//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `composio_connection_initiate` through `ComposioSubscribeBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/composio/connections/initiate` — start an OAuth connection for a
/// toolkit. Returns `{ connection_id, redirect_url, status }`; the client opens
/// `redirect_url` then polls `GET /api/composio/connections/:id`.
#[utoipa::path(
    post,
    path = "/api/composio/connections/initiate",
    tag = "Composio",
    summary = "Initiate a Composio account connection for a toolkit",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_connection_initiate(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ComposioConnectBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let owner = match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    let Some(store) = crate::identity::global() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "identity store not initialized" })),
        );
    };
    let composio_entity = caller.as_ref().map(|caller| caller.user_id.as_str());
    match crate::composio_connect::initiate(&state.client, &body.toolkit, composio_entity).await {
        Ok(mut value) => {
            if ryu_composio::service::is_configured() {
                // The owner's own link is now pending next to any agent link
                // started earlier; the callback tries them newest first.
                agent_composio_api::note_service_link(&owner, None);
            }
            let toolkit = body.toolkit.trim();
            if let Err(error) = store
                .set_connection_access_level(
                    &owner,
                    crate::connection_policy::COMPOSIO_PROVIDER,
                    &crate::connection_policy::composio_connection_key(toolkit),
                    body.access_level,
                )
                .await
            {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": format!("Composio connection policy could not be saved: {error}")
                    })),
                );
            }
            if let Some(object) = value.as_object_mut() {
                object.insert("access_level".to_owned(), json!(body.access_level.as_str()));
            }
            (StatusCode::OK, Json(value))
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Callback session data only; identity is supplied by authenticated middleware.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::server) struct ComposioCompleteBody {
    pub(in crate::server) session_uri: String,
}

/// Redeem a provider-returned session only for the authenticated caller.
///
/// The callback carries only an opaque session, so it tries the caller's
/// pending links, newest first: an agent's own account (the agent is re-checked
/// first) and their own account's. Connect refuses a session that is not that
/// subject's pending account, so the first match completes.
#[utoipa::path(
    post,
    path = "/api/composio/connections/complete",
    tag = "Composio",
    summary = "Complete a Connect account after callback identity verification",
    request_body = serde_json::Value,
    responses((status = 200, description = "Verified account metadata", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_connection_complete(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ComposioCompleteBody>,
) -> axum::response::Response {
    let owner = match crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response();
        }
    };
    if body.session_uri.is_empty() || body.session_uri.len() > 4096 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid callback session URI" })),
        )
            .into_response();
    }
    // The callback carries only an opaque session, so try each link the owner
    // has pending, newest first, then their own account's as a last resort.
    // Connect checks the session against each subject's own pending account, so
    // a wrong subject is refused and the next one is tried.
    let mut subjects = agent_composio_api::pending_service_links(&owner);
    if !subjects.contains(&None) {
        subjects.push(None);
    }
    let mut first_failure: Option<axum::response::Response> = None;
    for subject in subjects {
        let agent_id = subject.as_deref();
        if let Some(agent_id) = agent_id {
            if let Some(refusal) =
                agent_composio_api::completion_refusal(&state, &caller, agent_id).await
            {
                first_failure.get_or_insert(refusal);
                continue;
            }
        }
        let result = match agent_id {
            // The agent's account lives in the owner's tenant.
            Some(agent_id) => {
                ryu_composio::service::complete_as(&body.session_uri, Some(&owner), Some(agent_id))
                    .await
            }
            None => {
                ryu_composio::service::complete(
                    &body.session_uri,
                    caller.as_ref().map(|caller| caller.user_id.as_str()),
                )
                .await
            }
        };
        match result {
            Some(Ok(mut value)) => {
                agent_composio_api::finish_service_link(&owner, agent_id);
                if let Some(agent_id) = agent_id {
                    if let Some(object) = value.as_object_mut() {
                        object.insert("agent_id".to_owned(), json!(agent_id));
                    }
                }
                return (StatusCode::OK, Json(value)).into_response();
            }
            Some(Err(error)) => {
                // Only Connect's own refusal means "not this subject's link";
                // an unreachable Connect would fail the same way for the rest.
                let refused = error
                    .downcast_ref::<ryu_composio::service::ConnectRejected>()
                    .is_some();
                let failure = (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": error.to_string() })),
                )
                    .into_response();
                if !refused {
                    return first_failure.unwrap_or(failure);
                }
                first_failure.get_or_insert(failure);
            }
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "Connect is not configured" })),
                )
                    .into_response();
            }
        }
    }
    first_failure.unwrap_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "No pending connection matched this sign-in" })),
        )
            .into_response()
    })
}

/// Add the owner's stored access ceiling to the metadata-only Composio list.
/// Missing policy rows resolve to the safe `RiskBased` default, which keeps
/// connections created by older Core versions governed after an upgrade.
pub(in crate::server) async fn decorate_composio_access_levels(
    owner: &str,
    value: &mut serde_json::Value,
) -> anyhow::Result<()> {
    let Some(store) = crate::identity::global() else {
        return Ok(());
    };
    let Some(data) = value.get_mut("data").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for connection in data {
        let Some(object) = connection.as_object_mut() else {
            continue;
        };
        let toolkit = object.get("toolkit").and_then(Value::as_str).unwrap_or("");
        let access_level = store
            .get_connection_access_level(
                owner,
                crate::connection_policy::COMPOSIO_PROVIDER,
                &crate::connection_policy::composio_connection_key(toolkit),
            )
            .await?;
        object.insert(
            "access_level".to_owned(),
            Value::String(access_level.as_str().to_owned()),
        );
    }
    Ok(())
}

/// `GET /api/composio/connections/:id` — poll one connection's status (the client
/// calls this after the user returns from the Composio OAuth redirect).
#[utoipa::path(
    get,
    path = "/api/composio/connections/{id}",
    tag = "Composio",
    summary = "Poll a Composio connection's status",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn composio_connection_status(
    State(state): State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(error) = crate::mcp_oauth::owner_for_caller(caller.as_ref()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": error.to_string() })),
        );
    }
    if let Some(result) = ryu_composio::service::connection_status(
        &id,
        caller.as_ref().map(|caller| caller.user_id.as_str()),
    )
    .await
    {
        return match result {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": error.to_string() })),
            ),
        };
    }
    match crate::composio_connect::connection_status(&state.client, &id).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Body for `POST /api/composio/triggers/subscribe`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ComposioSubscribeBody {
    pub(in crate::server) agent_id: String,
    pub(in crate::server) toolkit: String,
    pub(in crate::server) trigger_slug: String,
    pub(in crate::server) connected_account_id: String,
    #[serde(default)]
    pub(in crate::server) config: serde_json::Value,
    /// `true` when `connected_account_id` is connected to the agent's own
    /// identity rather than the user's (an Its own identity or Both agent).
    #[serde(default)]
    pub(in crate::server) own_account: bool,
}
