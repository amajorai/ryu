//! Shared SSRF-guarded outbound HTTP for Ryu app satellites.
//!
//! A caller supplies a public URL; this primitive owns scheme screening, hostname
//! canonicalization, DNS resolution, private-address rejection, IP pinning,
//! redirect re-screening, timeout, and response-size limits. Domain apps keep only
//! their extraction/authorization logic.

use std::net::SocketAddr;
use std::time::Duration;

const DEFAULT_MAX_REDIRECT_HOPS: usize = 5;
const DEFAULT_MAX_BODY_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
pub struct GuardedFetchPolicy {
    pub allow_http: bool,
    pub max_body_bytes: u64,
    pub max_redirect_hops: usize,
    pub timeout: Duration,
}

impl Default for GuardedFetchPolicy {
    fn default() -> Self {
        Self {
            allow_http: true,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_redirect_hops: DEFAULT_MAX_REDIRECT_HOPS,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

/// The DNS result that a guarded caller is allowed to connect to for one URL.
///
/// Keeping the resolved addresses beside the canonical host lets streaming
/// consumers build their own request body/response pipeline without repeating
/// the screening logic or re-resolving the hostname at connect time.
#[derive(Debug, Clone)]
pub struct GuardedTarget {
    pub host: String,
    pub addresses: Vec<SocketAddr>,
}

fn is_blocked_ipv4(v4: std::net::Ipv4Addr) -> bool {
    let [a, b, _, _] = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || a == 0
        || a >= 224
        || (a == 192 && (b == 0 || b == 168))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 100 && (b & 0xc0) == 0x40)
}

fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let words = v6.segments();
    let zeroes = |start: usize, end: usize| words[start..end].iter().all(|word| *word == 0);
    let mapped = zeroes(0, 5) && words[5] == 0xffff;
    let translated = zeroes(0, 4) && words[4] == 0xffff && words[5] == 0;
    let nat64 = words[0] == 0x0064 && words[1] == 0xff9b && zeroes(2, 6);
    let compatible = zeroes(0, 6);
    if !(mapped || translated || nat64 || compatible) {
        return None;
    }
    let high = words[6];
    let low = words[7];
    Some(std::net::Ipv4Addr::new(
        (high >> 8) as u8,
        high as u8,
        (low >> 8) as u8,
        low as u8,
    ))
}

pub fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_blocked_ipv4(v4),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            if let Some(embedded) = embedded_ipv4(v6) {
                return is_blocked_ipv4(embedded);
            }
            let words = v6.segments();
            if words[0] == 0x2001 && words[1] == 0x0db8 {
                return true;
            }
            let first = words[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || (first & 0xffc0) == 0xfec0
        }
    }
}

const BLOCKED_METADATA_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];

/// Return whether a hostname is an explicitly internal/local name before DNS.
/// Resolution screening still runs for every other hostname.
#[must_use]
pub fn is_blocked_hostname(host: &str) -> bool {
    let bare = host.strip_suffix('.').unwrap_or(host);
    let lower = bare.to_ascii_lowercase();
    lower == "metadata"
        || lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || BLOCKED_METADATA_HOSTS
            .iter()
            .any(|deny| lower == *deny || lower.ends_with(&format!(".{deny}")))
}

fn screen_guarded_hostname(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("host is empty".to_owned());
    }
    if host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("host contains control or whitespace characters".to_owned());
    }
    if !host.is_ascii() {
        return Err("non-ASCII host is not allowed".to_owned());
    }
    let bare = host.strip_suffix('.').unwrap_or(host);
    let lower = bare.to_ascii_lowercase();
    if is_blocked_hostname(&lower) {
        return Err("internal host is not allowed".to_owned());
    }
    let unbracketed = lower.trim_start_matches('[').trim_end_matches(']');
    if unbracketed.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    match url::Host::parse(bare) {
        Ok(parsed) if parsed.to_string().eq_ignore_ascii_case(bare) => Ok(()),
        Ok(_) => Err("host failed IDNA round-trip".to_owned()),
        Err(error) => Err(format!("invalid host: {error}")),
    }
}

async fn resolve_guarded_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    screen_guarded_hostname(host)?;
    let resolve_host = host.to_owned();
    let resolved: Vec<SocketAddr> = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect())
    })
    .await
    .map_err(|error| format!("DNS resolution task failed: {error}"))?
    .map_err(|error| format!("failed to resolve host: {error}"))?;
    if resolved.is_empty() {
        return Err("host did not resolve".to_owned());
    }
    if resolved.iter().any(|address| is_blocked_ip(address.ip())) {
        return Err("private/loopback host is not allowed".to_owned());
    }
    Ok(resolved)
}

async fn guarded_parts(
    parsed: &url::Url,
    policy: GuardedFetchPolicy,
) -> Result<GuardedTarget, String> {
    if parsed.scheme() != "https" && !(policy.allow_http && parsed.scheme() == "http") {
        return Err(format!(
            "guarded URL must use http or https (got '{}')",
            parsed.scheme()
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "url has no host".to_owned())?
        .to_owned();
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if parsed.scheme() == "http" { 80 } else { 443 });
    let resolved = resolve_guarded_host(&host, port).await?;
    Ok(GuardedTarget {
        host,
        addresses: resolved,
    })
}

/// Parse, screen, resolve, and return the exact addresses approved for one
/// outbound URL. The caller must pass the returned target to its HTTP client's
/// `resolve_to_addrs` configuration; calling this function and then using a
/// fresh hostname-based client would reintroduce the DNS-rebinding gap.
pub async fn resolve_guarded_url(
    url: &str,
    policy: GuardedFetchPolicy,
) -> Result<GuardedTarget, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|error| format!("invalid url: {error}"))?;
    guarded_parts(&parsed, policy).await
}

pub async fn screen_url_with_policy(url: &str, policy: GuardedFetchPolicy) -> Result<(), String> {
    resolve_guarded_url(url, policy).await.map(|_| ())
}

pub async fn screen_url(url: &str) -> Result<(), String> {
    screen_url_with_policy(url, GuardedFetchPolicy::default()).await
}

/// A one-hop request for callers that need to keep protocol-specific redirect or
/// authorization policy in their own domain layer. The URL is still screened and
/// DNS-pinned by this crate; callers receive the redirect response rather than
/// getting an unguarded client.
#[derive(Debug, Clone)]
pub struct GuardedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct GuardedResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Execute one DNS-pinned request with no automatic redirects. This is the shared
/// host seam for app protocols that need to apply their own origin/redirect rules;
/// an app must not reimplement hostname screening or private-address rejection.
///
/// This client still honours `HTTP(S)_PROXY`/`ALL_PROXY`; when one is set the
/// proxy resolves the hostname itself, so the screened addresses are not the
/// ones connected to. Credential-bearing callers should use
/// [`guarded_request_direct`].
pub async fn guarded_request(
    request: GuardedRequest,
    policy: GuardedFetchPolicy,
) -> Result<GuardedResponse, String> {
    send_guarded_request(request, policy, false).await
}

/// [`guarded_request`] without environment or system proxies: the connection
/// goes only to the screened, pinned addresses. Use it wherever the request
/// carries credentials, so a configured egress proxy cannot re-resolve the host
/// into a network the private-address screen was meant to exclude.
pub async fn guarded_request_direct(
    request: GuardedRequest,
    policy: GuardedFetchPolicy,
) -> Result<GuardedResponse, String> {
    send_guarded_request(request, policy, true).await
}

async fn send_guarded_request(
    request: GuardedRequest,
    policy: GuardedFetchPolicy,
    direct: bool,
) -> Result<GuardedResponse, String> {
    let parsed =
        url::Url::parse(request.url.trim()).map_err(|error| format!("invalid url: {error}"))?;
    let target = guarded_parts(&parsed, policy).await?;
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() as u64 > policy.max_body_bytes)
    {
        return Err(format!(
            "request body exceeds {} bytes",
            policy.max_body_bytes
        ));
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|error| format!("invalid HTTP method: {error}"))?;
    let mut client = reqwest::Client::builder()
        .timeout(policy.timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&target.host, &target.addresses);
    if direct {
        client = client.no_proxy();
    }
    let client = client
        .build()
        .map_err(|error| format!("failed to build guarded HTTP client: {error}"))?;
    let mut builder = client.request(method, parsed.as_str());
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|error| format!("guarded request failed: {}", error.without_url()))?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("reading guarded response body: {}", error.without_url()))?
    {
        if body.len() as u64 + chunk.len() as u64 > policy.max_body_bytes {
            return Err(format!(
                "response body exceeds {} bytes",
                policy.max_body_bytes
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    Ok(GuardedResponse {
        status: response.status().as_u16(),
        headers,
        body,
    })
}

async fn guarded_get_once(
    parsed: &url::Url,
    policy: GuardedFetchPolicy,
) -> Result<reqwest::Response, String> {
    let target = guarded_parts(parsed, policy).await?;
    let client = reqwest::Client::builder()
        .timeout(policy.timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&target.host, &target.addresses)
        .build()
        .map_err(|error| format!("failed to build guarded HTTP client: {error}"))?;
    client
        .get(parsed.as_str())
        .send()
        .await
        .map_err(|error| format!("guarded request failed: {}", error.without_url()))
}

pub async fn guarded_fetch_text_with_policy(
    url: &str,
    policy: GuardedFetchPolicy,
) -> Result<(u16, String), String> {
    let mut current =
        url::Url::parse(url.trim()).map_err(|error| format!("invalid url: {error}"))?;
    for _ in 0..=policy.max_redirect_hops {
        let mut response = guarded_get_once(&current, policy).await?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
            else {
                return Ok((status, String::new()));
            };
            current = current
                .join(&location)
                .map_err(|error| format!("invalid redirect target: {error}"))?;
            continue;
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("reading guarded response body: {}", error.without_url()))?
        {
            if bytes.len() as u64 + chunk.len() as u64 > policy.max_body_bytes {
                let remaining = (policy.max_body_bytes as usize).saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((status, String::from_utf8_lossy(&bytes).into_owned()));
    }
    Err(format!(
        "too many redirects (more than {})",
        policy.max_redirect_hops
    ))
}

pub async fn guarded_fetch_text(url: &str) -> Result<(u16, String), String> {
    guarded_fetch_text_with_policy(url, GuardedFetchPolicy::default()).await
}

#[cfg(test)]
mod tests {
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
}
