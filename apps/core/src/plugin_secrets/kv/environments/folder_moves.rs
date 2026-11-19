//! Folder rename/move and single-value move.
//!
//! Values are sealed without associated data, so a move only rewrites the
//! coordinate columns: the ciphertext and the whole version history follow
//! the row. A folder move also carries the folder's explicit sub-folders, its
//! folder imports (on both sides) and its KV v2 folder versions. Both moves
//! are one transaction and refuse, without changing anything, when:
//!
//! - a destination value already exists (soft-deleted rows count: they keep
//!   their name until destroyed);
//! - a value on either side is under a namespace lock or in a folder sourced
//!   from an external store;
//! - a pending change request targets a moved value (it would land on the
//!   old coordinates);
//! - the folder holds items (they have their own policy keys; move them
//!   first).

use super::*;

/// Result of [`PluginSecretStore::move_folder`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMoveReport {
    pub environment: String,
    pub path: String,
    pub to_environment: String,
    pub to_path: String,
    /// Values moved, including soft-deleted ones.
    pub values: usize,
    /// Explicit folders moved.
    pub folders: usize,
    /// Folder imports rewritten.
    pub imports: usize,
}

/// `path` re-rooted from `from` to `to` when it is `from` or under it.
pub(crate) fn rebase_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_owned());
    }
    let rest = path.strip_prefix(from)?;
    if !rest.starts_with('/') {
        return None;
    }
    Some(if to == ROOT_PATH {
        rest.to_owned()
    } else {
        format!("{to}{rest}")
    })
}

fn rows_under(conn: &Connection, environment: &str, from: &str) -> Result<Vec<(String, VaultSecretInfo)>> {
    let sql = format!(
        "SELECT {INFO_COLUMNS} FROM vault_secrets
         WHERE environment = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)
         ORDER BY path, name"
    );
    let prefix = format!("{from}/");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![environment, from, prefix.chars().count() as i64, prefix],
        info_from_row,
    )?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(found) = row? {
            out.push(found);
        }
    }
    Ok(out)
}

/// Pending change requests whose target satisfies `hit`.
fn pending_changes(conn: &Connection, hit: impl Fn(&SecretCoords) -> bool) -> Result<usize> {
    let mut stmt =
        conn.prepare("SELECT coords FROM vault_change_requests WHERE status = 'pending'")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut count = 0;
    for row in rows {
        if serde_json::from_str::<SecretCoords>(&row?).is_ok_and(|coords| hit(&coords)) {
            count += 1;
        }
    }
    Ok(count)
}

fn count_under(conn: &Connection, table: &str, environment: &str, from: &str) -> Result<i64> {
    let prefix = format!("{from}/");
    Ok(conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {table}
             WHERE environment = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)"
        ),
        params![environment, from, prefix.chars().count() as i64, prefix],
        |row| row.get(0),
    )?)
}

fn guard_both(conn: &Connection, from: &SecretCoords, to: &SecretCoords) -> Result<()> {
    for coords in [from, to] {
        crate::vault::external::guard_local_write(conn, coords)?;
        crate::vault::policy::namespace_locks::guard_unlocked(conn, coords)?;
    }
    Ok(())
}

impl PluginSecretStore {
    /// Move (or rename) folder `from` in `environment` to `to` in
    /// `to_environment`, with everything under it. `allow(old, new)` is the
    /// caller's per-value authorization; one refusal refuses the whole move
    /// and reports a count, never a name.
    pub async fn move_folder(
        &self,
        environment: &str,
        from: &str,
        to_environment: &str,
        to: &str,
        actor: &AuditActor,
        allow: impl Fn(&SecretCoords, &SecretCoords) -> bool,
    ) -> Result<FolderMoveReport> {
        for env in [environment, to_environment] {
            if !is_valid_environment(env) {
                return Err(VaultError::Invalid(format!("invalid environment `{env}`")).into());
            }
        }
        let invalid = || VaultError::Invalid("invalid folder path".into());
        let from = normalize_path(from).ok_or_else(invalid)?;
        let to = normalize_path(to).ok_or_else(invalid)?;
        if from == ROOT_PATH {
            return Err(VaultError::Invalid("the root folder cannot be moved".into()).into());
        }
        if environment == to_environment && rebase_path(&to, &from, &to).is_some() {
            return Err(VaultError::Invalid(
                "a folder cannot move to itself or into its own sub-folder".into(),
            )
            .into());
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let items = count_under(&tx, "vault_items", environment, &from)?;
        if items > 0 {
            return Err(VaultError::Conflict(format!(
                "the folder holds {items} item(s); move or delete them first"
            ))
            .into());
        }
        for (env, path) in [(environment, from.as_str()), (to_environment, to.as_str())] {
            if count_under(&tx, "vault_external_sources", env, path)? > 0 {
                return Err(VaultError::Conflict(
                    "a folder on either side is sourced from an external store".into(),
                )
                .into());
            }
        }
        let rows = rows_under(&tx, environment, &from)?;
        let mut moves = Vec::with_capacity(rows.len());
        let (mut refused, mut taken) = (0, 0);
        for (id, info) in rows {
            let old = info.coords();
            let path = rebase_path(&old.path, &from, &to).ok_or_else(invalid)?;
            let new = SecretCoords {
                environment: to_environment.to_owned(),
                path,
                ..old.clone()
            };
            guard_both(&tx, &old, &new)?;
            if !allow(&old, &new) {
                refused += 1;
            } else if find_row(&tx, &new)?.is_some() {
                taken += 1;
            }
            moves.push((id, old, new));
        }
        if refused > 0 {
            return Err(VaultError::Denied(format!(
                "{refused} value(s) under the folder cannot be moved by this caller"
            ))
            .into());
        }
        if taken > 0 {
            return Err(VaultError::Conflict(format!(
                "{taken} value(s) already exist at the destination"
            ))
            .into());
        }
        let pending = pending_changes(&tx, |coords| {
            coords.environment == environment && rebase_path(&coords.path, &from, &to).is_some()
        })?;
        if pending > 0 {
            return Err(VaultError::Conflict(format!(
                "{pending} pending change request(s) target values under the folder"
            ))
            .into());
        }
        for (id, _, new) in &moves {
            tx.execute(
                "UPDATE vault_secrets SET environment = ?1, path = ?2 WHERE id = ?3",
                params![new.environment, new.path, id],
            )?;
        }
        let folders = move_folder_rows(&tx, environment, &from, to_environment, &to)?;
        let imports = move_imports(&tx, environment, &from, to_environment, &to)?;
        let report = FolderMoveReport {
            environment: environment.to_owned(),
            path: from,
            to_environment: to_environment.to_owned(),
            to_path: to,
            values: moves.len(),
            folders,
            imports,
        };
        let mut entry = AuditEntry::new(actor, "folder.move", "ok").details(json!({
            "toEnvironment": report.to_environment,
            "toPath": report.to_path,
            "values": report.values,
        }));
        entry.environment = Some(report.environment.clone());
        entry.path = Some(report.path.clone());
        self.audit_locked(&tx, &entry);
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(report)
    }

    /// Move one value to `to` (another folder, environment or name). The
    /// caller authorizes both sides first.
    pub async fn move_secret(
        &self,
        from: SecretCoords,
        to: SecretCoords,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        let from = from.normalize()?;
        let to = to.normalize()?;
        if from.scope != to.scope || from.scope_id != to.scope_id || from.binding != to.binding {
            return Err(VaultError::Invalid("a move keeps the value's scope and binding".into()).into());
        }
        if from == to {
            return Err(VaultError::Invalid("the value is already there".into()).into());
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        guard_both(&tx, &from, &to)?;
        let Some((id, _)) = find_row(&tx, &from)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if find_row(&tx, &to)?.is_some() {
            return Err(VaultError::Conflict("a value already exists at the destination".into()).into());
        }
        if pending_changes(&tx, |coords| *coords == from)? > 0 {
            return Err(VaultError::Conflict("a pending change request targets this value".into()).into());
        }
        tx.execute(
            "UPDATE vault_secrets SET environment = ?1, path = ?2, name = ?3 WHERE id = ?4",
            params![to.environment, to.path, to.name, id],
        )?;
        self.audit_locked(
            &tx,
            &from.audit(AuditEntry::new(actor, "secret.move", "ok").details(json!({
                "toEnvironment": to.environment,
                "toPath": to.path,
                "toName": to.name,
            }))),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        find_row(&conn, &to)?
            .map(|(_, info)| info)
            .ok_or_else(|| anyhow!("moved secret disappeared"))
    }
}

/// Re-root explicit folders and KV v2 folder versions; keeps `to` as an
/// explicit folder so an emptied destination stays listed.
fn move_folder_rows(
    tx: &Connection,
    environment: &str,
    from: &str,
    to_environment: &str,
    to: &str,
) -> Result<usize> {
    let mut stmt = tx.prepare("SELECT path FROM vault_folders WHERE environment = ?1")?;
    let paths = stmt
        .query_map(params![environment], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut moved = 0;
    for path in paths {
        let Some(new) = rebase_path(&path, from, to) else {
            continue;
        };
        tx.execute(
            "DELETE FROM vault_folders WHERE environment = ?1 AND path = ?2",
            params![environment, path],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO vault_folders (environment, path, created_at)
             VALUES (?1, ?2, ?3)",
            params![to_environment, new, now_millis()],
        )?;
        moved += 1;
    }
    tx.execute(
        "INSERT OR IGNORE INTO vault_folders (environment, path, created_at) VALUES (?1, ?2, ?3)",
        params![to_environment, to, now_millis()],
    )?;
    let mut stmt = tx.prepare(
        "SELECT scope_id, path FROM vault_kv_folder_versions WHERE environment = ?1",
    )?;
    let versions = stmt
        .query_map(params![environment], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (scope_id, path) in versions {
        if let Some(new) = rebase_path(&path, from, to) {
            tx.execute(
                "UPDATE OR REPLACE vault_kv_folder_versions SET environment = ?1, path = ?2
                 WHERE scope_id = ?3 AND environment = ?4 AND path = ?5",
                params![to_environment, new, scope_id, environment, path],
            )?;
        }
    }
    Ok(moved)
}

/// Rewrite imports whose folder or source folder is under `from`.
fn move_imports(
    tx: &Connection,
    environment: &str,
    from: &str,
    to_environment: &str,
    to: &str,
) -> Result<usize> {
    let mut moved = 0;
    for import in list_imports_locked(tx)? {
        let target = (import.environment == environment)
            .then(|| rebase_path(&import.path, from, to))
            .flatten();
        let source = (import.source_environment == environment)
            .then(|| rebase_path(&import.source_path, from, to))
            .flatten();
        if target.is_none() && source.is_none() {
            continue;
        }
        let (env, path) = match &target {
            Some(path) => (to_environment, path.as_str()),
            None => (import.environment.as_str(), import.path.as_str()),
        };
        let (source_env, source_path) = match &source {
            Some(path) => (to_environment, path.as_str()),
            None => (import.source_environment.as_str(), import.source_path.as_str()),
        };
        tx.execute(
            "UPDATE OR REPLACE vault_imports SET environment = ?1, path = ?2,
                 source_environment = ?3, source_path = ?4 WHERE id = ?5",
            params![env, path, source_env, source_path, import.id],
        )?;
        moved += 1;
    }
    Ok(moved)
}

#[cfg(test)]
#[path = "folder_moves_tests.rs"]
mod tests;
