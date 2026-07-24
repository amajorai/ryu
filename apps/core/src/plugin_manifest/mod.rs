//! **App manifest** — the `ryu.json` bundle descriptor for an installable Ryu App.
//!
//! # Scope (M3: type + parse + loader + list endpoint)
//!
//! This module defines the [`PluginManifest`] type, supports serde deserialisation of
//! a `ryu.json` file, and provides [`PluginManifestLoader`] — a scanner that reads
//! `~/.ryu/apps/*/ryu.json` (env-overridable via `RYU_APPS_DIR`), validates semver,
//! rejects duplicate ids, and merges built-in manifests with user-installed ones.
//! There is **no install/enable lifecycle here** — that lands in M3's install units.
//! There is **no permission-grant enforcement here** — grant enforcement belongs to
//! the Gateway (the Gateway decides what is *allowed*; Core decides what *runs*).
//!
//! # Distinction from the sidecar version catalog
//!
//! [`crate::catalog`] is the *sidecar version catalog*: it tracks what binary
//! versions of sidecars (providers, tools, agents) are available for download and
//! installation into `~/.ryu/bin`. It is an internal infrastructure concept.
//!
//! An [`PluginManifest`] is a *user-facing bundle descriptor* — a `ryu.json` file that
//! ships with (or describes) a Ryu App: it names the Runnables the app bundles, the
//! permission grants it needs, and an optional Companion surface. The two concepts
//! are deliberately kept separate and carry distinct names.
//!
//! # Per-kind config and validation
//!
//! Each Runnable entry in a manifest carries a `kind` discriminant
//! ([`crate::runnable::RunnableKind`]) and an optional typed `config` blob.
//! The per-kind config structs and the [`schema::validate_runnable`] function
//! live in the [`schema`] submodule; [`PluginManifestLoader`] runs validation during
//! loading and rejects any manifest whose Runnables fail their per-kind contract.

pub mod schema;

use std::collections::HashSet;
use std::path::PathBuf;

use schema::validate_runnable;

// The `manifest.json` data model + validation (PluginManifest, Surface, Requires,
// the per-kind schema types, validate_plugin_id, parse_min_version, …) now has a
// single definition in the `ryu-kernel-contracts` crate. Re-export the whole
// surface so every `crate::plugin_manifest::<Type>` call site (hundreds of them)
// resolves unchanged. Only Core-specific, I/O-bearing pieces stay below: the
// `PluginManifestLoader`, `core_version`, the built-in fixtures, and UI consts.
pub use ryu_kernel_contracts::manifest::*;

/// The running Core version, as a parsed [`semver::Version`]. Authoritative
/// source for the `engines.ryu` version-pin gate. Derived from the crate version
/// (`CARGO_PKG_VERSION`), which is the single version of record for Core.
pub fn core_version() -> semver::Version {
    // `CARGO_PKG_VERSION` is always valid semver (Cargo enforces it), so this
    // parse never fails in practice; fall back to 0.0.0 defensively.
    semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// File names a plugin manifest may use on disk, in preference order. The new
/// canonical name is `manifest.json`; the previous `plugin.json` and the legacy
/// `ryu.json` are still read so that plugins installed before the rename keep
/// loading. First match wins, so a directory carrying both resolves to
/// `manifest.json`.
///
/// Shared with [`crate::runnable::self_build`] so there is exactly ONE copy of
/// this ordering inside Core.
pub(crate) const MANIFEST_FILE_NAMES: &[&str] = &["manifest.json", "plugin.json", "ryu.json"];

/// The canonical manifest file name — the ONE name every write/scaffold path
/// emits. Reads accept the legacy names via [`MANIFEST_FILE_NAMES`]; writes must
/// never re-introduce them, or the migration never completes.
pub const MANIFEST_FILE_NAME: &str = MANIFEST_FILE_NAMES[0];

/// Built-in plugin manifests compiled into the binary, always present regardless of
/// whether the user has a `~/.ryu/plugins/` directory.
///
/// (`sample.manifest.json` — the Research Assistant demo — is kept as a test-only
/// fixture and is deliberately NOT shipped as a built-in.)
/// - `spider.manifest.json` — Spider web crawler tool. A fully declarative
///   `command` plugin (Core-tier, default-on): its single runnable IS the crawl
///   tool, backed by a BYO `spider` CLI reached through the command-tool
///   allowlist. The native `sidecar/mcp/spider.rs` provider was deleted, so the
///   fixture is the SOLE owner of the tool (see the exception note below).
/// - `agentbrowser.manifest.json` — Agent Browser web-browsing tool (system plugin, npx MCP-backed).
/// - `exa.manifest.json` — Exa neural search tool plugin (U040, BYOK).
/// - `ghost.manifest.json` — Ghost desktop-automation MCP tool (system plugin, Windows-first).
/// - `shadow.manifest.json` — Shadow screen/audio capture + semantic memory (system plugin, Windows-first).
///
/// The two sidecar-backed system tools (`agentbrowser`, `ghost`) declare an
/// **empty** `runnables` list on purpose: their tools are owned by the stdio MCP
/// server each declares under `mcp_servers` in its own fixture (`ghost` → the
/// `~/.ryu/bin/ghost mcp` binary; `agentbrowser` → `npx -y agentbrowser`),
/// registered into the MCP registry on activation by
/// `sidecar/mcp/register_manifest_mcp_servers` (they moved off the former
/// hardcoded `sidecar/mcp/mod.rs::builtin_servers`). The plugin record is the
/// install/enable/tier **governance shell** around that provider; declaring the
/// tools again here would double-list every one as an `app__<slug>` alias
/// (`fire_activation_event` → the Tool handler in `server/mod.rs`). Do not
/// re-add tool runnables to these fixtures.
///
/// EXCEPTION: `spider`, `rtk`, `advisor` and `shadow` CARRY their tool runnables,
/// because their Rust providers were deleted — the fixture is the only owner, so
/// there is nothing to double-list. The "no runnables" rule above exists solely to
/// avoid double-listing a provider-owned tool; it does not apply once the provider
/// is gone. `spider`/`rtk` are declarative `command`-backend tools; `advisor`
/// (`advisor__consult`) and `shadow` (`shadow__search`/`semantic_search`/`timeline`/
/// `recent_context`) are declarative `http`-backend tools reaching Core loopback
/// bridges (`/api/advisor/consult` and the `/api/shadow/*` proxy). `spider`/`rtk`
/// are reached through the
/// command-tool allowlist.
/// - `headroom.manifest.json` — Headroom gateway egress compression (a `compression` Policy runnable, #425).
/// - `firewall.manifest.json` — Gateway firewall on/off Policy plugin (#447, Core-tier, opt-in).
/// - `routing.manifest.json` — Smart (classifier) routing on/off Policy plugin (#447, Core-tier, opt-in).
/// - `sandbox.manifest.json` — Wasmtime ephemeral sandbox on/off Policy plugin (#448, Core-tier, opt-in).
/// - `engines.manifest.json` — Local engine bindings (llama.cpp + embeddings) as a default-on Core plugin (#448).
/// - `durable.manifest.json` — Durable workflow execution engine as a default-on Core plugin (#448 dogfood).
/// - `predict.manifest.json` — System-wide predictive typing on/off (a `predict` Policy runnable; Core-tier, opt-in). The plugin is the single switch for the `/api/predict/*` brain.
const BUILTIN_MANIFESTS: &[&str] = &[
    include_str!("fixtures/spider.manifest.json"),
    include_str!("fixtures/agentbrowser.manifest.json"),
    include_str!("fixtures/exa.manifest.json"),
    include_str!("fixtures/ghost.manifest.json"),
    include_str!("fixtures/shadow.manifest.json"),
    include_str!("fixtures/headroom.manifest.json"),
    include_str!("fixtures/firewall.manifest.json"),
    include_str!("fixtures/routing.manifest.json"),
    include_str!("fixtures/sandbox.manifest.json"),
    include_str!("fixtures/engines.manifest.json"),
    include_str!("fixtures/durable.manifest.json"),
    // System-wide predictive typing on/off (Policy-gated, Core-local). Opt-in like
    // firewall/routing/sandbox: enabling the plugin is the single switch for the
    // /api/predict/* brain — there is no separate config toggle.
    include_str!("fixtures/predict.manifest.json"),
    // Turn-hook plugins (the migrated, formerly-hardcoded features). These ship
    // as built-in fixtures but are built exactly like a third-party plugin would
    // be: a manifest + an inline JS hook reaching Core only through the
    // capability-gated plugin host. `goal`/`proof`/`double-check` are Core-tier
    // and default-on (see `plugins::builtins::CORE_DEFAULT_ON`) so their features
    // work on every surface with zero setup, gated cheaply by each hook's `match`
    // block; `advisor` stays Community (install-then-enable).
    include_str!("fixtures/double-check.manifest.json"),
    include_str!("fixtures/goal.manifest.json"),
    include_str!("fixtures/advisor.manifest.json"),
    // `proof` is `goal`'s stronger sibling: instead of a one-line transcript
    // judge, each round spawns an INDEPENDENT verifier sub-agent (grant
    // `hook:run-agent`) that gathers real evidence with tools before deciding.
    include_str!("fixtures/proof.manifest.json"),
    // `rtk` surfaces the built-in RTK (Rust Token Killer) command-wrapping tool
    // (`rtk__run`) as an installable plugin. Like `spider`, it is a fully
    // declarative `command`-backend tool: the fixture CARRIES its runnable (the
    // native `sidecar/mcp/rtk.rs` provider was deleted, so there is nothing to
    // double-list — same EXCEPTION as spider). The `rtk` binary is BYO, reached
    // through the command-tool allowlist. The fixture also contributes the Phase-2
    // auto-wrap settings that drive `crate::rtk_config` (NOT a tool). Community-tier,
    // opt-in.
    include_str!("fixtures/rtk.manifest.json"),
    // `security-guidance` ports Anthropic's security-guidance Claude Code plugin
    // onto Ryu's turn-hook substrate: a flag-gated `post_assistant_turn` hook that
    // (1) runs a ~22-rule regex pattern scan over the last answer and (2) does a
    // second-model diff review via `host.sideModel` (grant `hook:side-model`),
    // surfacing findings as an out-of-band note. Toggle + `/security` command +
    // reviewer-model picker mirror `double-check`. Community-tier, opt-in.
    include_str!("fixtures/security-guidance.manifest.json"),
    // `auto-expand` is the first `pre_user_turn` hook: before a message is sent it
    // calls a configurable model (`hook:side-model`) to rewrite the prompt into a
    // clearer form and returns a `replace` directive, so the improved prompt is
    // what gets sent and persisted. Composer toggle (auto-expand every message) +
    // `/expand` command (one-off). Core-tier, default-on; the flag/command `match`
    // keeps it free when idle.
    include_str!("fixtures/auto-expand.manifest.json"),
    // `session-context` is a reference `session_start` hook: on the first turn of a
    // conversation it injects the current date/time (a common blind spot for local
    // models) via a `replace`/`inject` directive. Community-tier, opt-in; the
    // reference a third party forks for richer setup-context injection. The other
    // new phases (pre/post_tool_use, subagent_stop, session_end, notification) fire
    // from off-chat-path sites through the process-global dispatcher; their
    // reference fixtures (`tool-firewall`, `hook-observers`) are deliberately NOT
    // registered here so those hot paths (esp. per tool call) stay lookup-free
    // until a user installs a plugin that actually uses them.
    include_str!("fixtures/hook-session-context.manifest.json"),
    // RAG capability: the default in-process embeddings+retrieval provider. Declares
    // `provides: [rag]` + `requires: [engines]` so the capability graph resolves
    // rag→engines for real (disable-safety: engines can't be disabled out from under
    // an enabled rag). A GraphRAG/third-party provider app can bind `rag` to swap it.
    include_str!("fixtures/rag.manifest.json"),
    // Mail (Agent Inboxes): a built-in app whose out-of-process `ryu-mail` sidecar
    // Core spawns (local sibling binary) and proxies `/api/mail/*` to via the
    // generic ext-proxy `public_mount` mechanism — the acceptance test proving the
    // generic loader replaces the retired hand-coded `sidecar/mail.rs`. Default-on,
    // so the externally-committed inbound-webhook URL resolves out of the box.
    include_str!("fixtures/mail.manifest.json"),
    // Browser (W9): a real-Chromium Electron browser Core runs as a `local` sidecar
    // and exposes as the grant-gated `browser.control` capability (list/open/navigate
    // tabs, screenshot, read titles, privileged JS eval). CORE built-in — listed in
    // `SYSTEM_PLUGINS` + `CORE_DEFAULT_ON`, so it is seeded enabled on a fresh install
    // and uninstall-protected (the workspace "Browser" tab uses this sidecar instead of
    // the fallback iframe). `lazy` + idle-stop keep the Electron GUI cold until the
    // desktop Browser panel first calls it through the ext-proxy — it does not spawn on
    // boot, only on first use.
    include_str!("fixtures/browser.manifest.json"),
    // Simulators: iOS Simulator (`simctl`, macOS + Xcode) + Android Emulator (`adb`)
    // control Core runs as a dependency-free `local` sidecar, exposing the grant-gated
    // `simulator.control` capability. OPT-IN like the browser — NOT in `CORE_DEFAULT_ON`,
    // so the toolchain-wrapping sidecar never spawns unless a user enables it. `lazy` +
    // idle-stop keep it cold until the desktop Simulator panel calls it through the
    // ext-proxy. Availability is a RUNTIME probe (`/capabilities`): iOS shows only on a
    // Mac with Xcode; Android wherever the SDK is present.
    include_str!("fixtures/simulator.manifest.json"),
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`, Path B) that
    // OWNS its Space documents via `spaces:docs`. Ships default-on with a UI bundle
    // + host-bridge grants seeded in `main.rs` (the generic CORE_DEFAULT_ON loop
    // seeds neither, so it has a dedicated seed block). Replaces the built-in
    // whiteboard editor.
    include_str!("fixtures/whiteboard.manifest.json"),
    // The Canvas app — a full-page Companion (`ui_format:"html"`, Path B) that owns
    // its Space documents via `spaces:docs` and runs generation nodes through the
    // window.ryu media/agent bridge (`media:generate` / `media:transcribe` /
    // `hook:run-agent` / `hook:side-model`) + reads catalogs via `core:list_agents`.
    // Ships default-on with a UI bundle + those grants seeded in `main.rs`. Replaces
    // the built-in creative-canvas board.
    include_str!("fixtures/canvas.manifest.json"),
    // The Fine-tuning app — a full-page Companion (`ui_format:"html"`, Path B) that
    // drives Core's fine-tune orchestration + durable job store via the
    // `finetune:runs` bridge and OWNS its Unsloth training sidecar (a
    // manifest-declared Python process spawned on the Core-tier auto-run path, so it
    // declares no `sidecar:process` grant — the Gateway denies that grant at enable).
    // Ships default-on with a UI bundle + those grants seeded in `main.rs`. Replaces
    // the built-in fine-tuning page.
    include_str!("fixtures/finetune.manifest.json"),
    // Spaces + Meetings — the first REAL plugin→plugin dependency edge.
    //
    // Both have zero runnables (like ghost/shadow), so the record governs them —
    // install/enable/disable. They differ in where the impl lives: `spaces` stays
    // IN-PROCESS (`server/spaces.rs`, no `public_mount`); `meetings` was moved
    // OUT-OF-PROCESS (2026-07-18) and now serves `/api/meetings/*` via a `public_mount`
    // sidecar (`apps-store/meetings/backend`, reached over loopback via
    // `meetings_client.rs`) — the old in-crate `server/meetings_api.rs` is gone.
    // Declaring a runnable here would register a PHANTOM tool with no implementation.
    //
    // Order matters only for readability: `plugins::seed` resolves the topological
    // order from `requires`, so the dependency is seeded before its dependent no
    // matter how these are listed.
    include_str!("fixtures/spaces.manifest.json"),
    // Meetings `requires` Spaces because it genuinely writes its notes into the
    // "Meetings" Space (the sidecar's note-save path lands in `state.spaces` via the
    // Core-side `MeetingIngest`/spaces seam). Disabling Spaces under it would leave that
    // write path pointing at a disabled capability, which is exactly what
    // `plugins::graph` now refuses.
    include_str!("fixtures/meetings.manifest.json"),
    // Five clean LEAF features turned into out-of-process sidecar Apps (2026-07-18).
    // Each serves its own `/api/<feature>/*` surface OUT-OF-PROCESS via a `public_mount`
    // sidecar bin + the generic ext-proxy loader; no in-process routes remain. The
    // plugin record governs install/enable/disable (toggle via the plugin lifecycle).
    // All five are default-on (see `plugins::builtins`) so the surface is reachable on a
    // fresh install — the routes were always-on before, so only a default-on seed keeps
    // them reachable (identical to the Meetings/Spaces edge).
    //
    // `research`/`dashboards`/`teams` declare NO `requires`. `clips` requires the
    // `shadow` capture app (it is a Core→Shadow proxy) and `recipes` requires the
    // `ghost` automation app (Ghost owns the RecipeStore) — both real, satisfiable
    // edges (shadow/ghost are default-on), so the graph refuses to disable the
    // dependency out from under them.
    include_str!("fixtures/research.manifest.json"),
    include_str!("fixtures/dashboards.manifest.json"),
    include_str!("fixtures/teams.manifest.json"),
    include_str!("fixtures/clips.manifest.json"),
    include_str!("fixtures/recipes.manifest.json"),
    // Wave-2: five more leaf features turned into Apps (toggle via the plugin lifecycle).
    // Of these `quests` + `healing` now serve `/api/<feature>/*` OUT-OF-PROCESS via a
    // `public_mount` sidecar + the generic ext-proxy loader; `approvals`/`skills`/`learning`
    // remain IN-PROCESS governance shells that gate their own route surface via
    // `require_app_enabled` (`learning` is the Outcome-B in-process exception). All
    // default-on so the surface is reachable on a fresh install (the routes were always-on
    // before).
    //
    // `quests`/`approvals`/`skills` declare NO `requires`. `learning` requires the
    // `skills` app (it writes synthesized skills) and `healing` requires the
    // `approvals` app (it delivers proposed fixes into that inbox) — both real,
    // satisfiable edges (skills/approvals are default-on), so the graph refuses to
    // disable the dependency out from under them.
    //
    // These manifests are registered UNCONDITIONALLY (no cfg). Only `healing`'s HTTP
    // surface compiles out behind the `healing` cargo feature; its manifest + id must
    // always be present so the default-on seed never references a missing manifest —
    // exactly like `research`/clips/recipes (feature-gated module, always-on fixture).
    include_str!("fixtures/quests.manifest.json"),
    include_str!("fixtures/approvals.manifest.json"),
    include_str!("fixtures/skills.manifest.json"),
    include_str!("fixtures/learning.manifest.json"),
    include_str!("fixtures/healing.manifest.json"),
    // Wave-3: two more leaf features turned into Apps (toggle via the plugin lifecycle).
    // `monitors` now serves `/api/monitors/*` OUT-OF-PROCESS via a `public_mount` sidecar
    // + the generic ext-proxy loader; `hardware` stays IN-PROCESS and gates its route
    // surface via `require_app_enabled`. Both default-on so the surface is reachable on a
    // fresh install (the routes were always-on before).
    //
    // Both declare NO `requires`. `monitors` owns ONLY its `/api/monitors/*` surface
    // (the interleaved `/api/activity/*`, `/api/events/*`, and
    // `/api/notifications/*` streams are separate concerns and stay Core-side, ungated).
    // `hardware` gates ONLY the PROTECTED `/api/hardware/devices*` device-registry
    // CRUD; the PUBLIC device channel (`/api/hardware/{ws,pair,display}`) stays ungated
    // because physical ESP32 devices connect there and gating it would break pairing.
    include_str!("fixtures/monitors.manifest.json"),
    include_str!("fixtures/hardware.manifest.json"),
    // Wave-4: two more leaf features turned into governance-shell Apps (toggle via
    // the plugin lifecycle + route gate; impl stays in-crate). Both default-on so the
    // gate is transparent on a fresh install (the routes were always-on before).
    //
    // Both declare NO `requires`. `workflows` gates ONLY the PROTECTED workflow
    // surface (`/workflows/*` DAG CRUD + `/api/workflows/catalog/*` templates); the
    // PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`) stays on the public
    // router, ungated, so external systems can POST triggers regardless of the app's
    // enabled bit. Neither is behind a cargo feature — the workflow executor is used
    // by the scheduler/durable/healing/approvals and must always compile.
    //
    // `agents` gates ONLY the `/api/agents/*` catalog/CRUD surface and is additionally
    // LOAD-BEARING (see `plugins::builtins::LOAD_BEARING_PLUGINS`): the composer fetches
    // the agent list on boot, so a disabled Agents app would break chat. The ACP
    // routing/execution substrate that serves a chat turn is kernel and stays untouched.
    include_str!("fixtures/workflows.manifest.json"),
    include_str!("fixtures/agents.manifest.json"),
    // W0 honest-gating baseline: three data-path governance shells whose
    // `/api/{voice,images+video+gifs,memory}/*` routes were mounted RAW before this
    // wave. Each gates its own protected route surface via `require_app_enabled`; the
    // impl stays in-crate (no cargo feature). All three default-on (see
    // `plugins::builtins`) so the gate is transparent on a fresh install.
    //
    // `voice` gates ONLY the protected voice data path; the PUBLIC realtime voice WS
    // (`/api/voice/ws`) stays on the public router (browser WS, auth-in-handler).
    // `media` gates ONLY the generative producers; the shared no-cloud blob store
    // (`/api/media/:file` + `/api/media/upload`) stays ungated kernel storage (it also
    // serves TTS audio + chat uploads). `memory` gates ONLY the HTTP CRUD surface; the
    // in-process chat auto-recall path is kernel. None declares `requires`.
    include_str!("fixtures/voice.manifest.json"),
    include_str!("fixtures/media.manifest.json"),
    include_str!("fixtures/memory.manifest.json"),
    // W7 frontend extraction: the webhooks page moved to a sandboxed companion app
    // (`apps-store/webhooks/ui`). Default-on, no `requires` — its `/api/webhooks` +
    // `/api/webhook-ingress/status` reads stay ungated on the main router (the host
    // calls them directly, monitors pattern), so this manifest exists only to seed
    // the companion's UI bundle + `webhooks:crud` grant, not to gate a route surface.
    include_str!("fixtures/webhooks.manifest.json"),
    // W7 frontend extraction: the activity-feed page moved to a sandboxed companion
    // app (`apps-store/activity/ui`). Default-on, no `requires` — its read-only
    // `/api/activity` stays ungated on the main router (the host calls it directly,
    // monitors pattern), so this manifest exists only to seed the companion's UI
    // bundle + `activity:read` grant, not to gate a route surface.
    include_str!("fixtures/activity.manifest.json"),
    // W7 frontend extraction: the timeline page moved to a sandboxed companion app
    // (`apps-store/timeline/ui`). Default-on, no `requires` — Shadow's device-local
    // `/timeline` + `/journal` + `/frame` live on the Shadow sidecar (:3030), not the
    // Core router, and the desktop host calls them directly (monitors pattern), so this
    // manifest exists only to seed the companion's UI bundle + `timeline:read` grant,
    // not to gate a route surface.
    include_str!("fixtures/timeline.manifest.json"),
    // The Calendar app — a sandboxed companion (`ui_format:"html"`). It was already
    // in the default-on seed set (`plugins::seed` maps CALENDAR_UI_HTML) and routed
    // in the desktop (`/calendar`), but its MANIFEST was never registered here, so
    // the record seeded with no manifest and calendar could not appear in
    // `/api/plugins`, plugin contributions, or the marketplace Apps catalog. Register
    // it so it loads like every other companion.
    include_str!("fixtures/calendar.manifest.json"),
    // W7 frontend extraction: the SKILL.md authoring editor moved to a sandboxed
    // companion app (`apps-store/skill-editor/ui`). Default-on, no `requires` — the
    // `/api/skills` authoring endpoints stay ungated on the Core router (the desktop host
    // calls them directly, monitors pattern), so this manifest exists only to seed the
    // companion's UI bundle + `skills:crud` grant, not to gate a route surface.
    include_str!("fixtures/skill-editor.manifest.json"),
    // `sample-widget` — the REFERENCE third-party MCP widget plugin (a dev
    // template; source lives at `plugins-store/sample-widget/`). It declares a
    // local Node MCP server (`node server.mjs`) whose `render` tool advertises
    // `_meta.openai/outputTemplate = ui://widget/sample.html` and serves that
    // resource, plus a `contributes.widgets` entry binding `sample_widget__render`
    // to it and the `widget:render` grant. Registered so it parses/loads like every
    // built-in and shows up as an installable example, but deliberately OPT-IN — it
    // is NOT in `plugins::builtins::CORE_DEFAULT_ON`, so it never seeds enabled and
    // its `node` server is never spawned unless a developer installs it. The
    // canonical copy under `plugins-store/` and this fixture are byte-identical.
    include_str!("fixtures/sample-widget.manifest.json"),
];

/// The Canvas app's plugin id (its Space documents are `kind = app:<this>`). Shared
/// by the default-on seed (`main.rs`), the legacy file-store migration
/// (`server/canvas_migrate.rs`), and the desktop create/route flow.
pub const CANVAS_PLUGIN_ID: &str = "com.ryu.canvas";

/// The Canvas app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `packages/canvas-app`, all JS/CSS inlined). Seeded as the plugin's
/// `ui_code` on a fresh install. Rebuild with `bun run --cwd packages/canvas-app
/// build` and copy `dist/index.html` to `fixtures/canvas.ui.html` to refresh it.
pub const CANVAS_UI_HTML: &str = include_str!("fixtures/canvas.ui.html");

/// The Whiteboard app's plugin id (its Space documents are `kind = app:<this>`).
/// Shared by the default-on seed (`main.rs`), the legacy-kind migration
/// (`server/spaces.rs`), and the desktop create/route flow.
pub const WHITEBOARD_PLUGIN_ID: &str = "com.ryu.whiteboard";

/// The Whiteboard app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/whiteboard-app`, all JS/CSS/fonts
/// inlined). Seeded as the plugin's `ui_code` on a fresh install so the default-on
/// companion has a UI without going through `ryu pack` / install-bundle. Rebuild
/// with `bun run --cwd packages/whiteboard-app build` and copy `dist/index.html`
/// to `fixtures/whiteboard.ui.html` to refresh it.
pub const WHITEBOARD_UI_HTML: &str = include_str!("fixtures/whiteboard.ui.html");

/// The Fine-tuning app's plugin id. Shared by the default-on seed (`main.rs`), the
/// manifest-sidecar ensure in `server/finetune.rs`, and the desktop "Fine-tune this
/// model" open path.
pub const FINETUNE_PLUGIN_ID: &str = "com.ryu.finetune";

/// The Fine-tuning app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/finetune-app`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` on a fresh install so the default-on companion
/// has a UI without going through `ryu pack`. Rebuild with `bun run --cwd
/// packages/finetune-app build` and copy `dist/index.html` to
/// `fixtures/finetune.ui.html` to refresh it.
pub const FINETUNE_UI_HTML: &str = include_str!("fixtures/finetune.ui.html");

/// The Monitors app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/monitors-app`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` on a fresh install so the default-on companion
/// has a UI without going through `ryu pack`. Rebuild with `bun run --cwd
/// packages/monitors-app build` and copy `dist/index.html` to
/// `fixtures/monitors.ui.html` to refresh it.
pub const MONITORS_UI_HTML: &str = include_str!("fixtures/monitors.ui.html");

/// The Workflows app's plugin id (its sandboxed companion drives Core's DAG
/// workflow engine + ghost record→replay). Re-exported from `plugins::builtins`
/// so the seed table and desktop route flow share one definition.
pub const WORKFLOWS_PLUGIN_ID: &str = crate::plugins::builtins::WORKFLOWS_PLUGIN_ID;

/// The Workflows app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/workflows-app`, React Flow + all
/// JS/CSS inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd packages/workflows-app build` and copy `dist/index.html` to
/// `fixtures/workflows.ui.html` to refresh it.
pub const WORKFLOWS_UI_HTML: &str = include_str!("fixtures/workflows.ui.html");

/// The Webhooks app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/webhooks/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/webhooks/ui build` (or `scripts/sync-app-fixtures.sh
/// webhooks`) and copy `dist/index.html` to `fixtures/webhooks.ui.html` to refresh it.
pub const WEBHOOKS_UI_HTML: &str = include_str!("fixtures/webhooks.ui.html");

/// The Quests app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/quests/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/quests/ui build` (or `scripts/sync-app-fixtures.sh
/// quests`) and copy `dist/index.html` to `fixtures/quests.ui.html` to refresh it.
pub const QUESTS_UI_HTML: &str = include_str!("fixtures/quests.ui.html");

/// The Activity app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/activity/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/activity/ui build` (or `scripts/sync-app-fixtures.sh
/// activity`) and copy `dist/index.html` to `fixtures/activity.ui.html` to refresh it.
pub const ACTIVITY_UI_HTML: &str = include_str!("fixtures/activity.ui.html");

/// The Timeline app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/timeline/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/timeline/ui build` (or `scripts/sync-app-fixtures.sh
/// timeline`) and copy `dist/index.html` to `fixtures/timeline.ui.html` to refresh it.
pub const TIMELINE_UI_HTML: &str = include_str!("fixtures/timeline.ui.html");

/// The Skill Editor app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/skill-editor/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// default-on companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/skill-editor/ui build` (or `scripts/sync-app-fixtures.sh
/// skill-editor`) and copy `dist/index.html` to `fixtures/skill-editor.ui.html` to
/// refresh it.
pub const SKILL_EDITOR_UI_HTML: &str = include_str!("fixtures/skill-editor.ui.html");

/// The Mail (Agent Inboxes) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/mail/ui`, all JS/CSS — incl. the
/// tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// onto a DISABLED record so enabling the opt-in `com.ryu.mail` app (from the store)
/// mounts the sandboxed companion. Rebuild with `bun run --cwd apps-store/mail/ui
/// build` (or `scripts/sync-app-fixtures.sh mail`) and copy `dist/index.html` to
/// `fixtures/mail.ui.html` to refresh it.
pub const MAIL_UI_HTML: &str = include_str!("fixtures/mail.ui.html");

/// The Calendar app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/calendar/ui`, all JS/CSS — incl.
/// the tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// (default-on companion) so the `/calendar` route mounts the sandboxed companion.
/// Rebuild with `bun run --cwd apps-store/calendar/ui build` (or
/// `scripts/sync-app-fixtures.sh calendar`) and copy `dist/index.html` to
/// `fixtures/calendar.ui.html` to refresh it.
pub const CALENDAR_UI_HTML: &str = include_str!("fixtures/calendar.ui.html");

/// The Learning app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/learning/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` (default-on companion) so
/// the `/learning` route mounts the sandboxed companion. The `com.ryu.learning`
/// manifest was a wave-2 route-gate governance shell (gating `/api/learn/*` +
/// `/api/experience/*`); the W7 frontend extraction upgrades it in place to ALSO
/// carry the companion runnable. Rebuild with `bun run --cwd apps-store/learning/ui
/// build` (or `scripts/sync-app-fixtures.sh learning`) and copy `dist/index.html` to
/// `fixtures/learning.ui.html` to refresh it.
pub const LEARNING_UI_HTML: &str = include_str!("fixtures/learning.ui.html");

/// The Meetings app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/meetings/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` (default-on companion) so
/// the `/meetings` + `/meetings/:id` routes mount the sandboxed companion (record →
/// live transcript → AI notes + audio import). The `com.ryu.meetings` manifest was a
/// wave-2 route-gate governance shell (gating `/api/meetings/*`) that `requires` the
/// `spaces` app; the W7 frontend extraction upgrades it in place to ALSO carry the
/// companion runnable. Rebuild with `bun run --cwd apps-store/meetings/ui build` (or
/// `scripts/sync-app-fixtures.sh meetings`) and copy `dist/index.html` to
/// `fixtures/meetings.ui.html` to refresh it.
pub const MEETINGS_UI_HTML: &str = include_str!("fixtures/meetings.ui.html");

/// The Inbox (Approvals) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/approvals/ui`, all JS/CSS — incl. the
/// tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// (default-on companion) so the `/inbox` + `/approvals` routes mount the sandboxed
/// companion. The `com.ryu.approvals` manifest was a wave-2 gate-only governance shell
/// (gating `/api/approvals/*`); the W7 frontend extraction upgrades it in place to ALSO
/// carry the companion runnable — the unified Inbox page (approvals + notifications +
/// quest check-offs + Shadow suggestions). Rebuild with
/// `bun run --cwd apps-store/approvals/ui build` (or `scripts/sync-app-fixtures.sh
/// approvals`) and copy `dist/index.html` to `fixtures/approvals.ui.html` to refresh it.
pub const APPROVALS_UI_HTML: &str = include_str!("fixtures/approvals.ui.html");

/// Loader that merges built-in manifests with user-installed ones from
/// `~/.ryu/plugins/*/manifest.json` (the path is overridable via `RYU_PLUGINS_DIR`,
/// or the legacy `RYU_APPS_DIR`; the legacy `plugin.json` and `ryu.json` file names
/// are also read).
///
/// # Validation
/// - A manifest whose `version` field is not valid semver is rejected with a logged
///   warning; all other manifests continue loading.
/// - A duplicate `id` (across built-ins and user manifests) is rejected with a
///   logged warning; the *first* manifest with that id wins.
/// - Any manifest that fails JSON parsing is skipped with a warning.
pub struct PluginManifestLoader;

impl PluginManifestLoader {
    /// Resolve the plugins scan directory.
    ///
    /// Resolution order:
    /// 1. `RYU_PLUGINS_DIR` if set.
    /// 2. `RYU_APPS_DIR` if set (legacy env var, still honoured).
    /// 3. `~/.ryu/plugins` if it exists, or if the legacy `~/.ryu/apps` does not.
    /// 4. `~/.ryu/apps` only as a fallback when the new dir is absent but the
    ///    legacy one exists (so pre-rename installs are not orphaned).
    pub fn plugins_dir() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_PLUGINS_DIR") {
            return PathBuf::from(p);
        }
        if let Some(p) = std::env::var_os("RYU_APPS_DIR") {
            return PathBuf::from(p);
        }
        let ryu = crate::paths::ryu_dir();
        let new_dir = ryu.join("plugins");
        let legacy_dir = ryu.join("apps");
        if !new_dir.exists() && legacy_dir.exists() {
            return legacy_dir;
        }
        new_dir
    }

    /// Load all manifests: built-ins first, then user-installed. Returns only
    /// the manifests that pass semver and duplicate-id validation.
    pub fn load() -> Vec<PluginManifest> {
        let mut manifests: Vec<PluginManifest> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        // 1. Built-in manifests (compiled in).
        for &raw in BUILTIN_MANIFESTS {
            match Self::parse_and_validate(raw, "<built-in>", &mut seen_ids) {
                Ok(m) => manifests.push(m),
                Err(e) => tracing::warn!("built-in manifest skipped: {e}"),
            }
        }

        // 2. User-installed manifests from the plugins directory. Each plugin dir
        //    may carry `manifest.json` (preferred) or the legacy `plugin.json` /
        //    `ryu.json`.
        let dir = Self::plugins_dir();
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let Some(manifest_path) = MANIFEST_FILE_NAMES
                        .iter()
                        .map(|name| entry.path().join(name))
                        .find(|p| p.exists())
                    else {
                        continue;
                    };
                    match std::fs::read_to_string(&manifest_path) {
                        Ok(raw) => {
                            match Self::parse_and_validate(
                                &raw,
                                &manifest_path.to_string_lossy(),
                                &mut seen_ids,
                            ) {
                                Ok(m) => manifests.push(m),
                                Err(e) => {
                                    tracing::warn!(
                                        "plugin manifest at {} skipped: {e}",
                                        manifest_path.display()
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "could not read plugin manifest at {}: {e}",
                                manifest_path.display()
                            );
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!(
                    "plugins directory {} does not exist; no user plugins loaded",
                    dir.display()
                );
            }
            Err(e) => {
                tracing::warn!("could not scan plugins directory {}: {e}", dir.display());
            }
        }

        manifests
    }

    /// Parse ONLY the compiled-in built-in manifests, ignoring `~/.ryu/plugins`.
    ///
    /// Parse ONLY the compiled-in built-in manifests, synchronously and with no disk
    /// scan (unlike [`Self::load`], which also reads the user plugins directory). Two
    /// callers: hermetic built-in tests (a `load()`-based assertion would also depend
    /// on whatever the developer has installed locally), and router-build-time
    /// public-mount registration (which is built-in-only by design and must be sync).
    pub(crate) fn load_builtins() -> Vec<PluginManifest> {
        let mut seen_ids: HashSet<String> = HashSet::new();
        BUILTIN_MANIFESTS
            .iter()
            .filter_map(|raw| Self::parse_and_validate(raw, "<built-in>", &mut seen_ids).ok())
            .collect()
    }

    fn parse_and_validate(
        raw: &str,
        source: &str,
        seen_ids: &mut HashSet<String>,
    ) -> Result<PluginManifest, String> {
        let manifest: PluginManifest =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;

        validate_plugin_id(&manifest.id).map_err(|e| format!("{e} (source: {source})"))?;

        if semver::Version::parse(&manifest.version).is_err() {
            return Err(format!(
                "app '{}' has invalid semver version '{}' (source: {source})",
                manifest.id, manifest.version
            ));
        }

        if !seen_ids.insert(manifest.id.clone()) {
            return Err(format!(
                "duplicate app id '{}' (source: {source}); first occurrence wins",
                manifest.id
            ));
        }

        // Version-pin gate: if the manifest declares `engines.ryu`, it must parse
        // as a semver requirement AND the running Core version must satisfy it.
        // Reject otherwise so an incompatible plugin never loads.
        if let Some(engines) = &manifest.engines {
            let req = semver::VersionReq::parse(&engines.ryu).map_err(|e| {
                format!(
                    "app '{}' has invalid engines.ryu requirement '{}': {e} (source: {source})",
                    manifest.id, engines.ryu
                )
            })?;
            let core = core_version();
            if !req.matches(&core) {
                return Err(format!(
                    "app '{}' requires Ryu engine '{}' but this Core is '{core}' (source: {source})",
                    manifest.id, engines.ryu
                ));
            }
        }

        // Dependency SHAPE gate (`requires.apps`). This is deliberately per-manifest
        // only — self-dependency, a malformed `min_version`, and duplicate edges are
        // all decidable from this manifest alone. Whether a declared dependency
        // EXISTS, is version-SATISFIABLE, and is ACYCLIC are cross-manifest
        // questions that this function structurally cannot answer (it sees one
        // manifest and a `seen_ids` set, never the other 36); those resolve later
        // against the full installed set in `crate::plugins::graph`.
        {
            let mut seen_deps: HashSet<&str> = HashSet::new();
            for dep in manifest.dependencies() {
                validate_plugin_id(&dep.id).map_err(|e| {
                    format!(
                        "app '{}' declares dependency with invalid id: {e} (source: {source})",
                        manifest.id
                    )
                })?;
                if dep.id == manifest.id {
                    return Err(format!(
                        "app '{}' cannot depend on itself (source: {source})",
                        manifest.id
                    ));
                }
                if !seen_deps.insert(dep.id.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate dependency '{}' (source: {source})",
                        manifest.id, dep.id
                    ));
                }
                if let Some(min) = &dep.min_version {
                    parse_min_version(min).map_err(|e| {
                        format!(
                            "app '{}' dependency '{}': {e} (source: {source})",
                            manifest.id, dep.id
                        )
                    })?;
                }
            }
        }

        // Validate each Runnable's per-kind config contract.
        for entry in &manifest.runnables {
            validate_runnable(entry)
                .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
        }

        // Validate each declared managed sidecar (name safety, health path, and
        // per-process-kind required fields). Duplicate local names would collide on
        // the same `<plugin_id>/<name>` manager key, so reject them at load.
        {
            let mut seen: HashSet<&str> = HashSet::new();
            for spec in &manifest.sidecars {
                crate::plugin_manifest::schema::validate_sidecar_spec(spec)
                    .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
                if !seen.insert(spec.name.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate sidecar name '{}' (source: {source})",
                        manifest.id, spec.name
                    ));
                }
            }
        }

        // Manifest-level companion surface: anti-impersonation on the visible label
        // (same rule as the companion *runnable* config and the desktop route-title
        // gate) so a plugin's panel can never pose as first-party Ryu/system chrome.
        if let Some(companion) = &manifest.companion {
            if companion.label.trim().is_empty() {
                return Err(format!(
                    "app '{}' companion label must not be empty (source: {source})",
                    manifest.id
                ));
            }
            if crate::plugin_manifest::schema::label_impersonates_system_chrome(&companion.label) {
                return Err(format!(
                    "app '{}' companion label '{}' must not impersonate system chrome (must not contain 'ryu' or 'system') (source: {source})",
                    manifest.id, companion.label
                ));
            }
        }

        // Contribution cross-validation: every id referenced in `contributes`
        // must resolve to a runnable declared in this manifest (declare-by-id).
        if let Some(contributes) = &manifest.contributes {
            let runnable_ids: HashSet<&str> =
                manifest.runnables.iter().map(|r| r.id.as_str()).collect();
            for referenced in contributes.referenced_ids() {
                if !runnable_ids.contains(referenced) {
                    return Err(format!(
                        "app '{}' contributes unknown runnable id '{referenced}' (no matching entry in 'runnables') (source: {source})",
                        manifest.id
                    ));
                }
            }
        }

        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::schema::validate_runnable;
    use super::*;
    use crate::runnable::RunnableKind;

    const SAMPLE_JSON: &str = include_str!("fixtures/sample.manifest.json");

    /// The multi-kind fixture lives in `apps/core/tests/manifest_fixtures/` so it
    /// doubles as the integration-test input and the in-module round-trip fixture.
    const MULTI_KIND_JSON: &str = include_str!("../../tests/manifest_fixtures/multi_kind.ryu.json");

    /// Each apps-store app exists as TWO copies of one manifest: the package
    /// source (`apps-store/<x>/manifest.json`, what the app team edits) and the
    /// fixture Core actually compiles in via `include_str!`
    /// (`src/plugin_manifest/fixtures/<x>.manifest.json`). Editing only the package
    /// copy is a **dead edit** — Core never reads it — and silently diverges the
    /// two. This test is the guard: the pair must stay byte-identical.
    ///
    /// Read at runtime (not `include_str!`) and skipped when `apps-store/` is absent,
    /// so the OSS Core mirror — which ships `apps/core` without `apps-store/` — still
    /// builds and tests green.
    #[test]
    fn companion_fixtures_match_their_package_manifests() {
        let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = core.join("..").join("..");
        let mut checked = 0;

        for (app, fixture) in [
            ("canvas", "canvas.manifest.json"),
            ("whiteboard", "whiteboard.manifest.json"),
            ("finetune", "finetune.manifest.json"),
            ("workflows", "workflows.manifest.json"),
            ("monitors", "monitors.manifest.json"),
            ("webhooks", "webhooks.manifest.json"),
            ("quests", "quests.manifest.json"),
            ("activity", "activity.manifest.json"),
            ("mail", "mail.manifest.json"),
            ("browser", "browser.manifest.json"),
            ("calendar", "calendar.manifest.json"),
            ("learning", "learning.manifest.json"),
            ("approvals", "approvals.manifest.json"),
            ("timeline", "timeline.manifest.json"),
            ("meetings", "meetings.manifest.json"),
            ("skill-editor", "skill-editor.manifest.json"),
            ("simulator", "simulator.manifest.json"),
            ("clips", "clips.manifest.json"),
            ("dashboards", "dashboards.manifest.json"),
            ("healing", "healing.manifest.json"),
            ("predict", "predict.manifest.json"),
            ("recipes", "recipes.manifest.json"),
            ("research", "research.manifest.json"),
            ("teams", "teams.manifest.json"),
            ("voice", "voice.manifest.json"),
        ] {
            let pkg_path = repo_root
                .join("apps-store")
                .join(app)
                .join("manifest.json");
            let Ok(pkg_json) = std::fs::read_to_string(&pkg_path) else {
                // OSS mirror (no `packages/`) — nothing to compare against.
                continue;
            };
            let fixture_path = core
                .join("src")
                .join("plugin_manifest")
                .join("fixtures")
                .join(fixture);
            let fixture_json = std::fs::read_to_string(&fixture_path)
                .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", fixture_path.display()));

            assert_eq!(
                fixture_json,
                pkg_json,
                "'{}' and '{}' have diverged. Core loads the FIXTURE (include_str!), so an edit \
                 to the package copy alone does nothing. Apply the change to both.",
                fixture_path.display(),
                pkg_path.display()
            );
            checked += 1;
        }

        // The `continue` above exists so the OSS Core mirror (no `apps-store/`)
        // stays green. Gate the zero-escape on the DIRECTORY being absent, not on
        // the reads failing: otherwise "every filename is wrong" (e.g. after a
        // manifest rename that missed this table) is indistinguishable from
        // "mirror tree", and this guard passes having compared nothing.
        if repo_root.join("apps-store").is_dir() {
            assert_eq!(
                checked, 25,
                "apps-store/ is present, so all twenty-five manifests must have been \
                 compared; found {checked}. A lower count means the table's file names \
                 no longer match what is on disk — this guard was silently checking nothing."
            );
        } else {
            assert_eq!(
                checked, 0,
                "apps-store/ is absent (OSS mirror), so nothing should have been compared"
            );
        }
    }

    /// Each companion app's UI is embedded at compile time via `include_str!`
    /// (the `*_UI_HTML` consts) and seeded as the plugin's `ui_code`. A truncated
    /// or emptied fixture would still compile but ship a broken companion, so this
    /// asserts every bundle is present and non-trivially sized. It is deliberately
    /// **size-only, not byte-identity**: the bundles are `vite`/`esbuild` output,
    /// which is not guaranteed byte-stable across build hosts, so a byte-identity
    /// check on a built asset (whiteboard is ~7.7 MB) would be flaky. The refresh
    /// path is `scripts/sync-app-fixtures.sh`; the `*.manifest.json` manifests (hand
    /// authored) keep their byte-identity guard in
    /// `companion_fixtures_match_their_package_manifests`.
    #[test]
    fn companion_ui_fixtures_exist_and_are_nontrivial() {
        // A real inlined single-file app bundle is always far larger than this;
        // the floor only catches an emptied/truncated fixture.
        const MIN_BYTES: usize = 10_000;

        for (name, html) in [
            ("canvas", CANVAS_UI_HTML),
            ("whiteboard", WHITEBOARD_UI_HTML),
            ("finetune", FINETUNE_UI_HTML),
            ("monitors", MONITORS_UI_HTML),
            ("workflows", WORKFLOWS_UI_HTML),
            ("webhooks", WEBHOOKS_UI_HTML),
            ("quests", QUESTS_UI_HTML),
            ("activity", ACTIVITY_UI_HTML),
            ("mail", MAIL_UI_HTML),
            ("calendar", CALENDAR_UI_HTML),
            ("learning", LEARNING_UI_HTML),
            ("approvals", APPROVALS_UI_HTML),
            ("timeline", TIMELINE_UI_HTML),
            ("meetings", MEETINGS_UI_HTML),
        ] {
            assert!(
                html.len() >= MIN_BYTES,
                "{name}.ui.html is only {} bytes (< {MIN_BYTES}) — likely truncated or empty; \
                 rebuild with scripts/sync-app-fixtures.sh",
                html.len()
            );
            assert!(html.contains('<'), "{name}.ui.html does not look like HTML");
        }
    }

    #[test]
    fn sample_fixture_deserializes_into_app_manifest() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        assert_eq!(manifest.id, "com.example.research-assistant");
        assert_eq!(manifest.name, "Research Assistant");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(
            manifest.permission_grants,
            vec!["mcp:web_search", "mcp:file_read"]
        );
        assert!(manifest.companion.is_some());
    }

    #[test]
    fn runnables_helper_returns_all_bundled_runnables() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        let runnables = manifest.runnables();
        assert_eq!(runnables.len(), 4);

        let kinds: Vec<RunnableKind> = runnables.iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&RunnableKind::Agent));
        assert!(kinds.contains(&RunnableKind::Workflow));
        assert!(kinds.contains(&RunnableKind::Tool));
        assert!(kinds.contains(&RunnableKind::Skill));
    }

    #[test]
    fn runnables_of_kind_filters_correctly() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        let agents = manifest.runnables_of_kind(RunnableKind::Agent);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "agent-researcher");

        let workflows = manifest.runnables_of_kind(RunnableKind::Workflow);
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].id, "wf-summarise");
    }

    #[test]
    fn manifest_without_companion_deserializes() {
        let json = r#"{
            "id": "com.example.minimal",
            "name": "Minimal App",
            "version": "0.1.0",
            "runnables": [
                { "id": "agent-x", "name": "Agent X", "kind": "agent" }
            ]
        }"#;
        let manifest: PluginManifest =
            serde_json::from_str(json).expect("minimal manifest should deserialise");
        assert!(manifest.companion.is_none());
        assert!(manifest.permission_grants.is_empty());
        assert_eq!(manifest.runnables().len(), 1);
    }

    #[test]
    fn manifest_roundtrips_through_json() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");
        let serialized = serde_json::to_string(&manifest).expect("serialise should succeed");
        let roundtripped: PluginManifest =
            serde_json::from_str(&serialized).expect("roundtrip deserialise should succeed");
        assert_eq!(manifest, roundtripped);
    }

    // ── PluginManifestLoader tests ───────────────────────────────────────────────

    fn loader_parse(raw: &str) -> Result<PluginManifest, String> {
        PluginManifestLoader::parse_and_validate(raw, "<test>", &mut HashSet::new())
    }

    // ── companion label anti-impersonation ───────────────────────────────────

    #[test]
    fn loader_rejects_companion_label_impersonating_system_chrome() {
        let raw = r#"{
            "id": "com.example.evil",
            "name": "Evil",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Ryu Settings" }
        }"#;
        let err = loader_parse(raw).unwrap_err();
        assert!(
            err.contains("impersonate system chrome"),
            "expected impersonation rejection, got: {err}"
        );
    }

    #[test]
    fn loader_accepts_benign_companion_label() {
        let raw = r#"{
            "id": "com.example.good",
            "name": "Good",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Research Assistant" }
        }"#;
        assert!(loader_parse(raw).is_ok());
    }

    // ── app id validation (path-traversal hardening) ─────────────────────────

    #[test]
    fn validate_plugin_id_accepts_bare_kebab_and_legacy_dotted() {
        // Bare-kebab ids (the new built-in convention) must pass.
        assert!(validate_plugin_id("ghost").is_ok());
        assert!(validate_plugin_id("data-grid-explorer").is_ok());
        assert!(validate_plugin_id("rtk").is_ok());
        // Legacy dotted third-party ids must still pass (back-compat).
        assert!(validate_plugin_id("com.example.research-assistant").is_ok());
        assert!(validate_plugin_id("io.ryu.ghost").is_ok());
        assert!(validate_plugin_id("com.example.my_app").is_ok());
    }

    #[test]
    fn validate_plugin_id_rejects_traversal_and_separators() {
        for bad in [
            "../../etc/cron.d/x",
            "..",
            "a/../b",
            "com/example/app",
            "com\\example\\app",
            "C:windows.x",
            "/etc/foo.bar",
            ".hidden.app",
            "app.",
            "-leading.dash",
            "",
        ] {
            assert!(
                validate_plugin_id(bad).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn validate_plugin_id_rejects_overlong() {
        let long = format!("com.example.{}", "a".repeat(200));
        assert!(validate_plugin_id(&long).is_err());
    }

    #[test]
    fn loader_rejects_path_traversal_id() {
        let json = r#"{"id":"../../../../etc/x","name":"Evil","version":"1.0.0","runnables":[]}"#;
        let err = loader_parse(json).unwrap_err();
        assert!(err.contains("..") || err.contains("illegal"), "got: {err}");
    }

    #[test]
    fn loader_accepts_valid_semver() {
        let json = r#"{
            "id": "com.example.app",
            "name": "Test",
            "version": "2.3.1",
            "runnables": []
        }"#;
        let m = loader_parse(json).expect("valid semver should be accepted");
        assert_eq!(m.version, "2.3.1");
    }

    #[test]
    fn loader_rejects_invalid_semver() {
        let json = r#"{
            "id": "com.example.bad-ver",
            "name": "Bad Version",
            "version": "not-semver",
            "runnables": []
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("invalid semver version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn loader_rejects_duplicate_ids() {
        let json = r#"{"id":"com.example.dup","name":"A","version":"1.0.0","runnables":[]}"#;
        let mut seen = HashSet::new();
        PluginManifestLoader::parse_and_validate(json, "<t1>", &mut seen)
            .expect("first occurrence should succeed");
        let err = PluginManifestLoader::parse_and_validate(json, "<t2>", &mut seen).unwrap_err();
        assert!(err.contains("duplicate app id"), "unexpected error: {err}");
    }

    #[test]
    fn loader_builtins_returns_all_built_in_manifests() {
        // Every built-in manifest must always load — including the #447/#448
        // policy/engine fixtures (whose `engines.ryu` must be satisfiable, or they
        // would be dropped here). The count grows as fixtures are added; assert the
        // floor plus each id below.
        let manifests = PluginManifestLoader::load();
        assert!(
            manifests.len() >= 5,
            "loader must return at least the built-in manifests, got {}",
            manifests.len()
        );
        // The new Core-tier policy/engine plugins must load (their engines.ryu
        // requirement is satisfied by this Core version).
        for id in ["firewall", "routing", "sandbox", "engines", "durable"] {
            assert!(
                manifests.iter().any(|m| m.id == id),
                "built-in '{id}' must load (engines.ryu must be satisfiable)"
            );
        }
        // The Research Assistant demo is no longer a shipped built-in (it was a
        // first-run sample); it must NOT appear in the catalog.
        assert!(
            !manifests
                .iter()
                .any(|m| m.id == "com.example.research-assistant"),
            "sample research assistant manifest must not be a built-in"
        );
        assert!(
            manifests.iter().any(|m| m.id == "spider"),
            "built-in Spider manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "exa"),
            "built-in Exa manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "ghost"),
            "built-in Ghost manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "shadow"),
            "built-in Shadow manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "proof"),
            "built-in Proof of Work manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "security-guidance"),
            "built-in Security Guidance manifest should be loaded"
        );
        // The Whiteboard app (the FIRST companion runnable in BUILTIN_MANIFESTS) must
        // load AND validate as a companion whose config carries `ui_entry` + the
        // Path B `ui_format:"html"` discriminator. `cargo check` compiles the
        // `include_str!` but never RUNS this loader, so without this a fixture that
        // fails `parse_and_validate` would be silently dropped → the default-on seed
        // finds no version → the whole feature is inert while every check stays green.
        let whiteboard = manifests
            .iter()
            .find(|m| m.id == WHITEBOARD_PLUGIN_ID)
            .expect("whiteboard app manifest must load and validate");
        let companion = whiteboard
            .runnables()
            .iter()
            .find(|r| r.kind == RunnableKind::Companion)
            .expect("whiteboard must expose a companion runnable");
        let cfg = companion
            .config
            .as_ref()
            .expect("whiteboard companion must carry a config");
        assert!(
            cfg.get("ui_entry").and_then(|v| v.as_str()).is_some(),
            "whiteboard companion config must set ui_entry (so has_ui is true)"
        );
        assert_eq!(
            cfg.get("ui_format").and_then(|v| v.as_str()),
            Some("html"),
            "whiteboard companion must declare ui_format:\"html\" (Path B)"
        );
    }

    #[test]
    fn sample_widget_fixture_loads_and_binds_its_widget() {
        // The reference third-party widget plugin must parse+register (a malformed
        // fixture is silently WARN-skipped by `load()`, staying green under
        // `cargo check`, so assert the loaded shape here). It carries no runnables:
        // its tool is owned by the declared MCP server, and the widget is wired by
        // `contributes.widgets` joined to the `widget:render` grant.
        let manifests = PluginManifestLoader::load();
        let m = manifests
            .iter()
            .find(|m| m.id == "sample-widget")
            .expect("sample-widget fixture must load and validate");
        assert!(
            m.permission_grants.iter().any(|g| g == "widget:render"),
            "sample-widget must declare the widget:render grant"
        );
        assert!(
            m.mcp_servers.contains_key("sample_widget"),
            "sample-widget must declare the sample_widget MCP server"
        );
        let widgets = m
            .contributes
            .as_ref()
            .map(|c| c.widgets.as_slice())
            .unwrap_or_default();
        let widget = widgets
            .iter()
            .find(|w| w.tool_id == "sample_widget__render")
            .expect("sample-widget must contribute the sample_widget__render widget");
        // tool_id MUST be `<mcp_servers-key>__<toolName>` and the uri must match the
        // resource the server serves (and the tool _meta.outputTemplate).
        assert_eq!(widget.uri, "ui://widget/sample.html");
        assert_eq!(widget.mime, "text/html+skybridge");
    }

    #[test]
    fn security_guidance_fixture_has_gated_turn_hook() {
        // The ported security-guidance plugin must contribute a flag-gated
        // `post_assistant_turn` hook with the side-model grant, so it is free on
        // the hot path (skipped unless the toggle/command is set) and can review.
        let manifests = PluginManifestLoader::load();
        let m = manifests
            .iter()
            .find(|m| m.id == "security-guidance")
            .expect("security-guidance must load");
        assert!(
            m.permission_grants.iter().any(|g| g == "hook:side-model"),
            "must declare the side-model grant"
        );
        let hooks = &m.contributes.as_ref().expect("contributes").turn_hooks;
        assert_eq!(hooks.len(), 1, "one turn hook");
        assert_eq!(hooks[0].on, "post_assistant_turn");
        let gate = hooks[0].run_when.as_ref().expect("a match gate");
        assert_eq!(gate.flag.as_deref(), Some("io.ryu.security-guidance"));
        assert!(gate.commands.iter().any(|c| c == "/security"));
    }

    // ── Per-kind validation via loader ────────────────────────────────────────

    #[test]
    fn loader_rejects_unknown_kind() {
        // An unknown `kind` string must be rejected with a descriptive error (serde
        // will produce a parse error since `RunnableKind` is exhaustive).
        let json = r#"{
            "id": "com.example.bad-kind",
            "name": "Bad Kind",
            "version": "1.0.0",
            "runnables": [
                { "id": "r1", "name": "R1", "kind": "not_a_real_kind" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("JSON parse error"),
            "expected parse error, got: {err}"
        );
    }

    #[test]
    fn loader_rejects_runnable_missing_required_config() {
        // A `tool` Runnable without `config` must be rejected with a descriptive error.
        let json = r#"{
            "id": "com.example.bad-tool",
            "name": "Bad Tool",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("kind=tool") || err.contains("missing required"),
            "expected per-kind validation error, got: {err}"
        );
    }

    #[test]
    fn loader_rejects_policy_missing_required_config() {
        let json = r#"{
            "id": "com.example.bad-policy",
            "name": "Bad Policy",
            "version": "1.0.0",
            "runnables": [
                { "id": "policy-x", "name": "Policy X", "kind": "policy" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("kind=policy") || err.contains("missing required"),
            "expected per-kind validation error, got: {err}"
        );
    }

    // ── Multi-kind fixture round-trip (acceptance criteria for #167) ──────────

    #[test]
    fn multi_kind_fixture_deserializes_all_eight_kinds() {
        let manifest: PluginManifest =
            serde_json::from_str(MULTI_KIND_JSON).expect("multi_kind.ryu.json should deserialise");

        assert_eq!(manifest.id, "com.example.multi-kind");
        assert_eq!(manifest.runnables().len(), 8);

        let kinds: Vec<RunnableKind> = manifest.runnables().iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&RunnableKind::Agent), "missing agent");
        assert!(kinds.contains(&RunnableKind::Workflow), "missing workflow");
        assert!(kinds.contains(&RunnableKind::Tool), "missing tool");
        assert!(kinds.contains(&RunnableKind::Skill), "missing skill");
        assert!(
            kinds.contains(&RunnableKind::Companion),
            "missing companion"
        );
        assert!(kinds.contains(&RunnableKind::Channel), "missing channel");
        assert!(kinds.contains(&RunnableKind::Engine), "missing engine");
        assert!(kinds.contains(&RunnableKind::Policy), "missing policy");
    }

    #[test]
    fn multi_kind_fixture_roundtrips_with_zero_data_loss() {
        let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
        let serialized = serde_json::to_string(&manifest).expect("serialise");
        let roundtripped: PluginManifest =
            serde_json::from_str(&serialized).expect("roundtrip deserialise");
        assert_eq!(
            manifest, roundtripped,
            "round-trip must produce identical data"
        );
    }

    #[test]
    fn multi_kind_fixture_all_runnables_pass_validation() {
        let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
        for entry in manifest.runnables() {
            validate_runnable(entry)
                .unwrap_or_else(|e| panic!("runnable '{}' failed validation: {e}", entry.id));
        }
    }

    // ── contributes / engines / activation_events (#443) ─────────────────────

    #[test]
    fn activation_events_default_empty_roundtrips() {
        let json = r#"{
            "id": "com.example.lazy",
            "name": "Lazy",
            "version": "1.0.0",
            "runnables": []
        }"#;
        let m = loader_parse(json).expect("manifest without activation_events should load");
        assert!(
            m.activation_events.is_empty(),
            "activation_events defaults to empty (eager)"
        );
        assert!(m.contributes.is_none());
        assert!(m.engines.is_none());

        // Round-trip preserves the empty default.
        let serialized = serde_json::to_string(&m).expect("serialise");
        let back: PluginManifest = serde_json::from_str(&serialized).expect("deserialise");
        assert_eq!(m, back);
    }

    #[test]
    fn activation_events_parse_and_roundtrip() {
        let json = r#"{
            "id": "com.example.events",
            "name": "Events",
            "version": "1.0.0",
            "runnables": [],
            "activation_events": ["onStartup", "onCommand:do-thing"]
        }"#;
        let m = loader_parse(json).expect("manifest with activation_events should load");
        assert_eq!(m.activation_events, vec!["onStartup", "onCommand:do-thing"]);
    }

    #[test]
    fn engines_satisfied_loads() {
        // A requirement the running Core always satisfies (any version >= 0.0.1).
        let json = r#"{
            "id": "com.example.engok",
            "name": "Eng OK",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=0.0.1" }
        }"#;
        let m = loader_parse(json).expect("satisfied engines.ryu should load");
        assert_eq!(m.engines.as_ref().unwrap().ryu, ">=0.0.1");
    }

    #[test]
    fn engines_unsatisfied_is_rejected() {
        // An impossibly-high requirement no real Core version satisfies.
        let json = r#"{
            "id": "com.example.engbad",
            "name": "Eng Bad",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=9999.0.0" }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("requires Ryu engine"),
            "expected version-pin rejection, got: {err}"
        );
    }

    #[test]
    fn engines_invalid_requirement_is_rejected() {
        let json = r#"{
            "id": "com.example.engsyntax",
            "name": "Eng Syntax",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": "not-a-req" }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("invalid engines.ryu"),
            "expected invalid-requirement rejection, got: {err}"
        );
    }

    #[test]
    fn contributes_referencing_existing_runnable_loads() {
        let json = r#"{
            "id": "com.example.contrib",
            "name": "Contrib",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "tools": [ { "id": "tool-x", "title": "Search the web" } ] }
        }"#;
        let m = loader_parse(json).expect("contributes referencing a real runnable should load");
        let c = m.contributes.as_ref().unwrap();
        assert_eq!(c.tools.len(), 1);
        assert_eq!(c.tools[0].id, "tool-x");
        assert_eq!(c.tools[0].title.as_deref(), Some("Search the web"));
    }

    #[test]
    fn contributes_referencing_missing_runnable_is_rejected() {
        let json = r#"{
            "id": "com.example.contribbad",
            "name": "Contrib Bad",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "commands": [ { "id": "does-not-exist" } ] }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("unknown runnable id"),
            "expected unknown-id rejection, got: {err}"
        );
    }

    #[test]
    fn core_version_is_parseable() {
        // core_version() must always return a valid semver (never 0.0.0 in a real
        // build), so the engines gate has a meaningful version to match against.
        let v = core_version();
        assert!(v >= semver::Version::new(0, 0, 0));
    }

    #[test]
    fn loader_scans_user_dir() {
        // Point RYU_PLUGINS_DIR at a temp dir with a canonical `manifest.json`
        // plugin, a legacy `plugin.json` plugin, a legacy `ryu.json` plugin
        // (proving the triple-read fallback), a plugin carrying BOTH
        // `manifest.json` and `plugin.json` (proving first-match-wins
        // precedence), and one malformed plugin.
        let tmp = std::env::temp_dir().join(format!(
            "ryu-plugin-manifest-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let canonical_dir = tmp.join("canonical-plugin");
        std::fs::create_dir_all(&canonical_dir).unwrap();
        std::fs::write(
            canonical_dir.join("manifest.json"),
            r#"{"id":"com.test.canonical-plugin","name":"Canonical Plugin","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        let plugin_dir = tmp.join("my-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"com.test.my-plugin","name":"My Plugin","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        // Carries BOTH names: `manifest.json` must win, so the `plugin.json` id
        // must NOT appear in the loaded set.
        let both_dir = tmp.join("both-plugin");
        std::fs::create_dir_all(&both_dir).unwrap();
        std::fs::write(
            both_dir.join("manifest.json"),
            r#"{"id":"com.test.both-new","name":"Both New","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        std::fs::write(
            both_dir.join("plugin.json"),
            r#"{"id":"com.test.both-old","name":"Both Old","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        let legacy_dir = tmp.join("legacy-plugin");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("ryu.json"),
            r#"{"id":"com.test.legacy-plugin","name":"Legacy Plugin","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        let bad_dir = tmp.join("bad-plugin");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("plugin.json"), b"not json").unwrap();

        std::env::set_var("RYU_PLUGINS_DIR", &tmp);
        let manifests = PluginManifestLoader::load();
        std::env::remove_var("RYU_PLUGINS_DIR");

        assert!(
            manifests.iter().any(|m| m.id == "com.test.canonical-plugin"),
            "canonical manifest.json plugin should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "com.test.my-plugin"),
            "legacy plugin.json plugin should still be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "com.test.legacy-plugin"),
            "legacy ryu.json plugin should still be loaded"
        );
        // Precedence: `manifest.json` is first in MANIFEST_FILE_NAMES, so a dir
        // carrying both resolves to it deterministically.
        assert!(
            manifests.iter().any(|m| m.id == "com.test.both-new"),
            "manifest.json must win over plugin.json when both are present"
        );
        assert!(
            !manifests.iter().any(|m| m.id == "com.test.both-old"),
            "plugin.json must NOT be read when manifest.json is present"
        );

        // The legacy `RYU_APPS_DIR` must still be honoured when `RYU_PLUGINS_DIR`
        // is unset, so pre-rename setups are not orphaned. Reuse the same temp
        // dir (it holds a legacy `ryu.json` plugin) to keep env mutation in this
        // single test, avoiding cross-test env races under parallel runs.
        std::env::set_var("RYU_APPS_DIR", &tmp);
        let legacy_manifests = PluginManifestLoader::load();
        std::env::remove_var("RYU_APPS_DIR");

        std::fs::remove_dir_all(&tmp).ok();

        assert!(
            legacy_manifests
                .iter()
                .any(|m| m.id == "com.test.legacy-plugin"),
            "legacy RYU_APPS_DIR should still be honoured"
        );
    }

    // ── requires / targets ────────────────────────────────────────────────────

    /// Parse a manifest through the real validation funnel (the same one the
    /// loader uses for built-ins and disk manifests).
    fn parse(raw: &str) -> Result<PluginManifest, String> {
        let mut seen = HashSet::new();
        PluginManifestLoader::parse_and_validate(raw, "<test>", &mut seen)
    }

    const NO_DEPS: &str = r#"{
        "id": "legacy.plugin",
        "name": "Legacy Plugin",
        "version": "1.0.0",
        "runnables": []
    }"#;

    /// BACKWARD COMPAT — the single most important test here. A manifest with
    /// neither `requires` nor `targets` (i.e. all 37 shipped fixtures) must still
    /// parse, and must mean "no dependencies, runs on EVERY surface". An absent
    /// `targets` must never be read as "hidden", or every existing plugin vanishes.
    #[test]
    fn manifest_without_requires_or_targets_means_no_deps_all_surfaces() {
        let m = parse(NO_DEPS).expect("a manifest with no requires/targets must parse");

        assert!(m.requires.is_none());
        assert!(m.dependencies().is_empty(), "absent requires = no deps");

        assert!(m.targets.is_empty());
        for surface in [
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ] {
            assert!(
                m.supports_surface(surface),
                "empty targets must mean EVERY surface, not none ({surface:?})"
            );
        }
    }

    /// Every shipped built-in must still load with the new fields present on the
    /// struct — the concrete guarantee that these fields break no existing plugin.
    ///
    /// The guarantee is precisely about manifests that declare **nothing**: absent
    /// `requires` = no dependencies, absent/empty `targets` = every surface. It is
    /// NOT "no built-in may ever declare them" — a built-in that *does* (Meetings
    /// requires Spaces; anything with explicit `targets`) is the feature working as
    /// designed. So each assertion is scoped to the undeclared case, which is the
    /// one that must never change behaviour.
    #[test]
    fn builtins_that_declare_nothing_keep_their_old_permissive_behaviour() {
        // `load_builtins`, not `load`: the latter also scans the developer's real
        // ~/.ryu/plugins, which would make this assertion depend on what they
        // happen to have installed.
        let manifests = PluginManifestLoader::load_builtins();
        assert!(!manifests.is_empty(), "built-ins must load");
        for m in &manifests {
            if m.requires.is_none() {
                assert!(
                    m.dependencies().is_empty(),
                    "built-in '{}' declares no `requires`, so it must have no dependencies",
                    m.id
                );
            }
            if m.targets.is_empty() {
                for surface in [
                    Surface::Gateway,
                    Surface::Core,
                    Surface::Desktop,
                    Surface::Island,
                    Surface::Mobile,
                    Surface::Extension,
                    Surface::Web,
                    Surface::Cli,
                ] {
                    assert!(
                        m.supports_surface(surface),
                        "built-in '{}' declares no `targets`, so it must surface on \
                         EVERY host ({surface:?})",
                        m.id
                    );
                }
            }
        }
    }

    #[test]
    fn requires_and_targets_round_trip() {
        let raw = r#"{
            "id": "meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "runnables": [],
            "requires": {
                "apps": [
                    { "id": "spaces", "min_version": "1.2.0" },
                    { "id": "voice" }
                ],
                "grants": ["spaces:docs"]
            },
            "targets": ["desktop", "island"]
        }"#;
        let m = parse(raw).expect("requires/targets must parse");

        let deps = m.dependencies();
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].id, "spaces");
        assert_eq!(deps[0].min_version.as_deref(), Some("1.2.0"));
        assert_eq!(deps[1].id, "voice");
        assert!(deps[1].min_version.is_none(), "min_version is optional");
        assert_eq!(
            m.requires.as_ref().unwrap().grants,
            vec!["spaces:docs".to_owned()]
        );

        assert_eq!(m.targets, vec![Surface::Desktop, Surface::Island]);

        // Serialising and re-parsing preserves both (the manifest is signed
        // verbatim, so the round-trip must be lossless).
        let json = serde_json::to_string(&m).unwrap();
        let back: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    /// The omitted fields must not appear in the serialised form — an existing
    /// manifest must re-serialise byte-identically, so its signature still verifies.
    #[test]
    fn absent_requires_and_targets_are_not_serialised() {
        let m = parse(NO_DEPS).unwrap();
        let json = serde_json::to_value(&m).unwrap();
        assert!(
            json.get("requires").is_none(),
            "absent requires must be omitted"
        );
        assert!(
            json.get("targets").is_none(),
            "empty targets must be omitted"
        );
    }

    // ── explicit targets: filtering ───────────────────────────────────────────

    #[test]
    fn explicit_targets_are_respected() {
        let raw = r#"{
            "id": "desktop.only",
            "name": "Desktop Only",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["desktop"]
        }"#;
        let m = parse(raw).unwrap();
        assert!(m.supports_surface(Surface::Desktop));
        assert!(!m.supports_surface(Surface::Mobile));
        assert!(!m.supports_surface(Surface::Cli));
        assert!(!m.supports_surface(Surface::Core));
    }

    #[test]
    fn unknown_surface_is_rejected() {
        let raw = r#"{
            "id": "bad.surface",
            "name": "Bad Surface",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["toaster"]
        }"#;
        assert!(parse(raw).is_err(), "an unknown surface must be rejected");
    }

    #[test]
    fn surface_tokens_round_trip_through_parse() {
        for s in [
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ] {
            assert_eq!(Surface::parse(s.as_str()), Some(s));
            // The wire token must match the serde (kebab-case) encoding exactly.
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
        }
        assert_eq!(Surface::parse("DESKTOP"), Some(Surface::Desktop));
        assert_eq!(Surface::parse("nonsense"), None);
    }

    // ── requires: shape validation ────────────────────────────────────────────

    #[test]
    fn self_dependency_is_rejected_at_load() {
        let raw = r#"{
            "id": "narcissus",
            "name": "Narcissus",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "narcissus" }] }
        }"#;
        let err = parse(raw).expect_err("a self-dependency must be rejected");
        assert!(err.contains("cannot depend on itself"), "got: {err}");
    }

    #[test]
    fn malformed_min_version_is_rejected_at_load() {
        let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib", "min_version": "not-a-version" }] }
        }"#;
        let err = parse(raw).expect_err("a malformed min_version must be rejected");
        assert!(err.contains("min_version"), "got: {err}");
    }

    #[test]
    fn duplicate_dependency_is_rejected_at_load() {
        let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib" }, { "id": "lib" }] }
        }"#;
        let err = parse(raw).expect_err("a duplicate dependency must be rejected");
        assert!(err.contains("duplicate dependency"), "got: {err}");
    }

    // ── min_version semantics ─────────────────────────────────────────────────

    /// The load-bearing semver decision: a bare `min_version` is a MINIMUM, not
    /// semver's default caret range. `VersionReq::parse("1.2.0")` means `^1.2.0`
    /// and would REJECT 2.0.0; `parse_min_version` must accept it.
    #[test]
    fn bare_min_version_is_a_minimum_not_a_caret() {
        let req = parse_min_version("1.2.0").unwrap();
        assert!(
            req.matches(&semver::Version::parse("1.2.0").unwrap()),
            "exact"
        );
        assert!(
            req.matches(&semver::Version::parse("1.9.9").unwrap()),
            "minor"
        );
        assert!(
            req.matches(&semver::Version::parse("2.0.0").unwrap()),
            "a bare min_version must accept a NEWER MAJOR — this is the whole point"
        );
        assert!(
            !req.matches(&semver::Version::parse("1.1.0").unwrap()),
            "below the minimum is still rejected"
        );
    }

    #[test]
    fn explicit_comparators_are_honoured_verbatim() {
        // The caret escape hatch still pins the major when asked for explicitly.
        let caret = parse_min_version("^1.2.0").unwrap();
        assert!(caret.matches(&semver::Version::parse("1.9.0").unwrap()));
        assert!(!caret.matches(&semver::Version::parse("2.0.0").unwrap()));

        let range = parse_min_version(">=1.0, <2").unwrap();
        assert!(range.matches(&semver::Version::parse("1.5.0").unwrap()));
        assert!(!range.matches(&semver::Version::parse("2.0.0").unwrap()));
    }

    #[test]
    fn invalid_min_version_strings_are_errors() {
        assert!(parse_min_version("not-a-version").is_err());
        assert!(parse_min_version("").is_err());
    }

    // ── Every fixture in `fixtures/*.manifest.json` must be well-formed ───────
    //
    // `BUILTIN_MANIFESTS` only `include_str!`s the SHIPPED subset, so `load()` never
    // touches the reference/sample fixtures (`sample`, `tool-firewall`,
    // `hook-observers`, `agents`, …). A truncated or malformed one of those would
    // compile fine and slip past every existing test. This reads the directory at
    // runtime (like `companion_fixtures_match_their_package_manifests`) so ALL of
    // them are exercised, and is skipped on any tree that ships without the folder.

    fn fixture_plugin_json_paths() -> Vec<std::path::PathBuf> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("plugin_manifest")
            .join("fixtures");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut paths: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".manifest.json"))
            })
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn every_fixture_deserializes_into_a_plugin_manifest() {
        let paths = fixture_plugin_json_paths();
        assert!(
            !paths.is_empty(),
            "fixtures/*.manifest.json must be present in this tree"
        );
        for path in &paths {
            let raw = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
            let manifest: PluginManifest = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("{} failed to deserialise: {e}", path.display()));
            assert!(
                !manifest.id.trim().is_empty(),
                "{} has an empty id",
                path.display()
            );
            assert!(
                !manifest.name.trim().is_empty(),
                "{} has an empty name",
                path.display()
            );
        }
    }

    #[test]
    fn every_fixture_has_a_valid_id_and_semver_version() {
        for path in &fixture_plugin_json_paths() {
            let raw = std::fs::read_to_string(path).expect("read fixture");
            let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
            validate_plugin_id(&manifest.id)
                .unwrap_or_else(|e| panic!("{} has an invalid plugin id: {e}", path.display()));
            semver::Version::parse(&manifest.version).unwrap_or_else(|e| {
                panic!(
                    "{} version '{}' is not semver: {e}",
                    path.display(),
                    manifest.version
                )
            });
        }
    }

    #[test]
    fn every_fixture_passes_parse_and_validate_independently() {
        // Each fixture, validated in isolation (a fresh `seen_ids`), must clear the
        // full loader contract — per-kind config, sidecar/companion/contributes
        // cross-checks — even the ones `load()` never reaches. `engines`-gated
        // fixtures are exempt: their `engines.ryu` is version-pinned and is a
        // deliberate load-time rejection, not a malformed manifest.
        for path in &fixture_plugin_json_paths() {
            let raw = std::fs::read_to_string(path).expect("read fixture");
            let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
            if manifest.engines.is_some() {
                continue;
            }
            let mut seen = HashSet::new();
            PluginManifestLoader::parse_and_validate(&raw, "<fixture>", &mut seen)
                .unwrap_or_else(|e| panic!("{} failed parse_and_validate: {e}", path.display()));
        }
    }

    #[test]
    fn fixture_ids_are_unique_across_the_directory() {
        let mut seen: HashSet<String> = HashSet::new();
        for path in &fixture_plugin_json_paths() {
            let raw = std::fs::read_to_string(path).expect("read fixture");
            let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
            assert!(
                seen.insert(manifest.id.clone()),
                "duplicate fixture id '{}' at {}",
                manifest.id,
                path.display()
            );
        }
    }
}
