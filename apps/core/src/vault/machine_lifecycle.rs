//! Machine identity lifecycle: create, list, update, delete, and AppRole
//! secret ids. Split out of [`super`] for the file-size limit.

use super::*;

impl PluginSecretStore {
    /// Create a machine identity as a configuration manager (tests and
    /// fixtures; the HTTP route records its caller with [`Self::machine_create_as`]).
    #[cfg(test)]
    pub async fn machine_create(
        &self,
        name: &str,
        auth: AuthMethod,
        policies: Vec<String>,
        token_ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        self.machine_create_as(
            name,
            auth,
            policies,
            token_ttl_secs,
            RoleWriter::Manager,
            actor,
        )
        .await
    }

    /// Create a machine identity written by `writer`: a delegate's JWKS and
    /// TokenReview targets are screened ([`crate::vault::machine_egress`]). For
    /// AppRole, `auth` may carry an empty `roleId`; one is generated.
    pub async fn machine_create_as(
        &self,
        name: &str,
        auth: AuthMethod,
        policies: Vec<String>,
        token_ttl_secs: Option<i64>,
        writer: RoleWriter,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        if !is_valid_identity_name(name) {
            return Err(VaultError::Invalid("invalid machine identity name".into()).into());
        }
        let auth = match auth {
            AuthMethod::AppRole { .. } => AuthMethod::AppRole {
                role_id: random_token("role_"),
            },
            AuthMethod::Jwt(config) => {
                config
                    .validate()
                    .map_err(|error| VaultError::Invalid(error.to_string()))?;
                AuthMethod::Jwt(config)
            }
            other => {
                crate::vault::auth_methods::validate(&other)
                    .map_err(|error| VaultError::Invalid(error.to_string()))?;
                other
            }
        };
        crate::vault::machine_egress::precheck(&auth, writer)
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let role_id = match &auth {
            AuthMethod::AppRole { role_id } => Some(role_id.clone()),
            _ => None,
        };
        let ttl = token_ttl_secs
            .unwrap_or(DEFAULT_TOKEN_TTL_SECS)
            .clamp(60, MAX_TOKEN_TTL_SECS);
        let id = random_token("mid_");
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_machine_identities
                 (id, name, auth, role_id, policies, token_ttl_secs, created_at, created_by, writer)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                name,
                serde_json::to_string(&auth)?,
                role_id,
                serde_json::to_string(&policies)?,
                ttl,
                now_millis(),
                actor.id,
                writer.label()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("machine identity `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.create", "ok")
                .details(json!({ "identity": id, "name": name })),
        );
        identity_locked(&conn, &id)
    }

    /// Every machine identity.
    pub async fn machine_list(&self) -> Result<Vec<MachineIdentity>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {IDENTITY_COLUMNS} FROM vault_machine_identities ORDER BY name"
        ))?;
        let rows = stmt.query_map([], identity_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One identity by id or name.
    pub async fn machine_get(&self, id_or_name: &str) -> Result<MachineIdentity> {
        let conn = self.conn.lock().await;
        identity_locked(&conn, id_or_name)
    }

    /// Update policies, TTL, or the disabled flag. Disabling cuts every token
    /// off at once, then sends each through the revoke tree (descendants,
    /// cubbyholes, leases; [`super::revoke`]). A lease its provider refuses
    /// to revoke fails the call with its id; the identity stays disabled.
    pub async fn machine_update(
        &self,
        id_or_name: &str,
        policies: Option<Vec<String>>,
        token_ttl_secs: Option<i64>,
        disabled: Option<bool>,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        let updated = {
            let conn = self.conn.lock().await;
            self.machine_update_locked(
                &conn,
                id_or_name,
                policies,
                token_ttl_secs,
                disabled,
                actor,
            )?
        };
        if disabled == Some(true) {
            let revocation = self.machine_revoke_tokens(&updated.id, actor).await?;
            if !revocation.leases_left.is_empty() {
                return Err(super::revoke::leases_left_error(
                    &updated,
                    &revocation.leases_left,
                ));
            }
        }
        Ok(updated)
    }

    fn machine_update_locked(
        &self,
        conn: &Connection,
        id_or_name: &str,
        policies: Option<Vec<String>>,
        token_ttl_secs: Option<i64>,
        disabled: Option<bool>,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        let identity = identity_locked(conn, id_or_name)?;
        if let Some(policies) = policies {
            conn.execute(
                "UPDATE vault_machine_identities SET policies = ?1 WHERE id = ?2",
                params![serde_json::to_string(&policies)?, identity.id],
            )?;
        }
        if let Some(ttl) = token_ttl_secs {
            conn.execute(
                "UPDATE vault_machine_identities SET token_ttl_secs = ?1 WHERE id = ?2",
                params![ttl.clamp(60, MAX_TOKEN_TTL_SECS), identity.id],
            )?;
        }
        if let Some(disabled) = disabled {
            conn.execute(
                "UPDATE vault_machine_identities SET disabled = ?1 WHERE id = ?2",
                params![disabled as i64, identity.id],
            )?;
            if disabled {
                conn.execute(
                    "UPDATE vault_tokens SET revoked_at = ?1
                     WHERE identity_id = ?2 AND revoked_at IS NULL",
                    params![now_millis(), identity.id],
                )?;
            }
        }
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, "machine.update", "ok")
                .details(json!({ "identity": identity.id })),
        );
        identity_locked(conn, &identity.id)
    }

    /// Delete an identity with its secret ids and tokens. It is disabled and
    /// its tokens go through the revoke tree first, as for a disable; if a
    /// lease outlives that, the delete fails with its id and the identity is
    /// kept, disabled, so the delete can be retried.
    pub async fn machine_delete(&self, id_or_name: &str, actor: &AuditActor) -> Result<()> {
        let identity = self
            .machine_update(id_or_name, None, None, Some(true), actor)
            .await?;
        let conn = self.conn.lock().await;
        self.machine_delete_rows_locked(&conn, &identity, actor)
    }

    /// Remove a disabled identity's rows. The lock was released after the
    /// revoke tree ran, so live leases are looked for again here: deleting
    /// the token rows they point to would leave them unrevocable, so the
    /// delete fails closed with their ids instead. Defense in depth: a
    /// disabled identity's tokens cannot record new leases
    /// (`tokens::request_lease_holder_locked`).
    pub(in crate::vault) fn machine_delete_rows_locked(
        &self,
        conn: &Connection,
        identity: &MachineIdentity,
        actor: &AuditActor,
    ) -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let left = super::revoke::live_leases_locked(&tx, &identity.id)?;
        if !left.is_empty() {
            // Roll back first: an audit row written inside `tx` would be
            // rolled back with it.
            tx.rollback()?;
            self.audit_locked(
                conn,
                &AuditEntry::new(actor, "machine.delete", "error")
                    .details(json!({ "identity": identity.id, "leasesLeft": left })),
            );
            return Err(super::revoke::leases_left_error(identity, &left));
        }
        tx.execute(
            "DELETE FROM vault_tokens WHERE identity_id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_approle_secret_ids WHERE identity_id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_machine_identities WHERE id = ?1",
            params![identity.id],
        )?;
        tx.execute(
            "DELETE FROM vault_policy_bindings WHERE subject = ?1",
            params![format!("machine:{}", identity.id)],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "machine.delete", "ok")
                .details(json!({ "identity": identity.id })),
        );
        tx.commit()?;
        self.flush_audit(conn);
        Ok(())
    }

    /// Issue an AppRole secret id. The plaintext is returned once.
    pub async fn machine_issue_secret_id(
        &self,
        id_or_name: &str,
        ttl_secs: Option<i64>,
        uses: Option<i64>,
        actor: &AuditActor,
    ) -> Result<(String, SecretIdInfo)> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        if !matches!(identity.auth, AuthMethod::AppRole { .. }) {
            return Err(VaultError::Invalid("secret ids are for AppRole identities".into()).into());
        }
        if identity.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        let secret = random_token("sid_");
        let info = SecretIdInfo {
            accessor: random_token("sida_"),
            created_at: now_millis(),
            expires_at: ttl_secs.map(|ttl| now_millis() + ttl.max(1) * 1000),
            uses_remaining: uses.map(|uses| uses.max(1)),
        };
        conn.execute(
            "INSERT INTO vault_approle_secret_ids
                 (accessor, identity_id, digest, created_at, expires_at, uses_remaining)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                info.accessor,
                identity.id,
                sha256_hex(secret.as_bytes()),
                info.created_at,
                info.expires_at,
                info.uses_remaining
            ],
        )?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.secret_id.create", "ok")
                .details(json!({ "identity": identity.id, "accessor": info.accessor })),
        ) {
            // Withhold the secret id and leave no usable row behind.
            conn.execute(
                "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                params![info.accessor],
            )?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok((secret, info))
    }

    /// AppRole secret ids for an identity.
    pub async fn machine_list_secret_ids(&self, id_or_name: &str) -> Result<Vec<SecretIdInfo>> {
        let conn = self.conn.lock().await;
        let identity = identity_locked(&conn, id_or_name)?;
        let mut stmt = conn.prepare(
            "SELECT accessor, created_at, expires_at, uses_remaining FROM vault_approle_secret_ids
             WHERE identity_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![identity.id], |row| {
            Ok(SecretIdInfo {
                accessor: row.get(0)?,
                created_at: row.get(1)?,
                expires_at: row.get(2)?,
                uses_remaining: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Destroy one secret id.
    pub async fn machine_revoke_secret_id(&self, accessor: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
            params![accessor],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.secret_id.revoke", "ok")
                .details(json!({ "accessor": accessor })),
        );
        Ok(())
    }

    /// Issue a login token for `identity`, unless it has been disabled since
    /// the caller read it. `token_cidrs` carries an AppRole secret id's
    /// `tokenBoundCidrs`, which replace the identity's.
    pub(in crate::vault) fn issue_token_locked(
        &self,
        conn: &Connection,
        identity: &MachineIdentity,
        token_cidrs: Option<Vec<String>>,
    ) -> Result<IssuedToken> {
        // A login checks `disabled` before it verifies its credential, which
        // may take a network round trip; read it again under this lock so a
        // disable in between is not undone by the login.
        if identity_locked(conn, &identity.id)?.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        let policies = effective_machine_policies(conn, &identity.id, &identity.policies)?;
        let new =
            crate::vault::tokens::identity_token(identity, policies, token_cidrs, now_millis());
        crate::vault::tokens::insert_token_locked(conn, &new)
    }
}
