//! Governed embedding and reranking endpoints.
//!
//! These routes deliberately accept a model id, not an upstream URL or key.
//! The Gateway authenticates the caller, resolves the model through its normal
//! routing table, and keeps provider credentials inside the configured provider.

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;

use crate::{
    budget::BudgetDecision,
    config::BudgetAction,
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs, EmbeddingOperation, PipelineOutput},
    state::SharedState,
};

const MAX_EMBED_INPUTS: usize = 256;
const MAX_EMBED_CHARS: usize = 16_384;
const MAX_RERANK_DOCUMENTS: usize = 128;
const MAX_RERANK_CHARS: usize = 32_768;

pub async fn embeddings(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    validate_embeddings(&body)?;
    required_model(&body)?;
    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: headers.get("authorization").and_then(|v| v.to_str().ok()),
            user_id: header_string(&headers, "x-ryu-user-id"),
            user_jwt: header_string(&headers, "x-ryu-user-jwt"),
            agent_id: header_string(&headers, "x-ryu-agent-id"),
            agent_provider_access: header_string(&headers, "x-ryu-agent-provider-access"),
            ..Default::default()
        },
    )
    .await?;
    let output = pipeline::run_embedding(state, ctx, body, EmbeddingOperation::Embed).await?;
    Ok(pipeline_response(output))
}

pub async fn rerank(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    validate_rerank(&body)?;
    required_model(&body)?;
    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: headers.get("authorization").and_then(|v| v.to_str().ok()),
            user_id: header_string(&headers, "x-ryu-user-id"),
            user_jwt: header_string(&headers, "x-ryu-user-jwt"),
            agent_id: header_string(&headers, "x-ryu-agent-id"),
            agent_provider_access: header_string(&headers, "x-ryu-agent-provider-access"),
            ..Default::default()
        },
    )
    .await?;
    let output = pipeline::run_embedding(state, ctx, body, EmbeddingOperation::Rerank).await?;
    Ok(pipeline_response(output))
}

fn pipeline_response(output: PipelineOutput) -> Response {
    let budget = output.budget.clone();
    let degraded = output.degraded.clone();
    let policy_alert = output.policy_alert.clone();
    let prompt_cache = output.prompt_cache;
    let mut response = Json(output.response).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&output.context.request_id) {
        headers.insert("x-request-id", value);
    }
    headers.insert("x-provider", HeaderValue::from_static(output.provider_used));
    if let Ok(value) = HeaderValue::from_str(&output.model_used) {
        headers.insert("x-routed-model", value);
    }
    if let Some(budget) = budget.as_ref() {
        apply_budget_headers(headers, budget);
    }
    if let Some(degraded) = degraded {
        if let Ok(value) = HeaderValue::from_str(&degraded.header_value()) {
            headers.insert("x-degraded", value);
        }
    }
    headers.insert(
        "x-ryu-prompt-cache",
        HeaderValue::from_static(prompt_cache.as_str()),
    );
    if let Some(alert) = policy_alert {
        response.extensions_mut().insert(alert);
    }
    response
}

fn apply_budget_headers(headers: &mut HeaderMap, budget: &BudgetDecision) {
    headers.insert(
        "x-budget-scope",
        HeaderValue::from_static(budget.scope.as_str()),
    );
    headers.insert(
        "x-budget-action",
        HeaderValue::from_static(budget_action_label(budget.action)),
    );
    if let Ok(value) = HeaderValue::from_str(&budget.used.to_string()) {
        headers.insert("x-budget-used", value);
    }
    if let Ok(value) = HeaderValue::from_str(&budget.limit.to_string()) {
        headers.insert("x-budget-limit", value);
    }
    headers.insert("x-budget-currency", HeaderValue::from_static("USD"));
    headers.insert("x-budget-unit", HeaderValue::from_static("micro_usd"));
}

fn budget_action_label(action: BudgetAction) -> &'static str {
    match action {
        BudgetAction::Notify => "notify",
        BudgetAction::Downgrade => "downgrade",
        BudgetAction::Restrict => "restrict",
        BudgetAction::Stop => "stop",
    }
}

fn required_model(body: &Value) -> Result<String, GatewayError> {
    body.get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| GatewayError::BadRequest("model is required".to_owned()))
}

fn validate_embeddings(body: &Value) -> Result<(), GatewayError> {
    let input = body
        .get("input")
        .ok_or_else(|| GatewayError::BadRequest("input is required".to_owned()))?;
    let inputs = match input {
        Value::String(text) => vec![text.as_str()],
        Value::Array(values) => values
            .iter()
            .map(|value| {
                value.as_str().ok_or_else(|| {
                    GatewayError::BadRequest("embedding input must be strings".to_owned())
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(GatewayError::BadRequest(
                "input must be a string or array".to_owned(),
            ))
        }
    };
    if inputs.len() > MAX_EMBED_INPUTS {
        return Err(GatewayError::BadRequest(format!(
            "at most {MAX_EMBED_INPUTS} embedding inputs are allowed"
        )));
    }
    if inputs.iter().any(|text| text.len() > MAX_EMBED_CHARS) {
        return Err(GatewayError::BadRequest(format!(
            "embedding inputs may be at most {MAX_EMBED_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate_rerank(body: &Value) -> Result<(), GatewayError> {
    let query = body
        .get("query")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| GatewayError::BadRequest("query is required".to_owned()))?;
    let documents = body
        .get("documents")
        .and_then(Value::as_array)
        .ok_or_else(|| GatewayError::BadRequest("documents must be an array".to_owned()))?;
    if documents.len() > MAX_RERANK_DOCUMENTS {
        return Err(GatewayError::BadRequest(format!(
            "at most {MAX_RERANK_DOCUMENTS} rerank documents are allowed"
        )));
    }
    if documents.iter().any(|document| !document.is_string()) {
        return Err(GatewayError::BadRequest(
            "rerank documents must be strings".to_owned(),
        ));
    }
    if query.len() > MAX_RERANK_CHARS
        || documents.iter().any(|document| {
            document
                .as_str()
                .is_some_and(|text| text.len() > MAX_RERANK_CHARS)
        })
    {
        return Err(GatewayError::BadRequest(format!(
            "rerank text may be at most {MAX_RERANK_CHARS} characters"
        )));
    }
    Ok(())
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedding_validation_rejects_oversized_batches() {
        let input = (0..=MAX_EMBED_INPUTS)
            .map(|_| Value::String("x".to_owned()))
            .collect::<Vec<_>>();
        let error = validate_embeddings(&json!({"model": "embed", "input": input}))
            .expect_err("oversized embedding batch must be rejected");
        assert!(error.to_string().contains("at most"));
    }

    #[test]
    fn rerank_validation_rejects_non_string_documents() {
        let error = validate_rerank(&json!({
            "model": "rerank",
            "query": "q",
            "documents": ["ok", {"secret": "not a document"}]
        }))
        .expect_err("non-string documents must be rejected");
        assert!(error.to_string().contains("documents must be strings"));
    }

    #[test]
    fn model_validation_rejects_blank_ids() {
        let error =
            required_model(&json!({"model": "  "})).expect_err("blank model ids must be rejected");
        assert!(error.to_string().contains("model is required"));
    }
}
