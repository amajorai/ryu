//! Chat-to-memory decomposition for the Memory app.
//!
//! Chat messages are source material, not durable memories. This module gives
//! Dream a bounded, visibility-filtered view of recent chats, asks the configured
//! side model for structured facts, and stores those facts as encrypted proposals.
//! Nothing enters the long-term memory set until the user accepts it.
//!
//! The pieces live in submodules: `routes` (HTTP handlers and accept/reject),
//! `sources` (recent chat loading), `prompt` (system prompt, model choice and
//! output parsing), `candidates` (one review run: filter, dedupe and store
//! proposals), `proposal_draft` (one candidate into a proposal with its
//! confidence and source excerpts), `reconcile` (related existing memories in,
//! revisions of them out), `run_state` (the watermark that lets an
//! idle automatic tick skip the model), `automatic` (settings and the opt-in
//! scheduler) and `wire` (response bodies).

use std::time::Duration;

mod automatic;
mod candidates;
mod prompt;
mod proposal_draft;
mod reconcile;
mod routes;
mod run_state;
mod sources;
mod wire;

pub(super) use automatic::is_quiet_hour;
pub(crate) use automatic::spawn_automatic_review;
#[cfg(test)]
use prompt::dream_prompt;
// OpenAPI resolves each handler through its generated `__path_*` item.
pub(super) use routes::{
    __path_accept_dream_proposal, __path_get_dream_review, __path_get_dream_settings,
    __path_reject_dream_proposal, __path_run_dream_review, __path_update_dream_settings, routes,
};

const DREAM_AUTOMATIC_PREF: &str = "memory-dream-automatic";
const DREAM_QUIET_START_PREF: &str = "memory-dream-quiet-start";
const DREAM_QUIET_END_PREF: &str = "memory-dream-quiet-end";
const DREAM_MODEL_PREF: &str = "memory-dream-model";
const DREAM_EFFORT_PREF: &str = "memory-dream-effort";
const DREAM_LAST_SOURCE_AT_PREF: &str = "memory-dream-last-source-at";
const DREAM_LAST_RUN_PREF: &str = "memory-dream-last-run";

const DREAM_MAX_CONVERSATIONS: usize = 8;
const DREAM_MESSAGES_PER_CONVERSATION: usize = 24;
const DREAM_MAX_TRANSCRIPT_CHARS: usize = 48_000;
const DREAM_MAX_MEMORY_CHARS: usize = 600;
const DREAM_MAX_REASON_CHARS: usize = 400;
const DREAM_MAX_WHEN_TO_USE_CHARS: usize = 240;
const DREAM_MAX_TAG_CHARS: usize = 40;
const DREAM_MAX_SOURCE_IDS: usize = 12;
const DREAM_MAX_RELATED_MEMORIES: usize = 40;
const DREAM_MAX_RELATED_MEMORY_CHARS: usize = 8_000;
const DREAM_AUTOMATIC_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[path = "../memory_dream_language.rs"]
mod language;

#[cfg(test)]
#[path = "../memory_dream_language_tests.rs"]
mod language_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod hygiene_tests;

#[cfg(test)]
mod reconcile_tests;
