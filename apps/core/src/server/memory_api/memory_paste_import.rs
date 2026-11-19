//! `POST /api/memory/import`: add memories pasted from another AI assistant.
//!
//! The user asks their other assistant to write out what it remembers, then
//! pastes the reply. Entries are parsed by [`crate::import::pasted_memory`],
//! recorded as user-scope memories with `import` provenance, and deduplicated
//! per owner by a content-hash tag, so pasting the same export twice adds
//! nothing.

use crate::import::pasted_memory::{parse_pasted_memories, PastedMemory, MAX_PASTED_MEMORY_BYTES};
use crate::server::*;

/// Assistants the desktop names; anything else is recorded as `other`.
const PASTE_SOURCES: &[&str] = &[
    "chatgpt",
    "claude",
    "gemini",
    "grok",
    "copilot",
    "perplexity",
    "other",
];

#[derive(Debug, serde::Deserialize)]
pub(in crate::server) struct ImportPastedMemoryBody {
    text: String,
    #[serde(default)]
    source: Option<String>,
}

/// What one paste added.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub(in crate::server) struct PastedMemorySummary {
    found: usize,
    imported: usize,
    already_present: usize,
    skipped_sensitive: usize,
    #[serde(skip)]
    ids: Vec<String>,
}

pub(in crate::server) fn paste_source(source: Option<&str>) -> &'static str {
    let source = source.map(str::trim).unwrap_or_default();
    PASTE_SOURCES
        .iter()
        .find(|known| known.eq_ignore_ascii_case(source))
        .copied()
        .unwrap_or("other")
}

/// Record parsed entries for `owner`, skipping ones already imported and, unless
/// allowed, ones that touch sensitive topics.
pub(in crate::server) async fn record_pasted_memories(
    store: &memory::MemoryStore,
    owner: &str,
    source: &str,
    entries: Vec<PastedMemory>,
    allow_sensitive: bool,
) -> anyhow::Result<PastedMemorySummary> {
    let mut summary = PastedMemorySummary {
        found: entries.len(),
        ..PastedMemorySummary::default()
    };
    for entry in entries {
        let hash = crate::import::content_sha256(&format!("{owner}\n{}", entry.content));
        let tag = format!("import:memory:paste:{}", &hash[..16]);
        if !store.ids_with_tag(&tag).await?.is_empty() {
            summary.already_present += 1;
            continue;
        }
        if !allow_sensitive && !memory::detect_sensitive_topics(&entry.content).is_empty() {
            summary.skipped_sensitive += 1;
            continue;
        }
        let mem = memory::NewMemory {
            content: entry.content,
            scope: memory::MemoryScope::User,
            scope_id: None,
            category: entry.category,
            importance: entry.importance,
            when_to_use: None,
            tags: vec![tag, format!("import:{source}")],
            author_agent_id: None,
        };
        if let Some(id) = store
            .record_full_with_metadata(owner, "default", mem, imported_memory_metadata())
            .await?
        {
            summary.imported += 1;
            summary.ids.push(id);
        }
    }
    Ok(summary)
}

pub(in crate::server) async fn import_pasted_memories(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ImportPastedMemoryBody>,
) -> axum::response::Response {
    if let Err(response) = require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    if body.text.len() > MAX_PASTED_MEMORY_BYTES {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the pasted text is too long; import it in smaller parts".to_owned(),
        );
    }
    let entries = parse_pasted_memories(&body.text);
    if entries.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "no memories were found in the pasted text".to_owned(),
        );
    }
    let owner = memory_owner_user_id(&caller);
    let source = paste_source(body.source.as_deref());
    let allow_sensitive = sensitive_memory_enabled(&state, &caller).await;
    match record_pasted_memories(&state.memory, &owner, source, entries, allow_sensitive).await {
        Ok(summary) => {
            for id in &summary.ids {
                if let Ok(Some(entry)) = state.memory.get(id).await {
                    index_memory_entry(&state, &entry).await;
                }
            }
            Json(json!(summary)).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
#[path = "memory_paste_import_tests.rs"]
mod tests;
