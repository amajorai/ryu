//! Environments, folders, and folder imports.

use super::*;

impl PluginSecretStore {
    // ── Environments, folders, imports ────────────────────────────────────

    pub async fn list_environments(&self) -> Result<Vec<Environment>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT slug, name, protected, required_approvals, position, cas_required
             FROM vault_environments ORDER BY position, slug",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Environment {
                slug: row.get(0)?,
                name: row.get(1)?,
                protected: row.get::<_, i64>(2)? != 0,
                required_approvals: row.get::<_, i64>(3)?.clamp(1, 5) as u8,
                position: row.get(4)?,
                cas_required: row.get::<_, i64>(5)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub async fn environment(&self, slug: &str) -> Result<Option<Environment>> {
        Ok(self
            .list_environments()
            .await?
            .into_iter()
            .find(|env| env.slug == slug))
    }

    pub async fn put_environment(
        &self,
        environment: &Environment,
        actor: &AuditActor,
    ) -> Result<()> {
        if !is_valid_environment(&environment.slug) {
            bail!("environment slug must match ^[a-z0-9][a-z0-9-]{{0,31}}$");
        }
        let name = environment.name.trim();
        if name.is_empty() || name.len() > 64 {
            bail!("environment name must be 1-64 characters");
        }
        if !(1..=5).contains(&environment.required_approvals) {
            bail!("requiredApprovals must be between 1 and 5");
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_environments
                (slug, name, protected, required_approvals, position, created_at, cas_required)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(slug) DO UPDATE SET name = excluded.name, protected = excluded.protected,
                 required_approvals = excluded.required_approvals, position = excluded.position,
                 cas_required = excluded.cas_required",
            params![
                environment.slug,
                name,
                environment.protected as i64,
                environment.required_approvals as i64,
                environment.position,
                now_millis(),
                environment.cas_required as i64
            ],
        )?;
        let mut entry = AuditEntry::new(actor, "environment.put", "ok").details(json!({
            "protected": environment.protected,
            "requiredApprovals": environment.required_approvals,
            "casRequired": environment.cas_required,
        }));
        entry.environment = Some(environment.slug.clone());
        self.audit_locked(&conn, &entry);
        Ok(())
    }

    /// Delete an environment that holds no secrets and no typed items. The
    /// default environment cannot be deleted.
    pub async fn delete_environment(&self, slug: &str, actor: &AuditActor) -> Result<bool> {
        if slug == DEFAULT_ENVIRONMENT {
            return Err(
                VaultError::Invalid("the default environment cannot be deleted".into()).into(),
            );
        }
        let conn = self.conn.lock().await;
        let used: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_secrets WHERE environment = ?1",
            params![slug],
            |row| row.get(0),
        )?;
        if used > 0 {
            return Err(VaultError::Conflict(format!(
                "environment `{slug}` still holds {used} secret(s)"
            ))
            .into());
        }
        let items: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_items WHERE environment = ?1",
            params![slug],
            |row| row.get(0),
        )?;
        if items > 0 {
            return Err(VaultError::Conflict(format!(
                "environment `{slug}` still holds {items} item(s)"
            ))
            .into());
        }
        conn.execute(
            "DELETE FROM vault_folders WHERE environment = ?1",
            params![slug],
        )?;
        conn.execute(
            "DELETE FROM vault_imports WHERE environment = ?1 OR source_environment = ?1",
            params![slug],
        )?;
        let removed = conn.execute(
            "DELETE FROM vault_environments WHERE slug = ?1",
            params![slug],
        )? > 0;
        let mut entry = AuditEntry::new(actor, "environment.delete", "ok");
        entry.environment = Some(slug.to_owned());
        self.audit_locked(&conn, &entry);
        Ok(removed)
    }

    /// Folders in an environment: explicit folders plus every folder in use.
    pub async fn list_folders(&self, environment: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut folders = BTreeSet::new();
        folders.insert(ROOT_PATH.to_owned());
        for sql in [
            "SELECT path FROM vault_folders WHERE environment = ?1",
            "SELECT DISTINCT path FROM vault_secrets WHERE environment = ?1 AND deleted_at IS NULL",
        ] {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![environment], |row| row.get::<_, String>(0))?;
            for row in rows {
                let path = row?;
                // Include every ancestor so the tree is navigable.
                let mut prefix = String::new();
                for segment in path
                    .trim_start_matches('/')
                    .split('/')
                    .filter(|s| !s.is_empty())
                {
                    prefix.push('/');
                    prefix.push_str(segment);
                    folders.insert(prefix.clone());
                }
            }
        }
        Ok(folders.into_iter().collect())
    }

    pub async fn create_folder(&self, environment: &str, path: &str) -> Result<String> {
        if !is_valid_environment(environment) {
            bail!("invalid environment");
        }
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO vault_folders (environment, path, created_at) VALUES (?1, ?2, ?3)",
            params![environment, path, now_millis()],
        )?;
        Ok(path)
    }

    /// Delete an empty folder (explicit row only).
    pub async fn delete_folder(&self, environment: &str, path: &str) -> Result<bool> {
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let conn = self.conn.lock().await;
        let used: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_secrets WHERE environment = ?1
               AND (path = ?2 OR path LIKE ?3) AND deleted_at IS NULL",
            params![environment, path, format!("{path}/%")],
            |row| row.get(0),
        )?;
        if used > 0 {
            return Err(VaultError::Conflict("the folder is not empty".into()).into());
        }
        Ok(conn.execute(
            "DELETE FROM vault_folders WHERE environment = ?1 AND path = ?2",
            params![environment, path],
        )? > 0)
    }

    pub async fn list_imports(&self) -> Result<Vec<FolderImport>> {
        let conn = self.conn.lock().await;
        list_imports_locked(&conn)
    }

    pub async fn add_import(
        &self,
        import: &FolderImport,
        actor: &AuditActor,
    ) -> Result<FolderImport> {
        for env in [&import.environment, &import.source_environment] {
            if !is_valid_environment(env) {
                bail!("invalid environment `{env}`");
            }
        }
        let path = normalize_path(&import.path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let source_path = normalize_path(&import.source_path)
            .ok_or_else(|| anyhow!("invalid source folder path"))?;
        if import.environment == import.source_environment && path == source_path {
            bail!("a folder cannot import itself");
        }
        let stored = FolderImport {
            id: format!("vim_{}", uuid::Uuid::new_v4().simple()),
            environment: import.environment.clone(),
            path,
            source_environment: import.source_environment.clone(),
            source_path,
            position: import.position,
        };
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_imports
                (id, environment, path, source_environment, source_path, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                stored.id,
                stored.environment,
                stored.path,
                stored.source_environment,
                stored.source_path,
                stored.position,
                now_millis()
            ],
        )
        .map_err(|_| VaultError::Conflict("this import already exists".into()))?;
        let mut entry = AuditEntry::new(actor, "import.add", "ok").details(json!({
            "sourceEnvironment": stored.source_environment,
            "sourcePath": stored.source_path,
        }));
        entry.environment = Some(stored.environment.clone());
        entry.path = Some(stored.path.clone());
        self.audit_locked(&conn, &entry);
        Ok(stored)
    }

    pub async fn remove_import(&self, id: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM vault_imports WHERE id = ?1", params![id])? > 0;
        if removed {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "import.remove", "ok").details(json!({ "id": id })),
            );
        }
        Ok(removed)
    }
}

pub(super) fn list_imports_locked(conn: &Connection) -> Result<Vec<FolderImport>> {
    let mut stmt = conn.prepare(
        "SELECT id, environment, path, source_environment, source_path, position
         FROM vault_imports ORDER BY environment, path, position, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FolderImport {
            id: row.get(0)?,
            environment: row.get(1)?,
            path: row.get(2)?,
            source_environment: row.get(3)?,
            source_path: row.get(4)?,
            position: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
