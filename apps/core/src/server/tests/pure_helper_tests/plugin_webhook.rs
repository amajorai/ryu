use super::*;

// ── download_control_result ──────────────────────────────────────────────
#[test]
fn download_control_result_maps_ok_and_missing() {
    let (ok_status, ok_body) = download_control_result(true);
    assert_eq!(ok_status, StatusCode::OK);
    assert_eq!(ok_body.0, json!({ "ok": true }));

    let (miss_status, miss_body) = download_control_result(false);
    assert_eq!(miss_status, StatusCode::NOT_FOUND);
    assert_eq!(miss_body.0["ok"], false);
    assert_eq!(miss_body.0["error"], "unknown download id");
}

// ── plugin_note_frame: SSE data framing ──────────────────────────────────
#[test]
fn plugin_note_frame_is_a_well_formed_sse_event() {
    let frame = plugin_note_frame("double-check: looks good");
    let text = String::from_utf8(frame).expect("utf8");
    assert!(text.starts_with("data: "));
    assert!(text.ends_with("\n\n"));
    let payload = text.trim_start_matches("data: ").trim_end_matches("\n\n");
    let value: serde_json::Value = serde_json::from_str(payload).expect("frame carries JSON");
    assert_eq!(value["type"], "data-plugin_note");
    assert_eq!(value["data"]["text"], "double-check: looks good");
}

#[test]
fn plugin_note_frame_carries_the_first_person_tool_intent() {
    let frame = plugin_note_frame_with_question(
        "The test suite will verify the change.",
        Some("Can I run Bash now?"),
    );
    let text = String::from_utf8(frame).expect("utf8");
    let payload = text.trim_start_matches("data: ").trim_end_matches("\n\n");
    let value: serde_json::Value = serde_json::from_str(payload).expect("frame carries JSON");
    assert_eq!(value["data"]["question"], "Can I run Bash now?");
    assert_eq!(
        value["data"]["text"],
        "The test suite will verify the change."
    );
}

#[test]
fn webhook_timestamp_fresh_is_lenient_when_absent_strict_when_stale() {
    // Absent ⇒ fresh (schemes like GitHub's carry no timestamp header).
    assert!(webhook_timestamp_fresh(&HeaderMap::new()));
    // Present + current ⇒ fresh.
    assert!(webhook_timestamp_fresh(&headers(&[(
        "webhook-timestamp",
        &now_secs().to_string()
    )])));
    // Present + far in the past ⇒ replay, rejected.
    assert!(!webhook_timestamp_fresh(&headers(&[(
        "webhook-timestamp",
        &(now_secs() - 10_000).to_string()
    )])));
}

#[test]
fn workflow_webhook_requires_a_parseable_fresh_timestamp() {
    assert!(!workflow_webhook_timestamp_fresh(&HeaderMap::new()));
    assert!(!workflow_webhook_timestamp_fresh(&headers(&[(
        "webhook-timestamp",
        "not-a-timestamp"
    )])));
    assert!(workflow_webhook_timestamp_fresh(&headers(&[(
        "webhook-timestamp",
        &now_secs().to_string()
    )])));
}

#[test]
fn webhook_delivery_id_reads_known_spellings_and_defaults_empty() {
    // Svix/Composio spelling wins.
    assert_eq!(
        webhook_delivery_id(&headers(&[("webhook-id", "svix_1")])),
        "svix_1"
    );
    // GitHub spelling.
    assert_eq!(
        webhook_delivery_id(&headers(&[("x-github-delivery", "gh_2")])),
        "gh_2"
    );
    // Generic fallback.
    assert_eq!(
        webhook_delivery_id(&headers(&[("x-delivery-id", "gen_3")])),
        "gen_3"
    );
    // Absent ⇒ empty (the "always new / not dedupable" contract).
    assert_eq!(webhook_delivery_id(&HeaderMap::new()), "");
}

// ── normalize_key / slugify_domain ───────────────────────────────────────
#[test]
fn normalize_key_collapses_and_trims_non_alphanumerics() {
    assert_eq!(
        normalize_key("1password.com:events"),
        "1password-com-events"
    );
    assert_eq!(normalize_key("--Foo!!Bar--"), "foo-bar");
    assert_eq!(normalize_key("Already-normal"), "already-normal");
    assert_eq!(normalize_key("!!!"), "");
}

#[test]
fn slugify_domain_lowercases_and_dashes_separators() {
    assert_eq!(slugify_domain("api.example.com"), "api-example-com");
    assert_eq!(slugify_domain("API.Example.COM"), "api-example-com");
    assert_eq!(
        slugify_domain(".leading.and.trailing."),
        "leading-and-trailing"
    );
}

// ── apis_guru_swagger_url ────────────────────────────────────────────────
#[test]
fn apis_guru_swagger_url_prefers_the_preferred_version() {
    let entry = json!({
        "preferred": "2.0",
        "versions": {
            "1.0": { "swaggerUrl": "https://ex/1.0.json" },
            "2.0": { "swaggerUrl": "https://ex/2.0.json" }
        }
    });
    assert_eq!(
        apis_guru_swagger_url(&entry).as_deref(),
        Some("https://ex/2.0.json")
    );
}

#[test]
fn apis_guru_swagger_url_falls_back_and_handles_missing() {
    // `preferred` absent (or not a real version) ⇒ first version key.
    let entry = json!({
        "preferred": "nope",
        "versions": { "1.0": { "swaggerUrl": "https://ex/1.0.json" } }
    });
    assert_eq!(
        apis_guru_swagger_url(&entry).as_deref(),
        Some("https://ex/1.0.json")
    );
    // No versions object ⇒ None.
    assert_eq!(apis_guru_swagger_url(&json!({})), None);
    // Version present but no swaggerUrl ⇒ None.
    assert_eq!(
        apis_guru_swagger_url(&json!({ "versions": { "1.0": {} } })),
        None
    );
}

// ── agent_version_status ─────────────────────────────────────────────────
#[test]
fn agent_version_status_compares_semver_and_degrades_gracefully() {
    assert_eq!(
        agent_version_status(Some("1.0.0"), Some("1.2.0")),
        Some("behind_latest")
    );
    assert_eq!(
        agent_version_status(Some("2.0.0"), Some("1.9.9")),
        Some("current")
    );
    assert_eq!(
        agent_version_status(Some("1.0.0"), Some("1.0.0")),
        Some("current")
    );
    // One side known ⇒ "unknown"; neither ⇒ None.
    assert_eq!(agent_version_status(Some("1.0.0"), None), Some("unknown"));
    assert_eq!(agent_version_status(None, Some("1.0.0")), Some("unknown"));
    assert_eq!(agent_version_status(None, None), None);
    // Unparseable version ⇒ None (never a bogus comparison).
    assert_eq!(
        agent_version_status(Some("not-semver"), Some("1.0.0")),
        None
    );
}

// ── npx_package_of ───────────────────────────────────────────────────────
#[test]
fn npx_package_of_skips_flags_env_and_separator() {
    assert_eq!(
        npx_package_of("npx -y @scope/pkg").as_deref(),
        Some("@scope/pkg")
    );
    assert_eq!(
        npx_package_of("FOO=bar npx --yes some-pkg arg1").as_deref(),
        Some("some-pkg")
    );
    // `pkg@1.2.3` ⇒ the version is stripped by npm_package_name.
    assert_eq!(npx_package_of("npx -- pkg@1.2.3").as_deref(), Some("pkg"));
    // Non-npx command ⇒ None (uvx self-fetch / managed binary).
    assert_eq!(npx_package_of("uvx some-tool"), None);
    // npx with only flags and no package ⇒ None.
    assert_eq!(npx_package_of("npx -y"), None);
}

// ── npx_row_label ────────────────────────────────────────────────────────
// The download row for an npx warm is named after the package, without the
// `@latest` the warm appends or the npm scope — otherwise every agent row in
// the Downloads page reads as "@zed-industries/…@latest".
#[test]
fn npx_row_label_drops_the_tag_and_the_scope() {
    assert_eq!(
        npx_row_label("@zed-industries/claude-code-acp@latest"),
        "claude-code-acp"
    );
    assert_eq!(npx_row_label("codex-acp@latest"), "codex-acp");
    // No tag at all (the npm-install leg passes a bare package name).
    assert_eq!(npx_row_label("@openai/codex"), "codex");
    assert_eq!(npx_row_label("some-pkg"), "some-pkg");
}

// ── agent_install_channel ────────────────────────────────────────────────
// Whether Ryu may upgrade an agent CLI in place is decided by where the
// binary actually resolves to. Getting this wrong is what made "Update" a
// no-op that reported success: npm/npx cannot move a vendor-installed binary.
#[test]
fn agent_install_channel_classifies_by_resolved_path() {
    let tmp = std::env::temp_dir().join(format!("ryu-channel-{}", std::process::id()));
    let global_bin = tmp.join("prefix/bin");
    let global_pkg = tmp.join("prefix/lib/node_modules/@vendor/cli");
    let vendor_bin = tmp.join("vendor/bin");
    let brew_bin = tmp.join("brew/bin");
    let brew_pkg = tmp.join("brew/Cellar/somecli/1.0.0/libexec/lib/node_modules/somecli");
    std::fs::create_dir_all(&global_bin).unwrap();
    std::fs::create_dir_all(&global_pkg).unwrap();
    std::fs::create_dir_all(&vendor_bin).unwrap();
    std::fs::create_dir_all(&brew_bin).unwrap();
    std::fs::create_dir_all(&brew_pkg).unwrap();

    // An npm global install: `<prefix>/bin/x` → `<prefix>/lib/node_modules/…`.
    let real = global_pkg.join("cli.js");
    std::fs::write(&real, "#!/usr/bin/env node\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, global_bin.join("npmcli")).unwrap();
    // A vendor installer: a plain file with no node_modules anywhere above it.
    std::fs::write(vendor_bin.join("vendorcli"), "#!/bin/sh\n").unwrap();
    // A homebrew formula shipping a Node CLI: node_modules IS above it, but
    // under Cellar — brew owns it, so `npm install -g` must not touch it.
    let brew_real = brew_pkg.join("cli.js");
    std::fs::write(&brew_real, "#!/usr/bin/env node\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&brew_real, brew_bin.join("brewcli")).unwrap();

    let saved = std::env::var("PATH").unwrap_or_default();
    let joined =
        std::env::join_paths([global_bin.clone(), vendor_bin.clone(), brew_bin.clone()]).unwrap();
    // SAFETY: single-threaded test; PATH is restored before returning.
    unsafe { std::env::set_var("PATH", &joined) };

    #[cfg(unix)]
    assert!(matches!(
        agent_install_channel("npmcli"),
        Some(AgentInstallChannel::NpmGlobal)
    ));
    assert!(matches!(
        agent_install_channel("vendorcli"),
        Some(AgentInstallChannel::External(_))
    ));
    #[cfg(unix)]
    assert!(matches!(
        agent_install_channel("brewcli"),
        Some(AgentInstallChannel::External(_))
    ));
    // Absent from PATH ⇒ nothing to classify (an npx-fetched agent).
    assert!(agent_install_channel("definitely-not-here").is_none());

    unsafe { std::env::set_var("PATH", saved) };
    std::fs::remove_dir_all(&tmp).ok();
}

// ── composio_toolkit_categories ──────────────────────────────────────────
#[test]
fn composio_categories_accept_strings_and_objects() {
    // Bare strings.
    assert_eq!(
        composio_toolkit_categories(&json!(["email", "crm"])),
        vec!["email".to_owned(), "crm".to_owned()]
    );
    // Objects: name > slug > id priority; unknown-shaped entries dropped.
    assert_eq!(
        composio_toolkit_categories(&json!([
            { "name": "Email" },
            { "slug": "sales" },
            { "id": "misc" },
            { "unrelated": "x" }
        ])),
        vec!["Email".to_owned(), "sales".to_owned(), "misc".to_owned()]
    );
    // Non-array ⇒ empty.
    assert!(composio_toolkit_categories(&json!({ "a": 1 })).is_empty());
    assert!(composio_toolkit_categories(&json!("nope")).is_empty());
}

// ── buyer_bearer_from_headers ────────────────────────────────────────────
#[test]
fn buyer_bearer_prefers_dedicated_header_then_authorization() {
    // Dedicated header wins even when Authorization is also present.
    let both = headers(&[
        ("x-ryu-buyer-token", "  buyer-tok  "),
        ("authorization", "Bearer auth-tok"),
    ]);
    assert_eq!(
        buyer_bearer_from_headers(&both).as_deref(),
        Some("buyer-tok")
    );

    // Only Authorization ⇒ strip the Bearer prefix.
    let auth_only = headers(&[("authorization", "Bearer auth-tok")]);
    assert_eq!(
        buyer_bearer_from_headers(&auth_only).as_deref(),
        Some("auth-tok")
    );

    // A blank dedicated header falls through to Authorization.
    let blank_buyer = headers(&[
        ("x-ryu-buyer-token", "   "),
        ("authorization", "Bearer auth-tok"),
    ]);
    assert_eq!(
        buyer_bearer_from_headers(&blank_buyer).as_deref(),
        Some("auth-tok")
    );

    // Neither ⇒ None; a non-Bearer Authorization ⇒ None.
    assert_eq!(buyer_bearer_from_headers(&HeaderMap::new()), None);
    assert_eq!(
        buyer_bearer_from_headers(&headers(&[("authorization", "Basic abc")])),
        None
    );
}

// ── parse_catalog_kind ───────────────────────────────────────────────────
#[test]
fn parse_catalog_kind_accepts_known_kinds_case_insensitively() {
    use crate::catalog_source::CatalogKind;
    assert_eq!(parse_catalog_kind(Some("model")), Ok(CatalogKind::Model));
    // FromStr lowercases, so an upper-case token still resolves.
    assert_eq!(parse_catalog_kind(Some("PLUGIN")), Ok(CatalogKind::Plugin));
    assert_eq!(
        parse_catalog_kind(Some("knowledge")),
        Ok(CatalogKind::Knowledge)
    );
    // Unknown ⇒ 400; absent ⇒ 400.
    assert_eq!(
        parse_catalog_kind(Some("bogus")),
        Err(StatusCode::BAD_REQUEST)
    );
    assert_eq!(parse_catalog_kind(None), Err(StatusCode::BAD_REQUEST));
}

// ── urlencoding_simple ───────────────────────────────────────────────────
#[test]
fn urlencoding_simple_encodes_reserved_and_multibyte() {
    assert_eq!(urlencoding_simple("a b"), "a%20b");
    // RFC3986 unreserved chars pass through untouched.
    assert_eq!(urlencoding_simple("A-z0_9.~"), "A-z0_9.~");
    assert_eq!(urlencoding_simple("/"), "%2F");
    // Multibyte UTF-8 is percent-encoded byte-by-byte (é = C3 A9).
    assert_eq!(urlencoding_simple("é"), "%C3%A9");
}

// ── plugin_entry_matches_query ───────────────────────────────────────────
#[test]
fn plugin_entry_matches_query_searches_name_desc_id() {
    let entry = json!({
        "name": "Weather",
        "description": "Forecasts and radar",
        "id": "com.acme.weather"
    });
    // Empty needle ⇒ always matches (no filter).
    assert!(plugin_entry_matches_query(&entry, ""));
    // Name (entry is lowercased internally; callers pass a lowercased needle).
    assert!(plugin_entry_matches_query(&entry, "weath"));
    // Description.
    assert!(plugin_entry_matches_query(&entry, "radar"));
    // Id.
    assert!(plugin_entry_matches_query(&entry, "acme"));
    // No hit anywhere.
    assert!(!plugin_entry_matches_query(&entry, "zzz"));
}
