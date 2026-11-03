//! Ids, install descriptors, enrichment, URL and token handling.

use super::*;

#[test]
fn app_vs_plugin_comes_from_the_matched_query_not_the_topics_array() {
    // The repo's own `topics` say "ryu-plugin", but it was found under the
    // app topic — the query is the ground truth (topics are publisher-controlled).
    let record = repo_item_to_record(&repo("acme/claims-plugin", 2), true).unwrap();
    let item = record_to_item(&record);
    assert_eq!(item["type"], "app");
    assert_eq!(item["has_companion"], true);
}

#[test]
fn card_carries_the_unreviewed_trust_triple() {
    let record = repo_item_to_record(&repo("acme/thing", 7), false).unwrap();
    let item = record_to_item(&record);
    assert_eq!(item["origin"], COMMUNITY_ORIGIN);
    assert_eq!(item["reviewed"], false);
    assert_eq!(item["provenance"], GITHUB_TOPIC_SOURCE_ID);
    assert_eq!(item["descriptor_only"], true);
    assert_eq!(item["stars"], 7);
    // A repo has no version until its manifest is read in `detail`.
    assert_eq!(item["version"], "");
    // And a card is never a manifest carrier.
    assert!(item.get("manifest").is_none());
}

#[test]
fn gh_ids_parse_and_foreign_ids_are_rejected() {
    assert_eq!(
        parse_gh_id("gh:acme/ryu-thing"),
        Some(("acme".to_string(), "ryu-thing".to_string()))
    );
    for foreign in [
        "@ryu/mail",
        "acme/ryu-thing",
        "gh:acme",
        "gh:/thing",
        "gh:acme/",
        "gh:acme/a/b",
        "",
    ] {
        assert!(
            parse_gh_id(foreign).is_none(),
            "`{foreign}` must not parse as a github-topic id"
        );
    }
}

#[test]
fn manifest_enrichment_lifts_the_allowlist_and_drops_runnable_code() {
    let manifest = serde_json::json!({
        "id": "com.acme.thing",
        "name": "Thing",
        "version": "1.2.3",
        "stability": "Beta",
        "description": "a thing",
        "category": "Productivity",
        "ui_code": "<script>alert(1)</script>",
        "ui_code_sha256": "deadbeef",
        "backend_code": "require('child_process').exec('rm -rf /')",
        "backend_sha256": "cafebabe",
        "artifact_url": "https://evil.example/x.tgz",
        "runnables": [{ "kind": "companion", "id": "ui", "name": "UI" }],
    });
    let lifted = manifest_display_fields(&manifest);
    assert_eq!(lifted["version"], "1.2.3");
    assert_eq!(lifted["stability"], "beta");
    assert_eq!(lifted["category"], "Productivity");
    // The manifest's claimed id is disclosed SEPARATELY, never as the entry id.
    assert_eq!(lifted["manifestId"], "com.acme.thing");
    assert!(lifted.get("id").is_none());
    for forbidden in [
        "ui_code",
        "ui_code_sha256",
        "backend_code",
        "backend_sha256",
        "artifact_url",
    ] {
        assert!(
            lifted.get(forbidden).is_none(),
            "`{forbidden}` must never travel from an unsigned source"
        );
    }
    // Runnable KINDS only — the shapes, never their code.
    assert_eq!(lifted["runnableKinds"], serde_json::json!(["companion"]));
}

#[test]
fn codex_plugin_interface_metadata_projects_to_the_shared_listing_contract() {
    assert!(REPO_MANIFEST_PATHS.contains(&".codex-plugin/plugin.json"));
    assert!(REPO_MANIFEST_PATHS.contains(&".claude-plugin/plugin.json"));
    let manifest = serde_json::json!({
        "$schema": "https://developers.openai.com/codex/schemas/plugin.json",
        "name": "conductor",
        "version": "1.0.0",
        "description": "fallback",
        "author": { "name": "Resend", "url": "https://resend.com" },
        "homepage": "https://github.com/resend/openai-plugins",
        "repository": "https://github.com/resend/openai-plugins",
        "license": "MIT",
        "keywords": ["email", "automation"],
        "banner": { "style": "gradient", "colors": ["#111111", "#222222"] },
        "external": true,
        "provides": [{
            "capability": "browser.control",
            "title": "Browser",
            "selectable": true,
            "target": "remote-desktop",
            "tools": { "browser.navigate": { "tool": "remote.open" } }
        }],
        "interface": {
            "displayName": "Conductor",
            "shortDescription": "A short pitch",
            "longDescription": "A longer public description",
            "category": "Productivity",
            "websiteURL": "https://resend.com/conductor",
            "privacyPolicyURL": "https://resend.com/legal/privacy",
            "termsOfServiceURL": "https://resend.com/legal/terms",
            "defaultPrompt": ["Draft an email"],
            "screenshots": ["https://cdn.example.com/conductor.png"],
            "composerIcon": "lucide:mail",
            "logo": "https://cdn.example.com/conductor.svg",
            "developerName": "Resend",
            "capabilities": ["Send email"]
        },
        "permission_grants": ["tool:execute"],
        "ui_code": "must not travel"
    });
    let display = RepoManifestDisplay::from_manifest(&manifest).expect("metadata survives");
    assert_eq!(display.name.as_deref(), Some("Conductor"));
    assert_eq!(display.tagline.as_deref(), Some("A short pitch"));
    assert_eq!(
        display.description.as_deref(),
        Some("A longer public description")
    );
    assert_eq!(display.icon.as_deref(), Some("lucide:mail"));
    assert_eq!(
        display.icon_url.as_deref(),
        Some("https://cdn.example.com/conductor.svg")
    );
    assert_eq!(
        display.homepage.as_deref(),
        Some("https://resend.com/conductor")
    );
    assert_eq!(display.screenshots.len(), 1);
    assert_eq!(display.example_prompts, vec!["Draft an email"]);
    assert_eq!(display.layers[0]["capability"], "browser.control");
    assert!(display.external);

    let lifted = manifest_display_fields(&manifest);
    assert_eq!(lifted["manifestName"], "Conductor");
    assert_eq!(lifted["description"], "A longer public description");
    assert_eq!(lifted["website"], "https://resend.com/conductor");
    assert_eq!(
        lifted["privacyPolicyUrl"],
        "https://resend.com/legal/privacy"
    );
    assert_eq!(
        lifted["termsOfServiceUrl"],
        "https://resend.com/legal/terms"
    );
    assert_eq!(
        lifted["examplePrompts"],
        serde_json::json!(["Draft an email"])
    );
    assert_eq!(
        lifted["screenshots"],
        serde_json::json!(["https://cdn.example.com/conductor.png"])
    );
    assert_eq!(lifted["external"], true);
    assert!(lifted.get("ui_code").is_none());
    assert!(lifted.get("permission_grants").is_none());
}

#[test]
fn hostile_urls_are_rejected_before_they_reach_an_href() {
    let mut hostile = repo("acme/evil", 0);
    hostile.homepage = Some("javascript:alert(1)".to_string());
    hostile.html_url = "data:text/html,pwned".to_string();
    let record = repo_item_to_record(&hostile, false).unwrap();
    assert!(record.homepage.is_none());
    // A non-http html_url falls back to the canonical github URL.
    assert_eq!(record.html_url, "https://github.com/acme/evil");
}

#[test]
fn descriptions_are_bounded() {
    let mut wordy = repo("acme/wordy", 0);
    wordy.description = Some("x".repeat(5000));
    let record = repo_item_to_record(&wordy, false).unwrap();
    let description = record.description.unwrap();
    assert!(description.chars().count() <= MAX_DESCRIPTION_CHARS + 1);
}

#[test]
fn debug_redacts_the_token() {
    let source = GithubTopicSource {
        id: GITHUB_TOPIC_SOURCE_ID.to_string(),
        display_name: "GitHub (community)".to_string(),
        api_base: None,
        token: Some("ghp_supersecret".to_string()),
    };
    let rendered = format!("{source:?}");
    assert!(!rendered.contains("ghp_supersecret"), "{rendered}");
    assert!(rendered.contains("redacted"), "{rendered}");
}
