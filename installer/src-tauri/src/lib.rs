mod auth;
mod commands;
mod discover;
mod fingerprint;
mod preflight;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::local_info,
            commands::scan_lan,
            commands::probe_router,
            preflight::check_prerequisites,
            auth::store_credentials,
            auth::load_credentials,
            auth::clear_credentials,
            auth::login_and_store,
            auth::try_auto_login,
            auth::open_dashboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SAFE_Links installer");
}