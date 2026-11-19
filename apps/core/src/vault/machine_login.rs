//! Machine logins (AppRole, JWT), token lookup and revoke, and pruning.
//! Split out of [`super`] for the file-size limit.

use super::*;

impl PluginSecretStore {
    /// AppRole login.
    pub async fn approle_login(&self, role_id: &str, secret_id: &str) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity: Option<MachineIdentity> = conn
            .query_row(
                &format!(
                    "SELECT {IDENTITY_COLUMNS} FROM vault_machine_identities WHERE role_id = ?1"
                ),
                params![role_id],
                identity_from_row,
            )
            .optional()?;
        let denied = |conn: &Connection, reason: &str| -> anyhow::Error {
            self.audit_locked(
                conn,
                &AuditEntry::new(
                    &AuditActor::new("machine", None),
                    "auth.approle.login",
                    "denied",
                )
                .details(json!({ "reason": reason })),
            );
            VaultError::Denied("invalid role id or secret id".into()).into()
        };
        let Some(identity) = identity.filter(|identity| !identity.disabled) else {
            return Err(denied(&conn, "unknown or disabled role"));
        };
        let now = now_millis();
        type SecretIdRow = (
            String,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
        );
        let row: Option<SecretIdRow> = conn
            .query_row(
                "SELECT accessor, expires_at, uses_remaining, cidr_list, token_bound_cidrs
                 FROM vault_approle_secret_ids WHERE identity_id = ?1 AND digest = ?2",
                params![identity.id, sha256_hex(secret_id.as_bytes())],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((accessor, expires_at, uses, cidr_list, token_cidrs)) = row else {
            return Err(denied(&conn, "secret id mismatch"));
        };
        if expires_at.is_some_and(|at| at <= now) {
            return Err(denied(&conn, "secret id expired"));
        }
        let parse = |text: Option<String>| -> Vec<String> {
            text.and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default()
        };
        let client = crate::vault::tokens::request_client_ip();
        // Address checks run before a use is consumed, so a request from the
        // wrong network cannot burn a single-use secret id.
        if !crate::vault::tokens::ip_allowed(&parse(cidr_list), client) {
            return Err(denied(
                &conn,
                "source address not allowed for this secret id",
            ));
        }
        let token_cidrs = Some(parse(token_cidrs)).filter(|cidrs| !cidrs.is_empty());
        // The identity's current boundCidrs always apply: a secret id issued
        // before an administrator narrowed them cannot keep its wider override.
        let identity_cidrs = &identity.token_config.bound_cidrs;
        if !crate::vault::tokens::ip_allowed(identity_cidrs, client) {
            return Err(denied(&conn, "source address not allowed for the identity"));
        }
        if token_cidrs
            .as_ref()
            .is_some_and(|cidrs| !crate::vault::tokens::cidrs_within(cidrs, identity_cidrs))
        {
            return Err(denied(
                &conn,
                "secret id token CIDRs are no longer inside the identity's boundCidrs",
            ));
        }
        let effective_cidrs = token_cidrs
            .clone()
            .unwrap_or_else(|| identity.token_config.bound_cidrs.clone());
        if !crate::vault::tokens::ip_allowed(&effective_cidrs, client) {
            return Err(denied(&conn, "source address not allowed for the token"));
        }
        let tx = conn.unchecked_transaction()?;
        match uses {
            Some(1) => {
                tx.execute(
                    "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                    params![accessor],
                )?;
            }
            Some(_) => {
                tx.execute(
                    "UPDATE vault_approle_secret_ids SET uses_remaining = uses_remaining - 1
                     WHERE accessor = ?1",
                    params![accessor],
                )?;
            }
            None => {}
        }
        let token = self.issue_token_locked(&tx, &identity, token_cidrs)?;
        tx.commit()?;
        // Audit after commit: inside a transaction the fail-closed verdict
        // is deferred, and the token must not leave without an accepted row.
        // A refused row leaves the secret-id use consumed.
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                "auth.approle.login",
                "ok",
            )
            .details(json!({ "tokenAccessor": token.accessor })),
        ) {
            crate::vault::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(token)
    }

    /// OIDC/JWT login against the named identity.
    pub async fn jwt_login(&self, identity_name: &str, jwt: &str) -> Result<IssuedToken> {
        // Unknown, disabled and other-method identities, and a login from
        // outside the identity's boundCidrs, are each refused (and audited,
        // with the attempted name) before the JWT is looked at.
        let identity = self
            .login_identity(identity_name, "jwt", |auth| {
                matches!(auth, AuthMethod::Jwt(_))
            })
            .await?;
        let AuthMethod::Jwt(config) = &identity.auth else {
            return Err(VaultError::Invalid("identity does not use jwt login".into()).into());
        };
        let egress = self.machine_identity_egress(&identity.name).await?;
        if let Err(error) = verify_jwt(config, jwt, egress).await {
            self.audit(
                &AuditEntry::new(
                    &AuditActor::new("machine", Some(&identity.id)),
                    "auth.jwt.login",
                    "denied",
                )
                .details(json!({ "reason": error.to_string() })),
            )
            .await;
            return Err(VaultError::Denied(format!("JWT rejected: {error}")).into());
        }
        let conn = self.conn.lock().await;
        let token = self.issue_token_locked(&conn, &identity, None)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                "auth.jwt.login",
                "ok",
            )
            .details(json!({ "tokenAccessor": token.accessor })),
        ) {
            crate::vault::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(token)
    }

    /// Resolve a presented token to its principal. `None` for unknown,
    /// expired, revoked, or disabled.
    pub async fn token_lookup(&self, token: &str) -> Result<Option<TokenPrincipal>> {
        if !token.starts_with("rvt_") {
            return Ok(None);
        }
        let conn = self.conn.lock().await;
        let now = now_millis();
        // The identity's own policies come from its current row, not the
        // token: the token's stored list is only what applied at issue time.
        let row: Option<(String, String, String, i64, String, i64)> = conn
            .query_row(
                "SELECT t.accessor, t.identity_id, i.policies, t.expires_at, i.name, i.disabled
                 FROM vault_tokens t JOIN vault_machine_identities i ON i.id = t.identity_id
                 WHERE t.digest = ?1 AND t.revoked_at IS NULL",
                params![sha256_hex(token.as_bytes())],
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
            .optional()?;
        let Some((accessor, identity_id, policies, expires_at, identity_name, disabled)) = row
        else {
            return Ok(None);
        };
        if expires_at <= now || disabled != 0 {
            return Ok(None);
        }
        // Bindings are re-read on every use, so a temporary `machine:<id>`
        // binding stops granting access at its `expiresAt`, even to tokens
        // minted while it was live.
        let identity_policies: Vec<String> = serde_json::from_str(&policies).unwrap_or_default();
        let policies = effective_machine_policies(&conn, &identity_id, &identity_policies)?;
        // Parent chain, CIDR binding, use limit, and child-token narrowing.
        let Some(policies) = self.token_admit_locked(&conn, &accessor, now, policies)? else {
            return Ok(None);
        };
        conn.execute(
            "UPDATE vault_tokens SET last_used_at = ?1 WHERE accessor = ?2",
            params![now, accessor],
        )?;
        Ok(Some(TokenPrincipal {
            accessor,
            identity_id,
            identity_name,
            policies,
            expires_at,
        }))
    }

    /// Revoke a token by accessor, with its non-orphan descendants, their
    /// cubbyholes, and the leases they hold.
    pub async fn token_revoke(&self, accessor: &str, actor: &AuditActor) -> Result<()> {
        self.token_revoke_tree(accessor, false, actor)
            .await
            .map(|_| ())
    }

    /// Delete tokens and secret ids that expired more than a day ago. A token
    /// that still holds a live lease is kept: its row ties the lease to the
    /// identity, so a later disable or delete still finds and revokes it.
    pub async fn machine_prune(&self) -> Result<usize> {
        let cutoff = now_millis() - 24 * 3600 * 1000;
        let conn = self.conn.lock().await;
        let tokens = conn.execute(
            "DELETE FROM vault_tokens WHERE (expires_at < ?1 OR revoked_at < ?1)
               AND NOT EXISTS (SELECT 1 FROM vault_leases l
                               WHERE l.token_accessor = vault_tokens.accessor
                                 AND l.revoked_at IS NULL)",
            params![cutoff],
        )?;
        let secret_ids = conn.execute(
            "DELETE FROM vault_approle_secret_ids WHERE expires_at IS NOT NULL AND expires_at < ?1",
            params![cutoff],
        )?;
        Ok(tokens + secret_ids)
    }
}

#[cfg(test)]
#[path = "machine_login_test.rs"]
mod tests;
