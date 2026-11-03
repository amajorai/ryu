//! Unit tests for the guarded-egress primitive (moved out of `lib.rs`).

use super::{is_blocked_hostname, is_blocked_ip, screen_url, GuardedFetchPolicy};

#[test]
fn blocks_internal_address_ranges() {
    for value in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "198.18.0.1",
        "224.0.0.1",
        "::1",
        "fd00::1",
        "::ffff:169.254.169.254",
        "::ffff:0:169.254.169.254",
        "64:ff9b::169.254.169.254",
        "::169.254.169.254",
    ] {
        assert!(is_blocked_ip(value.parse().expect("valid IP")), "{value}");
    }
}

#[test]
fn allows_public_addresses() {
    for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(!is_blocked_ip(value.parse().expect("valid IP")), "{value}");
    }
}

#[test]
fn blocks_ipv6_multicast_and_site_local_but_allows_neighboring_public_ranges() {
    for value in ["ff00::1", "ff02::1", "fec0::1", "feff::1"] {
        assert!(
            is_blocked_ip(value.parse().expect("valid IPv6 address")),
            "{value}"
        );
    }
    for value in ["2001:4860:4860::8888", "2606:4700:4700::1111"] {
        assert!(
            !is_blocked_ip(value.parse().expect("valid public IPv6 address")),
            "{value} must remain allowed"
        );
    }
}

#[test]
fn blocks_internal_hostnames_before_dns() {
    for value in ["localhost", "service.local", "db.internal", "metadata.goog"] {
        assert!(is_blocked_hostname(value), "{value}");
    }
    assert!(!is_blocked_hostname("cdn.example.com"));
}

#[tokio::test]
async fn rejects_non_http_and_internal_targets() {
    assert!(screen_url("file:///etc/passwd").await.is_err());
    assert!(screen_url("http://localhost:7980/api").await.is_err());
    assert!(screen_url("http://127.0.0.1:7980/api").await.is_err());
}

/// Serializes tests that rewrite the process-wide proxy variables.
static PROXY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Points the proxy variables at `proxy` (clearing `NO_PROXY`) while held,
/// and restores every variable to its previous value on drop, so the rest
/// of the test binary never sees the fixture proxy.
struct ProxyEnvGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl ProxyEnvGuard {
    const CLEARED: [&'static str; 2] = ["NO_PROXY", "no_proxy"];
    const PROXIED: [&'static str; 4] = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

    fn set(proxy: &str) -> Self {
        let lock = PROXY_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved = Self::CLEARED
            .iter()
            .chain(Self::PROXIED.iter())
            .map(|name| (*name, std::env::var_os(name)))
            .collect();
        for name in Self::CLEARED {
            std::env::remove_var(name);
        }
        for name in Self::PROXIED {
            std::env::set_var(name, proxy);
        }
        Self { saved, _lock: lock }
    }
}

impl Drop for ProxyEnvGuard {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// The direct variant must never hand a pinned request to an env proxy.
/// The non-direct call is the positive control proving the env proxy is live.
#[tokio::test]
async fn direct_requests_ignore_environment_proxies() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = connections.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            seen.fetch_add(1, Ordering::SeqCst);
            drop(socket);
        }
    });
    let _env = ProxyEnvGuard::set(&proxy);
    let request = || super::GuardedRequest {
        method: "GET".to_owned(),
        // A public IP literal needs no DNS and passes the address screen.
        url: "https://1.1.1.1/".to_owned(),
        headers: vec![("cookie".to_owned(), "session=fixture".to_owned())],
        body: None,
    };
    let policy = GuardedFetchPolicy {
        allow_http: false,
        max_redirect_hops: 0,
        timeout: std::time::Duration::from_secs(2),
        ..GuardedFetchPolicy::default()
    };
    let _ = super::guarded_request(request(), policy).await;
    assert!(
        connections.load(Ordering::SeqCst) > 0,
        "control: the env proxy should receive the non-direct request"
    );
    let before = connections.load(Ordering::SeqCst);
    let _ = super::guarded_request_direct(request(), policy).await;
    assert_eq!(connections.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn https_only_policy_rejects_plain_http() {
    let policy = GuardedFetchPolicy {
        allow_http: false,
        ..GuardedFetchPolicy::default()
    };
    assert!(super::screen_url_with_policy("http://example.com", policy)
        .await
        .is_err());
}
