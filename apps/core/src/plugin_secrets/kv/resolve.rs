//! `secret:` reference resolution and folder chains.

use super::*;

/// What one resolution found.
pub(super) struct Resolved {
    pub(super) value: String,
    pub(super) coords: SecretCoords,
    pub(super) version: i64,
    pub(super) expand: bool,
    pub(super) source: &'static str,
}

pub(super) enum CurrentValue {
    Value {
        value: String,
        version: i64,
        expand: bool,
    },
    Expired,
    Missing,
}

impl PluginSecretStore {
    // ── Resolution ────────────────────────────────────────────────────────

    /// Resolve one `secret:` reference body against the server-derived
    /// context. The first matching candidate wins according to `user > node >
    /// team > org`; within each scope the folder comes before its imports and
    /// an exact MCP binding wins over an unbound value. No caller-supplied
    /// identity is accepted here.
    pub async fn resolve_vault_secret(
        &self,
        body: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        // `secret:NAME#totp` resolves a stored TOTP seed (Base32 or
        // `otpauth://totp/` URL) to its current code; a value that is not a
        // seed is absent rather than sent upstream as the raw value.
        let (body, totp) = match body.strip_suffix(TOTP_SUFFIX) {
            Some(stripped) => (stripped, true),
            None => (body, false),
        };
        let Some(reference) = SecretRef::parse(body) else {
            bail!("invalid vault secret reference");
        };
        let mut visited = Vec::new();
        let value = self
            .resolve_reference(reference, context, 0, &mut visited)
            .await?;
        if !totp {
            return Ok(value);
        }
        Ok(value.and_then(|seed| crate::vault::totp::current_code_from_seed_value(&seed)))
    }

    pub(super) fn resolve_reference<'a>(
        &'a self,
        reference: SecretRef,
        context: &'a SecretResolutionContext,
        depth: usize,
        visited: &'a mut Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>>> + Send + 'a>>
    {
        Box::pin(async move {
            let active = context
                .environment
                .clone()
                .filter(|env| is_valid_environment(env))
                .unwrap_or_else(crate::vault::active_environment);
            let environment = reference.environment_or(&active);
            let key = policy_key(&environment, &reference.path, &reference.name);
            if visited.contains(&key) || depth > MAX_REFERENCE_DEPTH {
                return Ok(None);
            }
            // `visited` is the current recursion stack, not every key seen: a
            // value may use the same reference twice (`${A}:${A}`) without
            // that being a cycle.
            visited.push(key);
            let result = match self
                .find_for_context(&environment, &reference.path, &reference.name, context)
                .await
            {
                Err(error) => Err(error),
                Ok(None) => Ok(None),
                Ok(Some(found)) if !found.expand => Ok(Some(found.value)),
                Ok(Some(found)) => {
                    self.expand_references(&found, context, depth + 1, visited)
                        .await
                }
            };
            visited.pop();
            result
        })
    }

    pub(super) async fn expand_references(
        &self,
        found: &Resolved,
        context: &SecretResolutionContext,
        depth: usize,
        visited: &mut Vec<String>,
    ) -> Result<Option<String>> {
        let value = &found.value;
        let mut out = String::with_capacity(value.len());
        let mut rest = value.as_str();
        while let Some(start) = rest.find("${") {
            // `$${` escapes a literal `${`.
            if start > 0 && rest.as_bytes()[start - 1] == b'$' {
                out.push_str(&rest[..start - 1]);
                out.push_str("${");
                rest = &rest[start + 2..];
                continue;
            }
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else {
                out.push_str(&rest[start..]);
                rest = "";
                break;
            };
            let inner = after[..end].trim();
            let body = if inner.contains(':') {
                inner.to_owned()
            } else if inner.starts_with('/') || found.coords.path == ROOT_PATH {
                format!("{}:{inner}", found.coords.environment)
            } else {
                format!("{}:{}/{inner}", found.coords.environment, found.coords.path)
            };
            let Some(reference) = SecretRef::parse(&body) else {
                return Ok(None);
            };
            let Some(resolved) = self
                .resolve_reference(reference, context, depth, visited)
                .await?
            else {
                // Fail closed: a partially expanded credential is never sent.
                return Ok(None);
            };
            out.push_str(&resolved);
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Ok(Some(out))
    }

    /// The folder lookup chain: the folder, then its imports (depth-limited).
    pub(super) fn folder_chain(
        conn: &Connection,
        environment: &str,
        path: &str,
    ) -> Result<Vec<(String, String)>> {
        let imports = list_imports_locked(conn)?;
        let mut chain = vec![(environment.to_owned(), path.to_owned())];
        let mut frontier = vec![(environment.to_owned(), path.to_owned())];
        for _ in 0..MAX_IMPORT_DEPTH {
            let mut next = Vec::new();
            for (env, folder) in &frontier {
                let mut sources: Vec<&FolderImport> = imports
                    .iter()
                    .filter(|import| &import.environment == env && &import.path == folder)
                    .collect();
                sources.sort_by_key(|import| import.position);
                for import in sources {
                    let pair = (
                        import.source_environment.clone(),
                        import.source_path.clone(),
                    );
                    if !chain.contains(&pair) {
                        chain.push(pair.clone());
                        next.push(pair);
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        Ok(chain)
    }

    /// Candidate `(scope, scope_id)` pairs for a dispatch context, in
    /// precedence order ([`SecretScope::precedence`], the contract ladder).
    pub(crate) fn candidate_scopes(
        context: &SecretResolutionContext,
    ) -> Vec<(SecretScope, String)> {
        // A shared value is never resolved without a server-derived user. This
        // prevents a raw node bearer or an agent-less background job from
        // turning an org/team name into a shared-secret read.
        let has_user = context.user_id.is_some();
        let mut scopes: Vec<(SecretScope, String)> = Vec::new();
        for scope in SecretScope::precedence() {
            let scope_id = match scope {
                SecretScope::User => context
                    .user_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value)),
                SecretScope::Node => {
                    Some(context.node_id.as_str()).filter(|value| is_valid_scope_id(value))
                }
                SecretScope::Team if has_user => context
                    .team_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value))
                    .filter(|team| {
                        context
                            .team_authority
                            .as_ref()
                            .is_some_and(|authority| authority.allows(context, team))
                    }),
                SecretScope::Org if has_user => context
                    .org_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value)),
                // A project only reaches a run inside an organization: its
                // values live in the control plane, which re-checks the
                // project's team and the user's membership on every read.
                SecretScope::Project if has_user && context.org_id.is_some() => context
                    .project_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value)),
                SecretScope::Team | SecretScope::Org | SecretScope::Project => None,
            };
            if let Some(scope_id) = scope_id {
                scopes.push((scope, scope_id.to_owned()));
            }
        }
        scopes
    }

    /// Policy subjects for a dispatch context. Mirrors management's caller
    /// subjects: the user, every verified team of the owner (not only the
    /// conversation's requested team, which selects the Team candidate scope
    /// alone), and the owner's roles. A human broker session adds the role
    /// and team subjects its minter held at mint.
    pub(crate) fn context_subjects(context: &SecretResolutionContext) -> Vec<String> {
        let mut subjects = Vec::new();
        if let Some(user) = &context.user_id {
            subjects.push(format!("user:{user}"));
        }
        if let Some(authority) = &context.team_authority {
            subjects.extend(
                authority
                    .policy_team_ids(context)
                    .iter()
                    .map(|team| format!("team:{team}")),
            );
        }
        subjects.extend(context.roles.iter().map(|role| format!("role:{role}")));
        let minted_by_user = context.user_id.as_ref().is_some_and(|user| {
            context
                .minted_subjects
                .iter()
                .any(|subject| subject.strip_prefix("user:") == Some(user.as_str()))
        });
        if minted_by_user {
            for subject in &context.minted_subjects {
                if (subject.starts_with("role:") || subject.starts_with("team:"))
                    && !subjects.contains(subject)
                {
                    subjects.push(subject.clone());
                }
            }
        }
        subjects
    }
}
