use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Spawn a process WITHOUT flashing a console window on Windows.
fn hidden_command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

pub fn local_subnets() -> Vec<(Ipv4Addr, u8, Ipv4Addr)> {
    let mut out: Vec<(Ipv4Addr, u8, Ipv4Addr)> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    if let Ok(ifaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in ifaces {
            if let IpAddr::V4(v4) = ip {
                if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() { continue; }
                let o = v4.octets();
                let base = Ipv4Addr::new(o[0], o[1], o[2], 0);
                if seen.insert(u32::from(base)) { out.push((v4, 24, base)); }
            }
        }
    }
    if out.is_empty() {
        if let Ok(ip) = local_ip_address::local_ip() {
            if let IpAddr::V4(v4) = ip {
                let o = v4.octets();
                out.push((v4, 24, Ipv4Addr::new(o[0], o[1], o[2], 0)));
            }
        }
    }
    out
}

pub fn local_subnet() -> Option<(Ipv4Addr, u8, Ipv4Addr)> {
    local_subnets().into_iter().next()
}

pub fn default_gateway() -> Option<Ipv4Addr> {
    #[cfg(windows)]
    {
        if let Ok(o) = hidden_command("route").args(["print", "-4"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 && parts[0] == "0.0.0.0" && parts[1] == "0.0.0.0" {
                    if let Ok(gw) = parts[2].parse::<Ipv4Addr>() {
                        if !gw.is_unspecified() { return Some(gw); }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(o) = hidden_command("ip").args(["route", "show", "default"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[0] == "default" && parts[1] == "via" {
                    if let Ok(gw) = parts[2].parse::<Ipv4Addr>() { return Some(gw); }
                }
            }
        }
    }
    None
}

pub fn routed_subnets() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    #[cfg(windows)]
    {
        if let Ok(o) = hidden_command("route").args(["print", "-4"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    if let (Ok(dest), Ok(mask)) = (parts[0].parse::<Ipv4Addr>(), parts[1].parse::<Ipv4Addr>()) {
                        if u32::from(mask) == 0xFFFFFF00 {
                            let d = u32::from(dest);
                            if seen.insert(d) { out.push(dest); }
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(o) = hidden_command("ip").args(["route", "show"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                if let Some(first) = line.split_whitespace().next() {
                    if let Some((ip_str, cidr)) = first.split_once('/') {
                        if cidr == "24" {
                            if let Ok(ip) = ip_str.parse::<Ipv4Addr>() {
                                let o2 = ip.octets();
                                let base = Ipv4Addr::new(o2[0], o2[1], o2[2], 0);
                                let d = u32::from(base);
                                if seen.insert(d) { out.push(base); }
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Liveness probe: try TCP-connect to any of a handful of common router ports.
/// Returns true as soon as one connection succeeds.
pub async fn tcp_alive(ip: Ipv4Addr) -> bool {
    const PORTS: &[u16] = &[80, 443, 22, 8080, 53, 7547, 8291, 8728, 21, 23];
    for &port in PORTS {
        let addr = SocketAddr::new(IpAddr::V4(ip), port);
        if let Ok(Ok(_)) = timeout(Duration::from_millis(250), TcpStream::connect(addr)).await {
            return true;
        }
    }
    false
}

/// Sweep a /24 by TCP-probing common ports. Concurrency capped.
pub async fn tcp_sweep(base: Ipv4Addr, concurrency: usize) -> Vec<Ipv4Addr> {
    let o = base.octets();
    let sem = Arc::new(Semaphore::new(concurrency));
    let mut handles = Vec::with_capacity(254);
    for host in 1u8..=254 {
        let ip = Ipv4Addr::new(o[0], o[1], o[2], host);
        let sem_clone = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = match sem_clone.acquire_owned().await { Ok(p) => p, Err(_) => return None };
            if tcp_alive(ip).await { Some(ip) } else { None }
        }));
    }
    let mut live = Vec::new();
    for h in handles {
        if let Ok(Some(ip)) = h.await { live.push(ip); }
    }
    live
}

pub fn arp_table() -> HashMap<Ipv4Addr, String> {
    let mut map = HashMap::new();
    #[cfg(windows)]
    {
        if let Ok(o) = hidden_command("arp").arg("-a").output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(ip) = parts[0].parse::<Ipv4Addr>() {
                        let mac = parts[1].replace('-', ":").to_lowercase();
                        if mac.len() == 17 { map.insert(ip, mac); }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(o) = hidden_command("ip").args(["neigh", "show"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 && parts[3] == "lladdr" {
                    if let Ok(ip) = parts[0].parse::<Ipv4Addr>() {
                        let mac = parts[4].to_lowercase();
                        if mac.len() == 17 { map.insert(ip, mac); }
                    }
                }
            }
        }
    }
    map
}