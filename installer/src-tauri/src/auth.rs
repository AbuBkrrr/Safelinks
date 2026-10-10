use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "safelinks-installer";
const EMAIL_MARKER: &str = "__last_email__";
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
}

#[tauri::command]
pub async fn store_credentials(email: String, password: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &email).map_err(|e| e.to_string())?;
    entry.set_password(&password).map_err(|e| e.to_string())?;
    let marker = keyring::Entry::new(KEYRING_SERVICE, EMAIL_MARKER).map_err(|e| e.to_string())?;
    marker.set_password(&email).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_credentials() -> Result<Option<StoredSession>, String> {
    let marker = match keyring::Entry::new(KEYRING_SERVICE, EMAIL_MARKER) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let email: String = match marker.get_password() {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    Ok(Some(StoredSession { email }))
}

#[tauri::command]
pub async fn clear_credentials() -> Result<(), String> {
    let marker = match keyring::Entry::new(KEYRING_SERVICE, EMAIL_MARKER) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let email: Option<String> = marker.get_password().ok();
    let _ = marker.delete_credential();
    if let Some(e) = email {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &e) {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
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
    Ok(LoginResult { token, role, user })
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
    let marker = match keyring::Entry::new(KEYRING_SERVICE, EMAIL_MARKER) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let email: String = match marker.get_password() {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let entry = keyring::Entry::new(KEYRING_SERVICE, &email).map_err(|e| e.to_string())?;
    let password: String = match entry.get_password() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    match backend_login(&email, &password).await {
        Ok(res) => {
            if res.role != "reseller" {
                return Err("Stored account is not a reseller".into());
            }
            Ok(Some(res))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn open_dashboard() -> Result<(), String> {
    let url = "https://www.safelinks.name.ng/";
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