//! Core-owned onboarding profile bootstrap.
//!
//! The desktop owns the consent and progress UI; Core owns the job boundary so
//! eligibility, conversation materialisation, and memory writes cannot be
//! bypassed by a client. Connected sources are only read through the agent's
//! existing tools and are explicitly framed as untrusted input in the prompt.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};

use anyhow::Context;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use utoipa::ToSchema;

use super::{conversations::Tenancy, ServerState};
use crate::server::onboarding_state::{NodeOnboardingState, NodeSetupKind};

const MAX_ID_COUNT: usize = 200;
const MAX_AGENT_SUGGESTIONS: usize = 4;
const MAX_PROFILE_JOBS: usize = 64;
const MAX_PROFILE_JOBS_PER_OWNER: usize = 2;
const PROFILE_JOB_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const PROFILE_JOB_RETENTION_MS: i64 = 60 * 60 * 1000;
/// How long a cancelled draft may take to stop its model turn before the
/// driver gives up waiting and releases the job's slot anyway.
const PROFILE_DRAFT_CANCEL_GRACE: Duration = Duration::from_secs(30);
/// How often a cancelled draft re-signals its turn. Repeating the signal covers
/// a cancel that lands before the agent has registered the turn it could stop.
const PROFILE_DRAFT_CANCEL_RESIGNAL: Duration = Duration::from_millis(250);
/// Conversation ids of profile drafts still in flight. A draft's turn persists
/// into its reserved conversation, so a Core that exits mid-draft would leave a
/// half-built profile chat behind; [`sweep_abandoned_profile_drafts`] removes
/// whatever this list still names at the next startup.
const PENDING_PROFILE_DRAFTS_PREF: &str = "onboarding-profile-pending-drafts";

/// Tool ids the profile builder may place in a generated agent recipe. These
/// are stable, first-party Ryu tools rather than arbitrary ids copied from an
/// email, document, or MCP listing. A missing provider still fails closed at
/// runtime; the recipe never widens the agent beyond this set.
const RECOMMENDED_AGENT_TOOLS: &[&str] = &[
    "search_conversations.search",
    "memory.search",
    "memory.store",
    "spaces.search",
    "spaces.list_documents",
    "web.search",
    "web.extract",
    "web.crawl",
    "workspace.open_tab",
    "workspace.open_panel",
    "routines.list",
    "routines.create",
    "skills.search",
    "skills.load",
];

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartBody {
    #[serde(default)]
    cloud_selection: Option<serde_json::Value>,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    imported_conversation_ids: Vec<String>,
    #[serde(default = "default_recent_days")]
    recent_days: u32,
    #[serde(default)]
    share_user_org: bool,
}

fn default_recent_days() -> u32 {
    90
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobState {
    Building,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProfileOnboardingSnapshot {
    company_context: String,
    company_knowledge_enabled: bool,
    setup_kind: NodeSetupKind,
}

/// The validated, caller-bound inputs a profile build runs with. Captured once
/// at `start` so the detached build never re-reads request state.
#[derive(Debug, Clone)]
struct ProfileJobInputs {
    onboarding: ProfileOnboardingSnapshot,
    composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    owner_user_id: String,
    org_id: String,
    input: StartBody,
}

/// One onboarding profile build.
///
/// The build starts as soon as the job is created. It runs in two phases:
/// drafting (source reads and the model turn, which persists into the
/// owner-scoped profile conversation and stays cancellable through `cancel`)
/// and materialisation (the profile memory, after which the conversation is
/// kept). `materialized` flips under the job lock right before the second
/// phase, so a cancel either withdraws the draft, stopping its turn and
/// deleting its conversation, or is refused because writing has begun.
/// `background` records only that the user chose to leave the progress view;
/// it never gates the build. `driver_active` stays set until the job's driver
/// has returned, so a cancelled job whose model turn is still stopping keeps
/// counting against the per-owner and node caps.
#[derive(Debug, Clone)]
struct ProfileJob {
    inputs: ProfileJobInputs,
    state: JobState,
    started_at_ms: i64,
    materialized: bool,
    background: bool,
    cancel_requested: bool,
    cancel: CancellationToken,
    driver_active: bool,
    conversation_id: Option<String>,
    error: Option<String>,
    agent_suggestions: Vec<AgentSuggestion>,
}

/// A reviewable agent recipe derived from the profile bootstrap turn. This is
/// intentionally a draft, not an agent record: Desktop must show it to the
/// user and receive an explicit selection before anything is created.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuggestion {
    pub description: String,
    pub id: String,
    pub name: String,
    pub reason: String,
    pub system_prompt: String,
    pub title: String,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawAgentSuggestion {
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    tools: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProfileModelResponse {
    #[serde(default)]
    profile: String,
    #[serde(default, alias = "agentSuggestions")]
    agent_suggestions: Vec<RawAgentSuggestion>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ProfileJobView {
    agent_suggestions: Vec<AgentSuggestion>,
    /// The user chose to leave the progress view while the build continues.
    background: bool,
    conversation_id: Option<String>,
    error: Option<String>,
    id: String,
    /// Legacy flag for clients that predate `background`: true once the user
    /// chose to leave the progress view or the profile is being (or was)
    /// saved. Read `background` and `state` instead.
    materialized: bool,
    state: &'static str,
    started_at_ms: i64,
}

/// Whether this node may expose onboarding controls that write gateway-level
/// state. A managed node owns this setup centrally, while an org/team-bound
/// self-hosted node has an ACL and must not offer a one-person onboarding flow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOnboardingAccess {
    pub allowed: bool,
    pub managed_node: bool,
    pub reason: &'static str,
    pub scope: Option<crate::sidecar::control_plane::NodeScope>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileAvailability {
    allowed: bool,
    completed: bool,
    reason: &'static str,
}

/// The parsed result of the profile turn, held until it is materialised. The
/// turn itself has already persisted its prompt and reply (with their tool and
/// source parts) into the profile conversation.
#[derive(Debug, Clone)]
struct ProfileDraft {
    agent_id: String,
    agent_suggestions: Vec<AgentSuggestion>,
    profile: String,
}

mod access;
mod drafts;
mod driver;
mod handlers;
mod jobs;
mod reply;

use access::*;
pub(crate) use drafts::sweep_abandoned_profile_drafts;
use drafts::*;
use driver::*;
pub(crate) use handlers::*;
use jobs::*;
use reply::*;

#[cfg(test)]
#[path = "onboarding_profile/access_tests.rs"]
mod access_tests;

#[cfg(test)]
#[path = "onboarding_profile/drafts_tests.rs"]
mod drafts_tests;

#[cfg(test)]
#[path = "onboarding_profile/driver_tests.rs"]
mod driver_tests;

#[cfg(test)]
#[path = "onboarding_profile/handlers_tests.rs"]
mod handlers_tests;

#[cfg(test)]
#[path = "onboarding_profile/jobs_tests.rs"]
mod jobs_tests;

#[cfg(test)]
#[path = "onboarding_profile/reply_tests.rs"]
mod reply_tests;

#[path = "onboarding_profile_language.rs"]
mod language;

#[cfg(test)]
#[path = "onboarding_profile_language_tests.rs"]
mod language_tests;
