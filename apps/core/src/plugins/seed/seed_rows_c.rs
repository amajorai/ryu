//! Rows of the seed override table (see `super::seed_overrides`).
//!
//! test-exempt: a constant table; `seed_grants_match_the_manifest_they_belong_to`
//! and the companion-carriage tests in `super::tests` cover every row.

use super::SeedSpec;
use crate::plugin_manifest::{
    BLUEPRINT_UI_HTML, CLIPS_UI_HTML, MAIL_UI_HTML, PEOPLE_UI_HTML, PULL_REQUESTS_UI_HTML,
    REASONING_PLUGIN_ID, REASONING_UI_HTML, RLM_UI_HTML, SECURITY_UI_HTML, WARMUP_UI_HTML,
};

pub(super) fn rows() -> [SeedSpec; 10] {
    [
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
            // `tool:execute` runs the sandboxed adapters that map the `verify.*`
            // Toolkit verbs onto `reasoning.check` / `reasoning.policies`.
            grants: &[
                "reasoning:check",
                "hook:side-model",
                "hook:run-agent",
                "mcp:reasoning",
                "tool:execute",
                "ui:declarative-http",
            ],
            ui_code: Some(REASONING_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::CLIPS_PLUGIN_ID,
            // Clips is opt-in because its sidecar can capture the user's screen. The
            // Companion uses the generic app:http bridge and downloads an export only
            // after the user requests it; capture/ingest stays permission-level gated.
            grants: &["app:http", "files:download"],
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
            // Only the grants the companion uses, and the short list is the point.
            // `files:download` backs the explicit artifact export affordance.
            // `mcp:blueprint`
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
            grants: &[
                "blueprint:review",
                "mcp:blueprint",
                "ui:declarative-http",
                "files:download",
            ],
            ui_code: Some(BLUEPRINT_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/pull-requests",
            // Opt-in. `app:http` unlocks only the generic own-sidecar forwarder;
            // `shell:integrate` supplies live theme updates; `assistant:context`
            // hands the selected pull request to the global Ask Ryu assistant. The
            // enable path persists the Gateway-approved set, while this row carries
            // the compiled UI.
            grants: &["app:http", "shell:integrate", "assistant:context"],
            ui_code: Some(PULL_REQUESTS_UI_HTML),
        },
        SeedSpec {
            id: "@ryu/security",
            // Security is opt-in because enabling it grants a local process read
            // access to an explicitly selected repository. The Companion only
            // needs the generic app:http bridge; the sidecar owns path validation
            // and never applies a generated proposal.
            grants: &["app:http"],
            ui_code: Some(SECURITY_UI_HTML),
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
