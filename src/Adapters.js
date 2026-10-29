/**
 * Apps Script adapters + the public `Resumable` namespace.
 *
 * PropertiesService caps each value at ~9 KB, and job state (dead letters,
 * API page tokens) can outgrow that, so state is stored as JSON split
 * across numbered chunk keys.
 */

var RESUMABLE_CHUNK_SIZE = 8000; // characters per property value, under the 9 KB cap

/**
 * Key/value JSON store over any Properties-like object
 * ({getProperty, setProperty, setProperties, deleteProperty}).
 */
function ChunkedPropertyStore(props) {
  this.props = props;
}

ChunkedPropertyStore.prototype.get = function (key) {
  var meta = this.props.getProperty(key);
  if (meta === null || meta === undefined) return null;
  var parsed;
  try { parsed = JSON.parse(meta); } catch (e) { return null; }
  if (!parsed || typeof parsed.chunks !== 'number') return parsed; // legacy/plain value
  var json = '';
  for (var i = 0; i < parsed.chunks; i++) {
    var part = this.props.getProperty(key + '#' + i);
    if (part === null || part === undefined) return null; // torn write: treat as missing
    json += part;
  }
  return JSON.parse(json);
};

ChunkedPropertyStore.prototype.set = function (key, value) {
  var json = JSON.stringify(value);
  var chunks = Math.max(1, Math.ceil(json.length / RESUMABLE_CHUNK_SIZE));
  var previous = this.chunkCount_(key);
  var batch = {};
  for (var i = 0; i < chunks; i++) {
    batch[key + '#' + i] = json.substr(i * RESUMABLE_CHUNK_SIZE, RESUMABLE_CHUNK_SIZE);
  }
  batch[key] = JSON.stringify({ chunks: chunks, v: 1 });
  // setProperties writes all chunks + meta in one call.
  if (typeof this.props.setProperties === 'function') this.props.setProperties(batch, false);
  else for (var k in batch) this.props.setProperty(k, batch[k]);
  for (var j = chunks; j < previous; j++) this.props.deleteProperty(key + '#' + j);
};

ChunkedPropertyStore.prototype.remove = function (key) {
  var n = this.chunkCount_(key);
  for (var i = 0; i < n; i++) this.props.deleteProperty(key + '#' + i);
  this.props.deleteProperty(key);
};

ChunkedPropertyStore.prototype.chunkCount_ = function (key) {
  var meta = this.props.getProperty(key);
  if (!meta) return 0;
  try {
    var p = JSON.parse(meta);
    return (p && typeof p.chunks === 'number') ? p.chunks : 0;
  } catch (e) { return 0; }
};

/** Wraps LockService so overlapping trigger runs never double-process items. */
function ScriptLockAdapter(lock) {
  this.lock = lock;
}
ScriptLockAdapter.prototype.tryLock = function (ms) { return this.lock.tryLock(ms); };
ScriptLockAdapter.prototype.release = function () { this.lock.releaseLock(); };

/**
 * One-shot time-based triggers for continuation. Keeps at most one pending
 * trigger per handler so retries never pile up duplicates (Apps Script
 * allows only 20 triggers per user per script).
 */
function TriggerScheduler(scriptApp) {
  this.scriptApp = scriptApp;
}
TriggerScheduler.prototype.schedule = function (handler, delayMs) {
  this.cancel(handler);
  this.scriptApp.newTrigger(handler).timeBased().after(Math.max(1000, delayMs)).create();
};
TriggerScheduler.prototype.cancel = function (handler) {
  var triggers = this.scriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handler) this.scriptApp.deleteTrigger(triggers[i]);
  }
};

function AppsScriptClock() {}
AppsScriptClock.prototype.now = function () { return Date.now(); };
AppsScriptClock.prototype.sleep = function (ms) { Utilities.sleep(ms); };
AppsScriptClock.prototype.random = function () { return Math.random(); };

var ConsoleLogger = {
  info: function (m) { console.log(m); },
  warn: function (m) { console.warn(m); },
  error: function (m) { console.error(m); }
};

/**
 * Public API.
 *
 *   function syncInvoices() {
 *     Resumable.job('syncInvoices', {
 *       fetch: function (cursor, size) { ... },
 *       process: function (row) { ... },
 *       continueWith: 'syncInvoices'
 *     }).run();
 *   }
 */
var Resumable = {
  /**
   * @param {string} name
   * @param {Object} spec see ResumableJob
   * @param {Object} [deps] override any service (mainly for tests)
   */
  job: function (name, spec, deps) {
    var d = deps || {};
    return new ResumableJob(name, spec, {
      store: d.store || new ChunkedPropertyStore(PropertiesService.getScriptProperties()),
      lock: d.lock || new ScriptLockAdapter(LockService.getScriptLock()),
      scheduler: d.scheduler || new TriggerScheduler(ScriptApp),
      clock: d.clock || new AppsScriptClock(),
      logger: d.logger || ConsoleLogger
    });
  },

  /**
   * Helper for the most common case: walk the rows of a sheet range.
   * Returns a `fetch` function that reads `size` rows starting after the
   * cursor, so only one batch is ever held in memory.
   *
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {{firstRow?: number, columns?: number}} [opts]
   */
  sheetRows: function (sheet, opts) {
    var o = opts || {};
    var firstRow = o.firstRow || 2; // skip header by default
    return function (cursor, size) {
      var offset = typeof cursor === 'number' ? cursor : 0;
      var start = firstRow + offset;
      var last = sheet.getLastRow();
      if (start > last) return [];
      var n = Math.min(size, last - start + 1);
      var cols = o.columns || sheet.getLastColumn();
      var values = sheet.getRange(start, 1, n, cols).getValues();
      return values.map(function (row, i) { return { row: start + i, values: row }; });
    };
  },

  /** Throw this from process() to skip retries for a bad item. */
  permanent: function (message) { return resumablePermanentError_(message); }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ChunkedPropertyStore: ChunkedPropertyStore,
    ScriptLockAdapter: ScriptLockAdapter,
    TriggerScheduler: TriggerScheduler,
    Resumable: Resumable,
    RESUMABLE_CHUNK_SIZE: RESUMABLE_CHUNK_SIZE
  };
}
