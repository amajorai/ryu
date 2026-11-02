//! The per-store coverage rows of `GET /api/encryption/status`.
//!
//! Each row carries a stable `id`, a `status`, and English `label`/`detail`
//! text kept as the fallback for older clients. The desktop renders its own
//! localized copy keyed by `id`, so every runtime fact the English detail
//! interpolates is also sent as a value: `reason` (source history),
//! `unreadableCount` (record stores) and `partialReasons` (Spaces, as codes).

use serde_json::json;

/// Coverage verdict for one store. Ordered worst-to-best is not meaningful here;
/// the desktop colours on the string.
pub(super) const SEALED: &str = "sealed";
pub(super) const PARTIAL: &str = "partial";
pub(super) const PLAINTEXT: &str = "plaintext";

/// The source-history store entry: sealed, or still on the legacy plaintext
/// Git repository with the reason its import has not completed (too little
/// free space, or an import that did not verify).
pub(super) fn source_history_entry(
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
            "reason": serde_json::Value::Null,
        }),
        SourceHistoryState::LegacyGit(reason) => json!({
            "id": "source-history",
            "label": "Version history",
            "status": PLAINTEXT,
            "sealed": serde_json::Value::Null,
            "total": serde_json::Value::Null,
            "detail": format!("Saved versions of agents, workflows, skills and Space sources are still in the unencrypted history an earlier version kept ({reason}). Ryu retries the import at each start."),
            "warning": format!("Source history still stored unencrypted: {reason}"),
            "reason": reason,
        }),
    }
}

/// What [`store_entries`] reports from: live counts and the seal state of the
/// stores that expose one.
pub(super) struct StoreCoverage {
    pub(super) chat_sealed: u64,
    pub(super) chat_total: u64,
    pub(super) memory_total: u64,
    pub(super) spaces_seal: ryu_spaces::SealStatus,
    pub(super) agents_unreadable: u64,
    pub(super) history: ryu_workspace::source_history::SourceHistoryState,
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
        "unreadableCount": unreadable_rows,
    })
}

/// The Spaces row, from the store's own seal health: sealed only when it
/// accepts writes under the current key, no row is unreadable, the migration
/// finished and every blob file is sealed; otherwise partial, with the reason.
pub(super) fn spaces_entry(seal: &ryu_spaces::SealStatus) -> serde_json::Value {
    // Each reason as English text (the fallback detail) and as a code with its
    // values (what the desktop renders in the reader's language).
    let mut reasons: Vec<(String, serde_json::Value)> = Vec::new();
    if !seal.writable {
        reasons.push((
            "the store is sealed under a key this process does not hold, so writes are refused"
                .to_owned(),
            json!({ "code": "key-not-held" }),
        ));
    }
    if seal.unreadable_rows > 0 {
        reasons.push((
            format!(
                "{} value(s) did not open and are skipped",
                seal.unreadable_rows
            ),
            json!({ "code": "unreadable-values", "count": seal.unreadable_rows }),
        ));
    }
    if seal.migration != "sealed" {
        reasons.push((
            format!("sealing is still running ({})", seal.migration),
            json!({ "code": "sealing-running", "state": seal.migration }),
        ));
    }
    if seal.blobs_sealed < seal.blobs_total {
        reasons.push((
            format!(
                "{} of {} uploaded files are sealed{}",
                seal.blobs_sealed,
                seal.blobs_total,
                seal.blobs_pending
                    .as_deref()
                    .map(|why| format!(" ({why})"))
                    .unwrap_or_default()
            ),
            json!({
                "code": "files-unsealed",
                "sealed": seal.blobs_sealed,
                "total": seal.blobs_total,
                "pending": seal.blobs_pending,
            }),
        ));
    }
    let base = "Document and chunk text, embeddings, page history and uploaded files are sealed with the master key. Ids, timestamps and keyed lookup tokens stay readable so access filters, title lookups and keyword search keep working.";
    let (status, detail) = if reasons.is_empty() {
        (SEALED, base.to_owned())
    } else {
        let english: Vec<&str> = reasons.iter().map(|(text, _)| text.as_str()).collect();
        (
            PARTIAL,
            format!("{base} Not complete yet: {}.", english.join("; ")),
        )
    };
    let codes: Vec<serde_json::Value> = reasons.into_iter().map(|(_, code)| code).collect();
    json!({
        "id": "spaces",
        "label": "Spaces & documents",
        "status": status,
        "sealed": seal.blobs_sealed,
        "total": seal.blobs_total,
        "detail": detail,
        "partialReasons": codes,
    })
}

/// The per-store coverage list, from already-measured inputs.
pub(super) fn store_entries(inputs: &StoreCoverage) -> serde_json::Value {
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
