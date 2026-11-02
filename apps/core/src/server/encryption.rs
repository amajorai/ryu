//! At-rest encryption posture (`GET /api/encryption/status`).
//!
//! The read-only status surface behind the desktop's Gateway settings →
//! **Encryption** tab. Two things, both honest:
//!
//! 1. **Key custody** — which of the three paths (`RYU_MASTER_KEY` env → OS
//!    keychain → `~/.ryu/master.key` file fallback) the *running* process
//!    actually resolved, from [`ryu_crypto::key_custody`]. The file fallback puts
//!    the key next to the data it protects, so it is reported as a degraded
//!    posture rather than a silent equivalent.
//! 2. **Per-store coverage** — what is sealed today, store by store, with live
//!    row counts where they can be measured cheaply. Encryption-at-rest landed as
//!    slices (`docs/encryption-at-rest.md` §8): chat content, long-term memory,
//!    identity-vault state, plugin secrets, Spaces documents and the Core record
//!    stores (approvals, safe actions, prompt evals, agents, workflows and
//!    routines, alert delivery, catalog sources) are sealed. A single
//!    "Encrypted ✓" badge would misreport the node (preferences, app data and
//!    the device token stay partial), so this endpoint names every store's real
//!    state. The list is built by [`store_entries`], a pure function, so a test
//!    can assert that nothing sealed is reported as plaintext.
//!
//! Deliberately read-only and secret-free: no key material in any form (not the
//! key, not a prefix, not a hash), and no rotation/re-encrypt actions — those are
//! later slices of the same doc, not part of showing the posture.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

use super::ServerState;

mod stores;

use stores::{store_entries, StoreCoverage};

fn source_history() -> ryu_workspace::source_history::SourceHistory {
    ryu_workspace::source_history::SourceHistory::new(crate::paths::files_path("source-history"))
}

/// Run the source-history import once at startup (off the boot path) and warn
/// when the store has to stay on its plaintext Git history.
pub fn report_source_history_on_start() {
    if let ryu_workspace::source_history::SourceHistoryState::LegacyGit(reason) =
        source_history().migrate_and_report()
    {
        tracing::warn!("Source history still stored unencrypted: {reason}");
    }
    // Then move the plaintext JSON skill snapshots earlier builds kept under
    // `state/skill-versions/` into the sealed history (needs the import above).
    let report = ryu_skills::store::import_legacy_skill_versions();
    if report.imported > 0 || report.kept > 0 {
        tracing::info!(
            imported = report.imported,
            kept = report.kept,
            "legacy skill version snapshots imported into the sealed source history"
        );
    }
}

/// The source-history state, downgraded to plaintext while legacy skill
/// snapshots still wait for their import.
fn source_history_state() -> ryu_workspace::source_history::SourceHistoryState {
    use ryu_workspace::source_history::SourceHistoryState;
    match source_history().migrate_and_report() {
        SourceHistoryState::Sealed => ryu_skills::store::legacy_skill_versions_pending()
            .map_or(SourceHistoryState::Sealed, SourceHistoryState::LegacyGit),
        other => other,
    }
}

/// `GET /api/encryption/status`
///
/// The node's at-rest encryption posture: master-key custody plus a per-store
/// coverage table. Fails closed like the stores do — when the master key cannot
/// be loaded at all, `key.available` is `false` and carries the error, because in
/// that state the sealed stores refuse to open rather than writing plaintext.
#[utoipa::path(
    get,
    path = "/api/encryption/status",
    tag = "Data",
    summary = "At-rest encryption posture: key custody + per-store coverage",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn encryption_status(State(state): State<ServerState>) -> impl IntoResponse {
    // Key custody. `key_custody` resolves the key (cheap after boot) so the
    // answer describes the key in use, not a configured preference.
    let key = match ryu_crypto::key_custody() {
        Ok(c) => json!({
            "available": true,
            "source": c.source.as_str(),
            "envVar": c.env_var,
            "keychainService": c.keychain_service,
            "keychainAccount": c.keychain_account,
            "keyFile": c.key_file.as_ref().map(|p| p.display().to_string()),
            "legacyMemoryKeyPresent": c.legacy_memory_key_present,
            "error": serde_json::Value::Null,
        }),
        Err(e) => json!({
            "available": false,
            "source": serde_json::Value::Null,
            "envVar": "RYU_MASTER_KEY",
            "keychainService": serde_json::Value::Null,
            "keychainAccount": serde_json::Value::Null,
            "keyFile": serde_json::Value::Null,
            "legacyMemoryKeyPresent": false,
            "error": e.to_string(),
        }),
    };

    // Measured chat coverage: rows carrying the `enc:v1:` envelope vs rows that
    // exist. Legacy plaintext rows written before slice 1 upgrade lazily on the
    // next write, so this can legitimately read "partial" on an old node.
    let (chat_sealed, chat_total) = state
        .conversations
        .count_sealed_content()
        .await
        .unwrap_or((0, 0));

    // Memory rows are encrypted by construction (ciphertext + nonce blob columns,
    // no plaintext column to fall back to), so the count is exposure context, not
    // a coverage ratio.
    let memory_total = state.memory.count().await.unwrap_or(0);

    let history_state = tokio::task::spawn_blocking(source_history_state)
        .await
        .unwrap_or_else(|error| {
            ryu_workspace::source_history::SourceHistoryState::LegacyGit(error.to_string())
        });

    let stores = store_entries(&StoreCoverage {
        chat_sealed,
        chat_total,
        memory_total,
        spaces_seal: state.spaces.seal_status(),
        agents_unreadable: state.agent_store.unreadable_rows(),
        history: history_state,
    });

    (
        StatusCode::OK,
        Json(json!({
            "key": key,
            "stores": stores,
            "dataDir": crate::paths::ryu_dir().display().to_string(),
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests;
