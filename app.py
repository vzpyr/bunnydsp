#!/usr/bin/env python3
"""bunny dsp eq controller"""
import os, sys, time, fcntl, errno, atexit, logging, random
from typing import Optional
from flask import Flask, jsonify, request, render_template

PORT_MIN = 18000
PORT_MAX = 18999

logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger('bunnydsp')


def _pick_port() -> int:
    import socket
    for _ in range(100):
        port = random.randint(PORT_MIN, PORT_MAX)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', port))
                return port
        except OSError:
            continue
    raise RuntimeError('Could not find a free port')

REPORT_ID = 0x4B
DEVICE_NAME = 'TANCHJIM BUNNY DSP'

CMD_READ   = 0x52
CMD_WRITE  = 0x57
CMD_COMMIT = 0x53
CMD_CLEAR  = 0x43

REG_ENABLE  = 0x24
REG_GLOBAL  = 0x66
FILTER_BASE = 0x26

DISABLED_SLOT = 0x02
CUSTOM_SLOT   = 0x03
FILTER_COUNT  = 5

app = Flask(__name__)
fd = None
hidraw_path = None
perm_denied = False


def _set_nonblock(fileno: int) -> None:
    flags = fcntl.fcntl(fileno, fcntl.F_GETFL)
    fcntl.fcntl(fileno, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def _close_fd() -> None:
    global fd
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


atexit.register(_close_fd)


def find_device() -> Optional[str]:
    for hid in sorted(os.listdir('/dev')):
        if not hid.startswith('hidraw'):
            continue
        uevent = f'/sys/class/hidraw/{hid}/device/uevent'
        try:
            with open(uevent) as f:
                for line in f:
                    if DEVICE_NAME in line:
                        return f'/dev/{hid}'
        except OSError:
            continue
    return None


def init_hid() -> bool:
    global fd, hidraw_path, perm_denied
    hidraw_path = find_device()
    if not hidraw_path:
        perm_denied = False
        return False
    try:
        fd = os.open(hidraw_path, os.O_RDWR)
    except PermissionError:
        perm_denied = True
        log.warning('Permission denied for %s. Run with sudo -E or set up '
                     'udev rules.', hidraw_path)
        return False
    perm_denied = False
    _set_nonblock(fd)
    log.info('\u2713 Found %s at %s', DEVICE_NAME, hidraw_path)
    return True


def reopen() -> bool:
    global fd, hidraw_path
    time.sleep(0.2)
    new_path = find_device()
    if not new_path:
        return False
    try:
        new_fd = os.open(new_path, os.O_RDWR)
        _set_nonblock(new_fd)
        try:
            os.close(fd)
        except OSError:
            pass
        fd = new_fd
        hidraw_path = new_path
        log.info('\u2713 Reconnected at %s', new_path)
        return True
    except OSError:
        return False


def ensure_connected() -> bool:
    global fd
    if fd is None:
        return False
    try:
        os.read(fd, 1)
    except BlockingIOError:
        return True
    except OSError:
        for _ in range(10):
            if reopen():
                time.sleep(0.5)
                return True
        return False
    return True


def read_chip_id() -> str:
    try:
        probe = bytes([0x54, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        os.write(fd, probe)
        time.sleep(0.05)
        raw = os.read(fd, 16)
        if len(raw) > 1:
            return raw[1:9].rstrip(b'\x00').decode('ascii', errors='replace')
    except Exception:
        pass
    return '?'


def write_report(data: bytes) -> None:
    assert len(data) == 10
    packet = bytes([REPORT_ID]) + data
    for _ in range(3):
        try:
            os.write(fd, packet)
            time.sleep(0.03)
            return
        except OSError as e:
            if e.errno in (errno.EIO, errno.ENODEV, errno.EBADF):
                if not reopen():
                    raise OSError(errno.ENODEV,
                                  f'{DEVICE_NAME} not found after reconnect')
            else:
                raise
    raise OSError(errno.ENODEV, 'Failed to write after multiple retries')


def read_response(reg: int, cmd: int, timeout: float = 0.5) -> Optional[bytes]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            raw = os.read(fd, 16)
            if len(raw) < 5:
                continue
            data = raw[1:]
            if data[0] == reg and data[4] == cmd:
                return data
        except BlockingIOError:
            time.sleep(0.01)
        except OSError as e:
            if e.errno in (errno.EIO, errno.ENODEV, errno.EBADF):
                reopen()
            else:
                time.sleep(0.01)
    return None


def send_and_read(reg: int, cmd: int, data: bytes) -> Optional[bytes]:
    write_report(data)
    return read_response(reg, cmd)


def build_read_packet(reg: int) -> bytes:
    return bytes([reg, 0, 0, 0, CMD_READ, 0, 0, 0, 0, 0])


def parse_gain_freq(data: bytes) -> dict:
    gain_raw = data[6] | (data[7] << 8)
    if gain_raw > 0x7FFF:
        gain_raw -= 0x10000
    freq = data[8] | (data[9] << 8)
    return {'gain': gain_raw / 10.0, 'freq': freq}


def parse_q_type(data: bytes) -> dict:
    q = (data[6] | (data[7] << 8)) / 1000.0
    ft = data[8]
    types = {0: 'PK', 3: 'LSQ', 4: 'HSQ'}
    return {'q': round(q, 3), 'type': types.get(ft, 'PK')}


def build_gain_freq_packet(reg: int, freq: float, gain: float) -> bytes:
    freq_int = int(round(freq))
    gain_scaled = int(round(gain * 10))
    if gain_scaled < 0:
        gain_scaled += 0x10000
    return bytes([
        reg, 0, 0, 0, CMD_WRITE, 0,
        gain_scaled & 0xFF, (gain_scaled >> 8) & 0xFF,
        freq_int & 0xFF, (freq_int >> 8) & 0xFF,
    ])


def build_q_type_packet(reg: int, q: float, ftype: str) -> bytes:
    q_int = int(round(q * 1000))
    type_map = {'PK': 0, 'LSQ': 3, 'HSQ': 4}
    return bytes([
        reg, 0, 0, 0, CMD_WRITE, 0,
        q_int & 0xFF, (q_int >> 8) & 0xFF,
        type_map.get(ftype, 0), 0,
    ])


def _error_response(msg: str, status: int = 500):
    return jsonify({'error': msg, 'connected': False}), status


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/status')
def api_status():
    global fd, hidraw_path, perm_denied
    if fd is None:
        if not find_device():
            return jsonify({'connected': False, 'chip_id': None,
                            'permission_denied': perm_denied})
        if perm_denied:
            return jsonify({'connected': False, 'chip_id': None,
                            'permission_denied': True})
        if not init_hid():
            return jsonify({'connected': False, 'chip_id': None,
                            'permission_denied': perm_denied})
    try:
        os.read(fd, 1)
        return jsonify({'connected': True, 'chip_id': '?',
                        'permission_denied': False})
    except BlockingIOError:
        return jsonify({'connected': True, 'chip_id': '?',
                        'permission_denied': False})
    except OSError:
        pass  # fd is stale

    current_path = find_device()
    if not current_path:
        return jsonify({'connected': False, 'chip_id': None,
                        'permission_denied': False})
    try:
        new_fd = os.open(current_path, os.O_RDWR)
        _set_nonblock(new_fd)
        try:
            os.close(fd)
        except OSError:
            pass
        fd = new_fd
        hidraw_path = current_path
        log.info('\u2713 Reconnected at %s', current_path)
    except OSError:
        return jsonify({'connected': False, 'chip_id': None,
                        'permission_denied': False})
    return jsonify({'connected': True, 'chip_id': '?',
                    'permission_denied': False})


@app.route('/api/read')
def api_read():
    try:
        slot_data = send_and_read(REG_ENABLE, CMD_READ,
                                  build_read_packet(REG_ENABLE))
        slot = slot_data[6] if slot_data else DISABLED_SLOT

        filters = []
        if slot == CUSTOM_SLOT:
            for i in range(FILTER_COUNT):
                gf_reg = FILTER_BASE + i * 2
                q_reg = gf_reg + 1
                gf_data = send_and_read(gf_reg, CMD_READ,
                                        build_read_packet(gf_reg))
                parsed = parse_gain_freq(gf_data) if gf_data \
                    else {'gain': 0, 'freq': 1000}
                q_data = send_and_read(q_reg, CMD_READ,
                                       build_read_packet(q_reg))
                qparsed = parse_q_type(q_data) if q_data \
                    else {'q': 1.0, 'type': 'PK'}
                filters.append({**parsed, **qparsed})

        pg = send_and_read(REG_GLOBAL, CMD_READ, build_read_packet(REG_GLOBAL))
        mic_gain = 0
        if pg:
            raw = pg[6]
            mic_gain = raw if raw <= 127 else raw - 256

        chip_id = read_chip_id()

        return jsonify({
            'connected': True,
            'filters': filters, 'mic_gain': mic_gain,
            'slot': slot, 'enabled': slot == CUSTOM_SLOT,
            'chip_id': chip_id,
        })
    except OSError as e:
        return _error_response(f'Device error: {e}')
    except Exception as e:
        return _error_response(str(e))


@app.route('/api/commit', methods=['POST'])
def api_commit():
    try:
        body = request.get_json()
        if not body:
            return _error_response('No data provided', 400)
        filters = body.get('filters', [])
        mic_gain = body.get('mic_gain', 0)

        valid_types = {'PK', 'LSQ', 'HSQ'}

        write_report(bytes([REG_ENABLE, 0, 0, 0, CMD_WRITE, 0,
                            CUSTOM_SLOT, 0, 0, 0]))
        time.sleep(0.1)

        for i, f in enumerate(filters[:FILTER_COUNT]):
            gf_reg = FILTER_BASE + i * 2
            q_reg = gf_reg + 1

            freq  = _clamp(float(f.get('freq', 1000)), 20, 20000)
            raw_gain = float(f.get('gain', 0))
            gain  = 0 if f.get('disabled') else _clamp(raw_gain, -12, 12)
            q     = _clamp(float(f.get('q', 1.0)), 0.1, 10)
            ftype = f.get('type', 'PK')
            if ftype not in valid_types:
                ftype = 'PK'

            write_report(build_gain_freq_packet(gf_reg, freq, gain))
            write_report(build_q_type_packet(q_reg, q, ftype))

        pg_clamped = int(round(_clamp(float(mic_gain), -60, 12)))
        if pg_clamped < 0:
            pg_clamped &= 0xFF
        write_report(bytes([REG_GLOBAL, 0, 0, 0, CMD_WRITE, 0,
                            pg_clamped, 0, 0, 0]))
        write_report(bytes([0, 0, 0, 0, CMD_COMMIT, 0, 0, 0, 0, 0]))

        ensure_connected()

        return jsonify({'success': True, 'connected': True})
    except OSError as e:
        return _error_response(f'Device error: {e}')
    except Exception as e:
        return _error_response(str(e))


@app.route('/api/bypass', methods=['GET', 'POST'])
def api_bypass():
    try:
        if request.method == 'POST':
            body = request.get_json()
            target = (body or {}).get('slot', CUSTOM_SLOT)
        else:
            target = request.args.get('to', type=int)
            if target is None:
                return _error_response('Provide ?to=2 or ?to=3', 400)

        write_report(bytes([REG_ENABLE, 0, 0, 0, CMD_WRITE, 0,
                            target, 0, 0, 0]))
        write_report(bytes([0, 0, 0, 0, CMD_COMMIT, 0, 0, 0, 0, 0]))

        ensure_connected()

        return jsonify({'enabled': target == CUSTOM_SLOT, 'slot': target,
                        'connected': True})
    except OSError as e:
        return _error_response(f'Device error: {e}')
    except Exception as e:
        return _error_response(str(e))


if __name__ == '__main__':
    frozen = getattr(sys, 'frozen', False)

    if '--test-perm-denied' in sys.argv:
        perm_denied = True
        log.warning('Simulating permission denied for UI testing.')
        sys.argv.remove('--test-perm-denied')

    def start_flask():
        if perm_denied:
            log.warning('Permission denied, starting server anyway.')
        elif not init_hid():
            log.warning('%s not found, starting server anyway.', DEVICE_NAME)
        log.info('Starting on http://localhost:%d', port)
        app.run(host='127.0.0.1', port=port, debug=False)

    port = _pick_port()

    if '--web' in sys.argv:
        import webbrowser
        webbrowser.open(f'http://localhost:{port}')
        start_flask()
    elif frozen:
        import threading
        import webview
        threading.Thread(target=start_flask, daemon=True).start()
        webview.create_window('Bunny DSP', f'http://127.0.0.1:{port}/?native=1',
                              width=960, height=720)
        webview.start()
    else:
        start_flask()
