#[cfg(not(target_os = "android"))]
use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "android")]
use jni::{JavaVM, objects::GlobalRef};
#[cfg(target_os = "android")]
use std::sync::OnceLock;

#[allow(dead_code)]
pub const VID: u16 = 0x31b2;
#[allow(dead_code)]
pub const PID: u16 = 0x1112;

const REPORT_ID: u8 = 0x4B;

const CMD_READ: u8 = 0x52;
const CMD_WRITE: u8 = 0x57;
const CMD_COMMIT: u8 = 0x53;

const REG_ENABLE: u8 = 0x24;
const REG_MIC_GAIN: u8 = 0x65;
const REG_VOLUME: u8 = 0x66;
const FILTER_BASE: u8 = 0x26;

pub const DISABLED_SLOT: u8 = 0x02;
pub const CUSTOM_SLOT: u8 = 0x03;
pub const FILTER_COUNT: usize = 5;

// Android JNI globals and connection status
#[cfg(target_os = "android")]
pub static ANDROID_CONNECTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "android")]
pub static JVM: OnceLock<JavaVM> = OnceLock::new();
#[cfg(target_os = "android")]
pub static MAIN_ACTIVITY_CLASS: OnceLock<GlobalRef> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterData {
    pub gain: f64,
    pub freq: u16,
    pub q: f64,
    #[serde(rename = "type")]
    pub filter_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitFilter {
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
    #[serde(rename = "type")]
    pub filter_type: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResult {
    pub connected: bool,
    pub chip_id: Option<String>,
    pub permission_denied: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadResult {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub filters: Vec<FilterData>,
    pub left_vol: f64,
    pub right_vol: f64,
    pub mic_gain: f64,
    pub slot: u8,
    pub enabled: bool,
    pub chip_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitResult {
    pub success: bool,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BypassResult {
    pub enabled: bool,
    pub slot: u8,
    pub connected: bool,
}

pub struct HidState {
    #[cfg(not(target_os = "android"))]
    pub api: HidApi,
    #[cfg(not(target_os = "android"))]
    pub device: Option<HidDevice>,
}

impl HidState {
    pub fn new() -> Result<Self, String> {
        #[cfg(not(target_os = "android"))]
        {
            let api = HidApi::new().map_err(|e| format!("Failed to init HID: {e}"))?;
            Ok(Self { api, device: None })
        }
        #[cfg(target_os = "android")]
        {
            Ok(Self {})
        }
    }

    pub fn find_and_open(&mut self) -> Result<bool, String> {
        #[cfg(not(target_os = "android"))]
        {
            if self.device.is_some() {
                return Ok(true);
            }
            match self.api.open(VID, PID) {
                Ok(dev) => {
                    self.device = Some(dev);
                    Ok(true)
                }
                Err(_) => {
                    let present = self
                        .api
                        .device_list()
                        .any(|d| d.vendor_id() == VID && d.product_id() == PID);
                    if present {
                        Err("permission_denied".into())
                    } else {
                        Ok(false)
                    }
                }
            }
        }
        #[cfg(target_os = "android")]
        {
            if ANDROID_CONNECTED.load(Ordering::SeqCst) {
                return Ok(true);
            }
            
            if let Some(jvm) = JVM.get() {
                if let Some(class_ref) = MAIN_ACTIVITY_CLASS.get() {
                    if let Ok(mut env) = jvm.attach_current_thread() {
                        let class = unsafe { jni::objects::JClass::from_raw(class_ref.as_obj().as_raw()) };
                        let _ = env.call_static_method(
                            &class,
                            "forceConnect",
                            "()Z",
                            &[],
                        );
                    }
                }
            }
            
            std::thread::sleep(Duration::from_millis(200));
            Ok(ANDROID_CONNECTED.load(Ordering::SeqCst))
        }
    }

    pub fn ensure_connected(&mut self) -> bool {
        #[cfg(not(target_os = "android"))]
        {
            if self.device.is_none() {
                return false;
            }
            let mut buf = [0u8; 16];
            match self.device.as_ref().unwrap().read_timeout(&mut buf, 10) {
                Ok(_) => true,
                Err(e) => {
                    let s = e.to_string();
                    if s.contains("timeout") {
                        true
                    } else {
                        false
                    }
                }
            }
        }
        #[cfg(target_os = "android")]
        {
            ANDROID_CONNECTED.load(Ordering::SeqCst)
        }
    }

    pub fn reopen(&mut self) -> bool {
        #[cfg(not(target_os = "android"))]
        {
            self.device = None;
            std::thread::sleep(Duration::from_millis(200));
            match self.api.open(VID, PID) {
                Ok(dev) => {
                    log::info!("Reconnected to Bunny DSP");
                    self.device = Some(dev);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(target_os = "android")]
        {
            ANDROID_CONNECTED.load(Ordering::SeqCst)
        }
    }

    pub fn reconnect_after_commit(&mut self) -> bool {
        #[cfg(not(target_os = "android"))]
        {
            self.device = None;
            for _ in 0..10 {
                if self.reopen() {
                    std::thread::sleep(Duration::from_millis(500));
                    return true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            false
        }
        #[cfg(target_os = "android")]
        {
            std::thread::sleep(Duration::from_millis(1000));
            ANDROID_CONNECTED.load(Ordering::SeqCst)
        }
    }

    #[cfg(not(target_os = "android"))]
    fn device_ref(&self) -> Result<&HidDevice, String> {
        self.device
            .as_ref()
            .ok_or_else(|| "Device not connected".to_string())
    }

    fn write_raw(&self, packet: &[u8]) -> Result<(), String> {
        #[cfg(not(target_os = "android"))]
        {
            let dev = self.device_ref()?;
            for attempt in 0..3 {
                match dev.write(packet) {
                    Ok(_) => {
                        std::thread::sleep(Duration::from_millis(30));
                        return Ok(());
                    }
                    Err(e) => {
                        if attempt == 2 {
                            return Err(format!("Write failed after 3 attempts: {e}"));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
            unreachable!()
        }

        #[cfg(target_os = "android")]
        {
            let jvm = JVM.get().ok_or("JavaVM not initialized")?;
            let class_ref = MAIN_ACTIVITY_CLASS.get().ok_or("MainActivity class not cached")?;
            
            let mut env = jvm.attach_current_thread().map_err(|e| e.to_string())?;
            let byte_array = env.byte_array_from_slice(packet).map_err(|e| e.to_string())?;
            
            let class = unsafe { jni::objects::JClass::from_raw(class_ref.as_obj().as_raw()) };

            let res = env.call_static_method(
                &class,
                "writeReport",
                "([B)Z",
                &[jni::objects::JValue::Object(&byte_array)],
            ).map_err(|e| e.to_string())?;
            
            let success = res.z().map_err(|e| e.to_string())?;
            if success {
                std::thread::sleep(Duration::from_millis(30));
                Ok(())
            } else {
                Err("Android USB write failed".into())
            }
        }
    }

    fn write_report(&self, data: &[u8; 10]) -> Result<(), String> {
        let mut packet = vec![REPORT_ID];
        packet.extend_from_slice(data);
        self.write_raw(&packet)
    }

    fn read_raw(&self, timeout_ms: i32) -> Result<Option<Vec<u8>>, String> {
        #[cfg(not(target_os = "android"))]
        {
            let dev = self.device_ref()?;
            let mut buf = [0u8; 16];
            match dev.read_timeout(&mut buf, timeout_ms) {
                Ok(n) if n > 0 => Ok(Some(buf[..n].to_vec())),
                Err(e) if !e.to_string().contains("timeout") => Err(format!("Read error: {e}")),
                _ => Ok(None),
            }
        }

        #[cfg(target_os = "android")]
        {
            let jvm = JVM.get().ok_or("JavaVM not initialized")?;
            let class_ref = MAIN_ACTIVITY_CLASS.get().ok_or("MainActivity class not cached")?;
            
            let mut env = jvm.attach_current_thread().map_err(|e| e.to_string())?;
            
            let class = unsafe { jni::objects::JClass::from_raw(class_ref.as_obj().as_raw()) };

            let res = env.call_static_method(
                &class,
                "readReport",
                "(I)[B",
                &[jni::objects::JValue::Int(timeout_ms)],
            ).map_err(|e| e.to_string())?;
            
            let obj = res.l().map_err(|e| e.to_string())?;
            if !obj.is_null() {
                let byte_array = unsafe { jni::objects::JByteArray::from_raw(obj.into_raw()) };
                let len = env.get_array_length(&byte_array).map_err(|e| e.to_string())?;
                if len > 0 {
                    let mut buf = vec![0i8; len as usize];
                    env.get_byte_array_region(&byte_array, 0, &mut buf).map_err(|e| e.to_string())?;
                    let buf_u8: Vec<u8> = buf.iter().map(|&x| x as u8).collect();
                    return Ok(Some(buf_u8));
                }
            }
            Ok(None)
        }
    }

    fn read_response(
        &self,
        reg: u8,
        cmd: u8,
        timeout_ms: i32,
    ) -> Result<Option<[u8; 10]>, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
        while Instant::now() < deadline {
            match self.read_raw(10) {
                Ok(Some(buf)) if buf.len() >= 5 => {
                    let data = &buf[1..]; // skip report ID
                    if data.len() >= 5 && data[0] == reg && data[4] == cmd {
                        let mut out = [0u8; 10];
                        let len = data.len().min(10);
                        out[..len].copy_from_slice(&data[..len]);
                        return Ok(Some(out));
                    }
                }
                Err(e) => return Err(e),
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(None)
    }

    fn send_and_read(
        &self,
        reg: u8,
        cmd: u8,
        data: &[u8; 10],
    ) -> Result<Option<[u8; 10]>, String> {
        self.write_report(data)?;
        self.read_response(reg, cmd, 500)
    }

    fn build_read_packet(reg: u8) -> [u8; 10] {
        [reg, 0, 0, 0, CMD_READ, 0, 0, 0, 0, 0]
    }

    fn build_gain_freq_packet(reg: u8, freq: f64, gain: f64) -> [u8; 10] {
        let freq_int = freq.round() as u16;
        let mut gain_scaled = (gain * 10.0).round() as i32;
        if gain_scaled < 0 {
            gain_scaled += 0x10000;
        }
        let gs = gain_scaled as u16;
        [
            reg,
            0,
            0,
            0,
            CMD_WRITE,
            0,
            (gs & 0xFF) as u8,
            (gs >> 8) as u8,
            (freq_int & 0xFF) as u8,
            (freq_int >> 8) as u8,
        ]
    }

    fn build_q_type_packet(reg: u8, q: f64, ftype: &str) -> [u8; 10] {
        let q_int = (q * 1000.0).round() as u16;
        let type_byte = match ftype {
            "PK" => 0,
            "LSQ" => 3,
            "HSQ" => 4,
            _ => 0,
        };
        [
            reg,
            0,
            0,
            0,
            CMD_WRITE,
            0,
            (q_int & 0xFF) as u8,
            (q_int >> 8) as u8,
            type_byte,
            0,
        ]
    }

    fn parse_gain_freq(data: &[u8]) -> FilterData {
        let gain_raw = data[6] as u16 | ((data[7] as u16) << 8);
        let gain = if gain_raw > 0x7FFF {
            (gain_raw as i32 - 0x10000) as f64 / 10.0
        } else {
            gain_raw as f64 / 10.0
        };
        let freq = data[8] as u16 | ((data[9] as u16) << 8);
        FilterData {
            gain,
            freq,
            q: 1.0,
            filter_type: "PK".into(),
        }
    }

    fn parse_q_type(data: &[u8]) -> (f64, String) {
        let q_raw = data[6] as u16 | ((data[7] as u16) << 8);
        let q = q_raw as f64 / 1000.0;
        let ft = match data[8] {
            3 => "LSQ",
            4 => "HSQ",
            _ => "PK",
        };
        (q, ft.to_string())
    }

    fn decode_vol2(byte: u8) -> f64 {
        let signed = if byte <= 127 {
            byte as i8 as f64
        } else {
            (byte as i8) as f64
        };
        signed / 2.0
    }

    fn encode_vol2(db: f64) -> u8 {
        let raw = (db * 2.0).round() as i32;
        if raw < 0 {
            (raw + 256) as u8
        } else {
            raw as u8
        }
    }

    pub fn read_chip_id(&self) -> String {
        let probe = [0x54u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        if self.write_raw(&probe).is_ok() {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(Some(buf)) = self.read_raw(100) {
                if buf.len() > 1 {
                    let end = buf[1..]
                        .iter()
                        .position(|&b| b == 0)
                        .unwrap_or(buf.len() - 1);
                    return String::from_utf8_lossy(&buf[1..1 + end]).into_owned();
                }
            }
        }
        "?".into()
    }

    // --- Public command methods ---

    pub fn cmd_status(&mut self) -> StatusResult {
        match self.find_and_open() {
            Ok(true) => {
                if self.ensure_connected() {
                    StatusResult {
                        connected: true,
                        chip_id: Some("?".into()),
                        permission_denied: false,
                    }
                } else {
                    StatusResult {
                        connected: false,
                        chip_id: None,
                        permission_denied: false,
                    }
                }
            }
            Err(e) if e == "permission_denied" => StatusResult {
                connected: false,
                chip_id: None,
                permission_denied: true,
            },
            _ => StatusResult {
                connected: false,
                chip_id: None,
                permission_denied: false,
            },
        }
    }

    pub fn cmd_read(&mut self) -> ReadResult {
        let mut result = ReadResult {
            connected: true,
            error: None,
            filters: Vec::new(),
            left_vol: 0.0,
            right_vol: 0.0,
            mic_gain: 0.0,
            slot: DISABLED_SLOT,
            enabled: false,
            chip_id: "?".into(),
        };

        let slot_data = match self.send_and_read(REG_ENABLE, CMD_READ, &Self::build_read_packet(REG_ENABLE)) {
            Ok(Some(d)) => d,
            Ok(None) => {
                result.error = Some("No response from device".into());
                return result;
            }
            Err(e) => {
                result.error = Some(e);
                return result;
            }
        };

        let slot = slot_data[6];
        result.slot = slot;
        result.enabled = slot == CUSTOM_SLOT;

        if slot == CUSTOM_SLOT {
            for i in 0..FILTER_COUNT {
                let gf_reg = FILTER_BASE + (i * 2) as u8;
                let q_reg = gf_reg + 1;

                let gf_data = self
                    .send_and_read(gf_reg, CMD_READ, &Self::build_read_packet(gf_reg))
                    .ok()
                    .flatten();
                let mut filter = if let Some(ref data) = gf_data {
                    Self::parse_gain_freq(data)
                } else {
                    FilterData {
                        gain: 0.0,
                        freq: 1000,
                        q: 1.0,
                        filter_type: "PK".into(),
                    }
                };

                let q_data = self
                    .send_and_read(q_reg, CMD_READ, &Self::build_read_packet(q_reg))
                    .ok()
                    .flatten();
                if let Some(ref data) = q_data {
                    let (q, ft) = Self::parse_q_type(data);
                    filter.q = q;
                    filter.filter_type = ft;
                }

                result.filters.push(filter);
            }
        }

        if let Ok(Some(bal)) = self.send_and_read(REG_VOLUME, CMD_READ, &Self::build_read_packet(REG_VOLUME)) {
            result.left_vol = Self::decode_vol2(bal[6]);
            result.right_vol = Self::decode_vol2(bal[7]);
        }

        if let Ok(Some(mic)) = self.send_and_read(REG_MIC_GAIN, CMD_READ, &Self::build_read_packet(REG_MIC_GAIN)) {
            result.mic_gain = Self::decode_vol2(mic[6]);
        }

        result.chip_id = self.read_chip_id();
        result
    }

    pub fn cmd_commit(
        &mut self,
        filters: &[CommitFilter],
        left_vol: f64,
        right_vol: f64,
        mic_gain: f64,
    ) -> CommitResult {
        let enable_pkt = [REG_ENABLE, 0, 0, 0, CMD_WRITE, 0, CUSTOM_SLOT, 0, 0, 0];
        if let Err(e) = self.write_report(&enable_pkt) {
            return CommitResult {
                success: false,
                connected: false,
                error: Some(e),
            };
        }
        std::thread::sleep(Duration::from_millis(100));

        let valid_types: std::collections::HashSet<&str> =
            ["PK", "LSQ", "HSQ"].into_iter().collect();

        for (i, f) in filters.iter().enumerate().take(FILTER_COUNT) {
            let gf_reg = FILTER_BASE + (i * 2) as u8;
            let q_reg = gf_reg + 1;

            let freq = f.freq.clamp(20.0, 20000.0);
            let gain = if f.disabled {
                0.0
            } else {
                f.gain.clamp(-12.0, 12.0)
            };
            let q = f.q.clamp(0.1, 10.0);
            let ftype = if valid_types.contains(f.filter_type.as_str()) {
                f.filter_type.as_str()
            } else {
                "PK"
            };

            let _ = self.write_report(&Self::build_gain_freq_packet(gf_reg, freq, gain));
            let _ = self.write_report(&Self::build_q_type_packet(q_reg, q, ftype));
        }

        let vol_pkt = [
            REG_VOLUME,
            0,
            0,
            0,
            CMD_WRITE,
            0,
            Self::encode_vol2(left_vol.clamp(-60.0, 0.0)),
            Self::encode_vol2(right_vol.clamp(-60.0, 0.0)),
            0,
            0,
        ];
        let _ = self.write_report(&vol_pkt);

        let mic_pkt = [
            REG_MIC_GAIN,
            0,
            0,
            0,
            CMD_WRITE,
            0,
            Self::encode_vol2(mic_gain.clamp(-60.0, 12.0)),
            0,
            0,
            0,
        ];
        let _ = self.write_report(&mic_pkt);

        let commit_pkt = [0, 0, 0, 0, CMD_COMMIT, 0, 0, 0, 0, 0];
        let _ = self.write_report(&commit_pkt);

        let connected = self.reconnect_after_commit();

        CommitResult {
            success: true,
            connected,
            error: None,
        }
    }

    pub fn cmd_bypass(&mut self, target_slot: u8) -> BypassResult {
        let pkt = [REG_ENABLE, 0, 0, 0, CMD_WRITE, 0, target_slot, 0, 0, 0];
        let _ = self.write_report(&pkt);

        let commit_pkt = [0, 0, 0, 0, CMD_COMMIT, 0, 0, 0, 0, 0];
        let _ = self.write_report(&commit_pkt);

        let connected = self.reconnect_after_commit();

        BypassResult {
            enabled: target_slot == CUSTOM_SLOT,
            slot: target_slot,
            connected,
        }
    }
}

pub type HidStateMutex = Mutex<HidState>;
