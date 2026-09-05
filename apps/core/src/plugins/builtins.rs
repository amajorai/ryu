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
//! 3. [`is_system_plugin`] and [`find_system_plugin`] helpers consumed by
//!    `server/mod.rs`.
//!
//! # Core-vs-Gateway boundary
//!
//! Sidecar install/start/stop is "what runs" — it belongs in Core. Policy
//! decisions (grant enforcement, security checks) belong in the Gateway.
//! Nothing in this module enforces policy.

/// Metadata describing a system App whose lifecycle is sidecar-based.
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

/// The canonical list of system Apps. This is intentionally a much smaller set
/// than the official plugin catalog: being shipped by Ryu or verified by the
/// Ryu Marketplace does not make an app part of Core or uninstall-protected.
///
/// Order is stable and determines display order in the App-store.
pub const SYSTEM_PLUGINS: &[SystemPlugin] = &[
    SystemPlugin {
        manifest_id: "@ryu/ghost",
        sidecar_name: "@ryu/ghost",
        windows_first: false,
        local_only: true,
    },
    SystemPlugin {
        manifest_id: "@ryu/shadow",
        sidecar_name: "@ryu/shadow",
        windows_first: false,
        local_only: true,
    },
    // (Spider is NO LONGER a system plugin: it became a declarative `command`
    // tool — fixtures/spider.manifest.json — that shells out to a user-installed
    // `spider` CLI via the command-tool allowlist, with no Core-managed sidecar
    // lifecycle. It stays Core-tier + pre-installed via CORE_PLUGINS / CORE_PREINSTALLED
    // so its record seeds enabled and the tool is available out of the box.)
    // Agent Browser is the default web-browsing tool: an npx-launched MCP server
    // (npm `agentbrowser`), declared under `mcp_servers` in its plugin manifest
    // (fixtures/agentbrowser.manifest.json) and registered on activation.
    // Cross-platform (Node) and reaches the web, so neither Windows-first nor
    // local-only.
    SystemPlugin {
        manifest_id: "@ryu/agentbrowser",
        sidecar_name: "@ryu/agentbrowser",
        windows_first: false,
        local_only: false,
    },
    // Browser is the workspace's real-Chromium sidecar (an Electron GUI app,
    // `browser` sidecar on :7993) that backs the workspace "Browser" tab. A core
    // built-in and therefore uninstall-protected (`is_system_plugin`), but NOT
    // pre-installed: no release publishes a spawnable `ryu-browser-<os>-<arch>`
    // asset yet, so it is opt-in from the Store (see the note in `CORE_PREINSTALLED`).
    // Cross-platform Electron, runs locally on the node.
    SystemPlugin {
        manifest_id: BROWSER_PLUGIN_ID,
        sidecar_name: "browser",
        windows_first: false,
        local_only: true,
    },
];

/// The Browser app's plugin id — the workspace's real-Chromium sidecar that backs
/// the "Browser" workspace tab. A core built-in (see [`SYSTEM_PLUGINS`]) and so
/// non-uninstallable, but **opt-in**: deliberately absent from [`CORE_PREINSTALLED`]
/// until a release publishes an installable sidecar binary (the WHY is documented at
/// that absence). While it is disabled the desktop's Browser tab keeps its sandboxed
/// iframe fallback, which works.
pub const BROWSER_PLUGIN_ID: &str = "@ryu/browser";

/// Native workspace entry for the Gateway-owned WhatsApp Personal and WhatsApp
/// Business channel adapters. It has no sidecar or route of its own: the enabled
/// manifest contributes the desktop button, while the existing channel control
/// plane remains authoritative for credentials and delivery.
pub const WHATSAPP_PLUGIN_ID: &str = "@ryu/whatsapp";

/// The first-party Composio Connect plugin id. It is a hosted remote MCP bridge,
/// separate from the direct `composio.<action>` API-key integration.
pub const COMPOSIO_CONNECT_PLUGIN_ID: &str = "@ryu/composio-connect";

/// The Spaces app's plugin id — the document store + RAG index other apps write
/// into. It is a **dependency target**: an app that owns Space documents declares
/// `requires.apps = [{ id: SPACES_PLUGIN_ID }]` so the graph refuses to disable
/// Spaces out from under it.
pub const SPACES_PLUGIN_ID: &str = "@ryu/spaces";

/// The Meetings app's plugin id — record → transcript → AI notes, auto-saved into
/// the "Meetings" Space.
///
/// The FIRST first-party plugin to declare a real `requires` edge (→ Spaces). The
/// coupling is not decorative: `server/meetings_api.rs::save_notes_to_space` calls
/// `state.spaces.ingest_document`, and `ensure_meetings_space` calls
/// `state.spaces.{list_spaces, create_space}`.
pub const MEETINGS_PLUGIN_ID: &str = "@ryu/meetings";

/// The Outpost app's plugin id — social scheduling + publishing over the `ryu-social`
/// sidecar (`apps-store/social/`).
///
/// A governance-shell leaf with a companion: no `requires` edge (it owns its own
/// sidecar and its own SQLite database), Core-tier so its sidecar spawns on the
/// auto-run path, and therefore deliberately NOT declaring `sidecar:process` — the
/// Gateway denies that grant at enable. Core links zero social code; everything it
/// serves arrives through the generic ext-proxy `public_mount`.
pub const SOCIAL_PLUGIN_ID: &str = "@ryu/social";

/// The Token Table app's plugin id — a cosmetic six-max Hold'em Companion over
/// the standalone `ryu-token-table` sidecar and generic app/realtime bridges.
pub const TOKEN_TABLE_PLUGIN_ID: &str = "@ryu/token-table";

/// The Subtitles app's plugin id — local transcription + translation of a video into
/// a timed `.srt`/`.vtt`, over the `ryu-subtitles` sidecar (`apps-store/subtitles/`).
///
/// Same posture as [`SOCIAL_PLUGIN_ID`] directly above: a governance-shell leaf with a
/// companion, no `requires` edge (it owns its sidecar and its own SQLite database),
/// Core-tier via the [`CORE_PLUGINS`] row below so its sidecar spawns on the auto-run
/// path, and therefore deliberately NOT declaring `sidecar:process` — the Gateway
/// denies that grant at enable. Core links zero subtitle code; everything it serves
/// arrives through the generic ext-proxy `public_mount`.
pub const SUBTITLES_PLUGIN_ID: &str = "@ryu/subtitles";

/// The Deep Read app's plugin id — Recursive Language Models over the `ryu-rlm`
/// sidecar (`apps-store/rlm/`).
///
/// Same posture as [`SOCIAL_PLUGIN_ID`] above: a governance-shell leaf with a
/// companion, no `requires` edge (it owns its sidecar and its own on-disk context
/// store), Core-tier via the [`CORE_PLUGINS`] row below so its sidecar spawns on the
/// auto-run path AND its `mcp_servers` block registers, and therefore deliberately
/// NOT declaring `sidecar:process` — the Gateway denies that grant at enable. Core
/// links zero RLM code; everything it serves arrives through the generic ext-proxy
/// `public_mount`, and the one callback the sidecar makes is the generic
/// `/api/host/model/complete` gated on `hook:side-model`.
pub const RLM_PLUGIN_ID: &str = "@ryu/rlm";

/// The Tuition app's plugin id — a single-learner tutor over the `ryu-tuition` sidecar
/// (`apps-store/tuition/`).
///
/// A governance-shell leaf with a companion: no `requires` edge (it owns its sidecar
/// and its own SQLite database), Core-tier so that sidecar spawns on the auto-run path
/// and its `mcp_servers` entry registers, and therefore deliberately NOT declaring
/// `sidecar:process` — the Gateway denies that grant at enable. Core links zero
/// tuition code; everything it serves arrives through the generic ext-proxy.
pub const TUITION_PLUGIN_ID: &str = "@ryu/tuition";

/// The Wire app's plugin id — a personal newsroom over the `ryu-news` sidecar
/// (`apps-store/news/`). Same posture as [`TUITION_PLUGIN_ID`].
pub const NEWS_PLUGIN_ID: &str = "@ryu/news";

/// The Simulators app's plugin id — iOS `simctl` + Android `adb` control over the
/// `ryu-simulator` sidecar (`apps-store/simulator/`).
///
/// Same posture as [`CRM_PLUGIN_ID`] below: a governance-shell leaf with NO companion
/// bundle (`companion: null` — its desktop surface is a native dock panel over the
/// generic ext-proxy), so it needs no companion-bundle seed row. Core-tier via the
/// [`CORE_PLUGINS`] row below so its
/// sidecar spawns on the auto-run path, and therefore deliberately NOT declaring
/// `sidecar:process` — the Gateway denies that grant at enable.
pub const SIMULATOR_PLUGIN_ID: &str = "@ryu/simulator";

/// Harbor's plugin id — an object-first CRM over the `ryu-crm` sidecar
/// (`apps-store/crm/`). Core-tier for the same reason as Outpost (its sidecar must
/// spawn on the auto-run path, and a Community-tier sidecar would need the
/// `sidecar:process` grant the Gateway denies at enable), and Core links zero CRM
/// code. Its desktop surface is a native dock panel over the generic ext-proxy, so
/// unlike Outpost it ships no UI bundle and needs NO `plugins::seed` row.
pub const CRM_PLUGIN_ID: &str = "@ryu/crm";

/// Expenses is a local-first ledger over the `ryu-expenses` sidecar
/// (`apps-store/expenses/`). Core-tier lets its managed sidecar and manifest-owned
/// MCP server run through the generic lifecycle; it remains opt-in because the
/// app owns a process and is not part of the fresh-install preinstalled set.
pub const EXPENSES_PLUGIN_ID: &str = "@ryu/expenses";

/// Outreach is the small-batch campaign layer between Harbor CRM and Agent
/// Inboxes. It is Core-tier because its compiled companion uses the reviewed
/// model, storage, Mail, catalog, shell-theme, and toast host primitives; it
/// remains opt-in so no outbound surface appears on a fresh node.
pub const OUTREACH_PLUGIN_ID: &str = "@ryu/outreach";

/// Autopilot is the company-level orchestration layer over Ryu's existing agent
/// and app surfaces. It stays opt-in because running a tool-using company cycle
/// spends model budget and can propose changes across enabled apps.
pub const AUTOPILOT_PLUGIN_ID: &str = "@ryu/autopilot";

/// Projects is the local work-management layer between a customer record and
/// an automation run. It is a Core-tier, opt-in Companion over shared storage.
pub const PROJECTS_PLUGIN_ID: &str = "@ryu/projects";

/// Invoices is a local accounts-receivable register. It tracks status and due
/// dates but deliberately does not replace payment processing or accounting.
pub const INVOICES_PLUGIN_ID: &str = "@ryu/invoices";

/// People is a private local team directory for roles, onboarding, and leave
/// status. Payroll and HRIS integrations remain outside the app.
pub const PEOPLE_PLUGIN_ID: &str = "@ryu/people";

/// Backstage is an external-repository Companion app. Its editor remains owned by
/// `amajorai/backstage`; Ryu owns the generic host lifecycle, storage, and AI
/// bridges. Its UI carriage is supplied by the external Marketplace/standalone
/// package rather than compiled into Core.
pub const BACKSTAGE_PLUGIN_ID: &str = "@ryu/backstage";

/// The Blueprint app's plugin id — visual plan review over the `ryu-blueprint`
/// sidecar (`apps-store/blueprint/`). Shared by the [`CORE_PLUGINS`] row below and
/// the `plugins::seed` companion-bundle table.
///
/// It is opt-in and install-on-demand like the other non-default companions. The
/// compiled UI bundle is attached by the explicit lifecycle install path, so no
/// disabled record is needed merely to store it.
///
/// Declared HERE rather than in `plugin_manifest` (where `REASONING_PLUGIN_ID` and
/// the older companion ids ended up) because the only thing this id decides is
/// plugin *policy* — tier membership and pre-installed behavior — and those tables
/// tables live in `plugins::`. `plugin_manifest` owns the compiled-in bytes
/// (`BLUEPRINT_UI_HTML`), which is a different question. Same shape as
/// [`SOCIAL_PLUGIN_ID`] directly above.
pub const BLUEPRINT_PLUGIN_ID: &str = "@ryu/blueprint";

/// The Research app's plugin id — the `/api/research/*` proxy over the autoresearch
/// sidecar. A governance-shell leaf: pre-installed, no `requires` (it owns its own
/// sidecar), compile-out-able behind the `research` cargo feature.
pub const RESEARCH_PLUGIN_ID: &str = "@ryu/research";

/// The MarkItDown app's plugin id — the **shipped default** provider of the
/// `document.parse` capability (`apps-store/markitdown/`, a Python sidecar wrapping
/// Microsoft's MIT-licensed MarkItDown). The only one of the five parsing backends in
/// [`CORE_PREINSTALLED`], and the only one whose `provides` block carries
/// `"default": true` — see the block comment on its entry there for why both halves
/// are load-bearing and why the other four stay opt-in.
pub const MARKITDOWN_PLUGIN_ID: &str = "@ryu/markitdown";

/// The AnyDoc app's plugin id — a `document.parse` provider
/// (`apps-store/anydoc/`) backed by Firecrawl's MIT-licensed Rust converter.
/// It is Core-tier and opt-in: the binary is lightweight, but it is a separate
/// service and should not silently replace the shipped MarkItDown default.
pub const ANYDOC_PLUGIN_ID: &str = "@ryu/anydoc";

/// The Unstructured app's plugin id — a `document.parse` provider
/// (`apps-store/unstructured/`, a Python sidecar wrapping the Apache-2.0 Unstructured
/// library). Core-tier and governed, but **not pre-installed**: it is absent from
/// [`CORE_PREINSTALLED`] because `unstructured[all-docs]` is a 1-2 GB pip install whose
/// native helpers (poppler/tesseract/libreoffice/pandoc) are not pip-installable, so
/// it is opt-in from the Store — the same shape as `finetune`.
pub const UNSTRUCTURED_PLUGIN_ID: &str = "@ryu/unstructured";

/// The Docling app's plugin id — a `document.parse` provider (`apps-store/docling/`,
/// a Python sidecar wrapping IBM's MIT-licensed Docling). Core-tier and governed but
/// **not pre-installed** (absent from [`CORE_PREINSTALLED`]): it pulls a Torch stack and
/// downloads layout/OCR models on first parse.
///
/// It is also the id the `document.parse` binding falls back to if `markitdown` ever
/// loses its `"default": true` — `@ryu/anydoc` sorts lexicographically lowest of
/// the five, and the tiebreak is alphabetical. That fallback would be an accident,
/// never an intent.
pub const DOCLING_PLUGIN_ID: &str = "@ryu/docling";

/// The MinerU app's plugin id — a `document.parse` provider (`apps-store/mineru/`, a
/// Python sidecar driving the AGPL-licensed MinerU CLI, PDF-focused). Core-tier and
/// governed but **not pre-installed** (absent from [`CORE_PREINSTALLED`]): heaviest of the
/// five (model downloads, GPU-oriented backends), so it is opt-in from the Store.
pub const MINERU_PLUGIN_ID: &str = "@ryu/mineru";

/// The Dashboards app's plugin id — the `/api/dashboards/*` live widget-grid
/// surface. Governance-shell leaf: pre-installed, no `requires` (soft HTTP loopback to
/// monitors/etc). Gate-only (deep in-crate coupling to hardware displays +
/// `dashboard_builder`), so it is NOT behind a cargo feature.
pub const DASHBOARDS_PLUGIN_ID: &str = "@ryu/dashboards";

/// The Teams app's plugin id — the `/api/teams/*` CRUD surface over agent teams.
/// Governance-shell leaf: pre-installed, no `requires` (stores agent-id strings only).
/// Gate-only (the store also backs `@team` chat routing + `agent_builder`), so it
/// is NOT behind a cargo feature.
pub const TEAMS_PLUGIN_ID: &str = "@ryu/teams";

/// The Clips app's plugin id — the `/api/clips/*` Core→Shadow capture proxy. It
/// `requires` the `shadow` app (its recordings live in Shadow), so the graph
/// refuses to disable Shadow out from under an enabled Clips. Core-tier and
/// installable on demand; its optional Companion bundle is carried by the app seed
/// table, while the capture surface remains compile-out-able behind the `clips` feature.
pub const CLIPS_PLUGIN_ID: &str = "@ryu/clips";

/// The Recipes app's plugin id — the `/api/recipes/*` record→replay surface over
/// Ghost's RecipeStore. It `requires` the `ghost` app, so the graph refuses to
/// disable Ghost out from under an enabled Recipes. NOT pre-installed and therefore
/// install-on-demand: the
/// whole surface is out-of-process in the `ryu-recipes` sidecar, so Core links no
/// recipes code and there is no `recipes` cargo feature.
pub const RECIPES_PLUGIN_ID: &str = "@ryu/recipes";

/// The Mail (Agent Inboxes) app's plugin id. Unlike the gate-only apps above, Mail is
/// a **fully manifest-driven** app: its `ryu-mail` sidecar (a local sibling binary) is
/// spawned by the generic loader and its `/api/mail/*` surface is proxied via the
/// `public_mount` mechanism — there is no hand-coded Rust proxy. Pre-installed so the
/// externally-committed inbound-webhook URL resolves out of the box.
pub const MAIL_PLUGIN_ID: &str = "@ryu/mail";
/// The Warmup app — an opt-in companion that schedules a keep-alive ping to each
/// subscription agent so its rolling usage window is already open. Named here
/// because [`crate::plugins::seed`] needs the id for its `ui_code` seed row.
pub const WARMUP_PLUGIN_ID: &str = "@ryu/warmup";

/// The RAG capability app's plugin id — the default in-process embeddings+retrieval
/// provider. Declares `provides:[rag]` + `requires:[engines]`, so the capability
/// binding/graph resolves rag→engines for real (Track B). Pre-installed; a GraphRAG or
/// third-party provider app can bind the `rag` capability to swap the implementation.
pub const RAG_PLUGIN_ID: &str = "@ryu/rag";

/// The local inference-engine capability required by the built-in RAG provider.
/// It is Core-owned and compiled into the runtime because there is no marketplace
/// package to materialize before the first Spaces request.
pub const ENGINES_PLUGIN_ID: &str = "@ryu/engines";

/// The Message Reactions plugin id. Core supplies the persistence handlers and
/// the desktop supplies the native picker; this id governs both through the
/// generic AppGate and the message-action contribution.
pub const REACTIONS_PLUGIN_ID: &str = "@ryu/reactions";

/// The Side Chats plugin id. The `/btw` model bridge remains in Core, while this
/// plugin owns the slash command, chat feature declaration, and persisted aside
/// route lifecycle.
pub const SIDE_CHATS_PLUGIN_ID: &str = "@ryu/side-chats";

/// The Temporary Chats plugin id. It governs the desktop-only `ghostMode` chat
/// behavior; unlike `@ryu/ghost`, it is not the computer-control provider.
pub const GHOST_CHATS_PLUGIN_ID: &str = "@ryu/ghost-chats";

/// The Expanded Composer plugin id. The desktop host owns the shared dialog
/// surface; this id gates the feature contribution and its toolbar affordance.
pub const EXPANDED_COMPOSER_PLUGIN_ID: &str = "@ryu/expanded-composer";

/// The Session Stats plugin id. Core only carries the declarative contribution;
/// the desktop host owns the safe transcript renderer and provider normalization.
pub const STATS_PLUGIN_ID: &str = "@ryu/stats";

/// The Quests app's plugin id — the `/api/quests/*` auto-detecting todo board.
/// Governance-shell leaf: pre-installed, no `requires` (the scheduler is kernel infra).
/// The engine + store + HTTP surface are physically extracted to `crates/ryu-quests`
/// and mounted behind this gate; the whole capability is behind the `quests` cargo
/// feature (in `default`), so a lean build drops it. This id stays in Core as the
/// AppGate identity (a manifest/registry constant, not quest business logic).
pub const QUESTS_PLUGIN_ID: &str = "@ryu/quests";

/// The Approvals app's plugin id — the `/api/approvals/*` human-in-the-loop inbox.
/// Governance-shell leaf: pre-installed, no `requires` (the workflow dependency is
/// soft). It is a **dependency target**: Healing declares `requires.apps =
/// [@ryu/approvals]` because it delivers proposed fixes into this inbox. Gate-only
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
pub const APPROVALS_PLUGIN_ID: &str = "@ryu/approvals";

/// The Skills app's plugin id — the `/api/skills/*` + `/api/skills/catalog/*`
/// SKILL.md discovery/authoring/catalog surface. Governance-shell leaf: pre-installed,
/// no `requires`. It is a **dependency target**: Learning declares `requires.apps =
/// [@ryu/skills]` because it writes synthesized skills. Gate-only (its
/// `SkillRegistry` is a `ServerState` field injected into every chat turn by
/// `route_chat_stream`), so it is NOT behind a cargo feature.
pub const SKILLS_PLUGIN_ID: &str = "@ryu/skills";

/// The Learning app's plugin id — the `/api/learn/*` + `/api/experience/list`
/// continual-learning loop. `requires` the `skills` app (it writes synthesized
/// skills), so the graph refuses to disable Skills out from under it. Pre-installed.
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
pub const LEARNING_PLUGIN_ID: &str = "@ryu/learning";

/// The Self-Healing app's plugin id — the `/api/healing/*` diagnose→propose-fix
/// surface, now served OUT-OF-PROCESS by the `ryu-healing` sidecar (`public_mount`).
/// `requires` the `approvals` app (it delivers fixes into that inbox), so the graph
/// refuses to disable Approvals out from under it. Pre-installed; Core keeps only the
/// welded action side (`healing_client::CoreHealingHost`) and drives the sidecar over
/// loopback, with the run-status bus loop spawned unconditionally in `main.rs`.
pub const HEALING_PLUGIN_ID: &str = "@ryu/healing";

/// The Monitors app's plugin id — the `/api/monitors/*` website-watch surface
/// (price/stock/keyword/content/uptime + alerts). Now served OUT-OF-PROCESS by the
/// `ryu-monitors` sidecar (`public_mount`, App-gated via the ext proxy). Pre-installed,
/// no `requires` (the scheduler is kernel infra). Core keeps only the loopback driver
/// (`monitors_client`: `JobTarget::Monitor` run + backing-job reconcile) and the two
/// ext-bearer host callbacks (Spider fetch + alert fan-out); the interleaved
/// `/api/activity/*`, `/api/events/*`, and `/api/notifications/*` streams are separate
/// kernel concerns and stay ungated.
pub const MONITORS_PLUGIN_ID: &str = "@ryu/monitors";

/// The Hardware app's plugin id — the PROTECTED `/api/hardware/devices*` device-
/// registry CRUD (list/patch/delete + per-device dashboard config). Governance-shell
/// leaf: pre-installed, no `requires`. Gate-only (the device store + `hardware_ws` are
/// `ServerState`-adjacent and the RHP link is coupled to voice/dashboards), so it is
/// NOT behind a cargo feature. The gate covers ONLY the protected device-management
/// routes; the PUBLIC device channel (`/api/hardware/{ws,pair,display}`) stays ungated
/// so physical ESP32 devices can connect and pair regardless of the app's enabled bit.
pub const HARDWARE_PLUGIN_ID: &str = "@ryu/hardware";

/// The Workflows app's plugin id — the protected workflow surface: the DAG CRUD
/// (`/workflows/*`, no `/api` prefix) plus the template catalog
/// (`/api/workflows/catalog/*`). Governance-shell leaf: pre-installed, no `requires`.
/// Gate-only (its executor is a `ServerState` engine dispatched by the scheduler
/// `JobTarget::Workflow`, durable execution, healing, and approvals), so it is NOT
/// behind a cargo feature — the impl must always compile. The gate covers ONLY the
/// protected routes; the PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`)
/// stays on the public router, ungated, so external systems can POST triggers
/// regardless of the app's enabled bit.
pub const WORKFLOWS_PLUGIN_ID: &str = "@ryu/workflows";

/// The Agents app's plugin id — the `/api/agents/*` catalog + CRUD + session-
/// management surface (list/create/edit/delete/catalog/install, ACP config/auth/
/// sessions, threads, usage, capabilities). Governance-shell leaf: pre-installed AND
/// **load-bearing** (see [`LOAD_BEARING_PLUGINS`]) — the composer fetches the agent
/// list on boot, so a disabled Agents app would break chat; a plain disable is
/// refused. Gate-only (the `AgentStore` is a `ServerState` field the chat path reads
/// in-process), so it is NOT behind a cargo feature. The gate covers ONLY these
/// catalog/CRUD HTTP routes; the ACP routing/execution substrate that actually
/// serves a chat turn (`agent_routing/`, `sidecar/adapters/acp.rs`, and the
/// `/api/chat/stream` path) is kernel and stays untouched — it never HTTP-loops back
/// through `/api/agents`.
pub const AGENTS_PLUGIN_ID: &str = "@ryu/agents";

/// The Voice app's plugin id — the PROTECTED voice data path
/// (`/api/voice/transcribe`, `/api/voice/speak`, `/api/voice/tts-engines`,
/// `/api/voice/tts-models`, `/api/voice/tts-models/install`). Governance-shell leaf:
/// pre-installed, no `requires`. Gate-only (the `voice` module is called in-process by
/// the chat/island paths), so it is NOT behind a cargo feature. The gate covers ONLY
/// these protected routes; the PUBLIC realtime voice WS (`/api/voice/ws`) stays on the
/// public router, ungated (a browser WS upgrade authenticates in-handler), so live
/// voice mode connects regardless of the app's enabled bit.
pub const VOICE_PLUGIN_ID: &str = "@ryu/voice";

/// The Media-Generation app's plugin id — the generative-media PRODUCERS
/// (`/api/images/generate`, `/api/video/generate`, `/api/video/jobs/:id`,
/// `/api/gifs/search`). Governance-shell leaf: pre-installed, no `requires`. Gate-only,
/// so it is NOT behind a cargo feature. The gate covers ONLY the producers; the shared
/// no-cloud blob store (`/api/media/:file` serve + `/api/media/upload`) stays UNGATED
/// kernel storage because it also serves TTS audio and legacy media URLs. New user
/// uploads (chat / editor / `ui.uploadFile`) go to `/api/uploads` → the Uploads
/// system space instead — also ungated, for the same reason.
pub const MEDIA_PLUGIN_ID: &str = "@ryu/media";

/// The Memory app's plugin id — the `/api/memory` + `/api/memory/:id` long-term memory
/// CRUD surface (the Memory Library). Governance-shell leaf, no `requires`. Gate-only
/// (the `MemoryStore` is a `ServerState` field), so it is NOT behind a cargo feature.
/// The gate covers ONLY the HTTP CRUD surface; the in-process chat auto-recall path is
/// kernel and never HTTP-loops back through `/api/memory`.
///
/// Pre-installed for fresh installs. Existing explicit disabled records remain
/// respected by the lifecycle seeder, so this does not silently re-enable a
/// user's previous choice.
pub const MEMORY_PLUGIN_ID: &str = "@ryu/memory";

/// The Layers app's plugin id — a settings-only governance shell for the swappable
/// capability layers. It contributes no runnables and gates no route; it exists so the
/// `layer.<capability>.default.<arg>` preferences have a home that is not tied to any
/// one provider (hanging them off `exa` would lose them on a swap to `tavily`).
/// Pre-installed, because a settings surface the user cannot reach is not a setting.
pub const LAYERS_PLUGIN_ID: &str = "@ryu/layers";

/// The Webhooks app's plugin id — the inbound webhook endpoint registry surfaced by
/// the sandboxed `apps-store/webhooks/ui` companion (W7 frontend extraction). Unlike
/// the other leaf shells this is NOT a route gate: `/api/webhooks` +
/// `/api/webhook-ingress/status` are read-only and stay ungated on the main router
/// (the desktop host calls them directly, monitors pattern). The manifest exists only
/// to seed the companion's UI bundle + `webhooks:crud` grant. Pre-installed so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const WEBHOOKS_PLUGIN_ID: &str = "@ryu/webhooks";

/// The Activity app's plugin id — the unified chronological feed surfaced by the
/// sandboxed `apps-store/activity/ui` companion (W7 frontend extraction). Like
/// `webhooks` this is NOT a route gate: `/api/activity` (+ its `/stream`) is
/// read-only and stays ungated on the main router (the desktop host calls it
/// directly, monitors pattern). The manifest exists only to seed the companion's UI
/// bundle + `activity:read` grant. Pre-installed so the companion is present on every
/// fresh install (the page it replaced was always-on).
pub const ACTIVITY_PLUGIN_ID: &str = "@ryu/activity";

/// The Calendar app's plugin id — the scheduled-runs calendar (agent/workflow jobs
/// projected onto Month/Week/Day/Agenda) surfaced by the sandboxed
/// `apps-store/calendar/ui` companion (W7 frontend extraction). Like `webhooks`/
/// `activity` this is NOT a route gate: the underlying `/heartbeat/jobs` +
/// `/workflows` + `/api/agents` endpoints stay ungated on the main router (the
/// desktop host calls them directly, monitors pattern). The manifest exists only to
/// seed the companion's UI bundle + `calendar:crud` grant. Pre-installed so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const CALENDAR_PLUGIN_ID: &str = "@ryu/calendar";

/// The Help Center app's plugin id — a desktop-first support workspace backed by
/// the app's dedicated Ryu Space. Its companion owns ticket/article projection and
/// human-reviewed AI assistance while Core/Spaces owns persistence and tenancy.
pub const HELP_CENTER_PLUGIN_ID: &str = "@ryu/help-center";

/// The Sites app's plugin id — the first-party public-edge workspace for
/// versioned Site projects, wildcard-managed URLs, domains, connectors, and
/// the Help Center widget integration surface.
pub const SITES_PLUGIN_ID: &str = "@ryu/sites";

/// The Chat Broadcast app's desktop-only companion. It lists caller-visible
/// conversations and, after an explicit confirmation in its UI, posts a real
/// user turn to each selected chat through the trusted host bridge. No sidecar,
/// route gate, or background process is needed, so it is safe to pre-install.
pub const CHAT_BROADCAST_PLUGIN_ID: &str = "@ryu/chat-broadcast";

/// The Timeline app's plugin id — the CapCut-style activity replay scrubber
/// (Shadow's captured lanes + keyframe preview + Dayflow work journal) surfaced by
/// the sandboxed `apps-store/timeline/ui` companion (W7 frontend extraction). Like
/// `webhooks`/`activity`/`calendar` this is NOT a route gate: Shadow's device-local
/// `/timeline` + `/journal` + `/frame` endpoints live on the Shadow sidecar (:3030),
/// not the Core router, and the desktop host calls them directly (the monitors
/// pattern, but WITHOUT a node token — Shadow is machine-pinned). The manifest exists
/// only to seed the companion's UI bundle + `timeline:read` grant. Pre-installed so the
/// companion is present on every fresh install (the page it replaced was always-on).
pub const TIMELINE_PLUGIN_ID: &str = "@ryu/timeline";

/// The Skill Editor app's plugin id — the SKILL.md authoring editor (front-matter
/// form fields + a markdown body + server-backed version history) surfaced by the
/// sandboxed `apps-store/skill-editor/ui` companion (W7 frontend extraction). Like
/// `webhooks`/`activity`/`timeline` this is NOT a route gate: Core's `/api/skills`
/// authoring endpoints stay ungated on the router and the desktop host calls them
/// directly (the monitors pattern), so this manifest exists only to seed the
/// companion's UI bundle + `skills:crud` grant. Pre-installed so the editor's
/// `/skills/new` + `/skills/:id/edit` routes resolve on every fresh install.
pub const SKILL_EDITOR_PLUGIN_ID: &str = "@ryu/skill-editor";

/// The built-in **personality profiles** (`docs/output-styles.md`): eleven prose files
/// an agent can assign to change how it talks.
///
/// Carries no runnable, sidecar, hook or grant — `contributes.output_styles` is inert
/// text Core parses and appends to the system prompt, and `contributes.store_tabs`
/// points the Store at Core's own `/api/output-styles`. The Store catalog is
/// browse-only because assignment belongs to an agent. It is a plugin rather than a
/// hardcoded table for the reason `Contributes::themes` gives: a contribution inherits
/// install/enable, versioning, signing, the Store detail page and reviews for free, and
/// it is what lets a third party ship a style at all. Pre-installed — see the entry in
/// [`CORE_PLUGINS`] for why that is forced by the enabled-filter rather than chosen.
pub const OUTPUT_STYLES_PLUGIN_ID: &str = "@ryu/output-styles";

/// The UGC app's plugin id — the `/api/ugc/*` creator-marketing campaign tracker
/// (campaigns, creator roster, post submissions + review, Composio-refreshed post
/// metrics, accrued/approved/paid payouts), served OUT-OF-PROCESS by the `ryu-ugc`
/// sidecar (`public_mount`, App-gated via the ext proxy). Core-tier so it is
/// installable and its managed sidecar may spawn, but **opt-in** — absent from
/// [`CORE_PREINSTALLED`] — because a pre-installed sidecar app spawns a binary a normal
/// install does not have. No `requires` edge. Its surface is a desktop dock panel
/// (`contributes.dock_panels`, `panel: "native"`), not a companion, so it ships no
/// `ui_code` and needs no `plugins::seed` row.
pub const UGC_PLUGIN_ID: &str = "@ryu/ugc";

/// The Mission Control app's plugin id — the `/api/mission-control/*` cross-chat
/// work dashboard (per-conversation digests, per-day activity, hot files, and the
/// to-dos left outstanding across threads), served OUT-OF-PROCESS by the
/// `ryu-mission-control` sidecar (`public_mount`, App-gated via the ext proxy).
/// Core-tier so it is installable and its managed sidecar may spawn, but **opt-in**
/// — absent from [`CORE_PREINSTALLED`] — because a pre-installed sidecar app spawns a
/// binary a normal install does not have. No `requires` edge.
///
/// Its desktop surface is an APP-SHELL PAGE (`contributes.sidebar_buttons` naming
/// `/mission-control`, resolved by `contributions/app-shell-routes.ts`), not a
/// companion, so it ships no `ui_code` and needs no `plugins::seed` row. The
/// related in-chat panel is NOT part of this app: it is a shell-owned dock kind
/// that derives from the live message stream and works whether or not this app is
/// installed.
pub const MISSION_CONTROL_PLUGIN_ID: &str = "@ryu/mission-control";

/// The Feedback Board app's plugin id — a public request board plus a private
/// Ryu product workspace, served by the `ryu-feedback-board` sidecar through
/// the generic ext-proxy/public-mount path. Core-tier and opt-in: the sidecar
/// binary is not assumed to exist on a fresh node, so this id stays out of
/// `CORE_PREINSTALLED`.
pub const FEEDBACK_BOARD_PLUGIN_ID: &str = "@ryu/feedback-board";

/// The Drafts app's plugin id — the `/api/drafts/*` outbox (unsent composer text,
/// armed queue entries and their send history), served OUT-OF-PROCESS by the
/// `ryu-drafts` sidecar (`public_mount`, App-gated via the ext proxy). Core-tier so
/// it is installable and its managed sidecar may spawn, but **opt-in** — absent from
/// [`CORE_PREINSTALLED`] — because a pre-installed sidecar app spawns a binary a normal
/// install does not have. No `requires` edge.
///
/// Its desktop surface is an APP-SHELL PAGE (`contributes.sidebar_buttons` naming
/// `/drafts`, resolved by `contributions/app-shell-routes.ts`) plus one
/// `sidebar_sections` entry, so it ships no `ui_code` and needs no `plugins::seed`
/// row. The SENDING half is deliberately not here and not in the sidecar: a manifest
/// sidecar is spawned without `RYU_TOKEN`, so the desktop dispatcher — which holds
/// the node credential — claims a ready draft and posts the turn.
pub const DRAFTS_PLUGIN_ID: &str = "@ryu/drafts";

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
/// Pre-installed policy:
/// - `engines` (local llama.cpp) is pre-installed and seeded enabled (zero-setup chat on install).
/// - `durable` (the in-process durable workflow engine) is pre-installed and seeded enabled — it runs
///   on every platform with no extra sidecar, so it is a zero-setup pre-installed
///   dogfood (#448) declared as an `engine` runnable.
/// - `ghost`/`shadow`/`spider`/`agentbrowser` are the sidecar-backed pre-installed
///   tool apps. They are Core-tier AND pre-installed: on a fresh install their app
///   record is seeded enabled (so they appear installed exactly like the
///   auto-downloaded default models), while the tool process still runs through
///   its own sidecar/MCP lifecycle. `ghost` and `agentbrowser` declare no runnables
///   (their tools come from the dedicated MCP provider); the record is the
///   governance shell (see `crate::plugin_manifest` `BUILTIN_MANIFESTS` doc).
///   `@ryu/browser` is the exception among the sidecar-backed apps: it now also
///   carries declarative `http` tool runnables that reach its own sidecar through
///   the ext-proxy, because the swappable `browser.control` layer binds its verbs
///   to registry tool ids and a sidecar route is not one.
/// - `firewall`/`routing`/`sandbox` are Core-tier but **opt-in** (they change
///   gateway/sandbox behaviour), so they are NOT in [`CORE_PREINSTALLED`].
/// - `headroom` (egress compression) is deliberately **Community-tier**: the
///   compression *service* is the plugin and Core only hosts the gateway
///   transform, so it is install-then-enable from the marketplace exactly like a
///   third-party compression plugin would be. The bundled fixture is our
///   reference; nothing about the service is hardcoded.
pub const CORE_PLUGINS: &[&str] = &[
    "@ryu/ghost",
    "@ryu/shadow",
    "@ryu/spider",
    "@ryu/agentbrowser",
    // Ambient Elevator is a desktop-only, no-sidecar plugin. Core-tier keeps its
    // compiled manifest trusted while the desktop owns the actual audio element.
    "@ryu/ambient-elevator",
    // Agent Status is a pure compiled manifest whose declarative shell reads the
    // governed runs/approvals APIs. Core tier is the provenance proof that permits
    // those reviewed Core routes; it remains opt-in (not pre-installed).
    "@ryu/agent-status",
    // Ego Browser is an official, opt-in browser.control provider. It is Core
    // tier so a verified marketplace package can use its reviewed inline-Deno
    // bridge, but it is not pre-installed because Ego lite is a separate BYO app.
    "@ryu/ego-browser",
    // Expect and Agentation are local Node MCP servers. Core-tier is required so
    // their manifest-owned stdio servers can register without the reserved
    // `mcp:server` marketplace grant; both remain explicit opt-ins because their
    // npm launchers download third-party code when enabled.
    "@ryu/expect",
    "@ryu/agentation",
    // Third `web.extract` provider (Scrapling's MCP server). Core-tier is a
    // REQUIREMENT here, not a promotion: `may_register_mcp_servers` auto-allows
    // manifest-declared `mcp_servers` only for compiled-in fixtures, and the
    // Community path needs the approved `mcp:server` grant — which is off the
    // Gateway's default allowlist and in a reserved namespace, so operator-only.
    // A Community-tier scrapling would register nothing and be dead on arrival.
    // Deliberately NOT in `CORE_PREINSTALLED`: it needs a `pip install "scrapling[ai]"`
    // the user must perform, so shipping it on would put a permanently unavailable
    // tool on every fresh install — the same reason the BYOK providers stay opt-in.
    "@ryu/scrapling",
    // zvec-grep is the semantic sibling of the exact-search `ripgrep` plugin.
    // Core-tier is required because its manifest-owned MCP server is a local
    // process; it remains opt-in because it needs Node.js 22+ and a user-created
    // workspace index. The pinned npx stdio bridge starts/reuses zvec-grep's
    // loopback daemon and exposes the default search-only toolset.
    "@ryu/zvec-grep",
    // The default `web.search` provider. Core-tier for the same reason `spider` is:
    // it is a default TOOL app that must exist out of the box, and pre-installed
    // requires Core-tier. The other five search providers (tavily, brave, serper,
    // firecrawl, parallel) stay Community + opt-in, because each needs a key before
    // it can do anything useful. `parallel` is the one that could argue otherwise —
    // its public Search MCP endpoint works with no credential, exactly like exa's —
    // but its extract half is still BYOK, and pre-installed is a pick, not a listing:
    // two default providers of `web.search` would make the choice depend on
    // manifest ordering. exa keeps it; parallel is the swap you opt into.
    "@ryu/exa",
    // The Ryu Docs MCP plugin — read-only access to the docs site
    // (docs.ryuhq.com/mcp) as MCP tools. Core-tier is a REQUIREMENT, not a
    // promotion, for the same reason `scrapling` is: `may_register_mcp_servers`
    // auto-allows a manifest's `mcp_servers` only for compiled-in fixtures, and
    // the Community path needs the approved `mcp:server` grant — off the
    // Gateway's default allowlist and in a reserved namespace, so operator-only.
    // A Community-tier docs would register nothing and be dead on arrival.
    // Unlike `scrapling` it needs no install step: the server is REMOTE (a hosted
    // https URL, not a spawned command), so it is also in `CORE_PREINSTALLED`.
    "@ryu/docs",
    // Composio Connect is the OAuth-backed hosted MCP alternative to the direct
    // `COMPOSIO_API_KEY` action backend. Core-tier is required for the reserved
    // `mcp:server` + `identity.read` grants; it is pre-installed because it has no
    // local process or secret to provision and remains inert until the user
    // authorizes a Composio account.
    COMPOSIO_CONNECT_PLUGIN_ID,
    // The two Pi extensions that stopped being hardcoded: background bash and
    // sub-agents. Core-tier is a REQUIREMENT, not a promotion, exactly as for
    // `scrapling` above — `pi_config::app_extensions::may_ship_pi_extensions`
    // auto-allows a manifest's `pi_extensions` only for compiled-in manifests, and
    // the Community path needs the approved `pi:extension` grant, which is
    // operator-only. Both ARE in `CORE_PREINSTALLED`: they were unconditional before
    // the move, so anything else is a silent capability regression.
    "@ryu/pi-shell",
    "@ryu/pi-subagent",
    // The third Pi extension: the `monitor` tool (a from-scratch port of Claude
    // Code's Monitor for the managed Pi agent). Core-tier is a REQUIREMENT for
    // the same reason as its siblings — `may_ship_pi_extensions` auto-allows
    // only compiled-in manifests, and the Community path needs the operator-only
    // `pi:extension` grant. Unlike them it is NET-NEW rather than previously
    // unconditional, but it still sits in `CORE_PREINSTALLED` (see below): a
    // not pre-installed mirror of a first-class Claude Code tool would read as a
    // regression.
    "@ryu/pi-monitor",
    // Workspace real-Chromium browser sidecar — core built-in, installable from the
    // Store but NOT pre-installed (no publishable sidecar asset; see `CORE_PREINSTALLED`).
    BROWSER_PLUGIN_ID,
    // Native workspace entry over the existing Gateway channel adapters. No
    // sidecar, runnable or reserved grant; Core tier marks the compiled manifest
    // as first-party and allows the pre-installed contribution to seed safely.
    WHATSAPP_PLUGIN_ID,
    "@ryu/firewall",
    "@ryu/routing",
    "@ryu/sandbox",
    // pxpipe — the loopback token-saving proxy. Core-tier is a REQUIREMENT, not a
    // promotion, exactly as for `scrapling` above: it declares a managed sidecar, and
    // `may_run_sidecar` allows one at Community tier only against the Gateway-approved
    // `sidecar:process` grant — which the Gateway denies at enable. A Community pxpipe
    // would install and then never spawn its proxy. Deliberately NOT in
    // `CORE_PREINSTALLED`: it needs Node on PATH, fetches an npm package on first start,
    // and does nothing until the user points a provider at 127.0.0.1:47821 with their
    // own key (it is a transparent proxy and holds no credential — see its README).
    "@ryu/pxpipe",
    // Mail (Agent Inboxes) — manifest-driven app; its `ryu-mail` sidecar is spawned
    // by the generic loader (see MAIL_PLUGIN_ID).
    MAIL_PLUGIN_ID,
    // Payments (MPP) — its local `ryu-mpp` sidecar also needs the Core tier so the
    // generic loader can spawn the manifest-declared process and its reviewed host
    // capabilities can reach Core-owned encrypted custody. It remains opt-in and
    // is intentionally absent from CORE_PREINSTALLED.
    "@ryu/mpp",
    // RAG capability provider (default in-process embeddings+retrieval).
    RAG_PLUGIN_ID,
    // System-wide autocomplete. Core-tier but opt-in (NOT in CORE_PREINSTALLED):
    // enabling it is the single on/off switch for the /api/predict/* brain, and it
    // sends text from arbitrary apps to a model, so it ships disabled.
    "@ryu/predict",
    // System-wide dictation + agent-ask (Island surface). Core-tier; pre-installed
    // (see CORE_PREINSTALLED) so the previously-hardcoded Island feature keeps
    // working on a fresh install. Enabling the plugin is the single switch.
    "@ryu/dictation",
    // The Island companion overlay — a desktop-owned Electron sidecar the desktop
    // shell installs and launches (never a Core sidecar). Core-tier so its record
    // is installable/governed, but OPT-IN: no release auto-installs the Electron
    // bundle, so no record is seeded (absent from `CORE_PREINSTALLED` and carrying no
    // companion `ui_code`, so it has no lifecycle record on a fresh store). Its Island settings tab
    // registers via `contributes.settings_tabs` and appears only after the user
    // installs the app from the Store — the same posture as shadow's settings.
    "@ryu/island",
    "@ryu/engines",
    "@ryu/durable",
    "@ryu/goal",
    "@ryu/proof",
    "@ryu/receipts",
    "@ryu/double-check",
    "@ryu/chat-title",
    // Chat feature extraction: the side-question, temporary-chat, and expanded
    // composer lifecycles are plugin-owned declarations over host implementations.
    // Reactions are the adjacent message-action plugin; all four remain pre-installed
    // for parity with the previously built-in desktop experience.
    SIDE_CHATS_PLUGIN_ID,
    GHOST_CHATS_PLUGIN_ID,
    EXPANDED_COMPOSER_PLUGIN_ID,
    STATS_PLUGIN_ID,
    REACTIONS_PLUGIN_ID,
    // End-of-turn recap + `/recap`. Installable and governed like the turn-hook
    // plugins above it, but deliberately absent from `CORE_PREINSTALLED`: each recap is
    // a real side-model call on the user's budget, so it is install-on-demand and enabled
    // from the Store.
    "@ryu/recap",
    // End-of-turn AI-slop editor: bundles the `no-ai-slop` skill and has a
    // fresh-context reviewer edit the answer that just finished. Absent from
    // `CORE_PREINSTALLED` for recap's reason and then some — its hook carries no
    // `match` gate (every completed turn is the point), so it costs a sandbox spawn
    // per turn plus a sub-agent per answer that clears its prose floor.
    "@ryu/no-ai-slop",
    // Turns a correction into a durable rule in a Space and briefs every later chat
    // with the list. Absent from `CORE_PREINSTALLED` for recap's reason: the capture
    // hook has no `match` gate it could use (the pre-gate grammar cannot express
    // "this message reads like a complaint", so the cheap gate is a regex sweep
    // inside the hook), meaning a sandbox spawn per user turn plus a side-model call
    // on each correction it does catch.
    "@ryu/no-more-mistakes",
    // Agent-to-agent mailbox: every agent gets `agents.directory` / `agents.send` /
    // `agents.thread`, and a `pre_user_turn` hook delivers whatever
    // arrived for it. Off by default — the delivery hook cannot be `match`-gated (the
    // inbox is keyed by agent, `stateful` matches on the conversation) so it spawns a
    // sandbox per turn. It is opt-in because the hook still incurs a sandbox
    // spawn per turn.
    "@ryu/agent-comms",
    // Bounded dynamic workflow fan-out through the generic Core host bridge.
    // Opt-in: each run can spend model budget and may launch write-capable
    // delegates when the caller explicitly selects the code_write preset.
    "@ryu/dynamic-workflows",
    // Experimental per-turn AGENTS.md tail. Opt-in because it changes every
    // outbound context and can materially increase prompt size.
    "@ryu/agents-md-tail",
    // Cross-provider project and per-agent rules. The manifest owns the Agent
    // Edit panel and context hook; Core only supplies the generic discovery data.
    "@ryu/rules",
    // Pre-turn prompt-improver: rewrites the outgoing message via a configurable
    // model before it is sent. Reverse-DNS id (matches its manifest + composer flag).
    "@ryu/auto-expand",
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`) that owns its
    // Space documents via `spaces:docs`. NOT pre-installed: opt-in companions are absent
    // from a fresh store, and `lifecycle::install_app` attaches the compiled-in
    // `ui_code` HTML blob when the user installs one from the Store. `enable_app`
    // then gets its grants approved through the Gateway like any other app.
    "@ryu/whiteboard",
    // Drawesome is a lightweight, storage-backed creative Companion. It is Core-tier
    // so its reviewed storage grant can be enabled as a first-party app, but it stays
    // opt-in and does not seed a lifecycle record on a fresh install.
    "@ryu/drawesome",
    // The Canvas app — a full-page Companion (`ui_format:"html"`) that owns its Space
    // documents via `spaces:docs` and drives generation nodes through the window.ryu
    // media/agent bridge. Same posture as Whiteboard above: opt-in and absent from a
    // fresh store until explicit install.
    "@ryu/canvas",
    // The Fine-tuning app — a full-page Companion (`ui_format:"html"`) that drives
    // Core's fine-tune orchestration via `finetune:runs` and owns its Unsloth Python
    // training sidecar (spawned on the Core-tier auto-run path, so it declares no
    // `sidecar:process` grant — the Gateway denies that grant at enable). Opt-in;
    // explicit install carries its approved grants + `ui_code` HTML blob. Replaces
    // the built-in fine-tuning page.
    "@ryu/finetune",
    // The five document-parsing apps — the providers of the `document.parse`
    // capability. Four are Python sidecars and AnyDoc is a Rust sidecar it owns
    // (all spawned on the Core-tier auto-run path, so like `finetune` each declares
    // NO `sidecar:process` grant — the Gateway denies that grant at enable and the
    // enable fails). All five are here so they are governed and enable-able from the
    // Store; only `markitdown` is ALSO in CORE_PREINSTALLED (see the block there).
    // The other four are opt-in: `unstructured[all-docs]` is a 1-2 GB pip install
    // plus native helpers, `docling`/`mineru` pull model stacks, and AnyDoc is an
    // additional standalone extraction service. Enabling a second one is what makes
    // the capability actually swappable — the read model derives providers from the
    // ENABLED set.
    ANYDOC_PLUGIN_ID,
    MARKITDOWN_PLUGIN_ID,
    UNSTRUCTURED_PLUGIN_ID,
    DOCLING_PLUGIN_ID,
    MINERU_PLUGIN_ID,
    // Spaces + Meetings — the first REAL plugin→plugin dependency edge. Both are
    // governance shells: the implementation stays in-crate and the record gates it
    // (Meetings' `/api/meetings/*` routes are refused when the app is disabled —
    // see `server::require_app_enabled`). Both pre-installed, so today's behaviour is
    // unchanged on a fresh install; the dependency only bites when a user disables
    // Spaces while Meetings is still on, which the graph now refuses.
    SPACES_PLUGIN_ID,
    MEETINGS_PLUGIN_ID,
    // Five leaf-feature apps (research/dashboards/teams/clips/recipes). Core-tier —
    // installable and enable-able from the Store — but NO LONGER pre-installed, and
    // absent from a fresh store until explicit install. See the
    // block where they were removed from `CORE_PREINSTALLED` for why; the short
    // version is that each now owns an out-of-process sidecar binary that a normal
    // install does not have, so seeding them enabled shipped five apps nobody asked
    // for AND made four of them fail on first use. `clips`→`shadow` and
    // `recipes`→`ghost` are real `requires` edges; both deps are still pre-installed,
    // so enabling either from the Store finds its dependency already satisfied.
    RESEARCH_PLUGIN_ID,
    DASHBOARDS_PLUGIN_ID,
    TEAMS_PLUGIN_ID,
    CLIPS_PLUGIN_ID,
    RECIPES_PLUGIN_ID,
    // Outpost — the same posture as those five, for the same reason: Core-tier and
    // installable, but not pre-installed, because its `ryu-social` sidecar binary is not on a
    // normal install and an app that publishes publicly under the user's accounts is
    // the last thing that should arrive switched on. No `requires` edge — it owns its
    // sidecar and its own database.
    SOCIAL_PLUGIN_ID,
    // Token Table — opt-in like Outpost: Core-tier is what allows its managed
    // sidecar to spawn, while the absence from CORE_PREINSTALLED keeps a normal
    // install from starting an unrequested game service.
    TOKEN_TABLE_PLUGIN_ID,
    // Rooms — opt-in like Token Table: the Core-tier classification lets the
    // active-node room sidecar spawn without the Gateway-denied sidecar:process
    // grant, while the absence from CORE_PREINSTALLED keeps invited-device
    // hosting an explicit user action.
    "@ryu/rooms",
    // Subtitles — same posture as Outpost: Core-tier and installable, not pre-installed,
    // because the
    // `ryu-subtitles` binary is not on a normal install. Core-tier is what actually
    // spawns that sidecar; a Community-tier app with a manifest sidecar installs,
    // enables, and then silently never spawns, because `may_run_sidecar` would want
    // the `sidecar:process` grant the Gateway denies at enable. No `requires` edge —
    // it owns its sidecar and its own SQLite database.
    SUBTITLES_PLUGIN_ID,
    // Deep Read — same posture as Subtitles, and membership here is load-bearing for
    // TWO reasons rather than one: Core-tier is what spawns the `ryu-rlm` sidecar, and
    // it is also what lets the manifest's `mcp_servers` block register, which is the
    // whole agent-facing surface of this app. A Community-tier app with both would
    // install, enable, and then silently offer neither. Not pre-installed — the binary is
    // install, and an app that reads files from the user's home directory should not
    // arrive switched on. No `requires` edge; it owns its sidecar and its context store.
    RLM_PLUGIN_ID,
    // Harbor — same posture again: Core-tier and installable, not pre-installed, because
    // the `ryu-crm` binary is not on a normal install. No
    // `requires` edge; it owns its sidecar and its own SQLite database. Absent from
    CRM_PLUGIN_ID,
    // Expenses — same opt-in sidecar posture as Harbor, but with a companion bundle
    // carried by the explicit install path and an MCP server for the ledger agent.
    EXPENSES_PLUGIN_ID,
    OUTREACH_PLUGIN_ID,
    AUTOPILOT_PLUGIN_ID,
    PROJECTS_PLUGIN_ID,
    INVOICES_PLUGIN_ID,
    PEOPLE_PLUGIN_ID,
    // Backstage — an external-repository Companion whose editor is carried by its
    // Marketplace/standalone package and whose provider calls use generic Ryu
    // model/media/storage bridges. Opt-in; it is not opened on a fresh node.
    BACKSTAGE_PLUGIN_ID,
    // Wave-2 leaf-feature governance shells (quests/approvals/skills/learning/
    // healing). All Core-tier; `skills` and `learning` are ALSO pre-installed (see
    // CORE_PREINSTALLED), quests/approvals/healing ship opt-in. `learning`→`skills` and
    // `healing`→`approvals` are real `requires` edges; `learning`'s dep is pre-installed,
    // so the fail-closed seeder never skips it.
    QUESTS_PLUGIN_ID,
    APPROVALS_PLUGIN_ID,
    SKILLS_PLUGIN_ID,
    LEARNING_PLUGIN_ID,
    HEALING_PLUGIN_ID,
    // Wave-3 leaf-feature governance shells (monitors/hardware). Core-tier AND
    // pre-installed: their `/api/<feature>/*` routes were always-on before the gate, so
    // a pre-installed seed keeps them reachable on every existing install. Neither
    // declares `requires` (the scheduler + device store are kernel infra).
    MONITORS_PLUGIN_ID,
    HARDWARE_PLUGIN_ID,
    // The wave-4 two, pre-installed so their always-on routes stay reachable after
    // gating (see CORE_PLUGINS). Neither has a `requires` edge; `agents` is also
    // load-bearing (it can only be disabled with an explicit force override).
    WORKFLOWS_PLUGIN_ID,
    AGENTS_PLUGIN_ID,
    // W0 honest-gating baseline: three data-path governance shells whose
    // `/api/{voice,images+video+gifs,memory}/*` routes were mounted RAW before this
    // wave. Core-tier AND pre-installed so the gate is transparent on every existing
    // install (the routes were always-on before). Neither declares `requires`; the
    // `voice`/`media`/`memory` modules stay in-crate (gate-only, no cargo feature).
    VOICE_PLUGIN_ID,
    MEDIA_PLUGIN_ID,
    MEMORY_PLUGIN_ID,
    LAYERS_PLUGIN_ID,
    // W7 frontend extraction: the webhooks page became a sandboxed companion app.
    // Not a route gate (the `/api/webhooks*` reads stay ungated) — Core-tier + pre-installed
    // so the companion is present on every fresh install. No `requires` edge.
    WEBHOOKS_PLUGIN_ID,
    // W7 frontend extraction: the activity feed page became a sandboxed companion app.
    // Not a route gate (the `/api/activity` read stays ungated). Core-tier but
    // **not pre-installed** — see the `NOTE (not pre-installed apps)` block below, which is the
    // binding statement; this comment used to claim pre-installed and was simply wrong
    // (the id is absent from [`CORE_PREINSTALLED`]). No `requires` edge.
    ACTIVITY_PLUGIN_ID,
    // W7 frontend extraction: the calendar page became a sandboxed companion app.
    // Not a route gate (the `/heartbeat/jobs` + `/workflows` + `/api/agents` reads stay
    // ungated) — Core-tier + pre-installed so the companion is present on every fresh
    // install. No `requires` edge.
    CALENDAR_PLUGIN_ID,
    // Help Center is a Space-backed desktop companion. Core-tier keeps its
    // first-party manifest trusted, and the pre-installed seed makes the support
    // workspace available on a fresh install.
    HELP_CENTER_PLUGIN_ID,
    // Sites is the first-party public-edge companion. It is pre-installed as a
    // control surface, while managed routing and quotas remain enforced at the
    // control-plane/edge seam.
    SITES_PLUGIN_ID,
    // Chat Broadcast — a desktop-only Companion whose host bridge lists visible
    // conversations and posts a confirmed message into selected chats. It has no
    // sidecar or public route, so the Core-tier manifest can be pre-installed.
    CHAT_BROADCAST_PLUGIN_ID,
    // W7 frontend extraction: the timeline page became a sandboxed companion app.
    // Not a route gate (Shadow's device-local `/timeline` + `/journal` + `/frame` live
    // on the Shadow sidecar :3030, not the Core router). Core-tier but **not pre-installed**
    // — see the `NOTE (not pre-installed apps)` block below; this comment used to claim
    // pre-installed and was wrong (absent from [`CORE_PREINSTALLED`]). No `requires` edge.
    TIMELINE_PLUGIN_ID,
    // W7 frontend extraction: the SKILL.md editor became a sandboxed companion app.
    // Not a route gate (`/api/skills` authoring endpoints stay ungated). Core-tier but
    // **not pre-installed** — see the `NOTE (not pre-installed apps)` block below. This comment used
    // to claim pre-installed *because* `/skills/new` + `/skills/:id/edit` had to resolve on
    // a fresh install; they do not, and the claim was never true (absent from
    // [`CORE_PREINSTALLED`]). The clients no longer depend on it either: the Skills catalog
    // hides its New/Edit affordances unless an enabled app answers the editor path, so
    // authoring is opt-in from the Store rather than a dead button. No `requires` edge.
    SKILL_EDITOR_PLUGIN_ID,
    // The eleven built-in personality profiles (`docs/output-styles.md`). Core-tier AND
    // pre-installed, which for this one is a *reachability* decision rather than a
    // product-taste one: `contributes.output_styles` is served enabled-filtered, so a
    // disabled record means the agent editor offers no reusable profiles and the Store
    // tab is hidden (the desktop renders a contributed tab only when its app is installed
    // AND enabled). Not pre-installed would have shipped a feature with no discovery path
    // to turn itself on.
    //
    // Affordable because the plugin is inert: no runnables, no sidecar, no hooks, no
    // grants — eleven prose files nothing evaluates. Enabling it changes what is
    // *listable*, never what runs, because agents default to their own voice (§8) and
    // no built-in sets `force-for-plugin`. This is the same argument `exa` makes one
    // block down (seed a provider so the capability is non-empty), minus the caveat
    // that sank `@ryu/browser` — there is no binary to fail to spawn.
    OUTPUT_STYLES_PLUGIN_ID,
    // The UGC campaign tracker. Core-tier is a REQUIREMENT here, not a promotion —
    // the same argument `pxpipe` and the four document-parsing apps make above: it
    // declares a managed sidecar, and `may_run_sidecar` permits one at Community tier
    // only against the Gateway-approved `sidecar:process` grant, which the Gateway
    // DENIES at enable. A Community-tier `@ryu/ugc` would install and then never spawn
    // `ryu-ugc`. Deliberately NOT in `CORE_PREINSTALLED`, for exactly the reason the five
    // leaf apps (research/dashboards/teams/clips/recipes) were demoted: it owns an
    // out-of-process sidecar binary a normal install does not have, so seeding it
    // enabled would ship an app nobody asked for AND fail on first use. No `requires`
    // edge — nothing in Core reads its state, and its desktop dock panel talks to the
    // sidecar through the ext-proxy `public_mount`.
    UGC_PLUGIN_ID,
    // Mission Control. Same posture and same REQUIREMENT as `@ryu/ugc` directly
    // above: it declares a managed `ryu-mission-control` sidecar, and
    // `may_run_sidecar` permits one at Community tier only against a Gateway-approved
    // `sidecar:process` grant the Gateway DENIES at enable — so tier here is what
    // decides whether the binary ever spawns. Deliberately NOT in `CORE_PREINSTALLED`
    // for the same reason: the binary is not on a normal install.
    //
    // Nothing in Core reads its state, so no `requires` edge. Note the asymmetry with
    // the shell's `mission` dock panel, which shares this app's name and none of its
    // machinery — that panel derives from the live message stream client-side and is
    // unaffected by this row.
    MISSION_CONTROL_PLUGIN_ID,
    // Feedback Board. It owns a managed sidecar and therefore needs the Core tier
    // for its process grant. It remains opt-in because the binary is not shipped
    // on every node and the public board should not be enabled without an operator
    // choosing its workspace and moderation posture.
    FEEDBACK_BOARD_PLUGIN_ID,
    // Drafts. Same posture and same REQUIREMENT as `@ryu/mission-control` directly
    // above: it declares a managed `ryu-drafts` sidecar, and `may_run_sidecar`
    // permits one at Community tier only against a Gateway-approved
    // `sidecar:process` grant the Gateway DENIES at enable — so tier here is what
    // decides whether the binary ever spawns. Deliberately NOT in `CORE_PREINSTALLED`
    // for the same reason: the binary is not on a normal install.
    //
    // Nothing in Core reads the outbox, so no `requires` edge — the shell fetches
    // `/api/drafts/*` through the ext proxy for both the sidebar section and the
    // dispatcher.
    DRAFTS_PLUGIN_ID,
    // Automated Reasoning. Same posture and same REQUIREMENT as `@ryu/ugc` directly
    // above: it declares a managed `ryu-reasoning` sidecar, and `may_run_sidecar`
    // permits one at Community tier only against a Gateway-approved
    // `sidecar:process` grant the Gateway denies at enable — so tier here is what
    // decides whether the binary ever spawns. Its manifest `mcp_servers` entry
    // (`reasoning.solve`, the id a workflow `mcp` node takes) needs the same tier
    // via `may_register_mcp_servers`.
    //
    // This row was MISSING while the app's own comments (seed.rs, plugin_manifest)
    // asserted it was Core-tier, and nothing caught it:
    // `every_core_plugin_id_resolves_to_a_loaded_builtin_manifest` only checks the
    // forward direction (a CORE_PLUGINS id must have a manifest), never
    // manifest-declares-a-sidecar → CORE_PLUGINS. The app installed, enabled, and
    // then silently never spawned.
    //
    // Deliberately NOT in `CORE_PREINSTALLED`, for the reason the leaf apps were
    // demoted: it owns an out-of-process binary a normal install does not have.
    crate::plugin_manifest::REASONING_PLUGIN_ID,
    // Pull Requests owns a managed sidecar and therefore needs the Core tier
    // for its process/MCP grants, even though it remains marketplace-installed
    // and opt-in like the other non-system official apps.
    "@ryu/pull-requests",
    // Blueprint. Core tier for the same two mechanical reasons as Reasoning directly
    // above, and worth restating because NOTHING TESTS THIS ROW: it declares a
    // managed `ryu-blueprint` sidecar, and `may_run_sidecar` permits one at Community
    // tier only against a Gateway-approved `sidecar:process` grant the Gateway denies
    // at enable; its manifest `mcp_servers` entry (`blueprint.plan_publish` /
    // `blueprint.plan_status`, the ids an agent and a workflow `mcp` node take) is
    // gated the same way by `may_register_mcp_servers`. Omit this line and the app
    // installs, enables, reports itself healthy — and the binary never spawns while
    // its four MCP tools never appear, with no error anywhere to say why.
    //
    // Deliberately NOT in `CORE_PREINSTALLED`, for the reason the leaf apps were
    // demoted: it owns an out-of-process binary a normal install does not have.
    BLUEPRINT_PLUGIN_ID,
    // Tuition and Wire — the same posture and the same REQUIREMENT as Reasoning and
    // Blueprint directly above, and they shipped with this row MISSING for exactly
    // the reason Reasoning did. Each declares a managed sidecar (`ryu-tuition` /
    // `ryu-news`), and `may_run_sidecar` permits one at Community tier only against a
    // Gateway-approved `sidecar:process` grant the Gateway DENIES at enable; each also
    // declares an `mcp_servers` entry (`tuition.due`/`quiz`/`grade`…,
    // `news.search`/`brief`…, the ids an agent or a workflow `mcp` node takes) gated
    // the same way by `may_register_mcp_servers`. Without this line both apps install,
    // enable, seed their grants and report themselves healthy — while the binary never
    // spawns and the MCP tools never appear, with no error anywhere to say why.
    //
    // Neither declares `sidecar:process` or `mcp:server` in its own
    // `permission_grants` (`tuition:crud`/`news:crud` + `hook:side-model` +
    // `storage:kv` + `mcp:tuition`/`mcp:news`), which is what makes Core tier the
    // correct fix rather than a grant: the Gateway validates and denies those two
    // reserved grants at enable, so asking for them would break the enable instead.
    //
    // Deliberately NOT in `CORE_PREINSTALLED`, for the reason the leaf apps were
    // demoted: each owns an out-of-process binary a normal install does not have.
    TUITION_PLUGIN_ID,
    NEWS_PLUGIN_ID,
    // Simulators (iOS `simctl` + Android `adb` control). Core tier for the first half
    // of the same argument — it declares a managed `ryu-simulator` sidecar, and
    // `may_run_sidecar` permits one at Community tier only against the
    // Gateway-approved `sidecar:process` grant the Gateway DENIES at enable, so this
    // row is what decides whether the binary ever spawns. Its manifest declares no
    // `mcp_servers`, so the MCP half does not apply; its only declared grant is
    // `simulator:control`, the capability the desktop panel drives it through.
    //
    // Deliberately NOT in `CORE_PREINSTALLED` — `lazy` + idle-stop keep it cold, but a
    // toolchain-wrapping sidecar on a machine with no Xcode and no Android SDK is
    // exactly the app nobody asked for (availability is a RUNTIME probe of
    // `/capabilities`, so it cannot be decided here). This is a native dock-panel app
    // (`companion: null`) with no companion bundle.
    SIMULATOR_PLUGIN_ID,
    // Virtual Desktop — the same posture as simulator, for the same reason: the
    // `ryu-desktop` sidecar wraps a real virtual-desktop toolchain (xvfb, a window
    // manager, tigervnc) that a normal install does not carry, so it is opt-in from
    // the Store and its native dock panel prompts to install it. It is a native
    // dock-panel app (`companion: null`), so there is no companion bundle.
    "@ryu/desktop",
];

/// The subset of [`CORE_PLUGINS`] that is **pre-installed** on a fresh install
/// (seeded enabled at startup when the install has no prior record). The
/// opt-in Core plugins (firewall/routing/sandbox/headroom) are deliberately
/// excluded — they only activate when the user enables them.
///
/// The chat turn-hook plugins (`goal`/`proof`/`double-check`/`chat-title`) ship
/// pre-installed so their features (persistent goals, proof-of-work verification,
/// answer review, progressive chat titles) work on **every surface** with zero
/// setup, exactly like the built-in chat commands they replaced. This is only
/// affordable because each declares a cheap `match` pre-gate (see
/// [`crate::plugin_manifest::HookMatch`]) — or, for `chat-title`, a preference
/// read inside the hook: an idle hook costs a flag/prefix check or one KV read,
/// never a sandbox spawn when matched out. They stay real, swappable plugins —
/// a user can disable any of them, and the fixture is the reference a third
/// party can fork.
pub const CORE_PREINSTALLED: &[&str] = &[
    "@ryu/engines",
    "@ryu/durable",
    "@ryu/goal",
    "@ryu/proof",
    "@ryu/receipts",
    "@ryu/double-check",
    "@ryu/chat-title",
    SIDE_CHATS_PLUGIN_ID,
    GHOST_CHATS_PLUGIN_ID,
    EXPANDED_COMPOSER_PLUGIN_ID,
    STATS_PLUGIN_ID,
    REACTIONS_PLUGIN_ID,
    // WhatsApp is a zero-process workspace entry over the already-shipped channel
    // control plane. Pre-installed makes its contributed tab visible without starting
    // anything or requesting credentials until the user opens the setup form.
    WHATSAPP_PLUGIN_ID,
    // Rules are configuration, not an optional side effect: a fresh node should
    // honor Ryu agent rules and compatible project rule files immediately. The
    // per-agent preference still lets users disable injection or bound its turns.
    "@ryu/rules",
    // Background bash + sub-agents for the managed Pi agent. Pre-installed because
    // Core shipped both unconditionally before they became plugins; the win of the
    // move is that they are now DISABLE-able, not that they are off. Turning either
    // off takes effect in a new chat (Pi reads its extensions at process start).
    "@ryu/pi-shell",
    "@ryu/pi-subagent",
    // `monitor` for the managed Pi agent. Pre-installed for the same reason the
    // other two are: it is a first-class capability (Claude Code's Monitor, ported
    // from scratch) that the flagship agent simply should have; a fresh install
    // that defaulted it off would quietly lack the one tool this plugin exists to
    // add. Toggling it off takes effect in a new chat (Pi reads its extensions at
    // process start), exactly like its siblings.
    "@ryu/pi-monitor",
    // The pre-installed tool apps — record seeded enabled on a fresh
    // install so they show up like the auto-downloaded default models. The actual
    // process runs through its own sidecar/MCP lifecycle; enabling the record just
    // makes it a first-class, governed, disable-able App. The pure sidecar-backed
    // ones (ghost/agentbrowser) declare no runnables, so seeding never double-lists
    // their tools. `spider` and `shadow` are the declarative exceptions whose
    // manifests CARRY tool runnables as the sole owner: spider a `command` crawl
    // tool, shadow four `http` tools reaching the Shadow sidecar through Core's
    // `/api/shadow/*` proxy (its native `sidecar/mcp` providers were deleted).
    // Seeding the record enabled is exactly what surfaces those tools — no
    // double-listing, since nothing else owns them. (`@ryu/browser` carries the
    // same shape — seven `http` runnables that give `browser.control` registry tool
    // ids to bind to — but is NOT seeded; see the note below its former entry.)
    //
    // CAVEAT this list cannot fix on its own: seeding is what surfaces those tools,
    // so a pre-installed app whose PROCESS cannot start ships tools that fail on every
    // call. `ghost` and `shadow` are in that state today — neither has a public
    // release repo (see `sidecar/tools/ghost/downloader.rs`), so `computer.*` /
    // `ghost.*` / the four shadow `http` tools are offered and then die on spawn.
    // Removing them from here is NOT the fix (ghost is the `"default": true` provider
    // of `computer.control`, and its tools are a headline capability): the fix is CI
    // publishing `ghost-<os>-<arch>` / `shadow-<os>-<arch>`. Until then Core at least
    // reports the cause instead of a bare 502 — see
    // `manifest_sidecar::missing_sidecar_binary_reports`, which covers manifest
    // `local` sidecars; ghost/shadow are built-in `impl Sidecar`s with their own
    // downloaders and are NOT covered by that record.
    "@ryu/ghost",
    "@ryu/shadow",
    "@ryu/spider",
    "@ryu/agentbrowser",
    // Expect and Agentation launch third-party npm MCP servers. They remain
    // Core-tier and can be enabled explicitly, but must not execute mutable
    // registry code just because a node was freshly installed.
    // `exa` is pre-installed so the `web.search` toolkit has a provider out of the
    // box. Without this the capability had ZERO enabled providers on a fresh
    // install, and because the read model derives its capability list from the
    // ENABLED set, the whole toolkit vanished: no `web.search` tool for agents
    // and no row in the node selector, so nothing pointed at the Store either.
    // `web.extract` / `web.crawl` only escaped that because `spider` happens to be
    // pre-installed. Declaring `"default": true` in exa's manifest does NOT fix it —
    // that only breaks ties among ALREADY-ENABLED providers, it never installs
    // anything.
    //
    // Safe to ship on because exa is the one search provider that needs no
    // credential: its binding falls back to Exa's public MCP endpoint when no
    // `RYU_EXA_API_KEY` is set (see fixtures/exa.manifest.json). Every other
    // search provider is BYOK-only and stays opt-in.
    "@ryu/exa",
    // `docs` is pre-installed so every agent can look up Ryu documentation without
    // leaving the chat. Unlike its sibling pre-installed tool apps it needs no
    // binary and no key: the MCP server is REMOTE (`https://docs.ryuhq.com/mcp`),
    // so registration never depends on a probe and the tools are simply there
    // whenever the docs site is reachable — a fail-open read of a public site,
    // the same posture as `web_fetch`.
    "@ryu/docs",
    // Composio Connect is a remote OAuth MCP server. The plugin is registered on
    // a fresh install, but no provider token exists until the user explicitly
    // connects an identity profile from Marketplace → Connections.
    COMPOSIO_CONNECT_PLUGIN_ID,
    // NOTE: @ryu/browser is deliberately NOT pre-installed, and this is the one
    // membership decision here that is driven by RELEASE reality rather than product
    // taste. It was pre-installed ("so the Browser tab uses the real-Chromium sidecar out
    // of the box, not the fallback iframe") — but no release publishes a binary the
    // sidecar loader can install. Its `local` sidecar declares `command:
    // "ryu-browser"`, which `manifest_sidecar::ensure_local_sidecar_present` resolves
    // to the release asset `ryu-browser-<os>-<arch>` (`update::platform_tag()`, e.g.
    // `ryu-browser-macos-aarch64`, no extension, directly spawnable). What the
    // browser job actually uploads is electron-builder's
    // `ryu-browser-mac-arm64.zip`/`.dmg` — a different name AND a non-spawnable
    // bundle. So on every fresh install the app was seeded ENABLED, the desktop's
    // `BrowserTabPanel` feature-detected it and switched off the working iframe
    // fallback, and the panel then showed "Browser sidecar unreachable (502)"
    // permanently. Not pre-installed restores the honest fallback: the tab works, and the
    // Store is the one place that offers the sidecar.
    //
    // Consequences, both intentional:
    //  - `browser.control` (whose ONLY provider is this app) has zero enabled
    //    providers on a fresh install, so its 7 `http` tool runnables are not offered
    //    to agents. That is strictly better than offering tools whose every call dies
    //    on spawn, and agents still browse via `agentbrowser`/`spider`, which are
    //    pre-installed and DO ship. This is the deliberate exception to the exa /
    //    markitdown argument above (seed a provider so the capability is non-empty):
    //    that argument only holds for a provider that can actually run.
    //  - Uninstall-protection is UNCHANGED: browser is in `SYSTEM_PLUGINS`, so
    //    `is_uninstall_protected` still returns true via its `is_system_plugin` branch (it
    //    never depended on the pre-installed branch here).
    //
    // Re-add this line the moment the release publishes an installable, spawnable
    // asset under the `platform_tag()` name. For an Electron bundle that means moving
    // the manifest sidecar from `local` to `binary` (which supports `archive` +
    // `binary_name` extraction), not renaming the zip — macOS cannot ship an Electron
    // app as one executable file.
    //
    // NOTE: @ryu/mail is intentionally NOT pre-installed. It is sidecar-only now
    // (the in-process path was deleted, Track C). The release now builds + ships the
    // `ryu-mail` binary alongside the other 10 sidecar bins (see
    // `.github/workflows/release.yml`), so the old "binary not yet shipped" blocker is
    // gone; mail is kept OPT-IN by product choice (an unconfigured inbox should not
    // surface on a fresh install). Stays in CORE_PLUGINS (installable/enable-able); a
    // dev build can also put it on PATH / set RYU_MAIL_BIN. See
    // docs/platform-decomposition-handoff.md.
    // RAG — pre-installed so retrieval works out of the box; requires `engines`
    // (the embed sidecar), which the capability graph pulls in + protects.
    RAG_PLUGIN_ID,
    // Auto-expand ships pre-installed so its composer toggle + `/expand` command are
    // available with zero setup; the flag/command `match` gate makes it free when
    // the toggle is off and no `/expand` is used (no sandbox spawn on idle turns).
    "@ryu/auto-expand",
    // `markitdown` is pre-installed so the `document.parse` capability has a provider out
    // of the box — the same argument as `exa` above, and for the same mechanical
    // reason: the read model derives the capability's provider list from the ENABLED
    // set, so with every parsing backend not pre-installed the capability has zero providers
    // on a fresh install and `crate::document_parse` silently falls back to its
    // built-in floor (plain-text/markdown only). Every PDF, DOCX and XLSX a user
    // uploads would ingest as unreadable bytes, with nothing in the UI pointing at the
    // Store. Declaring `"default": true` in markitdown's manifest does NOT fix that on
    // its own — as the exa note says, the default flag only breaks ties among
    // ALREADY-ENABLED providers, it never installs anything. This line is what
    // installs it.
    //
    // markitdown specifically because it is the only one of the five that is cheap
    // enough to seed: a small pure-Python install with no native toolchain and no model
    // download. `unstructured` / `docling` / `mineru` stay not pre-installed (see the note
    // below) — a user who wants OCR or layout-aware PDF extraction enables one from the
    // Store, and the `"default": true` flag then keeps markitdown bound unless the user
    // explicitly rebinds via `/api/documents/backends`.
    //
    // CONSEQUENCE, deliberate (same shape as `learning` below): pre-installed ⇒
    // `is_uninstall_protected`, so the default parser can be DISABLED but never
    // uninstalled, and a user who had uninstalled it gets it back once on the next
    // boot. That is the intended posture — the capability should always have a
    // provider record to bind or rebind to.
    //
    // Its sidecar is `lazy: true`, so this seed only REGISTERS the sidecar (claims the
    // port, `server::mod`'s register-only branch); the venv/pip provisioning runs on
    // the first parse, not at boot. A fresh install therefore boots clean even before
    // the sidecar's release tarball exists — the failure, if any, surfaces as a 503
    // `provider_warming` on the first parse, never as a broken startup.
    MARKITDOWN_PLUGIN_ID,
    // NOTE (not pre-installed apps): whiteboard / canvas / finetune / unstructured /
    // docling / mineru / meetings / quests / approvals / healing / monitors /
    // workflows / activity / timeline / skill-editor are intentionally NOT pre-installed —
    // they stay installable + enable-able from the Store (still in CORE_PLUGINS), but a
    // fresh install ships them OFF so the sidebar/App surface isn't pre-loaded with
    // every feature.
    //
    // Not pre-installed has one posture: no lifecycle record is created on a fresh store.
    // An explicit `lifecycle::install_app` carries any compiled-in companion bundle,
    // so there is no reason to create a disabled row merely to hold build content.
    // Spaces stays pre-installed (it is a shared dependency, not a leaf feature).
    SPACES_PLUGIN_ID,
    // REMOVED from the pre-installed set: research / dashboards / teams / clips / recipes.
    //
    // These five were pre-installed for a reason that expired. They began as
    // *governance shells* — the code was in-crate and always ran, and the record
    // only gated the `/api/<feature>/*` routes, so seeding them enabled preserved
    // behaviour that already existed and cost nothing. The decomposition then moved
    // every one of them OUT of process: each is now a `public_mount` sidecar
    // (`ryu-research`, `ryu-dashboards`, `ryu-teams`, `ryu-clips`, `ryu-recipes`)
    // reached through the generic ext-proxy. Pre-installed stopped meaning "a route
    // that was already live stays live" and started meaning "spawn five binaries",
    // and nobody moved the membership when the mechanism moved underneath it.
    //
    // Both halves of what that produced were reported, repeatedly:
    //
    //  - **"I wiped everything and they are all installed again."** They were —
    //    `seed_preinstalled` writes an ENABLED record for every id here on a store
    //    with no rows, which is exactly the state a node reset leaves behind. So
    //    the reset "did nothing" for five apps the user had already uninstalled,
    //    and `is_uninstall_protected` keys off `is_preinstalled`, which meant the
    //    Store would not let them be uninstalled in the first place.
    //  - **"app sidecar binary is not installed."** `manifest_sidecar` reports that
    //    (correctly) whenever a `local` sidecar's `<command>-<os>-<arch>` release
    //    asset cannot be resolved. Seeding an app enabled is what makes Core try,
    //    so five apps the user never asked for produced a spawn error each, on
    //    every boot, in a state the user had no obvious way to leave.
    //
    // This is `@ryu/browser`'s argument (see its NOTE above), reached from the
    // other direction: browser was demoted because its binary does not ship, these
    // five because they should not have been pre-installed once they grew binaries
    // at all. Nothing here is deleted — all five remain Core-tier and installable
    // in `CORE_PLUGINS`, one click from the Store, with `clips`→`shadow` and
    // `recipes`→`ghost` still satisfied by their pre-installed deps.
    //
    // Migration v5 removes the records that the old pre-installed seed already wrote on
    // existing machines — without it this change would only ever reach installs
    // that have not booted.
    // `skills` stays pre-installed (a shared capability). `quests`/`approvals`/`healing`
    // are not pre-installed (see the note above) — `healing` requires `approvals`, so it
    // leaves the pre-installed set with its dep, never orphaned.
    SKILLS_PLUGIN_ID,
    // `learning` is pre-installed because its manifest is the SOLE home of the two
    // consent switches (`learning.skills-enabled` / `learning.enabled`), registered
    // via `contributes.settings_tabs` — a not pre-installed record would hide the control
    // while the thing it governs kept running. The path that makes that concrete is
    // the scheduler's `JobTarget::LearningCycle`: it calls `run_skills_pass` BEFORE
    // any training check, and that pass is gated only on `learning.skills-enabled`
    // (default ON) — so on a stock install it synthesizes skills from real
    // conversations, record or no record, since only the HTTP surface is AppGated
    // (see `server::learning_routes`). The `ExperienceStore` write is the weaker
    // half of the argument: it is record-independent too, but gated on
    // `learning.enabled` (default OFF) and reached only from the explicit
    // thumbs-up/down feedback path.
    // Memory is pre-installed for fresh installs so onboarding can materialize the
    // first user/org profile immediately. Existing explicit disabled records are
    // still authoritative in `seed_preinstalled`, and the profile job enables
    // long-term memory only after the onboarding consent step.
    // CONSEQUENCE, deliberate: pre-installed ⇒ `is_uninstall_protected`, so Learning can
    // no longer be uninstalled by anyone, and a user who HAD uninstalled it gets it
    // back once — installed and enabled — on the next boot after upgrading, because
    // uninstall removes the record and the seeder only skips ids that still have one.
    // That lands them in the posture this list intends (consent switch present), and
    // a "stay uninstalled" tombstone does not exist in the store to honor instead.
    LEARNING_PLUGIN_ID,
    // `monitors` is not pre-installed (see the note above). `hardware` stays pre-installed.
    HARDWARE_PLUGIN_ID,
    // `workflows` is not pre-installed (see the note above). `agents` stays pre-installed and
    // is LOAD-BEARING (see `LOAD_BEARING_PLUGINS`) — chat depends on the agent list.
    AGENTS_PLUGIN_ID,
    // The W0 data-path shells that stay pre-installed so their always-on routes stay
    // reachable after gating (see CORE_PLUGINS). Neither has a `requires` edge.
    //
    // Memory is pre-installed for fresh installs so profile bootstrap can write and
    // recall durable user/org facts immediately. `seed_preinstalled` still honors an
    // existing explicit disabled record, preserving a user's previous choice.
    MEMORY_PLUGIN_ID,
    //
    // NOTE: `predict` is deliberately absent — it is in CORE_PLUGINS but stays OPT-IN
    // (NOT pre-installed). Enabling the Predict plugin flips the system-wide autocomplete
    // brain ON (`main.rs` seeds `predict::set_enabled(rec.enabled)` at boot),
    // which sends text from arbitrary apps to a model; the codebase ships it OFF by
    // design (fixture note + `predict::ENABLED = AtomicBool::new(false)`). Gating its
    // `/api/predict/*` routes on the opt-in app breaks no working install: the brain is
    // already not pre-installed, so any install where predict actually works already has the
    // record enabled → the gate passes. Pre-installed would be a privacy regression.
    //
    // Dictation is pre-installed: it was previously hardcoded into Island with
    // enabled-by-default prefs. Seeding the plugin enabled preserves that UX while
    // making the plugin the single switch (synced into the `dictation` pref blob).
    "@ryu/dictation",
    VOICE_PLUGIN_ID,
    MEDIA_PLUGIN_ID,
    // W7: the webhooks companion, pre-installed so it is present on every fresh install
    // (the page it replaced was always-on). No `requires` edge; not a route gate.
    WEBHOOKS_PLUGIN_ID,
    // W7: the calendar companion, pre-installed so it is present on every fresh install
    // (the page it replaced was always-on). No `requires` edge; not a route gate.
    CALENDAR_PLUGIN_ID,
    // Help Center is pre-installed so the Space-backed support workspace is present
    // on a fresh install. Its `requires` edge is satisfied by the pre-installed Spaces app.
    HELP_CENTER_PLUGIN_ID,
    // Sites is pre-installed as the first-party public-edge control surface. The
    // local companion is honest about preview-only state; managed routing and
    // quotas remain control-plane-owned.
    SITES_PLUGIN_ID,
    // Chat Broadcast is pre-installed because it is a zero-process desktop
    // companion and its explicit confirmation is the user-controlled send gate.
    CHAT_BROADCAST_PLUGIN_ID,
    // `activity` / `timeline` / `skill-editor` are not pre-installed (see the note above).
    // Settings-only shell for the swappable layers. Pre-installed because a settings
    // surface the user cannot reach is not a setting; it contributes no runnables,
    // gates no route, and spawns no process, so enabling it costs nothing.
    LAYERS_PLUGIN_ID,
    // The eleven built-in personality profiles. Same shape as `layers` directly above —
    // a catalog whose options the user cannot reach is not a catalog — and the same
    // zero cost: no runnables, no route gate, no process. `contributes.output_styles`
    // and the Store tab are both served enabled-filtered, so this line is what makes
    // the feature visible at all. Enabling it changes nothing about what RUNS: the
    // every agent defaults to its own voice, so every turn's prompt stays byte-identical
    // until an agent is assigned one (asserted by `no_output_style_leaves_the_acp_preamble_byte_identical`).
    //
    // CONSEQUENCE, deliberate: pre-installed ⇒ `is_uninstall_protected`, so the built-in
    // styles can be DISABLED but not uninstalled. Correct here — they are the picker's
    // stock options, and a user-authored style lives on disk under the user root, not
    // in this package, so uninstalling would never have been how you get rid of one.
    OUTPUT_STYLES_PLUGIN_ID,
];

/// The [`crate::plugin_manifest::PluginTier`] of a plugin.
///
/// A reserved id is necessary but not sufficient for Core tier: manifests from
/// the user-writable plugin directory must not inherit Core privileges merely by
/// copying an official id. The bytes must also be compiled into Core. This keeps
/// the official id reservation while allowing runtime packages to load as
/// Community-tier plugins.
pub fn tier_for(manifest_id: &str) -> crate::plugin_manifest::PluginTier {
    if CORE_PLUGINS.contains(&manifest_id) && is_compiled_in_manifest(manifest_id) {
        crate::plugin_manifest::PluginTier::Core
    } else {
        crate::plugin_manifest::PluginTier::Community
    }
}

pub fn tier_for_manifest(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> crate::plugin_manifest::PluginTier {
    // A manifest's id is not provenance. In particular, do not let a package
    // loaded from the user-writable plugin directory inherit the compiled
    // manifest's tier by copying its id. The exact embedded bytes or a
    // digest-bound verified marketplace install are the only manifest-aware
    // ways to earn Core tier here.
    if is_core_plugin_id(&manifest.id)
        && (is_exact_compiled_manifest(manifest) || is_verified_official_package(manifest))
    {
        crate::plugin_manifest::PluginTier::Core
    } else {
        crate::plugin_manifest::PluginTier::Community
    }
}

fn is_core_plugin_id(manifest_id: &str) -> bool {
    if CORE_PLUGINS.contains(&manifest_id) {
        return true;
    }
    #[cfg(test)]
    {
        // Provenance tests need ids no other parallel in-memory PluginStore can
        // insert or clear in the process-global verified-digest registry.
        return manifest_id.starts_with("@ryu/__test-verified-official-");
    }
    #[cfg(not(test))]
    false
}

fn is_exact_compiled_manifest(manifest: &crate::plugin_manifest::PluginManifest) -> bool {
    if !is_compiled_in_manifest(&manifest.id) {
        return false;
    }
    let digest = crate::plugins::isolation::manifest_sha256_for_trust(manifest);
    crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .any(|builtin| {
            builtin.id == manifest.id
                && crate::plugins::isolation::manifest_sha256_for_trust(&builtin) == digest
        })
}

pub(crate) fn record_verified_official_package(
    manifest: &crate::plugin_manifest::PluginManifest,
    provenance: &crate::plugins::isolation::PluginProvenance,
) {
    if !is_core_plugin_id(&manifest.id)
        || provenance.builtin
        || provenance.source_id.as_deref()
            != Some(crate::plugins::isolation::OFFICIAL_MARKETPLACE_SOURCE_ID)
        || !provenance.signature_verified
        || provenance.manifest_sha256.as_deref()
            != Some(&crate::plugins::isolation::manifest_sha256(manifest))
    {
        return;
    }
    VERIFIED_OFFICIAL_PACKAGES
        .get_or_init(Default::default)
        .lock()
        .expect("verified package registry lock poisoned")
        .insert(
            manifest.id.clone(),
            provenance.manifest_sha256.clone().unwrap(),
        );
}

pub(crate) fn record_verified_official_digest(
    manifest_id: &str,
    provenance: &crate::plugins::isolation::PluginProvenance,
) {
    if !is_core_plugin_id(manifest_id)
        || provenance.builtin
        || provenance.source_id.as_deref()
            != Some(crate::plugins::isolation::OFFICIAL_MARKETPLACE_SOURCE_ID)
        || !provenance.signature_verified
    {
        return;
    }
    if let Some(digest) = &provenance.manifest_sha256 {
        VERIFIED_OFFICIAL_PACKAGES
            .get_or_init(Default::default)
            .lock()
            .expect("verified package registry lock poisoned")
            .insert(manifest_id.to_owned(), digest.clone());
    }
}

pub(crate) fn clear_verified_official_digest(manifest_id: &str) {
    if let Some(registry) = VERIFIED_OFFICIAL_PACKAGES.get() {
        registry
            .lock()
            .expect("verified package registry lock poisoned")
            .remove(manifest_id);
    }
}

fn is_verified_official_package(manifest: &crate::plugin_manifest::PluginManifest) -> bool {
    VERIFIED_OFFICIAL_PACKAGES
        .get_or_init(Default::default)
        .lock()
        .expect("verified package registry lock poisoned")
        .get(&manifest.id)
        .is_some_and(|digest| digest == &crate::plugins::isolation::manifest_sha256(manifest))
}

static VERIFIED_OFFICIAL_PACKAGES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) static VERIFIED_OFFICIAL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether a Core-tier plugin should be seeded enabled on first run.
pub fn is_preinstalled(manifest_id: &str) -> bool {
    CORE_PREINSTALLED.contains(&manifest_id)
}

/// Whether `manifest_id` names a manifest that ships **inside the binary**
/// (a `plugin_manifest/fixtures/*.manifest.json` registered with `include_str!`),
/// as opposed to one loaded from the user-writable `~/.ryu/plugins`.
///
/// This is a **provenance** question, not a privilege one, and it is deliberately
/// distinct from [`tier_for`]. Tier answers "how much may this plugin be trusted
/// with once the Gateway has vetted it" and drives the grant gates. Provenance
/// answers "did a human writing this repo author the bytes" — which is what matters
/// wherever a manifest field is consumed with no per-field approval record to check
/// against (see `tool_exec::may_read_env_secret`: there is no Gateway approval for
/// "may read env var X", so the only honest discriminator is where the manifest
/// came from). Several first-party plugins are Community-tier but compiled in
/// (`exa`, `rtk`, `@ryu/advisor`), so the two predicates genuinely differ.
///
/// Safe as an id comparison because the loader parses built-ins FIRST and
/// duplicate ids are rejected first-occurrence-wins ([`crate::plugin_manifest::PluginManifestLoader::load`]),
/// so a disk manifest can never take a compiled-in id. Computed once and cached —
/// the parse walks every embedded fixture.
pub fn is_compiled_in_manifest(manifest_id: &str) -> bool {
    static IDS: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    IDS.get_or_init(crate::plugin_manifest::compiled_manifest_ids)
        .contains(manifest_id)
}

/// Whether `manifest_id` is a **system plugin**: one of the [`SYSTEM_PLUGINS`]
/// whose real run path is a sidecar or MCP provider, with the plugin record acting
/// as the governed surface over it. System plugins are uninstall-protected (see
/// [`is_uninstall_protected`]) because removing the record would orphan a process
/// the seeder would then resurrect.
///
/// **Not a provenance check.** This was called `is_system_plugin`, which read as "ships
/// in the binary" and is a different, larger set — that question is
/// [`is_compiled_in_manifest`] (every [`BUILTIN_MANIFESTS`] entry). Nor is it a
/// trust tier ([`tier_for`]) or an enablement default ([`is_preinstalled`]). Four
/// independent predicates over four different sets; the old name collided with two
/// of them. See the App lifecycle docs for the full table.
pub fn is_system_plugin(manifest_id: &str) -> bool {
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
/// membership-driven mechanism as [`SYSTEM_PLUGINS`]/[`CORE_PREINSTALLED`], checked
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
/// - `@ryu/agents` — the agent catalog/CRUD surface (`/api/agents/*`). The
///   composer fetches the agent list on boot to populate the picker, so a disabled
///   Agents app would leave chat with no selectable agent — a fresh install would
///   read as broken. The chat-serving ACP substrate is separate kernel code and is
///   never gated; this protects only the catalog surface the composer depends on.
///
/// Everything else stays freely swappable/disableable — this list is deliberately
/// minimal so the "nothing hardcoded, everything swappable" principle holds for
/// all but the two subsystems whose absence reads as a broken install.
pub const LOAD_BEARING_PLUGINS: &[&str] = &["@ryu/engines", "@ryu/durable", AGENTS_PLUGIN_ID];

/// Whether disabling `manifest_id` needs an explicit force override because a core
/// subsystem depends on it. See [`LOAD_BEARING_PLUGINS`].
pub fn is_load_bearing(manifest_id: &str) -> bool {
    LOAD_BEARING_PLUGINS.contains(&manifest_id)
}

/// Plugins that are **mandatory**: REQUIRED FOR CORE, never disableable and never
/// uninstallable, with no `force` escape hatch.
///
/// This is the hard tier beside [`LOAD_BEARING_PLUGINS`], and the two are
/// **disjoint by construction** (asserted by
/// `mandatory_and_load_bearing_are_disjoint`). They answer different questions:
///
/// - Load-bearing: "are you sure?" — refused, but `force = true` goes through, and
///   the desktop turns the 409 into a *Disable anyway?* prompt.
/// - Mandatory: "no." — refused at every call site, with no override.
///
/// Keeping them disjoint is not tidiness. The mandatory check runs FIRST, so an id
/// in both sets could never produce `DisableError::LoadBearing` — the softer tier,
/// its 409, and the prompt built on top of it would all become unreachable code
/// that still looks alive.
///
/// **Why these and not the load-bearing three.** `engines`/`durable`/`agents` fail
/// LOUDLY: switch off the chat engine and chat stops working, in your face, and you
/// go turn it back on. They keep their escape hatch because a visible failure is
/// recoverable and `force` is how an operator digs out of a bad state.
///
/// The members here fail SILENTLY, which is what removes the argument for an
/// override — nothing tells the user, so nothing prompts them to undo it:
///
/// - **Data plane** — `spaces` (the workspace/document root every retrieval path
///   resolves through), `rag`, `layers`. Disabling one does not remove the data, it
///   removes the *reader*: Space uploads simply stop being retrievable, and chat
///   answers as if they were never there.
/// - **Capability plane** — `skills` (the injector both skill roots feed), `media`
///   (the image/render path), `hardware` (the device probing the engine picker
///   reads to decide what can run at all). Each degrades into "the feature quietly
///   does nothing" rather than an error.
///
/// Every entry is also a **Core-only** manifest — no package directory under
/// `apps-store/`, compiled in from `plugin_manifest/fixtures/*.manifest.json`.
/// They are not apps a user chose to install; they are how Core describes its own
/// subsystems to the plugin lifecycle, and "uninstall" has no coherent meaning for
/// something with nothing on disk to remove.
///
/// `memory` is deliberately NOT here despite being the same tier of subsystem: it
/// is pre-installed but user-disableable (see [`MEMORY_PLUGIN_ID`]), and a plugin that
/// ships disabled cannot also be one the user may never disable. Mandatory is a strict subset of
/// [`CORE_PREINSTALLED`], asserted by `mandatory_plugins_are_all_preinstalled`.
///
/// **The manifest's `mandatory: true` does not put anything here.** This constant
/// is the enforcement set and it is Core-owned; the manifest field is the
/// declaration, kept in lockstep by
/// `mandatory_constant_matches_builtin_manifest_declarations`. That direction
/// matters: a manifest is untrusted input, and "cannot be disabled" is precisely
/// the property a hostile plugin would claim for itself. Same posture as
/// [`CORE_PLUGINS`] — privilege is granted by Core, never self-asserted.
pub const MANDATORY_PLUGINS: &[&str] = &[
    // Data plane
    SPACES_PLUGIN_ID,
    RAG_PLUGIN_ID,
    LAYERS_PLUGIN_ID,
    // Capability plane
    SKILLS_PLUGIN_ID,
    MEDIA_PLUGIN_ID,
    HARDWARE_PLUGIN_ID,
];

/// Whether `manifest_id` is required for Core and may never be disabled or
/// uninstalled, not even with `force`. See [`MANDATORY_PLUGINS`].
pub fn is_mandatory(manifest_id: &str) -> bool {
    MANDATORY_PLUGINS.contains(&manifest_id)
}

/// Whether a compiled manifest is part of the minimal production runtime.
///
/// This set is intentionally Core-owned. A manifest cannot opt itself into the
/// trusted runtime by declaring `mandatory: true`. Engines is included separately
/// because it is the provider behind the mandatory RAG → Spaces dependency chain,
/// while remaining user-disableable under the existing lifecycle policy.
pub fn is_runtime_builtin(manifest_id: &str) -> bool {
    is_system_plugin(manifest_id)
        || is_mandatory(manifest_id)
        || is_preinstalled(manifest_id)
        || manifest_id == ENGINES_PLUGIN_ID
}

/// Whether `manifest_id` may NOT be uninstalled (it can only be disabled).
///
/// A plugin is uninstall-protected when removing its lifecycle record would be
/// either meaningless or actively harmful:
///
/// - **It is a built-in system app** ([`is_system_plugin`], the sidecar-backed
///   ghost/shadow/spider/agentbrowser) — matching how `SystemAppCard` already
///   offers only enable/disable, never uninstall.
/// - **It is pre-installed** ([`is_preinstalled`]) — this is the real correctness crux.
///   A pre-installed plugin's manifest is compiled into the binary (`include_str!`),
///   and [`crate::plugins::seed::seed_preinstalled`] re-adds *exactly the
///   [`CORE_PREINSTALLED`] set* whenever a record is missing. So removing a
///   pre-installed record does not uninstall the plugin — it resurrects, enabled,
///   on the very next boot. `is_preinstalled` IS the resurrection set, so refusing
///   it is what actually prevents a "removed" plugin from coming back.
///
/// The two predicates are reused as-is (no parallel list): `is_system_plugin` is a
/// strict subset of `is_preinstalled` here, kept in the OR as a defensive,
/// self-documenting statement of intent.
///
/// Opt-in built-ins (firewall/routing/sandbox/predict/…) are deliberately NOT
/// protected: they are not pre-installed, so removing their record cannot resurrect
/// them — it simply returns them to the install-then-enable state they started in,
/// which is a coherent uninstall. User-installed Community plugins are never
/// protected.
pub fn is_uninstall_protected(manifest_id: &str) -> bool {
    is_mandatory(manifest_id) || is_system_plugin(manifest_id) || is_preinstalled(manifest_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_apps_contains_default_tool_apps() {
        // Spider is deliberately absent — it is a declarative `command` plugin now,
        // not a sidecar-backed system plugin.
        for id in ["@ryu/ghost", "@ryu/shadow", "@ryu/agentbrowser"] {
            assert!(
                SYSTEM_PLUGINS.iter().any(|s| s.manifest_id == id),
                "{id} must be in SYSTEM_PLUGINS"
            );
        }
        assert!(
            !SYSTEM_PLUGINS
                .iter()
                .any(|s| s.manifest_id == "@ryu/spider"),
            "spider is a declarative command plugin, not a system plugin"
        );
    }

    /// The built-in output styles must be reachable on a fresh install.
    ///
    /// This guards a gap that is invisible at the type level and silent at runtime:
    /// both surfaces that expose a profile — `contributes.output_styles` on
    /// `GET /api/plugins/contributions`, and the Store tab (which the desktop renders
    /// only when its app is installed AND enabled) — are served **enabled-filtered**.
    /// Drop this id from `CORE_PREINSTALLED` and nothing fails to compile and no test
    /// about profiles breaks; the agent editor would quietly offer no reusable profile,
    /// with no discovery path anywhere in the product to turn it back on.
    #[test]
    fn output_styles_ship_reachable_on_a_fresh_install() {
        assert!(
            CORE_PLUGINS.contains(&OUTPUT_STYLES_PLUGIN_ID),
            "output-styles must be Core-tier — CORE_PREINSTALLED is documented as a subset of CORE_PLUGINS"
        );
        assert!(
            CORE_PREINSTALLED.contains(&OUTPUT_STYLES_PLUGIN_ID),
            "output-styles must be pre-installed or its contributions are filtered out of \
             the agent editor and the Store tab, with no way for a user to reach them"
        );
    }

    #[test]
    fn agent_status_has_reviewed_core_http_authority_but_remains_opt_in() {
        assert!(CORE_PLUGINS.contains(&"@ryu/agent-status"));
        assert!(!CORE_PREINSTALLED.contains(&"@ryu/agent-status"));
        let manifest = crate::plugin_manifest::PluginManifestLoader::load()
            .into_iter()
            .find(|manifest| manifest.id == "@ryu/agent-status")
            .expect("agent-status manifest is compiled in");
        assert_eq!(
            tier_for_manifest(&manifest),
            crate::plugin_manifest::PluginTier::Core
        );
        manifest
            .validate_declarative_http_policy(true)
            .expect("reviewed Core reads are allowed");
        assert!(manifest.validate_declarative_http_policy(false).is_err());
    }

    #[test]
    fn memory_is_preinstalled_for_fresh_installs() {
        assert!(CORE_PLUGINS.contains(&MEMORY_PLUGIN_ID));
        assert!(CORE_PREINSTALLED.contains(&MEMORY_PLUGIN_ID));
        assert!(!MANDATORY_PLUGINS.contains(&MEMORY_PLUGIN_ID));
    }

    #[test]
    fn is_system_plugin_returns_true_for_known_ids() {
        assert!(is_system_plugin("@ryu/ghost"));
        assert!(is_system_plugin("@ryu/shadow"));
        assert!(is_system_plugin("@ryu/agentbrowser"));
        // spider is Core-tier + pre-installed but NOT a system plugin (no sidecar).
        assert!(!is_system_plugin("@ryu/spider"));
    }

    #[test]
    fn is_system_plugin_returns_false_for_unknown_ids() {
        assert!(!is_system_plugin("@example/research-assistant"));
        assert!(!is_system_plugin("does.not.exist"));
    }

    #[test]
    fn find_system_plugin_returns_correct_metadata() {
        let ghost = find_system_plugin("@ryu/ghost").expect("ghost must be found");
        assert_eq!(ghost.sidecar_name, "@ryu/ghost");
        assert!(
            !ghost.windows_first,
            "ghost is cross-platform (Windows/macOS/Linux backends)"
        );
        assert!(ghost.local_only);

        let shadow = find_system_plugin("@ryu/shadow").expect("shadow must be found");
        assert_eq!(shadow.sidecar_name, "@ryu/shadow");
        assert!(
            !shadow.windows_first,
            "shadow capture is cross-platform (Windows/macOS/Linux)"
        );
        assert!(shadow.local_only);
    }

    #[test]
    fn find_system_plugin_returns_metadata_for_default_tool_apps() {
        // spider is no longer a system plugin (declarative command tool).
        assert!(find_system_plugin("@ryu/spider").is_none());

        let ab = find_system_plugin("@ryu/agentbrowser").expect("agentbrowser must be found");
        assert_eq!(ab.sidecar_name, "@ryu/agentbrowser");
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
        assert_eq!(tier_for("@ryu/engines"), PluginTier::Core);
        assert_eq!(tier_for("@ryu/ghost"), PluginTier::Core);
        assert_eq!(tier_for("@ryu/firewall"), PluginTier::Core);
        assert_eq!(tier_for("@ryu/sandbox"), PluginTier::Core);
        // #448 dogfood: the durable workflow engine plugin is Core-tier.
        assert_eq!(tier_for("@ryu/durable"), PluginTier::Core);
        assert!(is_preinstalled("@ryu/durable"));
    }

    /// The four sidecar-backed default tool apps are Core-tier AND pre-installed, so
    /// a fresh install auto-seeds their app record enabled (parity with the
    /// auto-downloaded default models). They are also system plugins (sidecar
    /// lifecycle) — the two facts coexist: the record is the governance shell, the
    /// sidecar/MCP provider is the run path.
    #[test]
    fn default_tool_apps_are_core_and_preinstalled_and_system() {
        use crate::plugin_manifest::PluginTier;
        for id in ["@ryu/ghost", "@ryu/shadow", "@ryu/agentbrowser"] {
            assert_eq!(tier_for(id), PluginTier::Core, "{id} must be Core-tier");
            assert!(
                is_preinstalled(id),
                "{id} must be pre-installed (auto-seeded)"
            );
            assert!(is_system_plugin(id), "{id} must be a system plugin");
        }
        // Spider is Core-tier + pre-installed (record seeded enabled so its
        // declarative tool works out of the box) but is NOT a system plugin — it
        // has no sidecar lifecycle.
        assert_eq!(
            tier_for("@ryu/spider"),
            PluginTier::Core,
            "spider must be Core-tier"
        );
        assert!(
            is_preinstalled("@ryu/spider"),
            "spider must be pre-installed"
        );
        assert!(
            !is_system_plugin("@ryu/spider"),
            "spider is not a system plugin"
        );
    }

    #[test]
    fn tier_for_unknown_is_community() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(
            tier_for("@example/research-assistant"),
            PluginTier::Community
        );
        assert_eq!(tier_for("does.not.exist"), PluginTier::Community);
    }

    #[test]
    fn signed_official_package_retains_core_tier() {
        let _guard = VERIFIED_OFFICIAL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use crate::plugin_manifest::PluginTier;
        use crate::plugins::isolation::{
            manifest_sha256, PluginProvenance, OFFICIAL_MARKETPLACE_SOURCE_ID,
        };

        let mut official: crate::plugin_manifest::PluginManifest =
            serde_json::from_value(serde_json::json!({
                "id": "@ryu/__test-verified-official-signed",
                "name": "Social",
                "version": "1.0.0",
                "runnables": []
            }))
            .expect("minimal official manifest");
        let provenance = PluginProvenance {
            source_id: Some(OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            signature_verified: true,
            manifest_sha256: Some(manifest_sha256(&official)),
            ..PluginProvenance::default()
        };
        record_verified_official_package(&official, &provenance);
        assert_eq!(tier_for_manifest(&official), PluginTier::Core);
        clear_verified_official_digest(&official.id);
    }

    #[test]
    fn clearing_verified_official_digest_revokes_core_tier() {
        let _guard = VERIFIED_OFFICIAL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use crate::plugin_manifest::PluginTier;
        use crate::plugins::isolation::{
            manifest_sha256, PluginProvenance, OFFICIAL_MARKETPLACE_SOURCE_ID,
        };

        let manifest: crate::plugin_manifest::PluginManifest =
            serde_json::from_value(serde_json::json!({
                "id": "@ryu/__test-verified-official-cleared",
                "name": "Social",
                "version": "1.0.0",
                "runnables": []
            }))
            .expect("minimal official manifest");
        let provenance = PluginProvenance {
            source_id: Some(OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            signature_verified: true,
            manifest_sha256: Some(manifest_sha256(&manifest)),
            ..PluginProvenance::default()
        };

        clear_verified_official_digest(&manifest.id);
        record_verified_official_package(&manifest, &provenance);
        assert_eq!(tier_for_manifest(&manifest), PluginTier::Core);

        clear_verified_official_digest(&manifest.id);
        assert_eq!(tier_for_manifest(&manifest), PluginTier::Community);
    }

    #[test]
    fn spoofed_official_id_does_not_retain_core_tier() {
        let _guard = VERIFIED_OFFICIAL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use crate::plugin_manifest::PluginTier;

        let spoofed: crate::plugin_manifest::PluginManifest =
            serde_json::from_value(serde_json::json!({
                "id": "@ryu/__test-verified-official-spoofed",
                "name": "Spoofed Social",
                "version": "9.9.9",
                "runnables": []
            }))
            .expect("minimal spoofed manifest");

        assert_eq!(tier_for_manifest(&spoofed), PluginTier::Community);
    }

    /// #444 Community-tier gate: a non-Core plugin is Community, is therefore NOT
    /// in `CORE_PREINSTALLED`, and so is never auto-seeded — it must be
    /// install-then-enable opt-in. This asserts the tier gate end-to-end at the
    /// membership layer (the lifecycle store enforces the install-disabled default
    /// that `install_app` tests cover).
    #[test]
    fn community_plugin_is_opt_in_never_preinstalled() {
        use crate::plugin_manifest::PluginTier;
        let community_id = "@example/research-assistant";
        // Tier is Community (not a manifest-asserted field — derived from membership).
        assert_eq!(tier_for(community_id), PluginTier::Community);
        // A Community plugin can never be Core-tier...
        assert!(!CORE_PLUGINS.contains(&community_id));
        // ...and therefore can never be pre-installed (auto-seeded). The startup
        // seeder iterates CORE_PREINSTALLED only, so a Community plugin is never
        // touched until the user explicitly installs+enables it.
        assert!(!CORE_PREINSTALLED.contains(&community_id));
        assert!(!is_preinstalled(community_id));
    }

    // ── The Meetings → Spaces dependency edge (the first REAL one) ────────────

    /// The edge exists in the SHIPPED fixtures, not just in a unit-test fixture.
    /// `MANDATORY_PLUGINS` (what the lifecycle enforces) and the manifests' own
    /// `mandatory: true` (what the Store renders) must name the SAME set.
    ///
    /// Both directions matter, for different failure modes:
    ///
    /// - A constant entry with no manifest declaration = a plugin the UI still
    ///   offers a Disable button for, which then 403s. The user gets a dead control
    ///   and an error where an absent control was the whole design.
    /// - A manifest declaration with no constant entry = a listing that renders as
    ///   undisableable while the lifecycle happily disables it. That is worse than
    ///   the first case, because it is the shape a hostile manifest would use to
    ///   claim a privilege Core never granted.
    #[test]
    fn mandatory_constant_matches_builtin_manifest_declarations() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();

        let declared: std::collections::BTreeSet<&str> = manifests
            .iter()
            .filter(|m| m.mandatory)
            .map(|m| m.id.as_str())
            .collect();
        let enforced: std::collections::BTreeSet<&str> =
            MANDATORY_PLUGINS.iter().copied().collect();

        assert_eq!(
            declared, enforced,
            "MANDATORY_PLUGINS and the manifests declaring `mandatory: true` have \
             drifted. Add `\"mandatory\": true` to the fixture, or drop the id from \
             the constant — the two are one decision recorded twice."
        );
    }

    /// Mandatory ⊂ pre-installed. A plugin that ships DISABLED cannot also be one the
    /// user may never disable — the install would boot into a state its own rules
    /// forbid, and nothing would ever turn it on (`seed_preinstalled` reseeds exactly
    /// `CORE_PREINSTALLED`). This is why `memory`, a subsystem of the same weight as
    /// `rag`, is deliberately not mandatory: it is not pre-installed.
    #[test]
    fn mandatory_plugins_are_all_preinstalled() {
        for id in MANDATORY_PLUGINS {
            assert!(
                is_preinstalled(id),
                "{id} is mandatory but not in CORE_PREINSTALLED — it would ship \
                 disabled and could never be enabled"
            );
        }
    }

    /// The two protection tiers must not overlap.
    ///
    /// `disable_app` checks mandatory FIRST, so an id in both sets can never yield
    /// `DisableError::LoadBearing`. That would silently kill the whole softer tier:
    /// the 409 response, its `code: "load_bearing"`, and the desktop's "disable
    /// anyway?" prompt would all still be there, all unreachable. An overlap does
    /// not break anything visibly — it just quietly deletes a feature — which is
    /// exactly the kind of thing that needs a test rather than a comment.
    #[test]
    fn mandatory_and_load_bearing_are_disjoint() {
        for id in MANDATORY_PLUGINS {
            assert!(
                !is_load_bearing(id),
                "{id} is in BOTH tiers; the mandatory check runs first, so its \
                 load-bearing membership (and the force-override prompt built on it) \
                 is dead. Pick one."
            );
        }
    }

    /// Mandatory is the strictly stronger tier, so it must imply the weaker
    /// protection. Without this, `is_uninstall_protected` could be narrowed and a
    /// mandatory plugin would become uninstallable through the uninstall path even
    /// though the disable path refuses it.
    #[test]
    fn mandatory_plugins_are_uninstall_protected() {
        for id in MANDATORY_PLUGINS {
            assert!(
                is_uninstall_protected(id),
                "{id} is mandatory but not uninstall-protected"
            );
        }
    }

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
        assert_eq!(dep.min_version.as_deref(), Some("0.1.14"));

        // The declared minimum is actually satisfiable by the Spaces we ship —
        // a `requires` that no shipped version can satisfy would fail-closed the
        // pre-installed seed forever.
        assert_eq!(spaces.version, "1.0.0");

        // It declares the grant it really uses (`save_notes_to_space` →
        // `spaces.ingest_document`), the same grant the Whiteboard declares.
        assert!(meetings
            .permission_grants
            .contains(&"spaces:docs".to_owned()));
    }

    /// THE proof the dependency model works end-to-end against real code: Approvals
    /// cannot be disabled out from under an enabled Healing, and the refusal NAMES
    /// the blocker so a UI can say "Disable Healing first" (or offer a cascade)
    /// without parsing a string.
    ///
    /// This used to be written against Spaces←Meetings, which was the obvious pick
    /// while Spaces was the most-depended-on app. Spaces is now
    /// [`MANDATORY_PLUGINS`], so a disable of it is refused BEFORE the dependency
    /// walk ever runs and the test could no longer reach the code it was testing.
    /// Healing→Approvals is the same shape and equally real: a declared
    /// `requires.apps` edge between two shipped, non-mandatory apps.
    #[tokio::test]
    async fn disabling_approvals_is_refused_while_healing_is_enabled() {
        use crate::plugins::graph::DependencyError;
        use crate::plugins::lifecycle::{disable_app, DisableError};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // Both enabled, as a fresh install's seed leaves them.
        for id in [APPROVALS_PLUGIN_ID, HEALING_PLUGIN_ID] {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        // 1. REFUSED — and the error names the dependent.
        let err = disable_app(&store, APPROVALS_PLUGIN_ID, &manifests, false, false)
            .await
            .expect_err("disabling Approvals under an enabled Healing must be refused");
        match err {
            DisableError::Dependency(DependencyError::BlockedByDependents {
                plugin,
                dependents,
            }) => {
                assert_eq!(plugin, APPROVALS_PLUGIN_ID);
                assert!(
                    dependents.contains(&HEALING_PLUGIN_ID.to_owned()),
                    "the refusal must name Healing, got {dependents:?}"
                );
            }
            other => panic!("expected BlockedByDependents, got {other:?}"),
        }

        // A refused disable changes NOTHING (it is not a partial disable).
        assert!(
            store
                .get(APPROVALS_PLUGIN_ID)
                .await
                .unwrap()
                .unwrap()
                .enabled
        );
        assert!(store.get(HEALING_PLUGIN_ID).await.unwrap().unwrap().enabled);

        // 2. Disable the dependent first, and Approvals disables cleanly.
        disable_app(&store, HEALING_PLUGIN_ID, &manifests, false, false)
            .await
            .expect("Healing has no dependents, so it disables freely");
        disable_app(&store, APPROVALS_PLUGIN_ID, &manifests, false, false)
            .await
            .expect("with Healing off, nothing blocks Approvals");

        assert!(
            !store
                .get(APPROVALS_PLUGIN_ID)
                .await
                .unwrap()
                .unwrap()
                .enabled
        );
        assert!(!store.get(HEALING_PLUGIN_ID).await.unwrap().unwrap().enabled);
    }

    /// The opt-in escape hatch: one cascade disables the dependent *and* the
    /// dependency, dependents-first, so nothing is ever left enabled against a
    /// disabled dependency. Re-pointed off Spaces for the reason above.
    #[tokio::test]
    async fn cascading_disable_of_approvals_takes_healing_with_it() {
        use crate::plugins::lifecycle::disable_app;
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        for id in [APPROVALS_PLUGIN_ID, HEALING_PLUGIN_ID] {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        let outcome = disable_app(&store, APPROVALS_PLUGIN_ID, &manifests, true, false)
            .await
            .expect("an explicit cascade is allowed");

        let order: Vec<&str> = outcome.disabled.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            order,
            vec![HEALING_PLUGIN_ID, APPROVALS_PLUGIN_ID],
            "the dependent must be disabled BEFORE its dependency"
        );
        assert!(
            !store
                .get(APPROVALS_PLUGIN_ID)
                .await
                .unwrap()
                .unwrap()
                .enabled
        );
        assert!(!store.get(HEALING_PLUGIN_ID).await.unwrap().unwrap().enabled);
    }

    /// The real pre-installed set must be fully satisfiable — every pre-installed plugin's
    /// `requires` is met from within the set, so nothing is fail-closed skipped, and
    /// Spaces (a shared dependency that stays pre-installed) is seeded.
    #[test]
    fn real_preinstalled_set_is_fully_satisfiable() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let specs = crate::plugins::seed::preinstalled_specs();
        let (ordered, skipped) = crate::plugins::seed::seed_order(&specs, &manifests);

        assert!(
            skipped.is_empty(),
            "no pre-installed plugin may be unsatisfiable: {skipped:?}"
        );
        assert!(
            ordered.iter().any(|id| id == SPACES_PLUGIN_ID),
            "Spaces stays pre-installed and must be seeded, got {ordered:?}"
        );
    }

    /// Spaces stays pre-installed; Meetings is now OPT-IN (not pre-installed). A fresh seed
    /// enables Spaces but must NOT **enable** Meetings — enabling it is a Store
    /// action.
    ///
    /// Meetings remains absent until the user explicitly installs it. Its compiled-in
    /// companion bundle is attached by the install path, and nothing spawns from an
    /// absent or disabled record.
    #[tokio::test]
    async fn the_real_seed_enables_spaces_but_leaves_meetings_optin() {
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        crate::plugins::seed::seed_preinstalled(&store, &manifests).await;

        let spaces = store
            .get(SPACES_PLUGIN_ID)
            .await
            .unwrap()
            .expect("the seed must install Spaces");
        assert!(spaces.enabled, "Spaces must be seeded ENABLED");

        // Meetings is opt-in, so the seed writes no record at all. Seeding Spaces must
        // not drag its dependent on with it.
        assert!(
            store
                .get(MEETINGS_PLUGIN_ID)
                .await
                .unwrap()
                .is_none_or(|record| !record.enabled),
            "Meetings is opt-in (not pre-installed) — the seed must not ENABLE it"
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

    /// Spaces is MANDATORY, and no combination of flags gets past it.
    ///
    /// This test used to assert the opposite — that disabling Spaces was refused
    /// with a *dependents* list and that an explicit cascade was then allowed
    /// through. That was the correct contract while Spaces was merely
    /// widely-depended-on. It is now required for Core, so the interesting question
    /// changed from "does the graph name the blockers?" (covered by
    /// `disabling_approvals_is_refused_while_healing_is_enabled`) to "can ANY caller
    /// get through?".
    ///
    /// All four (cascade × force) combinations are checked, because each is a
    /// distinct code path — the root guard, the resolved-order guard, and the two
    /// `force` branches — and a bypass in any one of them is a bypass.
    #[tokio::test]
    async fn disabling_spaces_is_refused_however_it_is_asked() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};
        use crate::plugins::lifecycle::{disable_app, DisableError};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        let dependents = [MEETINGS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID];
        for id in std::iter::once(SPACES_PLUGIN_ID).chain(dependents) {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        for (cascade, force) in [(false, false), (true, false), (false, true), (true, true)] {
            let err = disable_app(&store, SPACES_PLUGIN_ID, &manifests, cascade, force)
                .await
                .expect_err("Spaces is mandatory and must never disable");
            assert!(
                matches!(err, DisableError::Mandatory { ref id } if id == SPACES_PLUGIN_ID),
                "cascade={cascade} force={force}: expected Mandatory, got {err:?}"
            );
        }

        // Nothing was disabled by any of them — a refusal is never a partial disable,
        // and in particular a cascade must not take the DEPENDENTS down on its way to
        // discovering that the target itself is untouchable.
        for id in std::iter::once(SPACES_PLUGIN_ID).chain(dependents) {
            assert!(store.get(id).await.unwrap().unwrap().enabled, "'{id}'");
        }
    }

    /// A cascade must not reach a mandatory plugin as collateral either. Disabling
    /// Meetings is fine; disabling Meetings *with a cascade that would sweep in its
    /// Spaces dependency* is not — and the refusal must leave Meetings enabled too.
    ///
    /// This is the guard that makes the unforceable tier actually hold: without the
    /// order-wide check, `force` on some unrelated app would be a back door to
    /// switching off the data plane.
    #[tokio::test]
    async fn a_cascade_cannot_reach_a_mandatory_plugin() {
        use crate::plugins::lifecycle::{disable_app, DisableError};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        for id in [SPACES_PLUGIN_ID, MEETINGS_PLUGIN_ID] {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }

        // Meetings alone disables fine — it is the DEPENDENT, and nothing depends on
        // it, so no mandatory plugin is in its resolved order.
        disable_app(&store, MEETINGS_PLUGIN_ID, &manifests, true, false)
            .await
            .expect("Meetings itself is not mandatory");
        store.set_enabled(MEETINGS_PLUGIN_ID, &[]).await.unwrap();

        // Going the other way — cascading FROM Spaces — is refused, with Meetings
        // left untouched.
        let err = disable_app(&store, SPACES_PLUGIN_ID, &manifests, true, true)
            .await
            .expect_err("a cascade from a mandatory root is still refused");
        assert!(matches!(err, DisableError::Mandatory { .. }), "{err:?}");
        assert!(
            store
                .get(MEETINGS_PLUGIN_ID)
                .await
                .unwrap()
                .unwrap()
                .enabled,
            "the refused cascade must not have disabled the dependent"
        );
    }

    /// THE silent-brick guard for the new edges.
    ///
    /// `seed::seed_order` is fail-CLOSED: a pre-installed plugin whose `requires` cannot
    /// be satisfied *from within the pre-installed set* is SKIPPED, not enabled. So the
    /// moment Whiteboard/Canvas declare `requires: Spaces`, their appearing on a fresh
    /// install depends on Spaces staying pre-installed. If that ever changes, both
    /// companions go dark for 100% of users with nothing but a log line. This drives
    /// the REAL seed over the REAL manifests and asserts the end state a user gets.
    #[tokio::test]
    async fn the_real_seed_enables_spaces_and_leaves_its_space_owning_apps_optin() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};
        use crate::plugins::PluginStore;

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();

        // Nothing may be skipped, and Spaces (still pre-installed) must be seeded.
        let specs = crate::plugins::seed::preinstalled_specs();
        let (ordered, skipped) = crate::plugins::seed::seed_order(&specs, &manifests);
        assert!(
            skipped.is_empty(),
            "no pre-installed plugin may be unsatisfiable: {skipped:?}"
        );
        assert!(
            ordered.iter().any(|id| id == SPACES_PLUGIN_ID),
            "Spaces must be seeded, got {ordered:?}"
        );

        // Spaces is enabled; its formerly pre-installed dependents (meetings/whiteboard/
        // canvas) are now opt-in, so the seed must not create records for them. Their
        // bundle comes from `lifecycle::install_app` when the user installs them.
        let store = PluginStore::open_in_memory().unwrap();
        crate::plugins::seed::seed_preinstalled(&store, &manifests).await;
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
                "'{id}' is opt-in — the seed must write no record for it, let alone \
                 an enabled one"
            );
        }
    }

    // ── Load-bearing + uninstall-protection guards ────────────────────────────

    #[test]
    fn engines_is_load_bearing_and_default_swappables_are_not() {
        assert!(is_load_bearing("@ryu/engines"), "engines is load-bearing");
        assert!(is_load_bearing("@ryu/durable"), "durable is load-bearing");
        assert!(
            is_load_bearing(AGENTS_PLUGIN_ID),
            "agents is load-bearing (composer fetches the agent list on boot)"
        );
        // A freely-disableable Core plugin is NOT load-bearing.
        assert!(!is_load_bearing("@ryu/goal"));
        assert!(!is_load_bearing("@ryu/firewall"));
        assert!(!is_load_bearing("@example/research-assistant"));
    }

    /// The uninstall-protection predicate must cover the FULL resurrection set
    /// (`is_preinstalled`), not just the 4 SYSTEM plugins. `goal` isolates the
    /// `is_preinstalled` branch: pre-installed, NOT a system plugin, NOT load-bearing —
    /// so a weak `is_system_plugin`-only predicate would wrongly allow uninstalling it,
    /// and the seed would resurrect it on the next boot.
    #[test]
    fn uninstall_protection_covers_every_preinstalled_plugin_not_just_system_apps() {
        // A pre-installed, non-SYSTEM plugin is protected (the crux).
        assert!(
            !is_system_plugin("@ryu/goal"),
            "goal is not a SYSTEM plugin"
        );
        assert!(is_preinstalled("@ryu/goal"));
        assert!(
            is_uninstall_protected("@ryu/goal"),
            "a pre-installed plugin must be uninstall-protected or the seed resurrects it"
        );
        // The SYSTEM sidecar apps are protected too.
        for id in [
            "@ryu/ghost",
            "@ryu/shadow",
            "@ryu/spider",
            "@ryu/agentbrowser",
        ] {
            assert!(is_uninstall_protected(id), "{id} must be protected");
        }
        // engines/durable (pre-installed + load-bearing) are protected.
        assert!(is_uninstall_protected("@ryu/engines"));
        assert!(is_uninstall_protected("@ryu/durable"));
    }

    #[test]
    fn opt_in_builtins_and_community_plugins_are_not_uninstall_protected() {
        // Opt-in built-ins are compiled-in but NOT pre-installed, so removing their
        // record cannot resurrect them — uninstall is allowed.
        for id in [
            "@ryu/firewall",
            "@ryu/routing",
            "@ryu/sandbox",
            "@ryu/predict",
        ] {
            assert!(
                !is_uninstall_protected(id),
                "{id} is opt-in (not pre-installed) and must be uninstallable"
            );
        }
        // A user-installed Community plugin is always uninstallable.
        assert!(!is_uninstall_protected("@example/research-assistant"));
    }

    #[test]
    fn preinstalled_is_a_subset_of_core_and_opt_in_excluded() {
        // Every pre-installed plugin must be Core-tier.
        for id in CORE_PREINSTALLED {
            assert!(
                CORE_PLUGINS.contains(id),
                "pre-installed plugin '{id}' must be Core-tier"
            );
            assert!(is_preinstalled(id));
        }
        // Gateway/sandbox policy plugins are Core-tier but NOT pre-installed
        // (they change gateway/sandbox behaviour, so they stay opt-in).
        assert!(!is_preinstalled("@ryu/firewall"));
        assert!(!is_preinstalled("@ryu/routing"));
        assert!(!is_preinstalled("@ryu/sandbox"));
        assert!(!is_preinstalled("@ryu/headroom"));
        // Autocomplete is Core-tier but opt-in (sends text to a model).
        assert!(CORE_PLUGINS.contains(&"@ryu/predict"));
        assert!(!is_preinstalled("@ryu/predict"));
        // Dictation is Core-tier and pre-installed (Island surface, previously hardcoded).
        assert!(CORE_PLUGINS.contains(&"@ryu/dictation"));
        assert!(is_preinstalled("@ryu/dictation"));
        // Reactions are Core-tier and pre-installed so the built-in message-action
        // contribution is present on a fresh install while remaining disableable.
        assert!(CORE_PLUGINS.contains(&"@ryu/reactions"));
        assert!(is_preinstalled("@ryu/reactions"));
        // Side chats own the `/btw` command, persisted side-chat routes, and the
        // desktop context/sidebar affordances.
        assert!(CORE_PLUGINS.contains(&SIDE_CHATS_PLUGIN_ID));
        assert!(is_preinstalled(SIDE_CHATS_PLUGIN_ID));
        // Temporary chats own the desktop-only privacy/lifecycle behavior. Keep
        // this separate from `@ryu/ghost`, which is the computer-control plugin.
        assert!(CORE_PLUGINS.contains(&GHOST_CHATS_PLUGIN_ID));
        assert!(is_preinstalled(GHOST_CHATS_PLUGIN_ID));
        assert!(CORE_PLUGINS.contains(&EXPANDED_COMPOSER_PLUGIN_ID));
        assert!(is_preinstalled(EXPANDED_COMPOSER_PLUGIN_ID));
        // Session stats replace the former inference readout while remaining
        // disableable through the plugin-owned appearance preference.
        assert!(CORE_PLUGINS.contains(&STATS_PLUGIN_ID));
        assert!(is_preinstalled(STATS_PLUGIN_ID));
        // The Island companion is Core-tier but OPT-IN: no release auto-installs the
        // Electron bundle, so its record must never seed enabled (a fresh store has no
        // Island settings tab until the user installs the app from the Store).
        assert!(CORE_PLUGINS.contains(&"@ryu/island"));
        assert!(!is_preinstalled("@ryu/island"));
    }

    // ── Registration integrity: every id in a membership list must exist ──────
    //
    // `plugins::seed::seed_order` SILENTLY DROPS a pre-installed spec whose manifest is
    // not loaded ("no loaded manifest ⇒ nothing to seed"), so a typo in
    // `CORE_PREINSTALLED` or a missing `include_str!` in `BUILTIN_MANIFESTS` never
    // fails a test — the plugin just quietly never seeds. These guards close that
    // gap by asserting every membership id resolves to a real, loaded built-in.

    #[test]
    fn every_core_preinstalled_id_resolves_to_a_loaded_builtin_manifest() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for id in CORE_PREINSTALLED {
            assert!(
                manifests.iter().any(|m| &m.id == id),
                "pre-installed plugin '{id}' has no loaded built-in manifest — seed_order \
                 would drop it silently (typo in CORE_PREINSTALLED or missing fixture in \
                 BUILTIN_MANIFESTS)"
            );
        }
    }

    /// `scrapling` is the first Core-tier provider that is BOTH `mcp_servers`-backed
    /// and opt-in, and that combination is only correct because of a non-obvious
    /// constraint: `sidecar::mcp::may_register_mcp_servers` auto-allows a manifest's
    /// declared MCP servers for Core-tier ONLY. Demoting it to Community would need
    /// the approved `mcp:server` grant, which is off the Gateway's default allowlist
    /// and in a reserved namespace — so a Community-tier scrapling registers nothing
    /// and is dead on arrival, with no error anywhere to say so.
    ///
    /// It must also stay OUT of `CORE_PREINSTALLED`: the MCP server is a BYO
    /// `pip install "scrapling[ai]"`, so seeding it enabled would put a permanently
    /// unavailable tool on every fresh install.
    #[test]
    fn scrapling_is_core_tier_and_opt_in_with_a_loadable_mcp_manifest() {
        assert_eq!(
            tier_for("@ryu/scrapling"),
            crate::plugin_manifest::PluginTier::Core,
            "scrapling must be Core-tier or its manifest-declared MCP server is never \
             registered and it owns no tools at all"
        );
        assert!(
            !is_preinstalled("@ryu/scrapling"),
            "scrapling must stay opt-in: its MCP server is a BYO pip install"
        );

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let manifest = manifests
            .iter()
            .find(|m| m.id == "@ryu/scrapling")
            .expect("scrapling fixture did not load");

        // The tools come from the MCP server, so empty `runnables` is correct here —
        // re-adding them would double-list every tool as an `app.<slug>` alias.
        assert!(manifest.runnables.is_empty());
        assert!(
            manifest.mcp_servers.contains_key("scrapling"),
            "the MCP server key IS the tool-id prefix: `tool_id(server, tool)` builds \
             `scrapling.get`, which is exactly what the capability binding names"
        );

        // Exactly one capability, and deliberately NOT `web.crawl`: only Scrapling's
        // Python `Spider` class follows links and MCP does not expose it. A partial
        // entry would join resolution for web.crawl and could win the pick away from
        // `spider`, silently killing a layer that works.
        let capabilities: Vec<&str> = manifest
            .provides
            .iter()
            .map(|p| p.capability.as_str())
            .collect();
        assert_eq!(capabilities, vec!["web.extract"]);

        let entry = &manifest.provides[0];
        // Selectability needs unanimity across a capability's providers, and `spider`
        // owns the `default` for web.extract — note `scrapling` sorts BEFORE `spider`,
        // so if that default were ever dropped the lexicographic fallback would elect
        // this provider instead.
        assert!(entry.selectable);
        assert!(!entry.default_provider);

        let binding = entry
            .tools
            .get("web.extract")
            .expect("no web.extract binding");
        assert_eq!(binding.tool, "scrapling.get");
        // An adapter, not a `response` map: `structuredContent.content` is an ARRAY of
        // chunks and the canonical `content` is a string, which the declarative mapper
        // cannot join. Running both would apply the mapping twice, so they are
        // mutually exclusive by construction.
        assert!(binding.adapter.is_some());
        assert!(binding.response.is_none());
        // The adapter path hard-errors without this grant.
        assert!(
            manifest
                .permission_grants
                .iter()
                .any(|g| g == crate::tool_exec::GRANT_TOOL_EXECUTE),
            "an adapter-mapped provider must hold tool:execute or every web.extract \
             call through it fails"
        );
    }

    /// zvec-grep is the semantic search companion to the exact-search ripgrep
    /// plugin. It must stay Core-tier because its manifest-owned MCP server is a
    /// local process, but opt-in because Node.js and a user-created workspace
    /// index are prerequisites. The stdio bridge is upstream-owned and must stay
    /// pinned so the package executed by `npx` is part of the reviewed contract.
    #[test]
    fn zvec_grep_is_core_tier_and_opt_in_with_a_pinned_stdio_mcp_manifest() {
        assert_eq!(
            tier_for("@ryu/zvec-grep"),
            crate::plugin_manifest::PluginTier::Core,
            "zvec-grep must be Core-tier or its manifest MCP server is never registered"
        );
        assert!(
            !is_preinstalled("@ryu/zvec-grep"),
            "zvec-grep must stay opt-in: it requires Node.js and an explicit index"
        );

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let manifest = manifests
            .iter()
            .find(|m| m.id == "@ryu/zvec-grep")
            .expect("zvec-grep fixture did not load");

        assert!(manifest.runnables.is_empty());
        assert_eq!(
            manifest
                .permission_grants
                .iter()
                .find(|grant| grant.starts_with("mcp:"))
                .map(String::as_str),
            Some("mcp:zvec_grep")
        );

        let server = manifest
            .mcp_servers
            .get("zvec_grep")
            .expect("zvec-grep must declare its MCP server");
        assert_eq!(server.command.as_deref(), Some("npx"));
        assert_eq!(
            server.args,
            vec!["-y", "@zvec/zvec-grep@0.2.1", "server", "--stdio"]
        );
    }

    /// The `document.parse` capability has FIVE providers, and the whole
    /// "markitdown is the default parser" claim rests on two independent facts that
    /// live in different files and are easy to break apart:
    ///
    /// 1. exactly one provider carries `"default": true` — and it is `markitdown`,
    ///    not whichever id happens to sort first. `plugins::binding` resolves a
    ///    selectable capability as user override > sole provider > declared default >
    ///    **lexicographically-lowest provider id**, so zero defaults AND two defaults
    ///    both silently elect `@ryu/anydoc`. Nothing errors either way.
    /// 2. `markitdown` is in [`CORE_PREINSTALLED`] — the flag only breaks ties among
    ///    ALREADY-ENABLED providers, it never installs anything, so without the seed
    ///    the capability has zero providers on a fresh install.
    ///
    /// Asserted against the LOADED manifests (not the raw JSON) so it also covers the
    /// serde mapping of the `default` key onto `ProvidesEntry::default_provider`.
    /// `selectable` is checked on all five because it is a per-provider **veto**: one
    /// provider omitting it makes `document.parse` non-swappable for everyone.
    #[test]
    fn exactly_one_document_parse_provider_is_default_and_it_is_markitdown() {
        const CAP: &str = "document.parse";
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();

        let mut providers: Vec<(&str, bool, bool)> = Vec::new();
        for m in &manifests {
            for p in &m.provides {
                if p.capability == CAP {
                    providers.push((m.id.as_str(), p.default_provider, p.selectable));
                }
            }
        }
        providers.sort_unstable();

        let ids: Vec<&str> = providers.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(
            ids,
            vec![
                ANYDOC_PLUGIN_ID,
                DOCLING_PLUGIN_ID,
                MARKITDOWN_PLUGIN_ID,
                MINERU_PLUGIN_ID,
                UNSTRUCTURED_PLUGIN_ID,
            ],
            "all five parsing backends must be registered in BUILTIN_MANIFESTS"
        );

        let defaults: Vec<&str> = providers
            .iter()
            .filter(|(_, is_default, _)| *is_default)
            .map(|(id, _, _)| *id)
            .collect();
        assert_eq!(
            defaults,
            vec![MARKITDOWN_PLUGIN_ID],
            "EXACTLY ONE `document.parse` provider may declare `\"default\": true`, and it \
             must be markitdown. Zero defaults and two defaults both silently elect \
             '{DOCLING_PLUGIN_ID}' (lexicographically lowest) instead — a second \
             `\"default\": true` does not make that provider win, it re-runs the tiebreak."
        );

        for (id, _, selectable) in &providers {
            assert!(
                *selectable,
                "'{id}' must declare `selectable` — every provider of a capability has to \
                 agree, so one omission makes `document.parse` non-swappable for everyone"
            );
        }

        assert!(
            is_preinstalled(MARKITDOWN_PLUGIN_ID),
            "markitdown must be pre-installed: `\"default\": true` only breaks ties among \
             ENABLED providers, so without the seed `document.parse` has zero providers on \
             a fresh install and document_parse falls back to its text-only builtin floor"
        );
        for id in [
            ANYDOC_PLUGIN_ID,
            UNSTRUCTURED_PLUGIN_ID,
            DOCLING_PLUGIN_ID,
            MINERU_PLUGIN_ID,
        ] {
            assert!(
                CORE_PLUGINS.contains(&id),
                "'{id}' must be Core-tier so it is governed and enable-able from the Store"
            );
            assert!(
                !is_preinstalled(id),
                "'{id}' is an opt-in backend and must stay not pre-installed"
            );
            assert!(
                !is_load_bearing(id),
                "no parsing backend is load-bearing — the capability is swappable"
            );
        }
        assert!(
            !is_load_bearing(MARKITDOWN_PLUGIN_ID),
            "the default parser is still swappable: pre-installed, never load-bearing"
        );
    }

    /// The third fact behind a working parser picker, and the one that actually
    /// broke: every `document.parse` provider must be reported to a picker as
    /// **servable**.
    ///
    /// `document.parse` is served by Core calling the provider's sidecar route
    /// (`crate::document_parse`), never by capability verbs, so all five manifests
    /// declare zero `tools` — correctly. The desktop layer picker read only
    /// `serves_verbs` and concluded the opposite: it disabled all five rows,
    /// including the bound default, and labelled working backends "serves no verbs
    /// yet", leaving the layer unswappable from the node dropdown while parsing
    /// worked fine. Nothing failed, because the two halves (a capability with no
    /// verbs; a picker that gates on verbs) were each individually defensible.
    ///
    /// Asserted through [`describe_capabilities`] rather than on the manifests so it
    /// covers the read model a client actually sees, and mirrors what
    /// `ext_proxy::resolve_provider_route` requires — declaring a `route` with no
    /// resolvable `sidecar` must NOT count, since that is the dead-end pick the
    /// servability flags exist to keep a picker away from.
    #[test]
    fn every_document_parse_provider_is_reported_servable() {
        const CAP: &str = "document.parse";
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let described = crate::plugins::binding::describe_capabilities(
            &manifests,
            &manifests,
            &crate::plugins::binding::BindingConfig::default(),
        );
        let parse = described
            .iter()
            .find(|c| c.capability == CAP)
            .expect("document.parse must appear in the capability read model");

        assert!(
            !parse.providers.is_empty(),
            "the fixture set must enable at least one parser or this asserts nothing"
        );
        for p in &parse.providers {
            assert!(
                !p.serves_verbs,
                "'{}' declares capability verbs — if `document.parse` ever grows a verb \
                 facade, this test and the pickers' verb-count copy both need revisiting",
                p.id
            );
            assert!(
                p.serves_route,
                "'{}' must be reported route-servable: it has no verbs, so a picker that \
                 asks `serves_verbs || serves_route` would otherwise grey it out and the \
                 parser layer becomes unswappable. Check that its `provides[]` entry \
                 declares BOTH `sidecar` and `route`, and that the named sidecar exists \
                 on the manifest.",
                p.id
            );
        }

        // Keeps the loop above from passing vacuously. `serves_route` is computed, not
        // declared, and a predicate that returned `true` unconditionally would satisfy
        // every assertion here while re-opening the hole from the other side — letting
        // a picker offer a provider the broker cannot route to. `agentbrowser` is the
        // discriminating case: it serves `browser.control` by verbs with no `sidecar`
        // and no `route`, so it must come back verb-servable and route-UNservable.
        let browser = described
            .iter()
            .find(|c| c.capability == "browser.control")
            .expect("browser.control must appear in the capability read model");
        let agent = browser
            .providers
            .iter()
            .chain(browser.available.iter())
            .find(|p| p.id == "@ryu/agentbrowser")
            .expect("agentbrowser must be a registered browser.control provider");
        assert!(
            agent.serves_verbs && !agent.serves_route,
            "'{}' serves by verbs and declares no sidecar route — if this flips, \
             `serves_route` has stopped discriminating and the assertions above prove \
             nothing",
            agent.id
        );
    }

    /// Only real toolkits may be reported as toolkits.
    ///
    /// The node dropdown's "Toolkits" list filtered on `selectable`, which is the
    /// BINDER's tie-break flag: `plugins::binding::is_selectable` is a unanimity
    /// check across a capability's providers, and unanimity over a set of one is
    /// free. So four app-private capabilities — `news.crud`, `plan.review`,
    /// `reasoning.check`, `tuition.crud` — appeared as swappable layers with a
    /// single provider and nothing to swap to, purely because their manifests had
    /// copied `"selectable": true` from a neighbour that needed it.
    ///
    /// The manifests were cleaned up, but the shape of the mistake is what recurs:
    /// the next app copies the same block. `toolkit` is COMPUTED for that reason,
    /// and this test asserts the computation over the real built-in set rather than
    /// re-asserting the manifests, so a manifest re-adding the flag cannot re-open
    /// the hole.
    ///
    /// ## What this test does NOT discriminate
    ///
    /// Stated plainly so the green is not read as more than it is: over the shipped
    /// manifests the predicate's two arms agree everywhere. Every facade capability
    /// also has ≥2 providers (`browser.control` and `computer.control` are the
    /// minimum, at two each), and every non-facade capability has exactly one. A
    /// `toolkit` implemented as only the facade check, or as only the ≥2 count,
    /// would pass this test unchanged. The ≥2 arm is proven separately against a
    /// synthetic manifest set by
    /// `plugins::binding::tests::two_providers_make_a_non_facade_capability_a_toolkit`.
    #[test]
    fn only_facade_or_multi_provider_capabilities_are_reported_as_toolkits() {
        /// Provided by exactly one app, for that app's own sidecar. None of these is
        /// a layer anyone picks a provider for.
        const APP_PRIVATE: &[&str] = &[
            "news.crud",
            "plan.review",
            "reasoning.check",
            "tuition.crud",
        ];

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let described = crate::plugins::binding::describe_capabilities(
            &manifests,
            &manifests,
            &crate::plugins::binding::BindingConfig::default(),
        );

        for cap in APP_PRIVATE {
            let row = described
                .iter()
                .find(|c| &c.capability == cap)
                .unwrap_or_else(|| {
                    panic!(
                        "'{cap}' must still appear in the capability read model — this \
                         test asserts it is reported as a NON-toolkit, and a capability \
                         that vanished from BUILTIN_MANIFESTS would pass vacuously"
                    )
                });
            assert!(
                !row.toolkit,
                "'{cap}' is one app's private wiring to its own sidecar and must not be \
                 offered as a swappable layer. If a second app has legitimately started \
                 providing it, this capability became a real toolkit and the entry \
                 belongs off this list — check `providers`/`available` before deleting it."
            );
        }

        let mut toolkits: Vec<&str> = Vec::new();
        for row in &described {
            if !row.toolkit {
                continue;
            }
            toolkits.push(row.capability.as_str());
            let provider_count = manifests
                .iter()
                .filter(|m| {
                    m.provided_capabilities()
                        .iter()
                        .any(|p| p.capability == row.capability)
                })
                .count();
            let facade = row.capability == crate::document_parse::CAP_DOCUMENT_PARSE
                || crate::sidecar::mcp::capability_tools::verbs()
                    .iter()
                    .any(|v| v.capability == row.capability);
            assert!(
                facade || provider_count >= 2,
                "'{}' is reported as a toolkit with {provider_count} provider(s) and no \
                 host facade behind it. A toolkit has to be something a user can \
                 meaningfully re-point: either Core serves it (canonical verbs, or the \
                 document.parse route) so providers are interchangeable, or there are at \
                 least two of them.",
                row.capability
            );
        }

        // Keeps the loop above from passing vacuously — an `is_toolkit` stuck at
        // `false` would satisfy every assertion here and silently empty the picker.
        assert!(
            toolkits.contains(&"web.search") && toolkits.contains(&"document.parse"),
            "the real layers must survive the filter; got {toolkits:?}"
        );
    }

    #[test]
    fn every_core_plugin_id_resolves_to_a_loaded_builtin_manifest() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for id in CORE_PLUGINS {
            assert!(
                manifests.iter().any(|m| &m.id == id),
                "Core-tier plugin '{id}' has no loaded built-in manifest — tier_for('{id}') \
                 claims Core but nothing backs it"
            );
        }
    }

    /// The INVERSE of the test directly above, and the one that was missing while
    /// four shipped apps were silently broken.
    ///
    /// `tier_for` derives tier from [`CORE_PLUGINS`] membership ALONE, and both
    /// `sidecar::manifest_sidecar::may_run_sidecar` and
    /// `sidecar::mcp::may_register_mcp_servers` auto-allow only at Core tier —
    /// Community tier needs an approved `sidecar:process` / `mcp:server` grant, and
    /// both live in a reserved namespace the Gateway DENIES at enable. So a built-in
    /// manifest that declares a sidecar or an MCP server and is absent from
    /// `CORE_PLUGINS` installs, enables, reports itself healthy — and its binary
    /// never spawns while its MCP tools never appear, with no error anywhere.
    ///
    /// `every_core_plugin_id_resolves_to_a_loaded_builtin_manifest` only checks
    /// CORE_PLUGINS → manifest, so it cannot see that failure. `@ryu/reasoning`
    /// shipped with it, then `@ryu/news`, `@ryu/tuition` and `@ryu/simulator` shipped
    /// with it again; this test is what makes the fourth time impossible.
    #[test]
    fn every_builtin_manifest_with_a_process_is_core_tier() {
        /// Built-ins that declare a process and are Community-tier ON PURPOSE.
        /// Membership here is a decision, not a convenience: both are reference
        /// plugins whose whole point is to prove the third-party path works.
        const DELIBERATELY_COMMUNITY: &[&str] = &[
            // "the compression *service* is the plugin and Core only hosts the
            // gateway transform, so it is install-then-enable from the marketplace
            // exactly like a third-party compression plugin would be" — the
            // `CORE_PLUGINS` doc comment. Consequence, accepted: it declares a
            // `local` sidecar with EMPTY `permission_grants`, so at Community tier
            // its sidecar cannot spawn either. That is the same shape as the bug
            // this test guards; it is out of scope here and stays deliberate until
            // someone decides otherwise.
            "@ryu/headroom",
            // "the REFERENCE third-party MCP widget plugin (a dev template) …
            // deliberately OPT-IN" — its `BUILTIN_MANIFESTS` comment. A developer
            // installing the example is meant to walk the Community grant path,
            // which is precisely what it demonstrates.
            "@ryu/sample-widget",
        ];

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for m in &manifests {
            let declares_sidecar = !m.sidecars.is_empty();
            let declares_mcp = !m.mcp_servers.is_empty();
            if !(declares_sidecar || declares_mcp)
                || DELIBERATELY_COMMUNITY.contains(&m.id.as_str())
            {
                continue;
            }
            let what = match (declares_sidecar, declares_mcp) {
                (true, true) => "a managed sidecar and `mcp_servers`",
                (true, false) => "a managed sidecar",
                _ => "`mcp_servers`",
            };
            assert!(
                CORE_PLUGINS.contains(&m.id.as_str()),
                "built-in manifest '{}' declares {what} but is absent from CORE_PLUGINS, so \
                 tier_for('{}') is Community and the Gateway denies the `sidecar:process` / \
                 `mcp:server` grant it would need — the app installs, enables and then \
                 silently never spawns. Add it to CORE_PLUGINS, or to \
                 DELIBERATELY_COMMUNITY with the reason it should stay opt-in.",
                m.id,
                m.id
            );
        }

        // Non-vacuous: the loop must actually have inspected the shipped
        // sidecar-owning apps, not skipped an empty or mis-parsed manifest set.
        for id in ["@ryu/news", "@ryu/tuition", "@ryu/simulator"] {
            let m = manifests
                .iter()
                .find(|m| m.id == id)
                .unwrap_or_else(|| panic!("built-in manifest `{id}` is not compiled in"));
            assert!(
                !m.sidecars.is_empty(),
                "{id} is only an interesting case while it declares a sidecar"
            );
        }
    }

    #[test]
    fn every_system_plugin_id_resolves_to_a_loaded_builtin_manifest() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for sys in SYSTEM_PLUGINS {
            assert!(
                manifests.iter().any(|m| m.id == sys.manifest_id),
                "SYSTEM_PLUGINS entry '{}' has no loaded built-in manifest",
                sys.manifest_id
            );
        }
    }

    #[test]
    fn membership_lists_contain_no_duplicate_ids() {
        for (label, list) in [
            ("CORE_PLUGINS", CORE_PLUGINS),
            ("CORE_PREINSTALLED", CORE_PREINSTALLED),
        ] {
            let mut seen = std::collections::HashSet::new();
            for id in list {
                assert!(seen.insert(*id), "'{id}' appears more than once in {label}");
            }
        }
    }

    /// The Browser app must stay INSTALLABLE but never auto-seeded: no release
    /// publishes the `ryu-browser-<os>-<arch>` asset its `local` sidecar resolves, and
    /// a seeded-enabled record makes the desktop drop its working iframe fallback for
    /// a panel that 502s forever. Re-adding it to `CORE_PREINSTALLED` without shipping
    /// that asset re-breaks the Browser tab on every fresh install, so the invariant is
    /// pinned here. Uninstall-protection must be unaffected (it comes from
    /// `SYSTEM_PLUGINS`/`is_system_plugin`, not from being pre-installed).
    #[test]
    fn browser_is_installable_but_not_seeded_until_its_sidecar_ships() {
        assert!(
            CORE_PLUGINS.contains(&BROWSER_PLUGIN_ID),
            "browser must stay Core-tier + installable from the Store"
        );
        assert!(
            !CORE_PREINSTALLED.contains(&BROWSER_PLUGIN_ID),
            "browser must NOT be pre-installed while no release publishes a spawnable \
             ryu-browser binary — a seeded record turns the workspace Browser tab into \
             a permanent 'sidecar unreachable (502)'"
        );
        assert!(!is_preinstalled(BROWSER_PLUGIN_ID));
        // Still a SYSTEM plugin, so protection is unchanged by the line removal.
        assert!(is_system_plugin(BROWSER_PLUGIN_ID));
        assert!(
            is_uninstall_protected(BROWSER_PLUGIN_ID),
            "browser is uninstall-protected via is_system_plugin, independently of pre-installed"
        );
    }

    #[test]
    fn preinstalled_is_uninstall_protected_and_never_community() {
        use crate::plugin_manifest::PluginTier;
        for id in CORE_PREINSTALLED {
            assert!(
                is_uninstall_protected(id),
                "pre-installed '{id}' must be uninstall-protected (else the seed resurrects a \
                 record the user removed)"
            );
            assert_ne!(
                tier_for(id),
                PluginTier::Community,
                "pre-installed '{id}' must not be Community-tier"
            );
        }
    }
}
