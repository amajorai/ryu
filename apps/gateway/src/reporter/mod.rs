//! Control-plane reporter (M7 / U29).
//!
//! Periodically pushes the gateway's local eval/budget/audit state up to the
//! control plane for aggregation and dashboards, and (when configured)
//! reconciles a shared budget through the coordinator so spend stays bounded
//! across every user and machine on that budget.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{
    audit::{AuditEntry, AuditQuery, AuditSummary},
    state::SharedState,
};

pub mod violations;
pub mod windows;

/// Spawn the background reporting loop. A no-op when the control plane is
/// disabled or no gateway key is configured.
pub fn spawn(state: SharedState) {
    let cfg = state.config.control_plane.clone();
    if !cfg.enabled || cfg.gateway_key.is_none() {
        debug!("control-plane reporting disabled");
        return;
    }

    // Violation events drain on their own task and cursor, so an audit
    // backlog or a slow aggregate ingest never delays a strike signal.
    violations::spawn(state.clone());
    // Usage windows (spec 04.4) go on their own task and requests too, and
    // only from Ryu-operated Gateways.
    windows::spawn(state.clone());

    tokio::spawn(async move {
        // Resume from the last ACKNOWLEDGED audit row. Ingest applies `$inc`,
        // so restarting at 0 would replay every retained row into the rollups.
        match state.audit.report_cursor(REPORT_CURSOR) {
            Ok(Some(cursor)) => state.report_cursor.store(cursor, Ordering::Release),
            Ok(None) => {}
            Err(error) => warn!("control-plane report cursor unreadable: {error}"),
        }
        let mut interval =
            tokio::time::interval(Duration::from_secs(cfg.report_interval_secs.max(1)));
        loop {
            interval.tick().await;
            if let Err(e) = push_report(&state).await {
                warn!("control-plane report failed: {e}");
            }
            if let Err(e) = reconcile_budget(&state).await {
                warn!("control-plane budget reconcile failed: {e}");
            }
        }
    });
}

/// Name of the control-plane ingest cursor in the audit store.
const REPORT_CURSOR: &str = "control_plane_ingest";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Estimated spend in micro-USD for the given token totals.
fn cost_micro_usd(state: &SharedState, input: u64, output: u64) -> u64 {
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    (input + output).saturating_mul(per_1k) / 1000
}

/// Use provider-reported transaction costs wherever the managed provider gave
/// one (notably OpenRouter's discounted `usage.cost`), and estimate only the
/// managed rows that had no provider cost to report.
fn summary_cost_micro_usd(state: &SharedState, summary: &AuditSummary) -> u64 {
    summary
        .reported_cost_micro_usd
        .saturating_add(cost_micro_usd(
            state,
            summary.unpriced_input_tokens,
            summary.unpriced_output_tokens,
        ))
}

/// Billable cost for one audit row. BYOK/local rows deliberately stay `None`:
/// their provider activity belongs in usage analytics, but it did not debit a
/// Ryu-managed balance. Managed rows prefer the provider transaction price and
/// use the configured per-model table only when the provider omitted one.
/// The amount is the CHARGED one (platform markup applied exactly as
/// `debit_amount_for_provider` does at enforcement), so groupings of audit
/// rows by user/team/model/provider agree with the daily rollups and caps.
fn audit_cost_micro_usd(entry: &AuditEntry, config: &crate::config::GatewayConfig) -> Option<u64> {
    if entry.event_type == "service_call" {
        return entry
            .managed_inference
            .then_some(entry.provider_cost_micro_usd)
            .flatten()
            .map(|raw| {
                config
                    .credits
                    .debit_amount_for_provider(Some(entry.provider.as_str()), raw)
            });
    }
    entry
        .managed_inference
        .then(|| charged_row_cost(entry, config))
}

/// Shape one local audit row for control-plane ingestion. Keeping this mapping
/// in one function makes the analytics attribution fields hard to accidentally
/// omit when the audit schema grows.
fn audit_payload_entry(entry: &AuditEntry, config: &crate::config::GatewayConfig) -> Value {
    json!({
        "id": entry.id,
        "timestamp": entry.timestamp,
        "requestId": entry.request_id,
        "sessionId": entry.session_id,
        "agentId": entry.agent_id,
        "eventType": entry.event_type,
        "apiKey": entry.api_key,
        "userName": entry.user_name,
        "backend": entry.backend,
        "command": entry.command,
        "actorId": entry.user_id,
        // Legacy single team (the first); `teamIds` lists every team the
        // row is charged to so usage can be grouped by each of them.
        "teamId": entry.team_id,
        "teamIds": entry_team_ids(entry),
        "projectId": entry.project_id,
        "provider": display_provider(entry),
        // User-facing usage analytics: a managed tier's work shows its Ryu
        // alias, never the supplier's id. The local audit row keeps the real id.
        "model": (entry.event_type != "service_call").then(|| display_model(entry)),
        "serviceUsage": entry.service_usage.as_ref().map(|usage| json!({
            "requests": usage.requests,
            "documents": usage.documents,
            "providerCredits": usage.provider_credits,
            "costSource": usage.cost_source,
            "costIsEstimate": usage.cost_is_estimate,
        })),
        "feature": entry.feature,
        "widgetInstanceId": entry.widget_instance_id,
        "inputTokens": entry.input_tokens,
        "outputTokens": entry.output_tokens,
        "cacheTokens": audit_cache_tokens(entry),
        "managedInference": entry.managed_inference,
        "providerCostMicroUsd": entry.provider_cost_micro_usd,
        "costMicroUsd": audit_cost_micro_usd(entry, config),
        "latencyMs": entry.latency_ms,
        "durationMs": entry.duration_ms,
        "evalScore": entry.eval_score,
        "error": entry.error,
    })
}

/// The provider usage analytics may show for an audit row: managed traffic a
/// Ryu-operated slot served (own supply or the OpenRouter pass-through) is
/// Ryu Router's (`"ryu"`), never the supplier's slot id. BYOK and operator
/// traffic keep their provider. Per-supplier burn lives in the ledger `pool`.
fn display_provider(entry: &AuditEntry) -> &str {
    if entry.managed_inference && crate::credit_pools::is_ryu_router_slot(&entry.provider) {
        "ryu"
    } else {
        &entry.provider
    }
}

/// The model name usage analytics may show for an audit row: the Ryu Router id
/// (else the Ryu alias) for own-supply work, else the recorded id.
fn display_model(entry: &AuditEntry) -> std::borrow::Cow<'_, str> {
    crate::pipeline::model_alias::display_model(&entry.provider, &entry.model)
}

/// The id to price an audit row by. Cache-hit rows are recorded under the
/// alias (their `provider` is the cache, not the slot), so resolve it back to
/// the upstream id the price table knows.
fn pricing_model(model: &str) -> &str {
    ryu_gw_router::pool_model_alias_route(model).map_or(model, |(_, upstream)| upstream)
}

/// Prompt-cache tokens (reads + writes) for the ingest `cacheTokens` field.
/// Provider-reported prompt-cache counts win; the gateway's own cache
/// counters are the fallback for rows that only carry those.
fn audit_cache_tokens(entry: &AuditEntry) -> u64 {
    let provider = entry
        .prompt_cache_read_tokens
        .unwrap_or(0)
        .saturating_add(entry.prompt_cache_write_tokens.unwrap_or(0));
    if provider > 0 {
        return provider;
    }
    entry
        .cache_read_tokens
        .unwrap_or(0)
        .saturating_add(entry.cache_write_tokens.unwrap_or(0))
}

/// Length of the leading `YYYY-MM-DD` slice of a SQLite `datetime('now')`
/// timestamp (always UTC), used as the per-day rollup key.
const DAY_KEY_LEN: usize = 10;
/// Divisor from milliseconds to whole seconds for `agentSeconds`.
const MS_PER_SEC: u64 = 1000;

/// Convert a report slice's summed agent milliseconds into the whole-second
/// `agentSeconds` field, rounding half up. The control plane `$inc`s this value
/// once per slice, so truncating would drop up to 999ms per slice and steadily
/// under-report agent time (a busy day of sub-second slices summed to 0).
fn rounded_agent_seconds(agent_ms: u64) -> u64 {
    agent_ms.saturating_add(MS_PER_SEC / 2) / MS_PER_SEC
}

/// Most hashed session ids one daily bucket carries as `sessionIds`. The
/// control plane caps a bucket at the same bound.
const MAX_SESSION_IDS_PER_BUCKET: usize = 500;
/// Hex characters of a session id's SHA-256 sent as its `sessionIds` entry.
const SESSION_HASH_HEX_LEN: usize = 16;

/// Whether an audit row is one counted request (`requestCount`, `byModel`,
/// `byTransport`, `byFeature`): a model call that did not fail or get denied.
/// Errored rows still contribute the tokens and cost they recorded.
fn is_counted_request(entry: &AuditEntry) -> bool {
    entry.event_type == "model_call" && entry.error.is_none()
}

/// The `sessionIds` entry for one session: the first 16 hex characters of the
/// SHA-256 of its id, so the control plane can dedupe sessions across report
/// slices without receiving the raw id.
fn session_hash(session_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hex = hex::encode(Sha256::digest(session_id.as_bytes()));
    hex.truncate(SESSION_HASH_HEX_LEN);
    hex
}

/// A bucket's hashed session ids, deterministic: sorted and capped at the
/// first [`MAX_SESSION_IDS_PER_BUCKET`].
fn hashed_session_ids(sessions: &HashSet<String>) -> Vec<String> {
    let mut hashes: Vec<String> = sessions.iter().map(|id| session_hash(id)).collect();
    hashes.sort_unstable();
    hashes.dedup();
    hashes.truncate(MAX_SESSION_IDS_PER_BUCKET);
    hashes
}

/// Per-`(userId, day)` accumulator for the control-plane usage rollup. Mirrors
/// the `UserUsageDaily` shape the ingest upserts via `$inc`.
#[derive(Default)]
struct UserDailyBucket {
    input_tokens: u64,
    output_tokens: u64,
    /// Prompt-cache tokens (see [`audit_cache_tokens`]) → `cacheTokens`.
    cache_tokens: u64,
    request_count: u64,
    /// Distinct session ids seen this day → `sessionCount`.
    sessions: HashSet<String>,
    /// Summed exec `duration_ms`; divided down to whole seconds at emit time.
    agent_ms: u64,
    /// Per-feature request counts (`chat` | `island` | `agent`).
    feat_chat: u64,
    feat_island: u64,
    feat_agent: u64,
    /// Predict impressions. We can only observe requests, so `accepted` is 0.
    predict_shown: u64,
    /// Per-model request counts.
    by_model: HashMap<String, u64>,
    /// Per-skill request counts from `x-ryu-skill-ids`.
    by_skill: HashMap<String, u64>,
    /// Per-transport request counts. Gateway-observed rows are exact; ACP rows can
    /// be added later by Core/app-observed usage events.
    by_transport: HashMap<String, u64>,
    /// Managed spend for the day in CHARGED micro-USD (see [`charged_row_cost`]),
    /// the same unit the gateway's budget and org-limit enforcement debits, so
    /// a `keyDaily`/`teamDaily`/`userDaily` total compares directly to a cap.
    cost_micro: u64,
    /// First/last audit row id folded in, for the bucket's `rollupId`.
    row_span: RowSpan,
}

/// Inclusive range of audit row ids folded into one daily bucket.
#[derive(Default, Clone, Copy)]
struct RowSpan(Option<(i64, i64)>);

impl RowSpan {
    fn include(&mut self, id: i64) {
        self.0 = Some(match self.0 {
            Some((first, last)) => (first.min(id), last.max(id)),
            None => (id, id),
        });
    }

    /// Stable id of a rollup entry: the rollup kind, its identity key(s), the
    /// day and the exact audit rows it summarizes. Ingest applies `$inc`, so
    /// the control plane dedupes on this to make a replayed report (a restart
    /// before the acknowledgement, or a retried POST) count once.
    fn rollup_id(self, kind: &str, identity: &[&str], day: &str) -> String {
        use sha2::{Digest, Sha256};
        let (first, last) = self.0.unwrap_or_default();
        let mut hash = Sha256::new();
        hash.update(b"ryu-rollup-v1\0");
        for part in std::iter::once(kind)
            .chain(identity.iter().copied())
            .chain([day])
        {
            hash.update(part.as_bytes());
            hash.update(b"\0");
        }
        hash.update(format!("{first}..{last}").as_bytes());
        format!("ru_{}", hex::encode(&hash.finalize()[..16]))
    }
}

/// The charged amount of one managed audit row: the provider-reported
/// transaction price (control-plane price table as fallback) with the platform
/// markup applied exactly as `debit_amount_for_provider` does at enforcement.
fn charged_row_cost(entry: &impl CostRow, config: &crate::config::GatewayConfig) -> u64 {
    let raw = entry.provider_cost().unwrap_or_else(|| {
        // A published own-supply row carries its own price: never bill a
        // dynamically linked model at the flat rate.
        crate::own_supply_table::price_for(entry.provider(), pricing_model(entry.model()))
            .map(|price| own_supply_row_cost(entry, &price))
            .unwrap_or_else(|| {
                config.control_plane.cost_for(
                    pricing_model(entry.model()),
                    entry.tokens().0,
                    entry.tokens().1,
                )
            })
    });
    config
        .credits
        .debit_amount_for_provider(Some(entry.provider()), raw)
}

/// The fields a charged cost is computed from, shared by stored audit rows
/// and the live records the usage windows fold.
trait CostRow {
    fn provider(&self) -> &str;
    fn model(&self) -> &str;
    /// `(input, output)` tokens.
    fn tokens(&self) -> (u64, u64);
    fn provider_cost(&self) -> Option<u64>;
    fn cache_tokens(&self) -> ryu_gw_router::own_supply::CacheTokens;
}

impl CostRow for AuditEntry {
    fn provider(&self) -> &str {
        &self.provider
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn tokens(&self) -> (u64, u64) {
        (self.input_tokens, self.output_tokens)
    }
    fn provider_cost(&self) -> Option<u64> {
        self.provider_cost_micro_usd
    }
    fn cache_tokens(&self) -> ryu_gw_router::own_supply::CacheTokens {
        ryu_gw_router::own_supply::CacheTokens {
            read: self.cache_read_tokens.unwrap_or(0),
            write: self.cache_write_tokens.unwrap_or(0),
            write_1h: self.cache_write_1h_tokens.unwrap_or(0),
        }
    }
}

impl CostRow for crate::audit::AuditRecord {
    fn provider(&self) -> &str {
        &self.provider
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn tokens(&self) -> (u64, u64) {
        (self.input_tokens, self.output_tokens)
    }
    fn provider_cost(&self) -> Option<u64> {
        self.provider_cost_micro_usd
    }
    fn cache_tokens(&self) -> ryu_gw_router::own_supply::CacheTokens {
        ryu_gw_router::own_supply::CacheTokens {
            read: self.cache_read_tokens.unwrap_or(0),
            write: self.cache_write_tokens.unwrap_or(0),
            write_1h: self.cache_write_1h_tokens.unwrap_or(0),
        }
    }
}

/// The charged cost of a live model-call record, as the daily rollups count
/// it: `None` for a row that spent no Ryu-managed balance (BYOK, local).
pub(crate) fn record_cost_micro_usd(
    record: &crate::audit::AuditRecord,
    config: &crate::config::GatewayConfig,
) -> Option<u64> {
    (record.managed_inference && record.event_type == crate::audit::EventType::ModelCall)
        .then(|| charged_row_cost(record, config))
}

/// An own-supply row at its published price, with the cache legs the wallet
/// debit priced (`response_cost_micro_usd`): reads, five-minute writes and the
/// one-hour writes billed above them (rows that predate the split carry none).
fn own_supply_row_cost(
    entry: &impl CostRow,
    price: &ryu_gw_router::own_supply::OwnSupplyPrice,
) -> u64 {
    let (input, output) = entry.tokens();
    price.cost_with_cache(input, output, entry.cache_tokens())
}

impl UserDailyBucket {
    /// Fold a billable service-call row: its charged cost and one request.
    /// Token counters stay model-only.
    fn absorb_service(&mut self, entry: &AuditEntry, charged_cost: u64) {
        self.row_span.include(entry.id);
        self.request_count = self.request_count.saturating_add(1);
        self.cost_micro = self.cost_micro.saturating_add(charged_cost);
        if let Some(session) = &entry.session_id {
            self.sessions.insert(session.clone());
        }
    }

    /// Fold a single audit row (already known to carry a `user_id`) into the bucket.
    fn absorb(&mut self, entry: &AuditEntry, config: &crate::config::GatewayConfig) {
        self.row_span.include(entry.id);
        self.input_tokens = self.input_tokens.saturating_add(entry.input_tokens);
        self.cache_tokens = self.cache_tokens.saturating_add(audit_cache_tokens(entry));
        self.output_tokens = self.output_tokens.saturating_add(entry.output_tokens);
        if entry.event_type == "model_call" && entry.managed_inference {
            self.cost_micro = self
                .cost_micro
                .saturating_add(charged_row_cost(entry, config));
        }
        if is_counted_request(entry) {
            self.request_count = self.request_count.saturating_add(1);
            *self
                .by_model
                .entry(display_model(entry).into_owned())
                .or_insert(0) += 1;
            *self.by_transport.entry("gateway".to_string()).or_insert(0) += 1;
            // `byFeature` counts requests per surface, so exec rows and failed
            // or denied calls stay out of it like they stay out of `requestCount`.
            match entry.feature.as_deref() {
                Some("chat") => self.feat_chat += 1,
                Some("island") => self.feat_island += 1,
                Some("agent") => self.feat_agent += 1,
                Some("predict") => self.predict_shown += 1,
                _ => {}
            }
        }
        if let Some(skill_ids) = &entry.skill_ids {
            for skill in skill_ids
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *self.by_skill.entry(skill.to_string()).or_insert(0) += 1;
            }
        }
        if let Some(session) = &entry.session_id {
            self.sessions.insert(session.clone());
        }
        if let Some(ms) = entry.duration_ms {
            self.agent_ms = self.agent_ms.saturating_add(ms);
        }
    }

    /// Serialise the `byFeature` object, emitting only the surfaces that fired so
    /// the payload stays sparse (matches the optional `FeatureUsage` fields).
    fn by_feature_json(&self) -> Value {
        let mut feature = serde_json::Map::new();
        if self.feat_chat > 0 {
            feature.insert("chat".to_string(), json!(self.feat_chat));
        }
        if self.feat_island > 0 {
            feature.insert("island".to_string(), json!(self.feat_island));
        }
        if self.feat_agent > 0 {
            feature.insert("agent".to_string(), json!(self.feat_agent));
        }
        if self.predict_shown > 0 {
            feature.insert(
                "predict".to_string(),
                json!({ "shown": self.predict_shown, "accepted": 0 }),
            );
        }
        Value::Object(feature)
    }
}

/// Group the recent audit rows that carry a forwarded `user_id` into per-user,
/// per-UTC-day buckets shaped like `UserUsageDaily`. Self-hosted / untagged rows
/// (no `user_id`) are skipped, so this is empty on single-user deployments.
fn build_user_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    build_daily(state, entries, "userId", true, |entry| {
        entry.user_id.as_deref().into_iter().collect()
    })
}

/// Per-hosted-credential daily rollup (`keyDaily`), the same shape as
/// `userDaily` keyed by `keyId`. Only `rgw_` traffic carries a key id.
fn build_key_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    build_daily(state, entries, "keyId", false, |entry| {
        entry.key_id.as_deref().into_iter().collect()
    })
}

/// Per-team daily rollup (`teamDaily`), the same shape as `userDaily` keyed by
/// `teamId`. A caller in several teams is charged to each of them, so the row
/// is credited to every team in `team_ids` (falling back to the single
/// `team_id` on older rows). Rows without a team attribution are skipped.
fn build_team_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    build_daily(state, entries, "teamId", false, entry_team_ids)
}

/// Every team an audit row is attributed to, deduplicated.
fn entry_team_ids(entry: &AuditEntry) -> Vec<&str> {
    let mut teams: Vec<&str> = match entry.team_ids.as_deref() {
        Some(joined) => joined
            .split(',')
            .map(str::trim)
            .filter(|team| !team.is_empty())
            .collect(),
        None => entry.team_id.as_deref().into_iter().collect(),
    };
    teams.sort_unstable();
    teams.dedup();
    teams
}

/// Shared `UserUsageDaily`-shaped rollup over one identity dimension. `id_field`
/// names the identity key in the emitted rows; `ids_of` selects the (possibly
/// several) identities a row is credited to. `with_session_ids` adds the
/// hashed `sessionIds` the control plane dedupes sessions by (`userDaily`).
fn build_daily(
    state: &SharedState,
    entries: &[AuditEntry],
    id_field: &str,
    with_session_ids: bool,
    ids_of: impl Fn(&AuditEntry) -> Vec<&str>,
) -> Vec<Value> {
    let mut buckets: HashMap<(String, String), UserDailyBucket> = HashMap::new();
    for entry in entries {
        // A billable service call (web search/fetch etc.) is charged to the
        // same member/key/team caps, so its charged cost and request count
        // belong in the scoped rollups. Unbilled service rows stay out.
        let service_cost = (entry.event_type == "service_call")
            .then(|| audit_cost_micro_usd(entry, &state.config));
        if service_cost == Some(None) {
            continue;
        }
        let Some(day) = entry.timestamp.get(..DAY_KEY_LEN) else {
            continue;
        };
        for id in ids_of(entry).into_iter().filter(|id| !id.is_empty()) {
            let bucket = buckets.entry((id.to_owned(), day.to_string())).or_default();
            match service_cost {
                Some(cost) => bucket.absorb_service(entry, cost.unwrap_or_default()),
                None => bucket.absorb(entry, &state.config),
            }
        }
    }

    buckets
        .into_iter()
        .map(|((id, day), bucket)| {
            let mut row = json!({
                "rollupId": bucket.row_span.rollup_id(id_field, &[id.as_str()], &day),
                id_field: id,
                "day": day,
                "inputTokens": bucket.input_tokens,
                "cacheTokens": bucket.cache_tokens,
                "outputTokens": bucket.output_tokens,
                "requestCount": bucket.request_count,
                "sessionCount": bucket.sessions.len() as u64,
                "agentSeconds": rounded_agent_seconds(bucket.agent_ms),
                // Managed spend, summed per row from provider transaction costs
                // with the control-plane price table as the explicit fallback.
                "costMicroUsd": bucket.cost_micro,
                "byFeature": bucket.by_feature_json(),
                "byModel": bucket.by_model,
                "bySkill": bucket.by_skill,
                "byTransport": bucket.by_transport,
            });
            if with_session_ids {
                // Old control planes keep `$inc`ing `sessionCount`; newer ones
                // use these instead so a session spanning slices counts once.
                row["sessionIds"] = json!(hashed_session_ids(&bucket.sessions));
            }
            row
        })
        .collect()
}

/// Per-`(userId, agentId, day)` accumulator for the control-plane agent usage
/// rollup. Mirrors the `AgentUsageDaily` shape the ingest upserts via `$inc`.
#[derive(Default)]
struct AgentDailyBucket {
    input_tokens: u64,
    output_tokens: u64,
    /// Prompt-cache tokens (see [`audit_cache_tokens`]) → `cacheTokens`.
    cache_tokens: u64,
    request_count: u64,
    /// Distinct session ids seen this day → `sessionCount`.
    sessions: HashSet<String>,
    /// Summed exec `duration_ms`; divided down to whole seconds at emit time.
    agent_ms: u64,
    /// Per-model request counts.
    by_model: HashMap<String, u64>,
    /// Managed per-model spend for the day. See [`UserDailyBucket::cost_micro`].
    cost_micro: u64,
    /// First/last audit row id folded in, for the bucket's `rollupId`.
    row_span: RowSpan,
}

impl AgentDailyBucket {
    /// Fold a single audit row (already known to carry both a `user_id` and an
    /// `agent_id`) into the bucket.
    fn absorb(&mut self, entry: &AuditEntry, config: &crate::config::GatewayConfig) {
        self.row_span.include(entry.id);
        self.input_tokens = self.input_tokens.saturating_add(entry.input_tokens);
        self.cache_tokens = self.cache_tokens.saturating_add(audit_cache_tokens(entry));
        self.output_tokens = self.output_tokens.saturating_add(entry.output_tokens);
        if entry.event_type == "model_call" && entry.managed_inference {
            self.cost_micro = self
                .cost_micro
                .saturating_add(charged_row_cost(entry, config));
        }
        if is_counted_request(entry) {
            self.request_count = self.request_count.saturating_add(1);
            *self
                .by_model
                .entry(display_model(entry).into_owned())
                .or_insert(0) += 1;
        }
        if let Some(session) = &entry.session_id {
            self.sessions.insert(session.clone());
        }
        if let Some(ms) = entry.duration_ms {
            self.agent_ms = self.agent_ms.saturating_add(ms);
        }
    }
}

/// Group the recent audit rows that carry BOTH a forwarded `user_id` AND an
/// `agent_id` into per-user, per-agent, per-UTC-day buckets shaped like
/// `AgentUsageDaily`. Rows missing either id are skipped, so this is empty on
/// single-user / untagged deployments.
fn build_agent_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    let mut buckets: HashMap<(String, String, String), AgentDailyBucket> = HashMap::new();
    for entry in entries {
        if entry.event_type == "service_call" {
            continue;
        }
        let Some(user_id) = entry.user_id.clone() else {
            continue;
        };
        let Some(agent_id) = entry.agent_id.clone() else {
            continue;
        };
        let Some(day) = entry.timestamp.get(..DAY_KEY_LEN) else {
            continue;
        };
        buckets
            .entry((user_id, agent_id, day.to_string()))
            .or_default()
            .absorb(entry, &state.config);
    }

    buckets
        .into_iter()
        .map(|((user_id, agent_id, day), bucket)| {
            json!({
                "rollupId": bucket.row_span.rollup_id(
                    "agentDaily",
                    &[user_id.as_str(), agent_id.as_str()],
                    &day,
                ),
                "userId": user_id,
                "agentId": agent_id,
                "day": day,
                "inputTokens": bucket.input_tokens,
                "cacheTokens": bucket.cache_tokens,
                "outputTokens": bucket.output_tokens,
                "requestCount": bucket.request_count,
                "sessionCount": bucket.sessions.len() as u64,
                "sessionIds": hashed_session_ids(&bucket.sessions),
                "agentSeconds": rounded_agent_seconds(bucket.agent_ms),
                // Real per-model spend (#9), summed per row via the price table.
                "costMicroUsd": bucket.cost_micro,
                "byModel": bucket.by_model,
            })
        })
        .collect()
}

/// Build the aggregate report plus a bounded slice of recent (redacted) audit
/// rows and POST them to `/aggregation/ingest`.
async fn push_report(state: &SharedState) -> anyhow::Result<()> {
    let cfg = &state.config.control_plane;
    let key = cfg
        .gateway_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;

    let summary = state.audit.summary()?;
    let cost = summary_cost_micro_usd(state, &summary);
    let eval_scores = state.evals.all_provider_scores();

    let cursor = state.report_cursor.load(Ordering::Acquire);
    let entries = state.audit.query(&AuditQuery {
        id_after: Some(cursor),
        limit: Some(cfg.audit_limit),
        ..Default::default()
    })?;
    let next_cursor = entries.last().map(|entry| entry.id).unwrap_or(cursor);
    let report_key = format!("audit:{cursor}-{next_cursor}");
    let audit: Vec<Value> = entries
        .iter()
        .map(|entry| audit_payload_entry(entry, &state.config))
        .collect();

    // Per-user daily rollup (profiles / usage-points). Derived from the SAME
    // recent audit slice as `audit` above; rows without a forwarded user_id are
    // skipped, so this is empty on self-hosted / single-user gateways.
    let user_daily = build_user_daily(state, &entries);

    // Per-user-per-agent daily rollup (agent-level attribution). Derived from the
    // SAME recent audit slice; rows missing a user_id OR agent_id are skipped, so
    // this is empty on self-hosted / single-user / untagged gateways.
    let agent_daily = build_agent_daily(state, &entries);

    // Per-key and per-team daily rollups (C1 limits status), the same shape as
    // `userDaily`. Empty when no row carries a hosted key id / team id.
    let key_daily = build_key_daily(state, &entries);
    let team_daily = build_team_daily(state, &entries);

    let payload = json!({
        "report": {
            "windowStart": now_ms().saturating_sub(cfg.report_interval_secs * 1000),
            "windowEnd": now_ms(),
            "reportKey": report_key,
            "inputTokens": summary.input_tokens,
            "outputTokens": summary.output_tokens,
            "costMicroUsd": cost,
            "requestCount": summary.request_count,
            "errorCount": summary.error_count,
            "evalScores": eval_scores,
        },
        "audit": audit,
        "userDaily": user_daily,
        "agentDaily": agent_daily,
        "keyDaily": key_daily,
        "teamDaily": team_daily,
    });

    // `/api` is part of the route: the control plane mounts `aggregationRouter` at
    // `/api/aggregation`, and `cfg.base_url` is the bare origin. Same omission as
    // the credits debit join (see `pipeline/debit.rs`) — every usage rollup POSTed
    // to `/aggregation/ingest` and 404'd, silently, because the reporter is
    // best-effort.
    let url = format!(
        "{}/api/aggregation/ingest",
        cfg.base_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(&payload)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("ingest returned {status}: {body}");
    }

    // Advance (and persist) only after the control plane acknowledged the
    // slice, so an unacknowledged slice is resent rather than skipped.
    state.report_cursor.store(next_cursor, Ordering::Release);
    if next_cursor != cursor {
        if let Err(error) = state.audit.set_report_cursor(REPORT_CURSOR, next_cursor) {
            warn!("control-plane report cursor not persisted: {error}");
        }
    }

    debug!(
        requests = summary.request_count,
        cost_micro_usd = cost,
        audit_rows = audit.len(),
        user_daily = payload["userDaily"].as_array().map_or(0, Vec::len),
        agent_daily = payload["agentDaily"].as_array().map_or(0, Vec::len),
        "pushed report to control plane"
    );
    Ok(())
}

/// Report this gateway's total spend against a shared budget and read back the
/// reconciled remaining balance. The coordinator is the single source of truth.
async fn reconcile_budget(state: &SharedState) -> anyhow::Result<()> {
    let cfg = &state.config.control_plane;
    let Some(budget_id) = cfg.shared_budget_id.as_ref() else {
        return Ok(());
    };
    let key = cfg
        .gateway_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing gateway key"))?;

    let summary = state.audit.summary()?;
    let consumed = summary_cost_micro_usd(state, &summary);

    let url = reserve_url(&cfg.base_url, budget_id);
    let resp = state
        .http
        .post(&url)
        .header("x-gateway-key", key)
        .json(&json!({ "consumedMicroUsd": consumed }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("reserve returned {status}: {body}");
    }

    let body: Value = resp.json().await?;
    if body["exceeded"].as_bool().unwrap_or(false) {
        state.shared_budget.set_shared_exceeded(true);
        warn!(
            budget_id = %budget_id,
            consumed_micro_usd = consumed,
            "shared budget exceeded; gateway will enforce locally"
        );
    } else {
        state.shared_budget.set_shared_exceeded(false);
    }
    Ok(())
}

/// The shared-budget reconcile endpoint. Like ingest, the aggregation router is
/// mounted under `/api` on the control plane and `base_url` is the bare origin;
/// without the prefix every reconcile 404'd and the shared budget never closed.
fn reserve_url(base_url: &str, budget_id: &str) -> String {
    format!(
        "{}/api/aggregation/budgets/{budget_id}/reserve",
        base_url.trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::AuditEntry;

    #[test]
    fn reserve_url_is_mounted_under_api() {
        assert_eq!(
            reserve_url("https://cp.example/", "b1"),
            "https://cp.example/api/aggregation/budgets/b1/reserve"
        );
        assert_eq!(
            reserve_url("http://127.0.0.1:3000", "shared"),
            "http://127.0.0.1:3000/api/aggregation/budgets/shared/reserve"
        );
    }

    #[test]
    fn key_and_team_daily_share_the_user_daily_shape() {
        let state = test_state();
        let mut hosted = base_entry();
        hosted.key_id = Some("cred_1".to_string());
        hosted.team_id = Some("team_1".to_string());
        hosted.user_id = Some("u1".to_string());
        hosted.input_tokens = 10;
        hosted.provider_cost_micro_usd = Some(7);
        let unattributed = base_entry();

        let keys = build_key_daily(&state, &[hosted.clone(), unattributed.clone()]);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0]["keyId"], "cred_1");
        assert_eq!(keys[0]["day"], "2026-07-23");
        assert_eq!(keys[0]["costMicroUsd"], 7);
        assert!(keys[0].get("userId").is_none());

        let teams = build_team_daily(&state, &[hosted.clone(), unattributed]);
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0]["teamId"], "team_1");
        let users = build_user_daily(&state, &[hosted]);
        let user_fields: Vec<_> = users[0].as_object().unwrap().keys().cloned().collect();
        let team_fields: Vec<_> = teams[0].as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            user_fields
                .iter()
                .filter(|key| *key != "userId" && *key != "sessionIds")
                .collect::<Vec<_>>(),
            team_fields
                .iter()
                .filter(|key| *key != "teamId")
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn a_user_in_two_teams_contributes_to_both_team_daily_entries() {
        let state = test_state();
        let mut row = base_entry();
        row.user_id = Some("u1".to_string());
        row.team_id = Some("team_a".to_string());
        row.team_ids = Some("team_a,team_b".to_string());
        row.input_tokens = 10;
        row.managed_inference = true;
        row.provider_cost_micro_usd = Some(7);
        // An older row with only the single team column still counts once.
        let mut legacy = base_entry();
        legacy.team_id = Some("team_a".to_string());
        legacy.input_tokens = 1;

        let mut teams = build_team_daily(&state, &[row.clone(), legacy]);
        teams.sort_by(|left, right| left["teamId"].as_str().cmp(&right["teamId"].as_str()));
        assert_eq!(teams.len(), 2);
        assert_eq!(teams[0]["teamId"], "team_a");
        assert_eq!(teams[0]["inputTokens"], 11);
        assert_eq!(teams[1]["teamId"], "team_b");
        assert_eq!(teams[1]["inputTokens"], 10);
        assert_eq!(teams[1]["costMicroUsd"], 7);
        // The user rollup still counts the row exactly once.
        let users = build_user_daily(&state, &[row]);
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["inputTokens"], 10);
    }

    #[test]
    fn rollups_report_charged_cost_and_a_stable_rollup_id() {
        let mut config = crate::config::GatewayConfig::default();
        config.credits.markup_bps = 1_000; // +10%
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        let state: SharedState = Arc::new(AppState::new_for_test(config, audit, evals));
        let mut row = base_entry();
        row.id = 10;
        row.provider = "openai".to_string();
        row.key_id = Some("cred_1".to_string());
        row.team_ids = Some("team_a".to_string());
        row.user_id = Some("u1".to_string());
        row.managed_inference = true;
        row.provider_cost_micro_usd = Some(1_000);
        let mut later = row.clone();
        later.id = 12;

        let rows = [row.clone(), later];
        for rollup in [
            build_key_daily(&state, &rows),
            build_team_daily(&state, &rows),
            build_user_daily(&state, &rows),
        ] {
            assert_eq!(rollup.len(), 1);
            // Charged (marked-up) amount, the unit enforcement debits.
            assert_eq!(rollup[0]["costMicroUsd"], 2_200);
            assert!(rollup[0]["rollupId"].as_str().unwrap().starts_with("ru_"));
        }
        let keys = build_key_daily(&state, &rows);
        let teams = build_team_daily(&state, &rows);
        // Deterministic for the same rows; distinct per rollup kind and per slice.
        assert_eq!(
            keys[0]["rollupId"],
            build_key_daily(&state, &rows)[0]["rollupId"]
        );
        assert_ne!(keys[0]["rollupId"], teams[0]["rollupId"]);
        assert_ne!(
            keys[0]["rollupId"],
            build_key_daily(&state, &[row])[0]["rollupId"]
        );
        let agents = build_agent_daily(&state, &rows);
        assert!(agents.iter().all(|entry| entry["rollupId"].is_string()));
    }

    #[test]
    fn daily_buckets_sum_cache_tokens_and_audit_rows_list_every_team() {
        let state = test_state();
        let mut row = base_entry();
        row.user_id = Some("u1".to_string());
        row.agent_id = Some("agent".to_string());
        row.key_id = Some("cred_1".to_string());
        row.team_id = Some("team_a".to_string());
        row.team_ids = Some("team_a,team_b".to_string());
        row.prompt_cache_read_tokens = Some(30);
        row.prompt_cache_write_tokens = Some(5);
        let mut second = row.clone();
        second.id = 2;
        second.prompt_cache_read_tokens = None;
        second.prompt_cache_write_tokens = None;
        second.cache_read_tokens = Some(4);
        let rows = [row.clone(), second];
        for rollup in [
            build_user_daily(&state, &rows),
            build_key_daily(&state, &rows),
            build_agent_daily(&state, &rows),
        ] {
            assert_eq!(rollup[0]["cacheTokens"], 39);
        }
        let teams = build_team_daily(&state, &rows);
        assert_eq!(teams.len(), 2);
        assert!(teams.iter().all(|team| team["cacheTokens"] == 39));

        let cp = crate::config::GatewayConfig::default();
        let payload = audit_payload_entry(&row, &cp);
        assert_eq!(payload["teamId"], "team_a");
        assert_eq!(payload["teamIds"], json!(["team_a", "team_b"]));
        let mut legacy = base_entry();
        legacy.team_id = Some("team_z".to_string());
        assert_eq!(
            audit_payload_entry(&legacy, &cp)["teamIds"],
            json!(["team_z"])
        );
        assert_eq!(
            audit_payload_entry(&base_entry(), &cp)["teamIds"],
            json!([])
        );
    }

    use crate::state::{AppState, SharedState};
    use std::sync::Arc;

    fn test_state() -> SharedState {
        Arc::new(AppState::new_for_test_default())
    }

    /// A fully-defaulted audit row; tests override only the fields they exercise.
    fn base_entry() -> AuditEntry {
        AuditEntry {
            key_id: None,
            id: 1,
            timestamp: "2026-07-23T12:00:00".to_string(),
            request_id: "req-1".to_string(),
            api_key: "sk-xxxx".to_string(),
            user_name: None,
            org_id: None,
            team_id: None,
            team_ids: None,
            project_id: None,
            provider: "openai".to_string(),
            model: "gpt-4o".to_string(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_hit: false,
            prompt_cache_outcome: None,
            prompt_cache_read_tokens: None,
            prompt_cache_write_tokens: None,
            cache_write_1h_tokens: None,
            purpose: None,
            latency_ms: 0,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            event_type: "model_call".to_string(),
            service_usage: None,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            user_id: None,
            agent_id: None,
            feature: None,
            managed_inference: true,
            provider_cost_micro_usd: None,
            widget_instance_id: None,
        }
    }

    /// Usage analytics name own-supply work by the Ryu Router id the user knows,
    /// never the supplier's id; a BYOK slot serving the same id keeps its name.
    #[test]
    fn managed_pool_rows_report_the_ryu_router_id_not_the_upstream_id() {
        let cp = crate::config::GatewayConfig::default();
        let mut entry = base_entry();
        entry.provider = "anthropic-credits".into();
        entry.model = "claude-opus-4-5".into();
        assert_eq!(
            audit_payload_entry(&entry, &cp)["model"],
            "anthropic/claude-opus-4.5"
        );
        entry.user_id = Some("user-1".into());
        let rows = build_user_daily(&test_state(), &[entry.clone()]);
        assert_eq!(rows[0]["byModel"]["anthropic/claude-opus-4.5"], 1);
        assert!(rows[0]["byModel"].get("claude-opus-4-5").is_none());

        // Managed own-supply traffic never names its slot in analytics.
        assert_eq!(audit_payload_entry(&entry, &cp)["provider"], "ryu");
        entry.provider = "anthropic".into();
        assert_eq!(audit_payload_entry(&entry, &cp)["model"], "claude-opus-4-5");
        assert_eq!(audit_payload_entry(&entry, &cp)["provider"], "anthropic");
        // An alias-recorded (cache-hit) row prices by its upstream id.
        assert_eq!(pricing_model("ryu-code/max"), "claude-opus-4-5");
        assert_eq!(pricing_model("gpt-4o"), "gpt-4o");
    }

    #[test]
    fn service_payload_keeps_safe_units_and_does_not_synthesize_model_cost_or_model_counts() {
        let mut entry = base_entry();
        entry.event_type = "service_call".into();
        entry.model.clear();
        entry.input_tokens = 0;
        entry.output_tokens = 0;
        entry.duration_ms = None;
        entry.command = Some("web.search".into());
        entry.managed_inference = true;
        entry.provider = "exa".into();
        entry.provider_cost_micro_usd = None;
        entry.service_usage = Some(crate::audit::AuditServiceUsage {
            requests: 1,
            documents: 0,
            provider_credits: Some(0),
            cost_source: crate::audit::AuditServiceCostSource::ConfiguredEstimate,
            cost_is_estimate: true,
        });
        let cp = crate::config::GatewayConfig::default();
        let payload = audit_payload_entry(&entry, &cp);
        assert!(payload["model"].is_null());
        assert!(payload["costMicroUsd"].is_null());
        assert_eq!(payload["serviceUsage"]["requests"], 1);
        assert_eq!(payload["serviceUsage"]["providerCredits"], 0);
        assert_eq!(payload["serviceUsage"]["costSource"], "configured_estimate");
        assert_eq!(payload["serviceUsage"]["costIsEstimate"], true);
        entry.user_id = Some("user-service".into());
        let rows = build_user_daily(&test_state(), &[entry.clone()]);
        assert!(rows.is_empty());
        entry.agent_id = Some("agent-service".into());
        assert!(build_agent_daily(&test_state(), &[entry.clone()]).is_empty());
        entry.provider_cost_micro_usd = Some(0);
        entry.service_usage.as_mut().unwrap().cost_source =
            crate::audit::AuditServiceCostSource::ProviderReported;
        assert_eq!(audit_payload_entry(&entry, &cp)["costMicroUsd"], 0);
    }

    #[test]
    fn audit_rows_carry_prompt_cache_tokens_for_ingest() {
        let cp = crate::config::GatewayConfig::default();
        let mut entry = base_entry();
        assert_eq!(audit_payload_entry(&entry, &cp)["cacheTokens"], 0);
        entry.cache_read_tokens = Some(7);
        assert_eq!(audit_payload_entry(&entry, &cp)["cacheTokens"], 7);
        entry.prompt_cache_read_tokens = Some(30);
        entry.prompt_cache_write_tokens = Some(12);
        assert_eq!(audit_payload_entry(&entry, &cp)["cacheTokens"], 42);
    }

    #[test]
    fn cost_micro_usd_uses_flat_rate() {
        let state = test_state();
        // Default control-plane rate is 2000 micro-USD / 1k combined tokens.
        assert_eq!(cost_micro_usd(&state, 500, 500), 2000);
        assert_eq!(cost_micro_usd(&state, 0, 0), 0);
    }

    #[test]
    fn summary_cost_prefers_provider_transaction_cost_and_estimates_only_missing_rows() {
        let state = test_state();
        let summary = AuditSummary {
            input_tokens: 1_000,
            output_tokens: 1_000,
            reported_cost_micro_usd: 125,
            unpriced_input_tokens: 500,
            unpriced_output_tokens: 500,
            ..Default::default()
        };
        // 125 reported + 1000 tokens * 2000/1k = 2125 micro-USD.
        assert_eq!(summary_cost_micro_usd(&state, &summary), 2_125);
    }

    #[test]
    fn daily_rollup_uses_the_provider_transaction_cost() {
        let state = test_state();
        let mut entry = base_entry();
        entry.user_id = Some("u1".to_string());
        entry.input_tokens = 1_000;
        entry.provider_cost_micro_usd = Some(125);
        let rows = build_user_daily(&state, &[entry]);
        assert_eq!(rows[0]["costMicroUsd"], 125);
    }

    #[test]
    fn audit_payload_carries_rollup_dimensions_and_exact_managed_cost() {
        let state = test_state();
        let mut entry = base_entry();
        entry.agent_id = Some("agent-1".to_string());
        entry.feature = Some("agent".to_string());
        entry.session_id = Some("session-1".to_string());
        entry.duration_ms = Some(2_500);
        entry.provider_cost_micro_usd = Some(125);

        let payload = audit_payload_entry(&entry, &state.config);

        assert_eq!(payload["feature"], "agent");
        assert_eq!(payload["agentId"], "agent-1");
        assert_eq!(payload["sessionId"], "session-1");
        assert_eq!(payload["durationMs"], 2_500);
        assert_eq!(payload["costMicroUsd"], 125);
    }

    #[test]
    fn audit_row_cost_is_the_charged_amount_like_the_rollups() {
        let mut config = crate::config::GatewayConfig::default();
        config.credits.markup_bps = 2_500; // +25%
        let mut entry = base_entry();
        entry.provider = "openai".to_string();
        entry.user_id = Some("u1".to_string());
        entry.managed_inference = true;
        entry.provider_cost_micro_usd = Some(400);
        assert_eq!(audit_payload_entry(&entry, &config)["costMicroUsd"], 500);
        // Same unit as the daily rollup of the same row.
        assert_eq!(charged_row_cost(&entry, &config), 500);
        entry.event_type = "service_call".to_string();
        assert_eq!(audit_payload_entry(&entry, &config)["costMicroUsd"], 500);
        entry.managed_inference = false;
        assert!(audit_payload_entry(&entry, &config)["costMicroUsd"].is_null());
    }

    /// The rollup re-prices an own-supply row (no provider-reported cost) the
    /// way the wallet debit did, including one-hour cache writes billed above
    /// the five-minute rate (the arithmetic of the pipeline's debit test).
    #[test]
    fn own_supply_rows_price_one_hour_cache_writes_like_the_debit() {
        // Opus: $15/M in, $75/M out, $18.75/M five-minute write.
        let price = ryu_gw_router::own_supply::OwnSupplyPrice {
            cache_read_per_1k_micro_usd: Some(1_500),
            cache_write_per_1k_micro_usd: Some(18_750),
            ..ryu_gw_router::own_supply::OwnSupplyPrice::flat(15_000, 75_000)
        };
        let mut entry = base_entry();
        entry.provider = "anthropic-credits".to_string();
        entry.input_tokens = 1_000;
        entry.output_tokens = 1_000;
        entry.cache_write_tokens = Some(1_000);
        entry.cache_write_1h_tokens = Some(1_000);
        // One-hour writes at 2x the prompt price, as the debit bills them.
        assert_eq!(own_supply_row_cost(&entry, &price), 30_000 + 75_000);
        // A row that predates the split prices every write at the 5m rate.
        entry.cache_write_1h_tokens = None;
        assert_eq!(own_supply_row_cost(&entry, &price), 18_750 + 75_000);
    }

    #[test]
    fn billable_service_calls_reach_member_key_and_team_rollups() {
        let mut config = crate::config::GatewayConfig::default();
        config.credits.markup_bps = 1_000; // +10%
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        let state: SharedState = Arc::new(AppState::new_for_test(config, audit, evals));
        let mut service = base_entry();
        service.event_type = "service_call".to_string();
        service.provider = "exa".to_string();
        service.managed_inference = true;
        service.provider_cost_micro_usd = Some(100);
        service.input_tokens = 999; // never counted for service rows
        service.user_id = Some("u1".to_string());
        service.key_id = Some("cred_1".to_string());
        service.team_ids = Some("team_a,team_b".to_string());
        let mut unbilled = service.clone();
        unbilled.id = 2;
        unbilled.provider_cost_micro_usd = None;
        let rows = [service, unbilled];
        let mut rollups = vec![
            build_user_daily(&state, &rows),
            build_key_daily(&state, &rows),
        ];
        let teams = build_team_daily(&state, &rows);
        assert_eq!(teams.len(), 2);
        rollups.push(teams);
        for rollup in rollups {
            for entry in rollup {
                assert_eq!(entry["costMicroUsd"], 110);
                assert_eq!(entry["requestCount"], 1);
                assert_eq!(entry["inputTokens"], 0);
            }
        }
    }

    #[test]
    fn audit_payload_keeps_byok_cost_null() {
        let state = test_state();
        let mut entry = base_entry();
        entry.managed_inference = false;
        entry.provider = "openrouter".to_string();
        entry.provider_cost_micro_usd = Some(125);

        let payload = audit_payload_entry(&entry, &state.config);

        assert!(payload["costMicroUsd"].is_null());
    }

    #[test]
    fn build_user_daily_skips_rows_without_a_user_id() {
        let state = test_state();
        // Two rows, neither carries a forwarded user_id ⇒ empty rollup (self-hosted).
        let entries = vec![base_entry(), base_entry()];
        assert!(build_user_daily(&state, &entries).is_empty());
    }

    #[test]
    fn build_user_daily_aggregates_tokens_models_and_sessions_per_day() {
        let state = test_state();
        let mut a = base_entry();
        a.user_id = Some("u1".to_string());
        a.input_tokens = 100;
        a.output_tokens = 50;
        a.session_id = Some("s1".to_string());
        a.feature = Some("chat".to_string());
        a.duration_ms = Some(2500);

        let mut b = base_entry();
        b.user_id = Some("u1".to_string());
        b.input_tokens = 20;
        b.output_tokens = 10;
        b.model = "claude".to_string();
        b.session_id = Some("s2".to_string());
        b.feature = Some("agent".to_string());
        b.skill_ids = Some("skill-a, skill-b".to_string());

        let rows = build_user_daily(&state, &[a, b]);
        assert_eq!(rows.len(), 1, "same user + same UTC day ⇒ one bucket");
        let r = &rows[0];
        assert_eq!(r["userId"], "u1");
        assert_eq!(r["day"], "2026-07-23");
        assert_eq!(r["inputTokens"], 120);
        assert_eq!(r["outputTokens"], 60);
        assert_eq!(r["requestCount"], 2);
        assert_eq!(r["sessionCount"], 2, "two distinct session ids");
        assert_eq!(r["agentSeconds"], 3, "2500ms ⇒ 3 seconds (rounded half up)");
        // 180 tokens * 2000/1k = 360 micro-USD via the flat rate.
        assert_eq!(r["costMicroUsd"], 360);
        assert_eq!(r["byModel"]["gpt-4o"], 1);
        assert_eq!(r["byModel"]["claude"], 1);
        assert_eq!(r["bySkill"]["skill-a"], 1);
        assert_eq!(r["bySkill"]["skill-b"], 1);
        assert_eq!(r["byTransport"]["gateway"], 2);
        assert_eq!(r["byFeature"]["chat"], 1);
        assert_eq!(r["byFeature"]["agent"], 1);
        // Untouched surfaces stay absent (sparse payload).
        assert!(r["byFeature"].get("island").is_none());
    }

    #[test]
    fn build_user_daily_splits_buckets_across_days() {
        let state = test_state();
        let mut day1 = base_entry();
        day1.user_id = Some("u1".to_string());
        day1.timestamp = "2026-07-23T23:59:00".to_string();
        let mut day2 = base_entry();
        day2.user_id = Some("u1".to_string());
        day2.timestamp = "2026-07-24T00:01:00".to_string();
        let rows = build_user_daily(&state, &[day1, day2]);
        assert_eq!(rows.len(), 2, "same user, two UTC days ⇒ two buckets");
    }

    #[test]
    fn build_user_daily_non_model_call_rows_do_not_count_as_requests() {
        let state = test_state();
        let mut exec = base_entry();
        exec.user_id = Some("u1".to_string());
        exec.event_type = "exec".to_string();
        exec.input_tokens = 5;
        exec.output_tokens = 5;
        exec.duration_ms = Some(1000);
        let rows = build_user_daily(&state, &[exec]);
        let r = &rows[0];
        // Tokens still fold in, but requestCount / byModel / cost are model_call-only.
        assert_eq!(r["inputTokens"], 5);
        assert_eq!(r["requestCount"], 0);
        assert_eq!(r["costMicroUsd"], 0);
        assert_eq!(r["agentSeconds"], 1);
        assert!(r["byModel"].as_object().unwrap().is_empty());
    }

    #[test]
    fn predict_feature_emits_shown_and_zero_accepted() {
        let state = test_state();
        let mut p = base_entry();
        p.user_id = Some("u1".to_string());
        p.feature = Some("predict".to_string());
        let rows = build_user_daily(&state, &[p]);
        assert_eq!(rows[0]["byFeature"]["predict"]["shown"], 1);
        assert_eq!(rows[0]["byFeature"]["predict"]["accepted"], 0);
    }

    #[test]
    fn build_agent_daily_requires_both_user_and_agent_ids() {
        let state = test_state();
        let mut only_user = base_entry();
        only_user.user_id = Some("u1".to_string());
        let mut both = base_entry();
        both.user_id = Some("u1".to_string());
        both.agent_id = Some("a1".to_string());
        both.input_tokens = 30;
        both.output_tokens = 10;
        both.session_id = Some("s1".to_string());

        let rows = build_agent_daily(&state, &[only_user, both]);
        assert_eq!(rows.len(), 1, "the user-only row is skipped");
        let r = &rows[0];
        assert_eq!(r["userId"], "u1");
        assert_eq!(r["agentId"], "a1");
        assert_eq!(r["inputTokens"], 30);
        assert_eq!(r["outputTokens"], 10);
        assert_eq!(r["requestCount"], 1);
        assert_eq!(r["sessionCount"], 1);
        // 40 tokens * 2000/1k = 80 micro-USD.
        assert_eq!(r["costMicroUsd"], 80);
        assert_eq!(r["byModel"]["gpt-4o"], 1);
    }

    #[test]
    fn user_and_agent_daily_carry_hashed_session_ids() {
        let state = test_state();
        let mut a = base_entry();
        a.user_id = Some("u1".to_string());
        a.agent_id = Some("a1".to_string());
        a.session_id = Some("s1".to_string());
        let mut b = a.clone();
        b.id = 2;
        b.session_id = Some("s2".to_string());
        let mut repeat = a.clone();
        repeat.id = 3;
        let rows = [a, b, repeat];

        let expected = {
            let mut ids = vec![session_hash("s1"), session_hash("s2")];
            ids.sort();
            json!(ids)
        };
        for rollup in [
            build_user_daily(&state, &rows),
            build_agent_daily(&state, &rows),
        ] {
            assert_eq!(rollup[0]["sessionIds"], expected);
            // Old control planes still get the distinct count.
            assert_eq!(rollup[0]["sessionCount"], 2);
        }
        // First 16 hex chars of sha256("s1"); never the raw id.
        assert_eq!(session_hash("s1"), "e8bc163c82eee187");
        assert_eq!(session_hash("s1").len(), SESSION_HASH_HEX_LEN);
        // Only the user/agent rollups carry them.
        let mut keyed = rows[0].clone();
        keyed.key_id = Some("cred_1".to_string());
        assert!(build_key_daily(&state, &[keyed])[0]
            .get("sessionIds")
            .is_none());
        // A bucket without sessions sends an empty list.
        let mut no_session = base_entry();
        no_session.user_id = Some("u2".to_string());
        assert_eq!(
            build_user_daily(&state, &[no_session])[0]["sessionIds"],
            json!([])
        );
    }

    #[test]
    fn session_ids_are_capped_at_the_first_sorted_five_hundred() {
        let sessions: HashSet<String> = (0..MAX_SESSION_IDS_PER_BUCKET + 25)
            .map(|index| format!("session-{index}"))
            .collect();
        let ids = hashed_session_ids(&sessions);
        assert_eq!(ids.len(), MAX_SESSION_IDS_PER_BUCKET);
        let mut all: Vec<String> = sessions.iter().map(|id| session_hash(id)).collect();
        all.sort();
        assert_eq!(ids, all[..MAX_SESSION_IDS_PER_BUCKET]);
        assert_eq!(ids, hashed_session_ids(&sessions));

        let state = test_state();
        let rows: Vec<AuditEntry> = sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                let mut row = base_entry();
                row.id = index as i64 + 1;
                row.user_id = Some("u1".to_string());
                row.session_id = Some(session.clone());
                row
            })
            .collect();
        let rollup = build_user_daily(&state, &rows);
        assert_eq!(
            rollup[0]["sessionIds"].as_array().unwrap().len(),
            MAX_SESSION_IDS_PER_BUCKET
        );
        assert_eq!(rollup[0]["sessionCount"], MAX_SESSION_IDS_PER_BUCKET + 25);
    }

    #[test]
    fn by_feature_counts_only_model_call_requests() {
        let state = test_state();
        let mut call = base_entry();
        call.user_id = Some("u1".to_string());
        call.feature = Some("chat".to_string());
        let mut exec = call.clone();
        exec.id = 2;
        exec.event_type = "exec".to_string();
        exec.duration_ms = Some(1_000);
        let mut predict_exec = exec.clone();
        predict_exec.id = 3;
        predict_exec.feature = Some("predict".to_string());
        let rows = build_user_daily(&state, &[call, exec, predict_exec]);
        assert_eq!(rows[0]["requestCount"], 1);
        assert_eq!(rows[0]["byFeature"], json!({ "chat": 1 }));
        assert_eq!(rows[0]["agentSeconds"], 2);
    }

    #[test]
    fn errored_model_calls_keep_tokens_and_cost_but_are_not_requests() {
        let state = test_state();
        let mut ok = base_entry();
        ok.user_id = Some("u1".to_string());
        ok.agent_id = Some("a1".to_string());
        ok.feature = Some("chat".to_string());
        ok.input_tokens = 10;
        ok.provider_cost_micro_usd = Some(5);
        let mut failed = ok.clone();
        failed.id = 2;
        failed.model = "claude".to_string();
        failed.input_tokens = 7;
        failed.provider_cost_micro_usd = Some(3);
        failed.error = Some("stream interrupted".to_string());
        let mut denied = ok.clone();
        denied.id = 3;
        denied.feature = Some("agent".to_string());
        denied.input_tokens = 0;
        denied.provider_cost_micro_usd = Some(0);
        denied.error = Some("budget_denied".to_string());
        let rows = [ok, failed, denied];

        let user = &build_user_daily(&state, &rows)[0];
        assert_eq!(user["requestCount"], 1);
        assert_eq!(user["inputTokens"], 17);
        assert_eq!(user["costMicroUsd"], 8);
        assert_eq!(user["byFeature"], json!({ "chat": 1 }));
        assert_eq!(user["byModel"], json!({ "gpt-4o": 1 }));
        assert_eq!(user["byTransport"], json!({ "gateway": 1 }));

        let agent = &build_agent_daily(&state, &rows)[0];
        assert_eq!(agent["requestCount"], 1);
        assert_eq!(agent["inputTokens"], 17);
        assert_eq!(agent["costMicroUsd"], 8);
        assert_eq!(agent["byModel"], json!({ "gpt-4o": 1 }));
    }

    #[test]
    fn agent_seconds_round_to_nearest_second_per_slice() {
        assert_eq!(rounded_agent_seconds(0), 0);
        assert_eq!(rounded_agent_seconds(499), 0);
        assert_eq!(rounded_agent_seconds(500), 1);
        assert_eq!(rounded_agent_seconds(1499), 1);
        assert_eq!(rounded_agent_seconds(1500), 2);
        assert_eq!(rounded_agent_seconds(u64::MAX), u64::MAX / MS_PER_SEC);

        let state = test_state();
        let mut a = base_entry();
        a.user_id = Some("u1".to_string());
        a.agent_id = Some("a1".to_string());
        a.duration_ms = Some(400);
        let mut b = a.clone();
        b.duration_ms = Some(400);
        // Two 400ms rows sum to 800ms within the slice ⇒ 1s, not 0s.
        assert_eq!(
            build_user_daily(&state, &[a.clone(), b.clone()])[0]["agentSeconds"],
            1
        );
        assert_eq!(build_agent_daily(&state, &[a, b])[0]["agentSeconds"], 1);
    }
}
