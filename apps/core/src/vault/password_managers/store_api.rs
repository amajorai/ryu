//! Account management, approvals and grants on [`PluginSecretStore`].
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by tests.rs (account
//! validation, token sealing, reconnect, removal, approval and revocation tests).

use super::*;

impl PluginSecretStore {
    // ── Accounts ──────────────────────────────────────────────────────────

    /// Add an account; the token is sealed with the keyring.
    pub async fn pm_account_create(
        &self,
        input: AccountInput,
        actor: &AuditActor,
    ) -> Result<AccountRecord> {
        let record = validate_account(&input)?;
        let (key_version, nonce, ciphertext) = self.seal_row(input.token.as_bytes())?;
        drop(input);
        let conn = self.conn.lock().await;
        let exists = conn
            .query_row(
                "SELECT 1 FROM vault_pm_accounts WHERE name = ?1",
                params![record.name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Err(VaultError::Conflict(format!(
                "password-manager account `{}` exists",
                record.name
            ))
            .into());
        }
        conn.execute(
            "INSERT INTO vault_pm_accounts
                (id, name, provider, address, binary_path, state, nonce, ciphertext,
                 key_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'connected', ?6, ?7, ?8, ?9, ?9)",
            params![
                record.id,
                record.name,
                record.provider.as_str(),
                record.address,
                record.binary_path,
                nonce,
                ciphertext,
                key_version,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.create", "ok").details(json!({
                "account": record.name, "provider": record.provider.as_str(),
            })),
        );
        Ok(record)
    }

    /// Every account (no tokens).
    pub async fn pm_account_list(&self) -> Result<Vec<AccountRecord>> {
        let conn = self.conn.lock().await;
        accounts_locked(&conn)
    }

    /// One account (no token).
    pub async fn pm_account(&self, id: &str) -> Result<AccountRecord> {
        let conn = self.conn.lock().await;
        account_locked(&conn, id)
    }

    /// The account a reference resolves through.
    pub async fn pm_account_for_ref(&self, reference: &PmRef) -> Result<AccountRecord> {
        let conn = self.conn.lock().await;
        select_account(&conn, reference)
    }

    /// Replace an account's token (reconnect).
    pub async fn pm_account_set_token(
        &self,
        id: &str,
        mut token: String,
        actor: &AuditActor,
    ) -> Result<AccountRecord> {
        let checked = validate_token(&token);
        let sealed = checked.and_then(|()| self.seal_row(token.as_bytes()));
        wipe_string(&mut token);
        let (key_version, nonce, ciphertext) = sealed?;
        let conn = self.conn.lock().await;
        let record = account_locked(&conn, id)?;
        conn.execute(
            "UPDATE vault_pm_accounts
             SET nonce = ?1, ciphertext = ?2, key_version = ?3, state = 'connected',
                 last_error = NULL, updated_at = ?4
             WHERE id = ?5",
            params![nonce, ciphertext, key_version, now_millis(), id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.reconnect", "ok")
                .details(json!({ "account": record.name })),
        );
        account_locked(&conn, id)
    }

    /// Remove an account, its grants, and its pending approval requests.
    pub async fn pm_account_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = account_locked(&conn, id)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM vault_pm_grants WHERE account_id = ?1",
            params![id],
        )?;
        for proposal in proposals::list(&tx, Some(ProposalStatus::Pending))? {
            if proposal
                .credential_use
                .as_ref()
                .is_some_and(|credential_use| credential_use.account_id == id)
            {
                proposals::decide(
                    &tx,
                    &proposal.id,
                    ProposalStatus::Rejected,
                    "system",
                    "the password-manager account was removed",
                )?;
            }
        }
        tx.execute("DELETE FROM vault_pm_accounts WHERE id = ?1", params![id])?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "pm.account.delete", "ok")
                .details(json!({ "account": record.name })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(())
    }

    /// The account's unsealed token.
    pub(super) fn pm_token_locked(&self, conn: &Connection, id: &str) -> Result<Secret> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let (key_version, nonce, ciphertext): (u32, Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT key_version, nonce, ciphertext FROM vault_pm_accounts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(Secret::from_bytes(self.open_row(
            key_version,
            &nonce,
            &ciphertext,
        )?))
    }

    /// Check an account's connectivity and token. Never returns a value.
    pub async fn pm_account_test(&self, id: &str, actor: &AuditActor) -> Result<AccountRecord> {
        let (record, token) = {
            let conn = self.conn.lock().await;
            let record = account_locked(&conn, id)?;
            let token = self.pm_token_locked(&conn, id)?;
            (record, token)
        };
        let result = providers::check(&record, &token).await;
        drop(token);
        let conn = self.conn.lock().await;
        record_check(&conn, id, result.as_ref().map(|_| ()))?;
        let outcome = match &result {
            Ok(()) => "ok",
            Err(failure) => failure_outcome(failure.kind),
        };
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.account.test", outcome).details(json!({
                "account": record.name, "provider": record.provider.as_str(),
            })),
        );
        result?;
        account_locked(&conn, id)
    }

    // ── Approvals and grants ──────────────────────────────────────────────

    /// A credential-use request.
    pub async fn pm_approval(&self, id: &str) -> Result<Proposal> {
        let conn = self.conn.lock().await;
        match proposals::get(&conn, id)? {
            Some(proposal) if proposal.credential_use.is_some() => Ok(proposal),
            _ => Err(VaultError::NotFound(format!("password-manager approval `{id}`")).into()),
        }
    }

    /// Credential-use requests, newest first.
    pub async fn pm_approvals(&self, status: Option<ProposalStatus>) -> Result<Vec<Proposal>> {
        let conn = self.conn.lock().await;
        if let Err(error) = proposals::expire(&conn, now_millis()) {
            tracing::warn!("expiring proposals failed: {error:#}");
        }
        Ok(proposals::list(&conn, status)?
            .into_iter()
            .filter(|proposal| proposal.credential_use.is_some())
            .collect())
    }

    /// Approve a pending credential-use request with `mode`, recording the
    /// grant in the same transaction.
    pub async fn pm_approve(
        &self,
        id: &str,
        mode: GrantMode,
        note: &str,
        decided_by: &str,
        actor: &AuditActor,
    ) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let proposal = proposals::pending(&tx, id)?;
        let Some(credential_use) = proposal.credential_use else {
            return Err(invalid("not a password-manager approval request"));
        };
        account_locked(&tx, &credential_use.account_id)?;
        if !proposals::decide(&tx, id, ProposalStatus::Approved, decided_by, note)? {
            return Err(
                VaultError::Conflict(format!("approval `{id}` is no longer pending")).into(),
            );
        }
        let now = now_millis();
        let grant_id = format!("pmg_{}", uuid::Uuid::new_v4().simple());
        tx.execute(
            "INSERT INTO vault_pm_grants
                (id, subject, account_id, reference, mode, uses_remaining, expires_at,
                 granted_by, proposal_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                grant_id,
                credential_use.subject,
                credential_use.account_id,
                credential_use.reference,
                mode.as_str(),
                (mode == GrantMode::Once).then_some(1_i64),
                now + mode.lifetime_millis(),
                decided_by,
                id,
                now
            ],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "pm.approval.approve", "ok").details(json!({
                "approval": id, "grant": grant_id, "mode": mode.as_str(),
                "account": credential_use.account, "ref": credential_use.reference,
                "subject": credential_use.subject,
            })),
        );
        let grant = grant_locked(&tx, &grant_id)?;
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(grant)
    }

    /// Reject a pending credential-use request.
    pub async fn pm_reject(
        &self,
        id: &str,
        note: &str,
        decided_by: &str,
        actor: &AuditActor,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let proposal = proposals::pending(&conn, id)?;
        if proposal.credential_use.is_none() {
            return Err(invalid("not a password-manager approval request"));
        }
        if !proposals::decide(&conn, id, ProposalStatus::Rejected, decided_by, note)? {
            return Err(
                VaultError::Conflict(format!("approval `{id}` is no longer pending")).into(),
            );
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.approval.reject", "ok").details(json!({ "approval": id })),
        );
        Ok(())
    }

    /// Grants, newest first: only active ones unless `include_inactive`.
    pub async fn pm_grant_list(&self, include_inactive: bool) -> Result<Vec<GrantRecord>> {
        let conn = self.conn.lock().await;
        let now = now_millis();
        if let Err(error) = prune(&conn, now) {
            tracing::warn!("pruning password-manager grants failed: {error:#}");
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
             LEFT JOIN vault_pm_accounts a ON a.id = g.account_id
             WHERE ?1 OR (g.revoked_at IS NULL AND g.expires_at > ?2
                          AND (g.uses_remaining IS NULL OR g.uses_remaining > 0))
             ORDER BY g.created_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map(params![include_inactive, now], grant_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One grant.
    pub async fn pm_grant(&self, id: &str) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        grant_locked(&conn, id)
    }

    /// Revoke a grant; the consumer's next use asks for approval again.
    pub async fn pm_grant_revoke(&self, id: &str, actor: &AuditActor) -> Result<GrantRecord> {
        let conn = self.conn.lock().await;
        let grant = grant_locked(&conn, id)?;
        conn.execute(
            "UPDATE vault_pm_grants SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now_millis(), id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pm.grant.revoke", "ok").details(json!({
                "grant": id, "account": grant.account, "ref": grant.reference,
                "subject": grant.subject,
            })),
        );
        grant_locked(&conn, id)
    }
}
