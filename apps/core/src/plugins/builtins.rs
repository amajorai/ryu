//! Built-in system App definitions for the App-store.
//!
//! Ghost and Shadow are Ryu's first-party desktop-automation and screen-capture
//! tools. Their lifecycle is **sidecar-based** (install → `POST /api/setup/:name/install`,
//! start/stop → `POST /api/sidecar/:name/start|stop`) rather than the App
//! lifecycle store (PluginStore), so they never appear in the SQLite apps table.
//!
//! This module owns:
//!
//! 1. The [`SystemPlugin`] descriptor struct — the source of truth for which
//!    manifests are "system" and what sidecar name, badge flags, and platform
//!    notes apply to each.
//! 2. The [`SYSTEM_PLUGINS`] constant — the canonical list consulted by the
//!    `list_apps` handler to inject `built_in`, `sidecar_name`, `windows_first`,
//!    and `local_only` into the JSON response.
//! 3. [`is_builtin`] and [`find_system_plugin`] helpers consumed by
//!    `server/mod.rs`.
//!
//! # Core-vs-Gateway boundary
//!
//! Sidecar install/start/stop is "what runs" — it belongs in Core. Policy
//! decisions (grant enforcement, security checks) belong in the Gateway.
//! Nothing in this module enforces policy.

/// Metadata describing a built-in system App whose lifecycle is sidecar-based.
#[derive(Debug, Clone)]
pub struct SystemPlugin {
    /// Reverse-domain manifest id, must match the fixture JSON.
    pub manifest_id: &'static str,

    /// The sidecar `:name` used in `/api/setup/:name/install` and
    /// `/api/sidecar/:name/start|stop`.
    pub sidecar_name: &'static str,

    /// True when the sidecar binary only ships for Windows. The frontend
    /// renders a "Windows-first" badge and shows a graceful unavailable state
    /// on other platforms.
    pub windows_first: bool,

    /// True when the sidecar runs locally only (no cloud/remote fallback).
    /// The frontend renders a "Local only" badge.
    pub local_only: bool,
}

/// The canonical list of built-in system Apps.
///
/// Order is stable and determines display order in the App-store.
pub const SYSTEM_PLUGINS: &[SystemPlugin] = &[
    SystemPlugin {
        manifest_id: "ghost",
        sidecar_name: "ghost",
        windows_first: true,
        local_only: true,
    },
    SystemPlugin {
        manifest_id: "shadow",
        sidecar_name: "shadow",
        windows_first: true,
        local_only: true,
    },
    // Spider is the default web-crawl tool: a cross-platform Rust sidecar
    // (`spider-rs/spider`), so not Windows-first. Local-only (runs the crawler
    // process on the node).
    SystemPlugin {
        manifest_id: "spider",
        sidecar_name: "spider",
        windows_first: false,
        local_only: true,
    },
    // Agent Browser is the default web-browsing tool: an npx-launched MCP server
    // (npm `agentbrowser`), registered in `sidecar/mcp/mod.rs::builtin_servers`.
    // Cross-platform (Node) and reaches the web, so neither Windows-first nor
    // local-only.
    SystemPlugin {
        manifest_id: "agentbrowser",
        sidecar_name: "agentbrowser",
        windows_first: false,
        local_only: false,
    },
];

/// The Spaces app's plugin id — the document store + RAG index other apps write
/// into. It is a **dependency target**: an app that owns Space documents declares
/// `requires.apps = [{ id: SPACES_PLUGIN_ID }]` so the graph refuses to disable
/// Spaces out from under it.
pub const SPACES_PLUGIN_ID: &str = "com.ryu.spaces";

/// The Meetings app's plugin id — record → transcript → AI notes, auto-saved into
/// the "Meetings" Space.
///
/// The FIRST first-party plugin to declare a real `requires` edge (→ Spaces). The
/// coupling is not decorative: `server/meetings_api.rs::save_notes_to_space` calls
/// `state.spaces.ingest_document`, and `ensure_meetings_space` calls
/// `state.spaces.{list_spaces, create_space}`.
pub const MEETINGS_PLUGIN_ID: &str = "com.ryu.meetings";

/// The Research app's plugin id — the `/api/research/*` proxy over the autoresearch
/// sidecar. A governance-shell leaf: default-on, no `requires` (it owns its own
/// sidecar), compile-out-able behind the `research` cargo feature.
pub const RESEARCH_PLUGIN_ID: &str = "com.ryu.research";

/// The Dashboards app's plugin id — the `/api/dashboards/*` live widget-grid
/// surface. Governance-shell leaf: default-on, no `requires` (soft HTTP loopback to
/// monitors/etc). Gate-only (deep in-crate coupling to hardware displays +
/// `dashboard_builder`), so it is NOT behind a cargo feature.
pub const DASHBOARDS_PLUGIN_ID: &str = "com.ryu.dashboards";

/// The Teams app's plugin id — the `/api/teams/*` CRUD surface over agent teams.
/// Governance-shell leaf: default-on, no `requires` (stores agent-id strings only).
/// Gate-only (the store also backs `@team` chat routing + `agent_builder`), so it
/// is NOT behind a cargo feature.
pub const TEAMS_PLUGIN_ID: &str = "com.ryu.teams";

/// The Clips app's plugin id — the `/api/clips/*` Core→Shadow capture proxy. It
/// `requires` the `shadow` app (its recordings live in Shadow), so the graph
/// refuses to disable Shadow out from under an enabled Clips. Default-on;
/// compile-out-able behind the `clips` cargo feature.
pub const CLIPS_PLUGIN_ID: &str = "com.ryu.clips";

/// The Recipes app's plugin id — the `/api/recipes/*` record→replay surface over
/// Ghost's RecipeStore. It `requires` the `ghost` app, so the graph refuses to
/// disable Ghost out from under an enabled Recipes. Default-on; the HTTP routes are
/// compile-out-able behind the `recipes` cargo feature (the extracted `ryu_recipes`
/// engine stays compiled — the workflow executor's GhostAction node uses it).
pub const RECIPES_PLUGIN_ID: &str = "com.ryu.recipes";

/// The Mail (Agent Inboxes) app's plugin id. Unlike the gate-only apps above, Mail is
/// a **fully manifest-driven** app: its `ryu-mail` sidecar (a local sibling binary) is
/// spawned by the generic loader and its `/api/mail/*` surface is proxied via the
/// `public_mount` mechanism — there is no hand-coded Rust proxy. Default-on so the
/// externally-committed inbound-webhook URL resolves out of the box.
pub const MAIL_PLUGIN_ID: &str = "com.ryu.mail";

/// The RAG capability app's plugin id — the default in-process embeddings+retrieval
/// provider. Declares `provides:[rag]` + `requires:[engines]`, so the capability
/// binding/graph resolves rag→engines for real (Track B). Default-on; a GraphRAG or
/// third-party provider app can bind the `rag` capability to swap the implementation.
pub const RAG_PLUGIN_ID: &str = "com.ryu.rag";

/// The Quests app's plugin id — the `/api/quests/*` auto-detecting todo board.
/// Governance-shell leaf: default-on, no `requires` (the scheduler is kernel infra).
/// The engine + store + HTTP surface are physically extracted to `crates/ryu-quests`
/// and mounted behind this gate; the whole capability is behind the `quests` cargo
/// feature (in `default`), so a lean build drops it. This id stays in Core as the
/// AppGate identity (a manifest/registry constant, not quest business logic).
pub const QUESTS_PLUGIN_ID: &str = "com.ryu.quests";

/// The Approvals app's plugin id — the `/api/approvals/*` human-in-the-loop inbox.
/// Governance-shell leaf: default-on, no `requires` (the workflow dependency is
/// soft). It is a **dependency target**: Healing declares `requires.apps =
/// [com.ryu.approvals]` because it delivers proposed fixes into this inbox. Gate-only
/// (its `ApprovalEngine` is a `ServerState` field used by the scheduler/workflow/
/// healing), so it is NOT behind a cargo feature.
///
/// W7 frontend extraction: this manifest ALSO now carries the `approvals-companion`
/// runnable — the desktop Inbox page (`pages/InboxPage.tsx`) became the sandboxed
/// `apps-store/approvals/ui` companion, seeded with the `approvals:crud` + `quests:crud`
/// grants + a prebuilt UI bundle (see `seed_overrides`). It stays a route gate (unlike
/// the pure-companion webhooks/activity/calendar apps): the `/api/approvals/*` routes
/// remain gated on it; the unified inbox's reads (approvals + notifications + quest
/// check-offs + Shadow suggestions) reach Core/Shadow host-side (the monitors pattern).
pub const APPROVALS_PLUGIN_ID: &str = "com.ryu.approvals";

/// The Skills app's plugin id — the `/api/skills/*` + `/api/skills/catalog/*`
/// SKILL.md discovery/authoring/catalog surface. Governance-shell leaf: default-on,
/// no `requires`. It is a **dependency target**: Learning declares `requires.apps =
/// [com.ryu.skills]` because it writes synthesized skills. Gate-only (its
/// `SkillRegistry` is a `ServerState` field injected into every chat turn by
/// `route_chat_stream`), so it is NOT behind a cargo feature.
pub const SKILLS_PLUGIN_ID: &str = "com.ryu.skills";

/// The Learning app's plugin id — the `/api/learn/*` + `/api/experience/list`
/// continual-learning loop. `requires` the `skills` app (it writes synthesized
/// skills), so the graph refuses to disable Skills out from under it. Default-on.
/// Gate-only (its `ExperienceStore` is a `ServerState` field written from the chat
/// feedback path + a `JobTarget::LearningCycle` scheduler job), so it is NOT behind
/// a cargo feature.
///
/// W7 frontend extraction: this manifest ALSO now carries the `learning-companion`
/// runnable — the desktop Learning page became the sandboxed `apps-store/learning/ui`
/// companion, seeded with the `learning:crud` grant + a prebuilt UI bundle (see
/// `seed_overrides`). It stays a route gate (unlike the pure-companion webhooks/
/// activity/calendar apps): the `/api/learn/*` + `/api/experience/*` routes remain
/// gated on it; the companion's reads reach them host-side (monitors pattern).
pub const LEARNING_PLUGIN_ID: &str = "com.ryu.learning";

/// The Self-Healing app's plugin id — the `/api/healing/*` diagnose→propose-fix
/// surface, now served OUT-OF-PROCESS by the `ryu-healing` sidecar (`public_mount`).
/// `requires` the `approvals` app (it delivers fixes into that inbox), so the graph
/// refuses to disable Approvals out from under it. Default-on; Core keeps only the
/// welded action side (`healing_client::CoreHealingHost`) and drives the sidecar over
/// loopback, with the run-status bus loop spawned unconditionally in `main.rs`.
pub const HEALING_PLUGIN_ID: &str = "com.ryu.healing";

/// The Monitors app's plugin id — the `/api/monitors/*` website-watch surface
/// (price/stock/keyword/content/uptime + alerts). Now served OUT-OF-PROCESS by the
/// `ryu-monitors` sidecar (`public_mount`, App-gated via the ext proxy). Default-on,
/// no `requires` (the scheduler is kernel infra). Core keeps only the loopback driver
/// (`monitors_client`: `JobTarget::Monitor` run + backing-job reconcile) and the two
/// ext-bearer host callbacks (Spider fetch + alert fan-out); the interleaved
/// `/api/activity/*`, `/api/events/*`, and `/api/notifications/*` streams are separate
/// kernel concerns and stay ungated.
pub const MONITORS_PLUGIN_ID: &str = "com.ryu.monitors";

/// The Hardware app's plugin id — the PROTECTED `/api/hardware/devices*` device-
/// registry CRUD (list/patch/delete + per-device dashboard config). Governance-shell
/// leaf: default-on, no `requires`. Gate-only (the device store + `hardware_ws` are
/// `ServerState`-adjacent and the RHP link is coupled to voice/dashboards), so it is
/// NOT behind a cargo feature. The gate covers ONLY the protected device-management
/// routes; the PUBLIC device channel (`/api/hardware/{ws,pair,display}`) stays ungated
/// so physical ESP32 devices can connect and pair regardless of the app's enabled bit.
pub const HARDWARE_PLUGIN_ID: &str = "com.ryu.hardware";

/// The Workflows app's plugin id — the protected workflow surface: the DAG CRUD
/// (`/workflows/*`, no `/api` prefix) plus the template catalog
/// (`/api/workflows/catalog/*`). Governance-shell leaf: default-on, no `requires`.
/// Gate-only (its executor is a `ServerState` engine dispatched by the scheduler
/// `JobTarget::Workflow`, durable execution, healing, and approvals), so it is NOT
/// behind a cargo feature — the impl must always compile. The gate covers ONLY the
/// protected routes; the PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`)
/// stays on the public router, ungated, so external systems can POST triggers
/// regardless of the app's enabled bit.
pub const WORKFLOWS_PLUGIN_ID: &str = "com.ryu.workflows";

/// The Agents app's plugin id — the `/api/agents/*` catalog + CRUD + session-
/// management surface (list/create/edit/delete/catalog/install, ACP config/auth/
/// sessions, threads, usage, capabilities). Governance-shell leaf: default-on AND
/// **load-bearing** (see [`LOAD_BEARING_PLUGINS`]) — the composer fetches the agent
/// list on boot, so a disabled Agents app would break chat; a plain disable is
/// refused. Gate-only (the `AgentStore` is a `ServerState` field the chat path reads
/// in-process), so it is NOT behind a cargo feature. The gate covers ONLY these
/// catalog/CRUD HTTP routes; the ACP routing/execution substrate that actually
/// serves a chat turn (`agent_routing/`, `sidecar/adapters/acp.rs`, and the
/// `/api/chat/stream` path) is kernel and stays untouched — it never HTTP-loops back
/// through `/api/agents`.
pub const AGENTS_PLUGIN_ID: &str = "com.ryu.agents";

/// The Voice app's plugin id — the PROTECTED voice data path
/// (`/api/voice/transcribe`, `/api/voice/speak`, `/api/voice/tts-engines`,
/// `/api/voice/tts-models`, `/api/voice/tts-models/install`). Governance-shell leaf:
/// default-on, no `requires`. Gate-only (the `voice` module is called in-process by
/// the chat/island paths), so it is NOT behind a cargo feature. The gate covers ONLY
/// these protected routes; the PUBLIC realtime voice WS (`/api/voice/ws`) stays on the
/// public router, ungated (a browser WS upgrade authenticates in-handler), so live
/// voice mode connects regardless of the app's enabled bit.
pub const VOICE_PLUGIN_ID: &str = "com.ryu.voice";

/// The Media-Generation app's plugin id — the generative-media PRODUCERS
/// (`/api/images/generate`, `/api/video/generate`, `/api/video/jobs/:id`,
/// `/api/gifs/search`). Governance-shell leaf: default-on, no `requires`. Gate-only,
/// so it is NOT behind a cargo feature. The gate covers ONLY the producers; the shared
/// no-cloud blob store (`/api/media/:file` serve + `/api/media/upload`) stays UNGATED
/// kernel storage because it also serves TTS audio output and chat uploads — gating it
/// here would couple Voice/chat to the Media app's enabled bit.
pub const MEDIA_PLUGIN_ID: &str = "com.ryu.media";

/// The Memory app's plugin id — the `/api/memory` + `/api/memory/:id` long-term memory
/// CRUD surface (the Memory Library). Governance-shell leaf: default-on, no `requires`.
/// Gate-only (the `MemoryStore` is a `ServerState` field), so it is NOT behind a cargo
/// feature. The gate covers ONLY the HTTP CRUD surface; the in-process chat auto-recall
/// path is kernel and never HTTP-loops back through `/api/memory`.
pub const MEMORY_PLUGIN_ID: &str = "com.ryu.memory";

/// The Webhooks app's plugin id — the inbound webhook endpoint registry surfaced by
/// the sandboxed `apps-store/webhooks/ui` companion (W7 frontend extraction). Unlike
/// the other leaf shells this is NOT a route gate: `/api/webhooks` +
/// `/api/webhook-ingress/status` are read-only and stay ungated on the main router
/// (the desktop host calls them directly, monitors pattern). The manifest exists only
/// to seed the companion's UI bundle + `webhooks:crud` grant. Default-on so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const WEBHOOKS_PLUGIN_ID: &str = "com.ryu.webhooks";

/// The Activity app's plugin id — the unified chronological feed surfaced by the
/// sandboxed `apps-store/activity/ui` companion (W7 frontend extraction). Like
/// `webhooks` this is NOT a route gate: `/api/activity` (+ its `/stream`) is
/// read-only and stays ungated on the main router (the desktop host calls it
/// directly, monitors pattern). The manifest exists only to seed the companion's UI
/// bundle + `activity:read` grant. Default-on so the companion is present on every
/// fresh install (the page it replaced was always-on).
pub const ACTIVITY_PLUGIN_ID: &str = "com.ryu.activity";

/// The Calendar app's plugin id — the scheduled-runs calendar (agent/workflow jobs
/// projected onto Month/Week/Day/Agenda) surfaced by the sandboxed
/// `apps-store/calendar/ui` companion (W7 frontend extraction). Like `webhooks`/
/// `activity` this is NOT a route gate: the underlying `/heartbeat/jobs` +
/// `/workflows` + `/api/agents` endpoints stay ungated on the main router (the
/// desktop host calls them directly, monitors pattern). The manifest exists only to
/// seed the companion's UI bundle + `calendar:crud` grant. Default-on so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const CALENDAR_PLUGIN_ID: &str = "com.ryu.calendar";

/// The Timeline app's plugin id — the CapCut-style activity replay scrubber
/// (Shadow's captured lanes + keyframe preview + Dayflow work journal) surfaced by
/// the sandboxed `apps-store/timeline/ui` companion (W7 frontend extraction). Like
/// `webhooks`/`activity`/`calendar` this is NOT a route gate: Shadow's device-local
/// `/timeline` + `/journal` + `/frame` endpoints live on the Shadow sidecar (:3030),
/// not the Core router, and the desktop host calls them directly (the monitors
/// pattern, but WITHOUT a node token — Shadow is machine-pinned). The manifest exists
/// only to seed the companion's UI bundle + `timeline:read` grant. Default-on so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const TIMELINE_PLUGIN_ID: &str = "com.ryu.timeline";

/// The Skill Editor app's plugin id — the SKILL.md authoring editor (front-matter
/// form fields + a markdown body + server-backed version history) surfaced by the
/// sandboxed `apps-store/skill-editor/ui` companion (W7 frontend extraction). Like
/// `webhooks`/`activity`/`timeline` this is NOT a route gate: Core's `/api/skills`
/// authoring endpoints stay ungated on the router and the desktop host calls them
/// directly (the monitors pattern), so this manifest exists only to seed the
/// companion's UI bundle + `skills:crud` grant. Default-on so the editor's
/// `/skills/new` + `/skills/:id/edit` routes resolve on every fresh install.
pub const SKILL_EDITOR_PLUGIN_ID: &str = "com.ryu.skill-editor";

/// The set of **Core-tier** built-in plugin ids (#444).
///
/// Core-tier plugins are first-party and shipped with Ryu; they are seeded
/// enabled at startup (a one-time seed that respects a user's later disable) and
/// render in the "Core" section of the App-store. Every other plugin — including
/// user-installed ones and built-in fixtures NOT in this list — is
/// [`PluginTier::Community`] (install-then-enable opt-in).
///
/// Tier is derived from *membership here*, never from a manifest field, so a
/// plugin cannot promote itself to Core.
///
/// Defaults policy:
/// - `engines` (local llama.cpp) ships enabled (zero-setup chat on install).
/// - `durable` (the in-process durable workflow engine) ships enabled — it runs
///   on every platform with no extra sidecar, so it is a zero-setup default-on
///   dogfood (#448) declared as an `engine` runnable.
/// - `ghost`/`shadow`/`spider`/`agentbrowser` are the sidecar-backed default
///   tool apps. They are Core-tier AND default-on: on a fresh install their app
///   record is auto-seeded enabled (so they appear installed exactly like the
///   auto-downloaded default models), while the tool process still runs through
///   its own sidecar/MCP lifecycle. Their fixtures declare no runnables (the
///   tools come from the dedicated MCP provider); the record is the governance
///   shell (see `crate::plugin_manifest` `BUILTIN_MANIFESTS` doc).
/// - `firewall`/`routing`/`sandbox` are Core-tier but **opt-in** (they change
///   gateway/sandbox behaviour), so they are NOT in [`CORE_DEFAULT_ON`].
/// - `headroom` (egress compression) is deliberately **Community-tier**: the
///   compression *service* is the plugin and Core only hosts the gateway
///   transform, so it is install-then-enable from the marketplace exactly like a
///   third-party compression plugin would be. The bundled fixture is our
///   reference; nothing about the service is hardcoded.
pub const CORE_PLUGINS: &[&str] = &[
    "ghost",
    "shadow",
    "spider",
    "agentbrowser",
    "firewall",
    "routing",
    "sandbox",
    // Mail (Agent Inboxes) — manifest-driven app; its `ryu-mail` sidecar is spawned
    // by the generic loader (see MAIL_PLUGIN_ID).
    MAIL_PLUGIN_ID,
    // RAG capability provider (default in-process embeddings+retrieval).
    RAG_PLUGIN_ID,
    // System-wide predictive typing. Core-tier but opt-in (NOT in CORE_DEFAULT_ON):
    // enabling it is the single on/off switch for the /api/predict/* brain, and it
    // sends text from arbitrary apps to a model, so it ships disabled.
    "predict",
    "engines",
    "durable",
    "goal",
    "proof",
    "double-check",
    // Pre-turn prompt-improver: rewrites the outgoing message via a configurable
    // model before it is sent. Reverse-DNS id (matches its manifest + composer flag).
    "com.ryuhq.auto-expand",
    // Ryu Apps (widget-rendering in-process apps). All ship default-on so their
    // widgets render on install; widget-initiated writes are call-time
    // Gateway-gated (governed round-trip), so default-on is safe.
    "checklist",
    "smart-intake-form",
    "data-grid-explorer",
    "chart-studio",
    "decision-wizard",
    "quest-board",
    "worktree-diff-review",
    "gateway-budget-dial",
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`) that owns its
    // Space documents via `spaces:docs`. Default-on; `plugins::seed` gives it its
    // approved grants + `ui_code` HTML blob. Replaces the built-in whiteboard editor.
    "com.ryu.whiteboard",
    // The Canvas app — a full-page Companion (`ui_format:"html"`) that owns its Space
    // documents via `spaces:docs` and drives generation nodes through the window.ryu
    // media/agent bridge. Default-on; `plugins::seed` gives it its approved
    // grants + `ui_code` HTML blob. Replaces the built-in creative-canvas board.
    "com.ryu.canvas",
    // The Fine-tuning app — a full-page Companion (`ui_format:"html"`) that drives
    // Core's fine-tune orchestration via `finetune:runs` and owns its Unsloth Python
    // training sidecar (spawned on the Core-tier auto-run path, so it declares no
    // `sidecar:process` grant — the Gateway denies that grant at enable). Default-on;
    // `plugins::seed` gives it its approved grants + `ui_code` HTML blob. Replaces the
    // built-in fine-tuning page.
    "com.ryu.finetune",
    // Spaces + Meetings — the first REAL plugin→plugin dependency edge. Both are
    // governance shells: the implementation stays in-crate and the record gates it
    // (Meetings' `/api/meetings/*` routes are refused when the app is disabled —
    // see `server::require_app_enabled`). Both default-on, so today's behaviour is
    // unchanged on a fresh install; the dependency only bites when a user disables
    // Spaces while Meetings is still on, which the graph now refuses.
    SPACES_PLUGIN_ID,
    MEETINGS_PLUGIN_ID,
    // Five leaf-feature governance shells (research/dashboards/teams/clips/recipes).
    // Core-tier AND default-on: their `/api/<feature>/*` routes were always-on
    // before the gate, so a default-on seed is what keeps them reachable on every
    // existing install (same reasoning as Meetings/Spaces). `clips`→`shadow` and
    // `recipes`→`ghost` are real `requires` edges; both deps are default-on, so the
    // fail-closed seeder never skips them.
    RESEARCH_PLUGIN_ID,
    DASHBOARDS_PLUGIN_ID,
    TEAMS_PLUGIN_ID,
    CLIPS_PLUGIN_ID,
    RECIPES_PLUGIN_ID,
    // Wave-2 leaf-feature governance shells (quests/approvals/skills/learning/
    // healing). Core-tier AND default-on: their `/api/<feature>/*` routes were
    // always-on before the gate, so a default-on seed keeps them reachable on every
    // existing install (same reasoning as the wave-1 five). `learning`→`skills` and
    // `healing`→`approvals` are real `requires` edges; both deps are default-on, so
    // the fail-closed seeder never skips them.
    QUESTS_PLUGIN_ID,
    APPROVALS_PLUGIN_ID,
    SKILLS_PLUGIN_ID,
    LEARNING_PLUGIN_ID,
    HEALING_PLUGIN_ID,
    // Wave-3 leaf-feature governance shells (monitors/hardware). Core-tier AND
    // default-on: their `/api/<feature>/*` routes were always-on before the gate, so
    // a default-on seed keeps them reachable on every existing install. Neither
    // declares `requires` (the scheduler + device store are kernel infra).
    MONITORS_PLUGIN_ID,
    HARDWARE_PLUGIN_ID,
    // The wave-4 two, default-on so their always-on routes stay reachable after
    // gating (see CORE_PLUGINS). Neither has a `requires` edge; `agents` is also
    // load-bearing (it can only be disabled with an explicit force override).
    WORKFLOWS_PLUGIN_ID,
    AGENTS_PLUGIN_ID,
    // W0 honest-gating baseline: three data-path governance shells whose
    // `/api/{voice,images+video+gifs,memory}/*` routes were mounted RAW before this
    // wave. Core-tier AND default-on so the gate is transparent on every existing
    // install (the routes were always-on before). Neither declares `requires`; the
    // `voice`/`media`/`memory` modules stay in-crate (gate-only, no cargo feature).
    VOICE_PLUGIN_ID,
    MEDIA_PLUGIN_ID,
    MEMORY_PLUGIN_ID,
    // W7 frontend extraction: the webhooks page became a sandboxed companion app.
    // Not a route gate (the `/api/webhooks*` reads stay ungated) — Core-tier + default-on
    // so the companion is present on every fresh install. No `requires` edge.
    WEBHOOKS_PLUGIN_ID,
    // W7 frontend extraction: the activity feed page became a sandboxed companion app.
    // Not a route gate (the `/api/activity` read stays ungated) — Core-tier + default-on
    // so the companion is present on every fresh install. No `requires` edge.
    ACTIVITY_PLUGIN_ID,
    // W7 frontend extraction: the calendar page became a sandboxed companion app.
    // Not a route gate (the `/heartbeat/jobs` + `/workflows` + `/api/agents` reads stay
    // ungated) — Core-tier + default-on so the companion is present on every fresh
    // install. No `requires` edge.
    CALENDAR_PLUGIN_ID,
    // W7 frontend extraction: the timeline page became a sandboxed companion app.
    // Not a route gate (Shadow's device-local `/timeline` + `/journal` + `/frame` live
    // on the Shadow sidecar :3030, not the Core router) — Core-tier + default-on so the
    // companion is present on every fresh install. No `requires` edge.
    TIMELINE_PLUGIN_ID,
    // W7 frontend extraction: the SKILL.md editor became a sandboxed companion app.
    // Not a route gate (`/api/skills` authoring endpoints stay ungated) — Core-tier +
    // default-on so the `/skills/new` + `/skills/:id/edit` routes resolve on every fresh
    // install. No `requires` edge.
    SKILL_EDITOR_PLUGIN_ID,
];

/// The subset of [`CORE_PLUGINS`] that should be **enabled by default** on a
/// fresh install (seeded at startup when the install has no prior record). The
/// opt-in Core plugins (firewall/routing/sandbox/headroom) are deliberately
/// excluded — they only activate when the user enables them.
///
/// The chat turn-hook plugins (`goal`/`proof`/`double-check`) ship default-on so
/// their features (persistent goals, proof-of-work verification, answer review)
/// work on **every surface** with zero setup, exactly like the built-in chat
/// commands they replaced. This is only affordable because each declares a cheap
/// `match` pre-gate (see [`crate::plugin_manifest::HookMatch`]): an idle hook
/// costs a flag/prefix check or one KV read, never a sandbox spawn. They stay
/// real, swappable plugins — a user can disable any of them, and the fixture is
/// the reference a third party can fork.
pub const CORE_DEFAULT_ON: &[&str] = &[
    "engines",
    "durable",
    "goal",
    "proof",
    "double-check",
    // The default tool apps — auto-installed (record seeded enabled) on a fresh
    // install so they show up like the auto-downloaded default models. The actual
    // process runs through its own sidecar/MCP lifecycle; enabling the record just
    // makes it a first-class, governed, disable-able App. Their fixtures declare no
    // runnables, so seeding never double-lists their tools.
    "ghost",
    "shadow",
    "spider",
    "agentbrowser",
    // NOTE: com.ryu.mail is intentionally NOT default-on. It is sidecar-only now
    // (the in-process path was deleted, Track C). The release now builds + ships the
    // `ryu-mail` binary alongside the other 10 sidecar bins (see
    // `.github/workflows/release.yml`), so the old "binary not yet shipped" blocker is
    // gone; mail is kept OPT-IN by product choice (an unconfigured inbox should not
    // surface on a fresh install). Stays in CORE_PLUGINS (installable/enable-able); a
    // dev build can also put it on PATH / set RYU_MAIL_BIN. See
    // docs/platform-decomposition-handoff.md.
    // RAG — default-on so retrieval works out of the box; requires `engines`
    // (the embed sidecar), which the capability graph pulls in + protects.
    RAG_PLUGIN_ID,
    // Auto-expand ships default-on so its composer toggle + `/expand` command are
    // available with zero setup; the flag/command `match` gate makes it free when
    // the toggle is off and no `/expand` is used (no sandbox spawn on idle turns).
    "com.ryuhq.auto-expand",
    // Ryu Apps — default-on so widgets render on install (see CORE_PLUGINS).
    "checklist",
    "smart-intake-form",
    "data-grid-explorer",
    "chart-studio",
    "decision-wizard",
    "quest-board",
    "worktree-diff-review",
    "gateway-budget-dial",
    // NOTE (default-off apps): whiteboard / canvas / finetune / meetings / quests /
    // approvals / learning / healing / monitors / workflows / activity / timeline /
    // skill-editor are intentionally NOT default-on — they stay installable +
    // enable-able from the Store (still in CORE_PLUGINS), but a fresh install ships
    // them OFF so the sidebar/App surface isn't pre-loaded with every feature.
    // Spaces stays default-on (it is a shared dependency, not a leaf feature).
    SPACES_PLUGIN_ID,
    // The five leaf-feature sidecar Apps (each serves `/api/<feature>/*` out-of-process
    // via a `public_mount` sidecar + the generic ext-proxy loader), default-on so their
    // always-on surface stays reachable (the mount is live only while enabled; see
    // CORE_PLUGINS). `clips`/`recipes` are declared
    // here alongside their deps (`shadow`/`ghost`, both already default-on); the
    // hand-written order is irrelevant — `seed::seed_order` topologically reorders
    // by `requires`, so a dependency is always seeded before its dependent.
    RESEARCH_PLUGIN_ID,
    DASHBOARDS_PLUGIN_ID,
    TEAMS_PLUGIN_ID,
    CLIPS_PLUGIN_ID,
    RECIPES_PLUGIN_ID,
    // `skills` stays default-on (a shared capability). `quests`/`approvals`/
    // `learning`/`healing` are default-OFF (see the note above) — `learning` requires
    // `skills` and `healing` requires `approvals`, so both leave the default set with
    // their dep, never orphaned.
    SKILLS_PLUGIN_ID,
    // `monitors` is default-OFF (see the note above). `hardware` stays default-on.
    HARDWARE_PLUGIN_ID,
    // `workflows` is default-OFF (see the note above). `agents` stays default-on and
    // is LOAD-BEARING (see `LOAD_BEARING_PLUGINS`) — chat depends on the agent list.
    AGENTS_PLUGIN_ID,
    // The W0 three data-path shells, default-on so their always-on routes stay
    // reachable after gating (see CORE_PLUGINS). Neither has a `requires` edge.
    //
    // NOTE: `predict` is deliberately absent — it is in CORE_PLUGINS but stays OPT-IN
    // (NOT default-on). Enabling the Predict plugin flips the system-wide predictive-
    // typing brain ON (`main.rs` seeds `predict::set_enabled(rec.enabled)` at boot),
    // which sends text from arbitrary apps to a model; the codebase ships it OFF by
    // design (fixture note + `predict::ENABLED = AtomicBool::new(false)`). Gating its
    // `/api/predict/*` routes on the opt-in app breaks no working install: the brain is
    // already default-off, so any install where predict actually works already has the
    // record enabled → the gate passes. Default-on would be a privacy regression.
    VOICE_PLUGIN_ID,
    MEDIA_PLUGIN_ID,
    MEMORY_PLUGIN_ID,
    // W7: the webhooks companion, default-on so it is present on every fresh install
    // (the page it replaced was always-on). No `requires` edge; not a route gate.
    WEBHOOKS_PLUGIN_ID,
    // W7: the calendar companion, default-on so it is present on every fresh install
    // (the page it replaced was always-on). No `requires` edge; not a route gate.
    CALENDAR_PLUGIN_ID,
    // `activity` / `timeline` / `skill-editor` are default-OFF (see the note above).
];

/// The [`crate::plugin_manifest::PluginTier`] of a plugin, derived from
/// membership in [`CORE_PLUGINS`]. Anything not listed is Community.
pub fn tier_for(manifest_id: &str) -> crate::plugin_manifest::PluginTier {
    if CORE_PLUGINS.contains(&manifest_id) {
        crate::plugin_manifest::PluginTier::Core
    } else {
        crate::plugin_manifest::PluginTier::Community
    }
}

/// Whether a Core-tier plugin should be seeded enabled on first run.
pub fn is_default_on(manifest_id: &str) -> bool {
    CORE_DEFAULT_ON.contains(&manifest_id)
}

/// Returns `true` if `manifest_id` is one of the built-in system apps.
pub fn is_builtin(manifest_id: &str) -> bool {
    SYSTEM_PLUGINS.iter().any(|s| s.manifest_id == manifest_id)
}

/// Finds the [`SystemPlugin`] descriptor for `manifest_id`, if it is a system app.
pub fn find_system_plugin(manifest_id: &str) -> Option<&'static SystemPlugin> {
    SYSTEM_PLUGINS.iter().find(|s| s.manifest_id == manifest_id)
}

/// Plugins that are **load-bearing**: disabling one breaks a core function every
/// install depends on, so a plain disable is refused and only an explicit
/// `force = true` override goes through (see
/// [`crate::plugins::lifecycle::disable_app`]).
///
/// This is NOT a wholly separate "protected" registry — it is the same
/// membership-driven mechanism as [`SYSTEM_PLUGINS`]/[`CORE_DEFAULT_ON`], checked
/// alongside them. Each entry is here because a runtime subsystem hard-depends on
/// its Policy/Engine runnable:
///
/// - `engines` — the local llama.cpp chat engine (Gemma) that every default agent
///   ("ryu"/Pi) and all zero-setup local chat routes through. Disabling it turns
///   off the default chat path, so a fresh install would appear broken with no
///   obvious cause. It is the load-bearing example the spec calls out explicitly.
/// - `durable` — the in-process durable workflow engine
///   (`workflow::durable::FallbackEngine`). Disabling it strips durable execution
///   (checkpoints + bounded `While` resume) out from under every workflow run, so
///   in-flight/scheduled workflows lose their durability guarantee.
/// - `com.ryu.agents` — the agent catalog/CRUD surface (`/api/agents/*`). The
///   composer fetches the agent list on boot to populate the picker, so a disabled
///   Agents app would leave chat with no selectable agent — a fresh install would
///   read as broken. The chat-serving ACP substrate is separate kernel code and is
///   never gated; this protects only the catalog surface the composer depends on.
///
/// Everything else stays freely swappable/disableable — this list is deliberately
/// minimal so the "nothing hardcoded, everything swappable" principle holds for
/// all but the two subsystems whose absence reads as a broken install.
pub const LOAD_BEARING_PLUGINS: &[&str] = &["engines", "durable", AGENTS_PLUGIN_ID];

/// Whether disabling `manifest_id` needs an explicit force override because a core
/// subsystem depends on it. See [`LOAD_BEARING_PLUGINS`].
pub fn is_load_bearing(manifest_id: &str) -> bool {
    LOAD_BEARING_PLUGINS.contains(&manifest_id)
}

/// Whether `manifest_id` may NOT be uninstalled (it can only be disabled).
///
/// A plugin is uninstall-protected when removing its lifecycle record would be
/// either meaningless or actively harmful:
///
/// - **It is a built-in system app** ([`is_builtin`], the sidecar-backed
///   ghost/shadow/spider/agentbrowser) — matching how `SystemAppCard` already
///   offers only enable/disable, never uninstall.
/// - **It is default-on** ([`is_default_on`]) — this is the real correctness crux.
///   A default-on plugin's manifest is compiled into the binary (`include_str!`),
///   and [`crate::plugins::seed::seed_default_on`] re-adds *exactly the
///   [`CORE_DEFAULT_ON`] set* whenever a record is missing. So removing a
///   default-on record does not uninstall the plugin — it resurrects, enabled,
///   on the very next boot. `is_default_on` IS the resurrection set, so refusing
///   it is what actually prevents a "removed" plugin from coming back.
///
/// The two predicates are reused as-is (no parallel list): `is_builtin` is a
/// strict subset of `is_default_on` here, kept in the OR as a defensive,
/// self-documenting statement of intent.
///
/// Opt-in built-ins (firewall/routing/sandbox/predict/…) are deliberately NOT
/// protected: they are not default-on, so removing their record cannot resurrect
/// them — it simply returns them to the install-then-enable state they started in,
/// which is a coherent uninstall. User-installed Community plugins are never
/// protected.
pub fn is_uninstall_protected(manifest_id: &str) -> bool {
    is_builtin(manifest_id) || is_default_on(manifest_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_apps_contains_default_tool_apps() {
        for id in ["ghost", "shadow", "spider", "agentbrowser"] {
            assert!(
                SYSTEM_PLUGINS.iter().any(|s| s.manifest_id == id),
                "{id} must be in SYSTEM_PLUGINS"
            );
        }
    }

    #[test]
    fn is_builtin_returns_true_for_known_ids() {
        assert!(is_builtin("ghost"));
        assert!(is_builtin("shadow"));
        assert!(is_builtin("spider"));
        assert!(is_builtin("agentbrowser"));
    }

    #[test]
    fn is_builtin_returns_false_for_unknown_ids() {
        assert!(!is_builtin("com.example.research-assistant"));
        assert!(!is_builtin("does.not.exist"));
    }

    #[test]
    fn find_system_plugin_returns_correct_metadata() {
        let ghost = find_system_plugin("ghost").expect("ghost must be found");
        assert_eq!(ghost.sidecar_name, "ghost");
        assert!(ghost.windows_first);
        assert!(ghost.local_only);

        let shadow = find_system_plugin("shadow").expect("shadow must be found");
        assert_eq!(shadow.sidecar_name, "shadow");
        assert!(shadow.windows_first);
        assert!(shadow.local_only);
    }

    #[test]
    fn find_system_plugin_returns_metadata_for_default_tool_apps() {
        let spider = find_system_plugin("spider").expect("spider must be found");
        assert_eq!(spider.sidecar_name, "spider");
        assert!(!spider.windows_first, "spider is cross-platform");

        let ab = find_system_plugin("agentbrowser").expect("agentbrowser must be found");
        assert_eq!(ab.sidecar_name, "agentbrowser");
        assert!(!ab.windows_first, "agentbrowser is cross-platform");
        assert!(!ab.local_only, "agentbrowser reaches the web");
    }

    #[test]
    fn find_system_plugin_returns_none_for_unknown_id() {
        assert!(find_system_plugin("does.not.exist").is_none());
    }

    // ── Two-tier registry (#444) ──────────────────────────────────────────────

    #[test]
    fn tier_for_core_plugins_is_core() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(tier_for("engines"), PluginTier::Core);
        assert_eq!(tier_for("ghost"), PluginTier::Core);
        assert_eq!(tier_for("firewall"), PluginTier::Core);
        assert_eq!(tier_for("sandbox"), PluginTier::Core);
        // #448 dogfood: the durable workflow engine plugin is Core-tier.
        assert_eq!(tier_for("durable"), PluginTier::Core);
        assert!(is_default_on("durable"));
    }

    /// The four sidecar-backed default tool apps are Core-tier AND default-on, so
    /// a fresh install auto-seeds their app record enabled (parity with the
    /// auto-downloaded default models). They are also system plugins (sidecar
    /// lifecycle) — the two facts coexist: the record is the governance shell, the
    /// sidecar/MCP provider is the run path.
    #[test]
    fn default_tool_apps_are_core_and_default_on_and_system() {
        use crate::plugin_manifest::PluginTier;
        for id in ["ghost", "shadow", "spider", "agentbrowser"] {
            assert_eq!(tier_for(id), PluginTier::Core, "{id} must be Core-tier");
            assert!(is_default_on(id), "{id} must be default-on (auto-seeded)");
            assert!(is_builtin(id), "{id} must be a system plugin");
        }
    }

    #[test]
    fn tier_for_unknown_is_community() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(
            tier_for("com.example.research-assistant"),
            PluginTier::Community
        );
        assert_eq!(tier_for("does.not.exist"), PluginTier::Community);
    }

    /// #444 Community-tier gate: a non-Core plugin is Community, is therefore NOT
    /// in `CORE_DEFAULT_ON`, and so is never auto-seeded — it must be
    /// install-then-enable opt-in. This asserts the tier gate end-to-end at the
    /// membership layer (the lifecycle store enforces the install-disabled default
    /// that `install_app` tests cover).
    #[test]
    fn community_plugin_is_opt_in_never_default_on() {
        use crate::plugin_manifest::PluginTier;
        let community_id = "com.example.research-assistant";
        // Tier is Community (not a manifest-asserted field — derived from membership).
        assert_eq!(tier_for(community_id), PluginTier::Community);
        // A Community plugin can never be Core-tier...
        assert!(!CORE_PLUGINS.contains(&community_id));
        // ...and therefore can never be default-on (auto-seeded). The startup
        // seeder iterates CORE_DEFAULT_ON only, so a Community plugin is never
        // touched until the user explicitly installs+enables it.
        assert!(!CORE_DEFAULT_ON.contains(&community_id));
        assert!(!is_default_on(community_id));
    }

    // ── The Meetings → Spaces dependency edge (the first REAL one) ────────────

    /// The edge exists in the SHIPPED fixtures, not just in a unit-test fixture.
    /// If this fails, the dependency system is unexercised against real code.
    #[test]
    fn meetings_declares_a_real_requires_edge_on_spaces() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();

        let spaces = manifests
            .iter()
            .find(|m| m.id == SPACES_PLUGIN_ID)
            .expect("the Spaces fixture must be registered in BUILTIN_MANIFESTS");
        let meetings = manifests
            .iter()
            .find(|m| m.id == MEETINGS_PLUGIN_ID)
            .expect("the Meetings fixture must be registered in BUILTIN_MANIFESTS");

        let requires = meetings
            .requires
            .as_ref()
            .expect("Meetings must declare `requires`");
        let dep = requires
            .apps
            .iter()
            .find(|d| d.id == SPACES_PLUGIN_ID)
            .expect("Meetings must require Spaces");
        assert_eq!(dep.min_version.as_deref(), Some("1.0.0"));

        // The declared minimum is actually satisfiable by the Spaces we ship —
        // a `requires` that no shipped version can satisfy would fail-closed the
        // default-on seed forever.
        assert_eq!(spaces.version, "1.0.0");

        // It declares the grant it really uses (`save_notes_to_space` →
        // `spaces.ingest_document`), the same grant the Whiteboard declares.
        assert!(meetings
            .permission_grants
            .contains(&"spaces:docs".to_owned()));
    }

    /// THE proof the dependency model works end-to-end against real code: Spaces
    /// cannot be disabled out from under an enabled Meetings, and the refusal NAMES
    /// the blocker so a UI can say "Disable Meetings first" (or offer a cascade)
    /// without parsing a string.
    #[tokio::test]
    async fn disabling_spaces_is_refused_while_meetings_is_enabled() {
        use crate::plugins::graph::DependencyError;
        use crate::plugins::lifecycle::{disable_app, DisableError};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // Both enabled, as a fresh install's seed leaves them.
        for id in [SPACES_PLUGIN_ID, MEETINGS_PLUGIN_ID] {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        // 1. REFUSED — and the error names the dependent.
        let err = disable_app(&store, SPACES_PLUGIN_ID, &manifests, false, false)
            .await
            .expect_err("disabling Spaces under an enabled Meetings must be refused");
        match err {
            DisableError::Dependency(DependencyError::BlockedByDependents {
                plugin,
                dependents,
            }) => {
                assert_eq!(plugin, SPACES_PLUGIN_ID);
                assert!(
                    dependents.contains(&MEETINGS_PLUGIN_ID.to_owned()),
                    "the refusal must name Meetings, got {dependents:?}"
                );
            }
            other => panic!("expected BlockedByDependents, got {other:?}"),
        }

        // A refused disable changes NOTHING (it is not a partial disable).
        assert!(store.get(SPACES_PLUGIN_ID).await.unwrap().unwrap().enabled);
        assert!(store.get(MEETINGS_PLUGIN_ID).await.unwrap().unwrap().enabled);

        // 2. Disable the dependent first, and Spaces disables cleanly.
        disable_app(&store, MEETINGS_PLUGIN_ID, &manifests, false, false)
            .await
            .expect("Meetings has no dependents, so it disables freely");
        disable_app(&store, SPACES_PLUGIN_ID, &manifests, false, false)
            .await
            .expect("with Meetings off, nothing blocks Spaces");

        assert!(!store.get(SPACES_PLUGIN_ID).await.unwrap().unwrap().enabled);
        assert!(!store.get(MEETINGS_PLUGIN_ID).await.unwrap().unwrap().enabled);
    }

    /// The opt-in escape hatch: one cascade disables the dependent *and* the
    /// dependency, dependents-first, so nothing is ever left enabled against a
    /// disabled dependency.
    #[tokio::test]
    async fn cascading_disable_of_spaces_takes_meetings_with_it() {
        use crate::plugins::lifecycle::disable_app;
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        for id in [SPACES_PLUGIN_ID, MEETINGS_PLUGIN_ID] {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        let outcome = disable_app(&store, SPACES_PLUGIN_ID, &manifests, true, false)
            .await
            .expect("an explicit cascade is allowed");

        let order: Vec<&str> = outcome.disabled.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            order,
            vec![MEETINGS_PLUGIN_ID, SPACES_PLUGIN_ID],
            "the dependent must be disabled BEFORE its dependency"
        );
        assert!(!store.get(SPACES_PLUGIN_ID).await.unwrap().unwrap().enabled);
        assert!(!store.get(MEETINGS_PLUGIN_ID).await.unwrap().unwrap().enabled);
    }

    /// The real default-on set must be fully satisfiable — every default-on plugin's
    /// `requires` is met from within the set, so nothing is fail-closed skipped, and
    /// Spaces (a shared dependency that stays default-on) is seeded.
    #[test]
    fn real_default_on_set_is_fully_satisfiable() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let specs = crate::plugins::seed::default_on_specs();
        let (ordered, skipped) = crate::plugins::seed::seed_order(&specs, &manifests);

        assert!(
            skipped.is_empty(),
            "no default-on plugin may be unsatisfiable: {skipped:?}"
        );
        assert!(
            ordered.iter().any(|id| id == SPACES_PLUGIN_ID),
            "Spaces stays default-on and must be seeded, got {ordered:?}"
        );
    }

    /// Spaces stays default-on; Meetings is now OPT-IN (default-off). A fresh seed
    /// enables Spaces but must NOT install Meetings — enabling it is a Store action.
    #[tokio::test]
    async fn the_real_seed_enables_spaces_but_leaves_meetings_optin() {
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        crate::plugins::seed::seed_default_on(&store, &manifests).await;

        let spaces = store
            .get(SPACES_PLUGIN_ID)
            .await
            .unwrap()
            .expect("the seed must install Spaces");
        assert!(spaces.enabled, "Spaces must be seeded ENABLED");

        assert!(
            store.get(MEETINGS_PLUGIN_ID).await.unwrap().is_none(),
            "Meetings is opt-in (default-off) — the seed must not install it"
        );
    }

    // ── Whiteboard + Canvas: the other two real Spaces dependents ─────────────

    /// The Whiteboard and Canvas companions own Space documents (`spaces:docs`, the
    /// grant `plugins::seed` persists for them so their sandboxed frames can call
    /// `spaces.*` on the plugin bridge). That is the SAME real coupling Meetings has,
    /// so they declare the same edge — otherwise a user could disable Spaces and leave
    /// both enabled on top of a dead dependency, which is precisely the half-enabled
    /// state `plugins::graph` exists to prevent, reachable from the Store's Switch.
    #[test]
    fn whiteboard_and_canvas_declare_their_real_spaces_dependency() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for id in [WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID] {
            let m = manifests
                .iter()
                .find(|m| m.id == id)
                .unwrap_or_else(|| panic!("'{id}' must be a built-in"));

            // It really does own Space documents...
            assert!(
                m.permission_grants.contains(&"spaces:docs".to_owned()),
                "'{id}' must declare the spaces:docs grant it uses"
            );
            // ...so it must declare the dependency that protects it.
            assert!(
                m.dependencies().iter().any(|d| d.id == SPACES_PLUGIN_ID),
                "'{id}' holds spaces:docs, so it must require Spaces"
            );
        }
    }

    /// The refusal names the FULL blast radius, not just the first dependent: with
    /// Meetings, Whiteboard, and Canvas all enabled, disabling Spaces is refused and
    /// the error lists all three, so a client can say "disable these first" (or offer
    /// one cascade) without guessing.
    #[tokio::test]
    async fn disabling_spaces_is_refused_while_any_space_owning_app_is_enabled() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};
        use crate::plugins::graph::DependencyError;
        use crate::plugins::lifecycle::{disable_app, DisableError};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        let dependents = [MEETINGS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID];
        for id in std::iter::once(SPACES_PLUGIN_ID).chain(dependents) {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        let err = disable_app(&store, SPACES_PLUGIN_ID, &manifests, false, false)
            .await
            .expect_err("Spaces has three enabled dependents");
        match err {
            DisableError::Dependency(DependencyError::BlockedByDependents {
                plugin,
                dependents: named,
            }) => {
                assert_eq!(plugin, SPACES_PLUGIN_ID);
                for id in dependents {
                    assert!(
                        named.contains(&id.to_owned()),
                        "the refusal must name '{id}', got {named:?}"
                    );
                }
            }
            other => panic!("expected BlockedByDependents, got {other:?}"),
        }

        // Nothing was disabled — a refusal is never a partial disable.
        for id in std::iter::once(SPACES_PLUGIN_ID).chain(dependents) {
            assert!(store.get(id).await.unwrap().unwrap().enabled, "'{id}'");
        }

        // The cascade takes every dependent with it, and Spaces goes LAST so nothing
        // is ever enabled against a disabled dependency.
        let outcome = disable_app(&store, SPACES_PLUGIN_ID, &manifests, true, false)
            .await
            .expect("an explicit cascade is allowed");
        assert_eq!(
            outcome.disabled.last().map(|r| r.id.as_str()),
            Some(SPACES_PLUGIN_ID),
            "the dependency must be disabled LAST, got {:?}",
            outcome.disabled.iter().map(|r| &r.id).collect::<Vec<_>>()
        );
        for id in std::iter::once(SPACES_PLUGIN_ID).chain(dependents) {
            assert!(!store.get(id).await.unwrap().unwrap().enabled, "'{id}'");
        }
    }

    /// THE silent-brick guard for the new edges.
    ///
    /// `seed::seed_order` is fail-CLOSED: a default-on plugin whose `requires` cannot
    /// be satisfied *from within the default-on set* is SKIPPED, not enabled. So the
    /// moment Whiteboard/Canvas declare `requires: Spaces`, their appearing on a fresh
    /// install depends on Spaces staying default-on. If that ever changes, both
    /// companions go dark for 100% of users with nothing but a log line. This drives
    /// the REAL seed over the REAL manifests and asserts the end state a user gets.
    #[tokio::test]
    async fn the_real_seed_enables_spaces_and_leaves_its_space_owning_apps_optin() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();

        // Nothing may be skipped, and Spaces (still default-on) must be seeded.
        let specs = crate::plugins::seed::default_on_specs();
        let (ordered, skipped) = crate::plugins::seed::seed_order(&specs, &manifests);
        assert!(
            skipped.is_empty(),
            "no default-on plugin may be unsatisfiable: {skipped:?}"
        );
        assert!(
            ordered.iter().any(|id| id == SPACES_PLUGIN_ID),
            "Spaces must be seeded, got {ordered:?}"
        );

        // Spaces is enabled; its former default-on dependents (meetings/whiteboard/
        // canvas) are now opt-in, so the seed must NOT install them.
        let store = PluginStore::open_in_memory().unwrap();
        crate::plugins::seed::seed_default_on(&store, &manifests).await;
        assert!(
            store
                .get(SPACES_PLUGIN_ID)
                .await
                .unwrap()
                .expect("the seed must install Spaces")
                .enabled,
            "Spaces must be seeded ENABLED"
        );
        for id in [MEETINGS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID] {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' is opt-in (default-off) — the seed must not install it"
            );
        }
    }

    // ── Load-bearing + uninstall-protection guards ────────────────────────────

    #[test]
    fn engines_is_load_bearing_and_default_swappables_are_not() {
        assert!(is_load_bearing("engines"), "engines is load-bearing");
        assert!(is_load_bearing("durable"), "durable is load-bearing");
        assert!(
            is_load_bearing(AGENTS_PLUGIN_ID),
            "agents is load-bearing (composer fetches the agent list on boot)"
        );
        // A freely-disableable Core plugin is NOT load-bearing.
        assert!(!is_load_bearing("goal"));
        assert!(!is_load_bearing("firewall"));
        assert!(!is_load_bearing("com.example.research-assistant"));
    }

    /// The uninstall-protection predicate must cover the FULL resurrection set
    /// (`is_default_on`), not just the 4 SYSTEM plugins. `goal` isolates the
    /// `is_default_on` branch: default-on, NOT a system plugin, NOT load-bearing —
    /// so a weak `is_builtin`-only predicate would wrongly allow uninstalling it,
    /// and the seed would resurrect it on the next boot.
    #[test]
    fn uninstall_protection_covers_every_default_on_plugin_not_just_system_apps() {
        // A default-on, non-SYSTEM plugin is protected (the crux).
        assert!(!is_builtin("goal"), "goal is not a SYSTEM plugin");
        assert!(is_default_on("goal"));
        assert!(
            is_uninstall_protected("goal"),
            "a default-on plugin must be uninstall-protected or the seed resurrects it"
        );
        // The SYSTEM sidecar apps are protected too.
        for id in ["ghost", "shadow", "spider", "agentbrowser"] {
            assert!(is_uninstall_protected(id), "{id} must be protected");
        }
        // engines/durable (default-on + load-bearing) are protected.
        assert!(is_uninstall_protected("engines"));
        assert!(is_uninstall_protected("durable"));
    }

    #[test]
    fn opt_in_builtins_and_community_plugins_are_not_uninstall_protected() {
        // Opt-in built-ins are compiled-in but NOT default-on, so removing their
        // record cannot resurrect them — uninstall is allowed.
        for id in ["firewall", "routing", "sandbox", "predict"] {
            assert!(
                !is_uninstall_protected(id),
                "{id} is opt-in (not default-on) and must be uninstallable"
            );
        }
        // A user-installed Community plugin is always uninstallable.
        assert!(!is_uninstall_protected("com.example.research-assistant"));
    }

    #[test]
    fn default_on_is_a_subset_of_core_and_opt_in_excluded() {
        // Every default-on plugin must be Core-tier.
        for id in CORE_DEFAULT_ON {
            assert!(
                CORE_PLUGINS.contains(id),
                "default-on plugin '{id}' must be Core-tier"
            );
            assert!(is_default_on(id));
        }
        // Gateway/sandbox policy plugins are Core-tier but NOT default-on
        // (they change gateway/sandbox behaviour, so they stay opt-in).
        assert!(!is_default_on("firewall"));
        assert!(!is_default_on("routing"));
        assert!(!is_default_on("sandbox"));
        assert!(!is_default_on("headroom"));
        // Predictive typing is Core-tier but opt-in (sends text to a model).
        assert!(CORE_PLUGINS.contains(&"predict"));
        assert!(!is_default_on("predict"));
    }
}
