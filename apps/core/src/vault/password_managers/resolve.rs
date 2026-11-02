//! Reference resolution on [`PluginSecretStore`]: the explicit and broker path
//! ([`PluginSecretStore::pm_resolve`]) and runtime templates.
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by tests.rs (approval,
//! grant-channel, runtime-template and fail-closed audit resolution tests).

use super::*;

impl PluginSecretStore {
    // ── Resolution ────────────────────────────────────────────────────────

    /// Resolve a reference for `consumer`: a value when a grant covers it,
    /// otherwise the pending approval request (the provider is not
    /// contacted). Every outcome is audited without the value.
    pub async fn pm_resolve(
        &self,
        text: &str,
        consumer: &Consumer,
        actor: &AuditActor,
    ) -> Result<PmOutcome> {
        let reference = PmRef::parse(text)
            .ok_or_else(|| invalid(format!("invalid password-manager reference `{text}`")))?;
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let environment = if is_valid_environment(&consumer.environment) {
            consumer.environment.clone()
        } else {
            crate::vault::DEFAULT_ENVIRONMENT.to_owned()
        };
        let now = now_millis();
        let (account, qualified, grant, consumed, token) = {
            let conn = self.conn.lock().await;
            let account = select_account(&conn, &reference)?;
            let qualified = reference.qualified(&account.name);
            let details = json!({
                "provider": account.provider.as_str(),
                "account": account.name,
                "ref": qualified,
                "subject": consumer.subject,
            });
            if let Some(policies) = &consumer.machine_policies {
                let caps = crate::vault::policy::evaluate(
                    &CapabilitySet::new(),
                    policies,
                    &account_key(&account.name),
                );
                if !caps.contains(&Capability::Use) {
                    self.audit_locked(
                        &conn,
                        &AuditEntry::new(actor, "pm.resolve", "denied").details(details),
                    );
                    return Err(VaultError::Denied(format!(
                        "the machine identity lacks `use` on `{}`",
                        account_key(&account.name)
                    ))
                    .into());
                }
            }
            if !consumer.policy_subjects.is_empty() {
                let policies =
                    crate::vault::policy::policies_for(&conn, &consumer.policy_subjects)?;
                let templates = crate::vault::policy_ext::TemplateContext::from_subjects(
                    &consumer.policy_subjects,
                );
                let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
                let caps = crate::vault::policy::evaluate_with(
                    &use_only,
                    &policies,
                    &account_key(&account.name),
                    &templates,
                );
                if !caps.contains(&Capability::Use) {
                    self.audit_locked(
                        &conn,
                        &AuditEntry::new(actor, "pm.resolve", "denied").details(details),
                    );
                    return Err(VaultError::Denied(format!(
                        "a policy denies `use` on `{}`",
                        account_key(&account.name)
                    ))
                    .into());
                }
            }
            let Some((grant, consumed)) =
                take_grant(&conn, &consumer.subject, &account.id, &qualified, now)?
            else {
                let proposal = proposals::create_credential_use(
                    &conn,
                    CredentialUse {
                        reference: qualified.clone(),
                        account_id: account.id.clone(),
                        account: account.name.clone(),
                        provider: account.provider.as_str().to_owned(),
                        subject: consumer.subject.clone(),
                    },
                    &environment,
                    &consumer.requested_by,
                )?;
                let mut details = details;
                details["approval"] = json!(proposal.id);
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", "pending").details(details),
                );
                return Ok(PmOutcome::Pending(proposal));
            };
            let token = match self.pm_token_locked(&conn, &account.id) {
                Ok(token) => token,
                Err(error) => {
                    restore_grant(&conn, &grant, consumed);
                    return Err(error);
                }
            };
            (account, qualified, grant, consumed, token)
        };
        let fetched = providers::fetch(&account, &token, &reference).await;
        drop(token);
        let fetched = fetched.and_then(|value| {
            if value.as_bytes().is_empty() {
                Err(ProviderFailure {
                    kind: FailureKind::NotFound,
                    message: "the reference resolved to an empty value".into(),
                })
            } else if value.as_bytes().len() > MAX_VAULT_SECRET_VALUE_LEN {
                Err(ProviderFailure {
                    kind: FailureKind::Unavailable,
                    message: "the value is too large".into(),
                })
            } else {
                Ok(value)
            }
        });
        let conn = self.conn.lock().await;
        let checked = match &fetched {
            Ok(_) => Ok(()),
            Err(failure) => Err(failure),
        };
        if let Err(error) = record_check(&conn, &account.id, checked) {
            tracing::warn!("recording password-manager account state failed: {error:#}");
        }
        let details = json!({
            "provider": account.provider.as_str(),
            "account": account.name,
            "ref": qualified,
            "subject": consumer.subject,
            "grant": grant.id,
        });
        match fetched {
            Ok(value) => {
                let permitted = self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", "ok").details(details),
                );
                if !permitted {
                    restore_grant(&conn, &grant, consumed);
                    drop(value);
                    return Err(VaultError::AuditUnavailable.into());
                }
                Ok(PmOutcome::Value(value))
            }
            Err(failure) => {
                restore_grant(&conn, &grant, consumed);
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "pm.resolve", failure_outcome(failure.kind))
                        .details(details),
                );
                Err(anyhow::Error::new(failure))
            }
        }
    }

    /// `secret:op://…` / `secret:bws://…` in a runtime template: the MCP
    /// server or plugin that asked (the context's first MCP id), running for
    /// its owner (`user:<id>`, else `node:<id>`), is the consumer, so a grant
    /// covers that server alone. The owner's user, team, and role policies
    /// must not deny `use` on the account. A pending approval, a denial, or a
    /// provider failure leaves the reference absent (resolution stops); a
    /// sealed vault or a refused fail-closed audit is an error.
    pub(crate) async fn pm_resolve_for_runtime(
        &self,
        text: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        let actor = match &context.user_id {
            Some(user) => AuditActor::new("user", Some(user)),
            None => AuditActor::new("agent", None),
        };
        // The owner's role and team denies are unknown: fail closed, and
        // record the refused use like any other `pm.resolve` denial.
        if context.principal_unverified {
            tracing::warn!(
                "password-manager reference unresolved: the owner's principal is unverified"
            );
            self.audit(
                &AuditEntry::new(&actor, "pm.resolve", "denied").details(json!({
                    "ref": PmRef::parse(text).map(|_| text),
                    "mcpIds": context.mcp_ids,
                    "conversationId": context.conversation_id,
                    "reason": "principal_unverified",
                })),
            )
            .await;
            return Ok(None);
        }
        let owner = match &context.user_id {
            Some(user) => format!("user:{user}"),
            None => format!("node:{}", context.node_id),
        };
        let Some(subject) = context
            .mcp_ids
            .first()
            .and_then(|mcp_id| runtime_subject(mcp_id, &owner))
        else {
            tracing::warn!(
                "password-manager reference unresolved: the runtime context names no MCP server"
            );
            return Ok(None);
        };
        let environment = context
            .environment
            .clone()
            .filter(|environment| is_valid_environment(environment))
            .unwrap_or_else(crate::vault::active_environment);
        let consumer = Consumer {
            subject: subject.clone(),
            requested_by: subject,
            environment,
            machine_policies: None,
            policy_subjects: Self::context_subjects(context),
        };
        match self.pm_resolve(text, &consumer, &actor).await {
            Ok(PmOutcome::Value(value)) => Ok(value.into_string()),
            Ok(PmOutcome::Pending(proposal)) => {
                tracing::info!(
                    approval = proposal.id,
                    "password-manager reference awaits approval"
                );
                Ok(None)
            }
            Err(error)
                if error.downcast_ref::<VaultError>().is_some_and(|e| {
                    matches!(e, VaultError::Sealed | VaultError::AuditUnavailable)
                }) =>
            {
                Err(error)
            }
            Err(error) => {
                tracing::warn!("password-manager reference unresolved: {error:#}");
                Ok(None)
            }
        }
    }
}
