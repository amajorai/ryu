//! Domain-keyed elicitation signal (Unit 3, #521).
//!
//! Generalizes the Composio-specific "you must connect this account first"
//! detection into a provider-agnostic, **domain-keyed** signal resolved against
//! the Identity Vault [`IdentityStore`](crate::identity::IdentityStore). Any tool
//! that targets a `NEEDS_AUTH` domain can call [`needs_connection`] and surface
//! the same `__ryu_elicitation__` envelope the PTC invoker already pauses on (see
//! [`crate::tool_exec::invoker::detect_elicitation`]).
//!
//! ## Two detectors, one builder
//!
//! There are two *different* detectors that share only the final envelope
//! construction:
//!
//! - Composio's `detect_elicitation(status, body)` inspects an HTTP *response*
//!   (`apps/core/src/sidecar/mcp/composio.rs`).
//! - [`needs_connection`] queries the *vault* (this module).
//!
//! They do not compose — Composio does not call [`needs_connection`]. What is
//! shared is only the envelope assembly, extracted here as [`to_envelope`], which
//! Composio is refactored to reuse with **no behavior change** (the emitted JSON
//! is byte-identical to its previous hand-rolled `json!`).
//!
//! ## Nothing hardcoded
//!
//! The login URL comes from the per-domain [`CredentialSourceRegistry`] (seeded
//! from `RYU_IDENTITY_DEFAULT_SOURCE` via `from_env`), so no domain is
//! special-cased and the backend is swappable. See `docs/identity-vault-spec.md`
//! §7.

use serde_json::{json, Value};

use crate::identity::source::{CredentialSourceRegistry, LoginKind};
use crate::identity::{ConnectionStatus, IdentityStore};
use crate::tool_exec::Elicitation;

/// Build the `__ryu_elicitation__` envelope JSON from a typed [`Elicitation`].
///
/// The shared builder both detectors funnel through. Emits exactly `kind` and
/// `message`, plus `url` / `requested_schema` **only when present** — this keeps
/// the Composio envelope byte-identical to its previous hand-rolled shape (the
/// Composio elicitation never carries `url=None`+`requested_schema`, so those
/// keys stay omitted as before).
pub fn to_envelope(elicit: &Elicitation) -> Value {
    let mut inner = json!({
        "kind": elicit.kind,
        "message": elicit.message,
    });
    if let Some(url) = &elicit.url {
        inner["url"] = json!(url);
    }
    if let Some(schema) = &elicit.requested_schema {
        inner["requested_schema"] = schema.clone();
    }
    json!({ "__ryu_elicitation__": inner })
}

/// Domain-keyed connection signal: if the Identity Vault holds a `NEEDS_AUTH`
/// connection for `domain`, return an [`Elicitation`] carrying the login flow so
/// the caller can pause and let the user complete login. Returns `None` when:
///
/// - the global [`IdentityStore`] is not initialized (vault disabled);
/// - no connection exists for `domain` (the domain is not vault-managed);
/// - the connection is `AUTHENTICATED` (no login needed).
///
/// **Non-mutating** — this is a read-only signal. Flow-state transitions belong
/// to the login route, not here.
///
/// ### v1 scoping
///
/// Per `docs/identity-vault-spec.md` §8, agent→profile binding lands in a later
/// unit; "domain-keyed" here means the first `NEEDS_AUTH` connection for `domain`
/// across all profiles. The store exposes no find-by-domain, so this filters
/// [`IdentityStore::list`] (surgical: no store change).
pub async fn needs_connection(domain: &str) -> Option<Elicitation> {
    let store = crate::identity::global()?;
    let registry = CredentialSourceRegistry::from_env();
    needs_connection_with(store, &registry, domain).await
}

/// Testable core of [`needs_connection`] with the store + registry injected, so a
/// unit test can exercise it without the process-global.
pub(crate) async fn needs_connection_with(
    store: &IdentityStore,
    registry: &CredentialSourceRegistry,
    domain: &str,
) -> Option<Elicitation> {
    let connections = store.list().await.ok()?;
    // A domain is vault-managed iff a connection exists; signal only when it is
    // NEEDS_AUTH (an AUTHENTICATED connection needs no login).
    connections
        .into_iter()
        .find(|c| c.domain == domain && c.status == ConnectionStatus::NeedsAuth)?;

    // Resolve a login URL via the per-domain backend (nothing hardcoded). A
    // hosted backend hands back a URL; a manual one has none (the user imports
    // out-of-band) — in both cases `kind` stays `"url"`, matching Composio's
    // no-URL case.
    let url = match registry.resolve(domain).begin_login(domain).await {
        Ok(flow) => match flow.kind {
            LoginKind::Hosted { url } => Some(url),
            LoginKind::Manual => None,
        },
        // A backend that can't start a flow (e.g. a stubbed source) still yields
        // a NEEDS_AUTH signal — just without a URL the user can click.
        Err(_) => None,
    };

    let message =
        format!("This action needs a connection to `{domain}`. Connect that account, then retry.");
    Some(Elicitation {
        kind: "url".to_owned(),
        message,
        url,
        requested_schema: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::source::CredentialSourceRegistry;
    use crate::identity::{IdentityStore, SecretState};

    /// Seed the process-global cipher with a deterministic test key so
    /// `seal`/`open` work without an OS keychain (mirrors Unit 0's helper).
    fn ensure_test_cipher() {
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        // SAFETY: a fixed test constant, set never unset; tests run per-process.
        unsafe {
            std::env::set_var("RYU_MASTER_KEY", key);
        }
    }

    #[test]
    fn to_envelope_matches_composio_shape_with_url() {
        let elicit = Elicitation {
            kind: "url".to_owned(),
            message: "connect github".to_owned(),
            url: Some("https://composio.dev/connect/abc".to_owned()),
            requested_schema: None,
        };
        let env = to_envelope(&elicit);
        let inner = &env["__ryu_elicitation__"];
        assert_eq!(inner["kind"], "url");
        assert_eq!(inner["message"], "connect github");
        assert_eq!(inner["url"], "https://composio.dev/connect/abc");
        // No requested_schema key when None.
        assert!(inner.get("requested_schema").is_none());
    }

    #[test]
    fn to_envelope_omits_url_when_none() {
        let elicit = Elicitation {
            kind: "url".to_owned(),
            message: "connect slack".to_owned(),
            url: None,
            requested_schema: None,
        };
        let env = to_envelope(&elicit);
        let inner = &env["__ryu_elicitation__"];
        assert_eq!(inner["kind"], "url");
        // url key omitted entirely when None (the Composio no-url invariant).
        assert!(inner.get("url").is_none());
    }

    #[tokio::test]
    async fn needs_connection_none_when_authenticated() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let registry = CredentialSourceRegistry::default();
        let conn = store.create("prof", "app.example.com", None).await.unwrap();
        store
            .import_state(&conn.id, &SecretState::new("cookie=x".to_owned()))
            .await
            .unwrap();

        // AUTHENTICATED → no elicitation.
        assert!(needs_connection_with(&store, &registry, "app.example.com")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn needs_connection_none_for_unknown_domain() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let registry = CredentialSourceRegistry::default();
        store.create("prof", "a.example.com", None).await.unwrap();
        // A domain the vault does not manage → None.
        assert!(
            needs_connection_with(&store, &registry, "other.example.com")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn needs_connection_signals_on_needs_auth() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let registry = CredentialSourceRegistry::default();
        store.create("prof", "app.netflix.com", None).await.unwrap();

        let elicit = needs_connection_with(&store, &registry, "app.netflix.com")
            .await
            .expect("NEEDS_AUTH domain must elicit");
        assert_eq!(elicit.kind, "url");
        assert!(elicit.message.contains("app.netflix.com"));
        // Manual (default) backend has no hosted URL.
        assert!(elicit.url.is_none());

        // The envelope round-trips through the shared builder.
        let env = to_envelope(&elicit);
        assert_eq!(env["__ryu_elicitation__"]["kind"], "url");
    }
}
