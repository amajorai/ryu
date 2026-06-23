//! The **CredentialSource seam** (Unit 1, #519): one swappable adapter every
//! identity backend routes through.
//!
//! A [`CredentialSource`] captures and re-fetches the per-domain login state
//! that the Identity Vault seals. The default is [`ManualImport`] (the user
//! pastes a cookie/token); [`ComposioSource`] and [`BrowserToolSource`] are
//! wired stubs landing in later units. Per `CLAUDE.md` "nothing hardcoded", the
//! backend is resolved **per domain** through [`CredentialSourceRegistry`] with
//! a default (`manual`, overridable via `RYU_IDENTITY_DEFAULT_SOURCE`) and an
//! optional per-domain override map — no domain is special-cased.
//!
//! ## Why a trait *and* an enum
//!
//! Like [`crate::catalog_source`], the trait declares native `async fn` methods
//! (no `async-trait` dependency) so each impl is shape-checked, while the closed
//! [`CredentialBackend`] enum provides match-dispatch for heterogeneous storage
//! in the registry (native async-fn traits are not object-safe). See
//! `docs/identity-vault-spec.md` §5.

mod manual;

pub use manual::{BrowserToolSource, ComposioSource, ManualImport};

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
    /// Stable, machine id for this backend (`"manual"` | `"composio"` |
    /// `"browser-tool"`).
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

/// Closed dispatcher over the built-in backends so the registry can store a
/// heterogeneous set without `dyn` (native async-fn traits are not
/// object-safe). Adding a backend = one variant + four match arms.
#[derive(Debug, Clone)]
pub enum CredentialBackend {
    Manual(ManualImport),
    Composio(ComposioSource),
    BrowserTool(BrowserToolSource),
}

impl CredentialBackend {
    /// Construct a backend from its id, or `None` for an unknown id.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            ManualImport::ID => Some(Self::Manual(ManualImport)),
            ComposioSource::ID => Some(Self::Composio(ComposioSource)),
            BrowserToolSource::ID => Some(Self::BrowserTool(BrowserToolSource)),
            _ => None,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Manual(s) => s.id(),
            Self::Composio(s) => s.id(),
            Self::BrowserTool(s) => s.id(),
        }
    }

    pub async fn begin_login(&self, domain: &str) -> Result<LoginFlow> {
        match self {
            Self::Manual(s) => s.begin_login(domain).await,
            Self::Composio(s) => s.begin_login(domain).await,
            Self::BrowserTool(s) => s.begin_login(domain).await,
        }
    }

    pub async fn poll(&self, flow_id: &str) -> Result<ConnectionStatus> {
        match self {
            Self::Manual(s) => s.poll(flow_id).await,
            Self::Composio(s) => s.poll(flow_id).await,
            Self::BrowserTool(s) => s.poll(flow_id).await,
        }
    }

    pub async fn import(&self, domain: &str, raw: SecretState) -> Result<SealedState> {
        match self {
            Self::Manual(s) => s.import(domain, raw).await,
            Self::Composio(s) => s.import(domain, raw).await,
            Self::BrowserTool(s) => s.import(domain, raw).await,
        }
    }

    pub async fn fetch_state(&self, profile_id: &str, domain: &str) -> Result<SealedState> {
        match self {
            Self::Manual(s) => s.fetch_state(profile_id, domain).await,
            Self::Composio(s) => s.fetch_state(profile_id, domain).await,
            Self::BrowserTool(s) => s.fetch_state(profile_id, domain).await,
        }
    }
}

/// Resolves a [`CredentialBackend`] per domain. The default backend applies to
/// any domain without an explicit override; per-domain overrides let one domain
/// use a different backend (e.g. `app.netflix.com → browser-tool`). "Nothing
/// hardcoded": the default seeds from [`DEFAULT_SOURCE_ENV`], falling back to
/// `manual`, and overrides are data, not code. Cheap to clone (`Arc` inside).
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

    #[tokio::test]
    async fn browser_tool_backend_returns_not_implemented() {
        // BrowserTool is genuinely blocked on a capture backend (Ryu ships no
        // browser engine), so it stays an explicit NotImplemented stub.
        let err = CredentialBackend::BrowserTool(BrowserToolSource)
            .begin_login("app.example.com")
            .await
            .expect_err("stub must not succeed");
        assert!(
            err.to_string().contains("not implemented"),
            "expected a NotImplemented error, got: {err}"
        );
    }

    #[tokio::test]
    async fn composio_backend_explains_server_side_credentials() {
        // Composio is connect-on-execute (the tool path elicits a connect URL);
        // capture-oriented methods fail honestly, and `poll` mirrors manual.
        let backend = CredentialBackend::Composio(ComposioSource);
        let err = backend
            .begin_login("app.example.com")
            .await
            .expect_err("composio capture must not succeed");
        assert!(
            err.to_string().contains("server-side"),
            "expected the server-side explanation, got: {err}"
        );
        // A benign poll is NEEDS_AUTH, not an error (this backend never observes
        // a connection here).
        assert_eq!(
            backend.poll("flow_abc").await.unwrap(),
            ConnectionStatus::NeedsAuth
        );
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

    #[test]
    fn registry_per_domain_override_resolves() {
        let registry = CredentialSourceRegistry::with_default(ManualImport::ID)
            .with_override("app.netflix.com", BrowserToolSource::ID)
            .unwrap()
            .with_override("notion.so", ComposioSource::ID)
            .unwrap();

        // Overridden domains resolve to their backend.
        assert_eq!(registry.source_id_for("app.netflix.com"), "browser-tool");
        assert!(matches!(
            registry.resolve("app.netflix.com"),
            CredentialBackend::BrowserTool(_)
        ));
        assert!(matches!(
            registry.resolve("notion.so"),
            CredentialBackend::Composio(_)
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
