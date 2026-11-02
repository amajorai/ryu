//! Shared fixtures for the crate's unit tests: device stubs and a loopback HTTP server.

use super::*;

pub(crate) fn dev(ram: Option<u64>, vram: Option<u64>) -> device::DeviceInfo {
    device::DeviceInfo {
        total_ram_bytes: ram,
        ram_human: String::new(),
        vram_bytes: vram,
        vram_human: String::new(),
        gpu_name: None,
        gpu_vendor: None,
        unified_memory: false,
        os: "test".into(),
        disk_free_bytes: None,
        disk_free_human: String::new(),
    }
}

pub(crate) fn with_disk(mut device: device::DeviceInfo, free: u64) -> device::DeviceInfo {
    device.disk_free_bytes = Some(free);
    device.disk_free_human = human_bytes(free);
    device
}

pub(crate) fn tree(
    entries: &[(&str, Option<u64>)],
) -> std::collections::HashMap<String, (Option<u64>, Option<String>)> {
    entries
        .iter()
        .map(|(path, size)| ((*path).to_string(), (*size, None)))
        .collect()
}

/// A reqwest client that ignores any ambient proxy (localhost must be direct).
pub(crate) fn test_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// Spawn a throwaway HTTP/1.1 server on an ephemeral loopback port. `handler`
/// maps a request path to `(status, extra_headers, body)`. Zero dependencies —
/// good enough to exercise the catalog's fetch/parse logic hermetically.
pub(crate) fn spawn_http<F>(handler: F) -> String
where
    F: Fn(&str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + Sync + 'static,
{
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handler = std::sync::Arc::new(handler);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let handler = handler.clone();
            std::thread::spawn(move || {
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            data.extend_from_slice(&buf[..n]);
                            if data.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => return,
                    }
                }
                let req = String::from_utf8_lossy(&data);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                let (status, headers, body) = handler(&path);
                let mut resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (k, v) in headers {
                    resp.push_str(&format!("{k}: {v}\r\n"));
                }
                resp.push_str("\r\n");
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            });
        }
    });
    format!("127.0.0.1:{}", addr.port())
}

/// Install a downloads host (once) so `DownloadCenter` can write under a temp dir.
pub(crate) fn ensure_downloads_host() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        struct DlHost {
            dir: PathBuf,
        }
        impl ryu_downloads::DownloadsHost for DlHost {
            fn ryu_dir(&self) -> PathBuf {
                self.dir.clone()
            }
            fn installed_checksum(&self, _store_key: &str) -> Option<String> {
                None
            }
            fn record_version(&self, _store_key: &str, _version: &str, _checksum: &str) {}
            fn authorize(
                &self,
                _url: &str,
                req: reqwest::RequestBuilder,
            ) -> reqwest::RequestBuilder {
                req
            }
        }
        let dir = std::env::temp_dir().join(format!("ryu-mc-downloads-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        ryu_downloads::set_global_host(std::sync::Arc::new(DlHost { dir }));
    });
}
