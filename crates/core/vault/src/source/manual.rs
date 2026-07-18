//! The [`CredentialSource`] backends (Unit 1, #519).
//!
//! One impl lives here, behind the [`CredentialSource`] trait and dispatched
//! through the [`super::CredentialBackend`] enum:
//!
//! - [`ManualImport`] — the **default** and the only capture backend: the user
//!   pastes a cookie/token, Core seals it via the Unit 0 cipher, and the
//!   connection is `AUTHENTICATED`. No hosted page, no live re-fetch — the creds
//!   live in the vault.
//!
//! Two backends that used to be registered here are gone, for the same reason:
//! a backend whose methods cannot really run must not be *selectable*, because a
//! caller then picks it and only discovers at login time that it errors.
//!
//! - **`browser-tool`** — a browser-session capture source needs a browser
//!   engine / CDP / cookie jar, and Core ships none (`ghost` is AX-tree + input
//!   + screenshot, `shadow` is screen/audio capture + OCR — neither exposes
//!   browser storage). Every method returned `NotImplemented`.
//! - **`composio`** — a *dead vault backend*, not a dead integration. Composio
//!   connects an account **on first tool execution** and keeps the secret
//!   **server-side**, so there is no blob for the vault to seal, re-fetch, or
//!   health-check: `begin_login` / `import` / `fetch_state` could only ever
//!   error, and as the registry default its erroring `fetch_state` flipped every
//!   authenticated connection to `NEEDS_AUTH` on each [`crate::identity::health`]
//!   sweep. The **live** Composio path is untouched and lives elsewhere:
//!   [`crate::composio_connect`] (`initiate` / `connection_status`) and
//!   [`crate::sidecar::mcp::composio`]'s `dispatch`, which returns the
//!   `__ryu_elicitation__` connect URL; the tool seam skips `composio__…` ids
//!   entirely ([`crate::identity::consult_for_tool_call`]). Wiring Composio in as
//!   a real vault backend would need a domain→toolkit map plus sealed-marker /
//!   health semantics: a separate unit, not a stub.
//!
//! Both were removed from the closed [`super::CredentialBackend`] dispatcher
//! rather than left as traps; see `super`'s module docs for the honest path a
//! real capture backend would take.
//!
//! Per `CLAUDE.md` "nothing hardcoded": the trait is the swap point and the
//! backend is selected per domain through the registry — no domain is
//! special-cased and no backend is wired in inline.

use anyhow::{Context, Result};

use super::{CredentialSource, LoginFlow, LoginKind};
use ryu_crypto::global_cipher;
use crate::{ConnectionStatus, SealedState, SecretState};

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
        let store = crate::global()
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
