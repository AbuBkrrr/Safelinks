mod auth;
mod commands;
mod discover;
mod fingerprint;
mod preflight;
mod router;
mod ssh;

use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            for arg in &argv {
                if arg.starts_with("safelinks-installer://configure") {
                    if let Some((_, query)) = arg.split_once('?') {
                        let mut rid = String::new(); let mut ip = String::new();
                        let mut pc = String::new(); let mut ssid = String::new(); let mut pass = String::new();
                        for pair in query.split('&') {
                            let (k, v) = match pair.split_once('=') { Some(x) => x, None => continue };
                            let v = urlencoding_decode(v);
                            match k {
                                "resellerId" => rid = v, "ip" => ip = v, "pairingCode" => pc = v,
                                "ssid" => ssid = v, "pass" => pass = v, _ => {}
                            }
                        }
                        let payload = serde_json::json!({ "resellerId": rid, "ip": ip, "pairingCode": pc, "ssid": ssid, "pass": pass });
                        let _ = app.emit("deep-link-configure", payload);
                    }
                } else if arg.starts_with("safelinks-installer://auth") {
                    if let Some((_, query)) = arg.split_once('?') {
                        let mut token = String::new();
                        let mut role = String::new();
                        let mut email = String::new();
                        let mut company = String::new();
                        for pair in query.split('&') {
                            let (k, v) = match pair.split_once('=') { Some(x) => x, None => continue };
                            let v = urlencoding_decode(v);
                            match k {
                                "token" => token = v,
                                "role" => role = v,
                                "email" => email = v,
                                "companyName" => company = v,
                                _ => {}
                            }
                        }
                        let payload = serde_json::json!({
                            "token": token, "role": role, "email": email, "companyName": company,
                        });
                        crate::auth::cache_pending_auth(payload.clone());
                        let _ = app.emit("deep-link-auth", payload);
                    }
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // register_protocol_handler(); // removed: Tauri deep-link plugin + NSIS handles protocol registration
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    // safelinks-installer://auth?token=...&role=...&email=...&companyName=...
                    let s = url.as_str();
                    if s.starts_with("safelinks-installer://configure") {
                        if let Some((_, query)) = s.split_once('?') {
                            let mut rid = String::new(); let mut ip = String::new();
                            let mut pc = String::new(); let mut ssid = String::new(); let mut pass = String::new();
                            let mut token = String::new(); let mut role = String::new(); let mut email = String::new(); let mut company = String::new();
                            for pair in query.split('&') {
                                let (k, v) = match pair.split_once('=') { Some(x) => x, None => continue };
                                let v = urlencoding_decode(v);
                                match k {
                                    "resellerId" => rid = v, "ip" => ip = v, "pairingCode" => pc = v,
                                    "ssid" => ssid = v, "pass" => pass = v,
                                    "token" => token = v, "role" => role = v, "email" => email = v, "companyName" => company = v,
                                    _ => {}
                                }
                            }
                            let payload = serde_json::json!({ "resellerId": rid, "ip": ip, "pairingCode": pc, "ssid": ssid, "pass": pass, "token": token, "role": role, "email": email, "companyName": company });
                            if !token.is_empty() { crate::auth::cache_pending_auth(serde_json::json!({ "token": token, "role": role, "email": email, "companyName": company })); }
                            let _ = handle.emit("deep-link-configure", payload);
                        }
                    } else if let Some(q) = s.split_once("?") {
                        let query = q.1;
                        let mut token = String::new();
                        let mut role = String::new();
                        let mut email = String::new();
                        let mut company = String::new();
                        for pair in query.split('&') {
                            let (k, v) = match pair.split_once('=') { Some(x) => x, None => continue };
                            let v = urlencoding_decode(v);
                            match k {
                                "token" => token = v,
                                "role" => role = v,
                                "email" => email = v,
                                "companyName" => company = v,
                                _ => {}
                            }
                        }
                        let payload = serde_json::json!({
                            "token": token,
                            "role": role,
                            "email": email,
                            "companyName": company,
                        });
                        crate::auth::cache_pending_auth(payload.clone());
                        let _ = handle.emit("deep-link-auth", payload);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::local_info,
            commands::get_local_mac,
            commands::scan_lan,
            commands::probe_router,
            preflight::check_prerequisites,
            router::installer_save_rsc,
            router::installer_router_test_ssh,
            router::installer_router_apply_config,
            router::installer_router_check_status,
            ssh::scripts_info,
            auth::store_credentials,
            auth::store_google_session,
            auth::load_credentials,
            auth::clear_credentials,
            auth::login_and_store,
            auth::try_auto_login,
            auth::open_dashboard,
            auth::open_google_signin,
            auth::open_forgot_password,
            auth::open_signup,
            auth::take_pending_auth,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SAFE_Links installer");
}

fn urlencoding_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i+1]), hex(bytes[i+2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}