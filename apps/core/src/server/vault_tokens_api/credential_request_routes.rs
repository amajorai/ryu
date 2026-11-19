//! Hosted credential collection links
//! ([`crate::vault::shared::links::credential`]).
//!
//! * `POST /api/vault/credential-requests` makes a one-time link that asks a
//!   person for a sign-in to one site on behalf of an agent. It needs what
//!   creating that agent's account needs: `write` on the agent's folder key
//!   `sys/items/agents/<folder>`, `admin` there when the environment is
//!   protected, and an agent that may hold accounts of its own.
//! * Claiming the answer (`POST /api/vault/shares/{id}/claim`) re-checks the
//!   same and saves an agent account. It answers with account metadata only.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::{cloud, link_error};
use crate::identity_verify::VerifiedCaller;
use crate::server::vault_agent_accounts_api::{allow_created_account, box_fill};
use crate::server::vault_api::{respond, vault_error, Ctx};
use crate::server::vault_items_api::require_unprotected_or_admin;
use crate::server::{json_error, ServerState};
use crate::vault::agent_accounts::{self, create_collected};
use crate::vault::items::ItemCoords;
use crate::vault::policy::Capability;
use crate::vault::shared::links::credential::{self, CredentialRequest, CredentialTarget};
use crate::vault::shared::links::{self as sharing, ShareLinkInfo};
use crate::vault::VaultError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRequestBody {
    #[serde(default)]
    agent_id: Option<String>,
    site: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    totp: bool,
    #[serde(default)]
    submit_urls: Vec<String>,
    label: String,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// May the caller save an account for `agent_id`?
async fn authorize_agent(
    state: &ServerState,
    ctx: &Ctx,
    agent_id: Option<&str>,
) -> Result<(), Response> {
    let policy = box_fill::policy_for(&state.agent_store, agent_id)
        .await
        .map_err(|error| {
            tracing::warn!("agent account policy lookup failed: {error:#}");
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent lookup unavailable".to_owned(),
            )
        })?;
    if policy.is_some_and(|policy| !policy.allows_own_accounts()) {
        return Err(vault_error(
            VaultError::Denied(
                "this agent acts as you and has no accounts of its own; change its identity in the agent's settings"
                    .into(),
            )
            .into(),
        ));
    }
    let folder = ItemCoords::new(
        Some(agent_accounts::ENVIRONMENT),
        Some(&agent_accounts::agent_folder(agent_id)),
        "account",
    )
    .map_err(vault_error)?;
    ctx.require_sys(&folder.policy_key(), Capability::Write)?;
    require_unprotected_or_admin(ctx, &folder).await
}

/// POST /api/vault/credential-requests.
#[utoipa::path(post, path = "/api/vault/credential-requests", tag = "Vault",
    summary = "Create a one-time link that asks someone for an agent's sign-in to one site",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The link", body = serde_json::Value),
        (status = 409, description = "This node is not connected to Ryu Cloud", body = serde_json::Value),
    ))]
pub async fn credential_request_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<CredentialRequestBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let agent_id = body.agent_id.as_deref();
    if let Err(response) = authorize_agent(&state, &ctx, agent_id).await {
        return response;
    }
    let cloud = match cloud() {
        Ok(cloud) => cloud,
        Err(response) => return response,
    };
    let request = CredentialRequest {
        agent_id,
        site: &body.site,
        username: body.username.as_deref(),
        totp: body.totp,
        submit_urls: body.submit_urls.clone(),
        label: &body.label,
        ttl_secs: body.ttl_secs,
    };
    match credential::request_credential(ctx.store, &cloud, request, &ctx.actor()).await {
        Ok(link) => respond(json!({ "link": link })),
        Err(error) => link_error(error),
    }
}

/// Save a collected answer as an agent account and close the request. A
/// failure leaves the answer sealed here, so the claim can be retried.
pub(super) async fn claim_credential(
    state: &ServerState,
    ctx: &Ctx,
    (link, target): (&ShareLinkInfo, CredentialTarget),
    answer: &str,
) -> Response {
    let agent_id = target.agent_id.as_deref();
    if let Err(response) = authorize_agent(state, ctx, agent_id).await {
        return response;
    }
    let actor = ctx.actor();
    let input = match credential::collected_input(&target, answer, link.label.as_deref()) {
        Ok(input) => input,
        Err(error) => return vault_error(error),
    };
    let account = match create_collected(ctx.store, agent_id, input, &actor).await {
        Ok(account) => account,
        Err(error) => return vault_error(error),
    };
    if let Some(agent_id) = agent_id {
        allow_created_account(state, agent_id, &account.id).await;
    }
    if let Err(error) = sharing::finish_claim(ctx.store, &link.id, &actor).await {
        return vault_error(error);
    }
    respond(json!({ "account": account }))
}

#[cfg(test)]
mod tests {
    use super::CredentialRequestBody;
    use serde_json::json;

    #[test]
    fn the_body_takes_no_secret_and_defaults_to_no_authenticator_field() {
        let body: CredentialRequestBody = serde_json::from_value(
            json!({ "site": "github.com", "label": "Release bot", "agentId": "a1" }),
        )
        .unwrap();
        assert!(!body.totp);
        assert!(body.submit_urls.is_empty());
        assert_eq!(body.agent_id.as_deref(), Some("a1"));
        // A caller can never hand the password over through this route.
        assert!(serde_json::from_value::<CredentialRequestBody>(
            json!({ "site": "github.com", "label": "x", "password": "hunter2" })
        )
        .is_err());
    }
}
