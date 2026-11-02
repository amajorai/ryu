use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use thiserror::Error;
use url::{Host, Url};

use crate::TaskState;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EndpointPolicy {
    /// Permit plain HTTP only when the URL and every resolved address are
    /// loopback. Intended for local development and deterministic tests.
    pub allow_loopback_http: bool,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum EndpointError {
    #[error("endpoint URL is invalid")]
    InvalidUrl,
    #[error("endpoint must not contain embedded credentials")]
    EmbeddedCredentials,
    #[error("endpoint must not contain a fragment")]
    Fragment,
    #[error("endpoint must use HTTPS")]
    InsecureTransport,
    #[error("endpoint host is missing")]
    MissingHost,
    #[error("endpoint targets a local or non-public network")]
    NonPublicAddress,
}

/// Validate a configured endpoint or redirect target before DNS resolution.
/// The caller must also pass every resolved address to
/// [`validate_resolved_addresses`] immediately before connecting.
pub fn validate_endpoint(value: &str, policy: EndpointPolicy) -> Result<Url, EndpointError> {
    let url = Url::parse(value).map_err(|_| EndpointError::InvalidUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(EndpointError::EmbeddedCredentials);
    }
    if url.fragment().is_some() {
        return Err(EndpointError::Fragment);
    }

    let host = url.host().ok_or(EndpointError::MissingHost)?;
    let loopback_host = match host {
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
        Host::Domain(domain) => {
            domain.eq_ignore_ascii_case("localhost")
                || domain.to_ascii_lowercase().ends_with(".localhost")
        }
    };

    match url.scheme() {
        "https" => {}
        "http" if policy.allow_loopback_http && loopback_host => {}
        "http" => return Err(EndpointError::InsecureTransport),
        _ => return Err(EndpointError::InsecureTransport),
    }

    match host {
        Host::Ipv4(address) if !address_allowed(IpAddr::V4(address), policy) => {
            Err(EndpointError::NonPublicAddress)
        }
        Host::Ipv6(address) if !address_allowed(IpAddr::V6(address), policy) => {
            Err(EndpointError::NonPublicAddress)
        }
        Host::Domain(domain)
            if is_local_domain(domain)
                && !(policy.allow_loopback_http && loopback_host && url.scheme() == "http") =>
        {
            Err(EndpointError::NonPublicAddress)
        }
        _ => Ok(url),
    }
}

/// Revalidate all DNS results immediately before connecting. An empty result is
/// rejected, and a single unsafe result rejects the whole destination to avoid
/// mixed-answer and DNS-rebinding bypasses.
pub fn validate_resolved_addresses(
    addresses: &[IpAddr],
    policy: EndpointPolicy,
) -> Result<(), EndpointError> {
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !address_allowed(*address, policy))
    {
        return Err(EndpointError::NonPublicAddress);
    }
    Ok(())
}

fn is_local_domain(domain: &str) -> bool {
    let normalized = domain.to_ascii_lowercase();
    normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
}

fn address_allowed(address: IpAddr, policy: EndpointPolicy) -> bool {
    if policy.allow_loopback_http && address.is_loopback() {
        return true;
    }
    match address {
        IpAddr::V4(address) => ipv4_is_public(address),
        IpAddr::V6(address) => ipv6_is_public(address),
    }
}

fn ipv4_is_public(address: Ipv4Addr) -> bool {
    let [a, b, c, d] = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_unspecified()
        || address == Ipv4Addr::BROADCAST
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240
        || (a == 169 && b == 254 && c == 169 && d == 254))
}

/// IPv4 address carried inside an IPv6 address that a host or gateway may
/// translate back to IPv4: mapped (`::ffff:0:0/96`), translated
/// (`::ffff:0:0:0/96`), well-known NAT64 (`64:ff9b::/96`) and the deprecated
/// compatible form (`::/96`). Mirrors `ryu_egress`'s screen so the two guards
/// cannot disagree about which destinations are public.
fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let words = address.segments();
    let zeroes = |start: usize, end: usize| words[start..end].iter().all(|word| *word == 0);
    let mapped = zeroes(0, 5) && words[5] == 0xffff;
    let translated = zeroes(0, 4) && words[4] == 0xffff && words[5] == 0;
    let nat64 = words[0] == 0x0064 && words[1] == 0xff9b && zeroes(2, 6);
    let compatible = zeroes(0, 6);
    if !(mapped || translated || nat64 || compatible) {
        return None;
    }
    let octets = address.octets();
    Some(Ipv4Addr::new(
        octets[12], octets[13], octets[14], octets[15],
    ))
}

fn ipv6_is_public(address: Ipv6Addr) -> bool {
    if let Some(embedded) = embedded_ipv4(address) {
        return ipv4_is_public(embedded);
    }
    let segments = address.segments();
    !(address.is_loopback()
        // Local-use NAT64 prefix (RFC 8215) translates to operator-chosen IPv4.
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
        || address.is_unspecified()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[derive(Debug, Error, Eq, PartialEq)]
#[error("invalid task state transition from {from} to {to}")]
pub struct TransitionError {
    pub from: TaskState,
    pub to: TaskState,
}

/// A2A tasks are monotonic. Repeating the current state is idempotent, while a
/// terminal state cannot be reopened or changed into a different terminal state.
pub fn validate_task_transition(from: TaskState, to: TaskState) -> Result<(), TransitionError> {
    let valid = if from == to {
        true
    } else {
        match from {
            TaskState::Submitted => true,
            TaskState::Working | TaskState::InputRequired | TaskState::AuthRequired => {
                !matches!(to, TaskState::Submitted | TaskState::Unknown)
            }
            TaskState::Unknown => true,
            state if state.is_terminal() => false,
            _ => false,
        }
    };
    if valid {
        Ok(())
    } else {
        Err(TransitionError { from, to })
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn blocks_credentials_fragments_and_insecure_remote_urls() {
        let policy = EndpointPolicy::default();
        assert_eq!(
            validate_endpoint("https://user:secret@example.com/a2a", policy),
            Err(EndpointError::EmbeddedCredentials)
        );
        assert_eq!(
            validate_endpoint("https://example.com/a2a#secret", policy),
            Err(EndpointError::Fragment)
        );
        assert_eq!(
            validate_endpoint("http://example.com/a2a", policy),
            Err(EndpointError::InsecureTransport)
        );
    }

    #[test]
    fn permits_only_explicit_loopback_http_for_development() {
        let development = EndpointPolicy {
            allow_loopback_http: true,
        };
        assert!(validate_endpoint("http://127.0.0.1:7777/a2a", development).is_ok());
        assert!(validate_endpoint("http://localhost:7777/a2a", development).is_ok());
        assert_eq!(
            validate_endpoint("http://192.168.1.2/a2a", development),
            Err(EndpointError::InsecureTransport)
        );
        assert_eq!(
            validate_endpoint("https://localhost/a2a", development),
            Err(EndpointError::NonPublicAddress)
        );
    }

    #[test]
    fn blocks_private_metadata_and_mixed_dns_answers() {
        let policy = EndpointPolicy::default();
        let cases = [
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            "fc00::1".parse().expect("valid IPv6"),
            "2001:db8::1".parse().expect("valid IPv6"),
        ];
        for address in cases {
            assert_eq!(
                validate_resolved_addresses(&[address], policy),
                Err(EndpointError::NonPublicAddress)
            );
        }
        assert_eq!(
            validate_resolved_addresses(
                &[
                    IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
                    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
                ],
                policy
            ),
            Err(EndpointError::NonPublicAddress)
        );
        assert!(validate_resolved_addresses(
            &[IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))],
            policy
        )
        .is_ok());
    }

    #[test]
    fn blocks_ipv6_forms_that_embed_non_public_ipv4() {
        let policy = EndpointPolicy::default();
        for url in [
            "https://[64:ff9b::a00:5]/hook",
            "https://[64:ff9b::a9fe:a9fe]/",
            "https://[64:ff9b:1::808:808]/",
            "https://[::a00:1]/",
            "https://[::ffff:0:a00:1]/",
            "https://[::ffff:7f00:1]/",
        ] {
            assert_eq!(
                validate_endpoint(url, policy),
                Err(EndpointError::NonPublicAddress),
                "{url} must be rejected"
            );
        }
        for address in ["64:ff9b::7f00:1", "::a00:1", "::ffff:0:a9fe:a9fe"] {
            assert_eq!(
                validate_resolved_addresses(&[address.parse().expect("valid IPv6")], policy),
                Err(EndpointError::NonPublicAddress),
                "{address} must be rejected"
            );
        }
        assert!(validate_endpoint("https://[64:ff9b::808:808]/", policy).is_ok());
        assert!(validate_endpoint("https://[2606:4700::1111]/", policy).is_ok());
    }

    #[test]
    fn task_state_transitions_are_monotonic_and_idempotent() {
        assert!(validate_task_transition(TaskState::Submitted, TaskState::Working).is_ok());
        assert!(validate_task_transition(TaskState::Working, TaskState::Completed).is_ok());
        assert!(validate_task_transition(TaskState::Completed, TaskState::Completed).is_ok());
        assert!(validate_task_transition(TaskState::Completed, TaskState::Working).is_err());
        assert!(validate_task_transition(TaskState::Working, TaskState::Submitted).is_err());
    }
}
