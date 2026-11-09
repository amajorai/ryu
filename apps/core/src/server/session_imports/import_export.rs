//! Session handlers, agent-thread imports and setup-import items: `import_chat_export_item` through `import_markdown_memory_item`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Import one group of conversations from a ChatGPT or Claude data export:
/// every conversation lands through the same conversation store seam the
/// native thread importer uses, deduplicated by the export's conversation id
/// (a re-import only appends messages added since). A project group also gets
/// a project folder whose `AGENTS.md` carries the project's instructions, and
/// its chats are filed under that folder. `batch` holds the export already
/// parsed for a multi-group import.
pub(in crate::server) async fn import_chat_export_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
    batch: Option<&mut ChatExportBatch>,
) -> crate::import::ImportOutcome {
    use crate::import::chat_exports;
    use crate::import::{kind, ImportOutcome};

    let id = &selection.id;
    let Some(export) = chat_exports::detect(root) else {
        return ImportOutcome::failed_because(
            kind::CONVERSATIONS,
            id,
            id,
            crate::i18n::messages::IMPORT_OUTCOME_NOT_CHAT_EXPORT_MESSAGE,
        );
    };
    let Some(group) = chat_export_group(id) else {
        return ImportOutcome::failed_because(
            kind::CONVERSATIONS,
            id,
            id,
            crate::i18n::messages::IMPORT_OUTCOME_INVALID_CONVERSATIONS_MESSAGE,
        );
    };
    if native_history_access_denied(caller.as_ref()).is_some() {
        return ImportOutcome::failed_because(
            kind::CONVERSATIONS,
            id,
            id,
            crate::i18n::messages::IMPORT_OUTCOME_MEMBER_REQUIRED_MESSAGE,
        );
    }
    // Take this group out of the batch (a repeated selection reads again).
    let preloaded = batch.and_then(|batch| {
        let conversations = match &mut batch.groups {
            Ok(groups) => Ok(groups.remove(&group)?),
            Err(error) => Err(error.clone()),
        };
        Some((
            chat_exports::project_in(&batch.projects, export, &group),
            conversations,
        ))
    });
    let read_root = root.to_path_buf();
    let read_group = group.clone();
    let read = tokio::task::spawn_blocking(move || {
        let (project, conversations) = match preloaded {
            Some((project, conversations)) => (project, conversations.map_err(anyhow::Error::msg)?),
            None => (
                chat_exports::project_for(&read_root, export, &read_group),
                chat_exports::read_group(&read_root, export, &read_group)?,
            ),
        };
        let folder = match &project {
            Some(project) => {
                let base = chat_exports::default_projects_base()
                    .ok_or_else(|| anyhow::anyhow!("could not resolve the Documents directory"))?;
                Some(chat_exports::ensure_project_folder(&base, export, project)?)
            }
            None => None,
        };
        Ok::<_, anyhow::Error>((project, conversations, folder))
    })
    .await;
    let (project, conversations, folder) = match read {
        Ok(Ok(read)) => read,
        Ok(Err(e)) => return ImportOutcome::failed(kind::CONVERSATIONS, id, id, &e.to_string()),
        Err(e) => return ImportOutcome::failed(kind::CONVERSATIONS, id, id, &e.to_string()),
    };
    let label = export.label();
    let project_name = project.as_ref().map(|project| project.name.as_str());
    let title = super::import_export_text::export_title(label, project_name);
    let folder_path = folder
        .as_ref()
        .map(|f| f.path.to_string_lossy().to_string());
    let kept = folder.map(|f| f.kept).unwrap_or_default();
    let tenancy = caller_tenancy(caller);
    let origin = export.origin();
    let mut counts = super::import_export_text::ExportCounts {
        shortened: conversations.iter().filter(|c| c.truncated).count(),
        ..Default::default()
    };
    for conversation in conversations {
        match import_export_conversation(
            state,
            &origin,
            &tenancy,
            caller,
            &conversation,
            folder_path.as_deref(),
        )
        .await
        {
            Ok(ExportConversationResult::Created) => counts.created += 1,
            Ok(ExportConversationResult::Updated) => counts.updated += 1,
            Ok(ExportConversationResult::Unchanged) => counts.unchanged += 1,
            Ok(ExportConversationResult::Diverged) => counts.diverged += 1,
            Err(e) => {
                counts.failed += 1;
                tracing::warn!("chat export import: {}: {e:#}", conversation.id);
            }
        }
    }
    let detail =
        super::import_export_text::export_detail(label, &counts, folder_path.as_deref(), &kept);
    let outcome =
        super::import_export_text::export_outcome(id, title, &counts, detail, folder_path);
    if counts.created + counts.updated > 0 {
        crate::events::publish_system_notification_for_user(
            "Chats imported",
            super::import_export_text::chats_imported_body(
                label,
                project_name,
                counts.created,
                counts.updated,
            ),
            "success",
            caller.as_ref().map(|verified| verified.user_id.clone()),
        );
    }
    outcome
}

pub(in crate::server) enum ExportConversationResult {
    Created,
    Updated,
    Unchanged,
    /// The source branch was edited before its old end; left as imported.
    Diverged,
}

/// Create or catch up one exported conversation. Mirrors the native thread
/// importer: the same origin + source id resolves to the same Ryu
/// conversation, and only the missing tail is appended.
pub(in crate::server) async fn import_export_conversation(
    state: &ServerState,
    origin: &str,
    tenancy: &conversations::Tenancy,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation: &crate::import::chat_exports::ExportConversation,
    folder_path: Option<&str>,
) -> anyhow::Result<ExportConversationResult> {
    if let Some((existing, generation)) = state
        .conversations
        .find_imported_conversation_with_generation(origin, &conversation.id, tenancy)
        .await?
    {
        let can_update = import_reuse_permission(require_resource_write(
            state.conversations.get_access_meta(&existing).await,
            caller.as_ref(),
            "conversation not found",
        ))
        .unwrap_or(false);
        if !can_update {
            return Ok(ExportConversationResult::Unchanged);
        }
        let existing_messages = state.conversations.get_messages(&existing).await?;
        let missing = missing_imported_message_tail(&existing_messages, &conversation.messages);
        if missing.is_empty() {
            return Ok(ExportConversationResult::Unchanged);
        }
        // A prompt edited (or a reply regenerated) in the source after the
        // last import: the stored copy holds the branch the user left, so
        // appending the new branch would interleave two histories.
        if existing_messages.iter().any(|message| {
            conversation.is_superseded(&message.role, &message.content, message.created_at)
        }) {
            return Ok(ExportConversationResult::Diverged);
        }
        for message in missing {
            state
                .conversations
                .append_imported_message_at(
                    &existing,
                    &generation,
                    &message.role,
                    &message.content,
                    Some(crate::registry::DEFAULT_AGENT_ID),
                    tenancy.clone(),
                    message.created_at,
                )
                .await?;
        }
        return Ok(ExportConversationResult::Updated);
    }
    let conversation_id = format!("conv_{}", uuid::Uuid::new_v4());
    let generation = state
        .conversations
        .ensure_conversation_with_generation(
            &conversation_id,
            Some(crate::registry::DEFAULT_AGENT_ID),
            Some(&conversation.title),
            tenancy.clone(),
        )
        .await?;
    for message in &conversation.messages {
        state
            .conversations
            .append_imported_message_at(
                &conversation_id,
                &generation,
                &message.role,
                &message.content,
                Some(crate::registry::DEFAULT_AGENT_ID),
                tenancy.clone(),
                message.created_at,
            )
            .await?;
    }
    if folder_path.is_some() {
        if let Err(e) = state
            .conversations
            .set_run_metadata(&conversation_id, folder_path, None, None)
            .await
        {
            tracing::warn!("chat export import: folder for {conversation_id}: {e:#}");
        }
    }
    state
        .conversations
        .set_import_source(&conversation_id, origin, Some(&conversation.id))
        .await?;
    if let Err(e) = state
        .conversations
        .set_title(&conversation_id, &conversation.title)
        .await
    {
        tracing::warn!("chat export import: title for {conversation_id}: {e:#}");
    }
    Ok(ExportConversationResult::Created)
}

/// Record each entry of an OpenClaw / Hermes / Muse Markdown memory file
/// (`MEMORY.md`, `USER.md`, dated daily notes, Muse `memory/bank/`) as its own
/// Ryu memory. Each entry is deduped by a content-hash tag, so re-running a
/// migration adds only entries that were not imported before.
pub(in crate::server) async fn import_markdown_memory_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    framework: crate::import::frameworks::Framework,
    path: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    use crate::import::{kind, ImportOutcome};

    let title = format!(
        "{} memory {}",
        framework.label(),
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    );
    let Some(doc) = crate::import::frameworks::parse_markdown_memory(path) else {
        return ImportOutcome::failed_because(
            kind::MEMORY,
            &selection.id,
            &title,
            crate::i18n::messages::IMPORT_OUTCOME_UNREADABLE_MEMORY_MESSAGE,
        );
    };
    if doc.entries.is_empty() {
        return ImportOutcome::skipped(kind::MEMORY, &selection.id, &title, "no memory entries");
    }
    let owner = memory_owner_user_id(caller);
    let allow_sensitive = sensitive_memory_enabled(state, caller).await;
    let (mut imported, mut present, mut sensitive) = (0usize, 0usize, 0usize);
    for content in doc.entries {
        let tag = format!(
            "import:memory:{}:{}",
            framework.id(),
            &crate::import::content_sha256(&content)[..16]
        );
        match state.memory.ids_with_tag(&tag).await {
            Ok(ids) if !ids.is_empty() => {
                present += 1;
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                return ImportOutcome::failed(kind::MEMORY, &selection.id, &title, &e.to_string());
            }
        }
        if !allow_sensitive && !memory::detect_sensitive_topics(&content).is_empty() {
            sensitive += 1;
            continue;
        }
        let mem = memory::NewMemory {
            content,
            scope: memory::MemoryScope::User,
            scope_id: None,
            category: doc.category,
            importance: 3,
            when_to_use: None,
            tags: vec![tag, format!("import:{}", framework.id())],
            author_agent_id: None,
        };
        match state
            .memory
            .record_full_with_metadata(&owner, "default", mem, imported_memory_metadata())
            .await
        {
            Ok(Some(id)) => {
                if let Ok(Some(entry)) = state.memory.get(&id).await {
                    index_memory_entry(state, &entry).await;
                }
                imported += 1;
            }
            Ok(None) => {}
            Err(e) => {
                return ImportOutcome::failed(kind::MEMORY, &selection.id, &title, &e.to_string());
            }
        }
    }
    let mut detail = format!("{imported} entries imported, {present} already present");
    if sensitive > 0 {
        detail.push_str(&format!(
            ", {sensitive} skipped because sensitive topics are disabled in Settings → Memory"
        ));
    }
    if imported == 0 && present > 0 && sensitive == 0 {
        let mut outcome = ImportOutcome::already(kind::MEMORY, &selection.id, &title);
        outcome.detail = Some(detail);
        return outcome;
    }
    let mut outcome = ImportOutcome::ok(kind::MEMORY, &selection.id, &title);
    if imported == 0 {
        outcome.status = "skipped";
    }
    outcome.detail = Some(detail);
    outcome
}
