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
pub async fn open_dashboard() -> Result<(), String> {
    open_url_external("https://www.safelinks.name.ng/")
}

#[tauri::command]
pub async fn open_google_signin() -> Result<(), String> {
    // The web app should, after successful Google sign-in, redirect to:
    //   safelinks-installer://auth?token=<JWT>&role=reseller&email=<email>&companyName=<name>
    open_url_external("https://www.safelinks.name.ng/agent-login?source=installer")
}

#[tauri::command]
pub async fn open_forgot_password() -> Result<(), String> {
    open_url_external("https://www.safelinks.name.ng/forgot-password")
}

#[tauri::command]
pub async fn open_signup() -> Result<(), String> {
    open_url_external("https://www.safelinks.name.ng/signup?source=installer")
}