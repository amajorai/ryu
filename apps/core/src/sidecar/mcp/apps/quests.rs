//! Quest Board app. Wired (B2) to the quests subsystem: `board` reads the live
//! [`QuestStore`], and the companion writes drive it — `create` mints a quest
//! (plus its backing detection job), `update` moves it between columns, and
//! `complete` marks it done. Mutations that change lifecycle state go through the
//! process-global [`QuestEngine`] so the `QuestEvent` broadcast fans out to the
//! desktop quests page + island chip; a store-only fallback keeps the tools
//! working when the engine is not published (e.g. in tests).
//!
//! Contract note: the backend `QuestStatus` is `Open | Done | Dismissed` (no
//! `todo/in_progress/done`, no `priority`/`order`/`project_cwd`), so the board
//! emits those three columns. The `QuestBoard` widget is column-agnostic (it
//! derives columns from whatever statuses arrive), so this renders and drives
//! without a widget change. In-column reorder (`order`) has no backend and is a
//! no-op here.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, AppDispatchCtx};
use crate::quests::store::QuestStore;
use crate::quests::{CompletionSource, Quest, QuestStatus};

pub async fn dispatch(tool: &str, args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    match tool {
        "board" => board(ctx).await,
        "update" => update(args, ctx).await,
        "complete" => complete(args, ctx).await,
        "create" => create(args, ctx).await,
        other => Err(anyhow!("unknown ryu.quests tool '{other}'")),
    }
}

/// Resolve a usable [`QuestStore`]: the dispatch-context handle when present,
/// else the process-global engine's store (both are cheap `Arc` clones).
fn resolve_store(ctx: &AppDispatchCtx<'_>) -> Result<QuestStore> {
    if let Some(store) = ctx.quests {
        return Ok(store.clone());
    }
    if let Some(engine) = crate::quests::global_engine() {
        return Ok(engine.store.clone());
    }
    Err(anyhow!("quests store is unavailable"))
}

/// Read the board: all quests, grouped into the three backend columns.
async fn board(ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let store = resolve_store(ctx)?;
    let quests = store
        .list_quests()
        .await
        .map_err(|e| anyhow!("failed to list quests: {e}"))?;

    let mut open = Vec::new();
    let mut done = Vec::new();
    let mut dismissed = Vec::new();
    for q in &quests {
        // `source` is a small subtitle on the card; surface how a finished quest
        // was completed (manual vs auto-detected) when known.
        let card = json!({
            "id": q.id,
            "title": q.title,
            "source": q.completion_source.map(|s| match s {
                CompletionSource::Manual => "manual",
                CompletionSource::Detected => "detected",
            }),
        });
        match q.status {
            QuestStatus::Open => open.push(card),
            QuestStatus::Done => done.push(card),
            QuestStatus::Dismissed => dismissed.push(card),
        }
    }

    let open_count = open.len();
    let structured = json!({
        "columns": [
            { "status": "open", "count": open.len(), "quests": open },
            { "status": "done", "count": done.len(), "quests": done },
            { "status": "dismissed", "count": dismissed.len(), "quests": dismissed },
        ],
    });
    Ok(app_result(
        structured,
        None,
        &format!("{open_count} open quest(s)."),
    ))
}

/// Move a quest between columns. `status` is the destination column: `done` →
/// complete, `dismissed` → dismiss, `open` → reopen. `order` (reorder within a
/// column) has no backend representation and is ignored.
async fn update(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
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
        "done" | "complete" | "completed" => complete_quest(&id, ctx).await,
        "dismissed" | "dismiss" => dismiss_quest(&id, ctx).await,
        "open" | "todo" | "backlog" | "in_progress" | "doing" => reopen_quest(&id, ctx).await,
        // A pure reorder (no status change): acknowledge without a mutation.
        _ => Ok(app_result(
            json!({ "id": id, "status": "ok", "reordered": true }),
            None,
            "Reordered quest.",
        )),
    }
}

/// Complete a quest (companion `complete` tool).
async fn complete(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("complete requires an 'id'"))?
        .to_owned();
    complete_quest(&id, ctx).await
}

/// Create a quest and its backing detection job (mirrors the HTTP `create_quest`
/// handler so a widget-created quest is judged on the same tick loop).
async fn create(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if title.is_empty() {
        return Err(anyhow!("create requires a non-empty 'title'"));
    }
    let store = resolve_store(ctx)?;
    let now = chrono::Utc::now().to_rfc3339();
    let quest = Quest {
        id: format!("quest_{}", uuid::Uuid::new_v4().simple()),
        title,
        detail: None,
        completion_condition: String::new(),
        status: QuestStatus::Open,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
        completion_source: None,
        last_judged_at: None,
        snoozed_until: None,
        suggestion: None,
    };
    store
        .upsert_quest(&quest)
        .await
        .map_err(|e| anyhow!("failed to create quest: {e}"))?;
    sync_backing_job(&quest);
    let summary = format!("Created quest '{}'.", quest.title);
    Ok(app_result(
        json!({ "quest": quest, "status": "ok" }),
        None,
        &summary,
    ))
}

/// Complete a quest via the engine (so the `Completed` event broadcasts), falling
/// back to a store-only write when the engine is not published.
async fn complete_quest(id: &str, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    if let Some(engine) = crate::quests::global_engine() {
        let quest = engine
            .complete_quest(id, false)
            .await
            .map_err(|e| anyhow!("failed to complete quest: {e}"))?;
        return Ok(quest_result(quest, "complete"));
    }
    let store = resolve_store(ctx)?;
    let Some(mut quest) = store
        .get_quest(id)
        .await
        .map_err(|e| anyhow!("failed to read quest: {e}"))?
    else {
        return Ok(not_found(id, "complete"));
    };
    let now = chrono::Utc::now().to_rfc3339();
    quest.status = QuestStatus::Done;
    quest.completed_at = Some(now.clone());
    quest.completion_source = Some(CompletionSource::Manual);
    quest.suggestion = None;
    quest.snoozed_until = None;
    quest.updated_at = now;
    store
        .upsert_quest(&quest)
        .await
        .map_err(|e| anyhow!("failed to complete quest: {e}"))?;
    sync_backing_job(&quest);
    Ok(quest_result(Some(quest), "complete"))
}

/// Dismiss (abandon) a quest via the engine, with a store-only fallback.
async fn dismiss_quest(id: &str, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    if let Some(engine) = crate::quests::global_engine() {
        let quest = engine
            .dismiss_quest(id)
            .await
            .map_err(|e| anyhow!("failed to dismiss quest: {e}"))?;
        if let Some(q) = quest.as_ref() {
            sync_backing_job(q);
        }
        return Ok(quest_result(quest, "dismiss"));
    }
    let store = resolve_store(ctx)?;
    let Some(mut quest) = store
        .get_quest(id)
        .await
        .map_err(|e| anyhow!("failed to read quest: {e}"))?
    else {
        return Ok(not_found(id, "dismiss"));
    };
    quest.status = QuestStatus::Dismissed;
    quest.suggestion = None;
    quest.updated_at = chrono::Utc::now().to_rfc3339();
    store
        .upsert_quest(&quest)
        .await
        .map_err(|e| anyhow!("failed to dismiss quest: {e}"))?;
    sync_backing_job(&quest);
    Ok(quest_result(Some(quest), "dismiss"))
}

/// Reopen a done/dismissed quest (drag back to the Open column). No engine method
/// exists for this, so it is a direct store write plus a backing-job re-sync.
async fn reopen_quest(id: &str, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let store = resolve_store(ctx)?;
    let Some(mut quest) = store
        .get_quest(id)
        .await
        .map_err(|e| anyhow!("failed to read quest: {e}"))?
    else {
        return Ok(not_found(id, "reopen"));
    };
    quest.status = QuestStatus::Open;
    quest.completed_at = None;
    quest.completion_source = None;
    quest.updated_at = chrono::Utc::now().to_rfc3339();
    store
        .upsert_quest(&quest)
        .await
        .map_err(|e| anyhow!("failed to reopen quest: {e}"))?;
    sync_backing_job(&quest);
    Ok(quest_result(Some(quest), "reopen"))
}

/// Shape a mutation result: the updated quest (when found) plus an ok/not-found
/// status the widget can surface.
fn quest_result(quest: Option<Quest>, op: &str) -> Value {
    match quest {
        Some(q) => {
            let summary = format!("Quest {op}: '{}'.", q.title);
            app_result(json!({ "quest": q, "status": "ok", "op": op }), None, &summary)
        }
        None => app_result(
            json!({ "status": "not_found", "op": op }),
            None,
            &format!("Quest {op}: not found."),
        ),
    }
}

fn not_found(id: &str, op: &str) -> Value {
    app_result(
        json!({ "status": "not_found", "op": op, "id": id }),
        None,
        &format!("Quest {op}: '{id}' not found."),
    )
}

/// Create or refresh the scheduled detection job backing a quest, enabled only
/// while it is open. Mirrors `server::quests_api::sync_backing_job` (which is a
/// private handler helper) so a widget-created/updated quest rides the same tick
/// loop. The preference-driven interval is not threaded here; the default `2m`
/// matches the HTTP handler's fallback.
fn sync_backing_job(quest: &Quest) {
    use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

    let now = chrono::Utc::now().to_rfc3339();
    let id = format!("quest-{}", quest.id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: format!("quest: {}", quest.title),
        schedule: Schedule::Every {
            interval: "2m".to_owned(),
        },
        target: JobTarget::Quest {
            quest_id: quest.id.clone(),
        },
        enabled: quest.status == QuestStatus::Open,
        require_approval: false,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    if let Err(e) = job_store::save_job(&job) {
        tracing::warn!(quest_id = %quest.id, "quest-board: failed to sync backing job: {e}");
    }
}
