use serde::Serialize;

#[derive(Serialize)]
pub struct PreflightItem {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    pub required: bool,
}

#[derive(Serialize)]
pub struct PreflightReport {
    pub items: Vec<PreflightItem>,
    pub all_required_ok: bool,
    pub internet_ok: bool,
    pub os_ok: bool,
}

#[tauri::command]
pub async fn check_prerequisites() -> Result<PreflightReport, String> {
    let mut items = Vec::new();

    let webview2 = check_webview2();
    items.push(PreflightItem {
        name: "WebView2 Runtime".into(),
        ok: webview2,
        detail: if webview2 { "Installed".into() } else { "Missing — required. Reinstall Windows WebView2.".into() },
        required: true,
    });

    let vcredist = check_vcredist();
    items.push(PreflightItem {
        name: "Visual C++ Runtime".into(),
        ok: vcredist,
        detail: if vcredist { "Installed".into() } else { "Recommended — install VC++ 2015-2022 x64".into() },
        required: false,
    });

    let (os_ver, os_ok) = check_os_version();
    items.push(PreflightItem {
        name: "Windows version".into(),
        ok: os_ok,
        detail: os_ver.clone(),
        required: true,
    });

    let net = check_network();
    items.push(PreflightItem {
        name: "Network adapter".into(),
        ok: net,
        detail: if net { "Active".into() } else { "No active adapter — connect a cable or WiFi".into() },
        required: true,
    });

    let internet_ok = check_internet().await;
    items.push(PreflightItem {
        name: "Internet connection".into(),
        ok: internet_ok,
        detail: if internet_ok { "Online".into() } else { "Offline — connect to internet to continue".into() },
        required: true,
    });

    let all_required_ok = items.iter().filter(|i| i.required).all(|i| i.ok);
    Ok(PreflightReport { items, all_required_ok, internet_ok, os_ok })
}

#[cfg(windows)]
fn check_webview2() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    let paths = [
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    for p in paths {
        if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(p) {
            if k.get_value::<String, _>("pv").is_ok() { return true; }
        }
    }
    false
}

#[cfg(not(windows))]
fn check_webview2() -> bool { true }

#[cfg(windows)]
fn check_vcredist() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    let paths = [
        r"SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
        r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
    ];
    for p in paths {
        if RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(p).is_ok() { return true; }
    }
    false
}

#[cfg(not(windows))]
fn check_vcredist() -> bool { true }

fn check_os_version() -> (String, bool) {
    let info = os_info::get();
    let kind = format!("{:?}", info.os_type());
    let ver = info.version().to_string();
    let detail = format!("{} {}", kind, ver);
    let ok = if cfg!(windows) {
        let parts: Vec<&str> = ver.split('.').collect();
        if parts.len() >= 3 {
            let major: u32 = parts[0].parse().unwrap_or(0);
            let minor: u32 = parts[1].parse().unwrap_or(0);
            let build: u32 = parts[2].parse().unwrap_or(0);
            (major > 10) || (major == 10 && minor == 0 && build >= 17763)
        } else { true }
    } else { true };
    (detail, ok)
}

fn check_network() -> bool {
    local_ip_address::local_ip().is_ok()
}

async fn check_internet() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .head("https://backend-services-production-78d8.up.railway.app/")
        .send()
        .await
        .is_ok()
}