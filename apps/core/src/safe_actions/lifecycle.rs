//! Execution and review decisions for [`SafeActionsService`]: running a
//! certified plan and approving or denying a pending review.

use super::*;

impl SafeActionsService {
    pub(super) async fn execute(&self, mut submission: SubmissionRecord) -> Result<Value> {
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

    pub(super) async fn approve(
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
        if decision.expected_plan_hash.is_empty()
            || decision.expected_plan_hash != submission.report.bindings.plan_hash
        {
            return Err(anyhow!(
                "review plan binding does not match the persisted submission"
            ));
        }
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

    pub(super) async fn deny(
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
        if decision.expected_plan_hash.is_empty()
            || decision.expected_plan_hash != submission.report.bindings.plan_hash
        {
            return Err(anyhow!(
                "review plan binding does not match the persisted submission"
            ));
        }
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
