//! One-time migration of the legacy creative-canvas FILE store into the Canvas
//! Ryu App's Space documents.
//!
//! The built-in canvas persisted each board as `~/.ryu/canvases/<id>.json`
//! (`server/canvas.rs`, now removed). The feature was ported to a full-page
//! Companion (`@ryu/canvas`) which OWNS its boards as Space documents of kind
//! `app:@ryu/canvas`. This importer runs at startup: for every legacy file it
//! creates one app document in the "Canvas" system space, copies the board into the
//! doc `source` (the exact `{ name, nodes, edges, viewport }` shape the app reads
//! via `window.ryu.spaces.getDoc`), then deletes the plaintext file so it is
//! imported exactly once (idempotent across restarts) and the board content
//! does not stay readable beside its sealed Space copy. Older builds renamed
//! the file to `<id>.json.migrated` instead; [`remove_migrated_canvas_residue`]
//! deletes those leftovers at startup. A file that is not valid JSON is
//! quarantined as `<id>.json.invalid` (kept, never deleted, since it cannot be
//! imported) so it does not keep the import pending on every boot.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::plugin_manifest::CANVAS_PLUGIN_ID;
use crate::server::spaces::SpaceStore;

fn canvases_dir() -> PathBuf {
    crate::paths::state_path("canvases")
}

/// Whether `~/.ryu/canvases` holds at least one un-migrated `*.json` board.
///
/// The **precondition** for the import, hoisted out of [`migrate_legacy_canvases`]
/// so the caller can decide before doing anything observable. It exists because the
/// import's only input used to be a Space that boot created unconditionally:
/// `ensure_system_space("Canvas")` ran on every start, for every user, and THEN the
/// importer looked for legacy files and almost always found none. The visible cost
/// of that ordering was an undeletable, empty "Canvas" Space on machines that had
/// never installed the Canvas app — created fresh on the next boot after any reset.
///
/// Same predicate the importer applies (`*.json`, not `*.json.migrated` or a
/// quarantined `*.json.invalid`), so a `true` here means the pass has real work
/// and a `false` means it would have migrated nothing. Cheap: one `read_dir`, short-circuiting on the first match,
/// and an absent directory — the case for every install that post-dates the App
/// port — is `false` without touching a file.
pub fn has_pending_legacy_canvases() -> bool {
    let Ok(entries) = std::fs::read_dir(canvases_dir()) else {
        return false; // no legacy store — nothing to import.
    };
    entries
        .flatten()
        .any(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
}

/// Import every legacy canvas file into `space_id` as a `@ryu/canvas` document.
/// Best-effort: a file that is not valid JSON is renamed to `<id>.json.invalid`
/// (its bytes kept for the user) rather than aborting the whole pass; an
/// unreadable file is left in place for the next boot. Returns the number of
/// boards migrated.
pub async fn migrate_legacy_canvases(store: &SpaceStore, space_id: &str) -> usize {
    let dir = canvases_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0; // no legacy store — nothing to do.
    };
    let mut migrated = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        // Only untouched `*.json` files (skip already-migrated `*.json.migrated`).
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => value,
            Err(error) => {
                // Quarantine instead of retrying forever: a parse failure is
                // permanent, and leaving the `*.json` keeps
                // `has_pending_legacy_canvases` true on every boot.
                let quarantined = path.with_extension("json.invalid");
                tracing::warn!(
                    "canvas migrate: {path:?} is not valid JSON ({error}); moving it to {quarantined:?}"
                );
                if let Err(e) = std::fs::rename(&path, &quarantined) {
                    tracing::warn!("canvas migrate: quarantine failed for {path:?}: {e}");
                }
                continue;
            }
        };
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Untitled canvas")
            .to_owned();
        let nodes = value.get("nodes").cloned().unwrap_or_else(|| json!([]));
        let edges = value.get("edges").cloned().unwrap_or_else(|| json!([]));
        let viewport = value.get("viewport").cloned();
        // The app's scene shape: { name, nodes, edges, viewport? }.
        let mut scene = json!({ "name": name, "nodes": nodes, "edges": edges });
        if let Some(vp) = viewport {
            scene["viewport"] = vp;
        }
        let source = scene.to_string();

        match store
            .app_create_doc(
                CANVAS_PLUGIN_ID,
                space_id,
                &name,
                &crate::server::spaces::background_owner(),
            )
            .await
        {
            Ok(doc_id) => {
                if let Err(e) = store
                    .app_update_doc(CANVAS_PLUGIN_ID, &doc_id, Some(&name), &source)
                    .await
                {
                    tracing::warn!("canvas migrate: write '{}' failed: {e}", name);
                    // The file stays pending, so the next boot retries; drop the
                    // empty doc now or every retry leaves another orphan.
                    if let Err(e) = store.delete_document(&doc_id).await {
                        tracing::warn!("canvas migrate: cleanup of empty doc {doc_id} failed: {e}");
                    }
                    continue;
                }
                // The board now lives (sealed) in the Space document: delete the
                // plaintext source so a restart never re-imports it and its
                // content does not stay on disk in the clear.
                if let Err(e) = std::fs::remove_file(&path) {
                    tracing::warn!("canvas migrate: removing {path:?} failed: {e}");
                    // At least never import it twice; the startup sweep
                    // retries the delete.
                    let _ = std::fs::rename(&path, path.with_extension("json.migrated"));
                }
                migrated += 1;
            }
            Err(e) => tracing::warn!("canvas migrate: create doc for '{}' failed: {e}", name),
        }
    }
    if migrated > 0 {
        tracing::info!("canvas migrate: imported {migrated} legacy board(s) into the Canvas space");
    }
    migrated
}

/// Delete the `*.json.migrated` files older builds left behind after importing
/// a legacy board (each holds the board's full plaintext content, which now
/// lives sealed in its Space document). Removes the directory once empty.
/// Returns the number of files deleted; cheap when the directory is absent.
pub fn remove_migrated_canvas_residue() -> usize {
    let removed = remove_migrated_in(&canvases_dir());
    if removed > 0 {
        tracing::info!("canvas migrate: deleted {removed} imported legacy board file(s)");
    }
    removed
}

fn remove_migrated_in(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_residue = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".json.migrated"));
        if !is_residue {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("canvas migrate: removing {path:?} failed: {e}"),
        }
    }
    // Only succeeds when nothing (no un-migrated board) is left.
    let _ = std::fs::remove_dir(dir);
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrated_residue_is_deleted_and_pending_boards_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let canvases = dir.path().join("canvases");
        std::fs::create_dir_all(&canvases).unwrap();
        std::fs::write(
            canvases.join("a.json.migrated"),
            b"{\"name\":\"secret board\"}",
        )
        .unwrap();
        std::fs::write(canvases.join("b.json.migrated"), b"{}").unwrap();
        std::fs::write(canvases.join("c.json"), b"{}").unwrap();
        assert_eq!(remove_migrated_in(&canvases), 2);
        assert!(!canvases.join("a.json.migrated").exists());
        assert!(
            canvases.join("c.json").exists(),
            "an un-imported board is kept"
        );
        std::fs::remove_file(canvases.join("c.json")).unwrap();
        assert_eq!(remove_migrated_in(&canvases), 0);
        assert!(!canvases.exists(), "the empty legacy directory is removed");
        assert_eq!(remove_migrated_in(&canvases), 0);
    }
}
