//! Agent tool-egress SSRF screen.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Agent tool-egress SSRF screen ────────────────────────────────────────────
//
// The first-party guarded_get chain protects Core's own catalog/model/skill
// fetches. Agent browsing tools (the built-in Spider crawl tool) shell out to an
// external binary and would otherwise crawl arbitrary URLs with no Core-side IP
// screening, so http://169.254.169.254/ (cloud metadata) or http://10.0.0.1/
// (RFC1918) would be reachable. `screen_agent_egress_url` is the shared
// pre-dispatch screen for that egress path: it accepts http and https (Spider
// crawls both), reuses the same resolve + is_blocked_ip guard as the first-party
// path, and is enabled by default with a host-allowlist escape hatch.

/// Env var toggling the agent tool-egress SSRF screen. Enabled by default: absent or any
/// non-disable value keeps the screen active. Set to `0`/`false`/`off`/`no`
/// (case-insensitive) to disable.
pub(in crate::server) const ENV_AGENT_EGRESS_SSRF_GUARD: &str = "RYU_AGENT_EGRESS_SSRF_GUARD";
/// Env var holding a comma-separated allowlist of targets that bypass the egress
/// screen (case-insensitive, whitespace-trimmed, empty entries ignored).
///
/// Entries are `host:port` (narrow — that one port only) or bare `host` (wide —
/// every port on that host). Prefer the narrow form: see [`host_is_allowlisted_in`]
/// for why the difference is a security boundary and not a formatting preference.
pub(in crate::server) const ENV_AGENT_EGRESS_ALLOW_HOSTS: &str = "RYU_AGENT_EGRESS_ALLOW_HOSTS";

/// A URL rewritten so it can be put in an error string, a log line, or an API
/// response without carrying a credential with it.
///
/// Two removals, both of which are places hosted MCP providers really do put
/// secrets:
/// - **userinfo** — `https://user:token@host/…` (the `headers` map is not the only
///   way an operator can authenticate a remote server, and a pasted URL is the
///   easiest);
/// - **the query string**, replaced wholesale with `?<redacted>` — Smithery and
///   friends authenticate with `?api_key=…` / `?token=…`, and a per-parameter
///   denylist would be a guessing game against every provider's naming.
///
/// The host and path survive, because the whole reason these strings exist is to
/// tell an operator WHICH server failed, and a message that names neither is not
/// worth printing.
///
/// **Residual, deliberately accepted:** a secret in the PATH still shows (some
/// providers mint per-user endpoints like `/api/mcp/s/<token>/mcp`). Redacting the
/// path would destroy the diagnostic value that justifies logging the URL at all,
/// and unlike userinfo and the query there is no syntactic marker to redact by.
///
/// Operates on the raw string rather than a parsed [`url::Url`], because it is used
/// on inputs that FAILED to parse — which is exactly when the caller is least able
/// to reason about what the string contains.
pub(crate) fn redact_url_for_display(url: &str) -> String {
    let trimmed = url.trim();
    let (head, had_query) = match trimmed.find(['?', '#']) {
        Some(i) => (&trimmed[..i], true),
        None => (trimmed, false),
    };
    let mut out = String::with_capacity(head.len() + 16);
    // The authority is what follows `://` up to the next `/`. Without a scheme
    // separator the whole head is treated as authority-then-path, so a malformed
    // `user:pw@host/x` is redacted too.
    let (prefix, rest) = match head.find("://") {
        Some(i) => head.split_at(i + 3),
        None => ("", head),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    out.push_str(prefix);
    // `rfind`: an `@` may legally appear inside the userinfo itself, and the LAST
    // one is the delimiter.
    match authority.rfind('@') {
        Some(at) => {
            out.push_str("<redacted>@");
            out.push_str(&authority[at + 1..]);
        }
        None => out.push_str(authority),
    }
    out.push_str(path);
    if had_query {
        out.push_str("?<redacted>");
    }
    out
}

/// Pure: is the egress guard enabled for this env value? Pre-installed — only an
/// explicit disable token (`0`/`false`/`off`/`no`, case-insensitive, trimmed)
/// turns it off. Mirrors [`parse_auto_recall_enabled`] so the behavior is
/// unit-testable without mutating process env.
pub(in crate::server) fn agent_egress_guard_enabled_from(val: Option<&str>) -> bool {
    match val {
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        None => true,
    }
}

/// Pure: does the comma-separated allowlist `list` exempt `host` on `port`?
///
/// An entry matches if it equals the host (wide: every port) **or** the exact
/// `host:port` pair (narrow: that port only). Case- and whitespace-insensitive;
/// empty entries are ignored. Unit-testable without env.
///
/// # Why the narrow form exists, and why the docs push people to it
///
/// This one env var is read by TWO consumers with very different threat models:
///
/// 1. this file's [`guarded_post_json`], where the URL is an MCP endpoint an
///    operator configured by hand, and
/// 2. `tool_exec` (`tool_exec/mod.rs`, the `egress_url_arg` screen), where the URL
///    is a **model-supplied tool argument**.
///
/// Consumer 2 is the reason host granularity is too coarse. The blocked-egress
/// message tells a developer to allowlist `127.0.0.1` so their local MCP server on
/// :3000 is reachable; a bare `127.0.0.1` entry then also hands every model-chosen
/// URL the whole loopback interface — Core's own admin surface on :7980 and every
/// other sidecar port included. `127.0.0.1:3000` grants the one port the developer
/// actually meant, and nothing else.
///
/// Bare-host entries still work, deliberately: they are the pre-existing format and
/// silently narrowing them would break running configurations. The refusal message
/// recommends the narrow form so new entries start scoped.
///
/// The comparison is textual against both candidate spellings rather than a parse
/// of the entry, so an IPv6 literal needs no bracket-handling special case — the
/// operator writes the host exactly as it appears in the URL.
pub(in crate::server) fn host_is_allowlisted_in(host: &str, port: u16, list: Option<&str>) -> bool {
    host_is_allowlisted_in_with_mode(host, port, list, true)
}

pub(crate) fn host_is_allowlisted_in_with_mode(
    host: &str,
    port: u16,
    list: Option<&str>,
    allow_bare_host: bool,
) -> bool {
    let Some(list) = list else {
        return false;
    };
    let host_and_port = format!("{host}:{port}");
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            entry.eq_ignore_ascii_case(&host_and_port)
                || (allow_bare_host && entry.eq_ignore_ascii_case(host))
        })
}

/// Runtime wrapper: read [`ENV_AGENT_EGRESS_SSRF_GUARD`] and classify.
pub(crate) fn agent_egress_guard_enabled() -> bool {
    agent_egress_guard_enabled_from(std::env::var(ENV_AGENT_EGRESS_SSRF_GUARD).ok().as_deref())
}

/// Runtime read of [`ENV_AGENT_EGRESS_ALLOW_HOSTS`], shared with the command-tool
/// egress broker (`tool_exec::egress_broker`) so its per-connection screen uses
/// the same allowlist as [`screen_agent_egress_url`].
pub(crate) fn agent_egress_allow_hosts() -> Option<String> {
    std::env::var(ENV_AGENT_EGRESS_ALLOW_HOSTS).ok()
}

/// SSRF egress screen for agent browsing tools that fetch arbitrary URLs.
///
/// Parses `url`, requires an `http`/`https` scheme (rejecting `file://`,
/// `ldap://`, etc.), and — unless the guard is disabled or the host is
/// allowlisted — resolves the host and rejects it if any resolved IP is
/// loopback / RFC1918 private / link-local (incl. 169.254.169.254 metadata) /
/// ULA / CGNAT, reusing [`resolve_guarded_host`]. Returns the parsed URL so the
/// caller can dispatch it.
///
/// For a shell-out crawler this is only the fail-fast pre-dispatch check: the
/// child re-resolves the host itself and follows links Core never saw, so
/// `tool_exec` additionally routes every child connection through the
/// per-invocation `tool_exec::egress_broker` proxy, which re-screens each
/// target with the same guard/allowlist and connects only to the validated,
/// pinned address.
pub(crate) async fn screen_agent_egress_url(url: &str) -> anyhow::Result<url::Url> {
    screen_egress_url_pinned_with_allowlist_mode(
        url,
        agent_egress_guard_enabled(),
        std::env::var(ENV_AGENT_EGRESS_ALLOW_HOSTS).ok().as_deref(),
        false,
    )
    .await
    .map(|(parsed, _)| parsed)
}

/// The env-free core of [`screen_agent_egress_url`]: the whole decision, with the
/// two env-derived inputs passed in.
///
/// Split out so the screen can be asserted without `std::env::set_var`. Core's
/// tests all run in ONE bin-target process, so a test that mutates process env
/// races every other test in the binary — it passes alone and flakes in the
/// suite. The sibling pure helpers ([`agent_egress_guard_enabled_from`],
/// [`host_is_allowlisted_in`]) exist for the same reason; this completes the
/// pattern for the part that actually resolves.
pub(crate) async fn screen_egress_url_with(
    url: &str,
    guard_enabled: bool,
    allow_hosts: Option<&str>,
) -> anyhow::Result<url::Url> {
    screen_egress_url_pinned_with_allowlist_mode(url, guard_enabled, allow_hosts, true)
        .await
        .map(|(parsed, _)| parsed)
}

/// What the screen learned about where a URL actually points.
///
/// The distinction exists because "the screen passed" has two very different
/// meanings, and an in-process fetcher must not conflate them.
pub(crate) enum ScreenedEgress {
    /// The guard resolved the host and validated every address. Pin the client to
    /// EXACTLY these — re-resolving would reopen the rebinding window this closes.
    Pinned(Vec<std::net::SocketAddr>),
    /// The screen passed WITHOUT resolving: the guard is disabled, or the operator
    /// put this host in the allowlist (which is the loopback development case,
    /// where resolution would refuse by design). There is nothing to pin to, and
    /// overriding the exemption would break the case it exists for.
    Exempt,
}

/// [`screen_egress_url_with`], but it also hands back the addresses it validated.
///
/// ## Why the caller must not re-resolve
///
/// The obvious shape — screen the URL, then call [`resolve_guarded_host`] again to
/// build the pin — is unsafe in a way that looks like hardening. It performs TWO
/// independent resolutions and pins to the second, so nothing guarantees the
/// addresses it pins to are the addresses it validated. Worse, if that second
/// resolve is treated as "this must have been exempted" and the failure swallowed,
/// an attacker who controls DNS gets a fail-open: answer with a public address on
/// the screen's lookup (passes), a private one on the pin's lookup (fails, so no
/// pin is applied), and the request then connects to whatever DNS returns at
/// connect time. That is exactly the SSRF the guard exists to stop, reached
/// through the guard.
///
/// Exemption is therefore reported explicitly by [`ScreenedEgress::Exempt`] rather
/// than inferred from a second call's failure, and the validated addresses are
/// threaded out so the pin and the check can never disagree.
pub(crate) async fn screen_egress_url_pinned(
    url: &str,
    guard_enabled: bool,
    allow_hosts: Option<&str>,
) -> anyhow::Result<(url::Url, ScreenedEgress)> {
    screen_egress_url_pinned_with_allowlist_mode(url, guard_enabled, allow_hosts, true).await
}
