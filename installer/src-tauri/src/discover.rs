use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

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

/// Returns the default gateway IP (the immediate router the PC is talking to).
pub fn default_gateway() -> Option<Ipv4Addr> {
    #[cfg(windows)]
    {
        // route print -4 shows lines like:
        //  0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.107     25
        if let Ok(o) = Command::new("route").arg("print").arg("-4").output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    if parts[0] == "0.0.0.0" && parts[1] == "0.0.0.0" {
                        if let Ok(gw) = parts[2].parse::<Ipv4Addr>() {
                            if !gw.is_unspecified() { return Some(gw); }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(o) = Command::new("ip").args(["route", "show", "default"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                // "default via 192.168.1.1 dev eth0 ..."
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[0] == "default" && parts[1] == "via" {
                    if let Ok(gw) = parts[2].parse::<Ipv4Addr>() { return Some(gw); }
                }
            }
        }
    }
    None
}

pub fn default_router_subnets() -> Vec<Ipv4Addr> {
    vec![
        Ipv4Addr::new(192, 168, 88, 0),
        Ipv4Addr::new(192, 168, 1, 0),
        Ipv4Addr::new(192, 168, 0, 0),
        Ipv4Addr::new(192, 168, 2, 0),
        Ipv4Addr::new(192, 168, 8, 0),
        Ipv4Addr::new(192, 168, 10, 0),
        Ipv4Addr::new(10, 0, 0, 0),
        Ipv4Addr::new(10, 0, 1, 0),
        Ipv4Addr::new(10, 1, 0, 0),
        Ipv4Addr::new(172, 16, 0, 0),
    ]
}

pub fn routed_subnets() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    #[cfg(windows)]
    {
        if let Ok(o) = Command::new("route").arg("print").arg("-4").output() {
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
        if let Ok(o) = Command::new("ip").args(["route", "show"]).output() {
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

pub async fn ping_sweep(base: Ipv4Addr, prefix: u8) -> Vec<Ipv4Addr> {
    if prefix != 24 { return Vec::new(); }
    let o = base.octets();
    let mut handles = Vec::with_capacity(254);
    for host in 1u8..=254 {
        let ip = Ipv4Addr::new(o[0], o[1], o[2], host);
        handles.push(tokio::spawn(async move {
            if ping_once(ip).await { Some(ip) } else { None }
        }));
    }
    let mut live = Vec::new();
    for h in handles {
        if let Ok(Some(ip)) = h.await { live.push(ip); }
    }
    live
}

async fn ping_once(ip: Ipv4Addr) -> bool {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = TokioCommand::new("ping");
        c.args(["-n", "1", "-w", "500", &ip.to_string()]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = TokioCommand::new("ping");
        c.args(["-c", "1", "-W", "1", &ip.to_string()]);
        c
    };
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match timeout(Duration::from_secs(2), cmd.status()).await {
        Ok(Ok(s)) => s.success(),
        _ => false,
    }
}

pub fn arp_table() -> HashMap<Ipv4Addr, String> {
    let mut map = HashMap::new();
    #[cfg(windows)]
    {
        if let Ok(o) = Command::new("arp").arg("-a").output() {
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
        if let Ok(o) = Command::new("ip").args(["neigh", "show"]).output() {
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