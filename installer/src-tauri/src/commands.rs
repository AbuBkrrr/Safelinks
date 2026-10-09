use crate::{discover, fingerprint};
use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Serialize)]
pub struct LocalInfo { pub ip: String, pub subnet: String }

#[derive(Serialize)]
pub struct Device {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub web_title: Option<String>,
    pub open_ports: Vec<u16>,
    pub kind: String,
}

#[tauri::command]
pub async fn local_info() -> Result<LocalInfo, String> {
    let (ip, prefix, base) = discover::local_subnet().ok_or_else(|| "no local subnet".to_string())?;
    Ok(LocalInfo { ip: ip.to_string(), subnet: format!("{}/{}", base, prefix) })
}

async fn enrich(ip: Ipv4Addr, ports: Vec<u16>, mac: Option<String>) -> Device {
    // Vendor from MAC OUI first, then from HTTP title if that produces nothing.
    let vendor_mac = mac.as_deref().and_then(fingerprint::oui_lookup);

    let web_title = if ports.contains(&80) {
        fingerprint::http_probe_title(ip, 80).await
    } else if ports.contains(&8080) {
        fingerprint::http_probe_title(ip, 8080).await
    } else { None };

    let vendor_title = web_title.as_deref().and_then(fingerprint::classify_title);
    let vendor = vendor_title.or(vendor_mac);
    let kind = fingerprint::classify(vendor, &ports);

    Device {
        ip: ip.to_string(),
        mac,
        vendor: vendor.map(|s| s.to_string()),
        web_title,
        open_ports: ports,
        kind: kind.to_string(),
    }
}

#[tauri::command]
pub async fn scan_lan() -> Result<Vec<Device>, String> {
    let (_ip, prefix, base) = discover::local_subnet().ok_or_else(|| "no local subnet".to_string())?;
    let live = discover::ping_sweep(base, prefix).await;
    let arp = discover::arp_table();

    let mut handles = Vec::new();
    for ip in live {
        let mac = arp.get(&ip).cloned();
        handles.push(tokio::spawn(async move {
            let ports = fingerprint::probe_ports(ip).await;
            enrich(ip, ports, mac).await
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        if let Ok(d) = h.await {
            if d.kind == "device" && d.open_ports.is_empty() { continue; }
            out.push(d);
        }
    }
    out.sort_by_key(|d| match d.kind.as_str() {
        "router-mikrotik" => 0,
        "router-openwrt"  => 1,
        "router-ubiquiti" => 2,
        "router-tplink"   => 3,
        "router"          => 4,
        "router-likely"   => 5,
        "unknown-with-ports" => 6,
        _ => 7,
    });
    Ok(out)
}

#[tauri::command]
pub async fn probe_router(ip: String) -> Result<Device, String> {
    let parsed: Ipv4Addr = ip.parse().map_err(|_| format!("bad IP: {}", ip))?;
    let ports = fingerprint::probe_ports(parsed).await;
    let arp = discover::arp_table();
    let mac = arp.get(&parsed).cloned();
    Ok(enrich(parsed, ports, mac).await)
}