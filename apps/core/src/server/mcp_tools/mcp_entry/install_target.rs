//! Forced catalog installs: what the new entry may keep from the entry it
//! replaces, and which remote URLs a catalog entry may name.
//!
//! A catalog entry carries no keys. The keys of an installed server are the
//! `headers` (remote) and `env` (local) values the user saved on its `mcp.json`
//! entry, and they are sent to whatever the entry points at. An update keeps
//! them so the user need not enter them again, but only while the entry still
//! points at the target they were saved for. Both rules here are pure, so the
//! writer and the install route share one definition and the tests need no file.

use crate::server::*;
use crate::sidecar::mcp::{McpServerConfig, McpTransportKind};

/// Scheme, host and port of a remote MCP URL, the three parts that decide which
/// server receives the request headers. The MCP client compares the same three
/// for the legacy SSE message endpoint. `None` when the URL does not parse, has
/// no host, or has a scheme with no known port.
fn remote_origin(url: &str) -> Option<(String, String, u16)> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let port = parsed.port_or_known_default()?;
    Some((parsed.scheme().to_ascii_lowercase(), host, port))
}

/// The program a local entry runs, trimmed. `None` when it names none.
fn local_command(cfg: &McpServerConfig) -> Option<&str> {
    cfg.command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
}

/// Whether a forced catalog install of `new` over `existing` still points at
/// the target the user saved `existing`'s keys for. All of these must hold:
///
/// - `existing` was installed from the same catalog entry: it records a
///   `catalog_id` and it equals `new`'s. A server the user added by hand
///   records none, so a catalog entry that merely has its name never inherits
///   its keys.
/// - Both are remote, or both are local.
/// - Remote: the two URLs have the same origin (scheme, host and port). The
///   path may change, the server that receives the headers may not.
/// - Local: the same `command`. The arguments may change, because every update
///   of a package changes the pinned version in them.
///
/// Anything else is a different server under an old name, and the caller drops
/// the saved `headers`, `env` and `auth` and writes the entry disabled.
pub(in crate::server) fn same_install_target(
    existing: &McpServerConfig,
    new: &McpServerConfig,
) -> bool {
    let catalog_id = |cfg: &McpServerConfig| {
        cfg.catalog_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    };
    let Some(existing_id) = catalog_id(existing) else {
        return false;
    };
    if catalog_id(new).as_deref() != Some(existing_id.as_str()) {
        return false;
    }
    match (existing.transport_kind(), new.transport_kind()) {
        (McpTransportKind::Stdio, McpTransportKind::Stdio) => {
            let command = local_command(existing);
            command.is_some() && command == local_command(new)
        }
        (McpTransportKind::Stdio, _) | (_, McpTransportKind::Stdio) => false,
        _ => {
            let origin = existing.url.as_deref().and_then(remote_origin);
            origin.is_some() && origin == new.url.as_deref().and_then(remote_origin)
        }
    }
}

/// Why a catalog entry's remote `url` may not be installed, or `None` when it
/// may. A catalog remote must be `https`: the entry's saved headers are sent
/// with every request, and over plain `http` anyone on the path reads them.
///
/// The one exception is the exception the MCP client already has for a local
/// development server: a `host:port` (or bare host) the operator listed in
/// `RYU_AGENT_EGRESS_ALLOW_HOSTS`, passed in as `allow_hosts`. Without that
/// entry the client would refuse to call a loopback URL anyway.
pub(in crate::server) fn catalog_remote_url_refusal(
    url: &str,
    allow_hosts: Option<&str>,
) -> Option<String> {
    let shown = redact_url_for_display(url);
    let Ok(parsed) = url::Url::parse(url.trim()) else {
        return Some(format!(
            "the catalog entry's remote URL '{shown}' is not a valid URL"
        ));
    };
    match parsed.scheme() {
        "https" => None,
        "http" => {
            let host = parsed.host_str().unwrap_or_default();
            let port = parsed.port_or_known_default().unwrap_or(80);
            if !host.is_empty() && host_is_allowlisted_in(host, port, allow_hosts) {
                return None;
            }
            Some(format!(
                "the catalog entry's remote URL '{shown}' is plain http, so the server's keys \
                 would be sent unencrypted. A catalog MCP server must use https. For a local \
                 development server, add '{host}:{port}' to {ENV_AGENT_EGRESS_ALLOW_HOSTS} first"
            ))
        }
        other => Some(format!(
            "the catalog entry's remote URL scheme '{other}' is not supported, expected https"
        )),
    }
}

#[cfg(test)]
mod tests;
