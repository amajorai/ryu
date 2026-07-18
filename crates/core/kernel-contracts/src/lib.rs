//! # ryu-kernel-contracts — the pure-data manifest contract
//!
//! The single source of truth for the `plugin.json` manifest model: the types an
//! app/plugin author declares, the [`runnable`] kind discriminant, the per-kind
//! [`schema`] config shapes, and the validation + capability-labelling functions.
//!
//! This crate is **pure data + validation**: serde/schemars/semver only, no I/O,
//! no runtime, no `ServerState`. It exists to end the historical drift between
//! `apps/core`'s `plugin_manifest`/`runnable` modules and the Ryu SDK's
//! hand-maintained copy — both now re-export these one definitions.
//!
//! Every serde-facing shape reachable from [`manifest::PluginManifest`] also
//! derives [`schemars::JsonSchema`], so a JSON Schema for `plugin.json` can be
//! emitted for languages that validate manifests without a Rust FFI binding.

pub mod host_api;
pub mod manifest;
pub mod runnable;
pub mod schema;
pub mod tenancy;

// ── Root re-exports (the headline surface) ────────────────────────────────────

pub use host_api::HOST_API_VERSION;
pub use manifest::{
    parse_min_version, validate_cli_command_path, validate_plugin_id, AppDependency,
    CompanionSurface, Contributes, ContributionId, EnginesReq, HookMatch, PluginManifest,
    PluginTier, Requires, Surface, TurnHookContribution, WidgetContribution, MAX_PLUGIN_ID_LEN,
};
pub use runnable::{RunnableKind, RunnableMeta};
pub use tenancy::ResourceKey;
pub use schema::{
    capabilities_from_grants, capability_label, label_impersonates_system_chrome,
    validate_runnable, validate_sidecar_spec, AgentConfig, AssetSpec, BinarySpec, ChannelConfig,
    CompanionConfig, CompanionCsp, EngineConfig, ExternalRuntimeConfig, PolicyConfig, RunnableEntry,
    SidecarProcess, SidecarSpec, SkillConfig, SourceArchiveSpec, ToolBackend, ToolConfig,
    WorkflowConfig, SUPPORTED_ARCHIVE_FORMATS,
};
