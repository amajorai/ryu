//! Session handlers, agent-thread imports and setup-import items: `ScanImportBody` through `import_skill_item`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ─────────────────────────────────────────────────────────────────────────────
// Import agent *setup* from a scanned local folder (ChatGPT/Codex `/import`
// parity). The scanner + foreign-format parsers live in `crate::import`; the
// handlers below own the stateful writes so each item lands through the same
// store seam as the normal install flows. See `docs/agent-setup-import.md`.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(in crate::server) struct ScanImportBody {
    pub(in crate::server) path: String,
}

/// `POST /api/import/scan { path }` — list what a folder has that Ryu can
/// import (instructions, skills, MCP servers, plugins, Claude project
/// memories). Read-only; runs the bounded walk on a blocking thread.
#[utoipa::path(
    post,
    path = "/api/import/scan",
    tag = "Agents",
    summary = "Scan a local folder for importable agent setup",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn scan_import_handler(
    State(state): State<ServerState>,
    Json(body): Json<ScanImportBody>,
) -> axum::response::Response {
    let root = match crate::import::canonicalize_root(&body.path) {
        Ok(root) => root,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let result = tokio::task::spawn_blocking(move || crate::import::scan_source(&root)).await;
    match result {
        Ok(Ok(scan)) => Json(json!({
            "root": scan.root,
            "items": scan.items,
            "warnings": scan.warnings,
            "warning_notices": scan.warning_notices,
            "source": scan.source,
        }))
        .into_response(),
        Ok(Err(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct RunImportBody {
    pub(in crate::server) path: String,
    pub(in crate::server) items: Vec<crate::import::ImportSelection>,
}

/// `POST /api/import/run { path, items: [{ kind, id }] }` — import the selected
/// items found by a prior scan. Each item is re-resolved against the folder on
/// disk (never trusting client bytes), validated, and written into Ryu's own
/// store. Returns one outcome per item.
#[utoipa::path(
    post,
    path = "/api/import/run",
    tag = "Agents",
    summary = "Import selected agent setup items from a scanned folder",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn run_import_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<RunImportBody>,
) -> axum::response::Response {
    let root = match crate::import::canonicalize_root(&body.path) {
        Ok(root) => root,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if body.items.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "no items selected".to_string());
    }
    let results = apply_import_selections(&state, &caller, &root, body.items).await;
    let imported = results
        .iter()
        .filter(|outcome| outcome.status == "imported")
        .count();
    let skipped = results
        .iter()
        .filter(|outcome| outcome.status == "skipped")
        .count();
    let failed = results
        .iter()
        .filter(|outcome| outcome.status == "failed")
        .count();
    let source = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("agent setup");
    let level = if failed > 0 {
        "warning"
    } else if imported > 0 {
        "success"
    } else {
        "info"
    };
    crate::events::publish_system_notification_for_user(
        "Import complete",
        format!("{imported} imported, {skipped} already present, {failed} failed from {source}."),
        level,
        caller.as_ref().map(|verified| verified.user_id.clone()),
    );
    Json(json!({
        "root": root.to_string_lossy(),
        "results": results,
    }))
    .into_response()
}

/// Apply a selected setup batch through the existing import store seams. The
/// shared agent-sync worker uses this same function, which prevents the legacy
/// `/api/import/run` path and automatic sync from creating divergent import
/// semantics or duplicate schedulers.
pub(crate) async fn apply_import_selections(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selections: Vec<crate::import::ImportSelection>,
) -> Vec<crate::import::ImportOutcome> {
    let mut export_batch = read_chat_export_batch(caller, root, &selections).await;
    let mut results = Vec::with_capacity(selections.len());
    for selection in selections {
        let outcome = match export_batch.as_mut() {
            Some(batch) if selection.kind == crate::import::kind::CONVERSATIONS => {
                import_chat_export_item(state, caller, root, &selection, Some(batch)).await
            }
            _ => import_setup_item(state, caller, root, &selection).await,
        };
        results.push(outcome);
    }
    results
}

/// The conversation groups and projects of a ChatGPT / Claude export, read in
/// one pass for every group a batch selects, so importing N groups does not
/// parse the whole export N times.
pub(in crate::server) struct ChatExportBatch {
    pub(in crate::server) projects:
        std::collections::BTreeMap<String, crate::import::chat_exports::ExportProject>,
    pub(in crate::server) groups: Result<
        std::collections::BTreeMap<String, Vec<crate::import::chat_exports::ExportConversation>>,
        String,
    >,
}

/// The group a `conversations/<file>#<group>` item id names.
pub(in crate::server) fn chat_export_group(id: &str) -> Option<String> {
    id.strip_prefix(crate::import::kind::CONVERSATIONS)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| crate::import::split_fragment(rest).1)
        .map(str::to_string)
}

pub(in crate::server) async fn read_chat_export_batch(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selections: &[crate::import::ImportSelection],
) -> Option<ChatExportBatch> {
    use crate::import::chat_exports;

    let groups: std::collections::BTreeSet<String> = selections
        .iter()
        .filter(|selection| selection.kind == crate::import::kind::CONVERSATIONS)
        .filter_map(|selection| chat_export_group(&selection.id))
        .collect();
    // One group reads the export once either way; a denied caller reads nothing.
    if groups.len() < 2 || native_history_access_denied(caller.as_ref()).is_some() {
        return None;
    }
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let export = chat_exports::detect(&root)?;
        Some(ChatExportBatch {
            projects: chat_exports::declared_projects(&root, export),
            groups: chat_exports::read_groups(&root, export, &groups).map_err(|e| e.to_string()),
        })
    })
    .await
    .ok()
    .flatten()
}

/// Dispatch one selected import item to its destination store. Falls back to a
/// `failed` outcome on any error rather than aborting the batch.
pub(in crate::server) async fn import_setup_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    match selection.kind.as_str() {
        crate::import::kind::INSTRUCTIONS => import_instructions_item(state, root, selection).await,
        crate::import::kind::SKILL => import_skill_item(state, root, selection).await,
        crate::import::kind::MCP_SERVER => import_mcp_item(state, root, selection).await,
        crate::import::kind::PLUGIN => import_plugin_item(state, root, selection).await,
        crate::import::kind::MEMORY => import_memory_item(state, caller, root, selection).await,
        crate::import::kind::AGENT => import_agent_item(state, root, selection).await,
        crate::import::kind::SLASH_COMMAND => {
            import_slash_command_item(state, root, selection).await
        }
        crate::import::kind::CONVERSATIONS => {
            import_chat_export_item(state, caller, root, selection, None).await
        }
        other => crate::import::ImportOutcome::failed_msg(
            other,
            &selection.id,
            &selection.id,
            crate::i18n::Message::new(crate::i18n::messages::IMPORT_OUTCOME_UNKNOWN_KIND_MESSAGE)
                .text("kind", other),
        ),
    }
}

/// Snapshot an `AGENTS.md`/`CLAUDE.md` into the preferences store, keyed by the
/// folder's content hash, and hand back the containing folder so the desktop
/// registers it as a workspace project. (Runtime injection of that content into
/// the agent system prompt is a separate, deliberately-deferred phase.)
pub(in crate::server) async fn import_instructions_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    let path = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(p) => p,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::INSTRUCTIONS,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::INSTRUCTIONS,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    let folder = path.parent().unwrap_or(root);
    let key = format!(
        "project.instructions.{}",
        crate::import::content_sha256(&folder.to_string_lossy())
    );
    let content_revision = crate::import::content_sha256(&content);
    let value = serde_json::json!({
        "path": path.to_string_lossy(),
        "content": content,
        "imported_at": chrono_now_ms(),
    });
    let mut outcome = crate::import::ImportOutcome::ok(
        crate::import::kind::INSTRUCTIONS,
        &selection.id,
        "Project instructions",
    );
    match state
        .preferences
        .set(&key, &serde_json::to_string(&value).unwrap_or_default())
        .await
    {
        Ok(()) => {
            outcome.content_revision = Some(content_revision);
            outcome.folder_path = Some(folder.to_string_lossy().to_string());
        }
        Err(e) => {
            outcome.status = "failed";
            outcome.detail = Some(format!("could not save instructions: {e}"));
        }
    }
    outcome
}

/// Copy a found skill directory into the skills registry and activate it — the
/// exact same path a URL/source skill install uses.
pub(in crate::server) async fn import_skill_item(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    let dir = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(p) => p,
        Err(e) => {
            return crate::import::ImportOutcome::failed(
                crate::import::kind::SKILL,
                &selection.id,
                &selection.id,
                &e.to_string(),
            );
        }
    };
    match crate::skills_catalog::from_source::install_from_dir(&dir, None) {
        Ok(result) => {
            state.skills.reload();
            crate::import::ImportOutcome::ok(
                crate::import::kind::SKILL,
                &selection.id,
                &format!("Skill '{}'", result.slug),
            )
        }
        Err(e) => crate::import::ImportOutcome::failed(
            crate::import::kind::SKILL,
            &selection.id,
            &selection.id,
            &e.to_string(),
        ),
    }
}
