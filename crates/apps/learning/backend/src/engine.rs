//! Continual-learning loop (MetaClaw-style) over the experience buffer.
//!
//! See `docs/continual-learning-metaclaw-spec.md`. This module owns the *logic*;
//! [`crate::store`] owns storage and [`crate::api`] is the HTTP surface. Nothing
//! here touches the chat hot path: the experience buffer is built by **sweeping**
//! the persisted conversation store (via [`LearningHost`]) at cycle time, so a
//! periodic (idle-window) retrain is the unit of work, not a per-turn update.
//!
//! Every Core-owned dependency is reached through [`LearningCtx`] (its
//! [`ExperienceStore`] + a `&dyn LearningHost`), so this crate has ZERO dependency
//! on `apps/core`.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::host::{LearningHost, Msg, QueuedApproval};
use crate::store::{Experience, ExperienceStore};

/// Everything the learning engine needs, bundled: the durable experience buffer,
/// the Core seam, and an HTTP client for the BYO-PRM-endpoint path. Cheap to build
/// (the store + host are `Arc`-backed clones); Core constructs one per call site.
#[derive(Clone)]
pub struct LearningCtx {
    pub store: ExperienceStore,
    pub host: Arc<dyn LearningHost>,
    pub client: reqwest::Client,
}

impl LearningCtx {
    pub fn new(store: ExperienceStore, host: Arc<dyn LearningHost>, client: reqwest::Client) -> Self {
        Self {
            store,
            host,
            client,
        }
    }

    fn host(&self) -> &dyn LearningHost {
        &*self.host
    }
}

// ---------------------------------------------------------------------------
// Preference keys (dot-namespaced; defaults live in the resolvers, not the store)
// ---------------------------------------------------------------------------

/// Global opt-in for the **training** path — turning conversations into PRM-scored
/// experience samples and fine-tune data. Default OFF (explicit consent: the PRM
/// judge can route off-device). Gates sweep/score/cycle + the scheduled retrain.
pub const LEARNING_ENABLED_PREF: &str = "learning.enabled";
/// Opt-in for the **local skills** loop — distilling reusable skills from
/// conversations and proposing them in the approval inbox. Default ON. Entirely
/// on-device and inbox-gated (no conversation text ever leaves the machine), so it
/// is the safe "grows with you" default, kept separate from the training opt-in.
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
/// Whether an autonomously-synthesized skill must be approved in the inbox before
/// it joins the active library. Default ON — the loop *proposes*, the user
/// *disposes*. A deliberate `force` synth ("make a skill from this chat") always
/// bypasses the gate. Set falsy to restore silent auto-activation.
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

const DEFAULT_MIN_REWARD: f64 = 0.7;
const DEFAULT_MIN_GAP_HOURS: i64 = 20;

/// Skill slugs this loop writes are namespaced so they're distinguishable from
/// catalog-installed skills.
const LEARNED_SKILL_PREFIX: &str = "learned-";

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

async fn pref(host: &dyn LearningHost, key: &str) -> Option<String> {
    host.pref_get(key)
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn truthy(s: &str) -> bool {
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

/// Local skills-loop opt-in. Default ON — on-device, inbox-gated, no data egress,
/// so it's safe to run without the explicit consent the training path requires.
pub async fn resolve_skills_enabled(host: &dyn LearningHost) -> bool {
    if let Some(v) = pref(host, LEARNING_SKILLS_ENABLED_PREF).await {
        return truthy(&v);
    }
    std::env::var("RYU_LEARNING_SKILLS_ENABLED")
        .map(|v| truthy(&v))
        .unwrap_or(true)
}

/// Whether an autonomously-synthesized skill needs inbox approval before it goes
/// live. Default ON. A `force` synth bypasses this at the call site.
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
async fn conversation_excluded(
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
fn in_hour_window(hour: u32, start: u32, end: u32) -> bool {
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
    let effort = pref(host, LEARNING_PRM_EFFORT_PREF).await.unwrap_or_default();
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

// ---------------------------------------------------------------------------
// Model call: Gateway (host side-model) or BYO OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

async fn run_model(
    ctx: &LearningCtx,
    src: &ModelSource,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let Some(url) = src.url.as_deref() else {
        // Gateway path: reuse Core's shared side-model primitive (handles auth).
        return ctx
            .host()
            .run_side_model(&src.model, &src.effort, system, user)
            .await;
    };
    // BYO path: direct OpenAI-compatible call (the Gateway can't route an
    // arbitrary external judge endpoint; model id is its only routing knob).
    let endpoint = format!("{}/v1/chat/completions", url.trim_end_matches('/'));
    let mut body = json!({
        "model": src.model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    if !src.effort.trim().is_empty() {
        body["reasoning_effort"] = json!(src.effort);
    }
    let mut req = ctx.client.post(&endpoint).json(&body);
    if let Some(k) = src.key.as_deref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("PRM endpoint unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("PRM endpoint returned {}", resp.status()));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("PRM bad JSON: {e}"))?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

// ---------------------------------------------------------------------------
// Sweep: persisted conversations -> experience rows (consent-gated)
// ---------------------------------------------------------------------------

/// Walk the conversation store and capture every `(user, assistant)` turn that
/// isn't already buffered. Returns the number of newly-captured turns. A no-op
/// (returns 0) when the global opt-in is off.
pub async fn sweep_into_buffer(ctx: &LearningCtx) -> Result<usize> {
    if !resolve_enabled(ctx.host()).await {
        return Ok(0);
    }
    let generation = resolve_skill_generation(ctx.host()).await;
    let conversations = ctx
        .host()
        .list_conversations()
        .await
        .context("listing conversations for sweep")?;

    let mut added = 0usize;
    for conv in conversations {
        // Skip archived chats and any the user excluded from learning.
        if conv.archived || conv.message_count < 2 {
            continue;
        }
        if resolve_excluded(ctx.host(), &conv.id).await {
            continue;
        }
        let messages = match ctx.host().get_messages(&conv.id).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("sweep: get_messages({}) failed: {e:#}", conv.id);
                continue;
            }
        };
        // NOTE: only plaintext conversation content is ingested here — the
        // identity vault and encrypted-field stores are separate and never flow
        // through `messages`.
        let mut last_user: Option<String> = None;
        for m in messages {
            if m.role == "user" {
                last_user = Some(m.content);
            } else if m.role == "assistant" {
                let Some(user_text) = last_user.take() else {
                    continue;
                };
                let assistant_text = m.content;
                if user_text.trim().is_empty() || assistant_text.trim().is_empty() {
                    continue;
                }
                // Attribute to the agent that produced THIS reply (multi-agent
                // chats), falling back to the conversation's primary agent.
                let agent_id = m.agent_id.or_else(|| conv.agent_id.clone());
                let exp = Experience {
                    id: m.id,
                    conversation_id: conv.id.clone(),
                    agent_id,
                    user_text,
                    assistant_text,
                    outcome: "completed".to_string(),
                    reward: None,
                    base_model: None,
                    skill_generation: generation,
                    excluded: false,
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                if ctx.store.record_if_absent(&exp).await.unwrap_or(false) {
                    added += 1;
                }
            }
        }
    }
    Ok(added)
}

// ---------------------------------------------------------------------------
// Score: PRM judge over unscored samples
// ---------------------------------------------------------------------------

const PRM_SYSTEM: &str = "You are a strict reward model evaluating an AI assistant. \
Given a user message and the assistant's reply, rate the reply's correctness and \
helpfulness on a scale from 0.0 (wrong or useless) to 1.0 (perfect). \
Respond with ONLY the number, e.g. 0.82.";

/// Extract a reward in `[0,1]` from a judge's free-text answer. Tolerant of
/// `Score: 0.8/1.0`, `0.8`, `80%`, etc. Returns `None` when no number is found.
///
/// A bare left-to-right scan is unsafe: prose like "handles 2 edge cases, I rate
/// it 0.9" would lock onto the leading `2`. So we collect every numeric token and
/// PREFER the first decimal already in `[0,1]` (almost always the score, and for
/// `0.8/1.0` the numerator not the `1.0` denominator). Only when there is no such
/// decimal do we fall back to the last integer read as a percentage. Scale
/// phrasings like "9/10" are off the requested 0-1 format and are not parsed.
pub fn parse_reward(text: &str) -> Option<f64> {
    let mut tokens: Vec<(f64, bool)> = Vec::new(); // (value, had_decimal_point)
    let mut num = String::new();
    let mut had_dot = false;
    let flush = |num: &mut String, had_dot: &mut bool, tokens: &mut Vec<(f64, bool)>| {
        if !num.is_empty() {
            if let Ok(v) = num.parse::<f64>() {
                tokens.push((v, *had_dot));
            }
            num.clear();
            *had_dot = false;
        }
    };
    for c in text.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else if c == '.' && !had_dot {
            num.push(c);
            had_dot = true;
        } else {
            flush(&mut num, &mut had_dot, &mut tokens);
        }
    }
    flush(&mut num, &mut had_dot, &mut tokens);

    // Prefer the first decimal already within [0,1] — almost certainly the score.
    if let Some((v, _)) = tokens
        .iter()
        .find(|(v, dot)| *dot && (0.0..=1.0).contains(v))
    {
        return Some(*v);
    }
    // Otherwise the last numeric token, integers read as a percentage.
    let (v, _) = tokens.last()?;
    let v = if *v > 1.0 { v / 100.0 } else { *v };
    Some(v.clamp(0.0, 1.0))
}

/// Score up to `limit` unscored samples with the PRM. Returns how many were
/// scored. No-op when learning is disabled.
pub async fn score_buffer(ctx: &LearningCtx, limit: usize) -> Result<usize> {
    if !resolve_enabled(ctx.host()).await {
        return Ok(0);
    }
    let src = resolve_prm(ctx.host()).await;
    let pending = ctx
        .store
        .list_unscored(limit)
        .await
        .context("listing unscored experience")?;
    let mut scored = 0usize;
    let mut exclude_cache: HashMap<String, bool> = HashMap::new();
    for exp in pending {
        // Defense-in-depth: honor the per-conversation exclude PREF, not just the
        // denormalized row flag, so an excluded chat's plaintext never reaches the
        // PRM even if a prior row-flip failed.
        if conversation_excluded(ctx.host(), &exp.conversation_id, &mut exclude_cache).await {
            continue;
        }
        let user = format!(
            "User message:\n{}\n\nAssistant reply:\n{}",
            exp.user_text, exp.assistant_text
        );
        match run_model(ctx, &src, PRM_SYSTEM, &user).await {
            Ok(answer) => {
                if let Some(reward) = parse_reward(&answer) {
                    if ctx.store.set_reward(&exp.id, reward).await.unwrap_or(false) {
                        scored += 1;
                    }
                } else {
                    tracing::warn!("PRM returned no parseable score for {}: {answer:?}", exp.id);
                }
            }
            Err(e) => tracing::warn!("PRM call failed for {}: {e}", exp.id),
        }
    }
    Ok(scored)
}

// ---------------------------------------------------------------------------
// Synthesize: distill a reusable skill from a session (auto-evolution)
// ---------------------------------------------------------------------------

const SYNTH_SYSTEM: &str = "You distill a reusable skill from a conversation \
between a user and an AI assistant. If — and only if — the conversation \
demonstrates a generalizable procedure, technique, or a corrected mistake worth \
remembering, output a JSON object: \
{\"name\": short kebab-or-words title, \"description\": one sentence on when to \
use it, \"instructions\": markdown steps the assistant should follow next time}. \
If nothing reusable is present, output exactly {\"name\":\"\"}. Output ONLY JSON.";

#[derive(Debug, Clone, Serialize)]
pub struct SynthOutcome {
    pub created: bool,
    pub slug: Option<String>,
    pub reason: String,
}

/// Build the conversation transcript fed to the synthesis model.
fn transcript(messages: &[Msg]) -> String {
    let mut out = String::new();
    for m in messages {
        if m.role == "user" || m.role == "assistant" {
            out.push_str(&format!("{}: {}\n\n", m.role, m.content));
        }
    }
    out
}

/// Turn a free-form title into a namespaced, filesystem-safe skill slug.
pub fn slugify(name: &str) -> String {
    let mut slug = String::from(LEARNED_SKILL_PREFIX);
    let mut prev_dash = false;
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    // Cap length to keep directory names sane.
    slug.chars().take(60).collect()
}

/// Render a validated `SKILL.md` body from synthesized fields.
pub fn build_skill_md(name: &str, description: &str, instructions: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{instructions}\n")
}

/// Extract the first balanced `{...}` that parses as JSON from a possibly-fenced
/// answer. Crucially, if the first balanced object fails to parse (e.g. the answer
/// opens with a prose brace like `{placeholders}`), keep scanning for the next
/// candidate rather than bailing — the real JSON may come later in the string.
/// (Structural chars are ASCII, so byte scanning is UTF-8 safe: continuation
/// bytes never collide with `{`/`}`/`"`/`\`.)
fn extract_json_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find('{') {
        let start = search_from + rel;
        if let Some(end) = balanced_object_end(bytes, start) {
            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                return Some(v);
            }
        }
        // No object here, or it didn't parse — advance past this `{` and retry.
        search_from = start + 1;
    }
    None
}

/// Index of the `}` that closes the object opened at `start`, respecting strings
/// and escapes. `None` if unbalanced to end-of-input.
fn balanced_object_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Distill a skill from one conversation and, if worthwhile, write + activate it.
/// Consent-gated: runs only when the skills opt-in is on OR `force` is set by a
/// deliberate per-conversation user action ("make a skill from this chat"). With
/// skills off and `force` false this is a no-op — conversation content is never
/// processed and no global skill is written, so collection can't precede consent.
/// Always respects per-conversation exclude.
pub async fn synthesize_skill(
    ctx: &LearningCtx,
    conversation_id: &str,
    force: bool,
) -> Result<SynthOutcome> {
    // Gated by the *skills* opt-in (default ON, on-device), not the training
    // opt-in — distilling a local skill never sends conversation text off-device.
    if !(force || resolve_skills_enabled(ctx.host()).await) {
        return Ok(SynthOutcome {
            created: false,
            slug: None,
            reason: "skill learning is disabled; pass force for an explicit one-off".to_string(),
        });
    }
    if resolve_excluded(ctx.host(), conversation_id).await {
        return Ok(SynthOutcome {
            created: false,
            slug: None,
            reason: "conversation excluded from learning".to_string(),
        });
    }
    let messages = ctx
        .host()
        .get_messages(conversation_id)
        .await
        .context("loading conversation for synthesis")?;
    if messages.len() < 2 {
        return Ok(SynthOutcome {
            created: false,
            slug: None,
            reason: "too few messages".to_string(),
        });
    }
    let src = resolve_synth(ctx.host()).await;
    let answer = run_model(ctx, &src, SYNTH_SYSTEM, &transcript(&messages))
        .await
        .map_err(|e| anyhow::anyhow!("synthesis model call failed: {e}"))?;

    let obj = extract_json_object(&answer)
        .ok_or_else(|| anyhow::anyhow!("synthesis returned no JSON object: {answer:?}"))?;
    let name = obj["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Ok(SynthOutcome {
            created: false,
            slug: None,
            reason: "nothing reusable in this conversation".to_string(),
        });
    }
    let description = obj["description"].as_str().unwrap_or("").trim().to_string();
    let instructions = obj["instructions"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if instructions.is_empty() {
        return Ok(SynthOutcome {
            created: false,
            slug: None,
            reason: "synthesis produced empty instructions".to_string(),
        });
    }

    let slug = slugify(&name);
    let skill_md = build_skill_md(&name, &description, &instructions);
    // Validate before writing — a malformed skill must never reach the library.
    ryu_skills::parse_skill_md(&slug, &skill_md)
        .map_err(|e| anyhow::anyhow!("synthesized skill failed validation: {e}"))?;

    // Gate autonomous synthesis behind the approval inbox: the loop *proposes* a
    // skill and the user approves it before it joins the active library (the
    // Hermes `skills.write_approval` stage→review→approve model). A deliberate
    // `force` synth (the user explicitly asked to make a skill from this chat)
    // skips the gate. Falls back to direct activation when no approval engine is
    // wired (headless/tests) or the user opted out via the pref. Nothing is
    // written to disk until approve, so a rejected suggestion never touches the
    // library.
    if !force && resolve_require_approval(ctx.host()).await {
        match ctx
            .host()
            .queue_skill_approval(&slug, &name, &description, conversation_id, skill_md.clone())
            .await
            .map_err(|e| anyhow::anyhow!("queueing synthesized skill for approval: {e}"))?
        {
            QueuedApproval::Queued => {
                return Ok(SynthOutcome {
                    created: false,
                    slug: Some(slug),
                    reason: "skill queued for your approval in the inbox".to_string(),
                })
            }
            QueuedApproval::AlreadyPending => {
                return Ok(SynthOutcome {
                    created: false,
                    slug: Some(slug),
                    reason: "skill already awaiting approval in the inbox".to_string(),
                })
            }
            // No approval engine wired: fall through to direct activation below.
            QueuedApproval::NoEngine => {}
        }
    }

    write_skill(&slug, &skill_md).await?;
    ryu_skills::set_active(&slug, true);
    ctx.host().reload_skills();

    // Bump the skill generation so future captures are tagged against the new
    // library state (MetaClaw support/query separation).
    let gen = resolve_skill_generation(ctx.host()).await + 1;
    let _ = ctx
        .host()
        .pref_set(LEARNING_SKILL_GENERATION_PREF, &gen.to_string())
        .await;

    Ok(SynthOutcome {
        created: true,
        slug: Some(slug),
        reason: "skill synthesized".to_string(),
    })
}

/// Materialize an approved synthesized skill: write its `SKILL.md` into the
/// library. Public so the approval engine can install a learning-proposed skill
/// when the user approves it in the inbox (the write is deferred until approve so
/// a rejected suggestion never lands on disk). The caller flips it active +
/// reloads the registry; this only writes the file.
pub async fn write_synthesized_skill(slug: &str, contents: &str) -> Result<()> {
    write_skill(slug, contents).await
}

/// Atomically write `<skills_dir>/<slug>/SKILL.md` (tmp + rename), mirroring the
/// catalog installer so a concurrent registry reload never sees a half-written
/// file.
async fn write_skill(slug: &str, contents: &str) -> Result<()> {
    let dir = ryu_skills::SkillRegistry::skills_dir().join(slug);
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating skill dir {}", dir.display()))?;
    let tmp = dir.join("SKILL.md.tmp");
    let final_path = dir.join("SKILL.md");
    tokio::fs::write(&tmp, contents)
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    tokio::fs::rename(&tmp, &final_path)
        .await
        .with_context(|| format!("renaming into {}", final_path.display()))?;
    Ok(())
}

/// Autonomous local skills pass (the default "grows with you" loop). For each
/// conversation updated since the last watermark, distill a skill and propose it
/// in the approval inbox (deduped by slug so a chat never spams). Bounded to `max`
/// conversations per call so it can never flood the local model or the inbox.
/// On-device only; gated by the skills opt-in (default ON) and completely
/// independent of the training path. Returns the number of skills proposed.
pub async fn run_skills_pass(ctx: &LearningCtx, max: usize) -> Result<usize> {
    if !resolve_skills_enabled(ctx.host()).await {
        return Ok(0);
    }
    let watermark: i64 = pref(ctx.host(), LEARNING_SKILLS_WATERMARK_PREF)
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut convos = ctx
        .host()
        .list_conversations()
        .await
        .context("listing conversations for the skills pass")?;
    // Only chats with new activity, oldest-first so the watermark advances
    // monotonically and we never skip a conversation when there are more than
    // `max` fresh ones.
    convos.retain(|c| c.updated_at > watermark);
    convos.sort_by_key(|c| c.updated_at);

    let mut proposed = 0usize;
    let mut high = watermark;
    for c in convos.into_iter().take(max) {
        high = high.max(c.updated_at);
        match synthesize_skill(ctx, &c.id, false).await {
            // `slug` is Some whenever a reusable skill was produced (queued for
            // approval or, with the gate off, activated). None = nothing reusable.
            Ok(outcome) if outcome.slug.is_some() => proposed += 1,
            Ok(_) => {}
            Err(e) => tracing::warn!("skills pass: synth for {} failed: {e:#}", c.id),
        }
    }
    // Advance the watermark past everything we looked at so a no-skill chat isn't
    // re-processed until it gets new activity.
    if high > watermark {
        let _ = ctx
            .host()
            .pref_set(LEARNING_SKILLS_WATERMARK_PREF, &high.to_string())
            .await;
    }
    Ok(proposed)
}

// ---------------------------------------------------------------------------
// Cycle: reward-filtered SFT dataset derived from the ORIGINAL base (scaffold)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CyclePlan {
    pub base_model: Option<String>,
    pub swept: usize,
    pub scored: usize,
    pub sample_count: usize,
    pub min_reward: f64,
    pub dataset_path: Option<String>,
    /// Whether a fine-tune was actually dispatched (false = dry-run preview).
    pub dispatched: bool,
    /// Fine-tune job id when a training run was dispatched (`execute: true`).
    pub job_id: Option<String>,
    /// Set when an `execute` cycle FAILED to dispatch (misconfig, GPU gate,
    /// sidecar/remote error). Distinct from a legitimate no-op (nothing to train):
    /// the scheduler surfaces this as a job failure. `None` on success/dry-run/no-op.
    pub error: Option<String>,
    pub note: String,
}

/// One SFT example in the chat-messages shape the Unsloth sidecar consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftSample {
    pub messages: Vec<SftMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftMessage {
    pub role: String,
    pub content: String,
}

/// Build a reward-filtered SFT dataset (one JSON object per line) from the
/// trainable rows. Pure: takes rows, returns JSONL — unit-testable.
pub fn build_jsonl(rows: &[Experience]) -> String {
    let mut out = String::new();
    for r in rows {
        let sample = SftSample {
            messages: vec![
                SftMessage {
                    role: "user".into(),
                    content: r.user_text.clone(),
                },
                SftMessage {
                    role: "assistant".into(),
                    content: r.assistant_text.clone(),
                },
            ],
        };
        if let Ok(line) = serde_json::to_string(&sample) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Run the reward-filtered learning cycle. By default a **dry run**: sweep, score,
/// assemble the dataset, and return the plan WITHOUT dispatching a fine-tune
/// (training needs a GPU and is the opt-in heavy step). `execute` dispatches the
/// fine-tune through Core's fine-tune path.
pub async fn run_cycle(ctx: &LearningCtx, execute: bool) -> Result<CyclePlan> {
    if !resolve_enabled(ctx.host()).await {
        return Ok(CyclePlan {
            base_model: None,
            swept: 0,
            scored: 0,
            sample_count: 0,
            min_reward: 0.0,
            dataset_path: None,
            dispatched: false,
            job_id: None,
            error: None,
            note: "learning is disabled (global opt-in off)".to_string(),
        });
    }
    let swept = sweep_into_buffer(ctx).await?;
    let scored = score_buffer(ctx, 256).await?;
    let min_reward = resolve_min_reward(ctx.host()).await;
    let base_model = resolve_base_model(ctx.host()).await;

    let candidate_rows = ctx
        .store
        .list_for_training(min_reward, 4096)
        .await
        .context("collecting training set")?;
    // Defense-in-depth: drop any row whose conversation is excluded by PREF, not
    // just the row flag — so an excluded chat can never enter the training set
    // even if a prior row-flip failed.
    let mut exclude_cache: HashMap<String, bool> = HashMap::new();
    let mut rows = Vec::with_capacity(candidate_rows.len());
    for r in candidate_rows {
        if !conversation_excluded(ctx.host(), &r.conversation_id, &mut exclude_cache).await {
            rows.push(r);
        }
    }
    let jsonl = build_jsonl(&rows);

    // Persist the dataset for LOCAL training + audit. A remote node can't read a
    // local path, so remote dispatch inlines the samples instead (see below); the
    // file write is best-effort but its failure is recorded (not conflated with
    // "no samples").
    let mut dataset_path = None;
    let mut write_err = None;
    if !rows.is_empty() {
        let dir = crate::data_dir().join("learning");
        match tokio::fs::create_dir_all(&dir).await {
            Ok(()) => {
                let path = dir.join(format!("dataset-{}.jsonl", chrono::Utc::now().timestamp()));
                match tokio::fs::write(&path, &jsonl).await {
                    Ok(()) => dataset_path = Some(path.to_string_lossy().to_string()),
                    Err(e) => write_err = Some(format!("writing dataset failed: {e}")),
                }
            }
            Err(e) => write_err = Some(format!("creating dataset dir failed: {e}")),
        }
    }

    let mut dispatched = false;
    let mut job_id = None;
    let mut error = None;
    let note = if execute {
        let d = dispatch_cycle(ctx, &base_model, &rows, &dataset_path, &write_err).await;
        dispatched = d.dispatched;
        job_id = d.job_id;
        error = d.error;
        d.note
    } else {
        "dry run — dataset assembled; review, then re-run with execute:true to train".to_string()
    };

    Ok(CyclePlan {
        base_model,
        swept,
        scored,
        sample_count: rows.len(),
        min_reward,
        dataset_path,
        dispatched,
        job_id,
        error,
        note,
    })
}

struct Dispatched {
    dispatched: bool,
    job_id: Option<String>,
    error: Option<String>,
    note: String,
}

/// Build and dispatch the retrain. A real retrain always derives a FRESH LoRA
/// from the ORIGINAL base (never a previous merge — that drifts into collapse) via
/// Core's fine-tune dispatch path, which GPU-gates and records the job. Training
/// is async in the sidecar; the produced adapter is merged→served separately, so we
/// only dispatch and report the job id. Sets `error` (distinct from a benign no-op)
/// on any misconfig or dispatch failure so the scheduler can surface it.
async fn dispatch_cycle(
    ctx: &LearningCtx,
    base_model: &Option<String>,
    rows: &[Experience],
    dataset_path: &Option<String>,
    write_err: &Option<String>,
) -> Dispatched {
    let mut out = Dispatched {
        dispatched: false,
        job_id: None,
        error: None,
        note: String::new(),
    };
    let fail = |out: &mut Dispatched, msg: String| {
        out.error = Some(msg.clone());
        out.note = msg;
    };

    let Some(base) = base_model.as_deref() else {
        fail(&mut out, "cannot dispatch: set the `learning.base-model` pref to the ORIGINAL base model to retrain from".to_string());
        return out;
    };
    if rows.is_empty() {
        // Not an error — just nothing cleared the reward filter this cycle.
        out.note = "nothing to train: no samples cleared the reward filter".to_string();
        return out;
    }

    // Effective target: honor `remote` only when a remote URL is actually
    // configured; a half-configured remote is a hard error, not a silent local run.
    let requested_remote = resolve_train_target(ctx.host()).await == "remote";
    let remote = resolve_remote(ctx.host()).await;
    if requested_remote && remote.is_none() {
        fail(
            &mut out,
            "cannot dispatch: learning.train-target=remote but learning.remote-url is unset"
                .to_string(),
        );
        return out;
    }
    let use_remote = requested_remote && remote.is_some();

    // Remote reads the dataset on ITS filesystem, so a local path is meaningless
    // there — inline the samples. Local uses the on-disk JSONL path.
    let dataset = if use_remote {
        let samples: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({ "messages": [
                    { "role": "user", "content": r.user_text },
                    { "role": "assistant", "content": r.assistant_text },
                ] })
            })
            .collect();
        json!({ "format": "chat", "samples": samples })
    } else {
        match dataset_path {
            Some(p) => json!({ "format": "chat", "path": p }),
            None => {
                let e = write_err
                    .clone()
                    .unwrap_or_else(|| "dataset file was not written".to_string());
                fail(&mut out, format!("cannot dispatch: {e}"));
                return out;
            }
        }
    };

    let output_name = format!("learned-{}", chrono::Utc::now().timestamp());
    let mut body = json!({
        "base_model_id": base,
        "target": if use_remote { "remote" } else { "local" },
        "output_name": output_name,
        "dataset": dataset,
    });
    if let Some(r) = remote.filter(|_| use_remote) {
        body["remote"] = r;
    }

    // Fine-tuning runs OUT-OF-PROCESS in the `ryu-finetune` sidecar; the learning
    // retrain reaches it through Core's fine-tune dispatch seam.
    match ctx.host().dispatch_finetune(body).await {
        Ok(resp) => {
            out.dispatched = true;
            out.job_id = resp
                .get("job_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            out.note = format!(
                "fine-tune dispatched from base '{base}' on {} samples",
                rows.len()
            );
        }
        Err(err) => {
            fail(&mut out, format!("dispatch failed: {err}"));
        }
    }
    out
}

/// Where a retrain runs: `local` (default) or `remote` (a Ryu Cloud GPU node).
async fn resolve_train_target(host: &dyn LearningHost) -> String {
    pref(host, "learning.train-target")
        .await
        .filter(|t| t == "remote")
        .unwrap_or_else(|| "local".to_string())
}

/// Remote GPU-node coordinates for `target: remote`, from prefs. `None` unless a
/// URL is configured. The token is passed through to the finetune dispatch and is
/// never surfaced in the plan.
async fn resolve_remote(host: &dyn LearningHost) -> Option<Value> {
    let url = pref(host, "learning.remote-url").await?;
    let mut remote = json!({ "url": url });
    if let Some(token) = pref(host, "learning.remote-token").await {
        remote["token"] = json!(token);
    }
    Some(remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reward_handles_formats() {
        assert_eq!(parse_reward("0.82"), Some(0.82));
        assert_eq!(parse_reward("Score: 0.8/1.0"), Some(0.8)); // numerator, not 1.0
        assert_eq!(parse_reward("80"), Some(0.8)); // bare integer read as percentage
        assert_eq!(parse_reward("95"), Some(0.95));
        assert_eq!(parse_reward("1"), Some(1.0));
        assert_eq!(parse_reward("1.0"), Some(1.0));
        assert_eq!(parse_reward("nonsense"), None);
        // Prose with a leading integer must not poison the score (review finding).
        assert_eq!(
            parse_reward("handles 2 edge cases, so I rate it 0.9"),
            Some(0.9)
        );
        assert_eq!(parse_reward("GPT-4 rates this 0.85 overall"), Some(0.85));
    }

    #[test]
    fn hour_window_same_day_and_wrapping() {
        // Same-day window [1, 5)
        assert!(in_hour_window(2, 1, 5));
        assert!(in_hour_window(1, 1, 5));
        assert!(!in_hour_window(5, 1, 5));
        assert!(!in_hour_window(0, 1, 5));
        // Wrapping window [22, 6) spans midnight
        assert!(in_hour_window(23, 22, 6));
        assert!(in_hour_window(0, 22, 6));
        assert!(in_hour_window(5, 22, 6));
        assert!(!in_hour_window(12, 22, 6));
        // Single-bound window [22, 24) (missing end defaults to 24)
        assert!(in_hour_window(22, 22, 24));
        assert!(in_hour_window(23, 22, 24));
        assert!(!in_hour_window(12, 22, 24));
        // Empty window
        assert!(!in_hour_window(3, 3, 3));
    }

    #[test]
    fn slugify_is_namespaced_and_safe() {
        assert_eq!(slugify("Reverse a String!"), "learned-reverse-a-string");
        assert_eq!(slugify("  spaces  here  "), "learned-spaces-here");
        assert!(slugify("a").starts_with(LEARNED_SKILL_PREFIX));
    }

    #[test]
    fn build_skill_md_round_trips_through_parser() {
        let md = build_skill_md(
            "Reverse a string",
            "When you need to reverse a string in Rust",
            "Use `s.chars().rev().collect::<String>()`.",
        );
        let parsed = ryu_skills::parse_skill_md("learned-x", &md).expect("valid skill");
        assert_eq!(parsed.name, "Reverse a string");
        assert!(parsed.instructions.contains("rev()"));
    }

    #[test]
    fn extract_json_object_strips_fences() {
        let v =
            extract_json_object("here you go:\n```json\n{\"name\":\"x\",\"a\":1}\n```\n").unwrap();
        assert_eq!(v["name"], "x");
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn extract_json_object_handles_braces_in_strings() {
        let v = extract_json_object("{\"instructions\":\"use HashMap<K,{V}>\"}").unwrap();
        assert_eq!(v["instructions"], "use HashMap<K,{V}>");
    }

    #[test]
    fn extract_json_object_skips_prose_brace() {
        // First `{...}` is prose and won't parse; the real object comes later.
        let v = extract_json_object(
            "Use {placeholders} like this: {\"name\":\"foo\",\"instructions\":\"x\"}",
        )
        .unwrap();
        assert_eq!(v["name"], "foo");
    }

    #[test]
    fn build_jsonl_emits_one_chat_sample_per_line() {
        let rows = vec![Experience {
            id: "a".into(),
            conversation_id: "c".into(),
            agent_id: None,
            user_text: "hi".into(),
            assistant_text: "hello".into(),
            outcome: "completed".into(),
            reward: Some(0.9),
            base_model: None,
            skill_generation: 0,
            excluded: false,
            created_at: "t".into(),
        }];
        let jsonl = build_jsonl(&rows);
        assert_eq!(jsonl.lines().count(), 1);
        let parsed: SftSample = serde_json::from_str(jsonl.lines().next().unwrap()).unwrap();
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(parsed.messages[1].content, "hello");
    }
}
