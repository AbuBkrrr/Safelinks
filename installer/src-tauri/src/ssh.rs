// The router setup script is no longer embedded in this app: it is served by
// the SAFE_Links backend (GET /api/setup/<code>.rsc) so every copy of the
// installer, however old, applies the current script. See router.rs.

use serde::Serialize;

#[derive(Serialize)]
pub struct ScriptInfo {
    pub configure_bytes: usize,
    pub agent_bytes: usize,
    pub configure_lines: usize,
    pub agent_lines: usize,
}

/// Kept for UI compatibility: scripts are fetched from the backend at setup time.
#[tauri::command]
pub async fn scripts_info() -> Result<ScriptInfo, String> {
    Ok(ScriptInfo { configure_bytes: 0, agent_bytes: 0, configure_lines: 0, agent_lines: 0 })
}
