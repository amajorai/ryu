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

use std::sync::Arc;

use serde_json::{json, Value};

use crate::host::LearningHost;
use crate::store::ExperienceStore;

mod config;
mod cycle;
mod dispatch;
mod library;
mod reward;
mod score;
mod skill_md;
mod skills_dir;
mod synth;
mod transcript;

pub use config::{
    mark_cycle_ran, resolve_base_model, resolve_config, resolve_enabled, resolve_excluded,
    resolve_feedback_down_negative, resolve_feedback_memory_enabled, resolve_in_sleep_window,
    resolve_min_reward, resolve_prm, resolve_require_approval, resolve_skill_generation,
    resolve_skills_enabled, resolve_synth, scheduled_cycle_due, LearningConfig, ModelSource,
    FEEDBACK_DOWN_NEGATIVE_PREF, FEEDBACK_MEMORY_ENABLED_PREF, LEARNING_BASE_MODEL_PREF,
    LEARNING_ENABLED_PREF, LEARNING_EXCLUDE_PREFIX, LEARNING_LAST_CYCLE_PREF,
    LEARNING_MIN_GAP_HOURS_PREF, LEARNING_MIN_REWARD_PREF, LEARNING_PRM_EFFORT_PREF,
    LEARNING_PRM_KEY_PREF, LEARNING_PRM_MODEL_PREF, LEARNING_PRM_URL_PREF,
    LEARNING_REQUIRE_APPROVAL_PREF, LEARNING_SKILLS_ENABLED_PREF, LEARNING_SKILLS_WATERMARK_PREF,
    LEARNING_SKILL_GENERATION_PREF, LEARNING_SLEEP_END_PREF, LEARNING_SLEEP_START_PREF,
    LEARNING_SYNTH_EFFORT_PREF, LEARNING_SYNTH_MODEL_PREF,
};
pub use cycle::{
    build_jsonl, merge_cycle_output, run_cycle, run_cycle_with_improvement, CyclePlan, SftMessage,
    SftSample,
};
pub use dispatch::{inline_samples_within_budget, INLINE_DATASET_BUDGET_BYTES};
pub use library::{scan_learned_skills, LearnedSkill};
pub use reward::parse_reward;
pub use score::{score_buffer, sweep_into_buffer};
pub use skill_md::{build_skill_md, slugify, SkillProvenance};
pub use skills_dir::SkillsDir;
pub use synth::{
    run_skills_pass, synthesize_skill, write_synthesized_skill, write_synthesized_skill_in,
    SynthOutcome,
};

#[cfg(test)]
mod config_test;
#[cfg(test)]
mod cycle_test;
#[cfg(test)]
mod dispatch_test;
#[cfg(test)]
mod harness_test;
#[cfg(test)]
mod library_test;
#[cfg(test)]
mod reward_test;
#[cfg(test)]
mod run_model_test;
#[cfg(test)]
mod score_test;
#[cfg(test)]
mod skill_md_test;
#[cfg(test)]
mod skills_dir_test;
#[cfg(test)]
mod synth_test;
#[cfg(test)]
mod synth_write_test;
#[cfg(test)]
mod transcript_test;

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
    pub fn new(
        store: ExperienceStore,
        host: Arc<dyn LearningHost>,
        client: reqwest::Client,
    ) -> Self {
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
    completion_text(&v)
}

/// Finish reasons of a completion that ended on its own.
const NORMAL_FINISH_REASONS: &[&str] = &["stop", "end_turn", "eos"];

/// The reply text of a BYO OpenAI-compatible completion, or an error when the
/// model did not finish normally. A provider refusal, a content filter, a
/// length cut or a missing finish reason is never handed on as a verdict: a
/// truncated `0.95` that reads `0.9`, or a filtered synthesis, is no answer.
fn completion_text(v: &Value) -> Result<String, String> {
    let choice = &v["choices"][0];
    if choice["message"]["refusal"]
        .as_str()
        .is_some_and(|refusal| !refusal.trim().is_empty())
    {
        return Err("model refused".to_string());
    }
    let finish = choice["finish_reason"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !NORMAL_FINISH_REASONS.contains(&finish.as_str()) {
        return Err(format!("model stopped abnormally ({finish:?})"));
    }
    Ok(choice["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}
