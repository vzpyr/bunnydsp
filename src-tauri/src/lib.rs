mod hid;

use hid::{CommitFilter, HidState, HidStateMutex, CUSTOM_SLOT};
use tauri::Manager;

#[tauri::command]
async fn status(state: tauri::State<'_, HidStateMutex>) -> Result<hid::StatusResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(s.cmd_status())
}

#[tauri::command]
async fn read_all(state: tauri::State<'_, HidStateMutex>) -> Result<hid::ReadResult, String> {
    let mut s = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if s.device.is_none() {
        let _ = s.find_and_open();
    }
    if s.device.is_some() && !s.ensure_connected() {
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
    if s.device.is_none() {
        let _ = s.find_and_open();
    }
    if s.device.is_none() {
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
    if s.device.is_none() {
        let _ = s.find_and_open();
    }
    if s.device.is_none() {
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
    env_logger::init();

    let hid_state = HidState::new().expect("Failed to initialize HID API");
    let hid_mutex: HidStateMutex = std::sync::Mutex::new(hid_state);

    tauri::Builder::default()
        .manage(hid_mutex)
        .invoke_handler(tauri::generate_handler![status, read_all, commit, toggle_bypass])
        .setup(|app| {
            if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_decorations(false);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
