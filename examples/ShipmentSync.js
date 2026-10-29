/**
 * Example: enrich every row of a large "Shipments" sheet with a computed
 * landed cost and a status from an external API, without ever hitting the
 * 6-minute limit. Paste into a Sheets-bound project next to the library
 * (or add the library and prefix calls with its identifier).
 *
 * Columns: A shipment_id | B fob_usd | C freight_usd | D insurance_usd |
 *          E duty_rate | F cif_usd (out) | G duty_usd (out) | H status (out)
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Shipments')
    .addItem('Start / continue sync', 'syncShipments')
    .addItem('Pause sync', 'pauseShipmentSync')
    .addItem('Show progress', 'showShipmentSyncProgress')
    .addItem('Reset sync', 'resetShipmentSync')
    .addToUi();
}

function shipmentSyncJob_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Shipments');
  return Resumable.job('shipmentSync', {
    fetch: Resumable.sheetRows(sheet, { columns: 8 }),
    total: function () { return sheet.getLastRow() - 1; },

    // Bulk-write each batch with one setValues call: far faster than
    // writing cell by cell, and retried as a unit on transient errors.
    processBatch: function (rows) {
      var out = rows.map(function (r) {
        var v = r.values;
        var fob = Number(v[1]), freight = Number(v[2]), insurance = Number(v[3]), duty = Number(v[4]);
        if (!isFinite(fob)) return [v[5], v[6], 'ERROR: FOB is not a number'];
        var cif = fob + freight + insurance;
        return [cif, Math.round(cif * duty * 100) / 100, lookupStatus_(v[0])];
      });
      sheet.getRange(rows[0].row, 6, out.length, 3).setValues(out);
    },

    onProgress: function (s) {
      SpreadsheetApp.getActive().toast(s.processed + ' rows done', 'Shipment sync', 3);
    },
    onComplete: function (s) {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Shipment sync finished',
        s.processed + ' rows processed in ' + s.runs + ' execution(s); ' + s.failedCount + ' failed.');
    },
    continueWith: 'syncShipments', // the trigger calls this same function
    options: { batchSize: 200 }
  });
}

function syncShipments() { shipmentSyncJob_().run(); }
function pauseShipmentSync() { shipmentSyncJob_().pause(); }
function resetShipmentSync() { shipmentSyncJob_().reset(); }

function showShipmentSyncProgress() {
  var p = shipmentSyncJob_().progress();
  SpreadsheetApp.getUi().alert(
    'Status: ' + p.status + '\n' +
    'Processed: ' + p.processed + (p.total ? ' / ' + p.total + ' (' + p.percent + '%)' : '') + '\n' +
    'Failed: ' + p.failed + '\nExecutions: ' + p.runs +
    (p.lastError ? '\nLast error: ' + p.lastError : ''));
}

/** Stand-in for a tracking API call (UrlFetchApp in real life). */
function lookupStatus_(shipmentId) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('status:' + shipmentId);
  if (hit) return hit;
  var res = UrlFetchApp.fetch('https://example.com/api/shipments/' + encodeURIComponent(shipmentId),
    { muteHttpExceptions: true });
  if (res.getResponseCode() === 404) throw Resumable.permanent('Unknown shipment ' + shipmentId);
  if (res.getResponseCode() >= 500) throw new Error('Tracking API ' + res.getResponseCode()); // retried
  var status = JSON.parse(res.getContentText()).status;
  cache.put('status:' + shipmentId, status, 21600);
  return status;
}
