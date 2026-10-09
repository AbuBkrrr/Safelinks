mod commands;
mod discover;
mod fingerprint;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::local_info,
            commands::scan_lan,
            commands::probe_router,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SAFE_Links installer");
}