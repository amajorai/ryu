use super::*;

/// The other half of the same move: "New workflow" was a hardcoded row in the
/// desktop's create menu, so it showed (and 404'd) with Workflows uninstalled.
/// It is now the app's own contribution, which is what makes it disappear with
/// the app — the enabled gate is the contributions loop itself, so what has to
/// be asserted here is that the declaration exists and points somewhere real.
#[test]
fn the_workflows_app_registers_its_create_action() {
    let manifest = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == "@ryu/workflows")
        .expect("the Workflows manifest is compiled in");
    let contributes = manifest
        .contributes
        .as_ref()
        .expect("Workflows contributes");
    assert_eq!(
        contributes.create_actions.len(),
        1,
        "Workflows registers exactly one create-menu row"
    );
    let action = &contributes.create_actions[0];
    assert_eq!(action["label"], "New workflow");
    assert_eq!(
        action["target"], "/workflows/new",
        "the row must open the route the app actually serves"
    );
    // And it survives the chokepoint that rejects a row which does nothing.
    manifest
        .validate()
        .expect("the packaged Workflows manifest validates");
}

/// THE invariant of this family: installing a plugin does NOT enable it, so an
/// enabled-gated settings tab is missing exactly when the user goes looking for
/// it — right after installing, to paste the API key the plugin needs before it
/// is worth enabling at all.
#[test]
fn settings_tabs_are_served_for_an_installed_but_disabled_plugin() {
    let manifests = vec![settings_tab_manifest("@ryu/exa")];
    let installed = enabled_set(&["@ryu/exa"]);
    let none = enabled_set(&[]);

    let disabled = collect_plugin_settings_tabs(&manifests, &installed, &none, None);
    assert_eq!(
        disabled.len(),
        1,
        "a disabled plugin still offers its settings"
    );
    assert_eq!(disabled[0]["plugin"], "@ryu/exa");
    assert_eq!(
        disabled[0]["app_enabled"], false,
        "the shell must be able to say the plugin is not running yet"
    );
    // The declared body is passed through untouched — Core never validates it.
    assert_eq!(disabled[0]["fields"][0]["pref_key"], "RYU_EXA_API_KEY");

    let on = collect_plugin_settings_tabs(&manifests, &installed, &installed, None);
    assert_eq!(on[0]["app_enabled"], true);
}

/// Installed IS still required. Unlike a store tab (which is how you install an
/// app in the first place), settings for an app this node does not have are
/// preferences nothing reads.
#[test]
fn settings_tabs_are_not_served_for_an_uninstalled_plugin() {
    let manifests = vec![settings_tab_manifest("@ryu/exa")];
    let none = enabled_set(&[]);
    assert!(collect_plugin_settings_tabs(&manifests, &none, &none, None).is_empty());
}

/// Dropping the ENABLED filter must not drop the SURFACE filter with it.
#[test]
fn settings_tabs_still_respect_the_surface_filter() {
    use crate::plugin_manifest::Surface;
    let manifests = vec![manifest(json!({
        "id": "@ryu/exa", "name": "Exa", "version": "1.0.0", "runnables": [],
        "targets": ["desktop"],
        "contributes": { "settings_tabs": [
            { "id": "exa.settings", "title": "Exa", "fields": [
                { "type": "secret", "pref_key": "RYU_EXA_API_KEY", "label": "Key" }
            ]}
        ]}
    }))];
    let installed = enabled_set(&["@ryu/exa"]);
    assert_eq!(
        collect_plugin_settings_tabs(&manifests, &installed, &installed, Some(Surface::Desktop))
            .len(),
        1
    );
    assert_eq!(
        collect_plugin_settings_tabs(&manifests, &installed, &installed, Some(Surface::Island))
            .len(),
        0
    );
    assert_eq!(
        collect_plugin_settings_tabs(&manifests, &installed, &installed, None).len(),
        1
    );
}

/// Assert against the SHIPPED manifest: Exa is the case this exists for — its
/// only configuration is an API key, and it is useless until that key is set.
#[test]
fn the_exa_plugin_registers_its_api_key_settings_tab() {
    let manifests: Vec<_> = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .filter(|m| m.id == "@ryu/exa")
        .collect();
    assert_eq!(manifests.len(), 1, "the Exa manifest is compiled in");
    let installed = enabled_set(&["@ryu/exa"]);
    let none = enabled_set(&[]);
    let out = collect_plugin_settings_tabs(&manifests, &installed, &none, None);
    assert_eq!(out.len(), 1, "Exa registers exactly one settings tab");
    assert_eq!(out[0]["fields"][0]["pref_key"], "RYU_EXA_API_KEY");
    assert_eq!(out[0]["app_enabled"], false);
}

#[test]
fn build_channel_commands_unions_plugins_then_skills() {
    let plugins = vec![json!({
        "id": "proof.run", "command": "/proof", "description": "Prove it", "plugin": "proof"
    })];
    let skills = vec![skill("web-researcher", "Web Researcher", Some("Research"))];
    let out = build_channel_commands(&plugins, &skills);
    assert_eq!(
        out,
        vec![
            ChannelCommandEntry {
                name: "proof".to_owned(),
                description: "Prove it".to_owned(),
                source: "plugin",
            },
            ChannelCommandEntry {
                name: "web-researcher".to_owned(),
                description: "Research".to_owned(),
                source: "skill",
            },
        ]
    );
}

#[test]
fn build_channel_commands_lets_a_dispatching_plugin_win_a_collision() {
    // A plugin command has a real `pre_user_turn` hook behind it; a skill of the
    // same name is only a hint to the model, so it must not shadow the one that
    // actually runs.
    let plugins = vec![json!({ "command": "/goal", "description": "Plugin goal" })];
    let skills = vec![skill("goal", "Goal", Some("Skill goal"))];
    let out = build_channel_commands(&plugins, &skills);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].source, "plugin");
    assert_eq!(out[0].description, "Plugin goal");
}

#[test]
fn build_channel_commands_skips_entries_with_no_usable_name() {
    let plugins = vec![
        // `id` alone is the plugin's internal handle, not a command name.
        json!({ "id": "proof.run", "description": "no command key" }),
        // A slash with nothing after it names nothing.
        json!({ "command": "/", "description": "empty" }),
        json!({ "command": "   ", "description": "blank" }),
    ];
    assert!(build_channel_commands(&plugins, &[]).is_empty());
}

#[test]
fn build_channel_commands_falls_back_to_the_skill_name_and_flattens_text() {
    let skills = vec![
        skill("no-desc", "No Description", None),
        skill("multi", "Multi", Some("two\n  lines   here")),
    ];
    let out = build_channel_commands(&[], &skills);
    assert_eq!(out[0].description, "No Description");
    assert_eq!(out[1].description, "two lines here");
}

#[test]
fn build_channel_commands_serializes_to_the_published_shape() {
    let plugins = vec![json!({ "command": "/proof", "description": "Prove it" })];
    let value =
        serde_json::to_value(build_channel_commands(&plugins, &[])).expect("entries serialize");
    assert_eq!(
        value,
        json!([{ "name": "proof", "description": "Prove it", "source": "plugin" }])
    );
}

#[test]
fn flatten_one_line_collapses_all_whitespace() {
    assert_eq!(flatten_one_line("a\n\tb   c"), "a b c");
    assert_eq!(flatten_one_line("  padded  "), "padded");
    assert_eq!(flatten_one_line(""), "");
}
