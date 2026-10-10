use std::io::Read;
use std::net::TcpStream;
use std::time::Duration;

#[tauri::command]
pub async fn installer_router_test_ssh(
    ip: String,
    user: String,
    password: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let addr = format!("{}:22", ip);
        let tcp = TcpStream::connect(&addr).map_err(|e| format!("Cannot reach {} - {}", addr, e))?;
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
        let mut sess = ssh2::Session::new().map_err(|e| format!("SSH init: {}", e))?;
        sess.set_tcp_stream(tcp);
        sess.handshake().map_err(|e| format!("SSH handshake failed: {}", e))?;
        sess.userauth_password(&user, &password)
            .map_err(|e| format!("Auth failed for '{}': {}", user, e))?;
        if !sess.authenticated() { return Err("auth did not complete".to_string()); }
        let identity = run_cmd(&sess, "/system identity print")?;
        let resource = run_cmd(&sess, "/system resource print")?;
        Ok(serde_json::json!({ "ok": true, "ip": ip, "user": user, "identity": identity.trim(), "resource": resource.trim() }))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

fn run_cmd(sess: &ssh2::Session, cmd: &str) -> Result<String, String> {
    let mut ch = sess.channel_session().map_err(|e| format!("channel: {}", e))?;
    ch.exec(cmd).map_err(|e| format!("exec '{}': {}", cmd, e))?;
    let mut out = String::new();
    ch.read_to_string(&mut out).map_err(|e| format!("read: {}", e))?;
    let _ = ch.wait_close();
    Ok(out)
}