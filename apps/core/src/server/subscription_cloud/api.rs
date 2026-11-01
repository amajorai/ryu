//! Routes and the start-or-fall-back decision.
//!
//! Split by responsibility: backend features and the run view (`features`), account
//! choice and availability (`availability`), the routing decision (`start`), starting
//! a run (`launch`), follow-ups (`follow_up`), and the HTTP handlers (`settings`,
//! `sign_in`, `runs`). Every item keeps its `api::` path through the re-exports below.

mod availability;
mod features;
mod follow_up;
mod launch;
mod runs;
mod settings;
mod sign_in;
mod start;

pub(crate) use availability::account_label;
// Kept on their `api::` paths for callers outside this module.
pub(super) use availability::sign_in;
#[allow(unused_imports)]
pub(crate) use availability::{linked, AccountChoice};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use features::features;
pub(crate) use features::{run_view, Features, RunView};
pub(crate) use runs::{run_diff, run_status, stop_run};
pub(super) use settings::owner_with_plans;
pub(crate) use settings::{get_routing, list_backends, put_routing, BackendView, BackendsView};
pub(super) use sign_in::sign_in_slot_free;
pub(crate) use sign_in::{clear_cooldown, sign_in_backend};
pub(crate) use start::{may_try_plan, start_or_fall_back, RouteOutcome, RouteRequest};

use super::cli::SignIn;
use super::local_run;
use super::routing::Notice;
use super::store::{EnvironmentLink, RoutingSettings, RunRecord};
use super::CloudTaskBackend;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};

pub(crate) type ApiError = (StatusCode, Json<Value>);

pub(super) fn api_error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({"error":{"code":code,"message":message}})),
    )
}

fn owner_only() -> ApiError {
    api_error(
        StatusCode::FORBIDDEN,
        "subscription_backend_owner_only",
        "Only this node's owner can use the Claude or ChatGPT plan signed in on it.",
    )
}

pub(super) fn bad_request(message: &str) -> ApiError {
    api_error(StatusCode::BAD_REQUEST, "invalid_request", message)
}
// ── Routes ───────────────────────────────────────────────────────────────────

pub(crate) fn routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route("/api/cloud-task-backends", get(list_backends))
        .route(
            "/api/cloud-task-backends/routing",
            get(get_routing).put(put_routing),
        )
        .route(
            "/api/cloud-task-backends/:backend/sign-in",
            post(sign_in_backend),
        )
        .route(
            "/api/cloud-task-backends/:backend/cooldown",
            delete(clear_cooldown),
        )
        .merge(super::accounts_api::routes())
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run",
            get(run_status),
        )
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run/stop",
            post(stop_run),
        )
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run/diff",
            get(run_diff),
        )
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        settings::list_backends,
        settings::get_routing,
        settings::put_routing,
        sign_in::sign_in_backend,
        sign_in::clear_cooldown,
        runs::run_status,
        runs::stop_run,
        runs::run_diff
    ),
    components(schemas(
        BackendsView,
        BackendView,
        Features,
        RunView,
        RunRecord,
        RoutingSettings,
        EnvironmentLink,
        CloudTaskBackend,
        SignIn,
        Notice,
        local_run::LocalDiff
    ))
)]
struct SubscriptionCloudApiDoc;

pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    let mut doc = SubscriptionCloudApiDoc::openapi();
    doc.merge(super::accounts_api::AccountsApiDoc::openapi());
    doc
}

pub(super) fn respond<T: Serialize>(result: Result<T, ApiError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}
