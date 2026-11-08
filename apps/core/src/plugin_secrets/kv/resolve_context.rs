//! Candidate lookup for a resolution context, use audits, templates, and
//! effective values.

use super::*;

impl PluginSecretStore {
    pub(super) async fn find_for_context(
        &self,
        environment: &str,
        path: &str,
        name: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<Resolved>> {
        let actor = match &context.user_id {
            Some(user) => AuditActor::new("user", Some(user)),
            None => AuditActor::new("agent", None),
        };
        // Without the owner's verified roles and teams, the `role:`/`team:`
        // denies that bind them cannot be evaluated: fail closed.
        if context.principal_unverified {
            let mut entry = AuditEntry::new(&actor, "secret.use", "denied").details(json!({
                "conversationId": context.conversation_id,
                "mcpIds": context.mcp_ids,
                "reason": "principal_unverified",
            }));
            entry.environment = Some(environment.to_owned());
            entry.path = Some(path.to_owned());
            entry.name = Some(name.to_owned());
            self.audit(&entry).await;
            return Ok(None);
        }
        // A chat run's project comes from its workspace folder's mapping.
        let derived = crate::vault::run_project::with_run_project(context).await;
        let context = derived.as_ref();
        let scopes = Self::candidate_scopes(context);
        let subjects = Self::context_subjects(context);
        let templates = crate::vault::policy_ext::TemplateContext::from_subjects(&subjects);
        let (chain, policies) = {
            let conn = self.conn.lock().await;
            (
                Self::folder_chain(&conn, environment, path)?,
                policy::policies_for(&conn, &subjects)?,
            )
        };
        let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
        let now = now_millis();
        let mut denied = false;
        for (scope, scope_id) in &scopes {
            let shared = crate::vault::shared::is_enabled();
            if matches!(
                scope,
                SecretScope::Project | SecretScope::Team | SecretScope::Org
            ) && shared
            {
                let key = policy_key(environment, path, name);
                if !policy::evaluate_with(&use_only, &policies, &key, &templates)
                    .contains(&Capability::Use)
                {
                    denied = true;
                } else if let Some(shared) = crate::vault::shared::resolve(
                    context,
                    *scope,
                    scope_id,
                    environment,
                    path,
                    name,
                )
                .await
                {
                    let resolved = Resolved {
                        value: shared.value,
                        coords: SecretCoords {
                            scope: *scope,
                            scope_id: scope_id.clone(),
                            environment: shared.environment,
                            path: shared.path,
                            binding: None,
                            name: name.to_owned(),
                        },
                        version: shared.version,
                        expand: shared.expand_references,
                        source: "shared",
                    };
                    if !self.audit_use(&actor, context, &resolved, "ok").await {
                        return Err(VaultError::AuditUnavailable.into());
                    }
                    return Ok(Some(resolved));
                }
            }
            // Project values live only in the control plane.
            if *scope == SecretScope::Project {
                continue;
            }
            for (folder_env, folder_path) in &chain {
                let key = policy_key(folder_env, folder_path, name);
                if !policy::evaluate_with(&use_only, &policies, &key, &templates)
                    .contains(&Capability::Use)
                {
                    denied = true;
                    continue;
                }
                // A node folder with a live external source resolves only
                // through the store; an outage fails the whole lookup closed.
                if *scope == SecretScope::Node {
                    use crate::vault::external::LiveLookup;
                    match self
                        .external_live_lookup(scope_id, folder_env, folder_path, name)
                        .await?
                    {
                        LiveLookup::NotSourced => {}
                        LiveLookup::Missing => continue,
                        LiveLookup::Found { value, version } => {
                            let resolved = Resolved {
                                value,
                                coords: SecretCoords {
                                    scope: *scope,
                                    scope_id: scope_id.clone(),
                                    environment: folder_env.clone(),
                                    path: folder_path.clone(),
                                    binding: None,
                                    name: name.to_owned(),
                                },
                                version,
                                expand: false,
                                source: "external",
                            };
                            if !self.audit_use(&actor, context, &resolved, "ok").await {
                                return Err(VaultError::AuditUnavailable.into());
                            }
                            return Ok(Some(resolved));
                        }
                        LiveLookup::Unavailable => {
                            let entry = AuditEntry::new(&actor, "secret.use", "unavailable")
                                .secret("node", scope_id, folder_env, folder_path, name)
                                .details(json!({ "conversationId": context.conversation_id }));
                            self.audit(&entry).await;
                            return Ok(None);
                        }
                    }
                }
                let bindings = context
                    .mcp_ids
                    .iter()
                    .filter(|id| is_valid_scope_id(id))
                    .map(|id| {
                        Some(SecretBinding {
                            kind: SecretBindingKind::Mcp,
                            id: id.clone(),
                        })
                    })
                    .chain(std::iter::once(None));
                for binding in bindings {
                    let coords = SecretCoords {
                        scope: *scope,
                        scope_id: scope_id.clone(),
                        environment: folder_env.clone(),
                        path: folder_path.clone(),
                        binding,
                        name: name.to_owned(),
                    };
                    match self.current_value(&coords, now).await? {
                        CurrentValue::Value {
                            value,
                            version,
                            expand,
                        } => {
                            let resolved = Resolved {
                                value,
                                coords,
                                version,
                                expand,
                                source: "local",
                            };
                            if !self.audit_use(&actor, context, &resolved, "ok").await {
                                return Err(VaultError::AuditUnavailable.into());
                            }
                            return Ok(Some(resolved));
                        }
                        CurrentValue::Expired => {
                            let mut entry =
                                coords.audit(AuditEntry::new(&actor, "secret.use", "expired"));
                            entry.details = json!({ "conversationId": context.conversation_id });
                            self.audit(&entry).await;
                        }
                        CurrentValue::Missing => {}
                    }
                }
            }
        }
        let outcome = if denied { "denied" } else { "not_found" };
        let mut entry = AuditEntry::new(&actor, "secret.use", outcome).details(json!({
            "conversationId": context.conversation_id,
            "mcpIds": context.mcp_ids,
        }));
        entry.environment = Some(environment.to_owned());
        entry.path = Some(path.to_owned());
        entry.name = Some(name.to_owned());
        self.audit(&entry).await;
        Ok(None)
    }

    pub(super) async fn audit_use(
        &self,
        actor: &AuditActor,
        context: &SecretResolutionContext,
        resolved: &Resolved,
        outcome: &str,
    ) -> bool {
        let entry =
            resolved.coords.audit(
                AuditEntry::new(actor, "secret.use", outcome).details(json!({
                    "version": resolved.version,
                    "source": resolved.source,
                    "binding": resolved.coords.binding,
                    "conversationId": context.conversation_id,
                    "mcpIds": context.mcp_ids,
                })),
            );
        let permitted = self.audit(&entry).await;
        crate::vault::shared::forward_gateway_audit(
            &resolved.coords.policy_key(),
            context.user_id.clone(),
            context.conversation_id.clone(),
        );
        permitted
    }

    pub(super) async fn current_value(
        &self,
        coords: &SecretCoords,
        now: i64,
    ) -> Result<CurrentValue> {
        let (binding_kind, binding_id) = coords.binding_parts();
        let row: Option<(u32, Vec<u8>, Vec<u8>, i64, Option<i64>, i64)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT key_version, nonce, ciphertext, version, expires_at, expand_references
                 FROM vault_secrets
                 WHERE scope = ?1 AND scope_id = ?2 AND environment = ?3 AND path = ?4
                   AND binding_kind = ?5 AND binding_id = ?6 AND name = ?7
                   AND deleted_at IS NULL",
                params![
                    coords.scope.as_str(),
                    coords.scope_id,
                    coords.environment,
                    coords.path,
                    binding_kind,
                    binding_id,
                    coords.name
                ],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .context("reading vault_secrets")?
        };
        let Some((key_version, nonce, ciphertext, version, expires_at, expand)) = row else {
            return Ok(CurrentValue::Missing);
        };
        if expires_at.is_some_and(|at| at <= now) {
            return Ok(CurrentValue::Expired);
        }
        match self.open_row(key_version, &nonce, &ciphertext) {
            Ok(plain) => Ok(CurrentValue::Value {
                value: String::from_utf8_lossy(&plain).into_owned(),
                version,
                expand: expand != 0,
            }),
            Err(error) => {
                tracing::warn!(
                    scope = coords.scope.as_str(),
                    name = coords.name,
                    "vault secret could not be decrypted; treating it as unset: {error:#}"
                );
                Ok(CurrentValue::Missing)
            }
        }
    }

    /// Resolve `secret:` tokens inside a server-side MCP header or environment
    /// template. Literal text is preserved exactly. If any secret reference is
    /// unavailable, the whole template is absent so a caller never
    /// accidentally sends the literal reference upstream. `secret:op://…` and
    /// `secret:bws://…` resolve through a password-manager account once a
    /// human approved the owner's use (see [`crate::vault::password_managers`]).
    pub async fn resolve_vault_template(
        &self,
        template: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        let mut out = String::with_capacity(template.len());
        let mut cursor = 0;
        let mut saw_reference = false;

        while cursor < template.len() {
            let rest = &template[cursor..];
            let whitespace_len = rest
                .chars()
                .take_while(|character| character.is_whitespace())
                .map(char::len_utf8)
                .sum::<usize>();
            if whitespace_len > 0 {
                out.push_str(&rest[..whitespace_len]);
                cursor += whitespace_len;
                continue;
            }

            let word_len = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let word = &rest[..word_len];
            cursor += word_len;
            let Some(body) = word.strip_prefix("secret:") else {
                out.push_str(word);
                continue;
            };
            saw_reference = true;
            // `secret:op://…` / `secret:bws://…`: a password-manager reference,
            // resolved behind per-consumer approval (absent while pending).
            let value = if crate::vault::password_managers::has_pm_scheme(body) {
                self.pm_resolve_for_runtime(body, context).await?
            } else {
                self.resolve_vault_secret(body, context).await?
            };
            let Some(value) = value else {
                return Ok(None);
            };
            out.push_str(&value);
        }

        if saw_reference {
            Ok(Some(out))
        } else {
            Ok(Some(template.to_owned()))
        }
    }

    /// The effective local values a context would resolve in one folder (and
    /// its imports), keyed by name, for `export`/`run`. Precedence matches
    /// runtime resolution. Values the context may not `read` are skipped by the
    /// caller through `allow`; sealed values are never returned.
    pub async fn effective_local_values(
        &self,
        context: &SecretResolutionContext,
        environment: &str,
        path: &str,
        allow: impl Fn(&SecretCoords) -> bool,
    ) -> Result<BTreeMap<String, (SecretCoords, String)>> {
        Ok(self
            .effective_local_values_and_withheld(context, environment, path, allow)
            .await?
            .0)
    }

    /// [`Self::effective_local_values`] plus the names a readable sealed value
    /// holds. Those names resolve to the sealed value at run time, so a caller
    /// that merges values from another tier (the control plane's shared
    /// values) must drop them too, or a shadowed value would stand in.
    pub async fn effective_local_values_and_withheld(
        &self,
        context: &SecretResolutionContext,
        environment: &str,
        path: &str,
        allow: impl Fn(&SecretCoords) -> bool,
    ) -> Result<(BTreeMap<String, (SecretCoords, String)>, BTreeSet<String>)> {
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let chain = {
            let conn = self.conn.lock().await;
            Self::folder_chain(&conn, environment, &path)?
        };
        let scopes = Self::candidate_scopes(context);
        let now = now_millis();
        let listing = self.list_vault_secrets().await?;
        let mut out: BTreeMap<String, (SecretCoords, String)> = BTreeMap::new();
        // Sealed names are withheld, but they still win their name so a
        // lower-precedence value never stands in for them.
        let mut withheld: BTreeSet<String> = BTreeSet::new();
        for (scope, scope_id) in &scopes {
            for (folder_env, folder_path) in &chain {
                for info in listing.iter().filter(|info| {
                    &info.scope == scope
                        && &info.scope_id == scope_id
                        && &info.environment == folder_env
                        && &info.path == folder_path
                        && info.binding.is_none()
                }) {
                    if out.contains_key(&info.name) || withheld.contains(&info.name) {
                        continue;
                    }
                    let coords = info.coords();
                    if !allow(&coords) {
                        continue;
                    }
                    if !info.metadata.value_type.is_revealable() {
                        withheld.insert(info.name.clone());
                        continue;
                    }
                    if let CurrentValue::Value { value, .. } =
                        self.current_value(&coords, now).await?
                    {
                        out.insert(info.name.clone(), (coords, value));
                    }
                }
            }
        }
        Ok((out, withheld))
    }
}
