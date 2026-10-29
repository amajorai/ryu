//! Per-user and per-agent spend budgets with local counters (data plane, U21).
//!
//! This is the data-plane half of budget enforcement: every request is checked
//! inline against in-memory counters keyed by user id and agent id (no SQLite on
//! the hot path, no network call). Exceeding a budget triggers one of four
//! configured actions — notify, downgrade, restrict, or stop.
//!
//! Cross-user / team coordination (a shared budget pool across many gateways) is
//! explicitly out of scope here; that is the control-plane coordinator (U29).
//!
//! Counters are charged spend totals in micro-USD, kept per UTC calendar
//! window (daily / weekly / monthly / lifetime, see [`BudgetWindow`]) in a
//! [`SpendStore`]. The gateway backs that store with a SQLite file next to
//! `audit.db`, so user and agent spend survives a restart and a config swap;
//! tests and audit-less gateways use the in-memory [`MemorySpendStore`]. The
//! per-session counter stays in memory: session ids are ephemeral.

use std::collections::HashMap;
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

mod spend_store;
mod window;

pub use spend_store::{
    MemorySpendStore, SpendSeal, SpendStore, SqliteSpendStore, KEY_MISMATCH, KEY_UNAVAILABLE,
    SPEND_STORE, SUBJECT_FIELD,
};
pub use window::{unix_now, BudgetWindow};

/// Spend-store scope label for per-user local budget counters.
pub const SCOPE_USER: &str = "user";
/// Spend-store scope label for per-agent local budget counters.
pub const SCOPE_AGENT: &str = "agent";
/// In-flight claim scope label for the per-session cap (sessions keep their
/// recorded spend in memory, not in the [`SpendStore`]).
const SCOPE_SESSION: &str = "session";

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
    Notify,
    /// Swap the requested model for the rule's `downgrade_to` (a cheaper model)
    /// and continue. Falls back to `Restrict` if no downgrade model is set.
    Downgrade,
    /// Allow the request but clamp it: strip tool definitions and cap
    /// `max_tokens` so an over-budget caller can still get a minimal answer.
    Restrict,
    /// Reject the request with `402 budget_exceeded`. The hard stop, and the
    /// **default**: a rule that configures a `limit` without an `action` must
    /// actually stop spend at that limit; the never-blocking `notify` is opt-in.
    #[default]
    Stop,
}

/// Which classes of charged work a budget rule includes.
///
/// The model and media paths already use the charged-USD counter. Tool calls
/// are priced separately from model inference, so keeping their inclusion
/// explicit lets an agent cap describe its intended spend rather than silently
/// mixing unlike units. Missing fields in older configs default to included,
/// preserving the meaning of a spend cap while making the new setting visible
/// to editors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct BudgetChargeInclusion {
    /// OpenRouter, direct-provider, and other Gateway-routed model calls.
    #[serde(default = "default_true")]
    pub model: bool,
    /// Image, video, TTS, and STT calls priced by the media meter.
    #[serde(default = "default_true")]
    pub media: bool,
    /// Paid third-party actions such as Composio tool executions.
    #[serde(default = "default_true")]
    pub tools: bool,
}

fn default_true() -> bool {
    true
}

impl Default for BudgetChargeInclusion {
    fn default() -> Self {
        Self {
            model: true,
            media: true,
            tools: true,
        }
    }
}

/// A charged spend category passed to the budget counter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetChargeKind {
    Model,
    Media,
    Tools,
}

impl BudgetChargeInclusion {
    fn includes(self, kind: BudgetChargeKind) -> bool {
        match kind {
            BudgetChargeKind::Model => self.model,
            BudgetChargeKind::Media => self.media,
            BudgetChargeKind::Tools => self.tools,
        }
    }
}

/// A single budget rule: a charged-spend cap plus the action taken once it is reached.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BudgetRule {
    /// Charged-spend cap in micro-USD for this scope over `window`.
    /// 1_000_000 = $1; 0 = unlimited.
    pub limit: u64,
    /// UTC calendar window `limit` is measured over. Missing in old configs →
    /// `lifetime`, the original meaning of `limit`.
    #[serde(default)]
    pub window: BudgetWindow,
    /// Action to take once `limit` is reached. Defaults to `stop` so a
    /// configured limit blocks without an explicit action.
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
    /// Charged work categories included in this rule. Missing in old configs
    /// defaults to all currently metered categories.
    #[serde(default)]
    pub include: BudgetChargeInclusion,
}

fn default_restrict_max_tokens() -> u64 {
    256
}

/// Per-user and per-agent charged-spend budgets (data plane, local counters).
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
    /// A single global per-session charged-spend cap (#510). Unlike `users`/`agents`,
    /// this is NOT a map: session ids are ephemeral (Core mints a fresh
    /// conversation id per chat), so a per-session-id rule map would be dead
    /// config nobody could populate. Instead one rule applies to every session,
    /// with the running counter keyed by the `x-ryu-session-id` header.
    #[serde(default)]
    pub session: SessionBudgetConfig,
}

/// Global per-session charged-spend budget (#510). One rule that applies to every
/// session; the running counter is keyed by session id at request time.
///
/// Mirrors [`BudgetRule`]'s shape (a charged-spend cap plus an action) so the existing
/// `decide`/`enforce_budget` machinery enforces it identically — `stop` rejects,
/// `downgrade` swaps the model, `restrict` clamps, `notify` only flags.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionBudgetConfig {
    /// Lifetime charged-spend cap in micro-USD for any single session.
    /// 1_000_000 = $1; 0 = unlimited (the feature is off).
    #[serde(default)]
    pub limit: u64,
    /// Action to take once a session reaches `limit`. Defaults to `stop` so a
    /// configured cap blocks without an explicit action.
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
    /// Charged work categories included in the per-session rule.
    #[serde(default)]
    pub include: BudgetChargeInclusion,
}

impl Default for SessionBudgetConfig {
    fn default() -> Self {
        Self {
            limit: 0,
            action: BudgetAction::default(),
            downgrade_to: None,
            restrict_max_tokens: default_restrict_max_tokens(),
            alert: AlertTier::default(),
            include: BudgetChargeInclusion::default(),
        }
    }
}

/// Exec (sandbox) budget config: count and/or wall-clock per rolling window.
///
/// Unlike the charged-spend budget (lifetime, category-shaped), exec budgets apply
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
    /// A control-plane org-wide cap (hosted `rgw_` traffic).
    Org,
    /// A control-plane per-member cap (explicit entry or the member default).
    Member,
    /// A control-plane per-team cap.
    Team,
    /// A control-plane per-gateway-key cap.
    Key,
    /// A control-plane cap shared by every gateway key of one org service
    /// account.
    ServiceAccount,
    /// A control-plane builder tag budget (Treg parity C6): spend of calls the
    /// caller tagged with `x-ryu-tags`, counted per organization and tag.
    Tag,
}

impl BudgetScope {
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetScope::User => "user",
            BudgetScope::Agent => "agent",
            BudgetScope::Session => "session",
            BudgetScope::Org => "org",
            BudgetScope::Member => "member",
            BudgetScope::Team => "team",
            BudgetScope::Key => "key",
            BudgetScope::ServiceAccount => "service_account",
            BudgetScope::Tag => "tag",
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
    /// Charged model spend used by the matching scope, in micro-USD.
    pub used: u64,
    /// Charged model spend cap for the matching scope, in micro-USD.
    pub limit: u64,
    pub downgrade_to: Option<String>,
    pub restrict_max_tokens: u64,
    /// Notification fan-out tier configured on the matched rule (orthogonal to
    /// `action`). `enforce_budget` takes the `max` across all matched decisions
    /// to build the propagated `PolicyAlert`.
    pub alert: AlertTier,
}

/// Estimated charged micro-USD of requests that were admitted but whose spend
/// is not recorded yet, per `(scope, id)`.
///
/// Spend is recorded only after a response, so without this term every request
/// in a parallel burst would be checked against the same recorded figure and a
/// `Stop` cap would bound only sequential traffic. Shared across config swaps
/// (like the [`SpendStore`]) so a hot-swap never forgets the claims held by
/// requests that are still running.
#[derive(Default)]
pub struct BudgetInFlight {
    claims: DashMap<(String, String), u64>,
}

impl BudgetInFlight {
    /// Micro-USD currently claimed by running requests for `(scope, id)`.
    pub fn claimed_micro_usd(&self, scope: &str, id: &str) -> u64 {
        self.claims
            .get(&(scope.to_owned(), id.to_owned()))
            .map_or(0, |claimed| *claimed)
    }

    /// Give a claim back. Private: the only caller is [`BudgetHold::drop`].
    fn release(&self, key: &(String, String), amount_micro_usd: u64) {
        let mut remove = false;
        if let Some(mut claimed) = self.claims.get_mut(key) {
            *claimed = claimed.saturating_sub(amount_micro_usd);
            remove = *claimed == 0;
        }
        if remove {
            // Drop the key at zero so an idle process keeps no entry per id.
            self.claims.remove_if(key, |_, claimed| *claimed == 0);
        }
    }
}

/// The in-flight claims one request holds against its user, agent, and session
/// caps, released on drop.
///
/// Same RAII contract as [`CreditReservation`]: the hold is moved into whatever
/// owns the request's lifetime and released when that owner dies, on every
/// exit path including a client hang-up or a panic. There is deliberately no
/// public `release()`. The claim is an ESTIMATE that only decides who may
/// start; the recorded charge after the response is what counts.
pub struct BudgetHold {
    in_flight: Arc<BudgetInFlight>,
    claims: Vec<((String, String), u64)>,
}

impl Drop for BudgetHold {
    fn drop(&mut self) {
        for (key, amount) in &self.claims {
            self.in_flight.release(key, *amount);
        }
    }
}

impl std::fmt::Debug for BudgetHold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BudgetHold")
            .field("claims", &self.claims)
            .finish()
    }
}

/// The result of admitting one request against its local budgets.
#[derive(Debug, Default)]
pub struct BudgetAdmission {
    /// The most restrictive user/agent decision, as
    /// [`BudgetEnforcer::evaluate_charge`] reports it.
    pub decision: Option<BudgetDecision>,
    /// The per-session decision, as [`BudgetEnforcer::evaluate_session_charge`]
    /// reports it.
    pub session: Option<BudgetDecision>,
    /// HOLD THIS FOR AS LONG AS THE REQUEST RUNS (until its spend is recorded).
    /// `None` when nothing was claimed.
    pub hold: Option<BudgetHold>,
}

/// Budget enforcer over a [`SpendStore`]. Cheap to check on the request path:
/// every read is an in-memory map lookup.
pub struct BudgetEnforcer {
    config: BudgetConfig,
    /// Windowed charged micro-USD per user id (scope [`SCOPE_USER`]) and per
    /// agent id (scope [`SCOPE_AGENT`]). Shared across config swaps.
    store: Arc<dyn SpendStore>,
    /// Estimated spend of admitted, still-running requests. Shared across
    /// config swaps.
    in_flight: Arc<BudgetInFlight>,
    /// Lifetime charged micro-USD used per session id (#510). Bounded by
    /// `MAX_SESSION_ENTRIES`; cleared wholesale on overflow.
    session_usage: DashMap<String, u64>,
    enabled: bool,
}

impl BudgetEnforcer {
    /// Build an enforcer with process-memory counters (reset on restart).
    pub fn new(config: BudgetConfig) -> Self {
        Self::with_store(config, Arc::new(MemorySpendStore::new()))
    }

    /// Build an enforcer whose user/agent counters live in `store`.
    pub fn with_store(config: BudgetConfig, store: Arc<dyn SpendStore>) -> Self {
        Self::with_store_and_in_flight(config, store, Arc::default())
    }

    /// Build an enforcer over a shared counter store and in-flight claim map,
    /// so a rebuilt enforcer keeps both recorded spend and running claims.
    pub fn with_store_and_in_flight(
        config: BudgetConfig,
        store: Arc<dyn SpendStore>,
        in_flight: Arc<BudgetInFlight>,
    ) -> Self {
        // The session cap (a single global rule) also activates enforcement, so
        // a deployment can run with ONLY a session budget configured. Forgetting
        // this would make `record` early-return and the counter never move.
        let enabled =
            !config.users.is_empty() || !config.agents.is_empty() || config.session.limit > 0;
        Self {
            config,
            store,
            in_flight,
            session_usage: DashMap::new(),
            enabled,
        }
    }

    fn used(&self, scope: &str, id: &str, rule: &BudgetRule) -> u64 {
        self.store.spent(scope, id, rule.window, unix_now())
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
        self.evaluate_charge(user_id, agent_id, BudgetChargeKind::Model)
    }

    /// Evaluate the request's user and agent budgets for a specific charged
    /// spend category. Rules that exclude the category are not candidates for
    /// this request, even when another included category exhausted the same
    /// scope's counter.
    pub fn evaluate_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        if !self.enabled {
            return None;
        }

        let mut best: Option<BudgetDecision> = None;

        if let Some(uid) = user_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self.config.users.get(uid) {
                let used = self.used(SCOPE_USER, uid, rule);
                if rule.include.includes(kind) {
                    if let Some(decision) = Self::decide(BudgetScope::User, uid, rule, used) {
                        best = Some(decision);
                    }
                }
            }
        }

        if let Some(aid) = agent_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self.config.agents.get(aid) {
                let used = self.used(SCOPE_AGENT, aid, rule);
                if rule.include.includes(kind) {
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
        self.evaluate_session_charge(session_id, BudgetChargeKind::Model)
    }

    /// Evaluate the request's per-session budget for a specific charged spend
    /// category. Excluded categories do not consume or trigger the session cap.
    pub fn evaluate_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        if !self.enabled || self.config.session.limit == 0 {
            return None;
        }
        if !self.config.session.include.includes(kind) {
            return None;
        }
        let sid = session_id.filter(|s| !s.is_empty())?;
        let used = self.session_usage.get(sid).map(|v| *v).unwrap_or(0);
        let rule = Self::session_rule(&self.config.session);
        Self::decide(BudgetScope::Session, sid, &rule, used)
    }

    /// Admit one request: decide its user, agent, and session budgets counting
    /// the estimated spend of requests already running, and claim
    /// `estimate_micro_usd` against every capped scope that does not stop it.
    ///
    /// A request is never counted against its own estimate, so a lone request
    /// sees exactly what [`Self::evaluate_charge`] and
    /// [`Self::evaluate_session_charge`] report; only concurrent requests see
    /// each other. The returned hold must live until the request's spend is
    /// recorded (or it fails).
    pub fn admit_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        estimate_micro_usd: u64,
    ) -> BudgetAdmission {
        if !self.enabled {
            return BudgetAdmission::default();
        }
        let now = unix_now();
        let mut claims = Vec::new();

        let mut decision: Option<BudgetDecision> = None;
        if let Some(uid) = user_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self
                .config
                .users
                .get(uid)
                .filter(|r| r.include.includes(kind))
            {
                let spent = self.store.spent(SCOPE_USER, uid, rule.window, now);
                decision = self.admit_scope(
                    (BudgetScope::User, SCOPE_USER),
                    uid,
                    rule,
                    spent,
                    estimate_micro_usd,
                    &mut claims,
                );
            }
        }
        if let Some(aid) = agent_id.filter(|s| !s.is_empty()) {
            if let Some(rule) = self
                .config
                .agents
                .get(aid)
                .filter(|r| r.include.includes(kind))
            {
                let spent = self.store.spent(SCOPE_AGENT, aid, rule.window, now);
                if let Some(agent) = self.admit_scope(
                    (BudgetScope::Agent, SCOPE_AGENT),
                    aid,
                    rule,
                    spent,
                    estimate_micro_usd,
                    &mut claims,
                ) {
                    decision = match decision {
                        Some(prev) if severity(prev.action) >= severity(agent.action) => Some(prev),
                        _ => Some(agent),
                    };
                }
            }
        }

        let mut session = None;
        if self.config.session.limit > 0 && self.config.session.include.includes(kind) {
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                let spent = self.session_usage.get(sid).map_or(0, |v| *v);
                let rule = Self::session_rule(&self.config.session);
                session = self.admit_scope(
                    (BudgetScope::Session, SCOPE_SESSION),
                    sid,
                    &rule,
                    spent,
                    estimate_micro_usd,
                    &mut claims,
                );
            }
        }

        let hold = (!claims.is_empty()).then(|| BudgetHold {
            in_flight: Arc::clone(&self.in_flight),
            claims,
        });
        BudgetAdmission {
            decision,
            session,
            hold,
        }
    }

    /// Decide one scope against `spent` plus the claims of running requests,
    /// and claim `estimate` unless the scope stops this request.
    ///
    /// THE ONE ATOMIC STEP, as in [`WalletState::try_reserve`]: `DashMap::entry`
    /// holds the key's write lock across read-decide-claim, so two requests
    /// arriving together cannot both see the same headroom and both take it.
    fn admit_scope(
        &self,
        (scope, label): (BudgetScope, &'static str),
        id: &str,
        rule: &BudgetRule,
        spent: u64,
        estimate: u64,
        claims: &mut Vec<((String, String), u64)>,
    ) -> Option<BudgetDecision> {
        if rule.limit == 0 {
            return None;
        }
        let key = (label.to_owned(), id.to_owned());
        let (decision, claimed) = {
            let mut in_flight = self.in_flight.claims.entry(key.clone()).or_insert(0);
            let decision = Self::decide(scope, id, rule, spent.saturating_add(*in_flight));
            let stopped = decision
                .as_ref()
                .is_some_and(|decision| decision.action == BudgetAction::Stop);
            let claimed = estimate > 0 && !stopped;
            if claimed {
                *in_flight = in_flight.saturating_add(estimate);
            }
            (decision, claimed)
        };
        if claimed {
            claims.push((key, estimate));
        } else {
            // `entry` inserted a zero for a key nobody holds; drop it again (the
            // shard lock is released, so this cannot deadlock).
            self.in_flight
                .claims
                .remove_if(&key, |_, claimed| *claimed == 0);
        }
        decision
    }

    /// Project the global [`SessionBudgetConfig`] onto a transient [`BudgetRule`]
    /// so `decide`/`record` treat a session exactly like a user/agent scope.
    fn session_rule(cfg: &SessionBudgetConfig) -> BudgetRule {
        BudgetRule {
            limit: cfg.limit,
            window: BudgetWindow::Lifetime,
            action: cfg.action,
            downgrade_to: cfg.downgrade_to.clone(),
            restrict_max_tokens: cfg.restrict_max_tokens,
            alert: cfg.alert,
            include: cfg.include,
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

    /// Record charged micro-USD against the request's user and agent counters.
    /// Only increments scopes that actually have a configured budget so the
    /// maps stay bounded by the number of budgeted identities.
    pub fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, cost_micro_usd: u64) {
        self.record_charge(user_id, agent_id, BudgetChargeKind::Model, cost_micro_usd);
    }

    /// Record a charged amount against the configured user and agent rules only
    /// when that rule includes the requested spend category.
    pub fn record_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        if !self.enabled || cost_micro_usd == 0 {
            return;
        }
        if let Some(uid) = user_id.filter(|s| !s.is_empty()) {
            if self
                .config
                .users
                .get(uid)
                .is_some_and(|rule| rule.include.includes(kind))
            {
                self.store.add(SCOPE_USER, uid, cost_micro_usd, unix_now());
            }
        }
        if let Some(aid) = agent_id.filter(|s| !s.is_empty()) {
            if self
                .config
                .agents
                .get(aid)
                .is_some_and(|rule| rule.include.includes(kind))
            {
                self.store.add(SCOPE_AGENT, aid, cost_micro_usd, unix_now());
            }
        }
    }

    /// Record charged micro-USD against the request's session counter (#510). Kept
    /// separate from `record` so the prod call sites add it alongside without
    /// churning every existing `record` test, and the session-enabled gate lives
    /// with the session logic.
    ///
    /// Only increments when the global session rule is active (`limit > 0`). The
    /// map is soft-bounded at `MAX_SESSION_ENTRIES` — on overflow it is cleared
    /// wholesale (counters are ephemeral and best-effort, so this is acceptable).
    pub fn record_session(&self, session_id: Option<&str>, cost_micro_usd: u64) {
        self.record_session_charge(session_id, BudgetChargeKind::Model, cost_micro_usd);
    }

    /// Record a charged amount against a session when the session rule includes
    /// that spend category.
    pub fn record_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        if !self.enabled || cost_micro_usd == 0 || self.config.session.limit == 0 {
            return;
        }
        if !self.config.session.include.includes(kind) {
            return;
        }
        let Some(sid) = session_id.filter(|s| !s.is_empty()) else {
            return;
        };
        if self.session_usage.len() >= MAX_SESSION_ENTRIES && !self.session_usage.contains_key(sid)
        {
            self.session_usage.clear();
        }
        *self.session_usage.entry(sid.to_string()).or_insert(0) += cost_micro_usd;
    }

    /// Charged micro-USD recorded for a user in its rule's current window
    /// (lifetime when no rule is configured). Test/observability helper.
    #[allow(dead_code)]
    pub fn user_usage(&self, user_id: &str) -> u64 {
        let window = self
            .config
            .users
            .get(user_id)
            .map_or(BudgetWindow::Lifetime, |rule| rule.window);
        self.store.spent(SCOPE_USER, user_id, window, unix_now())
    }

    /// Current lifetime charged micro-USD recorded for a session (test/observability helper).
    #[allow(dead_code)]
    pub fn session_usage(&self, session_id: &str) -> u64 {
        self.session_usage.get(session_id).map(|v| *v).unwrap_or(0)
    }

    /// Charged micro-USD recorded for an agent in its rule's current window
    /// (lifetime when no rule is configured). Test/observability helper.
    #[allow(dead_code)]
    pub fn agent_usage(&self, agent_id: &str) -> u64 {
        let window = self
            .config
            .agents
            .get(agent_id)
            .map_or(BudgetWindow::Lifetime, |rule| rule.window);
        self.store.spent(SCOPE_AGENT, agent_id, window, unix_now())
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

/// The per-user / per-agent / per-session spend budget enforcer as a swappable
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
    /// Evaluate user + agent budgets for a specific charged spend category.
    /// Legacy backends that only implement model-shaped evaluation keep that
    /// behavior for model requests and do not enforce non-model categories.
    fn evaluate_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        if kind == BudgetChargeKind::Model {
            self.evaluate(user_id, agent_id)
        } else {
            None
        }
    }
    /// Evaluate the per-session budget.
    fn evaluate_session(&self, session_id: Option<&str>) -> Option<BudgetDecision>;
    /// Evaluate the per-session budget for a specific charged spend category.
    /// Legacy backends that only implement model-shaped evaluation keep that
    /// behavior for model requests and do not enforce non-model categories.
    fn evaluate_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        if kind == BudgetChargeKind::Model {
            self.evaluate_session(session_id)
        } else {
            None
        }
    }
    /// Admit one request against its user, agent, and session budgets,
    /// counting and claiming in-flight spend (see
    /// [`BudgetEnforcer::admit_charge`]). Backends without in-flight tracking
    /// keep the read-only evaluation and claim nothing.
    fn admit_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        _estimate_micro_usd: u64,
    ) -> BudgetAdmission {
        BudgetAdmission {
            decision: self.evaluate_charge(user_id, agent_id, kind),
            session: self.evaluate_session_charge(session_id, kind),
            hold: None,
        }
    }
    /// Record charged micro-USD against user + agent counters.
    fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, cost_micro_usd: u64);
    /// Record a charged amount for a specific spend category. Backends that
    /// only implement the legacy model-shaped method keep model accounting;
    /// the built-in backend overrides this for category-aware rules.
    fn record_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        if kind == BudgetChargeKind::Model {
            self.record(user_id, agent_id, cost_micro_usd);
        }
    }
    /// Record charged micro-USD against the session counter.
    fn record_session(&self, session_id: Option<&str>, cost_micro_usd: u64);
    /// Record a charged amount for a specific session spend category.
    fn record_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        if kind == BudgetChargeKind::Model {
            self.record_session(session_id, cost_micro_usd);
        }
    }
    /// Snapshot the live per-user / per-agent / per-session spend counters for a
    /// read surface (`GET /v1/budget/spend`). Default returns an empty snapshot so
    /// a backend that keeps no local counters (e.g. a control-plane-coordinated
    /// pool, or a test stub) is not forced to implement it; the built-in
    /// [`BudgetEnforcer`] overrides it with its DashMap contents.
    fn spend_snapshot(&self) -> BudgetSpendSnapshot {
        BudgetSpendSnapshot::default()
    }
}

/// A point-in-time snapshot of the budget spend counters, keyed by identity.
/// Each figure is the charged micro-USD in the scope rule's current window —
/// the same figure the budget gate compares against that rule's `limit`. User
/// and agent counters persist across restarts when the gateway has an audit
/// database; session counters are in memory only. Consumed by the
/// `GET /v1/budget/spend` read surface so the desktop can show live spend.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BudgetSpendSnapshot {
    /// Charged micro-USD per budgeted user id, in that rule's current window.
    pub users: HashMap<String, u64>,
    /// Charged micro-USD per budgeted agent id, in that rule's current window.
    pub agents: HashMap<String, u64>,
    /// Lifetime charged micro-USD per session id (populated only when the global session
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
    fn evaluate_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        BudgetEnforcer::evaluate_charge(self, user_id, agent_id, kind)
    }
    fn evaluate_session(&self, session_id: Option<&str>) -> Option<BudgetDecision> {
        BudgetEnforcer::evaluate_session(self, session_id)
    }
    fn evaluate_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
    ) -> Option<BudgetDecision> {
        BudgetEnforcer::evaluate_session_charge(self, session_id, kind)
    }
    fn admit_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        estimate_micro_usd: u64,
    ) -> BudgetAdmission {
        BudgetEnforcer::admit_charge(
            self,
            user_id,
            agent_id,
            session_id,
            kind,
            estimate_micro_usd,
        )
    }
    fn record(&self, user_id: Option<&str>, agent_id: Option<&str>, cost_micro_usd: u64) {
        BudgetEnforcer::record(self, user_id, agent_id, cost_micro_usd);
    }
    fn record_charge(
        &self,
        user_id: Option<&str>,
        agent_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        BudgetEnforcer::record_charge(self, user_id, agent_id, kind, cost_micro_usd);
    }
    fn record_session(&self, session_id: Option<&str>, cost_micro_usd: u64) {
        BudgetEnforcer::record_session(self, session_id, cost_micro_usd);
    }
    fn record_session_charge(
        &self,
        session_id: Option<&str>,
        kind: BudgetChargeKind,
        cost_micro_usd: u64,
    ) {
        BudgetEnforcer::record_session_charge(self, session_id, kind, cost_micro_usd);
    }
    fn spend_snapshot(&self) -> BudgetSpendSnapshot {
        let now = unix_now();
        let dump = |scope: &str, rules: &HashMap<String, BudgetRule>| -> HashMap<String, u64> {
            rules
                .iter()
                .map(|(id, rule)| (id.clone(), self.store.spent(scope, id, rule.window, now)))
                .filter(|(_, spent)| *spent > 0)
                .collect()
        };
        BudgetSpendSnapshot {
            users: dump(SCOPE_USER, &self.config.users),
            agents: dump(SCOPE_AGENT, &self.config.agents),
            sessions: self
                .session_usage
                .iter()
                .map(|e| (e.key().clone(), *e.value()))
                .collect(),
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
    /// Counter store shared by every built-in rebuild, so a config swap keeps
    /// the spend already recorded.
    store: Arc<dyn SpendStore>,
    /// In-flight claims shared by every built-in rebuild, so a config swap
    /// keeps counting the requests that are still running.
    in_flight: Arc<BudgetInFlight>,
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
    /// [`BudgetEnforcer`] over process-memory counters as the default active
    /// backend.
    pub fn new(config: BudgetConfig) -> Self {
        Self::with_store(config, Arc::new(MemorySpendStore::new()))
    }

    /// Build the registry with the built-in enforcer's counters in `store`.
    pub fn with_store(config: BudgetConfig, store: Arc<dyn SpendStore>) -> Self {
        let in_flight = Arc::<BudgetInFlight>::default();
        let builtin: std::sync::Arc<dyn BudgetBackend> =
            std::sync::Arc::new(BudgetEnforcer::with_store_and_in_flight(
                config,
                Arc::clone(&store),
                Arc::clone(&in_flight),
            ));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(BudgetRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
            store,
            in_flight,
        }
    }

    /// The counter store the built-in enforcer records into.
    pub fn store(&self) -> Arc<dyn SpendStore> {
        Arc::clone(&self.store)
    }

    /// The in-flight claims the built-in enforcer admits against.
    pub fn in_flight(&self) -> Arc<BudgetInFlight> {
        Arc::clone(&self.in_flight)
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
    /// User and agent counters live in the shared store and carry over; the
    /// ephemeral per-session counters reset. Only rebuilds the built-in; a
    /// non-built-in active backend is left in place.
    pub fn update_config(&self, config: BudgetConfig) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let builtin: std::sync::Arc<dyn BudgetBackend> =
            std::sync::Arc::new(BudgetEnforcer::with_store_and_in_flight(
                config,
                Arc::clone(&self.store),
                Arc::clone(&self.in_flight),
            ));
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
            window: Default::default(),
            action,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: AlertTier::default(),
            include: BudgetChargeInclusion::default(),
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
    fn rule_without_action_defaults_to_stop() {
        // A configured `limit` with `action` omitted must block, not merely
        // notify: the enum default and the serde default are both `stop`.
        assert_eq!(BudgetAction::default(), BudgetAction::Stop);

        let r: BudgetRule = serde_json::from_str(r#"{ "limit": 10 }"#).expect("rule deserializes");
        assert_eq!(r.action, BudgetAction::Stop);
        let s: SessionBudgetConfig =
            serde_json::from_str(r#"{ "limit": 10 }"#).expect("session cfg deserializes");
        assert_eq!(s.action, BudgetAction::Stop);

        // And the enforcer actually stops at the limit.
        let e = BudgetEnforcer::new(config_with_user("u1", r));
        e.record(Some("u1"), None, 20);
        let d = e.evaluate(Some("u1"), None).expect("limit reached");
        assert_eq!(d.action, BudgetAction::Stop);
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
    fn charged_spend_uses_micro_usd_units() {
        let e = BudgetEnforcer::new(config_with_user("u1", rule(1_000_000, BudgetAction::Stop)));

        e.record(Some("u1"), None, 250_000);
        assert_eq!(e.user_usage("u1"), 250_000);
        assert!(e.evaluate(Some("u1"), None).is_none());

        e.record(Some("u1"), None, 750_000);
        let decision = e
            .evaluate(Some("u1"), None)
            .expect("the one-dollar charged-cost cap should trigger");
        assert_eq!(decision.used, 1_000_000);
        assert_eq!(decision.limit, 1_000_000);
    }

    #[test]
    fn charge_categories_can_exclude_paid_tools_without_excluding_models() {
        let mut agents = HashMap::new();
        agents.insert(
            "agent-a".to_string(),
            BudgetRule {
                limit: 1_000_000,
                window: Default::default(),
                action: BudgetAction::Stop,
                downgrade_to: None,
                restrict_max_tokens: 256,
                alert: AlertTier::default(),
                include: BudgetChargeInclusion {
                    model: true,
                    media: true,
                    tools: false,
                },
            },
        );
        let enforcer = BudgetEnforcer::new(BudgetConfig {
            agents,
            ..BudgetConfig::default()
        });

        enforcer.record_charge(None, Some("agent-a"), BudgetChargeKind::Tools, 900_000);
        assert_eq!(enforcer.agent_usage("agent-a"), 0);

        enforcer.record_charge(None, Some("agent-a"), BudgetChargeKind::Model, 900_000);
        assert_eq!(enforcer.agent_usage("agent-a"), 900_000);
    }

    #[test]
    fn charge_categories_filter_budget_enforcement_by_kind() {
        let mut rule = rule(100, BudgetAction::Stop);
        rule.include = BudgetChargeInclusion {
            model: false,
            media: true,
            tools: true,
        };
        let enforcer = BudgetEnforcer::new(config_with_user("u1", rule));

        enforcer.record_charge(Some("u1"), None, BudgetChargeKind::Media, 100);
        assert!(enforcer
            .evaluate_charge(Some("u1"), None, BudgetChargeKind::Model)
            .is_none());
        assert!(enforcer
            .evaluate_charge(Some("u1"), None, BudgetChargeKind::Media)
            .is_some());

        let session = BudgetEnforcer::new(config_with_session(SessionBudgetConfig {
            limit: 100,
            include: BudgetChargeInclusion {
                model: false,
                media: true,
                tools: true,
            },
            ..SessionBudgetConfig::default()
        }));
        session.record_session_charge(Some("s1"), BudgetChargeKind::Media, 100);
        assert!(session
            .evaluate_session_charge(Some("s1"), BudgetChargeKind::Model)
            .is_none());
        assert!(session
            .evaluate_session_charge(Some("s1"), BudgetChargeKind::Media)
            .is_some());
    }

    #[test]
    fn old_rules_default_to_all_metered_charge_categories() {
        let rule: BudgetRule =
            serde_json::from_str(r#"{ "limit": 10 }"#).expect("legacy rule deserializes");
        assert_eq!(rule.include, BudgetChargeInclusion::default());

        let session: SessionBudgetConfig =
            serde_json::from_str(r#"{ "limit": 10 }"#).expect("legacy session rule deserializes");
        assert_eq!(session.include, BudgetChargeInclusion::default());
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
            window: Default::default(),
            action: BudgetAction::Downgrade,
            downgrade_to: Some("gpt-4o-mini".to_string()),
            restrict_max_tokens: 256,
            alert: AlertTier::default(),
            include: BudgetChargeInclusion::default(),
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
    fn agent_rules_are_independent_and_trigger_on_agent_id() {
        let mut agents = HashMap::new();
        agents.insert("agent-a".to_string(), rule(100, BudgetAction::Stop));
        let enforcer = BudgetEnforcer::new(BudgetConfig {
            agents,
            ..BudgetConfig::default()
        });

        enforcer.record(None, Some("agent-a"), 60);
        enforcer.record(None, Some("agent-b"), 1_000);

        assert_eq!(enforcer.agent_usage("agent-a"), 60);
        assert_eq!(enforcer.agent_usage("agent-b"), 0);
        assert!(enforcer.evaluate(None, Some("agent-a")).is_none());
        assert!(enforcer.evaluate(None, Some("agent-b")).is_none());

        enforcer.record(None, Some("agent-a"), 40);
        let decision = enforcer
            .evaluate(None, Some("agent-a"))
            .expect("the matching agent cap should trigger");
        assert_eq!(decision.scope, BudgetScope::Agent);
        assert_eq!(decision.key, "agent-a");
        assert_eq!(decision.action, BudgetAction::Stop);
        assert_eq!(decision.used, 100);
        assert_eq!(decision.limit, 100);
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
            include: BudgetChargeInclusion::default(),
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
// Per-period exec-event budget. Unlike the charged-spend budget (lifetime, category-shaped,
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

/// Cache of which org wallets are currently empty (balance ≤ 0), plus the last
/// balance actually observed.
///
/// Keyed by org id. A missing entry means "not empty" (allowed). Cheap to read
/// on the hot path; written best-effort by the debit hook after each metered
/// call. Lives only in memory — a restart clears it, and the next debit
/// repopulates it; the durable truth is the control-plane ledger.
///
/// The empty *flag* is what gates a request; the *balance* exists because
/// "empty or not" cannot answer a threshold question. Core's fallback rules are
/// written in dollars ("under $5 use the cheap model"), and this cache is the
/// only place inside the node where the authoritative figure lands — the debit
/// response carries it on every metered call. A fail-closed debit failure sets
/// the flag WITHOUT inventing a balance: we know the org must be gated, we do
/// not know what it holds, and reporting a made-up number would fire a
/// dollar-threshold rule on a transport error.

/// `in_flight_micro_usd` is the third field and the one that makes the other two
/// safe under concurrency. See [`WalletState::try_reserve`].
///
/// `balance_reported` timestamps the last debit's balance report, so a request
/// can tell whether the balance its admission read from the control-plane
/// resolve is older than that report. See
/// [`WalletState::balance_reported_after`].
#[derive(Default)]
pub struct WalletState {
    accounting_unavailable: DashMap<String, bool>,
    empty: DashMap<String, bool>,
    balance_micro_usd: DashMap<String, i64>,
    in_flight_micro_usd: DashMap<String, i64>,
    /// The last debit-reported balance and when it arrived.
    balance_reported: DashMap<String, (i64, Instant)>,
}

/// A claim on part of an org's balance, held for the life of one request.
///
/// RAII IS THE WHOLE DESIGN. Metering is post-paid — the request is served, then
/// debited — so the only way to stop N concurrent requests from all spending the
/// same balance is to subtract what is *about to* be spent before dispatch. That
/// subtraction has to be given back on EVERY exit: success, provider error,
/// budget rejection downstream, a client that hangs up mid-stream, a panic. A
/// reservation that leaks is strictly worse than the overdraft it prevents,
/// because it locks a paying customer out of their own balance until the process
/// restarts, and it leaks silently.
///
/// So releasing is not a call any code path is trusted to make. It is [`Drop`],
/// which the compiler runs on every one of those paths including unwind. The
/// permit is moved into whatever owns the request's lifetime — a local on the
/// non-streaming handlers, `StreamObserverState` on the streaming one — and the
/// release happens when that owner dies. There is deliberately no public
/// `release()`: a manual release is a second way to do it, and the two would
/// eventually disagree.
///
/// The reservation is an ESTIMATE, and it is never the thing that bills. The
/// authoritative charge is the post-call debit against the control-plane ledger;
/// this only decides who is allowed to start.
pub struct CreditReservation {
    wallet: Arc<WalletState>,
    org_id: String,
    amount_micro_usd: i64,
}

impl CreditReservation {
    /// What this permit is holding, in micro-USD. Observability only.
    pub fn amount_micro_usd(&self) -> i64 {
        self.amount_micro_usd
    }
}

impl Drop for CreditReservation {
    fn drop(&mut self) {
        self.wallet
            .release_in_flight(&self.org_id, self.amount_micro_usd);
    }
}

impl std::fmt::Debug for CreditReservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreditReservation")
            .field("org_id", &self.org_id)
            .field("amount_micro_usd", &self.amount_micro_usd)
            .finish()
    }
}

impl WalletState {
    /// Mark the control-plane accounting path unavailable for an org. This is
    /// separate from `empty`: a transport failure must reject provider spend
    /// with a retryable 503, not strand a funded org behind wallet-empty rules.
    pub fn set_org_accounting_unavailable(&self, org_id: &str, unavailable: bool) {
        if unavailable {
            self.accounting_unavailable.insert(org_id.to_string(), true);
        } else {
            self.accounting_unavailable.remove(org_id);
        }
    }

    /// Whether a managed org's latest debit could not be accounted for.
    pub fn is_org_accounting_unavailable(&self, org_id: &str) -> bool {
        self.accounting_unavailable
            .get(org_id)
            .map(|value| *value)
            .unwrap_or(false)
    }

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

    /// Record the authoritative balance the control plane just reported, and
    /// derive the empty flag from it — the two can then never disagree.
    pub fn set_org_balance(&self, org_id: &str, balance_micro_usd: i64) {
        self.balance_micro_usd
            .insert(org_id.to_string(), balance_micro_usd);
        self.balance_reported
            .insert(org_id.to_string(), (balance_micro_usd, Instant::now()));
        self.set_org_accounting_unavailable(org_id, false);
        self.set_org_empty(org_id, balance_micro_usd <= 0);
    }

    /// The balance the last debit reported, when it arrived AFTER
    /// `resolved_at`; otherwise `None`.
    ///
    /// A request's budget comes from the resolve cache, which can be up to a
    /// minute old, while each debit response reports the balance after that
    /// debit. Read on its own, the cached figure lets parallel requests spend a
    /// balance a large debit has already used. A report newer than the
    /// resolve the request's figures came from is the fresher truth.
    ///
    /// `resolved_at` is that request's own resolve. Resolutions are cached per
    /// credential and operation, so another entry of the same org resolving
    /// later says nothing about how old this request's figures are.
    ///
    /// `None` keeps the resolved figure: no debit has reported, or the resolve
    /// is at least as new as the report, as after a top-up is picked up on the
    /// next resolve.
    pub fn balance_reported_after(&self, org_id: &str, resolved_at: Instant) -> Option<i64> {
        let (balance, reported_at) = *self.balance_reported.get(org_id)?;
        (reported_at > resolved_at).then_some(balance)
    }

    /// The last observed balance for an org, or `None` when no debit has
    /// resolved one on this node yet. `None` means *unknown*, never zero.
    pub fn org_balance_micro_usd(&self, org_id: &str) -> Option<i64> {
        self.balance_micro_usd.get(org_id).map(|v| *v)
    }

    /// The single balance to report when the caller names no org.
    ///
    /// A node is a one-org place in practice (Core resolves exactly one org for
    /// its metered calls), so the common case is a single entry and returning it
    /// lets Core ask without knowing an org id it has no other use for. With
    /// more than one org cached, refuse rather than guess: picking an arbitrary
    /// wallet would silently answer a threshold rule with the wrong balance.
    pub fn sole_balance_micro_usd(&self) -> Option<i64> {
        if self.balance_micro_usd.len() != 1 {
            return None;
        }
        self.balance_micro_usd.iter().next().map(|e| *e.value())
    }

    /// Micro-USD currently reserved by in-flight requests for an org.
    pub fn in_flight_micro_usd(&self, org_id: &str) -> i64 {
        self.in_flight_micro_usd
            .get(org_id)
            .map(|v| *v)
            .unwrap_or(0)
    }

    /// Claim `amount_micro_usd` against `available_micro_usd`, or refuse.
    ///
    /// THE ONE ATOMIC STEP. `DashMap::entry` holds a per-key write lock across
    /// the read-check-write, so two requests arriving in the same instant cannot
    /// both observe the same headroom and both take it — which is exactly the
    /// bug this exists to fix, and it would survive any implementation that read
    /// the counter, decided, and then wrote.
    ///
    /// `available_micro_usd` is passed in rather than read from
    /// `balance_micro_usd` because the caller knows which balance applies: the
    /// gateway gates on the control-plane-resolved *pool-aware* figure, and a
    /// pooled request may draw on grant money that the flat per-org balance
    /// cached here does not describe. Keeping the policy at the call site leaves
    /// this function with one job — arithmetic nobody else can interleave with.
    ///
    /// A non-positive `amount_micro_usd` reserves nothing and always succeeds
    /// with a zero permit: an estimate of zero is a request we have no basis to
    /// refuse, and turning "no estimate" into "denied" would take the gateway
    /// down for every modality whose cost is not known up front.
    pub fn try_reserve(
        self: &Arc<Self>,
        org_id: &str,
        amount_micro_usd: i64,
        available_micro_usd: i64,
    ) -> Option<CreditReservation> {
        let amount = amount_micro_usd.max(0);
        let mut entry = self
            .in_flight_micro_usd
            .entry(org_id.to_string())
            .or_insert(0);
        // `>` not `>=`: a request whose estimate exactly consumes the remaining
        // balance is the last one that should be admitted, not the first one
        // refused. Overdraft is bounded by the estimate's error, which is the
        // honest bound — see the note on estimation at the call site.
        if amount > 0 && entry.saturating_add(amount) > available_micro_usd {
            return None;
        }
        *entry = entry.saturating_add(amount);
        Some(CreditReservation {
            wallet: Arc::clone(self),
            org_id: org_id.to_string(),
            amount_micro_usd: amount,
        })
    }

    /// Give a claim back. Private: the only caller is [`CreditReservation::drop`],
    /// because a release anyone can call is a release someone will call twice.
    fn release_in_flight(&self, org_id: &str, amount_micro_usd: i64) {
        if amount_micro_usd <= 0 {
            return;
        }
        let mut remove = false;
        if let Some(mut entry) = self.in_flight_micro_usd.get_mut(org_id) {
            // `max(0)` is a floor against an accounting slip, not an expected
            // path: going negative here would silently hand an org unlimited
            // headroom, which is the failure this whole mechanism exists to
            // prevent, so it is clamped rather than trusted.
            *entry = (*entry).saturating_sub(amount_micro_usd);
            remove = *entry == 0;
        }
        if remove {
            // Drop the key at zero so an idle process does not retain an entry
            // per org it has ever served.
            self.in_flight_micro_usd.remove_if(org_id, |_, v| *v == 0);
        }
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

    #[test]
    fn balance_is_unknown_until_a_debit_reports_one() {
        let w = WalletState::default();
        assert_eq!(w.org_balance_micro_usd("org_1"), None);
        // A fail-closed debit failure gates the org but must NOT invent a figure.
        w.set_org_empty("org_1", true);
        assert!(w.is_org_empty("org_1"));
        assert_eq!(w.org_balance_micro_usd("org_1"), None);
    }

    #[test]
    fn setting_a_balance_derives_the_empty_flag() {
        let w = WalletState::default();
        w.set_org_balance("org_1", 4_200_000);
        assert_eq!(w.org_balance_micro_usd("org_1"), Some(4_200_000));
        assert!(!w.is_org_empty("org_1"));
        w.set_org_balance("org_1", 0);
        assert!(w.is_org_empty("org_1"));
        // A top-up self-heals both.
        w.set_org_balance("org_1", 10_000_000);
        assert!(!w.is_org_empty("org_1"));
        assert_eq!(w.org_balance_micro_usd("org_1"), Some(10_000_000));
    }

    #[test]
    fn accounting_outage_is_distinct_and_clears_on_authoritative_balance() {
        let w = WalletState::default();
        w.set_org_accounting_unavailable("org_1", true);
        assert!(w.is_org_accounting_unavailable("org_1"));
        assert!(!w.is_org_empty("org_1"));

        w.set_org_balance("org_1", 10_000_000);
        assert!(!w.is_org_accounting_unavailable("org_1"));
        assert!(!w.is_org_empty("org_1"));
    }

    #[test]
    fn a_debit_report_counts_only_when_newer_than_the_resolve() {
        use std::time::{Duration, Instant};
        let w = WalletState::default();
        let resolved = Instant::now();
        // No debit has reported a balance.
        assert_eq!(w.balance_reported_after("org_1", resolved), None);

        // A debit reported after the resolve is the fresher figure.
        std::thread::sleep(Duration::from_millis(2));
        w.set_org_balance("org_1", 400_000);
        assert_eq!(w.balance_reported_after("org_1", resolved), Some(400_000));
        assert_eq!(w.balance_reported_after("org_2", resolved), None);

        // A resolve fetched after the report (a top-up is picked up) wins.
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(w.balance_reported_after("org_1", Instant::now()), None);
        // The earlier resolve still sees the report: each request compares
        // against its own resolve, not the org's newest.
        assert_eq!(w.balance_reported_after("org_1", resolved), Some(400_000));
    }

    #[test]
    fn sole_balance_refuses_to_guess_between_orgs() {
        let w = WalletState::default();
        assert_eq!(w.sole_balance_micro_usd(), None);
        w.set_org_balance("org_1", 1_000_000);
        assert_eq!(w.sole_balance_micro_usd(), Some(1_000_000));
        w.set_org_balance("org_2", 9_000_000);
        assert_eq!(w.sole_balance_micro_usd(), None);
    }
}

#[cfg(test)]
mod credit_reservation_tests {
    use super::WalletState;
    use std::sync::Arc;

    const USD: i64 = 1_000_000;

    #[test]
    fn concurrent_requests_cannot_all_spend_the_same_balance() {
        // THE BUG THIS EXISTS FOR. Metering is post-paid, so without a
        // reservation every request in flight at one instant sees the same
        // pre-debit balance and all of them pass.
        let w = Arc::new(WalletState::default());
        let balance = 10 * USD;

        let held: Vec<_> = (0..10)
            .filter_map(|_| w.try_reserve("org_1", USD, balance))
            .collect();

        assert_eq!(held.len(), 10, "ten $1 requests fit in a $10 balance");
        assert!(
            w.try_reserve("org_1", USD, balance).is_none(),
            "the eleventh must be refused — the balance is fully claimed"
        );
        assert_eq!(w.in_flight_micro_usd("org_1"), 10 * USD);
    }

    #[test]
    fn dropping_a_permit_returns_the_headroom() {
        let w = Arc::new(WalletState::default());
        let balance = 2 * USD;

        let first = w.try_reserve("org_1", 2 * USD, balance).unwrap();
        assert!(w.try_reserve("org_1", USD, balance).is_none());

        drop(first);

        assert_eq!(w.in_flight_micro_usd("org_1"), 0);
        assert!(
            w.try_reserve("org_1", USD, balance).is_some(),
            "the freed headroom is immediately reusable"
        );
    }

    #[test]
    fn a_permit_is_released_on_an_unwinding_path() {
        // The reason release is `Drop` and not a call: no exit path can forget.
        let w = Arc::new(WalletState::default());
        let wallet = Arc::clone(&w);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _permit = wallet.try_reserve("org_1", 5 * USD, 5 * USD).unwrap();
            panic!("provider blew up mid-request");
        }));
        assert!(panicked.is_err());
        assert_eq!(
            w.in_flight_micro_usd("org_1"),
            0,
            "an unwind must not strand the claim"
        );
    }

    #[test]
    fn reservations_are_per_org() {
        let w = Arc::new(WalletState::default());
        let _held = w.try_reserve("org_1", USD, USD).unwrap();
        assert!(w.try_reserve("org_1", USD, USD).is_none());
        assert!(
            w.try_reserve("org_2", USD, USD).is_some(),
            "one org exhausting its balance must not gate another"
        );
    }

    #[test]
    fn an_exactly_fitting_request_is_admitted() {
        // `>` not `>=`: the request that exactly consumes the balance is the last
        // one allowed in, not the first one refused.
        let w = Arc::new(WalletState::default());
        assert!(w.try_reserve("org_1", 5 * USD, 5 * USD).is_some());
    }

    #[test]
    fn a_zero_estimate_is_admitted_without_claiming_anything() {
        // Modalities whose cost is not knowable up front must not be denied;
        // "no estimate" is not "no money".
        let w = Arc::new(WalletState::default());
        let permit = w.try_reserve("org_1", 0, 0).expect("admitted");
        assert_eq!(permit.amount_micro_usd(), 0);
        assert_eq!(w.in_flight_micro_usd("org_1"), 0);
    }

    #[test]
    fn an_empty_balance_admits_nothing_positive() {
        // Closes the "a wallet holding one micro-USD serves a frontier request"
        // hole: the gate is now the ESTIMATE against the balance, not `<= 0`.
        let w = Arc::new(WalletState::default());
        assert!(w.try_reserve("org_1", USD, 1).is_none());
        assert!(w.try_reserve("org_1", USD, 0).is_none());
        assert!(w.try_reserve("org_1", USD, -5 * USD).is_none());
    }

    #[test]
    fn the_in_flight_key_does_not_leak_per_org_forever() {
        let w = Arc::new(WalletState::default());
        drop(w.try_reserve("org_1", USD, USD).unwrap());
        assert_eq!(w.in_flight_micro_usd("org_1"), 0);
    }

    #[test]
    fn parallel_reservers_never_oversubscribe() {
        // The check-then-write is inside one `entry` lock; this is the test that
        // would fail if it were ever split into a read and a write.
        let w = Arc::new(WalletState::default());
        let balance = 50 * USD;
        let mut handles = Vec::new();
        for _ in 0..8 {
            let wallet = Arc::clone(&w);
            handles.push(std::thread::spawn(move || {
                let mut mine = Vec::new();
                for _ in 0..25 {
                    if let Some(p) = wallet.try_reserve("org_1", USD, balance) {
                        mine.push(p);
                    }
                }
                mine
            }));
        }
        let held: Vec<_> = handles
            .into_iter()
            .flat_map(|h| h.join().expect("thread panicked"))
            .collect();

        assert_eq!(
            held.len() as i64,
            50,
            "exactly the balance's worth of $1 permits may exist at once"
        );
        assert_eq!(w.in_flight_micro_usd("org_1"), balance);
        drop(held);
        assert_eq!(w.in_flight_micro_usd("org_1"), 0);
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
                window: Default::default(),
                action: BudgetAction::Stop,
                downgrade_to: None,
                restrict_max_tokens: 256,
                alert: AlertTier::default(),
                include: BudgetChargeInclusion::default(),
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

    fn user_rule(limit: u64, window: BudgetWindow) -> BudgetConfig {
        let mut users = std::collections::HashMap::new();
        users.insert(
            "u".to_string(),
            BudgetRule {
                limit,
                window,
                action: BudgetAction::Stop,
                downgrade_to: None,
                restrict_max_tokens: 256,
                alert: AlertTier::default(),
                include: BudgetChargeInclusion::default(),
            },
        );
        BudgetConfig {
            users,
            ..BudgetConfig::default()
        }
    }

    #[test]
    fn update_config_keeps_recorded_spend_in_the_shared_store() {
        let reg = BudgetRegistry::new(user_rule(10, BudgetWindow::Lifetime));
        reg.with_active(|b| b.record(Some("u"), None, 6));
        assert!(reg.with_active(|b| b.evaluate(Some("u"), None)).is_none());
        // Lowering the cap must see the 6 already spent, not a reset counter.
        reg.update_config(user_rule(5, BudgetWindow::Lifetime));
        assert!(reg.with_active(|b| b.evaluate(Some("u"), None)).is_some());
        assert_eq!(
            reg.store()
                .spent(SCOPE_USER, "u", BudgetWindow::Daily, unix_now()),
            6
        );
    }

    #[test]
    fn a_daily_rule_ignores_yesterdays_spend() {
        let store: Arc<dyn SpendStore> = Arc::new(MemorySpendStore::new());
        store.add(SCOPE_USER, "u", 100, unix_now() - 86_400);
        let daily =
            BudgetEnforcer::with_store(user_rule(50, BudgetWindow::Daily), Arc::clone(&store));
        assert!(daily.evaluate(Some("u"), None).is_none());
        let lifetime = BudgetEnforcer::with_store(user_rule(50, BudgetWindow::Lifetime), store);
        let decision = lifetime
            .evaluate(Some("u"), None)
            .expect("lifetime cap reached");
        assert_eq!(decision.used, 100);
    }

    #[test]
    fn rule_window_defaults_to_lifetime_and_parses() {
        let legacy: BudgetRule = serde_json::from_str(r#"{ "limit": 10 }"#).unwrap();
        assert_eq!(legacy.window, BudgetWindow::Lifetime);
        let monthly: BudgetRule =
            serde_json::from_str(r#"{ "limit": 10, "window": "monthly" }"#).unwrap();
        assert_eq!(monthly.window, BudgetWindow::Monthly);
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

    const USD: u64 = 1_000_000;

    fn admit(enforcer: &BudgetEnforcer, estimate: u64) -> BudgetAdmission {
        enforcer.admit_charge(Some("u"), None, None, BudgetChargeKind::Model, estimate)
    }

    fn stopped(admission: &BudgetAdmission) -> bool {
        admission
            .decision
            .as_ref()
            .is_some_and(|decision| decision.action == BudgetAction::Stop)
    }

    #[test]
    fn stop_cap_counts_in_flight_admissions() {
        let enforcer = BudgetEnforcer::new(user_rule(5 * USD, BudgetWindow::Lifetime));
        enforcer.record(Some("u"), None, 4_900_000);

        // A lone request is never counted against its own estimate.
        let first = admit(&enforcer, 200_000);
        assert!(first.decision.is_none());
        assert!(first.hold.is_some());
        // While it runs, its claim fills the remaining headroom.
        let second = admit(&enforcer, 200_000);
        assert!(stopped(&second), "{:?}", second.decision);
        assert!(second.hold.is_none(), "a stopped request claims nothing");
        assert_eq!(second.decision.as_ref().unwrap().used, 5_100_000);
        // The read-only check is unchanged and still sees recorded spend only.
        assert!(enforcer.evaluate(Some("u"), None).is_none());

        drop(first);
        assert_eq!(enforcer.in_flight.claimed_micro_usd(SCOPE_USER, "u"), 0);
        assert!(enforcer.in_flight.claims.is_empty());
        assert!(admit(&enforcer, 200_000).decision.is_none());
    }

    #[test]
    fn session_cap_counts_in_flight_admissions() {
        let enforcer = BudgetEnforcer::new(BudgetConfig {
            session: SessionBudgetConfig {
                limit: 100,
                ..SessionBudgetConfig::default()
            },
            ..BudgetConfig::default()
        });
        enforcer.record_session(Some("s"), 90);
        let admit_session =
            || enforcer.admit_charge(None, None, Some("s"), BudgetChargeKind::Model, 10);
        let first = admit_session();
        assert!(first.session.is_none());
        let second = admit_session();
        assert_eq!(
            second.session.as_ref().map(|decision| decision.action),
            Some(BudgetAction::Stop)
        );
        drop(first);
        assert!(admit_session().session.is_none());
        assert!(enforcer.in_flight.claims.is_empty());
    }

    #[test]
    fn parallel_admissions_never_exceed_headroom() {
        let enforcer = BudgetEnforcer::new(user_rule(10 * USD, BudgetWindow::Lifetime));
        let holds = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..32 {
                scope.spawn(|| {
                    let admission = admit(&enforcer, USD);
                    if !stopped(&admission) {
                        holds.lock().unwrap().push(admission.hold);
                    }
                });
            }
        });
        let holds = holds.into_inner().unwrap();
        assert_eq!(holds.len(), 10, "exactly the headroom is admitted");
        assert_eq!(
            enforcer.in_flight.claimed_micro_usd(SCOPE_USER, "u"),
            10 * USD
        );
        drop(holds);
        assert!(enforcer.in_flight.claims.is_empty());
    }

    #[test]
    fn in_flight_claims_survive_config_swap() {
        let reg = BudgetRegistry::new(user_rule(10, BudgetWindow::Lifetime));
        reg.with_active(|b| b.record(Some("u"), None, 5));
        let held =
            reg.with_active(|b| b.admit_charge(Some("u"), None, None, BudgetChargeKind::Model, 5));
        assert!(held.decision.is_none());
        // A rebuilt enforcer still counts the request that is running.
        reg.update_config(user_rule(10, BudgetWindow::Lifetime));
        let blocked =
            reg.with_active(|b| b.admit_charge(Some("u"), None, None, BudgetChargeKind::Model, 5));
        assert!(stopped(&blocked), "{:?}", blocked.decision);
        drop(held);
        assert_eq!(reg.in_flight().claimed_micro_usd(SCOPE_USER, "u"), 0);
        let admitted =
            reg.with_active(|b| b.admit_charge(Some("u"), None, None, BudgetChargeKind::Model, 5));
        assert!(admitted.decision.is_none());
    }

    #[test]
    fn backends_without_in_flight_tracking_fall_back_to_evaluate() {
        let stub = StubBackend {
            cfg: BudgetConfig::default(),
            records: AtomicU64::new(0),
        };
        let admission = stub.admit_charge(Some("u"), None, None, BudgetChargeKind::Model, USD);
        assert!(stopped(&admission));
        assert!(admission.hold.is_none());
    }
}
