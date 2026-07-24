//! Default-on plugin seeding — the ONE definition of "what is enabled on a fresh
//! install".
//!
//! # Why this is not `lifecycle::enable_app`
//!
//! Seeding runs during startup, **before the Gateway sidecar is spawned**
//! (`main.rs` starts it well after this; the gateway-policy seed comment says the
//! same). `enable_app` fails **closed** on an unreachable Gateway, so routing the
//! seed through it would leave every default-on plugin disabled on every fresh
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
//!    (the declaration order of [`crate::plugins::builtins::CORE_DEFAULT_ON`] is
//!    NOT topological, and must not have to be).
//! 2. **Fail-closed satisfiability** — a default-on plugin whose `requires` cannot
//!    be satisfied *from within the default-on set* is SKIPPED (logged loudly),
//!    never seeded enabled with a missing dependency.
//!
//! # The default-on set is the universe
//!
//! [`seed_order`] resolves each plugin against the default-on manifests **only**.
//! A default-on plugin that depends on an opt-in plugin therefore reports
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
use crate::plugins::{builtins::CORE_DEFAULT_ON, graph, PluginStore};

/// One default-on plugin and everything the seed must write for it.
#[derive(Debug, Clone, Copy)]
pub struct SeedSpec {
    /// Manifest id.
    pub id: &'static str,
    /// Grants to persist as approved. The Gateway is not reachable at seed time,
    /// so these are the fixed first-party set (empty for most Core plugins; the
    /// companions need theirs to drive Spaces/media/finetune from their frames).
    pub grants: &'static [&'static str],
    /// Prebuilt companion UI bundle, when the plugin ships one.
    pub ui_code: Option<&'static str>,
}

/// Plugins that need more than `insert + set_enabled(&[])`: explicit grants and/or
/// a prebuilt `ui_code` bundle. Everything else in [`CORE_DEFAULT_ON`] seeds with
/// empty grants and no UI code (unchanged from the pre-graph behaviour).
///
/// The three companions need a UI bundle + the grants their sandboxed frames use.
/// `meetings` needs only a grant: it ships no frame (its code is in-crate), but it
/// really does write Space documents, so its approved grants must match the
/// `permission_grants` its manifest declares — otherwise the record would claim
/// less than the app does.
fn seed_overrides() -> [SeedSpec; 14] {
    use crate::plugin_manifest::{
        ACTIVITY_UI_HTML, APPROVALS_UI_HTML, CALENDAR_UI_HTML, CANVAS_PLUGIN_ID, CANVAS_UI_HTML,
        FINETUNE_PLUGIN_ID, FINETUNE_UI_HTML, LEARNING_UI_HTML, MEETINGS_UI_HTML, MONITORS_UI_HTML,
        QUESTS_UI_HTML, SKILL_EDITOR_UI_HTML, TIMELINE_UI_HTML, WEBHOOKS_UI_HTML,
        WHITEBOARD_PLUGIN_ID, WHITEBOARD_UI_HTML, WORKFLOWS_UI_HTML,
    };
    [
        SeedSpec {
            id: WHITEBOARD_PLUGIN_ID,
            // Its sandboxed frame owns Space documents + AI-generates.
            grants: &["spaces:docs", "hook:side-model"],
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
            ],
            ui_code: Some(CANVAS_UI_HTML),
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
            grants: &["spaces:docs", "meetings:crud"],
            ui_code: Some(MEETINGS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::MONITORS_PLUGIN_ID,
            // Its sandboxed frame drives Core's `/api/monitors/*` orchestration via
            // the `monitors:crud` bridge capability. Ships a prebuilt companion UI.
            grants: &["monitors:crud"],
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
            ],
            ui_code: Some(WORKFLOWS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::WEBHOOKS_PLUGIN_ID,
            // Its sandboxed frame renders Core's read-only webhook endpoint registry
            // (`/api/webhooks` + `/api/webhook-ingress/status`) via the `webhooks:crud`
            // bridge capability (host-direct, monitors pattern). Ships a prebuilt
            // companion UI. Core-tier, so it must NOT declare `sidecar:process`.
            grants: &["webhooks:crud"],
            ui_code: Some(WEBHOOKS_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::QUESTS_PLUGIN_ID,
            // Its sandboxed frame drives Core's `/api/quests/*` auto-detecting-todo
            // orchestration (list/create/update/delete + complete/dismiss + suggestion
            // accept/dismiss + judge) via the `quests:crud` bridge capability (host-direct,
            // monitors pattern). Ships a prebuilt companion UI. Core-tier, so it must NOT
            // declare `sidecar:process` (the Gateway denies that grant at enable).
            grants: &["quests:crud"],
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
            grants: &["calendar:crud"],
            ui_code: Some(CALENDAR_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::LEARNING_PLUGIN_ID,
            // Its sandboxed frame renders the read-only continual-learning surface
            // (the two opt-in levels + models, the experience buffer, and the read-only
            // self-healing attempt history) via the `learning:crud` bridge capability
            // (host-direct, monitors pattern): the host calls the existing
            // `/api/learn/config` + `/api/experience/list` + `/api/healing/status`
            // reads. Ships a prebuilt companion UI. `com.ryu.learning` was a wave-2
            // route-gate governance shell (gating `/api/learn/*` + `/api/experience/*`)
            // that `requires` the `skills` app; the W7 frontend extraction upgrades it
            // in place to ALSO carry the companion runnable — the `requires` edge stays
            // (skills is default-on, so `seed_order` seeds it first). Core-tier, so it
            // must NOT declare `sidecar:process` (the Gateway denies that grant at
            // enable).
            grants: &["learning:crud"],
            ui_code: Some(LEARNING_UI_HTML),
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
            // grants. Ships a prebuilt companion UI. `com.ryu.approvals` was a wave-2
            // gate-only governance shell (gating `/api/approvals/*`); the W7 frontend
            // extraction upgrades it in place to ALSO carry the companion runnable.
            // It ALSO holds `shell:integrate` — the generic shell-primitive lane
            // (`docs/renderer-host-slice-1.md`): the "open in chat" action opens a new
            // chat tab through the route-allowlisted `shell.openTab` (replacing the old
            // bespoke `suggestions.openInChat` verb), and the frame subscribes to the
            // live host theme. Core-tier, so it must NOT declare `sidecar:process` (the
            // Gateway denies that grant at enable).
            grants: &["approvals:crud", "quests:crud", "shell:integrate"],
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
            grants: &["skills:crud", "shell:integrate"],
            ui_code: Some(SKILL_EDITOR_UI_HTML),
        },
    ]
}

/// The full default-on seed table, in declaration order.
///
/// One list, derived from [`CORE_DEFAULT_ON`] — the overridden plugins are the same
/// ids with richer specs, so a plugin can never be default-on in one list and absent
/// from the other.
pub fn default_on_specs() -> Vec<SeedSpec> {
    let overrides = seed_overrides();
    CORE_DEFAULT_ON
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

/// A default-on plugin that could not be seeded, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSeed {
    pub id: String,
    pub error: graph::DependencyError,
}

/// Order the default-on set so every dependency precedes its dependents, and
/// separate out the plugins whose `requires` cannot be satisfied.
///
/// Pure: no store, no I/O. `manifests` is the loaded manifest set; specs with no
/// loaded manifest are dropped (nothing to seed), exactly as before.
///
/// Returns `(ordered_ids, skipped)`. `ordered_ids` is a valid topological order of
/// the seedable default-on plugins; `skipped` names the ones whose dependency graph
/// is unsatisfiable *within the default-on set* — they are NOT enabled (fail-closed).
pub fn seed_order(
    specs: &[SeedSpec],
    manifests: &[PluginManifest],
) -> (Vec<String>, Vec<SkippedSeed>) {
    // Lower capability edges (`requires.capabilities`) to concrete app-id edges
    // FIRST, resolving providers against the FULL installed set, so a `requires:[rag]`
    // consumer's provider is materialized as an ordinary dependency the graph honors.
    // The universe for resolution stays the default-on set (see module docs) — so a
    // default-on consumer whose capability provider is NOT default-on becomes an edge
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

/// Seed the default-on plugins on a fresh install: install + enable each, in
/// dependency order.
///
/// One-time and user-respecting: a plugin with ANY existing record (enabled OR
/// disabled) is left alone, so a user who disables a default-on plugin keeps it
/// disabled across restarts.
pub async fn seed_default_on(store: &PluginStore, manifests: &[PluginManifest]) {
    let specs = default_on_specs();
    let (ordered, skipped) = seed_order(&specs, manifests);

    for s in &skipped {
        tracing::error!(
            "default-on seed: SKIPPING '{}' — its dependencies cannot be satisfied from the \
             default-on set: {}. It stays disabled (fail-closed); enabling it by hand will \
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
            // A record exists (enabled or disabled) — the user's choice wins.
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("default-on seed: lookup '{id}' failed: {e}");
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

        if let Err(e) = store.insert(id, &version).await {
            tracing::warn!("default-on seed: insert '{id}' failed: {e}");
            continue;
        }
        if let Some(ui_code) = spec.ui_code {
            if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                tracing::warn!("default-on seed: set_ui_code '{id}' failed: {e}");
                continue;
            }
        }
        let grants: Vec<String> = spec.grants.iter().map(|g| (*g).to_owned()).collect();
        if let Err(e) = store.set_enabled(id, &grants).await {
            tracing::warn!("default-on seed: enable '{id}' failed: {e}");
        } else {
            tracing::info!("default-on seed: enabled '{id}'");
        }
    }

    seed_optin_companion_ui(store, manifests).await;
}

/// One opt-in built-in companion and its prebuilt UI bundle. See
/// [`seed_optin_companion_ui`] for why these are seeded but NOT enabled.
struct OptinCompanionUi {
    id: &'static str,
    ui_code: &'static str,
}

/// Seed the `ui_code` of **opt-in** (non-default-on) built-in companions onto a
/// **disabled** record on a fresh install.
///
/// # Why this exists
///
/// Every *default-on* companion gets its `ui_code` from [`seed_overrides`] (applied
/// by the loop above). Mail is the first **opt-in** built-in companion: it must NOT
/// be default-on — one `com.ryu.mail` manifest owns both the companion runnable AND
/// the `ryu-mail` sidecar, whose binary is not yet shipped, so a default-on entry
/// would fail its health check on every fresh install (see
/// [`crate::plugins::builtins::CORE_DEFAULT_ON`]). But nothing else seeds a built-in
/// companion's `ui_code`: neither `install_app` nor `enable_app` sources it, and the
/// `*_UI_HTML` consts are wired only into `seed_overrides`. So without this, enabling
/// mail from the store would leave `ui_code = None` and the companion would mount as
/// "no runnable UI".
///
/// This seeds the bundle onto a **disabled** record (no `set_enabled`), so the app
/// stays opt-in — no sidecar spawn on a fresh install — yet its UI is present the
/// moment the user enables it (`enable_app` only flips the enabled bit + validates
/// grants; the `ui_code` is already there).
///
/// User-respecting: a plugin with ANY existing record is skipped, exactly like
/// [`seed_default_on`].
async fn seed_optin_companion_ui(store: &PluginStore, manifests: &[PluginManifest]) {
    let companions = [OptinCompanionUi {
        id: crate::plugins::builtins::MAIL_PLUGIN_ID,
        ui_code: crate::plugin_manifest::MAIL_UI_HTML,
    }];

    for c in &companions {
        match store.get(c.id).await {
            // A record exists (enabled or disabled) — the user's choice wins.
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("opt-in companion seed: lookup '{}' failed: {e}", c.id);
                continue;
            }
        }

        let Some(version) = manifests
            .iter()
            .find(|m| m.id == c.id)
            .map(|m| m.version.clone())
        else {
            continue;
        };

        if let Err(e) = store.insert(c.id, &version).await {
            tracing::warn!("opt-in companion seed: insert '{}' failed: {e}", c.id);
            continue;
        }
        if let Err(e) = store.set_ui_code(c.id, Some(c.ui_code)).await {
            tracing::warn!("opt-in companion seed: set_ui_code '{}' failed: {e}", c.id);
            continue;
        }
        // Deliberately NOT enabled — the app stays opt-in (no sidecar spawn on a
        // fresh install); the seeded `ui_code` makes `enable_app` mount the
        // companion whenever the user turns it on.
        tracing::info!(
            "opt-in companion seed: seeded ui_code for '{}' (disabled)",
            c.id
        );
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

    /// Capability edges (`requires.capabilities`) are lowered at seed time, so the
    /// seed order respects them: with the REAL built-ins, spaces requires the `rag`
    /// capability and rag requires `engines`, so the order is engines → rag → spaces
    /// even though those are capability edges, not app deps.
    #[test]
    fn seed_order_respects_capability_edges() {
        let specs = default_on_specs();
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let (order, skipped) = seed_order(&specs, &manifests);
        let pos = |id: &str| order.iter().position(|x| x == id);
        let (e, r, s) = (pos("engines"), pos("com.ryu.rag"), pos("com.ryu.spaces"));
        assert!(
            e.is_some() && r.is_some() && s.is_some(),
            "engines/rag/spaces all seeded (order: {order:?})"
        );
        assert!(e < r && r < s, "engines → rag → spaces (order: {order:?})");
        assert!(
            !skipped
                .iter()
                .any(|sk| sk.id == "com.ryu.spaces" || sk.id == "com.ryu.rag"),
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

    /// FAIL-CLOSED: a default-on plugin whose dependency is NOT default-on is not
    /// seeded at all — never enabled with a dependency that was never enabled.
    #[test]
    fn a_dependency_outside_the_default_on_set_skips_the_plugin() {
        let specs = [spec("meetings")];
        let manifests = vec![
            manifest("meetings", "1.0.0", &["spaces"]),
            // `spaces` is loaded, but it is NOT in the default-on set.
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

    /// A cycle among default-on plugins is skipped, not seeded (and never hangs).
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
        let specs = [spec("engines"), spec("durable"), spec("goal")];
        let manifests = vec![
            manifest("engines", "1.0.0", &[]),
            manifest("durable", "1.0.0", &[]),
            manifest("goal", "1.0.0", &[]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(skipped.is_empty());
        assert_eq!(ordered, vec!["engines", "durable", "goal"]);
    }

    /// A spec with no loaded manifest is silently dropped (the pre-graph behaviour:
    /// the version lookup returned `None` and the block did nothing).
    #[test]
    fn a_spec_without_a_manifest_is_dropped() {
        let specs = [spec("engines"), spec("not-loaded")];
        let manifests = vec![manifest("engines", "1.0.0", &[])];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert_eq!(ordered, vec!["engines"]);
        assert!(skipped.is_empty(), "absent != unsatisfiable");
    }

    /// The seed table stays in lockstep with `CORE_DEFAULT_ON`: every default-on id
    /// gets exactly one spec, and the three companions carry their grants + UI code.
    #[test]
    fn default_on_specs_cover_core_default_on_exactly() {
        let specs = default_on_specs();
        assert_eq!(specs.len(), CORE_DEFAULT_ON.len());
        for id in CORE_DEFAULT_ON {
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
                crate::plugins::builtins::WEBHOOKS_PLUGIN_ID,
                crate::plugins::builtins::CALENDAR_PLUGIN_ID,
            ],
            "only the companions that STAY default-on ship a prebuilt UI bundle, in \
             CORE_DEFAULT_ON order. The other companion apps (whiteboard/canvas/finetune/ \
             meetings/quests/approvals/learning/monitors/workflows/activity/timeline/ \
             skill-editor) are now opt-in (default-off), so they leave the default-on seed \
             even though their SeedSpec overrides still carry ui_code (inert until enabled)"
        );
        // Non-companion Core plugins seed with EMPTY grants, exactly as the generic
        // loop did before this module existed.
        let engines = specs.iter().find(|s| s.id == "engines").unwrap();
        assert!(engines.grants.is_empty());
    }

    /// End-to-end over the real store: a fresh install seeds every default-on
    /// plugin enabled, and a second run never re-seeds (a user's disable sticks).
    #[tokio::test]
    async fn seeding_is_one_time_and_respects_a_user_disable() {
        let store = PluginStore::open_in_memory().unwrap();
        let manifests = vec![
            manifest("engines", "1.0.0", &[]),
            manifest("durable", "1.0.0", &[]),
        ];
        let specs = [spec("engines"), spec("durable")];
        let (ordered, _) = seed_order(&specs, &manifests);
        assert_eq!(ordered.len(), 2);

        // Simulate the seed for this synthetic set (seed_default_on drives the real
        // CORE_DEFAULT_ON table; the store behaviour under test is identical).
        for id in &ordered {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }
        // The user disables one.
        store.set_disabled("durable").await.unwrap();

        // A re-seed must leave it disabled: a present record always wins.
        for id in &ordered {
            if store.get(id).await.unwrap().is_some() {
                continue;
            }
            store.set_enabled(id, &[]).await.unwrap();
        }
        assert!(store.get("engines").await.unwrap().unwrap().enabled);
        assert!(!store.get("durable").await.unwrap().unwrap().enabled);
    }

    /// The W7 Mail-companion extraction rests on this: mail is the first OPT-IN
    /// built-in companion, so the default-on seed loop never touches it, yet its
    /// `ui_code` MUST be present when the user enables it (nothing else — not
    /// `install_app`, not `enable_app` — seeds a built-in's `ui_code`). This drives
    /// the REAL `seed_default_on` over the REAL manifest set and asserts the end
    /// state: mail has a record with `ui_code` set, but stays DISABLED (opt-in, no
    /// sidecar spawn on fresh install). If this fails, enabling mail mounts a broken
    /// "no runnable UI" companion.
    #[tokio::test]
    async fn the_real_seed_seeds_mail_ui_code_but_leaves_it_disabled() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let store = PluginStore::open_in_memory().unwrap();

        seed_default_on(&store, &manifests).await;

        let mail_id = crate::plugins::builtins::MAIL_PLUGIN_ID;
        let mail = store
            .get(mail_id)
            .await
            .unwrap()
            .expect("the seed must install a mail record (disabled)");
        assert!(
            !mail.enabled,
            "mail must stay opt-in (DISABLED) — it must not be auto-enabled / its \
             sidecar auto-spawned on a fresh install"
        );
        let ui = store
            .get_ui_code(mail_id)
            .await
            .unwrap()
            .expect("mail's companion ui_code must be seeded so enable mounts the UI");
        assert!(
            ui.len() > 10_000 && ui.contains('<'),
            "mail ui_code must be the real inlined companion bundle, got {} bytes",
            ui.len()
        );
    }
}
