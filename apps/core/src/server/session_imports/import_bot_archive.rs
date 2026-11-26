//! A bot export archive (`crate::import::bot_archive`), the zip a migrator
//! prompt builds inside Grok Bot: upload and stage it, discard it, and import
//! the "files and chats" item of one of its bots. Agents, memory and skills
//! of a staged archive go through the same item handlers as any scanned
//! folder.

use crate::import::bot_archive::{self, ArchiveError};
use crate::server::*;

fn archive_error(error: &ArchiveError) -> axum::response::Response {
    let status = match error {
        ArchiveError::ArchiveTooLarge
        | ArchiveError::TotalTooLarge
        | ArchiveError::EntryTooLarge { .. }
        | ArchiveError::TooManyEntries(_) => StatusCode::PAYLOAD_TOO_LARGE,
        ArchiveError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    // The reason is English, as every relayed scan error is.
    json_error(status, error.to_string())
}

fn io_failure(error: std::io::Error) -> axum::response::Response {
    archive_error(&ArchiveError::Io(error.to_string()))
}

/// Write the request body to `upload`, counting as it goes. A body larger
/// than the archive limit stops the upload; it is never held in memory.
async fn receive_upload(
    body: axum::body::Body,
    upload: &std::path::Path,
) -> Result<(), axum::response::Response> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(upload).await.map_err(io_failure)?;
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| archive_error(&ArchiveError::Upload(error.to_string())))?;
        size += chunk.len() as u64;
        if size > bot_archive::MAX_ARCHIVE_BYTES {
            return Err(archive_error(&ArchiveError::ArchiveTooLarge));
        }
        file.write_all(&chunk).await.map_err(io_failure)?;
    }
    file.flush().await.map_err(io_failure)?;
    if size == 0 {
        return Err(archive_error(&ArchiveError::Upload(
            "no file arrived".to_string(),
        )));
    }
    Ok(())
}

/// `POST /api/import/archive/stage` (body: the zip, as raw bytes). Checks the
/// zip, unpacks it into a staging folder under the node's data folder, and
/// returns the scan of that folder plus `archive`, the checked manifest with
/// the counts of what was unpacked. Nothing is imported: the client shows the
/// preview and sends the selection to `POST /api/import/run` with `root`.
pub(in crate::server) async fn stage_import_archive_handler(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: axum::body::Body,
) -> axum::response::Response {
    if let Some(denied) = native_history_access_denied(caller.as_ref()) {
        return denied;
    }
    let base = bot_archive::staging_base();
    if let Err(error) = tokio::fs::create_dir_all(&base).await {
        return io_failure(error);
    }
    let upload = base.join(format!("upload-{}.zip.part", uuid::Uuid::new_v4()));
    if let Err(response) = receive_upload(body, &upload).await {
        let _ = tokio::fs::remove_file(&upload).await;
        return response;
    }
    let staged = tokio::task::spawn_blocking(move || {
        bot_archive::sweep_stale(
            &base,
            std::time::Duration::from_secs(bot_archive::STAGING_MAX_AGE_SECS),
        );
        let staged = bot_archive::stage_archive(&upload, &base);
        let _ = std::fs::remove_file(&upload);
        let staged = staged.map_err(|error| archive_error(&error))?;
        let scanned = crate::import::canonicalize_root(&staged.root.to_string_lossy())
            .and_then(|root| crate::import::scan_source(&root));
        match scanned {
            Ok(scan) => Ok((staged.summary, scan)),
            Err(error) => {
                bot_archive::discard_staged(&base, &staged.root);
                Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    error.to_string(),
                ))
            }
        }
    })
    .await;
    match staged {
        Ok(Ok((archive, scan))) => Json(json!({
            "root": scan.root,
            "items": scan.items,
            "warnings": scan.warnings,
            "warning_notices": scan.warning_notices,
            "source": scan.source,
            "archive": archive,
        }))
        .into_response(),
        Ok(Err(response)) => response,
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct DiscardImportArchiveBody {
    pub(in crate::server) path: String,
}

/// `POST /api/import/archive/discard { path }` removes a staging folder that
/// `stage` returned. Any other path is left alone.
pub(in crate::server) async fn discard_import_archive_handler(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<DiscardImportArchiveBody>,
) -> axum::response::Response {
    if let Some(denied) = native_history_access_denied(caller.as_ref()) {
        return denied;
    }
    let path = std::path::PathBuf::from(body.path.trim());
    let discarded = tokio::task::spawn_blocking(move || {
        bot_archive::discard_staged(&bot_archive::staging_base(), &path)
    })
    .await
    .unwrap_or(false);
    Json(json!({ "discarded": discarded })).into_response()
}

/// Import the files and conversations of one bot of a staged archive: the
/// bot gets a project folder under `~/Documents/Ryu`, its files are copied
/// into `files/` there, and its conversations are filed under that folder.
pub(in crate::server) async fn import_bot_archive_item(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
) -> crate::import::ImportOutcome {
    let base = crate::import::chat_exports::default_projects_base();
    import_bot_archive_item_into(state, caller, root, selection, base).await
}

/// [`import_bot_archive_item`] with the folder that holds project folders.
pub(in crate::server) async fn import_bot_archive_item_into(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
    projects_base: Option<std::path::PathBuf>,
) -> crate::import::ImportOutcome {
    use crate::import::chat_exports;
    use crate::import::{kind, ImportOutcome};

    let id = &selection.id;
    let Some(key) = bot_archive::bot_key_of_item(id).map(str::to_string) else {
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
    let read_root = root.to_path_buf();
    let read = tokio::task::spawn_blocking(move || {
        let bot = bot_archive::staged_bot(&read_root, &key)
            .ok_or_else(|| anyhow::anyhow!("the archive holds no bot {key:?}"))?;
        let base = projects_base
            .ok_or_else(|| anyhow::anyhow!("could not resolve the Documents directory"))?;
        let project = chat_exports::ExportProject {
            id: bot.key.clone(),
            name: bot.name.clone(),
            description: bot.description.clone(),
            ..chat_exports::ExportProject::default()
        };
        let folder = chat_exports::ensure_project_folder_for(
            &base,
            bot_archive::SOURCE_ID,
            bot_archive::SOURCE_LABEL,
            &project,
        )?;
        let copied = bot_archive::copy_bot_files(&read_root, &key, &folder.path)?;
        let conversations = bot_archive::read_bot_conversations(&read_root, &key);
        Ok::<_, anyhow::Error>((bot, folder, copied, conversations))
    })
    .await;
    let (bot, folder, copied, conversations) = match read {
        Ok(Ok(read)) => read,
        Ok(Err(e)) => return ImportOutcome::failed(kind::CONVERSATIONS, id, id, &e.to_string()),
        Err(e) => return ImportOutcome::failed(kind::CONVERSATIONS, id, id, &e.to_string()),
    };
    let label = bot_archive::SOURCE_LABEL;
    let title = super::import_export_text::export_title(label, Some(bot.name.as_str()));
    let folder_path = folder.path.to_string_lossy().to_string();
    let mut kept = folder.kept;
    kept.extend(copied.kept.iter().cloned());
    let tenancy = caller_tenancy(caller);
    let mut counts = super::import_export_text::ExportCounts {
        shortened: conversations.iter().filter(|c| c.truncated).count(),
        ..Default::default()
    };
    for conversation in conversations {
        match import_export_conversation(
            state,
            bot_archive::ORIGIN,
            &tenancy,
            caller,
            &conversation,
            Some(folder_path.as_str()),
        )
        .await
        {
            Ok(ExportConversationResult::Created) => counts.created += 1,
            Ok(ExportConversationResult::Updated) => counts.updated += 1,
            Ok(ExportConversationResult::Unchanged) => counts.unchanged += 1,
            Ok(ExportConversationResult::Diverged) => counts.diverged += 1,
            Err(e) => {
                counts.failed += 1;
                tracing::warn!("bot archive import: {}: {e:#}", conversation.id);
            }
        }
    }
    let detail =
        super::import_export_text::export_detail(label, &counts, Some(folder_path.as_str()), &kept);
    let mut outcome =
        super::import_export_text::export_outcome(id, title, &counts, detail, Some(folder_path));
    // A second import of the same archive: every chat and file is already there.
    let changed = counts.created + counts.updated + counts.diverged + counts.failed + copied.copied;
    if changed == 0 && counts.unchanged + copied.unchanged > 0 {
        outcome.status = "skipped";
        outcome.already_exists = true;
    }
    if counts.created + counts.updated > 0 {
        crate::events::publish_system_notification_for_user(
            "Chats imported",
            super::import_export_text::chats_imported_body(
                label,
                Some(bot.name.as_str()),
                counts.created,
                counts.updated,
            ),
            "success",
            caller.as_ref().map(|verified| verified.user_id.clone()),
        );
    }
    outcome
}

#[cfg(test)]
#[path = "import_bot_archive_tests.rs"]
mod tests;
