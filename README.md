# Z-Bot Web Bluetooth test (Windows / cross-OS)

Throwaway harness to test whether a **browser can discover and flash the Zebra
robot over Web Bluetooth**. On a macOS 26 (Tahoe) dev Mac, Chrome/Chromium could
not *discover* the robot (a macOS-CoreBluetooth issue — the robot, runtime, and
upload protocol are all proven working; macOS Python/`bleak` flashes it every
time). This repo exists to confirm the expected result on **Windows**, where
Chromium uses a different BLE backend (WinRT).

## What you need

- **Windows 10/11** with **Chrome or Edge** (Web Bluetooth is Chromium-only; not
  Firefox/Safari).
- **Python 3** (for a quick local web server) — or any static server.
- The **robot powered on** and advertising over BLE as **`ZebraBot`** (it may show
  as **`MPY ESP32`**, address `F4:2D:C9:58:F7:7E`). It's already provisioned; just
  power it near the laptop.

> Web Bluetooth only works in a **secure context** — `http://localhost` or
> `https://`. Opening `index.html` as a `file://` will **not** expose the API, so
> you must serve it.

## Run

```bash
git clone https://github.com/<owner>/zbot-ble-spike-test.git
cd zbot-ble-spike-test
python -m http.server 8080
# open http://localhost:8080 in Chrome or Edge
```

(No Python? `npx serve -l 8080` works too. The page is static — no build step.)

## Test steps

1. **Connect** with **both checkboxes off** (default = filter by the NUS service
   `6e400001-…`, which the robot advertises in its primary packet).
2. If the chooser is empty after ~15s, tick **"Show all devices"** and Connect
   again — the robot may appear as **`MPY ESP32`**, **`ZebraBot`**, the address
   `F4:2D:C9:58:F7:7E`, or an **"Unknown / Unnamed device"**. Select it → **Pair**.
3. **Single upload** — watch the live log for:
   ```
   > QUIET — telemetry silent
   < PONG
   < PUT_OK BEGIN
   < PUT_OK CHUNK 12   (×N)
   < PUT_OK END
   > RESET
   ```
   The robot reboots and the OLED shows the uploaded program (`Zbot`).
4. **Run campaign** (50) → records success rate, retries, reconnects, timing →
   **Export CSV/JSON**.

## What to report back

- Did the robot **appear in the chooser**? Under which name/entry? With the
  default service filter, or only under "Show all devices"?
- Did **Single upload** succeed end-to-end (`PUT_OK END`)?
- Campaign **success rate**, plus any pairing prompts / disconnect-and-reconnect
  friction (fill in the Verdict notes box and export).

If the chooser finds it on Windows → the macOS failure is confirmed OS-specific
and Web Bluetooth stays viable as the delivery model. If it *also* fails on
Windows, that's a much bigger signal — capture the exact behavior.

## Files

`index.html` / `main.js` — UI · `bleUpload.js` — the `navigator.bluetooth` upload
protocol (QUIET-until-silent handshake, chunked upload, retry/reconnect) ·
`reliability.js` — the campaign + CSV/JSON export · `sample_user_main.py` — the
program that gets uploaded.

Throwaway — delete when the verdict is recorded. Mirrors
`zbot-poc/editor/scripts/ble-spike/`.
