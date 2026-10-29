//! HTTP surface for the threshold fallback rules (`crate::routing_policy`):
//! the rule list a settings screen edits, and the per-turn verdict the composer's
//! info bar renders.
//!
//! `GET /api/routing/advice` is what makes the feature visible instead of
//! spooky. It answers the question the user asks by sending a message — "given
//! what's left, what will actually run?" — *before* they send it, using the same
//! evaluator and the same cached signals the turn itself will use, so the bar
//! cannot disagree with what happens. It is a pure read: no rule is applied, no
//! turn is dispatched, and calling it never changes what a later turn does.
//!
//! Clients are expected to call it once per turn. That is affordable because
//! signal reads are cached with per-source TTLs (see
//! `crate::routing_policy::signals`), so "check the balance every message" costs
//! a preference read and some arithmetic, not three vendor round-trips.

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::routing_policy::{self, RoutingPolicy, Target, ROUTING_POLICY_PREF};
use crate::server::ServerState;

/// Query for [`advice`]: the agent/model the composer currently has selected.
#[derive(Debug, Deserialize)]
pub struct AdviceQuery {
    /// Agent id the turn would run on (`acp:claude`, `ryu`, …).
    #[serde(default)]
    pub agent_id: String,
    /// Model the composer has pinned, if any. Empty means "the agent's own
    /// binding decides", which a rule can still replace.
    #[serde(default)]
    pub model: String,
    /// Whether the composer is about to OPEN a conversation rather than continue
    /// one. Clients send `true` on an empty thread (the launchpad, a fresh chat).
    ///
    /// It matters because a rule that swaps the *agent* only applies at a
    /// conversation start — an ACP agent owns its session state. Passing it here
    /// is what keeps the info bar's prediction identical to what the turn will
    /// actually do; defaulting to `false` is the conservative read (the bar says
    /// "new conversations will start on X" rather than promising a switch).
    #[serde(default)]
    pub at_conversation_start: bool,
}

/// `GET /api/routing/advice?agent_id=&model=` — what the next turn would do.
///
/// Always 200. A node with no rules answers `severity: "continue"` with
/// `effective == original`, which the info bar renders as nothing at all.
#[utoipa::path(
    get,
    path = "/api/routing/advice",
    tag = "Routing",
    summary = "Fallback verdict for the turn about to be sent",
    params(
        ("agent_id" = String, Query, description = "Agent the turn would run on"),
        ("model" = Option<String>, Query, description = "Model the composer has pinned"),
        ("at_conversation_start" = Option<bool>, Query, description = "True when the composer would open a new conversation")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn advice(
    State(state): State<ServerState>,
    Query(query): Query<AdviceQuery>,
) -> impl IntoResponse {
    let target = Target {
        agent_id: query.agent_id,
        model: query.model,
        at_conversation_start: query.at_conversation_start,
    };
    Json(routing_policy::advice_for_turn(&state.preferences, &target).await)
}

/// `GET /api/routing/policy` — the node's rule list, plus what a rule may name.
///
/// The `credit_providers` list rides along because a settings form has to OFFER
/// the providers whose balance can actually be read. Only a handful of vendors
/// expose one to the inference key you already hold; a rule naming any other
/// provider would evaluate to "unknown" forever and look broken. Serving the list
/// from the same place that implements the readers means the form cannot drift
/// out of sync with them.
#[utoipa::path(
    get,
    path = "/api/routing/policy",
    tag = "Routing",
    summary = "The node's threshold fallback rules",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_policy(State(state): State<ServerState>) -> impl IntoResponse {
    let policy = routing_policy::load(&state.preferences).await;
    Json(serde_json::json!({
        "rules": policy.rules,
        "credit_providers": ryu_usage::PROVIDERS_WITH_CREDITS,
    }))
}

/// `PUT /api/routing/policy` — replace the node's rule list.
///
/// Writing drops the cached signal readings. Without that, a rule saved with a
/// fresh threshold would be judged against numbers fetched under the old
/// configuration — the user would change "$5" to "$50", send a message, and see
/// nothing happen for up to five minutes.
///
/// A provider-scoped subscription rule is validated before it is stored: it must
/// name a subscription provider, and an `account_id` must be one of that
/// provider's saved accounts. Such a rule would only abstain at evaluation, but
/// rejecting it here tells the user the rule can never fire.
#[utoipa::path(
    put,
    path = "/api/routing/policy",
    tag = "Routing",
    summary = "Replace the node's threshold fallback rules",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Saved", body = serde_json::Value),
        (status = 400, description = "A rule is invalid"),
        (status = 500, description = "Could not persist")
    )
)]
pub async fn put_policy(
    State(state): State<ServerState>,
    Json(policy): Json<RoutingPolicy>,
) -> impl IntoResponse {
    // Validation reads the saved-account vault, which is blocking I/O.
    let stored = routing_policy::load(&state.preferences).await;
    let candidate = policy.clone();
    match tokio::task::spawn_blocking(move || candidate.validate(&stored)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            );
        }
        Err(error) => {
            tracing::error!(error = %error, "routing policy validation task failed");
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not validate policy" })),
            );
        }
    }
    if let Err(e) = state
        .preferences
        .set(ROUTING_POLICY_PREF, &policy.to_pref_value())
        .await
    {
        tracing::error!(error = %e, "could not persist routing fallback policy");
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "could not persist policy" })),
        );
    }
    routing_policy::signals::invalidate_all();
    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "rules": policy.rules.len() })),
    )
}

/// `GET /api/routing/retry-policy` — the node's reactive failover config, plus
/// the agents a `candidates` list may name.
///
/// The candidate pool rides along for the same reason `credit_providers` does on
/// [`get_policy`]: a settings form must offer only agents whose windows can
/// actually be read, or a user would list one that can never be failed over to
/// and the feature would look broken. Serving it from `ryu_usage` means the form
/// cannot drift away from the readers that implement it.
#[utoipa::path(
    get,
    path = "/api/routing/retry-policy",
    tag = "Routing",
    summary = "The node's reactive failover config",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_retry_policy(State(state): State<ServerState>) -> impl IntoResponse {
    let policy = routing_policy::reactive::load(&state.preferences).await;
    Json(serde_json::json!({
        "policy": policy,
        "subscription_agents": ryu_usage::SUBSCRIPTION_AGENTS,
    }))
}

/// `PUT /api/routing/retry-policy` — replace the node's reactive failover config.
///
/// Unlike [`put_policy`] this does NOT invalidate the signal cache: the reactive
/// path deliberately reads windows uncached at the moment of failure (see
/// `routing_policy::reactive`), so there is no cached reading for a config change
/// to invalidate.
#[utoipa::path(
    put,
    path = "/api/routing/retry-policy",
    tag = "Routing",
    summary = "Replace the node's reactive failover config",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Saved", body = serde_json::Value),
        (status = 500, description = "Could not persist")
    )
)]
pub async fn put_retry_policy(
    State(state): State<ServerState>,
    Json(policy): Json<routing_policy::reactive::RetryPolicy>,
) -> impl IntoResponse {
    if let Err(e) = state
        .preferences
        .set(
            routing_policy::reactive::RETRY_POLICY_PREF,
            &policy.to_pref_value(),
        )
        .await
    {
        tracing::error!(error = %e, "could not persist reactive failover policy");
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "could not persist policy" })),
        );
    }
    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "enabled": policy.enabled })),
    )
}
