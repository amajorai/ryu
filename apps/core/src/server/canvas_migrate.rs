//! One-time migration of the legacy creative-canvas FILE store into the Canvas
//! Ryu App's Space documents.
//!
//! The built-in canvas persisted each board as `~/.ryu/canvases/<id>.json`
//! (`server/canvas.rs`, now removed). The feature was ported to a full-page
//! Companion (`com.ryu.canvas`) which OWNS its boards as Space documents of kind
//! `app:com.ryu.canvas`. This importer runs at startup: for every legacy file it
//! creates one app document in the "Canvas" system space, copies the board into the
//! doc `source` (the exact `{ name, nodes, edges, viewport }` shape the app reads
//! via `window.ryu.spaces.getDoc`), then renames the file to `<id>.json.migrated`
//! so it is imported exactly once (idempotent across restarts).

use std::path::PathBuf;

use serde_json::json;

use crate::paths::ryu_dir;
use crate::plugin_manifest::CANVAS_PLUGIN_ID;
use crate::server::spaces::SpaceStore;

fn canvases_dir() -> PathBuf {
    ryu_dir().join("canvases")
}

/// Import every legacy canvas file into `space_id` as a `com.ryu.canvas` document.
/// Best-effort: a malformed file is skipped (and left in place) rather than
/// aborting the whole pass. Returns the number of boards migrated.
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
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
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

        match store.app_create_doc(CANVAS_PLUGIN_ID, space_id, &name).await {
            Ok(doc_id) => {
                if let Err(e) = store
                    .app_update_doc(CANVAS_PLUGIN_ID, &doc_id, Some(&name), &source)
                    .await
                {
                    tracing::warn!("canvas migrate: write '{}' failed: {e}", name);
                    continue;
                }
                // Rename so a restart never re-imports it.
                let done = path.with_extension("json.migrated");
                if let Err(e) = std::fs::rename(&path, &done) {
                    tracing::warn!("canvas migrate: mark-done failed for {path:?}: {e}");
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
