//! Frozen residue: the `JobTarget::Quest` tick, its backing-job reconcile and the
//! Core-side Shadow evidence for a quest judge. Delete in Stage B, when Quests moves
//! onto the generic app-job contract ([`super::app_jobs`]) and gathers its own
//! evidence under a reviewed grant (`docs/app-boundary-extraction-plan.md`, step 6).
//!
//! | Capability | Body → reply | Used by |
//! |---|---|---|
//! | `quests.list` | `{}` → `{ quests, interval }` | quest job reconcile, judge evidence lookup |
//! | `quests.judge` | `{ id, context? }` → verdict | `JobTarget::Quest` tick |
//!
//! Quests stubs its own `sync_backing_job`, so Core owns the backing jobs by
//! reconciling them from the quest list on the shared background loop
//! ([`super::app_jobs::spawn`]): every quest gets a job (enabled while open), and
//! jobs whose quest is gone are swept. The sweep only runs on an AUTHORITATIVE list
//! (the provider answered 2xx with the list): an unbound, unreachable or failing
//! provider is "unknown", never "everything was deleted".
//!
//! Failure posture: when the Quests app is disabled or not installed (an unbound
//! capability), a tick is a quiet no-op and the reconcile is skipped, so a disabled
//! app never turns its jobs into a stream of failures. An enabled-but-failing
//! provider still surfaces as the job's error.
//!
//! Quest judging gathers Shadow evidence Core-side (the sidecar cannot reach
//! Core's `McpRegistry`) and posts it in the judge body.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{json, Value};

use super::app_jobs::{
    call_ok, tick_result, CallFailure, ReconcileOutcome, APP_JOB_LIST_TIMEOUT, APP_JOB_RUN_TIMEOUT,
};
use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};
use crate::sidecar::capability_consumer::CapabilityConsumer;

/// The quest list plus the detection interval quest jobs tick on.
pub(crate) const CAP_QUESTS_LIST: &str = "quests.list";
/// Run one detection pass for a quest. Also the scheduler's concurrency-budget key
/// for quest jobs.
pub(crate) const CAP_QUESTS_JUDGE: &str = "quests.judge";

/// Detection interval when the provider reports none (the Quests app's default).
const DEFAULT_QUEST_INTERVAL: &str = "2m";
/// Recent-activity window Core requests from Shadow for a judge.
const CONTEXT_MINUTES: u64 = 15;
/// Evidence budget posted to the judge.
const MAX_EVIDENCE_CHARS: usize = 4000;

/// One quest hop, bounded like the app-job hops: the reconcile loop is shared with
/// every app's jobs, so a hung Quests sidecar must time out rather than stall it
/// (or a scheduler slot). An expiry is an ordinary failure, never "unbound", so the
/// reconcile treats the list as unknown and sweeps nothing.
async fn call_within(
    consumer: Option<&CapabilityConsumer>,
    cap: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, CallFailure> {
    tokio::time::timeout(timeout, call_ok(consumer, cap, body))
        .await
        .unwrap_or_else(|_| {
            Err(CallFailure::failed(format!(
                "{cap} timed out after {}s",
                timeout.as_secs()
            )))
        })
}

// ── Tick ──────────────────────────────────────────────────────────────────────────

/// The `JobTarget::Quest` tick: gather Shadow evidence, then run one detection pass
/// through `quests.judge`. The quest list is read first (for the completion
/// condition that scopes the semantic search), so a disabled Quests app is skipped
/// before any Shadow call is made.
pub(crate) async fn judge_quest(
    consumer: Option<&CapabilityConsumer>,
    quest_id: &str,
) -> Result<(), String> {
    let condition = match list_quests(consumer).await {
        Ok(list) => list
            .quests
            .iter()
            .find(|q| q.get("id").and_then(Value::as_str) == Some(quest_id))
            .and_then(|q| q.get("completion_condition").and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned(),
        Err(failure) if failure.unbound => {
            return tick_result(CAP_QUESTS_JUDGE, Err(failure));
        }
        // The judge can still run on recent activity alone.
        Err(_) => String::new(),
    };
    let body = match gather_context(&condition).await {
        Some(context) => json!({ "id": quest_id, "context": context }),
        None => json!({ "id": quest_id }),
    };
    let result = call_within(consumer, CAP_QUESTS_JUDGE, &body, APP_JOB_RUN_TIMEOUT).await;
    tick_result(CAP_QUESTS_JUDGE, result)
}

/// Gather Shadow detection evidence for a quest: a recent-activity summary plus a
/// semantic search keyed on its completion condition, through Core's shared MCP
/// registry. `None` when Shadow yields nothing (a judge with no evidence is a safe
/// no-op on the app side).
async fn gather_context(condition: &str) -> Option<String> {
    let registry = crate::sidecar::mcp::global_registry()?;

    let mut parts: Vec<String> = Vec::new();
    if let Ok(recent) = registry
        .call_tool(
            "shadow.recent_context",
            // `q` is Shadow's minute-window query param (the declarative
            // `shadow.recent_context` http tool forwards args verbatim as query
            // params through the `/api/shadow/*` proxy).
            json!({ "q": CONTEXT_MINUTES }),
            None,
        )
        .await
    {
        if let Some(text) = usable_text(&recent) {
            parts.push(format!("Recent activity:\n{text}"));
        }
    }
    if !condition.is_empty() {
        if let Ok(semantic) = registry
            .call_tool(
                "shadow.semantic_search",
                // `q` is Shadow's search query param (see above).
                json!({ "q": condition, "limit": 5 }),
                None,
            )
            .await
        {
            if let Some(text) = usable_text(&semantic) {
                parts.push(format!("Related history:\n{text}"));
            }
        }
    }

    if parts.is_empty() {
        return None;
    }
    let mut combined = parts.join("\n\n");
    if combined.len() > MAX_EVIDENCE_CHARS {
        let mut cut = MAX_EVIDENCE_CHARS;
        while !combined.is_char_boundary(cut) {
            cut -= 1;
        }
        combined.truncate(cut);
    }
    Some(combined)
}

/// Extract usable evidence text from a Shadow MCP result.
fn usable_text(result: &Value) -> Option<String> {
    if result.get("available").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let text = result
        .get("summary")
        .or_else(|| result.get("text"))
        .or_else(|| result.get("context"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| result.to_string());
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "{}" || trimmed == "null" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ── Quest list ────────────────────────────────────────────────────────────────────

/// The authoritative quest list `quests.list` returned.
#[derive(Debug, Default)]
pub(crate) struct QuestList {
    pub(crate) quests: Vec<Value>,
    pub(crate) interval: String,
}

/// Read the quest list. A reply without a `quests` array is a failure, not an
/// empty list: only an explicit list may drive the orphan sweep.
pub(crate) async fn list_quests(
    consumer: Option<&CapabilityConsumer>,
) -> Result<QuestList, CallFailure> {
    list_quests_within(consumer, APP_JOB_LIST_TIMEOUT).await
}

async fn list_quests_within(
    consumer: Option<&CapabilityConsumer>,
    timeout: Duration,
) -> Result<QuestList, CallFailure> {
    let body = call_within(consumer, CAP_QUESTS_LIST, &json!({}), timeout).await?;
    let quests = body
        .get("quests")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| CallFailure::failed("quests.list reply has no `quests` array"))?;
    let interval = body
        .get("interval")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_QUEST_INTERVAL)
        .to_owned();
    Ok(QuestList { quests, interval })
}

// ── Backing-job reconcile ─────────────────────────────────────────────────────────

/// The persisted job id: byte-identical to the ids the old in-process host wrote,
/// so a node keeps ticking its existing jobs.
fn quest_job_id(quest_id: &str) -> String {
    format!("quest-{quest_id}")
}

fn quest_job_name(title: &str) -> String {
    format!("quest: {title}")
}

fn quest_target(quest_id: &str) -> JobTarget {
    JobTarget::Quest {
        quest_id: quest_id.to_owned(),
    }
}

/// One backing job the reconcile wants to exist.
#[derive(Debug, Clone, PartialEq)]
struct BackingJob {
    item_id: String,
    title: String,
    schedule: Schedule,
    enabled: bool,
}

/// Quest backing jobs: every quest with an id, on the shared detection interval,
/// enabled while the quest is open.
fn quest_backing_jobs(list: &QuestList) -> Vec<BackingJob> {
    list.quests
        .iter()
        .filter_map(|quest| {
            let id = quest.get("id").and_then(Value::as_str)?;
            Some(BackingJob {
                item_id: id.to_owned(),
                title: quest
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                schedule: Schedule::Every {
                    interval: list.interval.clone(),
                },
                enabled: quest.get("status").and_then(Value::as_str) == Some("open"),
            })
        })
        .collect()
}

/// The quest jobs whose quest is absent from an AUTHORITATIVE list. Pure, so the
/// sweep decision is unit-testable without the job store.
fn jobs_to_sweep(live: &[BackingJob], jobs: &[ScheduledJob]) -> Vec<String> {
    let live: HashSet<&str> = live.iter().map(|job| job.item_id.as_str()).collect();
    jobs.iter()
        .filter(|job| match &job.target {
            JobTarget::Quest { quest_id } => !live.contains(quest_id.as_str()),
            _ => false,
        })
        .map(|job| job.id.clone())
        .collect()
}

/// Create or update one backing job, keeping its history and creation time.
fn sync_backing_job(wanted: &BackingJob) {
    let now = chrono::Utc::now().to_rfc3339();
    let id = quest_job_id(&wanted.item_id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: quest_job_name(&wanted.title),
        schedule: wanted.schedule.clone(),
        target: quest_target(&wanted.item_id),
        enabled: wanted.enabled,
        require_approval: false,
        // Core-owned (reconciled by Core itself), not an App-created job.
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    let _ = job_store::recreate_authoritative_job(&job);
}

/// Reconcile the `JobTarget::Quest` backing jobs from `quests.list`: sync every
/// wanted job, then sweep orphans. An `Err` list is "unknown" and touches nothing.
pub(crate) async fn reconcile_quest_jobs(
    consumer: Option<&CapabilityConsumer>,
) -> ReconcileOutcome {
    reconcile_quest_jobs_within(consumer, APP_JOB_LIST_TIMEOUT).await
}

async fn reconcile_quest_jobs_within(
    consumer: Option<&CapabilityConsumer>,
    list_timeout: Duration,
) -> ReconcileOutcome {
    let wanted = match list_quests_within(consumer, list_timeout).await {
        Ok(list) => quest_backing_jobs(&list),
        Err(failure) => {
            tracing::debug!(
                "quest job reconcile skipped (list not authoritative): {}",
                failure.message
            );
            return ReconcileOutcome::Skipped;
        }
    };
    for job in &wanted {
        sync_backing_job(job);
    }
    let sweep = jobs_to_sweep(&wanted, &job_store::list_jobs());
    for job_id in &sweep {
        let _ = job_store::delete_job(job_id);
    }
    ReconcileOutcome::Reconciled {
        written: wanted.len(),
        swept: sweep.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::store::ExecOutcome;
    use crate::sidecar::capability_consumer::test_support::{
        consumer_with, consumer_without_providers, fixture_manifest, registered, serve,
    };
    use axum::routing::post;
    use axum::{Json, Router};

    fn job(id: &str, target: JobTarget) -> ScheduledJob {
        ScheduledJob {
            id: id.to_string(),
            name: id.to_string(),
            schedule: Schedule::Every {
                interval: "2m".into(),
            },
            target,
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_run_at: None,
            last_outcome: None::<ExecOutcome>,
            history: Vec::new(),
        }
    }

    fn quest_job(quest_id: &str) -> ScheduledJob {
        job(&quest_job_id(quest_id), quest_target(quest_id))
    }

    #[test]
    fn an_authoritative_empty_list_sweeps_only_quest_jobs() {
        let app = job(
            "app-x",
            JobTarget::AppJob {
                plugin_id: "@example/a".into(),
                job_id: "a1".into(),
                payload: None,
            },
        );
        let jobs = vec![quest_job("q1"), app];
        assert_eq!(jobs_to_sweep(&[], &jobs), vec![quest_job_id("q1")]);
    }

    #[test]
    fn a_partial_list_sweeps_only_the_missing_items() {
        let jobs = vec![quest_job("q1"), quest_job("q2")];
        let live = quest_backing_jobs(&QuestList {
            quests: vec![json!({ "id": "q1", "title": "one", "status": "open" })],
            interval: "2m".into(),
        });
        assert_eq!(jobs_to_sweep(&live, &jobs), vec![quest_job_id("q2")]);
    }

    #[test]
    fn job_ids_and_names_stay_byte_identical() {
        assert_eq!(quest_job_id("abc"), "quest-abc");
        assert_eq!(quest_job_name("Ship"), "quest: Ship");
    }

    #[test]
    fn backing_jobs_follow_quest_state_and_interval() {
        let quests = quest_backing_jobs(&QuestList {
            quests: vec![
                json!({ "id": "q1", "title": "open one", "status": "open" }),
                json!({ "id": "q2", "title": "done", "status": "completed" }),
                json!({ "title": "no id" }),
            ],
            interval: "10m".into(),
        });
        assert_eq!(quests.len(), 2);
        assert!(quests[0].enabled && !quests[1].enabled);
        assert_eq!(
            quests[0].schedule,
            Schedule::Every {
                interval: "10m".into()
            }
        );
    }

    /// With the Quests app disabled, not installed, or no consumer installed at
    /// all, a tick is a quiet success and the reconcile touches nothing.
    #[tokio::test]
    async fn ticks_and_reconciles_fail_open_when_the_app_is_disabled_or_missing() {
        let disabled = consumer_with(
            fixture_manifest(
                1,
                &[
                    (CAP_QUESTS_LIST, Some("/quests/list")),
                    (CAP_QUESTS_JUDGE, Some("/quests/judge")),
                ],
            ),
            false,
        )
        .await;
        let missing = consumer_without_providers();
        for consumer in [Some(&disabled), Some(&missing), None] {
            assert_eq!(judge_quest(consumer, "q1").await, Ok(()));
            assert_eq!(
                reconcile_quest_jobs(consumer).await,
                ReconcileOutcome::Skipped
            );
        }
    }

    /// The tick and list calls reach the provider's declared routes with the bodies
    /// the contract names.
    #[tokio::test]
    async fn ticks_and_lists_speak_the_capability_contract() {
        let (consumer, _sidecar, port) = registered(&[
            (CAP_QUESTS_LIST, Some("/quests/list")),
            (CAP_QUESTS_JUDGE, Some("/quests/judge")),
        ])
        .await;
        let app = Router::new()
            .route(
                "/api/fixture/quests/list",
                post(|| async {
                    Json(json!({
                        "quests": [{ "id": "q1", "title": "Ship", "status": "open",
                                     "completion_condition": "shipped" }],
                        "interval": "7m",
                    }))
                }),
            )
            .route(
                "/api/fixture/quests/judge",
                post(|Json(body): Json<Value>| async move {
                    if body["id"] == "q1" {
                        (axum::http::StatusCode::OK, Json(json!({ "met": false })))
                    } else {
                        (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(json!({ "error": "quest\nnot found" })),
                        )
                    }
                }),
            );
        let server = serve(port, app).await;

        let list = list_quests(Some(&consumer)).await.unwrap();
        assert_eq!(list.interval, "7m");
        assert_eq!(list.quests.len(), 1);
        assert_eq!(judge_quest(Some(&consumer), "q1").await, Ok(()));
        // A provider-side refusal surfaces its own (cleaned) error text.
        assert_eq!(
            judge_quest(Some(&consumer), "gone").await,
            Err("quest not found".to_owned())
        );
        server.abort();
    }

    /// A 2xx reply without the list is "unknown", never "empty": it must not be
    /// allowed to drive the orphan sweep.
    #[tokio::test]
    async fn a_list_reply_without_its_array_is_not_authoritative() {
        let (consumer, _sidecar, port) =
            registered(&[(CAP_QUESTS_LIST, Some("/quests/list"))]).await;
        let app = Router::new().route(
            "/api/fixture/quests/list",
            post(|| async { Json(json!({ "error": "store locked" })) }),
        );
        let server = serve(port, app).await;
        assert_eq!(
            reconcile_quest_jobs(Some(&consumer)).await,
            ReconcileOutcome::Skipped
        );
        server.abort();
    }

    /// A Quests sidecar that accepts the call but never answers times out: the
    /// list is unknown, nothing is swept, and the shared reconcile loop moves on.
    #[tokio::test]
    async fn a_hung_quest_list_times_out_and_touches_nothing() {
        let (consumer, _sidecar, port) =
            registered(&[(CAP_QUESTS_LIST, Some("/quests/list"))]).await;
        let app = Router::new().route(
            "/api/fixture/quests/list",
            post(|| async {
                std::future::pending::<()>().await;
                Json(json!({}))
            }),
        );
        let server = serve(port, app).await;
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            reconcile_quest_jobs_within(Some(&consumer), Duration::from_millis(200)),
        )
        .await
        .expect("the quest reconcile returns despite a hung provider");
        assert_eq!(outcome, ReconcileOutcome::Skipped);
        let failure = list_quests_within(Some(&consumer), Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(!failure.unbound);
        assert!(failure.message.contains("timed out"), "{}", failure.message);
        server.abort();
    }

    #[test]
    fn usable_text_drops_unavailable_and_empty_results() {
        assert_eq!(
            usable_text(&json!({ "available": false, "text": "x" })),
            None
        );
        assert_eq!(usable_text(&json!({ "summary": "  " })), None);
        assert_eq!(
            usable_text(&json!({ "summary": " did a thing " })),
            Some("did a thing".to_owned())
        );
    }
}
