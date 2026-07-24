//! Core-side typed HTTP client for the out-of-process `ryu-quests` sidecar.
//!
//! Quests (the auto-detecting todo list) used to run in-process: a
//! `ryu_quests::QuestEngine` field on `ServerState`, an `/api/quests/*` route
//! merge, a scheduler `JobTarget::Quest` arm that called `global_engine()`
//! directly, and an activity subscribe-loop over the in-process broadcast. Quests
//! is now an out-of-process app
//! (`com.ryu.quests`): the `ryu-quests` sidecar owns `quests.db`, the engine, and
//! the `/api/quests/*` surface — served through the generic ext-proxy
//! `public_mount`. Core links NO quest code; its three remaining reverse-couplings
//! reach the sidecar over loopback via this client:
//!
//! - **scheduler judge** — the `JobTarget::Quest` tick posts `POST /api/quests/:id/judge`.
//!   Because the sidecar's `shadow_call` cannot reach Core's `McpRegistry`, Core
//!   gathers Shadow evidence its own side and posts it in the judge body (the crate's
//!   `judge_quest_with_context` uses it verbatim).
//! - **scheduler-job lifecycle** — the sidecar stubs its `sync_backing_job`, so Core
//!   owns `JobTarget::Quest` jobs by reconciling them from the quest list on a
//!   background loop ([`spawn`]): every open quest gets an enabled job, closed/gone
//!   quests get theirs disabled/removed.
//! - **activity feed** — Core subscribes to the sidecar's `/api/quests/events` SSE and
//!   maps `completed`/`suggested` events into the activity store (the old in-process
//!   subscribe-loop, now dep-free JSON).
//!
//! Security mirrors the ext-proxy hop exactly: loopback target on the sidecar's
//! declared port ([`crate::profile::port`]-shifted for dev profiles), with the
//! per-plugin minted bearer ([`crate::sidecar::ext_proxy::ext_token`]) the sidecar
//! was spawned with — nothing hardcoded.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use ryu_activity::{ActivityItem, ActivityLevel, ActivityStore};

use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};
use crate::sidecar::ext_proxy::{ext_token, node_token};

/// The built-in Quests app id (matches the `quests.plugin.json` fixture id and
/// `plugins::builtins`).
const QUESTS_PLUGIN_ID: &str = "com.ryu.quests";
/// Fallback loopback port if the manifest is somehow absent — matches the
/// `quests.plugin.json` fixture `port`. Core injects this as `RYU_QUESTS_PORT` at
/// spawn.
const QUESTS_FALLBACK_PORT: u16 = 7991;

/// Default detection interval when the sidecar reports none — mirrors the crate's
/// `ryu_quests::DEFAULT_INTERVAL`.
const DEFAULT_INTERVAL: &str = "2m";
/// Recent-activity window Core requests from Shadow — mirrors the crate's
/// `CONTEXT_MINUTES`.
const CONTEXT_MINUTES: u64 = 15;
/// Evidence budget posted to the judge — mirrors the crate's `MAX_EVIDENCE_CHARS`.
const MAX_EVIDENCE_CHARS: usize = 4000;
/// How often Core reconciles `JobTarget::Quest` jobs from the sidecar's quest list.
const RECONCILE_EVERY: Duration = Duration::from_secs(30);

/// The scheduler job id backing a quest (kept byte-identical to the old in-process
/// `quests_host::job_id_for`, so a decoupled node keeps ticking pre-existing jobs).
fn job_id_for(quest_id: &str) -> String {
    format!("quest-{quest_id}")
}

/// Resolve the `ryu-quests` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]).
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == QUESTS_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-quests"))
        .map(|s| s.port)
        .unwrap_or(QUESTS_FALLBACK_PORT);
    crate::profile::port(raw)
}

/// Process-global quests client, so the scheduler (`JobTarget::Quest`) — which
/// does not carry `ServerState` — can reach the
/// sidecar. Set once from `main.rs`, mirroring the `ryu_*::global_engine` pattern
/// the other decoupled engines used.
static GLOBAL_CLIENT: std::sync::OnceLock<QuestsClient> = std::sync::OnceLock::new();

/// Publish the process-global quests client. Idempotent (first write wins).
pub fn set_global_client(client: QuestsClient) {
    let _ = GLOBAL_CLIENT.set(client);
}

/// The process-global quests client, or `None` before `main.rs` has set it.
pub fn global_client() -> Option<&'static QuestsClient> {
    GLOBAL_CLIENT.get()
}

/// Typed loopback client for the `ryu-quests` sidecar. Cheap to clone (holds only
/// the resolved port); the bearer is minted per call so it always tracks the
/// current node token.
#[derive(Clone)]
pub struct QuestsClient {
    port: u16,
}

impl QuestsClient {
    /// Build a client bound to the sidecar's resolved loopback port.
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/quests", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with — the same value
    /// the ext-proxy stamps on its hop, so a hand-rolled local request without it
    /// is rejected fail-closed.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), QUESTS_PLUGIN_ID)
    }

    /// Run one detection pass for `quest_id`, gathering Shadow evidence Core-side
    /// (the sidecar cannot) and posting it in the judge body. Best-effort: a
    /// transport error is surfaced as `Err` so the scheduler records the outcome.
    pub async fn judge(&self, quest_id: &str) -> Result<Value, String> {
        let context = self.gather_context(quest_id).await;
        let body = match context {
            Some(ctx) => json!({ "context": ctx }),
            None => json!({}),
        };
        let resp = reqwest::Client::new()
            .post(format!("{}/{quest_id}/judge", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("quests sidecar not reachable: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(body
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("quests judge failed: HTTP {status}")))
        }
    }

    /// Fetch the current quest list (`GET /api/quests`), returning the `quests`
    /// array.
    ///
    /// Returns `Err` when the sidecar is **unreachable or errored** (transport
    /// failure or non-2xx status) — a state that must NOT be confused with a
    /// genuinely-empty list, because the reconcile orphan-sweep would otherwise
    /// wipe every live quest job on a transient blip. `Ok(vec![])` means the
    /// sidecar answered and authoritatively holds no quests.
    pub async fn list_quests(&self) -> Result<Vec<Value>, String> {
        let resp = reqwest::Client::new()
            .get(self.base_url())
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("quests sidecar not reachable: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("quests list failed: HTTP {status}"));
        }
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        Ok(body
            .get("quests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// POST a mutation to the sidecar and return the parsed JSON body, mapping a
    /// transport error or non-2xx status to `Err(error_text)`. Backs the quests
    /// create/complete/dismiss/reopen operations.
    pub async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = reqwest::Client::new()
            .post(format!("{}{path}", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("quests sidecar not reachable: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(body
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("quests request failed: HTTP {status}")))
        }
    }

    /// Resolve the detection interval the sidecar reports
    /// (`GET /api/quests/detection-config`), falling back to [`DEFAULT_INTERVAL`].
    async fn detection_interval(&self) -> String {
        let Ok(resp) = reqwest::Client::new()
            .get(format!("{}/detection-config", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
        else {
            return DEFAULT_INTERVAL.to_string();
        };
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        body.get("interval")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_INTERVAL.to_string())
    }

    /// Gather Shadow detection evidence for a quest exactly as the crate's
    /// `gather_context` does — a recent-activity summary plus a semantic search
    /// keyed on the quest's completion condition — but Core-side, through
    /// [`crate::sidecar::mcp::global_registry`] (which the sidecar cannot reach).
    /// Returns `None` when Shadow yields nothing (a judge with no evidence is a
    /// safe no-op).
    async fn gather_context(&self, quest_id: &str) -> Option<String> {
        let registry = crate::sidecar::mcp::global_registry()?;

        // The condition scopes the semantic search; look it up from the list.
        let condition = self
            .list_quests()
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|q| q.get("id").and_then(Value::as_str) == Some(quest_id))
            .and_then(|q| {
                q.get("completion_condition")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();

        let mut parts: Vec<String> = Vec::new();
        if let Ok(recent) = registry
            .call_tool(
                "shadow__recent_context",
                // `q` is Shadow's minute-window query param (the declarative
                // `shadow__recent_context` http tool forwards args verbatim as
                // query params through the `/api/shadow/*` proxy).
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
                    "shadow__semantic_search",
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
            combined.truncate(MAX_EVIDENCE_CHARS);
        }
        Some(combined)
    }
}

/// Extract usable evidence text from a Shadow MCP result — mirrors the crate's
/// private `usable_text` so Core-gathered context matches what the sidecar would
/// have produced.
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

/// Reconcile Core-owned `JobTarget::Quest` scheduler jobs against the sidecar's
/// quest list: every open quest gets an enabled backing job (created on first
/// sight, so this replaces the sidecar's stubbed `sync_backing_job`); closed
/// quests get theirs disabled; jobs whose quest no longer exists are removed.
async fn reconcile_jobs(client: &QuestsClient) {
    let list = client.list_quests().await;
    match &list {
        // Reachable with live quests: (re)sync a backing job for each, then fall
        // through to the orphan sweep below.
        Ok(quests) if !quests.is_empty() => {
            let interval = client.detection_interval().await;
            for quest in quests {
                let Some(id) = quest.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let title = quest.get("title").and_then(Value::as_str).unwrap_or("");
                let open = quest.get("status").and_then(Value::as_str) == Some("open");
                sync_backing_job(id, title, &interval, open);
            }
        }
        // Reachable-but-EMPTY: authoritative "no quests" — nothing to sync, but the
        // sweep below MUST run so the last quest's orphaned job is removed (the
        // stale-job-leak this fixes). Deleting your last quest lands here.
        Ok(_) => {}
        // Unreachable/errored: an empty view here is "unknown", NOT "all deleted".
        // Skip the sweep entirely so a transient fetch failure never wipes live
        // jobs; the next tick reconciles once the sidecar answers again.
        Err(e) => {
            tracing::debug!("quests reconcile: sidecar unreachable ({e}); skipping orphan sweep");
            return;
        }
    }

    // Orphan sweep: remove every quest-backing job whose quest is gone from the
    // (reachable) authoritative list. Never reached on the `Err` arm above.
    for job_id in jobs_to_sweep(&list, &job_store::list_jobs()) {
        let _ = job_store::delete_job(&job_id);
    }
}

/// Decide which `JobTarget::Quest` backing jobs to delete, given the reconcile's
/// view of the world. This is the load-bearing "sweep vs skip" decision, factored
/// out as a pure function so it is unit-testable without the network or the global
/// job store:
///
/// - `list = Err(..)` (sidecar unreachable/errored) → sweep **nothing**; an empty
///   view is "unknown", and deleting jobs on a transient blip is the leak's
///   inverse failure.
/// - `list = Ok(quests)` (sidecar answered) → the list is authoritative, so sweep
///   every quest job whose quest is absent — **including when `quests` is empty**
///   (deleting the last quest must remove its orphaned job).
fn jobs_to_sweep(list: &Result<Vec<Value>, String>, jobs: &[ScheduledJob]) -> Vec<String> {
    let Ok(quests) = list else {
        return Vec::new();
    };
    let seen: std::collections::HashSet<String> = quests
        .iter()
        .filter_map(|q| q.get("id").and_then(Value::as_str))
        .map(job_id_for)
        .collect();
    jobs.iter()
        .filter_map(|job| match &job.target {
            JobTarget::Quest { quest_id } if !seen.contains(&job_id_for(quest_id)) => {
                Some(job.id.clone())
            }
            _ => None,
        })
        .collect()
}

/// Create or update the `JobTarget::Quest` backing job for a quest — lifted
/// verbatim from the old in-process `quests_host::CoreQuestsHost::sync_backing_job`
/// so a decoupled node produces byte-identical scheduler jobs.
fn sync_backing_job(quest_id: &str, title: &str, interval: &str, open: bool) {
    let now = chrono::Utc::now().to_rfc3339();
    let id = job_id_for(quest_id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: format!("quest: {title}"),
        schedule: Schedule::Every {
            interval: interval.to_string(),
        },
        target: JobTarget::Quest {
            quest_id: quest_id.to_string(),
        },
        enabled: open,
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
    let _ = job_store::save_job(&job);
}

/// Map a quest SSE event (JSON, `#[serde(tag = "type")]`) into an activity item —
/// the dep-free rewrite of the old `activity::ingest::from_quest_event`. Only
/// `completed`/`suggested` carry feed value (the crate never emits `updated` /
/// `deleted` over the stream).
fn activity_from_quest_json(event: &Value) -> Option<ActivityItem> {
    let quest = event.get("quest");
    let title = quest
        .and_then(|q| q.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let id = quest
        .and_then(|q| q.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let detail = quest
        .and_then(|q| q.get("detail"))
        .and_then(Value::as_str)
        .map(str::to_string);
    match event.get("type").and_then(Value::as_str) {
        Some("completed") => {
            let auto = event.get("auto").and_then(Value::as_bool).unwrap_or(false);
            Some(
                ActivityItem::new("quest", "quests", format!("Quest completed: {title}"))
                    .with_body(detail)
                    .with_level(ActivityLevel::Success)
                    .with_metadata(json!({ "quest_id": id, "auto": auto })),
            )
        }
        Some("suggested") => {
            let reason = event
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let confidence = event.get("confidence").and_then(Value::as_u64).unwrap_or(0);
            Some(
                ActivityItem::new("quest", "quests", format!("Quest may be done: {title}"))
                    .with_body(Some(reason))
                    .with_level(ActivityLevel::Info)
                    .with_metadata(json!({ "quest_id": id, "confidence": confidence })),
            )
        }
        _ => None,
    }
}

/// Spawn the two long-lived Core-side reverse-coupling tasks for quests:
/// (1) the `JobTarget::Quest` reconcile loop (job lifecycle), and (2) the
/// `/api/quests/events` SSE → activity-feed loop. Both are best-effort and
/// self-healing across a sidecar restart.
pub fn spawn(client: QuestsClient, activity: ActivityStore) {
    // (1) Scheduler-job reconcile loop.
    {
        let client = client.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(RECONCILE_EVERY);
            loop {
                tick.tick().await;
                reconcile_jobs(&client).await;
            }
        });
    }

    // (2) Quest events SSE → activity feed.
    tokio::spawn(async move {
        loop {
            if let Err(e) = stream_activity(&client, &activity).await {
                tracing::debug!("quests activity stream ended ({e}); retrying");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

/// One connection of the quest-events SSE stream, folding `data:` frames into the
/// activity store until the stream closes or errors (then [`spawn`] reconnects).
async fn stream_activity(client: &QuestsClient, activity: &ActivityStore) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get(format!("{}/events", client.base_url()))
        .bearer_auth(client.bearer())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line; each `data:` line carries one
        // JSON event.
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            if let Some(item) = activity_from_quest_json(&event) {
                if let Err(e) = activity.record(item).await {
                    tracing::warn!("activity: failed to record quest event: {e:#}");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::store::{ExecOutcome, Schedule};

    /// Build a scheduled job with the given id + target; other fields are inert
    /// filler (the sweep decision reads only `target` and `id`).
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
            created_at: "t".into(),
            updated_at: "t".into(),
            last_run_at: None,
            last_outcome: None::<ExecOutcome>,
            history: Vec::new(),
        }
    }

    fn quest_job(quest_id: &str) -> ScheduledJob {
        job(
            &job_id_for(quest_id),
            JobTarget::Quest {
                quest_id: quest_id.to_string(),
            },
        )
    }

    fn quest_value(id: &str) -> Value {
        json!({ "id": id, "title": id, "status": "open" })
    }

    #[test]
    fn reachable_empty_sweeps_all_orphaned_quest_jobs() {
        // Deleting the user's LAST quest → reachable-but-empty list. The orphaned
        // `quest-*` job MUST be swept (the stale-job-leak this fixes), while a
        // non-quest job (e.g. a monitor) is left untouched.
        let jobs = vec![
            quest_job("q1"),
            job(
                "monitor-m1",
                JobTarget::Monitor {
                    monitor_id: "m1".into(),
                },
            ),
        ];
        let list: Result<Vec<Value>, String> = Ok(vec![]);
        let swept = jobs_to_sweep(&list, &jobs);
        assert_eq!(swept, vec![job_id_for("q1")]);
    }

    #[test]
    fn unreachable_skips_the_sweep_entirely() {
        // Same orphaned-looking job, but the sidecar was unreachable → the empty
        // view is "unknown", so NOTHING is swept (no live job is wiped on a blip).
        let jobs = vec![quest_job("q1")];
        let list: Result<Vec<Value>, String> = Err("quests sidecar not reachable".into());
        assert!(jobs_to_sweep(&list, &jobs).is_empty());
    }

    #[test]
    fn reachable_nonempty_sweeps_only_the_missing_quests() {
        // q1 still exists; q2 is gone → only q2's backing job is swept.
        let jobs = vec![quest_job("q1"), quest_job("q2")];
        let list: Result<Vec<Value>, String> = Ok(vec![quest_value("q1")]);
        let swept = jobs_to_sweep(&list, &jobs);
        assert_eq!(swept, vec![job_id_for("q2")]);
    }
}
