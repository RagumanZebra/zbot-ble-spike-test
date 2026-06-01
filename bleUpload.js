// bleUpload.js — Web Bluetooth port of the ZebraBot BLE upload protocol.
//
// Source of truth: Zebra-VScode-Flasher/resources/tools/ble_put.py (host, bleak)
// Device server:   Zebra-VScode-Flasher/resources/runtime/robot/ble_teleop.py
//
// Wire protocol (Nordic UART Service, lowercased UUIDs for Web Bluetooth):
//   QUIET            -> OK QUIET            (optional, ~1.5s, continue on miss)
//   PING             -> PONG
//   PU               -> PUT_OK BEGIN        (opens /user_main.py.part fresh)
//   PC <base64>      -> PUT_OK CHUNK <rawlen>   (one per chunk; flow-controlled)
//   PE               -> PUT_OK END          (atomic rename .part -> /user_main.py)
//   RESET            -> (device reboots; no ack awaited)
//
// THROWAWAY SPIKE CODE (phase 2.8). Not production.
//
// Deviation from ble_put.py, by design:
//  * ble_put.py never retries. This harness DOES, because the whole point is to
//    measure how much retry/reconnect reliability costs. But it retries at the
//    WHOLE-UPLOAD level, not per-chunk: re-sending a single `PC` after a lost
//    ack would duplicate bytes in the device file (the device already appended
//    them). `PU` re-opens the temp file from scratch, so restarting the upload
//    is the only corruption-free retry. `metrics.retries` counts upload
//    restarts; `metrics.reconnects` counts GATT reconnects.

export const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // host -> device (write)
export const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device -> host (notify)

const _enc = new TextEncoder();
const _dec = new TextDecoder();

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Port of AckWaiter: buffers TX notification fragments, splits on '\n', trims
// '\r'. Unlike ble_put.py we do NOT replay matched lines from history — each
// step registers its waiter *before* sending, so it only ever resolves on a
// fresh ack. (ble_put.py's history replay can match a stale "PUT_OK CHUNK 12"
// from an earlier identical chunk and break per-chunk flow control.)
class AckBuffer {
  constructor(onLine) {
    this._carry = '';
    this._waiters = [];
    this.onLine = onLine || (() => {});
    this.history = [];
    this.lastLineAt = performance.now();
  }

  // ms since the last notification line of ANY kind (including telemetry).
  // Used to detect when the robot's telemetry stream has gone quiet after QUIET.
  msSinceLastLine() {
    return performance.now() - this.lastLineAt;
  }

  feed(dataView) {
    this._carry += _dec.decode(dataView);
    let idx;
    while ((idx = this._carry.indexOf('\n')) >= 0) {
      const raw = this._carry.slice(0, idx);
      this._carry = this._carry.slice(idx + 1);
      const line = raw.replace(/\r$/, '').trim();
      if (!line) continue;
      this.lastLineAt = performance.now();
      this.history.push(line);
      // Only surface/match protocol acks. The robot streams a flood of
      // telemetry (IMU/SNS/MTR_FB) that would bury the log and never matches a
      // waiter anyway — but it DOES advance lastLineAt above (for quiet detect).
      if (/^(PUT_|PONG|OK |ERR)/.test(line)) {
        this.onLine('< ' + line);
        for (const w of [...this._waiters]) w(line);
      }
    }
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        const i = this._waiters.indexOf(check);
        if (i >= 0) this._waiters.splice(i, 1);
      };
      const check = (line) => {
        if (predicate(line)) {
          cleanup();
          resolve(line);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('ack timeout'));
      }, timeoutMs);
      this._waiters.push(check);
    });
  }
}

// A live GATT connection to one ZebraBot. Survives reboots: after RESET the
// device drops, and reopen()/reopenWithRetry() reconnect the same granted
// device with no new permission prompt.
export class Connection {
  constructor(device, onLog) {
    this.device = device;
    this.onLog = onLog || (() => {});
    this.connected = false;
    this._writeWithResponse = true;
    this.device.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.onLog('! gattserverdisconnected');
    });
  }

  get name() {
    return this.device.name || 'ZebraBot';
  }

  async open() {
    this.ack = new AckBuffer(this.onLog);
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE_UUID);
    this.rx = await svc.getCharacteristic(RX_UUID);
    this.tx = await svc.getCharacteristic(TX_UUID);
    this._onNotify = (e) => this.ack.feed(e.target.value);
    await this.tx.startNotifications();
    this.tx.addEventListener('characteristicvaluechanged', this._onNotify);
    this._writeWithResponse = typeof this.rx.writeValueWithResponse === 'function';
    this.connected = true;
  }

  async reopen() {
    if (this.tx && this._onNotify) {
      try {
        this.tx.removeEventListener('characteristicvaluechanged', this._onNotify);
      } catch (_) {}
    }
    await this.open();
  }

  // Reconnect across a reboot: the device needs ~8s to come back and
  // re-advertise after a RESET, so retry with backoff. Returns true on success.
  async reopenWithRetry(attempts = 20, backoffMs = 600) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.reopen();
        this.onLog(`+ reconnected (attempt ${i})`);
        return true;
      } catch (e) {
        lastErr = e;
        await sleep(backoffMs);
      }
    }
    throw new Error('reconnect failed: ' + (lastErr ? lastErr.message : 'unknown'));
  }

  close() {
    try {
      if (this.tx && this._onNotify) {
        this.tx.removeEventListener('characteristicvaluechanged', this._onNotify);
      }
    } catch (_) {}
    try {
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    } catch (_) {}
    this.connected = false;
  }

  async sendLine(line) {
    const data = _enc.encode(line + '\n');
    if (this._writeWithResponse) {
      await this.rx.writeValueWithResponse(data);
    } else {
      await this.rx.writeValue(data); // older Chrome: defaults to with-response
    }
  }

  // Register the ack waiter BEFORE writing, to avoid the notify-before-listener
  // race. `response: true` writes mean the returned promise resolves only after
  // the device link-acked the bytes.
  async exchange(line, predicate, timeoutMs) {
    const waiter = this.ack.waitFor(predicate, timeoutMs);
    await this.sendLine(line);
    return waiter;
  }
}

// Pop a fresh device picker (requires a user gesture). Falls back to a
// name-prefix filter if the advert omits the service UUID.
export async function requestConnection({ onLog, preferNameFilter = false, acceptAll = false } = {}) {
  if (!navigator.bluetooth) {
    throw new Error(
      'navigator.bluetooth unavailable — open this page in Chrome/Edge over https or http://localhost'
    );
  }
  // acceptAll = debug: list every nearby BLE device (no filter). Useful to tell
  // "Chrome can't see the advert at all" from "the filter isn't matching".
  const options = acceptAll
    ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
    : preferNameFilter
      ? { filters: [{ namePrefix: 'ZebraBot' }], optionalServices: [SERVICE_UUID] }
      : { filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] };
  const device = await navigator.bluetooth.requestDevice(options);
  const conn = new Connection(device, onLog);
  await conn.open();
  return conn;
}

// One full upload attempt — no internal retry, so a single PC is never resent
// (which would duplicate bytes). Throws on any timeout/disconnect; the caller
// decides whether to restart.
async function uploadOnce(conn, bytes, opts) {
  const { chunkSize, delayMs, ackTimeoutMs, onLog, quietTries, quietProbeMs, quietGapMs } = opts;
  const log = onLog || (() => {});

  // Robust QUIET. The robot streams telemetry continuously, which saturates the
  // BLE notify queue and drops the OK QUIET / PONG replies. Waiting for the ack
  // (like ble_put.py) is unreliable — instead resend QUIET until the notify
  // stream actually goes SILENT. This is the fix that unblocked the spike.
  let quiet = false;
  for (let i = 0; i < quietTries; i++) {
    await conn.sendLine('QUIET');
    const t0 = performance.now();
    while (performance.now() - t0 < quietProbeMs) {
      await sleep(100);
      if (conn.ack.msSinceLastLine() > quietGapMs) {
        quiet = true;
        break;
      }
    }
    if (quiet) break;
  }
  log(quiet ? '> QUIET — telemetry silent' : '> QUIET — stream did not quiet; continuing');
  if (delayMs) await sleep(delayMs);

  log('> PING');
  await conn.exchange('PING', (l) => l === 'PONG', ackTimeoutMs);
  if (delayMs) await sleep(delayMs);

  log('> PU');
  await conn.exchange('PU', (l) => l === 'PUT_OK BEGIN', ackTimeoutMs);
  if (delayMs) await sleep(delayMs);

  const total = bytes.length;
  let sent = 0;
  for (let off = 0; off < total; off += chunkSize) {
    const chunk = bytes.subarray(off, Math.min(off + chunkSize, total));
    const expect = `PUT_OK CHUNK ${chunk.length}`;
    await conn.exchange('PC ' + b64(chunk), (l) => l === expect, ackTimeoutMs);
    sent += chunk.length;
    if (opts.onProgress) opts.onProgress(sent, total);
    if (delayMs) await sleep(delayMs);
  }

  log('> PE');
  await conn.exchange('PE', (l) => l === 'PUT_OK END', ackTimeoutMs);
  log(`  uploaded ${total} bytes -> /user_main.py`);
}

// Upload `bytes` with whole-upload retry + reconnect, recording how much
// resilience it took. `reset` reboots the device to run the new program; after
// a reset the connection drops (expected) and the caller reconnects for the
// next run.
export async function upload(conn, bytes, opts = {}) {
  const cfg = {
    chunkSize: 12,
    delayMs: 20,
    ackTimeoutMs: 8000,
    quietTries: 8, // resend QUIET up to N times…
    quietProbeMs: 2000, // …waiting this long each time for the stream to stop…
    quietGapMs: 1200, // …where "stopped" = no notification for this many ms.
    maxUploadRetries: 2,
    maxReconnects: 2,
    reset: true,
    onLog: conn.onLog,
    onProgress: null,
    ...opts,
  };
  const log = cfg.onLog || (() => {});
  const metrics = {
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / cfg.chunkSize) || 0,
    attempts: 0,
    retries: 0,
    reconnects: 0,
    success: false,
    durationMs: 0,
    error: '',
  };

  const started = performance.now();
  const maxAttempts = cfg.maxUploadRetries + 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    metrics.attempts = attempt;
    if (attempt > 1) {
      metrics.retries++;
      log(`! restarting upload (attempt ${attempt}/${maxAttempts})`);
    }
    try {
      if (!conn.connected) {
        metrics.reconnects++;
        await conn.reopenWithRetry(); // generous retry — a RESET reboot takes ~8s
      }
      await uploadOnce(conn, bytes, cfg);
      metrics.success = true;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log(`! attempt ${attempt} failed: ${e.message}`);
    }
  }

  if (metrics.success && cfg.reset) {
    try {
      log('> RESET');
      await conn.sendLine('RESET'); // device reboots; no ack
    } catch (e) {
      log(`  (reset not confirmed: ${e.message})`);
    }
  }

  metrics.durationMs = Math.round(performance.now() - started);
  if (!metrics.success) {
    metrics.error = lastErr ? lastErr.message : 'unknown';
    throw Object.assign(new Error(metrics.error), { metrics });
  }
  return metrics;
}
