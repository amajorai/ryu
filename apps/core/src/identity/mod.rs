//! Identity Vault — crypto-sealed per-domain agent connections (Unit 0, #518).
//!
//! Ryu agents act on the user's behalf on real services (a logged-in dashboard, a
//! paid feed, a channel). The Identity Vault generalizes the Composio-specific
//! login model into a first-class, provider-agnostic identity layer, modeled on
//! [kernel.sh Managed Auth Connections](https://www.kernel.sh/docs/auth/overview):
//!
//! ```text
//! Agent card ──binds──▶ Profile (1) ──has──▶ Connection (N, one per domain) ──▶ Domain
//!                                              status: AUTHENTICATED | NEEDS_AUTH
//! ```
//!
//! A connection's credential state (cookies/token/session) is **encrypted at rest,
//! never returned in API responses, and never sent to the LLM** — the kernel rule.
//!
//! ## Placement (Core vs Gateway)
//!
//! Per `CLAUDE.md` §1, the [`IdentityStore`], the encryption seam
//! ([`crate::crypto::FieldCipher`]), and the lifecycle all decide *what runs*, so
//! they live in Core. The Gateway owns *what is allowed/measured* — the
//! `browser.connect` / `identity.read` grant scopes and the audit record on every
//! credential read. The governed read chokepoint that enforces this lives in
//! [`governed::read_credential`] (#523); the raw [`store::IdentityStore`] stays
//! gateway-agnostic.
//!
//! ## Secret hygiene
//!
//! [`SealedState`] (ciphertext) and [`SecretState`] (decrypted plaintext) are
//! newtypes whose `Debug` is **redacted**: they never print their contents, so a
//! `ConnectionRecord` can derive `Debug`/be logged without leaking credentials.
//! `SecretState::expose` is the single, intentional readout used at seal time.
//!
//! See `docs/identity-vault-spec.md` for the full design.

mod consult;
mod elicitation;
mod governed;
pub mod health;
mod source;
mod store;

pub use consult::{consult_for_tool_call, ConsultOutcome};
pub use elicitation::{needs_connection, to_envelope};
pub use governed::{read_credential, IDENTITY_READ_SCOPE};
pub use health::{HealthEngine, HealthEvent};
pub use source::{
    BrowserToolSource, ComposioSource, CredentialBackend, CredentialSource,
    CredentialSourceRegistry, LoginFlow, LoginKind, ManualImport, DEFAULT_SOURCE_ENV,
};
pub use store::IdentityStore;

use serde::{Deserialize, Serialize};

/// Whether a connection currently holds a usable, live login for its domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectionStatus {
    /// The connection has sealed credential state and is believed live.
    Authenticated,
    /// No (or stale) credentials — a human-in-the-loop login is required.
    NeedsAuth,
}

impl ConnectionStatus {
    /// The wire/storage string (the `SCREAMING_SNAKE_CASE` form).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authenticated => "AUTHENTICATED",
            Self::NeedsAuth => "NEEDS_AUTH",
        }
    }

    /// Parse from storage. Unknown values fail soft to `NeedsAuth` (the safe
    /// default: a connection of unknown state must re-authenticate).
    pub fn from_str(s: &str) -> Self {
        match s {
            "AUTHENTICATED" => Self::Authenticated,
            _ => Self::NeedsAuth,
        }
    }
}

/// Where a connection is in its login flow. Independent of [`ConnectionStatus`]:
/// `flow_status` tracks the *transient* login attempt, `status` the durable result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlowStatus {
    /// No login flow in progress.
    Idle,
    /// A login flow has begun and is awaiting completion (e.g. hosted page).
    InProgress,
    /// The last login flow completed and sealed credentials.
    Done,
    /// The last login flow failed.
    Failed,
}

impl FlowStatus {
    /// The wire/storage string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "IDLE",
            Self::InProgress => "IN_PROGRESS",
            Self::Done => "DONE",
            Self::Failed => "FAILED",
        }
    }

    /// Parse from storage. Unknown values fail soft to `Idle`.
    pub fn from_str(s: &str) -> Self {
        match s {
            "IN_PROGRESS" => Self::InProgress,
            "DONE" => Self::Done,
            "FAILED" => Self::Failed,
            _ => Self::Idle,
        }
    }
}

/// Ciphertext credential state as stored on the row (the `enc:v1:` envelope).
///
/// Wrapped in a newtype with a **redacted `Debug`** so a `ConnectionRecord` can be
/// logged without ever printing the sealed blob. The raw envelope is only readable
/// via [`SealedState::as_str`], which callers must not log. Deliberately **not**
/// `Serialize`/`Deserialize`: the sealed blob must never cross a JSON boundary
/// (it is `#[serde(skip)]`-ed off `ConnectionRecord`), so an accidental
/// `Json(record)` in a later unit cannot leak it.
#[derive(Clone)]
pub struct SealedState(String);

impl SealedState {
    /// Wrap an already-sealed `enc:v1:` envelope string.
    pub fn new(sealed: String) -> Self {
        Self(sealed)
    }

    /// The raw sealed envelope. Intended only for re-storage; never log it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SealedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SealedState(<redacted>)")
    }
}

/// Decrypted credential plaintext (cookies/token/session JSON).
///
/// **Never** appears in `Debug`/`Display`/logs. The only readout is
/// [`SecretState::expose`], used at seal time. Not `Serialize` — it must never be
/// placed in an API response.
#[derive(Clone)]
pub struct SecretState(String);

impl SecretState {
    /// Wrap decrypted credential plaintext.
    pub fn new(plaintext: String) -> Self {
        Self(plaintext)
    }

    /// The decrypted plaintext. The single, intentional readout — callers must
    /// only pass this to the cipher's `seal`/`open` or a credential consumer, and
    /// must never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretState(<redacted>)")
    }
}

/// A single per-domain login belonging to a [`Profile`].
///
/// `encrypted_state` holds the sealed credential envelope ([`SealedState`], whose
/// `Debug` is redacted) so the whole record can derive `Debug`/be logged without
/// leaking credentials. The plaintext never lives on this struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionRecord {
    /// `conn_…` primary key.
    pub id: String,
    /// The identity profile this connection belongs to.
    pub profile_id: String,
    /// The domain this login is for, e.g. `app.netflix.com`. Arbitrary string —
    /// no domain is special-cased.
    pub domain: String,
    /// Durable authentication state.
    pub status: ConnectionStatus,
    /// Transient login-flow state.
    pub flow_status: FlowStatus,
    /// Which `CredentialSource` backend captured this (`manual` default).
    pub source: String,
    /// Sealed credential state (`enc:v1:` envelope). `None` until a login imports
    /// state. **Redacted in `Debug`; `#[serde(skip)]`-ed so it never appears in
    /// any API response body** (the spec §6 invariant), and not loaded from JSON.
    #[serde(skip)]
    pub encrypted_state: Option<SealedState>,
    /// Unix timestamp of the last health check (0 = never checked).
    pub last_checked: i64,
    /// Unix creation timestamp.
    pub created_at: i64,
    /// Unix last-update timestamp.
    pub updated_at: i64,
}

/// A profile is the grouping key — one profile aggregates many per-domain
/// connections, so an agent bound to a profile is "logged in to every connected
/// domain" at once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// The profile id shared by every connection in [`Profile::connections`].
    pub profile_id: String,
    /// The per-domain connections grouped under this profile.
    pub connections: Vec<ConnectionRecord>,
}

// ── Process-global store (set_global/global, like mcp/monitors) ──────────────

/// Process-global identity store, published once at startup from `main.rs`.
///
/// Off-`ServerState` callers — the scheduled health-check loop (a later unit) and
/// the shared elicitation seam — need the store without threading it through, so
/// it is published here and read on demand. Mirrors
/// [`crate::monitors::set_global_engine`] / [`crate::sidecar::mcp`].
static STORE: std::sync::OnceLock<IdentityStore> = std::sync::OnceLock::new();

/// Publish the global identity store. Idempotent: a second call is ignored.
pub fn set_global(store: IdentityStore) {
    let _ = STORE.set(store);
}

/// The global identity store, if it has been published.
pub fn global() -> Option<&'static IdentityStore> {
    STORE.get()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Make sure the process-global cipher is seeded with a deterministic test key
    /// so `seal`/`open` work without an OS keychain. Safe to call repeatedly.
    fn ensure_test_cipher() {
        // The crypto module resolves its key from `RYU_MASTER_KEY` first; set a
        // valid base64 32-byte key so `global_cipher()` is deterministic and never
        // touches the host keychain.
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        // SAFETY: tests are single-threaded per process here and we only set, never
        // unset; the key is a fixed test constant.
        unsafe {
            std::env::set_var("RYU_MASTER_KEY", key);
        }
    }

    #[test]
    fn connection_status_string_round_trips() {
        for status in [ConnectionStatus::Authenticated, ConnectionStatus::NeedsAuth] {
            assert_eq!(ConnectionStatus::from_str(status.as_str()), status);
        }
        // Unknown values fail soft to NeedsAuth (the safe default).
        assert_eq!(
            ConnectionStatus::from_str("garbage"),
            ConnectionStatus::NeedsAuth
        );
    }

    #[test]
    fn flow_status_string_round_trips() {
        for status in [
            FlowStatus::Idle,
            FlowStatus::InProgress,
            FlowStatus::Done,
            FlowStatus::Failed,
        ] {
            assert_eq!(FlowStatus::from_str(status.as_str()), status);
        }
        assert_eq!(FlowStatus::from_str("garbage"), FlowStatus::Idle);
    }

    #[test]
    fn secret_state_debug_is_redacted() {
        let secret = SecretState::new("cookie=hunter2; session=abc".to_owned());
        let rendered = format!("{secret:?}");
        assert!(
            !rendered.contains("hunter2"),
            "SecretState Debug must not leak the plaintext: {rendered}"
        );
        assert!(rendered.contains("redacted"));
        // The intentional readout still works.
        assert_eq!(secret.expose(), "cookie=hunter2; session=abc");
    }

    #[test]
    fn sealed_state_debug_is_redacted() {
        let sealed = SealedState::new("enc:v1:AAAA".to_owned());
        let rendered = format!("{sealed:?}");
        assert!(
            !rendered.contains("enc:v1:AAAA"),
            "must not leak: {rendered}"
        );
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn connection_record_debug_never_leaks_state() {
        let record = ConnectionRecord {
            id: "conn_1".to_owned(),
            profile_id: "prof_1".to_owned(),
            domain: "app.example.com".to_owned(),
            status: ConnectionStatus::Authenticated,
            flow_status: FlowStatus::Done,
            source: "manual".to_owned(),
            encrypted_state: Some(SealedState::new("enc:v1:SUPERSECRETBLOB".to_owned())),
            last_checked: 0,
            created_at: 0,
            updated_at: 0,
        };
        let rendered = format!("{record:?}");
        assert!(
            !rendered.contains("SUPERSECRETBLOB"),
            "record Debug must not leak sealed state: {rendered}"
        );

        // Spec §6 invariant: serializing a record must NEVER emit the sealed blob,
        // so a later unit doing `Json(record)` cannot leak credentials.
        let json = serde_json::to_string(&record).unwrap();
        assert!(
            !json.contains("SUPERSECRETBLOB"),
            "record JSON must not contain sealed state: {json}"
        );
        assert!(
            !json.contains("encrypted_state"),
            "encrypted_state field must be skipped in JSON: {json}"
        );
    }

    #[tokio::test]
    async fn create_seal_open_round_trip() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();

        let conn = store
            .create("prof_1", "app.example.com", None)
            .await
            .unwrap();
        assert_eq!(conn.status, ConnectionStatus::NeedsAuth);
        assert_eq!(conn.flow_status, FlowStatus::Idle);
        assert_eq!(conn.source, "manual");
        assert!(conn.encrypted_state.is_none());

        // Import sealed state → becomes AUTHENTICATED/DONE.
        let raw = SecretState::new("cookie=hunter2; token=xyz".to_owned());
        assert!(store.import_state(&conn.id, &raw).await.unwrap());

        let fetched = store.get(&conn.id).await.unwrap().unwrap();
        assert_eq!(fetched.status, ConnectionStatus::Authenticated);
        assert_eq!(fetched.flow_status, FlowStatus::Done);
        let sealed = fetched.encrypted_state.expect("state sealed");
        // The stored value is the enc envelope, NOT the plaintext.
        assert!(sealed.as_str().starts_with("enc:v1:"));
        assert!(!sealed.as_str().contains("hunter2"));

        // Open round-trips to the exact plaintext.
        let opened = store.open_state(&conn.id).await.unwrap().unwrap();
        assert_eq!(opened.expose(), "cookie=hunter2; token=xyz");
    }

    #[tokio::test]
    async fn status_state_machine_transitions() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let conn = store.create("prof_1", "a.example.com", None).await.unwrap();

        // NEEDS_AUTH → flow IN_PROGRESS during login.
        assert!(store
            .set_flow_status(&conn.id, FlowStatus::InProgress)
            .await
            .unwrap());
        let mid = store.get(&conn.id).await.unwrap().unwrap();
        assert_eq!(mid.status, ConnectionStatus::NeedsAuth);
        assert_eq!(mid.flow_status, FlowStatus::InProgress);

        // import → AUTHENTICATED / DONE.
        store
            .import_state(&conn.id, &SecretState::new("s".to_owned()))
            .await
            .unwrap();
        let auth = store.get(&conn.id).await.unwrap().unwrap();
        assert_eq!(auth.status, ConnectionStatus::Authenticated);
        assert_eq!(auth.flow_status, FlowStatus::Done);
        assert!(auth.last_checked > 0, "import stamps last_checked");

        // Health loop finds it stale → back to NEEDS_AUTH.
        assert!(store.mark_needs_auth(&conn.id).await.unwrap());
        let stale = store.get(&conn.id).await.unwrap().unwrap();
        assert_eq!(stale.status, ConnectionStatus::NeedsAuth);

        // Failed login flow.
        assert!(store
            .set_flow_status(&conn.id, FlowStatus::Failed)
            .await
            .unwrap());
        assert_eq!(
            store.get(&conn.id).await.unwrap().unwrap().flow_status,
            FlowStatus::Failed
        );
    }

    #[tokio::test]
    async fn profiles_group_connections() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        store.create("prof_a", "a.example.com", None).await.unwrap();
        store.create("prof_a", "b.example.com", None).await.unwrap();
        store
            .create("prof_b", "c.example.com", Some("composio"))
            .await
            .unwrap();

        let profiles = store.list_profiles().await.unwrap();
        assert_eq!(profiles.len(), 2);
        let prof_a = profiles.iter().find(|p| p.profile_id == "prof_a").unwrap();
        assert_eq!(prof_a.connections.len(), 2);

        let found = store
            .find("prof_b", "c.example.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.source, "composio");
    }

    #[tokio::test]
    async fn delete_removes_connection() {
        ensure_test_cipher();
        let store = IdentityStore::open_in_memory().unwrap();
        let conn = store.create("p", "d.example.com", None).await.unwrap();
        assert!(store.delete(&conn.id).await.unwrap());
        assert!(store.get(&conn.id).await.unwrap().is_none());
        // Deleting a missing row is a no-op false.
        assert!(!store.delete("conn_missing").await.unwrap());
    }
}
