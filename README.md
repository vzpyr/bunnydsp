# Bunny DSP

A standalone EQ controller app for the **Tanchjim Bunny DSP** USB-C IEMs,
written in Rust with a Tauri (webview) frontend.
It communicates with the onboard KTMicro DSP over raw USB HID.

<p align="center">
  <img src="screenshots/screenshot1.png" alt="Bunny DSP UI Top" width="45%">
  <img src="screenshots/screenshot2.png" alt="Bunny DSP UI Bottom" width="45%">
</p>

Previously a Python/Bottle/webview app; rewritten to drop the 100 MB+ Python
runtime dependency. The HID protocol and UI are functionally identical.

## Features

The Bunny DSP IEMs feature a KTMicro DAC/DSP chip with a hardware-baked, 5-band
parametric EQ. This project programs the device by sending HID feature reports
over USB, utilizing the chip's native support for standard USB HID class 1.1.

Each of the 5 bands supports:
* **Filter Types:** Peak (PK), Low Shelf (LSQ), and High Shelf (HSQ)
* **Gain:** +/-12 dB in 0.1 dB steps
* **Q Factor:** 0.1 to 10.0
* **Frequency:** 20 Hz to 20 kHz
* **Controls:** Per-band bypass/disable toggle, per-channel L/R digital volume,
  and ADC mic gain

The UI graph renders a composite frequency response from all active bands using
biquad filter math, ensuring that what you see on screen matches exactly what the
hardware produces. Each active band also shows a faint individual response curve
behind the composite, so you can see how bands overlap. Filter dots are draggable.

---

## Getting Started

All execution options require permission to access the USB HID device (see the
[Permissions](#permissions) section below). If the device is not connected or
permissions are missing, the UI will display an error.

### Option 1: Download pre-built binaries (Recommended)

Download the latest release from the **Releases** tab and run it:
* **Desktop (Linux/Windows):** Download and run the standalone executable.
* **Android:** Download the `.apk` file and install it on your device.

### Option 2: Build from source

Requires Rust (1.75+) and Node.js (20+).

#### Desktop Build:
```bash
npm install
npx tauri build
# Binary at src-tauri/target/release/bunnydsp
```

#### Android Build:
Ensure you have the Android SDK & NDK configured (NDK `26.1.10909125` is recommended):
```bash
npm install
npx tauri android build --debug
# APK at src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

### Permissions

#### Linux:
The `hidraw` device requires elevated privileges to access. Create a udev rule:

```text
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1112", GROUP="audio", MODE="0660", TAG+="uaccess"
```

Save to `/etc/udev/rules.d/99-tanchjim-bunny.rules`, then:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo usermod -aG audio $USER
```

Log out and back in (or reboot) for the group change to take effect.

#### Android:
When plugging in the Tanchjim Bunny DSP, Android will prompt you: *"Open Bunny DSP to handle TANCHJIM BUNNY DSP?"*. Allow this prompt to grant the app session access to the device.
* *Note:* Because committing settings triggers a hardware-level soft reboot of the DSP, Android treats this as a disconnect/reconnect and may ask for permission again. Depending on your custom ROM or launcher security settings, you can check the "Always open" or "Use by default" option to bypass future prompts.

---

## How the UI Works

The frontend features a single-page parametric EQ interface with a live,
canvas-based frequency response graph. Updating the values in the control panel
instantly recalculates the composite curve in real time using biquad filter
formulas, letting you preview the response before writing it to the hardware.

| Control | Function |
| --- | --- |
| **Read** | Fetches and displays the current settings stored in the device's flash memory. |
| **Commit** | Writes the current UI state to the device's flash. The hardware will reset afterward (indicated by an audible beep). |
| **Disable/Enable EQ** | Toggles between flat bypass (slot 2) and custom EQ (slot 3). This also triggers a hardware reset. |
| **Clear** | Resets the UI sliders to flat. This does *not* affect the hardware until you click **Commit**. |
| **Export/Import** | Saves or loads the current UI profile as a local JSON file. |
| **Mic Gain** | Controls the ADC microphone gain register (0x65) from -60 dB to +12 dB. |
| **L Vol / R Vol** | Per-channel digital DAC volume (register 0x66), -60 to 0 dB. |

---

## Project Structure

```text
bunnydsp/
├── src/
│   ├── app.js             # EQ UI, biquad graph rendering, import/export
│   ├── style.css          # App styling
│   ├── asano.png          # Togglable decoration in bottom-right corner
│   ├── banner.png         # Header banner image
│   └── favicon.png
├── src-tauri/
│   ├── gen/
│   │   └── android/       # Native Android project files
│   └── src/
│       ├── hid.rs         # HID protocol implementation (raw USB I/O)
│       ├── lib.rs         # Tauri commands, state management
│       └── main.rs        # Entry point
├── screenshots/
│   ├── screenshot1.png    # UI screenshot (top)
│   └── screenshot2.png    # UI screenshot (bottom)
├── index.html             # Single-page app shell
├── package.json           # Frontend dependencies (Vite + Tauri CLI)
├── vite.config.js         # Vite build config
├── Cargo.toml             # Rust dependencies
├── README.md
├── AGENTS.md
├── REGISTER-MAP.md
└── LICENSE
```

---

## The HID Protocol

The DSP chip exposes a vendor-defined feature report ID `0x4B` through HID interface
3. All EQ commands consist of 10-byte payloads preceded by this report ID byte.

Full protocol reference: `REGISTER-MAP.md`

### Command Structure

| Offset | Field |
| --- | --- |
| **0** | Register address (0x24-0x66) |
| **1-3** | Reserved (must be zero) |
| **4** | Command: `0x52` (read), `0x57` (write), `0x53` (commit), `0x43` (clear) |
| **5** | Reserved (must be zero) |
| **6-9** | Payload (little-endian) |

### Registers

| Address | Content |
| --- | --- |
| **0x24** | EQ slot selection: `2` = bypass, `3` = custom |
| **0x26-0x2F** | Five band pairs (gain + frequency, Q + filter type) |
| **0x54** | Device info (returns `TURN2CDC`) |
| **0x65** | Mic gain (digital ADC), -60 to +12 dB, int8 * 2 encoding |
| **0x66** | Per-channel digital DAC volume, -60 to 0 dB (byte 6 = L, byte 7 = R) |

### Band Encoding

Each EQ band spans two consecutive registers:

* **Even Register** (e.g., `0x26`): Gain (signed int16 LE, value / 10 = dB) +
  Frequency (uint16 LE, Hz)
* **Odd Register** (e.g., `0x27`): Q Factor (uint16 LE, value / 1000) +
  Filter Type (`0` = PK, `3` = LSQ, `4` = HSQ)

### Volume / Mic Gain Encoding (0x65, 0x66)

Volume and mic gain use **int8 * 2** encoding stored in a single unsigned byte:

```
encode: raw = dB * 2;  if raw < 0: raw += 256  -> unsigned byte
decode: signed = byte if byte <= 127 else byte - 256;  dB = signed / 2
```

| dB | Encoded byte |
|----|-------------|
| +12 | `0x18` (24) |
| 0   | `0x00` |
| -1  | `0xFE` (254) |
| -60 | `0x88` (136) |

### Commit & Reset Behavior

Sending the commit command (`0x53`) instructs the device to save all register
contents to flash and perform a hardware reset. During this process, the `hidraw`
node will briefly disappear and reappear under a different number within ~200ms.
The application automatically scans for new nodes and reconnects.

---

## References

The HID protocol used in this project was reverse-engineered from:

* **Decompiling the official Tanchjim Android app** (which provided the complete register map and command structure details, mapped out in [REGISTER-MAP.md](file:///home/daniel/Code/bunnydsp/REGISTER-MAP.md)).
* [jeromeof/devicePEQ](https://github.com/jeromeof/devicePEQ) (specifically `ktmicroUsbHidHandler.js` and the Bunny DSP configuration).
* Live USB packet captures performed on firmware v1.01 hardware.
* USB descriptor dumps gathered from the device's HID interface 3.
