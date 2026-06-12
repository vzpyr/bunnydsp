mod hid;

use hid::{CommitFilter, HidState, HidStateMutex, CUSTOM_SLOT};
#[cfg(not(target_os = "android"))]
use tauri::Manager;

#[tauri::command]
async fn status(state: tauri::State<'_, HidStateMutex>) -> Result<hid::StatusResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(s.cmd_status())
}

#[tauri::command]
async fn read_all(state: tauri::State<'_, HidStateMutex>) -> Result<hid::ReadResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if s.find_and_open().is_ok() && !s.ensure_connected() {
        s.reopen();
    }
    Ok(s.cmd_read())
}

#[tauri::command]
async fn commit(
    state: tauri::State<'_, HidStateMutex>,
    filters: Vec<CommitFilter>,
    left_vol: f64,
    right_vol: f64,
    mic_gain: f64,
) -> Result<hid::CommitResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if s.find_and_open().is_ok() && !s.ensure_connected() {
        s.reopen();
    }
    if !s.ensure_connected() {
        return Ok(hid::CommitResult {
            success: false,
            connected: false,
            error: Some("Device not connected".into()),
        });
    }
    Ok(s.cmd_commit(&filters, left_vol, right_vol, mic_gain))
}

#[tauri::command]
async fn toggle_bypass(
    state: tauri::State<'_, HidStateMutex>,
    target_slot: u8,
) -> Result<hid::BypassResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if s.find_and_open().is_ok() && !s.ensure_connected() {
        s.reopen();
    }
    if !s.ensure_connected() {
        return Ok(hid::BypassResult {
            enabled: target_slot == CUSTOM_SLOT,
            slot: target_slot,
            connected: false,
        });
    }
    Ok(s.cmd_bypass(target_slot))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(target_os = "android"))]
    env_logger::init();

    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Trace)
    );

    let hid_state = HidState::new().expect("Failed to initialize HID API");
    let hid_mutex: HidStateMutex = std::sync::Mutex::new(hid_state);

    tauri::Builder::default()
        .manage(hid_mutex)
        .invoke_handler(tauri::generate_handler![status, read_all, commit, toggle_bypass])
        .setup(|_app| {
            #[cfg(not(target_os = "android"))]
            if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                if let Some(w) = _app.get_webview_window("main") {
                    let _ = w.set_decorations(false);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_bunnydsp_eq_MainActivity_registerActivity(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    _activity: jni::objects::JObject,
) {
    if let Ok(jvm) = env.get_java_vm() {
        let _ = hid::JVM.set(jvm);
    }
    if let Ok(class) = env.find_class("com/bunnydsp/eq/MainActivity") {
        if let Ok(global_ref) = env.new_global_ref(class) {
            let _ = hid::MAIN_ACTIVITY_CLASS.set(global_ref);
            log::info!("MainActivity class cached successfully");
        }
    }
    log::info!("MainActivity registered JVM with Rust JNI");
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_bunnydsp_eq_MainActivity_setConnectedStatus(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
    connected: jni::sys::jboolean,
) {
    hid::ANDROID_CONNECTED.store(connected != 0, std::sync::atomic::Ordering::SeqCst);
    log::info!("USB Connection status updated: {}", connected != 0);
}
