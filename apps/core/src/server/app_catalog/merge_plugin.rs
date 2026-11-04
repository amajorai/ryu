//! App catalog browse, install-from-URL and hot reload: `merge_plugin_contract_fields` through `merge_plugin_contract_fields`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Insert the rich marketplace **detail** contract keys derived from a manifest
/// into `obj`. Shared by the built-in catalog card ([`plugin_manifest_to_entry`])
/// and the installed-plugin list ([`list_apps`]) so both built-in surfaces emit
/// the same contract shape (no `author`/`developer` split). Every key is emitted
/// only when the manifest carries the data (capabilities/runnables always, since
/// they derive from grants/runnables).
pub(in crate::server) fn merge_plugin_contract_fields(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    m: &crate::plugin_manifest::PluginManifest,
) {
    if !m.optional_permission_grants.is_empty() {
        obj.insert(
            "optional_permission_grants".to_owned(),
            json!(m.optional_permission_grants),
        );
    }
    if let Some(tagline) = &m.tagline {
        obj.insert("tagline".to_owned(), json!(tagline));
    }
    if let Some(icon) = &m.icon_url {
        obj.insert("iconUrl".to_owned(), json!(icon));
    }
    if let Some(bg) = &m.icon_background {
        obj.insert("iconBackground".to_owned(), json!(bg));
    }
    // camelCase twin of the `icon_padding` insert in `plugin_manifest_to_entry`.
    // Both are required: the CARD payload is snake_case and the DETAIL payload is
    // camelCase, and a field present in only one makes the hero and the card frame
    // the same logo differently.
    if let Some(pad) = &m.icon_padding {
        obj.insert("iconPadding".to_owned(), json!(pad));
    }
    if let Some(accent) = &m.accent_color {
        obj.insert("accentColor".to_owned(), json!(accent));
    }
    if let Some(banner) = &m.banner {
        obj.insert("banner".to_owned(), banner.clone());
    }
    if !m.screenshots.is_empty() {
        obj.insert("screenshots".to_owned(), json!(m.screenshots));
    }
    if let Some(dev) = m.developer() {
        obj.insert("developer".to_owned(), json!(dev));
    }
    if let Some(category) = &m.category {
        obj.insert("category".to_owned(), json!(category));
    }
    // Normalised `{message?, replacement?}`, absent = current. One key on both
    // the snake_case card and the camelCase detail (this helper feeds both).
    // Taken from the manifest, unlike `mandatory`: it can only make a listing
    // look worse, so self-assertion grants nothing.
    if let Some(notice) = m.deprecation() {
        obj.insert("deprecated".to_owned(), json!(notice));
    }
    if let Some(site) = &m.homepage {
        obj.insert("website".to_owned(), json!(site));
    }
    if let Some(repository) = &m.repository {
        obj.insert("repositoryUrl".to_owned(), json!(repository));
    }
    if let Some(license) = &m.license {
        obj.insert("license".to_owned(), json!(license));
    }
    // Remix policy, resolved (absent ⇒ allowed). Snake_case like the card keys
    // the store reads; the detail falls back to the card for it.
    obj.insert("allow_remix".to_owned(), json!(m.remix_allowed()));
    if let Some(privacy) = &m.privacy_policy_url {
        obj.insert("privacyPolicyUrl".to_owned(), json!(privacy));
    }
    if let Some(terms) = &m.terms_of_service_url {
        obj.insert("termsOfServiceUrl".to_owned(), json!(terms));
    }
    if !m.example_prompts.is_empty() {
        obj.insert("examplePrompts".to_owned(), json!(m.example_prompts));
    }
    if !m.tags.is_empty() {
        obj.insert("tags".to_owned(), json!(m.tags));
    } else if !m.keywords.is_empty() {
        obj.insert("tags".to_owned(), json!(m.keywords));
    }
    if !m.keywords.is_empty() {
        obj.insert("keywords".to_owned(), json!(m.keywords));
    }
    if let Some(setup) = &m.setup {
        obj.insert("setup".to_owned(), setup.clone());
    }
    if m.external {
        obj.insert("external".to_owned(), json!(true));
    }
    let layers = manifest_layer_projection(m);
    if !layers.is_empty() {
        obj.insert("layers".to_owned(), json!(layers));
    }
    // The dependency + surface contract, mirrored onto the entry from the ONE
    // definition of each field on the manifest.
    //
    // `requires` is what makes a catalog card honest about the closure an install
    // will pull in ("also installs: Spaces") and is what
    // `install_plugin_from_catalog` resolves before installing anything.
    //
    // `targets` is emitted ONLY when non-empty: an empty list means the plugin runs
    // on EVERY surface (`PluginManifest::supports_surface`), so emitting `[]` would
    // invert the meaning to "no surfaces" for any client reading it literally.
    if let Some(requires) = &m.requires {
        if !requires.apps.is_empty() || !requires.grants.is_empty() {
            obj.insert("requires".to_owned(), json!(requires));
        }
    }
    if !m.targets.is_empty() {
        obj.insert("targets".to_owned(), json!(m.targets));
    }
    // `engines` + this node's verdict on it.
    //
    // Both go on the CARD, not just the detail payload. A browse surface has to grey
    // a card and say "needs Core 0.2.0 — you have 0.1.12" while rendering a grid;
    // making that a per-card detail fetch is not a real option. `engines` used to
    // reach only the version-detail document, where it drove a scorecard badge and
    // nothing else, which is why nothing in the marketplace has ever reflected a
    // version floor.
    //
    // `compatibility` is computed HERE because only the node serving the entry knows
    // what is running. It reports floors for surfaces Core cannot observe as
    // advisory `unknown` rather than as failures; a client that knows its own
    // surface version re-evaluates from `engines` and may harden one into a refusal.
    if let Some(engines) = &m.engines {
        obj.insert("engines".to_owned(), json!(engines));
        obj.insert(
            "compatibility".to_owned(),
            json!(crate::plugin_manifest::node_host_versions().evaluate(Some(engines))),
        );
    }
    // `surfaces`, flattened to the list the store renders as platform badges.
    //
    // The map form supersedes `targets` and carries a per-surface support LEVEL, but
    // a CARD only needs "which platforms does this run on" — the level belongs on the
    // detail page. An explicit `"none"` is filtered OUT: it declares NON-support, so
    // listing it would advertise the one platform the author ruled out.
    //
    // Same non-empty rule as `targets` above, for the same reason: absent means "not
    // declared" (offered everywhere), while `[]` would read as "runs nowhere".
    if let Some(surfaces) = &m.surfaces {
        let listed: Vec<&str> = surfaces
            .iter()
            .filter(|(_, e)| e.support.is_supported())
            .map(|(s, _)| s.as_str())
            .collect();
        if !listed.is_empty() {
            obj.insert("surfaces".to_owned(), json!(listed));
        }
    }
    // Keep the richer support level on the CARD as well as on detail. The card
    // itself stays visually quiet, but a native/read-only host may need to explain
    // support without making a second detail request. This comes from the same
    // allowlisted projection used by local and community detail payloads, so the
    // three surfaces cannot grow different interpretations of `surfaces`.
    if let Ok(manifest) = serde_json::to_value(m) {
        let support = crate::catalog_source::manifest_surface::project_surface_support(&manifest);
        if !support.is_empty() {
            obj.insert("surface_support".to_owned(), json!(support));
        }
    }
    // capabilities: declared, else derived from permission_grants.
    obj.insert("capabilities".to_owned(), json!(m.resolved_capabilities()));
    // runnables: bundled runnables as {id, kind, name}. `enabled` is intentionally
    // omitted here — the desktop overlays enable state from the app_store.
    let runnables: Vec<serde_json::Value> = m
        .runnables
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "kind": r.kind.as_str(),
                "name": r.name,
            })
        })
        .collect();
    obj.insert("runnables".to_owned(), json!(runnables));
    // `mcp_servers`: the local processes this plugin will SPAWN if enabled, as
    // `{ name, command, args }`. Emitted only when the manifest declares any.
    //
    // Why this is part of the permission contract and not decoration: everything
    // else a consent surface shows is a grant STRING (`tool:command:spider`), and
    // grant strings are what the Gateway validates. An `mcp_servers` entry carries
    // its own verbatim `command` + `args` that Core hands to `Command::new`, so a
    // consent surface rendering `permission_grants` alone tells the user "this
    // plugin wants mcp:server" and never shows them WHAT it is about to run. This
    // serves the missing half. `command_env` is deliberately NOT resolved here:
    // this is the DECLARATION as authored, not the lowered runtime command (a
    // resolved absolute path would read as a promise Core has not yet made — the
    // env lookup happens at registration time in `mcp_server_config_from_decl`).
    if !m.mcp_servers.is_empty() {
        let mcp_servers: Vec<serde_json::Value> = m
            .mcp_servers
            .iter()
            .map(|(name, decl)| {
                json!({
                    "name": name,
                    "command": decl.command,
                    "args": decl.args,
                    "command_env": decl.command_env,
                    "transport": decl.transport,
                    "url": decl.url,
                    "auth": decl.auth,
                })
            })
            .collect();
        obj.insert("mcp_servers".to_owned(), json!(mcp_servers));
    }
}
