//! Card projection from hydrated manifests and probe carry-over.

use super::*;

#[test]
fn card_name_and_icon_come_from_the_manifest_not_the_repo_slug() {
    // The bug this closes: every community card was titled `<repo>` and iconed
    // with the OWNER's avatar, so an org's listings were indistinguishable and
    // none matched the name the plugin actually ships under.
    let record = hydrated(
        "acme/ryu-thing-plugin",
        serde_json::json!({
            "id": "@acme/thing",
            "name": "Thing",
            "icon": "lucide:brain",
            "iconUrl": "https://cdn.example.com/thing.png",
            "description": "Does the thing.",
            "version": "2.1.0",
            "tagline": "the thing, done",
            "category": "Productivity",
        }),
    );
    let item = record_to_item(&record);
    assert_eq!(item["name"], "Thing");
    assert_eq!(item["icon"], "lucide:brain");
    assert_eq!(item["icon_url"], "https://cdn.example.com/thing.png");
    assert_eq!(item["description"], "Does the thing.");
    assert_eq!(item["version"], "2.1.0");
    assert_eq!(item["tagline"], "the thing, done");
    assert_eq!(item["category"], "Productivity");
}

#[test]
fn an_unhydrated_card_falls_back_to_the_repo_slug_and_carries_no_art() {
    // Hydration is best-effort and deadline-bounded: a listing it has not
    // reached must still render, not blank out.
    let record = repo_item_to_record(&repo("acme/weather-thing", 4), false).unwrap();
    assert!(record.manifest.is_none());
    let item = record_to_item(&record);
    assert_eq!(item["name"], "weather-thing");
    // No art of ANY kind — deliberately including the owner's avatar, which
    // used to stand in here. `AppIcon` paints the generative tile seeded from
    // the listing id only for a card with no icon at all, so the avatar was
    // what forced every community card onto the flat `bg-muted` branch while
    // the shelves beside it showed painted plates.
    assert_eq!(item["icon"], Value::Null);
    assert_eq!(item["icon_url"], Value::Null);
    assert_eq!(item["icon_dither"], Value::Null);
    assert_eq!(item["icon_background"], Value::Null);
    assert_eq!(item["category"], "Community");
}

#[test]
fn a_community_card_carries_the_icon_plate_its_manifest_declares() {
    // The other half of the same shelf-consistency fix: a repo that DOES
    // declare the plate gets the identical painted square a first-party
    // listing gets, because both travel the same two keys.
    let record = hydrated(
        "acme/ryu-thing",
        serde_json::json!({
            "name": "Thing",
            "iconDither": { "from": 288, "to": "transparent", "direction": "down" },
            "iconBackground": "#0099ff",
        }),
    );
    let item = record_to_item(&record);
    assert_eq!(item["icon_dither"]["from"], 288.0);
    assert_eq!(item["icon_dither"]["to"], "transparent");
    assert_eq!(item["icon_dither"]["direction"], "down");
    assert_eq!(item["icon_background"], "#0099ff");

    // …and a plate that is really a CSS payload is dropped, not sanitized: this
    // JSON is unsigned and lands in an inline `style`.
    let hostile = hydrated(
        "acme/ryu-evil",
        serde_json::json!({
            // A name so the display record survives at all — the assertions
            // below are then about the plate being rejected, not about the
            // whole manifest having been dropped.
            "name": "Evil",
            "iconDither": { "from": "red; background: url(https://x/y)" },
            "iconBackground": "url(https://x/y); position: fixed",
        }),
    );
    let item = record_to_item(&hostile);
    assert_eq!(item["name"], "Evil");
    assert_eq!(item["icon_dither"], Value::Null);
    assert_eq!(item["icon_background"], Value::Null);
}

#[test]
fn a_manifest_can_supply_presentation_but_never_identity_or_trust() {
    // A topic-squatting repo may title itself anything; it must not be able to
    // claim someone else's id, publisher, or a reviewed status.
    let record = hydrated(
        "squatter/evil",
        serde_json::json!({
            "id": "@ryu/mail",
            "name": "Ryu Official Mail",
            "developer": "Ryu",
            "origin": "builtin",
            "reviewed": true,
            "descriptor_only": false,
            "built_in": true,
        }),
    );
    let item = record_to_item(&record);
    // A title that reads as Ryu's own is not honoured either: the listing is
    // shown under the repository that actually published it.
    assert_eq!(item["name"], "squatter/evil");
    // …and every identity/trust key is still GitHub's and Core's.
    assert_eq!(item["id"], "gh:squatter/evil");
    assert_eq!(item["developer"], "squatter");
    assert_eq!(item["owner"], "squatter");
    assert_eq!(item["origin"], COMMUNITY_ORIGIN);
    assert_eq!(item["reviewed"], false);
    assert_eq!(item["descriptor_only"], true);
}

#[test]
fn a_companion_icon_is_the_glyph_fallback() {
    // How an app authors its icon — same fallback `plugin_manifest_to_entry` uses.
    let record = hydrated(
        "acme/app",
        serde_json::json!({ "name": "App", "companion": { "icon": "ai-image" } }),
    );
    assert_eq!(record_to_item(&record)["icon"], "ai-image");
}

#[test]
fn an_icon_id_is_a_glyph_id_never_a_url_or_data_uri() {
    // `iconToUrl` returns a `data:`/`http(s):` id UNCHANGED and drops it into a
    // CSS `mask-image`, so the alphabet is constrained here, at the boundary.
    for good in ["lucide:brain", "activity-03", "svgl:brave|dark", "mic_01.x"] {
        assert_eq!(scrub_icon_id(good).as_deref(), Some(good), "{good}");
    }
    for bad in [
        "https://evil.example/x.svg",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "javascript:alert(1)",
        "lucide:brain\"); background:url(https://evil.example",
        "a b",
        "",
        "   ",
    ] {
        assert!(scrub_icon_id(bad).is_none(), "{bad}");
    }
    // And over-long ids are refused rather than truncated into a different id.
    assert!(scrub_icon_id(&"a".repeat(MAX_ICON_ID_CHARS + 1)).is_none());
}

#[test]
fn manifest_strings_are_control_stripped_and_bounded() {
    let record = hydrated(
        "acme/wordy",
        serde_json::json!({
            "name": format!("Line\nBreak\u{0}{}", "x".repeat(500)),
            "version": "1.0.0; rm -rf /",
            "description": "y".repeat(5000),
        }),
    );
    let manifest = record.manifest.as_ref().unwrap();
    let name = manifest.name.as_deref().unwrap();
    assert!(!name.contains('\n') && !name.contains('\u{0}'), "{name}");
    assert_eq!(name.chars().count(), MAX_NAME_CHARS);
    // A version outside semver's alphabet is dropped, not sanitized into a lie.
    assert!(manifest.version.is_none());
    assert_eq!(
        manifest.description.as_deref().unwrap().chars().count(),
        MAX_DESCRIPTION_CHARS
    );
}

#[test]
fn an_empty_manifest_hydrates_to_nothing_rather_than_blank_fields() {
    assert!(RepoManifestDisplay::from_manifest(&serde_json::json!({})).is_none());
    assert!(RepoManifestDisplay::from_manifest(&serde_json::json!([])).is_none());
    // A manifest with only non-display keys is equally "nothing to show".
    assert!(RepoManifestDisplay::from_manifest(&serde_json::json!({ "ui_code": "x" })).is_none());
}

#[test]
fn carry_manifests_preserves_probed_hits_and_misses() {
    // The negative cache. Without carrying a MISS, every refresh would re-pay
    // five raw fetches for each of the (many) manifest-less listings, forever.
    let hit = hydrated("acme/has-manifest", serde_json::json!({ "name": "Has" }));
    let mut miss = repo_item_to_record(&repo("acme/no-manifest", 1), false).unwrap();
    miss.manifest_probed_at = unix_now();
    let previous = vec![hit, miss];

    let mut fresh = vec![
        repo_item_to_record(&repo("ACME/Has-Manifest", 9), false).unwrap(),
        repo_item_to_record(&repo("acme/no-manifest", 2), false).unwrap(),
        repo_item_to_record(&repo("acme/brand-new", 0), false).unwrap(),
    ];
    carry_manifests(&mut fresh, Some(&previous));

    assert_eq!(
        fresh[0].manifest.as_ref().and_then(|m| m.name.as_deref()),
        Some("Has"),
        "a known hit carries over (match is case-insensitive on full_name)"
    );
    assert!(fresh[1].manifest.is_none());
    assert!(
        !fresh[1].manifest_probe_is_due(unix_now()),
        "a known MISS must stay remembered, or the probe never amortizes"
    );
    assert!(
        fresh[2].manifest_probe_is_due(unix_now()),
        "a listing never seen before is due"
    );
}

#[test]
fn a_remembered_probe_expires_so_a_later_manifest_is_picked_up() {
    let now = unix_now();
    let mut record = repo_item_to_record(&repo("acme/thing", 1), false).unwrap();
    record.manifest_probed_at = now;
    assert!(!record.manifest_probe_is_due(now));
    assert!(record.manifest_probe_is_due(now + MANIFEST_PROBE_TTL_SECS));
}

#[test]
fn the_detail_view_lift_scrubs_the_same_fields_the_card_does() {
    let lifted = manifest_display_fields(&serde_json::json!({
        "id": "com.acme.thing",
        "name": "Thing\nInjected",
        "icon": "https://evil.example/x.svg",
        "version": "1.0.0 && curl evil",
    }));
    assert_eq!(lifted["manifestName"], "ThingInjected");
    // A URL in the glyph slot is dropped here exactly as it is on the card —
    // this merge lands ON TOP of the card's sanitized values.
    assert!(lifted.get("icon").is_none());
    assert!(lifted.get("version").is_none());
}
