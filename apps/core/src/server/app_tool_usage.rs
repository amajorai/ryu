//! The generic sidecar → wallet usage callback.
//!
//! Sidecars own the provider call, but they do not own tenancy or the wallet.
//! This handler authenticates the sidecar token, derives the organization from
//! the registered managed node, and forwards only the descriptive charge facts
//! to Gateway. A sidecar can therefore never choose which organization's wallet
//! to debit.

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::sidecar::{ext_proxy::authenticate_sidecar, gateway::ExternalToolCharge};

const MAX_PROVIDER_BYTES: usize = 64;
const MAX_TOOL_ID_BYTES: usize = 256;
const MAX_REQUEST_ID_BYTES: usize = 256;
const MAX_TRANSACTION_ID_BYTES: usize = 256;
const MAX_TASK_LABEL_BYTES: usize = 256;

/// Body for `POST /api/host/capability/billing.recordToolCharge`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUsageBody {
    pub provider: String,
    pub tool_id: String,
    #[serde(default)]
    pub cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub estimated: bool,
    #[serde(default)]
    pub transaction_id: Option<String>,
    pub request_id: String,
    pub tool_calls: u64,
    #[serde(default)]
    pub task_label: Option<String>,
    #[serde(default)]
    pub composio_usage: Option<ryu_channel_contracts::composio_billing::ComposioUsage>,
}

impl ToolUsageBody {
    fn validate(&self) -> Result<(), &'static str> {
        if self.provider.trim().is_empty() || self.provider.len() > MAX_PROVIDER_BYTES {
            return Err("provider is empty or too long");
        }
        if self.tool_id.trim().is_empty() || self.tool_id.len() > MAX_TOOL_ID_BYTES {
            return Err("tool_id is empty or too long");
        }
        if self.request_id.trim().is_empty() || self.request_id.len() > MAX_REQUEST_ID_BYTES {
            return Err("request_id is empty or too long");
        }
        if self
            .transaction_id
            .as_deref()
            .is_some_and(|value| value.len() > MAX_TRANSACTION_ID_BYTES)
        {
            return Err("transaction_id is too long");
        }
        if self
            .task_label
            .as_deref()
            .is_some_and(|value| value.len() > MAX_TASK_LABEL_BYTES)
        {
            return Err("task_label is too long");
        }
        if self.tool_calls == 0 {
            return Err("tool_calls must be positive");
        }
        Ok(())
    }
}

/// Accept one sidecar usage report. A missing registered organization is an
/// explicit unbilled result for standalone/local nodes, not a guessed wallet.
pub(crate) async fn host_tool_usage_record(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<ToolUsageBody>,
) -> Response {
    if let Err(message) = body.validate() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": message })),
        )
            .into_response();
    }

    if let Err((status, message)) = authenticate_sidecar(&state, &headers).await {
        return (status, Json(json!({ "error": message }))).into_response();
    }

    let Some(org) = crate::sidecar::control_plane::registered_org() else {
        return Json(json!({
            "accepted": true,
            "billed": false,
            "reason": "node is not bound to an organization"
        }))
        .into_response();
    };

    let charge = ExternalToolCharge {
        provider: body.provider,
        tool_id: body.tool_id,
        cost_micro_usd: body.cost_micro_usd,
        estimated: body.estimated,
        transaction_id: body.transaction_id,
        request_id: body.request_id,
        tool_calls: body.tool_calls,
        task_label: body.task_label,
        composio_usage: body.composio_usage,
    };

    match crate::sidecar::gateway::record_external_tool_charge(&state.client, &org.id, charge).await
    {
        Ok(_) => {
            Json(json!({ "accepted": true, "billed": true, "org_id": org.id })).into_response()
        }
        Err(error) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("gateway tool charge failed: {error}") })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> ToolUsageBody {
        ToolUsageBody {
            provider: "treg".to_owned(),
            tool_id: "x.x.post.create".to_owned(),
            cost_micro_usd: Some(15_000),
            estimated: false,
            transaction_id: Some("call-1".to_owned()),
            request_id: "social:call-1".to_owned(),
            tool_calls: 1,
            task_label: Some("Outpost X post".to_owned()),
            composio_usage: None,
        }
    }

    #[test]
    fn accepts_bounded_usage_body() {
        assert!(valid_body().validate().is_ok());
    }

    #[test]
    fn rejects_zero_calls_and_unbounded_labels() {
        let mut zero = valid_body();
        zero.tool_calls = 0;
        assert_eq!(zero.validate(), Err("tool_calls must be positive"));

        let mut long = valid_body();
        long.task_label = Some("x".repeat(MAX_TASK_LABEL_BYTES + 1));
        assert_eq!(long.validate(), Err("task_label is too long"));
    }
}
