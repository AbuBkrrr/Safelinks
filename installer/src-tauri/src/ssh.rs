// SSH provisioning module for the MikroTik installer.
//
// Stage 2b-1 (this file): embeds the two .rsc scripts into the binary so
// they ship with the app, and exposes a self-test that confirms the
// resource files were found at compile time. No network calls yet.

use serde::Serialize;

/// The MikroTik configuration script body, verbatim from
/// web/backend/router-scripts/safelinks-configure.rsc.
pub const CONFIGURE_RSC: &str = include_str!("../resources/safelinks-configure.rsc");

/// The MikroTik agent installer script body, verbatim from
/// web/backend/router-scripts/safelinks-agent.rsc.
pub const AGENT_RSC: &str = include_str!("../resources/safelinks-agent.rsc");

#[derive(Serialize)]
pub struct ScriptInfo {
    pub configure_bytes: usize,
    pub agent_bytes: usize,
    pub configure_lines: usize,
    pub agent_lines: usize,
}

/// Sanity check that the resources were embedded. Callable from the UI.
#[tauri::command]
pub async fn scripts_info() -> Result<ScriptInfo, String> {
    Ok(ScriptInfo {
        configure_bytes: CONFIGURE_RSC.len(),
        agent_bytes: AGENT_RSC.len(),
        configure_lines: CONFIGURE_RSC.lines().count(),
        agent_lines: AGENT_RSC.lines().count(),
    })
}
