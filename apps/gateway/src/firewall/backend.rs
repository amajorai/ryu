//! The swappable firewall backend trait and its live-swap registry.

use super::{FirewallMatch, FirewallScanner};
use crate::config::{FirewallConfig, FirewallPolicy};

// ─── Swappable firewall/DLP backend (W6c decomposition) ──────────────────────

/// The node-level firewall / DLP scanner as a swappable capability. The built-in
/// [`FirewallScanner`] (regex + curated patterns) is the default; an alternative
/// (e.g. an out-of-process DLP engine) can register without touching the pipeline,
/// mirroring the [`crate::budget::BudgetRegistry`] inversion. The trait carries
/// exactly the surface the pipeline / passthrough / API drive through
/// `AppState::with_firewall`. The hierarchical [`resolve::FirewallResolver`] and
/// the inspector stay consumers of the concrete scanner and are unchanged.
pub trait FirewallBackend: Send + Sync {
    /// The live firewall config (for `GET /v1/config` and enable checks).
    fn config(&self) -> &FirewallConfig;
    /// The configured block/warn policy.
    fn policy(&self) -> &FirewallPolicy;
    /// Whether outbound scanning/redaction is enabled.
    fn outbound_enabled(&self) -> bool;
    /// Scan inbound prompt text; `Some` on the first violation.
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch>;
    /// Scan outbound response text; `Some` on the first violation.
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch>;
    /// Scan text against a caller-supplied locked-guardrail allowlist.
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch>;
    /// Redact PII/secrets in a single string (best-effort sanitize).
    fn sanitize(&self, text: &str) -> String;
    /// Redact outbound text, returning the redacted string + the hit pattern names.
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>);
    /// Redact a violation excerpt for storage, ignoring `redact_pii` /
    /// `redact_secrets`; an empty result means the excerpt must be dropped.
    /// `AppState::record_violation` stores only what this returns. The
    /// default keeps a backend without its own redactor on the
    /// sanitize-then-scrub path.
    fn redact_excerpt(&self, text: &str) -> String {
        let sanitized = self.sanitize(text);
        self.redact_outbound(&sanitized).0
    }
}

impl FirewallBackend for FirewallScanner {
    fn config(&self) -> &FirewallConfig {
        FirewallScanner::config(self)
    }
    fn policy(&self) -> &FirewallPolicy {
        FirewallScanner::policy(self)
    }
    fn outbound_enabled(&self) -> bool {
        FirewallScanner::outbound_enabled(self)
    }
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        FirewallScanner::scan_inbound(self, text)
    }
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        FirewallScanner::scan_outbound(self, text)
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        FirewallScanner::scan_locked_guardrails(self, text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        FirewallScanner::sanitize(self, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        FirewallScanner::redact_outbound(self, text)
    }
    fn redact_excerpt(&self, text: &str) -> String {
        FirewallScanner::redact_excerpt(self, text)
    }
}

/// Id-keyed registry over [`FirewallBackend`] implementations with a live-swap
/// discipline, identical in shape to [`crate::budget::BudgetRegistry`]: the
/// built-in [`FirewallScanner`] is registered under [`FirewallRegistry::BUILTIN`]
/// and active by default, so behavior is byte-identical with no config change.
/// `PUT /v1/config` rebuilds the active built-in via [`FirewallRegistry::update_config`];
/// a plugin backend registers + activates through [`FirewallRegistry::register`] /
/// [`FirewallRegistry::set_active`]. All access is via [`FirewallRegistry::with_active`]
/// so a read never outlives a swap.
pub struct FirewallRegistry {
    inner: std::sync::RwLock<FirewallRegistryInner>,
}

struct FirewallRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn FirewallBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn FirewallBackend>,
}

impl FirewallRegistry {
    /// Stable id of the built-in in-process firewall scanner.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`FirewallScanner`] as the default active backend.
    pub fn new(config: FirewallConfig) -> Self {
        let builtin: std::sync::Arc<dyn FirewallBackend> =
            std::sync::Arc::new(FirewallScanner::new(config));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(FirewallRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock), then run `f` against it — the arc holds no lock, matching
    /// the old `with_firewall` closure semantics.
    pub fn with_active<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn FirewallBackend) -> T,
    {
        let active = match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        };
        f(&*active)
    }

    /// Hot-swap the active built-in scanner with one built from a new config.
    /// Only rebuilds the built-in; a non-built-in active backend is left in place.
    pub fn update_config(&self, config: FirewallConfig) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let builtin: std::sync::Arc<dyn FirewallBackend> =
            std::sync::Arc::new(FirewallScanner::new(config));
        guard
            .backends
            .insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        if guard.active_id == Self::BUILTIN {
            guard.active = builtin;
        }
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    #[allow(dead_code)]
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn FirewallBackend>) {
        let id = id.into();
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !guard.backends.contains_key(&id) {
            guard.order.push(id.clone());
        }
        let is_active = id == guard.active_id;
        guard.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            guard.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    pub fn set_active(&self, id: &str) -> bool {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.backends.get(id).map(std::sync::Arc::clone) {
            Some(backend) => {
                guard.active = backend;
                guard.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.
    #[allow(dead_code)]
    pub fn active_id(&self) -> String {
        match self.inner.read() {
            Ok(g) => g.active_id.clone(),
            Err(p) => p.into_inner().active_id.clone(),
        }
    }

    /// The registered backend ids in registration order.
    pub fn available(&self) -> Vec<String> {
        match self.inner.read() {
            Ok(g) => g.order.clone(),
            Err(p) => p.into_inner().order.clone(),
        }
    }
}
