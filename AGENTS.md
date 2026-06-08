# Tanchjim Bunny DSP, Linux EQ Controller

## Style rules

- no unicode symbols in comments or markdown, no em dashes, no fancy
  quotes, no multiply/minus/bullet chars beyond plain `-`, `+`, `*`.
  use ascii only for punctuation and dashes.
- code comments only: don't add redundant or obvious ones. if a comment
  is warranted, keep it short, lazy, lowercase, like a human scribbled it.
  (this doesn't apply to markdown files.)

## What this is

Tauri desktop app that controls the onboard 5-band parametric EQ of the
Tanchjim Bunny DSP IEMs via USB HID. Rust backend binds directly to
hidraw, JavaScript frontend runs in a webview. No web server, no python
runtime. Binary is ~6 MB.

## Project layout

```
bunnydsp/
├── index.html             # HTML shell (loaded in webview)
├── src/
│   ├── app.js             # EQ UI, biquad graph, drag interaction, import/export
│   ├── style.css          # All CSS
│   ├── asano.png          # Corner decoration (togglable)
│   ├── banner.png         # Full-width decorative banner
│   └── favicon.png
├── src-tauri/
│   ├── tauri.conf.json    # Tauri config (window size, build commands)
│   ├── capabilities/
│   │   └── default.json   # Tauri permissions
│   ├── Cargo.toml         # Rust crate config
│   └── src/
│       ├── main.rs        # Entry point (windows_subsystem + run())
│       ├── lib.rs         # Tauri commands (status, read, commit, bypass)
│       └── hid.rs         # HID protocol implementation
├── package.json           # npm: Vite + @tauri-apps/cli
├── vite.config.js         # Vite config
├── screenshots/
├── README.md
├── AGENTS.md
├── REGISTER-MAP.md        # Complete protocol reference
└── LICENSE
```

## How to build and run

```bash
npm install                          # install vite + tauri cli
npx tauri dev                        # dev mode (hot-reload frontend)
npx tauri build                      # production binary
./src-tauri/target/release/bunnydsp  # standalone binary after build
```

## Architecture

```
Tauri Webview (app.js)
  ↕ invoke() -- JSON over IPC
Tauri Rust backend (lib.rs)
  ↕ HID API (hidapi crate)
Device (/dev/hidraw*)
```

### Tauri commands (lib.rs)

| Command | Args | Returns | Purpose |
|---------|------|---------|---------|
| `status` | none | `StatusResult` | Device connected? permission denied? |
| `read_all` | none | `ReadResult` | Read all registers, return filters + vols + mic gain |
| `commit` | filters, left_vol, right_vol, mic_gain | `CommitResult` | Write EQ bands + vol + mic gain, commit to flash |
| `toggle_bypass` | target_slot | `BypassResult` | Switch EQ slot 2 (bypass) or 3 (custom) |

### Connection lifecycle (hid.rs)

- `find_and_open()` -- scans /dev/hidraw* for device with matching VID:PID
  and product string "TANCHJIM BUNNY DSP"
- `reopen()` -- after commit resets USB, re-scans for new hidraw node
- `ensure_connected()` -- sends a lightweight read to verify device is alive
- All state behind `HidStateMutex` (std::sync::Mutex<HidState>)

## HID protocol summary

> **Full reference:** `REGISTER-MAP.md`

### Device

- USB VID:PID: `31b2:1112` (KTMicro)
- Product string: `TANCHJIM BUNNY DSP`
- Chip ID: `TURN2CDC` (readable at report 0x54)
- Firmware: v1.01 (bcdDevice=0101)
- Interface: HID interface 3, report ID `0x4B`

### Packet format (report 0x4B, 10 bytes after report ID)

```
Byte 0:    register address
Byte 1-3:  reserved (0x00)
Byte 4:    command -- 0x52='R' (read), 0x57='W' (write), 0x53='S' (commit), 0x43='C' (clear)
Byte 5:    reserved (0x00)
Byte 6-9:  payload (little-endian)
```

On Linux hidraw: write 11 bytes (report ID + payload), read 11 bytes back.

### Register quick reference

| Register | Purpose | Encoding |
|----------|---------|----------|
| `0x24` | EQ enable/slot | byte6: 0x02=bypass, 0x03=custom |
| `0x26` | Band 1 gain+freq | bytes6-7: gain int16 LE / 10 = dB, bytes8-9: freq uint16 LE (Hz) |
| `0x27` | Band 1 Q+type | bytes6-7: Q uint16 LE / 1000, byte8: 0=PK 3=LSQ 4=HSQ |
| `0x28`-`0x2F` | Bands 2-5 | Same layout as 0x26/0x27 (gain+freq then Q+type) |
| `0x54` | Device info | Returns `TURN2CDC` |
| `0x65` | Mic gain | Byte6: int8 * 2, range -60 to +12 dB |
| `0x66` | L/R digital volume | Byte6: L vol (int8 * 2), byte7: R vol (int8 * 2) |

### *2 encoding (registers 0x65, 0x66)

```
encode: raw = dB * 2;  if raw < 0: raw += 256;  -> unsigned byte
decode: signed = byte if byte <= 127 else byte - 256;  dB = signed / 2
```

### EQ constraints

- 5 bands, frequency-ordered (bands can't cross -- enforced in UI)
- Gain: +/-12 dB, Q: 0.1-10.0, types: Peak / Low Shelf / High Shelf
- L/R volume: -60 to 0 dB per channel (independent sliders)
- Mic gain: -60 to +12 dB

### Key behaviors

- **Writes are fire-and-forget** -- only read (0x52) and commit (0x53)
  generate responses
- **Commit (0x53) triggers USB reset** -- hidraw node disappears and
  reappears. `reopen()` handles this.
- **Settings stored in flash** -- survive power cycles and work across devices
- **Bypass (slot 2) also triggers USB reset**

## UI features

- 5-band EQ with per-band type (Peak / Low Shelf / High Shelf), frequency, gain, Q
- Enable/disable individual bands (disabled = gain forced to 0 on commit)
- Live frequency response graph with composite + individual band curves
- **Drag dots on graph** -> adjusts frequency (horizontal) and gain (vertical)
  in real time
- Independent L Volume / R Volume sliders (register 0x66, -60 to 0 dB)
- Mic Gain slider (register 0x65, -60 to +12 dB)
- Bypass toggle (switches EQ slot 2<->3)
- Import/export config as JSON

## Config format (`bunnydsp-<timestamp>.json`)

```json
{
  "format": "bunnydsp-v1",
  "leftVol": 0,
  "rightVol": 0,
  "micGain": 0,
  "bands": [
    {"type": "PK", "freq": 100, "gain": 0, "q": 1.0, "disabled": false},
    ...
  ]
}
```

### Import validation

| Field | Range | Fallback |
|-------|-------|----------|
| `freq` | 20 - 20,000 | 1000 |
| `gain` | -12 - +12 | 0 |
| `q` | 0.1 - 10.0 | 1.0 |
| `type` | PK / LSQ / HSQ | PK |
| `leftVol` | -60 - 0 | 0 |
| `rightVol` | -60 - 0 | 0 |
| `micGain` | -60 - +12 | 0 |

Format string must start with `bunnydsp-`, unknown filter types fall back to PK,
missing bands get defaults, extras ignored.

## Udev rule

`/etc/udev/rules.d/99-tanchjim-bunny.rules`:
```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1112", GROUP="audio", MODE="0660", TAG+="uaccess"
```
Then `sudo usermod -aG audio $USER` and log out/in.

## Decoration

- **Banner**: `/src/banner.png` -- full-width 240px, tiles horizontally
- **Corner Asano**: `/src/asano.png` -- fixed bottom-right, toggle button
  with slide transition

## Sources

- Protocol reverse-engineered from Tanchjim Android APK v2.3.2 (jadx) + live HID probing
- `jeromeof/devicePEQ` (GitHub) -- partial reference (has register 0x66 mislabeled)
- Full protocol reference: `REGISTER-MAP.md`
