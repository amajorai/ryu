//! Reads of the account vault: listings, counts and decrypted credentials.
// test-exempt: moved verbatim out of pi_config/accounts.rs; its tests are in accounts/tests.rs.

use super::*;

impl AccountVault {
    /// List a scope's accounts, active first then newest write first. **Names,
    /// kinds and timestamps only** — the ciphertext columns are not selected.
    pub fn list(&self, scope: &str) -> Result<Vec<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let mut stmt = conn
            .prepare(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at,
                 EXISTS(SELECT 1 FROM pi_oauth_refresh_intents AS intent
                   WHERE intent.scope = pi_accounts.scope AND intent.account_id = pi_accounts.account_id
                     AND intent.revision = pi_accounts.nonce AND intent.state <> 'retry')
				 FROM pi_accounts WHERE scope = ?1
				 ORDER BY is_active DESC, gateway_active DESC, updated_at DESC, account_id ASC",
            )
            .context("preparing pi_accounts list query")?;
        let rows = stmt
            .query_map(params![scope], |row| {
                Ok(AccountInfo {
                    account_id: row.get(0)?,
                    label: row.get(1)?,
                    kind: row.get(2)?,
                    active: row.get::<_, i64>(3)? != 0,
                    gateway_active: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                    needs_reauth: row.get(6)?,
                })
            })
            .context("querying pi_accounts")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading pi_accounts row")?);
        }
        Ok(out)
    }

    /// Check an account's exact scope without reading its encrypted credential.
    pub fn contains(&self, scope: &str, account_id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pi_accounts WHERE scope = ?1 AND account_id = ?2)",
            params![scope, account_id],
            |row| row.get(0),
        )
        .context("checking scoped account existence")
    }

    /// Every scope that has at least one account, for materialization sweeps.
    pub fn scopes(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let mut stmt = conn
            .prepare("SELECT DISTINCT scope FROM pi_accounts")
            .context("preparing pi_accounts scope query")?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .context("querying pi_accounts scopes")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading pi_accounts scope")?);
        }
        Ok(out)
    }

    /// How many accounts a scope holds (the picker's badge / configured hint).
    pub fn count(&self, scope: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pi_accounts WHERE scope = ?1",
                params![scope],
                |row| row.get(0),
            )
            .context("counting pi_accounts")?;
        Ok(n as usize)
    }

    /// The active account's credential for a scope, decrypted. `Ok(None)` when
    /// the scope has no active account, or when its active account is opaque
    /// (holds no readable credential).
    pub fn active_credential(&self, scope: &str) -> Result<Option<(String, Value)>> {
        let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT account_id, nonce, ciphertext FROM pi_accounts
                 WHERE scope = ?1 AND is_active = 1",
                params![scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("reading active pi_account")?
        };
        let Some((account_id, Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some((account_id, serde_json::from_slice(&plain)?)))
    }

    /// The Gateway-selected account's credential for a scope, decrypted. This is
    /// separate from [`active_credential`]: a personal account switch must not
    /// replace the account a shared Gateway uses.
    pub fn gateway_credential(&self, scope: &str) -> Result<Option<(String, Value)>> {
        let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT account_id, nonce, ciphertext FROM pi_accounts
				 WHERE scope = ?1 AND gateway_active = 1",
                params![scope],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("reading Gateway-active pi_account")?
        };
        let Some((account_id, Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some((account_id, serde_json::from_slice(&plain)?)))
    }

    /// The active account's info (id/label/kind) without touching the cipher.
    pub fn active_info(&self, scope: &str) -> Result<Option<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let row: Option<AccountInfo> = conn
            .query_row(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at,
                 EXISTS(SELECT 1 FROM pi_oauth_refresh_intents AS intent
                   WHERE intent.scope = pi_accounts.scope AND intent.account_id = pi_accounts.account_id
                     AND intent.revision = pi_accounts.nonce AND intent.state <> 'retry')
				 FROM pi_accounts WHERE scope = ?1 AND is_active = 1",
                params![scope],
                |row| {
                    Ok(AccountInfo {
                        account_id: row.get(0)?,
                        label: row.get(1)?,
                        kind: row.get(2)?,
                        active: row.get::<_, i64>(3)? != 0,
                        gateway_active: row.get::<_, i64>(4)? != 0,
                        updated_at: row.get(5)?,
                    needs_reauth: row.get(6)?,
                    })
                },
            )
            .optional()
            .context("reading active pi_account info")?;
        Ok(row)
    }

    /// The Gateway-selected account's info without touching the cipher.
    pub fn gateway_active_info(&self, scope: &str) -> Result<Option<AccountInfo>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        let row: Option<AccountInfo> = conn
            .query_row(
                "SELECT account_id, label, kind, is_active, gateway_active, updated_at,
                 EXISTS(SELECT 1 FROM pi_oauth_refresh_intents AS intent
                   WHERE intent.scope = pi_accounts.scope AND intent.account_id = pi_accounts.account_id
                     AND intent.revision = pi_accounts.nonce AND intent.state <> 'retry')
				 FROM pi_accounts WHERE scope = ?1 AND gateway_active = 1",
                params![scope],
                |row| {
                    Ok(AccountInfo {
                        account_id: row.get(0)?,
                        label: row.get(1)?,
                        kind: row.get(2)?,
                        active: row.get::<_, i64>(3)? != 0,
                        gateway_active: row.get::<_, i64>(4)? != 0,
                        updated_at: row.get(5)?,
                    needs_reauth: row.get(6)?,
                    })
                },
            )
            .optional()
            .context("reading Gateway-active pi_account info")?;
        Ok(row)
    }

    /// Read one account's credential by id, decrypted. `Ok(None)` when absent or
    /// when the account is opaque (holds no readable credential).
    pub fn credential(&self, scope: &str, account_id: &str) -> Result<Option<Value>> {
        let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = {
            let conn = self.conn.lock().expect("pi-accounts mutex");
            conn.query_row(
                "SELECT nonce, ciphertext FROM pi_accounts
                 WHERE scope = ?1 AND account_id = ?2",
                params![scope, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("reading pi_account")?
        };
        let Some((Some(nonce), Some(ciphertext))) = row else {
            return Ok(None);
        };
        let plain = self.cipher.decrypt(&nonce, &ciphertext)?;
        Ok(Some(serde_json::from_slice(&plain)?))
    }

    /// Opaque local revision for a sealed credential. Encryption generates a new
    /// nonce when the credential changes; account labels and active selectors do
    /// not change it. Never return this value from a public account API.
    pub fn credential_revision(&self, scope: &str, account_id: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().expect("pi-accounts mutex");
        conn.query_row(
            "SELECT nonce FROM pi_accounts WHERE scope = ?1 AND account_id = ?2",
            params![scope, account_id],
            |row| row.get(0),
        )
        .optional()
        .context("reading pi_account credential revision")
        .map(Option::flatten)
    }
}
