//! Quests: an auto-detecting todo list.
//!
//! A **quest** is a task with a natural-language *completion condition*. On a
//! schedule, the [`QuestEngine`] gathers what the user has recently been doing
//! from Shadow's always-on context (screen text / activity / semantic history)
//! and asks a judge model whether the task looks done. Depending on the user's
//! configured **detection mode** it either *suggests* completion (a chip the user
//! confirms) or *auto-completes* the quest outright.
//!
//! This is the [`crate::monitors`] pattern applied to personal tasks instead of
//! websites: a SQLite store holds the cross-run state, the scheduler fires each
//! open quest on its interval via a `JobTarget::Quest` job, and every transition
//! into a "done" verdict is broadcast over SSE (desktop quests page + island
//! completion chip). It reuses the goal-judge primitive (a one-shot side-model
//! call through the Gateway) for the actual reasoning.
//!
//! Placement (Core vs Gateway): a quest decides *what runs and when* (the
//! detection loop), so it is Core. The judge model call routes through the
//! Gateway like every other model call — nothing about the model is hardcoded
//! (pref `quest-judge-model` → env → the bundled local default).

pub mod store;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::server::preferences::PreferencesStore;
use crate::sidecar::mcp::McpRegistry;
use store::QuestStore;

/// Preference key: how aggressive auto-detection is (`off`/`suggest`/`auto_high`/`auto_all`).
pub const DETECTION_MODE_PREF: &str = "quest-detection-mode";
/// Preference key: the judge model id (swappable, never hardcoded to a provider).
pub const JUDGE_MODEL_PREF: &str = "quest-judge-model";
/// Preference key: the judge reasoning effort.
pub const JUDGE_EFFORT_PREF: &str = "quest-judge-effort";

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

/// Process-global quest engine, set once at startup from `main.rs`. Mirrors
/// [`crate::monitors::set_global_engine`]: the state-free scheduler reads it when
/// a `JobTarget::Quest` job fires.
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

/// The quest runtime: holds the store, the MCP registry (for Shadow context),
/// an HTTP client (for the gateway judge call), and the preferences store (for
/// the detection mode + judge model). Cheap to clone. Shared by the HTTP API
/// (run-now / manual ops) and the scheduler (via a process-global handle).
#[derive(Clone)]
pub struct QuestEngine {
    pub store: QuestStore,
    mcp: Arc<McpRegistry>,
    http: reqwest::Client,
    preferences: PreferencesStore,
}

impl QuestEngine {
    pub fn new(
        store: QuestStore,
        mcp: Arc<McpRegistry>,
        http: reqwest::Client,
        preferences: PreferencesStore,
    ) -> Self {
        Self {
            store,
            mcp,
            http,
            preferences,
        }
    }

    /// The active detection mode (pref `quest-detection-mode` → default Suggest).
    pub async fn detection_mode(&self) -> DetectionMode {
        match self.preferences.get(DETECTION_MODE_PREF).await {
            Ok(Some(v)) => DetectionMode::from_pref(&v),
            _ => DetectionMode::default(),
        }
    }

    /// Run one detection pass for `quest_id`: gather context, judge, and act per
    /// the detection mode. A no-op (returns `Ok(None)`) when the quest is not
    /// open, is snoozed, detection is off, or there is no context to judge.
    /// Returns the verdict when one was produced.
    pub async fn judge_quest(&self, quest_id: &str) -> Result<Option<Verdict>, String> {
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

        let Some(evidence) = self.gather_context(&quest).await else {
            // No context available (Shadow down / nothing captured) — can't judge.
            return Ok(None);
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

    /// Dismiss the whole quest (abandon it); never judged again.
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
        Ok(Some(quest))
    }

    // ---- internals --------------------------------------------------------

    /// Gather recent-activity evidence from Shadow via the MCP registry. Returns
    /// `None` when Shadow is unavailable or has nothing to offer (so we don't
    /// judge on an empty context). Combines a recent-activity summary with a
    /// semantic search keyed on the quest title.
    async fn gather_context(&self, quest: &Quest) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();

        let recent = self
            .mcp
            .call_tool(
                "shadow__recent_context",
                serde_json::json!({ "minutes": CONTEXT_MINUTES }),
                None,
            )
            .await
            .ok();
        if let Some(text) = recent.as_ref().and_then(usable_text) {
            parts.push(format!("Recent activity:\n{text}"));
        }

        let semantic = self
            .mcp
            .call_tool(
                "shadow__semantic_search",
                serde_json::json!({ "query": quest.condition(), "limit": 5 }),
                None,
            )
            .await
            .ok();
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
    /// `RYU_QUEST_JUDGE_MODEL` → `RYU_DEFAULT_LLM_MODEL` → the bundled local
    /// default. Nothing hardcoded to a remote provider.
    async fn resolve_judge_model(&self) -> String {
        if let Ok(Some(pref)) = self.preferences.get(JUDGE_MODEL_PREF).await {
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
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_string()
    }

    async fn resolve_judge_effort(&self) -> String {
        if let Ok(Some(pref)) = self.preferences.get(JUDGE_EFFORT_PREF).await {
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
        use crate::sidecar::gateway::{gateway_token, gateway_url};
        let base = gateway_url();
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
        if let Some(t) = gateway_token() {
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
}
