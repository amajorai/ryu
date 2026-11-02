//! Plan-node execution and the value, predicate, and contract helpers it uses.

use super::*;

pub(super) fn execute_node<'a>(
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

pub(super) async fn revalidate_execution(
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

pub(super) fn materialize(value: &PlanValue, outputs: &HashMap<String, Value>) -> Result<Value> {
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

pub(super) fn evaluate_predicate(
    predicate: &Predicate,
    outputs: &HashMap<String, Value>,
) -> Result<bool> {
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

pub(super) fn compare(left: &Value, op: ComparisonOp, right: &Value) -> Result<bool> {
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

pub(super) fn integer_value(value: &serde_json::Number) -> Option<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
}

pub(super) fn json_type(value: &Value) -> JsonType {
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

pub(super) fn now_ms() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}

pub(super) fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(super) fn valid_contract_resource(value: &str) -> bool {
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

pub(super) fn valid_contract_binding(binding: &ryu_safe_actions::ResourceBinding) -> bool {
    !binding.pointer.is_empty()
        && binding.pointer.len() <= 256
        && binding.pointer.starts_with('/')
        && binding.prefix.len() <= 256
        && binding.prefix.is_ascii()
        && binding.prefix.bytes().all(|byte| byte.is_ascii_graphic())
        && matches!(binding.prefix.as_bytes().last(), Some(b':' | b'/'))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
