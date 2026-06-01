// reliability.js — the phase 2.8 measurement campaign.
//
// Runs N sequential uploads over a rotating set of payload sizes against one
// connected ZebraBot, records per-run + aggregate metrics, and builds CSV/JSON
// exports. THROWAWAY SPIKE CODE.

import { upload, sleep } from './bleUpload.js';

const _enc = new TextEncoder();

// Grow `baseText` to ~targetBytes by appending harmless comment lines. The
// device just writes whatever bytes it receives, so padding exercises the
// chunking/flow-control at realistic file sizes.
function padTo(baseText, targetBytes) {
  let text = baseText.endsWith('\n') ? baseText : baseText + '\n';
  let n = 0;
  while (_enc.encode(text).length < targetBytes) {
    text += `# pad ${String(n).padStart(5, '0')} ---------------------------------\n`;
    n++;
  }
  return text;
}

// Three payload profiles: a tiny program, a typical one, and a large one.
export function buildPayloads(baseText) {
  return [
    { label: 'small', text: baseText },
    { label: 'medium', text: padTo(baseText, 1024) },
    { label: 'large', text: padTo(baseText, 3072) },
  ].map((p) => ({ ...p, bytes: _enc.encode(p.text) }));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(results) {
  const n = results.length;
  const ok = results.filter((r) => r.success);
  const durations = ok.map((r) => r.durationMs).sort((a, b) => a - b);
  const mean = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;
  return {
    runs: n,
    successes: ok.length,
    failures: n - ok.length,
    successRate: n ? +((ok.length / n) * 100).toFixed(1) : 0,
    meanMs: mean,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    totalRetries: results.reduce((a, r) => a + r.retries, 0),
    totalReconnects: results.reduce((a, r) => a + r.reconnects, 0),
    runsNeedingRetry: results.filter((r) => r.retries > 0).length,
    runsNeedingReconnect: results.filter((r) => r.reconnects > 0).length,
  };
}

// Run the campaign. `onRun(result)` fires after each upload for live UI;
// `shouldStop()` lets a Stop button cut the loop short.
export async function runCampaign(conn, opts = {}) {
  const {
    runs = 50,
    baseText,
    uploadOpts = {},
    onLog = () => {},
    onRun = () => {},
    shouldStop = () => false,
    interRunDelayMs = 250,
  } = opts;

  const payloads = buildPayloads(baseText);
  const results = [];

  for (let i = 0; i < runs; i++) {
    if (shouldStop()) {
      onLog(`# campaign stopped after ${i} runs`);
      break;
    }
    const payload = payloads[i % payloads.length];
    onLog(`\n=== run ${i + 1}/${runs} — ${payload.label} (${payload.bytes.length} B) ===`);

    let metrics;
    try {
      metrics = await upload(conn, payload.bytes, { ...uploadOpts, onLog });
    } catch (e) {
      metrics = e.metrics || {
        bytes: payload.bytes.length,
        chunks: 0,
        attempts: uploadOpts.maxUploadRetries != null ? uploadOpts.maxUploadRetries + 1 : 0,
        retries: 0,
        reconnects: 0,
        success: false,
        durationMs: 0,
        error: e.message,
      };
    }

    const result = { index: i + 1, payload: payload.label, ...metrics };
    results.push(result);
    onRun(result, summarize(results));

    if (interRunDelayMs) await sleep(interRunDelayMs);
  }

  return { results, aggregate: summarize(results) };
}

export function toCSV(results) {
  const cols = [
    'index',
    'payload',
    'bytes',
    'chunks',
    'attempts',
    'retries',
    'reconnects',
    'success',
    'durationMs',
    'error',
  ];
  const lines = [cols.join(',')];
  for (const r of results) {
    lines.push(
      cols
        .map((c) => {
          const v = r[c] == null ? '' : String(r[c]);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(',')
    );
  }
  return lines.join('\n');
}

export function toJSON(results, aggregate, meta = {}) {
  return JSON.stringify({ meta, aggregate, results }, null, 2);
}
