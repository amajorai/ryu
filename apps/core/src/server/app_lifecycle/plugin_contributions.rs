//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `plugin_contributions` through `plugin_contributions`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/plugins/contributions` — the declarative UI contributions (composer
/// controls, settings tabs, slash commands) of every **enabled** plugin, each
/// tagged with its owning `plugin` id. The desktop renders the known widget types
/// from this; new widget types need no Core change (Core passes them verbatim).
/// This is what lets a plugin like double-check/goal contribute its composer
/// toggle / slash command without editing the closed desktop source.
#[utoipa::path(
    get,
    path = "/api/plugins/contributions",
    tag = "Plugins",
    summary = "List the UI contributions of every enabled plugin",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_contributions(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    let enforce_custom_app_csp =
        crate::app_security::enforce_custom_app_csp_enabled(&state.preferences).await;

    let (installed_ids, enabled_records) = match installed_and_enabled_records(&state).await {
        Ok(views) => views,
        Err(response) => return response,
    };
    // Presence metadata needs ids only, not UI blobs or a query per manifest.
    let ui_bundle_ids = state.app_store.ids_with_ui_code().await.unwrap_or_default();
    let enabled_ids: std::collections::HashSet<String> = enabled_records.keys().cloned().collect();
    let mut store_tabs = Vec::new();
    let mut composer_controls = Vec::new();
    let mut chat_features = Vec::new();
    let mut computer_use_planners = Vec::new();
    let mut settings_tabs = Vec::new();
    let mut message_actions = Vec::new();
    let mut selection_actions = Vec::new();
    let mut context_menu_items = Vec::new();
    let mut create_actions = Vec::new();
    let mut agent_edit_panels = Vec::new();
    let mut agent_profile_tabs = Vec::new();
    let mut turn_hooks = Vec::new();
    let mut hook_events = Vec::new();
    let mut views = Vec::new();
    let mut sidebar_sections = Vec::new();
    let mut sidebar_buttons = Vec::new();
    let mut sidebar_modes = Vec::new();
    let mut themes = Vec::new();
    let mut avatar_accessories = Vec::new();
    let mut avatar_styles = Vec::new();
    let mut backgrounds = Vec::new();
    let mut interfaces = Vec::new();
    let mut dock_panels = Vec::new();
    let mut file_handlers = Vec::new();
    let mut live_activities = Vec::new();
    let mut output_styles = Vec::new();
    let mut chat_widget_templates = Vec::new();

    // Surface filter (`targets`): a plugin that doesn't target the calling host
    // contributes nothing to it. Absent/unknown `x-ryu-surface` = no filter, and
    // an empty `targets` = every surface, so existing plugins keep contributing
    // everywhere.
    let surface = surface_from_headers(&headers);

    let manifests = state.app_manifests.read().await;
    // Slash commands are collected by a shared walk because a SECOND reader —
    // `GET /api/channels/commands` — has to apply exactly the same enabled filter;
    // see [`collect_plugin_slash_commands`]. Imported user commands (Codex
    // prompts) are appended here, unenabled (they are the user's own, not gated
    // by a plugin's enabled bit).
    let mut slash_commands = collect_plugin_slash_commands(&manifests, &enabled_ids, surface);
    slash_commands.extend(read_user_slash_commands(&state.preferences).await);
    // Marketplace tabs — the ONE family collected outside the enabled filter. See
    // `Contributes::store_tabs`: the Store is where an app gets installed, and every
    // built-in feature app is absent until explicit install, so an enabled-gated tab would be
    // absent exactly when the user needs it. The surface filter still applies (a
    // shell that the app does not target cannot render the tab either way), and the
    // catalog DATA behind the tab stays gated by the app's own route gate.
    store_tabs.extend(collect_plugin_store_tabs(
        &manifests,
        &installed_ids,
        &enabled_ids,
        surface,
    ));
    // Settings tabs — the OTHER family collected outside the enabled filter, for the
    // same reason and with the same honesty requirement; see
    // [`collect_plugin_settings_tabs`]. Installed-gated, and each tab carries the
    // app's `app_enabled` bit so the shell can say "saved, applies once enabled"
    // instead of implying the plugin is running.
    settings_tabs.extend(collect_plugin_settings_tabs(
        &manifests,
        &installed_ids,
        &enabled_ids,
        surface,
    ));
    // Output styles — enabled-filtered like the in-loop families, but collected by
    // its own walk because building a row means PARSING the contributed markdown
    // (design §4's one-parser rule), not cloning a `Value`; see
    // [`collect_plugin_output_styles`].
    output_styles.extend(collect_plugin_output_styles(
        &manifests,
        &enabled_ids,
        surface,
    ));
    for manifest in manifests.iter() {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        let http_policy = match declarative_http_policy(manifest) {
            Ok(policy) => policy,
            Err(error) => {
                tracing::warn!(
                    plugin = %manifest.id,
                    %error,
                    "dropping unsafe declarative contributions"
                );
                continue;
            }
        };
        // Tag each contribution with its owning plugin id so the desktop knows
        // which `plugin_flags` entry a toggle sets / which plugin a tab belongs to.
        // The approved grants are carried alongside the server-owned policy so
        // the client can gate declarative HTTP on stored consent, never the
        // manifest's claim.
        let approved_grants = enabled_records
            .get(&manifest.id)
            .map(|record| record.approved_grants.as_slice())
            .unwrap_or_default();
        let tag = |mut v: serde_json::Value| {
            stamp_contribution_authority(manifest, &mut v, http_policy);
            tag_plugin_contribution(v, &manifest.id, approved_grants)
        };
        composer_controls.extend(c.composer_controls.iter().cloned().map(tag));
        // Host-rendered chat feature descriptors. The payload stays opaque so a
        // newer desktop can add a feature kind without requiring every Core build
        // to understand it; the owning plugin id is the only server-added field.
        chat_features.extend(c.chat_features.iter().cloned().map(tag));
        computer_use_planners.extend(
            c.computer_use_planners
                .iter()
                .filter_map(|planner| serde_json::to_value(planner).ok())
                .map(tag),
        );
        // Per-message toolbar actions and context-menu rows — the in-conversation
        // seams. Stored raw + tagged with the owning plugin id, exactly like the
        // sibling client-rendered families; the renderer owns the `kind`/`anchor`
        // vocabulary and ignores a member it does not know.
        message_actions.extend(c.message_actions.iter().cloned().map(tag));
        selection_actions.extend(c.selection_actions.iter().cloned().map(tag));
        context_menu_items.extend(c.context_menu_items.iter().cloned().map(tag));
        // "New X" rows for the shell's create menu. Enabled-gated like the rest of
        // this loop, which is the entire point: the row has to vanish with the app,
        // or clicking it navigates to a route the app no longer serves.
        create_actions.extend(c.create_actions.iter().cloned().map(tag));
        // Agent-editor panels are opaque client-rendered declarations, just like
        // composer controls. Enabled-gating makes the whole panel disappear when
        // its owning plugin is disabled.
        agent_edit_panels.extend(c.agent_edit_panels.iter().cloned().map(tag));
        // Agent-profile tabs embed one of the plugin's own companions, so (like
        // file handlers) a tab naming a runnable this plugin does not own is dropped
        // rather than mounting someone else's frame inside the profile.
        agent_profile_tabs.extend(c.agent_profile_tabs.iter().filter_map(|profile_tab| {
            let owns_companion = manifest.runnables.iter().any(|entry| {
                entry.id == profile_tab.companion
                    && entry.kind == crate::runnable::RunnableKind::Companion
            });
            if !owns_companion {
                return None;
            }
            serde_json::to_value(profile_tab).ok().map(tag)
        }));
        // Declarative views (the Raycast tier): serialize each typed contribution to
        // a Value and tag it with its owning plugin, exactly like the sibling families.
        views.extend(
            c.views
                .iter()
                .filter_map(|v| serde_json::to_value(v).ok())
                .map(tag),
        );
        // App-registered sidebar sections + buttons — same tag-and-collect shape as
        // views; the `spec`/`target` stay opaque to Core and the desktop's sidebar
        // renderer interprets them.
        sidebar_sections.extend(
            c.sidebar_sections
                .iter()
                .filter_map(|s| serde_json::to_value(s).ok())
                .map(tag),
        );
        sidebar_buttons.extend(
            c.sidebar_buttons
                .iter()
                .filter_map(|b| serde_json::to_value(b).ok())
                .map(tag),
        );
        // Sidebar MODES — how the sidebar as a whole is arranged, next to the two
        // members that say what is in it. Same tag-and-collect shape; the sections a
        // mode names stay opaque to Core, which never resolves them (the shell owns
        // the section vocabulary, and a mode may legitimately name a section from a
        // sibling app that is not installed).
        sidebar_modes.extend(
            c.sidebar_modes
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .map(tag),
        );
        // Colour themes (`contributes.themes`) — a marketplace theme is a plugin that
        // contributes one, exactly as in VS Code and Zed. Enabled-gated like the rest
        // of this loop, and deliberately so: disabling the plugin is how a user turns
        // its themes back off, so a disabled plugin's theme must leave the picker.
        // (The shell's own cache then drops it, and a selection pointing at it falls
        // back to the shipped default.)
        themes.extend(
            c.themes
                .iter()
                .filter_map(|t| serde_json::to_value(t).ok())
                .map(tag),
        );
        // Background variants are data-only references to host-owned renderers.
        // Keep them on the same enabled/surface-filtered contribution path as themes.
        // Avatar accessories and styles are data-only shape lists, already bounded
        // per plugin at the manifest gate. Enabled-gated like themes: disabling the
        // plugin removes its parts from the avatar editor, and a persisted selection
        // that names one renders the plain fallback until it comes back.
        avatar_accessories.extend(
            c.avatar_accessories
                .iter()
                .filter_map(|a| serde_json::to_value(a).ok())
                .map(tag),
        );
        avatar_styles.extend(
            c.avatar_styles
                .iter()
                .filter_map(|s| serde_json::to_value(s).ok())
                .map(tag),
        );
        let remaining = MAX_PLUGIN_BACKGROUND_ROWS_PER_RESPONSE.saturating_sub(backgrounds.len());
        if remaining > 0 {
            backgrounds.extend(serialize_plugin_backgrounds(c, &tag, remaining));
        }
        // Interfaces are data-only too: a host-owned renderer id plus bounded
        // params, served on the same enabled/surface-filtered path so disabling
        // the plugin removes its interfaces from the switcher.
        let remaining = MAX_PLUGIN_INTERFACE_ROWS_PER_RESPONSE.saturating_sub(interfaces.len());
        if remaining > 0 {
            interfaces.extend(serialize_plugin_interfaces(c, &tag, remaining));
        }
        // Workspace dock panels — the app-owned replacement for the desktop's closed
        // `TabKind` union. Same tag-and-collect shape as the sibling families; the
        // `panel` discriminant and `spec` stay opaque to Core, so a panel capability
        // this build has never heard of still reaches a newer shell intact.
        file_handlers.extend(c.file_handlers.iter().filter_map(|handler| {
            let owns_companion = manifest.runnables.iter().any(|entry| {
                entry.id == handler.companion
                    && entry.kind == crate::runnable::RunnableKind::Companion
            });
            if !owns_companion {
                return None;
            }
            serde_json::to_value(handler).ok().map(tag)
        }));
        dock_panels.extend(
            c.dock_panels
                .iter()
                .filter_map(|p| serde_json::to_value(p).ok())
                .map(tag),
        );
        // Live activities — the app-owned "Dynamic Island" cards. Same tag-and-collect
        // shape as the sibling families; the `spec` stays opaque to Core, so an
        // activity capability this build has never heard of still reaches a newer
        // shell intact.
        live_activities.extend(
            c.live_activities
                .iter()
                .filter_map(|a| serde_json::to_value(a).ok())
                .map(tag),
        );
        turn_hooks.extend(
            c.turn_hooks
                .iter()
                .map(|h| serde_json::json!({ "plugin": manifest.id, "id": h.id, "on": h.on })),
        );
        // App events this plugin EMITS — the provider half of the hook system, and
        // what a consumer author (or the workflow builder's event-trigger picker)
        // reads to discover what there is to subscribe to. Served next to
        // `turn_hooks` (which is the consumer half) on purpose: the two together are
        // the whole two-way picture of who publishes what and who listens.
        hook_events.extend(
            c.hook_events
                .iter()
                .filter_map(|e| serde_json::to_value(e).ok())
                .map(tag),
        );
    }
    chat_widget_templates.extend(collect_plugin_chat_widget_templates(
        &manifests,
        &enabled_ids,
        surface,
    ));
    // Channel adapters contributed by enabled plugins (`RunnableKind::Channel`),
    // registered into the app-contrib registry by the enable handlers.
    let channels = state.app_contrib.channels();

    // Companion surfaces, built from the enabled manifests' `Companion` runnables
    // so each entry carries its owning `plugin_id`, that plugin's GATEWAY-APPROVED
    // grants, and a `has_ui` flag (whether a sandboxed-UI bundle is stored). The
    // desktop reads `approved_grants` (NOT the manifest claim) to build the host
    // capability set, and only mounts third-party code when `has_ui` is true and
    // the experimental flag is on.
    // Which enabled apps can put an interactive card in chat.
    //
    // A STATUS flag, not the `contributes.widgets` payload — that payload is
    // Core-interpreted (uri / mime / ui_entry) and is deliberately not served here,
    // gathered at its consumption site instead. What a client cannot otherwise know
    // is the DECISION, and until now it could not: a widget announced itself only
    // when a turn happened to emit one, so no store or settings surface could say
    // "this app renders in chat" ahead of time — the same thing `has_ui` answers
    // for companions.
    //
    // `granted` mirrors the manifest side of Core's own promotion gate: declared
    // (non-empty `contributes.widgets`) AND the owning record enabled (this loop)
    // AND holding `widget:render`. An app that declares widgets but lacks the grant
    // is reported with `granted: false` rather than omitted — that is precisely the
    // state worth surfacing, because its widgets silently degrade to text and
    // nothing else in the UI says so.
    let widget_apps = plugin_widget_apps(&manifests, &enabled_records);

    let mut companions = plugin_companion_rows(
        &manifests,
        &enabled_records,
        surface,
        &ui_bundle_ids,
        enforce_custom_app_csp,
    );

    let mcp_projection_owners = mcp_app_extensions::projection_owner_ids(&manifests, surface);
    drop(manifests);
    mcp_app_extensions::append_contributions(
        &state,
        &mcp_projection_owners,
        &mut companions,
        &mut sidebar_buttons,
        &mut dock_panels,
        &mut file_handlers,
        &mut settings_tabs,
    )
    .await;
    Json(json!({
        "composer_controls": composer_controls,
        "chat_features": chat_features,
        "computer_use_planners": computer_use_planners,
        "settings_tabs": settings_tabs,
        "message_actions": message_actions,
        "selection_actions": selection_actions,
        "context_menu_items": context_menu_items,
        "create_actions": create_actions,
        "agent_edit_panels": agent_edit_panels,
        "agent_profile_tabs": agent_profile_tabs,
        "slash_commands": slash_commands,
        "turn_hooks": turn_hooks,
        "hook_events": hook_events,
        "views": views,
        "sidebar_sections": sidebar_sections,
        "sidebar_buttons": sidebar_buttons,
        "sidebar_modes": sidebar_modes,
        "themes": themes,
        "backgrounds": backgrounds,
        "avatar_accessories": avatar_accessories,
        "avatar_styles": avatar_styles,
        "interfaces": interfaces,
        "dock_panels": dock_panels,
        "fileHandlers": file_handlers,
        // Contributed live activities (the "Dynamic Island" cards) — enabled-gated
        // like the rest of the client-rendered families, tagged with their owning
        // plugin id so the dock can group and the contributed adapter can poll their
        // `source` through the host's authenticated Core seam.
        "live_activities": live_activities,
        // Metadata-only widget catalog. It contains no HTML, React, capability,
        // or executable action payload; the desktop owns the compact affordance.
        "chat_widget_templates": chat_widget_templates,
        // Contributed output styles (design §4). The DECLARATION view — which
        // enabled plugin ships which style — next to `themes`, its closest sibling.
        // Which style is in FORCE is a different question with a different answer,
        // and `GET /api/output-styles` is the one place that answers it.
        "output_styles": output_styles,
        "store_tabs": store_tabs,
        "channels": channels,
        "companions": companions,
        "widget_apps": widget_apps,
    }))
    .into_response()
}
