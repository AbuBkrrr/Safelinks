use std::net::Ipv4Addr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

pub const ROUTER_PORTS: &[u16] = &[
    22, 23, 53, 80, 443, 8291, 8728, 8080,
];

pub async fn probe_ports(ip: Ipv4Addr) -> Vec<u16> {
    let mut handles = Vec::new();
    for &port in ROUTER_PORTS {
        handles.push(tokio::spawn(async move {
            let ok = timeout(Duration::from_millis(400), TcpStream::connect((ip, port)))
                .await
                .map(|r| r.is_ok())
                .unwrap_or(false);
            if ok { Some(port) } else { None }
        }));
    }
    let mut open = Vec::new();
    for h in handles {
        if let Ok(Some(p)) = h.await { open.push(p); }
    }
    open.sort();
    open
}

pub fn oui_lookup(mac: &str) -> Option<&'static str> {
    if mac.len() < 8 { return None; }
    let prefix = &mac[..8].to_lowercase();
    match prefix.as_str() {
        "64:d1:54" | "dc:2c:6e" | "48:8f:5a" | "6c:3b:6b" | "74:4d:28"
        | "78:9a:18" | "b8:69:f4" | "c4:ad:34" | "cc:2d:e0" | "d4:ca:6d"
        | "e4:8d:8c" | "f4:1e:57" | "18:fd:74" | "2c:c8:1b" | "08:55:31" => Some("MikroTik"),
        "00:1d:0f" | "14:cc:20" | "50:c7:bf" | "a4:2b:b0" | "b0:4e:26"
        | "c0:4a:00" | "ec:08:6b" | "f4:f2:6d" | "60:32:b1" | "10:27:f5" => Some("TP-Link"),
        "00:15:6d" | "04:18:d6" | "24:a4:3c" | "44:d9:e7" | "68:d7:9a"
        | "74:83:c2" | "78:8a:20" | "80:2a:a8" | "dc:9f:db" | "f0:9f:c2" => Some("Ubiquiti"),
        "02:00:00" => Some("OpenWrt"),
        "20:e5:2a" | "a0:40:a0" | "9c:3d:cf" => Some("Netgear"),
        "1c:7e:e5" | "cc:b2:55" | "f0:7d:68" => Some("D-Link"),
        "c8:3a:35" | "d8:32:14" => Some("Tenda"),
        "00:e0:fc" | "28:6e:d4" | "48:8e:ef" => Some("Huawei"),
        "00:15:eb" | "34:e0:cf" => Some("ZTE"),
        _ => None,
    }
}

pub fn classify(vendor: Option<&str>, ports: &[u16]) -> &'static str {
    let has_mikrotik_sig = ports.contains(&8291) || ports.contains(&8728);
    let has_router_ports = ports.contains(&22) || ports.contains(&80) || ports.contains(&443);
    match (vendor, has_mikrotik_sig, has_router_ports) {
        (Some("MikroTik"), _, _) => "router-mikrotik",
        (Some(_), _, true) => "router",
        (Some(_), _, false) => "device",
        (None, true, _) => "router-mikrotik",
        (None, _, true) if ports.len() >= 3 => "router-likely",
        (None, _, true) => "unknown-with-ports",
        _ => "device",
    }
}