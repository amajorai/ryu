//! OpenAPI spec for the Core HTTP API, generated from the Axum handlers.
//!
//! Handlers are annotated with `#[utoipa::path(...)]` next to their definition in
//! `server/mod.rs`; this module collects them into one [`ApiDoc`]. As a child of
//! `server`, it can reference the parent's private handler functions (and the
//! `__path_*` items the macro generates beside them).
//!
//! The spec is consumed two ways:
//! - `ryu-core --dump-openapi` prints it (used by `apps/fumadocs` to render the
//!   interactive API reference; see `apps/fumadocs/scripts/generate-docs.ts`).
//! - `GET /api/openapi.json` serves it from a running Core.
//!
//! Adding an endpoint is mechanical: put `#[utoipa::path(...)]` on the handler,
//! then add it to the `paths(...)` list of the sub-doc that owns its area
//! ([`vault`], [`node_agents`], [`runtime`] or [`domains`]); [`api_doc`] merges
//! them. The lists are split by area only to keep each file under the size
//! limits; the merged spec is the same as one list.

use utoipa::OpenApi;

mod domains;
mod node_agents;
mod runtime;
mod vault;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Ryu Core API",
        version = "0.1.0",
        description = "The local Ryu Core orchestration backend. Default bind 127.0.0.1:7980 (override with --bind / RYU_BIND). When RYU_TOKEN is set, protected routes require `Authorization: Bearer <RYU_TOKEN>`; health and auth routes are public.",
        license(name = "Apache-2.0")
    ),
    servers((url = "http://localhost:7980", description = "Local Core")),
    tags(
        (name = "Health", description = "Liveness, version, and updates."),
        (name = "Auth", description = "Device authorization flow."),
        (name = "Nodes", description = "Node initialization."),
        (name = "Backups", description = "Encrypted S3 backups, schedules, retention and recovery for nodes, Spaces and apps."),
        (name = "Sidecars", description = "Engine/tool/agent install + lifecycle."),
        (name = "Models", description = "Model catalog (HF GGUF) + device fit."),
        (name = "Catalog", description = "Per-kind catalog sources."),
        (name = "Skills", description = "Agent Skills install + activation."),
        (name = "Engines", description = "Engine runtimes + active-engine swap."),
        (name = "Plugins", description = "Plugin (app) catalog + lifecycle."),
        (name = "Agents", description = "Agent CRUD, catalog, import/export."),
        (name = "Prompt Evals", description = "Promptfoo-compatible suites, runs, versions, and human review."),
        (name = "Annotation Queues", description = "Human review queues over runs, messages, and traces, with export to prompt suites."),
        (name = "Teams", description = "Agent teams + members."),
        (name = "MCP", description = "MCP servers, tools, catalog, sandbox."),
        (name = "Actions", description = "Canonical governed Action calls."),
        (name = "Tools", description = "Unified tool catalog (search/describe) + PTC exec."),
        (name = "Chat", description = "Chat, channels, delegation."),
        (name = "Retrieval", description = "Chunk indexing + search."),
        (name = "Conversations", description = "Conversations, sessions, and runs."),
        (name = "Harness", description = "Durable, replayable agent sessions and runs."),
        (name = "Spaces", description = "Spaces/RAG documents + embeddings."),
        (name = "Downloads", description = "Download center."),
        (name = "Worktree", description = "Per-run git worktrees."),
        (name = "Gateway", description = "Gateway config/status/audit (proxied)."),
        (name = "Workflows", description = "Workflow DAG engine."),
        (name = "Preferences", description = "Cross-surface preferences KV."),
        (name = "Vault", description = "Encrypted user-managed secret metadata and bindings."),
        (name = "Usage Review", description = "On-demand conversation and activity reviews."),
        (name = "Presence", description = "User availability and presence settings."),
(name = "Activity", description = "Activity API endpoints."),
        (name = "Approvals", description = "Approvals API endpoints."),
        (name = "Clips", description = "Clips API endpoints."),
        (name = "Composio", description = "Composio API endpoints."),
        (name = "Core", description = "Core API endpoints."),
        (name = "Dashboards", description = "Dashboards API endpoints."),
        (name = "Data", description = "Data API endpoints."),
        (name = "Events", description = "Events API endpoints."),
        (name = "Finetune", description = "Finetune API endpoints."),
        (name = "Git", description = "Git API endpoints."),
        (name = "Hardware", description = "Hardware API endpoints."),
        (name = "Healing", description = "Healing API endpoints."),
        (name = "Knowledge", description = "Knowledge API endpoints."),
        (name = "Learning", description = "Learning API endpoints."),
        (name = "Improvement", description = "Recursive-improvement records and lifecycle transitions."),
        (name = "Media", description = "Media API endpoints."),
        (name = "Meetings", description = "Meetings API endpoints."),
        (name = "Memory", description = "Memory API endpoints."),
        (name = "Monitors", description = "Monitors API endpoints."),
        (name = "Notifications", description = "Notifications API endpoints."),
        (name = "Predict", description = "Predict API endpoints."),
        (name = "Quests", description = "Quests API endpoints."),
        (name = "Recipes", description = "Recipes API endpoints."),
        (name = "Research", description = "Research API endpoints."),
        (name = "Sandboxes", description = "Sandboxes API endpoints."),
        (name = "Support", description = "Support API endpoints."),
        (name = "Voice", description = "Voice API endpoints."),
        (name = "Widgets", description = "Widgets API endpoints."),
    ),
)]
pub struct ApiDoc;

// ── Feature-gated leaf sub-docs ───────────────────────────────────────────────
//
// `research`/`clips`/`recipes` are compile-out-able leaves. Their handler
// paths can't live in `ApiDoc`'s `paths(...)` because utoipa's macro drops `#[cfg]`
// on individual entries — so a per-entry gate would still emit `super::*` for an
// absent module (E0433). Each extracted crate instead owns its own `#[utoipa::path]`
// annotations and exposes an `api::openapi()` sub-doc, merged into the base spec at
// build time by [`api_doc()`]. When the feature is on (the default), the merged
// output is identical in content to the old inline listing (paths land at the end of
// the map, which is functional-identical, not literally byte-identical JSON).

/// The full Core spec: the base [`ApiDoc`] plus any compile-out-able leaf sub-docs
/// that are enabled in this build. The single source of truth for both
/// `--dump-openapi` and `GET /api/openapi.json`, so the served spec and the dumped
/// spec never diverge on which features are compiled in.
pub fn api_doc() -> utoipa::openapi::OpenApi {
    #[allow(unused_mut)]
    let mut doc = ApiDoc::openapi();
    super::qoder_api::register_security(&mut doc);
    doc.merge(node_agents::NodeAgentsPaths::openapi());
    doc.merge(vault::VaultPaths::openapi());
    doc.merge(runtime::RuntimePaths::openapi());
    doc.merge(domains::DomainPaths::openapi());
    doc.merge(super::cloud_environments::openapi());
    doc.merge(super::subscription_cloud::api::openapi());
    doc.merge(super::prompt_registry::openapi());
    // Dashboards runs out-of-process (`ryu-dashboards` sidecar); its `/api/dashboards/*`
    // spec is owned by the sidecar and served through the ext-proxy `public_mount`, so
    // Core no longer merges it into this doc.
    // Hardware: the extracted `ryu_hardware` crate owns the `/api/hardware/devices*`
    // + `/api/hardware/display*` handler `#[utoipa::path]` annotations and exposes
    // them as a merged sub-doc. Non-optional dep, so merged unconditionally.
    doc.merge(ryu_hardware::api::openapi());
    // Predict: the extracted `ryu_predict` crate owns its `/api/predict/*` handler
    // `#[utoipa::path]` annotations and exposes them as a merged sub-doc (non-optional
    // dep, so no cfg gate — the routes are always mounted).
    doc.merge(ryu_predict::api::openapi());
    // Research `/api/research/*` is served out-of-process by the `ryu-research`
    // sidecar (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged
    // into Core's spec — the sidecar owns that surface.
    // Clips `/api/clips/*` is served out-of-process by the `ryu-clips` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Recipes `/api/recipes/*` is served out-of-process by the `ryu-recipes` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Healing `/api/healing/*` is served out-of-process by the `ryu-healing` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Quests `/api/quests/*` is served out-of-process by the `ryu-quests` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Teams `/api/teams/*` is served out-of-process by the `ryu-teams` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Meetings runs out-of-process (`ryu-meetings` sidecar); its `/api/meetings/*` spec
    // is owned by the sidecar and served through the ext-proxy `public_mount`, so Core
    // no longer merges it into this doc.
    // Monitors: OUT-OF-PROCESS (`ryu-monitors` sidecar) — the sidecar owns the
    // `/api/monitors/*` surface + its OpenAPI, so it is NOT merged into Core's spec.
    // Skills: the CRUD/version/source/activate handlers live in the extracted
    // `ryu-skills` crate (which owns their `#[utoipa::path]` annotations); the
    // Core-side `catalog`/`updates`/`install-from-source` handlers stay in the main
    // doc above. Non-optional dep (the registry is kernel-required), so no cfg gate.
    doc.merge(ryu_skills::api::openapi());
    // Output styles: the whole `/api/output-styles/*` surface lives in the extracted
    // `ryu-output-styles` crate, which owns every `#[utoipa::path]` on it — unlike
    // skills there is no Core-side leaf left in the main doc above, because Core
    // `nest`s the crate's router under the entire prefix. Non-optional dep (Core
    // resolves the style for every turn), so no cfg gate.
    doc.merge(ryu_output_styles::api::openapi());
    doc
}

/// `GET /api/openapi.json` — serve the generated spec from a running Core.
#[utoipa::path(
    get,
    path = "/api/openapi.json",
    tag = "Health",
    summary = "OpenAPI specification for this Core node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn serve_openapi() -> axum::Json<utoipa::openapi::OpenApi> {
    axum::Json(api_doc())
}

#[cfg(test)]
mod tests;
