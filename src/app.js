import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';

let leftVol = 0;
let rightVol = 0;
let micGain = 0;
let eqEnabled = true;
let hasChanges = false;
let connected = false;
let _wasConnected = false;
let isWorking = false;
let _reading = false;
let _pollTimer = null;
let _pollFails = 0;
let _needsReread = false;
let _initialReadDone = false;
let _dots = [];
let _drag = null;

const FREQ_POINTS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const disabled = [false, false, false, false, false];

document.getElementById('bands').innerHTML = [0, 1, 2, 3, 4].map(createBandHTML).join('');
drawEQ();
startPolling();

new ResizeObserver(drawEQ).observe(document.getElementById('eqCanvas'));
(function() {
  const c = document.getElementById('eqCanvas');
  c.addEventListener('mousedown', _onMouseDown);
  c.addEventListener('mousemove', _onMouseMove);
  c.addEventListener('mouseup', _onMouseUp);
  c.addEventListener('mouseleave', _onMouseUp);
})();

function createBandHTML(i) {
  return `
    <div class="band" id="band${i}">
      <div class="band-number">#${i + 1}</div>
      <div class="band-field">
        <label>Type</label>
        <select onchange="bandChanged(${i})" id="type${i}">
          <option value="PK">Peak</option>
          <option value="LSQ">Low Shelf</option>
          <option value="HSQ">High Shelf</option>
        </select>
      </div>
      <div class="band-field">
        <label>Frequency</label>
        <input type="range" id="freq${i}" min="20" max="20000" value="1000" step="1" oninput="document.getElementById('freqNum${i}').value=this.value;bandChanged(${i})">
        <div class="band-input-row">
          <input type="number" id="freqNum${i}" class="band-num" value="1000" min="20" max="20000" step="1" onchange="bandNumChanged(${i},'freq')" onkeydown="bandNumKey(event,${i},'freq')">
          <span class="unit">Hz</span>
        </div>
      </div>
      <div class="band-field">
        <label>Gain</label>
        <input type="range" id="gain${i}" min="-12" max="12" value="0" step="0.1" oninput="document.getElementById('gainNum${i}').value=this.value;bandChanged(${i})">
        <div class="band-input-row">
          <input type="number" id="gainNum${i}" class="band-num" value="0" min="-12" max="12" step="0.1" onchange="bandNumChanged(${i},'gain')" onkeydown="bandNumKey(event,${i},'gain')">
          <span class="unit">dB</span>
        </div>
      </div>
      <div class="band-field">
        <label>Q Factor</label>
        <input type="range" id="q${i}" min="0.1" max="10" value="1.0" step="0.1" oninput="document.getElementById('qNum${i}').value=this.value;bandChanged(${i})">
        <div class="band-input-row">
          <input type="number" id="qNum${i}" class="band-num" value="1.0" min="0.1" max="10" step="0.1" onchange="bandNumChanged(${i},'q')" onkeydown="bandNumKey(event,${i},'q')">
        </div>
      </div>
      <div class="band-toggle" id="toggle${i}" onclick="toggleBand(${i})">Enabled</div>
    </div>`;
}

function toggleBand(i) {
  if (!connected || isWorking) return;
  disabled[i] = !disabled[i];
  const el = document.getElementById('toggle' + i);
  el.textContent = disabled[i] ? 'Disabled' : 'Enabled';
  el.className = 'band-toggle' + (disabled[i] ? ' disabled' : '');
  markChanged();
  drawEQ();
}

function bandChanged(i) {
  document.getElementById('freqNum' + i).value = document.getElementById('freq' + i).value;
  document.getElementById('gainNum' + i).value = document.getElementById('gain' + i).value;
  document.getElementById('qNum' + i).value = document.getElementById('q' + i).value;
  enforceFreqOrder();
  if (!_reading) markChanged();
  drawEQ();
}

function bandNumChanged(i, field) {
  const slider = document.getElementById(field + i);
  const num = document.getElementById(field + 'Num' + i);
  let v = parseFloat(num.value);
  if (isNaN(v)) { num.value = slider.value; return; }
  const step = parseFloat(slider.step) || 1;
  v = Math.round(v / step) * step;
  v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v));
  slider.value = v;
  num.value = v;
  bandChanged(i);
}

function bandNumKey(event, i, field) {
  if (event.key === 'Enter') { event.preventDefault(); bandNumChanged(i, field); }
}

function enforceFreqOrder() {
  if (_reading) return;
  for (let i = 0; i < 5; i++) {
    const s = document.getElementById('freq' + i);
    s.min = i > 0 ? parseInt(document.getElementById('freq' + (i-1)).value) + 1 : 20;
    s.max = i < 4 ? parseInt(document.getElementById('freq' + (i+1)).value) - 1 : 20000;
  }
}

function updateLeftVol() {
  const slider = document.getElementById('leftVolSlider');
  const input = document.getElementById('leftVolInput');
  const val = parseFloat(input.value);
  if (document.activeElement === input) slider.value = val;
  else input.value = slider.value;
  leftVol = parseFloat(slider.value);
  if (!_reading) markChanged();
}

function updateRightVol() {
  const slider = document.getElementById('rightVolSlider');
  const input = document.getElementById('rightVolInput');
  const val = parseFloat(input.value);
  if (document.activeElement === input) slider.value = val;
  else input.value = slider.value;
  rightVol = parseFloat(slider.value);
  if (!_reading) markChanged();
}

function updateMicGain() {
  const slider = document.getElementById('micGainSlider');
  const input = document.getElementById('micGainInput');
  const val = parseFloat(input.value);
  if (document.activeElement === input) slider.value = val;
  else input.value = slider.value;
  micGain = parseFloat(slider.value);
  if (!_reading) markChanged();
}

function _canvasCoords(e) {
  const c = document.getElementById('eqCanvas');
  const r = c.getBoundingClientRect();
  return { mx: e.clientX - r.left, my: e.clientY - r.top, W: r.width, H: r.height };
}

function _onMouseDown(e) {
  const co = _canvasCoords(e);
  for (let i = _dots.length - 1; i >= 0; i--) {
    const d = _dots[i];
    if ((co.mx - d.x) ** 2 + (co.my - d.y) ** 2 <= 64) {
      _drag = { band: d.band };
      document.getElementById('eqCanvas').style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
  }
}

function _onMouseMove(e) {
  const canvas = document.getElementById('eqCanvas');
  if (!_drag) {
    const co = _canvasCoords(e);
    let over = false;
    for (const d of _dots) {
      if ((co.mx - d.x) ** 2 + (co.my - d.y) ** 2 <= 64) { over = true; break; }
    }
    canvas.style.cursor = over ? 'grab' : '';
    return;
  }
  const co = _canvasCoords(e);
  const b = _drag.band;
  const fMin = 20, fMax = 20000, dbMin = -15, dbMax = 15;
  let freq = Math.round(fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, co.mx / co.W))));
  if (b > 0) freq = Math.max(freq, parseFloat(document.getElementById('freq' + (b - 1)).value) + 1);
  if (b < 4) freq = Math.min(freq, parseFloat(document.getElementById('freq' + (b + 1)).value) - 1);
  freq = Math.max(20, Math.min(20000, freq));
  let gain = Math.round((dbMax - (co.my / co.H) * (dbMax - dbMin)) * 10) / 10;
  gain = Math.max(-12, Math.min(12, gain));
  const fs = document.getElementById('freq' + b);
  fs.min = b > 0 ? parseFloat(document.getElementById('freq' + (b - 1)).value) + 1 : 20;
  fs.max = b < 4 ? parseFloat(document.getElementById('freq' + (b + 1)).value) - 1 : 20000;
  fs.value = freq;
  document.getElementById('gain' + b).value = gain;
  bandChanged(b);
}

function _onMouseUp() {
  _drag = null;
  document.getElementById('eqCanvas').style.cursor = '';
}

function markChanged() {
  if (_reading) return;
  if (!hasChanges) {
    hasChanges = true;
    syncButtonStates();
  }
}

function syncButtonStates() {
  const commitBtn = document.getElementById('commitBtn');
  const permDenied = document.getElementById('permDeniedOverlay').classList.contains('visible');
  commitBtn.disabled = !hasChanges || !connected || isWorking || permDenied;

  document.getElementById('readBtn').disabled = !connected || isWorking || permDenied;
  document.getElementById('bypassBtn').disabled = !connected || isWorking || permDenied;
  document.getElementById('clearBtn').disabled = !connected || isWorking || permDenied;
  document.getElementById('importBtn').disabled = !connected || isWorking || permDenied;

  const overlay = document.getElementById('disconnectOverlay');
  overlay.classList.toggle('visible', !connected && !permDenied);
  document.getElementById('app').classList.toggle('offline', !connected || isWorking || permDenied);

  const inputs = document.querySelectorAll('.band input, .band select');
  const canInteract = connected && !isWorking && !permDenied;
  inputs.forEach(el => { el.disabled = !canInteract; });
  document.getElementById('leftVolSlider').disabled = !canInteract;
  document.getElementById('leftVolInput').disabled = !canInteract;
  document.getElementById('rightVolSlider').disabled = !canInteract;
  document.getElementById('rightVolInput').disabled = !canInteract;
  document.getElementById('micGainSlider').disabled = !canInteract;
  document.getElementById('micGainInput').disabled = !canInteract;

  document.querySelectorAll('.band-toggle').forEach(el => {
    el.classList.toggle('ui-disabled', !canInteract);
  });
}

function drawEQ() {
  const canvas = document.getElementById('eqCanvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);
  _dots = [];

  const fMin = 20, fMax = 20000;
  const dbMin = -15, dbMax = 15;

  function freqToX(f) { return Math.log(f / fMin) / Math.log(fMax / fMin) * W; }
  function dbToY(db) { return H - ((db - dbMin) / (dbMax - dbMin)) * H; }

  // grid
  ctx.strokeStyle = '#ddd9d4';
  ctx.lineWidth = 1;
  for (let db = -12; db <= 12; db += 3) {
    const y = dbToY(db);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = '#9a9590';
    ctx.font = '10px League Spartan';
    ctx.fillText(db + ' dB', 4, y - 3);
  }
  for (const f of FREQ_POINTS) {
    const x = freqToX(f);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = '#9a9590';
    ctx.font = '10px League Spartan';
    ctx.textAlign = 'center';
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x, H - 2);
    ctx.textAlign = 'start';
  }
  // 0 dB line
  ctx.strokeStyle = '#d4cfca';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, dbToY(0));
  ctx.lineTo(W, dbToY(0));
  ctx.stroke();

  // composite frequency response
  const steps = 800;

  // individual band curves (faint, behind composite)
  for (let b = 0; b < 5; b++) {
    if (disabled[b]) continue;
    const ft = document.getElementById('type' + b)?.value || 'PK';
    const fc = parseFloat(document.getElementById('freq' + b)?.value || 1000);
    const g = parseFloat(document.getElementById('gain' + b)?.value || 0);
    const q = parseFloat(document.getElementById('q' + b)?.value || 1);
    if (g === 0) continue;
    ctx.beginPath();
    let bfirst = true;
    for (let i = 0; i <= steps; i++) {
      const f = fMin * Math.pow(fMax / fMin, i / steps);
      let db = filterResponse(f, fc, g, q, ft);
      db = Math.max(dbMin, Math.min(dbMax, db));
      const x = freqToX(f), y = dbToY(db);
      if (bfirst) { ctx.moveTo(x, y); bfirst = false; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(42, 75, 127, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // composite curve
  ctx.beginPath();
  let first = true;
  for (let i = 0; i <= steps; i++) {
    const f = fMin * Math.pow(fMax / fMin, i / steps);
    let totalDb = 0;
    for (let b = 0; b < 5; b++) {
      if (disabled[b]) continue;
      const ft = document.getElementById('type' + b)?.value || 'PK';
      const fc = parseFloat(document.getElementById('freq' + b)?.value || 1000);
      const g = parseFloat(document.getElementById('gain' + b)?.value || 0);
      const q = parseFloat(document.getElementById('q' + b)?.value || 1);
      if (g === 0) continue;
      totalDb += filterResponse(f, fc, g, q, ft);
    }
    totalDb = Math.max(dbMin, Math.min(dbMax, totalDb));
    const x = freqToX(f), y = dbToY(totalDb);
    if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#D4A373';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // eq off indicator
  if (!eqEnabled) {
    ctx.fillStyle = 'rgba(217, 117, 107, 0.07)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d9756b';
    ctx.font = 'bold 14px League Spartan';
    ctx.textAlign = 'center';
    ctx.fillText('EQ DISABLED - Flat Response', W / 2, 30);
    ctx.textAlign = 'start';
    return;
  }

  // filter markers
  for (let b = 0; b < 5; b++) {
    if (disabled[b]) continue;
    const fc = parseFloat(document.getElementById('freq' + b)?.value || 1000);
    const g = parseFloat(document.getElementById('gain' + b)?.value || 0);
    if (g === 0) continue;
    const x = freqToX(fc), y = dbToY(g);
    _dots.push({ x, y, band: b });
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#d3dee8';
    ctx.fill();
    ctx.fillStyle = '#2c2926';
    ctx.font = 'bold 10px League Spartan';
    ctx.textAlign = 'center';
    ctx.fillText((b + 1), x, y - 10);
    ctx.textAlign = 'start';
  }
}

function filterResponse(f, fc, gain, q, type) {
  if (q <= 0.01) q = 0.1;
  const A = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * fc;
  const w = 2 * Math.PI * f;

  if (type === 'PK') {
    const num = Math.pow(w0 * w0 - w * w, 2) + Math.pow((A / q) * w0 * w, 2);
    const den = Math.pow(w0 * w0 - w * w, 2) + Math.pow((1 / (A * q)) * w0 * w, 2);
    return 10 * Math.log10(Math.max(num / den, 1e-15));
  }

  const w0w = w0 * w;
  const w0_sq = w0 * w0;
  const w_sq = w * w;

  if (type === 'LSQ') {
    const sqrtA = Math.sqrt(A);
    const num_sq = Math.pow(A * w0_sq - w_sq, 2) + Math.pow(sqrtA / q * w0w, 2);
    const den_sq = Math.pow(w0_sq - A * w_sq, 2) + Math.pow(sqrtA / q * w0w, 2);
    return 10 * Math.log10(Math.max(A * A * num_sq / den_sq, 1e-15));
  }

  if (type === 'HSQ') {
    const sqrtA = Math.sqrt(A);
    const num_sq = Math.pow(w0_sq - A * w_sq, 2) + Math.pow(sqrtA / q * w0w, 2);
    const den_sq = Math.pow(A * w0_sq - w_sq, 2) + Math.pow(sqrtA / q * w0w, 2);
    return 10 * Math.log10(Math.max(num_sq / den_sq, 1e-15));
  }

  return 0;
}

// --- Tauri IPC helpers ---

function notify(msg, type = 'success', persistent = false) {
  const el = document.getElementById('notify');
  el.textContent = msg;
  el.className = 'notify ' + type;
  if (el._timer) { clearTimeout(el._timer); el._timer = null; }
  if (!persistent) {
    el._timer = setTimeout(() => { el.className = 'notify'; }, 4000);
  }
}

// --- Polling ---

function startPolling() {
  checkStatus();
  _pollTimer = setInterval(checkStatus, 5000);
}

async function checkStatus() {
  try {
    const data = await invoke('status');
    if (data.connected) {
      _pollFails = 0;
      document.getElementById('permDeniedOverlay').classList.remove('visible');
      if (!connected) {
        connected = true;
        syncButtonStates();
        document.getElementById('statusDot').className = 'status-dot';
        document.getElementById('statusText').textContent = 'Connected';
        document.getElementById('chipId').textContent = data.chip_id || '?';
        if (_wasConnected) notify('Reconnected', 'success');
        if (_needsReread || !_initialReadDone) {
          _needsReread = false;
          _initialReadDone = true;
          readAll(true);
        }
      } else if (_needsReread) {
        _needsReread = false;
        readAll(true);
      } else if (data.chip_id && data.chip_id !== '?') {
        document.getElementById('chipId').textContent = data.chip_id;
      }
      _wasConnected = true;
    } else if (data.permission_denied) {
      _pollFails = 0;
      document.getElementById('disconnectOverlay').classList.remove('visible');
      document.getElementById('permDeniedOverlay').classList.add('visible');
      document.getElementById('statusDot').className = 'status-dot error';
      document.getElementById('statusText').textContent = 'Permission denied';
      document.getElementById('chipId').textContent = '-';
      connected = false;
      syncButtonStates();
    } else {
      gotDisconnected();
    }
  } catch (_e) {
    gotDisconnected();
  }
}

function gotDisconnected() {
  _pollFails++;
  if (_pollFails < 2) return;
  if (!connected && !_wasConnected) {
    _wasConnected = true;
  } else if (!connected) {
    return;
  }
  if (connected) {
    connected = false;
    notify('Device disconnected - controls disabled', 'error', true);
  }
  document.getElementById('statusDot').className = 'status-dot error';
  document.getElementById('statusText').textContent = 'Disconnected';
  document.getElementById('chipId').textContent = '-';
  syncButtonStates();
}

// --- Read / Commit / Bypass ---

async function readAll(quiet = false) {
  if (isWorking) return;
  isWorking = true;
  syncButtonStates();
  if (!quiet) notify('Reading from device...');

  try {
    const data = await invoke('read_all');
    if (!data) return;
    if (data.error) {
      notify(data.error, 'error');
      gotDisconnected();
      return;
    }

    _reading = true;
    if (data.filters && data.filters.length > 0) {
      for (let i = 0; i < data.filters.length; i++) {
        const f = data.filters[i];
        document.getElementById('type' + i).value = f.type;
        document.getElementById('freq' + i).value = f.freq;
        document.getElementById('gain' + i).value = f.gain;
        document.getElementById('q' + i).value = f.q;
        bandChanged(i);
      }
    }

    document.getElementById('leftVolSlider').value = data.left_vol || 0;
    document.getElementById('leftVolInput').value = data.left_vol || 0;
    leftVol = data.left_vol || 0;

    document.getElementById('rightVolSlider').value = data.right_vol || 0;
    document.getElementById('rightVolInput').value = data.right_vol || 0;
    rightVol = data.right_vol || 0;

    document.getElementById('micGainSlider').value = data.mic_gain || 0;
    document.getElementById('micGainInput').value = data.mic_gain || 0;
    micGain = data.mic_gain || 0;
    _reading = false;
    enforceFreqOrder();

    eqEnabled = data.enabled !== false;
    updateBypassUI();
    document.getElementById('slotInfo').textContent = eqEnabled ? 'EQ: Active' : 'EQ: Off';
    document.getElementById('chipId').textContent = data.chip_id || '?';

    connected = true;
    _pollFails = 0;
    document.getElementById('statusDot').className = 'status-dot';
    document.getElementById('statusText').textContent = 'Connected';

    hasChanges = false;
    drawEQ();
    if (!quiet) notify('Read ' + data.filters.length + ' filters', 'success');
  } catch (e) {
    notify('Read failed: ' + e, 'error');
    gotDisconnected();
  } finally {
    isWorking = false;
    syncButtonStates();
  }
}

async function commit() {
  if (isWorking || !hasChanges || !connected) return;
  isWorking = true;
  syncButtonStates();
  notify('Writing to device...');

  try {
    const filters = [];
    for (let i = 0; i < 5; i++) {
      filters.push({
        freq: parseFloat(document.getElementById('freq' + i).value),
        gain: disabled[i] ? 0 : parseFloat(document.getElementById('gain' + i).value),
        q: parseFloat(document.getElementById('q' + i).value),
        type: document.getElementById('type' + i).value,
        disabled: disabled[i]
      });
    }
    const leftVolVal = parseFloat(document.getElementById('leftVolSlider').value);
    const rightVolVal = parseFloat(document.getElementById('rightVolSlider').value);
    const micGainVal = parseFloat(document.getElementById('micGainSlider').value);

    const data = await invoke('commit', {
      filters,
      leftVol: leftVolVal,
      rightVol: rightVolVal,
      micGain: micGainVal
    });

    if (data && data.success) {
      hasChanges = false;
      notify('✓ Committed! You should hear a beep.', 'success');
    } else if (data && data.error) {
      notify(data.error, 'error');
    }
  } catch (e) {
    notify('Commit failed: ' + e, 'error');
    gotDisconnected();
  } finally {
    isWorking = false;
    syncButtonStates();
  }
}

async function clearAll() {
  if (!confirm('Reset all filters to flat (gain=0)?')) return;
  _reading = true;
  const defaults = [100, 500, 1000, 5000, 10000];
  for (let i = 0; i < 5; i++) {
    document.getElementById('gain' + i).value = 0;
    document.getElementById('freq' + i).value = defaults[i];
    document.getElementById('q' + i).value = 1;
    document.getElementById('type' + i).value = 'PK';
    disabled[i] = false;
    document.getElementById('toggle' + i).textContent = 'Enabled';
    document.getElementById('toggle' + i).className = 'band-toggle';
  }
  document.getElementById('leftVolSlider').value = 0;
  document.getElementById('leftVolInput').value = 0;
  leftVol = 0;
  document.getElementById('rightVolSlider').value = 0;
  document.getElementById('rightVolInput').value = 0;
  rightVol = 0;
  document.getElementById('micGainSlider').value = 0;
  document.getElementById('micGainInput').value = 0;
  micGain = 0;
  _reading = false;
  enforceFreqOrder();
  markChanged();
  drawEQ();
  notify('UI reset. Press "Commit" to write.', 'success');
}

function toggleAsano() {
  document.querySelector('.corner-asano-wrap').classList.toggle('hidden');
  document.querySelector('.asano-toggle').classList.toggle('hidden');
}

function getConfig() {
  const bands = [];
  for (let i = 0; i < 5; i++) {
    bands.push({
      type: document.getElementById('type' + i).value,
      freq: parseFloat(document.getElementById('freq' + i).value),
      gain: parseFloat(document.getElementById('gain' + i).value),
      q: parseFloat(document.getElementById('q' + i).value),
      disabled: disabled[i]
    });
  }
  return {
    format: 'bunnydsp-v1',
    leftVol: parseFloat(document.getElementById('leftVolSlider').value),
    rightVol: parseFloat(document.getElementById('rightVolSlider').value),
    micGain: parseFloat(document.getElementById('micGainSlider').value),
    bands
  };
}

function exportConfig() {
  const cfg = getConfig();
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bunnydsp-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
  downloadDir().then(dir => {
    notify('Exported to ' + dir + '/bunnydsp-' + ts + '.json', 'success');
  }).catch(() => {
    notify('Exported to Downloads/bunnydsp-' + ts + '.json', 'success');
  });
}

function importConfig(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    processImportJSON(e.target.result);
  };
  reader.readAsText(file);
}

function processImportJSON(json) {
  let cfg;
  try {
    cfg = JSON.parse(json);
  } catch (_) {
    notify('Invalid JSON file', 'error');
    return;
  }

  if (!cfg.format || !cfg.format.startsWith('bunnydsp-')) {
    notify('Not a Bunny DSP config file (missing "format")', 'error');
    return;
  }
  if (!Array.isArray(cfg.bands)) {
    notify('Invalid config: missing "bands" array', 'error');
    return;
  }

  const validTypes = ['PK', 'LSQ', 'HSQ'];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const lv = clamp(parseFloat(cfg.leftVol) || 0, -60, 0);
  const rv = clamp(parseFloat(cfg.rightVol) || 0, -60, 0);
  document.getElementById('leftVolSlider').value = lv;
  document.getElementById('leftVolInput').value = lv;
  leftVol = lv;
  document.getElementById('rightVolSlider').value = rv;
  document.getElementById('rightVolInput').value = rv;
  rightVol = rv;

  const mg = clamp(parseFloat(cfg.micGain) || 0, -60, 12);
  document.getElementById('micGainSlider').value = mg;
  document.getElementById('micGainInput').value = mg;
  micGain = mg;

  _reading = true;
  for (let i = 0; i < Math.min(cfg.bands.length, 5); i++) {
    const b = cfg.bands[i] || {};
    const type = validTypes.includes(b.type) ? b.type : 'PK';
    const freq = clamp(parseFloat(b.freq) || 1000, 20, 20000);
    const gain = clamp(parseFloat(b.gain) || 0, -12, 12);
    const q = clamp(parseFloat(b.q) || 1.0, 0.1, 10);

    document.getElementById('type' + i).value = type;
    document.getElementById('freq' + i).value = freq;
    document.getElementById('gain' + i).value = gain;
    document.getElementById('q' + i).value = q;
    bandChanged(i);

    disabled[i] = !!b.disabled;
    const toggle = document.getElementById('toggle' + i);
    toggle.textContent = disabled[i] ? 'Disabled' : 'Enabled';
    toggle.className = 'band-toggle' + (disabled[i] ? ' disabled' : '');
  }

  for (let i = cfg.bands.length; i < 5; i++) {
    const defaults = [100, 500, 1000, 5000, 10000];
    document.getElementById('type' + i).value = 'PK';
    document.getElementById('freq' + i).value = defaults[i];
    document.getElementById('gain' + i).value = 0;
    document.getElementById('q' + i).value = 1.0;
    bandChanged(i);
    disabled[i] = false;
    const toggle = document.getElementById('toggle' + i);
    toggle.textContent = 'Enabled';
    toggle.className = 'band-toggle';
  }

  _reading = false;
  enforceFreqOrder();
  markChanged();
  drawEQ();
  notify(`Imported ${cfg.bands.length} band(s). Review and press Commit.`, 'success');
}

function updateBypassUI() {
  const btn = document.getElementById('bypassBtn');
  btn.textContent = eqEnabled ? '⏻ Disable EQ' : '⏻ Enable EQ';
}

async function toggleBypass() {
  if (isWorking || !connected) return;
  const targetSlot = eqEnabled ? 2 : 3;
  try {
    const data = await invoke('toggle_bypass', { targetSlot });
    if (!data) return;
    eqEnabled = data.enabled;
    updateBypassUI();
    document.getElementById('slotInfo').textContent = eqEnabled ? 'EQ: Active' : 'EQ: Off';
    drawEQ();
    notify(eqEnabled ? 'EQ enabled' : 'EQ disabled', 'success');
    if (eqEnabled) _needsReread = true;
  } catch (e) {
    notify('Bypass toggle failed: ' + e, 'error');
  }
}

function retryConnection() {
  notify('Reconnecting...', 'success');
  readAll();
}

// Expose handler functions globally for onclick attributes
window.toggleBand = toggleBand;
window.bandChanged = bandChanged;
window.bandNumChanged = bandNumChanged;
window.bandNumKey = bandNumKey;
window.updateLeftVol = updateLeftVol;
window.updateRightVol = updateRightVol;
window.updateMicGain = updateMicGain;
window.readAll = readAll;
window.commit = commit;
window.clearAll = clearAll;
window.toggleAsano = toggleAsano;
window.exportConfig = exportConfig;
window.importConfig = importConfig;
window.toggleBypass = toggleBypass;
window.retryConnection = retryConnection;
