#![recursion_limit = "256"]

mod a2a;
mod acl;
mod acp_agent_settings;
mod acp_runtime;
mod activity;
mod agent_access;
mod agent_control;
mod agent_execution;
mod agent_routing;
mod agent_sandbox;
mod agent_selection;
mod agent_teams;
mod agents;
mod annotation_queues;
mod approvals;
mod atomic_file;
mod auth;
mod authorization;
mod background_processes;
mod capabilities;
mod catalog;
mod catalog_source;
mod claude_config;
mod codex_config;
mod collab_host;
mod composio_host;
mod connection_policy;
// Composio integration orchestration lives in the extracted `ryu-composio`
// crate; these aliases keep the in-tree `crate::composio_*` call sites unchanged.
// The workflow/agent-engine fan-out (`run_workflow_for_trigger`/`run_agent`)
// stays in Core as `composio_host` (kernel glue).
pub(crate) use ryu_composio::auth as composio_auth;
pub(crate) use ryu_composio::catalog as composio_catalog;
pub(crate) use ryu_composio::connect as composio_connect;
pub(crate) use ryu_composio::triggers as composio_triggers;
mod backups;
mod config_file;
mod connections;
mod crash;
mod crypto_host;
mod dashboard_capabilities;
mod data_path;
mod dev_execution;
/// The `document.parse` extraction facade. Shipped in `9bf1e2023` **without a
/// `mod` line**, so it was never in the module tree and never compiled — the
/// deepest form of the gap it was written to close. Declared here so
/// [`space_file_index`] can call it.
mod document_parse;
mod downloads;
mod entitlement;
mod events;
mod exec_approval;
mod execution_control;
/// Derived app-API tools: an installed app's own OpenAPI document lowered into
/// `ryu_ext.*` tools addressed through the ext-proxy. Sibling of [`self_api`],
/// which does the same for Core's own generated document.
mod ext_api;
mod fal_auth;
mod fleet;
mod gaming;
mod governance;
mod hardware;
mod hf_auth;
mod identity;
mod identity_verify;
mod image_host;
/// Scan a user-picked local folder and import the *setup* it contains (agent
/// instructions, skills, MCP servers, plugins, Claude project memories) into
/// Ryu's own stores — the setup-side companion to [`native_history`].
mod import;
mod inference;
mod learning;
mod local_egress;
mod lsp;
/// Telegram "managed bots" (Bot API 9.6) pairing: how a per-user child bot's token
/// reaches this node without the user ever visiting @BotFather. Client for the
/// hosted manager (`apps/cloud-bot`) plus the pending-pairing store; the HTTP
/// surface lives in [`server::managed_bot_api`].
mod managed_bot;
mod memory_host;
mod memory_policy;
mod memory_provider;
mod required_update_runtime;
mod sandbox_host;
/// Re-export shim: the MCP server catalog primitive now lives in the
/// `ryu-mcp-catalog` crate. Consumers reference
/// `crate::mcp_catalog::{ServerJson, InstallPlan, plan_from_server, …}`
/// unchanged; the crate's one cross-cutting kernel coupling (the SSRF-guarded
/// registry fetch) inverts through [`mcp_catalog_host`].
pub use ryu_mcp_catalog as mcp_catalog;
mod mcp_catalog_host;
mod mcp_oauth;
mod meeting_capabilities;
mod mesh_host;
mod midnight_wipe;
/// OpenAPI/Swagger spec → `http`-backed tool descriptors (integrations.sh REST
/// install-abstraction). Pure transform; install/persist wiring lives in `server`.
mod openapi_import;
/// Re-export shim: the Hugging Face model catalog + device-fit primitive now
/// lives in the `ryu-model-catalog` crate. Consumers reference
/// `crate::model_catalog::{ModelCard, install_from_descriptor, device, …}`
/// unchanged; the crate's cross-cutting kernel couplings invert through
/// [`model_catalog_host`].
pub use ryu_model_catalog as model_catalog;
mod model_catalog_host;
/// Re-export shim: the model weight-format primitive (`ModelFormat` + the pure
/// format→engine capability tables) now lives in the `ryu-model-format` crate.
/// Consumers reference `crate::model_format::{ModelFormat, engines_for_format, …}`
/// unchanged.
pub use ryu_model_format as model_format;
mod native_history;
mod needle;
mod needle2;
mod needle3;
mod node_token;
mod notify;
mod org_policy;
mod usage_history;
/// Re-export shim: the Open Knowledge Format (OKF) primitive now lives in the
/// `ryu-knowledge` crate. Consumers reference `crate::okf::{Bundle, Concept, …}`
/// unchanged.
pub use ryu_knowledge as okf;
#[cfg(test)]
mod app_boundary_guard;
mod app_security;
mod dictation;
mod log_rotation;
mod offline_test_bootstrap;
mod openrouter_auth;
mod pairing;
mod paths;
mod payment;
mod pi_config;
mod plugin_evals;
mod plugin_host;
mod plugin_manifest;
mod plugin_secrets;
mod plugin_storage;
mod plugins;
mod policy_alerts;
mod portable_packages;
mod predict;
mod predict_host;
mod presence;
mod privacy;
mod profile;
/// Signed-in once-a-day "used Ryu today" ping behind the profile streak.
mod profile_activity;
mod prompt_evals;
mod provider_pins;
mod rag_host;
mod recipes_host;
mod registry;
mod replicate_auth;
mod routing_policy;
mod rtk_config;
/// Raises the `core#run.failed` kernel event for failed agent, scheduled-job and
/// workflow runs (the Self-Healing extraction; no consumer is named in Core).
mod run_failures;
mod runnable;
mod ryu_analytics;
mod ryu_platform;
mod safe_actions;
/// The OS-style "boot with the extension layer off" switch (apps, plugins,
/// skills, user MCP servers, the scheduler). Resolved once, below, BEFORE
/// anything it suppresses has a chance to spawn.
mod safe_mode;
mod scheduler;
mod search_host;
mod self_api;
mod server;
mod sidecar;
mod skills_catalog;
mod skills_host;
mod smtp_auth;
/// The one path that puts an uploaded file's *contents* into a Space index —
/// `create_file` + [`document_parse`] + a durable per-document index status.
mod space_file_index;
mod stats_beacon;
mod stt_host;
/// Provider → saved accounts → usage: the one owner of subscription account
/// listings and per-account usage readings for every Core surface.
mod subscriptions;
mod support_access;
mod system_info;
mod telemetry;
mod tool_exec;
mod tool_registry_host;
mod treg_catalog;
mod update;
mod usage_host;
mod vault;
mod voice;
mod webhook_ingress;
mod webhook_ingress_host;
mod win_process;
mod workflow;
mod workspace_trust;

/// Report an unrecoverable boot failure as a clean one-line message on stderr and
/// exit non-zero — instead of `panic!`, which dumps a Rust backtrace that reads as a
/// crash to a user. Used only for the fail-fast boot paths in `main` (opening a data
/// store, binding the listen socket), where the process genuinely cannot continue but
/// the cause (port already in use, corrupt/locked data file) is an operator condition,
/// not a bug. Expands to `!` so it drops into `match`/`unwrap_or_else` arms unchanged.
macro_rules! boot_fail {
    ($($arg:tt)*) => {{
        crate::log_rotation::write_diagnostic(format!("ryu-core: {}", format_args!($($arg)*)));
        // `process::exit` skips destructors: flush consented OTLP spans first.
        crate::telemetry::shutdown();
        std::process::exit(1);
    }};
}

mod boot;

use boot::core_main;

fn main() {
    // The agent sandbox runner enters Linux namespaces, which only a
    // single-threaded process may do, so it must run before the async runtime
    // starts its worker threads. It execs the agent and never returns here.
    //
    // It deliberately runs before `protect_privileged_process_environment`
    // (in `core_main`), and that order costs no protection: the runner holds no
    // Core secret (it opens no store and loads no Gateway credential; its
    // environment is exactly the one its parent Core already scrubbed for the
    // agent, which `exec` hands to the agent unchanged), and `exec` resets the
    // dumpable flag anyway. The parent Core protects itself in `core_main` before
    // it can spawn any runner. Making the runner non-dumpable first would instead
    // break it: a non-dumpable process cannot write its own
    // `/proc/self/{setgroups,uid_map}`, so the user namespace would fail.
    if crate::agent_sandbox::run_if_requested() {
        return;
    }
    // Agent turns build deep async futures; the 2 MiB default worker stack
    // overflowed on the scheduled patrol run and aborted Core. Matches the
    // 16 MiB the runtime tests set through RUST_MIN_STACK.
    tokio::runtime::Builder::new_multi_thread()
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("building the Core async runtime")
        .block_on(core_main());
}
