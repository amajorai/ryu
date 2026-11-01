//! Starting a provider CLI's sign-in and clearing its usage-limit cooldown.

use super::super::cli;
use super::super::{accounts, runner, store, CloudTaskBackend, Provider};
use super::settings::owner_with_plans;
use super::{api_error, respond, ApiError};
use crate::server::ResolvedAuthorization;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn subscription_backend(raw: &str) -> Result<(CloudTaskBackend, Provider), ApiError> {
    CloudTaskBackend::parse(raw)
        .and_then(|backend| backend.provider().map(|provider| (backend, provider)))
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "subscription_backend_not_found",
                "Unknown subscription backend.",
            )
        })
}

/// One CLI sign-in per account per minute, so repeated clicks do not pile up login
/// processes on the node.
pub(in crate::server::subscription_cloud) fn sign_in_slot_free(key: &str) -> bool {
    static LAST: std::sync::LazyLock<std::sync::Mutex<BTreeMap<String, std::time::Instant>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = std::time::Instant::now();
    last.retain(|_, started| now.duration_since(*started) < std::time::Duration::from_secs(60));
    if last.contains_key(key) {
        return false;
    }
    last.insert(key.to_owned(), now);
    true
}

#[utoipa::path(post,path="/api/cloud-task-backends/{backend}/sign-in",operation_id="sign_in_cloud_task_backend",tag="Cloud environments",security(("bearerAuth"=[])),params(("backend"=String,Path,description="anthropic-subscription-cli or openai-subscription-cli")),description="Start the provider CLI's own sign-in (`claude auth login` or `codex login`) on this node. The CLI opens the provider's sign-in page in the browser; Ryu captures none of its input or output and never receives the credential. Poll `GET /api/cloud-task-backends` for the result. Node owner only.",responses((status=202,description="The CLI's sign-in started"),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable"),(status=404,description="subscription_backend_not_found"),(status=503,description="subscription_cli_missing: the CLI is not installed")))]
pub(crate) async fn sign_in_backend(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(raw): Path<String>,
) -> Response {
    let started: Result<Value, ApiError> = async {
        owner_with_plans(&auth).await?;
        let (backend, provider) = subscription_backend(&raw)?;
        if !sign_in_slot_free(&accounts::account_key(provider, accounts::DEFAULT_ACCOUNT)) {
            return Err(api_error(
                StatusCode::TOO_MANY_REQUESTS,
                "subscription_sign_in_pending",
                "A sign-in for this CLI just started. Finish it in your browser, or wait a minute and try again.",
            ));
        }
        runner()
            .spawn_detached(cli::sign_in_invocation(provider))
            .map_err(|_| {
                api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "subscription_cli_missing",
                    &format!("{} is not installed on this node.", backend.cli_name()),
                )
            })?;
        Ok(json!({"backend":backend,"started":true}))
    }
    .await;
    match started {
        Ok(body) => (StatusCode::ACCEPTED, Json(body)).into_response(),
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(delete,path="/api/cloud-task-backends/{backend}/cooldown",operation_id="clear_cloud_task_backend_cooldown",tag="Cloud environments",security(("bearerAuth"=[])),params(("backend"=String,Path,description="anthropic-subscription-cli or openai-subscription-cli")),description="Clear the usage-limit cooldown of this node's default sign-in for the backend's provider, so the next task tries it again. Linked accounts clear theirs at `DELETE /api/cloud-task-backends/accounts/{provider}/{id}/cooldown`. Node owner only.",responses((status=200,body=Value),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable"),(status=404,description="subscription_backend_not_found")))]
pub(crate) async fn clear_cooldown(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(raw): Path<String>,
) -> Response {
    respond(
        async {
            owner_with_plans(&auth).await?;
            let (backend, provider) = subscription_backend(&raw)?;
            store::clear_cooldown(&accounts::account_key(provider, accounts::DEFAULT_ACCOUNT));
            Ok(json!({"backend":backend,"cooldown":null}))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plan_backends_have_a_sign_in() {
        let (backend, provider) =
            subscription_backend("anthropic-subscription-cli").expect("plan backend");
        assert_eq!(backend, CloudTaskBackend::AnthropicSubscriptionCli);
        assert_eq!(provider, Provider::Anthropic);
        for raw in ["ryu-box", "not-a-backend", ""] {
            let error = subscription_backend(raw).expect_err(raw);
            assert_eq!(error.0, StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn a_sign_in_slot_is_taken_for_a_minute_per_account() {
        let key = format!("sign-in-slot-test-{}", std::process::id());
        assert!(sign_in_slot_free(&key));
        assert!(!sign_in_slot_free(&key));
        assert!(sign_in_slot_free(&format!("{key}-other")));
    }
}
