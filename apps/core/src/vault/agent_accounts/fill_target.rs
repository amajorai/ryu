//! Where a session Box fill may send a value (design
//! `docs/vault-env-session-parity/box-fill-verb/` 1.8): the login URLs
//! (`submit_urls`) of an agent account or an attached item, and the exact
//! page and bind hosts of a fill.
//!
//! In a Box the egress sidecar substitutes a password only in a `POST` to one
//! of these URLs, so they are validated here once for every source:
//! `https`, a host equal to the account's host, its `www.` variant or a
//! subdomain of it, no userinfo, port, query or fragment, and no `.` or `..`
//! path segment (also percent-encoded), at most four.
//!
//! An agent account keeps its login URLs in a plain text field
//! ([`FIELD_SUBMIT_URLS`], space separated). Reading them is metadata: no
//! value is revealed and nothing is audited. Stored URLs are validated again
//! on every read, so an edit through the generic item API cannot widen them.

use anyhow::Result;
use serde_json::json;

use super::{invalid, load, unknown_account, AccountView, PluginSecretStore};
use crate::vault::audit::AuditActor;
use crate::vault::items::ItemPatch;
use crate::vault::VaultError;

/// The account field holding the login URLs.
pub const FIELD_SUBMIT_URLS: &str = "submit_urls";
/// Most login URLs one account or item may carry.
pub const MAX_SUBMIT_URLS: usize = 4;
const MAX_URL_CHARS: usize = 2048;

/// Whether `host` is the account's host, its `www.` variant, or a subdomain.
fn host_belongs(candidate: &str, host: &str) -> bool {
    candidate == host || candidate.ends_with(&format!(".{host}"))
}

fn has_dot_segment(path: &str) -> bool {
    path.split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase().replace("%2e", ".");
        lower == "." || lower == ".."
    })
}

/// One login URL as `https://host/path`, or an error naming the rule.
pub fn validate_submit_url(host: &str, raw: &str) -> Result<String> {
    let raw = raw.trim();
    let refuse = |why: &str| invalid(format!("login URL {why}"));
    if raw.is_empty() || raw.len() > MAX_URL_CHARS || raw.chars().any(char::is_whitespace) {
        return Err(refuse("must be one URL without spaces"));
    }
    let rest = raw
        .get(..8)
        .filter(|scheme| scheme.eq_ignore_ascii_case("https://"))
        .map(|_| &raw[8..])
        .ok_or_else(|| refuse("must use https"))?;
    let path_start = rest.find('/').unwrap_or(rest.len());
    let raw_path = &rest[path_start..];
    if raw.contains(['?', '#']) {
        return Err(refuse("must not carry a query or fragment"));
    }
    if has_dot_segment(raw_path) {
        return Err(refuse("must not hold . or .. path segments"));
    }
    let parsed = url::Url::parse(raw).map_err(|_| refuse("is not a URL"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(refuse("must not carry a user name or password"));
    }
    if parsed.port().is_some() || rest[..path_start].contains(':') {
        return Err(refuse("must not name a port"));
    }
    let url_host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_ascii_lowercase(),
        _ => return Err(refuse("must name a DNS host")),
    };
    if !host_belongs(&url_host, host) {
        return Err(refuse(&format!(
            "must be on {host} or one of its subdomains"
        )));
    }
    let path = if parsed.path().is_empty() {
        "/"
    } else {
        parsed.path()
    };
    Ok(format!("https://{url_host}{path}"))
}

/// Validate a list of login URLs for `host`: at most four, no duplicates.
pub fn validate_submit_urls(host: &str, urls: &[String]) -> Result<Vec<String>> {
    if urls.len() > MAX_SUBMIT_URLS {
        return Err(invalid(format!(
            "an account takes at most {MAX_SUBMIT_URLS} login URLs"
        )));
    }
    let mut out: Vec<String> = Vec::with_capacity(urls.len());
    for raw in urls {
        let url = validate_submit_url(host, raw)?;
        if !out.contains(&url) {
            out.push(url);
        }
    }
    Ok(out)
}

/// The login URLs stored on an account. Entries that no longer validate for
/// `host` are dropped, so a bad edit never widens a fill.
pub fn stored_submit_urls(host: &str, raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .take(MAX_SUBMIT_URLS)
        .filter_map(|url| validate_submit_url(host, url).ok())
        .collect()
}

/// The page hosts of a Box fill for an account bound to `host`: the host and
/// its `www.` variant, compared exactly by Core and the Box's daemon. `None`
/// for a host the Box cannot bind (an address or a single label).
pub fn box_page_hosts(host: &str) -> Option<Vec<String>> {
    let dns = host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.');
    dns.then(|| vec![host.to_owned(), format!("www.{host}")])
}

/// The hosts a Box fill binds: the page hosts and every login URL's host.
pub fn box_bind_hosts(page_hosts: &[String], submit_urls: &[String]) -> Vec<String> {
    let mut hosts = page_hosts.to_vec();
    for url in submit_urls {
        let host = url
            .strip_prefix("https://")
            .and_then(|rest| rest.split('/').next())
            .unwrap_or_default();
        if !host.is_empty() && !hosts.iter().any(|existing| existing == host) {
            hosts.push(host.to_owned());
        }
    }
    hosts
}

/// Whether a Box page is `https` on exactly one of `page_hosts` (no `www.`
/// folding, no loopback allowance, no port).
pub fn box_page_matches(page_url: &str, page_hosts: &[String]) -> bool {
    let Ok(page) = url::Url::parse(page_url.trim()) else {
        return false;
    };
    let host = match page.host() {
        Some(url::Host::Domain(domain)) => domain.to_ascii_lowercase(),
        _ => return false,
    };
    page.scheme() == "https"
        && page.port().is_none()
        && page.username().is_empty()
        && page.password().is_none()
        && page_hosts.iter().any(|allowed| *allowed == host)
}

/// What a Box fill of an agent account needs, read without revealing
/// anything: the account's host and its validated login URLs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountTarget {
    pub host: String,
    pub submit_urls: Vec<String>,
}

/// The fill target of account `id` of `agent_id` (metadata only).
pub async fn account_target(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
) -> Result<AccountTarget> {
    let (_, _, account) = load(store, agent_id, id).await?;
    if account.host.is_empty() {
        return Err(unknown_account(id));
    }
    Ok(AccountTarget {
        host: account.host,
        submit_urls: account.submit_urls,
    })
}

/// A login URL change: the URLs before it and the account after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginUrlChange {
    pub before: Vec<String>,
    pub account: AccountView,
}

/// Set or replace the login URLs of account `id` of `agent_id`, validated
/// as at create; an empty list clears them. The login URLs decide where a
/// Box fill may submit the account's password, so callers audit the change.
///
/// An account created before login URLs has no field for them (item field
/// definitions are immutable) and is refused with a conflict that says to
/// create a new account for the site.
pub async fn set_submit_urls(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
    urls: &[String],
    actor: &AuditActor,
) -> Result<LoginUrlChange> {
    let (coords, view, account) = load(store, agent_id, id).await?;
    let urls = validate_submit_urls(&account.host, urls)?;
    if !view.fields.iter().any(|f| f.def.name == FIELD_SUBMIT_URLS) {
        return Err(VaultError::Conflict(format!(
            "account `{id}` was created before login URLs and cannot hold them; create a new \
             account for {}",
            account.host
        ))
        .into());
    }
    let value = (!urls.is_empty()).then(|| urls.join(" "));
    let patch: ItemPatch = serde_json::from_value(json!({
        "environment": coords.environment,
        "path": coords.path,
        "expectedVersion": view.version,
        "expectedId": view.id,
        "values": { FIELD_SUBMIT_URLS: value },
    }))?;
    store.item_patch(&coords.key, patch, actor).await?;
    let (_, _, after) = load(store, agent_id, id).await?;
    Ok(LoginUrlChange {
        before: account.submit_urls,
        account: after,
    })
}

#[cfg(test)]
#[path = "fill_target_tests.rs"]
mod tests;
