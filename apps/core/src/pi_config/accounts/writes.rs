//! Account capture, selection, labels and removal.
// test-exempt: moved verbatim out of pi_config/accounts.rs; its tests are in accounts/tests.rs.

use super::*;

impl AccountVault {
    /// Insert or replace an account in `scope` and make it the active one. The
    /// credential is sealed before it touches disk; pass `None` for an opaque
    /// account whose value Ryu cannot read back.
    pub fn upsert(
        &self,
        scope: &str,
        account_id: &str,
        label: &str,
        kind: &str,
        credential: Option<Value>,
    ) -> Result<()> {
        self.upsert_selected(scope, account_id, label, kind, credential, true)
    }

    /// Capture a pending native profile without changing the ready selection.
    pub(crate) fn upsert_inactive(
        &self,
        scope: &str,
        account_id: &str,
        label: &str,
        kind: &str,
        credential: Value,
    ) -> Result<()> {
        self.upsert_selected(scope, account_id, label, kind, Some(credential), false)
    }

    fn upsert_selected(
        &self,
        scope: &str,
        account_id: &str,
        label: &str,
        kind: &str,
        credential: Option<Value>,
        activate: bool,
    ) -> Result<()> {
        let sealed = credential
            .map(|v| serde_json::to_vec(&v).context("serializing pi account credential"))
            .transpose()?
            .map(|bytes| self.cipher.encrypt(&bytes))
            .transpose()?;
        let now = now_millis();
        let mut conn = self.conn.lock().expect("pi-accounts mutex");
        let transaction = conn.transaction().context("starting account capture")?;
        // The single add point of the vault: a new account is refused here when
        // its provider is full, whichever route, login or import asked for it.
        limit::ensure_room(&transaction, scope, account_id)?;
        transaction
            .execute(
                "INSERT INTO pi_accounts
				(scope, account_id, label, kind, nonce, ciphertext, is_active,
				 gateway_active, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, 0, ?7, ?7)
             ON CONFLICT(scope, account_id) DO UPDATE SET
                 label = excluded.label,
                 kind = excluded.kind,
                 nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext,
                 is_active = excluded.is_active,
                 updated_at = excluded.updated_at",
                params![
                    scope,
                    account_id,
                    label,
                    kind,
                    sealed.as_ref().map(|(n, _)| n.as_slice()),
                    sealed.as_ref().map(|(_, c)| c.as_slice()),
                    now,
                    activate,
                ],
            )
            .context("writing pi_accounts (upsert)")?;
        // Exactly one active row per scope.
        transaction
            .execute(
                "UPDATE pi_accounts SET is_active = 0
             WHERE scope = ?1 AND account_id <> ?2 AND is_active = 1 AND ?3 = 1",
                params![scope, account_id, activate],
            )
            .context("clearing prior active pi_account")?;
        // The first account for a scope is also the Gateway default. Later logins
        // become personal-active only, leaving an operator's shared Gateway choice
        // untouched.
        transaction
            .execute(
                "UPDATE pi_accounts SET gateway_active = 1
			 WHERE scope = ?1 AND account_id = ?2
			   AND kind = 'api_key'
			   AND NOT EXISTS (
				   SELECT 1 FROM pi_accounts
				   WHERE scope = ?1 AND gateway_active = 1
			   )",
                params![scope, account_id],
            )
            .context("seeding Gateway-active pi_account")?;
        transaction.commit().context("committing account capture")?;
        Ok(())
    }

    /// Whether any account in `scope` currently holds exactly `credential`.
    /// Used to avoid stacking a duplicate account on a re-login that rotated
    /// nothing (the pi-ai `pi_terminal_login` hint answers success without
    /// writing a new credential).
    pub fn has_credential(&self, scope: &str, credential: &Value) -> Result<bool> {
        let accounts = self.list(scope)?;
        for info in accounts {
            if let Some(existing) = self.credential(scope, &info.account_id)? {
                if &existing == credential {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The newest account in `scope` with a given label, if any. Used to refresh
    /// an opaque ACP sign-in instead of stacking duplicates.
    pub fn find_by_label(&self, scope: &str, label: &str) -> Result<Option<AccountInfo>> {
        let accounts = self.list(scope)?;
        Ok(accounts.into_iter().find(|a| a.label == label))
    }

    /// Mark `account_id` as the active account for `scope`. Returns `false` when
    /// no such account exists.
    pub fn set_active(&self, scope: &str, account_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().expect("pi-accounts mutex");
        let transaction = conn.transaction().context("starting account selection")?;
        let n = transaction
            .execute(
                "UPDATE pi_accounts SET is_active = 1, updated_at = ?3
                 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id, now_millis()],
            )
            .context("activating pi_account")?;
        if n == 0 {
            return Ok(false);
        }
        transaction
            .execute(
                "UPDATE pi_accounts SET is_active = 0
             WHERE scope = ?1 AND account_id <> ?2 AND is_active = 1",
                params![scope, account_id],
            )
            .context("clearing prior active pi_account")?;
        transaction
            .commit()
            .context("committing account selection")?;
        Ok(true)
    }

    /// Mark `account_id` as the Gateway-active account for `scope`. Returns
    /// `false` when no such account exists.
    pub fn set_gateway_active(&self, scope: &str, account_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().expect("pi-accounts mutex");
        let transaction = conn
            .transaction()
            .context("starting Gateway account selection")?;
        let n = transaction
            .execute(
                "UPDATE pi_accounts SET gateway_active = 1, updated_at = ?3
				 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id, now_millis()],
            )
            .context("activating Gateway pi_account")?;
        if n == 0 {
            return Ok(false);
        }
        transaction
            .execute(
                "UPDATE pi_accounts SET gateway_active = 0
			 WHERE scope = ?1 AND account_id <> ?2 AND gateway_active = 1",
                params![scope, account_id],
            )
            .context("clearing prior Gateway-active pi_account")?;
        transaction
            .commit()
            .context("committing Gateway account selection")?;
        Ok(true)
    }

    /// Change only an account's display label. Labels are non-secret metadata;
    /// credential timestamps and active-account selection stay unchanged.
    pub fn set_label(&self, scope: &str, account_id: &str, label: &str) -> Result<bool> {
        let label = label.trim();
        anyhow::ensure!(!label.is_empty(), "account label cannot be empty");
        anyhow::ensure!(
            label.chars().count() <= 80,
            "account label cannot exceed 80 characters"
        );
        anyhow::ensure!(
            !label.chars().any(char::is_control),
            "account label cannot contain control characters"
        );

        let conn = self.conn.lock().expect("pi-accounts mutex");
        let updated = conn
            .execute(
                "UPDATE pi_accounts SET label = ?3
                 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id, label],
            )
            .context("renaming pi_account")?;
        Ok(updated > 0)
    }

    /// Remove an account. Returns `true` if a row was removed.
    pub fn remove(&self, scope: &str, account_id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let was_gateway_active: bool = conn
            .query_row(
                "SELECT gateway_active FROM pi_accounts
				 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .optional()
            .context("checking Gateway-active pi_account before deletion")?
            .unwrap_or(false);
        let removed = conn
            .execute(
                "DELETE FROM pi_accounts WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
            )
            .context("deleting pi_account")?;
        if removed > 0 && was_gateway_active {
            conn.execute(
                "UPDATE pi_accounts SET gateway_active = 1
				 WHERE scope = ?1 AND account_id = (
					 SELECT account_id FROM pi_accounts
					 WHERE scope = ?1
					 ORDER BY is_active DESC, updated_at DESC, account_id ASC
					 LIMIT 1
				 )",
                params![scope],
            )
            .context("promoting replacement Gateway pi_account")?;
        }
        Ok(removed > 0)
    }
}
