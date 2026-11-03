//! Community marketplaces (`ryu-marketplace` topic).

use super::*;

#[test]
fn ghmp_ids_parse_and_foreign_ids_are_rejected() {
    assert_eq!(
        parse_ghmp_id("ghmp:acme/bazaar:thing-tool"),
        Some((
            "acme".to_string(),
            "bazaar".to_string(),
            "thing-tool".to_string()
        ))
    );
    for foreign in [
        "gh:acme/bazaar",
        "acme/bazaar:thing-tool",
        "ghmp:acme",
        "ghmp:acme/",
        "ghmp:acme/bazaar:",
        "ghmp:acme/bazaar:a/b",
        "ghmp:acme/a/b:thing",
        "",
    ] {
        assert!(
            parse_ghmp_id(foreign).is_none(),
            "`{foreign}` must not parse as a marketplace-entry id"
        );
    }
}

#[test]
fn a_marketplace_entry_card_is_grouped_and_trust_stamped() {
    let record = marketplace_repo("acme/bazaar");
    let marketplace = record.marketplace.as_ref().unwrap();
    let entry = &marketplace.entries[0];
    let item = marketplace_entry_to_item(&record, marketplace, entry);

    assert_eq!(
        item["id"], "ghmp:acme/bazaar:thing-tool",
        "the id is namespaced so it can never collide with a single-listing id"
    );
    assert_eq!(item["name"], "Thing Tool", "displayName wins over name");
    assert_eq!(item["type"], "plugin");
    // The grouping stamp is what the client files the row under.
    assert_eq!(item["catalog_source_id"], "acme/bazaar");
    assert_eq!(item["catalog_source_name"], "The Bazaar");
    // The repo the row points at is the PLUGIN's, never the marketplace's.
    assert_eq!(item["repo_url"], "https://github.com/acme/thing-tool");
    assert_eq!(item["install_source"], "https://github.com/acme/thing-tool");
    // Same trust triple as any community listing.
    assert_eq!(item["origin"], COMMUNITY_ORIGIN);
    assert_eq!(item["reviewed"], false);
    assert_eq!(item["provenance"], GITHUB_TOPIC_SOURCE_ID);
    assert_eq!(item["descriptor_only"], true);
    // And a card is never a manifest carrier.
    assert!(item.get("manifest").is_none());
}

#[test]
fn a_marketplace_entry_classifies_as_an_app_from_has_companion() {
    let record = marketplace_repo("acme/bazaar");
    let marketplace = record.marketplace.as_ref().unwrap();
    let canvas = &marketplace.entries[1];
    let item = marketplace_entry_to_item(&record, marketplace, canvas);
    assert_eq!(item["type"], "app");
    assert_eq!(item["has_companion"], true);
    // The source-object form resolves to the plugin's repo too.
    assert_eq!(item["repo_url"], "https://github.com/acme/canvas");
}

#[test]
fn a_marketplace_manifest_scrubs_hostile_fields_and_requires_a_name() {
    // A hostile entry keeps what the allowlist lets through and drops the rest.
    let parsed = GithubMarketplace::from_manifest(
        &serde_json::json!({
            "name": "Bazaar",
            "plugins": [
                {
                    "name": "ok",
                    "displayName": "OK",
                    "icon": "https://evil.example/x.svg",
                    "version": "1.0.0 && curl evil",
                    "description": "line\nbreak",
                    "source": "javascript:alert(1)",
                    "ui_code": "<script>alert(1)</script>",
                }
            ],
        }),
        "acme/bazaar",
    )
    .expect("an entry with a name parses");
    let entry = &parsed.entries[0];
    assert_eq!(entry.name, "ok");
    assert_eq!(entry.display_name.as_deref(), Some("OK"));
    // The icon slot only accepts glyph ids; a URL in it is dropped.
    assert!(entry.icon.is_none());
    // Version alphabet is closed; the hostile source repo is dropped, so the
    // card falls back to the marketplace repo's URL.
    assert!(entry.version.is_none());
    assert!(entry.source_repo.is_none());
    // Control characters are stripped from free text.
    assert_eq!(entry.description.as_deref(), Some("linebreak"));

    // An entry without a name cannot form a stable id → the whole marketplace
    // is treated as "nothing to show" and degrades to a single repo listing.
    assert!(GithubMarketplace::from_manifest(
        &serde_json::json!({ "plugins": [{ "displayName": "No Name" }] }),
        "acme/bazaar",
    )
    .is_none());
}

#[test]
fn a_marketplace_wins_the_dedupe_over_a_single_listing_of_the_same_repo() {
    // The same repo tagged `ryu-app` AND `ryu-marketplace`: the marketplace
    // classification must replace the single listing, not sit beside it.
    let app = repo_item_to_record(&repo("acme/bazaar", 6), true).unwrap();
    let marketplace = marketplace_repo("acme/bazaar");
    let merged = merge_marketplace_records(vec![app], vec![marketplace]);

    assert_eq!(merged.len(), 1, "one repo, one record");
    assert!(merged[0].is_marketplace);
    assert!(merged[0].marketplace.is_some());
}

#[test]
fn an_unhydrated_marketplace_degrades_to_a_single_repo_listing() {
    // A `ryu-marketplace` repo whose marketplace.json has not been probed yet
    // (or carries no entries) still renders — as the repo itself.
    let record = repo_item_to_marketplace_record(&repo("acme/bazaar", 3)).unwrap();
    assert!(record.marketplace.is_none());
    let item = record_to_item(&record);
    assert_eq!(item["id"], "gh:acme/bazaar");
    assert_eq!(item["name"], "bazaar");
    // Still a community listing under the trust notice.
    assert_eq!(item["origin"], COMMUNITY_ORIGIN);
    assert_eq!(item["reviewed"], false);
}

#[test]
fn a_marketplace_probe_is_carried_across_refreshes_and_expires() {
    let now = unix_now();
    let mut marketplace = marketplace_repo("acme/bazaar");
    let fresh = repo_item_to_marketplace_record(&repo("acme/bazaar", 9)).unwrap();
    // A fresh record has never been probed.
    assert!(fresh.marketplace_probe_is_due(now));

    // The probe (a HIT here) carries over on a case-insensitive full_name match.
    let mut target = repo_item_to_marketplace_record(&repo("ACME/Bazaar", 9)).unwrap();
    carry_manifests(
        std::slice::from_mut(&mut target),
        Some(&[marketplace.clone()]),
    );
    assert!(target.marketplace.is_some());
    assert_eq!(
        target.marketplace.as_ref().unwrap().name,
        "The Bazaar",
        "the parsed marketplace carries over, not just the probe timestamp"
    );

    // And a remembered probe expires, so a repo that later ADDS a marketplace
    // is picked up.
    marketplace.marketplace_probed_at = now;
    assert!(!marketplace.marketplace_probe_is_due(now));
    assert!(marketplace.marketplace_probe_is_due(now + MANIFEST_PROBE_TTL_SECS));
}

#[test]
fn marketplace_search_matches_entry_names_and_respects_the_type_filter() {
    let record = marketplace_repo("acme/bazaar");
    // Build a small cache and run the item-level filtering that `search` does
    // after expanding records, without touching the network.
    let expanded: Vec<Value> = match record.marketplace.as_ref() {
        Some(marketplace) => marketplace
            .entries
            .iter()
            .map(|entry| marketplace_entry_to_item(&record, marketplace, entry))
            .collect(),
        None => vec![record_to_item(&record)],
    };
    let filter = |type_filter: &str, needle: &str| -> Vec<Value> {
        let needle = needle.trim().to_ascii_lowercase();
        expanded
            .iter()
            .filter(|item| match type_filter {
                "app" => item.get("type").and_then(Value::as_str) == Some("app"),
                "plugin" => item.get("type").and_then(Value::as_str) != Some("app"),
                _ => true,
            })
            .filter(|item| {
                if needle.is_empty() {
                    return true;
                }
                let hay = [
                    item.get("name").and_then(Value::as_str).unwrap_or(""),
                    item.get("description")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    item.get("id").and_then(Value::as_str).unwrap_or(""),
                ];
                if hay.iter().any(|s| s.to_ascii_lowercase().contains(&needle)) {
                    return true;
                }
                item.get("topics")
                    .and_then(Value::as_array)
                    .is_some_and(|topics| {
                        topics.iter().any(|t| {
                            t.as_str()
                                .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
                        })
                    })
            })
            .cloned()
            .collect()
    };

    assert_eq!(filter("", "").len(), 2);
    let apps = filter("app", "");
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["id"], "ghmp:acme/bazaar:canvas");
    let plugins = filter("plugin", "");
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0]["id"], "ghmp:acme/bazaar:thing-tool");
    // Searching "thing" finds the ENTRY by its display name, not just the repo.
    assert_eq!(filter("", "thing").len(), 1);
    // Searching the marketplace repo finds the entries too (the id carries it).
    assert_eq!(filter("", "bazaar").len(), 2);
    // A repo topic still matches its entries, as it did before the filter
    // moved from the record to the expanded item level.
    assert_eq!(filter("", "ryu-plugin").len(), 2);
}
