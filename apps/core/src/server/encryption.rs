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

/// Coverage verdict for one store. Ordered worst-to-best is not meaningful here;
/// the desktop colours on the string.
const SEALED: &str = "sealed";
const PARTIAL: &str = "partial";
const PLAINTEXT: &str = "plaintext";

fn source_history() -> ryu_workspace::source_history::SourceHistory {
    ryu_workspace::source_history::SourceHistory::new(crate::paths::files_path("source-history"))
}

/// The source-history store entry: sealed, or still on the legacy plaintext
/// Git repository with the reason its import has not completed (too little
/// free space, or an import that did not verify).
fn source_history_entry(
    state: &ryu_workspace::source_history::SourceHistoryState,
) -> serde_json::Value {
    use ryu_workspace::source_history::SourceHistoryState;
    match state {
        SourceHistoryState::Sealed => json!({
            "id": "source-history",
            "label": "Version history",
            "status": SEALED,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Saved versions of agents, workflows, skills and Space sources are sealed with the master key; paths and timestamps stay readable so the history can be listed.",
            "warning": serde_json::Value::Null,
        }),
        SourceHistoryState::LegacyGit(reason) => json!({
            "id": "source-history",
            "label": "Version history",
            "status": PLAINTEXT,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": format!("Saved versions of agents, workflows, skills and Space sources are still in the unencrypted history an earlier version kept ({reason}). Ryu retries the import at each start."),
            "warning": format!("Source history still stored unencrypted: {reason}"),
        }),
    }
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

/// What [`store_entries`] reports from: live counts and the seal state of the
/// stores that expose one.
struct StoreCoverage {
    chat_sealed: u64,
    chat_total: u64,
    memory_total: u64,
    spaces_seal: ryu_spaces::SealStatus,
    agents_unreadable: u64,
    history: ryu_workspace::source_history::SourceHistoryState,
}

/// One sealed Core record store. Reported as partial only when rows were
/// skipped because they did not open under the current key.
fn record_store(id: &str, label: &str, detail: &str, unreadable_rows: u64) -> serde_json::Value {
    let (status, detail) = if unreadable_rows == 0 {
        (SEALED, detail.to_owned())
    } else {
        (
            PARTIAL,
            format!(
                "{detail} {unreadable_rows} row(s) did not open under the current key and are skipped."
            ),
        )
    };
    json!({
        "id": id,
        "label": label,
        "status": status,
        "sealed": serde_json::Value::Null,
        "total": serde_json::Value::Null,
        "detail": detail,
    })
}

/// The Spaces row, from the store's own seal health: sealed only when it
/// accepts writes under the current key, no row is unreadable, the migration
/// finished and every blob file is sealed; otherwise partial, with the reason.
fn spaces_entry(seal: &ryu_spaces::SealStatus) -> serde_json::Value {
    let mut reasons = Vec::new();
    if !seal.writable {
        reasons.push(
            "the store is sealed under a key this process does not hold, so writes are refused"
                .to_owned(),
        );
    }
    if seal.unreadable_rows > 0 {
        reasons.push(format!(
            "{} value(s) did not open and are skipped",
            seal.unreadable_rows
        ));
    }
    if seal.migration != "sealed" {
        reasons.push(format!("sealing is still running ({})", seal.migration));
    }
    if seal.blobs_sealed < seal.blobs_total {
        reasons.push(format!(
            "{} of {} uploaded files are sealed{}",
            seal.blobs_sealed,
            seal.blobs_total,
            seal.blobs_pending
                .as_deref()
                .map(|why| format!(" ({why})"))
                .unwrap_or_default()
        ));
    }
    let base = "Document and chunk text, embeddings, page history and uploaded files are sealed with the master key. Ids, timestamps and keyed lookup tokens stay readable so access filters, title lookups and keyword search keep working.";
    let (status, detail) = if reasons.is_empty() {
        (SEALED, base.to_owned())
    } else {
        (
            PARTIAL,
            format!("{base} Not complete yet: {}.", reasons.join("; ")),
        )
    };
    json!({
        "id": "spaces",
        "label": "Spaces & documents",
        "status": status,
        "sealed": seal.blobs_sealed,
        "total": seal.blobs_total,
        "detail": detail,
    })
}

/// The per-store coverage list, from already-measured inputs.
fn store_entries(inputs: &StoreCoverage) -> serde_json::Value {
    let chat_status = if inputs.chat_total == 0 || inputs.chat_sealed == inputs.chat_total {
        SEALED
    } else {
        PARTIAL
    };
    json!([
        {
            "id": "chats",
            "label": "Chats",
            "status": chat_status,
            "sealed": inputs.chat_sealed,
            "total": inputs.chat_total,
            "detail": "Message bodies, streamed parts and conversation titles are sealed with the master key. Roles, ids and timestamps stay readable so lists and ordering keep working.",
        },
        {
            "id": "memory",
            "label": "Long-term memory",
            "status": PARTIAL,
            "sealed": inputs.memory_total,
            "total": inputs.memory_total,
            "detail": "Every entry's content is stored as ciphertext; only its category, tags and scope stay readable so recall can filter.",
        },
        {
            "id": "identities",
            "label": "Identity vault",
            "status": SEALED,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Saved website credentials are sealed before they touch the row and are never logged.",
        },
        {
            "id": "plugin-secrets",
            "label": "Plugin secrets",
            "status": SEALED,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Per-plugin API keys are write-only and sealed at rest. Without a loadable master key the store refuses writes rather than storing plaintext.",
        },
        {
            "id": "preferences",
            "label": "Preferences & provider keys",
            "status": PARTIAL,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Credential preferences (provider keys, tokens and passwords) are sealed with the master key; ordinary settings remain plaintext so they stay queryable.",
        },
        {
            // Reported as PARTIAL rather than plaintext because the honest answer
            // is per-app: Core stores whatever bytes the app hands it, and an app
            // holding `crypto:seal` hands over ciphertext it sealed under its own
            // subkey. Calling the whole store plaintext would understate the apps
            // that opted in; calling it sealed would badly overstate the ones that
            // did not. Neither number is knowable from here — Core cannot tell a
            // sealed value from an opaque one without trying every app's key — so
            // the counts stay null and the detail explains the split.
            "id": "app-data",
            "label": "App data",
            "status": PARTIAL,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Values apps store on this device are written as given. An app that requests the \"encrypt its own data\" permission seals them first, under a key derived per app that the app itself never sees; apps that do not are stored in the clear.",
        },
        {
            "id": "device-token",
            "label": "Device token",
            "status": PARTIAL,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "The Core sign-in token and multi-account bearer tokens are sealed before auth.json or accounts.json; the separate early-boot node-auth.token remains plaintext until its boot-order path is redesigned.",
        },
        spaces_entry(&inputs.spaces_seal),
        // The Core record stores below are sealed per value, so their rows have
        // no live ratio; `agents` also reports rows it could not open.
        record_store(
            "approvals",
            "Approvals",
            "Approval requests (tool arguments, prompts, messages, results and notes) are sealed per row; ids, status and timestamps stay readable so the inbox can filter and expire.",
            0,
        ),
        record_store(
            "safe-actions",
            "Safe actions",
            "Submitted plans with their tool arguments, verification reports and review notes are sealed per row; ids, status, policies and timestamps stay readable.",
            0,
        ),
        record_store(
            "prompt-evals",
            "Prompt evals",
            "Suite and version configs, run requests and results, and review comments are sealed per value; names, scores and timestamps stay readable.",
            0,
        ),
        record_store(
            "agents",
            "Agents",
            "Agent descriptions, system prompts, personas and saved prompt versions are sealed per value; ids, names, tool and model bindings stay readable so agents can be listed and routed.",
            inputs.agents_unreadable,
        ),
        record_store(
            "workflows",
            "Workflows & routines",
            "Webhook secrets, chat bot tokens and webhook URLs inside saved workflows, scripts and scheduled routines are sealed per value; the rest of each definition stays readable so it can run.",
            0,
        ),
        record_store(
            "alert-delivery",
            "Alert delivery targets",
            "Telegram bot tokens, Slack and Discord webhook URLs, push tokens and email recipients that alerts are sent to are sealed; the notification inbox itself stays readable.",
            0,
        ),
        record_store(
            "catalog-sources",
            "Marketplace sources",
            "Credentials for private marketplace sources are sealed per value; source names and URLs stay readable.",
            0,
        ),
        {
            "id": "gateway-audit",
            "label": "Gateway audit log",
            "status": PARTIAL,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": "Request metadata stays readable; API keys are represented on disk by a SHA-256 lookup key and a short display prefix, never by the raw credential.",
        },
        source_history_entry(&inputs.history),
    ])
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
mod tests {
    use super::*;
    use ryu_workspace::source_history::SourceHistoryState;

    /// A store left on its legacy Git history is reported as plaintext with
    /// the recorded reason, not silently counted as sealed.
    #[test]
    fn source_history_left_on_git_is_reported_with_its_reason() {
        let entry = source_history_entry(&SourceHistoryState::LegacyGit(
            "not enough free space".to_owned(),
        ));
        assert_eq!(entry["status"], PLAINTEXT);
        assert_eq!(
            entry["warning"],
            "Source history still stored unencrypted: not enough free space"
        );
        let sealed = source_history_entry(&SourceHistoryState::Sealed);
        assert_eq!(sealed["status"], SEALED);
        assert!(sealed["warning"].is_null());
        assert!(entry["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("not enough free space")));
    }

    fn finished_spaces_seal() -> ryu_spaces::SealStatus {
        ryu_spaces::SealStatus {
            unreadable_rows: 0,
            writable: true,
            migration: "sealed".to_owned(),
            blobs_sealed: 3,
            blobs_total: 3,
            blobs_pending: None,
        }
    }

    fn coverage(spaces_seal: ryu_spaces::SealStatus, agents_unreadable: u64) -> StoreCoverage {
        StoreCoverage {
            chat_sealed: 4,
            chat_total: 4,
            memory_total: 2,
            spaces_seal,
            agents_unreadable,
            history: SourceHistoryState::Sealed,
        }
    }

    fn status_of(stores: &serde_json::Value, id: &str) -> String {
        stores
            .as_array()
            .and_then(|stores| stores.iter().find(|store| store["id"] == id))
            .and_then(|store| store["status"].as_str())
            .unwrap_or_else(|| panic!("no store entry `{id}`"))
            .to_owned()
    }

    /// Every store the node seals is listed, and none of them reads as
    /// plaintext while its seal is healthy.
    #[test]
    fn sealed_stores_are_listed_and_never_reported_as_plaintext() {
        let stores = store_entries(&coverage(finished_spaces_seal(), 0));
        for id in [
            "spaces",
            "approvals",
            "safe-actions",
            "prompt-evals",
            "agents",
            "workflows",
            "alert-delivery",
            "catalog-sources",
            "source-history",
        ] {
            assert_eq!(status_of(&stores, id), SEALED, "{id}");
        }
        let entries = stores.as_array().expect("an array of stores");
        let spaces = entries
            .iter()
            .find(|store| store["id"] == "spaces")
            .expect("spaces entry");
        assert!(!spaces["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("in the clear"));
        assert_eq!(spaces["sealed"], 3);
        assert_eq!(spaces["total"], 3);
        for store in entries {
            assert_ne!(store["status"], PLAINTEXT, "{}", store["id"]);
        }
    }

    /// Spaces is partial, with the reason, until its seal is complete and
    /// writable under the current key; unreadable agent rows make agents partial.
    #[test]
    fn spaces_and_agents_report_partial_while_their_seal_is_incomplete() {
        let cases = [
            ryu_spaces::SealStatus {
                writable: false,
                ..finished_spaces_seal()
            },
            ryu_spaces::SealStatus {
                unreadable_rows: 2,
                ..finished_spaces_seal()
            },
            ryu_spaces::SealStatus {
                migration: "sealing".to_owned(),
                ..finished_spaces_seal()
            },
            ryu_spaces::SealStatus {
                migration: "error: disk full".to_owned(),
                ..finished_spaces_seal()
            },
            ryu_spaces::SealStatus {
                blobs_sealed: 1,
                blobs_pending: Some("low disk space".to_owned()),
                ..finished_spaces_seal()
            },
        ];
        for seal in cases {
            let entry = spaces_entry(&seal);
            assert_eq!(entry["status"], PARTIAL, "{seal:?}");
            assert!(entry["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("Not complete yet")));
        }
        let stores = store_entries(&coverage(finished_spaces_seal(), 1));
        assert_eq!(status_of(&stores, "agents"), PARTIAL);
        assert_eq!(status_of(&stores, "approvals"), SEALED);
    }
}
