use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use local_ip_address::list_afinet_netifas;
use serde_json::json;

#[derive(Clone, serde::Serialize)]
pub struct Device {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub open_ports: Vec<u16>,
    pub kind: String,
    pub is_gateway: bool,
}

pub async fn get_local_info() -> Result<serde_json::Value, String> {
    let interfaces = list_afinet_netifas()
        .map_err(|e| format!("Failed to list interfaces: {}", e))?;

    let mut ips = Vec::new();
    for (name, ip) in interfaces {
        if name != "lo" && name != "docker0" {
            ips.push(format!("{}: {}", name, ip));
        }
    }

    Ok(json!({
        "local_ips": ips,
        "gateway_candidates": vec!["192.168.88.1", "192.168.1.1", "10.0.0.1", "172.16.0.1"]
    }))
}

pub async fn scan_lan() -> Result<Vec<Device>, String> {
    let mut devices = Vec::new();

    // Scan common router subnets
    let subnets = vec!["192.168.88.0/24", "192.168.1.0/24", "10.0.0.0/24"];

    for subnet in subnets {
        let octets: Vec<&str> = subnet.split('/').collect();
        if octets.len() != 2 {
            continue;
        }

        let base_parts: Vec<&str> = octets[0].split('.').collect();
        if base_parts.len() != 4 {
            continue;
        }

        let base = format!("{}.{}.{}.", base_parts[0], base_parts[1], base_parts[2]);

        for i in 1..254 {
            let ip = format!("{}{}",base, i);
            
            // Try ports 22, 8291, 80 (SSH, Winbox, HTTP)
            let ports = vec![22, 8291, 80];
            let mut open_ports = Vec::new();

            for port in ports {
                if check_port(&ip, port).await {
                    open_ports.push(port);
                }
            }

            if !open_ports.is_empty() {
                let kind = classify_device(&open_ports);
                devices.push(Device {
                    ip: ip.clone(),
                    mac: None,
                    vendor: None,
                    open_ports,
                    kind,
                    is_gateway: ip == "192.168.88.1" || ip == "192.168.1.1",
                });
            }
        }
    }

    Ok(devices)
}

async fn check_port(ip: &str, port: u16) -> bool {
    let addr = format!("{}:{}", ip, port);
    match timeout(Duration::from_millis(500), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

fn classify_device(ports: &[u16]) -> String {
    match ports {
        p if p.contains(&22) && p.contains(&8291) => "mikrotik".to_string(),
        p if p.contains(&22) && p.contains(&80) => "router".to_string(),
        p if p.contains(&8291) => "winbox-enabled".to_string(),
        p if p.contains(&22) => "ssh-enabled".to_string(),
        _ => "unknown".to_string(),
    }
}
