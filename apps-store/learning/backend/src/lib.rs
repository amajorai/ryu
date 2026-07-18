//! Continual-learning loop (MetaClaw-style) + experience buffer — extracted Core
//! capability crate.
//!
//! Core owns *what runs* (the chat sessions the loop learns from) and the durable
//! learning artifacts; this crate owns the *logic* of turning those sessions into
//! reusable skills and reward-filtered fine-tune data, plus the durable
//! [`ExperienceStore`] (`experience.db`) it accumulates. See
//! `docs/continual-learning-metaclaw-spec.md`.
//!
//! Pieces, mapped to MetaClaw:
//! - **sweep** — turn persisted conversations into `(user, assistant)` samples
//!   (consent-gated, per-conversation excludable). MetaClaw's experience capture.
//! - **score** — a PRM (judge LLM, configurable, defaults to the Gateway) scores
//!   each sample `[0,1]`. The judge must be *stronger* than the trained model.
//! - **synthesize** — distill a reusable skill from a session and write it to the
//!   skills library (auto-evolution; injects for free via the existing path).
//! - **cycle** — reward-filter the buffer into an SFT dataset derived from the
//!   *original base* model (never a previous merge), the input to the fine-tune
//!   path.
//!
//! ZERO apps/core dependency: every Core-owned callback the loop needs — reading
//! the conversation store, the Gateway PRM/synth side-model, queueing a
//! skill-synthesis approval, reloading the skills registry, dispatching a
//! fine-tune, and the preference store — is inverted through [`LearningHost`]. The
//! lone kernel coupling (the `~/.ryu` data directory, where `experience.db` lives)
//! is inverted through [`init_data_dir`], mirroring `ryu-finetune`.

use std::path::PathBuf;

pub mod api;
pub mod engine;
pub mod host;
pub mod store;

pub use api::{openapi, routes};
pub use engine::{
    build_jsonl, build_skill_md, parse_reward, resolve_base_model, resolve_config, resolve_enabled,
    resolve_excluded, resolve_feedback_down_negative, resolve_feedback_memory_enabled,
    resolve_in_sleep_window, resolve_min_reward, resolve_require_approval, resolve_skill_generation,
    resolve_skills_enabled, run_cycle, run_skills_pass, scheduled_cycle_due, score_buffer, slugify,
    sweep_into_buffer, synthesize_skill, write_synthesized_skill, mark_cycle_ran, CyclePlan,
    LearningConfig, LearningCtx, SftMessage,
    SftSample, SynthOutcome, FEEDBACK_DOWN_NEGATIVE_PREF, FEEDBACK_MEMORY_ENABLED_PREF,
    LEARNING_BASE_MODEL_PREF, LEARNING_ENABLED_PREF, LEARNING_EXCLUDE_PREFIX,
    LEARNING_LAST_CYCLE_PREF, LEARNING_MIN_GAP_HOURS_PREF, LEARNING_MIN_REWARD_PREF,
    LEARNING_PRM_EFFORT_PREF, LEARNING_PRM_KEY_PREF, LEARNING_PRM_MODEL_PREF, LEARNING_PRM_URL_PREF,
    LEARNING_REQUIRE_APPROVAL_PREF, LEARNING_SKILL_GENERATION_PREF, LEARNING_SKILLS_ENABLED_PREF,
    LEARNING_SKILLS_WATERMARK_PREF, LEARNING_SLEEP_END_PREF, LEARNING_SLEEP_START_PREF,
    LEARNING_SYNTH_EFFORT_PREF, LEARNING_SYNTH_MODEL_PREF,
};
pub use host::{ConvMeta, LearningHost, Msg, QueuedApproval};
pub use store::{Experience, ExperienceStore};

/// The crate's data directory (`experience.db` lives under it). Set once at startup
/// from Core (`ryu_dir()`); [`data_dir`] falls back to the system temp dir so unit
/// tests and any pre-init handler never panic. Mirrors `ryu_finetune::data_dir`.
static DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Publish the learning data directory. Idempotent: a second call is ignored.
pub fn init_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// The learning data directory, or the system temp dir when uninitialized.
pub(crate) fn data_dir() -> PathBuf {
    DATA_DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
}
