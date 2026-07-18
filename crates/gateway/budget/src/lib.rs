//! Per-user and per-agent token budgets with local counters (data plane, U21).
//!
//! This is the data-plane half of budget enforcement: every request is checked
//! inline against in-memory counters keyed by user id and agent id (no SQLite on
//! the hot path, no network call). Exceeding a budget triggers one of four
//! configured actions — notify, downgrade, restrict, or stop.
//!
//! Cross-user / team coordination (a shared budget pool across many gateways) is
//! explicitly out of scope here; that is the control-plane coordinator (U29).
//!
//! Counters are lifetime totals (input + output tokens). They live only in
//! memory: a restart resets them. That matches "local counters" — durable,
//! cross-restart accounting is the audit log's job and the coordinator's job.

use std::collections::HashMap;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

/// Notification fan-out tier, shared across gateway stages (see the crate).
pub use ryu_gw_contracts::AlertTier;

// ─── Budget config types (moved verbatim from gateway `config.rs`) ───────────
//
// These are the serde-shaped config the enforcer consumes. They live here (not
// in gateway `config.rs`) so this stage crate is self-contained; gateway
// `config.rs` re-exports them so `crate::config::Budget*` paths are unchanged
// and `GatewayConfig` still embeds `budgets` / `exec_budget`.

/// What the gateway does when a per-user or per-agent budget is exhausted.
///
/// These are the four data-plane actions a budget can trigger (U21). They are
/// enforced inline, on the request path, using local counters — no cross-user
/// or team coordination (that is control-plane, U29).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BudgetAction {
    /// Allow the request through but flag it (observable via response headers
    /// and metrics) so the client can surface a warning. Never blocks.
    #[default]
    Notify,
    /// Swap the requested model for the rule's `downgrade_to` (a cheaper model)
    /// and continue. Falls back to `Restrict` if no downgrade model is set.
    Downgrade,
    /// Allow the request but clamp it: strip tool definitions and cap
    /// `max_tokens` so an over-budget caller can still get a minimal answer.
    Restrict,
    /// Reject the request with `402 budget_exceeded`. The hard stop.
    Stop,
}

/// A single budget rule: a token cap plus the action taken once it is reached.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BudgetRule {
    /// Lifetime token cap (input + output combined) for this scope. 0 = unlimited.
    pub limit: u64,
    /// Action to take once `limit` is reached. Defaults to `notify`.
    #[serde(default)]
    pub action: BudgetAction,
    /// Model to route to when `action = downgrade`. Required for downgrade to
    /// take effect; otherwise the rule degrades to `restrict`.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Defaults to 256.
    #[serde(default = "default_restrict_max_tokens")]
    pub restrict_max_tokens: u64,
    /// Notification fan-out tier when this rule matches (orthogonal to `action`).
    /// Missing in old configs → `Silent`.
    #[serde(default)]
    pub alert: AlertTier,
}

fn default_restrict_max_tokens() -> u64 {
    256
}

/// Per-user and per-agent token budgets (data plane, local counters).
///
/// Keyed by the identity Core forwards on the request: `x-ryu-user-id` and
/// `x-ryu-agent-id`. A request can match both a user budget and an agent
/// budget; both are evaluated and the most restrictive triggered action wins
/// (`stop` > `downgrade`/`restrict` > `notify`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct BudgetConfig {
    /// Per-user budgets, keyed by user id.
    #[serde(default)]
    pub users: HashMap<String, BudgetRule>,
    /// Per-agent budgets, keyed by agent id.
    #[serde(default)]
    pub agents: HashMap<String, BudgetRule>,
    /// A single global per-session token cap (#510). Unlike `users`/`agents`,
    /// this is NOT a map: session ids are ephemeral (Core mints a fresh
    /// conversation id per chat), so a per-session-id rule map would be dead
    /// config nobody could populate. Instead one rule applies to every session,
    /// with the running counter keyed by the `x-ryu-session-id` header.
    #[serde(default)]
    pub session: SessionBudgetConfig,
}

/// Global per-session token budget (#510). One rule that applies to every
/// session; the running counter is keyed by session id at request time.
///
/// Mirrors [`BudgetRule`]'s shape (a token cap plus an action) so the existing
/// `decide`/`enforce_budget` machinery enforces it identically — `stop` rejects,
/// `downgrade` swaps the model, `restrict` clamps, `notify` only flags.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionBudgetConfig {
    /// Lifetime token cap (input + output combined) for any single session.
    /// 0 = unlimited (the feature is off).
    #[serde(default)]
    pub limit: u64,
    /// Action to take once a session reaches `limit`. Defaults to `notify`.
    #[serde(default)]
    pub action: BudgetAction,
    /// Model to route to when `action = downgrade`. Required for downgrade to
    /// take effect; otherwise the rule degrades to `restrict`.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Defaults to 256.
    #[serde(default = "default_restrict_max_tokens")]
    pub restrict_max_tokens: u64,
    /// Notification fan-out tier when the session cap matches. Old configs →
    /// `Silent`.
    #[serde(default)]
    pub alert: AlertTier,
}

impl Default for SessionBudgetConfig {
    fn default() -> Self {
        Self {
            limit: 0,
            action: BudgetAction::default(),
            downgrade_to: None,
            restrict_max_tokens: default_restrict_max_tokens(),
            alert: AlertTier::default(),
        }
    }
}

/// Exec (sandbox) budget config: count and/or wall-clock per rolling window.
///
/// Unlike the token budget (lifetime, model-call shaped), exec budgets apply
/// to non-model executions: sandbox runs, MCP tool invocations, and any
/// event posted to `POST /v1/exec/audit`. Limits reset at each window boundary.
///
/// Both `max_count` and `max_wall_clock_secs` can be configured independently;
/// when both are set, whichever is exhausted first triggers the deny. 0 = no
/// limit for that dimension.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExecBudgetConfig {
    /// Maximum number of sandbox/tool executions per `window_secs`. 0 = unlimited.
    #[serde(default = "default_exec_max_count")]
    pub max_count: u64,
    /// Maximum total wall-clock seconds of sandbox execution per `window_secs`. 0 = unlimited.
    #[serde(default)]
    pub max_wall_clock_secs: u64,
    /// Rolling window size in seconds. Default: 3600 (one hour).
    #[serde(default = "default_exec_window_secs")]
    pub window_secs: u64,
    /// Action when the exec budget is exhausted. Only `stop` (deny) is meaningful
    /// here — exec events do not support model downgrade or token restriction.
    #[serde(default)]
    pub action: ExecBudgetAction,
}

fn default_exec_max_count() -> u64 {
    0 // unlimited by default
}
fn default_exec_window_secs() -> u64 {
    3600
}

/// What the gateway does when the exec budget is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecBudgetAction {
    /// Allow the execution (log but do not block). Default.
    #[default]
    Notify,
    /// Deny the execution with 429 budget_exceeded.
    Stop,
}

impl Default for ExecBudgetConfig {
    fn default() -> Self {
        Self {
            max_count: default_exec_max_count(),
            max_wall_clock_secs: 0,
            window_secs: default_exec_window_secs(),
            action: ExecBudgetAction::default(),
        }
    }
}

/// Soft cap on the per-session counter map (#510). Session ids are ephemeral —
/// Core mints a fresh one per chat — so this map grows one entry per distinct
/// session since boot, unlike the user/agent maps (bounded by configured
/// identities). When it exceeds this size the whole map is cleared: counters
/// already reset on restart and are best-effort, so dropping them is acceptable
/// (the worst case is a long-lived session's running total resetting once).
const MAX_SESSION_ENTRIES: usize = 50_000;

/// Which identity dimension a budget decision applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetScope {
    User,
    Agent,
    Session,
}

impl BudgetScope {
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetScope::User => "user",
            BudgetScope::Agent => "agent",
            BudgetScope::Session => "session",
        }
    }
}

/// The outcome of checking a request against its budgets.
///
/// Always carries the scope/usage that drove the decision so it can be surfaced
/// to the client as response headers (acceptance criterion: observability).
#[derive(Debug, Clone)]
pub struct BudgetDecision {
    pub scope: BudgetScope,
    pub key: String,
    pub action: BudgetAction,
    pub used: u64,
    pub limit: u64,
    pub downgrade_to: Option<String>,
    pub restrict_max_tokens: u64,
    /// Notification fan-out tier configured on the matched rule (orthogonal to
    /// `action`). `enforce_budget` takes the `max` across all matched decisions
    /// to build the propagated `PolicyAlert`.
    pub alert: AlertTier,
}

/// In-memory budget enforcer. Cheap to clone-check on the request path.
pub struct BudgetEnforcer {
    config: BudgetConfig,
    /// Lifetime tokens used per user id.
    user_usage: DashMap<String, u64>,
    /// Lifetime tokens used per agent id.
    agent_usage: DashMap<String, u64>,
    /// Lifetime tokens used per session id (#510). Bounded by
    /// `MAX_SESSION_ENTRIES`; cleared wholesale on overflow.
    session_usage: DashMap<String, u64>,
    enabled: bool,
}

impl BudgetEnforcer {
    pub fn new(config: BudgetConfig) -> Self {
        // The session cap (a single global rule) also activates enforcement, so
        // a deployment can run with ONLY a session budget configured. Forgetting
        // this would make `record` early-return and the counter never move.
        let enabled =
            !config.users.is_empty() || !config.agents.is_empty() || config.session.limit > 0;
        Self {
            config,
            user_usage: DashMap::new(),
            agent_usage: DashMap::new(),
            session_usage: DashMap::new(),
            enabled,
        }
    }

    /// Return the current budget config (used by GET /v1/config to report live state).
    pub fn config(&self) -> &BudgetConfig {
        &self.config
    }

    /// Whether any budget rules are configured at all.
    #[allow(dead_code)]
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Evaluate the request's user and agent budgets and return the single most
    /// restrictive triggered action, if any. Returns `None` when no budget is
    /// configured for the given identity or none is exhausted yet.
    ///
    /// Severity order (most restrictive first): `stop` > `downgrade`/`restrict`
    /// > `notify`. When two scopes both trigger, the more severe wins; ties
    /// prefer the user scope.
    pub fn evaluate(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Option<BudgetDecision> {
        if !self.enabled {
            return None;
        }

        let mut best: Option<BudgetDecision> = None;

        if let Some(uid) = user_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self.config.users.get(uid) {
                let used = self.user_usage.get(uid).map(|v| *v).unwrap_or(0);
                if let Some(decision) = Self::decide(BudgetScope::User, uid, rule, used) {
                    best = Some(decision);
                }
            }
        }

        if let Some(aid) = agent_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self.config.agents.get(aid) {
                let used = self.agent_usage.get(aid).map(|v| *v).unwrap_or(0);
                if let Some(decision) = Self::decide(BudgetScope::Agent, aid, rule, used) {
                    best = match best {
                        Some(prev) if severity(prev.action) >= severity(decision.action) => {
                            Some(prev)
                        }
                        _ => Some(decision),
                    };
                }
            }
        }

        best
    }

    /// Evaluate the request's per-session budget (#510). Returns the triggered
    /// action if the single global session rule is configured (`limit > 0`) and
    /// this session's running counter has reached it.
    ///
    /// Reuses the same `decide` machinery as user/agent scopes — building a
    /// transient [`BudgetRule`] from the [`SessionBudgetConfig`] — so the
    /// downgrade-without-target → restrict degrade behaves identically.
    pub fn evaluate_session(&self, session_id: Option<&str>) -> Option<BudgetDecision> {
        if !self.enabled || self.config.session.limit == 0 {
            return None;
        }
        let sid = session_id.filter(|s| !s.is_empty())?;
        let used = self.session_usage.get(sid).map(|v| *v).unwrap_or(0);
        let rule = Self::session_rule(&self.config.session);
        Self::decide(BudgetScope::Session, sid, &rule, used)
    }

    /// Project the global [`SessionBudgetConfig`] onto a transient [`BudgetRule`]
    /// so `decide`/`record` treat a session exactly like a user/agent scope.
    fn session_rule(cfg: &SessionBudgetConfig) -> BudgetRule {
        BudgetRule {
            limit: cfg.limit,
            action: cfg.action,
            downgrade_to: cfg.downgrade_to.clone(),
            restrict_max_tokens: cfg.restrict_max_tokens,
            alert: cfg.alert,
        }
    }

    /// Build a decision for a scope if its rule is configured and exhausted.
    fn decide(
        scope: BudgetScope,
        key: &str,
        rule: &BudgetRule,
        used: u64,
    ) -> Option<BudgetDecision> {
        if rule.limit == 0 || used < rule.limit {
            return None;
        }

        // A downgrade with no target model degrades to a restrict so the caller
        // is never silently let through on a "downgrade" they cannot honour.
        let action = match rule.action {
            BudgetAction::Downgrade if rule.downgrade_to.is_none() => BudgetAction::Restrict,
            other => other,
        };

        Some(BudgetDecision {
            scope,
            key: key.to_string(),
            action,
            used,
            limit: rule.limit,
            downgrade_to: rule.downgrade_to.clone(),
            restrict_max_tokens: rule.restrict_max_tokens,
            alert: rule.alert,
        })
    }

    /// Record consumed tokens against the request's user and agent counters.
    /// Only increments scopes that actually have a configured budget so the
    /// maps stay bounded by the number of budgeted identities.
    pub fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, tokens: u64) {
        if !self.enabled || tokens == 0 {
            return;
        }
        if let Some(uid) = user_id.filter(|s| !s.is_empty()) {
            if self.config.users.contains_key(uid) {
                *self.user_usage.entry(uid.to_string()).or_insert(0) += tokens;
            }
        }
        if let Some(aid) = agent_id.filter(|s| !s.is_empty()) {
            if self.config.agents.contains_key(aid) {
                *self.agent_usage.entry(aid.to_string()).or_insert(0) += tokens;
            }
        }
    }

    /// Record consumed tokens against the request's session counter (#510). Kept
    /// separate from `record` so the prod call sites add it alongside without
    /// churning every existing `record` test, and the session-enabled gate lives
    /// with the session logic.
    ///
    /// Only increments when the global session rule is active (`limit > 0`). The
    /// map is soft-bounded at `MAX_SESSION_ENTRIES` — on overflow it is cleared
    /// wholesale (counters are ephemeral and best-effort, so this is acceptable).
    pub fn record_session(&self, session_id: Option<&str>, tokens: u64) {
        if !self.enabled || tokens == 0 || self.config.session.limit == 0 {
            return;
        }
        let Some(sid) = session_id.filter(|s| !s.is_empty()) else {
            return;
        };
        if self.session_usage.len() >= MAX_SESSION_ENTRIES && !self.session_usage.contains_key(sid)
        {
            self.session_usage.clear();
        }
        *self.session_usage.entry(sid.to_string()).or_insert(0) += tokens;
    }

    /// Current lifetime tokens recorded for a user (test/observability helper).
    #[allow(dead_code)]
    pub fn user_usage(&self, user_id: &str) -> u64 {
        self.user_usage.get(user_id).map(|v| *v).unwrap_or(0)
    }

    /// Current lifetime tokens recorded for a session (test/observability helper).
    #[allow(dead_code)]
    pub fn session_usage(&self, session_id: &str) -> u64 {
        self.session_usage.get(session_id).map(|v| *v).unwrap_or(0)
    }

    /// Current lifetime tokens recorded for an agent (test/observability helper).
    #[allow(dead_code)]
    pub fn agent_usage(&self, agent_id: &str) -> u64 {
        self.agent_usage.get(agent_id).map(|v| *v).unwrap_or(0)
    }
}

/// Higher = more restrictive. Used to pick a winner when both scopes trigger.
fn severity(action: BudgetAction) -> u8 {
    match action {
        BudgetAction::Notify => 0,
        BudgetAction::Restrict | BudgetAction::Downgrade => 1,
        BudgetAction::Stop => 2,
    }
}

impl Default for BudgetEnforcer {
    fn default() -> Self {
        Self::new(BudgetConfig::default())
    }
}

// ─── Swappable budget enforcer (Lg decomposition) ────────────────────────────

/// The per-user / per-agent / per-session token budget enforcer as a swappable
/// capability. The built-in [`BudgetEnforcer`] (in-memory counters) is the
/// default; an alternative (e.g. a control-plane-coordinated shared pool) can
/// register without touching the pipeline, mirroring the
/// `ProviderRegistry` inversion. The trait carries exactly
/// the surface the pipeline / API drive through `AppState::with_budget`.
pub trait BudgetBackend: Send + Sync {
    /// The live budget config (for `GET /v1/config`).
    fn config(&self) -> &BudgetConfig;
    /// Evaluate user + agent budgets, returning the most restrictive action.
    fn evaluate(&self, user_id: Option<&str>, agent_id: Option<&str>) -> Option<BudgetDecision>;
    /// Evaluate the per-session budget.
    fn evaluate_session(&self, session_id: Option<&str>) -> Option<BudgetDecision>;
    /// Record consumed tokens against user + agent counters.
    fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, tokens: u64);
    /// Record consumed tokens against the session counter.
    fn record_session(&self, session_id: Option<&str>, tokens: u64);
    /// Snapshot the live per-user / per-agent / per-session spend counters for a
    /// read surface (`GET /v1/budget/spend`). Default returns an empty snapshot so
    /// a backend that keeps no local counters (e.g. a control-plane-coordinated
    /// pool, or a test stub) is not forced to implement it; the built-in
    /// [`BudgetEnforcer`] overrides it with its DashMap contents.
    fn spend_snapshot(&self) -> BudgetSpendSnapshot {
        BudgetSpendSnapshot::default()
    }
}

/// A point-in-time snapshot of the in-memory budget spend counters, keyed by
/// identity. Lifetime token totals (input + output), the same figure the budget
/// gate compares against each scope's `limit`. In-memory only — a gateway
/// restart resets these to empty (see the crate-level note on counter
/// durability). Consumed by the `GET /v1/budget/spend` read surface so the
/// desktop can show live per-scope spend.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BudgetSpendSnapshot {
    /// Lifetime tokens per user id (only ids with a configured budget accrue).
    pub users: HashMap<String, u64>,
    /// Lifetime tokens per agent id (only ids with a configured budget accrue).
    pub agents: HashMap<String, u64>,
    /// Lifetime tokens per session id (populated only when the global session
    /// budget is active). Bounded by `MAX_SESSION_ENTRIES`.
    pub sessions: HashMap<String, u64>,
}

impl BudgetBackend for BudgetEnforcer {
    fn config(&self) -> &BudgetConfig {
        BudgetEnforcer::config(self)
    }
    fn evaluate(&self, user_id: Option<&str>, agent_id: Option<&str>) -> Option<BudgetDecision> {
        BudgetEnforcer::evaluate(self, user_id, agent_id)
    }
    fn evaluate_session(&self, session_id: Option<&str>) -> Option<BudgetDecision> {
        BudgetEnforcer::evaluate_session(self, session_id)
    }
    fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, tokens: u64) {
        BudgetEnforcer::record(self, user_id, agent_id, tokens);
    }
    fn record_session(&self, session_id: Option<&str>, tokens: u64) {
        BudgetEnforcer::record_session(self, session_id, tokens);
    }
    fn spend_snapshot(&self) -> BudgetSpendSnapshot {
        let dump = |m: &DashMap<String, u64>| -> HashMap<String, u64> {
            m.iter().map(|e| (e.key().clone(), *e.value())).collect()
        };
        BudgetSpendSnapshot {
            users: dump(&self.user_usage),
            agents: dump(&self.agent_usage),
            sessions: dump(&self.session_usage),
        }
    }
}

/// Id-keyed registry over [`BudgetBackend`] implementations, with a live-swap
/// discipline (like the firewall scanner): the built-in [`BudgetEnforcer`] is
/// registered first under [`BudgetRegistry::BUILTIN`] and active by default, so
/// behavior is byte-identical with no config change. `PUT /v1/config` rebuilds
/// the active built-in via [`BudgetRegistry::update_config`]; a plugin backend
/// can register + activate through [`BudgetRegistry::register`] /
/// [`BudgetRegistry::set_active`]. All access is via [`BudgetRegistry::with_active`]
/// so a read never outlives a swap.
pub struct BudgetRegistry {
    inner: std::sync::RwLock<BudgetRegistryInner>,
}

struct BudgetRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn BudgetBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn BudgetBackend>,
}

impl BudgetRegistry {
    /// Stable id of the built-in in-process budget enforcer.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`BudgetEnforcer`] as the default active backend.
    pub fn new(config: BudgetConfig) -> Self {
        let builtin: std::sync::Arc<dyn BudgetBackend> =
            std::sync::Arc::new(BudgetEnforcer::new(config));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(BudgetRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock), then run `f` against it — the arc holds no lock, matching
    /// the old `with_budget` closure semantics.
    pub fn with_active<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn BudgetBackend) -> T,
    {
        let active = match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        };
        f(&*active)
    }

    /// Hot-swap the active built-in enforcer with one built from a new config.
    /// In-memory counters reset on swap (intentional — see the module comment).
    /// Only rebuilds the built-in; a non-built-in active backend is left in place.
    pub fn update_config(&self, config: BudgetConfig) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let builtin: std::sync::Arc<dyn BudgetBackend> =
            std::sync::Arc::new(BudgetEnforcer::new(config));
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
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn BudgetBackend>) {
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
    /// Called by `AppState::new` (config-driven build) and `PUT /v1/config`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn rule(limit: u64, action: BudgetAction) -> BudgetRule {
        BudgetRule {
            limit,
            action,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: AlertTier::default(),
        }
    }

    fn config_with_user(id: &str, r: BudgetRule) -> BudgetConfig {
        let mut users = HashMap::new();
        users.insert(id.to_string(), r);
        BudgetConfig {
            users,
            ..BudgetConfig::default()
        }
    }

    fn config_with_session(cfg: SessionBudgetConfig) -> BudgetConfig {
        BudgetConfig {
            session: cfg,
            ..BudgetConfig::default()
        }
    }

    #[test]
    fn disabled_when_no_rules() {
        let e = BudgetEnforcer::new(BudgetConfig::default());
        assert!(!e.is_enabled());
        assert!(e.evaluate(Some("u1"), Some("a1")).is_none());
    }

    #[test]
    fn spend_snapshot_reflects_recorded_counters() {
        // A user + a session budget both configured so both scopes accrue.
        let mut cfg = config_with_user("u1", rule(1000, BudgetAction::Stop));
        cfg.session = SessionBudgetConfig {
            limit: 1000,
            ..SessionBudgetConfig::default()
        };
        let e = BudgetEnforcer::new(cfg);
        e.record(Some("u1"), None, 40);
        e.record_session(Some("s1"), 25);

        let snap = BudgetBackend::spend_snapshot(&e);
        assert_eq!(snap.users.get("u1"), Some(&40));
        assert_eq!(snap.sessions.get("s1"), Some(&25));
        // No agent budget configured ⇒ agent counter stays empty.
        assert!(snap.agents.is_empty());
    }

    #[test]
    fn counter_accumulates_then_triggers_stop() {
        let e = BudgetEnforcer::new(config_with_user("u1", rule(100, BudgetAction::Stop)));
        // Under budget: nothing fires.
        e.record(Some("u1"), None, 60);
        assert_eq!(e.user_usage("u1"), 60);
        assert!(e.evaluate(Some("u1"), None).is_none());
        // Crossing the limit fires the stop action.
        e.record(Some("u1"), None, 50);
        assert_eq!(e.user_usage("u1"), 110);
        let d = e.evaluate(Some("u1"), None).expect("budget should trigger");
        assert_eq!(d.action, BudgetAction::Stop);
        assert_eq!(d.scope, BudgetScope::User);
        assert_eq!(d.limit, 100);
        assert_eq!(d.used, 110);
    }

    #[test]
    fn notify_does_not_change_action_but_is_observable() {
        let e = BudgetEnforcer::new(config_with_user("u1", rule(10, BudgetAction::Notify)));
        e.record(Some("u1"), None, 10);
        let d = e.evaluate(Some("u1"), None).expect("notify should trigger");
        assert_eq!(d.action, BudgetAction::Notify);
    }

    #[test]
    fn downgrade_without_target_degrades_to_restrict() {
        let e = BudgetEnforcer::new(config_with_user("u1", rule(10, BudgetAction::Downgrade)));
        e.record(Some("u1"), None, 20);
        let d = e.evaluate(Some("u1"), None).expect("should trigger");
        assert_eq!(d.action, BudgetAction::Restrict);
    }

    #[test]
    fn downgrade_with_target_keeps_downgrade() {
        let r = BudgetRule {
            limit: 10,
            action: BudgetAction::Downgrade,
            downgrade_to: Some("gpt-4o-mini".to_string()),
            restrict_max_tokens: 256,
            alert: AlertTier::default(),
        };
        let e = BudgetEnforcer::new(config_with_user("u1", r));
        e.record(Some("u1"), None, 20);
        let d = e.evaluate(Some("u1"), None).expect("should trigger");
        assert_eq!(d.action, BudgetAction::Downgrade);
        assert_eq!(d.downgrade_to.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn most_restrictive_scope_wins() {
        let mut users = HashMap::new();
        users.insert("u1".to_string(), rule(10, BudgetAction::Notify));
        let mut agents = HashMap::new();
        agents.insert("a1".to_string(), rule(10, BudgetAction::Stop));
        let e = BudgetEnforcer::new(BudgetConfig {
            users,
            agents,
            ..BudgetConfig::default()
        });
        e.record(Some("u1"), Some("a1"), 20);
        let d = e.evaluate(Some("u1"), Some("a1")).expect("should trigger");
        // Agent's stop is more severe than the user's notify.
        assert_eq!(d.action, BudgetAction::Stop);
        assert_eq!(d.scope, BudgetScope::Agent);
    }

    #[test]
    fn record_only_tracks_budgeted_identities() {
        let e = BudgetEnforcer::new(config_with_user("u1", rule(100, BudgetAction::Stop)));
        // Unbudgeted user is not tracked, keeping the map bounded.
        e.record(Some("other"), None, 50);
        assert_eq!(e.user_usage("other"), 0);
    }

    // ── Per-session budget (#510) ────────────────────────────────────────────

    fn session_cfg(limit: u64, action: BudgetAction) -> SessionBudgetConfig {
        SessionBudgetConfig {
            limit,
            action,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: AlertTier::default(),
        }
    }

    #[test]
    fn session_disabled_when_limit_zero_and_no_other_rules() {
        let e = BudgetEnforcer::new(config_with_session(session_cfg(0, BudgetAction::Stop)));
        assert!(!e.is_enabled());
        e.record_session(Some("s1"), 100);
        assert_eq!(e.session_usage("s1"), 0);
        assert!(e.evaluate_session(Some("s1")).is_none());
    }

    #[test]
    fn session_counter_accumulates_then_triggers_stop() {
        let e = BudgetEnforcer::new(config_with_session(session_cfg(100, BudgetAction::Stop)));
        assert!(e.is_enabled());
        // Under cap: nothing fires.
        e.record_session(Some("s1"), 60);
        assert_eq!(e.session_usage("s1"), 60);
        assert!(e.evaluate_session(Some("s1")).is_none());
        // Crossing the cap fires the stop action for this session.
        e.record_session(Some("s1"), 50);
        assert_eq!(e.session_usage("s1"), 110);
        let d = e
            .evaluate_session(Some("s1"))
            .expect("session budget should trigger");
        assert_eq!(d.action, BudgetAction::Stop);
        assert_eq!(d.scope, BudgetScope::Session);
        assert_eq!(d.key, "s1");
        assert_eq!(d.limit, 100);
        assert_eq!(d.used, 110);
    }

    #[test]
    fn session_counters_are_independent_per_session() {
        let e = BudgetEnforcer::new(config_with_session(session_cfg(100, BudgetAction::Stop)));
        e.record_session(Some("s1"), 150);
        // A different session is unaffected by s1 blowing its cap.
        assert!(e.evaluate_session(Some("s1")).is_some());
        assert!(e.evaluate_session(Some("s2")).is_none());
        assert_eq!(e.session_usage("s2"), 0);
    }

    #[test]
    fn session_downgrade_without_target_degrades_to_restrict() {
        let e = BudgetEnforcer::new(config_with_session(session_cfg(
            10,
            BudgetAction::Downgrade,
        )));
        e.record_session(Some("s1"), 20);
        let d = e
            .evaluate_session(Some("s1"))
            .expect("session budget should trigger");
        assert_eq!(d.action, BudgetAction::Restrict);
    }

    #[test]
    fn session_record_noop_without_session_id() {
        let e = BudgetEnforcer::new(config_with_session(session_cfg(10, BudgetAction::Stop)));
        // No session id on the request: nothing recorded, nothing fires.
        e.record_session(None, 50);
        assert!(e.evaluate_session(None).is_none());
    }
}

// ── ExecBudgetEnforcer (M6 / #192) ──────────────────────────────────────────
//
// Per-period exec-event budget. Unlike the token budget (lifetime, model-call
// shaped), exec budgets apply to sandbox/tool runs. Counters reset at each
// window boundary. Thread-safe via atomics / Mutex.

use std::time::{Duration, Instant};

/// Outcome of checking the exec budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecBudgetResult {
    /// Execution is allowed (budget not exhausted or action=notify).
    Allow,
    /// Execution is denied because the budget is exhausted and action=stop.
    Deny {
        exec_count: u64,
        wall_clock_secs: u64,
        limit_count: u64,
        limit_wall_clock_secs: u64,
    },
}

/// In-memory per-period exec budget enforcer.
///
/// Counters (exec count, wall-clock seconds) accumulate during `window_secs`
/// and reset at the next window boundary. A single `Mutex<WindowState>` guards
/// the window state; the check is not on the hot LLM-call path.
pub struct ExecBudgetEnforcer {
    config: ExecBudgetConfig,
    state: std::sync::Mutex<ExecWindowState>,
}

struct ExecWindowState {
    window_start: Instant,
    exec_count: u64,
    wall_clock_ms: u64,
}

impl ExecBudgetEnforcer {
    pub fn new(config: ExecBudgetConfig) -> Self {
        Self {
            config,
            state: std::sync::Mutex::new(ExecWindowState {
                window_start: Instant::now(),
                exec_count: 0,
                wall_clock_ms: 0,
            }),
        }
    }

    /// Check whether a new execution is permitted. Does NOT record it (call
    /// `record` after the exec completes to update wall-clock).
    pub fn check(&self) -> ExecBudgetResult {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        self.maybe_reset_window(&mut state);

        let count_ok = self.config.max_count == 0 || state.exec_count < self.config.max_count;
        let wc_secs = state.wall_clock_ms / 1000;
        let wc_ok =
            self.config.max_wall_clock_secs == 0 || wc_secs < self.config.max_wall_clock_secs;

        if count_ok && wc_ok {
            return ExecBudgetResult::Allow;
        }

        match self.config.action {
            ExecBudgetAction::Notify => ExecBudgetResult::Allow,
            ExecBudgetAction::Stop => ExecBudgetResult::Deny {
                exec_count: state.exec_count,
                wall_clock_secs: wc_secs,
                limit_count: self.config.max_count,
                limit_wall_clock_secs: self.config.max_wall_clock_secs,
            },
        }
    }

    /// Record a completed execution. `duration_ms` is wall-clock time.
    pub fn record(&self, duration_ms: u64) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        self.maybe_reset_window(&mut state);
        state.exec_count += 1;
        state.wall_clock_ms += duration_ms;
    }

    fn maybe_reset_window(&self, state: &mut ExecWindowState) {
        let window = Duration::from_secs(self.config.window_secs);
        if state.window_start.elapsed() >= window {
            state.window_start = Instant::now();
            state.exec_count = 0;
            state.wall_clock_ms = 0;
        }
    }

    /// Current window exec count (for observability).
    pub fn current_count(&self) -> u64 {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.exec_count
    }
}

impl Default for ExecBudgetEnforcer {
    fn default() -> Self {
        Self::new(ExecBudgetConfig::default())
    }
}

#[cfg(test)]
mod exec_budget_tests {
    use super::*;

    fn enforcer(max_count: u64, action: ExecBudgetAction) -> ExecBudgetEnforcer {
        ExecBudgetEnforcer::new(ExecBudgetConfig {
            max_count,
            max_wall_clock_secs: 0,
            window_secs: 3600,
            action,
        })
    }

    #[test]
    fn allow_when_no_limits() {
        let e = ExecBudgetEnforcer::default();
        assert_eq!(e.check(), ExecBudgetResult::Allow);
    }

    #[test]
    fn deny_when_count_exhausted_and_action_stop() {
        let e = enforcer(2, ExecBudgetAction::Stop);
        e.record(100);
        e.record(100);
        assert_eq!(
            e.check(),
            ExecBudgetResult::Deny {
                exec_count: 2,
                wall_clock_secs: 0,
                limit_count: 2,
                limit_wall_clock_secs: 0,
            }
        );
    }

    #[test]
    fn notify_allows_past_limit() {
        let e = enforcer(1, ExecBudgetAction::Notify);
        e.record(100);
        e.record(100);
        assert_eq!(e.check(), ExecBudgetResult::Allow);
    }

    #[test]
    fn under_limit_allows() {
        let e = enforcer(3, ExecBudgetAction::Stop);
        e.record(100);
        e.record(100);
        assert_eq!(e.check(), ExecBudgetResult::Allow);
    }
}

// ── Shared-budget coordinator cache (M7 / U29) ──────────────────────────────
//
// The control-plane coordinator is the single source of truth for budgets
// shared across users and machines. The gateway reconciles its spend with the
// coordinator (see `crate::reporter`) and caches the verdict here so the hot
// request path can enforce it without a network round trip.

use std::sync::atomic::{AtomicBool, Ordering};

/// Cached verdict from the shared-budget coordinator.
#[derive(Default)]
pub struct SharedBudgetState {
    exceeded: AtomicBool,
}

impl SharedBudgetState {
    /// Update the cached verdict after a coordinator reconciliation.
    pub fn set_shared_exceeded(&self, exceeded: bool) {
        self.exceeded.store(exceeded, Ordering::Relaxed);
    }

    /// Whether the shared budget is currently over its cap. Read on the hot
    /// path; reflects the most recent coordinator reconciliation.
    pub fn is_shared_exceeded(&self) -> bool {
        self.exceeded.load(Ordering::Relaxed)
    }
}

// ── Per-org credit-wallet empty cache (marketplace monetization #486) ───────
//
// The credits debit hook is POST-call (the cost is only known after the model
// responds), but the budget gate that turns "wallet empty" into Stop/Downgrade
// is PRE-call. They cannot be the same moment, so — exactly like the shared
// budget above — a debit that drives an org's balance non-positive sets a cached
// per-org flag, and the NEXT request for that org is gated at `enforce_budget`.
// This yields a one-call grace overdraw, matching the debit endpoint's own
// contract ("never rejects for insufficient balance; reports the crossing").
// The flag is the steady-state truth (`balanceMicroUsd <= 0`), so a later top-up
// debit response self-heals it back to allowed.

/// Cache of which org wallets are currently empty (balance ≤ 0).
///
/// Keyed by org id. A missing entry means "not empty" (allowed). Cheap to read
/// on the hot path; written best-effort by the debit hook after each metered
/// call. Lives only in memory — a restart clears it, and the next debit
/// repopulates it; the durable truth is the control-plane ledger.
#[derive(Default)]
pub struct WalletState {
    empty: DashMap<String, bool>,
}

impl WalletState {
    /// Record the post-debit balance verdict for an org. `empty` should be
    /// `balance_micro_usd <= 0` so a top-up self-heals the flag.
    pub fn set_org_empty(&self, org_id: &str, empty: bool) {
        if empty {
            self.empty.insert(org_id.to_string(), true);
        } else {
            self.empty.remove(org_id);
        }
    }

    /// Whether the org's wallet is currently flagged empty. Read on the pre-call
    /// budget gate; reflects the most recent debit response for that org.
    pub fn is_org_empty(&self, org_id: &str) -> bool {
        self.empty.get(org_id).map(|v| *v).unwrap_or(false)
    }
}

#[cfg(test)]
mod wallet_state_tests {
    use super::WalletState;

    #[test]
    fn unknown_org_is_not_empty() {
        let w = WalletState::default();
        assert!(!w.is_org_empty("org_1"));
    }

    #[test]
    fn set_empty_then_self_heals_on_topup() {
        let w = WalletState::default();
        // A debit drives the org non-positive.
        w.set_org_empty("org_1", true);
        assert!(w.is_org_empty("org_1"));
        // A later top-up debit response (balance > 0) clears the flag.
        w.set_org_empty("org_1", false);
        assert!(!w.is_org_empty("org_1"));
    }

    #[test]
    fn flags_are_per_org() {
        let w = WalletState::default();
        w.set_org_empty("org_1", true);
        assert!(w.is_org_empty("org_1"));
        assert!(!w.is_org_empty("org_2"));
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// A stub backend recording every `record` call and reporting a sentinel
    /// evaluate — proof the registry dispatches to a swapped-in impl.
    struct StubBackend {
        cfg: BudgetConfig,
        records: AtomicU64,
    }
    impl BudgetBackend for StubBackend {
        fn config(&self) -> &BudgetConfig {
            &self.cfg
        }
        fn evaluate(&self, _u: Option<&str>, _a: Option<&str>) -> Option<BudgetDecision> {
            Some(BudgetDecision {
                scope: BudgetScope::User,
                key: "stub".to_string(),
                action: BudgetAction::Stop,
                used: 1,
                limit: 1,
                downgrade_to: None,
                restrict_max_tokens: 0,
                alert: AlertTier::default(),
            })
        }
        fn evaluate_session(&self, _s: Option<&str>) -> Option<BudgetDecision> {
            None
        }
        fn record(&self, _u: Option<&str>, _a: Option<&str>, _t: u64) {
            self.records.fetch_add(1, Ordering::Relaxed);
        }
        fn record_session(&self, _s: Option<&str>, _t: u64) {}
    }

    #[test]
    fn builtin_is_the_default_active_backend() {
        let reg = BudgetRegistry::new(BudgetConfig::default());
        assert_eq!(reg.active_id(), BudgetRegistry::BUILTIN);
        assert_eq!(reg.available(), vec![BudgetRegistry::BUILTIN.to_string()]);
        // With an empty config the built-in reports no decision (disabled).
        let decision = reg.with_active(|b| b.evaluate(Some("u"), None));
        assert!(decision.is_none());
    }

    #[test]
    fn update_config_hot_swaps_the_builtin_live() {
        let reg = BudgetRegistry::new(BudgetConfig::default());
        // Push a config with an exhausted user budget → evaluate now triggers.
        let mut users = std::collections::HashMap::new();
        users.insert(
            "u".to_string(),
            BudgetRule {
                limit: 1,
                action: BudgetAction::Stop,
                downgrade_to: None,
                restrict_max_tokens: 256,
                alert: AlertTier::default(),
            },
        );
        let cfg = BudgetConfig {
            users,
            ..BudgetConfig::default()
        };
        reg.update_config(cfg);
        // Record past the limit through the live active backend, then evaluate.
        reg.with_active(|b| b.record(Some("u"), None, 5));
        let decision = reg.with_active(|b| b.evaluate(Some("u"), None));
        assert!(matches!(
            decision,
            Some(BudgetDecision {
                action: BudgetAction::Stop,
                ..
            })
        ));
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let reg = BudgetRegistry::new(BudgetConfig::default());
        let stub = Arc::new(StubBackend {
            cfg: BudgetConfig::default(),
            records: AtomicU64::new(0),
        });
        reg.register("stub", Arc::clone(&stub) as Arc<dyn BudgetBackend>);
        // Registered but not active: built-in still answers (no decision).
        assert!(reg.with_active(|b| b.evaluate(Some("u"), None)).is_none());

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");
        // The stub's sentinel decision now answers — the swap is live.
        assert!(reg.with_active(|b| b.evaluate(Some("u"), None)).is_some());
        reg.with_active(|b| b.record(Some("u"), None, 1));
        assert_eq!(stub.records.load(Ordering::Relaxed), 1);

        // Unknown id is a no-op keeping the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }
}
