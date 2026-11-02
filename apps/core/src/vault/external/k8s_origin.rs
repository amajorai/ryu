//! Operator pin for the stores that may receive Core's Kubernetes
//! service-account token.
//!
//! `kubernetes` auth POSTs the pod's ambient service-account JWT to the store
//! address. That token is the Core host's own workload identity, not store
//! configuration, so a delegated store admin must not choose where it goes:
//! the operator lists the permitted store origins in
//! [`ENV_K8S_ALLOWED_ORIGINS`], and both store validation and every login
//! refuse any other origin (fail closed when the variable is unset).

use anyhow::{bail, Result};

/// Comma-separated `https://host[:port]` origins that may receive the token.
pub const ENV_K8S_ALLOWED_ORIGINS: &str = "RYU_VAULT_EXTERNAL_K8S_ALLOWED_ORIGINS";

/// Whether `address` is one of the `allowed` origins (scheme, host, port).
fn origin_listed(address: &url::Url, allowed: &str) -> bool {
    let origin = address.origin();
    origin.is_tuple()
        && allowed
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .filter_map(|entry| url::Url::parse(entry).ok())
            .any(|entry| entry.origin() == origin)
}

/// Refuse to send the service-account token to `address` unless the
/// operator pinned its origin.
pub fn check(address: &url::Url) -> Result<()> {
    let allowed = std::env::var(ENV_K8S_ALLOWED_ORIGINS).unwrap_or_default();
    if !origin_listed(address, &allowed) {
        bail!(
            "kubernetes auth sends the Core host's service-account token, so the store origin \
             must be listed in {ENV_K8S_ALLOWED_ORIGINS} on the Core host"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::origin_listed;

    fn url(text: &str) -> url::Url {
        url::Url::parse(text).unwrap()
    }

    #[test]
    fn only_listed_origins_match() {
        let allowed = " https://vault.example.com , https://bao.example.com:8200/";
        assert!(origin_listed(
            &url("https://vault.example.com/team"),
            allowed
        ));
        assert!(origin_listed(
            &url("https://vault.example.com:443"),
            allowed
        ));
        assert!(origin_listed(&url("https://bao.example.com:8200"), allowed));
        assert!(!origin_listed(&url("https://bao.example.com"), allowed));
        assert!(!origin_listed(&url("https://attacker.example"), allowed));
        assert!(!origin_listed(&url("http://vault.example.com"), allowed));
        assert!(!origin_listed(
            &url("https://vault.example.com.evil"),
            allowed
        ));
        assert!(!origin_listed(&url("https://vault.example.com"), ""));
        assert!(!origin_listed(
            &url("https://vault.example.com"),
            "not a url,*"
        ));
    }
}
