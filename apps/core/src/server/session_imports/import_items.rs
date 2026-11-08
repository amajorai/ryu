//! Session handlers, agent-thread imports and setup-import items: `import_mcp_item` through `import_saved_context_item`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Provenance for a fact brought in from another tool's memory or export, so
/// the Library can tell an imported fact from one this node learned itself.
pub(in crate::server) fn imported_memory_metadata() -> memory::MemoryMetadata {
    memory::MemoryMetadata::from_source(memory::MemorySource::Import)
}

/// Lower a foreign MCP entry into `~/.ryu/mcp.json` (enabled — it is the user's
/// own server), screening remote URLs and refusing names that collide.
pub(in crate::server) async fn import_mcp_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    let (token, name) = match crate::import::resolve_mcp_id(&selection.id) {
        Ok(v) => v,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::MCP_SERVER,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let title_msg = crate::import::named_title(
        crate::i18n::messages::IMPORT_MCP_SERVER_TITLE_MESSAGE,
        &name,
    );
    let title = crate::import::english(&title_msg);
    let cfg = match crate::import::read_mcp_entry(root, token, &name) {
        Ok(cfg) => cfg,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::MCP_SERVER,
                &selection.id,
                &title,
                &e.to_string(),
            )
            .titled(title_msg);
        }
    };
    // Name + shape gates mirror `create_mcp_server` (no `__`, exactly-one of
    // command/url, SSRF screen on remote urls).
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains("__") {
        return crate::import::ImportOutcome::failed_msg(
            crate::import::kind::MCP_SERVER,
            &selection.id,
            &title,
            crate::i18n::Message::new(
                crate::i18n::messages::IMPORT_OUTCOME_INVALID_MCP_NAME_MESSAGE,
            )
            .text("name", trimmed),
        )
        .titled(title_msg);
    }
    if cfg.url.is_some() == cfg.command.is_some() {
        return crate::import::ImportOutcome::failed_because(
            crate::import::kind::MCP_SERVER,
            &selection.id,
            &title,
            crate::i18n::messages::IMPORT_OUTCOME_MCP_TRANSPORT_MESSAGE,
        )
        .titled(title_msg);
    }
    if let Some(url) = &cfg.url {
        if let Err(e) = screen_agent_egress_url(url).await {
            return crate::import::ImportOutcome::failed_msg(
                crate::import::kind::MCP_SERVER,
                &selection.id,
                &title,
                crate::i18n::Message::new(crate::i18n::messages::IMPORT_OUTCOME_UNSAFE_URL_MESSAGE)
                    .text("url", url.as_str())
                    .text("error", e.to_string()),
            )
            .titled(title_msg);
        }
    }
    match write_imported_mcp_entry(&name, cfg).await {
        Ok(()) => {
            state.mcp.reload();
            crate::import::ImportOutcome::ok(crate::import::kind::MCP_SERVER, &selection.id, &title)
        }
        Err((StatusCode::CONFLICT, _)) => crate::import::ImportOutcome::already(
            crate::import::kind::MCP_SERVER,
            &selection.id,
            &title,
        ),
        Err((_, msg)) => crate::import::ImportOutcome::failed(
            crate::import::kind::MCP_SERVER,
            &selection.id,
            &title,
            &msg,
        )
        .titled(title_msg),
    }
}

/// Validate + hydrate + persist a plugin manifest found in the scanned folder,
/// through the same sink as URL/bundle installs (installed **disabled** by
/// design — grants must be reviewed before enable, mirroring the "finish setup
/// after importing" card).
pub(in crate::server) async fn import_plugin_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    let dir = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(p) => p,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::PLUGIN,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let manifest_path = match crate::import::find_manifest_path(&dir) {
        Some(p) => p,
        None => {
            return crate::import::ImportOutcome::failed_because(
                crate::import::kind::PLUGIN,
                &selection.id,
                &selection.id,
                crate::i18n::messages::IMPORT_OUTCOME_NO_MANIFEST_MESSAGE,
            );
        }
    };
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::PLUGIN,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    // Parse + hydrate `code_file` / output-style refs against the source dir
    // (symlink-contained), then run the full manifest validation gate.
    let manifest = match crate::plugin_manifest::parse_package_manifest(&raw, &dir) {
        Ok(m) => m,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::PLUGIN,
                &selection.id,
                &selection.id,
                &e,
            );
        }
    };
    let title_msg = crate::import::named_title(
        crate::i18n::messages::IMPORT_PLUGIN_TITLE_MESSAGE,
        &manifest.name,
    );
    let title = crate::import::english(&title_msg);
    match persist_installed_plugin(state, manifest, None, None).await {
        Ok(_) => {
            crate::import::ImportOutcome::ok(crate::import::kind::PLUGIN, &selection.id, &title)
        }
        Err((StatusCode::CONFLICT, _)) => crate::import::ImportOutcome::already(
            crate::import::kind::PLUGIN,
            &selection.id,
            &title,
        ),
        Err((_, msg)) => crate::import::ImportOutcome::failed(
            crate::import::kind::PLUGIN,
            &selection.id,
            &title,
            &msg,
        )
        .titled(title_msg),
    }
}

/// Record a Claude Code project memory into the Ryu memory store, deduped by a
/// content-hash tag (the memory crate itself has no content dedup, so the
/// importer owns idempotency).
pub(in crate::server) async fn import_memory_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    // Saved context reads the export's own files; its id names no file to
    // resolve (a split ChatGPT export has no `conversations.json`).
    if let Some(export) = crate::import::chat_exports::detect(root) {
        let fragment = selection
            .id
            .strip_prefix(crate::import::kind::MEMORY)
            .and_then(|rest| rest.strip_prefix('/'))
            .and_then(|rest| crate::import::split_fragment(rest).1);
        if fragment == Some(crate::import::chat_exports::SAVED_CONTEXT) {
            return import_saved_context_item(state, caller, root, export, selection).await;
        }
    }
    let path = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(p) => p,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::MEMORY,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let framework = crate::import::frameworks::detect(root).filter(|f| f.has_persona_home());
    if let Some(framework) = framework {
        if crate::import::frameworks::is_markdown_memory_path(&path) {
            return import_markdown_memory_item(state, caller, framework, &path, selection).await;
        }
    }
    let Some((content, when_to_use, importance)) = crate::import::parse_claude_memory(&path) else {
        return crate::import::ImportOutcome::failed_because(
            crate::import::kind::MEMORY,
            &selection.id,
            &selection.id,
            crate::i18n::messages::IMPORT_OUTCOME_UNREADABLE_MEMORY_MESSAGE,
        );
    };
    let tag = format!(
        "import:memory:claude:{}",
        &crate::import::content_sha256(&content)[..16]
    );
    match state.memory.ids_with_tag(&tag).await {
        Ok(ids) if !ids.is_empty() => {
            return crate::import::ImportOutcome::already(
                crate::import::kind::MEMORY,
                &selection.id,
                "Memory",
            );
        }
        Ok(_) => {}
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::MEMORY,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    }
    let owner = memory_owner_user_id(caller);
    let mem = memory::NewMemory {
        content,
        scope: memory::MemoryScope::User,
        scope_id: None,
        category: memory::MemoryCategory::ProjectContext,
        importance,
        when_to_use,
        tags: vec![tag],
        author_agent_id: None,
    };
    if !memory::detect_sensitive_topics(&mem.content).is_empty()
        && !sensitive_memory_enabled(&state, caller).await
    {
        return crate::import::ImportOutcome::failed_because(
            crate::import::kind::MEMORY,
            &selection.id,
            &selection.id,
            crate::i18n::messages::IMPORT_OUTCOME_SENSITIVE_MEMORY_MESSAGE,
        );
    }
    match state
        .memory
        .record_full_with_metadata(&owner, "default", mem, imported_memory_metadata())
        .await
    {
        Ok(Some(id)) => {
            match state.memory.get(&id).await {
                Ok(Some(entry)) => index_memory_entry(state, &entry).await,
                _ => {}
            }
            crate::import::ImportOutcome::ok(crate::import::kind::MEMORY, &selection.id, "Memory")
        }
        Ok(None) => crate::import::ImportOutcome::failed_because(
            crate::import::kind::MEMORY,
            &selection.id,
            &selection.id,
            crate::i18n::messages::IMPORT_OUTCOME_EMPTY_MEMORY_MESSAGE,
        ),
        Err(e) => crate::import::ImportOutcome::failed(
            crate::import::kind::MEMORY,
            &selection.id,
            &selection.id,
            &e.to_string(),
        ),
    }
}

/// Record ChatGPT custom instructions or Claude saved memory from a data
/// export as Ryu memories, deduped by content hash.
pub(in crate::server) async fn import_saved_context_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    export: crate::import::chat_exports::ExportSource,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    use crate::import::{kind, ImportOutcome};

    let title = match export {
        crate::import::chat_exports::ExportSource::ChatGpt => "ChatGPT custom instructions",
        crate::import::chat_exports::ExportSource::Claude => "Claude memory",
    };
    let root = root.to_path_buf();
    let entries = match tokio::task::spawn_blocking(move || {
        crate::import::chat_exports::saved_context(&root, export)
    })
    .await
    {
        Ok(entries) => entries,
        Err(e) => return ImportOutcome::failed(kind::MEMORY, &selection.id, title, &e.to_string()),
    };
    if entries.is_empty() {
        return ImportOutcome::skipped(kind::MEMORY, &selection.id, title, "nothing saved");
    }
    let owner = memory_owner_user_id(caller);
    let allow_sensitive = sensitive_memory_enabled(state, caller).await;
    let (mut imported, mut present, mut sensitive) = (0usize, 0usize, 0usize);
    for (content, about_user) in entries {
        let tag = format!(
            "import:memory:{}:{}",
            export.id(),
            &crate::import::content_sha256(&content)[..16]
        );
        match state.memory.ids_with_tag(&tag).await {
            Ok(ids) if !ids.is_empty() => {
                present += 1;
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                return ImportOutcome::failed(kind::MEMORY, &selection.id, title, &e.to_string())
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
            category: if about_user {
                memory::MemoryCategory::UserFact
            } else {
                memory::MemoryCategory::Preference
            },
            importance: 4,
            when_to_use: None,
            tags: vec![tag, format!("import:{}", export.id())],
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
                return ImportOutcome::failed(kind::MEMORY, &selection.id, title, &e.to_string())
            }
        }
    }
    let mut detail = format!("{imported} entries imported, {present} already present");
    if sensitive > 0 {
        detail.push_str(&format!(
            ", {sensitive} skipped because sensitive topics are disabled in Settings → Memory"
        ));
    }
    let mut outcome = if imported == 0 && present > 0 && sensitive == 0 {
        ImportOutcome::already(kind::MEMORY, &selection.id, title)
    } else {
        ImportOutcome::ok(kind::MEMORY, &selection.id, title)
    };
    if imported == 0 && outcome.status == "imported" {
        outcome.status = "skipped";
    }
    outcome.detail = Some(detail);
    outcome
}
