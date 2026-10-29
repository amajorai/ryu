//! HTTP API for per-agent subscription usage (`GET /api/agents/:id/usage`): the
//! "usage bar" feature. Given the agent active in chat, return that agent's
//! rolling rate-limit windows (5h session + weekly) read from the CLI's own
//! local OAuth token, à la CodexBar / openusage.
//!
//! Always 200: refusals (unsupported agent, not logged in, token expired, rate
//! limited) carry `available=false` + a `reason` rather than an HTTP error, so
//! the desktop's dumb bar never branches on status codes — it just hides on
//! `unsupported` and shows a hint otherwise. All the provider logic + the
//! never-refresh token safety lives in the extracted [`ryu_usage`] crate; this
//! handler is the kernel-side route ingress that delegates to it. Ryu-managed
//! subscription providers use the same route, with their isolated Pi OAuth
//! credential selected by the provider's login mapping.

use std::collections::BTreeMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

/// `GET /api/agents/:id/usage` — normalized usage snapshot for one agent.
///
/// The `{id}` may be an ACP id containing a colon (`acp:claude`); clients must
/// percent-encode it (`encodeURIComponent`), which axum decodes into the single
/// `:id` segment.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/usage",
    tag = "Agents",
    summary = "Per-agent subscription usage (5h + weekly windows)",
    params(("id" = String, Path, description = "Agent id (percent-encode `acp:` ids)")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn agent_usage(Path(id): Path<String>) -> impl IntoResponse {
    Json(crate::subscriptions::reading::agent_reading(&id).await)
}

/// `GET /api/pi-config/providers/:id/accounts/:account_id/usage` — normalized
/// usage for one saved Ryu subscription account. The account credential is
/// resolved inside Core's sealed vault and is never returned to the client.
#[utoipa::path(
    get,
    path = "/api/pi-config/providers/{id}/accounts/{account_id}/usage",
    tag = "Agents",
    summary = "Per-account subscription usage",
    description = "Reads one saved subscription credential inside Core's sealed vault and returns normalized provider usage meters without exposing the credential.",
    params(
        ("id" = String, Path, description = "Ryu provider id"),
        ("account_id" = String, Path, description = "Saved account id")
    ),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 404, description = "Not a provider with saved, readable accounts")
    )
)]
pub async fn provider_account_usage(
    Path((provider_id, account_id)): Path<(String, String)>,
) -> Response {
    use crate::subscriptions::ProviderKind;
    if !matches!(
        crate::subscriptions::provider_kind(&provider_id),
        Some(ProviderKind::Subscription | ProviderKind::ApiCredits)
    ) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not a subscription or API-credit provider",
            })),
        )
            .into_response();
    }
    Json(crate::subscriptions::reading::read_raw(&provider_id, &account_id).await).into_response()
}

/// The OAuth pool warmer's account read. The implementation, including the
/// credential-revision guard, lives in [`crate::subscriptions::reading::read_raw`].
pub(super) async fn read_provider_account_usage(
    provider_id: &str,
    account_id: &str,
) -> ryu_usage::UsageSnapshot {
    crate::subscriptions::reading::read_raw(provider_id, account_id).await
}

/// Query for `GET /api/usage/subscriptions`.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SubscriptionsQuery {
    /// Only this provider id.
    pub provider: Option<String>,
    /// `none` | `cached` (default) | `refresh` | `force`.
    pub usage: Option<String>,
}

/// Query for `GET /api/usage/subscriptions/{provider_id}/reading`.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ReadingQuery {
    /// Saved account id. Omitted reads the provider's active account.
    pub account: Option<String>,
    /// `0` (default) serves a fresh cached reading or reads once; `1` or
    /// `force` always reads the vendor.
    pub refresh: Option<String>,
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= crate::subscriptions::MAX_ID_CHARS
}

/// `GET /api/usage/subscriptions` — every subscription provider this node knows,
/// its saved accounts (with their display names) and each account's usage.
/// Owner-only: account names are often email addresses.
#[utoipa::path(
    get,
    path = "/api/usage/subscriptions",
    tag = "Agents",
    summary = "Subscription providers, saved accounts and usage",
    description = "Lists subscription providers with their saved accounts, pool policy, capabilities and per-account usage readings. `usage=cached` never waits on a vendor: accounts without a cached reading report `pending` and are read in the background. Credentials never leave Core.",
    params(SubscriptionsQuery),
    responses(
        (status = 200, description = "Subscriptions snapshot", body = serde_json::Value),
        (status = 400, description = "Invalid provider id or usage mode")
    )
)]
pub async fn subscriptions(Query(query): Query<SubscriptionsQuery>) -> Response {
    let usage = match query.usage.as_deref() {
        None => crate::subscriptions::UsageMode::Cached,
        Some(value) => match crate::subscriptions::UsageMode::parse(value) {
            Some(mode) => mode,
            None => return bad_request("usage must be none, cached, refresh or force"),
        },
    };
    if query.provider.as_deref().is_some_and(|id| !valid_id(id)) {
        return bad_request("provider must be 1 to 256 characters");
    }
    let snapshot = crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
        provider_id: query.provider,
        usage,
        include_labels: true,
        max_age: crate::subscriptions::DEFAULT_MAX_AGE,
        only_account: None,
    })
    .await;
    Json(snapshot).into_response()
}

/// `GET /api/usage/subscriptions/{provider_id}/reading` — one account's usage
/// reading. Without `account`, reads the active account and echoes its id.
#[utoipa::path(
    get,
    path = "/api/usage/subscriptions/{provider_id}/reading",
    tag = "Agents",
    summary = "Usage reading for one subscription account",
    description = "Returns one canonical usage reading. An account id that is not saved for this provider reads `account_not_found`; it never falls back to the active account.",
    params(
        ("provider_id" = String, Path, description = "Provider id (percent-encode `acp:` ids)"),
        ReadingQuery
    ),
    responses(
        (status = 200, description = "Usage reading", body = serde_json::Value),
        (status = 400, description = "Invalid id or refresh value"),
        (status = 404, description = "Unknown provider")
    )
)]
pub async fn subscription_reading(
    Path(provider_id): Path<String>,
    Query(query): Query<ReadingQuery>,
) -> Response {
    if !valid_id(&provider_id) {
        return bad_request("provider id must be 1 to 256 characters");
    }
    if query.account.as_deref().is_some_and(|id| !valid_id(id)) {
        return bad_request("account must be 1 to 256 characters");
    }
    let mode = match query.refresh.as_deref() {
        None | Some("0") => crate::subscriptions::UsageMode::Refresh,
        Some("1" | "force") => crate::subscriptions::UsageMode::Force,
        Some(_) => return bad_request("refresh must be 0, 1 or force"),
    };
    if crate::subscriptions::provider_capabilities(&provider_id).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown subscription provider" })),
        )
            .into_response();
    }
    let account = query
        .account
        .as_deref()
        .map_or(crate::subscriptions::AccountSel::Active, |id| {
            crate::subscriptions::AccountSel::Exact(id)
        });
    let reading = crate::subscriptions::reading::read_with(
        &provider_id,
        account,
        crate::subscriptions::reading::ReadOptions {
            mode,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            model: None,
            include_label: true,
        },
    )
    .await;
    Json(reading).into_response()
}

/// Where [`ConversationProviderAccount::account_id`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAccountSource {
    /// The conversation's sealed SDK account affinity.
    Affinity,
    /// The Claude subscription proxy's live session binding.
    ProxyBinding,
    /// No per-conversation binding exists; this is the provider's active
    /// account, which the next turn would normally start on.
    Active,
    /// Nothing is known.
    Unknown,
}

/// The subscription provider and saved account a conversation runs on, as far
/// as Core can tell without creating or refreshing any binding. Carries ids
/// only, never an account label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationProviderAccount {
    pub provider_id: Option<String>,
    pub account_id: Option<String>,
    pub source: ProviderAccountSource,
}

impl ConversationProviderAccount {
    fn unknown() -> Self {
        Self {
            provider_id: None,
            account_id: None,
            source: ProviderAccountSource::Unknown,
        }
    }
}

/// The conversation's subscription provider: the provider of its latest
/// model selection, else its agent when that agent id is itself a Ryu
/// subscription provider. `None` for everything else (ACP CLI logins, BYOK
/// providers, the gateway) — a guess here would mislabel the stats strip.
fn conversation_provider(
    selected_provider: Option<&str>,
    agent_id: Option<&str>,
    is_subscription: impl Fn(&str) -> bool,
) -> Option<String> {
    // The latest model selection decides; the agent id is only a fallback for
    // a conversation that never selected a model. A selection on another
    // provider must not be reported as the agent's subscription.
    selected_provider
        .filter(|id| !id.is_empty())
        .or(agent_id)
        .filter(|id| is_subscription(id))
        .map(str::to_owned)
}

/// Combine a binding peek with the provider's active account.
fn resolve_provider_account(
    provider_id: String,
    peeked: Option<String>,
    active: Option<String>,
) -> ConversationProviderAccount {
    if let Some(account_id) = peeked {
        let source = if provider_id == "claude-pro-max" {
            ProviderAccountSource::ProxyBinding
        } else {
            ProviderAccountSource::Affinity
        };
        return ConversationProviderAccount {
            provider_id: Some(provider_id),
            account_id: Some(account_id),
            source,
        };
    }
    let source = if active.is_some() {
        ProviderAccountSource::Active
    } else {
        ProviderAccountSource::Unknown
    };
    ConversationProviderAccount {
        provider_id: Some(provider_id),
        account_id: active,
        source,
    }
}

/// `GET /api/conversations/:id/provider-account` — which subscription provider
/// and saved account a conversation is running on. Read-only: it peeks the
/// existing affinity or proxy binding and never creates, refreshes or selects
/// one. Gated by the conversation's read ACL; returns ids only.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/provider-account",
    tag = "Conversations",
    summary = "Subscription provider and account a conversation runs on",
    description = "Reports the subscription provider and saved account id a conversation is bound to, and where that answer came from (`affinity`, `proxy_binding`, `active` or `unknown`). Never creates or refreshes a binding and never returns account names.",
    params(("id" = String, Path, description = "Conversation id")),
    responses(
        (status = 200, description = "Provider and account ids", body = ConversationProviderAccount),
        (status = 404, description = "Conversation not found")
    )
)]
pub async fn conversation_provider_account(
    State(state): State<super::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = super::require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return response;
    }
    let agent_id = match state.conversations.get_summary(&id).await {
        Ok(summary) => summary.and_then(|summary| summary.agent_id),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    let selected_provider = match state.conversations.list_model_changes(&id).await {
        Ok(changes) => changes.last().and_then(|change| change.provider_id.clone()),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    let Some(provider_id) = conversation_provider(
        selected_provider.as_deref(),
        agent_id.as_deref(),
        |provider_id| {
            crate::subscriptions::provider_kind(provider_id)
                == Some(crate::subscriptions::ProviderKind::Subscription)
        },
    ) else {
        return Json(ConversationProviderAccount::unknown()).into_response();
    };
    let agent_id = agent_id.unwrap_or_else(|| crate::registry::DEFAULT_AGENT_ID.to_owned());
    // Vault reads are synchronous; keep them off the async workers.
    let resolved = tokio::task::spawn_blocking(move || {
        let peeked =
            crate::subscriptions::reading::peek_account(&provider_id, Some(&id), &agent_id);
        let active = crate::pi_config::list_provider_accounts(&provider_id)
            .into_iter()
            .find(|info| info.active)
            .map(|info| info.account_id);
        resolve_provider_account(provider_id, peeked, active)
    })
    .await;
    match resolved {
        Ok(resolved) => Json(resolved).into_response(),
        Err(error) => {
            tracing::warn!(%error, "conversation provider-account lookup failed");
            Json(ConversationProviderAccount::unknown()).into_response()
        }
    }
}

#[cfg(test)]
mod conversation_provider_account_tests {
    use super::*;

    fn is_subscription(id: &str) -> bool {
        matches!(id, "claude-pro-max" | "github-copilot")
    }

    #[test]
    fn provider_comes_from_the_selection_else_the_agent_and_never_guesses() {
        assert_eq!(
            conversation_provider(
                Some("github-copilot"),
                Some("claude-pro-max"),
                is_subscription
            ),
            Some("github-copilot".to_owned())
        );
        // A selection on another provider is not reported as the agent's.
        assert_eq!(
            conversation_provider(Some("openrouter"), Some("claude-pro-max"), is_subscription),
            None
        );
        assert_eq!(
            conversation_provider(None, Some("claude-pro-max"), is_subscription),
            Some("claude-pro-max".to_owned())
        );
        assert_eq!(
            conversation_provider(Some(""), Some("claude-pro-max"), is_subscription),
            Some("claude-pro-max".to_owned())
        );
        assert_eq!(
            conversation_provider(None, Some("acp:claude"), is_subscription),
            None
        );
        assert_eq!(conversation_provider(None, None, is_subscription), None);
    }

    #[test]
    fn binding_sources_are_reported_and_active_is_the_fallback() {
        assert_eq!(
            resolve_provider_account(
                "claude-pro-max".to_owned(),
                Some("acct_bound".to_owned()),
                Some("acct_active".to_owned()),
            ),
            ConversationProviderAccount {
                provider_id: Some("claude-pro-max".to_owned()),
                account_id: Some("acct_bound".to_owned()),
                source: ProviderAccountSource::ProxyBinding,
            }
        );
        assert_eq!(
            resolve_provider_account(
                "github-copilot".to_owned(),
                Some("acct_pinned".to_owned()),
                None,
            )
            .source,
            ProviderAccountSource::Affinity
        );
        let active = resolve_provider_account(
            "github-copilot".to_owned(),
            None,
            Some("acct_active".to_owned()),
        );
        assert_eq!(active.source, ProviderAccountSource::Active);
        assert_eq!(active.account_id.as_deref(), Some("acct_active"));
        let unknown = resolve_provider_account("github-copilot".to_owned(), None, None);
        assert_eq!(unknown.source, ProviderAccountSource::Unknown);
        assert_eq!(unknown.provider_id.as_deref(), Some("github-copilot"));
    }

    #[test]
    fn the_wire_shape_is_camel_case_ids_without_labels() {
        let value = serde_json::to_value(ConversationProviderAccount {
            provider_id: Some("claude-pro-max".to_owned()),
            account_id: Some("acct_1".to_owned()),
            source: ProviderAccountSource::ProxyBinding,
        })
        .expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "providerId": "claude-pro-max",
                "accountId": "acct_1",
                "source": "proxy_binding",
            })
        );
        assert_eq!(
            serde_json::to_value(ConversationProviderAccount::unknown()).expect("serialize"),
            serde_json::json!({ "providerId": null, "accountId": null, "source": "unknown" })
        );
    }
}

/// `GET /api/providers/:id/credits` — remaining prepaid API credit on the BYOK
/// key stored for one provider.
///
/// Same always-200 contract as [`agent_usage`]. This handler owns the credential
/// lookup because keys live in Core's `models.json` / `auth.json` — a kernel
/// concept — and hands the key to the reader as an argument, so `ryu-usage` keeps
/// its zero dependency on `apps/core` without gaining a credential seam. The key
/// is never logged and never reaches the response body.
///
/// A provider with no readable balance (OpenAI, Anthropic and most others expose
/// none to an inference key) answers `unsupported`; one with no stored key
/// answers `not_logged_in`. Both make the desktop hide the row rather than
/// display a misleading `$0.00`.
#[utoipa::path(
    get,
    path = "/api/providers/{id}/credits",
    tag = "Agents",
    summary = "Remaining prepaid API credit for a BYOK provider",
    params(("id" = String, Path, description = "Provider id (openrouter / deepseek / moonshot)")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn provider_credits(Path(id): Path<String>) -> impl IntoResponse {
    // Resolve the key only for a provider that actually has an endpoint to call:
    // reading a credential we have no use for is a needless secret access.
    if !ryu_usage::supports_provider_credits(&id) {
        return Json(ryu_usage::fetch_provider_credits(&id, "").await);
    }
    let key = crate::pi_config::provider_api_key(&id).unwrap_or_default();
    Json(ryu_usage::fetch_provider_credits(&id, &key).await)
}

/// `GET /api/usage/subscription-costs` — the opt-in current-month API-list-price
/// equivalent for token usage that Core observed on managed Pi OAuth accounts.
/// It is deliberately separate from provider-reported limits and Ryu-billed spend.
#[utoipa::path(
    get,
    path = "/api/usage/subscription-costs",
    tag = "Agents",
    summary = "Managed Pi OAuth API-equivalent usage for the current month",
    description = "Returns local token usage grouped by provider and saved OAuth account, priced from models.dev when available. This is an estimate, not provider-reported billing.",
    responses(
        (status = 200, description = "Current UTC month", body = SubscriptionCostUsageSummary),
        (status = 503, description = "Local subscription cost store unavailable")
    )
)]
pub async fn subscription_cost_usage(State(state): State<super::ServerState>) -> Response {
    let Some(cost_store) = state.subscription_costs.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "subscription cost tracking unavailable"})),
        )
            .into_response();
    };
    let enabled = match cost_store.is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let now = Utc::now();
    let rows = match cost_store.current_month_by_model(now) {
        Ok(rows) => rows,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };

    let mut accounts: BTreeMap<(String, String), AccountCostAccumulator> = BTreeMap::new();
    for row in rows {
        let pricing_provider = crate::pi_config::oauth_login::oauth_provider_id(&row.provider_id);
        let pricing = match (row.model_id.as_deref(), pricing_provider) {
            (Some(model_id), Some(provider_id)) => {
                ryu_model_catalog::models_dev::meta_for(model_id, Some(provider_id)).await
            }
            _ => None,
        };
        let input_price = pricing
            .as_ref()
            .filter(|meta| meta.source == "models.dev")
            .and_then(|meta| meta.cost_input_per_1m)
            .filter(|price| price.is_finite() && *price >= 0.0);
        let output_price = pricing
            .as_ref()
            .filter(|meta| meta.source == "models.dev")
            .and_then(|meta| meta.cost_output_per_1m)
            .filter(|price| price.is_finite() && *price >= 0.0);
        let estimate = super::subscription_costs::estimate_model_cost(
            row.input_tokens,
            row.output_tokens,
            super::subscription_costs::ModelPricing {
                input_usd_per_million: input_price,
                output_usd_per_million: output_price,
            },
        );
        let price_source =
            (input_price.is_some() || output_price.is_some()).then(|| "models.dev".to_owned());
        let model = SubscriptionCostModelSummary {
            model_id: row.model_id.unwrap_or_else(|| "Unknown model".to_owned()),
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            estimated_cost_micro_usd: estimate.cost_micro_usd,
            unpriced_input_tokens: estimate.unpriced_input_tokens,
            unpriced_output_tokens: estimate.unpriced_output_tokens,
            missing_input_turns: row.missing_input_turns,
            missing_output_turns: row.missing_output_turns,
            turns: row.turns,
            price_source,
        };
        let account = accounts
            .entry((row.provider_id, row.account_id))
            .or_default();
        account.input_tokens = account.input_tokens.saturating_add(model.input_tokens);
        account.output_tokens = account.output_tokens.saturating_add(model.output_tokens);
        account.unpriced_input_tokens = account
            .unpriced_input_tokens
            .saturating_add(model.unpriced_input_tokens);
        account.unpriced_output_tokens = account
            .unpriced_output_tokens
            .saturating_add(model.unpriced_output_tokens);
        account.missing_input_turns = account
            .missing_input_turns
            .saturating_add(model.missing_input_turns);
        account.missing_output_turns = account
            .missing_output_turns
            .saturating_add(model.missing_output_turns);
        account.turns = account.turns.saturating_add(model.turns);
        add_cost(
            &mut account.estimated_cost_micro_usd,
            &mut account.cost_overflowed,
            model.estimated_cost_micro_usd,
        );
        account.models.push(model);
    }

    let response = SubscriptionCostUsageSummary {
        enabled,
        month: super::subscription_costs::current_month_label(now),
        accounts: accounts
            .into_iter()
            .map(
                |((provider_id, account_id), account)| SubscriptionCostAccountSummary {
                    provider_id,
                    account_id,
                    estimated_cost_micro_usd: account.estimated_cost_micro_usd,
                    input_tokens: account.input_tokens,
                    output_tokens: account.output_tokens,
                    unpriced_input_tokens: account.unpriced_input_tokens,
                    unpriced_output_tokens: account.unpriced_output_tokens,
                    missing_input_turns: account.missing_input_turns,
                    missing_output_turns: account.missing_output_turns,
                    turns: account.turns,
                    models: account.models,
                },
            )
            .collect(),
    };
    Json(response).into_response()
}

/// `PUT /api/usage/subscription-costs/settings` — opt in or out of future local
/// token-count recording. Turning tracking off retains this month's estimates.
#[utoipa::path(
    put,
    path = "/api/usage/subscription-costs/settings",
    tag = "Agents",
    summary = "Enable or disable local API-equivalent usage tracking",
    request_body = SubscriptionCostTrackingInput,
    responses(
        (status = 200, description = "Tracking setting saved", body = SubscriptionCostTrackingState),
        (status = 503, description = "Local subscription cost store unavailable")
    )
)]
pub async fn set_subscription_cost_tracking(
    State(state): State<super::ServerState>,
    Json(input): Json<SubscriptionCostTrackingInput>,
) -> Response {
    let Some(cost_store) = state.subscription_costs.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "subscription cost tracking unavailable"})),
        )
            .into_response();
    };
    match cost_store.set_enabled(input.enabled) {
        Ok(()) => Json(SubscriptionCostTrackingState {
            enabled: input.enabled,
        })
        .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionCostTrackingInput {
    pub enabled: bool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCostTrackingState {
    pub enabled: bool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCostUsageSummary {
    pub enabled: bool,
    pub month: String,
    pub accounts: Vec<SubscriptionCostAccountSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCostAccountSummary {
    pub provider_id: String,
    pub account_id: String,
    pub estimated_cost_micro_usd: Option<u64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub unpriced_input_tokens: u64,
    pub unpriced_output_tokens: u64,
    pub missing_input_turns: u64,
    pub missing_output_turns: u64,
    pub turns: u64,
    pub models: Vec<SubscriptionCostModelSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCostModelSummary {
    pub model_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_micro_usd: Option<u64>,
    pub unpriced_input_tokens: u64,
    pub unpriced_output_tokens: u64,
    pub missing_input_turns: u64,
    pub missing_output_turns: u64,
    pub turns: u64,
    pub price_source: Option<String>,
}

#[derive(Default)]
struct AccountCostAccumulator {
    estimated_cost_micro_usd: Option<u64>,
    cost_overflowed: bool,
    input_tokens: u64,
    output_tokens: u64,
    unpriced_input_tokens: u64,
    unpriced_output_tokens: u64,
    missing_input_turns: u64,
    missing_output_turns: u64,
    turns: u64,
    models: Vec<SubscriptionCostModelSummary>,
}

fn add_cost(total: &mut Option<u64>, overflowed: &mut bool, value: Option<u64>) {
    if *overflowed {
        return;
    }
    let Some(value) = value else {
        return;
    };
    if let Some(current) = *total {
        match current.checked_add(value) {
            Some(sum) => *total = Some(sum),
            None => {
                *total = None;
                *overflowed = true;
            }
        }
    } else {
        *total = Some(value);
    }
}

#[cfg(test)]
mod cost_accumulator_tests {
    use super::add_cost;

    #[test]
    fn account_cost_overflow_stays_unknown_after_later_rows() {
        let mut total = Some(u64::MAX);
        let mut overflowed = false;

        add_cost(&mut total, &mut overflowed, Some(1));
        assert_eq!(total, None);
        assert!(overflowed);
        add_cost(&mut total, &mut overflowed, Some(10));
        assert_eq!(total, None);
    }
}
