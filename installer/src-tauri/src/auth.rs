use tauri::{Emitter, Manager};
use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "safelinks-installer";
const EMAIL_MARKER: &str = "__last_email__";
const TOKEN_MARKER: &str = "__token__";
const BACKEND: &str = "https://backend-services-production-78d8.up.railway.app";

#[derive(Serialize, Deserialize)]
pub struct StoredSession {
    pub email: String,
}

#[derive(Serialize)]
pub struct LoginResult {
    pub token: String,
    pub role: String,
    pub user: serde_json::Value,
    pub auth_method: String, // "password" or "google"
}

// ---------- Keyring helpers ----------

fn keyring_set(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

fn keyring_get(key: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, key).ok()?.get_password().ok()
}

fn keyring_del(key: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, key) {
        let _ = e.delete_credential();
    }
}

// ---------- Commands ----------

#[tauri::command]
pub async fn store_credentials(email: String, password: String) -> Result<(), String> {
    keyring_set(&email, &password)?;
    keyring_set(EMAIL_MARKER, &email)?;
    // Clear any prior token-only login
    keyring_del(TOKEN_MARKER);
    Ok(())
}

#[tauri::command]
pub async fn store_google_session(
    email: String,
    token: String,
    user: serde_json::Value,
    role: String,
) -> Result<LoginResult, String> {
    if role != "reseller" {
        return Err(format!(
            "This is a {} account. The installer is for reseller accounts only.",
            role
        ));
    }
    keyring_set(EMAIL_MARKER, &email)?;
    keyring_set(TOKEN_MARKER, &token)?;
    Ok(LoginResult {
        token,
        role,
        user,
        auth_method: "google".to_string(),
    })
}

#[tauri::command]
pub async fn clear_credentials() -> Result<(), String> {
    if let Some(email) = keyring_get(EMAIL_MARKER) {
        keyring_del(&email);
    }
    keyring_del(EMAIL_MARKER);
    keyring_del(TOKEN_MARKER);
    Ok(())
}

#[tauri::command]
pub async fn load_credentials() -> Result<Option<StoredSession>, String> {
    Ok(keyring_get(EMAIL_MARKER).map(|email| StoredSession { email }))
}

async fn backend_login(email: &str, password: &str) -> Result<LoginResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/api/auth/login", BACKEND))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str().map(|s| s.to_string()))
                .or_else(|| v.get("message").and_then(|e| e.as_str().map(|s| s.to_string()))))
            .unwrap_or_else(|| text.clone());
        return Err(format!("Login failed ({}): {}", status.as_u16(), msg));
    }
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Bad response: {}", e))?;
    let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let role = body.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let user = body.get("user").cloned().unwrap_or(serde_json::Value::Null);
    if token.is_empty() {
        return Err("Login response missing token".into());
    }
    Ok(LoginResult { token, role, user, auth_method: "password".into() })
}

#[tauri::command]
pub async fn login_and_store(email: String, password: String) -> Result<LoginResult, String> {
    let res = backend_login(&email, &password).await?;
    if res.role != "reseller" {
        return Err(format!(
            "This is a {} account. The installer is for reseller accounts only. Sign in at https://www.safelinks.name.ng instead.",
            res.role
        ));
    }
    store_credentials(email, password).await?;
    Ok(res)
}

#[tauri::command]
pub async fn try_auto_login() -> Result<Option<LoginResult>, String> {
    // 1. Try password-based auto-login
    if let Some(email) = keyring_get(EMAIL_MARKER) {
        if let Some(password) = keyring_get(&email) {
            if let Ok(res) = backend_login(&email, &password).await {
                if res.role == "reseller" {
                    return Ok(Some(res));
                }
            }
        }
    }
    // 2. Try Google token auto-login
    if let (Some(email), Some(token)) = (keyring_get(EMAIL_MARKER), keyring_get(TOKEN_MARKER)) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("{}/api/auth/me", BACKEND))
            .bearer_auth(&token)
            .send()
            .await;
        if let Ok(r) = resp {
            if r.status().is_success() {
                if let Ok(body) = r.json::<serde_json::Value>().await {
                    let role = body.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if role == "reseller" {
                        let user = body.get("user").cloned().unwrap_or(serde_json::Value::Null);
                        return Ok(Some(LoginResult {
                            token, role, user, auth_method: "google".into()
                        }));
                    }
                }
            }
        }
    }
    Ok(None)
}

// ---------- External browser helper ----------

#[tauri::command]
pub async fn open_in_system_browser(url: String) -> Result<(), String> {
    open_url_external(&url)
}

pub fn open_url_external(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_portal(app: tauri::AppHandle, reseller_id: String) -> Result<(), String> {
    if reseller_id.is_empty() {
        return Err("reseller_id is required".to_string());
    }
    let url = format!("https://www.safelinks.name.ng/portal/{}", reseller_id);

    if let Some(w) = tauri::Manager::get_webview_window(&app, "portal") {
        let _ = w.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "portal",
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("bad url: {}", e))?),
    )
    .title("SAFE_Links Captive Portal")
    .inner_size(900.0, 800.0)
    .min_inner_size(500.0, 600.0)
    .build()
    .map_err(|e| format!("could not open portal window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn open_dashboard(app: tauri::AppHandle, token: Option<String>) -> Result<(), String> {
    let mut url = String::from("https://www.safelinks.name.ng/agent-login?source=installer");
    if let Some(t) = token.as_deref() {
        if !t.is_empty() {
            url.push_str("&token=");
            url.push_str(t);
        }
    }
    // Reuse an existing dashboard window if already open, else create a new
    // Tauri webview window pointing at the agent-login URL. Uses the same
    // WebView2 profile as the main window, so the reseller's session cookies
    // are shared and they are already logged in.
    if let Some(w) = tauri::Manager::get_webview_window(&app, "dashboard") {
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "dashboard",
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("bad url: {}", e))?),
    )
    .title("SAFE_Links Dashboard")
    .inner_size(1200.0, 820.0)
    .min_inner_size(900.0, 600.0)
    .build()
    .map_err(|e| format!("could not open dashboard window: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn open_google_signin(app: tauri::AppHandle) -> Result<(), String> {
    let url = "https://www.safelinks.name.ng/agent-login?source=installer";
    if let Some(w) = app.get_webview_window("google-auth") { let _ = w.set_focus(); return Ok(()); }
    let handle = app.clone();
    tauri::WebviewWindowBuilder::new(&app, "google-auth",
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("bad url: {}", e))?))
        .title("Sign in with Google")
        .inner_size(520.0, 720.0)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .on_navigation(move |nav| {
            let s = nav.as_str();
            if s.starts_with("safelinks-installer://") {
                if let Some((_, q)) = s.split_once('?') {
                    let mut token = String::new();
                    let mut role = String::new();
                    let mut email = String::new();
                    let mut company = String::new();
                    for pair in q.split('&') {
                        let (k, v) = match pair.split_once('=') { Some(x) => x, None => continue };
                        let v = url_decode(v);
                        match k {
                            "token" => token = v,
                            "role" => role = v,
                            "email" => email = v,
                            "companyName" => company = v,
                            _ => {}
                        }
                    }
                    let payload = serde_json::json!({ "token": token, "role": role, "email": email, "companyName": company });
                    let _ = handle.emit("deep-link-auth", payload);
                }
                if let Some(w) = handle.get_webview_window("google-auth") { let _ = w.close(); }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("could not open google auth window: {}", e))?;
    Ok(())
}

fn url_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l); i += 3; continue;
            }
        }
        out.push(bytes[i]); i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[tauri::command]
pub async fn open_forgot_password() -> Result<(), String> {
    open_url_external("https://www.safelinks.name.ng/forgot-password")
}

#[tauri::command]
pub async fn open_signup() -> Result<(), String> {
    open_url_external("https://www.safelinks.name.ng/signup?source=installer")
}