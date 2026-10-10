//! MikroTik router provisioning over SSH (russh, pure Rust - no libssh2).

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::ChannelMsg;
use russh_keys::key::PublicKey;
use serde::Serialize;

use crate::ssh::CONFIGURE_RSC;

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

    if !auth {
        return Err(format!("Authentication rejected for user '{}'", user));
    }
    Ok(session)
}

fn is_ros_error(s: &str) -> bool {
    let lower = s.to_lowercase();
    let trimmed = s.trim_start();
    lower.contains("no such item")
        || lower.contains("syntax error")
        || lower.contains("bad command name")
        || lower.contains("invalid value")
        || lower.contains("script error")
        || lower.contains("failure:")
        || trimmed.starts_with('!')
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
    let s = String::from_utf8_lossy(&out).into_owned();
    if is_ros_error(&s) {
        return Err(s.trim().to_string());
    }
    Ok(s)
}

fn escape_ros(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn count_ros_entries(s: &str) -> usize {
    s.lines()
        .filter(|l| {
            let t = l.trim_start();
            t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .count()
}

#[derive(Serialize)]
pub struct TestSshResult {
    pub ok: bool,
    pub ip: String,
    pub identity: String,
    pub resource: String,
}

#[derive(Serialize)]
pub struct ApplyResult {
    pub ok: bool,
    pub ssid: String,
    pub applied: usize,
    pub failed: usize,
    pub log: Vec<String>,
}

#[derive(Serialize)]
pub struct StatusCheck {
    pub label: String,
    pub ok: bool,
    pub warn_only: bool,
    pub detail: String,
}

#[derive(Serialize)]
pub struct RouterStatus {
    pub ssh_ok: bool,
    pub overall_ok: bool,
    pub checks: Vec<StatusCheck>,
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

    // Prepend runtime globals, wrap the whole .rsc as one script, send in a single exec.
    // RouterOS multi-line constructs (`:if (...) do={ ... }`) only work when executed
    // as a single script - sending them line-by-line breaks every block.
    let script = format!(
        ":global SL_WAN_MODE \"dhcp\"\n:global SL_LAN_IP \"192.168.88.1\"\n:global SL_SSID \"{}\"\n:global SL_WIFI_PASS \"{}\"\n{{\n{}\n}}",
        escape_ros(&ssid),
        escape_ros(&wifi_password),
        CONFIGURE_RSC
    );

    match exec(&mut session, &script).await {
        Ok(out) => {
            if out.contains("STATUS OK") {
                applied = 1;
                log.push("Script executed, STATUS OK".to_string());
                if log.len() < 80 {
                    // keep a tail of the output for the UI
                    let tail: Vec<&str> = out.lines().rev().take(10).collect();
                    for line in tail.iter().rev() { log.push((*line).to_string()); }
                }
            } else {
                failed = 1;
                log.push(format!("No STATUS OK marker; output: {}", out.trim()));
            }
        }
        Err(e) => {
            failed = 1;
            log.push(format!("Script failed: {}", e));
        }
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

async fn build_status(session: &mut Handle<AcceptAllKeys>) -> RouterStatus {
    let mut checks: Vec<StatusCheck> = Vec::new();

    let id_out = exec(session, "/system identity print").await.unwrap_or_default();
    let id_val = id_out
        .lines()
        .find(|l| l.trim_start().starts_with("name:"))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    checks.push(StatusCheck {
        label: "Router identity".into(),
        ok: true,
        warn_only: false,
        detail: id_val,
    });

    let hs_out = exec(session, "/ip hotspot print").await.unwrap_or_default();
    let hs_count = count_ros_entries(&hs_out);
    checks.push(StatusCheck {
        label: "Hotspot server".into(),
        ok: hs_count > 0,
        warn_only: false,
        detail: if hs_count > 0 {
            format!("{} active", hs_count)
        } else {
            "Not found - captive portal will not redirect".into()
        },
    });

    let dhcp_out = exec(session, "/ip dhcp-server print").await.unwrap_or_default();
    let dhcp_count = count_ros_entries(&dhcp_out);
    checks.push(StatusCheck {
        label: "DHCP server".into(),
        ok: dhcp_count > 0,
        warn_only: false,
        detail: if dhcp_count > 0 {
            format!("{} active", dhcp_count)
        } else {
            "Not found - clients will not get an IP".into()
        },
    });

    let wg_out = exec(session, "/ip hotspot walled-garden print").await.unwrap_or_default();
    let wg_count = count_ros_entries(&wg_out);
    let has_safelinks = wg_out.contains("safelinks.name.ng");
    let has_backend = wg_out.contains("backend-services-production");
    checks.push(StatusCheck {
        label: "Walled garden".into(),
        ok: wg_count >= 2 && has_safelinks && has_backend,
        warn_only: false,
        detail: if wg_count == 0 {
            "No entries - clients cannot reach the portal".into()
        } else {
            format!(
                "{} entries (portal: {}, backend: {})",
                wg_count,
                if has_safelinks { "yes" } else { "no" },
                if has_backend { "yes" } else { "no" }
            )
        },
    });

    let wlan_out = exec(session, "/interface print where type=wlan").await.unwrap_or_default();
    let wlan_count = count_ros_entries(&wlan_out);
    checks.push(StatusCheck {
        label: "WiFi radio".into(),
        ok: wlan_count > 0,
        warn_only: true,
        detail: if wlan_count > 0 {
            format!("{} radio(s) detected", wlan_count)
        } else {
            "No wireless interface - wired-only deploy".into()
        },
    });

    let overall_ok = checks.iter().filter(|c| !c.warn_only).all(|c| c.ok);

    RouterStatus {
        ssh_ok: true,
        overall_ok,
        checks,
    }
}

#[tauri::command]
pub async fn installer_router_check_status(
    ip: String,
    user: String,
    password: String,
) -> Result<RouterStatus, String> {
    let mut session = connect(&ip, &user, &password).await?;
    let status = build_status(&mut session).await;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    Ok(status)
}