//! One rule for every model request that does not go through the Gateway: it may
//! not carry a provider credential (security sweep 21 Nov 2026, finding CE-37).
//!
//! The Gateway adds what a provider hop needs: the provider's no-retention
//! privacy fields, the firewall, the data loss check, budgets and the audit row.
//! A request that leaves Core with a key and without the Gateway has none of
//! them, so it is refused. A keyless endpoint the user named (a local engine)
//! carries no account and stays allowed, whatever its host.
//!
//! Three callers: the chat plane's direct leg after a failed Gateway health
//! probe, the fallback leg of `connect_with_fallback`, and the sub-agent's
//! direct call behind `RYU_ALLOW_GATEWAY_FALLBACK=1`.

/// Shown when a request would take a provider key around the Gateway. It says
/// that the Gateway did not answer in time and that a retry may work, so nobody
/// reads it as a configuration error.
pub(crate) const KEYED_DIRECT_HOP_REFUSAL: &str = "The Gateway did not answer in time, so this request was not sent. A model provider that needs an API key or a password is only reached through the Gateway. Trying again may work.";

/// Whether a request to `base_url` goes to the configured Gateway. The same
/// comparison `connect_openai` uses to decide which hop gets the Gateway-only
/// headers.
pub(crate) fn is_gateway_hop(base_url: &str) -> bool {
    base_url.trim_end_matches('/') == crate::sidecar::gateway::gateway_url().trim_end_matches('/')
}

/// Whether a request to `base_url` with `api_key` would carry a credential: a
/// key that is not empty, userinfo in the address (`https://user:pass@host`),
/// or any query string in the address. Every query string counts, with no list
/// of names, so a key cannot pass under a name the list lacks; a base address
/// with a query string is no working keyless endpoint anyway, because the
/// request path is appended to its text. An address in which no host is read
/// (no scheme, or no web address at all) is judged by its text and counts as
/// keyed when it holds `@` or `?`.
pub(crate) fn hop_carries_credential(base_url: &str, api_key: Option<&str>) -> bool {
    if api_key.is_some_and(|key| !key.is_empty()) {
        return true;
    }
    let address = base_url.trim();
    match reqwest::Url::parse(address) {
        Ok(url) if url.has_host() => {
            !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some_and(|query| !query.is_empty())
        }
        _ => address.contains('@') || address.contains('?'),
    }
}

/// The refusal for a request that would carry a credential to an endpoint that
/// is not the Gateway, or `None` when the request may go out: it goes to the
/// Gateway, or it is keyless.
pub(crate) fn keyed_direct_hop_refusal(
    base_url: &str,
    api_key: Option<&str>,
) -> Option<&'static str> {
    if is_gateway_hop(base_url) || !hop_carries_credential(base_url, api_key) {
        None
    } else {
        Some(KEYED_DIRECT_HOP_REFUSAL)
    }
}

#[cfg(test)]
#[path = "direct_hop_guard_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "direct_hop_guard_turn_tests.rs"]
mod turn_tests;
