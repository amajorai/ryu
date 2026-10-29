//! [`ConversationStore`] methods for the hierarchy: thread placement, main
//! threads, spawned sessions and stored scope defaults. A grandchild of
//! `conversations`, so it uses the store's private connection directly.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::{now_millis, ConversationStore, ConversationSummary, Tenancy};
use super::defaults::{non_empty, scope_default_from_row, valid_opaque_id, SCOPE_DEFAULT_COLUMNS};
use super::{
    agent_scope, hierarchy_from_row, is_valid_scope, project_agent_scope, project_scope,
    validate_coordination, validate_opaque_id, CascadeLevels, DefaultsRole, OwnerKind,
    ScopeDefault, ThreadHierarchy, GLOBAL_SCOPE, HIERARCHY_SELECT, MAX_HIERARCHY_LISTING,
};

fn set_thread_project_locked(
    conn: &Connection,
    conversation_id: &str,
    project_id: Option<&str>,
) -> Result<bool> {
    let changed = conn
        .execute(
            "UPDATE conversations SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now_millis(), conversation_id],
        )
        .context("setting conversation project")?;
    Ok(changed == 1)
}

fn mark_spawned_by_locked(
    conn: &Connection,
    child_id: &str,
    parent_id: &str,
    parent_message_id: Option<&str>,
) -> Result<()> {
    if child_id == parent_id {
        return Ok(());
    }
    conn.execute(
        "UPDATE conversations
            SET spawned_by_conversation_id = ?2,
                spawned_by_message_id = ?3,
                project_id = COALESCE(project_id,
                    (SELECT p.project_id FROM conversations p WHERE p.id = ?2))
          WHERE id = ?1 AND spawned_by_conversation_id IS NULL AND thread_role = 'session'",
        params![child_id, parent_id, non_empty(parent_message_id)],
    )
    .context("recording session lineage")?;
    Ok(())
}

impl ConversationStore {
    /// The hierarchy metadata of one conversation, or `None` if it does not exist.
    pub async fn thread_hierarchy(&self, conversation_id: &str) -> Result<Option<ThreadHierarchy>> {
        let conn = self.conn.lock().await;
        let sql = format!("SELECT {HIERARCHY_SELECT} FROM conversations c WHERE c.id = ?1");
        Ok(conn
            .query_row(&sql, params![conversation_id], |row| {
                hierarchy_from_row(row, 0)
            })
            .optional()?)
    }

    /// Place a conversation in a project (or take it out with `None`). Returns
    /// `false` when the conversation does not exist.
    pub async fn set_thread_project(
        &self,
        conversation_id: &str,
        project_id: Option<&str>,
    ) -> Result<bool> {
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        let conn = self.conn.lock().await;
        set_thread_project_locked(&conn, conversation_id, project_id)
    }

    /// Atomically file a thread and optionally record its write-once lineage.
    /// Callers authorize the child and parent before entering this transaction.
    pub async fn place_thread_in_project(
        &self,
        conversation_id: &str,
        project_id: Option<&str>,
        parent_id: Option<&str>,
    ) -> Result<bool> {
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        let parent_id = non_empty(parent_id);
        let mut conn = self.conn.lock().await;
        let transaction = conn
            .transaction()
            .context("placing conversation in project")?;
        let changed = set_thread_project_locked(&transaction, conversation_id, project_id)
            .context("placing conversation in project")?;
        if changed {
            if let Some(parent_id) = parent_id {
                mark_spawned_by_locked(&transaction, conversation_id, parent_id, None)
                    .context("placing conversation in project")?;
            }
        }
        transaction
            .commit()
            .context("placing conversation in project")?;
        Ok(changed)
    }

    /// Set (or clear) the coordination strategy of a group's main thread.
    /// Returns `false` when the conversation does not exist or is not a group
    /// main thread.
    pub async fn set_group_coordination(
        &self,
        conversation_id: &str,
        coordination: Option<&str>,
    ) -> Result<bool> {
        validate_coordination(coordination)?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET coordination = ?1, updated_at = ?2
                  WHERE id = ?3 AND thread_role = 'main' AND owner_kind = 'group'",
                params![non_empty(coordination), now_millis(), conversation_id],
            )
            .context("setting group coordination")?;
        Ok(changed == 1)
    }

    /// Promote a conversation to an ad-hoc group main thread (owned by itself).
    /// Used when a second agent or human participant joins a plain chat. A thread
    /// that is already a main thread keeps its existing owner.
    pub async fn promote_to_group_main(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations
                    SET thread_role = 'main', owner_kind = 'group', owner_id = id
                  WHERE id = ?1 AND thread_role <> 'main'",
                params![conversation_id],
            )
            .context("promoting conversation to a group main thread")?;
        Ok(changed == 1)
    }

    /// Record which thread (and turn) spawned a session. Write-once: a session
    /// keeps the lineage of the thread that first created it, so a later
    /// coordinator messaging the same worker cannot re-parent it. The child also
    /// inherits the parent's project when it has none.
    pub async fn mark_spawned_by(
        &self,
        child_id: &str,
        parent_id: &str,
        parent_message_id: Option<&str>,
    ) -> Result<()> {
        if child_id == parent_id {
            return Ok(());
        }
        let conn = self.conn.lock().await;
        mark_spawned_by_locked(&conn, child_id, parent_id, parent_message_id)
    }

    /// The main thread of `(project, owner)`, if one exists.
    pub async fn find_main_thread(
        &self,
        project_id: Option<&str>,
        owner_kind: OwnerKind,
        owner_id: &str,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        Ok(find_main_thread_locked(
            &conn,
            non_empty(project_id),
            owner_kind,
            owner_id,
            None,
        )?)
    }

    /// The main thread `tenancy` owns for `(project, owner)`. A bot's personal
    /// main thread (no project) belongs to one principal, so each verified user
    /// and the node operator get their own; project and group main threads stay
    /// shared under their existing access contract.
    pub async fn find_main_thread_for_tenancy(
        &self,
        project_id: Option<&str>,
        owner_kind: OwnerKind,
        owner_id: &str,
        tenancy: &Tenancy,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        Ok(find_main_thread_locked(
            &conn,
            non_empty(project_id),
            owner_kind,
            owner_id,
            Some(tenancy),
        )?)
    }

    /// Return the main thread of `(project, owner)`, creating it on first use.
    ///
    /// Concurrent callers converge on one row: the partial unique index rejects a
    /// second main thread for the same scope and the loser re-reads the winner.
    pub async fn ensure_main_thread(
        &self,
        project_id: Option<&str>,
        owner_kind: OwnerKind,
        owner_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        validate_opaque_id(owner_id)?;
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        if let Some(existing) = self
            .find_main_thread_for_tenancy(project_id, owner_kind, owner_id, &tenancy)
            .await?
        {
            return Ok(existing);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.ensure_conversation(&id, non_empty(agent_id), title, tenancy.clone())
            .await?;
        let conn = self.conn.lock().await;
        let promoted = conn.execute(
            "UPDATE conversations
                SET project_id = ?2, thread_role = 'main', owner_kind = ?3, owner_id = ?4
              WHERE id = ?1",
            params![id, project_id, owner_kind.as_str(), owner_id.trim()],
        );
        match promoted {
            Ok(_) => Ok(id),
            Err(error) => {
                // Lost the race: drop our empty row and hand back the winner.
                conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
                    .ok();
                find_main_thread_locked(&conn, project_id, owner_kind, owner_id, Some(&tenancy))?
                    .ok_or_else(|| anyhow::anyhow!("creating main thread: {error}"))
            }
        }
    }

    /// Summaries of the sessions a thread spawned, newest activity first.
    pub async fn list_spawned_sessions(&self, parent_id: &str) -> Result<Vec<ConversationSummary>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM conversations WHERE spawned_by_conversation_id = ?1
                  ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let ids = stmt
                .query_map(params![parent_id, MAX_HIERARCHY_LISTING as i64], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        self.summaries_for_ids(&ids).await
    }

    /// Summaries of every thread in a project, newest activity first.
    pub async fn list_project_threads(&self, project_id: &str) -> Result<Vec<ConversationSummary>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM conversations WHERE project_id = ?1
                  ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let ids = stmt
                .query_map(
                    params![project_id.trim(), MAX_HIERARCHY_LISTING as i64],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        self.summaries_for_ids(&ids).await
    }

    async fn summaries_for_ids(&self, ids: &[String]) -> Result<Vec<ConversationSummary>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(summary) = self.get_summary(id).await? {
                out.push(summary);
            }
        }
        Ok(out)
    }

    /// One stored scope default, if set.
    pub async fn scope_default(&self, scope: &str) -> Result<Option<ScopeDefault>> {
        let conn = self.conn.lock().await;
        Ok(conn
            .query_row(
                &format!("SELECT {SCOPE_DEFAULT_COLUMNS} FROM scope_defaults WHERE scope = ?1"),
                params![scope],
                |row| scope_default_from_row(row, 0),
            )
            .optional()?)
    }

    /// Every stored scope default, keyed by scope.
    pub async fn list_scope_defaults(&self) -> Result<Vec<(String, ScopeDefault)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT scope, {SCOPE_DEFAULT_COLUMNS} FROM scope_defaults ORDER BY scope"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, scope_default_from_row(row, 1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Write a scope default. An all-empty value clears the scope (reset to
    /// inherited).
    pub async fn set_scope_default(&self, scope: &str, value: ScopeDefault) -> Result<()> {
        if !is_valid_scope(scope) {
            anyhow::bail!("invalid scope '{scope}'");
        }
        let value = value.trimmed();
        let conn = self.conn.lock().await;
        if value.is_empty() {
            conn.execute(
                "DELETE FROM scope_defaults WHERE scope = ?1",
                params![scope],
            )?;
            return Ok(());
        }
        conn.execute(
            "INSERT INTO scope_defaults (scope, provider, model, effort, coordinator_provider,
                 coordinator_model, coordinator_effort, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(scope) DO UPDATE SET
                 provider = excluded.provider, model = excluded.model,
                 effort = excluded.effort,
                 coordinator_provider = excluded.coordinator_provider,
                 coordinator_model = excluded.coordinator_model,
                 coordinator_effort = excluded.coordinator_effort,
                 updated_at = excluded.updated_at",
            params![
                scope,
                value.provider,
                value.model,
                value.effort,
                value.coordinator_provider,
                value.coordinator_model,
                value.coordinator_effort,
                now_millis()
            ],
        )
        .context("writing scope default")?;
        Ok(())
    }

    /// The stored levels of the cascade for `(project, agent)`, reduced for a
    /// thread of `role`. Session, binding and lane levels belong to the caller
    /// (they live elsewhere).
    pub async fn stored_cascade_levels(
        &self,
        project_id: Option<&str>,
        agent_id: Option<&str>,
        role: DefaultsRole,
    ) -> Result<CascadeLevels> {
        let project_id = non_empty(project_id).filter(|p| valid_opaque_id(p));
        let agent_id = non_empty(agent_id).filter(|a| valid_opaque_id(a));
        let mut levels = CascadeLevels::default();
        if let (Some(project), Some(agent)) = (project_id, agent_id) {
            levels.project_agent = self
                .scope_default(&project_agent_scope(project, agent))
                .await?;
        }
        if let Some(agent) = agent_id {
            levels.agent = self.scope_default(&agent_scope(agent)).await?;
        }
        if let Some(project) = project_id {
            levels.project = self.scope_default(&project_scope(project)).await?;
        }
        levels.settings = self.scope_default(GLOBAL_SCOPE).await?;
        Ok(levels.for_role(role))
    }
}

/// The main thread of `(project, owner)`. With a `tenancy`, a bot's personal
/// main thread (no project) must belong to exactly that principal; without one,
/// the first matching main thread of any principal is returned.
pub(super) fn find_main_thread_locked(
    conn: &Connection,
    project_id: Option<&str>,
    owner_kind: OwnerKind,
    owner_id: &str,
    tenancy: Option<&Tenancy>,
) -> rusqlite::Result<Option<String>> {
    let (owner_user_id, org_id) = tenancy.map_or((None, None), Tenancy::parts);
    conn.query_row(
        "SELECT id FROM conversations
          WHERE thread_role = 'main' AND IFNULL(project_id, '') = IFNULL(?1, '')
            AND owner_kind = ?2 AND owner_id = ?3
            AND (?4 = 0 OR ?1 IS NOT NULL OR ?2 <> 'agent'
                 OR (owner_user_id IS ?5 AND org_id IS ?6))
          ORDER BY rowid LIMIT 1",
        params![
            project_id,
            owner_kind.as_str(),
            owner_id.trim(),
            tenancy.is_some(),
            owner_user_id,
            org_id
        ],
        |row| row.get(0),
    )
    .optional()
}
