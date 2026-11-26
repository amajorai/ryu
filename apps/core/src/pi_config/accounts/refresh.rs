//! OAuth refresh bookkeeping and compare-and-replace credential writes.
// test-exempt: moved verbatim out of pi_config/accounts.rs; its tests are in accounts/tests.rs.

use super::*;

impl AccountVault {
    /// Commit intent before dispatch. SQLite serializes separate Core processes,
    /// and a crash leaves the nonce-bound intent in place to prevent token reuse.
    pub(in crate::pi_config) fn begin_refresh(
        &self,
        scope: &str,
        account_id: &str,
        expected: &Value,
    ) -> Result<Vec<u8>> {
        let mut conn = self.conn.lock().expect("pi-accounts mutex");
        let transaction =
            conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (revision, ciphertext): (Vec<u8>, Vec<u8>) = transaction.query_row(
            "SELECT nonce, ciphertext FROM pi_accounts WHERE scope = ?1 AND account_id = ?2",
            params![scope, account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let current: Value = serde_json::from_slice(&self.cipher.decrypt(&revision, &ciphertext)?)?;
        if current != *expected {
            anyhow::bail!("OAuth account changed before refresh; retry with the current account");
        }
        let intent: Option<(String, i64)> = transaction
            .query_row(
                "SELECT state, retry_at FROM pi_oauth_refresh_intents
             WHERE scope = ?1 AND account_id = ?2 AND revision = ?3",
                params![scope, account_id, revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match intent.as_ref() {
            Some((state, _)) if state == "revoked" => return Err(RefreshFailure::Revoked.into()),
            Some((state, retry_at)) if state == "retry" && *retry_at > now_millis() => {
                return Err(RefreshFailure::Transient.into());
            }
            Some((state, _)) if state != "retry" => return Err(RefreshFailure::Uncertain.into()),
            _ => {}
        }
        transaction.execute(
            "INSERT INTO pi_oauth_refresh_intents(scope, account_id, revision, state, retry_at)
             VALUES (?1, ?2, ?3, 'pending', 0)
             ON CONFLICT(scope, account_id) DO UPDATE SET revision = excluded.revision,
                 state = excluded.state, retry_at = 0",
            params![scope, account_id, revision],
        )?;
        transaction.commit()?;
        Ok(revision)
    }

    pub(in crate::pi_config) fn record_refresh_failure(
        &self,
        scope: &str,
        account_id: &str,
        revision: &[u8],
        failure: RefreshFailure,
    ) -> Result<()> {
        let state = match failure {
            RefreshFailure::Uncertain => "pending",
            RefreshFailure::Revoked => "revoked",
            RefreshFailure::Transient => "retry",
        };
        self.conn.lock().expect("pi-accounts mutex").execute(
            "UPDATE pi_oauth_refresh_intents SET state = ?4, retry_at = ?5
             WHERE scope = ?1 AND account_id = ?2 AND revision = ?3",
            params![scope, account_id, revision, state, now_millis() + 60_000],
        )?;
        Ok(())
    }

    /// Safe public projection: no nonce, token, vendor body, or secret leaves the vault.
    pub fn needs_reauth(&self, scope: &str, account_id: &str) -> Result<bool> {
        self.conn
            .lock()
            .expect("pi-accounts mutex")
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pi_oauth_refresh_intents AS intent
             JOIN pi_accounts AS account ON account.scope = intent.scope
               AND account.account_id = intent.account_id AND account.nonce = intent.revision
             WHERE account.scope = ?1 AND account.account_id = ?2 AND intent.state <> 'retry')",
                params![scope, account_id],
                |row| row.get(0),
            )
            .context("reading OAuth reauthentication state")
    }

    /// Replace a saved credential only while it still matches the value read
    /// before an OAuth exchange. This keeps a removed account removed and
    /// prevents an older concurrent refresh from overwriting a newer token.
    /// Neither active selector changes.
    pub fn replace_credential(
        &self,
        scope: &str,
        account_id: &str,
        expected: &Value,
        credential: Value,
    ) -> Result<bool> {
        self.replace_credential_generation(scope, account_id, expected, None, credential)
    }

    #[cfg(test)]
    pub(in crate::pi_config) fn expire_refresh_retry_for_test(&self) -> Result<()> {
        self.conn.lock().expect("pi-accounts mutex").execute(
            "UPDATE pi_oauth_refresh_intents SET retry_at = 0 WHERE state = 'retry'",
            [],
        )?;
        Ok(())
    }

    pub(in crate::pi_config) fn finish_refresh(
        &self,
        scope: &str,
        account_id: &str,
        expected: &Value,
        revision: &[u8],
        credential: Value,
    ) -> Result<bool> {
        self.replace_credential_generation(scope, account_id, expected, Some(revision), credential)
    }

    fn replace_credential_generation(
        &self,
        scope: &str,
        account_id: &str,
        expected: &Value,
        expected_revision: Option<&[u8]>,
        credential: Value,
    ) -> Result<bool> {
        let bytes = serde_json::to_vec(&credential).context("serializing pi account credential")?;
        let (nonce, ciphertext) = self.cipher.encrypt(&bytes)?;
        let mut conn = self.conn.lock().expect("pi-accounts mutex");
        let transaction =
            conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let sealed: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = transaction
            .query_row(
                "SELECT nonce, ciphertext FROM pi_accounts WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((Some(current_nonce), Some(current_ciphertext))) = sealed else {
            return Ok(false);
        };
        if expected_revision.is_some_and(|revision| revision != current_nonce.as_slice()) {
            return Ok(false);
        }
        let plain = self.cipher.decrypt(&current_nonce, &current_ciphertext)?;
        let current: Value = serde_json::from_slice(&plain)?;
        if &current != expected {
            return Ok(false);
        }
        let changed = transaction.execute(
            "UPDATE pi_accounts SET nonce = ?3, ciphertext = ?4, updated_at = ?5
             WHERE scope = ?1 AND account_id = ?2",
            params![scope, account_id, nonce, ciphertext, now_millis()],
        )?;
        transaction.commit()?;
        Ok(changed == 1)
    }
}
