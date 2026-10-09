// Installer-side auth: log in as a reseller and fetch the plan config.
// Stage 2c-3 keeps things simple — HTTPS calls via reqwest, no state
// stored in Rust. The token lives in the WebView's localStorage for
// now; Stage 2c-4 will move it to the OS keychain via `keyring`.

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://backend-services-production-78d8.up.railway.app";

#[derive(Serialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct LoginUser {
    pub id: String,
    pub email: String,
    #[serde(rename = "companyName", default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub role: String,
    pub user: LoginUser,
}

#[tauri::command]
pub async fn installer_login(email: String, password: String) -> Result<LoginResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let resp = client
        .post(format!("{}/api/auth/login", API_BASE))
        .json(&LoginRequest { email, password })
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {}", e))?;

    if !status.is_success() {
        return Err(format!("login failed — HTTP {}: {}", status.as_u16(), body));
    }

    serde_json::from_str::<LoginResponse>(&body)
        .map_err(|e| format!("parse error: {} — body: {}", e, body))
}

#[tauri::command]
pub async fn installer_plan_config(token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let resp = client
        .get(format!("{}/api/installer/plan-config", API_BASE))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {}", e))?;

    if !status.is_success() {
        return Err(format!("plan-config failed — HTTP {}: {}", status.as_u16(), body));
    }

    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("parse error: {} — body: {}", e, body))
}


#[derive(Serialize)]
struct LicenseInitiateRequest {
    #[serde(rename = "planId")]
    plan_id: String,
    provider: String,
}

#[derive(Deserialize, Serialize)]
pub struct LicenseInitiateResponse {
    pub ok: bool,
    pub provider: String,
    pub reference: String,
    #[serde(rename = "authorizationUrl")]
    pub authorization_url: String,
    pub amount: f64,
    pub currency: String,
    #[serde(rename = "plan_id")]
    pub plan_id: String,
    #[serde(rename = "plan_name")]
    pub plan_name: String,
}

#[tauri::command]
pub async fn installer_license_initiate(
    token: String,
    plan_id: String,
    provider: String,
) -> Result<LicenseInitiateResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let resp = client
        .post(format!("{}/api/installer/license/initiate", API_BASE))
        .bearer_auth(&token)
        .json(&LicenseInitiateRequest { plan_id, provider })
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read body: {}", e))?;
    if !status.is_success() {
        return Err(format!("license-initiate failed - HTTP {}: {}", status.as_u16(), body));
    }
    serde_json::from_str::<LicenseInitiateResponse>(&body)
        .map_err(|e| format!("parse error: {} - body: {}", e, body))
}