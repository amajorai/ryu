//! Core's HTTP server: `ServerState`, the router, and every route handler.
//!
//! The handlers live in responsibility submodules (one directory per surface)
//! that are glob re-exported below, so every `crate::server::<item>` path is
//! unchanged. Each submodule file starts with `use crate::server::*;`, which
//! brings in the imports declared here and every sibling item.

#[cfg(test)]
#[path = "activation_package_runtime_test.rs"]
mod activation_package_runtime;
#[cfg(test)]
#[path = "catalog_package_cards_runtime_test.rs"]
mod catalog_package_cards_runtime;
#[cfg(test)]
#[path = "output_styles_package_runtime_test.rs"]
mod output_styles_package_runtime;

use crate::win_process::NoWindow;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

pub mod account_warmup;
pub(crate) mod acp_inference_proxy;
pub mod acp_tool_broker;
pub mod activity_api;
mod agent_routing_cleanup;
pub mod agent_sync;
pub mod annotation_queues_api;
mod app_bundle_guard;
pub mod approvals_api;
pub mod auto_title;
mod backups;
pub mod canvas_migrate;
pub mod catalog_scan;
pub mod chat_checkpoints;
pub mod chat_suggestions;
pub mod chatgpt_api;
pub mod chatgpt_plan_api;
pub mod claude_api;
mod cloud_environments;
mod cloud_github_transport;
pub(crate) mod cloud_tasks;
mod cloud_web_search;
pub mod composer_predictions;
pub mod connect_events;
pub mod context_handoff;
pub mod continuity;
pub mod conversation_history;
pub mod conversation_lifecycle;
pub mod conversations;
pub mod core_identity;
pub mod data_admin;
mod data_path_api;
pub mod encryption;
mod gateway_cloud_speech_accounts;
pub(crate) mod gateway_phone_calls;
mod gateway_speech_settings;
mod gateway_web_accounts;
pub mod gifs;
pub mod git;
pub mod governance;
pub mod harness;
pub mod hierarchy_api;
pub mod hooks;
pub mod host_hierarchy;
pub mod kiro_api;
pub mod mcp_events;
mod mcp_forms;
pub mod native_accounts;
pub mod qoder_api;
pub mod recommendations;
mod scheduled_agent_access;
mod sdk_accounts;
pub(crate) mod security_key_relay;
pub(crate) mod session_box;
pub(crate) mod subscription_cloud;
pub(crate) mod tool_ingress_authority;
mod workflow_access;
// The device-registry + TRMNL display HTTP surface moved to the extracted
// `ryu_hardware` crate (`ryu_hardware::api`); the public pairing ingress + the WS
// link stay Core-side (kernel ingress that forwards to the crate).
pub mod hardware_public;
pub mod hardware_ws;
// The `chat.startTurn` kernel capability: the ONE way an out-of-process app posts a
// turn on the user's behalf. Names no app — it is a host primitive, reached through
// the generic capability broker.
pub mod host_chat;
pub mod model_stream;
// Healing is OUT-OF-PROCESS: the `ryu-healing` sidecar owns the diagnose→propose
// engine, the per-source attempt cap, the `healing.*` prefs, the Gateway diagnosis,
// and the `/api/healing/*` surface (served via `public_mount`). Core knows no
// healing: it raises `core#run.failed` (`crate::run_failures`) and exposes the
// grant-gated run-recovery kernel capabilities (`app_runs`) the sidecar acts through.
pub mod agent_ui_templates;
pub mod identity_api;
pub mod images;
pub mod improvement_api;
pub mod language_packs;
pub mod learning;
pub mod managed_bot_api;
pub mod mcp_app_extensions;
pub mod mcp_oauth_api;
pub mod mcp_oauth_confirm_api;
pub mod media;
pub mod memory_dream;
pub mod memory_git;
pub mod memory_reflect;
pub mod memory_working;
mod node_lifecycle_routes;
pub mod optimizer_api;
pub mod prompt_registry;
pub(crate) mod retrieval_expansion;
pub mod trace_api;
pub mod uploads;
/// Re-export of the extracted [`ryu_memory`] crate under the historical
/// `server::memory` path. The long-term memory store, scope model, and recall now
/// live in `crates/ryu-memory`; the Core-coupled default constructor lives in
/// [`crate::memory_host`]. This alias keeps the ~19 `memory::`-qualified call
/// sites in Core unchanged (re-export shim, zero business logic).
pub use ryu_memory as memory;
pub mod app_egress;
pub mod app_email;
pub(crate) mod app_file_notes;
pub(crate) mod app_mcp_call;
pub mod app_notify;
// Short-lived, path-scoped delegations to one app's routes (C3).
pub(crate) mod app_route_delegation;
pub(crate) mod app_route_delegation_api;
// Per-member revocation of app route delegations (member removal, owner).
pub(crate) mod app_route_revocation;
pub(crate) mod app_route_revocation_api;
// Per-member app data purge fan-out (account deletion, member removal).
pub(crate) mod data_user_purge;
// The control plane's purge delegation, admitted on the purge route only.
pub(crate) mod data_purge_delegation;
// Nodes pull queued purges the control plane could not push to them.
pub(crate) mod data_purge_pull;
pub(crate) mod data_purge_pull_worker;
// Run recovery (`approvals.request`, `runs.rerunAgent`, `workflows.rerun`): the
// grant-gated kernel capabilities a `core#run.failed` subscriber acts through.
pub mod app_runs;
// Safe Actions plan review for a Companion: bridge-only, under the verified user.
pub(crate) mod app_chat_send;
pub(crate) mod app_safe_actions;
pub mod app_warmup;
pub mod app_webhooks;
// The shared error and reply decoding for the in-process `app_*` operations.
pub mod app_tool_usage;
pub(crate) mod kernel_op;
#[cfg(test)]
mod marketplace_catalog_cursor_tests;
pub mod marketplace_license_watch;
#[cfg(test)]
pub(crate) mod multiplayer_journey_tests;
pub mod notifications_api;
pub mod onboarding_profile;
pub mod onboarding_state;
pub mod openapi;
pub mod plugin_bridge_api;
pub mod plugin_rollback;
pub mod plugin_uninstall;
mod plugin_update_deps;
pub mod portable_package_runtime;
pub mod preferences;
pub mod provider_router;
pub mod realtime_ws;
pub mod rules;
pub mod run_auto_resume;
pub mod shadow_proxy;
pub mod space_portable;
/// Re-export shim: `crate::server::retrieval` is the extracted [`ryu_rag`] crate.
/// Provider/model selection lives in [`crate::rag_host`] (the single resolver);
/// this alias keeps the many `retrieval::`-qualified reference sites unchanged.
pub use ryu_rag as retrieval;
pub mod agent_composio_api;
pub mod agent_launch_check_api;
mod local_egress_api;
pub(crate) mod oauth_pool_policy;
pub(crate) mod oauth_pool_usage;
pub mod presence_api;
pub mod routing_api;
mod space_imports;
pub mod spaces;
pub mod subscription_costs;
pub mod sync;
mod trace_context;
pub mod usage_api;
pub mod usage_review;
pub mod vault_agent_accounts_api;
pub mod vault_api;
pub mod vault_audit_events_api;
pub mod vault_broker_api;
pub mod vault_compat_api;
pub mod vault_crypto_api;
pub mod vault_engines_api;
pub mod vault_external_api;
pub mod vault_items_api;
pub mod vault_kv_api;
pub mod vault_pm_api;
pub mod vault_policy_ext_api;
pub mod vault_seal_dynamic_api;
pub mod vault_tokens_api;
pub mod vault_totp_pwpolicy_api;
pub mod voice;
pub mod voice_ws;
pub mod widgets;
pub mod ws_ticket;

// The git/worktree engine moved to the `ryu-workspace` crate; alias it so the
// in-file `worktree::…` references (WorktreeRun's diff/guard, the apply handler)
// keep working unchanged.
use ryu_workspace::worktree;

use crate::agents::{AgentStore, AgentTemplate, CreateAgent, UpdateAgent};
use crate::auth::AuthState;
use crate::plugins::PluginStore;
use crate::sidecar::adapters::{
    route_chat_stream, run_proactive_opening_text, run_reply_text, run_team_reply_text,
    AcpAgentRegistry, ChatStreamRequest, UiContent, UiMessage,
};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::onboarding::SetupManager;
use crate::sidecar::{install_state::InstallStatusStore, SidecarManager};
use conversations::{ChannelTurnClaim, ChannelTurnReplay, ConversationStore, SessionStatus};
use memory::MemoryStore;
use preferences::PreferencesStore;
use retrieval::{ChunkSource, RetrievalStore};
use ryu_skills::SkillRegistry;
use ryu_tracing::TraceStore;
use spaces::SpaceStore;

tokio::task_local! {
    /// Whether the HTTP request currently being served came from a trusted local
    /// peer ([`is_trusted_local_peer`]). Set by the auth middleware for the whole
    /// handler future; absent for in-process work that is not an HTTP request.
    static REQUEST_PEER_IS_LOCAL: bool;
}

tokio::task_local! {
    /// Whether the HTTP request currently being served was admitted with this
    /// node's own owner token ([`presents_owner_token`]) rather than a user
    /// JWT, a paired token, or a delegation. Set by the auth middleware next to
    /// [`REQUEST_PEER_IS_LOCAL`].
    static REQUEST_PRESENTS_OWNER_TOKEN: bool;
}

tokio::task_local! {
    /// Whether the bearer that admitted the HTTP request currently being served
    /// is itself a verified Better Auth user JWT ([`bearer_is_user_jwt`]). Set
    /// by the auth middleware next to [`REQUEST_PRESENTS_OWNER_TOKEN`].
    static REQUEST_BEARER_IS_USER_JWT: bool;
}

#[cfg(test)]
mod workflow_version_revision_tests;

#[cfg(test)]
mod approvals_decision_runtime_test;

#[cfg(test)]
mod calendar_routine_runtime_test;

#[cfg(test)]
mod heartbeat_app_jobs_test;

#[cfg(test)]
mod agent_account_access_test;

#[cfg(test)]
mod chat_export_import_test;
#[cfg(test)]
mod companion_surface_tests;
#[cfg(test)]
mod core_policy_route_auth_test;
#[cfg(test)]
mod gateway_operator_reads_permission_test;
#[cfg(test)]
mod gateway_tool_member_layer_test;
#[cfg(test)]
mod hardware_pairing_routes_test;
#[cfg(test)]
mod native_thread_import_identity_test;
#[cfg(test)]
mod pi_login_gate_test;
#[cfg(test)]
mod preferences_routes_runtime_test;
#[cfg(test)]
mod privacy_preferences_runtime_test;
#[cfg(test)]
mod setup_import_content_revision_test;
#[cfg(test)]
mod spaces_backlinks_test;
#[cfg(test)]
mod vault_public_routes_auth_test;

mod request_auth;
pub use request_auth::*;
mod access_gate;
pub(crate) use access_gate::*;
mod acl_plane;
pub(crate) use acl_plane::*;
mod http_router;
pub use http_router::*;
mod node_settings;
use node_settings::*;
mod chat_api;
pub use chat_api::*;
mod acp_agents;
pub(crate) use acp_agents::*;
mod chat_controls;
pub(crate) use chat_controls::*;
mod device_tools_api;
use device_tools_api::*;
mod channel_runs;
use channel_runs::*;
mod memory_api;
pub(crate) use memory_api::*;
mod plugin_diagnostics;
use plugin_diagnostics::*;
mod app_catalog;
pub use app_catalog::*;
mod app_lifecycle;
pub use app_lifecycle::*;
mod app_updates;
pub(crate) use app_updates::*;
mod agent_catalog;
use agent_catalog::*;
mod prompt_studio;
use prompt_studio::*;
mod provider_logins;
use provider_logins::*;
mod conversation_api;
pub(crate) use conversation_api::*;
mod conversation_features;
pub(crate) use conversation_features::*;
mod session_imports;
pub(crate) use session_imports::*;
mod mcp_servers;
use mcp_servers::*;
mod mcp_tools;
pub(crate) use mcp_tools::*;
mod mcp_network;
use mcp_network::*;
mod tool_catalog;
use tool_catalog::*;
mod mesh_webhooks;
pub(crate) use mesh_webhooks::*;
mod spaces_api;
pub(crate) use spaces_api::*;
mod model_catalog;
pub(crate) use model_catalog::*;
mod catalog_sources;
pub(crate) use catalog_sources::*;
mod skills_catalog;
use skills_catalog::*;
mod sidecar_admin;
use sidecar_admin::*;
mod gateway_config;
pub(crate) use gateway_config::*;
mod gateway_providers;
use gateway_providers::*;
mod gateway_observability;
use gateway_observability::*;
mod workflow_api;
pub(crate) use workflow_api::*;
mod scheduled_jobs;
pub(crate) use scheduled_jobs::*;
mod dependency_installs;
use dependency_installs::*;
mod pairing_acl;
pub(crate) use pairing_acl::*;

#[cfg(test)]
pub(crate) mod tests;
