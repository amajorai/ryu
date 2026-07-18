# ryu-kernel-contracts

The single, pure-data definition of the `plugin.json` manifest model — the types
an app/plugin author declares, plus their validation and capability-labelling
logic. Shared verbatim by `apps/core` and the Ryu SDK so the two can never drift.

## Role in the decomposition

A **leaf contract crate** (L0): serde / schemars / semver only — no I/O, no
runtime, no `ServerState`, ZERO dependency on `apps/core`. It exists to end the
historical drift between Core's old `plugin_manifest`/`runnable` modules and the
SDK's hand-maintained copy; both now re-export these one definitions.

Every serde-facing shape reachable from `PluginManifest` also derives
`schemars::JsonSchema`, so a JSON Schema for `plugin.json` can be emitted for
non-Rust manifest validators (see `schemas/`).

## Key modules

- `manifest` — `PluginManifest` and the author-facing surface: `Requires`,
  `Contributes`, `Surface`, `AppDependency`, `EnginesReq`, `TurnHookContribution`,
  `WidgetContribution`, `PluginTier`, plus validators (`validate_plugin_id`,
  `validate_cli_command_path`, `parse_min_version`).
- `runnable` — `RunnableKind` (the 8-variant discriminant) + `RunnableMeta`.
- `schema` — per-kind config shapes (`AgentConfig`, `ToolConfig`, `WorkflowConfig`,
  `SkillConfig`, `EngineConfig`, `ChannelConfig`, `CompanionConfig`,
  `SidecarSpec`/`SidecarProcess`, …) and the capability seam:
  `capabilities_from_grants`, `capability_label`, `validate_runnable`,
  `validate_sidecar_spec`.
- `host_api` — `HOST_API_VERSION`, the host↔plugin API version handshake.
- `tenancy` — `ResourceKey`, the org/resource identity used by ACL enforcement.

## How it is consumed

Compiled-into-core (and into the SDK) as a non-optional path dependency;
re-exported so callers see one definition. Not a sidecar — it carries no runtime.

## Swap seam

None at runtime — this *is* the contract. Its versioning is the compatibility
seam: `HOST_API_VERSION` and `parse_min_version` gate which manifests a given
host will load, so the schema can evolve without breaking older plugins.
