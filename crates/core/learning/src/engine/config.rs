//! Learning preference keys and their resolvers (pref -> env -> default).

use std::collections::HashMap;

use chrono::Timelike;
use serde::Serialize;

use crate::host::LearningHost;

// ---------------------------------------------------------------------------
// Preference keys (dot-namespaced; defaults live in the resolvers, not the store)
// ---------------------------------------------------------------------------

/// Global opt-in for the **training** path — turning conversations into PRM-scored
/// experience samples and fine-tune data. Default OFF (explicit consent: the PRM
/// judge can route off-device). Gates sweep/score/cycle + the scheduled retrain.
pub const LEARNING_ENABLED_PREF: &str = "learning.enabled";
/// Opt-in for the **local skills** loop — distilling reusable skills from
/// conversations and proposing them in the approval inbox. Default OFF. Even
/// local synthesis turns conversation content into a durable artifact, so it
/// requires explicit consent.
pub const LEARNING_SKILLS_ENABLED_PREF: &str = "learning.skills-enabled";
/// Unix-seconds watermark for the autonomous skills pass: only conversations
/// updated after this are considered, so a chat is never re-distilled until it
/// gets new activity.
pub const LEARNING_SKILLS_WATERMARK_PREF: &str = "learning.skills-last-synth-at";
/// Per-conversation exclude: key is `learning.exclude.<conversation_id>`.
pub const LEARNING_EXCLUDE_PREFIX: &str = "learning.exclude.";
/// PRM (judge) model id routed through the Gateway.
pub const LEARNING_PRM_MODEL_PREF: &str = "learning.prm-model";
pub const LEARNING_PRM_EFFORT_PREF: &str = "learning.prm-effort";
/// Optional BYO PRM endpoint (OpenAI-compatible). When set, bypasses the Gateway.
pub const LEARNING_PRM_URL_PREF: &str = "learning.prm-url";
pub const LEARNING_PRM_KEY_PREF: &str = "learning.prm-key";
/// Skill-synthesis model id (defaults local-first, like the plugin host).
pub const LEARNING_SYNTH_MODEL_PREF: &str = "learning.synth-model";
pub const LEARNING_SYNTH_EFFORT_PREF: &str = "learning.synth-effort";
/// Minimum reward a sample needs to enter the training set (rejection sampling).
pub const LEARNING_MIN_REWARD_PREF: &str = "learning.min-reward";
/// Base model to retrain from. Anchored to the ORIGINAL base, never a merge.
pub const LEARNING_BASE_MODEL_PREF: &str = "learning.base-model";
/// Current skill-library generation; bumped when auto-evolution lands a skill.
pub const LEARNING_SKILL_GENERATION_PREF: &str = "learning.skill-generation";
/// Whether a synthesized skill must be approved in the inbox before it joins the
/// active library. Default ON — the loop *proposes*, the user *disposes*. Applies
/// to a `force` synth too: `force` only bypasses the opt-in/quality gates, never
/// the approval gate (an activated skill is node-global context, so the write must
/// always pass the inbox). Set falsy to restore silent auto-activation.
pub const LEARNING_REQUIRE_APPROVAL_PREF: &str = "learning.require-approval";

/// Optional idle/sleep-window bounds (UTC hour, 0-23) for the scheduled cycle.
pub const LEARNING_SLEEP_START_PREF: &str = "learning.sleep-start";
pub const LEARNING_SLEEP_END_PREF: &str = "learning.sleep-end";
/// Unix-seconds of the last scheduled cycle run (dedupe across ticks/restarts).
pub const LEARNING_LAST_CYCLE_PREF: &str = "learning.last-cycle-at";
/// Minimum hours between scheduled cycles.
pub const LEARNING_MIN_GAP_HOURS_PREF: &str = "learning.min-cycle-gap-hours";

/// Whether a thumbs 👍/👎 on a chat message writes a long-term RAG memory fact
/// (good answers become recallable examples; bad answers become "avoid" notes).
/// Default ON — the memory store is local and private, and auto-recall already
/// surfaces its facts, so this improves answers on install with no egress. The
/// feedback fan-out itself stays Core-side (it writes the RAG memory + retrieval
/// stores); this crate owns only the pref resolver so all learning prefs live here.
pub const FEEDBACK_MEMORY_ENABLED_PREF: &str = "feedback.memory-enabled";
/// Whether a 👎 also records a *negative* ("avoid answering like this") memory
/// note, in addition to being filtered out of the training set. Default ON.
pub const FEEDBACK_DOWN_NEGATIVE_PREF: &str = "feedback.down-negative-memory";

pub(super) const DEFAULT_MIN_REWARD: f64 = 0.7;
const DEFAULT_MIN_GAP_HOURS: i64 = 20;

/// Skill slugs this loop writes are namespaced so they're distinguishable from
/// catalog-installed skills.
pub(super) const LEARNED_SKILL_PREFIX: &str = "learned-";

/// Where the model call for PRM/synthesis is routed.
#[derive(Debug, Clone)]
pub struct ModelSource {
    pub model: String,
    pub effort: String,
    /// BYO OpenAI-compatible endpoint; `None` routes through the Gateway.
    pub url: Option<String>,
    pub key: Option<String>,
}

/// Resolved, client-safe learning config (never includes secrets).
#[derive(Debug, Clone, Serialize)]
pub struct LearningConfig {
    pub enabled: bool,
    pub skills_enabled: bool,
    pub prm_model: String,
    pub prm_via_byo: bool,
    pub synth_model: String,
    pub min_reward: f64,
    pub base_model: Option<String>,
    pub skill_generation: i64,
}

// ---------------------------------------------------------------------------
// Resolvers (pref -> env -> default)
// ---------------------------------------------------------------------------

pub(super) async fn pref(host: &dyn LearningHost, key: &str) -> Option<String> {
    host.pref_get(key)
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn truthy(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Global opt-in. Default OFF — learning never happens unless the user enables it.
pub async fn resolve_enabled(host: &dyn LearningHost) -> bool {
    if let Some(v) = pref(host, LEARNING_ENABLED_PREF).await {
        return truthy(&v);
    }
    std::env::var("RYU_LEARNING_ENABLED")
        .map(|v| truthy(&v))
        .unwrap_or(false)
}

/// Local skills-loop opt-in. Default OFF — skill synthesis still turns
/// conversation content into a durable artifact.
pub async fn resolve_skills_enabled(host: &dyn LearningHost) -> bool {
    if let Some(v) = pref(host, LEARNING_SKILLS_ENABLED_PREF).await {
        return truthy(&v);
    }
    std::env::var("RYU_LEARNING_SKILLS_ENABLED")
        .map(|v| truthy(&v))
        .unwrap_or(false)
}

/// Whether a synthesized skill needs inbox approval before it goes live. Default
/// ON. Applies to every synthesis path, `force` included — see
/// [`LEARNING_REQUIRE_APPROVAL_PREF`].
pub async fn resolve_require_approval(host: &dyn LearningHost) -> bool {
    match pref(host, LEARNING_REQUIRE_APPROVAL_PREF).await {
        Some(v) => truthy(&v),
        None => true,
    }
}

/// Whether a thumbs vote writes a RAG memory fact. Default ON (local + private).
pub async fn resolve_feedback_memory_enabled(host: &dyn LearningHost) -> bool {
    match pref(host, FEEDBACK_MEMORY_ENABLED_PREF).await {
        Some(v) => truthy(&v),
        None => true,
    }
}

/// Whether a 👎 records a negative "avoid" memory note. Default ON.
pub async fn resolve_feedback_down_negative(host: &dyn LearningHost) -> bool {
    match pref(host, FEEDBACK_DOWN_NEGATIVE_PREF).await {
        Some(v) => truthy(&v),
        None => true,
    }
}

/// Per-conversation opt-out. Honored even when the global toggle is on.
pub async fn resolve_excluded(host: &dyn LearningHost, conversation_id: &str) -> bool {
    let key = format!("{LEARNING_EXCLUDE_PREFIX}{conversation_id}");
    pref(host, &key).await.map(|v| truthy(&v)).unwrap_or(false)
}

/// `resolve_excluded` with a per-pass cache, for loops over many rows that share
/// a conversation id (scoring/training). Avoids one pref read per row.
pub(super) async fn conversation_excluded(
    host: &dyn LearningHost,
    conversation_id: &str,
    cache: &mut HashMap<String, bool>,
) -> bool {
    if let Some(v) = cache.get(conversation_id) {
        return *v;
    }
    let v = resolve_excluded(host, conversation_id).await;
    cache.insert(conversation_id.to_string(), v);
    v
}

pub async fn resolve_min_reward(host: &dyn LearningHost) -> f64 {
    pref(host, LEARNING_MIN_REWARD_PREF)
        .await
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| (0.0..=1.0).contains(v))
        .unwrap_or(DEFAULT_MIN_REWARD)
}

/// Whether the current UTC hour is inside the configured idle/sleep window. When
/// neither bound is set, always `true` (no restriction). Handles windows that wrap
/// midnight (e.g. start=22, end=6). Core has no keyboard-idle signal, so this
/// hour-window is the pragmatic stand-in for MetaClaw's idle scheduler.
pub async fn resolve_in_sleep_window(host: &dyn LearningHost) -> bool {
    let start = pref(host, LEARNING_SLEEP_START_PREF)
        .await
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|h| *h < 24);
    let end = pref(host, LEARNING_SLEEP_END_PREF)
        .await
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|h| *h <= 24);
    // Only BOTH-unset means "no restriction". A single bound is honored: a missing
    // start means from midnight (0), a missing end means until midnight (24) — so
    // `sleep-start=22` alone yields [22, 24) rather than firing all day.
    if start.is_none() && end.is_none() {
        return true;
    }
    let hour = chrono::Utc::now().hour();
    in_hour_window(hour, start.unwrap_or(0), end.unwrap_or(24))
}

/// Whether enough time has elapsed since the last scheduled cycle. The scheduler
/// ticks the cycle job hourly (so it reliably catches the sleep window), but a
/// retrain should run at most once per `min-cycle-gap-hours` (default 20). This
/// gap is persisted, so it also prevents a fresh cycle firing on every Core
/// restart. `true` when no prior run is recorded.
pub async fn scheduled_cycle_due(host: &dyn LearningHost) -> bool {
    let last = pref(host, LEARNING_LAST_CYCLE_PREF)
        .await
        .and_then(|v| v.parse::<i64>().ok());
    let Some(last) = last else {
        return true;
    };
    let gap_hours = pref(host, LEARNING_MIN_GAP_HOURS_PREF)
        .await
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|h| *h > 0)
        .unwrap_or(DEFAULT_MIN_GAP_HOURS);
    (chrono::Utc::now().timestamp() - last) >= gap_hours * 3600
}

/// Stamp "a cycle ran now". Called by the scheduler BEFORE running so a crash or
/// restart mid-cycle doesn't immediately re-run (attempt-based dedupe).
pub async fn mark_cycle_ran(host: &dyn LearningHost) {
    let now = chrono::Utc::now().timestamp().to_string();
    let _ = host.pref_set(LEARNING_LAST_CYCLE_PREF, &now).await;
}

/// Is `hour` within `[start, end)` on a 24h clock, wrapping midnight when
/// `start > end`? `start == end` means an empty window (never). `end` may be 24
/// (= midnight), so `[22, 24)` is the last two hours of the day.
pub(super) fn in_hour_window(hour: u32, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

pub async fn resolve_skill_generation(host: &dyn LearningHost) -> i64 {
    pref(host, LEARNING_SKILL_GENERATION_PREF)
        .await
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

pub async fn resolve_base_model(host: &dyn LearningHost) -> Option<String> {
    pref(host, LEARNING_BASE_MODEL_PREF).await
}

/// PRM judge source. Defaults to a *remote* model via the Gateway so the judge is
/// stronger than the (typically local) model being trained — a local model
/// grading itself only reinforces its own style, not correctness.
pub async fn resolve_prm(host: &dyn LearningHost) -> ModelSource {
    let model = pref(host, LEARNING_PRM_MODEL_PREF)
        .await
        .or_else(|| std::env::var("RYU_LEARNING_PRM_MODEL").ok())
        .or_else(|| std::env::var("RYU_DEFAULT_LLM_MODEL").ok())
        .unwrap_or_else(|| host.default_prm_model());
    let effort = pref(host, LEARNING_PRM_EFFORT_PREF)
        .await
        .unwrap_or_default();
    let url = pref(host, LEARNING_PRM_URL_PREF).await;
    let key = pref(host, LEARNING_PRM_KEY_PREF).await;
    ModelSource {
        model,
        effort,
        url,
        key,
    }
}

/// Skill-synthesis source. Defaults local-first (cheap, private) — synthesis is a
/// summarization task, not a correctness judgement, so the local model is fine.
pub async fn resolve_synth(host: &dyn LearningHost) -> ModelSource {
    let model = pref(host, LEARNING_SYNTH_MODEL_PREF)
        .await
        .or_else(|| std::env::var("RYU_LEARNING_SYNTH_MODEL").ok())
        .or_else(|| std::env::var("RYU_DEFAULT_LLM_MODEL").ok())
        .unwrap_or_else(|| host.default_synth_model());
    let effort = pref(host, LEARNING_SYNTH_EFFORT_PREF)
        .await
        .unwrap_or_default();
    ModelSource {
        model,
        effort,
        url: None,
        key: None,
    }
}

pub async fn resolve_config(host: &dyn LearningHost) -> LearningConfig {
    let prm = resolve_prm(host).await;
    let synth = resolve_synth(host).await;
    LearningConfig {
        enabled: resolve_enabled(host).await,
        skills_enabled: resolve_skills_enabled(host).await,
        prm_model: prm.model,
        prm_via_byo: prm.url.is_some(),
        synth_model: synth.model,
        min_reward: resolve_min_reward(host).await,
        base_model: resolve_base_model(host).await,
        skill_generation: resolve_skill_generation(host).await,
    }
}
