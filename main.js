// main.js — wires the DOM to the BLE port + campaign runner. Throwaway spike UI.

import { requestConnection, upload } from './bleUpload.js';
import { runCampaign, toCSV, toJSON, summarize } from './reliability.js';

const $ = (id) => document.getElementById(id);
const _encLen = (s) => new TextEncoder().encode(s).length;

let conn = null;
let results = [];
let aggregate = null;
let stopFlag = false;
let running = false;

function log(msg) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}

function setConnected(c) {
  const on = !!c;
  $('btnDisconnect').disabled = !on;
  $('btnSingle').disabled = !on;
  $('btnCampaign').disabled = !on || running;
  $('connStatus').innerHTML = on
    ? `Connected to <b>${conn.name}</b>.`
    : 'Not connected.';
}

function uploadOpts() {
  return {
    chunkSize: +$('chunkSize').value,
    delayMs: +$('delayMs').value,
    ackTimeoutMs: +$('ackTimeoutMs').value,
    maxUploadRetries: +$('maxUploadRetries').value,
    maxReconnects: +$('maxReconnects').value,
    reset: $('resetEach').checked,
  };
}

function payloadBytes() {
  return new TextEncoder().encode($('payload').value);
}

function renderCards(a) {
  if (!a) return;
  const cards = [
    ['success', `${a.successRate}%`, a.successRate >= +$('threshold').value ? 'ok' : 'bad'],
    ['runs', `${a.successes}/${a.runs}`, ''],
    ['median', `${a.medianMs} ms`, ''],
    ['p95', `${a.p95Ms} ms`, ''],
    ['retries', `${a.totalRetries}`, a.totalRetries ? 'bad' : 'ok'],
    ['reconnects', `${a.totalReconnects}`, a.totalReconnects ? 'bad' : 'ok'],
  ];
  $('cards').innerHTML = cards
    .map(
      ([k, v, cls]) =>
        `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`
    )
    .join('');
}

function appendRow(r) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${r.index}</td><td>${r.payload}</td><td>${r.bytes}</td>
    <td>${r.retries}</td><td>${r.reconnects}</td><td>${r.durationMs}</td>
    <td class="${r.success ? 'ok' : 'bad'}">${r.success ? '✓' : '✗'}</td>`;
  if (!r.success) tr.title = r.error || '';
  $('resultsTable').querySelector('tbody').appendChild(tr);
}

function renderVerdict(a) {
  const badge = $('verdictBadge');
  if (!a || !a.runs) {
    badge.className = 'badge idle';
    badge.textContent = 'no data';
    return;
  }
  const pass = a.successRate >= +$('threshold').value;
  badge.className = 'badge ' + (pass ? 'pass' : 'fail');
  badge.textContent = pass
    ? `RELIABLE — ${a.successRate}% (→ 3.6/3.7)`
    : `FLAKY — ${a.successRate}% (→ Electron plan)`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMeta() {
  return {
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    settings: uploadOpts(),
    notes: $('notes').value,
    threshold: +$('threshold').value,
  };
}

// --- handlers -------------------------------------------------------------

$('btnConnect').addEventListener('click', async () => {
  try {
    $('btnConnect').disabled = true;
    log('# requesting device…');
    conn = await requestConnection({
      onLog: log,
      preferNameFilter: $('nameFilter').checked,
      acceptAll: $('acceptAll').checked,
    });
    log(`# connected to ${conn.name}`);
    setConnected(conn);
  } catch (e) {
    log(`! connect failed: ${e.message}`);
  } finally {
    $('btnConnect').disabled = false;
  }
});

$('btnDisconnect').addEventListener('click', () => {
  if (conn) conn.close();
  conn = null;
  setConnected(null);
  log('# disconnected');
});

$('btnSingle').addEventListener('click', async () => {
  if (!conn) return;
  $('btnSingle').disabled = true;
  try {
    const bytes = payloadBytes();
    log(`\n=== single upload — ${bytes.length} B ===`);
    const m = await upload(conn, bytes, { ...uploadOpts(), onLog: log });
    log(`# OK in ${m.durationMs} ms (retries ${m.retries}, reconnects ${m.reconnects})`);
  } catch (e) {
    log(`! single upload failed: ${e.message}`);
  } finally {
    $('btnSingle').disabled = false;
  }
});

$('btnCampaign').addEventListener('click', async () => {
  if (!conn || running) return;
  running = true;
  stopFlag = false;
  results = [];
  $('resultsTable').querySelector('tbody').innerHTML = '';
  $('btnCampaign').disabled = true;
  $('btnSingle').disabled = true;
  $('btnStop').disabled = false;
  $('btnCSV').disabled = true;
  $('btnJSON').disabled = true;

  try {
    const out = await runCampaign(conn, {
      runs: +$('runs').value,
      baseText: $('payload').value,
      uploadOpts: uploadOpts(),
      onLog: log,
      shouldStop: () => stopFlag,
      onRun: (r, agg) => {
        results.push(r);
        aggregate = agg;
        appendRow(r);
        renderCards(agg);
        renderVerdict(agg);
      },
    });
    aggregate = out.aggregate;
    results = out.results;
    log(`\n# campaign done — ${aggregate.successRate}% over ${aggregate.runs} runs`);
  } catch (e) {
    log(`! campaign error: ${e.message}`);
  } finally {
    running = false;
    $('btnStop').disabled = true;
    $('btnCampaign').disabled = !conn;
    $('btnSingle').disabled = !conn;
    $('btnCSV').disabled = results.length === 0;
    $('btnJSON').disabled = results.length === 0;
  }
});

$('btnStop').addEventListener('click', () => {
  stopFlag = true;
  $('btnStop').disabled = true;
  log('# stop requested…');
});

$('threshold').addEventListener('input', () => {
  if (aggregate) {
    renderCards(aggregate);
    renderVerdict(aggregate);
  }
});

$('btnCSV').addEventListener('click', () => download('ble-spike-results.csv', toCSV(results), 'text/csv'));
$('btnJSON').addEventListener('click', () =>
  download('ble-spike-results.json', toJSON(results, aggregate, exportMeta()), 'application/json')
);

// --- init -----------------------------------------------------------------

(async function init() {
  if (!navigator.bluetooth) {
    log('! navigator.bluetooth unavailable — use Chrome/Edge over http://localhost or https.');
    $('btnConnect').disabled = true;
  }
  try {
    const res = await fetch('./sample_user_main.py');
    if (res.ok) {
      const text = await res.text();
      $('payload').value = text;
      log(`# loaded sample_user_main.py (${_encLen(text)} B)`);
    }
  } catch (_) {
    log('# could not fetch sample_user_main.py — paste a payload manually.');
  }
})();
