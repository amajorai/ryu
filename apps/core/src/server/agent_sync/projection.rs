// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

async fn project_skills(
    store: &AgentSyncStore,
    profile: &SyncProfile,
    destination: &Path,
    skills: &[ryu_skills::SkillRecord],
    operation_id: &str,
    dry_run: bool,
    force_item: Option<(&str, &str)>,
) -> Result<(usize, usize, Vec<String>)> {
    let mut projected = 0;
    let mut conflicts = 0;
    let mut warnings = Vec::new();
    for skill in skills {
        let Some(id) = safe_projection_segment(&skill.id) else {
            warnings.push(format!(
                "Skipped skill {:?}: unsafe projection id",
                skill.id
            ));
            continue;
        };
        let path = destination.join("skills").join(id).join("SKILL.md");
        let content = render_skill(skill)?;
        let hash = sha256_bytes(content.as_bytes());
        let source_id = format!("skills/{id}/SKILL.md");
        let existing = fs::read(&path).ok();
        let previous = store.item(&profile.id, "skill", &source_id).await?;
        let existing_hash = existing.as_deref().map(sha256_bytes);
        let forced = force_item == Some(("skill", source_id.as_str()));
        let external_preserved =
            external_baseline_preserved(previous.as_ref(), existing_hash.as_deref(), &hash);
        if let Some(existing) = existing.as_deref() {
            let existing_hash = existing_hash
                .as_deref()
                .context("skill projection hash disappeared")?;
            let external_changed = previous
                .as_ref()
                .and_then(|item| item.generated_hash.as_deref())
                .is_none_or(|previous_hash| previous_hash != existing_hash);
            let paused = previous
                .as_ref()
                .is_some_and(|item| item.state == "conflict");
            if existing != content.as_bytes()
                && (external_changed || paused)
                && !forced
                && !external_preserved
            {
                conflicts += 1;
                warnings.push(format!(
                    "Skill projection {} changed outside Ryu; preserved and paused.",
                    path.display()
                ));
                if !dry_run {
                    store
                        .upsert_item(
                            &profile.id,
                            "skill",
                            &source_id,
                            None,
                            Some(&existing_hash),
                            operation_id,
                            "conflict",
                            Some(&json!({
                                "path": path.to_string_lossy(),
                                "generated_hash_before_conflict": hash,
                            })),
                        )
                        .await?;
                }
                continue;
            }
            if existing != content.as_bytes() && !external_preserved {
                projected += 1;
                if !dry_run {
                    write_atomic(&path, content.as_bytes())?;
                }
            }
        } else {
            projected += 1;
            if !dry_run {
                write_atomic(&path, content.as_bytes())?;
            }
        }
        if !dry_run && external_preserved {
            store
                .upsert_item(
                    &profile.id,
                    "skill",
                    &source_id,
                    None,
                    existing_hash.as_deref(),
                    operation_id,
                    "external",
                    Some(&json!({
                        "resolution": "keep_external",
                        "adopted_hash": existing_hash,
                        "previous_generated_hash": hash,
                        "path": path.to_string_lossy(),
                    })),
                )
                .await?;
        } else if !dry_run {
            store
                .upsert_item(
                    &profile.id,
                    "skill",
                    &source_id,
                    None,
                    Some(&hash),
                    operation_id,
                    "projected",
                    None,
                )
                .await?;
        }
    }
    Ok((projected, conflicts, warnings))
}

fn external_baseline_preserved(
    previous: Option<&SyncItemStatus>,
    existing_hash: Option<&str>,
    current_generated_hash: &str,
) -> bool {
    let Some(item) = previous else {
        return false;
    };
    item.state == "external"
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("resolution"))
            .and_then(Value::as_str)
            == Some("keep_external")
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("adopted_hash"))
            .and_then(Value::as_str)
            == existing_hash
        && item
            .conflict
            .as_ref()
            .and_then(|value| value.get("previous_generated_hash"))
            .and_then(Value::as_str)
            == Some(current_generated_hash)
}

fn render_skill(skill: &ryu_skills::SkillRecord) -> Result<String> {
    let name = serde_json::to_string(&skill.name)?;
    let description = serde_json::to_string(&skill.description.clone().unwrap_or_default())?;
    let allowed_tools = if skill.allowed_tools.is_empty() {
        String::new()
    } else {
        skill
            .allowed_tools
            .iter()
            .map(|tool| serde_json::to_string(tool).map(|value| format!("  - {value}")))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n")
    };
    let tools_block = if allowed_tools.is_empty() {
        String::new()
    } else {
        format!("allowed-tools:\n{allowed_tools}\n")
    };
    Ok(format!(
        "---\nname: {name}\ndescription: {description}\n{tools_block}enabled: {}\nalways-on: {}\n---\n{}\n",
        skill.enabled, skill.always_on, skill.instructions
    ))
}

fn safe_projection_segment(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value != "."
        && value != ".."
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        }))
    .then_some(value)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS sync_profiles (
             id TEXT PRIMARY KEY,
             provider TEXT NOT NULL,
             root TEXT NOT NULL UNIQUE,
             import_enabled INTEGER NOT NULL DEFAULT 0,
             export_enabled INTEGER NOT NULL DEFAULT 0,
             status TEXT NOT NULL DEFAULT 'idle',
             conflict_count INTEGER NOT NULL DEFAULT 0,
             last_operation_id TEXT,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sync_items (
             profile_id TEXT NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
             kind TEXT NOT NULL,
             source_id TEXT NOT NULL,
             source_hash TEXT,
             generated_hash TEXT,
             revision INTEGER NOT NULL DEFAULT 0,
             operation_id TEXT,
             state TEXT NOT NULL,
             conflict_json TEXT,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (profile_id, kind, source_id)
         );
         CREATE TABLE IF NOT EXISTS acp_bindings (
             node_id TEXT NOT NULL,
             conversation_id TEXT NOT NULL,
             agent_id TEXT NOT NULL,
             engine TEXT NOT NULL,
             native_session_id TEXT NOT NULL,
             working_directory TEXT,
             capabilities_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (node_id, conversation_id, agent_id)
         );
         CREATE INDEX IF NOT EXISTS idx_sync_items_operation
             ON sync_items(operation_id);
         CREATE INDEX IF NOT EXISTS idx_acp_bindings_conversation
             ON acp_bindings(node_id, conversation_id);",
    )
    .context("initializing agent sync schema")?;
    let has_generation = {
        let mut stmt = conn.prepare("PRAGMA table_info(acp_bindings)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        columns.iter().any(|name| name == "conversation_generation")
    };
    if !has_generation {
        conn.execute(
            "ALTER TABLE acp_bindings ADD COLUMN conversation_generation TEXT",
            [],
        )?;
    }
    let has_revision = {
        let mut stmt = conn.prepare("PRAGMA table_info(sync_items)")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().any(|name| name == "revision")
    };
    if !has_revision {
        conn.execute(
            "ALTER TABLE sync_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let has_include_conversations = {
        let mut stmt = conn.prepare("PRAGMA table_info(sync_profiles)")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().any(|name| name == "include_conversations")
    };
    if !has_include_conversations {
        // Existing profiles stop exporting conversations until the user opts in.
        conn.execute(
            "ALTER TABLE sync_profiles ADD COLUMN include_conversations INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncProfile> {
    Ok(SyncProfile {
        id: row.get(0)?,
        provider: row.get(1)?,
        root: row.get(2)?,
        import_enabled: row.get::<_, i64>(3)? != 0,
        export_enabled: row.get::<_, i64>(4)? != 0,
        status: row.get(5)?,
        conflict_count: row.get::<_, i64>(6)?.max(0) as u64,
        last_operation_id: row.get(7)?,
        updated_at: row.get(8)?,
        include_conversations: row.get::<_, i64>(9)? != 0,
    })
}

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncItemStatus> {
    let conflict_json: Option<String> = row.get(8)?;
    Ok(SyncItemStatus {
        profile_id: row.get(0)?,
        kind: row.get(1)?,
        source_id: row.get(2)?,
        source_hash: row.get(3)?,
        generated_hash: row.get(4)?,
        revision: row.get(5)?,
        operation_id: row.get(6)?,
        state: row.get(7)?,
        conflict: conflict_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        updated_at: row.get(9)?,
    })
}

fn attach_conversations(conn: &Connection, path: Option<&Path>) -> Result<()> {
    if let Some(path) = path.filter(|path| path.is_file()) {
        conn.execute(
            "ATTACH DATABASE ?1 AS conversation_state",
            [path.to_string_lossy().as_ref()],
        )?;
    } else {
        conn.execute("ATTACH DATABASE ':memory:' AS conversation_state", [])?;
        conn.execute("CREATE TABLE conversation_state.conversation_generations (conversation_id TEXT PRIMARY KEY, generation TEXT NOT NULL)", [])?;
    }
    Ok(())
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AcpBinding> {
    let capabilities = row
        .get::<_, String>(6)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    Ok(AcpBinding {
        node_id: row.get(0)?,
        conversation_id: row.get(1)?,
        agent_id: row.get(2)?,
        engine: row.get(3)?,
        native_session_id: row.get(4)?,
        working_directory: row.get(5)?,
        capabilities,
        updated_at: row.get(7)?,
        conversation_generation: row.get(8)?,
    })
}

fn default_true() -> bool {
    true
}

fn normalize_provider(input: &str) -> Result<String> {
    let provider = input.trim().to_ascii_lowercase();
    if provider.is_empty() {
        bail!("provider is empty");
    }
    if !matches!(
        provider.as_str(),
        "claude"
            | "codex"
            | "cursor"
            | "openclaw"
            | "hermes"
            | "muse"
            | "mastra"
            | "langchain"
            | "persona"
            | "chatgpt"
            | "claude-ai"
            | "other"
    ) {
        bail!("unsupported provider {provider:?}");
    }
    Ok(provider)
}

fn detect_provider(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .map(|name| match name.to_ascii_lowercase().as_str() {
            ".claude" => "claude",
            ".codex" => "codex",
            ".cursor" => "cursor",
            _ => "other",
        })
        .filter(|provider| *provider != "other")
        .or_else(|| crate::import::chat_exports::detect(root).map(|s| s.id()))
        .or_else(|| crate::import::frameworks::detect(root).map(|f| f.id()))
        .unwrap_or("other")
        .to_owned()
}

fn capabilities_for(provider: &str) -> SyncCapabilities {
    let native_threads = crate::native_history::engine_supports_history(provider);
    SyncCapabilities {
        setup_import: true,
        native_threads,
        acp_load_resume: None,
        portable_bundle: true,
        native_conversation_export: false,
        note: if provider == "cursor" {
            Some("Cursor setup can be scanned, but native thread/session files are not projected or fabricated.".to_owned())
        } else {
            Some("ACP load/resume is capability-based; replaying the Ryu transcript is always available.".to_owned())
        },
    }
}
