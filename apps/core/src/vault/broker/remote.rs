//! The remote-reachable broker listener (off by default).
//!
//! The loopback listener serves agents on this machine. Remote agents (a VM, a
//! container host, a CI runner on the same private network) reach the broker
//! through a second listener that exists only when [`ENV_REMOTE_LISTEN`] names
//! an address, and that admits:
//!
//! * peers inside [`ENV_REMOTE_CIDRS`] only (required; a catch-all block such
//!   as `0.0.0.0/0` is refused, so the listener is never an open proxy), and
//! * sessions minted with `remote: true` only (which needs `use` on
//!   `sys/broker/remote`), so a loopback session that leaks cannot be
//!   replayed from the network.
//!
//! Every request still needs a live `rvb_` session in `Proxy-Authorization`.
//! By default the proxy hop is plain HTTP, like the loopback listener, so the
//! session crosses the network in the clear: bind it only on a trusted
//! network (a VPN, a private VPC, a WireGuard or Tailscale interface). With
//! [`ENV_REMOTE_TLS`] on, the listener speaks TLS with a server certificate
//! the broker CA issues for [`RemoteConfig::certificate_host`], and agents
//! use an `https://` proxy URL that trusts the CA returned at mint.
//! [`ENV_REMOTE_URL`] is the proxy URL handed to remote agents at mint.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use anyhow::{bail, Context, Result};

use super::netguard::Cidr;

/// `host:port` of the remote listener; unset keeps it off.
pub const ENV_REMOTE_LISTEN: &str = "RYU_VAULT_BROKER_REMOTE_LISTEN";
/// Comma-separated peer CIDRs the remote listener admits (required).
pub const ENV_REMOTE_CIDRS: &str = "RYU_VAULT_BROKER_REMOTE_CIDRS";
/// Proxy URL remote agents use, e.g. `http://10.0.0.5:8124`
/// (`https://` with [`ENV_REMOTE_TLS`]).
pub const ENV_REMOTE_URL: &str = "RYU_VAULT_BROKER_REMOTE_URL";
/// `1` or `true` serves the remote listener over TLS (off by default).
pub const ENV_REMOTE_TLS: &str = "RYU_VAULT_BROKER_REMOTE_TLS";

/// A validated remote-listener configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    pub listen: SocketAddr,
    pub allowed: Vec<Cidr>,
    /// The `http(s)://host:port` remote agents are given, if known.
    pub url: Option<String>,
    /// Serve TLS with a broker-CA server certificate.
    pub tls: bool,
}

impl RemoteConfig {
    /// Whether `peer` may connect.
    pub fn admits(&self, peer: IpAddr) -> bool {
        self.allowed.iter().any(|cidr| cidr.contains(peer))
    }

    /// The name the TLS server certificate is issued for: the advertised
    /// URL's host, else the listen address (none for a wildcard bind
    /// without a URL; the connection's local address is used then).
    pub fn certificate_host(&self) -> Option<String> {
        if let Some(url) = &self.url {
            let host = reqwest::Url::parse(url).ok()?.host_str()?.to_owned();
            return Some(
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_owned(),
            );
        }
        (!self.listen.ip().is_unspecified()).then(|| self.listen.ip().to_string())
    }

    /// The configuration from the environment: `Ok(None)` when off.
    pub fn from_env() -> Result<Option<Self>> {
        let read = |name: &str| std::env::var(name).ok();
        Self::parse(
            read(ENV_REMOTE_LISTEN).as_deref(),
            read(ENV_REMOTE_CIDRS).as_deref(),
            read(ENV_REMOTE_URL).as_deref(),
            parse_flag(read(ENV_REMOTE_TLS).as_deref())?,
        )
    }

    pub fn parse(
        listen: Option<&str>,
        cidrs: Option<&str>,
        url: Option<&str>,
        tls: bool,
    ) -> Result<Option<Self>> {
        let Some(listen) = listen.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let listen: SocketAddr = listen
            .parse()
            .with_context(|| format!("{ENV_REMOTE_LISTEN} must be an address:port"))?;
        if listen.port() == 0 {
            bail!("{ENV_REMOTE_LISTEN} needs a fixed port");
        }
        let mut allowed = Vec::new();
        for entry in cidrs
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
        {
            let cidr = Cidr::parse(entry)
                .with_context(|| format!("invalid {ENV_REMOTE_CIDRS} `{entry}`"))?;
            if is_catch_all(&cidr) {
                bail!("{ENV_REMOTE_CIDRS} must name specific networks, not `{entry}`");
            }
            allowed.push(cidr);
        }
        if allowed.is_empty() {
            bail!("{ENV_REMOTE_CIDRS} is required with {ENV_REMOTE_LISTEN}");
        }
        let scheme = if tls { "https" } else { "http" };
        let url = match url.map(str::trim).filter(|value| !value.is_empty()) {
            Some(url) => Some(advertised_url(url, scheme)?),
            None if !listen.ip().is_unspecified() => Some(format!("{scheme}://{listen}")),
            None => None,
        };
        Ok(Some(Self {
            listen,
            allowed,
            url,
            tls,
        }))
    }
}

/// A block covering every address of its family.
fn is_catch_all(cidr: &Cidr) -> bool {
    let v4 = cidr.contains(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)))
        && cidr.contains(IpAddr::V4(Ipv4Addr::new(223, 255, 255, 254)));
    let v6 = cidr.contains(IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)))
        && cidr.contains(IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)));
    v4 || v6
}

/// An on/off environment flag: unset or empty is off.
fn parse_flag(value: Option<&str>) -> Result<bool> {
    match value.map(str::trim).unwrap_or_default() {
        "" | "0" | "false" | "off" => Ok(false),
        "1" | "true" | "on" => Ok(true),
        other => bail!("{ENV_REMOTE_TLS} must be on or off, not `{other}`"),
    }
}

fn advertised_url(url: &str, scheme: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("invalid {ENV_REMOTE_URL}"))?;
    if parsed.scheme() != scheme
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        bail!("{ENV_REMOTE_URL} must be {scheme}://host:port");
    }
    Ok(url.trim_end_matches('/').to_owned())
}

/// The proxy URL with a session token, for a remote agent's environment.
pub fn proxy_url(base: &str, token: &str) -> String {
    match base.split_once("://") {
        Some((scheme, rest)) => format!("{scheme}://rvb:{token}@{rest}"),
        None => base.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_remote_listener_is_off_unless_configured() {
        assert_eq!(
            RemoteConfig::parse(None, Some("10.0.0.0/8"), None, false).unwrap(),
            None
        );
        assert_eq!(
            RemoteConfig::parse(Some(" "), None, None, false).unwrap(),
            None
        );
    }

    #[test]
    fn it_needs_a_fixed_port_and_specific_networks() {
        for (listen, cidrs) in [
            ("10.0.0.5:8124", None),
            ("10.0.0.5:8124", Some(" , ")),
            ("10.0.0.5:8124", Some("0.0.0.0/0")),
            ("10.0.0.5:8124", Some("10.0.0.0/8,::/0")),
            ("10.0.0.5:8124", Some("10.0.0.0/33")),
            ("10.0.0.5:0", Some("10.0.0.0/8")),
            ("not-an-address", Some("10.0.0.0/8")),
        ] {
            assert!(
                RemoteConfig::parse(Some(listen), cidrs, None, false).is_err(),
                "{listen} {cidrs:?}"
            );
        }
        let config = RemoteConfig::parse(
            Some("10.0.0.5:8124"),
            Some("10.0.0.0/8, 192.168.1.7"),
            None,
            false,
        )
        .unwrap()
        .unwrap();
        assert!(config.admits("10.9.9.9".parse().unwrap()));
        assert!(config.admits("192.168.1.7".parse().unwrap()));
        assert!(!config.admits("192.168.1.8".parse().unwrap()));
        assert!(!config.admits("8.8.8.8".parse().unwrap()));
        assert_eq!(config.url.as_deref(), Some("http://10.0.0.5:8124"));
    }

    #[test]
    fn the_advertised_url_is_a_plain_proxy_origin() {
        let wildcard = RemoteConfig::parse(Some("0.0.0.0:8124"), Some("10.0.0.0/8"), None, false)
            .unwrap()
            .unwrap();
        assert_eq!(wildcard.url, None);
        let named = RemoteConfig::parse(
            Some("0.0.0.0:8124"),
            Some("10.0.0.0/8"),
            Some("http://broker.internal:8124/"),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(named.url.as_deref(), Some("http://broker.internal:8124"));
        for bad in ["https://x:1", "http://u:p@x:1", "http://x:1/path", "nope"] {
            assert!(
                RemoteConfig::parse(Some("0.0.0.0:8124"), Some("10.0.0.0/8"), Some(bad), false)
                    .is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            proxy_url("http://broker.internal:8124", "rvb_x"),
            "http://rvb:rvb_x@broker.internal:8124"
        );
    }

    #[test]
    fn tls_is_opt_in_and_changes_the_advertised_scheme() {
        assert!(!parse_flag(None).unwrap());
        assert!(!parse_flag(Some(" off ")).unwrap());
        assert!(parse_flag(Some("1")).unwrap());
        assert!(parse_flag(Some("yes please")).is_err());
        let tls = RemoteConfig::parse(Some("10.0.0.5:8124"), Some("10.0.0.0/8"), None, true)
            .unwrap()
            .unwrap();
        assert!(tls.tls);
        assert_eq!(tls.url.as_deref(), Some("https://10.0.0.5:8124"));
        assert_eq!(tls.certificate_host().as_deref(), Some("10.0.0.5"));
        let named = RemoteConfig::parse(
            Some("0.0.0.0:8124"),
            Some("10.0.0.0/8"),
            Some("https://broker.internal:8124"),
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(named.certificate_host().as_deref(), Some("broker.internal"));
        assert_eq!(
            proxy_url(named.url.as_deref().unwrap(), "rvb_x"),
            "https://rvb:rvb_x@broker.internal:8124"
        );
        // The advertised scheme must match the listener.
        for (url, tls) in [("http://x:1", true), ("https://x:1", false)] {
            assert!(
                RemoteConfig::parse(Some("0.0.0.0:8124"), Some("10.0.0.0/8"), Some(url), tls)
                    .is_err(),
                "{url} {tls}"
            );
        }
        let wildcard = RemoteConfig::parse(Some("0.0.0.0:8124"), Some("10.0.0.0/8"), None, true)
            .unwrap()
            .unwrap();
        assert_eq!(wildcard.certificate_host(), None);
    }
}
