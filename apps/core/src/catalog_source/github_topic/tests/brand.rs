//! Protected-brand names and art on community listings.

use super::*;

fn brand_marketplace(record: &GithubTopicRecord) -> GithubMarketplace {
    GithubMarketplace::from_manifest(
        &serde_json::json!({
            "name": "Claude Official Marketplace",
            "plugins": [{
                "name": "chat",
                "displayName": "ChatGPT Pro",
                "source": "acme/chat",
                "icon": "svgl:openai",
                "iconUrl": "https://cdn.example.com/openai.png",
            }],
        }),
        &record.full_name,
    )
    .expect("marketplace parses")
}

#[test]
fn a_brand_named_card_is_shown_as_owner_repo_without_declared_art() {
    let record = hydrated(
        "evil/desktop",
        serde_json::json!({
            "name": "Claude Opus Desktop",
            "icon": "lucide:brain",
            "iconUrl": "https://cdn.example.com/claude.png",
            "banner": { "style": "animated-gradient", "gradient": { "preset": "vortex" } },
        }),
    );
    let item = record_to_item(&record);
    assert_eq!(item["name"], "evil/desktop");
    assert_eq!(item["icon"], Value::Null);
    assert_eq!(item["icon_url"], Value::Null);
    assert_eq!(item["banner"], Value::Null);
    assert_eq!(item["developer"], "evil");
    assert_eq!(item["origin"], COMMUNITY_ORIGIN);
}

#[test]
fn lookalike_and_invisible_character_brand_names_are_guarded_too() {
    for name in [
        "Cl\u{0430}ude Pro",
        "Chat\u{200B}GPT",
        "Gem\u{202E}ini Ultra",
        "\u{FF23}\u{FF4C}\u{FF41}\u{FF55}\u{FF44}\u{FF45}",
        "RyuMail",
    ] {
        let record = hydrated("evil/thing", serde_json::json!({ "name": name }));
        assert_eq!(record_to_item(&record)["name"], "evil/thing", "{name:?}");
    }
}

#[test]
fn a_protected_repo_slug_falls_back_to_owner_repo() {
    let record = repo_item_to_record(&repo("acme/chatgpt-helper", 1), false).unwrap();
    assert_eq!(record_to_item(&record)["name"], "acme/chatgpt-helper");
}

#[test]
fn a_brand_glyph_is_dropped_from_an_ordinary_card() {
    let branded = hydrated(
        "acme/thing",
        serde_json::json!({ "name": "Thing", "icon": "svgl:claude-ai" }),
    );
    let item = record_to_item(&branded);
    assert_eq!(item["name"], "Thing");
    assert_eq!(item["icon"], Value::Null);
    let plain = hydrated(
        "acme/thing",
        serde_json::json!({ "name": "Thing", "icon": "lucide:brain" }),
    );
    assert_eq!(record_to_item(&plain)["icon"], "lucide:brain");
}

#[test]
fn scrubbed_text_drops_format_characters() {
    assert_eq!(
        scrub_text("Cla\u{202E}u\u{200B}de\u{E0041}\u{FEFF}\u{00AD} Tool", 80).as_deref(),
        Some("Claude Tool")
    );
    assert_eq!(scrub_text("\u{200B}\u{2060}", 80), None);
    let display = RepoManifestDisplay::from_manifest(
        &serde_json::json!({ "name": "Weather\u{200D} Widget" }),
    )
    .unwrap();
    assert_eq!(display.name.as_deref(), Some("Weather Widget"));
}

#[test]
fn a_brand_named_marketplace_entry_and_collection_are_qualified() {
    let record = repo_item_to_marketplace_record(&repo("acme/bazaar", 1)).unwrap();
    let marketplace = brand_marketplace(&record);
    let entry = &marketplace.entries[0];
    let item = marketplace_entry_to_item(&record, &marketplace, entry);
    assert_eq!(item["name"], "acme/bazaar/chat");
    assert_eq!(item["catalog_source_name"], "acme/bazaar");
    assert_eq!(item["icon"], Value::Null);
    assert_eq!(item["icon_url"], Value::Null);
    assert_eq!(item["owner"], "acme");
}

#[test]
fn the_detail_lift_drops_a_brand_name_and_its_art() {
    let lifted = manifest_display_fields(&serde_json::json!({
        "name": "Gemini Ultra",
        "icon": "lucide:brain",
        "iconUrl": "https://cdn.example.com/gemini.png",
        "description": "A helper.",
    }));
    assert!(lifted.get("manifestName").is_none());
    assert!(lifted.get("icon").is_none());
    assert!(lifted.get("iconUrl").is_none());
    assert_eq!(lifted["description"], "A helper.");
    let glyph = manifest_display_fields(&serde_json::json!({
        "name": "Thing",
        "icon": "svgl:claude-ai",
    }));
    assert_eq!(glyph["manifestName"], "Thing");
    assert!(glyph.get("icon").is_none());
}

#[test]
fn the_detail_lift_of_a_guarded_card_keeps_its_art_withheld() {
    // A card guarded by its repo slug (`evil/claude-desktop`) or its marketplace
    // entry name declares an ordinary manifest name: the detail must not repaint
    // the art the card dropped.
    let manifest = serde_json::json!({
        "name": "Desktop",
        "icon": "lucide:brain",
        "iconUrl": "https://cdn.example.com/claude.png",
        "banner": { "style": "animated-gradient", "gradient": { "preset": "vortex" } },
        "description": "A helper.",
    });
    let lifted = manifest_display_fields_for_card(&manifest, true);
    assert!(lifted.get("manifestName").is_none());
    assert!(lifted.get("icon").is_none());
    assert!(lifted.get("iconUrl").is_none());
    assert!(lifted.get("banner").is_none());
    assert_eq!(lifted["description"], "A helper.");
    let plain = manifest_display_fields_for_card(&manifest, false);
    assert_eq!(plain["manifestName"], "Desktop");
    assert_eq!(plain["icon"], "lucide:brain");
    assert!(plain.get("banner").is_some());
}
