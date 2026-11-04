use super::*;

/// The app-vs-plugin rule, on synthetic manifests: exactly three keys mint a
/// destination, and the ones people keep arguing about mint nothing.
#[test]
fn catalog_app_predicate_counts_only_the_three_destination_keys() {
    let manifest = |extra: serde_json::Value| -> PluginManifest {
        let mut base = json!({ "id": "acme/x", "name": "X", "version": "1.0.0", "runnables": [] });
        let (Some(obj), Some(more)) = (base.as_object_mut(), extra.as_object()) else {
            panic!("test fixtures are objects");
        };
        for (k, v) in more {
            obj.insert(k.clone(), v.clone());
        }
        serde_json::from_value(base).expect("fixture manifest parses")
    };

    // (a) a companion runnable.
    assert!(manifest_declares_destination(&manifest(json!({
        "runnables": [{ "id": "ui", "name": "UI", "kind": "companion" }]
    }))));
    // (b) a dock panel — in ANY panel mode, `native` included.
    assert!(manifest_declares_destination(&manifest(json!({
        "contributes": { "dock_panels": [
            { "id": "p", "title": "P", "placement": "bottom", "panel": "native" }
        ] }
    }))));
    assert!(manifest_declares_destination(&manifest(json!({
        "contributes": { "dock_panels": [
            { "id": "p", "title": "P", "placement": "right", "panel": "view" }
        ] }
    }))));
    // (c) a TOP-LEVEL sidebar-button target.
    assert!(manifest_declares_destination(&manifest(json!({
        "contributes": { "sidebar_buttons": [
            { "id": "home", "title": "Home", "target": "/drafts" }
        ] }
    }))));

    // A SUB-path target is a link into a surface the shell already owns.
    assert!(!manifest_declares_destination(&manifest(json!({
        "contributes": { "sidebar_buttons": [
            { "id": "home", "title": "Memory", "target": "/library/memory" }
        ] }
    }))));
    // A sidecar is not evidence — the docling/markitdown/mineru/unstructured
    // shape. Their real manifests are asserted in the sibling test below; here
    // the point is that the process spec is never even consulted.
    assert!(!manifest_declares_destination(&manifest(json!({
        "sidecars": [{
            "name": "s",
            "port": 8095,
            "health_path": "/health",
            "process": { "kind": "local", "command": "ryu-s" }
        }],
        "contributes": {}
    }))));
    // Neither are views, sidebar sections or store tabs: all render inside a
    // surface that exists without the item.
    assert!(!manifest_declares_destination(&manifest(json!({
        "contributes": {
            "views": [{ "id": "v", "view": "data-table" }],
            "sidebar_sections": [{ "id": "s", "title": "S", "source": "/api/x" }],
            "store_tabs": [{ "id": "t", "title": "T" }]
        }
    }))));
    // Non-companion runnable kinds never promote.
    assert!(!manifest_declares_destination(&manifest(json!({
        "runnables": [{ "id": "t", "name": "T", "kind": "tool" }]
    }))));

    assert!(is_top_level_route("/drafts"));
    assert!(is_top_level_route(" /mission-control "));
    assert!(!is_top_level_route("/library/memory"));
    assert!(!is_top_level_route("drafts"));
    assert!(!is_top_level_route("/"));
}

/// The rule against the manifests we actually ship. These twelve ids are the
/// whole argument: seven items claim a destination WITHOUT a companion runnable
/// (four via `dock_panels`, three via a top-level route) and were filed as
/// plugins by the old companion-only test; five document parsers each ship a
/// sidecar and are still plugins; and `@ryu/memory` targets a sub-path of
/// a shell-owned surface and is still a plugin.
#[test]
fn catalog_taxonomy_classifies_shipped_manifests_by_destination() {
    let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let by_id = |id: &str| -> &crate::plugin_manifest::PluginManifest {
        builtins
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("built-in manifest `{id}` is not compiled in"))
    };

    for id in [
        // dock_panels, `panel: "native"`.
        "@ryu/browser",
        "@ryu/crm",
        "@ryu/ugc",
        "@ryu/simulator",
        // a top-level `sidebar_buttons[].target` the shell mints a route from.
        "@ryu/dashboards",
        "@ryu/drafts",
        "@ryu/mission-control",
    ] {
        let m = by_id(id);
        assert!(
            !m.runnables.iter().any(|r| r.kind.as_str() == "companion"),
            "{id} is the interesting case only while it has NO companion runnable"
        );
        assert!(
            manifest_declares_destination(m),
            "{id} declares a destination and must classify as an app"
        );
        assert_eq!(plugin_manifest_to_entry(m)["type"], "app", "{id}");
    }

    for id in [
        // Five interchangeable `document.parse` providers, each with a sidecar.
        "@ryu/anydoc",
        "@ryu/docling",
        "@ryu/markitdown",
        "@ryu/mineru",
        "@ryu/unstructured",
        // Targets `/library/memory`; `/library` is the shell's.
        "@ryu/memory",
    ] {
        let m = by_id(id);
        assert!(
            !manifest_declares_destination(m),
            "{id} claims no destination and must classify as a plugin"
        );
        assert_eq!(plugin_manifest_to_entry(m)["type"], "plugin", "{id}");
    }
}

/// The publisher check on a first-party catalog card. Two independent breaks put
/// it out: the card projector dropped the fields a hosted listing carries, and a
/// built-in's manifest entry (which never set them) wins the whole-entry dedupe,
/// so the hosted card that DID carry `orgVerified` was discarded outright.
#[test]
fn catalog_card_carries_org_verification() {
    // A compiled-in manifest is vouched for by Core itself.
    let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let m = builtins
        .iter()
        .find(|m| m.id == "@ryu/calendar")
        .expect("built-in manifest `@ryu/calendar` is compiled in");
    let e = plugin_manifest_to_entry(m);
    assert_eq!(e["org_verified"], json!(true));
    assert_eq!(e["org_verified_tier"], json!("official"));
    assert_eq!(e["publisher_trust"], json!("gold"));
    assert_eq!(e["publisher_trust_source"], json!("ryu_staff"));

    // A manifest Core does NOT ship stays unbadged — the check is provenance,
    // never the `@ryu/` string, which anything writing to `~/.ryu/plugins` can
    // put in a manifest.
    let sideloaded = PluginManifest {
        id: "@ryu/definitely-not-shipped".to_owned(),
        name: "Impostor".to_owned(),
        version: "1.0.0".to_owned(),
        ..Default::default()
    };
    let e = plugin_manifest_to_entry(&sideloaded);
    assert!(e.get("org_verified").is_none());
    assert_eq!(e["system"], json!(false));
    for id in ["@ryu/docs", "@ryu/composio-connect", "@ryu/ghost"] {
        let protected = PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            ..Default::default()
        };
        assert_eq!(
            plugin_manifest_to_entry(&protected)["system"],
            json!(true),
            "{id} is uninstall-protected, so it is labelled system"
        );
    }
    assert!(e.get("org_verified_tier").is_none());

    // A remote card's own verification survives the projector — including a
    // `false` (a revoked check must propagate), while absent stays absent so a
    // source that never computes it is not flattened to "not verified".
    let verified = json!({
        "id": "acme/widget",
        "org_verified": true,
        "org_verified_tier": "partner",
        "publisher_trust": "blue",
        "publisher_trust_source": "stripe_connect",
    });
    let e = plugin_marketplace_item_to_entry(&verified, "ryu-marketplace").unwrap();
    assert_eq!(e["org_verified"], json!(true));
    assert_eq!(e["org_verified_tier"], json!("partner"));
    assert_eq!(e["publisher_trust"], json!("blue"));
    assert_eq!(e["publisher_trust_source"], json!("stripe_connect"));

    let revoked = json!({ "id": "acme/widget", "org_verified": false });
    let e = plugin_marketplace_item_to_entry(&revoked, "ryu-marketplace").unwrap();
    assert_eq!(e["org_verified"], json!(false));

    let unknown = json!({ "id": "acme/widget" });
    let e = plugin_marketplace_item_to_entry(&unknown, "ryu-marketplace").unwrap();
    assert!(e.get("org_verified").is_none());
}

#[test]
fn marketplace_item_maps_with_name_fallback() {
    // Full item.
    let full =
        json!({ "id": "acme/widget", "name": "Widget", "description": "d", "version": "2.0.0" });
    let e = plugin_marketplace_item_to_entry(&full, "ryu-marketplace").unwrap();
    assert_eq!(e["id"], "acme/widget");
    assert_eq!(e["name"], "Widget");
    assert_eq!(e["source"], "ryu-marketplace");
    assert_eq!(e["built_in"], false);

    // Missing name → falls back to id; missing version → empty string.
    let sparse = json!({ "id": "acme/bare" });
    let e2 = plugin_marketplace_item_to_entry(&sparse, "ryu-marketplace").unwrap();
    assert_eq!(e2["name"], "acme/bare");
    assert_eq!(e2["version"], "");

    // No id → dropped.
    assert!(plugin_marketplace_item_to_entry(&json!({ "name": "x" }), "s").is_none());
}

/// A hosted theme card's `theme_preview` (projected by the marketplace server
/// from the stored manifest) rides through the projector onto the store card,
/// so a theme's icon square is its palette rather than a dither avatar. Only
/// emitted when the source card actually carries the object.
#[test]
fn hosted_theme_preview_rides_through_the_projector() {
    let preview = json!({
        "bg": "#0b0e14",
        "surface": "#141926",
        "primary": "#7c9cff",
        "text": "#e6e9f0",
        "mode": "dark",
    });
    let item = json!({
        "id": "@acme/midnight-theme",
        "name": "Midnight Theme",
        "category": "Themes",
        "theme_preview": preview,
    });
    let e = plugin_marketplace_item_to_entry(&item, "ryu-marketplace").unwrap();
    assert_eq!(e["theme_preview"], preview);
    assert_eq!(e["category"], "Themes");

    // A card without the palette emits no key — an ordinary plugin's card is
    // byte-identical, and the client keeps its last-resort glyph.
    let plain = json!({ "id": "@acme/tool", "name": "Tool" });
    let e = plugin_marketplace_item_to_entry(&plain, "ryu-marketplace").unwrap();
    assert!(e.get("theme_preview").is_none());
}

/// Remix policy and credit survive the projector: an explicit `false` is the
/// author's opt-out and must not be dropped, and a credit stays an object.
#[test]
fn marketplace_item_projects_remix_policy_and_credit() {
    let locked = json!({ "id": "@acme/locked", "name": "Locked", "allow_remix": false });
    let e = plugin_marketplace_item_to_entry(&locked, "ryu-marketplace").unwrap();
    assert_eq!(e["allow_remix"], false);

    let remix = json!({
        "id": "@acme/remix",
        "name": "Remix",
        "allow_remix": true,
        "remixed_from": { "kind": "plugin", "id": "@acme/original" },
    });
    let e = plugin_marketplace_item_to_entry(&remix, "ryu-marketplace").unwrap();
    assert_eq!(e["allow_remix"], true);
    assert_eq!(
        e["remixed_from"],
        json!({ "kind": "plugin", "id": "@acme/original" })
    );

    let plain = json!({ "id": "@acme/plain", "name": "Plain", "remixed_from": "x" });
    let e = plugin_marketplace_item_to_entry(&plain, "ryu-marketplace").unwrap();
    assert!(e.get("allow_remix").is_none());
    assert!(e.get("remixed_from").is_none());
}

/// The community trust contract, end to end through the projector. `origin`
/// must survive as **snake_case** — the store's notice keys on
/// `entry.origin === "community"`, and a dropped/renamed field would render an
/// unreviewed third-party listing with no warning at all.
#[test]
fn community_card_projects_its_unreviewed_trust_fields() {
    let card = crate::catalog_source::COMMUNITY_ORIGIN;
    let item = json!({
        "id": "gh:acme/ryu-thing",
        "name": "ryu-thing",
        "description": "a community thing",
        "type": "app",
        "has_companion": true,
        "origin": card,
        "reviewed": false,
        "provenance": "github-topic",
        "descriptor_only": true,
        "repo_url": "https://github.com/acme/ryu-thing",
        "developer": "acme",
        "stars": 42,
        "license": "MIT",
    });
    let e = plugin_marketplace_item_to_entry(&item, "github-topic").unwrap();
    assert_eq!(e["origin"], card);
    assert_eq!(e["reviewed"], false);
    assert_eq!(e["provenance"], "github-topic");
    assert_eq!(e["stars"], 42);
    assert_eq!(e["repo_url"], "https://github.com/acme/ryu-thing");
    assert_eq!(e["developer"], "acme");
    assert_eq!(e["license"], "MIT");
    // Declared descriptor-only → browse-only, no install CTA.
    assert_eq!(e["descriptor_only"], true);
    assert_eq!(e["type"], "app");
    assert_eq!(e["built_in"], false);
}

/// A community MARKETPLACE entry's grouping stamp must survive the projector,
/// snake_case end to end — the store's "Community Marketplaces" section files
/// each row under its marketplace's sub-heading by these two keys.
#[test]
fn a_marketplace_entry_card_keeps_its_grouping_stamp() {
    let item = json!({
        "id": "ghmp:acme/bazaar:thing-tool",
        "name": "Thing Tool",
        "description": "Does the thing.",
        "type": "plugin",
        "origin": "community",
        "reviewed": false,
        "provenance": "github-topic",
        "descriptor_only": true,
        "repo_url": "https://github.com/acme/thing-tool",
        "catalog_source_id": "acme/bazaar",
        "catalog_source_name": "The Bazaar",
    });
    let e = plugin_marketplace_item_to_entry(&item, "github-topic").unwrap();
    assert_eq!(e["catalog_source_id"], "acme/bazaar");
    assert_eq!(e["catalog_source_name"], "The Bazaar");
    // And the rest of the community trust contract travels with it.
    assert_eq!(e["origin"], "community");
    assert_eq!(e["reviewed"], false);
    assert_eq!(e["descriptor_only"], true);
    assert_eq!(e["repo_url"], "https://github.com/acme/thing-tool");
}

/// `descriptor_only` is now card-declared, with the legacy integrations.sh id
/// as the fallback — a first-party card must NOT become browse-only by accident.
#[test]
fn descriptor_only_prefers_the_card_then_falls_back_to_the_source_id() {
    let plain = json!({ "id": "acme/widget" });
    assert_eq!(
        plugin_marketplace_item_to_entry(&plain, "ryu-catalog").unwrap()["descriptor_only"],
        false
    );
    assert_eq!(
        plugin_marketplace_item_to_entry(&plain, "integrations-sh").unwrap()["descriptor_only"],
        true,
        "the legacy integrations.sh source predates the card field"
    );
    let declared = json!({ "id": "gh:a/b", "descriptor_only": true });
    assert_eq!(
        plugin_marketplace_item_to_entry(&declared, "github-topic").unwrap()["descriptor_only"],
        true
    );
}

#[test]
fn merge_dedups_by_id_first_writer_wins() {
    let builtins = vec![json!({ "id": "a", "source": "built-in" })];
    let marketplace = vec![
        json!({ "id": "a", "source": "ryu-marketplace" }), // dup of builtin → dropped
        json!({ "id": "b", "source": "ryu-marketplace" }),
    ];
    let registry = vec![
        json!({ "id": "b", "source": "registry" }), // dup → dropped
        json!({ "id": "c", "source": "registry" }),
        json!({ "no_id": true }), // no id → dropped
    ];
    let merged = merge_plugin_catalog_entries(vec![builtins, marketplace, registry]);
    assert_eq!(merged.len(), 3, "a, b, c — deduped");
    assert_eq!(merged[0]["id"], "a");
    assert_eq!(
        merged[0]["source"], "built-in",
        "first writer (builtin) wins for 'a'"
    );
    assert_eq!(merged[1]["id"], "b");
    assert_eq!(
        merged[1]["source"], "ryu-marketplace",
        "first writer wins for 'b'"
    );
    assert_eq!(merged[2]["id"], "c");
}
