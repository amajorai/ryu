//! Rows of the seed override table (see `super::seed_overrides`).
//!
//! test-exempt: a constant table; `seed_grants_match_the_manifest_they_belong_to`
//! and the companion-carriage tests in `super::tests` cover every row.

use super::SeedSpec;
use crate::plugin_manifest::{
    APPROVALS_UI_HTML, AUTOPILOT_UI_HTML, BOT_FLOWS_UI_HTML, CHAT_BROADCAST_UI_HTML,
    EXPENSES_UI_HTML, FAMILY_UI_HTML, FORMS_UI_HTML, INVOICES_UI_HTML, LEARNING_UI_HTML,
    NEWS_UI_HTML, OUTREACH_UI_HTML, PROJECTS_UI_HTML, SITES_UI_HTML, SKILL_EDITOR_UI_HTML,
    TIMELINE_UI_HTML, TUITION_UI_HTML,
};
use crate::plugins::builtins::CHAT_BROADCAST_PLUGIN_ID;

pub(super) fn rows() -> [SeedSpec; 18] {
    [
        SeedSpec {
            id: crate::plugins::builtins::SITES_PLUGIN_ID,
            // Sites is pre-installed and its managed sidecar declares these
            // host capabilities. Persist the reviewed manifest set here because
            // fresh-install seeding cannot call the Gateway grant validator.
            grants: &[
                "app:http",
                "hook:side-model",
                "hook:run-agent",
                "hook:run-agent:write",
                "spaces:docs",
                "spaces:database",
                "identity:read",
                "security:check",
                "tools.invoke",
                "plugins:install",
                // The same sidecar binary exposes `sites.*` MCP tools to agents
                // (`ryu-sites mcp`), which call the running Sites service with the
                // same owner/editor checks as the companion.
                "mcp:sites",
                // The sidecar seals uploads, records and Site state under the
                // Sites subkey.
                "crypto:seal",
            ],
            ui_code: Some(SITES_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::FORMS_PLUGIN_ID,
            // `crypto:seal`: the sidecar seals respondent answers under the
            // Forms subkey.
            grants: &["app:http", "crypto:seal"],
            ui_code: Some(FORMS_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/bot-flows",
            // The companion is the flow builder over the satellite sidecar that
            // also serves the public chat pages. It uses the generic own-app HTTP
            // bridge, the shared side-model lane for "Generate flow from
            // description", and hands page context to the global assistant.
            // Core does not carry bot routes.
            grants: &["app:http", "hook:side-model", "assistant:context"],
            ui_code: Some(BOT_FLOWS_UI_HTML),
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
            id: crate::plugins::builtins::BROWSER_PLUGIN_ID,
            // A grants-only spec (no companion UI). The browser sidecar fills an
            // agent's own website login into a page through the
            // `vault.credentialFill` / `vault.totpEnroll` kernel capabilities, which
            // the capability broker authorises against the stored
            // `approved_grants` (`vault:fill`). Without this row a pre-installed
            // browser is enabled with no grants and every fill 403s;
            // `backfill_declared_grants` carries it onto records that predate the
            // row. The set mirrors the manifest exactly; `vault:fill` and
            // `security-key:relay` (the `securityKey.request` relay to the owner's
            // desktop key) are approved only for this app (Gateway owner-exclusive
            // grants), the other two are on the reviewed allowlist.
            grants: &[
                "browser:control",
                "tool:http-egress:127.0.0.1",
                "vault:fill",
                "security-key:relay",
            ],
            ui_code: None,
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
            id: "@ryu/family",
            // The companion is the family hub over the same sidecar that exposes
            // `family.*` MCP tools to the planner agent. It uses only the generic
            // own-app HTTP bridge; Core does not carry family routes.
            grants: &["app:http", "mcp:family"],
            ui_code: Some(FAMILY_UI_HTML),
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
                "hook:run-agent:write",
                "storage:kv",
                "core:list_agents",
                "shell:integrate",
                "ui:toast",
            ],
            ui_code: Some(AUTOPILOT_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::PROJECTS_PLUGIN_ID,
            grants: &[
                "app:http",
                "tool:http-egress:127.0.0.1",
                "chat.sendFollowUp",
                "chat:project-guidance",
                // The sidecar seals its records under the Projects subkey.
                "crypto:seal",
                "shell:integrate",
                "spaces:docs",
                "storage:kv",
                "ui:toast",
            ],
            ui_code: Some(PROJECTS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::INVOICES_PLUGIN_ID,
            grants: &["storage:kv", "shell:integrate", "ui:toast"],
            ui_code: Some(INVOICES_UI_HTML),
        },
    ]
}
