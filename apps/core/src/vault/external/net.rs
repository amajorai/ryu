//! Egress guard for external-store HTTP calls.
//!
//! Store addresses are operator-configured, but the vault still never lets a
//! store become an SSRF primitive:
//!
//! * `https` is required. Loopback hosts (`127.0.0.1`, `[::1]`, `localhost`)
//!   are refused unless the operator sets `RYU_VAULT_EXTERNAL_ALLOW_LOOPBACK=1`
//!   or runs the `dev` profile; only then is `http` accepted, and only for
//!   loopback (local development against a dev-mode OpenBao/Vault);
//! * a hostname is resolved once, every resolved address is screened, and the
//!   client is pinned to exactly those addresses (`resolve_to_addrs`), so a DNS
//!   answer cannot change between the check and the connect (rebinding);
//! * link-local, cloud metadata, unspecified, multicast, and loopback (for a
//!   non-loopback name) addresses are always refused. Private LAN ranges
//!   (RFC 1918, CGNAT, ULA) are refused unless the operator sets
//!   `RYU_VAULT_EXTERNAL_ALLOW_PRIVATE=1` for a store on an internal network;
//! * redirects are never followed and no HTTP proxy is used, so the screened
//!   first hop is the only hop;
//! * responses are capped at [`MAX_RESPONSE_BYTES`].

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};

/// Opt-in for stores on private networks (never link-local or metadata).
pub const ENV_ALLOW_PRIVATE: &str = "RYU_VAULT_EXTERNAL_ALLOW_PRIVATE";
/// Opt-in for stores on this host's loopback interface (local development).
pub const ENV_ALLOW_LOOPBACK: &str = "RYU_VAULT_EXTERNAL_ALLOW_LOOPBACK";
/// Largest response body accepted from a store.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Cloud instance-metadata and host-agent addresses that are refused even when
/// private networks are allowed (some sit in CGNAT or public ranges).
const METADATA_ADDRESSES: &[IpAddr] = &[
    IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
    IpAddr::V4(Ipv4Addr::new(169, 254, 170, 2)),
    IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)),
    IpAddr::V4(Ipv4Addr::new(168, 63, 129, 16)),
    IpAddr::V6(Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)),
];

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Which non-public destinations the operator allowed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Egress {
    /// RFC 1918, CGNAT, and ULA ranges (never link-local or metadata).
    pub allow_private: bool,
    /// This host's loopback interface, over `http` or `https`.
    pub allow_loopback: bool,
}

impl Egress {
    /// The operator's settings. Loopback is also allowed in the `dev` profile
    /// and in unit tests, whose fake stores listen on `127.0.0.1`.
    pub fn from_env() -> Self {
        Self {
            allow_private: env_flag(ENV_ALLOW_PRIVATE),
            allow_loopback: cfg!(test)
                || env_flag(ENV_ALLOW_LOOPBACK)
                || crate::profile::profile() == "dev",
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// RFC 1918, CGNAT (100.64/10), and IPv6 ULA (fc00::/7).
fn is_private_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private() || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// Screen one resolved address for a non-loopback host.
pub fn screen_ip(ip: IpAddr, allow_private: bool) -> Result<()> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        other => other,
    };
    if METADATA_ADDRESSES.contains(&ip) || is_link_local(ip) {
        bail!("address {ip} is link-local or cloud metadata");
    }
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        bail!("address {ip} is not a routable store address");
    }
    if ryu_egress::is_blocked_ip(ip) && !(allow_private && is_private_lan(ip)) {
        bail!(
            "address {ip} is internal; set {ENV_ALLOW_PRIVATE}=1 to allow private-network stores"
        );
    }
    Ok(())
}

/// Screen every address a hostname resolved to. Any refused address refuses
/// the host, so a mixed public/internal answer cannot slip through.
pub fn screen_resolved(host: &str, addrs: &[SocketAddr], allow_private: bool) -> Result<()> {
    if addrs.is_empty() {
        bail!("store host `{host}` did not resolve");
    }
    for addr in addrs {
        screen_ip(addr.ip(), allow_private)
            .with_context(|| format!("store host `{host}` is refused"))?;
    }
    Ok(())
}

/// Validate a store address without network access: scheme, host shape, and
/// literal addresses. Returns the parsed URL with any trailing slash removed.
pub fn validate_address(address: &str, egress: Egress) -> Result<url::Url> {
    let url = url::Url::parse(address.trim()).map_err(|_| anyhow!("address is not a URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("address must not carry credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("address must not carry a query or fragment");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("address has no host"))?
        .to_owned();
    let loopback = is_loopback_host(&host);
    if loopback && !egress.allow_loopback {
        bail!("loopback store addresses need {ENV_ALLOW_LOOPBACK}=1 (local development only)");
    }
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => bail!("address must be https (http is allowed only for loopback)"),
    }
    if !loopback {
        if ryu_egress::is_blocked_hostname(&host) {
            bail!("store host `{host}` is an internal name");
        }
        if let Ok(ip) = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            screen_ip(ip, egress.allow_private)?;
        }
    }
    Ok(url)
}

/// A client that may only reach `url`'s host, at the screened addresses.
pub async fn guarded_client(url: &url::Url, egress: Egress) -> Result<reqwest::Client> {
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("address has no host"))?
        .to_owned();
    if is_loopback_host(&host) && !egress.allow_loopback {
        bail!("loopback store addresses need {ENV_ALLOW_LOOPBACK}=1 (local development only)");
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().unwrap_or(443);
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT);
    if bare.eq_ignore_ascii_case("localhost") {
        let addrs = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ];
        builder = builder.resolve_to_addrs(&host, &addrs);
    } else if bare.parse::<IpAddr>().is_err() {
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
            .await
            .with_context(|| format!("resolving store host `{host}`"))?
            .collect();
        screen_resolved(&host, &addrs, egress.allow_private)?;
        builder = builder.resolve_to_addrs(&host, &addrs);
    }
    builder.build().context("building the store HTTP client")
}

/// Read a JSON response body within the size cap.
pub async fn read_json(response: reqwest::Response) -> Result<serde_json::Value> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
    {
        bail!("store response is too large");
    }
    let bytes = response.bytes().await.context("reading store response")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        bail!("store response is too large");
    }
    if bytes.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&bytes).context("store response is not JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }

    const PUBLIC: Egress = Egress {
        allow_private: false,
        allow_loopback: false,
    };
    const PRIVATE: Egress = Egress {
        allow_private: true,
        allow_loopback: false,
    };
    const LOOPBACK: Egress = Egress {
        allow_private: false,
        allow_loopback: true,
    };

    #[test]
    fn https_is_required_except_for_loopback() {
        assert!(validate_address("https://vault.example.com", PUBLIC).is_ok());
        assert!(validate_address("http://127.0.0.1:8200", LOOPBACK).is_ok());
        assert!(validate_address("http://[::1]:8200", LOOPBACK).is_ok());
        assert!(validate_address("http://localhost:8200", LOOPBACK).is_ok());
        assert!(validate_address("http://vault.example.com", LOOPBACK).is_err());
        assert!(validate_address("ftp://vault.example.com", PUBLIC).is_err());
        assert!(validate_address("https://user:pw@vault.example.com", PUBLIC).is_err());
        assert!(validate_address("https://vault.example.com/?x=1", PUBLIC).is_err());
    }

    #[tokio::test]
    async fn loopback_needs_the_operator_opt_in() {
        for address in [
            "http://127.0.0.1:8200",
            "https://127.0.0.1:8200",
            "http://[::1]:8200",
            "https://localhost:8200",
        ] {
            assert!(validate_address(address, PUBLIC).is_err(), "{address}");
            // The private-network opt-in does not cover this host.
            assert!(validate_address(address, PRIVATE).is_err(), "{address}");
            let url = url::Url::parse(address).unwrap();
            assert!(guarded_client(&url, PRIVATE).await.is_err(), "{address}");
            assert!(guarded_client(&url, LOOPBACK).await.is_ok(), "{address}");
        }
    }

    #[test]
    fn metadata_and_link_local_are_always_refused() {
        for ip in [
            "169.254.169.254",
            "169.254.1.1",
            "100.100.100.200",
            "168.63.129.16",
            "fe80::1",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
        ] {
            assert!(screen_ip(ip.parse().unwrap(), true).is_err(), "{ip}");
        }
        assert!(validate_address("https://169.254.169.254", PRIVATE).is_err());
        assert!(validate_address("https://metadata.google.internal", PRIVATE).is_err());
    }

    #[test]
    fn private_ranges_need_the_operator_opt_in() {
        for ip in [
            "10.0.0.5",
            "192.168.1.10",
            "172.16.0.1",
            "100.64.0.1",
            "fd12::1",
        ] {
            assert!(screen_ip(ip.parse().unwrap(), false).is_err(), "{ip}");
            assert!(screen_ip(ip.parse().unwrap(), true).is_ok(), "{ip}");
        }
        assert!(screen_ip("93.184.216.34".parse().unwrap(), false).is_ok());
    }

    #[test]
    fn a_name_resolving_to_any_internal_address_is_refused() {
        // DNS rebinding: one public and one loopback answer.
        assert!(screen_resolved(
            "vault.example.com",
            &[addr("93.184.216.34"), addr("127.0.0.1")],
            true
        )
        .is_err());
        assert!(screen_resolved("vault.example.com", &[], false).is_err());
        assert!(screen_resolved("vault.example.com", &[addr("93.184.216.34")], false).is_ok());
    }
}
