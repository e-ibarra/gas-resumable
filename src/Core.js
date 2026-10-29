/**
 * gas-resumable — core engine.
 *
 * Environment-agnostic: everything that touches Apps Script services
 * (properties, locks, triggers, sleep) is injected, so the engine runs
 * unchanged in Apps Script and in Node tests.
 *
 * In Apps Script all files share one global scope, so this file only
 * declares globals and exports them for Node at the bottom.
 */

/** @typedef {'idle'|'running'|'paused'|'done'|'failed'} JobStatus */

/**
 * @typedef {Object} JobState
 * @property {JobStatus} status
 * @property {*} cursor              Opaque position passed back to fetch().
 * @property {number} processed      Items processed successfully.
 * @property {number} failedCount    Items that exhausted their retries.
 * @property {Array<{cursor:*, index:number, error:string, attempts:number}>} deadLetters
 * @property {number} runs           Executions used so far (1 per trigger fire).
 * @property {number|null} startedAt Epoch ms of the first run.
 * @property {number|null} finishedAt
 * @property {string|null} lastError
 * @property {number|null} total     Optional total, for progress reporting.
 */

var RESUMABLE_DEFAULTS = {
  batchSize: 100,
  // Apps Script kills consumer-account executions at 6 min. Leave headroom
  // for the checkpoint write and the trigger call.
  maxRuntimeMs: 4.5 * 60 * 1000,
  // Never start a batch unless we expect it to finish: we keep a running
  // average of batch duration and require this much margin on top of it.
  safetyMarginMs: 20 * 1000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
  maxDeadLetters: 200,
  // Stop the whole job if too many items fail (likely a systemic error).
  maxFailures: 50,
  continuationDelayMs: 60 * 1000,
  lockWaitMs: 1000
};

/** @returns {JobState} */
function resumableInitialState_() {
  return {
    status: 'idle',
    cursor: null,
    processed: 0,
    failedCount: 0,
    deadLetters: [],
    runs: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    total: null
  };
}

function resumableErrorMessage_(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  return (err && err.message) ? String(err.message) : String(err);
}

/**
 * A long-running job that processes items in checkpointed batches and
 * re-schedules itself before Apps Script's execution limit.
 *
 * @param {string} name Unique job name (used as the storage key).
 * @param {Object} spec
 * @param {function(*, number): (Array|{items:Array, nextCursor:*})} spec.fetch
 *   Returns the next batch starting at `cursor` (null on first call).
 *   Return an array (cursor then advances by its length, starting at 0) or
 *   `{items, nextCursor}` for custom pagination (API page tokens, etc.).
 *   An empty batch means the job is finished.
 * @param {function(*, Object): void} [spec.process] Handles one item.
 * @param {function(Array, Object): void} [spec.processBatch] Handles a whole
 *   batch at once (e.g. one setValues call). Use instead of `process`.
 * @param {function(): number} [spec.total] Optional, for progress reporting.
 * @param {function(JobState): void} [spec.onComplete]
 * @param {function(JobState): void} [spec.onFail]
 * @param {function(JobState): void} [spec.onProgress] Called after each batch.
 * @param {string} [spec.continueWith] Name of the global function that calls
 *   job.run(); required for auto-continuation via triggers.
 * @param {Object} deps Injected services: store, lock, scheduler, clock, logger.
 */
function ResumableJob(name, spec, deps) {
  if (!name || typeof name !== 'string') throw new Error('ResumableJob: name is required');
  if (!spec || typeof spec.fetch !== 'function') throw new Error('ResumableJob: spec.fetch is required');
  if (typeof spec.process !== 'function' && typeof spec.processBatch !== 'function') {
    throw new Error('ResumableJob: provide spec.process or spec.processBatch');
  }
  if (!deps || !deps.store || !deps.lock || !deps.scheduler || !deps.clock) {
    throw new Error('ResumableJob: deps.store, deps.lock, deps.scheduler and deps.clock are required');
  }
  this.name = name;
  this.spec = spec;
  this.opts = Object.assign({}, RESUMABLE_DEFAULTS, spec.options || {});
  this.store = deps.store;
  this.lock = deps.lock;
  this.scheduler = deps.scheduler;
  this.clock = deps.clock;
  this.log = deps.logger || { info: function () {}, warn: function () {}, error: function () {} };
  this.key = 'resumable:' + name;
}

/** @returns {JobState} */
ResumableJob.prototype.state = function () {
  var saved = this.store.get(this.key);
  return saved ? Object.assign(resumableInitialState_(), saved) : resumableInitialState_();
};

ResumableJob.prototype.save_ = function (state) {
  this.store.set(this.key, state);
};

/** Forget all progress so the next run starts from scratch. */
ResumableJob.prototype.reset = function () {
  this.store.remove(this.key);
  if (this.spec.continueWith) this.scheduler.cancel(this.spec.continueWith);
};

/** Stop after the current batch; run() will refuse to continue until resume(). */
ResumableJob.prototype.pause = function () {
  var s = this.state();
  if (s.status === 'running' || s.status === 'idle') {
    s.status = 'paused';
    this.save_(s);
  }
  if (this.spec.continueWith) this.scheduler.cancel(this.spec.continueWith);
};

ResumableJob.prototype.resume = function () {
  var s = this.state();
  if (s.status === 'paused') {
    s.status = 'running';
    this.save_(s);
  }
  return this.run();
};

/** Human-readable progress, handy for a sidebar or a status cell. */
ResumableJob.prototype.progress = function () {
  var s = this.state();
  var pct = s.total ? Math.min(100, Math.round((s.processed / s.total) * 100)) : null;
  return {
    status: s.status,
    processed: s.processed,
    total: s.total,
    percent: pct,
    failed: s.failedCount,
    runs: s.runs,
    lastError: s.lastError
  };
};

/**
 * Process as many batches as fit in this execution, then checkpoint and
 * schedule a continuation if work remains.
 * @returns {{status: JobStatus, processedThisRun: number, continued: boolean}}
 */
ResumableJob.prototype.run = function () {
  var started = this.clock.now();
  if (!this.lock.tryLock(this.opts.lockWaitMs)) {
    this.log.warn('[' + this.name + '] another execution holds the lock; skipping');
    return { status: this.state().status, processedThisRun: 0, continued: false, skipped: true };
  }
  try {
    return this.runLocked_(started);
  } finally {
    this.lock.release();
  }
};

ResumableJob.prototype.runLocked_ = function (started) {
  var s = this.state();
  var opts = this.opts;
  var spec = this.spec;

  if (s.status === 'done' || s.status === 'failed' || s.status === 'paused') {
    this.log.info('[' + this.name + '] status is ' + s.status + '; nothing to do (call reset() or resume())');
    return { status: s.status, processedThisRun: 0, continued: false };
  }

  if (s.status === 'idle') {
    s.status = 'running';
    s.startedAt = started;
    if (typeof spec.total === 'function') {
      try { s.total = spec.total(); } catch (e) { s.total = null; }
    }
  }
  s.runs += 1;
  s.lastError = null;
  this.save_(s);

  var processedThisRun = 0;
  var avgBatchMs = 0;
  var batches = 0;

  while (true) {
    var elapsed = this.clock.now() - started;
    var needed = avgBatchMs + opts.safetyMarginMs;
    if (batches > 0 && elapsed + needed > opts.maxRuntimeMs) break;
    if (batches === 0 && elapsed + opts.safetyMarginMs > opts.maxRuntimeMs) break;

    // Re-check pause flag set by another execution (e.g. a "Stop" menu item).
    var latest = this.store.get(this.key);
    if (latest && latest.status === 'paused') {
      s.status = 'paused';
      break;
    }

    var batchStart = this.clock.now();
    var fetched;
    try {
      fetched = spec.fetch(s.cursor, opts.batchSize);
    } catch (e) {
      // A failing fetch is systemic (bad range, API down): checkpoint and retry later.
      s.lastError = 'fetch: ' + resumableErrorMessage_(e);
      this.log.error('[' + this.name + '] ' + s.lastError);
      break;
    }

    var items, nextCursor;
    if (Array.isArray(fetched)) {
      items = fetched;
      nextCursor = (typeof s.cursor === 'number' ? s.cursor : 0) + fetched.length;
    } else if (fetched && Array.isArray(fetched.items)) {
      items = fetched.items;
      nextCursor = fetched.nextCursor;
    } else {
      items = [];
    }

    if (items.length === 0) {
      return this.complete_(s, processedThisRun);
    }

    var ctx = { job: this, cursor: s.cursor, state: s };
    if (typeof spec.processBatch === 'function') {
      var ok = this.withRetries_(function () { spec.processBatch(items, ctx); });
      if (ok === true) {
        s.processed += items.length;
        processedThisRun += items.length;
      } else {
        this.deadLetter_(s, s.cursor, -1, ok, items.length);
      }
    } else {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var res = this.withRetries_(function () { spec.process(item, ctx); });
        if (res === true) {
          s.processed += 1;
          processedThisRun += 1;
        } else {
          this.deadLetter_(s, s.cursor, i, res, 1);
        }
      }
    }

    s.cursor = nextCursor;
    batches += 1;
    var batchMs = this.clock.now() - batchStart;
    avgBatchMs = avgBatchMs === 0 ? batchMs : (avgBatchMs * 0.7 + batchMs * 0.3);
    // A pause() issued during this batch (same or another execution) must
    // survive the checkpoint instead of being overwritten by it.
    var pausedNow = this.store.get(this.key);
    if (pausedNow && pausedNow.status === 'paused') s.status = 'paused';
    this.save_(s); // checkpoint after every batch
    if (s.status === 'paused') break;

    if (typeof spec.onProgress === 'function') {
      try { spec.onProgress(s); } catch (e) { this.log.warn('onProgress failed: ' + resumableErrorMessage_(e)); }
    }

    if (s.failedCount > opts.maxFailures) {
      s.status = 'failed';
      s.lastError = 'Too many failed items (' + s.failedCount + '); stopping. See deadLetters.';
      s.finishedAt = this.clock.now();
      this.save_(s);
      if (spec.continueWith) this.scheduler.cancel(spec.continueWith);
      if (typeof spec.onFail === 'function') spec.onFail(s);
      this.log.error('[' + this.name + '] ' + s.lastError);
      return { status: 'failed', processedThisRun: processedThisRun, continued: false };
    }

    if (nextCursor === null || nextCursor === undefined) {
      if (!Array.isArray(fetched)) return this.complete_(s, processedThisRun);
    }
  }

  // Out of time (or paused / transient fetch error): checkpoint and continue later.
  this.save_(s);
  if (s.status === 'paused') {
    return { status: 'paused', processedThisRun: processedThisRun, continued: false };
  }
  var continued = false;
  if (spec.continueWith) {
    this.scheduler.schedule(spec.continueWith, opts.continuationDelayMs);
    continued = true;
    this.log.info('[' + this.name + '] checkpointed at ' + s.processed + ' items; continuing in ' +
      Math.round(opts.continuationDelayMs / 1000) + 's');
  } else {
    this.log.warn('[' + this.name + '] out of time and no continueWith set; call run() again to continue');
  }
  return { status: s.status, processedThisRun: processedThisRun, continued: continued };
};

ResumableJob.prototype.complete_ = function (s, processedThisRun) {
  s.status = 'done';
  s.finishedAt = this.clock.now();
  this.save_(s);
  if (this.spec.continueWith) this.scheduler.cancel(this.spec.continueWith);
  if (typeof this.spec.onComplete === 'function') {
    try { this.spec.onComplete(s); } catch (e) { this.log.warn('onComplete failed: ' + resumableErrorMessage_(e)); }
  }
  this.log.info('[' + this.name + '] done: ' + s.processed + ' processed, ' + s.failedCount + ' failed, ' + s.runs + ' run(s)');
  return { status: 'done', processedThisRun: processedThisRun, continued: false };
};

/** @returns {true|string} true on success, otherwise the last error message. */
ResumableJob.prototype.withRetries_ = function (fn) {
  var attempts = 0;
  var lastErr = null;
  while (attempts <= this.opts.maxRetries) {
    try {
      fn();
      return true;
    } catch (e) {
      lastErr = e;
      attempts += 1;
      if (e && e.permanent === true) break; // caller marked it non-retryable
      if (attempts <= this.opts.maxRetries) {
        // Exponential backoff with jitter: 0.5s, 1s, 2s... (+0-25%)
        var delay = this.opts.retryBaseDelayMs * Math.pow(2, attempts - 1);
        delay += Math.floor(delay * 0.25 * this.clock.random());
        this.clock.sleep(delay);
      }
    }
  }
  return resumableErrorMessage_(lastErr) + ' (after ' + attempts + ' attempt' + (attempts === 1 ? '' : 's') + ')';
};

ResumableJob.prototype.deadLetter_ = function (s, cursor, index, message, count) {
  s.failedCount += count;
  s.lastError = message;
  if (s.deadLetters.length < this.opts.maxDeadLetters) {
    s.deadLetters.push({ cursor: cursor, index: index, error: message, attempts: this.opts.maxRetries + 1 });
  }
  this.log.warn('[' + this.name + '] item failed at cursor ' + JSON.stringify(cursor) + ' #' + index + ': ' + message);
};

/** Mark an error as non-retryable: `throw Resumable.permanent('bad row')`. */
function resumablePermanentError_(message) {
  var e = new Error(message);
  e.permanent = true;
  return e;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ResumableJob: ResumableJob,
    RESUMABLE_DEFAULTS: RESUMABLE_DEFAULTS,
    resumablePermanentError_: resumablePermanentError_
  };
}
