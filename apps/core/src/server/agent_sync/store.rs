// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

impl AgentSyncStore {
    pub fn open_default() -> Result<Self> {
        Self::open(crate::paths::db_path("agent-sync.db"))
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating sync state directory {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening agent sync database {}", path.display()))?;
        // This connection ATTACHes conversations.db, which the conversation
        // store writes through its own connection; wait out a transient lock
        // instead of failing the sync read with SQLITE_BUSY.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        init_schema(&conn)?;
        attach_conversations(
            &conn,
            path.parent()
                .map(|parent| parent.join("conversations.db"))
                .as_deref(),
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            active: Arc::new(Mutex::new(HashSet::new())),
            node_id: local_node_id(),
        })
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory sync database")?;
        init_schema(&conn)?;
        attach_conversations(&conn, None)?;
        conn.execute("INSERT INTO conversation_state.conversation_generations VALUES ('conversation-1', 'test-generation')", [])?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            active: Arc::new(Mutex::new(HashSet::new())),
            node_id: "test-node".to_owned(),
        })
    }

    pub fn current_generation(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self
            .conn
            .try_lock()
            .map_err(|_| anyhow::anyhow!("sync database busy"))?;
        conn.query_row("SELECT generation FROM conversation_state.conversation_generations WHERE conversation_id = ?1", [conversation_id], |row| row.get(0)).optional().context("reading conversation generation")
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn profiles(&self) -> Result<Vec<SyncProfile>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles ORDER BY provider, root",
        )?;
        let rows = stmt.query_map([], profile_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing sync profiles")
    }

    async fn profile(&self, id: &str) -> Result<Option<SyncProfile>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles WHERE id = ?1",
            [id],
            profile_from_row,
        )
        .optional()
        .context("reading sync profile")
    }

    async fn profile_for_root(&self, root: &Path) -> Result<Option<SyncProfile>> {
        let root = root.to_string_lossy().to_string();
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, provider, root, import_enabled, export_enabled, status,
                    conflict_count, last_operation_id, updated_at, include_conversations
             FROM sync_profiles WHERE root = ?1",
            [root],
            profile_from_row,
        )
        .optional()
        .context("reading sync profile for root")
    }

    async fn upsert_profile(&self, input: ProfileInput) -> Result<SyncProfile> {
        let provider = normalize_provider(&input.provider)?;
        let root = crate::import::canonicalize_root(&input.root)?;
        let root = root.to_string_lossy().to_string();
        let supplied_id = input.id.clone();
        let id = supplied_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("profile_{}", uuid::Uuid::new_v4()));
        let now = now_ms();
        let conn = self.conn.lock().await;
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, provider FROM sync_profiles WHERE root = ?1",
                [&root],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_id, existing_provider)) = existing {
            if existing_id != id && input.id.is_some() {
                bail!("root is already configured by profile {existing_id}");
            }
            if existing_provider != provider && input.id.is_some() {
                bail!("root is already configured for provider {existing_provider}");
            }
            conn.execute(
                "UPDATE sync_profiles
                 SET provider = ?1, import_enabled = ?2, export_enabled = ?3,
                     updated_at = ?4,
                     include_conversations = COALESCE(?6, include_conversations)
                 WHERE id = ?5",
                params![
                    provider,
                    input.import_enabled as i64,
                    input.export_enabled as i64,
                    now,
                    existing_id,
                    input.include_conversations.map(i64::from)
                ],
            )?;
            drop(conn);
            return self
                .profile(&existing_id)
                .await?
                .context("updated sync profile disappeared");
        }
        conn.execute(
            "INSERT INTO sync_profiles
                (id, provider, root, import_enabled, export_enabled, status,
                 conflict_count, updated_at, include_conversations)
             VALUES (?1, ?2, ?3, ?4, ?5, 'idle', 0, ?6, ?7)",
            params![
                id,
                provider,
                root,
                input.import_enabled as i64,
                input.export_enabled as i64,
                now,
                i64::from(input.include_conversations.unwrap_or(false))
            ],
        )?;
        drop(conn);
        self.profile(&id)
            .await?
            .context("created sync profile disappeared")
    }

    async fn delete_profile(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute("DELETE FROM sync_profiles WHERE id = ?1", [id])?;
        Ok(deleted != 0)
    }

    async fn try_start(&self, profile_id: &str) -> bool {
        self.active.lock().await.insert(profile_id.to_owned())
    }

    async fn finish(&self, profile_id: &str) {
        self.active.lock().await.remove(profile_id);
    }

    async fn active_count(&self) -> usize {
        self.active.lock().await.len()
    }

    async fn upsert_item(
        &self,
        profile_id: &str,
        kind: &str,
        source_id: &str,
        source_hash: Option<&str>,
        generated_hash: Option<&str>,
        operation_id: &str,
        state: &str,
        conflict: Option<&Value>,
    ) -> Result<()> {
        let conflict_json = conflict.map(serde_json::to_string).transpose()?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sync_items
                (profile_id, kind, source_id, source_hash, generated_hash,
                 revision, operation_id, state, conflict_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9)
             ON CONFLICT(profile_id, kind, source_id) DO UPDATE SET
                source_hash = COALESCE(excluded.source_hash, sync_items.source_hash),
                generated_hash = COALESCE(excluded.generated_hash, sync_items.generated_hash),
                revision = sync_items.revision + 1,
                operation_id = excluded.operation_id,
                state = excluded.state,
                conflict_json = excluded.conflict_json,
                updated_at = excluded.updated_at",
            params![
                profile_id,
                kind,
                source_id,
                source_hash,
                generated_hash,
                operation_id,
                state,
                conflict_json,
                now_ms()
            ],
        )?;
        Ok(())
    }

    async fn item(
        &self,
        profile_id: &str,
        kind: &str,
        source_id: &str,
    ) -> Result<Option<SyncItemStatus>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT profile_id, kind, source_id, source_hash, generated_hash,
                    revision, operation_id, state, conflict_json, updated_at
             FROM sync_items WHERE profile_id = ?1 AND kind = ?2 AND source_id = ?3",
            params![profile_id, kind, source_id],
            item_from_row,
        )
        .optional()
        .context("reading sync item")
    }

    async fn bindings(&self) -> Result<Vec<AcpBinding>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings WHERE EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation) ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], binding_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing ACP bindings")
    }

    /// The native session this node last recorded for one agent in one
    /// conversation, which a respawned ACP instance can resume.
    pub async fn binding_for_agent(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Option<AcpBinding>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND agent_id = ?3 AND EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation)
             LIMIT 1",
            params![self.node_id, conversation_id, agent_id],
            binding_from_row,
        )
        .optional()
        .context("reading ACP binding for agent")
    }

    /// Every native session id this node recorded for one conversation (any
    /// agent or generation), for deleting the agents' own transcripts with it.
    pub async fn native_sessions_for(&self, conversation_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT native_session_id FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND native_session_id <> ''",
        )?;
        let rows = stmt.query_map(params![self.node_id, conversation_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing native sessions")
    }

    /// Forget this node's native ACP sessions for one conversation, so the next
    /// turn starts a fresh agent session from Ryu's transcript instead of
    /// resuming one that remembers turns the user rewound.
    pub async fn forget_acp_bindings(&self, conversation_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM acp_bindings WHERE node_id = ?1 AND conversation_id = ?2",
            params![self.node_id, conversation_id],
        )
        .context("forgetting ACP bindings")
    }

    async fn binding_for(&self, conversation_id: &str) -> Result<Option<AcpBinding>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT node_id, conversation_id, agent_id, engine, native_session_id,
                    working_directory, capabilities_json, updated_at, conversation_generation
             FROM acp_bindings
             WHERE node_id = ?1 AND conversation_id = ?2 AND EXISTS (SELECT 1 FROM conversation_state.conversation_generations g WHERE g.conversation_id = acp_bindings.conversation_id AND g.generation = acp_bindings.conversation_generation)
             ORDER BY updated_at DESC LIMIT 1",
            params![self.node_id, conversation_id],
            binding_from_row,
        )
        .optional()
        .context("reading ACP binding")
    }

    async fn items(&self) -> Result<Vec<SyncItemStatus>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT profile_id, kind, source_id, source_hash, generated_hash,
                    revision, operation_id, state, conflict_json, updated_at
             FROM sync_items ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], item_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing sync items")
    }

    async fn update_profile_summary(
        &self,
        profile_id: &str,
        operation_id: &str,
        status: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE sync_profiles
             SET status = ?1,
                 conflict_count = (SELECT COUNT(*) FROM sync_items
                                   WHERE profile_id = ?2 AND state = 'conflict'),
                 last_operation_id = ?3,
                 updated_at = ?4
             WHERE id = ?2",
            params![status, profile_id, operation_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn record_acp_binding(
        &self,
        conversation_id: &str,
        agent_id: &str,
        engine: &str,
        native_session_id: &str,
        working_directory: Option<&Path>,
        capabilities: &Value,
        generation: &str,
    ) -> Result<()> {
        let conn = self
            .conn
            .try_lock()
            .map_err(|_| anyhow::anyhow!("sync database busy"))?;
        record_acp_binding_conn(
            &conn,
            &self.node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory,
            capabilities,
            generation,
        )
    }

    pub async fn record_acp_binding_async(
        &self,
        conversation_id: &str,
        agent_id: &str,
        engine: &str,
        native_session_id: &str,
        working_directory: Option<&Path>,
        capabilities: &Value,
        generation: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        record_acp_binding_conn(
            &conn,
            &self.node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory,
            capabilities,
            generation,
        )
    }
}

fn record_acp_binding_conn(
    conn: &Connection,
    node_id: &str,
    conversation_id: &str,
    agent_id: &str,
    engine: &str,
    native_session_id: &str,
    working_directory: Option<&Path>,
    capabilities: &Value,
    generation: &str,
) -> Result<()> {
    let changed = conn.execute(
        "INSERT INTO acp_bindings
                (node_id, conversation_id, agent_id, engine, native_session_id,
                 working_directory, capabilities_json, updated_at, conversation_generation)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE EXISTS (SELECT 1 FROM conversation_state.conversation_generations WHERE conversation_id = ?2 AND generation = ?9)
             ON CONFLICT(node_id, conversation_id, agent_id) DO UPDATE SET
                engine = excluded.engine,
                native_session_id = excluded.native_session_id,
                working_directory = excluded.working_directory,
                capabilities_json = excluded.capabilities_json,
                updated_at = excluded.updated_at,
                conversation_generation = excluded.conversation_generation",
        params![
            node_id,
            conversation_id,
            agent_id,
            engine,
            native_session_id,
            working_directory.map(|path| path.to_string_lossy().to_string()),
            serde_json::to_string(capabilities)?,
            now_ms(),
            generation,
        ],
    )?;
    anyhow::ensure!(changed == 1, "conversation generation is no longer current");
    Ok(())
}
