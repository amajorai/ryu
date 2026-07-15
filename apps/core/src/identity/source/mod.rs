//! The **CredentialSource seam** (Unit 1, #519): one swappable adapter every
//! identity backend routes through.
//!
//! A [`CredentialSource`] captures and re-fetches the per-domain login state
//! that the Identity Vault seals. [`ManualImport`] (the user pastes a
//! cookie/token) is the **only** backend — every registered backend really
//! works. Per `CLAUDE.md` "nothing hardcoded", the backend is still resolved
//! **per domain** through [`CredentialSourceRegistry`] with a default (`manual`,
//! overridable via `RYU_IDENTITY_DEFAULT_SOURCE`) and an optional per-domain
//! override map — the seam is the swap point; no domain is special-cased.
//!
//! ## Only registered backends are selectable
//!
//! [`CredentialBackend::from_id`] is the **single registration point**, and
//! [`is_known_source`] / [`known_source_ids`] are its public read: an id that
//! `from_id` does not know cannot be persisted on a connection
//! ([`crate::identity::IdentityStore::create`] rejects it), cannot be the
//! registry default (`RYU_IDENTITY_DEFAULT_SOURCE` falls back to `manual`), and
//! cannot be a per-domain override ([`CredentialSourceRegistry::with_override`]
//! errors). A backend is therefore either fully implemented and selectable, or
//! it does not exist — **no selectable backend may bail, 500, or be a
//! `NotImplemented` stub**. That rule is why the `browser-tool` and `composio`
//! backends are gone (see below).
//!
//! ## The removed backends
//!
//! **`browser-tool`** used to be registered here with every method returning
//! `NotImplemented`. **`composio`** used to be registered here with
//! `begin_login` / `import` / `fetch_state` all bailing — a *dead vault backend*
//! (Composio holds credentials server-side and connects on first tool execution,
//! so there is no blob for the vault to seal; see [`manual`]'s docs, and note
//! the **live** Composio integration — [`crate::composio_connect`] and
//! [`crate::sidecar::mcp::composio`] — is a different path and is untouched).
//!
//! Both were selectable three ways (the `source` field on
//! `POST /api/identities/connections`, `RYU_IDENTITY_DEFAULT_SOURCE`, and a
//! per-domain override) and each one ended in a runtime error — and, when set as
//! the default, the [`crate::identity::health`] sweep read the erroring
//! `fetch_state` as "session lapsed" and flipped every authenticated connection
//! to `NEEDS_AUTH`. Neither was relocated: Core ships no browser engine, no CDP,
//! and no cookie jar, and neither desktop-automation sidecar can stand in
//! (`ghost` is AX-tree + input + screenshot; `shadow` is screen/audio capture +
//! OCR — no browser storage on either); and Composio's secret never leaves
//! Composio.
//!
//! The genuine in-repo path for a future browser-session capture backend is
//! `apps/extension` (WXT), which can read a domain's cookie jar via
//! `chrome.cookies` and POST it to a Core ingress endpoint — Core seals it
//! exactly like a manual import. That is a new backend id (e.g. `extension`),
//! and it needs an extension change plus a host-permissions/consent decision, so
//! it lands as its own unit. When it does, it becomes a real
//! [`CredentialBackend`] variant here (and its id joins [`KNOWN_SOURCE_IDS`]);
//! until then nothing advertises it.
//!
//! ## Why a trait *and* an enum
//!
//! Like [`crate::catalog_source`], the trait declares native `async fn` methods
//! (no `async-trait` dependency) so each impl is shape-checked, while the closed
//! [`CredentialBackend`] enum provides match-dispatch for heterogeneous storage
//! in the registry (native async-fn traits are not object-safe). See
//! `docs/identity-vault-spec.md` §5.

mod manual;

pub use manual::ManualImport;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};

use crate::identity::{ConnectionStatus, SealedState, SecretState};

/// Env knob overriding the registry's default backend id (defaults `"manual"`).
pub const DEFAULT_SOURCE_ENV: &str = "RYU_IDENTITY_DEFAULT_SOURCE";

/// The fallback backend id when no override and no env knob apply.
const BUILTIN_DEFAULT_SOURCE: &str = ManualImport::ID;

/// How a connection's login is completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginKind {
    /// The backend hands back a URL the user opens to complete login (e.g. a
    /// hosted OAuth page). Polled to completion via [`CredentialSource::poll`].
    Hosted { url: String },
    /// The user logs in out-of-band and imports the resulting credential state
    /// via [`CredentialSource::import`] — no hosted page.
    Manual,
}

/// A started login flow: a correlation id plus how the user completes it.
#[derive(Debug, Clone)]
pub struct LoginFlow {
    /// Correlation id for [`CredentialSource::poll`] (`flow_…`).
    pub flow_id: String,
    /// Whether login is hosted (URL) or manual (import).
    pub kind: LoginKind,
}

/// The seam every identity backend routes through.
///
/// Methods use native `async fn` — see the module note on why there is no
/// `dyn` / `async-trait`. The [`SecretState`] / [`SealedState`] newtypes keep
/// plaintext out of `Debug`/logs; an impl must never log decrypted state.
pub trait CredentialSource: Send + Sync {
    /// Stable, machine id for this backend (today: `"manual"`).
    fn id(&self) -> &str;

    /// Begin a login flow for `domain`, returning how the user completes it.
    async fn begin_login(&self, domain: &str) -> Result<LoginFlow>;

    /// Poll a flow by id; `NEEDS_AUTH` until the flow has captured credentials.
    async fn poll(&self, flow_id: &str) -> Result<ConnectionStatus>;

    /// Seal user-provided credential state for `domain` (the manual path).
    /// Returns the `enc:v1:…` envelope; never logs the plaintext.
    async fn import(&self, domain: &str, raw: SecretState) -> Result<SealedState>;

    /// Re-fetch (or read back) the sealed state for a profile's `domain`. The
    /// returned blob is sealed — **never** decrypt-and-log it.
    async fn fetch_state(&self, profile_id: &str, domain: &str) -> Result<SealedState>;
}

/// A `#[cfg(test)]`-only backend whose `fetch_state` always errors, standing in
/// for a live capture backend that has lost its session.
///
/// The [`crate::identity::health`] sweep resolves backends *through*
/// [`CredentialBackend`] (via the registry), so proving the stale-flip needs a
/// backend the dispatcher can actually resolve — a bare test struct is
/// unreachable from `run_sweep`. This is compiled only under `cfg(test)`, so it
/// is not a selectable source in a real binary.
#[cfg(test)]
#[derive(Debug, Clone, Default)]
pub struct AlwaysStale;

#[cfg(test)]
impl AlwaysStale {
    /// The test backend id (`"always-stale"`).
    pub const ID: &'static str = "always-stale";
}

#[cfg(test)]
impl CredentialSource for AlwaysStale {
    fn id(&self) -> &str {
        Self::ID
    }

    async fn begin_login(&self, _domain: &str) -> Result<LoginFlow> {
        Ok(LoginFlow {
            flow_id: "flow_test".to_owned(),
            kind: LoginKind::Manual,
        })
    }

    async fn poll(&self, _flow_id: &str) -> Result<ConnectionStatus> {
        Ok(ConnectionStatus::NeedsAuth)
    }

    async fn import(&self, _domain: &str, _raw: SecretState) -> Result<SealedState> {
        bail!("test backend `always-stale` never captures state")
    }

    async fn fetch_state(&self, _profile_id: &str, _domain: &str) -> Result<SealedState> {
        bail!("test backend `always-stale`: the live session has lapsed")
    }
}

/// Every backend id [`CredentialBackend::from_id`] resolves — the selectable
/// set. Derived from the backends' own `ID` consts so it cannot drift from the
/// dispatcher, and used for the store's create-time validation, its error
/// message, and the schema migration that normalizes retired ids.
#[cfg(not(test))]
pub const KNOWN_SOURCE_IDS: &[&str] = &[ManualImport::ID];

/// Test builds additionally resolve the [`AlwaysStale`] fixture (see its docs).
#[cfg(test)]
pub const KNOWN_SOURCE_IDS: &[&str] = &[ManualImport::ID, AlwaysStale::ID];

/// The selectable backend ids (see [`KNOWN_SOURCE_IDS`]).
pub fn known_source_ids() -> &'static [&'static str] {
    KNOWN_SOURCE_IDS
}

/// Whether `id` names a backend the dispatcher can resolve. The single source of
/// truth is [`CredentialBackend::from_id`], so an id is "known" iff it maps to a
/// real, fully-implemented backend — never a stub.
pub fn is_known_source(id: &str) -> bool {
    CredentialBackend::from_id(id).is_some()
}

/// Closed dispatcher over the built-in backends so the registry can store a
/// heterogeneous set without `dyn` (native async-fn traits are not
/// object-safe). Adding a backend = one variant + five match arms (`id` +
/// the four trait methods) + its id in [`KNOWN_SOURCE_IDS`].
///
/// **[`from_id`](Self::from_id) is the registration point**: a backend that is
/// not constructible here is not selectable anywhere (store, env default, or
/// per-domain override). Never register a backend whose methods are not really
/// implemented — an unimplemented backend must simply not exist.
#[derive(Debug, Clone)]
pub enum CredentialBackend {
    Manual(ManualImport),
    /// Test-only always-erroring fixture; never resolvable in a real binary.
    #[cfg(test)]
    AlwaysStale(AlwaysStale),
}

impl CredentialBackend {
    /// Construct a backend from its id, or `None` for an unknown id.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            ManualImport::ID => Some(Self::Manual(ManualImport)),
            #[cfg(test)]
            AlwaysStale::ID => Some(Self::AlwaysStale(AlwaysStale)),
            _ => None,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Manual(s) => s.id(),
            #[cfg(test)]
            Self::AlwaysStale(s) => s.id(),
        }
    }

    pub async fn begin_login(&self, domain: &str) -> Result<LoginFlow> {
        match self {
            Self::Manual(s) => s.begin_login(domain).await,
            #[cfg(test)]
            Self::AlwaysStale(s) => s.begin_login(domain).await,
        }
    }

    pub async fn poll(&self, flow_id: &str) -> Result<ConnectionStatus> {
        match self {
            Self::Manual(s) => s.poll(flow_id).await,
            #[cfg(test)]
            Self::AlwaysStale(s) => s.poll(flow_id).await,
        }
    }

    pub async fn import(&self, domain: &str, raw: SecretState) -> Result<SealedState> {
        match self {
            Self::Manual(s) => s.import(domain, raw).await,
            #[cfg(test)]
            Self::AlwaysStale(s) => s.import(domain, raw).await,
        }
    }

    pub async fn fetch_state(&self, profile_id: &str, domain: &str) -> Result<SealedState> {
        match self {
            Self::Manual(s) => s.fetch_state(profile_id, domain).await,
            #[cfg(test)]
            Self::AlwaysStale(s) => s.fetch_state(profile_id, domain).await,
        }
    }
}

/// Resolves a [`CredentialBackend`] per domain. The default backend applies to
/// any domain without an explicit override; per-domain overrides let one domain
/// use a different backend once a second one exists (e.g. a future
/// `app.netflix.com → extension` cookie-jar capture). Today `manual` is the only
/// registered backend, so every domain resolves to it — but the seam stays,
/// because "nothing hardcoded" means the *swap point* is the contract, not the
/// current cardinality. The default seeds from [`DEFAULT_SOURCE_ENV`], falling
/// back to `manual`, and overrides are data, not code. Both entry points
/// validate the id against [`CredentialBackend::from_id`], so an unregistered
/// backend can never be resolved. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct CredentialSourceRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    default_id: String,
    overrides: HashMap<String, String>,
}

impl CredentialSourceRegistry {
    /// Build a registry whose default backend comes from
    /// [`DEFAULT_SOURCE_ENV`] (falling back to `manual` when unset or set to an
    /// unknown id), with no per-domain overrides.
    pub fn from_env() -> Self {
        let default_id = std::env::var(DEFAULT_SOURCE_ENV)
            .ok()
            .filter(|id| CredentialBackend::from_id(id).is_some())
            .unwrap_or_else(|| BUILTIN_DEFAULT_SOURCE.to_owned());
        Self::with_default(default_id)
    }

    /// Build a registry with an explicit default backend id. An unknown id
    /// falls back to `manual` so resolution never fails closed by typo.
    pub fn with_default(default_id: impl Into<String>) -> Self {
        let mut default_id = default_id.into();
        if CredentialBackend::from_id(&default_id).is_none() {
            default_id = BUILTIN_DEFAULT_SOURCE.to_owned();
        }
        Self {
            inner: Arc::new(RegistryInner {
                default_id,
                overrides: HashMap::new(),
            }),
        }
    }

    /// The id of the default backend used for un-overridden domains.
    pub fn default_id(&self) -> &str {
        &self.inner.default_id
    }

    /// Register a per-domain override mapping `domain → backend id`. Returns an
    /// error for an unknown backend id (so a bad override is caught at wiring,
    /// not at tool-call time). Builder-style for ergonomic setup.
    pub fn with_override(
        mut self,
        domain: impl Into<String>,
        source_id: impl Into<String>,
    ) -> Result<Self> {
        let source_id = source_id.into();
        if CredentialBackend::from_id(&source_id).is_none() {
            bail!("unknown CredentialSource backend id `{source_id}`");
        }
        // `Arc::make_mut` keeps the type cheap-to-clone while letting the
        // builder mutate before the registry is shared.
        Arc::make_mut(&mut self.inner)
            .overrides
            .insert(domain.into(), source_id);
        Ok(self)
    }

    /// The backend id that applies to `domain` (the override, else the default).
    pub fn source_id_for(&self, domain: &str) -> &str {
        self.inner
            .overrides
            .get(domain)
            .map(String::as_str)
            .unwrap_or(&self.inner.default_id)
    }

    /// Resolve the [`CredentialBackend`] for `domain`. The resolved id always
    /// maps to a known backend (constructors validate ids), so this never fails.
    pub fn resolve(&self, domain: &str) -> CredentialBackend {
        let id = self.source_id_for(domain);
        CredentialBackend::from_id(id).unwrap_or_else(|| CredentialBackend::Manual(ManualImport))
    }
}

impl Default for CredentialSourceRegistry {
    fn default() -> Self {
        Self::with_default(BUILTIN_DEFAULT_SOURCE)
    }
}

// `RegistryInner` must be `Clone` for `Arc::make_mut` in the builder.
impl Clone for RegistryInner {
    fn clone(&self) -> Self {
        Self {
            default_id: self.default_id.clone(),
            overrides: self.overrides.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ConnectionStatus;

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

    #[tokio::test]
    async fn manual_import_seals_without_leaking_plaintext() {
        ensure_test_cipher();
        let backend = ManualImport;
        let raw = SecretState::new("cookie=hunter2; token=xyz".to_owned());
        let sealed = backend.import("app.example.com", raw).await.unwrap();
        // The envelope is the `enc:v1:` ciphertext, never the plaintext.
        assert!(sealed.as_str().starts_with("enc:v1:"));
        assert!(!sealed.as_str().contains("hunter2"));
        assert!(!sealed.as_str().contains("token=xyz"));
    }

    #[tokio::test]
    async fn manual_begin_login_is_manual_kind() {
        let backend = ManualImport;
        let flow = backend.begin_login("app.example.com").await.unwrap();
        assert_eq!(flow.kind, LoginKind::Manual);
        assert!(flow.flow_id.starts_with("flow_"));
    }

    #[tokio::test]
    async fn manual_poll_is_needs_auth_until_imported() {
        let backend = ManualImport;
        let status = backend.poll("flow_abc").await.unwrap();
        assert_eq!(status, ConnectionStatus::NeedsAuth);
    }

    /// The retired `browser-tool` stub must be unselectable on **every** path:
    /// it cannot be constructed, cannot be the env default, and cannot be a
    /// per-domain override. (A registered-but-unimplemented backend is a trap —
    /// it accepts the selection and only fails at login time.)
    #[test]
    fn browser_tool_is_not_a_selectable_source() {
        assert!(
            CredentialBackend::from_id("browser-tool").is_none(),
            "the browser-tool stub must not be registered"
        );
        assert!(!is_known_source("browser-tool"));
        assert!(!known_source_ids().contains(&"browser-tool"));

        // Env default → falls back to manual instead of arming the stub.
        let registry = CredentialSourceRegistry::with_default("browser-tool");
        assert_eq!(registry.default_id(), ManualImport::ID);

        // Per-domain override → rejected at wiring, not at tool-call time.
        assert!(CredentialSourceRegistry::default()
            .with_override("app.netflix.com", "browser-tool")
            .is_err());
    }

    /// The retired `composio` backend must be unselectable on **every** path.
    /// It was a *dead vault backend*: Composio keeps credentials server-side, so
    /// `begin_login` / `import` / `fetch_state` could only bail — yet all three
    /// selection paths accepted it, and `POST /connections/{id}/login` then 500'd.
    /// (The **live** Composio integration — `composio_connect` + the
    /// `sidecar::mcp::composio` elicitation path — is a different seam and stays.)
    #[test]
    fn composio_is_not_a_selectable_source() {
        assert!(
            CredentialBackend::from_id("composio").is_none(),
            "the dead composio vault backend must not be registered"
        );
        assert!(!is_known_source("composio"));
        assert!(!known_source_ids().contains(&"composio"));

        // RYU_IDENTITY_DEFAULT_SOURCE=composio → falls back to manual, so the
        // health sweep can no longer flip every connection to NEEDS_AUTH on an
        // erroring `fetch_state`.
        let registry = CredentialSourceRegistry::with_default("composio");
        assert_eq!(registry.default_id(), ManualImport::ID);

        // Per-domain override → rejected at wiring, not at tool-call time.
        assert!(CredentialSourceRegistry::default()
            .with_override("notion.so", "composio")
            .is_err());
    }

    /// **The end-state guard.** Every *selectable* backend must really work:
    /// `begin_login` and `poll` — the two calls any selection hits first, and the
    /// ones that returned HTTP 500 for `browser-tool` and `composio` — must
    /// **succeed**, not merely fail with a nicer message.
    ///
    /// This is the invariant the whole registration rule exists to protect, so it
    /// is asserted over the *whole* registered set rather than per-backend: a
    /// future backend added to [`CredentialBackend::from_id`] whose `begin_login`
    /// bails fails here, at the seam, instead of at a user's login click.
    ///
    /// (`import`/`fetch_state` are deliberately not asserted: a *live* backend
    /// may legitimately error there when a real session has lapsed — that is
    /// runtime state, not an unimplemented method. The `AlwaysStale` fixture
    /// models exactly that case.)
    #[tokio::test]
    async fn no_registered_backend_is_a_stub() {
        for id in known_source_ids() {
            let backend = CredentialBackend::from_id(id)
                .unwrap_or_else(|| panic!("known id `{id}` must resolve"));

            let flow = backend.begin_login("app.example.com").await.unwrap_or_else(|e| {
                panic!("selectable backend `{id}` bails on begin_login; it must not be selectable: {e}")
            });
            assert!(flow.flow_id.starts_with("flow_"));

            backend.poll(&flow.flow_id).await.unwrap_or_else(|e| {
                panic!("selectable backend `{id}` bails on poll: {e}")
            });
        }
    }

    #[test]
    fn registry_defaults_to_manual() {
        let registry = CredentialSourceRegistry::default();
        assert_eq!(registry.default_id(), ManualImport::ID);
        assert_eq!(registry.source_id_for("anything.example.com"), "manual");
        assert!(matches!(
            registry.resolve("anything.example.com"),
            CredentialBackend::Manual(_)
        ));
    }

    #[test]
    fn registry_unknown_default_falls_back_to_manual() {
        let registry = CredentialSourceRegistry::with_default("nope-not-a-backend");
        assert_eq!(registry.default_id(), ManualImport::ID);
    }

    /// The per-domain override seam still works with a second registered backend.
    /// `manual` is the only *production* backend today, so this exercises the seam
    /// through the `#[cfg(test)]` [`AlwaysStale`] fixture — the swap point is the
    /// contract, and it must keep working for the next real backend.
    #[test]
    fn registry_per_domain_override_resolves() {
        let registry = CredentialSourceRegistry::with_default(ManualImport::ID)
            .with_override("notion.so", AlwaysStale::ID)
            .unwrap();

        // The overridden domain resolves to its backend.
        assert_eq!(registry.source_id_for("notion.so"), AlwaysStale::ID);
        assert!(matches!(
            registry.resolve("notion.so"),
            CredentialBackend::AlwaysStale(_)
        ));
        // A non-overridden domain still uses the default.
        assert!(matches!(
            registry.resolve("other.example.com"),
            CredentialBackend::Manual(_)
        ));
    }

    #[test]
    fn registry_rejects_unknown_override_backend() {
        let result = CredentialSourceRegistry::with_default(ManualImport::ID)
            .with_override("d.com", "bogus");
        assert!(result.is_err());
    }
}
