//! Per-agent egress allowlists: the hosts an agent's app sessions may reach.
//!
//! A user can limit an agent to a short list of hosts (`example.com`) and
//! domains (`*.example.com`). The list is node-local policy, stored by agent id
//! in [`store::AllowlistStore`] and edited through
//! `/api/agents/:id/egress-allowlist` ([`api`]).
//!
//! Core delivers it through the generic ext proxy: on every verified agent-lane
//! hop it stamps the agent's current list in
//! [`crate::sidecar::ext_proxy::HDR_CALLER_EGRESS_ALLOWLIST`], after stripping
//! any copy the caller sent. The list is also bound into the agent-lane proof
//! (see `sidecar::ext_proxy::lane`), so a proof minted under one policy does not
//! verify after the policy changed, and a store that cannot be read refuses the
//! agent's requests instead of sending them unrestricted. An app that runs
//! network sessions for agents (the browser app's Bot lanes, for one) enforces
//! the list in its own egress path. Core has no per-app branch for it.
//!
//! An agent with no stored list is unrestricted, as before this policy
//! existed. An empty list allows no host at all.

pub mod api;
pub mod store;

#[cfg(test)]
mod api_tests;
#[cfg(test)]
mod tests;

use std::net::IpAddr;
use std::sync::OnceLock;

/// Most host patterns one agent may carry. Apps reject a longer list.
pub const MAX_PATTERNS: usize = 32;

/// Longest DNS name a pattern may name.
const MAX_HOST_LENGTH: usize = 253;

/// Longest agent id the store accepts.
const MAX_AGENT_ID_LENGTH: usize = 256;

const WILDCARD_PREFIX: &str = "*.";

/// Why an allowlist or agent id was refused. The message is safe to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistError(pub String);

impl std::fmt::Display for AllowlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AllowlistError {}

fn refuse(message: &str) -> AllowlistError {
    AllowlistError(message.to_owned())
}

/// Normalize one destination host: lowercase, IDNA (punycode), no trailing
/// dot, IPv6 without brackets. `None` for anything that is not a plain host
/// (ports, paths, userinfo, escapes and whitespace included).
pub fn normalize_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_suffix('.').unwrap_or(trimmed);
    if trimmed.is_empty() || trimmed.len() > MAX_HOST_LENGTH {
        return None;
    }
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    if bare
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '@' | '\\' | '%'))
    {
        return None;
    }
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    if bare.contains(':') {
        return None;
    }
    let host = url::Host::parse(bare).ok()?;
    let url::Host::Domain(domain) = host else {
        // `url` reads some numeric forms (`0x7f.1`) as IPv4. Only the canonical
        // dotted form above is an accepted address.
        return None;
    };
    let domain = domain.to_ascii_lowercase();
    let valid_label = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    (domain.len() <= MAX_HOST_LENGTH && domain.split('.').all(valid_label)).then_some(domain)
}

fn normalize_pattern(raw: &str) -> Result<String, AllowlistError> {
    let pattern = raw.trim().to_ascii_lowercase();
    let (wildcard, host) = match pattern.strip_prefix(WILDCARD_PREFIX) {
        Some(rest) => (true, rest),
        None => (false, pattern.as_str()),
    };
    let normalized = normalize_host(host)
        .filter(|host| !wildcard || (host.parse::<IpAddr>().is_err() && host.contains('.')));
    match normalized {
        Some(host) if wildcard => Ok(format!("{WILDCARD_PREFIX}{host}")),
        Some(host) => Ok(host),
        None => Err(refuse(
            "egress allowlist entries must be a host name or `*.` and a domain",
        )),
    }
}

/// Validate and normalize an allowlist: each entry an exact host or `*.` and a
/// domain, at most [`MAX_PATTERNS`], de-duplicated and sorted. Blank entries
/// are dropped.
pub fn normalize_patterns<S: AsRef<str>>(raw: &[S]) -> Result<Vec<String>, AllowlistError> {
    let entries: Vec<&str> = raw
        .iter()
        .map(AsRef::as_ref)
        .filter(|entry| !entry.trim().is_empty())
        .collect();
    if entries.len() > MAX_PATTERNS {
        return Err(AllowlistError(format!(
            "an egress allowlist may name at most {MAX_PATTERNS} hosts"
        )));
    }
    let mut patterns = entries
        .into_iter()
        .map(normalize_pattern)
        .collect::<Result<Vec<_>, _>>()?;
    patterns.sort();
    patterns.dedup();
    Ok(patterns)
}

/// The header value for a normalized allowlist: the patterns joined by `,`.
/// An empty list is an empty value, which allows no host.
pub fn header_value(patterns: &[String]) -> String {
    patterns.join(",")
}

/// Whether `agent_id` is a usable store key.
pub fn validate_agent_id(agent_id: &str) -> Result<(), AllowlistError> {
    if agent_id.trim().is_empty()
        || agent_id.len() > MAX_AGENT_ID_LENGTH
        || agent_id.chars().any(char::is_control)
    {
        return Err(refuse("the agent id is not valid"));
    }
    Ok(())
}

/// The node's allowlist store, under the data dir's `state/`.
pub fn global() -> &'static store::AllowlistStore {
    static STORE: OnceLock<store::AllowlistStore> = OnceLock::new();
    STORE.get_or_init(|| {
        store::AllowlistStore::at(crate::paths::state_path("agent-egress-allowlists.json"))
    })
}

/// Drop a deleted agent's allowlist from `store`. A later agent that reuses
/// the id must start without it, and the file must not keep lists for agents
/// that no longer exist. A write error is returned for the caller to log;
/// the agent is already gone, so it cannot be undone.
pub fn forget_agent_in(store: &store::AllowlistStore, agent_id: &str) -> anyhow::Result<bool> {
    if validate_agent_id(agent_id).is_err() || store.get(agent_id)?.is_none() {
        return Ok(false);
    }
    store.set(agent_id, None)?;
    Ok(true)
}

/// [`forget_agent_in`] on the node's store, logging a failure. Called from
/// every path that deletes an agent row.
pub fn forget_deleted_agent(agent_id: &str) {
    if let Err(error) = forget_agent_in(global(), agent_id) {
        tracing::warn!(
            "egress allowlist of deleted agent '{agent_id}' was not removed: {error:#}"
        );
    }
}

/// The header value Core stamps for `agent_id` right now: `Ok(None)` when the
/// agent has no allowlist, an error when the store cannot be read.
pub fn current_header_value(agent_id: &str) -> anyhow::Result<Option<String>> {
    Ok(global()
        .get(agent_id)?
        .map(|patterns| header_value(&patterns)))
}
