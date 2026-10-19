//! MikroTik router provisioning over SSH (russh, pure Rust - no libssh2).

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::ChannelMsg;
use russh_keys::key::PublicKey;
use serde::Serialize;

use crate::ssh::CONFIGURE_RSC;

const SL_BACKEND: &str = "https://backend-services-production-78d8.up.railway.app";

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
    let mut preferred = russh::Preferred::default();
    preferred.kex = std::borrow::Cow::Borrowed(&[
        russh::kex::DH_G1_SHA1,
        russh::kex::DH_G14_SHA1,
        russh::kex::DH_G14_SHA256,
        russh::kex::DH_G16_SHA512,
        russh::kex::ECDH_SHA2_NISTP256,
        russh::kex::ECDH_SHA2_NISTP384,
        russh::kex::ECDH_SHA2_NISTP521,
        russh::kex::CURVE25519,
        russh::kex::CURVE25519_PRE_RFC_8731,
    ]);
    let mut cfg_inner = client::Config::default();
    cfg_inner.preferred = preferred;
    let cfg = Arc::new(cfg_inner);

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
    reseller_id: Option<String>,
    admin_mac: Option<String>,
    auth_token: Option<String>,
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
    let rid = reseller_id.unwrap_or_default();
    if rid.is_empty() {
        failed = 1;
        log.push("ERROR: reseller_id is empty. Sign out and sign in again, then retry.".to_string());
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "").await;
        return Ok(ApplyResult { ok: false, ssid, applied, failed, log });
    }
    file_contents.push_str(&format!(":global slResellerId \"{}\"\n", escape_ros(&rid)));
    let mac = admin_mac.unwrap_or_default();
    if !mac.is_empty() {
        file_contents.push_str(&format!(":global slAdminMac \"{}\"\n", escape_ros(&mac)));
    }
    file_contents.push_str(CONFIGURE_RSC);

    // Transport: SFTP the script to the router, then /import file=... Exec
    // mode is single-line only; shell mode collapses newlines. Per project
    // brief: multi-line scripts must run via /import file= on the filesystem.
    let auth = auth_token.unwrap_or_default();
    if auth.is_empty() {
        failed = 1;
        log.push("ERROR: auth_token is empty. Sign out and sign in again.".to_string());
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "").await;
        return Ok(ApplyResult { ok: false, ssid, applied, failed, log });
    }

    let uploaded_path = match publish_and_fetch_rsc(&mut session, &auth, &file_contents, &mut log).await {
        Ok(p) => p,
        Err(e) => {
            failed = 1;
            log.push(format!("RSC delivery failed: {}", e));
            let _ = session.disconnect(russh::Disconnect::ByApplication, "", "").await;
            return Ok(ApplyResult { ok: false, ssid, applied, failed, log });
        }
    };

    let import_cmd = format!("/import file={}", uploaded_path);
    match exec_raw(&mut session, &import_cmd).await {
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
                log.push("Import ran but STATUS OK marker was not returned.".to_string());
            }

            // Non-fatal: install the automation agent regardless of configure result
            if let Err(e) = install_agent(&mut session, &auth, &mut log).await {
                log.push(format!("WARN: agent install failed: {}", e));
            }
            let tail: Vec<&str> = out.lines().rev().take(30).collect();
            for line in tail.iter().rev() {
                let t = line.trim();
                if !t.is_empty() { log.push(t.to_string()); }
            }
        }
        Err(e) => {
            failed = 1;
            log.push(format!("Import execution failed: {}", e));
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
pub async fn installer_save_rsc(
    ssid: String,
    wifi_password: String,
    reseller_id: String,
    admin_mac: String,
) -> Result<String, String> {
    let mut lines_out: Vec<String> = Vec::new();
    for line in CONFIGURE_RSC.lines() {
        let t = line.trim_end();
        if t == ":global slSsid" {
            lines_out.push(format!(":global slSsid \"{}\"", escape_ros(&ssid)));
        } else if t == ":global slWifiPass" {
            lines_out.push(format!(":global slWifiPass \"{}\"", escape_ros(&wifi_password)));
        } else if t == ":global slResellerId" {
            lines_out.push(format!(":global slResellerId \"{}\"", escape_ros(&reseller_id)));
        } else if t == ":global slAdminMac" {
            lines_out.push(format!(":global slAdminMac \"{}\"", escape_ros(&admin_mac)));
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

/// Publish the RSC to our backend, then tell the router to pull it via
/// /tool fetch. Avoids RouterOS SFTP (unreliable on several firmware builds).
/// Returns the local path where the router saved the file, ready for /import.
async fn publish_and_fetch_rsc(
    session: &mut Handle<AcceptAllKeys>,
    auth_token: &str,
    rsc_text: &str,
    log: &mut Vec<String>,
) -> Result<String, String> {
    const REMOTE_FILE: &str = "safelinks-configure.rsc";

    // Step 1 — POST the RSC to our backend, get a short-lived download URL.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("reqwest build: {}", e))?;

    let payload = serde_json::json!({ "content": rsc_text });
    let resp = client
        .post(format!("{}/api/installer/rsc-publish", SL_BACKEND))
        .bearer_auth(auth_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("publish POST failed: {}", e))?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("publish HTTP {}: {}", status.as_u16(), body_text.trim()));
    }
    let body: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("publish response not JSON: {} — body={}", e, body_text.trim()))?;
    let url = body.get("url").and_then(|v| v.as_str())
        .ok_or_else(|| format!("publish response missing 'url': {}", body_text.trim()))?
        .to_string();
    log.push(format!("RSC published ({} bytes) → {}", rsc_text.len(), url));

    // Step 2 — tell the router to pull the file itself.
    // 1. Force cleanup of old agent scripts
let _ = exec_raw(session, "/system script remove [find name=\"safelinks-checkin\"]").await;
let _ = exec_raw(session, "/system scheduler remove [find name=\"safelinks-checkin\"]").await;

// 2. Retry fetch with verification
let mut fetch_ok = false;
for attempt in 1..=5 {
    let fetch_cmd = format!(
        "/tool fetch url=\"{}\" dst-path=\"{}\" check-certificate=no",
        url, REMOTE_FILE
    );
    log.push(format!("Attempting to fetch agent (try {})...", attempt));
    
    match exec_raw(session, &fetch_cmd).await {
        Ok(out) => {
            if out.contains("failure:") || out.contains("status: failed") {
                log.push(format!("Fetch failed: {}", out.trim()));
            } else {
                // Wait for the file to actually appear in the filesystem
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let check_cmd = format!("/file print where name=\"{}\"", REMOTE_FILE);
                let check_out = exec_raw(session, &check_cmd).await.unwrap_or_default();
                if check_out.contains(REMOTE_FILE) {
                    fetch_ok = true;
                    log.push(format!("Agent downloaded to {}", REMOTE_FILE));
                    break;
                } else {
                    log.push("Fetch command succeeded but file is missing.".to_string());
                }
            }
        }
        Err(e) => log.push(format!("Fetch error: {}", e)),
    }
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
}

if !fetch_ok {
    return Err("CRITICAL: Could not download agent script to router. Check internet access.".to_string());
}

log.push("Agent file verified on router.".to_string());

    // Step 3 — confirm the file exists on the router.
    let check_cmd = format!("/file print where name=\"{}\"", REMOTE_FILE);
    let check_out = exec_raw(session, &check_cmd).await.unwrap_or_default();
    if !check_out.contains(REMOTE_FILE) {
        return Err(format!(
            "file '{}' not found after fetch — file print returned: {}",
            REMOTE_FILE, check_out.trim()
        ));
    }
    let size_line = check_out.lines()
        .find(|l| l.contains(REMOTE_FILE))
        .unwrap_or("")
        .trim().to_string();
    log.push(format!("Verified on router: {}", size_line));

    Ok(REMOTE_FILE.to_string())
}

/// Install the SAFELINKS zero-touch agent on the router and pair it.
/// Runs after configure RSC succeeds. Non-fatal — the router still serves
/// the portal if this fails, just without the automation agent.
async fn install_agent(
    session: &mut Handle<AcceptAllKeys>,
    auth_token: &str,
    log: &mut Vec<String>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("reqwest build: {}", e))?;

    // 1. Get pairing code
    let pc_resp = client
        .post(format!("{}/api/reseller/pairing-codes", SL_BACKEND))
        .bearer_auth(auth_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("pairing-code POST: {}", e))?;
    if !pc_resp.status().is_success() {
        return Err(format!("pairing-code HTTP {}", pc_resp.status().as_u16()));
    }
    let pc_body: serde_json::Value = pc_resp.json().await
        .map_err(|e| format!("pairing-code JSON: {}", e))?;
    let code = pc_body.get("code").and_then(|v| v.as_str())
        .ok_or_else(|| "pairing-code missing".to_string())?
        .to_string();
    log.push(format!("Generated pairing code: {}", code));

    // 2. Router fetches bootstrap.rsc?code=<code>
    let boot_url = format!("{}/api/agent/bootstrap.rsc?code={}", SL_BACKEND, code);
    let fetch_cmd = format!(
        "/tool fetch url=\"{}\" dst-path=\"safelinks-bootstrap.rsc\" check-certificate=no",
        boot_url
    );
    let fetch_out = exec_raw(session, &fetch_cmd).await
        .map_err(|e| format!("bootstrap fetch exec: {}", e))?;
    if fetch_out.contains("failure:") || fetch_out.contains("status: failed") {
        return Err(format!("bootstrap fetch failed: {}", fetch_out.trim()));
    }
    log.push("Router fetched safelinks-bootstrap.rsc".to_string());

    // 3. Import — runs pairing + scheduler creation inline
    let import_out = exec_raw(session, "/import file=safelinks-bootstrap.rsc").await
        .map_err(|e| format!("bootstrap import exec: {}", e))?;
    let import_failed = import_out.contains("failure:")
        || import_out.contains("status: failed")
        || import_out.contains("Script Error:")
        || import_out.contains("syntax error");
    if import_failed && !import_out.contains("loaded and executed") {
        return Err(format!("bootstrap import failed: {}", import_out.trim()));
    }
    if !import_out.contains("safelinks-bootstrap: OK") {
        return Err(format!("bootstrap did not confirm pairing: {}", import_out.trim()));
    }
    log.push("Bootstrap paired with backend".to_string());

    Ok(())
}