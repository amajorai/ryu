//! App catalog browse, install-from-URL and hot reload: `display_version` through `manifest_layer_projection`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The version to SHOW for a locally loaded manifest.
///
/// A normal compiled-in manifest ships INSIDE this binary, so the version the user
/// actually has is whatever Core release delivered it — not the `version` the
/// manifest declares, which is an authoring-time constant no release bump ever
/// rewrites. External-repository apps may opt into their own published train with
/// the manifest's non-`builtin` `source` hint; their editor version is meaningful
/// even though Core carries a trusted copy for offline Marketplace discovery.
///
/// A DISK manifest keeps its own version: it was installed from a catalog that
/// has a real publish train, and overriding it would misreport the installed
/// build of every sideloaded plugin. The predicate is therefore PROVENANCE
/// (`is_compiled_in_manifest`), the same one `local_detail_trust_signals` keys
/// on — never the emitted `"source": "built-in"`, which `plugin_manifest_to_entry`
/// hardcodes for disk manifests too and so cannot tell the two apart.
pub(in crate::server) fn display_version(m: &crate::plugin_manifest::PluginManifest) -> String {
    if crate::plugins::builtins::is_exact_compiled_manifest(m)
        && !m
            .source
            .as_deref()
            .is_some_and(|source| !source.trim().is_empty() && source != "builtin")
    {
        env!("CARGO_PKG_VERSION").to_owned()
    } else {
        m.version.clone()
    }
}

pub(in crate::server) fn local_plugin_detail(id: &str) -> Option<serde_json::Value> {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load();
    let m = manifests.iter().find(|m| m.id == id)?;

    // `load()` returns compiled-in fixtures AND anything the user dropped into the
    // writable `~/.ryu/plugins`. Only the former is reviewed-by-construction, and
    // `origin`/`reviewed` are TRUST SIGNALS the consent surface renders next to the
    // permission grants — so they must key on manifest provenance, not on the mere
    // fact that Core managed to parse the file. Marking a disk manifest
    // `first_party` + `reviewed` would let anything that can write a directory
    // under `~/.ryu/plugins` dress itself as a vetted first-party app on the very
    // screen where the user decides whether to approve its grants (and, because
    // this path answers BEFORE the remote source, shadow a real listing while
    // doing it).
    let (source, origin, reviewed) =
        local_detail_trust_signals(crate::plugins::builtins::is_exact_compiled_manifest(m));

    let mut obj = serde_json::Map::new();
    obj.insert("id".to_owned(), json!(m.id));
    obj.insert("name".to_owned(), json!(m.name));
    obj.insert("version".to_owned(), json!(display_version(m)));
    obj.insert("description".to_owned(), json!(m.description));
    obj.insert("source".to_owned(), json!(source));
    obj.insert("origin".to_owned(), json!(origin));
    obj.insert("reviewed".to_owned(), json!(reviewed));
    obj.insert(
        "builtIn".to_owned(),
        json!(crate::plugins::builtins::find_system_plugin(&m.id).is_some()),
    );
    // Publisher identity, matching the card projection in `plugin_manifest_to_entry`
    // and keyed on the same provenance predicate `reviewed` above is (camelCase here
    // because this payload is camelCase — see `builtIn`).
    //
    // Emitted ONLY when it is true, and that is not a style choice: the hero treats
    // the detail as authoritative the moment `orgVerified !== undefined` and then
    // ignores the card's flag entirely. Emitting `false` for every third-party
    // listing would therefore ERASE a check a hosted marketplace card legitimately
    // carried, on the exact screen where it matters most. Absent means "this payload
    // knows nothing about it — keep what the card said".
    if crate::plugins::builtins::is_exact_compiled_manifest(m) {
        obj.insert("orgVerified".to_owned(), json!(true));
        obj.insert("orgVerifiedTier".to_owned(), json!("official"));
        obj.insert("publisherTrust".to_owned(), json!("gold"));
        obj.insert("publisherTrustSource".to_owned(), json!("ryu_staff"));
    }
    merge_plugin_contract_fields(&mut obj, m);

    // The API surface is projected from the manifest's own JSON, through the exact
    // same allowlist a third-party manifest crosses — one projection, one contract,
    // no first-party-only shape for the renderer to special-case.
    if let Ok(value) = serde_json::to_value(m) {
        for (k, v) in crate::catalog_source::manifest_surface::project_manifest(&value) {
            obj.insert(k, v);
        }
    }
    if let Some(readme) = local_plugin_readme(&m.id) {
        obj.insert("readme".to_owned(), json!(readme));
    }
    Some(serde_json::Value::Object(obj))
}

/// True when a client route is a TOP-LEVEL path — one non-empty segment, e.g.
/// `/drafts`. Deliberately the same shape the desktop's `COMPANION_ALIAS` catch-all
/// matches (`/^\/[^/]+$/`, apps/desktop/src/contributions/builtins.ts).
///
/// Core cannot know which routes the desktop shell registers, so "a top-level path
/// the item INTRODUCES" can only be approximated from here by segment count. That is
/// a layering fact, not a shortcut: the shell owns `/library`, `/settings`, `/store`
/// and friends, and every one of them is claimed unconditionally, so no item can
/// introduce a top-level path that the shell already owns. It is exact for every
/// manifest shipped today and the discriminating case (`/library/memory`) is pinned
/// by test.
pub(crate) fn is_top_level_route(target: &str) -> bool {
    let trimmed = target.trim();
    let Some(rest) = trimmed.strip_prefix('/') else {
        return false;
    };
    !rest.is_empty() && !rest.contains('/')
}

/// True when a manifest claims a UI **destination** — somewhere the user navigates TO
/// that does not exist while the item is uninstalled. This is THE app-vs-plugin
/// predicate; anything else is a plugin.
///
/// Exactly three manifest keys mint a destination, and no others:
///
/// 1. `runnables[].kind == "companion"` — a companion window backed by the item's own
///    sandboxed `ui/` bundle.
/// 2. a non-empty `contributes.dock_panels` — a workspace tab, in ANY `panel` mode.
///    `panel: "native"` counts: the React component ships in the shell, but "the tab's
///    existence, label and placement become the app's declaration, so disabling the
///    app removes the tab" (packages/app-host/src/views.ts). Browser, Simulator, CRM
///    and UGC are apps this way.
/// 3. `contributes.sidebar_buttons[].target` pointing at a TOP-LEVEL path
///    (`/dashboard`, `/drafts`, `/mission-control`). The shell mints that route from
///    the live contributions feed and tears it down when the app is disabled
///    (apps/desktop/src/contributions/app-shell-routes.ts, whose first line reads
///    "Routes for shell pages an APP owns").
///
/// Three things are deliberately NOT evidence, because they are where the question
/// used to get argued:
///
/// - **A sidecar is not evidence.** `@ryu/docling`, `@ryu/markitdown`, `@ryu/mineru`
///   and `@ryu/unstructured` each ship a Python sidecar and are four interchangeable
///   providers of ONE capability (`document.parse`) with no contributions at all.
///   Nobody opens Docling. They are plugins.
/// - **The package directory is not the taxonomy.** `apps-store/` is a PACKAGING root
///   (items published as their own satellite repo because they carry an
///   out-of-process backend); 20 of its members are plugins by function.
/// - **`views` / `sidebar_sections` / `store_tabs` are content, not destinations.** A
///   view renders inside a companion or a `panel:"view"` dock panel; a sidebar
///   section is rows inside a list the shell already draws. A SUB-path target is a
///   link for the same reason: `@ryu/memory` targets `/library/memory`, and `/library`
///   is registered unconditionally by the shell, so Memory decorates a page it does
///   not own — it stays a plugin.
pub(in crate::server) fn manifest_declares_destination(
    m: &crate::plugin_manifest::PluginManifest,
) -> bool {
    if m.runnables.iter().any(|r| r.kind.as_str() == "companion") {
        return true;
    }
    let Some(contributes) = m.contributes.as_ref() else {
        return false;
    };
    if !contributes.dock_panels.is_empty() {
        return true;
    }
    contributes
        .sidebar_buttons
        .iter()
        .any(|b| is_top_level_route(&b.target))
}

/// Map a loaded [`crate::plugin_manifest::PluginManifest`] to a Plugins-catalog
/// `CatalogEntry`. Built-in system apps (Ghost/Shadow) are flagged so the desktop
/// renders them as system cards.
pub(in crate::server) fn manifest_layer_projection(
    m: &crate::plugin_manifest::PluginManifest,
) -> Vec<serde_json::Value> {
    m.provided_capabilities()
        .into_iter()
        .map(|provided| {
            json!({
                "capability": provided.capability,
                "title": provided.title,
                "toolkit": crate::plugins::binding::is_toolkit(
                    std::slice::from_ref(m),
                    &provided.capability,
                ),
                "selectable": provided.selectable,
                "target": provided.target,
                "verbs": provided.tools.keys().collect::<Vec<_>>(),
            })
        })
        .collect()
}
