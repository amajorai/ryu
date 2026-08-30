//! Safe, node-scoped Marketplace recommendations.
//!
//! The endpoint is deliberately an adapter around the existing catalog handlers:
//! those handlers own source selection, install state, and per-kind normalization.
//! This module only joins their public card projections, asks the configured side
//! model for a bounded ranking, and intersects that ranking back with known cards.
//! Raw memory, connection payloads, and credentials never enter this path.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get as route_get, put as route_put},
    Extension, Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::Mutex;

use super::{AgentCatalogQuery, ServerState};

const HIDDEN_PREF_PREFIX: &str = "marketplace.recommendations.hidden.";
const MODEL_PREF: &str = "marketplace-recommendations-model";
const EFFORT_PREF: &str = "marketplace-recommendations-effort";
const MAX_CATALOG_ROWS_PER_KIND: usize = 12;
const MAX_RECOMMENDATIONS: usize = 12;
const MAX_REASON_CHARS: usize = 180;
const MAX_MODEL_RESPONSE_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cadence {
    Daily,
    Weekly,
    Monthly,
}

impl Cadence {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("daily") => Self::Daily,
            Some("monthly") => Self::Monthly,
            _ => Self::Weekly,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    fn ttl(self) -> Duration {
        match self {
            Self::Daily => Duration::from_secs(24 * 60 * 60),
            Self::Weekly => Duration::from_secs(7 * 24 * 60 * 60),
            Self::Monthly => Duration::from_secs(31 * 24 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct RecommendationRow {
    id: String,
    kind: String,
    name: String,
    description: Option<String>,
    icon_url: Option<String>,
    installed: bool,
    reason: String,
    generated_at: String,
    cache_scope: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct RecommendationResponse {
    enabled: bool,
    hidden: bool,
    cadence: &'static str,
    cached: bool,
    generated_at: Option<String>,
    items: Vec<RecommendationRow>,
}

#[derive(Debug, Clone)]
struct CatalogReference {
    id: String,
    kind: String,
    name: String,
    description: Option<String>,
    icon_url: Option<String>,
    installed: bool,
}

#[derive(Debug, Clone)]
struct CachedFeed {
    created_at: std::time::Instant,
    generated_at: String,
    items: Vec<RecommendationRow>,
}

static CACHE: OnceLock<Mutex<HashMap<String, CachedFeed>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CachedFeed>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn user_scope(caller: &Option<crate::identity_verify::VerifiedCaller>) -> String {
    let raw = caller
        .as_ref()
        .map(|value| value.user_id.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("local");
    digest(raw)
}

fn preference_key(scope: &str) -> String {
    format!("{HIDDEN_PREF_PREFIX}{scope}")
}

fn digest(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn gateway_policy(value: &Value) -> (bool, Cadence) {
    let policy = value.get("marketplace_recommendations");
    (
        policy
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        Cadence::parse(
            policy
                .and_then(|value| value.get("cadence"))
                .and_then(Value::as_str),
        ),
    )
}

fn empty_response(enabled: bool, hidden: bool, cadence: Cadence) -> RecommendationResponse {
    RecommendationResponse {
        enabled,
        hidden,
        cadence: cadence.as_str(),
        cached: false,
        generated_at: None,
        items: Vec::new(),
    }
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn references_from(value: &Value, key: &str, kind: &str) -> Vec<CatalogReference> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_CATALOG_ROWS_PER_KIND)
        .filter_map(|entry| reference_from_entry(entry, kind))
        .collect()
}

fn app_references_from(value: &Value) -> Vec<CatalogReference> {
    value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_CATALOG_ROWS_PER_KIND)
        .filter_map(|entry| {
            let is_app = entry
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "app")
                || entry
                    .get("kinds")
                    .and_then(Value::as_array)
                    .is_some_and(|kinds| {
                        kinds.iter().any(|kind| kind.as_str() == Some("companion"))
                    });
            reference_from_entry(entry, if is_app { "app" } else { "plugin" })
        })
        .collect()
}

fn reference_from_entry(entry: &Value, kind: &str) -> Option<CatalogReference> {
    let id = optional_string(entry.get("id"))?;
    let name = optional_string(entry.get("name")).unwrap_or_else(|| id.clone());
    Some(CatalogReference {
        id,
        kind: kind.to_owned(),
        name,
        description: optional_string(entry.get("description")),
        icon_url: optional_string(entry.get("icon_url").or_else(|| entry.get("iconUrl"))),
        installed: entry
            .get("installed")
            .and_then(Value::as_bool)
            .or_else(|| entry.get("added").and_then(Value::as_bool))
            .unwrap_or(false),
    })
}

async fn catalog_references(state: &ServerState) -> Vec<CatalogReference> {
    let apps = super::list_apps_catalog(State(state.clone())).await.0;
    let agents = super::list_agent_catalog(
        State(state.clone()),
        Query(AgentCatalogQuery {
            versions: Some("0".to_owned()),
        }),
    )
    .await
    .0;
    let (models_status, models) = super::models_catalog_list(
        State(state.clone()),
        Query(HashMap::from([
            ("limit".to_owned(), MAX_CATALOG_ROWS_PER_KIND.to_string()),
            ("sort".to_owned(), "trending".to_owned()),
        ])),
    )
    .await;
    let (skills_status, skills) = super::skills_catalog_list(
        State(state.clone()),
        Query(HashMap::from([
            ("limit".to_owned(), MAX_CATALOG_ROWS_PER_KIND.to_string()),
            ("source".to_owned(), "all".to_owned()),
        ])),
    )
    .await;
    let (mcp_status, mcp) = super::mcp_catalog_list(
        State(state.clone()),
        Query(HashMap::from([(
            "limit".to_owned(),
            MAX_CATALOG_ROWS_PER_KIND.to_string(),
        )])),
    )
    .await;

    let mut refs = app_references_from(&apps);
    refs.extend(references_from(&agents, "agents", "agent"));
    if models_status.is_success() {
        refs.extend(references_from(&models, "models", "model"));
    }
    if skills_status.is_success() {
        refs.extend(references_from(&skills, "skills", "skill"));
    }
    if mcp_status.is_success() {
        refs.extend(references_from(&mcp, "servers", "mcp"));
    }

    refs
}

fn catalog_revision(references: &[CatalogReference]) -> String {
    let safe: Vec<(&str, &str, &str, bool)> = references
        .iter()
        .map(|value| {
            (
                value.kind.as_str(),
                value.id.as_str(),
                value.name.as_str(),
                value.installed,
            )
        })
        .collect();
    digest(&serde_json::to_string(&safe).unwrap_or_default())
}

async fn settings_revision(state: &ServerState, cadence: Cadence) -> String {
    let model = state
        .preferences
        .get(MODEL_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let effort = state
        .preferences
        .get(EFFORT_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    digest(&format!("{}:{}:{}", cadence.as_str(), model, effort))
}

fn recommendation_prompt(references: &[CatalogReference], signals: &[String]) -> String {
    let installed = references
        .iter()
        .filter(|value| value.installed)
        .map(|value| format!("{}:{}", value.kind, value.id))
        .take(24)
        .collect::<Vec<_>>();
    let candidates = references
        .iter()
        .map(|value| {
            json!({
                "kind": value.kind,
                "id": value.id,
                "name": value.name,
                "description": value.description,
                "installed": value.installed,
            })
        })
        .take(48)
        .collect::<Vec<_>>();
    format!(
        "Derived Marketplace signals only. Installed catalog references: {}. Safe profile signals: {}. Choose up to {MAX_RECOMMENDATIONS} candidates from the JSON list. Return JSON only as {{\"recommendations\":[{{\"kind\":\"...\",\"id\":\"...\",\"reason\":\"short safe reason\"}}]}}. Reasons must be derived from the candidate metadata, installation state, and safe profile signals; do not mention private memory, credentials, connection values, or hidden context. Candidates: {}",
        if installed.is_empty() {
            "none".to_owned()
        } else {
            installed.join(", ")
        },
        if signals.is_empty() {
            "none".to_owned()
        } else {
            signals.join(", ")
        },
        serde_json::to_string(&candidates).unwrap_or_else(|_| "[]".to_owned())
    )
}

/// Reduce private context to an allowlisted, category-only signal set before it
/// reaches the default cloud agent. Memory contents, domains, ids, and sealed
/// connection state never leave this function.
async fn safe_profile_signals(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Vec<String> {
    let mut signals = BTreeSet::new();

    if let Some(store) = crate::identity::global() {
        if let Ok(connections) = store.list().await {
            for connection in connections.into_iter().take(32) {
                let source = connection.source.trim().to_ascii_lowercase();
                let kind = if source.contains("mcp") {
                    "mcp"
                } else if source.contains("composio") || source.contains("toolkit") {
                    "toolkit"
                } else if source.contains("oauth") {
                    "oauth"
                } else if source.contains("manual") {
                    "manual"
                } else {
                    "other"
                };
                signals.insert(format!("connection:{kind}"));
                signals.insert(format!(
                    "connection_status:{}",
                    connection.status.as_str().to_ascii_lowercase()
                ));
            }
        }
    }

    let filter = super::memory::MemoryFilter {
        limit: Some(64),
        lifecycle: Some(super::memory::MemoryLifecycle::Active),
        ..Default::default()
    };
    let visibility = super::memory::MemoryVisibility::for_caller_in_org(
        caller.as_ref().map(|value| value.user_id.as_str()),
        caller.as_ref().and_then(|value| value.org_id.as_deref()),
        super::node_org_id().is_some(),
    );
    let consent_user_id = caller
        .as_ref()
        .map(|value| value.user_id.as_str())
        .unwrap_or(super::memory::LOCAL_USER);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(consent_user_id)
        .await
        .unwrap_or(false);
    if let Ok(entries) = state
        .memory
        .list_visible_with_sensitive(&filter, visibility, include_sensitive)
        .await
    {
        for entry in entries {
            signals.insert(format!("memory_category:{}", entry.category.as_str()));
        }
    }

    signals.into_iter().take(24).collect()
}

fn clipped_reason(value: Option<&str>, fallback: &str) -> String {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    value.chars().take(MAX_REASON_CHARS).collect()
}

fn parse_model_rows(
    raw: &str,
    references: &[CatalogReference],
    generated_at: &str,
) -> Vec<RecommendationRow> {
    let clipped: String = raw.chars().take(MAX_MODEL_RESPONSE_CHARS).collect();
    let parsed = serde_json::from_str::<Value>(&clipped).ok();
    let picks = parsed
        .as_ref()
        .and_then(|value| value.get("recommendations"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let by_key: HashMap<String, &CatalogReference> = references
        .iter()
        .map(|value| (format!("{}:{}", value.kind, value.id), value))
        .collect();
    let mut seen = std::collections::HashSet::new();
    picks
        .into_iter()
        .take(MAX_RECOMMENDATIONS)
        .filter_map(|pick| {
            let kind = pick.get("kind").and_then(Value::as_str)?.trim();
            let id = pick.get("id").and_then(Value::as_str)?.trim();
            let key = format!("{kind}:{id}");
            let reference = by_key.get(&key).copied()?;
            if !seen.insert(key) {
                return None;
            }
            Some(RecommendationRow {
                id: reference.id.clone(),
                kind: reference.kind.clone(),
                name: reference.name.clone(),
                description: reference.description.clone(),
                icon_url: reference.icon_url.clone(),
                installed: reference.installed,
                reason: clipped_reason(
                    pick.get("reason").and_then(Value::as_str),
                    "A match for your current catalog setup.",
                ),
                generated_at: generated_at.to_owned(),
                cache_scope: "node-user-catalog-settings",
            })
        })
        .collect()
}

struct RecommendationModelAdapter<'a> {
    state: &'a ServerState,
}

impl RecommendationModelAdapter<'_> {
    async fn generate(
        &self,
        references: &[CatalogReference],
        signals: &[String],
        generated_at: &str,
    ) -> Vec<RecommendationRow> {
        let model = crate::agent_selection::resolve_side_model(
            &self.state.preferences,
            MODEL_PREF,
            Some(EFFORT_PREF),
        )
        .await
        .map(|value| (value.model, value.effort))
        .unwrap_or_else(|| (crate::registry::DEFAULT_LLM_MODEL.to_owned(), String::new()));
        let system = "You are Ryu's Marketplace recommendation adapter. Rank only the supplied catalog references. Return safe derived reasons and never request or reveal private user context, memory text, credentials, or connection payloads.";
        match super::call_side_model(
            self.state,
            &model.0,
            &model.1,
            system,
            &recommendation_prompt(references, signals),
        )
        .await
        {
            Ok(raw) => parse_model_rows(&raw, references, generated_at),
            Err(error) => {
                tracing::warn!(error = %error, "marketplace recommendations model unavailable");
                Vec::new()
            }
        }
    }
}

async fn gateway_settings(state: &ServerState) -> Option<(bool, Cadence)> {
    match crate::sidecar::gateway::fetch_config(&state.client).await {
        Ok(config) => Some(gateway_policy(&config)),
        Err(error) => {
            tracing::debug!(error = %error, "marketplace recommendations gateway policy unavailable");
            None
        }
    }
}

async fn hidden_for(state: &ServerState, scope: &str) -> bool {
    state
        .preferences
        .get(&preference_key(scope))
        .await
        .ok()
        .flatten()
        .is_some_and(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"))
}

async fn load(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    force: bool,
) -> RecommendationResponse {
    let Some((enabled, cadence)) = gateway_settings(state).await else {
        return empty_response(false, false, Cadence::Weekly);
    };
    let scope = user_scope(caller);
    let hidden = hidden_for(state, &scope).await;
    if !enabled || hidden {
        return empty_response(enabled, hidden, cadence);
    }

    let references = catalog_references(state).await;
    if references.is_empty() {
        return empty_response(enabled, hidden, cadence);
    }
    let revision = catalog_revision(&references);
    let signals = safe_profile_signals(state, caller).await;
    let profile_revision = digest(&signals.join(","));
    let gateway = crate::sidecar::gateway::gateway_url();
    let settings = settings_revision(state, cadence).await;
    let key = format!(
        "{}:{}:{}:{}:{}",
        gateway, scope, revision, profile_revision, settings
    );
    let now = std::time::Instant::now();
    let mut cache_guard = cache().lock().await;
    if force {
        cache_guard.remove(&key);
    } else if let Some(value) = cache_guard.get(&key) {
        if now.duration_since(value.created_at) < cadence.ttl() {
            return RecommendationResponse {
                enabled,
                hidden,
                cadence: cadence.as_str(),
                cached: true,
                generated_at: Some(value.generated_at.clone()),
                items: value.items.clone(),
            };
        }
    }
    drop(cache_guard);

    let generated_at = Utc::now().to_rfc3339();
    let adapter = RecommendationModelAdapter { state };
    let mut items = adapter.generate(&references, &signals, &generated_at).await;
    if items.is_empty() {
        items = references
            .iter()
            .take(MAX_RECOMMENDATIONS)
            .map(|value| RecommendationRow {
                id: value.id.clone(),
                kind: value.kind.clone(),
                name: value.name.clone(),
                description: value.description.clone(),
                icon_url: value.icon_url.clone(),
                installed: value.installed,
                reason: "A match for your current catalog setup.".to_owned(),
                generated_at: generated_at.clone(),
                cache_scope: "node-user-catalog-settings",
            })
            .collect();
    }
    cache().lock().await.insert(
        key,
        CachedFeed {
            created_at: now,
            generated_at: generated_at.clone(),
            items: items.clone(),
        },
    );
    RecommendationResponse {
        enabled,
        hidden,
        cadence: cadence.as_str(),
        cached: false,
        generated_at: Some(generated_at),
        items,
    }
}

#[derive(Debug, Deserialize, Default)]
struct RefreshQuery {
    #[serde(default)]
    refresh: bool,
}

#[derive(Debug, Deserialize)]
struct PreferenceBody {
    hidden: bool,
}

pub async fn get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<RefreshQuery>,
) -> Json<RecommendationResponse> {
    Json(load(&state, &caller, query.refresh).await)
}

pub async fn refresh(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Json<RecommendationResponse> {
    Json(load(&state, &caller, true).await)
}

pub async fn set_preference(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PreferenceBody>,
) -> Response {
    let scope = user_scope(&caller);
    match state
        .preferences
        .set(
            &preference_key(&scope),
            if body.hidden { "true" } else { "false" },
        )
        .await
    {
        Ok(()) => {
            if body.hidden {
                cache().lock().await.retain(|key, _| !key.contains(&scope));
            }
            Json(json!({ "hidden": body.hidden })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/marketplace/recommendations",
            route_get(get).post(refresh),
        )
        .route(
            "/api/marketplace/recommendations/preference",
            route_put(set_preference),
        )
}

#[cfg(test)]
mod tests {
    use super::{
        catalog_revision, gateway_policy, parse_model_rows, recommendation_prompt, Cadence,
        CatalogReference,
    };
    use serde_json::json;

    #[test]
    fn cadence_is_closed_and_defaults_weekly() {
        assert_eq!(Cadence::parse(None).as_str(), "weekly");
        assert_eq!(Cadence::parse(Some("daily")).as_str(), "daily");
        assert_eq!(Cadence::parse(Some("monthly")).as_str(), "monthly");
        assert_eq!(Cadence::parse(Some("hourly")).as_str(), "weekly");
    }

    #[test]
    fn model_rows_intersect_catalog_and_drop_private_fields() {
        let refs = vec![CatalogReference {
            id: "owner/tool".to_owned(),
            kind: "mcp".to_owned(),
            name: "Tool".to_owned(),
            description: Some("Safe description".to_owned()),
            icon_url: None,
            installed: false,
        }];
        let rows = parse_model_rows(
            &json!({
                "recommendations": [{
                    "kind": "mcp",
                    "id": "owner/tool",
                    "reason": "Useful"
                }, {
                    "kind": "mcp",
                    "id": "not-in-catalog",
                    "reason": "Ignore"
                }]
            })
            .to_string(),
            &refs,
            "2026-08-19T00:00:00Z",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "owner/tool");
        assert_eq!(rows[0].cache_scope, "node-user-catalog-settings");
        assert!(!serde_json::to_string(&rows).unwrap().contains("credential"));
    }

    #[test]
    fn policy_defaults_enabled_weekly_and_reads_gateway_shape() {
        assert_eq!(gateway_policy(&json!({})), (true, Cadence::Weekly));
        assert_eq!(
            gateway_policy(&json!({
                "marketplace_recommendations": {"enabled": false, "cadence": "daily"}
            })),
            (false, Cadence::Daily)
        );
    }

    #[test]
    fn catalog_revision_changes_with_catalog_or_install_state() {
        let base = vec![CatalogReference {
            id: "a".to_owned(),
            kind: "skill".to_owned(),
            name: "A".to_owned(),
            description: None,
            icon_url: None,
            installed: false,
        }];
        let mut changed = base.clone();
        changed[0].installed = true;
        assert_ne!(catalog_revision(&base), catalog_revision(&changed));
    }

    #[test]
    fn recommendation_prompt_only_accepts_category_signals() {
        let prompt = recommendation_prompt(
            &[],
            &[
                "memory_category:preference".to_owned(),
                "connection:oauth".to_owned(),
            ],
        );
        assert!(prompt.contains("memory_category:preference"));
        assert!(prompt.contains("connection:oauth"));
        assert!(!prompt.contains("raw-memory-content"));
        assert!(!prompt.contains("github-token"));
    }
}
