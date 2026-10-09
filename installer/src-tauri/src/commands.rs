use crate::{discover, fingerprint};
use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Serialize)]
pub struct LocalInfo {
    pub ip: String,
    pub subnet: String,
}

#[derive(Serialize)]
pub struct Device {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub open_ports: Vec<u16>,
    pub kind: String,
}

#[tauri::command]
pub async fn local_info() -> Result<LocalInfo, String> {
    let (ip, prefix, base) = discover::local_subnet()
        .ok_or_else(|| "Could not determine local subnet".to_string())?;
    Ok(LocalInfo {
        ip: ip.to_string(),
        subnet: format!("{}/{}", base, prefix),
    })
}

#[tauri::command]
pub async fn scan_lan() -> Result<Vec<Device>, String> {
    let (_ip, prefix, base) = discover::local_subnet()
        .ok_or_else(|| "Could not determine local subnet".to_string())?;

    let live = discover::ping_sweep(base, prefix).await;
    let arp = discover::arp_table();

    let mut handles = Vec::new();
    for ip in live {
        handles.push(tokio::spawn(async move {
            let ports = fingerprint::probe_ports(ip).await;
            (ip, ports)
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        if let Ok((ip, ports)) = h.await {
            let mac = arp.get(&ip).cloned();
            let vendor = mac.as_deref().and_then(fingerprint::oui_lookup);
            let kind = fingerprint::classify(vendor, &ports);
            if kind == "device" && ports.is_empty() { continue; }
            out.push(Device {
                ip: ip.to_string(),
                mac,
                vendor: vendor.map(|s| s.to_string()),
                open_ports: ports,
                kind: kind.to_string(),
            });
        }
    }
    out.sort_by_key(|d| match d.kind.as_str() {
        "router-mikrotik" => 0,
        "router" => 1,
        "router-likely" => 2,
        "unknown-with-ports" => 3,
        _ => 4,
    });
    Ok(out)
}

#[tauri::command]
pub async fn probe_router(ip: String) -> Result<Device, String> {
    let parsed: Ipv4Addr = ip.parse().map_err(|_| format!("bad IP: {}", ip))?;
    let ports = fingerprint::probe_ports(parsed).await;
    let arp = discover::arp_table();
    let mac = arp.get(&parsed).cloned();
    let vendor = mac.as_deref().and_then(fingerprint::oui_lookup);
    let kind = fingerprint::classify(vendor, &ports);
    Ok(Device {
        ip,
        mac,
        vendor: vendor.map(|s| s.to_string()),
        open_ports: ports,
        kind: kind.to_string(),
    })
}