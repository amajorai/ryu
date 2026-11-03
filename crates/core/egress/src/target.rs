//! Screening for non-HTTP outbound targets (database, cache, and webhook hosts)
//! whose address was configured by someone with less authority than the host
//! operator.
//!
//! The HTTP helpers in the crate root cover URLs. Database and cache drivers
//! open their own sockets, so they need the same screen as a host and port:
//! the hostname is checked before DNS, resolved once, every resolved address is
//! checked, and the caller must connect to exactly the returned addresses (so a
//! DNS answer cannot change between the check and the connect).
//!
//! [`TargetAuthority`] records who configured a target, and [`must_screen`]
//! decides whether that target is screened at connect time.

use std::net::SocketAddr;

/// Who configured an outbound target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetAuthority {
    /// The host operator, or a principal holding full configuration authority.
    /// Its targets keep the host's network position (loopback and LAN).
    Operator,
    /// A principal delegated authority over this one object only. Its targets
    /// must be public.
    Delegate,
    /// Written before the writer was recorded.
    Unrecorded,
}

impl TargetAuthority {
    /// The stored label (`manager` or `delegate`); `None` for unrecorded.
    #[must_use]
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Operator => Some("manager"),
            Self::Delegate => Some("delegate"),
            Self::Unrecorded => None,
        }
    }

    /// Parse a stored label. A missing or unknown label is unrecorded.
    #[must_use]
    pub fn from_label(label: Option<&str>) -> Self {
        match label {
            Some("manager") => Self::Operator,
            Some("delegate") => Self::Delegate,
            _ => Self::Unrecorded,
        }
    }
}

/// Whether a target must be screened at connect time.
///
/// Delegate targets always are. Unrecorded targets are screened only where
/// delegation exists (`multi_user`): on a single-operator host every earlier
/// writer was the operator, so its targets keep working unchanged.
#[must_use]
pub fn must_screen(authority: TargetAuthority, multi_user: bool) -> bool {
    match authority {
        TargetAuthority::Operator => false,
        TargetAuthority::Delegate => true,
        TargetAuthority::Unrecorded => multi_user,
    }
}

/// Screen a configured host without DNS: Unix-socket paths, empty or malformed
/// hosts, internal names (`localhost`, `*.local`, `*.internal`, metadata), and
/// internal IP literals (loopback, private, link-local, CGNAT, ULA,
/// unspecified, multicast, and IPv4 embedded in IPv6) are refused.
pub fn screen_host_literal(host: &str) -> Result<(), String> {
    if host.starts_with('/') || host.starts_with('@') || host.contains('\\') {
        return Err("Unix-socket hosts are not allowed".to_owned());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    super::screen_guarded_hostname(bare)?;
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if super::is_blocked_ip(ip) {
            return Err(format!("address {ip} is internal"));
        }
    }
    Ok(())
}

/// Check every address a host resolved to; one internal address refuses the
/// host, so a mixed public/internal answer cannot slip through.
pub fn screen_resolved(host: &str, addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() {
        return Err(format!("host `{host}` did not resolve"));
    }
    for address in addresses {
        if super::is_blocked_ip(address.ip()) {
            return Err(format!(
                "host `{host}` resolved to internal address {}",
                address.ip()
            ));
        }
    }
    Ok(())
}

/// Screen `host`, resolve it with `resolve`, and screen every answer. The
/// caller must connect to one of the returned addresses, never to `host`.
pub fn resolve_screened_with<F>(
    host: &str,
    port: u16,
    resolve: F,
) -> Result<Vec<SocketAddr>, String>
where
    F: FnOnce(&str, u16) -> std::io::Result<Vec<SocketAddr>>,
{
    screen_host_literal(host)?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addresses =
        resolve(bare, port).map_err(|error| format!("failed to resolve host `{bare}`: {error}"))?;
    screen_resolved(bare, &addresses)?;
    Ok(addresses)
}

/// [`resolve_screened_with`] using the system resolver.
pub async fn resolve_screened(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    screen_host_literal(host)?;
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    tokio::task::spawn_blocking(move || {
        resolve_screened_with(&bare, port, |name, port| {
            use std::net::ToSocketAddrs;
            (name, port).to_socket_addrs().map(Iterator::collect)
        })
    })
    .await
    .map_err(|error| format!("DNS resolution task failed: {error}"))?
}

#[cfg(test)]
#[path = "target_test.rs"]
mod target_test;
