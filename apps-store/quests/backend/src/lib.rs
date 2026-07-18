//! Quests: an auto-detecting todo list.
//!
//! A **quest** is a task with a natural-language *completion condition*. On a
//! schedule, the [`QuestEngine`] gathers what the user has recently been doing
//! from Shadow's always-on context (screen text / activity / semantic history)
//! and asks a judge model whether the task looks done. Depending on the user's
//! configured **detection mode** it either *suggests* completion (a chip the user
//! confirms) or *auto-completes* the quest outright.
//!
//! This crate is the extracted **Quests** capability. It owns the store, the
//! engine, the event types, and the `/api/quests/*` HTTP surface. Everything the
//! moved code needs from the host (preferences, Shadow context via MCP, the
//! Gateway judge call, and the scheduler backing job) is inverted through the
//! [`QuestsHost`] trait so this crate has ZERO dependency on `apps/core`.
//!
//! Placement (Core vs Gateway): a quest decides *what runs and when* (the
//! detection loop), so it is Core. The judge model call routes through the
//! Gateway like every other model call — nothing about the model is hardcoded
//! (pref `quest-judge-model` → env → the host's bundled local default).

pub mod api;
pub mod store;

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub use api::{routes, QuestsCtx};
pub use store::QuestStore;

/// Preference key: how aggressive auto-detection is (`off`/`suggest`/`auto_high`/`auto_all`).
pub const DETECTION_MODE_PREF: &str = "quest-detection-mode";
/// Preference key: the judge model id (swappable, never hardcoded to a provider).
pub const JUDGE_MODEL_PREF: &str = "quest-judge-model";
/// Preference key: the judge reasoning effort.
pub const JUDGE_EFFORT_PREF: &str = "quest-judge-effort";
/// Preference key: the detection interval (how often each quest is judged).
pub const DETECTION_INTERVAL_PREF: &str = "quest-detection-interval";
/// Default detection interval when nothing is configured.
pub const DEFAULT_INTERVAL: &str = "2m";

/// Below this confidence a "done" verdict is ignored entirely (treated as noise).
const CONFIDENCE_FLOOR: u8 = 50;
/// At/above this confidence, `auto_high` mode auto-completes instead of suggesting.
const HIGH_CONFIDENCE: u8 = 85;
/// How many minutes of recent activity the judge sees.
const CONTEXT_MINUTES: u64 = 15;
/// After a user dismisses a suggestion, skip judging this quest for this long so
/// it does not immediately re-suggest the same (rejected) completion.
const DISMISS_SNOOZE_SECS: i64 = 3600;
/// Max characters of gathered evidence handed to the judge (and stored).
const MAX_EVIDENCE_CHARS: usize = 4000;

/// The host contract: the narrow set of Core capabilities the moved quest code
/// depends on, inverted so this crate never imports `apps/core`. Core implements
/// this with its existing machinery (preferences store, MCP registry, Gateway
/// loopback, scheduler) and injects `Arc<dyn QuestsHost>` into the [`QuestEngine`].
#[async_trait]
pub trait QuestsHost: Send + Sync {
    /// Read a preference value (`None` when unset or on error).
    async fn pref_get(&self, key: &str) -> Option<String>;
    /// Write a preference value.
    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String>;
    /// Call a Shadow MCP tool for detection context (`None` when unavailable).
    async fn shadow_call(&self, tool: &str, args: serde_json::Value)
        -> Option<serde_json::Value>;
    /// The local Gateway base URL for the one-shot judge completion.
    fn gateway_url(&self) -> String;
    /// The Gateway bearer token, if one is configured.
    fn gateway_token(&self) -> Option<String>;
    /// The fallback judge model when no pref/env is set (the bundled local default).
    fn default_judge_model(&self) -> String;
    /// Create or refresh the scheduled detection job backing a quest, enabled only
    /// while it is open. This is the (inverted) scheduler coupling — Core owns the
    /// `JobTarget::Quest` variant and writes the job; the engine only asks for it.
    fn sync_backing_job(
        &self,
        quest_id: &str,
        title: &str,
        interval: &str,
        open: bool,
    ) -> Result<(), String>;
    /// Remove the scheduled detection job backing a quest.
    fn delete_backing_job(&self, quest_id: &str);
}

/// Process-global quest engine, set once at startup from the host. The state-free
/// scheduler reads it when a `JobTarget::Quest` job fires, and the in-process
/// quest-board MCP widget reads it to drive live mutations.
static ENGINE: std::sync::OnceLock<QuestEngine> = std::sync::OnceLock::new();

/// Publish the global engine. Idempotent: a second call is ignored.
pub fn set_global_engine(engine: QuestEngine) {
    let _ = ENGINE.set(engine);
}

/// The global engine, if it has been published.
pub fn global_engine() -> Option<&'static QuestEngine> {
    ENGINE.get()
}

/// How aggressively the engine acts on a "done" verdict.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DetectionMode {
    /// No auto-detection at all; quests are a plain manual todo list.
    Off,
    /// Suggest completion (a chip the user confirms); never auto-complete.
    Suggest,
    /// Auto-complete only on a high-confidence verdict; otherwise suggest. This
    /// is the default: a fresh install auto-completes tasks it is confident about
    /// and falls back to a suggestion chip when it is less sure.
    #[default]
    AutoHigh,
    /// Auto-complete on any verdict above the confidence floor.
    AutoAll,
}

impl DetectionMode {
    pub fn from_pref(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "off" => Self::Off,
            "auto_high" | "auto-high" => Self::AutoHigh,
            "auto_all" | "auto-all" => Self::AutoAll,
            _ => Self::Suggest,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Suggest => "suggest",
            Self::AutoHigh => "auto_high",
            Self::AutoAll => "auto_all",
        }
    }
}

/// Where a quest's completion came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionSource {
    /// The user marked it done themselves.
    Manual,
    /// The engine detected it from context.
    Detected,
}

/// A quest's lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuestStatus {
    /// Active; the engine judges it on each tick.
    #[default]
    Open,
    /// Completed (manually or detected).
    Done,
    /// Abandoned by the user; never judged again.
    Dismissed,
}

/// A pending "looks done" detection awaiting the user's confirmation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    /// 0-100 confidence from the judge.
    pub confidence: u8,
    /// One-line reason the judge gave.
    pub reason: String,
    /// A short snippet of the evidence the judge saw (for the user to sanity-check).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    pub suggested_at: String,
}

/// A task the user wants to get done.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quest {
    pub id: String,
    pub title: String,
    /// Optional longer description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The natural-language condition the judge evaluates. Empty = use `title`.
    #[serde(default)]
    pub completion_condition: String,
    #[serde(default)]
    pub status: QuestStatus,
    pub created_at: String,
    pub updated_at: String,
    // ---- rollup / detection state ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_source: Option<CompletionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_judged_at: Option<String>,
    /// While set, the engine skips judging until this time (after a dismissal).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    /// The current pending suggestion, if the engine thinks it is done but is
    /// waiting on the user (suggest / auto_high-below-threshold modes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Suggestion>,
}

impl Quest {
    /// The text the judge evaluates: the explicit condition, or the title.
    pub fn condition(&self) -> &str {
        let c = self.completion_condition.trim();
        if c.is_empty() {
            self.title.trim()
        } else {
            c
        }
    }
}

/// A change event fanned out to SSE subscribers (desktop page + island chip).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuestEvent {
    /// The engine thinks a quest is done and wants the user to confirm.
    Suggested {
        quest: Quest,
        confidence: u8,
        reason: String,
    },
    /// A quest was completed (manually or auto). `auto` distinguishes the two.
    Completed { quest: Quest, auto: bool },
    /// A quest was created or edited.
    Updated { quest: Quest },
    /// A quest was deleted.
    Deleted { id: String },
}

/// What one judge run produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub met: bool,
    pub confidence: u8,
    pub reason: String,
}

/// The quest runtime: holds the store, the host (for cross-cutting calls), and an
/// HTTP client (for the gateway judge call). Cheap to clone. Shared by the HTTP
/// API (run-now / manual ops), the scheduler (via a process-global handle), and
/// the in-process quest-board MCP widget.
#[derive(Clone)]
pub struct QuestEngine {
    pub store: QuestStore,
    host: Arc<dyn QuestsHost>,
    http: reqwest::Client,
}

impl QuestEngine {
    pub fn new(store: QuestStore, host: Arc<dyn QuestsHost>, http: reqwest::Client) -> Self {
        Self { store, host, http }
    }

    /// Read a preference through the host (used by the config endpoints).
    pub async fn pref_get(&self, key: &str) -> Option<String> {
        self.host.pref_get(key).await
    }

    /// Write a preference through the host (used by the config endpoints).
    pub async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.host.pref_set(key, value).await
    }

    /// The active detection mode (pref `quest-detection-mode` → default).
    pub async fn detection_mode(&self) -> DetectionMode {
        match self.host.pref_get(DETECTION_MODE_PREF).await {
            Some(v) => DetectionMode::from_pref(&v),
            None => DetectionMode::default(),
        }
    }

    /// Resolve the detection interval: pref → env `RYU_QUEST_INTERVAL` → default.
    pub async fn resolve_interval(&self) -> String {
        if let Some(v) = self.host.pref_get(DETECTION_INTERVAL_PREF).await {
            let t = v.trim();
            if !t.is_empty() && humantime::parse_duration(t).is_ok() {
                return t.to_string();
            }
        }
        std::env::var("RYU_QUEST_INTERVAL")
            .ok()
            .filter(|v| humantime::parse_duration(v).is_ok())
            .unwrap_or_else(|| DEFAULT_INTERVAL.to_string())
    }

    /// Create a quest and its backing detection job. Trims the title and condition
    /// and drops an empty detail. A backing-job persist failure is surfaced (the
    /// HTTP `create` handler maps it to a 500).
    pub async fn create_quest(
        &self,
        title: String,
        detail: Option<String>,
        completion_condition: String,
    ) -> Result<Quest, String> {
        let now = chrono::Utc::now().to_rfc3339();
        let quest = Quest {
            id: format!("quest_{}", uuid::Uuid::new_v4().simple()),
            title: title.trim().to_string(),
            detail: detail.filter(|d| !d.trim().is_empty()),
            completion_condition: completion_condition.trim().to_string(),
            status: QuestStatus::Open,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
            completion_source: None,
            last_judged_at: None,
            snoozed_until: None,
            suggestion: None,
        };
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        let interval = self.resolve_interval().await;
        self.host
            .sync_backing_job(&quest.id, &quest.title, &interval, true)?;
        Ok(quest)
    }

    /// Edit a quest's title / detail / completion condition, then re-sync its
    /// backing job (best-effort). Returns `None` when the quest does not exist.
    pub async fn update_quest(
        &self,
        id: &str,
        title: String,
        detail: Option<String>,
        completion_condition: String,
    ) -> Result<Option<Quest>, String> {
        let Some(mut quest) = self.store.get_quest(id).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        quest.title = title.trim().to_string();
        quest.detail = detail.filter(|d| !d.trim().is_empty());
        quest.completion_condition = completion_condition.trim().to_string();
        quest.updated_at = chrono::Utc::now().to_rfc3339();
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        let interval = self.resolve_interval().await;
        let _ = self.host.sync_backing_job(
            &quest.id,
            &quest.title,
            &interval,
            quest.status == QuestStatus::Open,
        );
        Ok(Some(quest))
    }

    /// Delete a quest, its detection history, and its backing job. Returns true
    /// when a quest was removed.
    pub async fn delete_quest(&self, id: &str) -> Result<bool, String> {
        self.host.delete_backing_job(id);
        self.store.delete_quest(id).await.map_err(|e| e.to_string())
    }

    /// Run one detection pass for `quest_id`: gather context, judge, and act per
    /// the detection mode. A no-op (returns `Ok(None)`) when the quest is not
    /// open, is snoozed, detection is off, or there is no context to judge.
    /// Returns the verdict when one was produced.
    pub async fn judge_quest(&self, quest_id: &str) -> Result<Option<Verdict>, String> {
        self.judge_quest_with_context(quest_id, None).await
    }

    /// Same as [`judge_quest`] but with detection context supplied by the caller.
    ///
    /// When Core drives quests OUT-OF-PROCESS (the `ryu-quests` sidecar), the
    /// sidecar's [`QuestsHost::shadow_call`] cannot reach Core's `McpRegistry`, so
    /// `gather_context` yields nothing. The scheduler therefore gathers Shadow
    /// evidence Core-side and posts it in the judge body; the sidecar uses that
    /// verbatim instead of calling Shadow itself. A `None`/blank `external_context`
    /// falls back to the in-process [`gather_context`] path (unchanged behaviour for
    /// the in-crate default build and the standalone judge endpoint).
    pub async fn judge_quest_with_context(
        &self,
        quest_id: &str,
        external_context: Option<String>,
    ) -> Result<Option<Verdict>, String> {
        let mut quest = self
            .store
            .get_quest(quest_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("quest '{quest_id}' not found"))?;

        if quest.status != QuestStatus::Open {
            return Ok(None);
        }
        let mode = self.detection_mode().await;
        if mode == DetectionMode::Off {
            return Ok(None);
        }
        if let Some(until) = &quest.snoozed_until {
            if !snooze_elapsed(until) {
                return Ok(None);
            }
        }

        let evidence = match external_context {
            Some(ctx) if !ctx.trim().is_empty() => ctx,
            _ => {
                let Some(evidence) = self.gather_context(&quest).await else {
                    // No context available (Shadow down / nothing captured) — can't judge.
                    return Ok(None);
                };
                evidence
            }
        };

        let model = self.resolve_judge_model().await;
        let effort = self.resolve_judge_effort().await;
        let (system, user) = build_judge_prompt(quest.condition(), &evidence);
        let reply = self.call_judge(&model, &effort, &system, &user).await?;
        let verdict = parse_verdict(&reply);

        let now = chrono::Utc::now().to_rfc3339();
        quest.last_judged_at = Some(now.clone());
        // Clear a stale snooze once it has elapsed and we judged again.
        quest.snoozed_until = None;

        if !verdict.met || verdict.confidence < CONFIDENCE_FLOOR {
            quest.updated_at = now;
            let _ = self.store.upsert_quest(&quest).await;
            return Ok(Some(verdict));
        }

        // A done verdict above the floor. Decide suggest vs auto-complete.
        let auto = match mode {
            DetectionMode::AutoAll => true,
            DetectionMode::AutoHigh => verdict.confidence >= HIGH_CONFIDENCE,
            DetectionMode::Suggest | DetectionMode::Off => false,
        };
        let evidence_snip = Some(snippet(&evidence));

        if auto {
            let _ = self
                .store
                .insert_detection(
                    &quest.id,
                    verdict.confidence,
                    &verdict.reason,
                    evidence_snip.as_deref(),
                    "auto_completed",
                )
                .await;
            quest.status = QuestStatus::Done;
            quest.completed_at = Some(now.clone());
            quest.completion_source = Some(CompletionSource::Detected);
            quest.suggestion = None;
            quest.updated_at = now;
            let _ = self.store.upsert_quest(&quest).await;
            self.store.broadcast(QuestEvent::Completed {
                quest: quest.clone(),
                auto: true,
            });
        } else {
            // Suggest. Skip if we already have an equivalent pending suggestion
            // (no re-spam on every tick).
            let already = quest
                .suggestion
                .as_ref()
                .map(|s| s.confidence == verdict.confidence && s.reason == verdict.reason)
                .unwrap_or(false);
            quest.suggestion = Some(Suggestion {
                confidence: verdict.confidence,
                reason: verdict.reason.clone(),
                evidence: evidence_snip.clone(),
                suggested_at: now.clone(),
            });
            quest.updated_at = now;
            let _ = self.store.upsert_quest(&quest).await;
            if !already {
                let _ = self
                    .store
                    .insert_detection(
                        &quest.id,
                        verdict.confidence,
                        &verdict.reason,
                        evidence_snip.as_deref(),
                        "suggested",
                    )
                    .await;
                self.store.broadcast(QuestEvent::Suggested {
                    quest: quest.clone(),
                    confidence: verdict.confidence,
                    reason: verdict.reason.clone(),
                });
            }
        }

        Ok(Some(verdict))
    }

    /// Manually complete a quest (user clicked done, or confirmed a suggestion).
    /// `detected` marks it as a confirmed auto-detection vs a manual check-off.
    /// Also disables the backing detection job (best-effort).
    pub async fn complete_quest(&self, id: &str, detected: bool) -> Result<Option<Quest>, String> {
        let Some(mut quest) = self.store.get_quest(id).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let now = chrono::Utc::now().to_rfc3339();
        quest.status = QuestStatus::Done;
        quest.completed_at = Some(now.clone());
        quest.completion_source = Some(if detected {
            CompletionSource::Detected
        } else {
            CompletionSource::Manual
        });
        quest.suggestion = None;
        quest.snoozed_until = None;
        quest.updated_at = now;
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        self.sync_job(&quest).await;
        self.store.broadcast(QuestEvent::Completed {
            quest: quest.clone(),
            auto: false,
        });
        Ok(Some(quest))
    }

    /// Dismiss the *pending suggestion* but keep the quest open, snoozing further
    /// judging so the same rejected completion does not immediately reappear.
    pub async fn dismiss_suggestion(&self, id: &str) -> Result<Option<Quest>, String> {
        let Some(mut quest) = self.store.get_quest(id).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let now = chrono::Utc::now();
        quest.suggestion = None;
        quest.snoozed_until =
            Some((now + chrono::Duration::seconds(DISMISS_SNOOZE_SECS)).to_rfc3339());
        quest.updated_at = now.to_rfc3339();
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(quest))
    }

    /// Dismiss the whole quest (abandon it); never judged again. Also disables the
    /// backing detection job (best-effort).
    pub async fn dismiss_quest(&self, id: &str) -> Result<Option<Quest>, String> {
        let Some(mut quest) = self.store.get_quest(id).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        quest.status = QuestStatus::Dismissed;
        quest.suggestion = None;
        quest.updated_at = chrono::Utc::now().to_rfc3339();
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        self.sync_job(&quest).await;
        Ok(Some(quest))
    }

    /// Reopen a done/dismissed quest (e.g. dragged back to the Open column on the
    /// board). Clears completion rollup and re-enables the backing job.
    pub async fn reopen_quest(&self, id: &str) -> Result<Option<Quest>, String> {
        let Some(mut quest) = self.store.get_quest(id).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        quest.status = QuestStatus::Open;
        quest.completed_at = None;
        quest.completion_source = None;
        quest.updated_at = chrono::Utc::now().to_rfc3339();
        self.store
            .upsert_quest(&quest)
            .await
            .map_err(|e| e.to_string())?;
        self.sync_job(&quest).await;
        Ok(Some(quest))
    }

    // ---- internals --------------------------------------------------------

    /// Re-sync the backing detection job for a quest (best-effort), enabled only
    /// while it is open.
    async fn sync_job(&self, quest: &Quest) {
        let interval = self.resolve_interval().await;
        let _ = self.host.sync_backing_job(
            &quest.id,
            &quest.title,
            &interval,
            quest.status == QuestStatus::Open,
        );
    }

    /// Gather recent-activity evidence from Shadow via the host. Returns `None`
    /// when Shadow is unavailable or has nothing to offer (so we don't judge on an
    /// empty context). Combines a recent-activity summary with a semantic search
    /// keyed on the quest title.
    async fn gather_context(&self, quest: &Quest) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();

        let recent = self
            .host
            .shadow_call(
                "shadow__recent_context",
                serde_json::json!({ "minutes": CONTEXT_MINUTES }),
            )
            .await;
        if let Some(text) = recent.as_ref().and_then(usable_text) {
            parts.push(format!("Recent activity:\n{text}"));
        }

        let semantic = self
            .host
            .shadow_call(
                "shadow__semantic_search",
                serde_json::json!({ "query": quest.condition(), "limit": 5 }),
            )
            .await;
        if let Some(text) = semantic.as_ref().and_then(usable_text) {
            parts.push(format!("Related history:\n{text}"));
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

    /// Resolve the judge model: pref `quest-judge-model` → env
    /// `RYU_QUEST_JUDGE_MODEL` → `RYU_DEFAULT_LLM_MODEL` → the host's bundled
    /// local default. Nothing hardcoded to a remote provider.
    async fn resolve_judge_model(&self) -> String {
        if let Some(pref) = self.host.pref_get(JUDGE_MODEL_PREF).await {
            let trimmed = pref.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        for var in ["RYU_QUEST_JUDGE_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    return val;
                }
            }
        }
        self.host.default_judge_model()
    }

    async fn resolve_judge_effort(&self) -> String {
        if let Some(pref) = self.host.pref_get(JUDGE_EFFORT_PREF).await {
            let trimmed = pref.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        std::env::var("RYU_QUEST_JUDGE_EFFORT").unwrap_or_default()
    }

    /// One-shot non-streaming judge call through the local gateway. Mirrors the
    /// goal-judge / double-check `call_side_model` request shape.
    async fn call_judge(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        let base = self.host.gateway_url();
        let base = base.trim_end_matches('/');
        let mut payload = serde_json::json!({
            "model": model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let effort = effort.trim();
        if !effort.is_empty() {
            payload["reasoning_effort"] = serde_json::json!(effort);
        }
        let mut req = self
            .http
            .post(format!("{base}/v1/chat/completions"))
            .timeout(std::time::Duration::from_secs(60))
            .json(&payload);
        if let Some(t) = self.host.gateway_token() {
            req = req.bearer_auth(t);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("gateway unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("gateway returned HTTP {}", resp.status()));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("response was not valid JSON: {e}"))?;
        let text = body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        Ok(text.to_string())
    }
}

/// Group quests into the three backend columns for the quest-board widget. The
/// board is column-agnostic (derives columns from whatever statuses arrive), so
/// this renders and drives without a widget change.
pub fn board_columns(quests: &[Quest]) -> serde_json::Value {
    let mut open = Vec::new();
    let mut done = Vec::new();
    let mut dismissed = Vec::new();
    for q in quests {
        // `source` is a small subtitle on the card; surface how a finished quest
        // was completed (manual vs auto-detected) when known.
        let card = serde_json::json!({
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
    serde_json::json!({
        "columns": [
            { "status": "open", "count": open.len(), "quests": open },
            { "status": "done", "count": done.len(), "quests": done },
            { "status": "dismissed", "count": dismissed.len(), "quests": dismissed },
        ],
    })
}

/// True when a Shadow tool result carries real content (not the `available:false`
/// graceful-degrade envelope and not empty).
fn usable_text(result: &serde_json::Value) -> Option<String> {
    if result.get("available").and_then(serde_json::Value::as_bool) == Some(false) {
        return None;
    }
    // Prefer an explicit text/summary field; else stringify the whole payload.
    let text = result
        .get("summary")
        .or_else(|| result.get("text"))
        .or_else(|| result.get("context"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| result.to_string());
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "{}" || trimmed == "null" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Whether a snooze timestamp (RFC3339) is in the past (judging may resume).
fn snooze_elapsed(until: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(until) {
        Ok(t) => chrono::Utc::now() >= t,
        // Unparseable timestamp: don't get stuck snoozed forever.
        Err(_) => true,
    }
}

/// A short evidence snippet stored alongside a suggestion / detection.
fn snippet(evidence: &str) -> String {
    const MAX: usize = 280;
    let one_line = evidence.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() > MAX {
        format!("{}…", one_line.chars().take(MAX).collect::<String>())
    } else {
        one_line
    }
}

/// Build the (system, user) judge prompt.
fn build_judge_prompt(condition: &str, evidence: &str) -> (String, String) {
    let system = "You are a meticulous completion judge for a personal todo app. \
You are given a TASK the user wants to finish and EVIDENCE of what they have \
recently been doing on their computer (captured screen text, app activity, and \
recent history). Decide whether the task has actually been completed, based ONLY \
on the evidence. Be conservative: if the evidence does not clearly show the task \
is done, answer no. Reply with EXACTLY three lines and nothing else:\n\
MET: yes or no\n\
CONFIDENCE: an integer from 0 to 100 (how certain you are it is done)\n\
REASON: one short sentence citing the evidence."
        .to_string();
    let user = format!("TASK: {condition}\n\nEVIDENCE (recent activity):\n{evidence}");
    (system, user)
}

/// Parse the judge's three-line reply into a [`Verdict`]. Defensive: an
/// unreadable verdict is treated as not-met with zero confidence (fail-safe — we
/// never auto-complete on garbage).
fn parse_verdict(text: &str) -> Verdict {
    let mut met = false;
    let mut met_found = false;
    let mut confidence: u8 = 0;
    let mut reason = String::new();

    for line in text.lines() {
        let lower = line.to_lowercase();
        let lower = lower.trim();
        if let Some(rest) = lower.strip_prefix("met:") {
            let rest = rest.trim();
            if rest.starts_with("yes") || rest.starts_with("true") {
                met = true;
                met_found = true;
            } else if rest.starts_with("no") || rest.starts_with("false") {
                met = false;
                met_found = true;
            }
        } else if let Some(rest) = lower.strip_prefix("confidence:") {
            let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u32>() {
                confidence = n.min(100) as u8;
            }
        } else if let Some(idx) = lower.find("reason:") {
            // Preserve original casing for the reason text.
            reason = line[idx + "reason:".len()..].trim().to_string();
        }
    }

    if !met_found {
        // No clear verdict: fail-safe to not-met.
        return Verdict {
            met: false,
            confidence: 0,
            reason: if reason.is_empty() {
                "No clear verdict from the judge.".to_string()
            } else {
                reason
            },
        };
    }
    if reason.is_empty() {
        reason = if met {
            "Looks done.".to_string()
        } else {
            "Not yet done.".to_string()
        };
    }
    Verdict {
        met,
        confidence,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_mode_roundtrips() {
        assert_eq!(DetectionMode::from_pref("off"), DetectionMode::Off);
        assert_eq!(DetectionMode::from_pref("suggest"), DetectionMode::Suggest);
        assert_eq!(
            DetectionMode::from_pref("auto_high"),
            DetectionMode::AutoHigh
        );
        assert_eq!(DetectionMode::from_pref("auto-all"), DetectionMode::AutoAll);
        assert_eq!(DetectionMode::from_pref("garbage"), DetectionMode::Suggest);
        assert_eq!(DetectionMode::AutoHigh.as_str(), "auto_high");
    }

    #[test]
    fn parses_clear_done_verdict() {
        let v = parse_verdict("MET: yes\nCONFIDENCE: 90\nREASON: The PR was merged.");
        assert!(v.met);
        assert_eq!(v.confidence, 90);
        assert_eq!(v.reason, "The PR was merged.");
    }

    #[test]
    fn parses_not_done_verdict() {
        let v = parse_verdict("MET: no\nCONFIDENCE: 20\nREASON: Still editing the draft.");
        assert!(!v.met);
        assert_eq!(v.confidence, 20);
    }

    #[test]
    fn clamps_confidence_and_handles_messy_lines() {
        let v = parse_verdict("MET: YES — done\nConfidence: 130%\nReason: shipped");
        assert!(v.met);
        assert_eq!(v.confidence, 100);
        assert_eq!(v.reason, "shipped");
    }

    #[test]
    fn garbage_fails_safe_to_not_met() {
        let v = parse_verdict("I think maybe it could be done?");
        assert!(!v.met);
        assert_eq!(v.confidence, 0);
    }

    #[test]
    fn quest_condition_falls_back_to_title() {
        let q = Quest {
            id: "q1".into(),
            title: "Deploy staging".into(),
            detail: None,
            completion_condition: "  ".into(),
            status: QuestStatus::Open,
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            completion_source: None,
            last_judged_at: None,
            snoozed_until: None,
            suggestion: None,
        };
        assert_eq!(q.condition(), "Deploy staging");
    }

    #[test]
    fn unavailable_shadow_result_is_not_usable() {
        let v = serde_json::json!({ "available": false, "reason": "down" });
        assert!(usable_text(&v).is_none());
        let v2 = serde_json::json!({ "summary": "user merged a PR" });
        assert_eq!(usable_text(&v2).as_deref(), Some("user merged a PR"));
    }

    #[test]
    fn snooze_elapsed_handles_past_future_and_garbage() {
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(snooze_elapsed(&past));
        assert!(!snooze_elapsed(&future));
        assert!(snooze_elapsed("not-a-timestamp"));
    }

    #[test]
    fn board_columns_groups_by_status() {
        let mk = |id: &str, status: QuestStatus| Quest {
            id: id.into(),
            title: id.into(),
            detail: None,
            completion_condition: String::new(),
            status,
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            completion_source: None,
            last_judged_at: None,
            snoozed_until: None,
            suggestion: None,
        };
        let quests = vec![
            mk("a", QuestStatus::Open),
            mk("b", QuestStatus::Done),
            mk("c", QuestStatus::Open),
        ];
        let board = board_columns(&quests);
        let columns = board.get("columns").and_then(|c| c.as_array()).unwrap();
        assert_eq!(columns[0].get("count").and_then(|c| c.as_u64()), Some(2));
        assert_eq!(columns[1].get("count").and_then(|c| c.as_u64()), Some(1));
        assert_eq!(columns[2].get("count").and_then(|c| c.as_u64()), Some(0));
    }
}
