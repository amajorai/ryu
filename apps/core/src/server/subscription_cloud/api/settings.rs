//! The backends list and the node owner's routing settings routes.

use super::super::accounts;
use super::super::cli::SignIn;
use super::super::store::{self, RoutingSettings};
use super::super::{
    caller_is_node_owner, plan_owner, rollout_allows, unix_now, CloudTaskBackend, Provider,
};
use super::availability::{checkout_is_usable, codex_environment_id_ok, linked, sign_in};
use super::features::{features, Features};
use super::{api_error, bad_request, owner_only, respond, ApiError};
use crate::server::cloud_environments as environments;
use crate::server::ResolvedAuthorization;
use axum::http::StatusCode;
use axum::response::Response;
use axum::Extension;
use serde::Serialize;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendView {
    backend: CloudTaskBackend,
    /// `ryu-credits` or `user-plan`.
    billing: &'static str,
    /// The CLI is on this node's PATH.
    installed: bool,
    sign_in: Option<SignIn>,
    cooldown_seconds_remaining: Option<u64>,
    features: Features,
    /// The command the owner can run on the node to sign in.
    sign_in_command: Option<&'static str>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendsView {
    /// Whether this caller may use the plans signed in on this node.
    owner: bool,
    rollout: bool,
    settings: Option<RoutingSettings>,
    backends: Vec<BackendView>,
}

async fn backend_view(backend: CloudTaskBackend, probe: bool, now: u64) -> BackendView {
    let provider = backend.provider();
    let (installed, sign_in_state) = match provider {
        Some(provider) if probe => {
            match sign_in(provider, super::super::accounts::DEFAULT_ACCOUNT).await {
                Some(state) => (true, Some(state)),
                None => (false, None),
            }
        }
        Some(_) => (false, None),
        None => (true, None),
    };
    BackendView {
        backend,
        billing: if provider.is_some() {
            "user-plan"
        } else {
            "ryu-credits"
        },
        installed,
        sign_in: sign_in_state,
        cooldown_seconds_remaining: provider.and_then(|provider| {
            store::cooldown_remaining(
                &accounts::account_key(provider, accounts::DEFAULT_ACCOUNT),
                now,
            )
        }),
        features: features(backend),
        sign_in_command: match provider {
            Some(Provider::Anthropic) => Some("claude auth login"),
            Some(Provider::Openai) => Some("codex login"),
            None => None,
        },
    }
}

#[utoipa::path(get,path="/api/cloud-task-backends",operation_id="list_cloud_task_backends",tag="Cloud environments",security(("bearerAuth"=[])),description="The backends a cloud task can run on: the Ryu Box (Ryu credits) and, for this node's owner, the Claude Code and Codex CLIs signed in on this node with the owner's own plan. Reports whether each CLI is installed and how it is signed in (read from the CLI's own status command; Ryu never holds the plan's credentials), any usage-limit cooldown, and which session features each backend supports. Other callers get the Ryu Box only.",responses((status=200,body=BackendsView),(status=403,description="Not a personal identity")))]
pub(crate) async fn list_backends(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = plan_owner(&auth, &environments::owner(&auth)?);
            let node_owner = caller_is_node_owner(&auth);
            let rollout = rollout_allows(&auth).await;
            let probe = node_owner && rollout;
            let now = unix_now();
            let mut backends = Vec::new();
            for backend in CloudTaskBackend::ALL {
                if backend != CloudTaskBackend::RyuBox && !probe {
                    continue;
                }
                backends.push(backend_view(backend, probe, now).await);
            }
            Ok(BackendsView {
                owner: node_owner,
                rollout,
                settings: probe.then(|| store::settings(&owner)),
                backends,
            })
        }
        .await,
    )
}

/// The owner key, for a route only the node owner may use with the rollout on.
pub(in crate::server::subscription_cloud) async fn owner_with_plans(
    auth: &ResolvedAuthorization,
) -> Result<String, ApiError> {
    let owner = plan_owner(auth, &environments::owner(auth)?);
    if !caller_is_node_owner(auth) {
        return Err(owner_only());
    }
    if !rollout_allows(auth).await {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable",
            "Running cloud tasks on your own plan is not enabled for this account yet.",
        ));
    }
    Ok(owner)
}

#[utoipa::path(get,path="/api/cloud-task-backends/routing",operation_id="get_cloud_task_routing",tag="Cloud environments",security(("bearerAuth"=[])),description="The node owner's cloud task routing: whether their own plans are used, the default backend order, per-agent orders, and each environment's local checkout (Claude) or Codex environment ID. Node owner only.",responses((status=200,body=RoutingSettings),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn get_routing(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            Ok(store::settings(&owner))
        }
        .await,
    )
}

const MAX_AGENT_OVERRIDES: usize = 64;
const MAX_ENVIRONMENT_LINKS: usize = 256;

fn validate_order(order: &[CloudTaskBackend]) -> Result<(), ApiError> {
    let mut seen = Vec::new();
    for backend in order {
        if seen.contains(backend) {
            return Err(bad_request("A backend order lists a backend twice."));
        }
        seen.push(*backend);
    }
    if order.is_empty() {
        return Err(bad_request("A backend order needs at least one backend."));
    }
    Ok(())
}

/// Every account a routing choice names must be the default sign-in or linked, and
/// the explicit fallback lists stay short and free of repeats.
fn validate_accounts(owner: &str, settings: &RoutingSettings) -> Result<(), ApiError> {
    let unknown =
        || bad_request("A routing choice names an account that is not linked on this node.");
    for (provider, id) in &settings.default_accounts {
        if !linked(owner, *provider, id) {
            return Err(unknown());
        }
    }
    if settings.agent_accounts.len() > MAX_AGENT_OVERRIDES {
        return Err(bad_request("Too many per-agent accounts."));
    }
    for (agent, choice) in &settings.agent_accounts {
        if agent.is_empty() || agent.len() > 128 {
            return Err(bad_request("An agent ID must be 1-128 characters."));
        }
        if choice
            .iter()
            .any(|(provider, id)| !linked(owner, *provider, id))
        {
            return Err(unknown());
        }
    }
    for (provider, order) in &settings.account_fallbacks {
        if order.len() > accounts::MAX_ACCOUNTS_PER_PROVIDER + 1 {
            return Err(bad_request("A fallback list is too long."));
        }
        let mut seen = Vec::new();
        for id in order {
            if seen.contains(&id) {
                return Err(bad_request("A fallback list names an account twice."));
            }
            seen.push(id);
            if !linked(owner, *provider, id) {
                return Err(unknown());
            }
        }
    }
    Ok(())
}

fn validate_settings(settings: &RoutingSettings) -> Result<(), ApiError> {
    validate_order(&settings.default_order)?;
    if settings.agent_overrides.len() > MAX_AGENT_OVERRIDES
        || settings.environments.len() > MAX_ENVIRONMENT_LINKS
    {
        return Err(bad_request("Too many agent overrides or environments."));
    }
    for (agent, order) in &settings.agent_overrides {
        if agent.is_empty() || agent.len() > 128 {
            return Err(bad_request("An agent ID must be 1-128 characters."));
        }
        validate_order(order)?;
    }
    for (environment, link) in &settings.environments {
        if environment.is_empty() || environment.len() > 128 {
            return Err(bad_request("An environment ID must be 1-128 characters."));
        }
        if let Some(checkout) = &link.claude_checkout {
            if checkout.len() > 4096 || !checkout_is_usable(checkout) {
                return Err(bad_request(
                    "A Claude checkout must be the absolute path of a git checkout on this node.",
                ));
            }
        }
        if let Some(id) = &link.codex_environment_id {
            if !codex_environment_id_ok(id) {
                return Err(bad_request(
                    "A Codex environment ID is 1-128 letters, digits, '-' or '_'.",
                ));
            }
        }
    }
    Ok(())
}

#[utoipa::path(put,path="/api/cloud-task-backends/routing",operation_id="put_cloud_task_routing",tag="Cloud environments",security(("bearerAuth"=[])),request_body=RoutingSettings,description="Replace the node owner's cloud task routing. Orders may not repeat a backend; the Ryu Box is always the last fallback unless a session pins a backend strictly. A Claude checkout must be an absolute path to a git checkout on this node. Node owner only.",responses((status=200,body=RoutingSettings),(status=400,description="invalid_request"),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn put_routing(
    Extension(auth): Extension<ResolvedAuthorization>,
    body: axum::body::Bytes,
) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let settings: RoutingSettings = serde_json::from_slice(&body)
                .map_err(|_| bad_request("The routing settings are invalid."))?;
            validate_settings(&settings)?;
            validate_accounts(&owner, &settings)?;
            store::save_settings(&owner, settings.clone());
            Ok(settings)
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(error: &ApiError) -> String {
        error.1 .0["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    #[test]
    fn a_backend_order_is_non_empty_and_free_of_repeats() {
        assert!(validate_order(&[
            CloudTaskBackend::AnthropicSubscriptionCli,
            CloudTaskBackend::RyuBox,
        ])
        .is_ok());
        let empty = validate_order(&[]).expect_err("empty order");
        assert_eq!(empty.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            message(&empty),
            "A backend order needs at least one backend."
        );
        let repeated = validate_order(&[CloudTaskBackend::RyuBox, CloudTaskBackend::RyuBox])
            .expect_err("repeated backend");
        assert_eq!(repeated.0, StatusCode::BAD_REQUEST);
        assert_eq!(message(&repeated), "A backend order lists a backend twice.");
    }
}
