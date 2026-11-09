//! Ids retired from the pre-installed seed, and the companion-bundle backfill.

use super::*;

/// Historical ids that could have a disabled lifecycle row created by the old
/// companion-bundle seed. This is migration-only: it is not a live product state
/// or a second install category. New opt-in plugins are simply absent until the
/// user explicitly installs them.
pub(super) const LEGACY_DISABLED_SEED_IDS: &[&str] = &[
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
pub(super) const DEMOTED_FROM_PREINSTALLED_V5: &[&str] = &[
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
pub(super) async fn backfill_companion_ui(store: &PluginStore) {
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
