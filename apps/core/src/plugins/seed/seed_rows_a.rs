//! Rows of the seed override table (see `super::seed_overrides`).
//!
//! test-exempt: a constant table; `seed_grants_match_the_manifest_they_belong_to`
//! and the companion-carriage tests in `super::tests` cover every row.

use super::SeedSpec;
use crate::plugin_manifest::{
    ACTIVITY_UI_HTML, APP_STUDIO_UI_HTML, CALENDAR_UI_HTML, CANVAS_PLUGIN_ID, CANVAS_UI_HTML,
    CONVERT_PLUGIN_ID, CONVERT_UI_HTML, DRAWSOME_PLUGIN_ID, DRAWSOME_UI_HTML, FINETUNE_PLUGIN_ID,
    FINETUNE_UI_HTML, HELP_CENTER_UI_HTML, MEETINGS_UI_HTML, MONITORS_UI_HTML, QUESTS_UI_HTML,
    SLIDES_PLUGIN_ID, SLIDES_UI_HTML, SOCIAL_UI_HTML, SUBTITLES_UI_HTML, WEBHOOKS_UI_HTML,
    WHITEBOARD_PLUGIN_ID, WHITEBOARD_UI_HTML, WORKFLOWS_UI_HTML,
};

pub(super) fn rows() -> [SeedSpec; 17] {
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
            id: CONVERT_PLUGIN_ID,
            // Convert persists bounded metadata, emits optional host toasts, and
            // downloads converted results only after the user requests them. File
            // bytes are read and transformed inside the Companion document.
            grants: &["storage:kv", "ui:toast", "files:download"],
            ui_code: Some(CONVERT_UI_HTML),
        },
        SeedSpec {
            id: SLIDES_PLUGIN_ID,
            // The editor persists its own gallery and uses the generic Ryu model,
            // media, upload, and user-requested file-download bridges. It is opt-in,
            // so this row supplies the verified bundle and grants when the user
            // explicitly installs it.
            grants: &[
                "storage:kv",
                "media:generate",
                "hook:side-model",
                "files:download",
            ],
            ui_code: Some(SLIDES_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/app-studio",
            // Its frame keeps drafts in its own app storage, edits through the
            // governed side-model bridge, and installs the companion-only apps it
            // builds via the host-validated `apps.installBundle` bridge
            // (`plugins:install`). Opt-in: this row supplies the verified bundle and
            // grants when the user explicitly installs it.
            grants: &[
                "storage:kv",
                "hook:side-model",
                "ui:toast",
                "plugins:install",
            ],
            ui_code: Some(APP_STUDIO_UI_HTML),
        },
        SeedSpec {
            id: FINETUNE_PLUGIN_ID,
            // The companion drives its own `ryu-finetune` sidecar through the generic
            // ext-proxy (`app:http`) and keeps `finetune:runs` for the live progress
            // stream. Its Unsloth training sidecar spawns on the
            // Core-tier auto-run path (`may_run_sidecar` is unconditional for Core), so it
            // must NOT declare `sidecar:process` — the Gateway validates + denies that
            // grant at enable (same fix as mail, commit 9faf67be). Grants mirror the
            // manifest's `permission_grants` exactly.
            grants: &["app:http", "finetune:runs"],
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
            //
            // Recaps add `app:http` (its UI calls its own `/api/ext/@ryu/meetings/recaps`
            // routes), `assistant:context` (hands a recap to the global Ask Ryu assistant)
            // and `notifications:send-to-user` (the recap-ready and digest notices).
            grants: &[
                "spaces:docs",
                "meetings:crud",
                "ui:toast",
                "ui:declarative-http",
                "app:http",
                "assistant:context",
                "notifications:send-to-user",
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
            // `subscriptions:read` feeds the provider-reset form's provider and
            // account pickers (owner/admin only, enforced again in Core).
            grants: &[
                "monitors:crud",
                "subscriptions:read",
                "tools.invoke",
                "ui:declarative-http",
            ],
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
                // The recipe picker reads the Recipes app's list route through the
                // cross-app `app.request` bridge (reviewed per-target grant).
                "app:http:@ryu/recipes",
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
            grants: &["activity:read", "activity:run", "shell:integrate"],
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
    ]
}
