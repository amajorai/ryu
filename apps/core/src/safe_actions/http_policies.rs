//! `/api/tools/plans` policy, catalog, and verified-agent handlers.

use super::*;

pub(super) async fn list_policies(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async { Ok(json!({"policies": service(&state).store.list_policies().await?})) }).await
}

pub(super) async fn get_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let policy = service(&state)
            .store
            .get_policy(&id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("policy '{id}' not found")))?;
        Ok(json!({"policy": policy}))
    })
    .await
}

pub(super) async fn create_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<PolicyInput>,
) -> Response {
    if let Err(response) = require_operator(&caller, true) {
        return response;
    }
    api(put_policy_record(service(&state), input, None)).await
}

pub(super) async fn update_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(input): Json<PolicyInput>,
) -> Response {
    if let Err(response) = require_operator(&caller, true) {
        return response;
    }
    api(put_policy_record(service(&state), input, Some(id))).await
}

pub(super) async fn put_policy_record(
    service: &SafeActionsService,
    input: PolicyInput,
    forced_id: Option<String>,
) -> std::result::Result<Value, ApiError> {
    let updating = forced_id.is_some();
    if updating && input.expected_version.is_none() {
        return Err(ApiError::bad_request(
            "expected_version is required when updating a policy",
        ));
    }
    let id = forced_id
        .or(input.id)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if !valid_request_id(&id) {
        return Err(ApiError::bad_request(
            "policy id must be 1-128 safe ASCII characters",
        ));
    }
    if input.name.trim().is_empty() || input.name.len() > 128 {
        return Err(ApiError::bad_request(
            "policy name must be 1-128 characters",
        ));
    }
    if input
        .description
        .as_ref()
        .is_some_and(|value| value.len() > 4096)
    {
        return Err(ApiError::bad_request(
            "policy description must be at most 4096 characters",
        ));
    }
    if input.bound_agent_ids.len() > 256 {
        return Err(ApiError::bad_request(
            "a policy may bind at most 256 verified agents",
        ));
    }
    let findings = ryu_safe_actions::validate_policy(&input.policy);
    if !findings.is_empty() {
        return Err(ApiError::bad_request(format!(
            "policy failed validation: {}",
            findings
                .iter()
                .map(|finding| finding.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }
    for agent_id in &input.bound_agent_ids {
        service
            .agent_revision(agent_id)
            .await
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    let hash = sha256_canonical(&input.policy).map_err(ApiError::internal)?;
    let record = PolicyRecord {
        id,
        name: input.name.trim().to_owned(),
        description: input.description,
        policy: input.policy,
        policy_hash: hash,
        version: 0,
        bound_agent_ids: input.bound_agent_ids,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let record = service
        .store
        .put_policy(record, input.expected_version)
        .await
        .map_err(ApiError::conflict)?;
    Ok(json!({"policy": record}))
}

pub(super) async fn delete_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(input): Json<PolicyDeleteInput>,
) -> Response {
    if let Err(response) = require_operator(&caller, true) {
        return response;
    }
    api(async {
        if !service(&state)
            .store
            .delete_policy(&id, input.expected_version)
            .await?
        {
            return Err(ApiError::conflict(
                "policy changed or no longer exists; reload before deleting",
            ));
        }
        Ok(json!({"ok": true}))
    })
    .await
}

pub(super) async fn check_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    input: Option<Json<PolicyCheckInput>>,
) -> Response {
    if let Err(response) = require_operator(&caller, true) {
        return response;
    }
    api(async {
        let policy = service(&state)
            .store
            .get_policy(&id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("policy '{id}' not found")))?;
        if let Some(Json(input)) = input {
            let (verifier_input, _, _) = service(&state)
                .verifier_input(&input.agent_id, input.plan, Some(policy.policy))
                .await?;
            let report = ryu_safe_actions::verify(&verifier_input);
            Ok(json!({
                "valid": report.decision != VerificationDecision::Denied,
                "findings": report.findings,
                "report": report,
            }))
        } else {
            let findings = ryu_safe_actions::validate_policy(&policy.policy);
            Ok(json!({
                "valid": findings.is_empty(),
                "findings": findings,
            }))
        }
    })
    .await
}

pub(super) async fn get_catalog(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let tools = service(&state).catalog(None).await?;
        let catalog_hash = sha256_canonical(&tools)?;
        let contract_metadata = service(&state)
            .store
            .list_contracts()
            .await?
            .into_iter()
            .map(|record| (record.tool.clone(), record))
            .collect::<BTreeMap<_, _>>();
        Ok(serde_json::to_value(CatalogView {
            tools: tools
                .into_iter()
                .map(|tool| {
                    let metadata = contract_metadata.get(&tool.name);
                    let mut value = serde_json::to_value(&tool).unwrap_or(Value::Null);
                    if let Some(object) = value.as_object_mut() {
                        if let Some(record) = metadata {
                            object.insert(
                                "contract_hash".to_owned(),
                                Value::String(record.contract_hash.clone()),
                            );
                            object.insert(
                                "contract_implementation_hash".to_owned(),
                                Value::String(record.implementation_hash.clone()),
                            );
                            object.insert(
                                "attested_by".to_owned(),
                                Value::String(record.attested_by.clone()),
                            );
                            object.insert(
                                "contract_stale".to_owned(),
                                Value::Bool(record.implementation_hash != tool.implementation_hash),
                            );
                        }
                    }
                    value
                })
                .collect(),
            catalog_hash,
        })?)
    })
    .await
}

pub(super) async fn list_verified_agents(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let registry = crate::sidecar::mcp::global_registry()
            .ok_or_else(|| anyhow!("tool registry is not initialized"))?;
        let store = registry
            .agent_store
            .as_ref()
            .ok_or_else(|| anyhow!("agent store is not initialized"))?;
        let agents = store
            .list()
            .await?
            .into_iter()
            .filter(|agent| {
                agent.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
            })
            .map(|agent| {
                json!({
                    "id": agent.id,
                    "name": agent.name,
                    "title": agent.title,
                    "lifecycle_status": agent.lifecycle_status,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"agents": agents}))
    })
    .await
}
