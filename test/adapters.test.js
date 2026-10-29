'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Apps Script shares one global scope between files; mirror that for Node.
const core = require('../src/Core.js');
global.ResumableJob = core.ResumableJob;
global.resumablePermanentError_ = core.resumablePermanentError_;
const { ChunkedPropertyStore, TriggerScheduler, Resumable, RESUMABLE_CHUNK_SIZE } = require('../src/Adapters.js');
const { FakeProperties, FakeScriptApp, FakeSheet, FakeLock, FakeClock } = require('./fakes.js');

test('ChunkedPropertyStore round-trips values larger than the 9 KB property cap', () => {
  const props = new FakeProperties();
  const store = new ChunkedPropertyStore(props);
  const big = { deadLetters: Array.from({ length: 400 }, (_, i) => ({ i, error: 'x'.repeat(60) })) };
  assert.ok(JSON.stringify(big).length > 9000);
  store.set('job', big);
  assert.deepEqual(store.get('job'), big);
  assert.ok(props.keys().filter((k) => k.startsWith('job#')).length > 1);
});

test('ChunkedPropertyStore removes stale chunks when the value shrinks', () => {
  const props = new FakeProperties();
  const store = new ChunkedPropertyStore(props);
  store.set('k', 'y'.repeat(RESUMABLE_CHUNK_SIZE * 3));
  assert.equal(props.keys().filter((k) => k.startsWith('k#')).length, 4); // JSON quotes push it to 4
  store.set('k', { small: true });
  assert.deepEqual(props.keys().filter((k) => k.startsWith('k#')), ['k#0']);
  assert.deepEqual(store.get('k'), { small: true });
  store.remove('k');
  assert.deepEqual(props.keys(), []);
});

test('ChunkedPropertyStore treats a torn write (missing chunk) as missing state', () => {
  const props = new FakeProperties();
  const store = new ChunkedPropertyStore(props);
  store.set('k', 'z'.repeat(20000));
  props.deleteProperty('k#1');
  assert.equal(store.get('k'), null);
});

test('TriggerScheduler keeps a single pending trigger per handler', () => {
  const app = new FakeScriptApp();
  const sched = new TriggerScheduler(app);
  sched.schedule('runJob', 60000);
  sched.schedule('runJob', 60000);
  sched.schedule('other', 1);
  assert.equal(app.triggers.length, 2);
  assert.equal(app.triggers.find((t) => t.getHandlerFunction() === 'other').after, 1000, 'minimum 1s delay');
  sched.cancel('runJob');
  assert.deepEqual(app.triggers.map((t) => t.getHandlerFunction()), ['other']);
});

test('Resumable.sheetRows reads one batch at a time and stops at the last row', () => {
  const rows = [['id', 'amount'], ...Array.from({ length: 23 }, (_, i) => [i + 1, (i + 1) * 10])];
  const sheet = new FakeSheet(rows);
  const fetch = Resumable.sheetRows(sheet);
  const b1 = fetch(null, 10);
  assert.equal(b1.length, 10);
  assert.deepEqual(b1[0], { row: 2, values: [1, 10] });
  const b3 = fetch(20, 10);
  assert.equal(b3.length, 3);
  assert.equal(b3[2].row, 24);
  assert.deepEqual(fetch(23, 10), []);
  assert.deepEqual(sheet.reads.map((r) => r.numRows), [10, 3]);
});

test('end to end: a sheet job survives several "executions" with real adapters', () => {
  const rows = [['sku', 'qty'], ...Array.from({ length: 500 }, (_, i) => ['SKU-' + i, i])];
  const sheet = new FakeSheet(rows);
  const props = new FakeProperties();
  const app = new FakeScriptApp();
  const clock = new FakeClock();
  const out = [];
  const makeJob = () => Resumable.job('copySkus', {
    fetch: Resumable.sheetRows(sheet),
    process: (r) => { out.push(r.values[0]); clock.advance(800); },
    total: () => sheet.getLastRow() - 1,
    continueWith: 'copySkus'
  }, {
    store: new ChunkedPropertyStore(props),
    lock: new FakeLock(),
    scheduler: new TriggerScheduler(app),
    clock,
    logger: { info() {}, warn() {}, error() {} }
  });

  let executions = 0;
  do {
    makeJob().run(); // every trigger fire builds a fresh job, like real Apps Script
    executions++;
  } while (app.triggers.length > 0 && executions < 20);

  const job = makeJob();
  assert.equal(job.state().status, 'done');
  assert.equal(out.length, 500);
  assert.equal(new Set(out).size, 500, 'no duplicates across executions');
  assert.ok(executions > 1, 'needed more than one execution');
  assert.equal(job.progress().percent, 100);
});
