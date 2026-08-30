mod store;

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

    async fn catalog(&self, allowed_tools: Option<&[String]>) -> Result<Vec<ToolDescriptor>> {
        let registry = self.registry()?;
        let contracts = self.store.list_contracts().await?;
        let mut trusted = BTreeMap::new();
        for record in contracts {
            let hash = sha256_canonical(&record.contract)?;
            if hash != record.contract_hash || !record.contract.trust.is_verifiable() {
                continue;
            }
            trusted.insert(record.tool.clone(), record);
        }
        let mut catalog = Vec::new();
        for tool in registry.list_all_tools().await {
            if tool.server == SERVER_NAME {
                continue;
            }
            if allowed_tools.is_some_and(|allowed| !allowed.iter().any(|name| name == &tool.id)) {
                continue;
            }
            let Ok(dispatch_chain) = registry.verified_dispatch_chain(&tool.id).await else {
                continue;
            };
            let implementation_hash = registry
                .verified_implementation_hash(&tool, &dispatch_chain)
                .await?;
            catalog.push(ToolDescriptor {
                name: tool.id.clone(),
                input_schema: tool.input_schema.unwrap_or(Value::Bool(false)),
                output_schema: tool.output_schema.unwrap_or(Value::Bool(false)),
                implementation_hash: implementation_hash.clone(),
                dispatch_chain,
                contract: trusted.get(&tool.id).and_then(|record| {
                    (record.implementation_hash == implementation_hash)
                        .then(|| record.contract.clone())
                }),
            });
        }
        catalog.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(catalog)
    }

    async fn agent_revision(&self, agent_id: &str) -> Result<(String, crate::agents::AgentRecord)> {
        let registry = self.registry()?;
        let store = registry
            .agent_store
            .as_ref()
            .ok_or_else(|| anyhow!("agent store unavailable for verified plan"))?;
        let record = store
            .get(agent_id)
            .await?
            .ok_or_else(|| anyhow!("calling agent '{agent_id}' is not installed"))?;
        if record.safety_profile != crate::agents::AgentSafetyProfile::VerifiedPlanOnly {
            return Err(anyhow!(
                "agent '{agent_id}' is not configured for verified plans only"
            ));
        }
        let revision = sha256_canonical(&json!({
            "id": record.id,
            "updated_at": record.updated_at,
            "lifecycle": record.lifecycle_status.as_str(),
            "safety": record.safety_profile.as_str(),
            "tools": record.tools,
            "identity_profiles": record.identity_profile_ids,
        }))?;
        Ok((revision, record))
    }

    async fn verifier_input(
        &self,
        agent_id: &str,
        plan: ToolPlan,
        policy_override: Option<Policy>,
    ) -> Result<(VerifierInput, PolicyRecord, crate::agents::AgentRecord)> {
        let (agent_revision, agent) = self.agent_revision(agent_id).await?;
        let policy = match policy_override {
            Some(policy) => PolicyRecord {
                id: "policy-check".to_owned(),
                name: "Policy check".to_owned(),
                description: None,
                policy_hash: sha256_canonical(&policy)?,
                policy,
                version: 0,
                bound_agent_ids: vec![agent_id.to_owned()],
                created_at: String::new(),
                updated_at: String::new(),
            },
            None => self
                .store
                .policy_for_agent(agent_id)
                .await?
                .ok_or_else(|| anyhow!("agent '{agent_id}' has no Safe Actions policy binding"))?,
        };
        if sha256_canonical(&policy.policy)? != policy.policy_hash {
            return Err(anyhow!(
                "stored policy '{}' failed its integrity check",
                policy.id
            ));
        }
        let input = VerifierInput {
            plan,
            policy: policy.policy.clone(),
            catalog: self.catalog(Some(&agent.tools)).await?,
            agent_revision,
        };
        Ok((input, policy, agent))
    }

    async fn submit(
        &self,
        agent_id: &str,
        request_id: &str,
        plan: ToolPlan,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        if !valid_request_id(request_id) {
            return Err(anyhow!(
                "plans.submit request_id must be 1-128 ASCII letters, digits, '.', '_', or '-'"
            ));
        }
        // The idempotency identity is deliberately independent of mutable
        // verification bindings. Retrying the same caller-generated request
        // after a policy/catalog revision must return the original durable
        // submission, never create a second opportunity for side effects.
        let submission_key = sha256_canonical(&json!({
            "agent_id": agent_id,
            "host_conversation_id": host_conversation_id,
            "request_id": request_id,
        }))?;
        if let Some(stored) = self.store.get_submission_by_key(&submission_key).await? {
            if sha256_canonical(&stored.plan)? != sha256_canonical(&plan)? {
                return Err(anyhow!(
                    "plans.submit request_id was already used for a different plan"
                ));
            }
            if matches!(stored.status.as_str(), "certified" | "approved") {
                return self.execute(stored).await;
            }
            return self.submission_response(&stored).await;
        }

        let (input, policy, _) = self.verifier_input(agent_id, plan, None).await?;
        let report = ryu_safe_actions::verify(&input);
        let timestamp = chrono::Utc::now().to_rfc3339();
        let status = match report.decision {
            VerificationDecision::Proved => "certified",
            VerificationDecision::NeedsReview => "pending_review",
            VerificationDecision::Denied => "denied",
        };
        let certificate = if report.decision == VerificationDecision::Proved {
            Some(issue_certificate(
                &report,
                now_ms(),
                now_ms().saturating_add(CERTIFICATE_TTL_MS),
            )?)
        } else {
            None
        };
        let candidate = SubmissionRecord {
            id: Uuid::new_v4().to_string(),
            submission_key,
            agent_id: agent_id.to_owned(),
            agent_revision: input.agent_revision,
            policy_id: policy.id,
            host_conversation_id: host_conversation_id.map(str::to_owned),
            plan: input.plan,
            report,
            certificate,
            status: status.to_owned(),
            review_note: None,
            reviewed_by: None,
            reviewed_at: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        let stored = self.store.insert_submission(&candidate).await?;
        if sha256_canonical(&stored.plan)? != sha256_canonical(&candidate.plan)? {
            return Err(anyhow!(
                "plans.submit request_id was already used for a different plan"
            ));
        }
        if matches!(stored.status.as_str(), "certified" | "approved") {
            return self.execute(stored).await;
        }
        self.submission_response(&stored).await
    }

    async fn submission_response(&self, submission: &SubmissionRecord) -> Result<Value> {
        let receipt = self.store.get_receipt(&submission.id).await?;
        Ok(json!({
            "submission": submission,
            "review": submission,
            "receipt": receipt,
            "execution_id": receipt.as_ref().map(|item| item.id.as_str()).unwrap_or(submission.id.as_str()),
            "status": receipt.as_ref().map(|item| item.status.as_str()).unwrap_or(submission.status.as_str()),
        }))
    }

    async fn execute(&self, mut submission: SubmissionRecord) -> Result<Value> {
        if let Some(existing) = self.store.get_receipt(&submission.id).await? {
            return Ok(
                json!({"receipt": existing, "execution_id": existing.id, "status": existing.status}),
            );
        }

        // Reload every mutable binding immediately before execution. A changed
        // policy, catalog, agent, plan, or verifier version invalidates the cert.
        let (current, policy, agent) = self
            .verifier_input(&submission.agent_id, submission.plan.clone(), None)
            .await?;
        let current_report = ryu_safe_actions::verify(&current);
        let mut certificate = submission
            .certificate
            .clone()
            .ok_or_else(|| anyhow!("submission has no Core-issued certificate"))?;
        let validation = validate_certificate(
            &certificate,
            &CertificateBindings::from(&current_report.bindings),
            &current.agent_revision,
            now_ms(),
        );
        if validation == Err(CertificateError::Expired) && submission.status == "approved" {
            let mut approved_report = submission.report.clone();
            approved_report.decision = VerificationDecision::Proved;
            certificate = issue_certificate(
                &approved_report,
                now_ms(),
                now_ms().saturating_add(CERTIFICATE_TTL_MS),
            )?;
            submission.certificate = Some(certificate.clone());
            submission.updated_at = chrono::Utc::now().to_rfc3339();
            if !self
                .store
                .transition_submission(&submission.id, &["approved"], submission.clone())
                .await?
            {
                return Err(anyhow!("approved submission changed while resuming"));
            }
        } else {
            validation?;
        }
        if current_report.decision == VerificationDecision::Denied {
            return Err(anyhow!(
                "plan no longer verifies under the current policy and catalog"
            ));
        }
        if policy.id != submission.policy_id {
            return Err(anyhow!("agent policy binding changed after certification"));
        }
        let from = if submission.status == "approved" {
            vec!["approved"]
        } else {
            vec!["certified"]
        };
        let certificate_id = Uuid::new_v4().to_string();
        let receipt_id = Uuid::new_v4().to_string();
        let started_at = chrono::Utc::now().to_rfc3339();
        let receipt = ExecutionReceipt {
            id: receipt_id.clone(),
            submission_id: submission.id.clone(),
            certificate_id: certificate_id.clone(),
            agent_id: submission.agent_id.clone(),
            status: "running".to_owned(),
            plan_hash: current_report.bindings.plan_hash.clone(),
            policy_hash: current_report.bindings.policy_hash.clone(),
            catalog_hash: current_report.bindings.catalog_hash.clone(),
            verifier_version: current_report.bindings.verifier_version.clone(),
            result_hash: None,
            error: None,
            started_at,
            finished_at: None,
            steps: Vec::new(),
        };
        submission.status = "executing".to_owned();
        submission.updated_at = chrono::Utc::now().to_rfc3339();
        if !self
            .store
            .start_execution(&submission.id, &from, &submission, &receipt)
            .await?
        {
            if let Some(existing) = self.store.get_receipt(&submission.id).await? {
                return Ok(
                    json!({"receipt": existing, "execution_id": existing.id, "status": existing.status}),
                );
            }
            return Err(anyhow!(
                "submission is not executable in status '{}'",
                submission.status
            ));
        }
        let identity = ExecutionIdentity {
            agent_id: submission.agent_id.clone(),
            allowlist: agent.tools.clone(),
            profile_ids: agent.identity_profile_ids.clone(),
            host_conversation_id: submission.host_conversation_id.clone(),
        };
        let mut context = ExecutionContext {
            service: self.clone(),
            identity,
            submission: submission.clone(),
            certificate_id,
            certificate,
            outputs: HashMap::new(),
            retained_output_bytes: 0,
            failure_status: None,
            receipt,
            ordinal: 0,
        };
        let root = submission.plan.root.clone();
        let outcome = execute_node(&root, &mut context).await;
        context.receipt.finished_at = Some(chrono::Utc::now().to_rfc3339());
        match outcome {
            Ok(result) => {
                context.receipt.status = "succeeded".to_owned();
                context.receipt.result_hash = Some(sha256_canonical(&result)?);
                submission.status = "succeeded".to_owned();
                submission.updated_at = chrono::Utc::now().to_rfc3339();
                if !self
                    .store
                    .save_terminal(&context.receipt, &submission)
                    .await?
                {
                    let recovered = self
                        .store
                        .get_receipt(&submission.id)
                        .await?
                        .ok_or_else(|| anyhow!("execution receipt disappeared during recovery"))?;
                    return Ok(json!({
                        "receipt": recovered,
                        "execution_id": receipt_id,
                        "status": recovered.status,
                    }));
                }
                Ok(json!({
                    "receipt": context.receipt,
                    "execution_id": receipt_id,
                    "status": "succeeded",
                    "result": result,
                }))
            }
            Err(error) => {
                let summary = sanitize_error(&error);
                context.receipt.status = context.failure_status.unwrap_or("uncertain").to_owned();
                context.receipt.error = Some(summary.clone());
                submission.status = context.receipt.status.clone();
                submission.updated_at = chrono::Utc::now().to_rfc3339();
                if !self
                    .store
                    .save_terminal(&context.receipt, &submission)
                    .await?
                {
                    let recovered = self
                        .store
                        .get_receipt(&submission.id)
                        .await?
                        .ok_or_else(|| anyhow!("execution receipt disappeared during recovery"))?;
                    return Ok(json!({
                        "receipt": recovered,
                        "execution_id": receipt_id,
                        "status": recovered.status,
                    }));
                }
                Err(anyhow!(summary))
            }
        }
    }

    async fn approve(
        &self,
        id: &str,
        decision: ReviewDecisionInput,
        reviewed_by: String,
    ) -> Result<Value> {
        if decision.note.as_ref().is_some_and(|note| note.len() > 4096) {
            return Err(anyhow!("review note must be at most 4096 characters"));
        }
        let mut submission = self
            .store
            .get_submission(id)
            .await?
            .ok_or_else(|| anyhow!("review '{id}' not found"))?;
        if submission.status == "approved" {
            return self.execute(submission).await;
        }
        if submission.status != "pending_review" {
            return Err(anyhow!("review '{id}' is not pending"));
        }
        let (input, policy, _) = self
            .verifier_input(&submission.agent_id, submission.plan.clone(), None)
            .await?;
        if policy.id != submission.policy_id {
            return Err(anyhow!(
                "agent policy binding changed while review was pending"
            ));
        }
        let current_report = ryu_safe_actions::verify(&input);
        if current_report.decision == VerificationDecision::Denied
            || current_report.bindings != submission.report.bindings
        {
            submission.status = "invalidated".to_owned();
            submission.updated_at = chrono::Utc::now().to_rfc3339();
            let _ = self
                .store
                .transition_submission(id, &["pending_review"], submission)
                .await?;
            return Err(anyhow!(
                "review evidence changed; this review was invalidated and must be resubmitted"
            ));
        }
        // Preserve the exact report the reviewer saw. Human approval changes
        // only the decision used for the Core-issued certificate; it must not
        // replace the displayed evidence with a freshly computed report.
        let mut report = submission.report.clone();
        report.decision = VerificationDecision::Proved;
        let certificate = issue_certificate(
            &report,
            now_ms(),
            now_ms().saturating_add(CERTIFICATE_TTL_MS),
        )?;
        submission.certificate = Some(certificate);
        submission.status = "approved".to_owned();
        submission.review_note = decision.note;
        submission.reviewed_by = Some(reviewed_by);
        submission.reviewed_at = Some(chrono::Utc::now().to_rfc3339());
        submission.updated_at = chrono::Utc::now().to_rfc3339();
        if !self
            .store
            .transition_submission(id, &["pending_review"], submission.clone())
            .await?
        {
            return Err(anyhow!("review '{id}' was already decided"));
        }
        self.execute(submission).await
    }

    async fn deny(
        &self,
        id: &str,
        decision: ReviewDecisionInput,
        reviewed_by: String,
    ) -> Result<Value> {
        if decision.note.as_ref().is_some_and(|note| note.len() > 4096) {
            return Err(anyhow!("review note must be at most 4096 characters"));
        }
        let mut submission = self
            .store
            .get_submission(id)
            .await?
            .ok_or_else(|| anyhow!("review '{id}' not found"))?;
        submission.status = "denied_by_reviewer".to_owned();
        submission.review_note = decision.note;
        submission.reviewed_by = Some(reviewed_by);
        submission.reviewed_at = Some(chrono::Utc::now().to_rfc3339());
        submission.updated_at = chrono::Utc::now().to_rfc3339();
        if !self
            .store
            .transition_submission(id, &["pending_review"], submission.clone())
            .await?
        {
            return Err(anyhow!("review '{id}' was already decided"));
        }
        Ok(json!({"review": submission, "status": "denied_by_reviewer"}))
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

pub(crate) async fn dispatch_tool(
    tool: &str,
    arguments: Value,
    agent_id: Option<&str>,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    let service = global().ok_or_else(|| anyhow!("Safe Actions is not initialized"))?;
    match tool {
        "submit" => {
            let agent_id = agent_id
                .ok_or_else(|| anyhow!("plans.submit requires a server-bound calling agent"))?;
            let input: SubmitPlanInput =
                serde_json::from_value(arguments).context("invalid plans.submit input")?;
            service
                .submit(
                    agent_id,
                    &input.request_id,
                    input.plan,
                    host_conversation_id,
                )
                .await
        }
        "status" => {
            let agent_id = agent_id
                .ok_or_else(|| anyhow!("plans.status requires a server-bound calling agent"))?;
            let input: StatusInput =
                serde_json::from_value(arguments).context("invalid plans.status input")?;
            if let Some(receipt) = service.store.get_receipt(&input.execution_id).await? {
                let submission = service
                    .store
                    .get_submission(&receipt.submission_id)
                    .await?
                    .ok_or_else(|| anyhow!("execution '{}' not found", input.execution_id))?;
                require_submission_principal(
                    &submission,
                    agent_id,
                    host_conversation_id,
                    &input.execution_id,
                )?;
                return Ok(json!({"receipt": receipt, "status": receipt.status}));
            }
            let submission = service
                .store
                .get_submission(&input.execution_id)
                .await?
                .ok_or_else(|| anyhow!("execution '{}' not found", input.execution_id))?;
            require_submission_principal(
                &submission,
                agent_id,
                host_conversation_id,
                &input.execution_id,
            )?;
            service.submission_response(&submission).await
        }
        "catalog" => {
            let agent_id = agent_id
                .ok_or_else(|| anyhow!("plans.catalog requires a server-bound calling agent"))?;
            let (_, agent) = service.agent_revision(agent_id).await?;
            Ok(serde_json::to_value(
                service.catalog(Some(&agent.tools)).await?,
            )?)
        }
        _ => Err(anyhow!("unknown Safe Actions tool '{tool}'")),
    }
}

fn require_submission_principal(
    submission: &SubmissionRecord,
    agent_id: &str,
    host_conversation_id: Option<&str>,
    requested_id: &str,
) -> Result<()> {
    if submission.agent_id != agent_id
        || host_conversation_id.is_some()
            && submission.host_conversation_id.as_deref() != host_conversation_id
    {
        return Err(anyhow!("execution '{requested_id}' not found"));
    }
    Ok(())
}

const CORE_REDACTION_MARKER: &str = "[redacted by Core]";

fn redact_review_value(value: &mut PlanValue) {
    match value {
        PlanValue::Literal { value } => *value = Value::String(CORE_REDACTION_MARKER.to_owned()),
        PlanValue::Object { fields } => {
            for child in fields.values_mut() {
                redact_review_value(child);
            }
        }
        PlanValue::Array { items } => {
            for child in items {
                redact_review_value(child);
            }
        }
        PlanValue::StepOutput { .. } => {}
    }
}

fn redact_review_predicate(predicate: &mut Predicate) {
    match predicate {
        Predicate::Compare { left, right, .. } => {
            redact_review_value(left);
            redact_review_value(right);
        }
        Predicate::All { predicates } | Predicate::Any { predicates } => {
            for child in predicates {
                redact_review_predicate(child);
            }
        }
        Predicate::Not { predicate } => redact_review_predicate(predicate),
        Predicate::Exists { value } => redact_review_value(value),
    }
}

fn redact_review_node(node: &mut PlanNode) {
    match node {
        PlanNode::Call { arguments, .. } => redact_review_value(arguments),
        PlanNode::Sequence { nodes, .. } | PlanNode::Parallel { nodes, .. } => {
            for child in nodes {
                redact_review_node(child);
            }
        }
        PlanNode::If {
            predicate,
            then_node,
            else_node,
            ..
        } => {
            redact_review_predicate(predicate);
            redact_review_node(then_node);
            redact_review_node(else_node);
        }
    }
}

fn mark_review_calls_redacted(node: &mut Value) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("call") => {
            object.insert("arguments_redacted".to_owned(), Value::Bool(true));
        }
        Some("sequence" | "parallel") => {
            if let Some(nodes) = object.get_mut("nodes").and_then(Value::as_array_mut) {
                for child in nodes {
                    mark_review_calls_redacted(child);
                }
            }
        }
        Some("if") => {
            if let Some(child) = object.get_mut("then_node") {
                mark_review_calls_redacted(child);
            }
            if let Some(child) = object.get_mut("else_node") {
                mark_review_calls_redacted(child);
            }
        }
        _ => {}
    }
}

fn review_projection(record: &SubmissionRecord) -> Result<Value> {
    let mut projected = record.clone();
    redact_review_node(&mut projected.plan.root);
    let mut value = serde_json::to_value(projected)?;
    if let Some(root) = value.pointer_mut("/plan/root") {
        mark_review_calls_redacted(root);
    }
    Ok(value)
}

pub(crate) async fn authorize_verified_dispatch(
    agent_id: &str,
    tool_id: &str,
    arguments: &Value,
) -> Result<()> {
    let grant = VERIFIED_STEP_GRANT.try_with(Clone::clone).map_err(|_| {
        anyhow!("verified agent direct tool call denied; submit a plans.submit plan")
    })?;
    if grant.agent_id != agent_id {
        return Err(anyhow!("verified plan grant belongs to another agent"));
    }
    if !grant
        .allowed_tool_chain
        .iter()
        .any(|allowed| allowed == tool_id)
    {
        return Err(anyhow!(
            "tool '{tool_id}' is outside certified step '{}'",
            grant.step_id
        ));
    }
    if sha256_canonical(arguments)? != grant.arguments_hash {
        return Err(anyhow!(
            "arguments changed after step '{}' was certified",
            grant.step_id
        ));
    }
    let service = grant.service.clone();
    let registry = service.registry()?;
    if registry
        .verified_implementation_hash_for_id(tool_id)
        .await?
        != grant.implementation_hash
    {
        return Err(anyhow!(
            "tool '{tool_id}' implementation changed after certification"
        ));
    }
    let submission = service
        .store
        .get_submission(&grant.submission_id)
        .await?
        .ok_or_else(|| anyhow!("certified submission no longer exists"))?;
    if submission.status != "executing" || submission.agent_id != agent_id {
        return Err(anyhow!("certified submission is not executing"));
    }
    if CertificateBindings::from(&submission.report.bindings) != grant.bindings {
        return Err(anyhow!(
            "certified submission bindings changed before dispatch"
        ));
    }
    let receipt = service
        .store
        .get_receipt(&grant.submission_id)
        .await?
        .ok_or_else(|| anyhow!("certified execution receipt no longer exists"))?;
    if receipt.status != "running"
        || receipt.agent_id != agent_id
        || receipt.certificate_id != grant.certificate_id
    {
        return Err(anyhow!(
            "certified execution receipt does not match this dispatch"
        ));
    }
    validate_certificate(
        &grant.certificate,
        &grant.bindings,
        &submission.agent_revision,
        now_ms(),
    )?;
    Ok(())
}

fn execute_node<'a>(
    node: &'a PlanNode,
    context: &'a mut ExecutionContext,
) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        match node {
            PlanNode::Call {
                id,
                tool,
                arguments,
            } => {
                let verified_descriptor = revalidate_execution(context, tool).await?;
                let value = materialize(arguments, &context.outputs)?;
                if let Err(reason) = ryu_safe_actions::validate_runtime_value(
                    &value,
                    &verified_descriptor.input_schema,
                ) {
                    context.failure_status = Some("failed");
                    return Err(anyhow!(
                        "materialized arguments do not satisfy the revalidated input schema: {reason}"
                    ));
                }
                let arguments_hash = sha256_canonical(&value)?;
                context.ordinal = context.ordinal.saturating_add(1);
                let mut step = StepReceipt {
                    step_id: id.clone(),
                    ordinal: context.ordinal,
                    tool: tool.clone(),
                    arguments_hash: arguments_hash.clone(),
                    result_hash: None,
                    status: "running".to_owned(),
                    error: None,
                    started_at: chrono::Utc::now().to_rfc3339(),
                    finished_at: None,
                };
                context
                    .service
                    .store
                    .save_step(&context.receipt.id, &step)
                    .await?;
                let registry = context.service.registry()?;
                let grant = VerifiedStepGrant {
                    service: context.service.clone(),
                    submission_id: context.submission.id.clone(),
                    certificate_id: context.certificate_id.clone(),
                    agent_id: context.identity.agent_id.clone(),
                    step_id: id.clone(),
                    // Use the chain from the exact catalog snapshot that was
                    // just re-verified. Reloading it here would open an alias
                    // retarget race between certification and dispatch.
                    allowed_tool_chain: verified_descriptor.dispatch_chain.clone(),
                    implementation_hash: verified_descriptor.implementation_hash.clone(),
                    arguments_hash,
                    bindings: CertificateBindings::from(&context.submission.report.bindings),
                    certificate: context.certificate.clone(),
                };
                let output = match tokio::time::timeout(
                    Duration::from_secs(TOOL_EXECUTION_TIMEOUT_SECS),
                    VERIFIED_STEP_GRANT.scope(
                        grant,
                        registry.call_tool_with_identity_after_approval(
                            Some(&context.identity.agent_id),
                            tool,
                            value,
                            Some(&context.identity.allowlist),
                            None,
                            &context.identity.profile_ids,
                            None,
                            context.identity.host_conversation_id.as_deref(),
                        ),
                    ),
                )
                .await
                {
                    Ok(output) => output,
                    Err(_) => Err(anyhow!("tool execution timed out with an unknown outcome")),
                };
                step.finished_at = Some(chrono::Utc::now().to_rfc3339());
                match output {
                    Ok(output) => {
                        if output.get("__ryu_elicitation__").is_some() {
                            let error = anyhow!(
                                "tool '{tool}' needs an authenticated account connection; no action was executed"
                            );
                            step.status = "blocked".to_owned();
                            step.error = Some(sanitize_error(&error));
                            context.failure_status = Some("blocked");
                            context
                                .service
                                .store
                                .save_step(&context.receipt.id, &step)
                                .await?;
                            return Err(error);
                        }
                        let output_bytes = canonical_json(&output)?.len();
                        if output_bytes > MAX_STEP_OUTPUT_BYTES
                            || context.retained_output_bytes.saturating_add(output_bytes)
                                > MAX_EXECUTION_OUTPUT_BYTES
                        {
                            let error = anyhow!("tool output exceeded the safe output limit");
                            step.status = "uncertain".to_owned();
                            step.error = Some(sanitize_error(&error));
                            context
                                .service
                                .store
                                .save_step(&context.receipt.id, &step)
                                .await?;
                            return Err(error);
                        }
                        if let Err(reason) = ryu_safe_actions::validate_runtime_value(
                            &output,
                            &verified_descriptor.output_schema,
                        ) {
                            let error = anyhow!(
                                "tool output does not satisfy its revalidated output schema: {reason}"
                            );
                            step.status = "failed".to_owned();
                            step.error = Some(sanitize_error(&error));
                            context.failure_status = Some("failed");
                            context
                                .service
                                .store
                                .save_step(&context.receipt.id, &step)
                                .await?;
                            return Err(error);
                        }
                        context.retained_output_bytes =
                            context.retained_output_bytes.saturating_add(output_bytes);
                        step.status = "succeeded".to_owned();
                        step.result_hash = Some(sha256_canonical(&output)?);
                        context
                            .service
                            .store
                            .save_step(&context.receipt.id, &step)
                            .await?;
                        context.outputs.insert(id.clone(), output.clone());
                        Ok(output)
                    }
                    Err(error) => {
                        step.status = "uncertain".to_owned();
                        step.error = Some(sanitize_error(&error));
                        context
                            .service
                            .store
                            .save_step(&context.receipt.id, &step)
                            .await?;
                        Err(error)
                    }
                }
            }
            PlanNode::Sequence { nodes, .. } | PlanNode::Parallel { nodes, .. } => {
                // Parallel nodes are verified read-only. Core deliberately commits
                // their receipt order deterministically in v1; concurrency can be
                // added without changing plan semantics or certificate bindings.
                let mut values = Vec::with_capacity(nodes.len());
                for child in nodes {
                    values.push(execute_node(child, context).await?);
                }
                Ok(Value::Array(values))
            }
            PlanNode::If {
                predicate,
                then_node,
                else_node,
                ..
            } => {
                if evaluate_predicate(predicate, &context.outputs)? {
                    execute_node(then_node, context).await
                } else {
                    execute_node(else_node, context).await
                }
            }
        }
    })
}

async fn revalidate_execution(
    context: &mut ExecutionContext,
    tool: &str,
) -> Result<ToolDescriptor> {
    let (current, policy, agent) = context
        .service
        .verifier_input(
            &context.submission.agent_id,
            context.submission.plan.clone(),
            None,
        )
        .await?;
    let descriptor = current
        .catalog
        .iter()
        .find(|descriptor| descriptor.name == tool)
        .cloned()
        .ok_or_else(|| anyhow!("certified tool is no longer in the agent catalog"))?;
    let report = ryu_safe_actions::verify(&current);
    if report.decision == VerificationDecision::Denied
        || report.bindings != context.submission.report.bindings
        || policy.id != context.submission.policy_id
    {
        return Err(anyhow!(
            "certified bindings changed before the next tool dispatch"
        ));
    }
    validate_certificate(
        &context.certificate,
        &CertificateBindings::from(&report.bindings),
        &current.agent_revision,
        now_ms(),
    )?;
    context.identity.allowlist = agent.tools;
    context.identity.profile_ids = agent.identity_profile_ids;
    Ok(descriptor)
}

fn materialize(value: &PlanValue, outputs: &HashMap<String, Value>) -> Result<Value> {
    match value {
        PlanValue::Literal { value } => Ok(value.clone()),
        PlanValue::Object { fields } => fields
            .iter()
            .map(|(key, value)| Ok((key.clone(), materialize(value, outputs)?)))
            .collect::<Result<Map<String, Value>>>()
            .map(Value::Object),
        PlanValue::Array { items } => items
            .iter()
            .map(|value| materialize(value, outputs))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        PlanValue::StepOutput {
            step_id,
            pointer,
            value_type,
        } => {
            let output = outputs
                .get(step_id)
                .ok_or_else(|| anyhow!("step output '{step_id}' is unavailable"))?;
            let selected = if pointer.is_empty() {
                output
            } else {
                output.pointer(pointer).ok_or_else(|| {
                    anyhow!("step output '{step_id}' has no JSON pointer '{pointer}'")
                })?
            };
            if json_type(selected) != *value_type
                && !matches!(
                    (json_type(selected), value_type),
                    (JsonType::Integer, JsonType::Number)
                )
            {
                return Err(anyhow!(
                    "step output '{step_id}' has an unexpected runtime type"
                ));
            }
            Ok(selected.clone())
        }
    }
}

fn evaluate_predicate(predicate: &Predicate, outputs: &HashMap<String, Value>) -> Result<bool> {
    match predicate {
        Predicate::Compare { left, op, right } => {
            let left = materialize(left, outputs)?;
            let right = materialize(right, outputs)?;
            compare(&left, *op, &right)
        }
        Predicate::All { predicates } => {
            for item in predicates {
                if !evaluate_predicate(item, outputs)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Predicate::Any { predicates } => {
            for item in predicates {
                if evaluate_predicate(item, outputs)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Predicate::Not { predicate } => Ok(!evaluate_predicate(predicate, outputs)?),
        Predicate::Exists { value } => Ok(!materialize(value, outputs)?.is_null()),
    }
}

fn compare(left: &Value, op: ComparisonOp, right: &Value) -> Result<bool> {
    match op {
        ComparisonOp::Equal => Ok(left == right),
        ComparisonOp::NotEqual => Ok(left != right),
        ComparisonOp::LessThan
        | ComparisonOp::LessThanOrEqual
        | ComparisonOp::GreaterThan
        | ComparisonOp::GreaterThanOrEqual => {
            let order = match (left, right) {
                (Value::Number(left), Value::Number(right)) => integer_value(left)
                    .zip(integer_value(right))
                    .map(|(left, right)| left.cmp(&right)),
                (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
                _ => None,
            }
            .ok_or_else(|| anyhow!("predicate values are not order-comparable"))?;
            Ok(match op {
                ComparisonOp::LessThan => order.is_lt(),
                ComparisonOp::LessThanOrEqual => order.is_le(),
                ComparisonOp::GreaterThan => order.is_gt(),
                ComparisonOp::GreaterThanOrEqual => order.is_ge(),
                ComparisonOp::Equal | ComparisonOp::NotEqual => unreachable!(),
            })
        }
    }
}

fn integer_value(value: &serde_json::Number) -> Option<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
}

fn json_type(value: &Value) -> JsonType {
    match value {
        Value::Null => JsonType::Null,
        Value::Bool(_) => JsonType::Boolean,
        Value::Number(number) if number.is_i64() || number.is_u64() => JsonType::Integer,
        Value::Number(_) => JsonType::Number,
        Value::String(_) => JsonType::String,
        Value::Array(_) => JsonType::Array,
        Value::Object(_) => JsonType::Object,
    }
}

fn now_ms() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_contract_resource(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    !value.is_empty()
        && value.len() <= 1024
        && value.is_ascii()
        && value.bytes().all(|byte| byte.is_ascii_graphic())
        && !value.contains('*')
        && !value.contains('\\')
        && !lowered.contains("%2e")
        && !lowered.contains("%2f")
        && !lowered.contains("%5c")
        && !value
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
}

fn valid_contract_binding(binding: &ryu_safe_actions::ResourceBinding) -> bool {
    !binding.pointer.is_empty()
        && binding.pointer.len() <= 256
        && binding.pointer.starts_with('/')
        && binding.prefix.len() <= 256
        && binding.prefix.is_ascii()
        && binding.prefix.bytes().all(|byte| byte.is_ascii_graphic())
        && matches!(binding.prefix.as_bytes().last(), Some(b':' | b'/'))
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

fn require_operator(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    write: bool,
) -> std::result::Result<String, Response> {
    let node_org_id = crate::server::node_org_id();
    authorize_operator(
        caller.as_ref(),
        crate::sidecar::control_plane::is_managed_node(),
        node_org_id.as_deref(),
        write,
    )
    .map_err(|(status, message)| {
        (status, Json(json!({"ok": false, "error": message}))).into_response()
    })
}

fn authorize_operator(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    managed_node: bool,
    node_org_id: Option<&str>,
    write: bool,
) -> std::result::Result<String, (StatusCode, &'static str)> {
    if !managed_node {
        return Ok(caller
            .map(|identity| identity.user_id.clone())
            .unwrap_or_else(|| "local-operator".to_owned()));
    }
    let Some(node_org_id) = node_org_id else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Safe Actions is unavailable until managed-node registration completes",
        ));
    };
    let Some(identity) = caller.as_ref() else {
        return Err((
            StatusCode::FORBIDDEN,
            "authenticated Safe Actions operator required",
        ));
    };
    let required = if write {
        crate::identity_verify::OrgRole::Admin
    } else {
        crate::identity_verify::OrgRole::Viewer
    };
    if identity.org_id.as_deref() != Some(node_org_id) || !identity.role.satisfies(required) {
        return Err((StatusCode::FORBIDDEN, "Safe Actions operator access denied"));
    }
    Ok(identity.user_id.clone())
}

async fn list_policies(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async { Ok(json!({"policies": service(&state).store.list_policies().await?})) }).await
}

async fn get_policy(
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

async fn create_policy(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<PolicyInput>,
) -> Response {
    if let Err(response) = require_operator(&caller, true) {
        return response;
    }
    api(put_policy_record(service(&state), input, None)).await
}

async fn update_policy(
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

async fn put_policy_record(
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

async fn delete_policy(
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

async fn check_policy(
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

async fn get_catalog(
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

async fn list_verified_agents(
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

async fn put_contract(
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

async fn list_reviews(
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

async fn get_review(
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

async fn approve_review(
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

async fn deny_review(
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

async fn list_receipts(
    State(state): State<crate::server::ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = require_operator(&caller, false) {
        return response;
    }
    api(async { Ok(json!({"receipts": service(&state).store.list_receipts().await?})) }).await
}

async fn get_receipt(
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

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn conflict(error: impl std::fmt::Display) -> Self {
        tracing::warn!(error = %error, "Safe Actions concurrent update conflict");
        Self {
            status: StatusCode::CONFLICT,
            message: "Safe Actions data changed; reload the latest version and retry".to_owned(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
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

async fn api<F>(future: F) -> Response
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

#[cfg(test)]
mod tests {
    use super::*;

    struct SafeActionsTestHooks;

    impl crate::plugin_host::HookDispatch for SafeActionsTestHooks {
        fn dispatch<'a>(
            &'a self,
            phase: &'a str,
            ctx: crate::plugin_host::HookContext,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Vec<crate::plugin_host::HookDirective>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if phase == crate::plugin_host::ON_PRE_TOOL_USE
                    && ctx.tool_name.as_deref() == Some("app.echo")
                    && ctx.tool_input.as_ref().and_then(|value| value.get("hook"))
                        == Some(&json!("block"))
                {
                    return vec![crate::plugin_host::HookDirective::Deny {
                        reason: "blocked by the Safe Actions hook fixture".to_owned(),
                    }];
                }
                Vec::new()
            })
        }

        fn dispatch_tool_result<'a>(
            &'a self,
            ctx: crate::plugin_host::HookContext,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>>
        {
            Box::pin(async move {
                (ctx.tool_name.as_deref() == Some("app.echo")
                    && ctx.tool_input.as_ref().and_then(|value| value.get("hook"))
                        == Some(&json!("redact")))
                .then(|| json!({"value": "[redacted by hook]"}))
            })
        }
    }

    fn operator(
        org_id: Option<&str>,
        role: crate::identity_verify::OrgRole,
    ) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: "operator-1".to_owned(),
            email: None,
            org_id: org_id.map(str::to_owned),
            role,
            teams: Vec::new(),
        }
    }

    #[test]
    fn operator_authorization_fails_closed_for_unregistered_managed_nodes() {
        let admin = operator(Some("org-1"), crate::identity_verify::OrgRole::Admin);
        assert_eq!(
            authorize_operator(Some(&admin), true, None, true)
                .unwrap_err()
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            authorize_operator(None, true, Some("org-1"), false)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            authorize_operator(Some(&admin), true, Some("org-2"), true)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn operator_authorization_preserves_local_and_role_scoped_access() {
        assert_eq!(
            authorize_operator(None, false, None, true).unwrap(),
            "local-operator"
        );
        let viewer = operator(Some("org-1"), crate::identity_verify::OrgRole::Viewer);
        assert_eq!(
            authorize_operator(Some(&viewer), true, Some("org-1"), false).unwrap(),
            "operator-1"
        );
        assert_eq!(
            authorize_operator(Some(&viewer), true, Some("org-1"), true)
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        let admin = operator(Some("org-1"), crate::identity_verify::OrgRole::Admin);
        assert_eq!(
            authorize_operator(Some(&admin), true, Some("org-1"), true).unwrap(),
            "operator-1"
        );
    }

    #[test]
    fn materializes_nested_step_output() {
        let outputs = HashMap::from([("read".to_owned(), json!({"items": [7]}))]);
        let value = PlanValue::StepOutput {
            step_id: "read".to_owned(),
            pointer: "/items/0".to_owned(),
            value_type: JsonType::Integer,
        };
        assert_eq!(materialize(&value, &outputs).unwrap(), json!(7));
    }

    #[test]
    fn ordered_comparisons_reject_mixed_types() {
        assert!(compare(&json!(1), ComparisonOp::LessThan, &json!(2)).unwrap());
        assert!(compare(&json!(1), ComparisonOp::LessThan, &json!("2")).is_err());
        assert!(compare(&json!(1.1), ComparisonOp::LessThan, &json!(1.2)).is_err());
        assert!(compare(
            &json!(9_007_199_254_740_992_u64),
            ComparisonOp::LessThan,
            &json!(9_007_199_254_740_993_u64),
        )
        .unwrap());
    }

    #[test]
    fn review_projection_never_exposes_literal_arguments() {
        let plan = ToolPlan {
            schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
            root: PlanNode::Call {
                id: "send".to_owned(),
                tool: "mail.send".to_owned(),
                arguments: PlanValue::Literal {
                    value: json!({"token": "top-secret-review-value"}),
                },
            },
        };
        let report = ryu_safe_actions::verify(&VerifierInput {
            plan: plan.clone(),
            policy: Policy::default(),
            catalog: Vec::new(),
            agent_revision: "agent-revision".to_owned(),
        });
        let record = SubmissionRecord {
            id: "submission-1".to_owned(),
            submission_key: "request-key".to_owned(),
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
            created_at: "2026-08-23T00:00:00Z".to_owned(),
            updated_at: "2026-08-23T00:00:00Z".to_owned(),
        };

        let value = review_projection(&record).unwrap();
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("top-secret-review-value"));
        assert!(encoded.contains("[redacted by Core]"));
        assert_eq!(
            value.pointer("/plan/root/arguments_redacted"),
            Some(&Value::Bool(true))
        );
    }

    #[tokio::test]
    async fn verified_plan_executes_once_through_the_live_registry_boundary() {
        use crate::plugin_manifest::schema::RunnableEntry;
        use crate::plugin_manifest::PluginManifest;
        use crate::runnable::RunnableKind;
        use crate::sidecar::mcp::{AppToolBackendTag, RegistryTool};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::sync::RwLock;

        struct GatewayEnv {
            fallback: Option<std::ffi::OsString>,
            approval_mode: Option<std::ffi::OsString>,
        }
        impl Drop for GatewayEnv {
            fn drop(&mut self) {
                unsafe {
                    match self.fallback.take() {
                        Some(value) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", value),
                        None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
                    }
                    match self.approval_mode.take() {
                        Some(value) => std::env::set_var("RYU_EXEC_APPROVAL_MODE", value),
                        None => std::env::remove_var("RYU_EXEC_APPROVAL_MODE"),
                    }
                }
            }
        }

        let _gateway_env_lock = crate::sidecar::gateway::lock_gateway_env();
        let _gateway_env = GatewayEnv {
            fallback: std::env::var_os("RYU_ALLOW_GATEWAY_FALLBACK"),
            approval_mode: std::env::var_os("RYU_EXEC_APPROVAL_MODE"),
        };
        unsafe {
            std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
            std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/echo", listener.local_addr().unwrap());
        let echo = Router::new()
            .route(
                "/echo",
                post(
                    |State(counter): State<Arc<AtomicUsize>>, Json(body): Json<Value>| async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        let value = body.get("value").cloned().unwrap_or(Value::Null);
                        if value == json!("needs-auth") {
                            return Json(json!({
                                "__ryu_elicitation__": {
                                    "kind": "url",
                                    "message": "Connect the fixture account",
                                    "url": "https://example.invalid/connect"
                                }
                            }));
                        }
                        Json(json!({"value": value}))
                    },
                ),
            )
            .with_state(Arc::clone(&calls));
        let server = tokio::spawn(async move {
            axum::serve(listener, echo).await.unwrap();
        });

        let app_store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
        app_store.insert("com.test.echo", "1.0.0").await.unwrap();
        app_store
            .set_enabled("com.test.echo", &["tool:http-egress:127.0.0.1".to_owned()])
            .await
            .unwrap();
        let input_schema = json!({
            "type": "object",
            "properties": { "value": { "type": "string" } },
            "required": ["value"],
            "additionalProperties": false
        });
        let output_schema = input_schema.clone();
        let manifest = PluginManifest {
            id: "com.test.echo".to_owned(),
            name: "Echo fixture".to_owned(),
            version: "1.0.0".to_owned(),
            permission_grants: vec!["tool:http-egress:127.0.0.1".to_owned()],
            runnables: vec![RunnableEntry {
                id: "echo".to_owned(),
                name: "echo".to_owned(),
                kind: RunnableKind::Tool,
                config: Some(json!({
                    "slug": "echo",
                    "backend": "http",
                    "url": endpoint,
                    "method": "POST",
                    "unwrap_body": true,
                    "input_schema": input_schema,
                    "output_schema": output_schema,
                })),
            }],
            companion: None,
            ..Default::default()
        };
        let manifests = Arc::new(RwLock::new(vec![manifest]));
        let acp_registry = crate::sidecar::adapters::AcpAgentRegistry::new();
        let agent_store = crate::agents::AgentStore::open_in_memory(&acp_registry).unwrap();
        let create: crate::agents::CreateAgent = serde_json::from_value(json!({
            "name": "Verified echo",
            "safety_profile": "verified_plan_only",
            "tools": ["app.echo"]
        }))
        .unwrap();
        let created = agent_store.create(create).await.unwrap();
        let agent = agent_store
            .update(
                &created.id,
                crate::agents::UpdateAgent {
                    lifecycle_status: Some(crate::agents::AgentLifecycleStatus::Active),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();

        let registry = Arc::new(
            crate::sidecar::mcp::McpRegistry::empty()
                .with_self_build(manifests, app_store)
                .with_agent_store(agent_store),
        );
        registry.register_test_app_tool_descriptor(RegistryTool {
            id: "app.echo".to_owned(),
            server: "app".to_owned(),
            name: "echo".to_owned(),
            description: Some("Echo a value".to_owned()),
            input_schema: Some(input_schema.clone()),
            output_schema: Some(output_schema.clone()),
            annotations: Some(json!({"readOnlyHint": true})),
            meta: None,
            widget: None,
            widget_accessible: false,
            output_template: None,
            app_backend: Some(AppToolBackendTag::Http),
        });
        assert!(
            crate::plugin_host::set_global(Arc::new(SafeActionsTestHooks)),
            "the live-boundary test must own the process-global hook dispatcher"
        );
        let blocked = registry
            .call_tool_with_identity_after_approval(
                None,
                "app.echo",
                json!({"value": "must-not-run", "hook": "block"}),
                Some(&["app.echo".to_owned()]),
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(blocked.to_string().contains("blocked by a plugin hook"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let redacted = registry
            .call_tool_with_identity_after_approval(
                None,
                "app.echo",
                json!({"value": "secret result", "hook": "redact"}),
                Some(&["app.echo".to_owned()]),
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(redacted, json!({"value": "[redacted by hook]"}));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        calls.store(0, Ordering::SeqCst);
        let probe = registry
            .call_tool_with_identity_after_approval(
                None,
                "app.echo",
                json!({"value": "probe"}),
                Some(&["app.echo".to_owned()]),
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(probe, json!({"value": "probe"}));
        calls.store(0, Ordering::SeqCst);
        let store = SafeActionsStore::open_in_memory().unwrap();
        let service = SafeActionsService::with_registry(store.clone(), Arc::clone(&registry));
        let descriptor = service
            .catalog(Some(&agent.tools))
            .await
            .unwrap()
            .into_iter()
            .find(|tool| tool.name == "app.echo")
            .unwrap();
        let contract = ryu_safe_actions::EffectContract {
            trust: ContractTrust::OperatorAttested,
            effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
            resources: ["test://echo/value".to_owned()].into_iter().collect(),
            resource_bindings: Vec::new(),
            arguments_independent: true,
        };
        store
            .put_contract(
                ToolContractRecord {
                    tool: "app.echo".to_owned(),
                    contract: contract.clone(),
                    contract_hash: sha256_canonical(&contract).unwrap(),
                    implementation_hash: descriptor.implementation_hash,
                    attested_by: "operator-1".to_owned(),
                    created_at: String::new(),
                    updated_at: String::new(),
                },
                None,
                None,
            )
            .await
            .unwrap();
        let policy = Policy {
            allow_tools: ["app.echo".to_owned()].into_iter().collect(),
            deny_tools: Default::default(),
            allowed_effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
            allowed_resources: ["test://echo/*".to_owned()].into_iter().collect(),
            review_tools: Default::default(),
            review_effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
            allow_parallel_reads: false,
            limits: Default::default(),
        };
        let policy_hash = sha256_canonical(&policy).unwrap();
        let policy = store
            .put_policy(
                PolicyRecord {
                    id: "echo-policy".to_owned(),
                    name: "Echo policy".to_owned(),
                    description: None,
                    policy,
                    policy_hash,
                    version: 0,
                    bound_agent_ids: vec![agent.id.clone()],
                    created_at: String::new(),
                    updated_at: String::new(),
                },
                None,
            )
            .await
            .unwrap();

        let raw_error = registry
            .call_tool_with_identity(
                Some(&agent.id),
                "app.echo",
                json!({"value": "unsafe"}),
                Some(&agent.tools),
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(raw_error.to_string().contains("typed plan"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let plan = ToolPlan {
            schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
            root: PlanNode::Call {
                id: "echo".to_owned(),
                tool: "app.echo".to_owned(),
                arguments: PlanValue::Object {
                    fields: BTreeMap::from([(
                        "value".to_owned(),
                        PlanValue::Literal {
                            value: json!("verified"),
                        },
                    )]),
                },
            },
        };
        let pending = service
            .submit(&agent.id, "request-echo-1", plan.clone(), None)
            .await
            .unwrap();
        assert_eq!(pending.get("status"), Some(&json!("pending_review")));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let submission_id = pending
            .pointer("/submission/id")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned();
        let completed = service
            .approve(
                &submission_id,
                ReviewDecisionInput {
                    note: Some("verified test approval".to_owned()),
                },
                "operator-1".to_owned(),
            )
            .await
            .unwrap();
        assert_eq!(completed.get("status"), Some(&json!("succeeded")));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let receipt = store.get_receipt(&submission_id).await.unwrap().unwrap();
        assert_eq!(receipt.status, "succeeded");
        assert_eq!(receipt.steps.len(), 1);
        assert_eq!(receipt.steps[0].status, "succeeded");

        let auth_plan = ToolPlan {
            schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
            root: PlanNode::Call {
                id: "echo-auth".to_owned(),
                tool: "app.echo".to_owned(),
                arguments: PlanValue::Object {
                    fields: BTreeMap::from([(
                        "value".to_owned(),
                        PlanValue::Literal {
                            value: json!("needs-auth"),
                        },
                    )]),
                },
            },
        };
        let auth_pending = service
            .submit(&agent.id, "request-echo-auth", auth_plan, None)
            .await
            .unwrap();
        let auth_submission_id = auth_pending
            .pointer("/submission/id")
            .and_then(Value::as_str)
            .unwrap();
        let auth_blocked = service
            .approve(
                auth_submission_id,
                ReviewDecisionInput { note: None },
                "operator-1".to_owned(),
            )
            .await
            .unwrap_err();
        assert!(auth_blocked
            .to_string()
            .contains("tool execution did not complete"));
        let auth_receipt = store
            .get_receipt(auth_submission_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(auth_receipt.status, "blocked");
        assert_eq!(auth_receipt.steps[0].status, "blocked");
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        assert!(store
            .delete_policy(&policy.id, policy.version)
            .await
            .unwrap());
        let retry = service
            .submit(&agent.id, "request-echo-1", plan, None)
            .await
            .unwrap();
        assert_eq!(retry.get("status"), Some(&json!("succeeded")));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn raw_dispatch_has_no_implicit_verified_grant() {
        let error = authorize_verified_dispatch("agent", "files.delete", &json!({"id": 1}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("direct tool call denied"));
    }
}
