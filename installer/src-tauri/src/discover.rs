use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

pub fn local_subnet() -> Option<(Ipv4Addr, u8, Ipv4Addr)> {
    let ip = local_ip_address::local_ip().ok()?;
    let v4 = match ip {
        IpAddr::V4(v) => v,
        IpAddr::V6(_) => return None,
    };
    let o = v4.octets();
    let base = Ipv4Addr::new(o[0], o[1], o[2], 0);
    Some((v4, 24, base))
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
        c.args(["-n", "1", "-w", "600", &ip.to_string()]);
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
                        if mac.len() == 17 {
                            map.insert(ip, mac);
                        }
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
                        if mac.len() == 17 {
                            map.insert(ip, mac);
                        }
                    }
                }
            }
        }
    }

    map
}