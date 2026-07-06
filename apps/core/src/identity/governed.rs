//! Gateway-governed credential reads (Unit 5, #523).
//!
//! The [`IdentityStore`] (in `store.rs`) is pure, gateway-agnostic storage: it
//! seals and opens credential state but enforces no policy. Per `CLAUDE.md` §1,
//! *whether a credential may be read* is a Gateway concern (the moat: scope +
//! audit). This module is the thin governance wrapper that ties the two together
//! so every actual credential read is:
//!
//!   1. **grant-gated, fail-closed** — Core asks the Gateway to validate the
//!      `identity.read` grant (`check_identity_grant`). A denied grant or an
//!      unreachable gateway refuses the read (unless `RYU_ALLOW_GATEWAY_FALLBACK`
//!      is set), so Core never approves a read on its own.
//!   2. **audited, best-effort** — the read emits a `credential_read` audit row
//!      through the same Gateway exec-audit path other governed work uses
//!      (`report_credential_read_audit`), queryable by session. The audit payload
//!      carries only the domain + source — **never** the decrypted credential.
//!
//! This is the single chokepoint later units (the tool-call-time credential
//! consumer, the elicitation seam) call instead of `IdentityStore::open_state`
//! directly. Reading the raw store stays possible for non-egress internals (e.g.
//! the health-check loop re-fetching), but any path where plaintext leaves the
//! vault must go through here.

use anyhow::{bail, Result};

use crate::sidecar::gateway::{
    check_identity_grant, report_credential_read_audit, IdentityGrantOutcome,
};

use super::{IdentityStore, SecretState};

/// The grant scope a credential read requires. Matches the Gateway allowlist
/// entry added in #523 (`apps/gateway/src/governance/mod.rs`).
pub const IDENTITY_READ_SCOPE: &str = "identity.read";

/// Read (decrypt) a connection's sealed credential state through the Gateway
/// governance gate.
///
/// Fail-closed: the `identity.read` grant is validated with the Gateway first;
/// if it is denied (or the gateway is unreachable and fallback is off) the read
/// is refused and nothing is decrypted. On success the plaintext is returned and
/// a best-effort `credential_read` audit row is emitted.
///
/// Returns:
///   - `Ok(Some(state))` — granted and the connection has sealed state.
///   - `Ok(None)`        — granted but the connection has no state to read.
///   - `Err(_)`          — the connection is unknown, or the grant was denied.
///
/// **The returned [`SecretState`] must never be logged or placed in an API
/// response.** `session_id` correlates the audit row to a Core session.
pub async fn read_credential(
    store: &IdentityStore,
    connection_id: &str,
    session_id: Option<String>,
) -> Result<Option<SecretState>> {
    // Resolve the connection first: we need its domain + source for both the
    // grant-context and the audit attribution, and to fail clearly on a bad id.
    let Some(record) = store.get(connection_id).await? else {
        bail!("identity connection `{connection_id}` not found");
    };

    // Fail-closed grant gate. The domain is forwarded only as attribution
    // context (the gateway logs it as `app_id`); no secret is sent.
    match check_identity_grant(IDENTITY_READ_SCOPE, &record.domain).await {
        IdentityGrantOutcome::Allow => {}
        IdentityGrantOutcome::Deny(reason) => {
            bail!("identity read denied for `{}`: {reason}", record.domain);
        }
    }

    // The actual credential read (plaintext leaves the vault here).
    let state = store.open_state(connection_id).await?;

    // Best-effort audit: the read is already authorized, so a gateway blink here
    // only warns. Carries the source + domain, never the decrypted state.
    report_credential_read_audit(&record.source, &record.domain, session_id, None).await;

    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed the process-global cipher with a deterministic test key so the
    /// underlying `open_state` can decrypt without an OS keychain.
    fn ensure_test_cipher() {
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        // SAFETY: a fixed test constant, set never unset; tests run per-process.
        unsafe {
            std::env::set_var("RYU_MASTER_KEY", key);
        }
    }

    /// With no gateway reachable and fail-closed (the default), a credential read
    /// is refused — the moat holds even for a connection that has sealed state.
    #[tokio::test]
    async fn read_is_denied_fail_closed_without_gateway() {
        ensure_test_cipher();
        // Serialize against other gateway-env-mutating tests (process-global vars).
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        // Make sure fallback is OFF for this test (other tests may set it).
        let prev = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        // Point the gateway at an unused loopback port so the check is unreachable.
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");

        let store = IdentityStore::open_in_memory().unwrap();
        let conn = store.create("prof", "app.example.com", None).await.unwrap();
        store
            .import_state(&conn.id, &SecretState::new("cookie=secret".to_owned()))
            .await
            .unwrap();

        let result = read_credential(&store, &conn.id, None).await;
        assert!(
            result.is_err(),
            "fail-closed: an unreachable gateway must deny the read"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            !msg.contains("secret"),
            "error must not leak the credential"
        );

        // Restore env.
        match prev {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
    }

    /// An unknown connection id errors clearly before any grant/read happens.
    #[tokio::test]
    async fn read_unknown_connection_errors() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let result = read_credential(&store, "conn_missing", None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }
}
