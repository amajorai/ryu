//! The swappable firewall backend trait and its live-swap registry.

use std::sync::Arc;

use super::{FirewallMatch, FirewallScanner};
use crate::config::{CustomPatternKind, FirewallConfig, FirewallPolicy};

// ─── Swappable firewall/DLP backend (W6c decomposition) ──────────────────────

/// The node-level firewall / DLP scanner as a swappable capability. The built-in
/// [`FirewallScanner`] (regex + curated patterns) is the default; an alternative
/// (e.g. an out-of-process DLP engine) can register without touching the pipeline,
/// mirroring the [`crate::budget::BudgetRegistry`] inversion. The trait carries
/// exactly the surface the pipeline / passthrough / API drive through
/// `AppState::with_firewall`. The hierarchical [`super::resolve::FirewallResolver`] and
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
    /// Redact PII/secrets in a single string (best-effort sanitize). Must be a
    /// pure function of `text`: the stream rewrite reuses one result. It must
    /// keep the stream's field separator (`\n\0\n`) byte for byte, as must
    /// `redact_outbound`; a rewrite that consumes it masks the frames instead.
    fn sanitize(&self, text: &str) -> String;
    /// Redact outbound text, returning the redacted string + the hit pattern
    /// names. The string must be a pure function of `text`, like `sanitize`.
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>);
    /// Redact a violation excerpt for storage, ignoring `redact_pii` /
    /// `redact_secrets`; an empty result means the excerpt must be dropped.
    /// `AppState::record_violation` stores only what this returns. The
    /// default ([`redact_excerpt_fail_closed`]) gives a backend without its
    /// own redactor a safe path: sanitize, then the outbound scrub, then a
    /// fold-aware survivor check that drops the excerpt if anything survives.
    fn redact_excerpt(&self, text: &str) -> String {
        redact_excerpt_fail_closed(self, text)
    }
}

/// The built-in pattern sets with the default config, compiled once: the
/// survivor check every plugin excerpt passes, whatever the plugin's own
/// detection misses. Its PII and secret scans read the `normalize_for_scan`
/// view, so zero-width, fullwidth, look-alike and TAG obfuscation is seen.
fn builtin_excerpt_scanner() -> &'static FirewallScanner {
    static SCANNER: std::sync::OnceLock<FirewallScanner> = std::sync::OnceLock::new();
    SCANNER.get_or_init(|| FirewallScanner::new_scoped(FirewallConfig::default()))
}

/// Whether PII or a secret survives in `text`: by `backend`'s own `pii` /
/// `secrets` scan, or by the built-in's normalized scan.
fn excerpt_survives<B: FirewallBackend + ?Sized>(backend: &B, text: &str) -> bool {
    let guardrails = ["pii".to_owned(), "secrets".to_owned()];
    if backend.scan_locked_guardrails(text, &guardrails).is_some() {
        return true;
    }
    let (pii, secret) = builtin_excerpt_scanner().companion_survivors(text);
    pii || secret
}

/// The default [`FirewallBackend::redact_excerpt`]: `backend`'s sanitize,
/// then its outbound scrub. A plugin's sanitize rewrites the raw text while
/// obfuscated PII hides from raw patterns, so when anything survives the text
/// is folded with `fold_for_redaction` and scrubbed again; if anything still
/// survives, the excerpt is dropped (empty) rather than stored.
pub(super) fn redact_excerpt_fail_closed<B: FirewallBackend + ?Sized>(
    backend: &B,
    text: &str,
) -> String {
    let scrub = |text: &str| backend.redact_outbound(&backend.sanitize(text)).0;
    let clean = scrub(text);
    if !excerpt_survives(backend, &clean) {
        return clean;
    }
    let refolded = scrub(&ryu_gw_firewall::fold_for_redaction(&clean));
    if excerpt_survives(backend, &refolded) {
        String::new()
    } else {
        refolded
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

/// The operator's survivor set: the curated PII and secret patterns plus the
/// node config's `custom_patterns` of kind PII or secret. Built from the
/// config the registry is given at startup and on every `PUT /v1/config`.
fn operator_excerpt_scanner(config: &FirewallConfig) -> Arc<FirewallScanner> {
    let custom_patterns = config
        .custom_patterns
        .iter()
        .filter(|pattern| {
            matches!(
                pattern.kind,
                CustomPatternKind::Pii | CustomPatternKind::Secret
            )
        })
        .cloned()
        .collect();
    Arc::new(FirewallScanner::new_scoped(FirewallConfig {
        custom_patterns,
        ..FirewallConfig::default()
    }))
}

/// The active backend as [`FirewallRegistry::with_active`] hands it out.
/// Every call is the backend's own; its excerpt is then checked against the
/// operator's survivor set (curated plus custom PII and secret patterns, on
/// the normalized view) and dropped if anything survives. The curated-only
/// fallback in [`redact_excerpt_fail_closed`] cannot see a pattern only the
/// operator configured. The built-in's own excerpt redaction already applies
/// the same patterns, so for it the check never drops anything it kept.
struct OperatorExcerptGuard {
    inner: Arc<dyn FirewallBackend>,
    survivor: Arc<FirewallScanner>,
}

impl FirewallBackend for OperatorExcerptGuard {
    fn config(&self) -> &FirewallConfig {
        self.inner.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.inner.policy()
    }
    fn outbound_enabled(&self) -> bool {
        self.inner.outbound_enabled()
    }
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        self.inner.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        self.inner.scan_outbound(text)
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        self.inner.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        self.inner.sanitize(text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.inner.redact_outbound(text)
    }
    fn redact_excerpt(&self, text: &str) -> String {
        let clean = self.inner.redact_excerpt(text);
        let (pii, secret) = self.survivor.companion_survivors(&clean);
        if pii || secret {
            String::new()
        } else {
            clean
        }
    }
}

/// The live handle for a backend: always behind an [`OperatorExcerptGuard`],
/// keyed on nothing about the backend, so a plugin registered under
/// [`FirewallRegistry::BUILTIN`] cannot pass for the built-in and skip it.
fn live_handle(
    backend: &Arc<dyn FirewallBackend>,
    survivor: &Arc<FirewallScanner>,
) -> Arc<dyn FirewallBackend> {
    Arc::new(OperatorExcerptGuard {
        inner: Arc::clone(backend),
        survivor: Arc::clone(survivor),
    })
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
    /// The live handle: the active backend, wrapped by [`live_handle`].
    active: std::sync::Arc<dyn FirewallBackend>,
    /// The operator's excerpt survivor set, rebuilt with the config.
    survivor: Arc<FirewallScanner>,
}

impl FirewallRegistry {
    /// Stable id of the built-in in-process firewall scanner.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`FirewallScanner`] as the default active backend.
    pub fn new(config: FirewallConfig) -> Self {
        let survivor = operator_excerpt_scanner(&config);
        let builtin: std::sync::Arc<dyn FirewallBackend> =
            std::sync::Arc::new(FirewallScanner::new(config));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(FirewallRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: live_handle(&builtin, &survivor),
                survivor,
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
    /// Only rebuilds the built-in; a non-built-in active backend is left in
    /// place, but its excerpt survivor check is rebuilt with the new
    /// `custom_patterns`.
    pub fn update_config(&self, config: FirewallConfig) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let survivor = operator_excerpt_scanner(&config);
        let builtin: std::sync::Arc<dyn FirewallBackend> =
            std::sync::Arc::new(FirewallScanner::new(config));
        guard
            .backends
            .insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        guard.survivor = survivor;
        let inner = &mut *guard;
        if let Some(active) = inner.backends.get(&inner.active_id) {
            inner.active = live_handle(active, &inner.survivor);
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
        if id == guard.active_id {
            guard.active = live_handle(&backend, &guard.survivor);
        }
        guard.backends.insert(id, backend);
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    pub fn set_active(&self, id: &str) -> bool {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.backends.get(id).map(std::sync::Arc::clone) {
            Some(backend) => {
                guard.active = live_handle(&backend, &guard.survivor);
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
