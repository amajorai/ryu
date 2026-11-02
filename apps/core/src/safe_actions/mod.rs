mod dispatch;
mod execute;
mod http_policies;
mod http_reviews;
mod lifecycle;
mod operator;
mod service;
mod store;
#[cfg(test)]
mod tests;

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ryu_safe_actions::{
    canonical_json, issue_certificate, sha256_canonical, validate_certificate, Certificate,
    CertificateBindings, CertificateError, ComparisonOp, ContractTrust, JsonType, PlanNode,
    PlanValue, Policy, Predicate, ToolDescriptor, ToolPlan, VerificationDecision, VerifierInput,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    sync::OnceLock,
    time::Duration,
};
use store::{
    sanitize_error, CatalogView, ContractInput, ExecutionReceipt, PolicyCheckInput,
    PolicyDeleteInput, PolicyInput, PolicyRecord, ReviewDecisionInput, StatusInput, StepReceipt,
    SubmissionRecord, SubmitPlanInput, ToolContractRecord,
};
use uuid::Uuid;

pub use store::SafeActionsStore;

use dispatch::*;
pub(crate) use dispatch::{authorize_verified_dispatch, dispatch_tool};
use execute::*;
use http_policies::*;
use http_reviews::*;
use operator::authorize_operator;

pub(crate) const SERVER_NAME: &str = "plans";
const CERTIFICATE_TTL_MS: u64 = 5 * 60 * 1000;
const MAX_STEP_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EXECUTION_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const TOOL_EXECUTION_TIMEOUT_SECS: u64 = 120;

static GLOBAL: OnceLock<SafeActionsService> = OnceLock::new();

#[derive(Clone)]
pub struct SafeActionsService {
    store: SafeActionsStore,
    registry: Option<std::sync::Arc<crate::sidecar::mcp::McpRegistry>>,
}

#[derive(Clone)]
struct VerifiedStepGrant {
    service: SafeActionsService,
    submission_id: String,
    certificate_id: String,
    agent_id: String,
    step_id: String,
    allowed_tool_chain: Vec<String>,
    implementation_hash: String,
    arguments_hash: String,
    bindings: CertificateBindings,
    certificate: Certificate,
}

tokio::task_local! {
    static VERIFIED_STEP_GRANT: VerifiedStepGrant;
}

#[derive(Clone)]
struct ExecutionIdentity {
    agent_id: String,
    allowlist: Vec<String>,
    profile_ids: Vec<String>,
    host_conversation_id: Option<String>,
}

struct ExecutionContext {
    service: SafeActionsService,
    identity: ExecutionIdentity,
    submission: SubmissionRecord,
    certificate_id: String,
    certificate: Certificate,
    outputs: HashMap<String, Value>,
    retained_output_bytes: usize,
    failure_status: Option<&'static str>,
    receipt: ExecutionReceipt,
    ordinal: u64,
}

impl SafeActionsService {
    pub fn new(store: SafeActionsStore) -> Self {
        Self {
            store,
            registry: None,
        }
    }

    #[cfg(test)]
    fn with_registry(
        store: SafeActionsStore,
        registry: std::sync::Arc<crate::sidecar::mcp::McpRegistry>,
    ) -> Self {
        Self {
            store,
            registry: Some(registry),
        }
    }

    pub fn store(&self) -> &SafeActionsStore {
        &self.store
    }

    fn registry(&self) -> Result<std::sync::Arc<crate::sidecar::mcp::McpRegistry>> {
        self.registry
            .clone()
            .or_else(crate::sidecar::mcp::global_registry)
            .ok_or_else(|| anyhow!("tool registry is not initialized"))
    }
}

/// The fixed plan and report behind [`SafeActionsService::insert_test_pending_review`].
#[cfg(test)]
fn test_pending_review_plan() -> (ToolPlan, ryu_safe_actions::VerificationReport) {
    let plan = ToolPlan {
        schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
        root: PlanNode::Call {
            id: "send".to_owned(),
            tool: "mail.send".to_owned(),
            arguments: PlanValue::Literal { value: json!({}) },
        },
    };
    let report = ryu_safe_actions::verify(&VerifierInput {
        plan: plan.clone(),
        policy: Policy::default(),
        catalog: Vec::new(),
        agent_revision: "agent-revision".to_owned(),
    });
    (plan, report)
}

/// The plan hash a reviewer is shown for every test pending review, which a
/// decision must echo back as `expected_plan_hash`.
#[cfg(test)]
pub(crate) fn test_pending_review_plan_hash() -> String {
    test_pending_review_plan().1.bindings.plan_hash
}

#[cfg(test)]
impl SafeActionsService {
    /// Persist a `pending_review` submission with no executable plan behind it,
    /// for authorization tests of the review routes. Returns its id.
    pub(crate) async fn insert_test_pending_review(&self) -> String {
        let (plan, report) = test_pending_review_plan();
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let record = SubmissionRecord {
            id: id.clone(),
            submission_key: id.clone(),
            agent_id: "agent-1".to_owned(),
            agent_revision: "agent-revision".to_owned(),
            policy_id: "policy-1".to_owned(),
            host_conversation_id: None,
            plan,
            report,
            certificate: None,
            status: "pending_review".to_owned(),
            review_note: None,
            reviewed_by: None,
            reviewed_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store
            .insert_submission(&record)
            .await
            .expect("insert a test submission")
            .id
    }

    /// `(status, reviewed_by)` of one submission, for tests.
    pub(crate) async fn test_review_state(&self, id: &str) -> Option<(String, Option<String>)> {
        self.store
            .get_submission(id)
            .await
            .ok()
            .flatten()
            .map(|submission| (submission.status, submission.reviewed_by))
    }
}

pub fn install_global(service: SafeActionsService) {
    let _ = GLOBAL.set(service);
}

pub fn global() -> Option<SafeActionsService> {
    GLOBAL.get().cloned()
}

pub fn tools() -> Vec<crate::sidecar::mcp::RegistryTool> {
    [
        (
            "submit",
            "Verify, certify, and execute a typed tool plan under the calling agent's bound Safe Actions policy.",
            json!({
                "type": "object",
                "required": ["request_id", "plan"],
                "additionalProperties": false,
                "properties": {
                    "request_id": {
                        "type": "string",
                        "description": "Caller-generated idempotency key. Reuse it only when retrying the same intended submission."
                    },
                    "plan": {"type": "object"}
                }
            }),
        ),
        (
            "status",
            "Read a durable Safe Actions execution receipt by execution, submission, or certificate id.",
            json!({
                "type": "object",
                "required": ["execution_id"],
                "additionalProperties": false,
                "properties": {"execution_id": {"type": "string"}}
            }),
        ),
        (
            "catalog",
            "List the current attested tool catalog used for deterministic verification.",
            json!({"type": "object", "additionalProperties": false}),
        ),
    ]
    .into_iter()
    .map(|(name, description, schema)| crate::sidecar::mcp::RegistryTool {
        id: format!("{SERVER_NAME}.{name}"),
        server: SERVER_NAME.to_owned(),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        input_schema: Some(schema),
        output_schema: Some(json!({"type": "object"})),
        annotations: Some(json!({"readOnlyHint": name != "submit"})),
        meta: None,
        widget: None,
        widget_accessible: false,
        output_template: None,
        app_backend: None,
    })
    .collect()
}

pub fn routes() -> Router<crate::server::ServerState> {
    Router::new()
        .route(
            "/api/tools/plans/policies",
            get(list_policies).post(create_policy),
        )
        .route(
            "/api/tools/plans/policies/:id",
            get(get_policy).put(update_policy).delete(delete_policy),
        )
        .route("/api/tools/plans/policies/:id/check", post(check_policy))
        .route("/api/tools/plans/agents", get(list_verified_agents))
        .route("/api/tools/plans/catalog", get(get_catalog))
        .route("/api/tools/plans/catalog/contracts", post(put_contract))
        .route("/api/tools/plans/reviews", get(list_reviews))
        .route("/api/tools/plans/reviews/:id", get(get_review))
        .route("/api/tools/plans/reviews/:id/approve", post(approve_review))
        .route("/api/tools/plans/reviews/:id/deny", post(deny_review))
        .route("/api/tools/plans/receipts", get(list_receipts))
        .route("/api/tools/plans/receipts/:id", get(get_receipt))
}

fn service(state: &crate::server::ServerState) -> &SafeActionsService {
    &state.safe_actions
}

/// Authorize the verified caller as a Safe Actions operator on this node,
/// returning the id recorded as reviewer or attester. See
/// [`operator::authorize_operator`] for the rule.
fn require_operator(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    write: bool,
) -> std::result::Result<String, Response> {
    let node = crate::sidecar::control_plane::registered_node();
    authorize_operator(
        caller.as_ref(),
        crate::sidecar::control_plane::is_managed_node(),
        node.as_ref(),
        write,
    )
    .map_err(|(status, message)| {
        (status, Json(json!({"ok": false, "error": message}))).into_response()
    })
}
