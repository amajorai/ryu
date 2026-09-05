//! Pre-installed plugin seeding — the ONE definition of "what is enabled on a fresh
//! install".
//!
//! # Why this is not `lifecycle::enable_app`
//!
//! Seeding runs during startup, **before the Gateway sidecar is spawned**
//! (`main.rs` starts it well after this; the gateway-policy seed comment says the
//! same). `enable_app` fails **closed** on an unreachable Gateway, so routing the
//! seed through it would leave every pre-installed plugin disabled on every fresh
//! install — a hard regression. The seed is a trusted first-party bootstrap that
//! writes the store directly, with explicit, hardcoded grants.
//!
//! That bypass is safe for *policy* (these are our own plugins, with grants we
//! chose) but it MUST NOT bypass the **dependency graph** — otherwise the very
//! first first-party plugin to declare `requires` would be seeded enabled while
//! its dependency stayed disabled, i.e. exactly the half-enabled state the graph
//! exists to prevent, on the path every user hits. So this module keeps the
//! store-only write and adds the two things the graph gives `enable_app`:
//!
//! 1. **Topological order** — a dependency is always seeded before its dependent
//!    (the declaration order of [`crate::plugins::builtins::CORE_PREINSTALLED`] is
//!    NOT topological, and must not have to be).
//! 2. **Fail-closed satisfiability** — a pre-installed plugin whose `requires` cannot
//!    be satisfied *from within the pre-installed set* is SKIPPED (logged loudly),
//!    never seeded enabled with a missing dependency.
//!
//! # The pre-installed set is the universe
//!
//! [`seed_order`] resolves each plugin against the pre-installed manifests **only**.
//! A pre-installed plugin that depends on an opt-in plugin therefore reports
//! `MissingDependency` and is skipped, rather than silently auto-installing
//! something the user never asked for. `enable_app` would report the same error
//! for an uninstalled dependency; a seed must not be more permissive than an
//! explicit enable.
//!
//! # Core-vs-Gateway boundary
//!
//! Pure Core: this decides *what runs* on a fresh install. No policy is enforced
//! here — the grants below are the fixed, first-party set the Gateway is asked to
//! honour, and every *call-time* capability check still goes through the Gateway.

use crate::plugin_manifest::PluginManifest;
use crate::plugins::{
    builtins::{CHAT_BROADCAST_PLUGIN_ID, CORE_PREINSTALLED},
    graph, PluginStore,
};

/// One pre-installed plugin and everything the seed must write for it.
#[derive(Debug, Clone, Copy)]
pub struct SeedSpec {
    /// Manifest id.
    pub id: &'static str,
    /// Grants to persist as approved. The Gateway is not reachable at seed time,
    /// so these are the fixed first-party set (empty for most Core plugins; the
    /// companions need theirs to drive Spaces/media/finetune from their frames).
    pub grants: &'static [&'static str],
    /// Prebuilt companion UI bundle, when the plugin ships one.
    ///
    /// Pre-installed records receive the bundle during the normal seed. An explicit
    /// install receives it from [`crate::plugins::lifecycle::install_app`], so an
    /// opt-in plugin does not need a lifecycle row before the user installs it.
    pub ui_code: Option<&'static str>,
}

/// Plugins that need more than `insert + set_enabled(&[])`: explicit grants and/or
/// a prebuilt `ui_code` bundle. Everything else in [`CORE_PREINSTALLED`] seeds with
/// empty grants and no UI code (unchanged from the pre-graph behaviour).
///
/// The companions need a UI bundle + the grants their sandboxed frames use.
/// A row that ships no frame (`ui_code: None`, e.g. `recipes`) is here purely for
/// its grants: it really does drive the host over a kernel capability, so its
/// approved grants must match the `permission_grants` its manifest declares —
/// otherwise the record would claim less than the app does.
///
/// # This table is the ONE list of compiled-in companion bundles
///
/// Most rows are pre-installed (`preinstalled_specs` looks them up by
/// [`CORE_PREINSTALLED`] id), but membership here is deliberately NOT limited to the
/// pre-installed set: the explicit install path derives opt-in companion bundles from
/// this same table. Adding a 16th companion to a second list is what caused the
/// original carriage bug; there is no second list.
fn seed_overrides() -> [SeedSpec; 38] {
    use crate::plugin_manifest::{
        ACTIVITY_UI_HTML, APPROVALS_UI_HTML, AUTOPILOT_UI_HTML, BLUEPRINT_UI_HTML,
        CALENDAR_UI_HTML, CANVAS_PLUGIN_ID, CANVAS_UI_HTML, CHAT_BROADCAST_UI_HTML, CLIPS_UI_HTML,
        DRAWSOME_PLUGIN_ID, DRAWSOME_UI_HTML, EXPENSES_UI_HTML, FINETUNE_PLUGIN_ID,
        FINETUNE_UI_HTML, HELP_CENTER_UI_HTML, INVOICES_UI_HTML, LEARNING_UI_HTML, MAIL_UI_HTML,
        MEETINGS_UI_HTML, MONITORS_UI_HTML, NEWS_UI_HTML, OUTREACH_UI_HTML, PEOPLE_UI_HTML,
        PROJECTS_UI_HTML, PULL_REQUESTS_UI_HTML, QUESTS_UI_HTML, REASONING_PLUGIN_ID,
        REASONING_UI_HTML, RLM_UI_HTML, SITES_UI_HTML, SKILL_EDITOR_UI_HTML, SLIDES_PLUGIN_ID,
        SLIDES_UI_HTML, SOCIAL_UI_HTML, SUBTITLES_UI_HTML, TIMELINE_UI_HTML, TUITION_UI_HTML,
        WARMUP_UI_HTML, WEBHOOKS_UI_HTML, WHITEBOARD_PLUGIN_ID, WHITEBOARD_UI_HTML,
        WORKFLOWS_UI_HTML,
    };
    [
        SeedSpec {
            id: WHITEBOARD_PLUGIN_ID,
            // Its sandboxed frame owns Space documents + AI-generates.
            grants: &[
                "spaces:docs",
                "hook:side-model",
                "core:list_agents",
                "app:realtime",
                "ui:declarative-http",
                "ui:toast",
            ],
            ui_code: Some(WHITEBOARD_UI_HTML),
        },
        SeedSpec {
            id: CANVAS_PLUGIN_ID,
            // Space documents + catalog listing + the media/agent bridge.
            grants: &[
                "spaces:docs",
                "core:list_agents",
                "media:generate",
                "media:transcribe",
                "hook:run-agent",
                "hook:side-model",
                "app:realtime",
                "ui:declarative-http",
            ],
            ui_code: Some(CANVAS_UI_HTML),
        },
        SeedSpec {
            id: DRAWSOME_PLUGIN_ID,
            // Drawesome's Companion persists only its own title + stroke data through
            // the generic app-scoped KV bridge; it has no provider or sidecar access.
            grants: &["storage:kv", "ui:toast"],
            ui_code: Some(DRAWSOME_UI_HTML),
        },
        SeedSpec {
            id: SLIDES_PLUGIN_ID,
            // The editor persists its own gallery and uses the generic Ryu model,
            // media, and upload bridges. It is opt-in, so this row supplies the
            // verified bundle and grants when the user explicitly installs it.
            grants: &["storage:kv", "media:generate", "hook:side-model"],
            ui_code: Some(SLIDES_UI_HTML),
        },
        SeedSpec {
            id: FINETUNE_PLUGIN_ID,
            // Core's fine-tune orchestration. Its Unsloth training sidecar spawns on the
            // Core-tier auto-run path (`may_run_sidecar` is unconditional for Core), so it
            // must NOT declare `sidecar:process` — the Gateway validates + denies that
            // grant at enable (same fix as mail, commit 9faf67be). Grants mirror the
            // manifest's `permission_grants` exactly.
            grants: &["finetune:runs"],
            ui_code: Some(FINETUNE_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::MEETINGS_PLUGIN_ID,
            // It saves finalized notes into the "Meetings" Space (`spaces:docs`). Its
            // sandboxed frame ALSO drives Core's `/api/meetings/*` orchestration (list/
            // transcript + start/finalize/delete/rename + audio import) via the
            // `meetings:crud` bridge capability (host-direct, monitors pattern). `com.ryu
            // .meetings` was a wave-2 route-gate governance shell (gating `/api/meetings/*`)
            // that `requires` the `spaces` app; the W7 frontend extraction upgrades it in
            // place to ALSO carry the companion runnable + ship a prebuilt UI bundle.
            // Core-tier, so it must NOT declare `sidecar:process` (the Gateway denies that
            // grant at enable).
            grants: &[
                "spaces:docs",
                "meetings:crud",
                "ui:toast",
                "ui:declarative-http",
            ],
            ui_code: Some(MEETINGS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::SOCIAL_PLUGIN_ID,
            // Outpost's sandboxed frame drives its own `ryu-social` sidecar through the
            // `social:crud` bridge forwarder (`social.request` → the host re-issues onto
            // Core's `/api/social` public mount, host-direct, the monitors pattern). The
            // frame has NO network of its own — its CSP is `connect-src 'none'` and the
            // manifest declares no `csp` widening — so without this grant the app mounts,
            // renders, and every single fetch rejects.
            //
            // `hook:side-model` is the AI copy assist (`model.complete`) and
            // `shell:integrate` is what `shell.openTab` + `shell.themeSubscribe` need:
            // the companion re-themes live on a light/dark toggle and opens a chat tab
            // from a post. Both degrade to a silent no-op rather than throwing, so an
            // install missing either still schedules posts — but a seeded row missing
            // `shell:integrate` is a companion that never re-themes without a remount,
            // which reads as a rendering bug rather than a missing grant.
            //
            // Core-tier, so it must NOT declare `sidecar:process` (the Gateway validates
            // and denies that grant at enable — same fix as mail/finetune). The sidecar
            // spawns on the Core auto-run path instead.
            grants: &[
                "social:crud",
                "tools.invoke",
                "hook:side-model",
                "shell:integrate",
                "core:list_agents",
                "ui:declarative-http",
                "ui:toast",
            ],
            ui_code: Some(SOCIAL_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::SUBTITLES_PLUGIN_ID,
            // Subtitles' sandboxed frame drives its own `ryu-subtitles` sidecar through
            // the `subtitles:crud` bridge forwarder (`subtitles.request` → the host
            // re-issues onto Core's `/api/subtitles` public mount, host-direct, the
            // monitors pattern). The frame has NO network of its own — its CSP is
            // `connect-src 'none'` and the manifest declares no `csp` widening — so
            // without this grant the app mounts, renders an empty picker, and every
            // fetch rejects.
            //
            // ONE grant, and that is the whole list: the app needs no side model (its
            // translation call is the SIDECAR's, made from a process that holds the
            // gateway token itself) and no shell integration (it opens no chat tab).
            // A grant it does not use is a grant a compromised frame could.
            //
            // The `grants` here must stay SET-EQUAL to the manifest's top-level
            // `permission_grants`, which is asserted. Core-tier, so it must NOT declare
            // `sidecar:process` — the Gateway validates and denies that grant at enable;
            // the sidecar spawns on the Core auto-run path instead.
            grants: &["subtitles:crud", "ui:toast", "ui:declarative-http"],
            ui_code: Some(SUBTITLES_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::MONITORS_PLUGIN_ID,
            // Its sandboxed frame drives Core's `/api/monitors/*` orchestration via
            // the `monitors:crud` bridge capability. Ships a prebuilt companion UI.
            // `tools.invoke` is what its OUT-OF-PROCESS sidecar needs: the Spider fetch
            // backend reaches Core's `McpRegistry` through the `mcp.callTool` kernel
            // capability, which is gated on the declared∩approved intersection — so a
            // seeded record missing this grant would 403 every crawl.
            grants: &["monitors:crud", "tools.invoke", "ui:declarative-http"],
            ui_code: Some(MONITORS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::WORKFLOWS_PLUGIN_ID,
            // Its sandboxed frame drives Core's DAG workflow engine (CRUD + versions +
            // run/run-state/resume), the workflow-template catalog, node-config catalog
            // reads (agents/apps/mcp/skills/recipes/schedules/composio), and ghost
            // record→replay — via the workflows:crud/runstate/catalogs + ghost:record
            // bridge capabilities. Ships a prebuilt companion UI. Like the other
            // Core-tier companions it must NOT declare `sidecar:process` (the Gateway
            // denies that grant at enable; Core auto-runs any sidecar).
            grants: &[
                "workflows:crud",
                "workflows:runstate",
                "workflows:catalogs",
                "ghost:record",
                "core:list_agents",
                "app:realtime",
                "ui:toast",
                "ui:declarative-http",
            ],
            ui_code: Some(WORKFLOWS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::WEBHOOKS_PLUGIN_ID,
            // Its sandboxed frame renders Core's read-only webhook endpoint registry
            // (`/api/webhooks` + `/api/webhook-ingress/status`) via the `webhooks:crud`
            // bridge capability (host-direct, monitors pattern). Ships a prebuilt
            // companion UI. Core-tier, so it must NOT declare `sidecar:process`.
            grants: &["webhooks:crud", "ui:toast"],
            ui_code: Some(WEBHOOKS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::QUESTS_PLUGIN_ID,
            // Its sandboxed frame drives Core's `/api/quests/*` auto-detecting-todo
            // orchestration (list/create/update/delete + complete/dismiss + suggestion
            // accept/dismiss + judge) via the `quests:crud` bridge capability (host-direct,
            // monitors pattern). Ships a prebuilt companion UI. Core-tier, so it must NOT
            // declare `sidecar:process` (the Gateway denies that grant at enable).
            //
            // It ALSO holds `quests:capture` — the separate, narrower grant behind the
            // `quests.capture` verb. Split from `quests:crud` because keeping text the
            // user selected in ANOTHER app is a different reach than editing the board;
            // `@ryu/approvals` holds `quests:crud` for the inbox's task check-off and
            // deliberately does NOT hold this one.
            grants: &[
                "quests:crud",
                "quests:capture",
                "ui:toast",
                "ui:declarative-http",
            ],
            ui_code: Some(QUESTS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::ACTIVITY_PLUGIN_ID,
            // Its sandboxed frame renders Core's read-only unified activity feed
            // (`GET /api/activity`) via the `activity:read` bridge capability (host-direct,
            // monitors pattern). It ALSO holds `shell:integrate` — the generic shell-primitive
            // lane (`docs/renderer-host-slice-1.md`): the feed's clickable rows open the chat
            // tab through the route-allowlisted `shell.openTab` (replacing the old bespoke
            // `activity.openSession` verb). Ships a prebuilt companion UI. Core-tier, so it
            // must NOT declare `sidecar:process` (the Gateway denies that grant at enable).
            grants: &["activity:read", "shell:integrate"],
            ui_code: Some(ACTIVITY_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::CALENDAR_PLUGIN_ID,
            // Its sandboxed frame renders the scheduled-runs calendar (agent/workflow
            // jobs projected onto Month/Week/Day/Agenda) and schedules an agent, via the
            // `calendar:crud` bridge capability (host-direct, monitors pattern): the host
            // calls the existing `/heartbeat/jobs` + `/workflows` + `/api/agents` reads +
            // the `createScheduledAgentWorkflow` composite. Ships a prebuilt companion UI.
            // Core-tier, so it must NOT declare `sidecar:process` (the Gateway denies that
            // grant at enable).
            grants: &["calendar:crud", "core:list_agents"],
            ui_code: Some(CALENDAR_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::HELP_CENTER_PLUGIN_ID,
            grants: &["spaces:docs", "storage:kv", "hook:side-model"],
            ui_code: Some(HELP_CENTER_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::SITES_PLUGIN_ID,
            // The first slice is a truthful local companion. Public-edge route
            // admission and managed hosting remain control-plane owned; there
            // is no app-specific network grant to approve here.
            grants: &[],
            ui_code: Some(SITES_UI_HTML),
        },
        SeedSpec {
            id: CHAT_BROADCAST_PLUGIN_ID,
            // The companion can list only caller-visible conversations and send
            // only after the user confirms. Core performs the ACL check again for
            // every destination while the trusted host owns the transcript.
            grants: &["chat.sendFollowUp"],
            ui_code: Some(CHAT_BROADCAST_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::LEARNING_PLUGIN_ID,
            // Its sandboxed frame renders the read-only continual-learning surface
            // (the two opt-in levels + models, the experience buffer, and the read-only
            // self-healing attempt history) via the `learning:crud` bridge capability
            // (host-direct, monitors pattern): the host calls the existing
            // `/api/learn/config` + `/api/experience/list` + `/api/healing/status`
            // reads. Ships a prebuilt companion UI. `@ryu/learning` was a wave-2
            // route-gate governance shell (gating `/api/learn/*` + `/api/experience/*`)
            // that `requires` the `skills` app; the W7 frontend extraction upgrades it
            // in place to ALSO carry the companion runnable — the `requires` edge stays
            // (skills is pre-installed, so `seed_order` seeds it first). Core-tier, so it
            // must NOT declare `sidecar:process` (the Gateway denies that grant at
            // enable).
            grants: &["learning:crud"],
            ui_code: Some(LEARNING_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/chat-title",
            // A grants-only spec (no companion UI). It is here because its
            // context-menu row ("Rename with AI") dispatches through the HTTP host
            // relay, and THAT path authorises against the stored
            // `approved_grants` — not, as the sandbox hook path does, against the
            // manifest's declared `permission_grants`. Without a spec the seed
            // enables this plugin with `grants: &[]`, so its hook kept working
            // while the menu row would have 403'd on every existing profile. The
            // set mirrors the manifest exactly; `backfill_declared_grants` is what
            // carries it onto records that predate the row.
            grants: &[
                "hook:side-model",
                "conversation:set-title",
                "preferences:read",
                "hook:run-self",
            ],
            ui_code: None,
        },
        SeedSpec {
            id: crate::plugins::builtins::APPROVALS_PLUGIN_ID,
            // Its sandboxed frame renders the unified Inbox — pending HITL approvals
            // (approve/reject), the per-user notification feed (read + the workflow-resume
            // ack gate), the quest task check-offs, and Shadow's proactive suggestions —
            // via the `approvals:crud` bridge capability (host-direct, monitors pattern):
            // the host calls the existing `/api/approvals/*`, `/api/notifications/*`
            // (host-resolved user id), and Shadow's `/proactive` + `/api/feedback`. The
            // quest section reuses the `quests:crud` verbs, so the app declares BOTH
            // grants. Ships a prebuilt companion UI. `@ryu/approvals` was a wave-2
            // gate-only governance shell (gating `/api/approvals/*`); the W7 frontend
            // extraction upgrades it in place to ALSO carry the companion runnable.
            // It ALSO holds `shell:integrate` — the generic shell-primitive lane
            // (`docs/renderer-host-slice-1.md`): the "open in chat" action opens a new
            // chat tab through the route-allowlisted `shell.openTab` (replacing the old
            // bespoke `suggestions.openInChat` verb), and the frame subscribes to the
            // live host theme. Core-tier, so it must NOT declare `sidecar:process` (the
            // Gateway denies that grant at enable).
            grants: &[
                "approvals:crud",
                "notifications:send-to-user",
                "quests:crud",
                "shell:integrate",
                "ui:toast",
            ],
            ui_code: Some(APPROVALS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::TIMELINE_PLUGIN_ID,
            // Its sandboxed frame renders the CapCut-style activity replay scrubber
            // (Shadow's captured lanes + keyframe preview + Dayflow work journal) via
            // the `timeline:read` bridge capability. Host-direct (the monitors pattern),
            // but device-LOCAL: the host calls Shadow (:3030) WITHOUT a node token (the
            // `shadow.ts` INVARIANT — captured screen/input is machine-pinned), the same
            // host-direct-to-Shadow shape the approvals inbox uses for `/proactive`.
            // It ALSO holds `shell:integrate` — the generic shell-primitive lane
            // (docs/renderer-host-slice-1.md) its Weekly-Review + Settings opens now
            // route through (`shell.openTab`, replacing the bespoke
            // `timeline.openReview`/`timeline.openSettings` verbs). Ships a prebuilt
            // companion UI. Core-tier, so it must NOT declare `sidecar:process` (the
            // Gateway denies that grant at enable).
            grants: &["timeline:read", "shell:integrate"],
            ui_code: Some(TIMELINE_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::SKILL_EDITOR_PLUGIN_ID,
            // Its sandboxed frame authors a user-owned Agent Skill (`SKILL.md`) — the
            // front-matter form fields + a markdown body + server-backed version history —
            // via the `skills:crud` bridge capability (host-direct, monitors pattern): the
            // host calls the existing `/api/skills` authoring endpoints (the desktop
            // `skills.ts` client). It ALSO holds `shell:integrate` — the generic
            // shell-primitive lane (`docs/renderer-host-slice-1.md`): the decoupled frame
            // subscribes to the live host theme (`shell.subscribeTheme`), so it re-themes
            // on a light/dark toggle instead of holding a mount-time snapshot. It has no
            // navigation verb to move onto `shell.openTab` (its `setTitle` renames the
            // current owning tab, which no slice-1 primitive covers, so that stays on the
            // `skills:crud` bridge). Ships a prebuilt companion UI. Core-tier, so it must
            // NOT declare `sidecar:process` (the Gateway denies that grant at enable).
            grants: &["skills:crud", "shell:integrate", "ui:toast"],
            ui_code: Some(SKILL_EDITOR_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::TUITION_PLUGIN_ID,
            // Its sandboxed frame runs the study session, the skills graph and the
            // review queue, driving the `ryu-tuition` sidecar through ONE generic
            // `tuition.request` forwarder — so twenty-four sidecar routes cost one
            // bridge verb and a route added later costs none. Ships a prebuilt
            // companion UI. Core-tier, so it must NOT declare `sidecar:process` (the
            // Gateway denies that grant at enable); the sidecar is spawned by the
            // manifest loader.
            //
            // `hook:side-model` is what lets the SIDECAR call back for a completion —
            // item generation and rubric marking, the app's only two model edges — and
            // must be approved here as well as in `host_api.grants` or both 403 at
            // runtime. `storage:kv` is the Study-mode handoff: the turn hook has no
            // HTTP and cannot reach the sidecar, so it queues candidates in Core's KV
            // and the sidecar drains them. `mcp:tuition` registers the app's own MCP
            // server so `tuition.quiz` and friends exist for agents and workflows.
            grants: &[
                "tuition:crud",
                "hook:side-model",
                "storage:kv",
                "mcp:tuition",
                "ui:declarative-http",
            ],
            ui_code: Some(TUITION_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::NEWS_PLUGIN_ID,
            // Same shape as Tuition above, with the KV handoff running the other way:
            // the sidecar publishes a ranked headline snapshot and the `pre_user_turn`
            // hook reads it, so "ground this message in the news" costs no HTTP from a
            // sandbox that has none. `hook:side-model` covers the brief prose and the
            // neutral cluster titles — the only two places a model touches this app.
            grants: &[
                "news:crud",
                "hook:side-model",
                "storage:kv",
                "mcp:news",
                "ui:declarative-http",
            ],
            ui_code: Some(NEWS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::EXPENSES_PLUGIN_ID,
            // The companion is a visual ledger over the same sidecar that exposes
            // `expenses.*` MCP tools to agents and workflows. It uses only the
            // generic own-app HTTP bridge; Core does not carry expense routes.
            grants: &["app:http", "mcp:expenses"],
            ui_code: Some(EXPENSES_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::OUTREACH_PLUGIN_ID,
            // Outreach is a pure Companion composition layer. It uses the host's
            // durable app storage, shared model lane, existing Mail transport,
            // secret-free runtime catalog, live theme, and toast primitives — no
            // second CRM, SMTP service, scheduler, or provider client.
            grants: &[
                "storage:kv",
                "hook:side-model",
                "mail:crud",
                "core:list_agents",
                "shell:integrate",
                "ui:toast",
            ],
            ui_code: Some(OUTREACH_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::AUTOPILOT_PLUGIN_ID,
            // Autopilot is a pure Companion orchestration layer. The selected
            // Ryu agent performs the tool loop, while the frame owns only its
            // durable brief/cycle ledger and reads the secret-free catalog.
            grants: &[
                "hook:run-agent",
                "storage:kv",
                "core:list_agents",
                "shell:integrate",
                "ui:toast",
            ],
            ui_code: Some(AUTOPILOT_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::PROJECTS_PLUGIN_ID,
            grants: &["storage:kv", "shell:integrate", "ui:toast"],
            ui_code: Some(PROJECTS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::INVOICES_PLUGIN_ID,
            grants: &["storage:kv", "shell:integrate", "ui:toast"],
            ui_code: Some(INVOICES_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::PEOPLE_PLUGIN_ID,
            grants: &["storage:kv", "shell:integrate", "ui:toast"],
            ui_code: Some(PEOPLE_UI_HTML),
        },
        SeedSpec {
            id: REASONING_PLUGIN_ID,
            // Its sandboxed frame authors formal policies and runs the solver
            // playground, driving the `ryu-reasoning` sidecar through ONE generic
            // `reasoning.request` forwarder (the Outpost shape) — so the seven sidecar
            // routes cost one bridge verb and a route added later costs none. Ships a
            // prebuilt companion UI. Core-tier, so it must NOT declare `sidecar:process`
            // (the Gateway denies that grant at enable); the sidecar is spawned by the
            // manifest loader, not by a grant.
            //
            // The other three are not the frame's: `hook:side-model` is what lets the
            // SIDECAR call back for a completion (declared ∩ approved, so it must be
            // approved here as well as in `host_api.grants` or every draft/check 403s),
            // `hook:run-agent` is the turn hook's only route to the solver (the plugin
            // sandbox has no HTTP), and `mcp:reasoning` registers the app's own MCP
            // server so `reasoning.solve` exists for agents and workflow `mcp` nodes.
            grants: &[
                "reasoning:check",
                "hook:side-model",
                "hook:run-agent",
                "mcp:reasoning",
                "ui:declarative-http",
            ],
            ui_code: Some(REASONING_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::CLIPS_PLUGIN_ID,
            // Clips is opt-in because its sidecar can capture the user's screen. The
            // generic app:http bridge is the only host capability the Companion needs;
            // capture/ingest authorization remains in the app's permission levels.
            grants: &["app:http"],
            ui_code: Some(CLIPS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::RLM_PLUGIN_ID,
            // Its sandboxed frame loads a corpus, browses the outline, asks questions
            // and reads run traces, driving the `ryu-rlm` sidecar through ONE generic
            // `rlm.request` forwarder (the Outpost shape) — so the ten sidecar routes
            // cost one bridge verb and a route added later costs none. Ships a prebuilt
            // companion UI. Core-tier, so it must NOT declare `sidecar:process` (the
            // Gateway denies that grant at enable); the sidecar is spawned by the
            // manifest loader, not by a grant.
            //
            // The other three are not the frame's: `hook:side-model` is what lets the
            // SIDECAR call back for a completion (declared ∩ approved, so it must be
            // approved here as well as in `host_api.grants` or every query 403s and the
            // app can read nothing at all), `hook:run-agent` is the turn hook's only
            // route to the engine (the plugin sandbox has no HTTP), and `mcp:rlm`
            // registers the app's own MCP server so `rlm.ask` exists for agents and
            // workflow `mcp` nodes — which is this app's main surface, not a side one.
            grants: &[
                "rlm:query",
                "hook:side-model",
                "hook:run-agent",
                "mcp:rlm",
                "ui:declarative-http",
            ],
            ui_code: Some(RLM_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::BLUEPRINT_PLUGIN_ID,
            // Its sandboxed frame renders a published plan — markdown blocks, the
            // `@xyflow/react` dependency graph derived from `steps[].depends_on`, the
            // annotation rail — and drives the `ryu-blueprint` sidecar through ONE
            // generic `blueprint.request` forwarder (the Outpost/Reasoning shape), so
            // the eleven sidecar routes cost one bridge verb and a route added later
            // costs none. Ships a prebuilt companion UI. Core-tier, so it must NOT
            // declare `sidecar:process` (the Gateway denies that grant at enable); the
            // sidecar is spawned by the manifest loader, not by a grant.
            //
            // Only two grants, and the short list is the point. `mcp:blueprint`
            // registers the app's own MCP server so `blueprint.plan_publish` /
            // `plan_status` / `plan_get` / `step_update` exist for agents and workflow
            // `mcp` nodes — the ONLY way a plan ever gets published, since the app
            // ships no turn hooks (the plugin sandbox has no HTTP, so a hook could not
            // reach the sidecar that owns the plans). No `hook:side-model`: nothing
            // here asks a model anything — block and step extraction is deterministic
            // markdown parsing in Rust, which is also why the ids are stable across
            // revisions and why annotations can anchor to them at all.
            //
            // Inert today for the same reason mail's and warmup's rows below are:
            // Blueprint is outside `CORE_PREINSTALLED`, so `preinstalled_specs` never looks
            // it up and the opt-in pass writes only `ui_code`, leaving `enable_app` to
            // persist the Gateway-approved set. Recorded anyway, and set-equal to the
            // manifest's `permission_grants`, so a promotion is correct by construction.
            grants: &["blueprint:review", "mcp:blueprint", "ui:declarative-http"],
            ui_code: Some(BLUEPRINT_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/pull-requests",
            // Opt-in. `app:http` unlocks only the generic own-sidecar forwarder;
            // `shell:integrate` supplies live theme updates. The enable path persists
            // the Gateway-approved set, while this row carries the compiled UI.
            grants: &["app:http", "shell:integrate"],
            ui_code: Some(PULL_REQUESTS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::RECIPES_PLUGIN_ID,
            // Recipes ships NO frame (no `ui_code`) — it is here purely for the grant.
            // Its out-of-process sidecar proxies replay + the recording session back to
            // Core over the `ghost.{replay,recordStart,recordStatus,recordStop}` kernel
            // capabilities, which are gated on `ghost:record` (declared ∩ approved).
            //
            // This row is now INERT, the same way mail's below is: recipes left
            // `CORE_PREINSTALLED` (see the block there), so `preinstalled_specs` never
            // looks it up and its Enable routes through `enable_app`, which persists
            // the Gateway-approved set instead. Kept, not deleted, for the reason
            // stated on mail — it mirrors the manifest's `permission_grants` exactly,
            // so it is the correct value the instant recipes is ever pre-installed again,
            // and deleting it would silently reintroduce the 403-on-every-replay bug
            // it was added to fix.
            grants: &["ghost:record"],
            ui_code: None,
        },
        SeedSpec {
            id: crate::plugins::builtins::MAIL_PLUGIN_ID,
            // Mail is OPT-IN by product choice (an unconfigured inbox should not
            // surface on a fresh install — see `CORE_PREINSTALLED`), so this row's
            // `grants` are inert today: `preinstalled_specs` never looks it up (mail is
            // not in `CORE_PREINSTALLED`) and the opt-in pass writes only `ui_code`,
            // leaving `enable_app` to persist the Gateway-approved set. They are
            // recorded anyway, and mirror the manifest's `permission_grants` exactly,
            // so a future promotion into the pre-installed set is correct by
            // construction rather than by remembering to fill this in.
            grants: &["mail:crud", "ui:toast"],
            ui_code: Some(MAIL_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::WARMUP_PLUGIN_ID,
            // Warmup is OPT-IN by product choice: it spends the user's subscription
            // usage on their behalf, on a schedule, which is not a thing to switch on
            // for someone. Like mail's row above, `grants` is inert while the app is
            // outside `CORE_PREINSTALLED` (the opt-in pass writes only `ui_code`), but
            // mirrors the manifest's `permission_grants` so a promotion would be
            // correct by construction.
            grants: &["warmup:crud", "core:list_agents"],
            ui_code: Some(WARMUP_UI_HTML),
        },
    ]
}

/// The full pre-installed seed table, in declaration order.
///
/// One list, derived from [`CORE_PREINSTALLED`] — the overridden plugins are the same
/// ids with richer specs, so a plugin can never be pre-installed in one list and absent
/// from the other.
pub fn preinstalled_specs() -> Vec<SeedSpec> {
    let overrides = seed_overrides();
    CORE_PREINSTALLED
        .iter()
        .map(|id| {
            overrides
                .iter()
                .find(|o| o.id == *id)
                .copied()
                .unwrap_or(SeedSpec {
                    id,
                    grants: &[],
                    ui_code: None,
                })
        })
        .collect()
}

/// A pre-installed plugin that could not be seeded, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSeed {
    pub id: String,
    pub error: graph::DependencyError,
}

/// Order the pre-installed set so every dependency precedes its dependents, and
/// separate out the plugins whose `requires` cannot be satisfied.
///
/// Pure: no store, no I/O. `manifests` is the loaded manifest set; specs with no
/// loaded manifest are dropped (nothing to seed), exactly as before.
///
/// Returns `(ordered_ids, skipped)`. `ordered_ids` is a valid topological order of
/// the seedable pre-installed plugins; `skipped` names the ones whose dependency graph
/// is unsatisfiable *within the pre-installed set* — they are NOT enabled (fail-closed).
pub fn seed_order(
    specs: &[SeedSpec],
    manifests: &[PluginManifest],
) -> (Vec<String>, Vec<SkippedSeed>) {
    // Lower capability edges (`requires.capabilities`) to concrete app-id edges
    // FIRST, resolving providers against the FULL installed set, so a `requires:[rag]`
    // consumer's provider is materialized as an ordinary dependency the graph honors.
    // The universe for resolution stays the pre-installed set (see module docs) — so a
    // pre-installed consumer whose capability provider is NOT pre-installed becomes an edge
    // to a plugin absent from the universe, which `resolve_enable_order` reports as a
    // MissingDependency and the loop below SKIPS (fail-closed) — matching the posture
    // for an un-installed app dependency, and preserving the enabled-set binding
    // invariant at seed time.
    let binding_cfg = crate::plugins::binding::active_config();
    let lowered = crate::plugins::binding::lower_manifests(manifests, &binding_cfg);
    let universe: Vec<PluginManifest> = specs
        .iter()
        .filter_map(|s| lowered.iter().find(|m| m.id == s.id))
        .cloned()
        .collect();

    let mut ordered: Vec<String> = Vec::new();
    let mut skipped: Vec<SkippedSeed> = Vec::new();

    for spec in specs {
        // No loaded manifest ⇒ nothing to seed (unchanged: the old code looked up
        // the version and silently did nothing when absent).
        if !universe.iter().any(|m| m.id == spec.id) {
            continue;
        }
        match graph::resolve_enable_order(spec.id, &universe) {
            // deps-first, target-last. Appending in that order keeps `ordered`
            // topologically valid; a plugin already placed by an earlier spec's
            // closure is not re-added.
            Ok(order) => {
                for id in order {
                    if !ordered.contains(&id) {
                        ordered.push(id);
                    }
                }
            }
            Err(error) => skipped.push(SkippedSeed {
                id: spec.id.to_owned(),
                error,
            }),
        }
    }

    (ordered, skipped)
}

/// Seed the pre-installed plugins on a fresh install: install + enable each, in
/// dependency order.
///
/// One-time and user-respecting: a plugin with ANY existing record (enabled OR
/// disabled) is left alone, so a user who disables a pre-installed plugin keeps it
/// disabled across restarts.
///
/// Then backfills the compiled-in companion bundle on any existing record that is
/// missing it. Opt-in companions with no record remain absent until an explicit
/// install.
pub async fn seed_preinstalled(store: &PluginStore, manifests: &[PluginManifest]) {
    seed_preinstalled_with_materialized(store, manifests, &std::collections::HashSet::new()).await;
}

/// Seed pre-installed plugins, treating the ids in `newly_materialized` as a first
/// install even when the catalog materializer has already created their lifecycle
/// rows. Existing rows are still authoritative unless the row was created by this
/// startup's materialization pass.
pub async fn seed_preinstalled_with_materialized(
    store: &PluginStore,
    manifests: &[PluginManifest],
    newly_materialized: &std::collections::HashSet<String>,
) {
    let specs = preinstalled_specs();
    let (ordered, skipped) = seed_order(&specs, manifests);

    for s in &skipped {
        tracing::error!(
            "pre-installed seed: SKIPPING '{}' — its dependencies cannot be satisfied from the \
             pre-installed set: {}. It stays disabled (fail-closed); enabling it by hand will \
             report the same error until the dependency is installed.",
            s.id,
            s.error
        );
    }

    for id in &ordered {
        let Some(spec) = specs.iter().find(|s| s.id == id) else {
            continue;
        };

        match store.get(id).await {
            // A record exists (enabled or disabled) — the user's choice wins,
            // except for a row created by this boot's first materialization.
            Ok(Some(record)) => {
                if !newly_materialized.contains(id) || record.enabled {
                    continue;
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("pre-installed seed: lookup '{id}' failed: {e}");
                continue;
            }
        }

        let Some(version) = manifests
            .iter()
            .find(|m| m.id == *id)
            .map(|m| m.version.clone())
        else {
            continue;
        };

        if store.get_record(id).await.ok().flatten().is_none() {
            if let Err(e) = store.insert(id, &version).await {
                tracing::warn!("pre-installed seed: insert '{id}' failed: {e}");
                continue;
            }
        }
        if let Some(ui_code) = spec.ui_code {
            if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                tracing::warn!("pre-installed seed: set_ui_code '{id}' failed: {e}");
                continue;
            }
        }
        let grants: Vec<String> = spec.grants.iter().map(|g| (*g).to_owned()).collect();
        if let Err(e) = store.set_enabled(id, &grants).await {
            tracing::warn!("pre-installed seed: enable '{id}' failed: {e}");
        } else {
            tracing::info!("pre-installed seed: enabled '{id}'");
        }
    }

    backfill_companion_ui(store).await;
    backfill_declared_grants(store).await;
}

/// Union any newly-declared seed grant into an EXISTING record.
///
/// # The upgrade gap this closes
///
/// Seeding is one-time: a user who already enabled a built-in keeps the record they
/// have, grants and all. That is the right rule for *user* state — but a grant the
/// BUILD declares is not user state. When a release splits a verb out behind a new,
/// narrower grant (`quests.capture` leaving `quests:crud`), every existing install
/// would keep only the old grant and the new verb would be denied for them and only
/// them: working on a fresh install, broken on an upgrade, which is the worst shape
/// a permission bug can take.
///
/// Strictly additive, and deliberately so:
///
/// - it only ever ADDS grants the built-in's own `SeedSpec` declares (which the
///   Gateway's reviewed allowlist already blesses), so it cannot widen anything the
///   build did not already ship;
/// - it never removes a grant, so a user's own additions survive;
/// - it never touches the `enabled` bit, so it cannot resurrect a disabled app;
/// - it skips DISABLED records entirely. `set_disabled` wipes `approved_grants` to
///   `[]` — disabling is a consent revocation, not a pause — so re-granting a
///   disabled app here would quietly undo that. Its grants come back when the user
///   enables it again, from the seed spec, which is where they belong.
///
/// A record that does not exist is skipped — installing is the seed's job, not this.
async fn backfill_declared_grants(store: &PluginStore) {
    for spec in seed_overrides() {
        if spec.grants.is_empty() {
            continue;
        }
        let Ok(Some(record)) = store.get(spec.id).await else {
            continue;
        };
        if !record.enabled {
            continue;
        }
        let missing: Vec<String> = spec
            .grants
            .iter()
            .filter(|g| !record.approved_grants.iter().any(|have| have == *g))
            .map(|g| (*g).to_owned())
            .collect();
        if missing.is_empty() {
            continue;
        }
        match store.add_approved_grants(spec.id, &missing).await {
            Ok(_) => tracing::info!(
                "grant backfill: added {missing:?} to '{}' (the build declares them; the                  record predates the declaration)",
                spec.id
            ),
            Err(e) => tracing::warn!("grant backfill: '{}' failed: {e}", spec.id),
        }
    }
}

/// Every built-in companion that ships a compiled-in `ui_code` bundle, derived from
/// [`seed_overrides`] — the ONE table — so a newly added companion cannot be
/// forgotten here. The explicit install path uses this list to carry the bundle.
///
/// `pub(crate)` for one more reader: `plugin_manifest`'s
/// `companion_ui_fixtures_exist_and_are_nontrivial` size guard drives its loop off
/// this list instead of a hand-copied one, which is how `SKILL_EDITOR_UI_HTML` had
/// gone unguarded — the const existed, the table carried it, the guard's 14-row copy
/// did not.
pub(crate) fn companion_ui_specs() -> Vec<SeedSpec> {
    seed_overrides()
        .into_iter()
        .filter(|s| s.ui_code.is_some())
        .collect()
}

/// The compiled-in companion bundle for a built-in id, or `None` if it ships none.
///
/// The lookup decouples "a built-in's bundle exists" from "the pre-installed seed wrote
/// a record for it". [`crate::plugins::lifecycle::install_app`] reads it too, so the
/// Store's own Install carries the bundle for opt-in companions.
pub(crate) fn compiled_in_ui_code(id: &str) -> Option<&'static str> {
    companion_ui_specs()
        .into_iter()
        .find(|s| s.id == id)
        .and_then(|s| s.ui_code)
}

/// Historical ids that could have a disabled lifecycle row created by the old
/// companion-bundle seed. This is migration-only: it is not a live product state
/// or a second install category. New opt-in plugins are simply absent until the
/// user explicitly installs them.
const LEGACY_DISABLED_SEED_IDS: &[&str] = &[
    // Two Space-document boards. Both are pure leaf features (a Space owns the
    // documents; nothing in Core reads their records), so an install that never
    // opens one has no reason to carry them.
    crate::plugin_manifest::WHITEBOARD_PLUGIN_ID,
    crate::plugin_manifest::CANVAS_PLUGIN_ID,
    // Every remaining opt-in companion. These were already not pre-installed, so this
    // changes nothing about what RUNS on a fresh install — only about what the
    // Store claims is on the machine.
    //
    // Why they are here now: not pre-installed still left each one holding a DISABLED
    // record (written by the old companion seed purely to carry its compiled-in
    // bundle), so a brand-new machine listed eleven apps nobody had asked for
    // under *Installed*, and an uninstall was silently undone by the next boot's
    // re-seed. The reported version of that: "I did a full reset and Workflows is
    // STILL installed." It was — by design, and the design was wrong. An app the
    // user has never enabled should not appear on their machine at all.
    //
    // Safe for the same two reasons `whiteboard`/`canvas` were: `install_app`
    // sources the compiled-in bundle via `compiled_in_ui_code`, so Install →
    // Enable from the Store still mounts a real UI with no seeded record; and
    // none of these ids is in `SYSTEM_PLUGINS` or `CORE_PREINSTALLED`, so
    // `is_uninstall_protected` was already false for all of them — this is what
    // makes their uninstall STICK across a reboot.
    crate::plugin_manifest::FINETUNE_PLUGIN_ID,
    crate::plugins::builtins::MEETINGS_PLUGIN_ID,
    crate::plugins::builtins::MONITORS_PLUGIN_ID,
    crate::plugins::builtins::WORKFLOWS_PLUGIN_ID,
    crate::plugins::builtins::QUESTS_PLUGIN_ID,
    crate::plugins::builtins::ACTIVITY_PLUGIN_ID,
    crate::plugins::builtins::APPROVALS_PLUGIN_ID,
    crate::plugins::builtins::TIMELINE_PLUGIN_ID,
    crate::plugins::builtins::SKILL_EDITOR_PLUGIN_ID,
    crate::plugins::builtins::MAIL_PLUGIN_ID,
    crate::plugins::builtins::WARMUP_PLUGIN_ID,
    // Automated Reasoning. An opt-in companion that DOES carry a compiled-in bundle,
    // so `install_app` sources it via `compiled_in_ui_code` and Install → Enable from
    // the Store mounts a real UI with no seeded record. It belongs here for the
    // ordinary reason — a fresh machine should not list an app nobody asked for as
    // *Installed* — plus one of its own: the app is inert until someone writes a
    // policy, so an automatically-created record would advertise a feature that could not do
    // anything yet.
    crate::plugin_manifest::REASONING_PLUGIN_ID,
    // Deep Read. Same shape as Automated Reasoning directly above — an opt-in
    // companion that DOES carry a compiled-in bundle, so `install_app` sources it via
    // `compiled_in_ui_code` and Install → Enable from the Store mounts a real UI with
    // no seeded record. It belongs here for the ordinary reason, plus one specific to
    // it: enabling the app is what makes a process that reads files out of the user's
    // home directory available to an agent. That should be a choice someone made, not
    // a row that was already there.
    crate::plugins::builtins::RLM_PLUGIN_ID,
    // Tuition and Wire. Both carry a compiled-in companion bundle, so `install_app`
    // sources it via `compiled_in_ui_code` and Install → Enable from the Store mounts
    // a real UI with no seeded record. They belong here for the ordinary reason — a
    // fresh machine should not list an app nobody asked for as *Installed* — plus one
    // of their own: each is empty until the user adds a subject or a feed, so a
    // automatically-created record would advertise a surface with nothing behind it.
    crate::plugins::builtins::TUITION_PLUGIN_ID,
    crate::plugins::builtins::NEWS_PLUGIN_ID,
    // Outpost. Same posture as mail — an opt-in companion that DOES carry a
    // compiled-in bundle, so `install_app` sources it via `compiled_in_ui_code` and
    // Install → Enable from the Store mounts a real UI with no seeded record. It
    // belongs here for the ordinary reason (a fresh machine should not list an app
    // nobody asked for as *Installed*) and one specific to it: enabling the app is
    // what spawns `ryu-social`, and that sidecar starts a scheduler that publishes
    // automatically arriving would put
    // a publishing daemon one accidental toggle away on every fresh store.
    crate::plugins::builtins::SOCIAL_PLUGIN_ID,
    // Subtitles. Same posture as Outpost — an opt-in companion that DOES carry a
    // compiled-in bundle, so `install_app` sources it via `compiled_in_ui_code` and
    // Install → Enable from the Store mounts a real UI with no seeded record. The
    // ordinary reason applies (a fresh machine should not list an app nobody asked for
    // as *Installed*), and one specific to it: enabling the app is what spawns
    // `ryu-subtitles`, a process whose whole job is to open files off the user's disk
    // by path. That is a capability a user should switch on deliberately, not find
    // already present.
    crate::plugins::builtins::SUBTITLES_PLUGIN_ID,
    // Blueprint. Same posture as Automated Reasoning above, and for a sharper version
    // of its second reason: the app is not merely inert until someone uses it, it is
    // inert until an *agent* publishes a plan into it. Every plan arrives over
    // `blueprint.plan_publish`, so a fresh store has literally nothing to show — a
    // automatically-created record would list a plan-review surface with no plans and no way
    // for the user to make one by hand. It carries a compiled-in bundle
    // (`BLUEPRINT_UI_HTML`), which is what keeps this side of the either/or safe:
    // `install_app` sources the frame via `compiled_in_ui_code`, so Install → Enable
    // from the Store still mounts a real UI with no seeded record.
    crate::plugins::builtins::BLUEPRINT_PLUGIN_ID,
    // The five demoted leaf-feature sidecar apps. Unlike every id above these were
    // Pre-installed until now, so they arrive here from the other direction: not
    // "not pre-installed but still present", but "pre-installed and enabled on
    // every fresh store". See the block in `CORE_PREINSTALLED` where they were
    // removed for the full account; the reason they belong in THIS list too is
    // that dropping them from the pre-installed set alone would still leave a disabled
    // record on a fresh store (the old companion seed wrote one for every opt-in
    // companion), so the Store would keep listing five uninstalled apps as
    // *Installed* and an uninstall would not survive a reboot.
    //
    // Four of these remain sidecar-only and carry no compiled-in companion bundle;
    // Clips is the exception now that its opt-in editor is carried by
    // `CLIPS_UI_HTML` in `seed_overrides`. The v5 list stays historical: it removes
    // the old pre-installed lifecycle record for Clips as well as the four sidecars,
    // while explicit re-install still gets whichever carriage the current manifest
    // provides.
    crate::plugins::builtins::RESEARCH_PLUGIN_ID,
    crate::plugins::builtins::DASHBOARDS_PLUGIN_ID,
    crate::plugins::builtins::TEAMS_PLUGIN_ID,
    crate::plugins::builtins::CLIPS_PLUGIN_ID,
    crate::plugins::builtins::RECIPES_PLUGIN_ID,
    // Pull Requests is an opt-in companion with a compiled-in UI bundle. Keep
    // its frame available through an explicit install, but do not seed a
    // disabled record for an app the user has not asked for.
    "@ryu/pull-requests",
];

/// The ids migration **v5** un-seeds, frozen as a literal rather than derived.
///
/// These are the five apps that were removed from `CORE_PREINSTALLED`. v5 needs its
/// own list, and it must never be folded into the broader legacy disabled-row list,
/// for two independent reasons:
///
/// 1. **v5 is allowed to remove an ENABLED record and v3 is not** (see
///    [`unseed_demoted_preinstalled_apps`] for why that is sound *only* for ids that
///    were seeded enabled). Pointing v5 at the live list would extend that licence
///    to every id ever added to the legacy disabled-row list — including whiteboard/canvas,
///    where an enabled record IS a deliberate user act and v3 deliberately protects
///    it.
/// 2. **A migration is a historical statement.** It describes one specific store
///    transition and runs once. A derived list would silently change meaning for
///    stores that ran it under the old value, which is the same trap the frozen
///    `LEGACY_DEFAULT_SECTION_ORDER` snapshot avoids on the desktop side.
///
/// Adding an app to the live not pre-installed set later must NOT touch this constant. If
/// that app also needs cleanup on existing stores, it gets its own step and schema
/// version.
const DEMOTED_FROM_PREINSTALLED_V5: &[&str] = &[
    crate::plugins::builtins::RESEARCH_PLUGIN_ID,
    crate::plugins::builtins::DASHBOARDS_PLUGIN_ID,
    crate::plugins::builtins::TEAMS_PLUGIN_ID,
    crate::plugins::builtins::CLIPS_PLUGIN_ID,
    crate::plugins::builtins::RECIPES_PLUGIN_ID,
];

/// Backfill a compiled-in companion bundle onto an existing lifecycle record.
///
/// The bundle is build content, not user state, so filling a missing value is safe.
/// The function deliberately never creates a record: an opt-in plugin is absent
/// until the user explicitly installs it, and [`crate::plugins::lifecycle::install_app`]
/// carries the bundle at that point.
async fn backfill_companion_ui(store: &PluginStore) {
    for spec in companion_ui_specs() {
        let Some(ui_code) = spec.ui_code else {
            continue;
        };
        let id = spec.id;

        let existing = match store.get_record(id).await {
            Ok(existing) => existing,
            Err(e) => {
                tracing::warn!("companion ui backfill: lookup '{id}' failed: {e}");
                continue;
            }
        };

        if existing.is_none() {
            continue;
        }

        // Fill a missing bundle, never overwrite one, and never touch the enabled
        // bit or the approved grants.
        match store.has_ui_code(id).await {
            Ok(false) => match store.set_ui_code(id, Some(ui_code)).await {
                Ok(_) => tracing::info!(
                    "companion ui backfill: filled the compiled-in ui_code for '{id}' \
                     (enabled state and grants untouched)"
                ),
                Err(e) => tracing::warn!("companion ui backfill: set_ui_code '{id}' failed: {e}"),
            },
            Ok(true) => {}
            Err(e) => tracing::warn!("companion ui backfill: ui_code lookup '{id}' failed: {e}"),
        }
    }
}

/// The store schema version this build expects. Bump when adding a migration below.
///
/// Each step below is gated on its OWN version (`current < N`), not just on this
/// total. Re-running an earlier step at a later bump would re-assert a value the
/// user is entitled to have changed since — e.g. bumping to 2 and letting v1 stores
/// re-run the v1 grant backfill would re-grant `ghost:record` to everyone who
/// revoked it between v1 and v2, which is exactly what
/// `a_later_revocation_is_never_undone_by_a_second_run` forbids (that test cannot
/// see it, because it only ever runs against one const value).
///
/// - v1: backfill host-api grants onto pre-existing records ([`backfill_host_api_grants`]).
/// - v2: re-enable the Learning app's record so its consent switches are reachable
///   again ([`restore_learning_consent_surface`]).
/// - v3: drop legacy disabled seed records, but only where they were never enabled
///   ([`remove_legacy_disabled_seed_records`]).
/// - v4: re-key records + plugin KV from legacy plugin ids to their scoped form
///   ([`rekey_legacy_plugin_ids`]).
/// - v5: drop the records the old pre-installed seed wrote for the five demoted
///   leaf-feature sidecar apps ([`unseed_demoted_preinstalled_apps`]).
/// - v6: move legacy unscoped plugin KV into the active user's tenant namespace
///   ([`migrate_legacy_plugin_storage`]).
const STORE_SCHEMA_VERSION: i64 = 6;

/// One-time data migrations for ALREADY-INSTALLED stores.
///
/// # Why this exists (and why it is not part of the seed loop)
///
/// [`seed_preinstalled`] deliberately short-circuits on `Ok(Some(_)) => continue`: a
/// plugin with any existing record is left alone, because the user's choice wins.
/// That is right for enable/disable, but it means a built-in that starts REQUIRING a
/// grant it never needed before is broken on every pre-existing install — the record
/// was written when the grant did not exist, and nothing else rewrites
/// `approved_grants` (`set_enabled` is its only writer; `update_app` explicitly
/// leaves it untouched).
///
/// That is exactly what happened when the per-app `/api/host/<app>/*` reverse
/// callbacks moved onto the generic `/api/host/capability/<cap>` seam: those routes
/// previously required NO grant (the gate was the minted sidecar token plus a
/// hardcoded app-id pin), and the generic seam correctly requires the capability
/// grant the manifest declares. Fresh installs are fine. `recipes` — pre-installed, and
/// the only pre-installed caller — would 403 on `ghost.*` on every existing install
/// until the user manually disabled and re-enabled it.
///
/// # Why a one-time migration rather than a boot reconcile
///
/// A reconcile that ran on EVERY boot would re-grant a capability the user had
/// deliberately revoked, silently overriding them forever. Gating on the store's
/// `PRAGMA user_version` runs the backfill exactly once per install, so it repairs
/// the upgrade and then never fights the user again.
///
/// # Scope (deliberately narrow)
///
/// Only COMPILED-IN built-ins (`is_compiled_in_manifest`) — a disk manifest under
/// `~/.ryu/plugins` must never self-approve, which is the whole point of the Gateway
/// gate. Only grants the built-in's own fixture declares, and only ADDITIVE
/// (`add_approved_grants` can never revoke).
///
/// # Steps
///
/// One fn per schema version, each gated on `current < N` so a store that already ran
/// an earlier step never re-runs it (see [`STORE_SCHEMA_VERSION`]):
///
/// - v1 [`backfill_host_api_grants`] — the host-callback grant repair described above.
/// - v2 [`restore_learning_consent_surface`] — re-enable `@ryu/learning`, whose
///   record now owns the consent switches for a capture path the kernel runs anyway.
/// - v4 [`rekey_legacy_plugin_ids`] — move lifecycle records and plugin KV onto the
///   scoped ids (`@ryu/meetings` → `@ryu/meetings`).
/// - v3 [`remove_legacy_disabled_seed_records`] — remove the never-enabled records
///   that the old unconditional companion-ui seed wrote.
///   The seed change alone only fixes FRESH installs (the loop leaves every existing
///   record alone), so without this step every current machine keeps listing
///   Whiteboard/Canvas as installed forever.
/// - v5 [`unseed_demoted_preinstalled_apps`] — the same repair for the five apps
///   demoted OUT of `CORE_PREINSTALLED`, which v3 cannot do because it refuses to
///   touch an enabled record and these were all seeded enabled.
/// - v6 [`migrate_legacy_plugin_storage`] — preserve existing plugin state while
///   enabling tenant-scoped storage for the active local account.
pub async fn run_one_time_migrations(store: &PluginStore, manifests: &[PluginManifest]) {
    let current = match store.schema_version().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("store migration: reading schema version failed: {e}");
            return;
        }
    };
    if current >= STORE_SCHEMA_VERSION {
        return;
    }

    if current < 1 {
        backfill_host_api_grants(store, manifests).await;
    }
    if current < 2 {
        restore_learning_consent_surface(store).await;
    }
    if current < 3 {
        remove_legacy_disabled_seed_records(store).await;
    }
    if current < 4 {
        rekey_legacy_plugin_ids(store).await;
    }
    if current < 5 {
        unseed_demoted_preinstalled_apps(store).await;
    }
    if current < 6 {
        match migrate_legacy_plugin_storage().await {
            LegacyPluginStorageMigration::Complete => {}
            LegacyPluginStorageMigration::WaitingForAccount => {
                // The earlier migrations have completed. Record that prefix so a
                // later boot retries only the tenant move after an account exists;
                // otherwise every boot would re-assert v1-v5 user state.
                if let Err(error) = store.set_schema_version(STORE_SCHEMA_VERSION - 1).await {
                    tracing::warn!(
                        "store migration v6: could not record pending account state: {error}"
                    );
                }
                return;
            }
            LegacyPluginStorageMigration::Failed => {
                tracing::warn!("store migration v6: leaving schema version unchanged for retry");
                return;
            }
        }
    }

    if let Err(e) = store.set_schema_version(STORE_SCHEMA_VERSION).await {
        // Not fatal, but not free either: a failed version write means every step is
        // attempted again next boot, and re-running a step RE-ASSERTS its value. If
        // the user changed that value in between, the re-run silently overrides them
        // — v1 would re-grant a revoked `ghost:record`, v2 would re-enable a Learning
        // record the user just disabled. That is the same class of bug the version
        // gate exists to prevent, narrowed to the window between a failed PRAGMA
        // write and the next restart. Only a store that cannot be written to at all
        // reaches here, so the narrow exposure is accepted rather than retried.
        tracing::warn!("store migration: recording schema version failed: {e}");
    }
}

/// **v4** — move every install's lifecycle record and plugin KV from a legacy plugin
/// id onto its scoped form (`@ryu/meetings` → `@ryu/meetings`).
///
/// The manifest loader canonicalizes ids at parse, so after the rename Core looks up
/// `@ryu/meetings` — but the records on an existing machine are still filed under
/// `@ryu/meetings`. Without this step every installed app on every existing
/// install silently reverts to *not installed*: disabled, with an empty
/// `approved_grants`, and with its plugin KV (active goals, learning state,
/// per-conversation hook state) unreachable. Nothing errors; it just looks like the
/// user's setup evaporated.
///
/// Driven off [`crate::plugin_manifest::LEGACY_PLUGIN_ID_ALIASES`], the same table
/// `canonical_plugin_id` reads, so the migration and the runtime resolver can never
/// disagree about what maps to what.
///
/// Both halves are re-run-safe (a record or KV row already present under the new id
/// wins), which matters because the version write at the end of
/// [`run_one_time_migrations`] can itself fail and re-run every step next boot.
async fn rekey_legacy_plugin_ids(store: &PluginStore) {
    let storage = crate::plugin_storage::global();
    let mut records = 0usize;
    let mut kv_rows = 0usize;

    for (legacy, canonical) in crate::plugin_manifest::LEGACY_PLUGIN_ID_ALIASES {
        match store.rekey(legacy, canonical).await {
            Ok(true) => records += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("store migration v4: rekey '{legacy}' record failed: {e}"),
        }
        // Best-effort and independent of the record move: an install can hold KV for
        // a plugin whose record was already removed, and losing that state silently
        // is the failure this step exists to prevent.
        if let Some(storage) = storage {
            match storage.rekey_plugin(legacy, canonical).await {
                Ok(n) => kv_rows += n,
                Err(e) => tracing::warn!("store migration v4: rekey '{legacy}' kv failed: {e}"),
            }
        }
    }

    if records > 0 || kv_rows > 0 {
        tracing::info!(
            records,
            kv_rows,
            "store migration v4: moved plugin state onto scoped ids"
        );
    }
}

/// **v6** — the host bridge now prefixes plugin KV with the authenticated user
/// id. Existing local installs have unscoped rows, so move them once for the
/// active account instead of making every hook appear to have lost its state.
/// When Core has no active local account (for example a freshly provisioned
/// shared node), leave the legacy rows untouched; the tenant bridge deliberately
/// does not expose them to an unrelated caller.
enum LegacyPluginStorageMigration {
    Complete,
    Failed,
    WaitingForAccount,
}

async fn migrate_legacy_plugin_storage() -> LegacyPluginStorageMigration {
    let Some(tenant) = crate::auth::load_accounts().active_user_id else {
        return LegacyPluginStorageMigration::WaitingForAccount;
    };
    let Some(storage) = crate::plugin_storage::global() else {
        tracing::warn!("store migration v6: plugin storage is unavailable");
        return LegacyPluginStorageMigration::Failed;
    };
    match storage.migrate_legacy_namespaces(&tenant).await {
        Ok(rows) if rows > 0 => {
            tracing::info!(rows, "store migration v6: tenant-scoped plugin KV")
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!("store migration v6: plugin KV migration failed: {error}");
            return LegacyPluginStorageMigration::Failed;
        }
    }
    LegacyPluginStorageMigration::Complete
}

/// **v1** — see [`run_one_time_migrations`] for the why.
async fn backfill_host_api_grants(store: &PluginStore, manifests: &[PluginManifest]) {
    for manifest in manifests {
        if !crate::plugins::builtins::is_compiled_in_manifest(&manifest.id) {
            continue;
        }
        // The grants a sidecar needs for its host callbacks, which is the set the
        // capability seam now enforces. `permission_grants` is the manifest-level
        // declaration the Gateway validates; the intersection is what a fresh
        // install would have ended up with.
        let needed: Vec<String> = manifest
            .sidecars
            .iter()
            .flat_map(|s| s.host_api.iter())
            .flat_map(|h| h.grants.iter())
            .filter(|g| manifest.permission_grants.iter().any(|p| p == *g))
            .cloned()
            .collect();
        if needed.is_empty() {
            continue;
        }
        match store.get(&manifest.id).await {
            // No record = nothing installed yet; the seed will do the right thing.
            Ok(None) | Err(_) => continue,
            Ok(Some(record)) => {
                let missing: Vec<String> = needed
                    .iter()
                    .filter(|g| !record.approved_grants.iter().any(|a| a == *g))
                    .cloned()
                    .collect();
                if missing.is_empty() {
                    continue;
                }
                match store.add_approved_grants(&manifest.id, &missing).await {
                    Ok(_) => tracing::info!(
                        "store migration v1: backfilled host-api grant(s) {missing:?} for \
                         built-in '{}' (its host callbacks became capability-gated; a \
                         pre-existing record predates the grant)",
                        manifest.id
                    ),
                    Err(e) => tracing::warn!(
                        "store migration: backfilling grants for '{}' failed: {e}",
                        manifest.id
                    ),
                }
            }
        }
    }
}

/// **v2** — restore the Learning app's record (enabled) on installs that already
/// had one, so its consent switches are reachable again.
///
/// # The regression this repairs
///
/// The two learning consent switches moved out of Privacy settings and into an
/// app-registered settings tab (`contributes.settings_tabs` in the `@ryu/learning`
/// manifest, rendered by the desktop's `LearningSettings.tsx`). An app-registered tab
/// only renders while its owning app is ENABLED. Adding the id to [`CORE_PREINSTALLED`]
/// fixes fresh installs only: [`seed_preinstalled`] short-circuits on
/// `Ok(Some(_)) => continue`, and Learning was not pre-installed until now, so essentially
/// every pre-existing install carries a `@ryu/learning` record at `enabled = false`.
/// Those users would see NO consent switches at all.
///
/// # Why enabling the record is safe — the whole justification
///
/// **The app record is not the consent.** The consent is the two preferences, and this
/// migration does not touch either: `learning.enabled` (the training/PRM opt-in) stays
/// OFF, and `learning.skills-enabled` keeps whatever the user set. Enabling the record
/// only makes the settings SURFACE and the `/api/learn/*` routes reachable again — it
/// restores a control the user lost, it does not turn anything on.
///
/// Nothing about what actually RUNS changes, because the capture and the cycle were
/// never gated on the record in the first place: the scheduler keeps running its
/// `JobTarget::LearningCycle` job and the in-process `ExperienceStore` keeps capturing
/// `(user, assistant)` turns whether the app is enabled or not (see the
/// `learning_routes` doc — "Only the HTTP surface is gated"). Nor does any boot path
/// seed global state from this record, the way `main.rs` seeds `dictation::set_enabled
/// (rec.enabled)` and `predict::set_enabled(rec.enabled)`; and the manifest declares no
/// sidecar and no `mcp_servers`, so flipping the bit spawns nothing. That asymmetry —
/// still running, but no longer switchable off — is precisely why the surface must be
/// restored.
///
/// # Scope
///
/// Exactly one id, looked up through [`preinstalled_specs`], which is derived from
/// [`CORE_PREINSTALLED`] ⊂ `CORE_PLUGINS` ⊂ the official package catalog — a tighter scope than
/// the v1 step's `is_compiled_in_manifest` guard, and self-limiting: if Learning ever
/// leaves the pre-installed set again, this step stops asserting anything. No other app
/// is touched, and a record that is already enabled (or absent — an install that never
/// had Learning is a fresh-seed case, not an upgrade case) is left alone.
///
/// # Why this does not re-derive the dependency graph
///
/// The module header promises the store-only write never bypasses the graph, and
/// Learning is the plugin that made that promise concrete — it `requires` the `skills`
/// app. This step still calls `set_enabled` directly, deliberately: a satisfiability
/// guard would turn a ONE-SHOT migration into a permanent no-op for anyone who has
/// `skills` disabled, stranding exactly the users the repair exists for, with no second
/// bump to save them. The exposure is small and recoverable in a way the alternative is
/// not: `skills` is pre-installed (so a disabled dependency is rare), enabling Learning is
/// one bit with no sidecar and no spawn, and a half-enabled pair is re-derived by the
/// ordinary enable/disable path the moment either app is toggled — whereas a silently
/// skipped one-shot migration is not recoverable at all.
///
/// # Why once, not every boot
///
/// The version gate is the entire safety property: a user who disables Learning AFTER
/// this migration must stay disabled across every subsequent restart. A reconcile that
/// re-enabled it on every boot would take the off-switch away permanently, which is the
/// same class of bug as the one being repaired.
async fn restore_learning_consent_surface(store: &PluginStore) {
    let id = crate::plugins::builtins::LEARNING_PLUGIN_ID;
    let Some(spec) = preinstalled_specs().into_iter().find(|s| s.id == id) else {
        return;
    };

    let record = match store.get(id).await {
        // Already enabled, or never installed — nothing to repair. (The absent case
        // belongs to `seed_preinstalled`, which conjures no record it did not create.)
        Ok(Some(record)) if record.enabled => return,
        Ok(None) => return,
        Ok(Some(record)) => record,
        Err(e) => {
            tracing::warn!("store migration v2: lookup '{id}' failed: {e}");
            return;
        }
    };

    // A record written during the not pre-installed era has NO `ui_code`: nothing but
    // `seed_overrides` sources a built-in's companion bundle (neither `install_app`
    // nor `enable_app` does — that is why the backfill exists),
    // and the pre-installed seed loop skipped this record. Enabling without it would
    // trade a missing switch for a companion that mounts as "no runnable UI".
    // Only ever FILLS a gap; a record that already has a bundle is left alone.
    //
    // Kept even though `backfill_companion_ui` now fills every companion record on
    // every boot: `main.rs` runs the seed BEFORE the migrations, so in practice this
    // finds the bundle already there and no-ops — but the repair this migration owes
    // its user must not depend on the ORDER of two independent boot steps.
    if let Some(ui_code) = spec.ui_code {
        match store.has_ui_code(id).await {
            Ok(false) => {
                if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                    tracing::warn!("store migration v2: set_ui_code '{id}' failed: {e}");
                }
            }
            Ok(true) => {}
            Err(e) => tracing::warn!("store migration v2: ui_code lookup '{id}' failed: {e}"),
        }
    }

    // Union, never replace: the v1 step above adds grants WITHOUT touching `enabled`,
    // so a record can reach here already carrying grants that a bare
    // `set_enabled(id, &spec.grants)` would silently drop.
    let mut grants = record.approved_grants.clone();
    for g in spec.grants {
        if !grants.iter().any(|have| have == *g) {
            grants.push((*g).to_owned());
        }
    }

    match store.set_enabled(id, &grants).await {
        Ok(_) => tracing::info!(
            "store migration v2: re-enabled '{id}' so its consent switches are reachable \
             again (the record is not the consent — `learning.enabled` stays OFF and \
             `learning.skills-enabled` is untouched; capture + the learning cycle were \
             never gated on this record)"
        ),
        Err(e) => tracing::warn!("store migration v2: enabling '{id}' failed: {e}"),
    }
}

/// **v3** — remove legacy disabled seed records from stores that already carry a row
/// created by the old unconditional companion-bundle seed.
///
/// # Why the seed change is not enough on its own
///
/// [`seed_preinstalled`] / [`backfill_companion_ui`] leave every EXISTING record alone —
/// that is the "user's choice wins" rule, and it is right. But it means dropping the
/// the legacy seed only ever fixes machines that have not booted yet: every current install
/// keeps a `@ryu/whiteboard` / `@ryu/canvas` row forever, and the Store keeps
/// listing them as installed. This step is what makes the change reach them.
///
/// # Why removing the record loses nothing
///
/// The record holds no user state: `ui_code` is build content (re-attached by
/// `lifecycle::install_app` from the compiled-in const), `approved_grants` is
/// re-derived by `enable_app` from the manifest, and the app's actual content — the
/// Space documents its board renders — lives in Spaces and is never touched here. So
/// the worst case for a user who WANTED it is one click in the Store, and the app
/// re-installs with an identical record.
///
/// # The one line it will not cross
///
/// **An ENABLED record is never removed.** Enabled is the one bit that can only have
/// come from a deliberate act (nothing ever seeded these two enabled — see
/// `the_real_seed_enables_spaces_and_leaves_its_space_owning_apps_optin`), and
/// removing it would delete a working app out from under someone mid-use. Same shape
/// as v1/v2's refusal to override a later user decision.
///
/// Once per install, like every step here: a user who installs Whiteboard AFTER this
/// migration keeps it, because the version gate has already passed.
async fn remove_legacy_disabled_seed_records(store: &PluginStore) {
    for id in LEGACY_DISABLED_SEED_IDS {
        match store.get(id).await {
            // Never installed — the fresh-install case, already correct.
            Ok(None) => continue,
            // The user turned it on. Their choice, and the app is in use.
            Ok(Some(record)) if record.enabled => {
                tracing::info!(
                    "store migration v3: keeping '{id}' — it is ENABLED, so the record is a \
                     deliberate choice, not the legacy seed artifact this step removes"
                );
            }
            Ok(Some(_)) => match store.remove(id).await {
                Ok(_) => tracing::info!(
                    "store migration v3: removed the never-enabled legacy seed record for \
                     '{id}'; `lifecycle::install_app` now attaches any compiled-in bundle \
                     at explicit install time"
                ),
                Err(e) => tracing::warn!("store migration v3: removing '{id}' failed: {e}"),
            },
            Err(e) => tracing::warn!("store migration v3: lookup '{id}' failed: {e}"),
        }
    }
}

/// **v5** — remove the records the old pre-installed seed wrote for the five
/// leaf-feature sidecar apps in [`DEMOTED_FROM_PREINSTALLED_V5`], **enabled or not**.
///
/// # Why v3 cannot do this
///
/// [`remove_legacy_disabled_seed_records`] refuses to remove an ENABLED record, on the grounds
/// that `enabled` can only have come from a deliberate act. For whiteboard/canvas
/// that is exactly right — nothing ever seeded them enabled, so an enabled record is
/// proof of a user decision.
///
/// For these five it is exactly wrong, and for a mechanical reason: they were IN
/// `CORE_PREINSTALLED`, and [`seed_preinstalled`] writes `enabled = true` for every id in
/// that list on any store missing the row. So on every existing install all five are
/// enabled, and not one of those bits records a choice — it records the seed. Reusing
/// v3's rule here would make the step a no-op on 100% of the machines that have the
/// problem, which is the failure mode this whole change exists to end: a fix that
/// only ever reaches installs that do not need it.
///
/// # Why removing them loses nothing
///
/// Same argument as v3, and it is stronger here because these apps are fully
/// out-of-process. The record holds `enabled`, `approved_grants` (re-derived by
/// `enable_app` from the manifest at every enable) and, for Clips, the current
/// `ui_code` companion carriage. The other four sidecar apps do not use `ui_code`;
/// their UI is served by their own sidecar over the ext-proxy.
/// The user's actual data — teams in `teams.db`, dashboards in `dashboards.db`,
/// recorded clips in the Clips Space, recipes in Ghost's RecipeStore — lives in
/// stores this never touches, and is still there when the app is re-installed. So
/// the worst case for someone who wanted one is a single click in the Store, onto an
/// identical record and their existing data.
///
/// # The line it does hold
///
/// The id list is frozen (see [`DEMOTED_FROM_PREINSTALLED_V5`]) and the step is version
/// gated, so it runs exactly once. A user who installs Teams the day after upgrading
/// keeps it forever: the gate has already passed and nothing re-runs. That is the
/// same run-once property `a_later_revocation_is_never_undone_by_a_second_run` pins
/// for v1 — this step gets it from the gate alone, which is why the test below asserts
/// a re-install survives repeated boots.
async fn unseed_demoted_preinstalled_apps(store: &PluginStore) {
    for id in DEMOTED_FROM_PREINSTALLED_V5 {
        match store.get(id).await {
            // Already absent — a fresh store, or a user who uninstalled it before
            // `is_uninstall_protected` started refusing (it keyed off `is_preinstalled`).
            Ok(None) => continue,
            Ok(Some(record)) => {
                let was_enabled = record.enabled;
                match store.remove(id).await {
                    Ok(_) => tracing::info!(
                        "store migration v5: removed the '{id}' record (enabled={was_enabled}) — \
                         it was written by the old CORE_PREINSTALLED seed, not by the user, and \
                         the app is now install-on-demand from the Store. Its data (teams.db / \
                         dashboards.db / the Clips Space / Ghost recipes) is untouched and is \
                         still there if it is re-installed."
                    ),
                    Err(e) => tracing::warn!("store migration v5: removing '{id}' failed: {e}"),
                }
            }
            Err(e) => tracing::warn!("store migration v5: lookup '{id}' failed: {e}"),
        }
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// The v1 subject: a compiled-in built-in whose sidecar declares a `host_api`
    /// grant that is also in its `permission_grants` — the exact shape
    /// [`backfill_host_api_grants`] repairs. Its grant is `tools.invoke`.
    ///
    /// This used to be `@ryu/recipes`, which is the app the v1 regression was
    /// actually reported against. Recipes moved into [`DEMOTED_FROM_PREINSTALLED_V5`],
    /// and v5 REMOVES those records outright — so every test here that inserts a
    /// record and then reads it back through the full `run_one_time_migrations`
    /// would be asserting against a row v5 had just deleted. Monitors is the nearest
    /// equivalent that survives the whole chain: it is in the legacy disabled-seed set, but
    /// v3 refuses to touch an ENABLED record and these tests install it enabled.
    const MONITORS: &str = crate::plugins::builtins::MONITORS_PLUGIN_ID;
    /// The `host_api` grant [`MONITORS`] declares — what v1 must put back.
    const MONITORS_HOST_GRANT: &str = "tools.invoke";

    /// Reproduces the actual upgrade: a store seeded BEFORE the per-app
    /// `/api/host/<app>/*` callbacks moved onto the capability seam. Its record is
    /// enabled with NO grants, because those routes required none. After the move,
    /// the host callbacks need the manifest's declared grant, so without this
    /// migration every pre-existing install 403s until the user toggles the app off
    /// and on.
    #[tokio::test]
    async fn backfills_a_host_api_grant_onto_a_pre_existing_record() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // The pre-upgrade state: installed + enabled, empty approved_grants.
        store.insert(MONITORS, "1.0.0").await.unwrap();
        store.set_enabled(MONITORS, &[]).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        let record = store.get(MONITORS).await.unwrap().unwrap();
        assert!(
            record
                .approved_grants
                .iter()
                .any(|g| g == MONITORS_HOST_GRANT),
            "'{MONITORS}' must regain the grant its host callbacks now require, got {:?}",
            record.approved_grants
        );
        assert!(
            record.enabled,
            "the backfill must not disturb enabled state"
        );
    }

    /// The property that makes running this at boot safe: it happens ONCE. A user who
    /// revokes a grant afterwards must keep it revoked across every later restart —
    /// a reconcile that re-asserted the grant on every boot would silently override
    /// them forever, which is why this is version-gated rather than unconditional.
    #[tokio::test]
    async fn a_later_revocation_is_never_undone_by_a_second_run() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        store.insert(MONITORS, "1.0.0").await.unwrap();
        store.set_enabled(MONITORS, &[]).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;
        // The user revokes it.
        store.set_enabled(MONITORS, &[]).await.unwrap();
        // Every subsequent boot.
        run_one_time_migrations(&store, &manifests).await;
        run_one_time_migrations(&store, &manifests).await;

        let record = store.get(MONITORS).await.unwrap().unwrap();
        assert!(
            record.approved_grants.is_empty(),
            "a revoked grant must stay revoked, got {:?}",
            record.approved_grants
        );
    }

    /// A disk manifest must never self-approve — that is the entire point of the
    /// Gateway grant gate, and a migration that ignored it would be a way to bypass
    /// the capability grammar by shipping a manifest that declares its own host_api.
    #[tokio::test]
    async fn a_non_compiled_in_plugin_is_never_backfilled() {
        let store = PluginStore::open_in_memory().unwrap();
        let evil = "com.evil.app";
        assert!(
            !crate::plugins::builtins::is_compiled_in_manifest(evil),
            "'{evil}' must not be a built-in for this test to mean anything"
        );
        store.insert(evil, "1.0.0").await.unwrap();
        store.set_enabled(evil, &[]).await.unwrap();

        // A manifest that declares a sidecar host_api grant AND the matching
        // permission_grant — i.e. it has done everything a built-in does.
        let mut manifest = crate::plugin_manifest::PluginManifestLoader::load_builtins()
            .into_iter()
            .find(|m| m.id == MONITORS)
            .expect("monitors fixture");
        manifest.id = evil.to_owned();

        run_one_time_migrations(&store, &[manifest]).await;

        let record = store.get(evil).await.unwrap().unwrap();
        assert!(
            record.approved_grants.is_empty(),
            "a disk manifest must never self-approve a host-api grant, got {:?}",
            record.approved_grants
        );
    }

    const LEARNING: &str = crate::plugins::builtins::LEARNING_PLUGIN_ID;
    /// A not pre-installed built-in that is outside the legacy disabled-seed set. It used to
    /// be `quests`, which moved into that set; using it here would make v3 delete the
    /// very record the test inserts to watch.
    const OPT_IN_BUILTIN: &str = crate::plugins::builtins::HEALING_PLUGIN_ID;

    /// THE consent-surface regression (v2). Learning was not pre-installed until its two
    /// consent switches moved onto its app-registered settings tab, so essentially
    /// every pre-existing install has a `@ryu/learning` record at `enabled = false`
    /// — and an app-registered tab only renders while its app is enabled. The seed
    /// loop cannot fix it (`Ok(Some(_)) => continue`), so those users lose the
    /// off-switch for a capture path the kernel keeps running regardless of the record.
    #[tokio::test]
    async fn the_learning_consent_surface_is_restored_on_a_pre_existing_disabled_record() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // The pre-upgrade state: installed, and the user (or the old not pre-installed
        // posture) left it disabled.
        store.insert(LEARNING, "1.0.0").await.unwrap();
        store.set_disabled(LEARNING).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        let record = store.get(LEARNING).await.unwrap().unwrap();
        let ui = store
            .get_ui_code(LEARNING)
            .await
            .unwrap()
            .expect("a re-enabled record must carry its companion bundle, not mount empty");
        assert!(
            ui.len() > 10_000 && ui.contains('<'),
            "learning ui_code must be the real inlined companion bundle, got {} bytes",
            ui.len()
        );
        assert!(
            record.enabled,
            "learning must be re-enabled so its settings tab (and /api/learn/*) is \
             reachable again"
        );
        assert!(
            record.approved_grants.iter().any(|g| g == "learning:crud"),
            "a re-enabled record must carry the grants a fresh install would have, got {:?}",
            record.approved_grants
        );
    }

    /// The property that makes v2 safe, mirroring
    /// `a_later_revocation_is_never_undone_by_a_second_run`: the version gate. A user
    /// who disables Learning AFTER the migration must stay disabled across every later
    /// restart — a boot reconcile would take the off-switch away permanently, the same
    /// class of bug the migration repairs.
    ///
    /// This FAILS if the version gating is removed — but note it takes BOTH gates to
    /// turn it red, because they are redundant for v2: dropping only the
    /// `current >= STORE_SCHEMA_VERSION` early return still leaves `current < 2` false
    /// on the second run, and dropping only `current < 2` still hits the early return.
    /// So this test pins the PROPERTY (run-once, never a reconcile), not either gate in
    /// isolation. `a_v1_store_gets_only_the_v2_step` is what pins the per-step gate.
    /// The first assert below is load-bearing in the other direction: it fails if the
    /// v2 step is removed outright, which keeps the tail assert from passing vacuously.
    #[tokio::test]
    async fn a_later_learning_disable_is_never_undone_by_a_second_run() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        store.insert(LEARNING, "1.0.0").await.unwrap();
        store.set_disabled(LEARNING).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;
        assert!(store.get(LEARNING).await.unwrap().unwrap().enabled);

        // The user turns Learning off again.
        store.set_disabled(LEARNING).await.unwrap();
        // Every subsequent boot.
        run_one_time_migrations(&store, &manifests).await;
        run_one_time_migrations(&store, &manifests).await;

        assert!(
            !store.get(LEARNING).await.unwrap().unwrap().enabled,
            "a deliberate disable must survive every later boot"
        );
    }

    /// v2 is exactly one id. It must not become a general "re-enable the pre-installed
    /// set" reconcile: another app the user disabled stays disabled, and a not pre-installed
    /// built-in is never enabled at all.
    #[tokio::test]
    async fn the_learning_migration_enables_no_other_app() {
        assert!(
            crate::plugins::builtins::CORE_PLUGINS.contains(&OPT_IN_BUILTIN)
                && !CORE_PREINSTALLED.contains(&OPT_IN_BUILTIN)
                && !LEGACY_DISABLED_SEED_IDS.contains(&OPT_IN_BUILTIN),
            "'{OPT_IN_BUILTIN}' must be a not pre-installed built-in outside the legacy seed set for \
             this test to mean anything"
        );
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        store.insert(LEARNING, "1.0.0").await.unwrap();
        store.set_disabled(LEARNING).await.unwrap();
        // A pre-installed app the user deliberately turned off. `skills` rather than
        // `recipes`: recipes is no longer pre-installed, and v5 deletes its record
        // outright, so it can no longer stand for "left alone by v2".
        let still_preinstalled = crate::plugins::builtins::SKILLS_PLUGIN_ID;
        assert!(
            CORE_PREINSTALLED.contains(&still_preinstalled)
                && !LEGACY_DISABLED_SEED_IDS.contains(&still_preinstalled),
            "'{still_preinstalled}' must be a pre-installed app outside the legacy seed set for this test to \
             mean anything"
        );
        store.insert(still_preinstalled, "1.0.0").await.unwrap();
        store.set_disabled(still_preinstalled).await.unwrap();
        // A not pre-installed built-in, never enabled.
        store.insert(OPT_IN_BUILTIN, "1.0.0").await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        assert!(store.get(LEARNING).await.unwrap().unwrap().enabled);
        assert!(
            !store
                .get(still_preinstalled)
                .await
                .unwrap()
                .unwrap()
                .enabled,
            "another pre-installed app the user disabled must stay disabled"
        );
        assert!(
            !store.get(OPT_IN_BUILTIN).await.unwrap().unwrap().enabled,
            "a not pre-installed built-in must never be enabled by this migration"
        );
    }

    /// Each step is gated on its OWN version, so bumping the schema for a later step
    /// must NOT drag the v1 grant backfill along for a store that already ran it:
    /// re-running it would re-grant the host-api grant to everyone who revoked it
    /// since — the same "a reconcile silently overrides the user" bug the version
    /// gate exists to prevent, invisible to the single-version revocation test above.
    #[tokio::test]
    async fn a_v1_store_gets_only_the_v2_step() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        store.set_schema_version(1).await.unwrap();

        // Enabled, and the user revoked the grant the v1 backfill had given it.
        store.insert(MONITORS, "1.0.0").await.unwrap();
        store.set_enabled(MONITORS, &[]).await.unwrap();
        store.insert(LEARNING, "1.0.0").await.unwrap();
        store.set_disabled(LEARNING).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        assert!(
            store
                .get(MONITORS)
                .await
                .unwrap()
                .unwrap()
                .approved_grants
                .is_empty(),
            "the v1 backfill must not re-run for a store already at v1"
        );
        assert!(
            store.get(LEARNING).await.unwrap().unwrap().enabled,
            "the v2 step must still run for a store at v1"
        );
    }

    /// An app the user never installed must not be conjured into existence.
    #[tokio::test]
    async fn an_absent_record_is_left_absent() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        run_one_time_migrations(&store, &manifests).await;

        assert!(store.get(MONITORS).await.unwrap().is_none());
    }

    /// **v3** — the upgrade case the seed change cannot reach on its own: every
    /// existing install carries the disabled `@ryu/whiteboard` / `@ryu/canvas`
    /// record the old legacy seed wrote, and `seed_preinstalled` leaves existing records
    /// alone by design. Without this step the change ships as fresh-installs-only.
    #[tokio::test]
    async fn v3_removes_the_never_enabled_legacy_seed_records() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // The pre-upgrade state the old companion seed produced: installed,
        // disabled, carrying the compiled-in bundle.
        for id in LEGACY_DISABLED_SEED_IDS {
            store.insert(id, "1.0.0").await.unwrap();
            store
                .set_ui_code(id, Some("<html>bundle</html>"))
                .await
                .unwrap();
        }

        run_one_time_migrations(&store, &manifests).await;

        for id in LEGACY_DISABLED_SEED_IDS {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' was a never-enabled legacy seed artifact — v3 must remove it"
            );
        }
    }

    /// The line v3 will not cross. `enabled` can only have come from a deliberate act
    /// (nothing ever seeded these two enabled), so removing the record would delete a
    /// working app out from under someone mid-use — the same "never override a later
    /// user decision" rule v1 and v2 are built on.
    #[tokio::test]
    async fn v3_never_removes_an_enabled_record() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        let id = LEGACY_DISABLED_SEED_IDS[0];
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(id, &["spaces:docs".to_owned()])
            .await
            .unwrap();

        run_one_time_migrations(&store, &manifests).await;

        let record = store
            .get(id)
            .await
            .unwrap()
            .expect("an ENABLED record must survive v3");
        assert!(record.enabled, "and must stay enabled");
        assert_eq!(
            record.approved_grants,
            vec!["spaces:docs".to_owned()],
            "its grants must be untouched"
        );
    }

    /// Once per install, like every other step: a user who installs Whiteboard AFTER
    /// the migration ran must keep it. A v3 that re-ran on every boot would make the
    /// app un-installable-by-Store, which is strictly worse than the legacy record it
    /// replaces.
    #[tokio::test]
    async fn v3_does_not_re_run_and_uninstall_a_later_install() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        run_one_time_migrations(&store, &manifests).await;

        // The user installs it afterwards, from the Store, and leaves it off.
        let id = LEGACY_DISABLED_SEED_IDS[0];
        store.insert(id, "1.0.0").await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        assert!(
            store.get(id).await.unwrap().is_some(),
            "'{id}' was installed AFTER v3 ran — the version gate must stop v3 from removing it"
        );
    }

    // ── v5: the five apps demoted out of CORE_PREINSTALLED ──────────────────────

    /// THE reported bug, as a test: "I wiped all my state and Teams / Dashboards /
    /// Clips are still installed."
    ///
    /// They were, and v3 could not help, because it refuses to remove an ENABLED
    /// record and `seed_preinstalled` had seeded all five ENABLED. This asserts the one
    /// thing that makes v5 worth a schema bump: it removes them anyway.
    #[tokio::test]
    async fn v5_removes_the_demoted_apps_even_though_the_seed_left_them_enabled() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        // Exactly what the old pre-installed seed wrote on every existing install.
        for id in DEMOTED_FROM_PREINSTALLED_V5 {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
            assert!(store.get(id).await.unwrap().unwrap().enabled);
        }

        run_one_time_migrations(&store, &manifests).await;

        for id in DEMOTED_FROM_PREINSTALLED_V5 {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' was auto-enabled by the old CORE_PREINSTALLED seed, not by the user — \
                 v5 must remove the record so the app is genuinely absent"
            );
        }
    }

    /// v5's licence to delete an enabled record must not leak onto v3's ids. The two
    /// steps disagree about what `enabled` MEANS — seeded, for the demoted five;
    /// deliberate, for whiteboard/canvas — and that is the entire reason
    /// [`DEMOTED_FROM_PREINSTALLED_V5`] is a frozen literal instead of a reference to
    /// the legacy disabled-seed list. Wiring v5 to the live list would turn this red.
    #[tokio::test]
    async fn v5_leaves_the_v3_ids_alone() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        let whiteboard = crate::plugin_manifest::WHITEBOARD_PLUGIN_ID;
        assert!(
            LEGACY_DISABLED_SEED_IDS.contains(&whiteboard)
                && !DEMOTED_FROM_PREINSTALLED_V5.contains(&whiteboard),
            "'{whiteboard}' must be a v3-only id for this test to mean anything"
        );
        store.insert(whiteboard, "1.0.0").await.unwrap();
        store.set_enabled(whiteboard, &[]).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;

        assert!(
            store
                .get(whiteboard)
                .await
                .unwrap()
                .is_some_and(|r| r.enabled),
            "an ENABLED whiteboard record is a deliberate user act — only the seed ever \
             enabled the v5 ids, so v5 must not generalize its removal to v3's"
        );
    }

    /// Run-once, from the version gate alone: a user who re-installs Teams the day
    /// after upgrading keeps it through every later boot. Without this the change
    /// would be worse than the bug — an app the Store could install but never keep.
    #[tokio::test]
    async fn v5_does_not_re_run_and_uninstall_a_later_install() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        run_one_time_migrations(&store, &manifests).await;

        let id = crate::plugins::builtins::TEAMS_PLUGIN_ID;
        store.insert(id, "1.0.0").await.unwrap();
        store.set_enabled(id, &[]).await.unwrap();

        run_one_time_migrations(&store, &manifests).await;
        run_one_time_migrations(&store, &manifests).await;

        assert!(
            store.get(id).await.unwrap().is_some_and(|r| r.enabled),
            "'{id}' was installed AFTER v5 ran — the version gate must stop v5 from \
             removing it on every later boot"
        );
    }

    /// The fresh-install half, which is what a node reset actually exercises: seeding
    /// an empty store must write NO record for any of the five. A pass here plus
    /// `v5_removes_…` above is the full claim — "wipe your state and they are gone",
    /// for new machines and upgraded ones alike.
    #[tokio::test]
    async fn a_fresh_seed_writes_no_record_for_the_demoted_apps() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_preinstalled(&store, &manifests).await;
        for id in DEMOTED_FROM_PREINSTALLED_V5 {
            assert!(
                !CORE_PREINSTALLED.contains(id),
                "'{id}' must not be back in CORE_PREINSTALLED — that is what auto-installs it"
            );
            assert!(
                LEGACY_DISABLED_SEED_IDS.contains(id),
                "'{id}' must be covered by the legacy cleanup set"
            );
            assert!(
                store.get(id).await.unwrap().is_none(),
                "a fresh store must carry NO '{id}' record at all"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{AppDependency, Requires};

    fn manifest(id: &str, version: &str, deps: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            requires: (!deps.is_empty()).then(|| Requires {
                apps: deps
                    .iter()
                    .map(|d| AppDependency {
                        id: (*d).to_owned(),
                        min_version: None,
                    })
                    .collect(),
                capabilities: vec![],
                grants: vec![],
            }),
            ..Default::default()
        }
    }

    fn spec(id: &'static str) -> SeedSpec {
        SeedSpec {
            id,
            grants: &[],
            ui_code: None,
        }
    }

    #[test]
    fn production_runtime_set_can_seed_memory() {
        let manifests =
            crate::plugin_manifest::PluginManifestLoader::load_runtime_builtins_for_test();
        assert!(
            manifests
                .iter()
                .any(|manifest| manifest.id == crate::plugins::builtins::MEMORY_PLUGIN_ID),
            "the production runtime fixture set must load the Memory manifest"
        );
        let (ordered, skipped) = seed_order(&preinstalled_specs(), &manifests);
        assert!(
            skipped
                .iter()
                .all(|seed| seed.id != crate::plugins::builtins::MEMORY_PLUGIN_ID),
            "Memory was skipped during production pre-installed ordering: {skipped:?}"
        );
        assert!(ordered
            .iter()
            .any(|id| id == crate::plugins::builtins::MEMORY_PLUGIN_ID));
    }

    /// Capability edges (`requires.capabilities`) are lowered at seed time, so the
    /// seed order respects them: with the REAL built-ins, spaces requires the `rag`
    /// capability and rag requires `engines`, so the order is engines → rag → spaces
    /// even though those are capability edges, not app deps.
    #[test]
    fn seed_order_respects_capability_edges() {
        let specs = preinstalled_specs();
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let (order, skipped) = seed_order(&specs, &manifests);
        let pos = |id: &str| order.iter().position(|x| x == id);
        let (e, r, s) = (pos("@ryu/engines"), pos("@ryu/rag"), pos("@ryu/spaces"));
        assert!(
            e.is_some() && r.is_some() && s.is_some(),
            "engines/rag/spaces all seeded (order: {order:?})"
        );
        assert!(e < r && r < s, "engines → rag → spaces (order: {order:?})");
        assert!(
            !skipped
                .iter()
                .any(|sk| sk.id == "@ryu/spaces" || sk.id == "@ryu/rag"),
            "no capability-related seed skip (skipped: {skipped:?})"
        );
    }

    /// THE regression this module exists for: the seed list is written by hand and
    /// is NOT topological. A dependent declared BEFORE its dependency must still be
    /// seeded AFTER it.
    #[test]
    fn seed_order_is_topological_even_when_declaration_order_is_not() {
        // "meetings" is declared first but requires "spaces".
        let specs = [spec("meetings"), spec("spaces")];
        let manifests = vec![
            manifest("meetings", "1.0.0", &["spaces"]),
            manifest("spaces", "1.0.0", &[]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(skipped.is_empty());
        assert_eq!(ordered, vec!["spaces".to_owned(), "meetings".to_owned()]);
    }

    /// FAIL-CLOSED: a pre-installed plugin whose dependency is NOT pre-installed is not
    /// seeded at all — never enabled with a dependency that was never enabled.
    #[test]
    fn a_dependency_outside_the_preinstalled_set_skips_the_plugin() {
        let specs = [spec("meetings")];
        let manifests = vec![
            manifest("meetings", "1.0.0", &["spaces"]),
            // `spaces` is loaded, but it is NOT in the pre-installed set.
            manifest("spaces", "1.0.0", &[]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(ordered.is_empty(), "nothing may be seeded: {ordered:?}");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].id, "meetings");
        assert!(matches!(
            skipped[0].error,
            graph::DependencyError::MissingDependency { .. }
        ));
    }

    /// A cycle among pre-installed plugins is skipped, not seeded (and never hangs).
    #[test]
    fn a_cycle_is_skipped() {
        let specs = [spec("a"), spec("b")];
        let manifests = vec![
            manifest("a", "1.0.0", &["b"]),
            manifest("b", "1.0.0", &["a"]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(ordered.is_empty());
        assert_eq!(skipped.len(), 2, "both ends of the cycle are unsatisfiable");
    }

    /// BACKWARD COMPAT: today NO built-in declares `requires`, so the order must be
    /// exactly the declaration order and nothing may be skipped.
    #[test]
    fn without_requires_the_order_is_the_declaration_order() {
        let specs = [
            spec("@ryu/engines"),
            spec("@ryu/durable"),
            spec("@ryu/goal"),
        ];
        let manifests = vec![
            manifest("@ryu/engines", "1.0.0", &[]),
            manifest("@ryu/durable", "1.0.0", &[]),
            manifest("@ryu/goal", "1.0.0", &[]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(skipped.is_empty());
        assert_eq!(ordered, vec!["@ryu/engines", "@ryu/durable", "@ryu/goal"]);
    }

    /// A spec with no loaded manifest is silently dropped (the pre-graph behaviour:
    /// the version lookup returned `None` and the block did nothing).
    #[test]
    fn a_spec_without_a_manifest_is_dropped() {
        let specs = [spec("@ryu/engines"), spec("not-loaded")];
        let manifests = vec![manifest("@ryu/engines", "1.0.0", &[])];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert_eq!(ordered, vec!["@ryu/engines"]);
        assert!(skipped.is_empty(), "absent != unsatisfiable");
    }

    /// A fresh install must seed the Pi-extension plugins INSTALLED + ENABLED.
    ///
    /// Pinned separately from the lockstep check below because the failure is
    /// invisible: `pi_config::app_extensions` resolves over the *enabled record set*,
    /// so an id that never gets an enabled record materializes nothing and the
    /// flagship agent silently loses background bash, sub-agents and the monitor.
    /// Before `pi-shell`/`pi-subagent` were plugins, Core shipped both
    /// unconditionally — a fresh install losing them would be a pure regression,
    /// with a missing tool as its only symptom. `pi-monitor` is net-new but
    /// pre-installed by design (a first-class capability the flagship should have),
    /// so the same guard pins it too.
    ///
    /// The pre-installed axis is enough here: the id is in `CORE_PREINSTALLED` (so
    /// `preinstalled_specs` yields a spec, which the seed loop inserts + enables).
    #[test]
    fn the_pi_extension_plugins_are_seeded_enabled_on_a_fresh_install() {
        let specs = preinstalled_specs();
        for id in ["@ryu/pi-shell", "@ryu/pi-subagent", "@ryu/pi-monitor"] {
            assert!(
                specs.iter().any(|s| s.id == id),
                "'{id}' has no pre-installed seed spec, so a fresh install would never create \
                 an enabled record — and its Pi extension would never be materialized"
            );
            assert!(
                !LEGACY_DISABLED_SEED_IDS.contains(&id),
                "'{id}' must not be a legacy opt-in seed id"
            );
            assert!(
                crate::plugins::builtins::tier_for(id) == crate::plugin_manifest::PluginTier::Core,
                "'{id}' must be Core-tier: may_ship_pi_extensions auto-allows only Core, \
                 and a Community-tier built-in would need the operator-only \
                 'pi:extension' grant to ship anything at all"
            );
        }
    }

    /// The seed table stays in lockstep with `CORE_PREINSTALLED`: every pre-installed id
    /// gets exactly one spec, and the pre-installed companions carry their grants + UI code.
    #[test]
    fn preinstalled_specs_cover_core_preinstalled_exactly() {
        let specs = preinstalled_specs();
        assert_eq!(specs.len(), CORE_PREINSTALLED.len());
        for id in CORE_PREINSTALLED {
            assert_eq!(
                specs.iter().filter(|s| s.id == *id).count(),
                1,
                "'{id}' must have exactly one seed spec"
            );
        }
        let with_ui: Vec<&str> = specs
            .iter()
            .filter(|s| s.ui_code.is_some())
            .map(|s| s.id)
            .collect();
        assert_eq!(
            with_ui,
            vec![
                crate::plugins::builtins::LEARNING_PLUGIN_ID,
                crate::plugins::builtins::WEBHOOKS_PLUGIN_ID,
                crate::plugins::builtins::CALENDAR_PLUGIN_ID,
                crate::plugins::builtins::HELP_CENTER_PLUGIN_ID,
                crate::plugins::builtins::SITES_PLUGIN_ID,
                crate::plugins::builtins::CHAT_BROADCAST_PLUGIN_ID,
            ],
            "only the companions that STAY pre-installed ship their prebuilt UI bundle via \
             the pre-installed seed, in CORE_PREINSTALLED order. The other companion apps \
             (whiteboard/canvas/finetune/meetings/quests/approvals/monitors/workflows/ \
             activity/timeline/skill-editor, plus mail) are opt-in (not pre-installed), so they \
             leave the pre-installed seed — their SeedSpec `ui_code` is carried by \
             explicit install instead, onto the record created by the user, which is what makes \
             enabling one from the Store mount a real UI. `learning` is back in the set: \
             it owns the consent switches for a capture path the kernel runs regardless \
             of the record (see CORE_PREINSTALLED)"
        );
        // Non-companion Core plugins seed with EMPTY grants, exactly as the generic
        // loop did before this module existed.
        let engines = specs.iter().find(|s| s.id == "@ryu/engines").unwrap();
        assert!(engines.grants.is_empty());
    }

    /// The upgrade path for a grant SPLIT: a record enabled before `quests:capture`
    /// existed must gain it, without losing what it had or changing whether it is on.
    #[tokio::test]
    async fn backfill_adds_a_newly_declared_grant_to_an_existing_record() {
        let store = PluginStore::open_in_memory().unwrap();
        let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(id, &["quests:crud".to_owned()])
            .await
            .unwrap();

        super::backfill_declared_grants(&store).await;

        let record = store.get(id).await.unwrap().unwrap();
        assert!(record.approved_grants.iter().any(|g| g == "quests:crud"));
        assert!(record.approved_grants.iter().any(|g| g == "quests:capture"));
        assert!(record.enabled, "backfill must not change the enabled bit");
    }

    /// Additive only: a grant the user's record carries that the build does not
    /// declare survives the backfill.
    #[tokio::test]
    async fn backfill_never_removes_a_grant() {
        let store = PluginStore::open_in_memory().unwrap();
        let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(
                id,
                &["quests:crud".to_owned(), "something:extra".to_owned()],
            )
            .await
            .unwrap();

        super::backfill_declared_grants(&store).await;

        let record = store.get(id).await.unwrap().unwrap();
        assert!(record
            .approved_grants
            .iter()
            .any(|g| g == "something:extra"));
        assert!(record.approved_grants.iter().any(|g| g == "quests:capture"));
    }

    /// A DISABLED app is not re-granted. `set_disabled` wipes `approved_grants` —
    /// disabling revokes consent — so a backfill that re-added them would silently
    /// undo the user's decision.
    #[tokio::test]
    async fn backfill_leaves_a_disabled_app_revoked() {
        let store = PluginStore::open_in_memory().unwrap();
        let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(id, &["quests:crud".to_owned()])
            .await
            .unwrap();
        store.set_disabled(id).await.unwrap();

        super::backfill_declared_grants(&store).await;

        let record = store.get(id).await.unwrap().unwrap();
        assert!(!record.enabled, "a disabled app must stay disabled");
        assert!(
            record.approved_grants.is_empty(),
            "disabling revoked its grants; the backfill must not hand them back"
        );
    }

    /// No record = nothing installed. Installing is the seed's job, not the
    /// backfill's, so it must not conjure one.
    #[tokio::test]
    async fn backfill_does_not_create_a_record() {
        let store = PluginStore::open_in_memory().unwrap();
        super::backfill_declared_grants(&store).await;
        assert!(store
            .get(crate::plugins::builtins::QUESTS_PLUGIN_ID)
            .await
            .unwrap()
            .is_none());
    }

    /// End-to-end over the real store: a fresh install seeds every pre-installed
    /// plugin enabled, and a second run never re-seeds (a user's disable sticks).
    #[tokio::test]
    async fn seeding_is_one_time_and_respects_a_user_disable() {
        let store = PluginStore::open_in_memory().unwrap();
        let manifests = vec![
            manifest("@ryu/engines", "1.0.0", &[]),
            manifest("@ryu/durable", "1.0.0", &[]),
        ];
        let specs = [spec("@ryu/engines"), spec("@ryu/durable")];
        let (ordered, _) = seed_order(&specs, &manifests);
        assert_eq!(ordered.len(), 2);

        // Simulate the seed for this synthetic set (seed_preinstalled drives the real
        // CORE_PREINSTALLED table; the store behaviour under test is identical).
        for id in &ordered {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }
        // The user disables one.
        store.set_disabled("@ryu/durable").await.unwrap();

        // A re-seed must leave it disabled: a present record always wins.
        for id in &ordered {
            if store.get(id).await.unwrap().is_some() {
                continue;
            }
            store.set_enabled(id, &[]).await.unwrap();
        }
        assert!(store.get("@ryu/engines").await.unwrap().unwrap().enabled);
        assert!(!store.get("@ryu/durable").await.unwrap().unwrap().enabled);
    }

    /// A catalog materializer creates the lifecycle row before the pre-installed
    /// pass runs. Only rows it created on this boot may be enabled; an older
    /// disabled row remains the user's choice.
    #[tokio::test]
    async fn newly_materialized_preinstalled_is_enabled_without_resurrecting_disabled_state() {
        let store = PluginStore::open_in_memory().unwrap();
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let user_disabled = "@ryu/goal";
        let newly_materialized = "@ryu/proof";

        store.insert(user_disabled, "1.0.0").await.unwrap();
        store.set_disabled(user_disabled).await.unwrap();
        store.insert(newly_materialized, "1.0.0").await.unwrap();

        let materialized = std::collections::HashSet::from([newly_materialized.to_owned()]);
        seed_preinstalled_with_materialized(&store, &manifests, &materialized).await;

        assert!(!store.get(user_disabled).await.unwrap().unwrap().enabled);
        assert!(
            store
                .get(newly_materialized)
                .await
                .unwrap()
                .unwrap()
                .enabled
        );
    }

    /// The W7 Mail-companion extraction used to rest on mail having a legacy disabled
    /// seed record: it was the first opt-in built-in companion, so the pre-installed loop
    /// never touched it, and the record existed purely to carry its `ui_code`.
    ///
    /// Mail is now install-on-demand, so a fresh store carries no mail record at
    /// all and the bundle arrives from `lifecycle::install_app` instead. The property
    /// the extraction actually needs is unchanged and still pinned here: whatever path
    /// puts mail on the machine, the compiled-in bundle must come with it, or enabling
    /// mail mounts a broken "no runnable UI" companion.
    #[tokio::test]
    async fn mail_stays_absent_until_install_and_carries_its_bundle() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_preinstalled(&store, &manifests).await;

        let mail_id = crate::plugins::builtins::MAIL_PLUGIN_ID;
        assert!(
            store.get(mail_id).await.unwrap().is_none(),
            "mail must not receive a seed record — an unconfigured inbox has no business \
             appearing as Installed on a fresh machine"
        );
        let manifest = manifests
            .iter()
            .find(|manifest| manifest.id == mail_id)
            .expect("mail manifest");
        crate::plugins::lifecycle::install_app(&store, manifest)
            .await
            .unwrap();
        assert!(!store.get(mail_id).await.unwrap().unwrap().enabled);
        assert!(store.has_ui_code(mail_id).await.unwrap());
        let ui = compiled_in_ui_code(mail_id)
            .expect("mail must still ship a compiled-in bundle for install_app to source");
        assert!(
            ui.len() > 10_000 && ui.contains('<'),
            "mail ui_code must be the real inlined companion bundle, got {} bytes",
            ui.len()
        );
    }

    /// THE A3 regression, re-pointed. ELEVEN not pre-installed built-in companions once
    /// carried a real, size-guarded `ui_code` in `seed_overrides` that NOTHING ever
    /// wrote, so enabling any of them from the Store mounted "this app has no
    /// interface" (the contributions payload's `has_ui` reads `has_ui_code`).
    ///
    /// The old fix was to create a DISABLED record carrying the bundle. That is no
    /// longer the posture: every one of those ids is install-on-demand, so a fresh
    /// store has no record for them and `lifecycle::install_app` carries the bundle
    /// at Install time instead.
    ///
    /// What must never come back is the limbo state in between — an app that is
    /// automatically-created, disabled, and bundle-less. So this asserts the INVARIANT rather
    /// than a list: every compiled-in companion bundle is reachable by exactly one of
    /// the two live carriages (pre-installed seed, or install-time sourcing), and no
    /// companion sits in a third state where neither runs.
    #[tokio::test]
    async fn every_companion_bundle_has_a_live_carriage() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_preinstalled(&store, &manifests).await;

        // Non-vacuous: there are companion bundles to account for at all.
        let specs = companion_ui_specs();
        assert!(
            specs.len() >= 10,
            "expected the real companion bundle set, got {}",
            specs.len()
        );

        for spec in specs {
            let id = spec.id;
            let opt_in = !CORE_PREINSTALLED.contains(&id);
            assert!(
                !opt_in || store.get(id).await.unwrap().is_none(),
                "'{id}' must either be pre-installed or absent until explicit install"
            );

            // Whichever path owns it, the bundle itself must be real.
            let ui = compiled_in_ui_code(id)
                .unwrap_or_else(|| panic!("'{id}' must ship a compiled-in bundle"));
            assert!(
                ui.len() > 10_000 && ui.contains('<'),
                "'{id}' ui_code must be the real inlined companion bundle, got {} bytes",
                ui.len()
            );

            if opt_in {
                assert!(
                    store.get(id).await.unwrap().is_none(),
                    "'{id}' is opt-in, so a fresh store must carry no record"
                );
            } else {
                let record = store
                    .get(id)
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("pre-installed '{id}' must be seeded"));
                assert!(
                    record.enabled,
                    "pre-installed '{id}' must be seeded enabled"
                );
            }
        }
    }

    /// The end state for the former legacy-seeded apps, and the reason dropping the
    /// old seed is safe rather than a regression: a fresh store has NO record for
    /// them (so the Store lists them as available, not "Installed (off)"), and the
    /// ordinary `install_app` carries the compiled-in bundle so a one-click Install
    /// lands the exact record the old seed used to write.
    ///
    /// Both halves matter. Asserting only the absence would pass just as well for the
    /// broken version of this change — the one where the old seed is gone, nothing
    /// replaces it, and enabling the app from the Store mounts "this app has no
    /// interface" (the A3 regression the sibling test above exists for). The install
    /// leg is what proves the carriage moved instead of disappearing.
    #[tokio::test]
    async fn opt_in_apps_get_no_record_but_stay_fully_installable() {
        use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};

        // Non-vacuous, and pinned by name: this is a product decision, so a silent
        // emptying of the list must fail here rather than quietly recreate records.
        for id in [WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID] {
            assert!(
                LEGACY_DISABLED_SEED_IDS.contains(&id),
                "'{id}' must be covered by the legacy cleanup set"
            );
            assert!(
                !CORE_PREINSTALLED.contains(&id),
                "'{id}' cannot be pre-installed and opt-in"
            );
        }

        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_preinstalled(&store, &manifests).await;

        for id in LEGACY_DISABLED_SEED_IDS {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' must not receive a lifecycle record from the seed — a fresh install must carry no \
                 record for it at all"
            );

            // …and the Store's Install must still deliver a mountable app.
            let manifest = manifests
                .iter()
                .find(|m| m.id == *id)
                .unwrap_or_else(|| panic!("'{id}' must be a compiled-in built-in manifest"));
            crate::plugins::lifecycle::install_app(&store, manifest)
                .await
                .unwrap();

            let record = store.get(id).await.unwrap().expect("installed");
            assert!(
                !record.enabled,
                "install must leave '{id}' DISABLED — Enable is a separate, Gateway-validated \
                 step"
            );

            // The bundle leg applies only to COMPANION apps — the ones whose UI is a
            // compiled-in `ui_code` blob. The five sidecar apps demoted out of
            // `CORE_PREINSTALLED` are also install-on-demand but ship no such blob:
            // their UI is served by their own sidecar over the ext-proxy, so there is
            // no carriage to prove and `get_ui_code` is legitimately None. Keyed off
            // `compiled_in_ui_code` rather than an id list so it cannot rot, and
            // asserted in BOTH directions below so the branch can never become a
            // silent escape hatch for a companion that lost its bundle.
            let Some(_) = compiled_in_ui_code(id) else {
                assert!(
                    DEMOTED_FROM_PREINSTALLED_V5.contains(id),
                    "'{id}' has no compiled-in companion bundle, so its Install cannot attach \
                     one. That is only correct for a sidecar-served app; if '{id}' is a \
                     companion, this is the A3 regression — it will mount as \"this app has \
                     no interface\""
                );
                continue;
            };
            let ui = store.get_ui_code(id).await.unwrap().unwrap_or_else(|| {
                panic!(
                    "installing '{id}' must attach its compiled-in companion bundle, or enabling \
                     it mounts \"this app has no interface\""
                )
            });
            assert!(
                ui.len() > 10_000 && ui.contains('<'),
                "'{id}' ui_code must be the real inlined companion bundle, got {} bytes",
                ui.len()
            );
        }
    }

    /// A second boot must not create opt-in records: the companion backfill runs on
    /// EVERY boot, so the absence guarantee has to hold for an existing store too.
    #[tokio::test]
    async fn a_reboot_never_creates_an_opt_in_record() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_preinstalled(&store, &manifests).await;
        seed_preinstalled(&store, &manifests).await;
        seed_preinstalled(&store, &manifests).await;

        for id in LEGACY_DISABLED_SEED_IDS {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' came back on a later boot — an uninstall must survive a restart"
            );
        }
    }

    /// The case-2 back-fill must keep working for a user who DID enable one of these:
    /// the skip is only on the record-CREATION branch, so an existing record whose
    /// bundle is missing is still repaired. Getting this wrong would strand exactly
    /// the users who use the feature.
    #[tokio::test]
    async fn an_existing_opt_in_record_still_gets_its_bundle() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        let id = LEGACY_DISABLED_SEED_IDS[0];
        // A legacy record with no bundle (`store.insert` writes none).
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(id, &["spaces:docs".to_owned()])
            .await
            .unwrap();

        seed_preinstalled(&store, &manifests).await;

        assert!(
            store.has_ui_code(id).await.unwrap(),
            "'{id}' has an existing record, so the companion-ui back-fill must still fill its \
             missing bundle"
        );
        assert!(
            store.get(id).await.unwrap().unwrap().enabled,
            "the back-fill must never touch the enabled bit"
        );
    }

    /// The carriage list is DERIVED from `seed_overrides`, never a second hardcoded
    /// array — that duplication is what left eleven companions with an unreachable
    /// bundle. A 17th companion row therefore needs no second edit: it is picked up
    /// by the pre-installed loop (if pre-installed) or by explicit install (if not), and
    /// this asserts both halves are non-empty so neither branch can rot unnoticed.
    #[test]
    fn the_companion_bundle_carriage_is_derived_from_the_one_table() {
        let with_ui: Vec<&str> = seed_overrides()
            .iter()
            .filter(|s| s.ui_code.is_some())
            .map(|s| s.id)
            .collect();
        assert!(
            !with_ui.is_empty(),
            "seed_overrides must carry compiled-in companion bundles"
        );
        let carried: Vec<&str> = companion_ui_specs().into_iter().map(|s| s.id).collect();
        assert_eq!(
            carried, with_ui,
            "every seed_overrides row with a ui_code must be carried, in table order"
        );
        assert!(
            carried.iter().any(|id| CORE_PREINSTALLED.contains(id)),
            "some companions are pre-installed (their bundle rides the enable loop)"
        );
        assert!(
            carried.iter().any(|id| !CORE_PREINSTALLED.contains(id)),
            "some companions are opt-in (their bundle rides explicit install)"
        );
    }

    /// The UPGRADE half of the repair. Several of these apps began life as wave-2
    /// route-gate governance shells and only gained a companion runnable in the W7
    /// extraction, so a pre-existing install carries a record written before any
    /// bundle existed — and the seed loop leaves every existing record alone
    /// (`Ok(Some(_)) => continue`), which is right for enable/disable and wrong for
    /// build content. Filling it must not disturb one bit of user state.
    #[tokio::test]
    async fn a_pre_existing_record_without_a_bundle_is_filled_without_touching_user_state() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;

        // The pre-upgrade state: installed + enabled with its grant, no ui_code.
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_enabled(id, &["quests:crud".to_owned()])
            .await
            .unwrap();
        assert!(!store.has_ui_code(id).await.unwrap());

        seed_preinstalled(&store, &manifests).await;

        let ui =
            store.get_ui_code(id).await.unwrap().expect(
                "a record predating the bundle must be back-filled, not left mounting empty",
            );
        assert!(ui.len() > 10_000 && ui.contains('<'));
        let record = store.get(id).await.unwrap().unwrap();
        assert!(record.enabled, "the fill must not disturb enabled state");
        // The bundle fill itself rewrites NO grants. The pass as a whole is allowed
        // to ADD one the build declares (`backfill_declared_grants`) — that is not
        // user state — but the grant the record already had must survive verbatim,
        // and nothing may be dropped.
        assert!(
            record.approved_grants.iter().any(|g| g == "quests:crud"),
            "the fill must not drop a grant the record already had"
        );
        assert!(
            record.approved_grants.iter().all(|g| seed_overrides()
                .iter()
                .any(|spec| spec.id == id && spec.grants.contains(&g.as_str()))),
            "the pass must only ever add grants the build itself declares"
        );
        assert_eq!(
            record.version, "1.0.0",
            "the fill must not silently re-version the record"
        );
    }

    /// Only ever FILLS a gap. A record that already carries a bundle keeps it —
    /// otherwise every boot would clobber whatever the update lifecycle installed
    /// (`update_app` is the one other `set_ui_code` writer) with the compiled-in
    /// build, which is a downgrade dressed up as a repair.
    #[tokio::test]
    async fn an_existing_companion_bundle_is_never_overwritten() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();
        let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
        const SENTINEL: &str = "<!-- installed by the update lifecycle -->";

        store.insert(id, "1.0.0").await.unwrap();
        store.set_ui_code(id, Some(SENTINEL)).await.unwrap();

        seed_preinstalled(&store, &manifests).await;

        assert_eq!(
            store.get_ui_code(id).await.unwrap().as_deref(),
            Some(SENTINEL),
            "a stored bundle must never be overwritten by the compiled-in one"
        );
    }

    /// Every [`seed_overrides`] row must approve EXACTLY what its manifest declares
    /// in `permission_grants` — no more, no less.
    ///
    /// # Why this is a test and not derived code
    ///
    /// The obvious "cleanup" here is to delete `SeedSpec::grants` and read
    /// `manifest.permission_grants` at seed time. That would be a privilege
    /// escalation, not a refactor. A plugin with NO row seeds with `grants: &[]`
    /// (see [`preinstalled_specs`]), and ten pre-installed plugins are in exactly that
    /// state while declaring grants in their manifests — `agentbrowser` and `exa`
    /// declare `tool:execute`, `ghost` declares `mcp:ghost`, `shadow` and `exa`
    /// declare `tool:http-egress:*`. Deriving would pre-approve all of it at seed
    /// time, when the Gateway is not reachable to refuse anything, and would leave
    /// any built-in able to widen its own approved set by editing its own manifest.
    ///
    /// This table is therefore a HUMAN-REVIEWED ALLOWLIST that is deliberately
    /// narrower than the union of what manifests ask for. The same judgement is
    /// already visible in [`backfill_host_api_grants`], which takes only the
    /// `sidecars[].host_api.grants` INTERSECTED with `permission_grants` rather
    /// than trusting the declaration.
    ///
    /// What is genuinely worth enforcing is that a row and its manifest do not
    /// DRIFT: an over-grant hands a frame a capability its manifest never asked
    /// for and the Gateway never reviewed, and an under-grant ships a companion
    /// whose frame is refused a capability it actually uses — the failure mode the
    /// `recipes` row's comment describes. Both are caught here, at compile-and-test
    /// time, without surrendering the allowlist.
    #[test]
    fn seed_grants_match_the_manifest_they_belong_to() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let mut checked = 0;

        for spec in seed_overrides() {
            let Some(manifest) = manifests.iter().find(|m| m.id == spec.id) else {
                panic!(
                    "seed row '{}' has no compiled-in manifest — add it to BUILTIN_MANIFESTS \
                     or drop the row",
                    spec.id
                );
            };

            let mut approved: Vec<&str> = spec.grants.to_vec();
            approved.sort_unstable();
            let mut declared: Vec<&str> = manifest
                .permission_grants
                .iter()
                .map(String::as_str)
                .collect();
            declared.sort_unstable();

            assert_eq!(
                approved, declared,
                "seed row '{}' and its manifest disagree on grants.\n  \
                 seed approves: {approved:?}\n  manifest declares: {declared:?}\n\
                 Extra in the seed is an UNREVIEWED grant; extra in the manifest means \
                 the app's frame will be refused a capability it uses. Fix whichever \
                 side is wrong — do not derive one from the other (see this test's docs).",
                spec.id
            );
            checked += 1;
        }

        assert_eq!(
            checked,
            seed_overrides().len(),
            "every seed row must be covered"
        );
    }
}
