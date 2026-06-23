//! The default [`CredentialSource`] backends (Unit 1, #519).
//!
//! Three impls live here, all behind the [`CredentialSource`] trait and
//! dispatched through the [`super::CredentialBackend`] enum:
//!
//! - [`ManualImport`] — the **default**: the user pastes a cookie/token, Core
//!   seals it via the Unit 0 cipher, and the connection is `AUTHENTICATED`. No
//!   hosted page, no live re-fetch — the creds live in the vault.
//! - [`ComposioSource`] — Composio connects accounts **on first tool
//!   execution** (the tool path elicits a connect URL) and holds the secret
//!   server-side, so its capture-oriented methods return honest errors pointing
//!   at that path rather than sealing a vault blob it can't produce.
//! - [`BrowserToolSource`] — a wired stub returning a clear `NotImplemented`
//!   error; it is blocked on a browser-capture backend (Ryu ships no browser
//!   engine) and lands in a later unit.
//!
//! Per `CLAUDE.md` "nothing hardcoded": the trait is the swap point and the
//! backend is selected per domain through the registry — no domain is
//! special-cased and no backend is wired in inline.

use anyhow::{bail, Context, Result};

use super::{CredentialSource, LoginFlow, LoginKind};
use crate::crypto::global_cipher;
use crate::identity::{ConnectionStatus, SealedState, SecretState};

/// The default backend: user-provided credential state, sealed at rest.
///
/// The login flow is [`LoginKind::Manual`] — there is no hosted page; the user
/// completes login out-of-band and hands Core the resulting cookie/token, which
/// [`ManualImport::import`] seals. There is no live re-fetch, so
/// [`ManualImport::fetch_state`] reads the already-sealed state from the vault.
#[derive(Debug, Clone, Default)]
pub struct ManualImport;

impl ManualImport {
    /// The backend id (`"manual"`).
    pub const ID: &'static str = "manual";
}

impl CredentialSource for ManualImport {
    fn id(&self) -> &str {
        Self::ID
    }

    async fn begin_login(&self, _domain: &str) -> Result<LoginFlow> {
        // Manual import needs no hosted page: a fresh flow id the caller can
        // correlate, with the Manual kind signalling "collect creds from the
        // user, then call import".
        Ok(LoginFlow {
            flow_id: format!("flow_{}", uuid::Uuid::new_v4().simple()),
            kind: LoginKind::Manual,
        })
    }

    async fn poll(&self, _flow_id: &str) -> Result<ConnectionStatus> {
        // A manual flow only completes when the user imports state (which the
        // store flips to AUTHENTICATED), so a poll before that is NEEDS_AUTH.
        // The transient flow position lives in `FlowStatus`, not here.
        Ok(ConnectionStatus::NeedsAuth)
    }

    async fn import(&self, _domain: &str, raw: SecretState) -> Result<SealedState> {
        // Seal the user-provided plaintext via the Unit 0 cipher. Nothing here
        // logs `raw`; the returned envelope is `enc:v1:…`, never the plaintext.
        let cipher = global_cipher().context("loading the at-rest cipher for manual import")?;
        let sealed = cipher
            .seal(raw.expose())
            .context("sealing manually-imported credential state")?;
        Ok(SealedState::new(sealed))
    }

    async fn fetch_state(&self, profile_id: &str, domain: &str) -> Result<SealedState> {
        // No live re-fetch for the manual backend: the sealed creds already
        // live in the vault, so read them back from the Unit 0 store.
        let store = crate::identity::global()
            .context("identity store not initialized; cannot fetch manual state")?;
        let record = store
            .find(profile_id, domain)
            .await
            .context("looking up the manual connection")?
            .with_context(|| {
                format!("no connection for profile `{profile_id}` and domain `{domain}`")
            })?;
        record
            .encrypted_state
            .with_context(|| format!("connection for `{domain}` has no sealed state (NEEDS_AUTH)"))
    }
}

/// Composio-backed credentials.
///
/// Composio establishes a connected account **on first tool execution**, not by
/// capturing a credential blob into Ryu's vault: when an agent runs a Composio
/// action against an un-connected account, [`crate::sidecar::mcp::composio`]'s
/// `dispatch` detects the connection-required response and returns the
/// `__ryu_elicitation__` connect URL so the user can authorize. Composio then
/// holds the secret **server-side** and re-uses it on the next call.
///
/// That means this `CredentialSource` has nothing to seal or re-fetch: there is
/// no per-domain connect-initiate / connection-status / credential-fetch API
/// exposed to Core (only catalog + `dispatch`), and no domain→toolkit mapping at
/// this seam. So the capture-oriented methods return honest errors that point at
/// the real connect path rather than pretending a vault blob exists, and `poll`
/// mirrors [`ManualImport`] (this backend never observes a connection here). A
/// full vault-style Composio backend is a later unit; see the deferred note.
#[derive(Debug, Clone, Default)]
pub struct ComposioSource;

impl ComposioSource {
    /// The backend id (`"composio"`).
    pub const ID: &'static str = "composio";

    /// Shared, actionable explanation for the capture-oriented methods.
    fn unsupported(method: &str) -> anyhow::Error {
        anyhow::anyhow!(
            "Composio holds credentials server-side and exposes no per-domain {method}; \
             a Composio account is connected on first tool execution, where \
             `sidecar/mcp/composio.rs::dispatch` returns the `__ryu_elicitation__` connect URL \
             — there is no sealed vault blob for the Identity Vault to manage"
        )
    }
}

impl CredentialSource for ComposioSource {
    fn id(&self) -> &str {
        Self::ID
    }

    async fn begin_login(&self, _domain: &str) -> Result<LoginFlow> {
        bail!(Self::unsupported("connect-initiate"))
    }

    async fn poll(&self, _flow_id: &str) -> Result<ConnectionStatus> {
        // This backend never captures a connection into the vault, so it can
        // never observe one becoming AUTHENTICATED here. Mirror the manual
        // backend's safe default rather than erroring on a benign poll.
        Ok(ConnectionStatus::NeedsAuth)
    }

    async fn import(&self, _domain: &str, _raw: SecretState) -> Result<SealedState> {
        bail!(Self::unsupported("credential import"))
    }

    async fn fetch_state(&self, _profile_id: &str, _domain: &str) -> Result<SealedState> {
        bail!(Self::unsupported("credential fetch"))
    }
}

/// Stub backend for an external MCP browser tool (e.g. agentbrowser) capturing
/// a logged-in session. The browser engine itself is out of scope (Ryu ships
/// none) — this is the future seam impl. Wired so the registry resolves it;
/// every method fails with a clear `NotImplemented`.
#[derive(Debug, Clone, Default)]
pub struct BrowserToolSource;

impl BrowserToolSource {
    /// The backend id (`"browser-tool"`).
    pub const ID: &'static str = "browser-tool";
}

impl CredentialSource for BrowserToolSource {
    fn id(&self) -> &str {
        Self::ID
    }

    async fn begin_login(&self, _domain: &str) -> Result<LoginFlow> {
        bail!("CredentialSource 'browser-tool' not implemented yet (Identity Vault epic #517)")
    }

    async fn poll(&self, _flow_id: &str) -> Result<ConnectionStatus> {
        bail!("CredentialSource 'browser-tool' not implemented yet (Identity Vault epic #517)")
    }

    async fn import(&self, _domain: &str, _raw: SecretState) -> Result<SealedState> {
        bail!("CredentialSource 'browser-tool' not implemented yet (Identity Vault epic #517)")
    }

    async fn fetch_state(&self, _profile_id: &str, _domain: &str) -> Result<SealedState> {
        bail!("CredentialSource 'browser-tool' not implemented yet (Identity Vault epic #517)")
    }
}
