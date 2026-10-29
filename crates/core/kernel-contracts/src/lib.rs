//! # ryu-kernel-contracts — the pure-data manifest contract
//!
//! The single source of truth for the `manifest.json` manifest model: the types an
//! app/plugin author declares, the [`runnable`] kind discriminant, the per-kind
//! [`schema`] config shapes, and the validation + capability-labelling functions.
//!
//! This crate is **pure data + validation**: serde/schemars/semver only, no I/O,
//! no runtime, no `ServerState`. It exists to end the historical drift between
//! `apps/core`'s `plugin_manifest`/`runnable` modules and the Ryu SDK's
//! hand-maintained copy — both now re-export these one definitions.
//!
//! Every serde-facing shape reachable from [`manifest::PluginManifest`] also
//! derives [`schemars::JsonSchema`], so a JSON Schema for `manifest.json` can be
//! emitted for languages that validate manifests without a Rust FFI binding.

pub mod avatar;
pub mod host_api;
pub mod manifest;
pub mod runnable;
pub mod schema;
pub mod tenancy;

// ── Root re-exports (the headline surface) ────────────────────────────────────

pub use host_api::HOST_API_VERSION;
pub use manifest::{
    canonical_plugin_id, cookie_namespace_prefix, is_app_event, is_env_var_name,
    is_kernel_event_id, kernel_event, kernel_event_in, parse_min_version, plugin_dir_name,
    split_hook_event_id, validate_cli_command_path, validate_event_subscription,
    validate_forwarded_cookie_names, validate_hook_event, validate_plugin_id, AppDependency,
    CompanionSurface, CompatibilityVerdict, Contributes, ContributionId, EnginesReq,
    EventSubscription, HookEventContribution, HookMatch, HookMode, HostVersions, KernelEventSpec,
    PluginManifest, PluginTier, Requires, Surface, TurnHookContribution, UnmetRequirement,
    WidgetContribution, HOOK_EVENT_SEPARATOR, KERNEL_EVENTS, KERNEL_EVENT_OWNER,
    LEGACY_PLUGIN_ID_ALIASES, MAX_PLUGIN_ID_LEN, MAX_SECRET_KEY_LEN, RUNS_FAILURES_GRANT,
};
pub use runnable::{RunnableKind, RunnableMeta};
pub use schema::{
    capabilities_from_grants, capability_label, label_impersonates_system_chrome,
    parse_sandbox_path, validate_runnable, validate_sidecar_spec, AgentConfig, AssetSpec,
    BinarySpec, ChannelConfig, CompanionConfig, CompanionCsp, EngineConfig, ExternalRuntimeConfig,
    ManifestAgentIdentityMode, ModelSnapshotSpec, PolicyConfig, RunnableEntry, SandboxPathBase,
    SandboxPathRef, SidecarProcess, SidecarSandboxFs, SidecarSandboxMode, SidecarSandboxSpec,
    SidecarSpec, SkillConfig, SourceArchiveSpec, ToolBackend, ToolConfig, WorkflowConfig,
    AGENT_CONFIG_FORBIDDEN_ACCOUNT_ACCESS, SUPPORTED_ARCHIVE_FORMATS,
};
pub use tenancy::ResourceKey;
