# KTMicro Bunny DSP -- USB HID Register Map

> **Sources:** Tanchjim Android APK v2.3.2 (jadx decompilation) +
> live HID probing against real device, firmware v1.01 (bcdDevice=0101).
>
> **For project-specific implementation notes**, see `../AGENTS.md`.

---

## 1. Device Identification & USB Topology

### Identification

| Property | Value |
|----------|-------|
| USB VID:PID | `31b2:1112` (KTMicro) |
| Product string | `TANCHJIM BUNNY DSP` |
| Chip identifier | `TURN2CDC` (readable at HID report 0x54) |
| Firmware | v1.01 (bcdDevice=0101) |
| USB class | Composite: Audio Class 1.0 + HID |
| HID report descriptor | 70 bytes, 3 reports |

### USB Interface Topology

```
Interface 0  alt=0  Audio Control       (class=1, subclass=1)
Interface 1  alt=0  Audio Streaming     (class=1, subclass=2) -- idle
Interface 1  alt=2  Audio Streaming     (class=1, subclass=2) -- active
Interface 3  alt=0  HID                 (class=3, subclass=0)  ← DSP control
```

### Audio Topology (USB Audio Class descriptors)

```
Recording (Mic -> USB):
  Input Terminal 1 [Microphone, 1ch]
    -> Feature Unit 2 [Mute, Volume ch1]
    -> Selector Unit 3
    -> Output Terminal 4 [USB Streaming]

Playback (USB -> Speaker):
  Input Terminal 5 [USB Streaming, 2ch L+R]
    -> Mixer Unit 6
    -> Feature Unit 7 [Mute, Volume L, Volume R]
    -> Output Terminal 8 [Speaker]
```

> Mic gain via USB Audio Class (Feature Unit 2) is separate from the HID-based
> "Digital ADC" mic gain at register 0x65. The official app uses the HID register,
> not the USB Audio Class feature unit.

---

## 2. HID Reports

| Report ID | Type | Direction | Size | Purpose |
|-----------|------|-----------|------|---------|
| `0x01` | Consumer | IN | 1 byte | Play/pause, vol +/- |
| `0x4B` | Vendor feature | IN + OUT | 10 bytes | **EQ, mic gain, DAC, config** |
| `0x54` | Vendor feature | IN | 10 bytes | **Chip ID (read-only)** |

All DSP configuration uses report **0x4B**.

---

## 3. Packet Format (Report 0x4B)

10-byte payload after the 1-byte report ID prefix.

```
Byte 0:    Register address
Byte 1-3:  Reserved (0x00)
Byte 4:    Command
             0x52 = 'R'  (read register)
             0x57 = 'W'  (write register)
             0x53 = 'S'  (commit all settings to flash)
             0x43 = 'C'  (clear/reset)
Byte 5:    Reserved (0x00)
Byte 6-9:  Payload (little-endian, varies by register)
```

### Linux hidraw

```
write(fd, [0x4B, reg, 0,0,0, cmd, 0, b6,b7,b8,b9])   # 11 bytes
read(fd, 11)  -> response: [0x4B, reg, 0,0,0, cmd, 0, b6,b7,b8,b9]
```

Only **read (0x52)** and **commit (0x53)** generate input report responses.
Writes to non-existent registers silently return zeros.

### Android (official app -- for reference)

The official app uses vendor-specific USB control transfers, NOT standard HID
feature reports:

```
Write: controlTransfer(requestType=0x43, request=0xA0, index=0x09A0, data=[reportID, ...])
Read:  controlTransfer(requestType=0xC3, request=0xA1, index=0x09A0, data=buffer)
```

Payload format is identical between Linux hidraw and Android control transfers.

---

## 4. Register Map

### 4.1 EQ Enable / Slot -- 0x24

| Property | Value |
|----------|-------|
| Type | Read/Write |
| Byte 6 | Slot: `0x02` = bypass (EQ off), `0x03` = custom EQ |

### 4.2 EQ Bands -- 0x26 through 0x2F

5 bands, each spanning two registers (gain+freq then Q+type):

| Register | Band | Content |
|----------|------|---------|
| `0x26` | 1 | Gain (int16 LE, /10 = dB) + Frequency (uint16 LE, Hz) |
| `0x27` | 1 | Q (uint16 LE, /1000) + Type (0=PK, 3=LSQ, 4=HSQ) |
| `0x28` | 2 | Gain + Frequency |
| `0x29` | 2 | Q + Type |
| `0x2A` | 3 | Gain + Frequency |
| `0x2B` | 3 | Q + Type |
| `0x2C` | 4 | Gain + Frequency |
| `0x2D` | 4 | Q + Type |
| `0x2E` | 5 | Gain + Frequency |
| `0x2F` | 5 | Q + Type |

#### Encoding: Gain + Frequency registers (0x26, 0x28, 0x2A, 0x2C, 0x2E)

| Bytes | Type | Encoding |
|-------|------|----------|
| 6-7 | Gain | Signed int16 LE. Value / 10 = dB. E.g. `0x0078` (120) -> +12.0 dB, `0xFFF1` (-15) -> -1.5 dB |
| 8-9 | Frequency | Unsigned int16 LE. Value in Hz. E.g. `0x0032` -> 50 Hz |

#### Encoding: Q + Type registers (0x27, 0x29, 0x2B, 0x2D, 0x2F)

| Bytes | Type | Encoding |
|-------|------|----------|
| 6-7 | Q | Unsigned int16 LE. Value / 1000. E.g. `0x012C` (300) -> Q = 0.3 |
| 8 | Type | `0x00` = Peak, `0x03` = Low Shelf, `0x04` = High Shelf |
| 9 | -- | Reserved (0x00) |

#### Constraints

- 5 bands, frequency-ordered (no crossing)
- Gain: +/-12 dB, Q: 0.1-10.0 (100-10000 encoded)
- Types: Peak, Low Shelf, High Shelf

### 4.3 Mic Gain -- 0x65

| Property | Value |
|----------|-------|
| Official name | "Digital ADC" / 麦克风增益设置 |
| Type | Read/Write |
| Range | -60 to +12 dB |
| Encoding | **int8 * 2** at byte 6 |
| Read cmd | `[0x4B, 0x65, 0,0,0, 0x52, 0, 0,0,0,0]` |
| Write cmd | `[0x4B, 0x65, 0,0,0, 0x57, 0, encoded, 0,0,0]` |
| Requires commit | Yes (0x53) |

#### Encoding

```python
# Encode
raw = db_value * 2
if raw < 0: raw += 256
byte = raw & 0xFF

# Decode
signed = byte if byte <= 127 else byte - 256
db = signed / 2
```

| dB | Encoded byte |
|----|-------------|
| +12 | `0x18` (24) |
| 0 | `0x00` |
| -1 | `0xFE` (254) |
| -5 | `0xF6` (246) |
| -60 | `0x88` (136) |

### 4.4 Digital DAC Volume -- 0x66

| Property | Value |
|----------|-------|
| Official name | "Digital DAC" / 数字音量 |
| Type | Read/Write |
| Encoding | **Two int8 * 2**: byte 6 = Left, byte 7 = Right |
| Read cmd | `[0x4B, 0x66, 0,0,0, 0x52, 0, 0,0,0,0]` |
| Write cmd | `[0x4B, 0x66, 0,0,0, 0x57, 0, L_enc, R_enc, 0,0]` |
| Requires commit | Yes (0x53) |

**Both channels must be written together** -- the official app always sends
both bytes even when only one channel changes.

Encoding is identical to mic gain (int8 * 2). This is per-channel digital
volume, NOT a balance/pan control.

### 4.5 DAC Preset Index -- 0x3B

| Property | Value |
|----------|-------|
| Type | Read/Write |
| Encoding | uint8 at byte 6 |
| Read cmd | `[0x4B, 0x3B, 0,0,0, 0x52, 0, 0,0,0,0]` |
| Write cmd | `[0x4B, 0x3B, 0,0,0, 0x57, 0, index, 0,0,0]` |

### 4.6 Commit -- Command 0x53

```
Write: [0x4B, 0x00, 0,0,0, 0x53, 0, 0,0,0,0]
```

- Persists ALL writable registers to flash
- Triggers USB device reset (hidraw node disappears/reappears, ~200-500ms)
- Settings survive power cycles and work across any host
- The register address (`0x00`) doesn't matter -- commits everything globally

---

## 5. Read-Only Information Registers

These return static identification data. Writes are accepted (ACK byte 0x03)
but values do not change.

| Register(s) | Raw bytes | Decoded |
|-------------|-----------|---------|
| `0x00` | `52 45 47 3a` | `REG:` (ASCII) |
| `0x01` | `01 00 00 00` | Firmware major version (1) |
| `0x04`-`0x05` | `31 2e 30 2e` / `31 00 00 00` | `1.0.1` |
| `0x08`-`0x0A` | `53 65 70 ... 34 00` | `Sep  4 2024` (build date) |
| `0x0C`-`0x0D` | `31 31 3a 30 32 3a 34 30` | `11:02:40` (build time) |
| `0x10`-`0x11` | `61 30 66 63 37 35 33 00` | Build hash |
| `0x36`-`0x37` | `50 65 72 66 43 66 67 3a` | `PerfCfg:` (tag) |
| `0x3A` | `05 00 00 00` | Perf config flag (0x05) |
| `0x40`-`0x41` | `4b 54 4d 69 63 72 6f 00` | `KTMicro` |
| `0x48`-`0x4C` | `54 41 4e ... 44 53 50 00 00` | `TANCHJIM BUNNY DSP` |
| `0x50`-`0x52` | `32 30 32 34 30 39 30 39 32 30 31 37` | `202409092017` |
| `0x5B` | `b2 31 12 11` | VID=0x31B2 PID=0x1112 (LE) |
| `0x61` | `31 2a 2a 2a` | `1***` |

### Report 0x54 -- Chip ID

Reading report 0x54 always returns `TURN2CDC` regardless of command parameters:

```
Write:  [0x54, 0,0,0,0, 0, 0,0,0,0,0]
Read:   [0x54, 0x55, 0x52, 0x4e, 0x32, 0x43, 0x44, 0x43, 0x00, 0x00]
        = "TURN2CDC"
```

---

## 6. Unknown Registers

These registers accept writes but their purpose is unknown (not used by the
official app). Values vary between sequential reads.

| Register | Layout | Notes |
|----------|--------|-------|
| `0x64` | byte6, rest 0 | Varies (0x01, 0xD0, etc.) |
| `0x67` | bytes6-7 uint16, bytes8-9 0 | ~1000, varies |
| `0x68` | byte6, rest 0 | 0x42, varies |
| `0x69` | byte6, rest 0 | 0x01, varies |
| `0x71` | 4 bytes | Multi-byte config |
| `0x72` | 2* uint16 (10, 20) | Paired config |
| `0x73` | 2* uint16 (10, 500) | Paired config |
| `0x78` | byte6, rest 0 | 0xFD |
| `0x79` | 2* uint16 (10, 300) | Paired config |
| `0x7A` | 2* uint16 (10, 100) | Paired config |
| `0xE1` | 4 bytes `78 56 34 12` | Magic number |

---

## 7. Key Behaviors

1. **Writes are fire-and-forget** -- only read (0x52) and commit (0x53) generate
   responses. Write (0x57) may receive a stale ACK (byte 6 = 0x03) on next read.

2. **Commit triggers USB reset** -- the hidraw node disappears and reappears.
   Must re-scan `/dev/hidraw*` and re-open.

3. **Commit stores to flash** -- settings survive power cycles and work across
   different host devices.

4. **Bypass (slot 0x02) also triggers USB reset** -- same reconnection needed.

5. **All non-zero registers are writable** (verified by probing). Zero-valued
   registers either don't exist or are reserved.

6. **Commit register address doesn't matter** -- `0x53` to `0x00` commits
   everything globally.

7. **Chip ID at report 0x54** always returns `TURN2CDC` regardless of command
   parameters.

---

## 8. Feature Comparison: Official App

| Feature | Official App | Register |
|---------|-------------|----------|
| 5-band PEQ | ✓ | 0x26-0x2F |
| EQ bypass | ✓ (slot 0x02) | 0x24 |
| EQ commit to flash | ✓ (0x53) | 0x00 |
| Mic gain (-60 to +12 dB) | ✓ ("Digital ADC") | 0x65 |
| Per-channel digital volume | ✓ ("Digital DAC") | 0x66 (L+R) |
| DAC preset selector | ✓ | 0x3B |
| L/R balance (single slider) | ✗ | -- |
| Pregain (auto-calculated) | ✗ | -- |

---

## 9. Common Misunderstandings

### 0x66 is NOT mic gain or pregain

Several open-source projects (including devicePEQ) treat register 0x66 as
"pregain" or "mic gain." This is incorrect. Register 0x66 is per-channel
**Digital DAC volume** (two bytes: L + R).

### 0x65 IS mic gain

The official app has a dedicated "Microphone Gain Setting" page
(`typec_mic.vue`) that reads/writes register 0x65. Encoding is `value * 2`
as signed 8-bit, range -60 to +12 dB.

### No balance slider in the official app

The official app has independent L/R digital volume under "Advanced Settings"
-> "Digital DAC." The `balanceMic` variable in the decompiled code belongs to
the Stargate II (WalkPlay) handler, not Bunny DSP (KTMicro).

---

## 10. Official App Code Patterns

Documented here for reference when reverse-engineering or verifying behavior.

### Device identification

```java
// SmallTail.java (simplified)
if (device.getProductName().contains("TANCHJIM-")
    && device.getVendorId() != 0x31BE   // Typec cable
    && device.getVendorId() != 0x3302)  // Stargate II
{ /* Bunny DSP */ }
```

### Reading EQ bands

```javascript
// cable_x_voice_custom.vue -- sequential reads
sendHidData("4b 26 00 00 00 52 00 00 00 00 00"); // Band 1 gain+freq
sendHidData("4b 27 00 00 00 52 00 00 00 00 00"); // Band 1 Q+type
// ... bands 2-5 at 0x28-0x2F
```

### Writing EQ bands

```javascript
// Format: "4b <reg> 00 00 00 57 00 <gain_hex> <freq_hex>"
sendHidData("4b 26 00 00 00 57 00 " + gainHex + " " + freqHex);
```

### Writing mic gain

```javascript
function saveMicGain(dbValue) {
    var raw = dbValue < 0 ? (256 + 2 * dbValue) : (2 * dbValue);
    sendHidData("4b 65 00 00 00 57 00 " + raw.toString(16).padStart(2,'0') + " 00 00 00");
    setTimeout(() => sendHidData("4b 00 00 00 00 53 00 00 00 00 00"), 200);
}
```

### Parsing responses

```javascript
function parseResponse(dataArray) {
    // dataArray indices are 11-byte HID packet (index 0 = report ID)
    // dataArray[7] = byte 6 (first payload byte)
    var register = dataArray[1];
    var command  = dataArray[5];

    if (command == "52") { // Read response
        switch (register) {
            case "65": // Mic gain
                var raw = parseInt(dataArray[7], 16);
                var signed = raw > 128 ? raw - 256 : raw;
                var dbValue = signed / 2;
                break;
            case "66": // Digital DAC
                var rawL = parseInt(dataArray[7], 16);  // Left
                var rawR = parseInt(dataArray[8], 16);  // Right
                break;
        }
    }
}
```

> `dataArray[6]` = byte 5 (reserved), `dataArray[7]` = byte 6 (first payload byte)

---

## 11. References

- **Tanchjim APK v2.3.2** -- decompiled with jadx
  - `SmallTail.java` -- USB control transfer bridge
  - `cable_x_voice_custom.vue` -- EQ + DAC + mic gain
  - `typec_mic.vue` -- dedicated mic gain page
- **devicePEQ** (GitHub: jeromeof/devicePEQ) -- partial reference, has register 0x66 mislabeled
- **Live HID probing** -- Tanchjim Bunny DSP, firmware v1.01
