use crate::{discover, fingerprint};
use serde::Serialize;
use std::collections::HashSet;
use std::net::Ipv4Addr;

#[derive(Serialize)]
pub struct LocalInfo {
    pub ip: String,
    pub subnet: String,
    pub gateway: Option<String>,
}

#[derive(Serialize)]
pub struct Device {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub web_title: Option<String>,
    pub open_ports: Vec<u16>,
    pub kind: String,
    pub is_gateway: bool,
}

#[tauri::command]
pub async fn local_info() -> Result<LocalInfo, String> {
    let subnets = discover::local_subnets();
    let first = subnets.first().ok_or_else(|| "no local subnet".to_string())?;
    let summary = subnets.iter().map(|(_, p, b)| format!("{}/{}", b, p)).collect::<Vec<_>>().join(", ");
    let gateway = discover::default_gateway().map(|g| g.to_string());
    Ok(LocalInfo { ip: first.0.to_string(), subnet: summary, gateway })
}

async fn enrich(ip: Ipv4Addr, ports: Vec<u16>, mac: Option<String>, gateway: Option<Ipv4Addr>) -> Device {
    let vendor_mac = mac.as_deref().and_then(fingerprint::oui_lookup);
    let web_title = if ports.contains(&80) {
        fingerprint::http_probe_title(ip, 80).await
    } else if ports.contains(&8080) {
        fingerprint::http_probe_title(ip, 8080).await
    } else { None };
    let vendor_title = web_title.as_deref().and_then(fingerprint::classify_title);
    let vendor = vendor_title.or(vendor_mac);
    let kind = fingerprint::classify(vendor, &ports);
    let is_gateway = gateway.map_or(false, |g| g == ip);
    Device {
        ip: ip.to_string(),
        mac,
        vendor: vendor.map(|s| s.to_string()),
        web_title,
        open_ports: ports,
        kind: kind.to_string(),
        is_gateway,
    }
}

fn parse_cidr(s: &str) -> Option<(Ipv4Addr, u8)> {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 { return None; }
    let ip: Ipv4Addr = parts[0].parse().ok()?;
    let prefix: u8 = parts[1].parse().ok()?;
    let o = ip.octets();
    Some((Ipv4Addr::new(o[0], o[1], o[2], 0), prefix))
}

/// Hard cap: never sweep more than this many subnets in one run.
const MAX_SUBNETS_PER_RUN: usize = 4;
/// Concurrency per subnet (in-flight TCP probes).
const PROBE_CONCURRENCY: usize = 64;

#[tauri::command]
pub async fn scan_lan(extra_subnets: Option<Vec<String>>) -> Result<Vec<Device>, String> {
    let gateway = discover::default_gateway();
    let mut bases: Vec<Ipv4Addr> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();

    // Priority order:
    // 1. Local subnets (always)
    for (_, _, base) in discover::local_subnets() {
        if seen.insert(u32::from(base)) { bases.push(base); }
    }
    // 2. Explicitly requested by the user
    if let Some(extra) = extra_subnets {
        for s in extra {
            if let Some((base, prefix)) = parse_cidr(&s) {
                if prefix == 24 && seen.insert(u32::from(base)) { bases.push(base); }
            }
        }
    }
    // 3. Routed subnets (only if we still have room)
    if bases.len() < MAX_SUBNETS_PER_RUN {
        for base in discover::routed_subnets() {
            if seen.insert(u32::from(base)) {
                bases.push(base);
                if bases.len() >= MAX_SUBNETS_PER_RUN { break; }
            }
        }
    }
    // Hard cap
    bases.truncate(MAX_SUBNETS_PER_RUN);

    // TCP sweep in parallel across subnets; concurrency capped per subnet.
    let mut subnet_handles = Vec::new();
    for base in bases {
        subnet_handles.push(tokio::spawn(async move {
            discover::tcp_sweep(base, PROBE_CONCURRENCY).await
        }));
    }

    let mut all_live: Vec<Ipv4Addr> = Vec::new();
    let mut live_seen: HashSet<u32> = HashSet::new();
    // Always seed the gateway so it's included even if it blocks all probed ports.
    if let Some(gw) = gateway {
        if live_seen.insert(u32::from(gw)) { all_live.push(gw); }
    }
    for h in subnet_handles {
        if let Ok(mut ips) = h.await {
            for ip in ips.drain(..) {
                if live_seen.insert(u32::from(ip)) { all_live.push(ip); }
            }
        }
    }

    let arp = discover::arp_table();

    let mut handles = Vec::new();
    for ip in all_live {
        let mac = arp.get(&ip).cloned();
        let gw = gateway;
        handles.push(tokio::spawn(async move {
            let ports = fingerprint::probe_ports(ip).await;
            enrich(ip, ports, mac, gw).await
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        if let Ok(d) = h.await {
            if d.kind == "device" && d.open_ports.is_empty() && !d.is_gateway { continue; }
            out.push(d);
        }
    }
    out.sort_by_key(|d| {
        let gw_rank = if d.is_gateway { 0 } else { 1 };
        let kind_rank = match d.kind.as_str() {
            "router-mikrotik" => 0,
            "router-openwrt"  => 1,
            "router-ubiquiti" => 2,
            "router-tplink"   => 3,
            "router"          => 4,
            "router-likely"   => 5,
            "unknown-with-ports" => 6,
            _ => 7,
        };
        (gw_rank, kind_rank)
    });
    Ok(out)
}

#[tauri::command]
pub async fn probe_router(ip: String) -> Result<Device, String> {
    let parsed: Ipv4Addr = ip.parse().map_err(|_| format!("bad IP: {}", ip))?;
    let gateway = discover::default_gateway();
    let ports = fingerprint::probe_ports(parsed).await;
    let arp = discover::arp_table();
    let mac = arp.get(&parsed).cloned();
    Ok(enrich(parsed, ports, mac, gateway).await)
}