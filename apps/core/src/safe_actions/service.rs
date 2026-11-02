//! Verification and submission for [`SafeActionsService`]: the attested
//! catalog, the bound agent revision, and plan submission.

use super::*;

impl SafeActionsService {
    pub(super) async fn catalog(
        &self,
        allowed_tools: Option<&[String]>,
    ) -> Result<Vec<ToolDescriptor>> {
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

    pub(super) async fn agent_revision(
        &self,
        agent_id: &str,
    ) -> Result<(String, crate::agents::AgentRecord)> {
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

    pub(super) async fn verifier_input(
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

    pub(super) async fn submit(
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

    pub(super) async fn submission_response(&self, submission: &SubmissionRecord) -> Result<Value> {
        let receipt = self.store.get_receipt(&submission.id).await?;
        Ok(json!({
            "submission": submission,
            "review": submission,
            "receipt": receipt,
            "execution_id": receipt.as_ref().map(|item| item.id.as_str()).unwrap_or(submission.id.as_str()),
            "status": receipt.as_ref().map(|item| item.status.as_str()).unwrap_or(submission.status.as_str()),
        }))
    }
}
