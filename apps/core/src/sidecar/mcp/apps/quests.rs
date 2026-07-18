//! Quest Board MCP app (kernel MCP-app glue). Thin dispatch over the OUT-OF-PROCESS
//! `ryu-quests` sidecar: `board` reads the quest list and groups it into columns,
//! and the companion writes drive the sidecar — `create` mints a quest (plus its
//! backing detection job, reconciled Core-side), `update` moves it between columns,
//! and `complete` marks it done. Every call goes over loopback through the
//! process-global [`crate::quests_client`] (the quest engine no longer lives in
//! Core), so the sidecar's `QuestEvent` broadcast still fans out to the desktop
//! quests page + island chip and the backing scheduler job is kept in sync by the
//! quests_client reconcile loop.
//!
//! The quest business logic (state transitions, job sync) lives in the sidecar;
//! this module is only the MCP `tools/call` envelope + tool routing + the board
//! grouping (the dep-free successor to the crate's `board_columns`).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, AppDispatchCtx};
use crate::quests_client::{global_client, QuestsClient};

pub async fn dispatch(tool: &str, args: Value, _ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    match tool {
        "board" => board().await,
        "update" => update(args).await,
        "complete" => complete(args).await,
        "create" => create(args).await,
        other => Err(anyhow!("unknown ryu.quests tool '{other}'")),
    }
}

/// Resolve the process-global quests client (the loopback handle to the sidecar).
fn client() -> Result<&'static QuestsClient> {
    global_client().ok_or_else(|| anyhow!("quests sidecar is unavailable"))
}

/// Read the board: all quests, grouped into the three backend columns. The
/// grouping mirrors the sidecar crate's `board_columns` over the quest JSON.
async fn board() -> Result<Value> {
    // An unreachable sidecar surfaces as an empty board rather than a widget error.
    let quests = client()?.list_quests().await.unwrap_or_default();
    let open_count = quests
        .iter()
        .filter(|q| q.get("status").and_then(Value::as_str) == Some("open"))
        .count();
    Ok(app_result(
        board_columns(&quests),
        None,
        &format!("{open_count} open quest(s)."),
    ))
}

/// Group quests into the three backend columns (open/done/dismissed). Dep-free
/// port of `ryu_quests::board_columns`, operating on the quest JSON.
fn board_columns(quests: &[Value]) -> Value {
    let mut open = Vec::new();
    let mut done = Vec::new();
    let mut dismissed = Vec::new();
    for q in quests {
        let card = json!({
            "id": q.get("id").and_then(Value::as_str).unwrap_or(""),
            "title": q.get("title").and_then(Value::as_str).unwrap_or(""),
            "source": q.get("completion_source"),
        });
        match q.get("status").and_then(Value::as_str) {
            Some("done") => done.push(card),
            Some("dismissed") => dismissed.push(card),
            // Open (or anything unexpected) lands in the open column, matching the
            // crate's default arm.
            _ => open.push(card),
        }
    }
    json!({
        "columns": [
            { "status": "open", "count": open.len(), "quests": open },
            { "status": "done", "count": done.len(), "quests": done },
            { "status": "dismissed", "count": dismissed.len(), "quests": dismissed },
        ],
    })
}

/// Move a quest between columns. `status` is the destination column: `done` →
/// complete, `dismissed` → dismiss, `open` → reopen. `order` (reorder within a
/// column) has no backend representation and is ignored.
async fn update(args: Value) -> Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("update requires an 'id'"))?
        .to_owned();
    let status = args
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();

    match status.as_str() {
        "done" | "complete" | "completed" => {
            let out = client()?
                .post(&format!("/{id}/complete"), json!({}))
                .await
                .map_err(|e| anyhow!("failed to complete quest: {e}"))?;
            Ok(quest_result(out, "complete"))
        }
        "dismissed" | "dismiss" => {
            let out = client()?
                .post(&format!("/{id}/dismiss"), json!({}))
                .await
                .map_err(|e| anyhow!("failed to dismiss quest: {e}"))?;
            Ok(quest_result(out, "dismiss"))
        }
        "open" | "todo" | "backlog" | "in_progress" | "doing" => {
            let out = client()?
                .post(&format!("/{id}/reopen"), json!({}))
                .await
                .map_err(|e| anyhow!("failed to reopen quest: {e}"))?;
            Ok(quest_result(out, "reopen"))
        }
        // A pure reorder (no status change): acknowledge without a mutation.
        _ => Ok(app_result(
            json!({ "id": id, "status": "ok", "reordered": true }),
            None,
            "Reordered quest.",
        )),
    }
}

/// Complete a quest (companion `complete` tool).
async fn complete(args: Value) -> Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("complete requires an 'id'"))?
        .to_owned();
    let out = client()?
        .post(&format!("/{id}/complete"), json!({}))
        .await
        .map_err(|e| anyhow!("failed to complete quest: {e}"))?;
    Ok(quest_result(out, "complete"))
}

/// Create a quest and its backing detection job (the quests_client reconcile loop
/// registers the `JobTarget::Quest` job so a widget-created quest is judged on the
/// same tick loop as an HTTP-created one).
async fn create(args: Value) -> Result<Value> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if title.is_empty() {
        return Err(anyhow!("create requires a non-empty 'title'"));
    }
    let out = client()?
        .post("/", json!({ "title": title }))
        .await
        .map_err(|e| anyhow!("failed to create quest: {e}"))?;
    let quest = out.get("quest").cloned().unwrap_or(Value::Null);
    let quest_title = quest
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&title);
    let summary = format!("Created quest '{quest_title}'.");
    Ok(app_result(json!({ "quest": quest, "status": "ok" }), None, &summary))
}

/// Shape a mutation result: the updated quest (when found) plus an ok/not-found
/// status the widget can surface. The sidecar returns `{ "quest": {...} }` on
/// success or a 404 the client maps to `Err`; a missing `quest` field is treated
/// as not-found.
fn quest_result(out: Value, op: &str) -> Value {
    match out.get("quest").filter(|q| !q.is_null()) {
        Some(q) => {
            let title = q.get("title").and_then(Value::as_str).unwrap_or("");
            let summary = format!("Quest {op}: '{title}'.");
            app_result(
                json!({ "quest": q, "status": "ok", "op": op }),
                None,
                &summary,
            )
        }
        None => app_result(
            json!({ "status": "not_found", "op": op }),
            None,
            &format!("Quest {op}: not found."),
        ),
    }
}
