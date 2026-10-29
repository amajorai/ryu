//! Dial-time SSRF guard for brokered traffic.
//!
//! Every address a host resolves to is checked (so a DNS answer that mixes a
//! public and a private address is refused, and a rebinding answer at connect
//! time is checked again by [`GuardedResolver`]). Loopback, private,
//! link-local, and other non-public ranges are blocked unless
//! `RYU_VAULT_BROKER_ALLOW_PRIVATE` is set or the address falls inside
//! `RYU_VAULT_BROKER_NETWORK_ALLOWLIST`. Cloud metadata endpoints stay blocked
//! regardless of either setting.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use anyhow::{bail, Result};

/// Addresses that are never dialed (instance metadata services).
const METADATA_IPS: &[IpAddr] = &[
    IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
    IpAddr::V4(Ipv4Addr::new(169, 254, 170, 2)),
    IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)),
    IpAddr::V6(Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)),
];
const METADATA_HOSTS: &[&str] = &["metadata", "metadata.google.internal", "metadata.goog"];

/// An IPv4 or IPv6 CIDR block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `a.b.c.d/n`, `x::y/n`, or a bare address (a host route).
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (addr, prefix) = match value.split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix.parse::<u8>().ok()?)),
            None => (value, None),
        };
        let network: IpAddr = addr.parse().ok()?;
        let max = if network.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(Self { network, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.network, canonical(ip)) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// IPv4-mapped IPv6 addresses compare as IPv4.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// The broker's network policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetGuard {
    pub allow_private: bool,
    pub allowlist: Vec<Cidr>,
}

impl NetGuard {
    /// Read [`super::ENV_ALLOW_PRIVATE`] and [`super::ENV_NETWORK_ALLOWLIST`].
    /// Unparseable allowlist entries are ignored with a warning.
    pub fn from_env() -> Self {
        let allow_private = std::env::var(super::ENV_ALLOW_PRIVATE)
            .map(|value| matches!(value.trim(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let allowlist = std::env::var(super::ENV_NETWORK_ALLOWLIST)
            .unwrap_or_default()
            .split(',')
            .filter(|entry| !entry.trim().is_empty())
            .filter_map(|entry| {
                let parsed = Cidr::parse(entry);
                if parsed.is_none() {
                    tracing::warn!(entry, "ignoring invalid broker network allowlist entry");
                }
                parsed
            })
            .collect();
        Self {
            allow_private,
            allowlist,
        }
    }

    fn allowlisted(&self, ip: IpAddr) -> bool {
        self.allowlist.iter().any(|cidr| cidr.contains(ip))
    }

    /// Whether one address may be dialed.
    pub fn check_ip(&self, ip: IpAddr) -> Result<()> {
        let ip = canonical(ip);
        if METADATA_IPS.contains(&ip) {
            bail!("the cloud metadata address {ip} is never reachable through the broker");
        }
        if self.allow_private || self.allowlisted(ip) || !ryu_egress::is_blocked_ip(ip) {
            return Ok(());
        }
        bail!("{ip} is a private or reserved address")
    }

    /// Resolve `host` and check every address. An internal hostname
    /// (`localhost`, `*.internal`, ...) is accepted only when every address it
    /// resolves to is allowed explicitly.
    pub async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        let bare = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if let Ok(ip) = bare.parse::<IpAddr>() {
            self.check_ip(ip)?;
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        if METADATA_HOSTS
            .iter()
            .any(|name| bare == *name || bare.ends_with(&format!(".{name}")))
        {
            bail!("metadata hostnames are never reachable through the broker");
        }
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare.as_str(), port))
            .await
            .map_err(|_| anyhow::anyhow!("`{bare}` did not resolve"))?
            .collect();
        if addrs.is_empty() {
            bail!("`{bare}` did not resolve");
        }
        for addr in &addrs {
            self.check_ip(addr.ip())?;
        }
        if ryu_egress::is_blocked_hostname(&bare)
            && !self.allow_private
            && !addrs.iter().all(|addr| self.allowlisted(addr.ip()))
        {
            bail!("`{bare}` is an internal hostname");
        }
        Ok(addrs)
    }
}

/// A `reqwest` resolver that applies the guard at connect time, so the
/// addresses actually dialed are the ones that were checked.
#[derive(Debug, Clone)]
pub struct GuardedResolver(pub Arc<NetGuard>);

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let guard = self.0.clone();
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = guard
                .resolve(&host, 0)
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;
            let addrs: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn cidrs_parse_and_match() {
        let net = Cidr::parse("10.1.0.0/16").unwrap();
        assert!(net.contains(ip("10.1.200.3")));
        assert!(!net.contains(ip("10.2.0.1")));
        assert!(net.contains(ip("::ffff:10.1.0.9")));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        assert!(Cidr::parse("fd00::/8").unwrap().contains(ip("fd12::1")));
        assert!(Cidr::parse("127.0.0.1").unwrap().contains(ip("127.0.0.1")));
        assert!(Cidr::parse("10.0.0.0/33").is_none());
        assert!(Cidr::parse("nope/8").is_none());
    }

    #[test]
    fn private_ranges_are_blocked_by_default() {
        let guard = NetGuard::default();
        for blocked in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "::1",
            "fe80::1",
        ] {
            assert!(guard.check_ip(ip(blocked)).is_err(), "{blocked}");
        }
        assert!(guard.check_ip(ip("93.184.216.34")).is_ok());
    }

    #[test]
    fn allowlists_open_ranges_but_never_metadata() {
        let guard = NetGuard {
            allow_private: false,
            allowlist: vec![
                Cidr::parse("10.0.0.0/8").unwrap(),
                Cidr::parse("169.254.0.0/16").unwrap(),
            ],
        };
        assert!(guard.check_ip(ip("10.4.4.4")).is_ok());
        assert!(guard.check_ip(ip("192.168.0.1")).is_err());
        assert!(guard.check_ip(ip("169.254.169.254")).is_err());
        let open = NetGuard {
            allow_private: true,
            allowlist: Vec::new(),
        };
        assert!(open.check_ip(ip("127.0.0.1")).is_ok());
        assert!(open.check_ip(ip("169.254.169.254")).is_err());
        assert!(open.check_ip(ip("::ffff:169.254.169.254")).is_err());
    }

    #[tokio::test]
    async fn resolution_checks_literals_names_and_metadata_hosts() {
        let guard = NetGuard::default();
        assert!(guard.resolve("127.0.0.1", 80).await.is_err());
        assert!(guard.resolve("[::1]", 80).await.is_err());
        assert!(guard.resolve("localhost", 80).await.is_err());
        assert!(guard.resolve("metadata.google.internal", 80).await.is_err());
        let loopback = NetGuard {
            allow_private: false,
            allowlist: vec![
                Cidr::parse("127.0.0.0/8").unwrap(),
                Cidr::parse("::1").unwrap(),
            ],
        };
        let addrs = loopback.resolve("localhost", 8080).await.unwrap();
        assert!(addrs
            .iter()
            .all(|addr| addr.ip().is_loopback() && addr.port() == 8080));
        assert!(loopback.resolve("metadata", 80).await.is_err());
    }
}
