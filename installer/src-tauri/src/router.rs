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


async fn run_script_via_shell(
    session: &mut Handle<AcceptAllKeys>,
    script: &str,
) -> Result<String, String> {
    // RouterOS exec mode collapses everything to one line. Interactive shell
    // mode accepts newline-separated multi-line scripts. We open a shell
    // channel, dump the whole script, then read until output goes idle.
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("shell channel open failed: {}", e))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell failed: {}", e))?;

    // Let RouterOS print its first prompt
    tokio::time::sleep(Duration::from_millis(900)).await;

    // Drain the initial banner
    let mut pre: Vec<u8> = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(400), channel.wait()).await {
            Ok(Some(ChannelMsg::Data { ref data })) => pre.extend_from_slice(data),
            _ => break,
        }
    }

    // Send the whole script. \n works in shell mode.
    let mut payload = String::new();
    payload.push_str(script);
    if !script.ends_with('\n') { payload.push('\n'); }

    channel
        .data(payload.as_bytes())
        .await
        .map_err(|e| format!("write failed: {}", e))?;

    // Read until output goes quiet for 3 consecutive seconds, or 90s hard cap.
    let hard_deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let mut out: Vec<u8> = Vec::new();

    loop {
        let now = tokio::time::Instant::now();
        if now >= hard_deadline { break; }

        let wait_for = Duration::from_secs(3);
        match tokio::time::timeout(wait_for, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { ref data })) => out.extend_from_slice(data),
            Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => out.extend_from_slice(data),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => break, // idle timeout - script has finished
        }
    }

    let _ = channel.close().await;
    Ok(String::from_utf8_lossy(&out).into_owned())
}
async fn exec_raw(session: &mut Handle<AcceptAllKeys>, cmd: &str) -> Result<String, String> {
    // Like exec() but does NOT reject on RouterOS runtime error strings.
    // Script transport wants the raw output so we can look for STATUS OK.
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

fn count_ros_entries(s: &str) -> usize {
    s.lines()
        .filter(|l| {
            let t = l.trim_start();
            t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .count()
}


/// Compress a .rsc file into one top-level statement per line, preserving
/// block structure. RouterOS exec mode rejects multi-line :do{} and
/// :if ... do={} blocks - they must be on one line with balanced braces.
/// Bare ":global NAME" declarations are dropped (they are set by the preamble).
fn compress_rsc_to_statements(rsc: &str) -> Vec<String> {
    let mut statements: Vec<String> = Vec::new();
    let mut pending = String::new();
    let mut depth: i32 = 0;

    for raw in rsc.lines() {
        let t = raw.trim();
        if t.is_empty() { continue; }
        if t.starts_with('#') { continue; }

        // Skip bare ":global NAME" - set by preamble instead.
        if t.starts_with(":global ") {
            let parts: Vec<&str> = t.split_whitespace().collect();
            if parts.len() == 2 { continue; }
        }

        for ch in t.chars() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
        }

        if !pending.is_empty() { pending.push(' '); }
        pending.push_str(t);

        if depth <= 0 {
            statements.push(pending.clone());
            pending.clear();
            depth = 0;
        }
    }

    if !pending.is_empty() { statements.push(pending); }
    statements
}

/// Count RouterOS error markers. "no such item" is deliberately NOT counted -
/// it is benign output from remove commands when the target did not exist.
fn count_ros_errors(s: &str) -> usize {
    let lower = s.to_lowercase();
    let patterns = [
        "syntax error",
        "bad parameter name",
        "expected closing brace",
        "expected end of command",
        "invalid value",
        "input does not match",
        "script error",
        "failure:",
        "bad command name",
    ];
    patterns.iter().map(|p| lower.matches(p).count()).sum()
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

    // Build the script with our values inlined at the top so the .rsc sees them.
    let mut file_contents = String::new();
    file_contents.push_str(&format!(":global slSsid \"{}\"\n", escape_ros(&ssid)));
    file_contents.push_str(&format!(":global slWifiPass \"{}\"\n", escape_ros(&wifi_password)));
    file_contents.push_str(":global slWanMode \"dhcp\"\n");
    file_contents.push_str(":global slLanIp \"192.168.88.1\"\n");
    file_contents.push_str(CONFIGURE_RSC);

    // Run through an interactive shell channel. Exec mode is single-line only;
    // shell mode parses the .rsc line by line, preserving block structure.
    match run_script_via_shell(&mut session, &file_contents).await {
        Ok(out) => {
            let errors = count_ros_errors(&out);
            if out.contains("STATUS OK") && errors == 0 {
                applied = 1;
                log.push("SUCCESS: router is configured and serving the portal.".to_string());
            } else if errors > 0 {
                failed = errors;
                log.push(format!("Finished with {} error(s). Router may be partially configured.", errors));
            } else {
                failed = 1;
                log.push("Script ran but STATUS OK marker was not returned.".to_string());
            }
            let tail: Vec<&str> = out.lines().rev().take(30).collect();
            for line in tail.iter().rev() {
                let t = line.trim();
                if !t.is_empty() { log.push(t.to_string()); }
            }
        }
        Err(e) => {
            failed = 1;
            log.push(format!("Script transport failed: {}", e));
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


// ========================================================================
// Option B: save the .rsc to disk for manual Winbox import.
// No SSH, no exec mode, no shell channel. Just writes a file.
// ========================================================================
#[tauri::command]
pub async fn installer_save_rsc(ssid: String, wifi_password: String) -> Result<String, String> {
    let mut lines_out: Vec<String> = Vec::new();
    for line in CONFIGURE_RSC.lines() {
        let t = line.trim_end();
        if t == ":global slSsid" {
            lines_out.push(format!(":global slSsid \"{}\"", escape_ros(&ssid)));
        } else if t == ":global slWifiPass" {
            lines_out.push(format!(":global slWifiPass \"{}\"", escape_ros(&wifi_password)));
        } else {
            lines_out.push(line.to_string());
        }
    }
    let body = lines_out.join("\r\n") + "\r\n";

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot find home directory".to_string())?;
    let dir = std::path::PathBuf::from(home).join("Documents").join("SAFE_Links");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let path = dir.join("safelinks-configure.rsc");
    std::fs::write(&path, body.as_bytes()).map_err(|e| format!("write failed: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}