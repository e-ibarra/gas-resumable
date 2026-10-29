'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumableJob, resumablePermanentError_ } = require('../src/Core.js');
const { deps, FakeClock } = require('./fakes.js');

const range = (n) => Array.from({ length: n }, (_, i) => i);
const arrayFetch = (data) => (cursor, size) => {
  const start = typeof cursor === 'number' ? cursor : 0;
  return data.slice(start, start + size);
};

test('processes everything in one run when time allows', () => {
  const d = deps();
  const seen = [];
  let completed = null;
  const job = new ResumableJob('small', {
    fetch: arrayFetch(range(250)),
    process: (x) => seen.push(x),
    onComplete: (s) => { completed = s; },
    continueWith: 'runSmall',
    options: { batchSize: 100 }
  }, d);

  const r = job.run();
  assert.equal(r.status, 'done');
  assert.equal(r.processedThisRun, 250);
  assert.deepEqual(seen, range(250));
  assert.equal(completed.processed, 250);
  assert.equal(d.scheduler.pending.size, 0, 'no continuation left behind');
  assert.equal(job.state().runs, 1);
});

test('checkpoints before the time limit and resumes exactly where it stopped', () => {
  const d = deps();
  const seen = [];
  const job = new ResumableJob('big', {
    fetch: arrayFetch(range(1000)),
    // each item "costs" 1 second of runtime
    process: (x) => { seen.push(x); d.clock.advance(1000); },
    continueWith: 'runBig',
    options: { batchSize: 50, maxRuntimeMs: 270_000, safetyMarginMs: 20_000 }
  }, d);

  const first = job.run();
  assert.equal(first.status, 'running');
  assert.ok(first.continued, 'continuation scheduled');
  assert.ok(d.scheduler.pending.has('runBig'));
  assert.ok(first.processedThisRun > 0 && first.processedThisRun < 1000);
  // never ran past the budget
  assert.ok(first.processedThisRun * 1000 <= 270_000);

  // trigger fires a few times
  let guard = 0;
  while (job.state().status === 'running' && guard++ < 20) job.run();

  const s = job.state();
  assert.equal(s.status, 'done');
  assert.equal(s.processed, 1000);
  assert.deepEqual(seen, range(1000), 'every item exactly once, in order');
  assert.ok(s.runs >= 4);
  assert.equal(d.scheduler.pending.size, 0);
});

test('retries transient errors with exponential backoff', () => {
  const d = deps();
  let attempts = 0;
  const job = new ResumableJob('flaky', {
    fetch: arrayFetch(['a']),
    process: () => { attempts++; if (attempts < 3) throw new Error('Service invoked too many times'); },
    options: { maxRetries: 3, retryBaseDelayMs: 500 }
  }, d);
  job.run();
  assert.equal(job.state().processed, 1);
  assert.equal(job.state().failedCount, 0);
  assert.deepEqual(d.clock.slept, [500, 1000]);
});

test('dead-letters items that keep failing and keeps going', () => {
  const d = deps();
  const job = new ResumableJob('bad', {
    fetch: arrayFetch([1, 2, 3, 4]),
    process: (x) => { if (x === 3) throw new Error('row 3 is malformed'); },
    options: { maxRetries: 1, retryBaseDelayMs: 10 }
  }, d);
  job.run();
  const s = job.state();
  assert.equal(s.status, 'done');
  assert.equal(s.processed, 3);
  assert.equal(s.failedCount, 1);
  assert.equal(s.deadLetters.length, 1);
  assert.match(s.deadLetters[0].error, /row 3 is malformed \(after 2 attempts\)/);
  assert.equal(s.deadLetters[0].index, 2);
});

test('permanent errors are not retried', () => {
  const d = deps();
  let calls = 0;
  const job = new ResumableJob('perm', {
    fetch: arrayFetch(['x']),
    process: () => { calls++; throw resumablePermanentError_('invalid email'); },
    options: { maxRetries: 5 }
  }, d);
  job.run();
  assert.equal(calls, 1);
  assert.deepEqual(d.clock.slept, []);
  assert.equal(job.state().failedCount, 1);
});

test('stops the job when failures exceed maxFailures', () => {
  const d = deps();
  let failed = null;
  const job = new ResumableJob('systemic', {
    fetch: arrayFetch(range(100)),
    process: () => { throw new Error('Exception: You do not have permission'); },
    onFail: (s) => { failed = s; },
    continueWith: 'runSystemic',
    options: { maxRetries: 0, maxFailures: 5, batchSize: 10 }
  }, d);
  const r = job.run();
  assert.equal(r.status, 'failed');
  assert.ok(failed);
  assert.match(job.state().lastError, /Too many failed items/);
  assert.equal(d.scheduler.pending.size, 0);
  // A failed job stays failed until reset
  assert.equal(job.run().processedThisRun, 0);
  job.reset();
  assert.equal(job.state().status, 'idle');
});

test('skips when another execution holds the lock', () => {
  const d = deps();
  d.lock.busy = true;
  const job = new ResumableJob('locked', { fetch: arrayFetch([1]), process: () => {} }, d);
  const r = job.run();
  assert.equal(r.skipped, true);
  assert.equal(job.state().processed, 0);
});

test('releases the lock even if a callback throws', () => {
  const d = deps();
  const job = new ResumableJob('throws', {
    fetch: arrayFetch([1]),
    process: () => {},
    onComplete: () => { throw new Error('boom'); }
  }, d);
  job.run();
  assert.equal(d.lock.held, false);
});

test('pause stops after the current batch; resume continues', () => {
  const d = deps();
  const seen = [];
  const job = new ResumableJob('pausable', {
    fetch: arrayFetch(range(30)),
    process: (x) => { seen.push(x); if (x === 9) job.pause(); },
    continueWith: 'runPausable',
    options: { batchSize: 10 }
  }, d);
  const r = job.run();
  assert.equal(r.status, 'paused');
  assert.deepEqual(seen, range(10));
  assert.equal(d.scheduler.pending.size, 0);
  assert.equal(job.run().processedThisRun, 0, 'paused jobs do not run');
  job.resume();
  assert.deepEqual(seen, range(30));
  assert.equal(job.state().status, 'done');
});

test('supports custom pagination via {items, nextCursor}', () => {
  const d = deps();
  const pages = { start: { items: [1, 2], next: 'p2' }, p2: { items: [3], next: 'p3' }, p3: { items: [4, 5], next: null } };
  const seen = [];
  const job = new ResumableJob('api', {
    fetch: (cursor) => { const p = pages[cursor || 'start']; return { items: p.items, nextCursor: p.next }; },
    process: (x) => seen.push(x)
  }, d);
  assert.equal(job.run().status, 'done');
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('processBatch receives whole batches and retries them as a unit', () => {
  const d = deps();
  const writes = [];
  let failOnce = true;
  const job = new ResumableJob('bulk', {
    fetch: arrayFetch(range(25)),
    processBatch: (items) => {
      if (failOnce && items[0] === 10) { failOnce = false; throw new Error('Timeout'); }
      writes.push(items.length);
    },
    options: { batchSize: 10, retryBaseDelayMs: 1 }
  }, d);
  job.run();
  assert.deepEqual(writes, [10, 10, 5]);
  assert.equal(job.state().processed, 25);
});

test('a failing fetch checkpoints and schedules a retry instead of crashing', () => {
  const d = deps();
  let calls = 0;
  const job = new ResumableJob('fetchfail', {
    fetch: (cursor, size) => {
      calls++;
      if (calls === 2) throw new Error('Range not found');
      const start = cursor || 0;
      return range(30).slice(start, start + size);
    },
    process: () => {},
    continueWith: 'runFetchFail',
    options: { batchSize: 10 }
  }, d);
  const r = job.run();
  assert.equal(r.status, 'running');
  assert.equal(job.state().processed, 10);
  assert.match(job.state().lastError, /fetch: Range not found/);
  assert.ok(d.scheduler.pending.has('runFetchFail'));
  job.run();
  assert.equal(job.state().status, 'done');
  assert.equal(job.state().processed, 30);
});

test('reports progress percentage when total() is provided', () => {
  const d = deps();
  const job = new ResumableJob('progress', {
    fetch: arrayFetch(range(40)),
    process: () => d.clock.advance(10_000),
    total: () => 40,
    continueWith: 'runProgress',
    options: { batchSize: 10, maxRuntimeMs: 250_000, safetyMarginMs: 10_000 }
  }, d);
  job.run();
  const p = job.progress();
  assert.equal(p.total, 40);
  assert.ok(p.percent > 0 && p.percent < 100, `percent was ${p.percent}`);
});

test('validates its inputs', () => {
  assert.throws(() => new ResumableJob('', { fetch() {}, process() {} }, deps()), /name is required/);
  assert.throws(() => new ResumableJob('x', { process() {} }, deps()), /fetch is required/);
  assert.throws(() => new ResumableJob('x', { fetch() {} }, deps()), /process or spec.processBatch/);
  assert.throws(() => new ResumableJob('x', { fetch() {}, process() {} }, {}), /deps/);
});

test('backoff jitter uses the injected random source', () => {
  const clock = new FakeClock();
  clock.random = () => 1; // max jitter = +25%
  const d = deps({ clock });
  let n = 0;
  const job = new ResumableJob('jitter', {
    fetch: arrayFetch([1]),
    process: () => { if (n++ === 0) throw new Error('x'); },
    options: { retryBaseDelayMs: 400 }
  }, d);
  job.run();
  assert.deepEqual(clock.slept, [500]);
});
