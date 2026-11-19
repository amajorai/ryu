//! CIDR blocks, client-address resolution and trusted proxies.

use std::net::IpAddr;

use anyhow::Result;

use crate::vault::VaultError;

use super::*;

// ── CIDR blocks ───────────────────────────────────────────────────────────

/// One IPv4 or IPv6 CIDR block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `10.0.0.0/8`, `fd00::/8`, or a bare address (a host block).
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (address, prefix) = match text.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix.parse::<u8>().ok()?)),
            None => (text, None),
        };
        let address: IpAddr = address.parse().ok()?;
        let address = address.to_canonical();
        let width = if address.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(width);
        if prefix > width {
            return None;
        }
        Some(Self {
            network: mask(address, prefix),
            prefix,
        })
    }

    /// Whether `ip` is inside this block.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        ip.is_ipv4() == self.network.is_ipv4() && mask(ip, self.prefix) == self.network
    }

    /// Whether every address of `other` is inside this block.
    pub fn covers(&self, other: &Cidr) -> bool {
        self.prefix <= other.prefix && self.contains(other.network)
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

pub(super) fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let bits = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(prefix))
            };
            IpAddr::V4((u32::from(v4) & bits).into())
        }
        IpAddr::V6(v6) => {
            let bits = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(prefix))
            };
            IpAddr::V6((u128::from(v6) & bits).into())
        }
    }
}

/// Validate and canonicalize a CIDR list (deduplicated, at most [`MAX_CIDRS`]).
pub fn normalize_cidrs(list: &[String]) -> Result<Vec<String>> {
    if list.len() > MAX_CIDRS {
        return Err(VaultError::Invalid(format!("at most {MAX_CIDRS} CIDR blocks")).into());
    }
    let mut out = Vec::new();
    for entry in list {
        let cidr = Cidr::parse(entry)
            .ok_or_else(|| VaultError::Invalid(format!("`{entry}` is not a CIDR block")))?;
        let text = cidr.to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    Ok(out)
}

/// Whether `ip` satisfies `cidrs`. An empty list allows any address; a
/// non-empty list requires a known address inside one of the blocks.
pub fn ip_allowed(cidrs: &[String], ip: Option<IpAddr>) -> bool {
    cidrs.is_empty()
        || ip.is_some_and(|ip| {
            cidrs
                .iter()
                .filter_map(|cidr| Cidr::parse(cidr))
                .any(|cidr| cidr.contains(ip))
        })
}

/// Whether every block in `inner` lies inside some block of `outer` (an empty
/// `outer` admits anything).
pub fn cidrs_within(inner: &[String], outer: &[String]) -> bool {
    if outer.is_empty() {
        return true;
    }
    let outer: Vec<Cidr> = outer.iter().filter_map(|c| Cidr::parse(c)).collect();
    inner.iter().all(|entry| {
        Cidr::parse(entry).is_some_and(|cidr| outer.iter().any(|block| block.covers(&cidr)))
    })
}

/// Proxies whose `X-Forwarded-For` header is trusted
/// (`RYU_VAULT_TRUSTED_PROXIES`, comma-separated CIDRs; empty by default).
pub fn trusted_proxies() -> Vec<Cidr> {
    std::env::var(ENV_TRUSTED_PROXIES)
        .unwrap_or_default()
        .split(',')
        .filter(|entry| !entry.trim().is_empty())
        .filter_map(Cidr::parse)
        .collect()
}

/// Resolve the client address of a request.
///
/// The socket peer is authoritative. `X-Forwarded-For` is honored only when
/// the peer is a configured trusted proxy, and then the right-most entry that
/// is not itself a trusted proxy wins. A loopback peer behind Core's own
/// forwarding tunnel is a remote client of unknown address, so the result is
/// `None` and CIDR-bound tokens fail closed.
pub fn resolve_client_ip(
    peer: Option<IpAddr>,
    forwarded_for: Option<&str>,
    trusted: &[Cidr],
    tunnel_active: bool,
) -> Option<IpAddr> {
    let peer = peer?.to_canonical();
    if peer.is_loopback() && tunnel_active {
        return None;
    }
    if !trusted.iter().any(|proxy| proxy.contains(peer)) {
        return Some(peer);
    }
    let Some(header) = forwarded_for else {
        return Some(peer);
    };
    for hop in header.rsplit(',') {
        let ip: IpAddr = hop.trim().parse().ok()?;
        let ip = ip.to_canonical();
        if !trusted.iter().any(|proxy| proxy.contains(ip)) {
            return Some(ip);
        }
    }
    Some(peer)
}
