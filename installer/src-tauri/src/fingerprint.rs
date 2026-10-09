use std::net::Ipv4Addr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

pub const ROUTER_PORTS: &[u16] = &[21, 22, 23, 53, 80, 161, 443, 8080, 8291, 8443, 8728, 8729];

pub async fn probe_ports(ip: Ipv4Addr) -> Vec<u16> {
    let mut handles = Vec::new();
    for &port in ROUTER_PORTS {
        handles.push(tokio::spawn(async move {
            let ok = timeout(Duration::from_millis(400), TcpStream::connect((ip, port)))
                .await.map(|r| r.is_ok()).unwrap_or(false);
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

// ---- HTTP title probe (raw TCP, no extra deps) ----
pub async fn http_probe_title(ip: Ipv4Addr, port: u16) -> Option<String> {
    let body = match timeout(Duration::from_millis(1500), http_get(ip, port, "/")).await {
        Ok(Ok(b)) => b,
        _ => return None,
    };
    extract_title(&body)
}

async fn http_get(ip: Ipv4Addr, port: u16, path: &str) -> std::io::Result<String> {
    let mut stream = TcpStream::connect((ip, port)).await?;
    let req = format!(
        "GET {} HTTP/1.0\r\nHost: {}\r\nUser-Agent: SAFELinks-Agent/0.1\r\nConnection: close\r\n\r\n",
        path, ip
    );
    stream.write_all(req.as_bytes()).await?;
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 2048];
    for _ in 0..8 {
        match timeout(Duration::from_millis(500), stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= 16384 { break; }
            }
            _ => break,
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn extract_title(body: &str) -> Option<String> {
    let lower = body.to_lowercase();
    let start = lower.find("<title")?;
    let after = &body[start..];
    let open_end = after.find('>')? + 1;
    let rest = &after[open_end..];
    let end = rest.to_lowercase().find("</title")?;
    let title = rest[..end].trim();
    if title.is_empty() { None } else { Some(title.chars().take(200).collect()) }
}

pub fn classify_title(title: &str) -> Option<&'static str> {
    let t = title.to_lowercase();
    if t.contains("routeros") || t.contains("mikrotik") { return Some("MikroTik"); }
    if t.contains("openwrt") || t.contains("luci")     { return Some("OpenWrt"); }
    if t.contains("unifi") || t.contains("airos") || t.contains("airmax") || t.contains("edgeos") || t.contains("edgerouter") { return Some("Ubiquiti"); }
    if t.contains("omada") || t.contains("tp-link") || t.contains("tplink") { return Some("TP-Link"); }
    if t.contains("asus")                              { return Some("ASUS"); }
    if t.contains("netgear") || t.contains("nighthawk"){ return Some("Netgear"); }
    if t.contains("linksys")                           { return Some("Linksys"); }
    if t.contains("tenda")                             { return Some("Tenda"); }
    if t.contains("d-link") || t.contains("dlink")     { return Some("D-Link"); }
    if t.contains("huawei") || t.contains("honor")     { return Some("Huawei"); }
    if t.contains("zte")                               { return Some("ZTE"); }
    if t.contains("cisco") || t.contains("meraki")     { return Some("Cisco"); }
    if t.contains("aruba")                             { return Some("Aruba"); }
    if t.contains("zyxel")                             { return Some("Zyxel"); }
    if t.contains("ruckus")                            { return Some("Ruckus"); }
    if t.contains("engenius")                          { return Some("EnGenius"); }
    if t.contains("fortinet") || t.contains("fortigate") { return Some("Fortinet"); }
    if t.contains("dd-wrt")                            { return Some("DD-WRT"); }
    if t.contains("pfsense") || t.contains("opnsense") { return Some("pfSense"); }
    if t.contains("vyos")                              { return Some("VyOS"); }
    None
}

// ---- OUI table ----
pub fn oui_lookup(mac: &str) -> Option<&'static str> {
    if mac.len() < 8 { return None; }
    let prefix = &mac[..8].to_lowercase();
    match prefix.as_str() {
        // MikroTik
        "64:d1:54"|"dc:2c:6e"|"48:8f:5a"|"6c:3b:6b"|"74:4d:28"|"78:9a:18"|"b8:69:f4"|"c4:ad:34"|"cc:2d:e0"|"d4:ca:6d"|"e4:8d:8c"|"f4:1e:57"|"18:fd:74"|"2c:c8:1b"|"08:55:31"|"44:d9:e7"|"c8:2a:dd" => Some("MikroTik"),
        // TP-Link
        "00:1d:0f"|"14:cc:20"|"50:c7:bf"|"a4:2b:b0"|"b0:4e:26"|"c0:4a:00"|"ec:08:6b"|"f4:f2:6d"|"60:32:b1"|"10:27:f5"|"00:27:19"|"1c:3b:f3"|"30:b5:c2"|"a0:f3:c1"|"b0:48:7a"|"b0:95:75"|"c4:6e:1f"|"e8:de:27"|"f8:8c:21" => Some("TP-Link"),
        // Ubiquiti
        "00:15:6d"|"04:18:d6"|"24:a4:3c"|"68:d7:9a"|"74:83:c2"|"78:8a:20"|"80:2a:a8"|"dc:9f:db"|"f0:9f:c2"|"78:45:58"|"b4:fb:e4"|"e0:63:da"|"fc:ec:da" => Some("Ubiquiti"),
        // ASUS
        "00:1f:c6"|"2c:56:dc"|"38:d5:47"|"50:46:5d"|"ac:9e:17"|"b0:6e:bf"|"d8:50:e6"|"f8:32:e4"|"04:d4:c4"|"08:60:6e"|"1c:87:2c"|"2c:fd:a1"|"38:2c:4a"|"40:16:7e"|"48:5b:39"|"4c:ed:fb"|"54:04:a6"|"60:45:cb"|"70:4d:7b"|"74:d0:2b"|"78:24:af"|"88:d7:f6"|"9c:5c:8e"|"a8:5e:45"|"bc:ae:c5"|"c8:60:00"|"d0:17:c2"|"e0:3f:49"|"e0:d5:5e"|"f4:6d:04"|"fc:aa:14" => Some("ASUS"),
        // Netgear
        "20:e5:2a"|"a0:40:a0"|"9c:3d:cf"|"28:c6:8e"|"3c:37:86"|"44:94:fc"|"4c:60:de"|"6c:b0:ce"|"74:44:01"|"78:d2:94"|"80:37:73"|"84:1b:5e"|"9c:c9:eb"|"a0:04:60"|"b0:39:56"|"b0:7f:b9"|"c0:3f:0e"|"c4:3d:c7"|"c4:04:15"|"c8:d7:19"|"cc:40:d0"|"d8:9e:f3"|"dc:ef:09"|"e0:46:9a"|"e4:f4:c6"|"e8:fc:af"|"f8:73:94" => Some("Netgear"),
        // D-Link
        "1c:7e:e5"|"cc:b2:55"|"f0:7d:68"|"00:1b:11"|"00:1c:f0"|"00:1e:58"|"00:22:b0"|"00:24:01"|"00:26:5a"|"00:50:ba"|"04:8d:38"|"08:5b:0e"|"0c:0e:76"|"10:62:eb"|"14:d6:4d"|"18:e8:29"|"1c:bd:b9"|"1c:df:0f"|"28:10:7b"|"2c:b0:5d"|"30:8a:04"|"34:08:04"|"3c:1e:04"|"40:9b:cd"|"5c:d9:98"|"74:da:38"|"78:54:2e"|"80:26:89"|"84:c9:b2"|"90:94:e4"|"9c:d6:43"|"a0:ab:1b"|"ac:f1:df"|"b8:a3:86"|"bc:22:28"|"c4:12:f5"|"c8:be:19"|"c8:d3:a3"|"d8:fe:e3"|"dc:d3:21"|"e0:1c:fc"|"e4:6f:13"|"ec:22:80"|"f0:b4:79"|"f4:8c:eb"|"fc:75:16" => Some("D-Link"),
        // Tenda
        "c8:3a:35"|"d8:32:14"|"00:b0:0c"|"04:95:e6"|"08:10:78"|"0c:82:68"|"10:13:31"|"14:3b:42"|"18:a6:f7"|"1c:1d:67"|"20:76:93"|"24:69:68"|"28:87:ba"|"2c:16:bd"|"30:0a:c5"|"34:96:72"|"38:83:45"|"3c:46:d8"|"40:16:9f"|"44:32:c8"|"48:7b:6b"|"4c:9e:ff"|"50:2b:73"|"54:6c:eb"|"58:d9:d5"|"5c:50:15"|"60:a4:b7"|"64:6e:97"|"68:3e:26"|"6c:72:20"|"70:3a:cb"|"78:44:76"|"7c:8b:ca"|"80:6f:b0"|"84:16:f9"|"88:70:8c"|"8c:88:2b"|"90:2b:34"|"94:0c:6d"|"98:63:cf"|"9c:37:f4"|"a0:39:f7"|"a4:2b:8c"|"a8:57:4e"|"ac:64:62"|"b4:0e:dc"|"b8:3a:5a"|"bc:46:99"|"c4:e9:84"|"cc:2d:1b"|"d0:76:e7"|"d4:6e:5c"|"e0:ca:4d"|"e4:6a:35"|"e8:4e:06"|"ec:88:8f"|"f4:ec:38"|"f8:1a:67"|"fc:d7:33" => Some("Tenda"),
        // Huawei
        "00:e0:fc"|"28:6e:d4"|"48:8e:ef"|"00:18:82"|"00:25:9e"|"00:34:fe"|"00:46:4b"|"00:66:4b"|"00:9a:cd"|"00:bd:3e"|"00:cd:3e"|"04:25:c5"|"04:33:89"|"04:bd:70"|"04:c0:6f"|"04:f9:38"|"04:fe:8d"|"08:19:a6"|"08:63:61"|"08:7a:4c"|"0c:37:dc"|"0c:45:ba"|"0c:96:bf"|"0c:d6:bd"|"10:1b:54"|"10:47:80"|"10:c6:1f"|"14:30:04"|"14:b9:68"|"18:c5:8a"|"1c:15:1f"|"1c:20:db"|"20:0b:c7"|"20:2b:c1"|"20:f3:a3"|"24:09:95"|"24:69:a5"|"24:db:ac"|"28:31:52"|"28:3c:e4"|"28:5f:db"|"2c:55:d3"|"2c:ab:00"|"30:87:30"|"30:d1:7e"|"34:00:a3"|"34:6b:d4"|"34:a2:a2"|"34:cd:be"|"38:4c:4f"|"38:f8:89"|"3c:df:bd"|"3c:fa:43"|"40:4d:8e"|"40:cb:a8"|"44:6a:2e"|"44:c3:46"|"48:00:31"|"48:3c:0c"|"48:43:5a"|"48:62:76"|"4c:1f:cc"|"4c:54:99"|"4c:8b:ef"|"4c:b1:6c"|"50:01:d9"|"50:9f:27"|"50:a7:2b"|"54:25:ea"|"54:39:df"|"54:89:98"|"54:a5:1b"|"58:1f:28"|"58:2a:f5"|"5c:4c:a9"|"5c:7d:5e"|"5c:a8:6a"|"60:de:44"|"60:e7:01"|"64:3e:8c"|"64:a6:51"|"68:a0:f6"|"6c:92:bf"|"70:54:f5"|"70:72:3c"|"70:7b:e8"|"70:a8:e3"|"74:88:2a"|"78:1d:ba"|"78:d7:52"|"7c:11:cb"|"7c:60:97"|"7c:a1:77"|"80:71:1f"|"80:b6:86"|"80:fb:06"|"84:5b:12"|"84:a8:e6"|"88:28:b3"|"88:3f:d3"|"88:53:d4"|"88:e3:ab"|"8c:0d:76"|"8c:34:fd"|"8c:e5:ef"|"90:17:ac"|"90:4e:2b"|"90:67:1c"|"94:04:9c"|"94:0e:6b"|"94:77:2b"|"98:e7:f5"|"9c:28:ef"|"9c:74:1a"|"9c:b2:b2"|"a0:8c:f8"|"a4:71:74"|"a4:99:47"|"a4:c6:4f"|"a8:c8:3a"|"ac:4e:91"|"ac:85:3d"|"ac:e2:15"|"b0:5b:67"|"b0:89:91"|"b0:e5:ed"|"b4:15:13"|"b4:cd:27"|"b8:08:d7"|"b8:bc:1b"|"bc:25:e0"|"bc:76:70"|"c0:70:09"|"c4:05:28"|"c4:47:3f"|"c8:94:d2"|"c8:d1:5e"|"cc:53:b5"|"cc:a2:23"|"d0:2d:b3"|"d0:3c:1f"|"d0:7a:b5"|"d4:6a:a8"|"d4:6b:a6"|"d4:b1:10"|"d8:49:0b"|"d8:c7:71"|"dc:d2:fc"|"e0:24:7f"|"e0:97:96"|"e4:a7:c5"|"e8:08:8b"|"e8:cd:2d"|"ec:23:3d"|"ec:38:8f"|"ec:cb:30"|"f0:43:47"|"f0:98:38"|"f4:55:9c"|"f4:8e:92"|"f4:c7:14"|"f8:01:13"|"f8:3d:ff"|"f8:4a:bf"|"f8:e8:11"|"fc:48:ef"|"fc:e3:3c" => Some("Huawei"),
        // ZTE
        "00:15:eb"|"34:e0:cf"|"00:19:c6"|"00:1e:73"|"00:22:93"|"00:25:12"|"00:26:ed"|"00:36:76"|"04:5c:df"|"04:c2:3e"|"08:18:1a"|"08:3e:5d"|"08:57:00"|"08:95:2a"|"08:f6:f8"|"0c:12:62"|"0c:37:96"|"10:00:fd"|"10:39:e9"|"10:5f:49"|"14:4d:67"|"14:5f:94"|"14:83:8e"|"18:33:9d"|"18:66:da"|"18:c3:f4"|"18:d2:76"|"1c:1d:86"|"1c:23:2c"|"1c:2c:78"|"1c:57:dc"|"1c:6a:7a"|"1c:9e:cb"|"1c:b0:44"|"20:0c:c8"|"20:10:7a"|"20:15:de"|"20:28:3e"|"20:4e:7f"|"20:62:74"|"20:6b:e7"|"20:89:84"|"20:9b:a5"|"20:b0:01"|"20:d0:4f"|"20:f1:9c"|"24:2d:6c"|"24:4b:03"|"24:4c:07"|"24:9e:ab"|"24:a4:87"|"24:be:05"|"24:c4:4a"|"24:da:9b"|"24:db:ed" => Some("ZTE"),
        // Linksys / Belkin
        "00:13:10"|"00:14:bf"|"00:18:39"|"00:1a:70"|"00:1c:10"|"00:1d:7e"|"00:1e:e5"|"00:21:29"|"00:22:6b"|"00:23:69"|"00:25:9c"|"14:91:82"|"20:aa:4b"|"24:f5:a2"|"30:23:03"|"48:f8:b3"|"58:6d:8f"|"60:38:e0"|"68:7f:74"|"94:10:3e"|"c0:56:27"|"c4:41:1e"|"d8:5d:4c"|"ec:1a:59" => Some("Linksys"),
        // Zyxel
        "00:13:49"|"00:19:cb"|"00:23:f8"|"00:a0:c5"|"00:aa:aa"|"28:28:5d"|"40:4a:03"|"5c:f4:ab"|"78:9f:70"|"90:ef:68"|"b0:b2:dc"|"bc:99:11"|"c8:6c:87"|"d8:ec:5e"|"e8:37:7a"|"f8:44:77" => Some("Zyxel"),
        // Cisco / Meraki
        "00:00:0c"|"00:04:9a"|"00:0a:41"|"00:0b:5f"|"00:0c:30"|"00:0d:28"|"00:0e:38"|"00:0f:23"|"00:10:07"|"00:11:20"|"00:12:01"|"00:13:19"|"00:14:1b"|"00:15:2b"|"00:16:47"|"00:17:0e"|"00:18:18"|"00:19:06"|"00:1a:a1"|"00:1b:0c"|"00:1c:0e"|"00:1d:45"|"00:1e:13"|"00:1f:26"|"00:21:a0"|"00:22:55"|"00:23:04"|"00:24:13"|"00:24:97"|"00:25:45"|"00:26:0a"|"00:26:51"|"00:26:cb"|"00:27:0d"|"00:27:22"|"00:28:5a"|"00:2a:6a"|"00:4c:c6"|"00:62:ec"|"00:6b:f1"|"00:9e:1e"|"00:b0:64"|"00:c8:8b"|"00:d0:ba"|"00:d0:bc"|"00:e0:14"|"00:e0:a3"|"00:e0:f7"|"00:e0:fe" => Some("Cisco"),
        // Aruba / HP
        "00:0b:86"|"00:1a:1e"|"00:24:6c"|"04:bd:88"|"18:64:72"|"20:4c:03"|"24:de:c6"|"40:e3:d6"|"6c:f3:7f"|"84:d4:7e"|"94:b4:0f"|"b4:5d:50"|"d8:c7:c8"|"f8:60:5a" => Some("Aruba"),
        // Fortinet
        "00:09:0f"|"04:d5:90"|"0c:9a:42"|"70:4c:a5"|"90:6c:ac"|"e0:23:ff" => Some("Fortinet"),
        // OpenWrt (dev default)
        "02:00:00"|"02:c0:00" => Some("OpenWrt"),
        _ => None,
    }
}

pub fn classify(vendor: Option<&str>, ports: &[u16]) -> &'static str {
    let has_mikrotik_sig = ports.contains(&8291) || ports.contains(&8728) || ports.contains(&8729);
    let has_router_ports = ports.contains(&22) || ports.contains(&80) || ports.contains(&443) || ports.contains(&23);
    match (vendor, has_mikrotik_sig, has_router_ports) {
        (Some("MikroTik"), _, _) => "router-mikrotik",
        (Some("OpenWrt"),  _, _) => "router-openwrt",
        (Some("Ubiquiti"), _, _) => "router-ubiquiti",
        (Some("TP-Link"),  _, _) => "router-tplink",
        (Some(_), _, true)       => "router",
        (Some(_), _, false)      => "device",
        (None, true, _)          => "router-mikrotik",
        (None, _, true) if ports.len() >= 3 => "router-likely",
        (None, _, true) => "unknown-with-ports",
        _ => "device",
    }
}