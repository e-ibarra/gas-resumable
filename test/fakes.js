'use strict';
// In-memory stand-ins for Apps Script services. They mimic the parts of
// the real API the library uses, including its limits.

class FakeClock {
  constructor(start = 1_700_000_000_000) { this.t = start; this.slept = []; }
  now() { return this.t; }
  sleep(ms) { this.slept.push(ms); this.t += ms; }
  random() { return 0; }
  advance(ms) { this.t += ms; }
}

class MemoryStore {
  constructor() { this.data = new Map(); this.writes = 0; }
  get(k) { return this.data.has(k) ? JSON.parse(this.data.get(k)) : null; }
  set(k, v) { this.writes++; this.data.set(k, JSON.stringify(v)); }
  remove(k) { this.data.delete(k); }
}

class FakeLock {
  constructor() { this.held = false; this.busy = false; }
  tryLock() { if (this.busy || this.held) return false; this.held = true; return true; }
  release() { this.held = false; }
}

class FakeScheduler {
  constructor() { this.pending = new Map(); this.scheduledCount = 0; }
  schedule(handler, delayMs) { this.pending.set(handler, delayMs); this.scheduledCount++; }
  cancel(handler) { this.pending.delete(handler); }
}

/** PropertiesService.getScriptProperties() lookalike, enforcing the 9 KB value cap. */
class FakeProperties {
  constructor() { this.map = new Map(); }
  getProperty(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setProperty(k, v) {
    if (String(v).length > 9000) throw new Error('Argument too large: value');
    this.map.set(k, String(v));
  }
  setProperties(obj) { for (const k of Object.keys(obj)) this.setProperty(k, obj[k]); }
  deleteProperty(k) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}

/** ScriptApp lookalike for trigger management. */
class FakeScriptApp {
  constructor() { this.triggers = []; }
  newTrigger(handler) {
    const self = this;
    const spec = { handler, after: null };
    return {
      timeBased() {
        return {
          after(ms) { spec.after = ms; return { create() { self.triggers.push(makeTrigger(spec)); } }; }
        };
      }
    };
  }
  getProjectTriggers() { return this.triggers.slice(); }
  deleteTrigger(t) { this.triggers = this.triggers.filter((x) => x !== t); }
}
function makeTrigger(spec) {
  return { getHandlerFunction: () => spec.handler, after: spec.after };
}

/** Minimal Sheet lookalike for the sheetRows helper. */
class FakeSheet {
  constructor(rows) { this.rows = rows; this.reads = []; } // rows include header
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows[0] ? this.rows[0].length : 0; }
  getRange(row, col, numRows, numCols) {
    this.reads.push({ row, numRows });
    const rows = this.rows;
    return {
      getValues() {
        return rows.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols));
      }
    };
  }
}

function deps(overrides = {}) {
  return {
    store: new MemoryStore(),
    lock: new FakeLock(),
    scheduler: new FakeScheduler(),
    clock: new FakeClock(),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides
  };
}

module.exports = { FakeClock, MemoryStore, FakeLock, FakeScheduler, FakeProperties, FakeScriptApp, FakeSheet, deps };
