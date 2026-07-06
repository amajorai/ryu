//! Tool-call-time Identity Vault consult (Unit 6, #517 close).
//!
//! This is the seam that finally *uses* the two primitives the rest of the epic
//! built but left unwired: [`needs_connection`](super::needs_connection) and
//! [`read_credential`](super::read_credential). It is called from the single tool
//! dispatch chokepoint ([`crate::sidecar::mcp::McpRegistry::call_tool_with_user`])
//! so it covers **both** planes (the ACP MCP bridge fallthrough and the PTC
//! invoker) plus the HTTP `call_mcp_tool` handler with one wiring.
//!
//! ## What it does
//!
//! Given the agent's bound identity profiles (`AgentRecord.identity_profile_ids`,
//! resolved via `resolve_binding`) and a tool call, it:
//!
//! 1. Extracts the **target domain** of the call (the exact host of a `url`/`domain`
//!    argument; v1 = exact host match, see below).
//! 2. Looks up that domain among the bound profiles' connections.
//! 3. If a bound connection is **`NEEDS_AUTH`** → returns [`ConsultOutcome::Elicit`]
//!    carrying the same `__ryu_elicitation__` envelope Composio returns, so the
//!    caller surfaces it as the tool result (PTC `detect_elicitation` → `Suspend`;
//!    chat/ACP plane surfaces it as the tool-result text). The tool is **not**
//!    dispatched.
//! 4. If a bound connection is **`AUTHENTICATED`** → reads the credential through
//!    the gateway-governed [`read_credential`] gate (grant `identity.read` +
//!    audit). The decrypted [`SecretState`] is consumed only here; it is **never**
//!    returned in [`ConsultOutcome`] and **never** placed in the tool result the
//!    LLM sees (the 3-layer invariant). The call proceeds.
//!
//! ## v1 scoping (honest boundaries)
//!
//! - **Domain trigger** is an *exact host match* extracted from a `url`/`domain`
//!   arg. No public-suffix / registrable-domain fuzzy matching (that adds a dep and
//!   is overreach for the "browse a logged-in dashboard" case). A tool call with no
//!   url/domain arg, or whose host is not a bound connection, simply proceeds.
//! - **Composio is skipped** (`composio__…` ids): it owns its own connection-required
//!   path (`mcp::composio::detect_elicitation`); running both would collide.
//! - **Credential consumption is a remaining seam.** v1's only live
//!   [`CredentialSource`](super::CredentialSource) is `ManualImport`; the
//!   `BrowserTool`/`Composio` capture backends are stubs (spec §5/§12), so there is
//!   no real consumer yet that knows how to splice a cookie into a specific tool's
//!   request. This seam therefore *reads + audits* the credential at the boundary
//!   (proving the governed path) but does not arg-splice it; a browser-tool
//!   consumer is the follow-up. The read still matters: it exercises the
//!   `identity.read` grant + audit on every authenticated tool hit.
//! - **Fail-closed read → proceed without the credential.** If the grant read is
//!   denied (e.g. an unreachable dev gateway), the tool call proceeds *without* the
//!   credential rather than hard-failing — the tool then returns its own auth error
//!   instead of every browsing call dying on a gateway blink. The `NEEDS_AUTH`
//!   elicitation path is unaffected (it never reads a credential).

use serde_json::Value;

use super::{read_credential, ConnectionStatus, IdentityStore, SecretState};

/// Tools that know how to *consume* a vault credential (splice it into their
/// outbound request). For these — and only these — the consult returns the
/// decrypted secret ([`ConsultOutcome::ProceedWithCredential`]) so the dispatcher
/// can hand it to the tool out-of-band. Every other authenticated tool still has
/// its credential read+audited (exercising the `identity.read` grant) but the
/// secret is dropped, keeping the secret's blast radius to known consumers.
const INJECTION_CAPABLE_TOOLS: &[&str] = &[crate::sidecar::mcp::web_fetch::GET_TOOL_ID];

/// Whether `tool_id` is a credential-consuming tool (see [`INJECTION_CAPABLE_TOOLS`]).
fn is_injection_capable(tool_id: &str) -> bool {
    INJECTION_CAPABLE_TOOLS.contains(&tool_id)
}

/// What the vault consult decided for one tool call.
///
/// Note: [`ConsultOutcome::ProceedWithCredential`] carries a decrypted
/// [`SecretState`]. The enum is internal to Core's dispatch path — it is never
/// serialized, returned in an API response, or logged. `SecretState`'s `Debug` is
/// redacted, so even an accidental `{:?}` cannot leak it.
pub enum ConsultOutcome {
    /// No bound domain matched (or an authenticated read was handled but the tool
    /// is not a credential consumer): dispatch the tool normally.
    Proceed,
    /// A bound domain is `AUTHENTICATED` and the tool is credential-consuming:
    /// dispatch normally, but hand this decrypted credential to the tool so it can
    /// act AS the user. The secret must be consumed server-side and never reach the
    /// model or any log (the 3-layer invariant).
    ProceedWithCredential(SecretState),
    /// A bound domain is `NEEDS_AUTH`: do NOT dispatch; return this
    /// `__ryu_elicitation__` envelope as the tool result so the caller pauses for
    /// login (mirrors Composio's connection-required result).
    Elicit(Value),
}

/// Extract the target domain (host) of a tool call from its arguments.
///
/// v1 looks at a `url` arg (parsed for its host) then a bare `domain` arg. Returns
/// the lowercased host, or `None` when the call carries no addressable target.
fn extract_domain(args: &Value) -> Option<String> {
    if let Some(url) = args.get("url").and_then(Value::as_str) {
        if let Some(host) = host_from_url(url) {
            return Some(host);
        }
    }
    // A bare `domain` arg is taken verbatim (already a host).
    if let Some(domain) = args.get("domain").and_then(Value::as_str) {
        let d = domain.trim().to_lowercase();
        if !d.is_empty() {
            return Some(d);
        }
    }
    None
}

/// Pull the lowercased host out of a URL string without a URL-parsing dep.
///
/// Handles `scheme://host[:port]/path` and bare `host[:port]/path`. Strips any
/// `userinfo@`, the `:port`, and the path. Returns `None` for an empty host.
fn host_from_url(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    // Cut at the first path/query/fragment delimiter.
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Drop any userinfo (`user:pass@host`).
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // Drop the port.
    let host = host_port.split(':').next().unwrap_or(host_port);
    let host = host.trim().to_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Consult the global Identity Vault for a tool call. See module docs.
///
/// Returns [`ConsultOutcome::Proceed`] (the common case) when:
/// - the agent has no bound profiles, or
/// - the vault is not initialized, or
/// - the call carries no addressable domain, or
/// - no bound connection matches the domain, or
/// - a matched connection is `AUTHENTICATED` (the credential is read+audited here).
///
/// Returns [`ConsultOutcome::Elicit`] only when a bound connection for the call's
/// domain is `NEEDS_AUTH`.
pub async fn consult_for_tool_call(
    profile_ids: &[String],
    tool_id: &str,
    args: &Value,
    session_id: Option<String>,
) -> ConsultOutcome {
    // Binding is opt-in: an agent with no bound profiles sees no vault at all.
    if profile_ids.is_empty() {
        return ConsultOutcome::Proceed;
    }
    // Composio owns its own connection-required path; never double-handle it.
    if tool_id.starts_with("composio__") {
        return ConsultOutcome::Proceed;
    }
    let Some(store) = super::global() else {
        return ConsultOutcome::Proceed;
    };
    let Some(domain) = extract_domain(args) else {
        return ConsultOutcome::Proceed;
    };
    consult_with(
        store,
        profile_ids,
        &domain,
        session_id,
        is_injection_capable(tool_id),
    )
    .await
}

/// Testable core of [`consult_for_tool_call`] with the store injected and the
/// domain already extracted, so a unit test can exercise it without the
/// process-global or arg parsing.
pub(crate) async fn consult_with(
    store: &IdentityStore,
    profile_ids: &[String],
    domain: &str,
    session_id: Option<String>,
    inject: bool,
) -> ConsultOutcome {
    // Find the first bound connection for this domain across the agent's profiles.
    let mut matched = None;
    for profile_id in profile_ids {
        match store.find(profile_id, domain).await {
            Ok(Some(conn)) => {
                matched = Some(conn);
                break;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(
                    "identity consult: lookup failed for profile '{profile_id}' domain '{domain}': {e:#}"
                );
            }
        }
    }
    let Some(conn) = matched else {
        // The agent is bound, but not to this domain: nothing to do.
        return ConsultOutcome::Proceed;
    };

    match conn.status {
        ConnectionStatus::NeedsAuth => {
            // Surface the same envelope Composio returns, so the caller pauses for
            // login. Resolve the (manual = no) login URL via the per-domain source
            // registry (nothing hardcoded), against THIS store — not the global —
            // so the decision is deterministic for the connection we just found.
            let registry = super::CredentialSourceRegistry::from_env();
            match super::elicitation::needs_connection_with(store, &registry, domain).await {
                Some(elicit) => ConsultOutcome::Elicit(super::to_envelope(&elicit)),
                // The status said NEEDS_AUTH but the seam could not build an
                // elicitation (vault disabled mid-call etc.) — proceed rather than
                // wedge the tool call.
                None => ConsultOutcome::Proceed,
            }
        }
        ConnectionStatus::Authenticated => {
            // Read (decrypt) the credential through the gateway-governed gate:
            // grant `identity.read` is validated and a `credential_read` audit row
            // is emitted. The plaintext is consumed ONLY here and is never returned
            // to the caller / LLM (the 3-layer invariant).
            match read_credential(store, &conn.id, session_id).await {
                Ok(Some(state)) => {
                    // The governed read happened (grant + audit). Hand the secret
                    // to a credential-consuming tool (e.g. web_fetch) so it can act
                    // AS the user; for every other tool the read still exercises the
                    // grant + audit but the secret is dropped here (never logged,
                    // never returned to the model).
                    if inject {
                        tracing::debug!(
                            "identity consult: injecting authenticated credential into a consuming tool for domain '{domain}'"
                        );
                        ConsultOutcome::ProceedWithCredential(state)
                    } else {
                        tracing::debug!(
                            "identity consult: authenticated credential available for domain '{domain}' (read governed, not consumed)"
                        );
                        ConsultOutcome::Proceed
                    }
                }
                Ok(None) => {
                    // AUTHENTICATED but no sealed state (shouldn't normally happen);
                    // proceed without a credential.
                    ConsultOutcome::Proceed
                }
                Err(e) => {
                    // Fail-closed read denied (e.g. unreachable gateway): proceed
                    // WITHOUT the credential so the tool returns its own auth error
                    // rather than every browsing call dying on a gateway blink. The
                    // error string never carries the secret (governed::read_credential
                    // guarantees that).
                    tracing::warn!(
                        "identity consult: governed read denied for domain '{domain}', proceeding without credential: {e:#}"
                    );
                    ConsultOutcome::Proceed
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{IdentityStore, SecretState};

    /// Seed the process-global cipher with a deterministic test key so
    /// `seal`/`open` work without an OS keychain (mirrors the sibling modules).
    fn ensure_test_cipher() {
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        // SAFETY: a fixed test constant, set never unset; tests run per-process.
        unsafe {
            std::env::set_var("RYU_MASTER_KEY", key);
        }
    }

    #[test]
    fn host_from_url_strips_scheme_port_path_userinfo() {
        assert_eq!(
            host_from_url("https://app.netflix.com/browse"),
            Some("app.netflix.com".to_owned())
        );
        assert_eq!(
            host_from_url("https://user:pass@app.example.com:8443/x?y=1"),
            Some("app.example.com".to_owned())
        );
        // Bare host (no scheme).
        assert_eq!(
            host_from_url("dash.acme.io/path"),
            Some("dash.acme.io".to_owned())
        );
        // Case folded.
        assert_eq!(
            host_from_url("https://APP.Example.COM"),
            Some("app.example.com".to_owned())
        );
        assert_eq!(host_from_url(""), None);
    }

    #[test]
    fn extract_domain_prefers_url_then_domain() {
        assert_eq!(
            extract_domain(&serde_json::json!({ "url": "https://a.example.com/x" })),
            Some("a.example.com".to_owned())
        );
        assert_eq!(
            extract_domain(&serde_json::json!({ "domain": "B.Example.com" })),
            Some("b.example.com".to_owned())
        );
        // No addressable arg → None.
        assert_eq!(
            extract_domain(&serde_json::json!({ "query": "hello" })),
            None
        );
    }

    #[tokio::test]
    async fn consult_proceeds_when_no_bound_profiles() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        // Even with a NEEDS_AUTH connection in the vault, an unbound agent (empty
        // profile list) sees nothing.
        store.create("prof", "app.netflix.com", None).await.unwrap();
        let out = consult_with(&store, &[], "app.netflix.com", None, false).await;
        assert!(matches!(out, ConsultOutcome::Proceed));
    }

    #[tokio::test]
    async fn consult_proceeds_for_unbound_domain() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        store.create("prof", "a.example.com", None).await.unwrap();
        // Bound to prof, but the call targets a different domain.
        let out = consult_with(
            &store,
            &["prof".to_owned()],
            "other.example.com",
            None,
            false,
        )
        .await;
        assert!(matches!(out, ConsultOutcome::Proceed));
    }

    /// The headline NEEDS_AUTH path: a bound profile with a NEEDS_AUTH connection
    /// for the call's domain returns the `__ryu_elicitation__` envelope so the
    /// caller pauses for login.
    #[tokio::test]
    async fn consult_elicits_on_bound_needs_auth() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        // Fresh connection starts NEEDS_AUTH (no sealed state).
        store
            .create("prof_netflix", "app.netflix.com", None)
            .await
            .unwrap();

        let out = consult_with(
            &store,
            &["prof_netflix".to_owned()],
            "app.netflix.com",
            None,
            false,
        )
        .await;
        match out {
            ConsultOutcome::Elicit(env) => {
                let inner = &env["__ryu_elicitation__"];
                assert_eq!(inner["kind"], "url");
                assert!(
                    inner["message"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("app.netflix.com"),
                    "envelope must name the domain: {env}"
                );
            }
            ConsultOutcome::Proceed | ConsultOutcome::ProceedWithCredential(_) => {
                panic!("expected an elicitation for a NEEDS_AUTH domain")
            }
        }
    }

    /// The grant-gated read path: an AUTHENTICATED bound connection. With no
    /// reachable gateway (fail-closed), the governed read is denied, so the consult
    /// proceeds WITHOUT a credential — and crucially the decrypted secret never
    /// appears in the outcome (it cannot: `Proceed` carries no value).
    #[tokio::test]
    async fn consult_authenticated_read_is_grant_gated_and_never_leaks() {
        ensure_test_cipher();
        // Serialize against other gateway-env-mutating tests (process-global vars).
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        // Force fail-closed (an unreachable gateway) so the read is denied.
        let prev_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");

        let store = IdentityStore::open_in_memory().unwrap();
        let conn = store
            .create("prof_dash", "dash.acme.io", None)
            .await
            .unwrap();
        store
            .import_state(&conn.id, &SecretState::new("cookie=topsecret".to_owned()))
            .await
            .unwrap();

        // inject=true (an injection-capable tool): even so, a denied read must NOT
        // yield a credential — it proceeds without one.
        let out = consult_with(
            &store,
            &["prof_dash".to_owned()],
            "dash.acme.io",
            None,
            true,
        )
        .await;
        // Denied read → proceed (the tool will surface its own auth error). The
        // outcome proves no secret leaks: a denied read can never become
        // ProceedWithCredential.
        assert!(
            matches!(out, ConsultOutcome::Proceed),
            "a fail-closed denied read must proceed without the credential, not inject or elicit"
        );

        // Restore env.
        match prev_fallback {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
    }

    /// The headline injection path: an AUTHENTICATED bound connection for a
    /// credential-consuming tool (`inject=true`), with the grant ALLOWED (fallback
    /// on), yields `ProceedWithCredential` carrying the exact decrypted secret so a
    /// consumer (web_fetch) can act AS the user.
    #[tokio::test]
    async fn consult_injects_credential_when_authenticated_and_consuming() {
        ensure_test_cipher();
        // Serialize against other gateway-env-mutating tests (process-global vars).
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        // Fallback ON + an unreachable gateway → the grant check fails OPEN (Allow),
        // so the governed read succeeds without a live gateway.
        let prev_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");

        let store = IdentityStore::open_in_memory().unwrap();
        let conn = store
            .create("prof_dash", "dash.acme.io", None)
            .await
            .unwrap();
        store
            .import_state(&conn.id, &SecretState::new("session=topsecret".to_owned()))
            .await
            .unwrap();

        let out = consult_with(
            &store,
            &["prof_dash".to_owned()],
            "dash.acme.io",
            None,
            true,
        )
        .await;
        match out {
            ConsultOutcome::ProceedWithCredential(secret) => {
                assert_eq!(secret.expose(), "session=topsecret");
            }
            _ => panic!("expected ProceedWithCredential for an authenticated consuming tool"),
        }

        // The same authenticated connection for a NON-consuming tool (inject=false)
        // must NOT surface the credential — it proceeds, read+audited but dropped.
        let out2 = consult_with(
            &store,
            &["prof_dash".to_owned()],
            "dash.acme.io",
            None,
            false,
        )
        .await;
        assert!(
            matches!(out2, ConsultOutcome::Proceed),
            "a non-consuming tool must not receive the credential"
        );

        // Restore env.
        match prev_fallback {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
    }
}
