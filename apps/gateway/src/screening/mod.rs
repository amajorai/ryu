//! Hazard screener admission glue (managed guardrails Phase 2, screener
//! addendum sections 3.4 and 5 to 9).
//!
//! The backends, the role chain, the isolated `SafetyClient` and the segment
//! cache live in `crates/gateway/screening`. This module maps the platform
//! floor (or a self-hosted node's own opt-in) onto them and applies the fail
//! rules of section 6:
//!
//! - **Where it binds.** Fleet custody screens every request at floor tier
//!   with the floor's `screener` field, or the compiled baseline when the
//!   floor has none. A self-hosted node with `node_classifiers = true`
//!   screens at node tier and is never bound by Ryu's floor: qualification
//!   does not gate it, and an outage never refuses its traffic. A managed
//!   node does not screen here; the fleet screens that traffic.
//! - **The primary screener** is a local closed-choice decision model on the
//!   `systemone` wire. Guard models and the inspector are alternatives
//!   behind the same trait. A remote decision API is opt-in per node and
//!   refused for floor traffic without an approved retention record.
//! - **Fail rules.** A hard code (S4, S9, `hard: true`) blocks on a verdict.
//!   Without one: a healthy qualified backend that failed this request gives
//!   503 `screening_unavailable`; no healthy qualified backend (none
//!   qualified yet, or every breaker open) gives degraded mode, the regex
//!   floor plus a per-org throttle, never a blanket 503. Media no backend
//!   can screen is refused with 403 `media_unscreenable`.
//! - Screening refusals are safety outcomes: they never trip a provider
//!   circuit or move a request to another provider.

pub mod admit;
pub mod breaker;
pub mod output;
pub mod policy;
pub mod status;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use ryu_gw_screening::backends::decision::{
    decision_covers, DecisionBackend, DecisionConfig, RemotePermit,
};
use ryu_gw_screening::backends::guard_model::{GuardDialect, GuardModelBackend, GuardModelConfig};
use ryu_gw_screening::backends::inspector::{
    inspector_covers, InspectorBackend, InspectorConfig, InspectorFocus,
};
use ryu_gw_screening::{
    BackendKind, ChainPolicy, CodeSet, Locality, Role, ScreenTier, ScreenerBackend, ScreenerChain,
    SegmentCache, TaxonomyId,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::{ScreeningBackendConfig, ScreeningBackendKind, ScreeningConfig};
use crate::custody::GatewayCustody;
use crate::traffic::TrafficBus;

use breaker::{BreakerState, Breakered};
pub use policy::FloorScreener;

/// Default per-call hard timeouts (spec 02.7): T2 text 800 ms, T1 50 ms is
/// too short for a decision model, which serves both, so it takes T2's.
const DEFAULT_TEXT_TIMEOUT_MS: u32 = 800;
/// T2 image (spec 02.7).
const DEFAULT_IMAGE_TIMEOUT_MS: u32 = 1500;
/// Concurrent calls per backend (llama-server `--parallel`, VERIFY per host).
const DEFAULT_CONCURRENCY: usize = 4;
/// How often a degraded replica raises its admin alert (section 6).
pub const DEGRADED_ALERT_EVERY: Duration = Duration::from_secs(300);
/// Seconds a client waits before retrying a screener 503.
pub const SCREENING_RETRY_AFTER_SECS: u64 = 2;
/// How often the background probe runs (section 10.3).
pub const PROBE_EVERY: Duration = Duration::from_secs(10);
/// The probe's own timeout.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Most orgs the degraded throttle tracks before it drops idle buckets.
const MAX_THROTTLE_BUCKETS: usize = 10_000;

/// One configured, built backend.
pub struct BackendSlot {
    pub id: String,
    pub kind: ScreeningBackendKind,
    pub backend: Arc<Breakered>,
    /// Set for a remote processor: who may send it content.
    pub permit: Option<RemotePermit>,
    pub processor_id: Option<String>,
}

impl BackendSlot {
    pub fn breaker_state(&self) -> BreakerState {
        self.backend.breaker.state()
    }
}

/// The chain for one policy and tier.
pub struct ActiveChain {
    pub screener: Arc<FloorScreener>,
    pub tier: ScreenTier,
    pub chain: ScreenerChain,
    /// Every configured backend's breaker, by id.
    pub breakers: BTreeMap<String, Arc<Breakered>>,
}

impl ActiveChain {
    pub fn policy(&self) -> &ChainPolicy {
        self.chain.policy()
    }
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

/// The process's screener runtime. One per process, in `AppState`.
pub struct ScreeningRuntime {
    slots: BTreeMap<String, Arc<BackendSlot>>,
    /// Configured backends that could not be built, with the reason. They
    /// are absent from every role and listed on the status route.
    build_errors: BTreeMap<String, String>,
    /// Static coverage per configured id (built or not), for floor checks.
    static_covers: BTreeMap<String, (ScreeningBackendKind, CodeSet, Option<String>)>,
    node_classifiers: bool,
    degraded_rpm: u32,
    cache: Mutex<(u32, Arc<SegmentCache>)>,
    active: Mutex<Option<Arc<ActiveChain>>>,
    throttle: Mutex<HashMap<String, Bucket>>,
    /// Requests already charged to the degraded throttle, so a request that
    /// is re-admitted (per attempt, per tool round) is charged once.
    charged: Mutex<std::collections::VecDeque<String>>,
    scope_secret: [u8; 32],
    last_alert: Mutex<Option<Instant>>,
    /// Test constructors only: screen nothing on any custody, so suites for
    /// other gates are not throttled by the degraded row. Screening tests
    /// install a live runtime instead.
    #[cfg(test)]
    inert: bool,
}

impl Default for ScreeningRuntime {
    fn default() -> Self {
        Self::empty(&ScreeningConfig::default())
    }
}

fn baseline() -> Arc<FloorScreener> {
    static BASELINE: OnceLock<Arc<FloorScreener>> = OnceLock::new();
    Arc::clone(BASELINE.get_or_init(|| Arc::new(FloorScreener::baseline())))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ScreeningRuntime {
    fn empty(config: &ScreeningConfig) -> Self {
        let mut scope_secret = [0u8; 32];
        rand::Rng::fill(&mut rand::thread_rng(), &mut scope_secret);
        Self {
            slots: BTreeMap::new(),
            build_errors: BTreeMap::new(),
            static_covers: BTreeMap::new(),
            node_classifiers: config.node_classifiers,
            degraded_rpm: config.degraded_rpm.max(1),
            cache: Mutex::new((1, Arc::new(SegmentCache::default()))),
            active: Mutex::new(None),
            throttle: Mutex::new(HashMap::new()),
            charged: Mutex::new(std::collections::VecDeque::new()),
            scope_secret,
            last_alert: Mutex::new(None),
            #[cfg(test)]
            inert: false,
        }
    }

    /// A runtime that screens nothing, for `AppState`'s test constructors.
    #[cfg(test)]
    pub fn inert() -> Self {
        Self {
            inert: true,
            ..Self::empty(&ScreeningConfig::default())
        }
    }

    /// Build every configured backend, reading `*_env` names through
    /// `lookup`. A backend that cannot be built (a bad URL, a local decision
    /// model without pinned weights) is absent and listed with its reason;
    /// it never stops the gateway from starting.
    pub fn from_config(config: &ScreeningConfig, lookup: &dyn Fn(&str) -> Option<String>) -> Self {
        let mut runtime = Self::empty(config);
        for (id, backend) in &config.backends {
            runtime.static_covers.insert(
                id.clone(),
                (
                    backend.kind,
                    static_covers(backend),
                    backend.processor_id.clone(),
                ),
            );
            match build_backend(id, backend, lookup) {
                Ok(slot) => {
                    runtime.slots.insert(id.clone(), Arc::new(slot));
                }
                Err(reason) => {
                    tracing::warn!(
                        backend = id.as_str(),
                        reason,
                        "screening: backend not built"
                    );
                    runtime.build_errors.insert(id.clone(), reason.to_owned());
                }
            }
        }
        runtime
    }

    /// A runtime over ready-made backends, for tests. Each tuple is the
    /// backend, its config kind and, for a remote processor, its permit.
    #[cfg(test)]
    pub fn with_backends(
        config: &ScreeningConfig,
        backends: Vec<(
            Arc<dyn ScreenerBackend>,
            ScreeningBackendKind,
            Option<RemotePermit>,
        )>,
    ) -> Self {
        let mut runtime = Self::empty(config);
        for (backend, kind, permit) in backends {
            let d = backend.descriptor();
            let id = d.id().to_owned();
            let processor_id = d.locality.processor_id().map(str::to_owned);
            runtime
                .static_covers
                .insert(id.clone(), (kind, d.covers.clone(), processor_id.clone()));
            runtime.slots.insert(
                id.clone(),
                Arc::new(BackendSlot {
                    id,
                    kind,
                    backend: Arc::new(Breakered::new(backend)),
                    permit,
                    processor_id,
                }),
            );
        }
        runtime
    }

    pub fn slots(&self) -> impl Iterator<Item = &Arc<BackendSlot>> {
        self.slots.values()
    }

    pub fn slot(&self, id: &str) -> Option<&Arc<BackendSlot>> {
        self.slots.get(id)
    }

    pub fn build_errors(&self) -> &BTreeMap<String, String> {
        &self.build_errors
    }

    pub fn degraded_rpm(&self) -> u32 {
        self.degraded_rpm
    }

    /// Which tier screens a request on `custody`, if any.
    pub fn tier(&self, custody: GatewayCustody) -> Option<ScreenTier> {
        #[cfg(test)]
        if self.inert {
            return None;
        }
        match custody {
            GatewayCustody::Fleet => Some(ScreenTier::Floor),
            GatewayCustody::SelfHosted if self.node_classifiers && !self.slots.is_empty() => {
                Some(ScreenTier::Node)
            }
            GatewayCustody::SelfHosted | GatewayCustody::ManagedNode => None,
        }
    }

    /// The keyed segment scope for `org`: org-scoped so the cache is not a
    /// cross-tenant oracle (spec 02.8).
    pub fn scope_key(&self, org: Option<&str>) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.scope_secret);
        hasher.update(b"org\x1f");
        hasher.update(org.unwrap_or("-").as_bytes());
        hasher.finalize().into()
    }

    /// The segment cache for `template_version`. A floor that changes its
    /// template version starts a new cache, so old scores are never reused.
    fn cache_for(&self, template_version: u32) -> Arc<SegmentCache> {
        let mut cache = lock(&self.cache);
        if cache.0 != template_version {
            *cache = (template_version, Arc::new(SegmentCache::default()));
        }
        Arc::clone(&cache.1)
    }

    pub fn cache_stats(&self) -> ryu_gw_screening::cache::CacheStats {
        lock(&self.cache).1.stats()
    }

    /// The chain for `tier` under the floor `screener` (floor tier) or the
    /// node's own baseline (node tier). Rebuilt only when either changes.
    pub fn active(
        &self,
        tier: ScreenTier,
        screener: Option<Arc<FloorScreener>>,
    ) -> Arc<ActiveChain> {
        let screener = match tier {
            ScreenTier::Floor => screener.unwrap_or_else(baseline),
            ScreenTier::Node => baseline(),
        };
        let mut active = lock(&self.active);
        if let Some(current) = active.as_ref() {
            if current.tier == tier && Arc::ptr_eq(&current.screener, &screener) {
                return Arc::clone(current);
            }
        }
        let built = Arc::new(self.build_chain(tier, screener));
        *active = Some(Arc::clone(&built));
        built
    }

    fn build_chain(&self, tier: ScreenTier, screener: Arc<FloorScreener>) -> ActiveChain {
        // Remote permits follow the active floor: a record admits floor
        // traffic, the operator's opt-in admits node traffic only.
        for slot in self.slots.values() {
            if let (Some(permit), Some(processor)) = (&slot.permit, &slot.processor_id) {
                let recorded = tier == ScreenTier::Floor
                    && screener.explicit
                    && screener.remote_record(&slot.id, processor);
                permit.set_floor_record(recorded);
            }
        }
        let policy = ChainPolicy {
            hard_codes: screener.hard_codes(),
            qualifications: screener.qualifications.clone(),
            remote_mode: screener.remote_mode,
        };
        let pick = |ids: &[String]| -> Vec<Arc<dyn ScreenerBackend>> {
            ids.iter()
                .filter_map(|id| self.slots.get(id))
                .map(|slot| Arc::clone(&slot.backend) as Arc<dyn ScreenerBackend>)
                .collect()
        };
        let chain = ScreenerChain::new(policy)
            .with_cache(self.cache_for(screener.template_version))
            .with_role(Role::TextHazard, pick(&screener.roles.text_hazard))
            .with_role(Role::PromptAttack, pick(&screener.roles.prompt_attack))
            .with_role(Role::Vision, pick(&screener.roles.vision))
            .with_role(Role::Output, pick(&screener.roles.output));
        ActiveChain {
            screener,
            tier,
            chain,
            breakers: self
                .slots
                .iter()
                .map(|(id, slot)| (id.clone(), Arc::clone(&slot.backend)))
                .collect(),
        }
    }

    /// The checks a floor's `screener` needs this replica's endpoints for
    /// (section 5.3). `Err` rejects the whole floor; the previous one stays.
    pub fn validate_floor(&self, screener: &FloorScreener) -> Result<(), &'static str> {
        for id in screener.roles.all_ids() {
            let Some((kind, _, processor)) = self.static_covers.get(id) else {
                return Err("screener role names a backend this replica has no endpoint for");
            };
            if *kind == ScreeningBackendKind::DecisionRemote {
                let recorded = processor
                    .as_deref()
                    .is_some_and(|processor| screener.remote_record(id, processor));
                if !recorded {
                    return Err(
                        "screener role names a remote processor without a retention record",
                    );
                }
            }
        }
        // Every hard code needs a text-hazard backend that can cover it at
        // all (SB-4: a Qwen3Guard-only role never covers S4). Qualification
        // is not checked here: an unqualified source runs the degraded row.
        let covered = screener
            .roles
            .text_hazard
            .iter()
            .filter_map(|id| self.static_covers.get(id))
            .fold(CodeSet::new(), |acc, (_, covers, _)| acc.union(covers));
        if !screener.hard_codes().is_subset(&covered) {
            return Err("screener textHazard role cannot cover every hard code");
        }
        Ok(())
    }

    /// Spend one request from `org`'s degraded share. `Err` carries the
    /// seconds until the next request fits. The first request always passes.
    pub fn throttle(&self, org: &str) -> Result<(), u64> {
        let rpm = f64::from(self.degraded_rpm);
        let per_sec = rpm / 60.0;
        let now = Instant::now();
        let mut buckets = lock(&self.throttle);
        if buckets.len() >= MAX_THROTTLE_BUCKETS && !buckets.contains_key(org) {
            buckets.retain(|_, b| now.duration_since(b.at) < Duration::from_secs(600));
        }
        let bucket = buckets.entry(org.to_owned()).or_insert(Bucket {
            tokens: rpm,
            at: now,
        });
        let elapsed = now.duration_since(bucket.at).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * per_sec).min(rpm);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / per_sec).ceil();
            Err((wait as u64).max(1))
        }
    }

    /// [`Self::throttle`], charged at most once per request id.
    pub fn throttle_request(&self, request_id: &str, org: &str) -> Result<(), u64> {
        if !request_id.is_empty() {
            let mut charged = lock(&self.charged);
            if charged.iter().any(|id| id == request_id) {
                return Ok(());
            }
            if charged.len() >= MAX_THROTTLE_BUCKETS {
                charged.pop_front();
            }
            charged.push_back(request_id.to_owned());
        }
        self.throttle(org)
    }

    /// Whether the degraded admin alert is due (at most every 5 minutes).
    pub fn alert_due(&self) -> bool {
        let mut last = lock(&self.last_alert);
        if last.is_some_and(|at| at.elapsed() < DEGRADED_ALERT_EVERY) {
            return false;
        }
        *last = Some(Instant::now());
        true
    }

    /// Publish breaker transitions as `screening_degraded` events.
    pub fn publish_transitions(&self, traffic: &TrafficBus) {
        for slot in self.slots.values() {
            for state in slot.backend.breaker.take_transitions() {
                tracing::warn!(
                    backend = slot.id.as_str(),
                    breaker = state.as_str(),
                    "screening: breaker transition"
                );
                publish_degraded(
                    traffic,
                    json!({ "reason": "breaker", "backend": slot.id, "breaker": state.as_str() }),
                );
            }
        }
    }

    /// Probe every backend once, recording the result on its breaker. An
    /// engine down at boot opens its breaker, so the replica starts in
    /// degraded mode instead of failing to start.
    pub async fn probe_all(&self) {
        for slot in self.slots.values() {
            let health = match tokio::time::timeout(PROBE_TIMEOUT, slot.backend.probe()).await {
                Ok(health) => health,
                Err(_) => ryu_gw_screening::BackendHealth::Down("probe_timeout"),
            };
            if health == ryu_gw_screening::BackendHealth::NotPermitted {
                // Absent, never down (section 6).
                continue;
            }
            slot.backend.breaker.record_probe(health);
        }
    }
}

/// Publish one `screening_degraded` event on the live feed. It carries no
/// org id, so only the master key or the local operator sees it.
///
/// It carries the base fields of a request event with neutral values
/// (`provider: "gateway"`, no key, no tokens), so a feed consumer that reads
/// every event as a request row sees a gateway marker row instead of missing
/// fields.
pub fn publish_degraded(traffic: &TrafficBus, detail: Value) {
    let mut event = json!({
        "kind": "screening_degraded",
        "event_type": "screening_degraded",
        "request_id": "",
        "api_key": "",
        "provider": "gateway",
        "model": null,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_hit": false,
        "latency_ms": 0,
        "error": null,
        "session_id": null,
        "org_id": null,
        "status": null,
        "route": null,
        "ts": chrono::Utc::now().to_rfc3339(),
    });
    if let (Some(target), Some(detail)) = (event.as_object_mut(), detail.as_object()) {
        for (key, value) in detail {
            target.insert(key.clone(), value.clone());
        }
    }
    traffic.publish(event);
}

/// Codes a configured backend can cover, from its kind and dialect alone.
fn static_covers(config: &ScreeningBackendConfig) -> CodeSet {
    match config.kind {
        ScreeningBackendKind::DecisionLocal | ScreeningBackendKind::DecisionRemote => {
            decision_covers()
        }
        ScreeningBackendKind::GuardModel => config
            .dialect
            .as_deref()
            .and_then(GuardDialect::parse)
            .map(GuardDialect::covers)
            .unwrap_or_default(),
        ScreeningBackendKind::Inspector => inspector_covers(),
    }
}

fn locality_of(url: &str, private_network: bool) -> Locality {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    let loopback = host.as_deref().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(|c| c == '[' || c == ']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if loopback || !private_network {
        Locality::Loopback
    } else {
        Locality::PrivateNetwork
    }
}

fn build_backend(
    id: &str,
    config: &ScreeningBackendConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<BackendSlot, &'static str> {
    let resolve = |inline: &Option<String>, env: &Option<String>| {
        ScreeningBackendConfig::resolve(inline.as_deref(), env.as_deref(), lookup)
    };
    let url = resolve(&config.base_url, &config.base_url_env).ok_or("no endpoint URL")?;
    let model = resolve(&config.model, &config.model_env);
    let weights = resolve(&config.weights_sha256, &config.weights_sha256_env);
    let bearer = config
        .api_key_env
        .as_deref()
        .and_then(lookup)
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    let concurrency = config.max_concurrency.unwrap_or(DEFAULT_CONCURRENCY);
    let text_timeout = config.hard_timeout_ms.unwrap_or(DEFAULT_TEXT_TIMEOUT_MS);
    let (backend, permit, processor_id): (Arc<dyn ScreenerBackend>, _, _) = match config.kind {
        ScreeningBackendKind::DecisionLocal => {
            let locality = locality_of(&url, config.private_network);
            let backend = DecisionBackend::local(
                DecisionConfig {
                    id: id.to_owned(),
                    url,
                    model: model.ok_or("no model")?,
                    weights_sha256: weights,
                    hard_timeout_ms: text_timeout,
                    max_concurrency: concurrency,
                },
                locality,
            )
            .map_err(endpoint_reason)?;
            (Arc::new(backend), None, None)
        }
        ScreeningBackendKind::DecisionRemote => {
            let processor = config
                .processor_id
                .clone()
                .filter(|p| !p.trim().is_empty())
                .ok_or("a remote processor needs a processor_id")?;
            let permit = RemotePermit::new();
            permit.set_node_opt_in(config.allow_remote_processor);
            let backend = DecisionBackend::remote(
                DecisionConfig {
                    id: id.to_owned(),
                    url,
                    model: model.ok_or("no model")?,
                    weights_sha256: weights,
                    hard_timeout_ms: text_timeout,
                    max_concurrency: concurrency,
                },
                &processor,
                bearer,
                permit.clone(),
            )
            .map_err(endpoint_reason)?;
            (Arc::new(backend), Some(permit), Some(processor))
        }
        ScreeningBackendKind::GuardModel => {
            let dialect = config
                .dialect
                .as_deref()
                .and_then(GuardDialect::parse)
                .ok_or("guard model dialect is not llama_guard or qwen3guard")?;
            let locality = locality_of(&url, config.private_network);
            let backend = GuardModelBackend::new(GuardModelConfig {
                id: id.to_owned(),
                base_url: url,
                locality,
                model: model.ok_or("no model")?,
                weights_sha256: weights,
                template_version: config.template_version,
                dialect,
                images: config.images,
                bearer,
                hard_timeout_ms: if config.images {
                    config.hard_timeout_ms.unwrap_or(DEFAULT_IMAGE_TIMEOUT_MS)
                } else {
                    text_timeout
                },
                max_concurrency: concurrency,
            })
            .map_err(endpoint_reason)?;
            (Arc::new(backend), None, None)
        }
        ScreeningBackendKind::Inspector => {
            let locality = locality_of(&url, config.private_network);
            let backend = InspectorBackend::new(InspectorConfig {
                id: id.to_owned(),
                base_url: url,
                locality,
                model: model.ok_or("no model")?,
                focus: InspectorFocus::Both,
                hard_timeout_ms: config.hard_timeout_ms.unwrap_or(1500),
                max_concurrency: concurrency,
            })
            .map_err(endpoint_reason)?;
            (Arc::new(backend), None, None)
        }
    };
    debug_assert!(
        backend.descriptor().reference.kind != BackendKind::Test,
        "configured backends are never the test backend"
    );
    Ok(BackendSlot {
        id: id.to_owned(),
        kind: config.kind,
        backend: Arc::new(Breakered::new(backend)),
        permit,
        processor_id,
    })
}

fn endpoint_reason(error: ryu_gw_screening::EndpointError) -> &'static str {
    use ryu_gw_screening::EndpointError as E;
    match error {
        E::Invalid => "endpoint is not a valid URL",
        E::Scheme => "endpoint scheme must be http or https",
        E::RemoteNotHttps => "a remote processor endpoint must use https",
        E::ExtraParts => "endpoint must not carry userinfo, a query or a fragment",
        E::NotLoopback => "a loopback endpoint must resolve to a loopback address",
        E::PlaintextCredential => "credentials are never sent over plaintext",
        E::Client => "the HTTP client could not be built",
        E::UnpinnedWeights => "a local decision model must pin its weights sha256",
    }
}

/// Boot check I1 (spec 02.6.3): on the fleet a remote processor's credential
/// must not be any credential a chat slot can use, so screening traffic can
/// never be billed to, or seen by, the account it protects. Compared by
/// value against every provider credential this process holds.
pub fn check_remote_credentials(
    config: &crate::config::GatewayConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let mut held: Vec<String> = Vec::new();
    if let Ok(providers) = serde_json::to_value(&config.providers) {
        collect_strings(&providers, &mut held);
    }
    if let Some(environment) = config.provider_environment.as_ref() {
        held.extend(environment.values().values().cloned());
    }
    for (id, backend) in &config.screening.backends {
        if backend.kind != ScreeningBackendKind::DecisionRemote {
            continue;
        }
        let Some(key) = backend
            .api_key_env
            .as_deref()
            .and_then(lookup)
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty())
        else {
            continue;
        };
        if held.iter().any(|value| value.trim() == key) {
            return Err(format!(
                "screening backend '{id}' uses a credential a chat provider slot also holds"
            ));
        }
    }
    Ok(())
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) if s.len() >= 8 => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// The S-code of `code` for the wire, or its full id when it has none.
pub fn short_code(code: TaxonomyId) -> &'static str {
    code.short().unwrap_or(code.as_str())
}

/// One backend's flag or block score for one code: the unit of a violation
/// event (screener addendum 11.1, one event per non-allow code per detector).
#[derive(Debug, Clone)]
pub struct Detection {
    pub code: TaxonomyId,
    pub backend_id: String,
    pub score: f32,
    /// The screened text the score came from, for the redacted excerpt.
    pub text: Option<Arc<str>>,
}

/// Every `(backend, code)` in `verdict` whose own score clears the code's
/// flag or block rule, with that backend's highest score and its text.
pub fn detections_of(
    screener: &FloorScreener,
    verdict: &ryu_gw_screening::ChainVerdict,
    items: &[ryu_gw_screening::ScreenItem],
    adult: bool,
) -> Vec<Detection> {
    let mut found: BTreeMap<(String, TaxonomyId), Detection> = BTreeMap::new();
    for composed in &verdict.items {
        let text = items
            .iter()
            .find(|item| item.key == composed.key)
            .and_then(|item| item.text.clone());
        for contribution in &composed.contributions {
            let code = contribution.code;
            let action = screener
                .rule(code)
                .decide(contribution.score, adult && code == TaxonomyId::S12);
            if action == policy::CodeAction::Allow {
                continue;
            }
            let key = (contribution.backend_id.clone(), code);
            let better = found
                .get(&key)
                .is_none_or(|existing| contribution.score > existing.score);
            if better {
                found.insert(
                    key,
                    Detection {
                        code,
                        backend_id: contribution.backend_id.clone(),
                        score: contribution.score,
                        text: text.clone(),
                    },
                );
            }
        }
    }
    found.into_values().collect()
}

/// Record one violation event per detection. A code in `blocked` takes
/// `block_action`; any other detected code was flagged and forwarded.
///
/// Returns the id the live feed verdict joins on: the first event recorded
/// with `block_action`, else the first flag. A duplicate (the same request,
/// attempt, detector and code seen before) records nothing new.
pub fn record_detections(
    state: &crate::state::AppState,
    ctx: &crate::pipeline::RequestContext,
    active: &ActiveChain,
    detections: &[Detection],
    blocked: &[TaxonomyId],
    block_action: crate::audit::EnforcementAction,
    direction: ryu_gw_screening::Direction,
    screening_id: &str,
) -> Option<String> {
    use crate::audit::{EnforcementAction, PolicyLayer};
    let layer = if active.tier == ScreenTier::Floor {
        PolicyLayer::Platform
    } else {
        PolicyLayer::Node
    };
    let (mut first_block, mut first_flag) = (None, None);
    for detection in detections {
        let descriptor = active
            .breakers
            .get(&detection.backend_id)
            .map(|backend| backend.descriptor());
        let version = descriptor.map_or_else(
            || "unknown@-#t0".to_owned(),
            |d| d.reference.detector_version(),
        );
        let action = if blocked.contains(&detection.code) {
            block_action
        } else {
            EnforcementAction::LoggedOnly
        };
        let mut input = crate::violations::VerdictInput::classifier(
            detection.code,
            &detection.backend_id,
            version,
            detection.score,
            action,
            crate::violations::direction_of(direction),
            layer,
        )
        .with_screening_id(screening_id)
        .with_processor(descriptor.and_then(|d| d.locality.processor_id()));
        if let Some(text) = detection.text.as_deref() {
            input = input.with_evidence(text);
        }
        let recorded = state.record_violation(ctx, input);
        let slot = if action == EnforcementAction::LoggedOnly {
            &mut first_flag
        } else {
            &mut first_block
        };
        if slot.is_none() {
            *slot = recorded;
        }
    }
    first_block.or(first_flag)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
