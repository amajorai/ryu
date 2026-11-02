use std::sync::{atomic::AtomicI64, Arc, OnceLock, RwLock};

use crate::{
    audit::{AuditLogger, AuditRegistry},
    budget::{BudgetBackend, BudgetRegistry, ExecBudgetEnforcer, SharedBudgetState, WalletState},
    cache::CacheRegistry,
    circuit_breaker::CircuitBreakerRegistry,
    composio::ComposioClient,
    concurrency::ConcurrencyLimiter,
    config::{ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, GatewayConfig},
    evals::EvalsRegistry,
    firewall::{
        resolve::{FirewallResolver, PolicyBundle},
        FirewallRegistry, FirewallScanner,
    },
    jobs::MediaJobStore,
    metrics::Metrics,
    passthrough::PassthroughRegistry,
    phone_calls::PhoneCallHub,
    pipeline::RequestContext,
    policy::{EffectivePolicy, ResolveCache},
    providers::{ProviderRegistry, ProviderRuntime},
    quota::ProviderQuotas,
    rate_limit::RateLimiterRegistry,
    responses_store::ResponsesStore,
    router::{
        smart::{SmartRouter, SmartRouterBackend, SmartRouterRegistry},
        RouterRegistry,
    },
    semantic_cache::{SemanticCache, SemanticCacheRegistry},
    skills::SkillsRegistry,
    tools::ToolSearchClient,
    traffic::TrafficBus,
    treg::TregClient,
    wasm_policy::WasmPolicyHost,
};

/// Receiver half of the online-eval queue, drained by `online_evals::spawn_worker`.
pub(crate) type OnlineEvalReceiver =
    tokio::sync::mpsc::Receiver<crate::evals::online::OnlineEvalJob<RequestContext>>;

/// Reject an `[evals.online]` block that references unknown or
/// offline-unavailable evaluators before the Gateway starts serving.
pub(crate) fn validate_online_evals(config: &GatewayConfig) -> Result<(), String> {
    validate_online_evals_against(&config.evals.online, &config.custom_evaluators)
}

/// [`validate_online_evals`] against an explicit custom-evaluator set, so
/// `PUT /v1/config` can refuse a custom-evaluator change that would orphan an
/// `[evals.online]` reference (and make the next Gateway start fail).
pub(crate) fn validate_online_evals_against(
    online: &crate::evals::OnlineEvalsConfig,
    custom: &[crate::evaluators::Evaluator],
) -> Result<(), String> {
    online.validate()?;
    let registry = crate::evaluators::EvaluatorRegistry::from_custom(custom);
    let ids: Vec<String> = online
        .referenced_evaluators()
        .into_iter()
        .map(str::to_owned)
        .collect();
    if let Some(unknown) = ids.iter().find(|id| registry.get(id).is_none()) {
        return Err(format!(
            "evals.online references unknown evaluator '{unknown}'"
        ));
    }
    registry
        .validate_offline_ids(&ids)
        .map_err(|error| format!("evals.online: {error}"))
}

pub struct AppState {
    pub config: GatewayConfig,
    /// Resolved, validated pre-processing stage order (W6d). Built ONCE here at
    /// config-apply time from `config.pipeline` and iterated by
    /// [`crate::pipeline::pre_process`], so the request hot path pays zero
    /// per-request allocation to know the order â€” it borrows this pre-resolved
    /// slice. Default = [`crate::pipeline::stages::DEFAULT_ORDER`] (the exact
    /// pre-W6d sequence).
    pub stage_order: crate::pipeline::stages::StageOrder,
    /// Capture once per request before routing/governance/dispatch.
    pub provider_runtime: ProviderRuntime,
    /// Classifier-driven model routing (custom routing instructions). Inert
    /// unless `config.routing.smart_routing` is active; holds a per-session
    /// decision cache.
    ///
    /// `RwLock<Arc<â€¦>>` so `PUT /v1/config { routing: { smart_routing â€¦ } }` can
    /// **hot-swap** the smart router without a gateway restart â€” the same live-swap
    /// discipline as `firewall`/`budget`, but Arc-wrapped because
    /// [`SmartRouter::resolve`] is async and is held across an `.await` on the
    /// request path (a read guard cannot be). Callers clone the `Arc` out under a
    /// brief read lock (see [`Self::smart_router`]) and keep it across the await.
    /// Only `routing.smart_routing` swaps here; the [`Self::router`] model-map /
    /// fallback / tiers remain a startup snapshot (restart-only).
    ///
    /// W6c: now a swappable [`SmartRouterRegistry`] (async backend, `Arc`-yielding)
    /// whose built-in is the [`SmartRouter`]. `update_smart_router` hot-swaps the
    /// built-in â€” the same live-swap the old `RwLock<Arc<SmartRouter>>` gave.
    pub smart_router: SmartRouterRegistry,
    /// Per-agent smart-routing override cache (the "both" config scope: global
    /// `smart_router` is the default, an agent may override it). Keyed by a stable
    /// hash of the override [`SmartRoutingConfig`] JSON that Core injects as the
    /// private `ryu_smart_route` request-body field; each distinct config gets one
    /// ephemeral [`SmartRouter`] so its rule-embedding + session caches are reused
    /// across that agent's turns. Empty until an override is first seen.
    pub per_agent_routers: crate::router::smart::bounded::BoundedCache<String, Arc<SmartRouter>>,
    /// `RwLock` so `PUT /v1/config` can hot-swap the scanner without a restart.
    /// This is the **node-level** scanner: it still serves the outbound-scan,
    /// error-redaction, and multimodal paths, and it alone owns the process-global
    /// untrusted-wrapping flag. The per-request *resolved* (nodeâ†’orgâ†’agent)
    /// scanner used by the chat inbound/locked/companion paths comes from
    /// [`Self::resolver`] instead.
    ///
    /// W6c: now a swappable [`FirewallRegistry`] whose built-in is the
    /// [`FirewallScanner`]. `with_firewall` delegates to the active backend;
    /// `update_firewall_config` hot-swaps the built-in â€” same live-swap as before.
    pub firewall: FirewallRegistry,
    /// Hierarchical firewall resolver (node â†’ org â†’ agent cascade, #hierarchical
    /// policy). Holds the standalone-local org/agent overlay stores and a
    /// compiled-scanner cache; hands per-request scanners to
    /// [`Self::with_resolved_firewall`]. Its own internal `RwLock`s carry the
    /// poison-recovery discipline, so it is stored directly (not wrapped).
    pub resolver: FirewallResolver,
    /// Native-format passthrough reverse proxy (Claude Code / Codex) as a
    /// swappable registry (W6c decomposition): the built-in
    /// [`crate::passthrough::BuiltinPassthrough`] is the default active backend.
    /// The `/passthrough/*` handlers delegate through [`PassthroughRegistry::active`].
    pub passthrough: PassthroughRegistry,
    /// Per-key rate limiter as a swappable registry (Lg decomposition): the
    /// built-in in-process [`crate::rate_limit::RateLimiter`] is the default
    /// active backend. HOT primitive â€” in-process swap only, never IPC.
    pub rate_limiter: RateLimiterRegistry,
    /// Exact-match response cache as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::cache::Cache`] is the default active
    /// backend; a plugin backend can register without touching the pipeline.
    pub cache: CacheRegistry,
    /// Per-provider circuit breaker as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::circuit_breaker::CircuitBreakers`] is the
    /// default active backend. HOT primitive â€” in-process swap only, never IPC.
    pub circuit_breaker: CircuitBreakerRegistry,
    /// Priority admission queue for the resident local engine (interactive ahead
    /// of background fan-out). Inert for remote providers and when disabled.
    /// A startup snapshot of `config.concurrency` (applies on the next restart).
    pub admission: ConcurrencyLimiter,
    pub skills: SkillsRegistry,
    /// Bounded, credential-scoped in-memory state for Responses API continuation.
    pub response_states: ResponsesStore,
    /// Audit sink as a swappable registry (Lg decomposition): the built-in
    /// [`crate::audit::AuditLogger`] is the default active backend.
    pub audit: AuditRegistry,
    /// Charged-spend budget enforcer as a swappable, live-swap registry (Lg
    /// decomposition): the built-in [`crate::budget::BudgetEnforcer`] is the
    /// default active backend. `PUT /v1/config` hot-swaps it without a restart
    /// (see [`Self::update_budget_config`]); a plugin backend can register.
    pub budget: BudgetRegistry,
    /// Windowed charged-spend counters shared by the local budget enforcer
    /// (scopes `user` / `agent`) and the control-plane org limits (scopes `org`
    /// / `member` / `team` / `key`). SQLite next to `audit.db` when auditing is
    /// enabled, so spend survives a restart; in memory otherwise.
    pub spend_store: Arc<dyn crate::budget::SpendStore>,
    /// RPM / TPM buckets for control-plane org limits, keyed per subject.
    /// Also holds the abuse ladder's throttle and new-key buckets
    /// ([`crate::enforcement`]), under their own `abuse:` and `newkey:` keys.
    pub org_rate: crate::rate_limit::ScopedRateLimiter,
    /// In-flight counters for throttled subjects and new keys on the fleet
    /// ([`crate::enforcement`]).
    pub abuse_in_flight: Arc<crate::enforcement::InFlight>,
    /// Verifies the forwarded `x-ryu-user-jwt` on hosted `rgw_` traffic. `Some`
    /// when a control-plane URL is configured.
    pub user_jwt: Option<crate::policy::UserJwtVerifier>,
    /// Last `policyVersion` the control plane reported for this gateway's own
    /// key, surfaced on the admin health view. `None` until fetched or when the
    /// control plane predates the field.
    pub policy_version: RwLock<Option<String>>,
    /// Exec (sandbox/tool) budget enforcer (M6 / #192). Enforces count + wall-clock
    /// limits per rolling window; checked pre-run by Core via `POST /v1/exec/budget/check`.
    pub exec_budget: ExecBudgetEnforcer,
    /// Live eval runner as a swappable registry (Lg decomposition): the built-in
    /// [`crate::evals::EvalsRunner`] is the default active backend.
    pub evals: EvalsRegistry,
    /// Online evals (`[evals.online]`): the bounded hand-off queue, per-tenant
    /// judge budget and recent scored production requests. The pipeline only
    /// `try_send`s here; [`crate::online_evals::spawn_worker`] scores off-path.
    pub online_evals: Arc<crate::evals::online::OnlineEvals<RequestContext>>,
    /// The receiver half of [`Self::online_evals`], taken once by the worker.
    pub(crate) online_eval_receiver: std::sync::Mutex<Option<OnlineEvalReceiver>>,
    /// Live user-authored evaluators. Seeded from `config.custom_evaluators` and
    /// swapped by `PUT /v1/config`, so a saved custom evaluator is visible to
    /// the catalog, offline runner, online scorer and inline guardrails without
    /// a Gateway restart. Read through [`Self::evaluator_registry`].
    pub custom_evaluators: RwLock<Arc<Vec<crate::evaluators::Evaluator>>>,
    pub shared_budget: SharedBudgetState,
    /// Per-org credit-wallet empty cache (#486). The debit hook sets an org's
    /// flag after a metered call drives its balance non-positive; the pre-call
    /// budget gate reads it. Inert unless `config.credits` is active and the
    /// request carries an org.
    pub wallet: Arc<WalletState>,
    /// Ryu's own-supply allowances from the latest control-plane handshake,
    /// read by own-supply routing (`pipeline::own_supply`).
    pub pool_allowances: Arc<crate::credit_pools::PoolAllowances>,
    /// The Ryu Router own-supply table plus this gateway's canary and
    /// quarantine state (`own_supply_table`). The compiled seed by default;
    /// `main` installs the fleet runtime when this is a fleet gateway.
    pub own_supply: Arc<crate::own_supply_table::OwnSupplyRuntime>,
    /// Where this process runs (`custody`). `SelfHosted` by default; `main`
    /// installs the detected custody before the router is built, and the
    /// router and route gates read only this field, never the environment.
    pub custody: crate::custody::GatewayCustody,
    /// End-user salt root and upstream-subject pepper (`identity`). A local
    /// root with no pepper by default; `main` installs the secrets loaded for
    /// the detected custody, and the fleet refuses to start without them.
    pub identity_keys: Arc<crate::identity::IdentityKeys>,
    pub metrics: Metrics,
    pub composio: Option<ComposioClient>,
    pub treg: Option<TregClient>,
    /// The connections layer over [`Self::composio`] / [`Self::treg`]: provider
    /// dispatch for `/v1/providers/*` and the live `backends.connections` pick.
    pub connections: crate::connections::ConnectionRegistry,
    /// Unified tool catalog client over Core (#475). `Some` when `providers.core`
    /// is configured (CORE_URL set); `None` â‡’ the tool loop and `/v1/exec/tool`
    /// are inert. Behind the [`tools::CoreCatalog`] trait for the loop.
    pub tools: Option<ToolSearchClient>,
    /// Semantic (embedding-similarity) cache as a swappable registry (Lg
    /// decomposition): the built-in [`crate::semantic_cache::SemanticCache`] is
    /// the default active backend when enabled; disabled â‡’ no active backend
    /// (`active()` is `None`), matching the old `Option<SemanticCache>`.
    pub semantic_cache: SemanticCacheRegistry,
    /// `/v1/embeddings` cache (`[embedding_cache]`); `None` when disabled.
    pub embedding_cache: Option<ryu_gw_cache::EmbeddingCache>,
    /// Shared HTTP client for embedding calls (semantic cache) and Composio.
    pub http: reqwest::Client,
    /// Effective control-plane policy (U28). Empty by default; populated when
    /// the gateway is bound to a control plane and refreshed in the background.
    /// `RwLock` so a refresh task can swap it without restarting the gateway.
    pub policy: RwLock<EffectivePolicy>,
    /// `RwLock` so `PUT /v1/config` can hot-swap the auth config (API keys)
    /// without a restart. The master key and require_auth flag are read from the
    /// static `config` field; only `api_keys` is mutable at runtime.
    pub auth: RwLock<AuthConfig>,
    /// In-memory async media-job store (video generation). Job-based because
    /// cloud video runs for minutes; the client polls the gateway.
    pub jobs: MediaJobStore,
    /// Live PSTN sessions keyed by provider call SID, for authenticated mobile
    /// guidance, abort, and handoff controls.
    pub phone_calls: PhoneCallHub,
    /// The node's shared channel pairing store, set once when channels start
    /// (`channels_host::spawn_registered`) so the admin approval route acts on
    /// the same store every channel adapter reads. Unset until then.
    pub channel_pairing: OnceLock<ryu_gw_channels::pairing::PairingStore>,
    /// Token → org resolve cache for the multi-tenant data plane. `Some` when a
    /// control-plane URL is configured (`CONTROL_PLANE_URL`); resolves any minted
    /// `rgw_` bearer to its org + budget + policy and caches the result. `None`
    /// â‡’ the dynamic per-token auth path is inert and single-org behavior holds.
    pub resolve_cache: Option<ResolveCache>,
    /// The fleet's internal secret (`RYU_VAULT_INTERNAL_SECRET`) that
    /// authenticates control-plane enforcement pushes
    /// (`POST /internal/enforcement/invalidate`). `None` refuses every push.
    pub enforcement_push_secret: Option<String>,
    /// The newest valid platform floor any resolve carried (spec 02.3). Empty
    /// at boot in production, so a fleet Gateway refuses until its first
    /// resolve delivers one; test builds start from the compiled baseline.
    pub platform_floor: crate::platform_floor::FloorStore,
    /// Per-caller model policy for shared nodes (`policy::user_policy`). `Some`
    /// when a control plane is configured; applied once a caller is known.
    pub user_policy: Option<crate::policy::UserPolicyCache>,
    /// The hardened wasmtime host for untrusted WASM **policy** plugins
    /// (`EvaluatorImpl::Wasm`). Lazily built on first use â€” a gateway with no wasm
    /// policy declared pays nothing (no engine init, no epoch ticker thread).
    /// `Some(host)` once initialised; the inner `Option` is `None` only if engine
    /// construction failed, in which case wasm evaluation fails closed. See
    /// [`Self::wasm_host`].
    wasm_host: OnceLock<Option<Arc<WasmPolicyHost>>>,
    /// Live traffic bus for `GET /v1/traffic`. Every audit record published via
    /// [`Self::log_audit`] is also broadcast here (redacted), so the desktop's
    /// live dashboard needs no polling. Inert when no subscriber is connected.
    pub traffic: TrafficBus,
    /// Highest local audit row id acknowledged by the control plane reporter.
    /// The cursor advances only after a successful ingest response, allowing a
    /// retry to reuse the same idempotency key when a response is lost.
    pub report_cursor: AtomicI64,
    /// Violation events awaiting the control plane (`crate::violations`):
    /// `violations.db` beside the audit database with its own delivery
    /// cursor, so an audit backlog never delays a strike signal. In memory
    /// when auditing is disabled.
    pub violations: Arc<crate::audit::ViolationOutbox>,
    /// Open per-credential usage windows (spec 04.4), folded from every
    /// model-call row [`Self::log_audit_with`] records on a Ryu-operated
    /// Gateway and drained into `violations` once their minute closes.
    pub usage_windows: crate::usage_windows::UsageWindows,
    /// The hazard screener runtime (`crate::screening`): the configured
    /// backends behind their breakers, the active chain and the degraded
    /// throttle. Built from `[screening]` at startup; tests swap in one over
    /// deterministic backends.
    pub screening: Arc<crate::screening::ScreeningRuntime>,
}

pub type SharedState = Arc<AppState>;

mod backends;
mod construct;
mod live_config;
mod recording;
#[cfg(test)]
mod test_support;

use backends::{
    apply_stage_backends, build_redis_caches, gateway_content_cipher, select_stage_backend,
    spend_store_beside,
};

#[cfg(test)]
#[path = "backends_tests.rs"]
mod stage_backend_selection_tests;

#[cfg(test)]
#[path = "live_config_tests.rs"]
mod smart_router_swap_tests;

#[cfg(test)]
#[path = "resolved_scanner_tests.rs"]
mod resolved_scanner_request_scope_tests;

#[cfg(test)]
#[path = "recording_tests.rs"]
mod recording_tests;
