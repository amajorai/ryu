//! The **file notes into a Space** kernel capability (`spaces.fileNotes`).
//!
//! Files a finalized notes document into the "Meetings" system Space under the
//! background owner. Core owns the `SpaceStore` and its tenancy, so a sidecar
//! cannot do this itself. Body `{ title, markdown }` → `{ space_id, doc_id }`.
//!
//! Gate: the caller's minted ext token, the `spaces:docs` host grant (checked by
//! the broker before dispatch), and a pin to the one app this was built for
//! (`@ryu/meetings`).
//!
//! # Why the pin stays (reviewed 2026-10-11)
//!
//! `spaces:docs` is necessary but not sufficient. Its reviewed meaning (the
//! `host.spaces_*` bridge in `plugin_host::bridge`) is "an app owns its OWN Space
//! documents": every document it touches carries `kind = "app:<plugin_id>"`, the
//! store isolates them per app, and the caller's Space ACL (`SPACE_READ` /
//! `SPACE_WRITE`) still applies. This handler does something else: it creates (or
//! re-asserts) the shared "Meetings" SYSTEM Space and ingests an ordinary `page`
//! document that no app owns, under `background_owner()`, with no per-user Space
//! access check. Unpinning on `spaces:docs` would let every holder (Whiteboard,
//! Canvas, and any approved third-party app) write into that system Space.
//! Replacing the pin needs a new reviewed scope for that write: a Gateway governance
//! change, not a Core refactor. See `docs/app-boundary-extraction-plan.md` (step 6).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::spaces::{self, SpaceStore};
use super::ServerState;
use crate::plugins::builtins::MEETINGS_PLUGIN_ID;
use crate::sidecar::ext_proxy::authenticate_sidecar;

/// The Space that filed notes land in. Reusing Spaces gives editing (the PlateJS
/// markdown editor) and RAG search for free.
const NOTES_SPACE_NAME: &str = "Meetings";

/// The `{ title, markdown }` body the caller posts.
#[derive(serde::Deserialize)]
pub(crate) struct FileNotesBody {
    title: String,
    markdown: String,
}

/// `POST /api/host/capability/spaces.fileNotes` — file a notes document into the
/// "Meetings" Space on the pinned app's behalf and return `{ space_id, doc_id }`
/// for it to persist.
///
/// The `@ryu/meetings` pin is the load-bearing gate: the broker's `spaces:docs`
/// check does not cover a write into a system Space under the background owner
/// (see the module doc).
pub(crate) async fn host_file_notes(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FileNotesBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != MEETINGS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the meetings app" })),
        )
            .into_response();
    }

    match file_notes(&state.spaces, &body.title, &body.markdown).await {
        Some((space_id, doc_id)) => {
            Json(json!({ "space_id": space_id, "doc_id": doc_id })).into_response()
        }
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "filing notes into the Meetings space failed" })),
        )
            .into_response(),
    }
}

/// Find the notes Space (creating it on first use) and ingest the markdown under
/// the background owner. Returns `(space_id, doc_id)` on success.
async fn file_notes(spaces: &SpaceStore, title: &str, markdown: &str) -> Option<(String, String)> {
    // Get-or-create as a SYSTEM space (system=1) so it is undeletable, matching
    // Artifacts/Canvas/Whiteboard/Clips. `ensure_system_space` also re-asserts
    // system=1 on an existing row, so an older deletable Meetings space is upgraded
    // in place on the next filing.
    let space_id = match spaces
        .ensure_system_space(NOTES_SPACE_NAME, Some("Auto-saved meeting notes"))
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!("spaces.fileNotes: ensuring the Meetings space failed: {e:#}");
            return None;
        }
    };
    match spaces
        .ingest_document(&space_id, title, markdown, &spaces::background_owner())
        .await
    {
        Ok(doc_id) => Some((space_id, doc_id)),
        Err(e) => {
            tracing::warn!("spaces.fileNotes: saving notes to the space failed: {e:#}");
            None
        }
    }
}
