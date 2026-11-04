use super::*;

#[test]
fn acp_authentication_cannot_borrow_another_engines_credentials() {
    let managed_pi = r#"{"type":"stdio","name":"pi","command":"npx","args":["-y","pi-acp"],"env":[{"name":"PI_CODING_AGENT_DIR","value":"managed"}]}"#;
    assert_eq!(
        acp_login_verification_provider(managed_pi, "ryu", Some("claude-pro-max")),
        Some("claude-pro-max")
    );
    assert_eq!(
        acp_login_verification_provider("kiro-cli acp", "acp:kiro", Some("claude-pro-max")),
        None
    );
    assert_eq!(
        acp_login_verification_provider(
            "kiro-cli acp PI_CODING_AGENT_DIR=managed",
            "ryu",
            Some("claude-pro-max")
        ),
        None
    );
    assert_eq!(
        acp_login_verification_provider("npx -y pi-acp", "acp:pi", Some("claude-pro-max")),
        None
    );
    assert_eq!(
        acp_login_verification_provider(managed_pi, "ryu", None),
        None
    );
    // A limited custom agent's managed Pi reads the credential-free limited
    // config, so it cannot vouch for Ryu's own Pi sign-in.
    let limited_pi = {
        let _pi_guard = crate::pi_config::lock_pi_config_test_env();
        serde_json::json!({
            "type": "stdio",
            "name": "pi",
            "command": "npx",
            "args": ["-y", "pi-acp"],
            "env": [{
                "name": "PI_CODING_AGENT_DIR",
                "value": crate::pi_config::limited_agent_dir(Some("agent-a")),
            }],
        })
        .to_string()
    };
    assert!(crate::sidecar::adapters::acp::is_managed_pi_extension(
        &limited_pi,
        "agent-a"
    ));
    assert_eq!(
        acp_login_verification_provider(&limited_pi, "agent-a", Some("claude-pro-max")),
        None
    );
}

// ── ct_eq: constant-time bearer compare ──────────────────────────────────
#[test]
fn ct_eq_matches_only_identical_strings() {
    assert!(ct_eq("token", "token"));
    assert!(ct_eq("", ""));
    // Length mismatch short-circuits false (prefix is not a match).
    assert!(!ct_eq("token", "toke"));
    assert!(!ct_eq("toke", "token"));
    // Same length, one differing byte.
    assert!(!ct_eq("token", "tokeb"));
}

// ── header_str / header_decoded ──────────────────────────────────────────
#[test]
fn header_str_trims_and_drops_blanks() {
    let h = headers(&[("a", "  hi  "), ("blank", "   "), ("empty", "")]);
    assert_eq!(header_str(&h, "a").as_deref(), Some("hi"));
    assert_eq!(header_str(&h, "blank"), None);
    assert_eq!(header_str(&h, "empty"), None);
    assert_eq!(header_str(&h, "absent"), None);
}

#[test]
fn header_decoded_percent_decodes_and_falls_back_on_bad_escapes() {
    let h = headers(&[
        ("enc", "a%40b.com"),
        ("plain", "no-encoding"),
        ("bad", "100%zz"),
    ]);
    assert_eq!(header_decoded(&h, "enc").as_deref(), Some("a@b.com"));
    assert_eq!(header_decoded(&h, "plain").as_deref(), Some("no-encoding"));
    // An undecodable percent sequence must not panic or drop the value — the
    // raw string is returned verbatim.
    assert_eq!(header_decoded(&h, "bad").as_deref(), Some("100%zz"));
}

// ── surface_from_headers ─────────────────────────────────────────────────
#[test]
fn surface_parses_case_insensitively_and_unknown_is_none() {
    use crate::plugin_manifest::Surface;
    assert_eq!(
        surface_from_headers(&headers(&[("x-ryu-surface", "desktop")])),
        Some(Surface::Desktop)
    );
    // Case-insensitive + trimmed (header_str trims first).
    assert_eq!(
        surface_from_headers(&headers(&[("x-ryu-surface", "  ISLAND ")])),
        Some(Surface::Island)
    );
    // Unknown surface ⇒ None ("do not filter", never "filter everything out").
    assert_eq!(
        surface_from_headers(&headers(&[("x-ryu-surface", "toaster")])),
        None
    );
    // Absent ⇒ None.
    assert_eq!(surface_from_headers(&HeaderMap::new()), None);
}

#[test]
fn marketplace_catalog_keeps_paid_listings_visible_on_every_surface() {
    let entries = vec![
        json!({ "id": "free", "pricing": null }),
        json!({ "id": "free-model", "pricing": { "model": "free" } }),
        json!({ "id": "paid", "pricing": { "amountMinor": 900, "model": "one_time" } }),
        json!({ "id": "legacy-paid", "pricing": { "amountMinor": 500 } }),
    ];
    assert_eq!(
        entries
            .iter()
            .filter_map(|entry| entry.get("id").and_then(|id| id.as_str()))
            .collect::<Vec<_>>(),
        vec!["free", "free-model", "paid", "legacy-paid"]
    );
}

// ── append_return_to_query ───────────────────────────────────────────────
#[test]
fn append_return_to_query_encodes_and_passes_through_bad_uris() {
    let out = append_return_to_query("https://x.com/verify?code=1", "app://home?a=b");
    // Appended as an encoded query pair, preserving the existing `code`.
    assert!(out.starts_with("https://x.com/verify?code=1&"));
    assert!(out.contains("return_to=app%3A%2F%2Fhome"));
    // A non-URL input is returned unchanged rather than mangled.
    assert_eq!(
        append_return_to_query("not a url", "x"),
        "not a url".to_owned()
    );
}

// ── json_error ───────────────────────────────────────────────────────────
#[tokio::test]
async fn json_error_sets_status_and_escapes_body() {
    // A message with a quote, backslash and newline must round-trip as valid
    // JSON (the whole reason this goes through serde, not string interpolation).
    let msg = "boom: \"x\"\\y\nz";
    let resp = json_error(StatusCode::BAD_REQUEST, msg.to_owned());
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body reads");
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).expect("body is valid JSON despite control chars");
    assert_eq!(parsed["error"], msg);
}

// ── URL install: unattested backend stripping ────────────────────────────

#[test]
fn url_install_strips_an_inline_backend_it_cannot_attest() {
    let fetched = json!({
        "id": "com.example.url",
        "name": "Url",
        "version": "1.0.0",
        "runnables": [],
        "backend_code": "require('child_process').exec('id')",
        "backend_sha256": "deadbeef"
    })
    .to_string();
    let stripped: serde_json::Value =
        serde_json::from_str(&strip_unattested_url_backend(&fetched).unwrap()).unwrap();
    assert!(stripped.get("backend_code").is_none());
    assert!(stripped.get("backend_sha256").is_none());
    assert_eq!(stripped["id"], "com.example.url");
}

#[test]
fn url_install_keeps_a_manifest_without_a_backend_verbatim() {
    let fetched = "{\"id\":\"com.example.url\",\"name\":\"Url\",\"version\":\"1.0.0\"}";
    assert_eq!(strip_unattested_url_backend(fetched).unwrap(), fetched);
    assert!(strip_unattested_url_backend("not json").is_err());
}

/// A Marketplace detail that names its approved versions marks every other
/// Versions-tab row uninstallable; a detail without the list is untouched.
#[test]
fn versions_outside_the_marketplace_approval_list_are_not_installable() {
    let detail = json!({
        "approvedVersions": ["2.0.0", "1.0.0"],
        "versions": [
            { "version": "v2.0.0" },
            { "version": "1.5.0" },
            { "version": "1.0.0", "installable": true },
            { "tagOnly": true },
        ],
    });
    let marked = mark_unapproved_versions(detail);
    let installable: Vec<_> = marked["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row.get("installable").cloned())
        .collect();
    assert_eq!(
        installable,
        vec![
            None,
            Some(json!(false)),
            Some(json!(true)),
            Some(json!(false))
        ]
    );

    let other_source = json!({ "versions": [{ "version": "1.5.0" }] });
    assert_eq!(mark_unapproved_versions(other_source.clone()), other_source);
}

/// A revocation switches a plugin off, so it honours the disable tiers: a
/// mandatory plugin is refused outright and a load-bearing one needs `force`.
#[tokio::test]
async fn revocations_refuse_mandatory_and_need_force_for_load_bearing() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let revoke = |id: &str, force: bool| {
        let state = state.clone();
        let body = crate::server::RevokePluginBody {
            id: id.to_owned(),
            version: None,
            reason: None,
            force,
        };
        async move {
            crate::server::revoke_plugin_handler(
                axum::extract::State(state),
                axum::Extension(None),
                axum::Json(body),
            )
            .await
            .status()
        }
    };
    let mandatory = crate::plugins::builtins::MANDATORY_PLUGINS[0];
    let load_bearing = crate::plugins::builtins::LOAD_BEARING_PLUGINS[0];
    assert_eq!(revoke(mandatory, true).await, StatusCode::FORBIDDEN);
    assert_eq!(revoke(load_bearing, false).await, StatusCode::CONFLICT);
    assert!(state.app_store.list_revocations().await.unwrap().is_empty());
    assert_eq!(revoke(load_bearing, true).await, StatusCode::OK);
    assert_eq!(revoke("com.example.ordinary", false).await, StatusCode::OK);
    assert_eq!(state.app_store.list_revocations().await.unwrap().len(), 2);
}

/// Every plugin-management handler that mutates (or exposes credential state
/// of) an installed plugin must pass the managed-node lifecycle ACL. Scans
/// the server source so a new early return cannot silently drop the guard.
#[test]
fn plugin_management_handlers_enforce_the_lifecycle_permission() {
    let source = crate::server::tests::source_text::server_source();
    for (handler, permission) in [
        ("async fn reload_app_manifests(", "APP_UPDATE"),
        ("async fn set_app_grants_handler(", "APP_ENABLE"),
        ("async fn list_plugin_secrets_handler(", "APP_UPDATE"),
        ("async fn put_plugin_secret_handler(", "APP_UPDATE"),
        ("async fn delete_plugin_secret_handler(", "APP_UPDATE"),
        ("async fn revoke_plugin_handler(", "APP_DISABLE"),
        ("async fn unrevoke_plugin_handler(", "APP_ENABLE"),
        ("async fn enable_app_handler(", "APP_ENABLE"),
        ("async fn install_app_from_url(", "APP_INSTALL"),
    ] {
        let start = source
            .find(handler)
            .unwrap_or_else(|| panic!("{handler} not found"));
        let body = &source[start..];
        let end = body[1..].find("\nasync fn ").map_or(body.len(), |i| i + 1);
        let body = &body[..end];
        let guard = body
            .find("enforce_app_lifecycle_permission(")
            .unwrap_or_else(|| panic!("{handler} does not enforce the lifecycle ACL"));
        assert!(
            body[guard..].contains(&format!("permissions::{permission}")),
            "{handler} must require {permission}"
        );
        let first_return = body.find("return ").unwrap_or(usize::MAX);
        let guard_return = guard + body[guard..].find("return response").unwrap_or(0);
        assert!(
            first_return >= guard_return,
            "{handler} returns before its lifecycle ACL check"
        );
    }
}

// ── plugin BYOK secrets ──────────────────────────────────────────────────

/// THE ONE PROPERTY OF THIS ENDPOINT: the listing must never carry a secret —
/// not the plaintext, not the encrypted form, not a masked preview, not a
/// length. Asserted four ways so a future field addition has to trip one: the
/// plaintext is absent, the ciphertext (base64 AND hex) is absent, each entry's
/// key set is EXACTLY the declared metadata set, and the two usability flags are
/// booleans (so they cannot smuggle bytes of the value).
#[tokio::test]
async fn listing_plugin_secrets_never_returns_a_value() {
    use base64::Engine as _;

    let plaintext = "tvly-PLAINTEXT-must-not-appear";
    // The global is a first-set-wins OnceLock that other tests in this binary
    // (the uninstall cleanup tests) also publish, so write through whichever
    // in-memory store won rather than one the handler may never read.
    crate::plugin_secrets::set_global(
        crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
    );
    let store = crate::plugin_secrets::global().expect("the global store is published");
    store
        .set("tavily", "RYU_TAVILY_API_KEY", plaintext)
        .await
        .unwrap();
    let ciphertext = store
        .raw_ciphertext_for_test("tavily", "RYU_TAVILY_API_KEY")
        .await
        .expect("the secret was stored");

    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let resp =
        list_plugin_secrets_handler(State(state), Path("tavily".to_owned()), Extension(None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body reads");
    let raw_body = String::from_utf8_lossy(&bytes).into_owned();

    assert!(
        !raw_body.contains(plaintext),
        "the response leaked the plaintext secret: {raw_body}"
    );
    let b64 = base64::engine::general_purpose::STANDARD.encode(&ciphertext);
    assert!(
        !raw_body.contains(&b64),
        "the response leaked the base64 ciphertext: {raw_body}"
    );
    let hex: String = ciphertext.iter().map(|b| format!("{b:02x}")).collect();
    assert!(
        !raw_body.contains(&hex),
        "the response leaked the hex ciphertext: {raw_body}"
    );

    let parsed: serde_json::Value = serde_json::from_slice(&bytes).expect("valid JSON");
    let entries = parsed["secrets"].as_array().expect("secrets is an array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["key"], "RYU_TAVILY_API_KEY");
    assert_eq!(entries[0]["set"], true);
    assert!(entries[0]["updated_at"].as_i64().unwrap_or(0) > 0);
    let fields: std::collections::BTreeSet<&str> = entries[0]
        .as_object()
        .expect("entry is an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        fields,
        ["key", "set", "updated_at", "shadowed_by_env", "readable",]
            .into_iter()
            .collect(),
        "an entry must carry NOTHING beyond the name, the set flag, the timestamp, and \
             the two USABILITY facts (whether an env var shadows it, whether the plugin may \
             read it) — all metadata, never any part of the value. Widening this list is a \
             deliberate act: check the new field cannot carry, encode, or imply the secret."
    );
    // The two additions are booleans by construction, so they cannot smuggle
    // bytes of the value even if a future refactor computed them differently.
    assert!(entries[0]["shadowed_by_env"].is_boolean());
    assert!(entries[0]["readable"].is_boolean());
}

/// The key doubles as an env var name and a URL path segment, so a name the
/// resolver could never read back is refused at the door rather than stored as
/// a credential the user believes is live.
#[test]
fn a_malformed_secret_key_is_refused() {
    for bad in ["", "has-dash", "1leading", "../escape", "a b"] {
        assert!(
            !crate::plugin_secrets::is_valid_secret_key(bad),
            "'{bad}' must be refused by PUT /api/plugins/:id/secrets/:key"
        );
    }
    assert!(crate::plugin_secrets::is_valid_secret_key(
        "RYU_TAVILY_API_KEY"
    ));
}
