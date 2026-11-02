//! `/api/tools/plans` contract, review, and receipt handlers, and the shared
//! API error mapping.

use super::*;

pub(super) async fn put_contract(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<ContractInput>,
) -> Response {
    let attested_by = match require_operator(&caller, true) {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    api(async {
        if input.contract.trust != ContractTrust::OperatorAttested {
            return Err(ApiError::bad_request(
                "the operator API accepts only operator_attested contracts",
            ));
        }
        if input.contract.effects.is_empty() {
            return Err(ApiError::bad_request(
                "an attested contract must declare at least one effect",
            ));
        }
        if input.contract.resources.len() > 256
            || input.contract.resource_bindings.len() > 32
            || input
                .contract
                .resources
                .iter()
                .any(|resource| !valid_contract_resource(resource))
        {
            return Err(ApiError::bad_request(
                "an attested contract may declare at most 256 safe concrete resources",
            ));
        }
        if input.contract.arguments_independent
            == !input.contract.resource_bindings.is_empty()
            || input
                .contract
                .resource_bindings
                .iter()
                .any(|binding| !valid_contract_binding(binding))
        {
            return Err(ApiError::bad_request(
                "declare either argument-independent resources or 1-32 valid argument resource bindings",
            ));
        }
        if input.contract.resources.is_empty() && input.contract.resource_bindings.is_empty() {
            return Err(ApiError::bad_request(
                "an attested contract must declare or derive affected resources",
            ));
        }
        let descriptor = service(&state)
            .catalog(None)
            .await?
            .iter()
            .find(|tool| tool.name == input.tool)
            .cloned();
        let Some(descriptor) = descriptor else {
            return Err(ApiError::bad_request(
                "contracts may be attested only for tools in the live catalog",
            ));
        };
        let contract_hash = sha256_canonical(&input.contract)?;
        let record = ToolContractRecord {
            tool: input.tool,
            contract: input.contract,
            contract_hash,
            implementation_hash: descriptor.implementation_hash,
            attested_by,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let record = service(&state)
            .store
            .put_contract(
                record,
                input.expected_contract_hash.as_deref(),
                input.expected_implementation_hash.as_deref(),
            )
            .await
            .map_err(ApiError::conflict)?;
        Ok(json!({"contract": record}))
    })
    .await
}

pub(super) async fn list_reviews(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let reviews = service(&state)
            .store
            .list_reviews()
            .await?
            .iter()
            .map(review_projection)
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"reviews": reviews}))
    })
    .await
}

pub(super) async fn get_review(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let review = service(&state)
            .store
            .get_submission(&id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("review '{id}' not found")))?;
        Ok(json!({"review": review_projection(&review)?}))
    })
    .await
}

pub(super) async fn approve_review(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(input): Json<ReviewDecisionInput>,
) -> Response {
    let reviewed_by = match require_operator(&caller, true) {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    api(async {
        let outcome = service(&state).approve(&id, input, reviewed_by).await?;
        Ok(json!({
            "ok": true,
            "status": outcome.get("status").cloned().unwrap_or(Value::String("completed".to_owned())),
            "receipt": outcome.get("receipt").cloned(),
        }))
    })
    .await
}

pub(super) async fn deny_review(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(input): Json<ReviewDecisionInput>,
) -> Response {
    let reviewed_by = match require_operator(&caller, true) {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    api(async {
        service(&state).deny(&id, input, reviewed_by).await?;
        Ok(json!({"ok": true, "status": "denied_by_reviewer"}))
    })
    .await
}

pub(super) async fn list_receipts(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async { Ok(json!({"receipts": service(&state).store.list_receipts().await?})) }).await
}

pub(super) async fn get_receipt(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async {
        let receipt = service(&state)
            .store
            .get_receipt(&id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("receipt '{id}' not found")))?;
        Ok(json!({"receipt": receipt}))
    })
    .await
}

pub(super) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(super) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub(super) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub(super) fn conflict(error: impl std::fmt::Display) -> Self {
        tracing::warn!(error = %error, "Safe Actions concurrent update conflict");
        Self {
            status: StatusCode::CONFLICT,
            message: "Safe Actions data changed; reload the latest version and retry".to_owned(),
        }
    }

    pub(super) fn internal(error: impl std::fmt::Display) -> Self {
        let detail = error.to_string();
        let digest = sha256_canonical(&detail).unwrap_or_else(|_| "unavailable".to_owned());
        let correlation = digest.get(..12).unwrap_or(&digest);
        tracing::error!(error = %detail, correlation, "Safe Actions request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("Safe Actions request failed (correlation {correlation})"),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(error: E) -> Self {
        Self::internal(error.into())
    }
}

pub(super) async fn api<F>(future: F) -> Response
where
    F: Future<Output = std::result::Result<Value, ApiError>>,
{
    match future.await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => (
            error.status,
            Json(json!({"ok": false, "error": error.message})),
        )
            .into_response(),
    }
}
