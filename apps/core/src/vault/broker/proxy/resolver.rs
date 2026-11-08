//! Per-request credential resolution under the session's policies.
//! test-exempt: moved out of proxy.rs; proxy_tests.rs covers machine, human, and password-manager resolution end to end.

use super::*;

/// Per-request credential resolution with a small cache, so a reference used
/// twice is resolved (and audited) once.
pub(super) struct Resolver {
    pub(super) store: &'static PluginSecretStore,
    pub(super) context: SecretResolutionContext,
    /// The session's environment, for unqualified references.
    pub(super) environment: String,
    /// The minting machine token's policies: each reference needs `use`
    /// under them (no baseline), so the machine's own grants and denies
    /// bound what its sessions can inject.
    pub(super) machine_policies: Option<Vec<Policy>>,
    /// A human minter's policy subjects (`user:`, `role:`, `team:`) captured
    /// at mint; `None` for machine sessions and sessions minted before they
    /// were recorded.
    pub(super) minter_subjects: Option<Vec<String>>,
    pub(super) cache: HashMap<String, String>,
    /// The session's minting principal: the consumer a password-manager
    /// grant names.
    pub(super) subject: String,
    pub(super) session_id: String,
}

/// Whether `policies` grant `use` on a `secret:` reference body, starting
/// from no capabilities (the machine-token baseline), with identity templates
/// expanded for the minting `subject` (`machine:<id>`).
pub(super) fn machine_may_use(
    policies: &[Policy],
    subject: &str,
    body: &str,
    environment: &str,
) -> bool {
    let Some(parsed) = SecretRef::parse(body) else {
        return false;
    };
    let key = crate::vault::policy_key(
        &parsed.environment_or(environment),
        &parsed.path,
        &parsed.name,
    );
    crate::vault::policy::evaluate_with(
        &CapabilitySet::new(),
        policies,
        &key,
        &crate::vault::policy_ext::TemplateContext::from_subjects(&[subject.to_owned()]),
    )
    .contains(&Capability::Use)
}

/// Whether a human minter's `subjects` keep `use` on a `secret:` reference
/// body. The baseline is `use`, so only explicit deny rules (including
/// `role:`/`team:` ones) refuse it.
pub(super) fn minter_may_use(
    policies: &[Policy],
    subjects: &[String],
    body: &str,
    environment: &str,
) -> bool {
    let body = body
        .strip_suffix(crate::plugin_secrets::kv::TOTP_SUFFIX)
        .unwrap_or(body);
    let Some(parsed) = SecretRef::parse(body) else {
        return false;
    };
    let key = crate::vault::policy_key(
        &parsed.environment_or(environment),
        &parsed.path,
        &parsed.name,
    );
    let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
    crate::vault::policy::evaluate_with(
        &use_only,
        policies,
        &key,
        &crate::vault::policy_ext::TemplateContext::from_subjects(subjects),
    )
    .contains(&Capability::Use)
}

impl Resolver {
    pub(super) async fn resolve(&mut self, reference: &str) -> Result<String, Refusal> {
        if let Some(value) = self.cache.get(reference) {
            return Ok(value.clone());
        }
        let unavailable = || {
            Refusal::new(
                StatusCode::BAD_GATEWAY,
                "credential_unavailable",
                &format!("`{reference}` could not be resolved for this session"),
            )
        };
        if let Some(text) = substitute::pm_ref_text(reference) {
            let value = self.resolve_password_manager(reference, text).await?;
            self.cache.insert(reference.to_owned(), value.clone());
            return Ok(value);
        }
        let body = reference.strip_prefix("secret:").ok_or_else(unavailable)?;
        if let Some(policies) = &self.machine_policies {
            if !machine_may_use(policies, &self.subject, body, &self.environment) {
                return Err(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "credential_denied",
                    &format!("the session's machine identity lacks `use` on `{reference}`"),
                ));
            }
        }
        if let Some(subjects) = self.minter_subjects.as_ref().filter(|s| !s.is_empty()) {
            let policies = {
                let conn = self.store.conn.lock().await;
                crate::vault::policy::policies_for(&conn, subjects)
            };
            let policies = policies.map_err(|error| {
                tracing::warn!("broker minter policy lookup failed: {error:#}");
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "policy lookup failed",
                )
            })?;
            if !minter_may_use(&policies, subjects, body, &self.environment) {
                return Err(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "credential_denied",
                    &format!("the session's minter may not use `{reference}`"),
                ));
            }
        }
        match self.store.resolve_vault_secret(body, &self.context).await {
            Ok(Some(value)) => {
                self.cache.insert(reference.to_owned(), value.clone());
                Ok(value)
            }
            Ok(None) => Err(unavailable()),
            Err(error) => {
                if error
                    .downcast_ref::<VaultError>()
                    .is_some_and(|e| matches!(e, VaultError::Sealed))
                {
                    return Err(Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_sealed",
                        "the vault is sealed",
                    ));
                }
                tracing::warn!("broker credential resolution failed: {error:#}");
                Err(unavailable())
            }
        }
    }
}

impl Resolver {
    /// Resolve a password-manager reference for the session's minting
    /// principal. Without a grant the request is refused with the pending
    /// approval's id and the provider is not contacted.
    pub(super) async fn resolve_password_manager(
        &self,
        reference: &str,
        text: &str,
    ) -> Result<String, Refusal> {
        use crate::vault::password_managers::{Consumer, PmOutcome};
        let consumer = Consumer {
            subject: crate::vault::password_managers::broker_subject(&self.subject),
            requested_by: format!("broker_session:{}", self.session_id),
            environment: self.environment.clone(),
            machine_policies: self.machine_policies.clone(),
            // A user-minted session carries its user's policies, including
            // the role and team subjects recorded at mint (deny rules hold); a
            // machine's are checked above, the operator has none.
            policy_subjects: if self.subject.starts_with("user:") {
                PluginSecretStore::context_subjects(&self.context)
            } else {
                Vec::new()
            },
        };
        let actor = crate::vault::audit::AuditActor::new("broker_session", Some(&self.session_id));
        match self.store.pm_resolve(text, &consumer, &actor).await {
            Ok(PmOutcome::Value(value)) => value.into_string().ok_or_else(|| {
                Refusal::new(
                    StatusCode::BAD_GATEWAY,
                    "credential_invalid",
                    "a credential is not valid UTF-8",
                )
            }),
            Ok(PmOutcome::Pending(proposal)) => Err(Refusal {
                response: json_response(
                    StatusCode::FORBIDDEN,
                    "credential_approval_required",
                    serde_json::json!({
                        "error": "credential_approval_required",
                        "message": format!(
                            "`{reference}` needs a human approval before this session can use it"
                        ),
                        "approvalId": proposal.id,
                        "pollUrl": format!("{PROPOSALS_ENDPOINT}/{}", proposal.id),
                    }),
                ),
                outcome: "credential_approval_required",
            }),
            Err(error) => {
                let refusal = match error.downcast_ref::<VaultError>() {
                    Some(VaultError::Sealed) => Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_sealed",
                        "the vault is sealed",
                    ),
                    Some(VaultError::AuditUnavailable) => Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_audit_unavailable",
                        "the credential use could not be audited",
                    ),
                    Some(VaultError::Denied(_)) => Refusal::new(
                        StatusCode::FORBIDDEN,
                        "credential_denied",
                        &format!("the session's principal may not use `{reference}`"),
                    ),
                    _ => Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "credential_unavailable",
                        &format!("`{reference}` could not be resolved for this session"),
                    ),
                };
                tracing::warn!("broker password-manager resolution failed: {error:#}");
                Err(refusal)
            }
        }
    }
}
