//! The `plans.*` MCP tool dispatch, review projections, and the verified-step
//! grant check every raw tool dispatch passes through.

use super::*;

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

pub(super) fn require_submission_principal(
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

pub(super) fn redact_review_value(value: &mut PlanValue) {
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

pub(super) fn redact_review_predicate(predicate: &mut Predicate) {
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

pub(super) fn redact_review_node(node: &mut PlanNode) {
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

pub(super) fn mark_review_calls_redacted(node: &mut Value) {
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

pub(super) fn review_projection(record: &SubmissionRecord) -> Result<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
