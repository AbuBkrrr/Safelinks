//! MikroTik router provisioning over SSH (russh, pure Rust - no libssh2).

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::ChannelMsg;
use russh_keys::key::PublicKey;
use serde::Serialize;

use crate::ssh::CONFIGURE_RSC;

/// Accept any server host key. MikroTik ships a self-signed key by default.
struct AcceptAllKeys;

#[async_trait::async_trait]
impl client::Handler for AcceptAllKeys {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect(ip: &str, user: &str, password: &str) -> Result<Handle<AcceptAllKeys>, String> {
    let addr = format!("{}:22", ip);
    let cfg = Arc::new(client::Config::default());

    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(cfg, addr.as_str(), AcceptAllKeys),
    )
    .await
    .map_err(|_| format!("Timed out connecting to {}", addr))?
    .map_err(|e| format!("SSH connect failed: {}", e))?;

    let auth = tokio::time::timeout(
        Duration::from_secs(10),
        session.authenticate_password(user, password),
    )
    .await
    .map_err(|_| "Auth timed out".to_string())?
    .map_err(|e| format!("Auth error: {}", e))?;

    // russh 0.45: authenticate_password returns Result<bool, Error>
    if !auth {
        return Err(format!("Authentication rejected for user '{}'", user));
    }
    Ok(session)
}

async fn exec(session: &mut Handle<AcceptAllKeys>, cmd: &str) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel open failed: {}", e))?;

    channel
        .exec(true, cmd)
        .await
        .map_err(|e| format!("exec failed: {}", e))?;

    let mut out: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => out.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => out.extend_from_slice(data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn escape_ros(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[derive(Serialize)]
pub struct TestSshResult {
    pub ok: bool,
    pub ip: String,
    pub identity: String,
    pub resource: String,
}

#[tauri::command]
pub async fn installer_router_test_ssh(
    ip: String,
    user: String,
    password: String,
) -> Result<TestSshResult, String> {
    let mut session = connect(&ip, &user, &password).await?;
    let identity = exec(&mut session, "/system identity print").await?;
    let resource = exec(&mut session, "/system resource print").await?;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    Ok(TestSshResult {
        ok: true,
        ip,
        identity: identity.trim().to_string(),
        resource: resource.trim().to_string(),
    })
}

#[derive(Serialize)]
pub struct ApplyResult {
    pub ok: bool,
    pub ssid: String,
    pub applied: usize,
    pub failed: usize,
    pub log: Vec<String>,
}

#[tauri::command]
pub async fn installer_router_apply_config(
    ip: String,
    user: String,
    password: String,
    ssid: String,
    wifi_password: String,
) -> Result<ApplyResult, String> {
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("SSID must be 1..32 characters".into());
    }
    if wifi_password.len() < 8 {
        return Err("WiFi password must be at least 8 characters".into());
    }

    let mut session = connect(&ip, &user, &password).await?;
    let mut log: Vec<String> = Vec::new();
    let mut applied = 0usize;
    let mut failed = 0usize;

    for raw in CONFIGURE_RSC.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        match exec(&mut session, line).await {
            Ok(_) => { applied += 1; if log.len() < 80 { log.push(format!("OK : {}", line)); } }
            Err(e) => { failed += 1; log.push(format!("ERR: {} -- {}", line, e)); }
        }
    }

    let ssid_cmd = format!(
        "/interface wireless set [find default-name=wlan1] ssid=\"{}\"",
        escape_ros(&ssid)
    );
    match exec(&mut session, &ssid_cmd).await {
        Ok(_) => { applied += 1; log.push(format!("OK : ssid set to '{}'", ssid)); }
        Err(e) => { failed += 1; log.push(format!("ERR: ssid set -- {}", e)); }
    }

    let sec_cmd = format!(
        "/interface wireless security-profiles set [find default=yes] authentication-types=wpa2-psk wpa2-pre-shared-key=\"{}\"",
        escape_ros(&wifi_password)
    );
    match exec(&mut session, &sec_cmd).await {
        Ok(_) => { applied += 1; log.push("OK : wifi password set".to_string()); }
        Err(e) => { failed += 1; log.push(format!("ERR: wifi password -- {}", e)); }
    }

    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;

    Ok(ApplyResult {
        ok: failed == 0,
        ssid,
        applied,
        failed,
        log,
    })
}