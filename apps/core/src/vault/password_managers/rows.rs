//! Password-manager tables and rows, input validation, CLI binary resolution,
//! and the grant bookkeeping a resolution performs.

use super::*;

// ── Schema and rows ───────────────────────────────────────────────────────

/// Create the password-manager tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_pm_accounts (
             id              TEXT PRIMARY KEY,
             name            TEXT NOT NULL UNIQUE,
             provider        TEXT NOT NULL,
             address         TEXT,
             binary_path     TEXT,
             state           TEXT NOT NULL DEFAULT 'connected',
             last_error      TEXT,
             last_checked_at INTEGER,
             nonce           BLOB NOT NULL,
             ciphertext      BLOB NOT NULL,
             key_version     INTEGER NOT NULL DEFAULT 0,
             created_at      INTEGER NOT NULL,
             updated_at      INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_pm_grants (
             id             TEXT PRIMARY KEY,
             subject        TEXT NOT NULL,
             account_id     TEXT NOT NULL,
             reference      TEXT NOT NULL,
             mode           TEXT NOT NULL,
             uses_remaining INTEGER,
             expires_at     INTEGER NOT NULL,
             granted_by     TEXT NOT NULL,
             proposal_id    TEXT,
             created_at     INTEGER NOT NULL,
             revoked_at     INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_vault_pm_grants_lookup
             ON vault_pm_grants (subject, account_id, reference);",
    )
    .context("initializing password-manager schema")
}

pub(super) const ACCOUNT_COLUMNS: &str =
    "id, name, provider, address, binary_path, state, last_error,
    last_checked_at, created_at, updated_at";

pub(super) fn account_from_row(row: &Row<'_>) -> rusqlite::Result<Option<AccountRecord>> {
    let Some(provider) = ProviderKind::parse(&row.get::<_, String>(2)?) else {
        return Ok(None);
    };
    let state: String = row.get(5)?;
    Ok(Some(AccountRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        provider,
        address: row.get(3)?,
        binary_path: row.get(4)?,
        state: if state == "reconnect_required" {
            AccountState::ReconnectRequired
        } else {
            AccountState::Connected
        },
        last_error: row.get(6)?,
        last_checked_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    }))
}

pub(super) fn accounts_locked(conn: &Connection) -> Result<Vec<AccountRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM vault_pm_accounts ORDER BY name"
    ))?;
    let rows = stmt.query_map([], account_from_row)?;
    Ok(rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect())
}

pub(super) fn account_locked(conn: &Connection, id: &str) -> Result<AccountRecord> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM vault_pm_accounts WHERE id = ?1"),
        params![id],
        account_from_row,
    )
    .optional()?
    .flatten()
    .ok_or_else(|| VaultError::NotFound(format!("password-manager account `{id}`")).into())
}

pub(super) const GRANT_COLUMNS: &str =
    "g.id, g.subject, g.account_id, COALESCE(a.name, ''), g.reference,
    g.mode, g.uses_remaining, g.expires_at, g.granted_by, g.proposal_id, g.created_at,
    g.revoked_at";

pub(super) fn grant_from_row(row: &Row<'_>) -> rusqlite::Result<GrantRecord> {
    let mode: String = row.get(5)?;
    Ok(GrantRecord {
        id: row.get(0)?,
        subject: row.get(1)?,
        account_id: row.get(2)?,
        account: row.get(3)?,
        reference: row.get(4)?,
        mode: GrantMode::parse(&mode).unwrap_or(GrantMode::Once),
        uses_remaining: row.get(6)?,
        expires_at: row.get(7)?,
        granted_by: row.get(8)?,
        proposal_id: row.get(9)?,
        created_at: row.get(10)?,
        revoked_at: row.get(11)?,
    })
}

pub(super) fn grant_locked(conn: &Connection, id: &str) -> Result<GrantRecord> {
    conn.query_row(
        &format!(
            "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
             LEFT JOIN vault_pm_accounts a ON a.id = g.account_id WHERE g.id = ?1"
        ),
        params![id],
        grant_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("password-manager grant `{id}`")).into())
}

/// Delete grants whose usefulness ended more than the retention window ago.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    let cutoff = now - GRANT_RETENTION_MILLIS;
    Ok(conn.execute(
        "DELETE FROM vault_pm_grants
         WHERE expires_at <= ?1 OR (revoked_at IS NOT NULL AND revoked_at <= ?1)
            OR (uses_remaining = 0 AND created_at <= ?1)",
        params![cutoff],
    )?)
}

// ── Validation ────────────────────────────────────────────────────────────

pub(super) fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

pub(super) fn validate_token(token: &str) -> Result<()> {
    if token.trim().is_empty() {
        return Err(invalid("`token` is required"));
    }
    if token.len() > MAX_TOKEN_LEN || token.chars().any(char::is_control) {
        return Err(invalid("`token` is invalid"));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    /// Per-test CLI binary, so tests never mutate the shared process
    /// environment or depend on what `PATH` holds.
    static BINARY_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Use `path` as the CLI binary for accounts added on this test thread.
#[cfg(test)]
pub(crate) fn set_binary_for_test(path: Option<PathBuf>) {
    BINARY_OVERRIDE.with(|cell| *cell.borrow_mut() = path);
}

pub(super) fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(super) fn search_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)).collect::<Vec<_>>())
        .find(|candidate| is_executable_file(candidate))
}

/// The absolute CLI path for a CLI provider, resolved now.
pub(super) fn resolve_binary(provider: ProviderKind) -> Result<Option<String>> {
    let (name, env) = match provider {
        ProviderKind::OnePasswordConnect => return Ok(None),
        ProviderKind::OnePasswordServiceAccount => ("op", ENV_OP_BIN),
        ProviderKind::BitwardenSm => ("bws", ENV_BWS_BIN),
    };
    #[cfg(test)]
    let overridden = BINARY_OVERRIDE.with(|cell| cell.borrow().clone());
    #[cfg(not(test))]
    let overridden: Option<PathBuf> = None;
    let configured = overridden.or_else(|| {
        std::env::var_os(env)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    });
    let candidate = match configured {
        Some(path) if !path.is_absolute() => {
            return Err(invalid(format!("{env} must be an absolute path")))
        }
        Some(path) => path,
        None => search_path(name).ok_or_else(|| {
            invalid(format!(
                "the `{name}` CLI was not found on the Core host's PATH; install it or set {env}"
            ))
        })?,
    };
    if !is_executable_file(&candidate) {
        return Err(invalid(format!(
            "the configured `{name}` CLI is not an executable file"
        )));
    }
    let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
    Ok(Some(resolved.display().to_string()))
}

pub(super) fn validate_account(input: &AccountInput) -> Result<AccountRecord> {
    if !is_valid_account_name(&input.name) {
        return Err(invalid("invalid account name"));
    }
    validate_token(&input.token)?;
    if input
        .binary
        .as_deref()
        .is_some_and(|b| !b.trim().is_empty())
    {
        return Err(invalid(format!(
            "`binary` is not accepted; set {ENV_OP_BIN} or {ENV_BWS_BIN} on the Core host instead"
        )));
    }
    let address = input
        .address
        .as_deref()
        .map(str::trim)
        .filter(|address| !address.is_empty());
    let address = match (input.provider, address) {
        (ProviderKind::OnePasswordConnect, None) => {
            return Err(invalid(
                "1password-connect accounts need the Connect server `address`",
            ))
        }
        (ProviderKind::OnePasswordServiceAccount, Some(_)) => {
            return Err(invalid(
                "1password-service-account accounts take no `address`",
            ))
        }
        (_, Some(address)) => {
            if address.len() > MAX_ADDRESS_LEN {
                return Err(invalid("address is too long"));
            }
            let url = net::validate_address(address, net::Egress::from_env())
                .map_err(|error| invalid(error.to_string()))?;
            Some(url.as_str().trim_end_matches('/').to_owned())
        }
        (_, None) => None,
    };
    let binary_path = resolve_binary(input.provider)?;
    let now = now_millis();
    Ok(AccountRecord {
        id: format!("pma_{}", uuid::Uuid::new_v4().simple()),
        name: input.name.clone(),
        provider: input.provider,
        address,
        binary_path,
        state: AccountState::Connected,
        last_error: None,
        last_checked_at: None,
        created_at: now,
        updated_at: now,
    })
}

/// Pick the account a reference names: the qualified one, or the only
/// account of the reference's family.
pub(super) fn select_account(conn: &Connection, reference: &PmRef) -> Result<AccountRecord> {
    let family: Vec<AccountRecord> = accounts_locked(conn)?
        .into_iter()
        .filter(|account| account.provider.scheme() == reference.scheme)
        .collect();
    if let Some(name) = &reference.account {
        return family
            .into_iter()
            .find(|account| &account.name == name)
            .ok_or_else(|| {
                VaultError::NotFound(format!(
                    "no {} account named `{name}`",
                    reference.scheme.family()
                ))
                .into()
            });
    }
    let mut family = family.into_iter();
    match (family.next(), family.next()) {
        (Some(account), None) => Ok(account),
        (None, _) => Err(VaultError::NotFound(format!(
            "no {} account is connected",
            reference.scheme.family()
        ))
        .into()),
        (Some(_), Some(_)) => Err(invalid(format!(
            "several {} accounts exist; qualify the reference as {}<account>@…",
            reference.scheme.family(),
            reference.scheme.prefix()
        ))),
    }
}

/// Longest provider error kept on an account, in bytes.
const MAX_ERROR_LEN: usize = 300;

/// A provider error cut to [`MAX_ERROR_LEN`] bytes on a char boundary.
///
/// `String::truncate` panics inside a multi-byte character, and provider CLIs
/// echo user-chosen item names and localized messages, so a byte cut could crash
/// Core with the error text (and whatever it quotes) in the panic report.
pub(super) fn short(text: &str) -> String {
    text[..text.floor_char_boundary(MAX_ERROR_LEN)].to_owned()
}

/// Record the outcome of a provider call on the account.
pub(super) fn record_check(
    conn: &Connection,
    id: &str,
    result: Result<(), &ProviderFailure>,
) -> Result<()> {
    let now = now_millis();
    match result {
        Ok(()) => conn.execute(
            "UPDATE vault_pm_accounts SET state = 'connected', last_error = NULL,
                 last_checked_at = ?1 WHERE id = ?2",
            params![now, id],
        )?,
        Err(failure) => conn.execute(
            "UPDATE vault_pm_accounts
             SET state = CASE WHEN ?1 THEN 'reconnect_required' ELSE state END,
                 last_error = ?2, last_checked_at = ?3 WHERE id = ?4",
            params![
                failure.kind == FailureKind::Auth,
                short(&failure.message),
                now,
                id
            ],
        )?,
    };
    Ok(())
}

/// A grant usable now, consuming one use of an approve-once grant. Returns
/// the grant and whether a use was consumed.
pub(super) fn take_grant(
    conn: &Connection,
    subject: &str,
    account_id: &str,
    reference: &str,
    now: i64,
) -> Result<Option<(GrantRecord, bool)>> {
    let grant = conn
        .query_row(
            &format!(
                "SELECT {GRANT_COLUMNS} FROM vault_pm_grants g
                 LEFT JOIN vault_pm_accounts a ON a.id = g.account_id
                 WHERE g.subject = ?1 AND g.account_id = ?2 AND g.reference = ?3
                   AND g.revoked_at IS NULL AND g.expires_at > ?4
                   AND (g.uses_remaining IS NULL OR g.uses_remaining > 0)
                 ORDER BY (g.uses_remaining IS NULL) DESC, g.expires_at DESC LIMIT 1"
            ),
            params![subject, account_id, reference, now],
            grant_from_row,
        )
        .optional()?;
    let Some(grant) = grant else {
        return Ok(None);
    };
    if grant.uses_remaining.is_none() {
        return Ok(Some((grant, false)));
    }
    let consumed = conn.execute(
        "UPDATE vault_pm_grants SET uses_remaining = uses_remaining - 1
         WHERE id = ?1 AND uses_remaining > 0 AND revoked_at IS NULL",
        params![grant.id],
    )?;
    Ok((consumed == 1).then_some((grant, true)))
}

/// Give back a use consumed for a resolution that released nothing.
pub(super) fn restore_grant(conn: &Connection, grant: &GrantRecord, consumed: bool) {
    if !consumed {
        return;
    }
    if let Err(error) = conn.execute(
        "UPDATE vault_pm_grants SET uses_remaining = uses_remaining + 1 WHERE id = ?1",
        params![grant.id],
    ) {
        tracing::warn!("restoring a password-manager grant failed: {error:#}");
    }
}

pub(super) fn failure_outcome(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Auth => "reconnect_required",
        FailureKind::NotFound => "not_found",
        FailureKind::Unavailable => "error",
    }
}

#[cfg(test)]
#[path = "rows_test.rs"]
mod rows_test;
