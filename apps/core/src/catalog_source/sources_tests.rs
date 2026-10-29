use super::*;

#[test]
fn marketplace_trust_anchor_prefers_runtime_then_compiled_and_fails_closed_when_strict() {
    let resolve = super::resolve_marketplace_trust_anchor;
    // Runtime override wins over the compiled-in production key.
    assert_eq!(
        resolve(Some(" runtime-key "), Some("compiled-key"), true).unwrap(),
        Some("runtime-key".to_owned())
    );
    // A blank runtime value does not mask the compiled key.
    assert_eq!(
        resolve(Some("  "), Some("compiled-key"), true).unwrap(),
        Some("compiled-key".to_owned())
    );
    // Shipped build with no pinned key: refuse rather than trust the local
    // Gateway's own key.
    let err = resolve(None, None, true).expect_err("strict build must fail closed");
    assert!(err
        .to_string()
        .contains("no pinned Marketplace verifying key"));
    assert!(resolve(Some(""), Some(" "), true).is_err());
    // Dev/test: no pinned key means the Gateway verifies with its own key.
    assert_eq!(resolve(None, None, false).unwrap(), None);
    // Debug test builds keep the dev policy (local Gateway key allowed).
    if cfg!(debug_assertions) {
        assert!(!super::marketplace_trust_anchor_required());
    }
}

#[test]
fn a_paid_item_the_caller_has_not_bought_is_refused_before_install() {
    let withheld = serde_json::json!({ "requiresPurchase": true, "manifest": {} });
    let err = super::require_install_entitlement("acme/paid", &withheld)
        .expect_err("a withheld paid item must not install");
    assert!(err.to_string().contains("paid Marketplace item"));

    let entitled = serde_json::json!({ "requiresPurchase": false });
    assert!(super::require_install_entitlement("acme/paid", &entitled).is_ok());
    let exhausted = serde_json::json!({ "updateAllowanceExhausted": true });
    let err = super::require_install_entitlement("acme/paid", &exhausted)
        .expect_err("an exhausted bounded-update purchase must not update");
    assert!(err.to_string().contains("no updates left"));
    // Older control planes omit the flag; that is not a refusal.
    assert!(super::require_install_entitlement("acme/free", &serde_json::json!({})).is_ok());
}

#[test]
fn marketplace_signature_binds_descriptor_and_manifest() {
    use ed25519_dalek::{Signer, Verifier};
    let detail = serde_json::json!({
        "descriptor": {"url": "https://example.com/reviewed.zip"},
        "manifest": {"id": "acme/reviewed", "version": "1.0.0"},
        "signature": "signature-is-not-part-of-the-payload"
    });
    let signed_payload = marketplace_signature_payload(&detail);
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let signature = signing_key.sign(&serde_json::to_vec(&signed_payload).unwrap());
    let verifies = |payload: &Value| {
        signing_key
            .verifying_key()
            .verify(&serde_json::to_vec(payload).unwrap(), &signature)
            .is_ok()
    };
    assert!(verifies(&signed_payload));
    assert!(!verifies(&detail["manifest"]));
    assert_eq!(
        signed_payload,
        serde_json::json!({
            "descriptor": detail["descriptor"], "manifest": detail["manifest"]
        })
    );
    let mut changed = detail.clone();
    changed["descriptor"]["url"] = serde_json::json!("https://attacker.example/payload.zip");
    assert_ne!(marketplace_signature_payload(&changed), signed_payload);
    assert!(!verifies(&marketplace_signature_payload(&changed)));
    changed = detail.clone();
    changed["manifest"]["version"] = serde_json::json!("2.0.0");
    assert_ne!(marketplace_signature_payload(&changed), signed_payload);
    assert!(!verifies(&marketplace_signature_payload(&changed)));
}

#[tokio::test]
async fn unsigned_executable_marketplace_installs_are_rejected() {
    for kind in [CatalogKind::Plugin, CatalogKind::Mcp, CatalogKind::Skill] {
        let source = RyuMarketplaceSource::builtin(kind);
        let error = source
            .install_descriptor_from_detail(
                &reqwest::Client::new(),
                "acme/test",
                serde_json::json!({"manifest": {"id": "acme/test", "version": "1.0.0"},
                "descriptor": {}, "orgVerified": true}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no signature"));
    }
}

#[tokio::test]
async fn direct_marketplace_mcp_install_rejects_unsigned_but_browsing_remains_available() {
    let detail = serde_json::json!({
        "manifest": {"id": "acme/mcp", "version": "1.0.0"},
        "descriptor": {"kind": "stdio", "server_name": "acme/mcp",
            "identifier": "@modelcontextprotocol/server-memory", "version": "2026.8.31"}
    });
    let app = axum::Router::new().route(
        "/api/marketplace/catalog/detail",
        axum::routing::get(move || {
            let detail = detail.clone();
            async move { axum::Json(detail) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut marketplace = RyuMarketplaceSource::builtin(CatalogKind::Mcp);
    marketplace.base_url = Some(format!("http://{address}"));
    let client = reqwest::Client::new();
    assert!(marketplace
        .fetch_detail(&client, "acme/mcp")
        .await
        .unwrap()
        .get("descriptor")
        .is_some());
    let error = Source::RyuMarketplace(marketplace)
        .install_mcp(&client, "acme/mcp")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no signature"));
    server.abort();
}

#[tokio::test]
async fn signed_marketplace_install_verifies_envelope_and_preserves_normal_payload() {
    use base64::Engine as _;
    use ed25519_dalek::{Signer, Verifier};
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
    let verifying_key = signing_key.verifying_key();
    let app = axum::Router::new().route(
        "/v1/manifests/verify",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
            let valid = body
                .get("signature")
                .and_then(Value::as_str)
                .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
                .and_then(|bytes| ed25519_dalek::Signature::from_slice(&bytes).ok())
                .is_some_and(|signature| {
                    verifying_key
                        .verify(&serde_json::to_vec(&body["manifest"]).unwrap(), &signature)
                        .is_ok()
                });
            axum::Json(serde_json::json!({"valid": valid}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let url = format!("http://{address}/v1/manifests/verify");
    let code = "export function render() {};";
    let mut detail = serde_json::json!({
        "manifest": {"id": "acme/plugin", "name": "Reviewed plugin", "version": "1.0.0",
            "ui_code_sha256": compute_ui_code_sha256(code)},
        "descriptor": {}, "uiCode": code,
    });
    let signature =
        signing_key.sign(&serde_json::to_vec(&marketplace_signature_payload(&detail)).unwrap());
    detail["signature"] =
        serde_json::json!(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()));
    let client = reqwest::Client::new();
    let signed = verify_marketplace_install_at(&client, "acme/plugin", &detail, &url, None)
        .await
        .unwrap();
    let source = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
    let descriptor = source
        .descriptor_from_verified_detail("acme/plugin", detail.clone(), signed)
        .unwrap();
    assert_eq!(descriptor.raw["signature_verified"], true);
    assert_eq!(descriptor.raw["ui_code"], code);
    assert_eq!(descriptor.raw["manifest"], detail["manifest"]);
    for field in ["manifest", "descriptor"] {
        let mut tampered = detail.clone();
        tampered[field]["tampered"] = serde_json::json!(true);
        assert!(
            verify_marketplace_install_at(&client, "acme/plugin", &tampered, &url, None)
                .await
                .is_err()
        );
    }
    let mut malformed = detail.clone();
    malformed["signature"] = serde_json::json!("invalid-signature");
    assert!(
        verify_marketplace_install_at(&client, "acme/plugin", &malformed, &url, None)
            .await
            .is_err()
    );
    server.abort();
    let _ = server.await;
    let disconnected_client = reqwest::Client::new();
    assert!(verify_marketplace_install_at(
        &disconnected_client,
        "acme/plugin",
        &detail,
        &url,
        None
    )
    .await
    .is_err());
}

#[test]
fn cheapest_marks_only_comparable_eligible_options() {
    let price = |usd: f64| IntegrationPrice {
        usd: Some(usd),
        currency: Some("USD".to_owned()),
        value: Some(usd),
        per: Some(1.0),
        unit: Some("call".to_owned()),
        confidence: Some("verified".to_owned()),
        basis: None,
        metered_by: Vec::new(),
    };
    let mut options = vec![
        IntegrationOption {
            id: "free".to_owned(),
            source: "treg".to_owned(),
            kind: "treg-endpoint".to_owned(),
            action: "chat-setup".to_owned(),
            connection_id: None,
            name: "Free".to_owned(),
            description: None,
            url: None,
            provider: None,
            capability: Some("profile".to_owned()),
            comparison_key: Some("profile".to_owned()),
            price: Some(price(0.0)),
            is_cheapest: false,
            provider_role: None,
            available: Some(true),
            availability_note: None,
        },
        IntegrationOption {
            id: "paid".to_owned(),
            source: "treg".to_owned(),
            kind: "treg-endpoint".to_owned(),
            action: "chat-setup".to_owned(),
            connection_id: None,
            name: "Paid".to_owned(),
            description: None,
            url: None,
            provider: None,
            capability: Some("profile".to_owned()),
            comparison_key: Some("profile".to_owned()),
            price: Some(price(0.01)),
            is_cheapest: false,
            provider_role: None,
            available: Some(true),
            availability_note: None,
        },
        IntegrationOption {
            id: "blocked".to_owned(),
            source: "treg".to_owned(),
            kind: "treg-endpoint".to_owned(),
            action: "chat-setup".to_owned(),
            connection_id: None,
            name: "Blocked".to_owned(),
            description: None,
            url: None,
            provider: None,
            capability: Some("profile".to_owned()),
            comparison_key: Some("profile".to_owned()),
            price: Some(price(-1.0)),
            is_cheapest: false,
            provider_role: None,
            available: Some(false),
            availability_note: Some("not eligible".to_owned()),
        },
    ];

    mark_cheapest_options(&mut options);

    assert!(options[0].is_cheapest);
    assert!(!options[1].is_cheapest);
    assert!(!options[2].is_cheapest);
}

#[test]
fn managed_providers_rank_treg_before_composio() {
    let option = |id: &str, source: &str, available: Option<bool>| IntegrationOption {
        id: id.to_owned(),
        source: source.to_owned(),
        kind: format!("{source}-row"),
        action: "chat-setup".to_owned(),
        connection_id: None,
        name: id.to_owned(),
        description: None,
        url: None,
        provider: None,
        capability: None,
        comparison_key: None,
        price: None,
        is_cheapest: false,
        provider_role: None,
        available,
        availability_note: None,
    };
    let brand = |options: Vec<IntegrationOption>, sources: &[&str]| IntegrationBrand {
        id: "github".to_owned(),
        name: "GitHub".to_owned(),
        description: None,
        logo: None,
        categories: Vec::new(),
        sources: sources.iter().map(|source| (*source).to_owned()).collect(),
        feeds: Vec::new(),
        connections: Vec::new(),
        options,
        composio_slug: None,
        treg_slug: None,
        ryu_slug: None,
        suggested_source: None,
        preferred_source: None,
        domain: None,
        popularity: None,
    };

    let mut both = brand(
        vec![
            option("composio:github", "composio", None),
            option("directory:mcp/github", "directory", Some(true)),
            option("treg:github", "treg", Some(true)),
            option("treg:blocked", "treg", Some(false)),
        ],
        &["directory", "composio", "treg"],
    );
    rank_managed_providers(&mut both, None);
    let order: Vec<_> = both.options.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(
        order,
        [
            "directory:mcp/github",
            "treg:github",
            "treg:blocked",
            "composio:github"
        ]
    );
    assert_eq!(both.sources, ["directory", "treg", "composio"]);
    let roles: Vec<_> = both
        .options
        .iter()
        .map(|o| o.provider_role.as_deref())
        .collect();
    assert_eq!(
        roles,
        [None, Some("primary"), None, Some("alternative")],
        "a blocked catalog row is never primary"
    );

    // One managed source only: order still applies, no roles.
    let mut composio_only = brand(
        vec![option("composio:github", "composio", None)],
        &["composio"],
    );
    rank_managed_providers(&mut composio_only, None);
    assert_eq!(composio_only.options[0].provider_role, None);

    // Only blocked catalog rows: Composio is not an "alternative" to them.
    let mut blocked_only = brand(
        vec![
            option("composio:github", "composio", None),
            option("treg:blocked", "treg", Some(false)),
        ],
        &["composio", "treg"],
    );
    rank_managed_providers(&mut blocked_only, None);
    assert!(blocked_only
        .options
        .iter()
        .all(|option| option.provider_role.is_none()));
    assert_eq!(blocked_only.suggested_source.as_deref(), Some("composio"));
}

#[test]
fn gmail_absent_from_treg_keeps_composio_suggested() {
    let composio = IntegrationOption {
        id: "composio:gmail".to_owned(),
        source: "composio".to_owned(),
        kind: "composio-toolkit".to_owned(),
        action: "connect".to_owned(),
        connection_id: None,
        name: "Composio toolkit".to_owned(),
        description: None,
        url: None,
        provider: Some("Composio".to_owned()),
        capability: None,
        comparison_key: None,
        price: None,
        is_cheapest: false,
        provider_role: None,
        available: None,
        availability_note: None,
    };
    let mut gmail = IntegrationBrand {
        id: "gmail".to_owned(),
        name: "Gmail".to_owned(),
        description: None,
        logo: None,
        categories: Vec::new(),
        sources: vec!["composio".to_owned()],
        feeds: Vec::new(),
        connections: Vec::new(),
        options: vec![composio],
        composio_slug: Some("gmail".to_owned()),
        treg_slug: None,
        ryu_slug: None,
        suggested_source: None,
        preferred_source: None,
        domain: None,
        popularity: None,
    };
    // Even a stale `treg` pin cannot move Gmail off Composio: Treg does not
    // offer it, so the option stays, unlabelled, and Composio is suggested.
    rank_managed_providers(&mut gmail, Some("treg"));
    assert_eq!(gmail.options.len(), 1);
    assert_eq!(gmail.suggested_source.as_deref(), Some("composio"));
    assert_eq!(gmail.preferred_source, None);
    assert_eq!(gmail.options[0].provider_role, None);
}

#[test]
fn a_pin_switches_the_primary_managed_source() {
    let option = |id: &str, source: &str| IntegrationOption {
        id: id.to_owned(),
        source: source.to_owned(),
        kind: format!("{source}-row"),
        action: "chat-setup".to_owned(),
        connection_id: None,
        name: id.to_owned(),
        description: None,
        url: None,
        provider: None,
        capability: None,
        comparison_key: None,
        price: None,
        is_cheapest: false,
        provider_role: None,
        available: Some(true),
        availability_note: None,
    };
    let mut brand = IntegrationBrand {
        id: "reddit".to_owned(),
        name: "Reddit".to_owned(),
        description: None,
        logo: None,
        categories: Vec::new(),
        sources: vec!["treg".to_owned(), "composio".to_owned()],
        feeds: Vec::new(),
        connections: Vec::new(),
        options: vec![
            option("treg:reddit", "treg"),
            option("composio:reddit", "composio"),
        ],
        composio_slug: None,
        treg_slug: None,
        ryu_slug: None,
        suggested_source: None,
        preferred_source: None,
        domain: None,
        popularity: None,
    };
    rank_managed_providers(&mut brand, Some("composio"));
    assert_eq!(brand.suggested_source.as_deref(), Some("treg"));
    assert_eq!(brand.preferred_source.as_deref(), Some("composio"));
    assert_eq!(brand.options[0].id, "composio:reddit");
    assert_eq!(brand.options[0].provider_role.as_deref(), Some("primary"));
    assert_eq!(
        brand.options[1].provider_role.as_deref(),
        Some("alternative")
    );
    assert_eq!(brand.sources, ["composio", "treg"]);

    // Clearing the pin goes back to the suggestion.
    rank_managed_providers(&mut brand, None);
    assert_eq!(brand.preferred_source, None);
    assert_eq!(brand.options[0].id, "treg:reddit");
    assert_eq!(brand.options[0].provider_role.as_deref(), Some("primary"));
}

#[test]
fn provider_pins_keep_only_known_sources() {
    let pins = parse_provider_pins(Some(
        r#"{"gmail":"composio","reddit":" Treg ","x":"pipedream","y":1}"#,
    ));
    assert_eq!(pins.len(), 2);
    assert_eq!(pins["gmail"], "composio");
    assert_eq!(pins["reddit"], "treg");
    assert!(parse_provider_pins(Some("not json")).is_empty());
    assert!(parse_provider_pins(None).is_empty());
}

#[test]
fn cheapest_never_compares_a_base_price_with_an_all_in_price() {
    let option = |id: &str, usd: f64, basis: Option<&str>, meters: &[&str]| IntegrationOption {
        id: id.to_owned(),
        source: "ryu".to_owned(),
        kind: "ryu-endpoint".to_owned(),
        action: "chat-setup".to_owned(),
        connection_id: None,
        name: id.to_owned(),
        description: None,
        url: None,
        provider: None,
        capability: Some("web.search".to_owned()),
        comparison_key: Some("web/web.search".to_owned()),
        price: Some(IntegrationPrice {
            usd: Some(usd),
            currency: Some("USD".to_owned()),
            value: Some(usd),
            per: Some(1.0),
            unit: Some("call".to_owned()),
            confidence: Some("high".to_owned()),
            basis: basis.map(str::to_owned),
            metered_by: meters.iter().map(|meter| (*meter).to_owned()).collect(),
        }),
        is_cheapest: false,
        provider_role: None,
        available: Some(true),
        availability_note: None,
    };
    let mut options = vec![
        option(
            "exa.search.instant",
            0.004,
            Some("base_call"),
            &["results_over_10"],
        ),
        option("brave.web_search", 0.005, Some("one_call"), &[]),
        option("tavily.search.basic", 0.008, None, &[]),
        option(
            "exa.search.auto",
            0.007,
            Some("base_call"),
            &["results_over_10"],
        ),
    ];
    mark_cheapest_options(&mut options);
    // Exa's base price is compared only with Exa's other base price.
    assert!(options[0].is_cheapest);
    assert!(!options[3].is_cheapest);
    // Brave is cheapest among the all-in prices.
    assert!(options[1].is_cheapest);
    assert!(!options[2].is_cheapest);
    let serialized = serde_json::to_value(options[0].price.as_ref().unwrap()).unwrap();
    assert_eq!(serialized["basis"], "base_call");
    assert_eq!(serialized["metered_by"][0], "results_over_10");
}

#[test]
fn directory_options_preserve_each_install_surface() {
    let cases = [
        ("mcp", "mcp"),
        ("openapi", "rest-import"),
        ("api", "rest-import"),
        ("rest", "rest-import"),
        ("graphql", "graphql-import"),
        ("cli", "chat-setup"),
    ];
    for (kind, action) in cases {
        let connection = IntegrationConnection {
            id: format!("{kind}/example"),
            kind: kind.to_owned(),
            name: format!("Example {kind}"),
            url: Some("https://example.com/setup".to_owned()),
        };
        let option = integration_connection_option(&connection, None);
        assert_eq!(option.source, "directory");
        assert_eq!(option.kind, kind);
        assert_eq!(option.action, action);
        assert_eq!(
            option.connection_id.as_deref(),
            Some(connection.id.as_str())
        );
    }
}

/// A source that does not publish release trains must REFUSE a named channel,
/// not quietly serve its ordinary build under that name.
///
/// This is the fail-closed half of the whole feature: the resolution rule
/// everywhere else is "a channel selects only its own builds, never a
/// fallback", and a trait default that fell through to `install_descriptor`
/// would break exactly that — a user who asked for `beta` would be handed
/// stable and told the install succeeded.
#[tokio::test]
async fn a_named_channel_is_refused_by_a_source_that_publishes_no_trains() {
    let source = Source::Stub(StubSource {
        id: "stub-plugins".to_string(),
        display_name: "Stub".to_string(),
        kind: CatalogKind::Plugin,
    });
    let client = reqwest::Client::new();

    let err = source
        .install_descriptor_at(&client, "com.acme.thing", Some("beta"))
        .await
        .expect_err("a stub source cannot serve a beta train");
    let message = err.to_string();
    assert!(
        message.contains("beta") && message.contains("release channels"),
        "the refusal must name the train that is unavailable: {message}"
    );

    // `stable`, an empty string and `None` are the SAME request — the ordinary
    // install — so none of them may take the refusal path. (They still fail
    // here, because a stub source serves nothing at all; the point is that they
    // fail with the source's own note rather than the channel refusal.)
    for channel in [None, Some(""), Some("stable"), Some("  STABLE ")] {
        let err = source
            .install_descriptor_at(&client, "com.acme.thing", channel)
            .await
            .expect_err("a stub source serves nothing");
        assert!(
            err.to_string().contains("no upstream configured"),
            "`{channel:?}` must take the ordinary install path, not the channel refusal"
        );
    }
}

/// A plugin marketplace whose plugin declares skill paths must resolve to ONE
/// plugin item at the repo root (Plugin kind), not per-skill leaves — while the
/// Skill kind still flattens into per-skill items. Locks the kind-aware
/// `fetch_items` split so a plugin is never advertised as a skill subdir.
#[test]
fn plugin_kind_yields_one_item_per_plugin_skill_kind_flattens() {
    let manifest_json = br#"{
            "plugins": [
                {
                    "name": "foo",
                    "description": "a bundle",
                    "source": "acme/plugins",
                    "skills": ["./skills/bar", "./skills/baz"]
                }
            ]
        }"#;
    let manifest = parse_marketplace(manifest_json).expect("parse manifest");

    // Plugin kind: one item at the repo root, carrying the plugin name + repo.
    let plugin_items = plugins_as_items(&manifest, "acme/marketplace");
    assert_eq!(plugin_items.len(), 1);
    assert_eq!(plugin_items[0].id, "foo");
    assert_eq!(plugin_items[0].plugin, "foo");
    assert_eq!(plugin_items[0].install_source, "acme/plugins");

    // Skill kind: one item per declared skill, scoped to its subdir.
    let skill_items = flatten_plugins(&manifest, "acme/marketplace");
    assert_eq!(skill_items.len(), 2);
    assert_eq!(skill_items[0].id, "foo/bar");
    assert!(skill_items[0]
        .install_source
        .ends_with("/tree/HEAD/skills/bar"));
    assert_eq!(skill_items[1].id, "foo/baz");
}

const SAMPLE_INDEX: &str = r#"[
        { "name": "gemma-4-E2B-it-Q4_K_M.gguf",
          "download_url": "https://models.example/gemma-q4.gguf",
          "sha": "abc123", "size": 3221225472 },
        { "name": "phi-mini-Q8_0.gguf",
          "download_url": "https://models.example/phi-q8.gguf",
          "size": 4000000000 }
    ]"#;

fn source() -> ModelIndexSource {
    ModelIndexSource {
        id: "my-index".to_string(),
        display_name: "My Models".to_string(),
        index_url: "https://models.example/index.json".to_string(),
    }
}

#[test]
fn parses_index_into_cards_and_descriptors() {
    let entries = parse_index(SAMPLE_INDEX.as_bytes()).expect("parse index");
    assert_eq!(entries.len(), 2);

    let src = source();

    // First entry: full detail card maps to the desktop ModelCard/GgufFile shape.
    let detail = src.entry_to_detail(&entries[0]);
    assert_eq!(detail["card"]["id"], "gemma-4-E2B-it-Q4_K_M.gguf");
    assert_eq!(detail["card"]["author"], "My Models");
    let file0 = &detail["files"][0];
    assert_eq!(file0["url"], "https://models.example/gemma-q4.gguf");
    assert_eq!(file0["sha256"], "abc123");
    assert_eq!(file0["size_bytes"], 3_221_225_472u64);
    assert!(file0["size_human"].as_str().is_some_and(|s| !s.is_empty()));

    // Descriptor carries url + sha + dest_filename; no download happens here.
    let d0 = src.entry_to_descriptor(&entries[0]);
    assert_eq!(d0.kind, CatalogKind::Model);
    assert_eq!(d0.repo_id, "gemma-4-E2B-it-Q4_K_M.gguf");
    assert_eq!(d0.files.len(), 1);
    assert_eq!(d0.files[0].url, "https://models.example/gemma-q4.gguf");
    assert_eq!(d0.files[0].sha256.as_deref(), Some("abc123"));
    assert_eq!(d0.files[0].dest_filename, "gemma-4-E2B-it-Q4_K_M.gguf");

    // Second entry: missing sha → None (verification disabled, never panics).
    let d1 = src.entry_to_descriptor(&entries[1]);
    assert_eq!(d1.files[0].sha256, None);
    assert_eq!(d1.files[0].dest_filename, "phi-mini-Q8_0.gguf");
}

#[test]
fn rejects_malformed_index() {
    assert!(parse_index(b"not json").is_err());
    // Missing required fields (name/download_url) is a parse error, not a panic.
    assert!(parse_index(br#"[{ "size": 1 }]"#).is_err());
}

// ── Marketplace adapter (#463) ────────────────────────────────────────────

const SAMPLE_MARKETPLACE: &str = r#"{
        "name": "acme-marketplace",
        "owner": { "name": "Acme" },
        "plugins": [
            {
                "name": "code-tools",
                "description": "Coding helpers",
                "source": "acme/code-tools",
                "skills": ["./skills/lint", "skills/format"]
            },
            {
                "name": "solo-skill",
                "description": "A single skill repo",
                "source": { "source": "github", "repo": "acme/solo" }
            },
            {
                "name": "broken",
                "description": "no resolvable source"
            }
        ]
    }"#;

#[test]
fn marketplace_manifest_url_forms() {
    // owner/repo and github URLs expand to one candidate per MANIFEST_PATHS,
    // Ryu-native path first, Claude/Codex-legacy last (ecosystem compat).
    let owner = marketplace_manifest_urls("owner/repo");
    assert_eq!(
        owner,
        vec![
            "https://raw.githubusercontent.com/owner/repo/HEAD/.ryu-plugin/marketplace.json",
            "https://raw.githubusercontent.com/owner/repo/HEAD/.agents/plugins/marketplace.json",
            "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json",
            "https://raw.githubusercontent.com/owner/repo/HEAD/.cursor-plugin/marketplace.json",
        ]
    );
    assert_eq!(
        marketplace_manifest_urls("https://github.com/owner/repo")[0],
        "https://raw.githubusercontent.com/owner/repo/HEAD/.ryu-plugin/marketplace.json"
    );
    assert_eq!(
        marketplace_manifest_urls("https://github.com/owner/repo.git")[2],
        "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json"
    );
    // A direct .json URL is used verbatim as the sole candidate.
    assert_eq!(
        marketplace_manifest_urls("https://example.com/custom/marketplace.json"),
        vec!["https://example.com/custom/marketplace.json"]
    );
}

#[test]
fn marketplace_location_classifies_local_git_and_urls() {
    use MarketplaceLocation as L;
    // owner/repo shorthand → github raw https candidates.
    match marketplace_location("owner/repo").expect("shorthand") {
        L::Http(urls) => {
            assert_eq!(urls.len(), MANIFEST_PATHS.len());
            assert!(urls[0].starts_with("https://raw.githubusercontent.com/owner/repo/HEAD/"));
        }
        other => panic!("expected Http, got {other:?}"),
    }
    // github URL → raw candidates.
    match marketplace_location("https://github.com/owner/repo").expect("github url") {
        L::Http(urls) => {
            assert!(urls[0].starts_with("https://raw.githubusercontent.com/owner/repo/HEAD/"))
        }
        other => panic!("expected Http, got {other:?}"),
    }
    // Direct .json URL → the verbatim single candidate.
    match marketplace_location("https://example.com/marketplace.json").expect("json url") {
        L::Http(urls) => {
            assert_eq!(
                urls,
                vec!["https://example.com/marketplace.json".to_string()]
            )
        }
        other => panic!("expected Http, got {other:?}"),
    }
    // A non-github https URL is a git clone (Claude-aligned).
    match marketplace_location("https://gitlab.com/company/plugins").expect("gitlab") {
        L::Git(url) => assert_eq!(url, "https://gitlab.com/company/plugins"),
        other => panic!("expected Git, got {other:?}"),
    }
    // git@ / ssh:// → clone.
    match marketplace_location("git@gitlab.com:company/plugins.git").expect("git@") {
        L::Git(url) => assert_eq!(url, "git@gitlab.com:company/plugins.git"),
        other => panic!("expected Git, got {other:?}"),
    }
    // An existing local directory → Local.
    let dir = std::env::temp_dir().join("ryu-mp-test-location-dir");
    std::fs::create_dir_all(&dir).expect("create dir");
    match marketplace_location(dir.to_str().expect("utf8")).expect("local dir") {
        L::Local(p) => assert_eq!(p, dir),
        other => panic!("expected Local, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
    // A path-shaped string that does not exist → Local (fails at read time).
    let missing = std::env::temp_dir().join("ryu-mp-test-does-not-exist");
    match marketplace_location(missing.to_str().expect("utf8")).expect("path-shaped") {
        L::Local(_) => {}
        other => panic!("expected Local, got {other:?}"),
    }
    // A bare single segment that is neither a path nor owner/repo → error.
    assert!(marketplace_location("nonsense").is_err());
}

#[tokio::test]
async fn fetch_items_reads_local_path_marketplace() {
    // A local marketplace directory with a `.ryu-plugin/marketplace.json`;
    // its `./`-relative plugin source resolves to a path inside the checkout.
    let dir = std::env::temp_dir().join(format!("ryu-mp-test-local-{}", std::process::id()));
    std::fs::create_dir_all(dir.join(".ryu-plugin")).expect("create .ryu-plugin");
    std::fs::write(
        dir.join(".ryu-plugin/marketplace.json"),
        r#"{
                "name": "local-mp",
                "owner": { "name": "Local" },
                "plugins": [
                    { "name": "local-tool", "source": "./plugins/local-tool", "description": "A local tool" }
                ]
            }"#,
    )
    .expect("write manifest");
    let source = MarketplaceSource::new(
        "local-mp",
        "Local MP",
        dir.to_string_lossy().to_string(),
        CatalogKind::Plugin,
    );
    let client = reqwest::Client::new();
    let items = source
        .fetch_items(&client)
        .await
        .expect("fetch local marketplace");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, "local-tool");
    assert_eq!(
        items[0].install_source,
        dir.join("plugins/local-tool").to_string_lossy()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scoped_source_handles_gitlab_and_local_paths() {
    // gitlab URL → the `/-/tree/HEAD/<subdir>` archive form, `.git` stripped.
    assert_eq!(
        scoped_source("https://gitlab.com/acme/tools.git", "skills/lint"),
        "https://gitlab.com/acme/tools/-/tree/HEAD/skills/lint"
    );
    // Subgroups keep their slashes.
    assert_eq!(
        scoped_source("https://gitlab.com/acme/sub/tools", "skills/lint"),
        "https://gitlab.com/acme/sub/tools/-/tree/HEAD/skills/lint"
    );
    // A local path → a joined subdirectory.
    let dir = std::env::temp_dir().join("ryu-mp-test-scoped-local");
    std::fs::create_dir_all(&dir).expect("create dir");
    assert_eq!(
        scoped_source(dir.to_str().expect("utf8"), "skills/lint"),
        dir.join("skills/lint").to_string_lossy()
    );
    let _ = std::fs::remove_dir_all(&dir);
    // A non-github, non-gitlab URL keeps its bare source (walker finds it).
    assert_eq!(
        scoped_source("https://bitbucket.org/acme/tools", "skills/lint"),
        "https://bitbucket.org/acme/tools"
    );
}

#[test]
fn resolve_marketplace_source_resolves_relative_against_context() {
    // A `./` source in a local-path marketplace → a path inside the checkout.
    let dir = std::env::temp_dir().join("ryu-mp-test-resolve-local");
    std::fs::create_dir_all(&dir).expect("create dir");
    assert_eq!(
        resolve_marketplace_source("./plugins/foo", dir.to_str().expect("utf8")),
        dir.join("plugins/foo").to_string_lossy()
    );
    let _ = std::fs::remove_dir_all(&dir);
    // A bare repo-local subfolder in a gitlab marketplace → gitlab tree URL.
    assert_eq!(
        resolve_marketplace_source("teaching", "https://gitlab.com/acme/mp.git"),
        "https://gitlab.com/acme/mp/-/tree/HEAD/teaching"
    );
    // An owner/repo source is returned unchanged (github shorthand).
    assert_eq!(
        resolve_marketplace_source("owner/repo", "https://gitlab.com/acme/mp.git"),
        "owner/repo"
    );
}

#[test]
fn gitlab_host_project_parses() {
    assert_eq!(
        gitlab_host_project("https://gitlab.com/acme/tools.git"),
        Some(("gitlab.com".into(), "acme/tools".into()))
    );
    assert_eq!(
        gitlab_host_project("https://www.gitlab.com/group/sub/repo"),
        Some(("www.gitlab.com".into(), "group/sub/repo".into()))
    );
    // A self-hosted `*.gitlab.com` instance.
    assert_eq!(
        gitlab_host_project("https://git.gitlab.com/group/repo"),
        Some(("git.gitlab.com".into(), "group/repo".into()))
    );
    // A `-` marker (tree/blob) splits the project from the ref, like the
    // install path's parser.
    assert_eq!(
        gitlab_host_project("https://gitlab.com/acme/mp/-/tree/main/skills"),
        Some(("gitlab.com".into(), "acme/mp".into()))
    );
    // github is not gitlab.
    assert_eq!(gitlab_host_project("https://github.com/owner/repo"), None);
}

#[test]
fn http_url_allowlists_scheme() {
    assert_eq!(http_url("https://ok.example"), Some("https://ok.example"));
    assert_eq!(http_url("  http://ok.example  "), Some("http://ok.example"));
    assert_eq!(http_url("javascript:alert(1)"), None);
    assert_eq!(http_url("data:text/html,x"), None);
    assert_eq!(http_url("ftp://x"), None);
}

#[test]
fn flattens_plugins_into_skill_items() {
    let manifest = parse_marketplace(SAMPLE_MARKETPLACE.as_bytes()).expect("parse");
    let items = flatten_plugins(&manifest, "acme/marketplace");
    // 2 skills from code-tools + 1 from solo-skill; broken (no source) skipped.
    assert_eq!(items.len(), 3);

    let lint = items
        .iter()
        .find(|i| i.id == "code-tools/lint")
        .expect("lint item");
    assert_eq!(lint.plugin, "code-tools");
    assert_eq!(
        lint.install_source,
        "https://github.com/acme/code-tools/tree/HEAD/skills/lint"
    );
    assert_eq!(lint.description.as_deref(), Some("Coding helpers"));

    // The `./` prefix is stripped before building the subdir URL.
    let fmt = items
        .iter()
        .find(|i| i.id == "code-tools/format")
        .expect("format item");
    assert_eq!(
        fmt.install_source,
        "https://github.com/acme/code-tools/tree/HEAD/skills/format"
    );

    // A plugin with no explicit skills surfaces as a single item at the repo root.
    let solo = items
        .iter()
        .find(|i| i.id == "solo-skill")
        .expect("solo item");
    assert_eq!(solo.install_source, "acme/solo");

    // The broken plugin (unresolvable source) is skipped, never panics.
    assert!(!items.iter().any(|i| i.plugin == "broken"));
}

#[test]
fn rejects_malformed_marketplace() {
    assert!(parse_marketplace(b"not json").is_err());
    // An empty object parses (no plugins) rather than panicking.
    let empty = parse_marketplace(b"{}").expect("empty object parses");
    assert!(flatten_plugins(&empty, "acme/marketplace").is_empty());
}

#[test]
fn plugin_source_string_handles_string_and_object() {
    assert_eq!(
        plugin_source_string(&serde_json::json!("owner/repo")).as_deref(),
        Some("owner/repo")
    );
    assert_eq!(
        plugin_source_string(&serde_json::json!({ "repo": "owner/repo" })).as_deref(),
        Some("owner/repo")
    );
    assert_eq!(
        plugin_source_string(&serde_json::json!({ "url": "https://example.com/r.git" })).as_deref(),
        Some("https://example.com/r.git")
    );
    assert_eq!(plugin_source_string(&serde_json::json!(null)), None);
    assert_eq!(plugin_source_string(&serde_json::json!({})), None);
}

// ── Smithery + Ryu-hosted MCP sources (#465) ──────────────────────────────

const SAMPLE_SMITHERY_DETAIL: &str = r#"{
        "qualifiedName": "@acme/weather",
        "displayName": "Weather",
        "description": "Hosted weather MCP server",
        "deploymentUrl": "https://server.smithery.ai/@acme/weather/mcp",
        "connections": [
            { "type": "http", "url": "https://server.smithery.ai/@acme/weather/mcp" }
        ]
    }"#;

#[test]
fn smithery_detail_maps_to_remote_plan() {
    let detail: SmitheryServerDetail =
        serde_json::from_str(SAMPLE_SMITHERY_DETAIL).expect("parse smithery detail");
    let server = SmitherySource::detail_to_server_json(&detail).expect("map to server json");
    // Reuses #464's validated plan builder → a Remote entry with the hosted URL.
    let plan = crate::mcp_catalog::plan_from_server(&server).expect("plan");
    assert_eq!(plan.server_name, "@acme/weather");
    assert_eq!(
        plan.entry,
        crate::mcp_catalog::McpEntryPlan::Remote {
            url: "https://server.smithery.ai/@acme/weather/mcp".to_string(),
        }
    );
}

#[test]
fn smithery_stdio_only_server_reports_no_installable_url() {
    // A server with no deploymentUrl and no connection url cannot be installed
    // (Smithery's API carries no package identifier for stdio) — a clear error,
    // never a panic.
    let detail = SmitheryServerDetail {
        qualified_name: "@acme/local".to_string(),
        display_name: Some("Local".to_string()),
        description: None,
        deployment_url: None,
        connections: vec![SmitheryConnection {
            connection_type: Some("stdio".to_string()),
            url: None,
        }],
    };
    assert!(SmitherySource::detail_to_server_json(&detail).is_err());
}

#[test]
fn smithery_bad_list_json_degrades_to_empty_note() {
    // Tolerant parse: a malformed list body is a serde error inside fetch_list,
    // and search turns any error into an empty, labelled result (never panics).
    let bad: std::result::Result<SmitheryListEnvelope, _> = serde_json::from_slice(b"not json");
    assert!(bad.is_err());
}

#[test]
fn smithery_search_without_key_is_empty_with_note() {
    // No key (and no env): search degrades to `{ servers: [], note }`.
    let src = SmitherySource {
        id: "smithery".to_string(),
        display_name: "Smithery".to_string(),
        api_key: None,
    };
    let client = reqwest::Client::new();
    let q = CatalogQuery::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let value = rt.block_on(src.search(&client, &q)).expect("search ok");
    assert_eq!(value["servers"].as_array().map(Vec::len), Some(0));
    assert!(value["note"]
        .as_str()
        .is_some_and(|n| n.contains("API key")));
}

#[test]
fn ryu_hosted_static_list_is_non_empty_and_all_plannable() {
    // The built-in curated index parses (it is the official server.json
    // envelope shape) and every entry maps to a valid InstallPlan via #464.
    // The test marks the code-reviewed fixture as trusted; live installs
    // still verify the package registry metadata through `verify_and_plan`.
    let mut servers = crate::mcp_catalog::parse_server_list(RYU_HOSTED_CURATED_INDEX.as_bytes())
        .expect("curated index parses");
    assert!(!servers.is_empty());
    for server in &mut servers {
        server.mark_package_provenance_verified();
        let plan = crate::mcp_catalog::plan_from_server(server)
            .unwrap_or_else(|e| panic!("server {} should plan: {e}", server.name));
        // All curated entries are stdio npm/pypi packages.
        assert!(matches!(
            plan.entry,
            crate::mcp_catalog::McpEntryPlan::Stdio { .. }
        ));
    }
}

// ── Ryu Marketplace source (#467) ─────────────────────────────────────────

#[test]
fn ryu_marketplace_search_unreachable_degrades_per_kind() {
    // An unreachable base URL must NOT error the list: search degrades to the
    // correct per-kind envelope with a note (mirrors smithery_search_without_key).
    // A short connect timeout keeps the test fast (TEST-NET-1 never answers).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(200))
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap();
    let q = CatalogQuery::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    // A guaranteed-unreachable base (RFC 5737 TEST-NET-1, port closed).
    let base = "http://192.0.2.1:1".to_string();
    let cases = [
        (CatalogKind::Model, "models"),
        (CatalogKind::Skill, "skills"),
        (CatalogKind::Mcp, "servers"),
        (CatalogKind::Plugin, "items"),
    ];
    for (kind, key) in cases {
        let src = RyuMarketplaceSource {
            id: "ryu-marketplace".to_string(),
            display_name: "Ryu Marketplace".to_string(),
            kind,
            base_url: Some(base.clone()),
        };
        let value = rt.block_on(src.search(&client, &q)).expect("search ok");
        assert_eq!(
            value[key].as_array().map(Vec::len),
            Some(0),
            "kind {kind} should have an empty `{key}` array"
        );
        assert!(
            value["note"].as_str().is_some(),
            "kind {kind} should carry a degrade note"
        );
    }
}

#[test]
fn ryu_marketplace_search_serves_stale_memory_cache_with_note() {
    let source = RyuMarketplaceSource {
        id: "ryu-marketplace".to_string(),
        display_name: "Ryu Marketplace".to_string(),
        kind: CatalogKind::Plugin,
        base_url: Some("http://192.0.2.1:3".to_string()),
    };
    let key = marketplace_cache_key(&source.resolve_base(), source.kind, "", 40, None);
    let cards: Vec<MarketplaceCard> =
        serde_json::from_str(r#"[{"id":"acme/cached","name":"Cached Plugin"}]"#).unwrap();
    let page = MarketplacePage {
        cards,
        next_cursor: None,
    };
    let cache = RYU_MARKETPLACE_MEMORY_CACHE.get_or_init(Default::default);
    cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            key,
            (
                std::time::Instant::now()
                    - RYU_MARKETPLACE_CACHE_TTL
                    - std::time::Duration::from_secs(1),
                page,
            ),
        );

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(100))
        .timeout(std::time::Duration::from_millis(250))
        .build()
        .unwrap();
    let value = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(source.search(&client, &CatalogQuery::default()))
        .expect("stale search should still return an envelope");

    assert_eq!(value["items"][0]["id"], "acme/cached");
    assert_eq!(
        value["note"].as_str(),
        Some("Ryu Marketplace is unavailable; showing cached listings.")
    );
}

#[tokio::test]
async fn ryu_marketplace_search_forwards_the_cursor_and_returns_the_next_one() {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let recorder = seen.clone();
    let app = axum::Router::new().route(
        "/api/marketplace/catalog",
        axum::routing::get(
            move |axum::extract::Query(params): axum::extract::Query<
                std::collections::HashMap<String, String>,
            >| {
                let recorder = recorder.clone();
                async move {
                    let cursor = params.get("cursor").cloned().unwrap_or_default();
                    recorder.lock().unwrap().push(format!(
                        "limit={} cursor={cursor}",
                        params.get("limit").cloned().unwrap_or_default()
                    ));
                    // Page 2 continues; page 3 claims a cursor past the
                    // server's own bound, which Core must not pass on.
                    let next = match cursor.as_str() {
                        "" => Value::from("2"),
                        "2" => Value::from("4"),
                        _ => Value::from("999999"),
                    };
                    axum::Json(serde_json::json!({
                        "kind": "plugin",
                        "items": [{ "id": format!("acme/page-{cursor}"), "name": "Paged" }],
                        "nextCursor": next,
                    }))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let source = RyuMarketplaceSource {
        id: "ryu-marketplace".to_string(),
        display_name: "Ryu Marketplace".to_string(),
        kind: CatalogKind::Plugin,
        base_url: Some(format!("http://{address}")),
    };
    let client = reqwest::Client::new();
    let query = |cursor: Option<&str>| CatalogQuery {
        query: "paged".to_owned(),
        limit: 500,
        cursor: cursor.map(str::to_owned),
        ..Default::default()
    };

    let first = source.search(&client, &query(None)).await.unwrap();
    assert_eq!(first["items"][0]["id"], "acme/page-");
    assert_eq!(first["next_cursor"], "2");
    let second = source.search(&client, &query(Some("2"))).await.unwrap();
    assert_eq!(second["items"][0]["id"], "acme/page-2");
    assert_eq!(second["next_cursor"], "4");
    let third = source.search(&client, &query(Some("4"))).await.unwrap();
    assert!(
        third["next_cursor"].is_null(),
        "out-of-bounds cursor dropped"
    );

    // A cursor the server could not have issued is refused before any
    // request, with the typed error routes map to 400.
    for bad in ["-1", "abc", "5001", "1234567890"] {
        let error = source.search(&client, &query(Some(bad))).await.unwrap_err();
        assert!(
            error
                .downcast_ref::<super::super::InvalidCatalogCursor>()
                .is_some(),
            "cursor {bad} must be rejected"
        );
    }
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            "limit=100 cursor=",
            "limit=100 cursor=2",
            "limit=100 cursor=4"
        ],
        "limit is clamped to the server bound and the cursor is forwarded"
    );
    server.abort();
}

#[test]
fn ryu_marketplace_disk_cache_reads_pre_paging_card_arrays() {
    let legacy: MarketplaceCacheEnvelope<MarketplaceDiskPage> =
        serde_json::from_str(r#"{"fetched_at": 1, "value": [{"id": "acme/old", "name": "Old"}]}"#)
            .unwrap();
    let page: MarketplacePage = legacy.value.into();
    assert_eq!(page.cards.len(), 1);
    assert_eq!(page.next_cursor, None);
    let current: MarketplaceCacheEnvelope<MarketplaceDiskPage> =
        serde_json::from_str(r#"{"fetched_at": 1, "value": {"cards": [], "next_cursor": "40"}}"#)
            .unwrap();
    let page: MarketplacePage = current.value.into();
    assert_eq!(page.next_cursor.as_deref(), Some("40"));
}

#[test]
fn ryu_marketplace_search_envelope_maps_cards_per_kind() {
    // The happy path: a server `/catalog` body deserializes into cards, each
    // maps via `card_to_value`, and `wrap_envelope` emits the per-kind key the
    // matching desktop tab reads (models/skills/servers/items).
    const BODY: &str = r#"{ "kind": "skill", "items": [
            { "id": "owner/foo", "name": "Foo Skill", "description": "does foo",
              "author": "Acme", "version": "1.0.0", "installSource": "owner/foo",
              "membershipIncluded": true }
        ] }"#;
    let env: MarketplaceListEnvelope = serde_json::from_str(BODY).expect("parse catalog body");
    assert_eq!(env.items.len(), 1);

    let cases = [
        (CatalogKind::Model, "models"),
        (CatalogKind::Skill, "skills"),
        (CatalogKind::Mcp, "servers"),
        (CatalogKind::Plugin, "items"),
    ];
    for (kind, key) in cases {
        let src = RyuMarketplaceSource::builtin(kind);
        let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
        let value = src.wrap_envelope(cards, None, None);
        let arr = value[key].as_array().expect("per-kind array present");
        assert_eq!(arr.len(), 1, "kind {kind} → key `{key}`");
        assert_eq!(arr[0]["id"], "owner/foo");
        assert_eq!(arr[0]["name"], "Foo Skill");
        if kind == CatalogKind::Plugin {
            assert_eq!(arr[0]["membership_included"], true);
        }
        // No `note` on the success path.
        assert!(value.get("note").is_none());
    }
}

#[test]
fn ryu_marketplace_card_projects_normalised_deprecation() {
    const BODY: &str = r#"{ "kind": "plugin", "items": [
            { "id": "acme/old", "name": "Old",
              "deprecated": { "message": "Use New.", "replacement": "acme/new" } },
            { "id": "acme/flag", "name": "Flag", "deprecated": "Retired." },
            { "id": "acme/current", "name": "Current" }
        ] }"#;
    let env: MarketplaceListEnvelope = serde_json::from_str(BODY).expect("parse catalog body");
    let src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
    let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
    assert_eq!(
        cards[0]["deprecated"],
        serde_json::json!({ "message": "Use New.", "replacement": "acme/new" })
    );
    assert_eq!(
        cards[1]["deprecated"],
        serde_json::json!({ "message": "Retired." })
    );
    assert!(cards[2].get("deprecated").is_none());
}

/// A malformed `deprecated` on a hosted card is ignored: the card keeps its
/// place with no notice and the rest of the envelope still parses.
#[test]
fn ryu_marketplace_card_projects_remix_policy_and_credit() {
    const BODY: &str = r#"{ "kind": "plugin", "items": [
            { "id": "acme/locked", "name": "Locked", "allowRemix": false },
            { "id": "acme/remix", "name": "Remix", "allowRemix": true,
              "remixedFrom": { "kind": "plugin", "id": "acme/original", "version": "1.0.0" } },
            { "id": "acme/old-server", "name": "Old server" },
            { "id": "acme/odd", "name": "Odd", "allowRemix": "no", "remixedFrom": "acme/x" }
        ] }"#;
    let env: MarketplaceListEnvelope =
        serde_json::from_str(BODY).expect("a malformed remix field must not fail the envelope");
    let src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
    let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
    assert_eq!(cards[0]["allow_remix"], serde_json::json!(false));
    assert_eq!(cards[1]["allow_remix"], serde_json::json!(true));
    assert_eq!(
        cards[1]["remixed_from"],
        serde_json::json!({ "kind": "plugin", "id": "acme/original", "version": "1.0.0" })
    );
    // Absent (an older server) and malformed both read as the default.
    assert_eq!(cards[2]["allow_remix"], serde_json::json!(true));
    assert_eq!(cards[3]["allow_remix"], serde_json::json!(true));
    assert!(cards[3].get("remixed_from").is_none());
}

#[test]
fn ryu_marketplace_card_ignores_malformed_deprecation() {
    const BODY: &str = r#"{ "kind": "plugin", "items": [
            { "id": "acme/odd", "name": "Odd", "deprecated": 42 },
            { "id": "acme/list", "name": "List", "deprecated": [] },
            { "id": "acme/flag", "name": "Flag", "deprecated": "Retired." }
        ] }"#;
    let env: MarketplaceListEnvelope =
        serde_json::from_str(BODY).expect("a bad deprecated value must not fail the envelope");
    let src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
    let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
    assert_eq!(cards.len(), 3);
    assert!(cards[0].get("deprecated").is_none());
    assert!(cards[1].get("deprecated").is_none());
    assert_eq!(
        cards[2]["deprecated"],
        serde_json::json!({ "message": "Retired." })
    );
}

#[test]
fn ryu_marketplace_card_projects_org_verification_camel_to_snake() {
    // The control plane speaks camelCase (`orgVerified`/`orgVerifiedTier`); the
    // card `CatalogEntry` reads is snake_case. Locks that projection, and — the
    // reason this test exists at all — locks that an ABSENT signal stays absent:
    // emitting `false` for a server that never sent the field would render a
    // positive "this publisher is not verified" claim about an honest listing.
    const BODY: &str = r#"{ "kind": "plugin", "items": [
            { "id": "acme/verified", "name": "Verified", "orgVerified": true,
              "orgVerifiedTier": "partner", "publisherTrust": "blue",
              "publisherTrustSource": "stripe_connect",
              "publisherVerification": { "verifiedSince": "2026-08-23T00:00:00.000Z",
                "methods": [{ "kind": "email", "label": "Verified email" },
                             { "kind": "domain", "label": "Verified domain" }] } },
            { "id": "acme/unverified", "name": "Unverified", "orgVerified": false,
              "publisherTrust": "dotted", "publisherTrustSource": "none" },
            { "id": "acme/silent", "name": "Silent" },
            { "id": "acme/blank-tier", "name": "Blank Tier", "orgVerified": true,
              "orgVerifiedTier": "  " }
        ] }"#;
    let env: MarketplaceListEnvelope = serde_json::from_str(BODY).expect("parse catalog body");
    let src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
    let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
    assert_eq!(cards.len(), 4);

    // Verified publisher: both keys land, renamed.
    assert_eq!(cards[0]["org_verified"], true);
    assert_eq!(cards[0]["org_verified_tier"], "partner");
    assert_eq!(cards[0]["publisher_trust"], "blue");
    assert_eq!(cards[0]["publisher_trust_source"], "stripe_connect");
    assert_eq!(
        cards[0]["publisher_verification"]["verifiedSince"],
        "2026-08-23T00:00:00.000Z"
    );
    assert_eq!(
        cards[0]["publisher_verification"]["methods"][1]["label"],
        "Verified domain"
    );
    // The camelCase spellings must NOT leak onto the snake_case card.
    assert!(cards[0].get("orgVerified").is_none());
    assert!(cards[0].get("orgVerifiedTier").is_none());

    // An explicit `false` is a real answer and is carried through; a tier the
    // server did not send stays absent rather than becoming `null`.
    assert_eq!(cards[1]["org_verified"], false);
    assert!(cards[1].get("org_verified_tier").is_none());
    assert_eq!(cards[1]["publisher_trust"], "dotted");
    assert_eq!(cards[1]["publisher_trust_source"], "none");

    // Absent ⇒ absent. Not `false`, not `null`.
    assert!(
        cards[2].get("org_verified").is_none(),
        "a card with no org-verification signal must not claim one either way"
    );
    assert!(cards[2].get("org_verified_tier").is_none());

    // A blank tier is no tier — same posture the other optional card fields take.
    assert_eq!(cards[3]["org_verified"], true);
    assert!(cards[3].get("org_verified_tier").is_none());
}

#[test]
fn ryu_marketplace_resolve_base_prefers_explicit_then_default() {
    // Explicit base wins and is trailing-slash-trimmed.
    let src = RyuMarketplaceSource {
        id: "ryu-marketplace".to_string(),
        display_name: "Ryu Marketplace".to_string(),
        kind: CatalogKind::Skill,
        base_url: Some("https://market.example/".to_string()),
    };
    assert_eq!(src.resolve_base(), "https://market.example");

    // With no explicit base and no env override, the hosted-marketplace default.
    if std::env::var(RYU_MARKETPLACE_API_ENV).is_err() {
        let default_src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
        assert_eq!(default_src.resolve_base(), RYU_MARKETPLACE_DEFAULT_BASE);
    }
}

#[test]
fn integrations_sh_item_maps_to_plugin_catalog_card() {
    let record = IntegrationsShRecord {
        id: "mcp/figma".to_string(),
        kind: "mcp".to_string(),
        name: "Figma".to_string(),
        description: Some("Design context for agents".to_string()),
        url: Some("https://help.figma.com/mcp".to_string()),
        icon: Some("https://integrations.sh/logo/figma.com".to_string()),
        domain: Some("figma.com".to_string()),
        categories: vec!["design".to_string()],
        feeds: vec!["claude".to_string(), "openai".to_string()],
        popularity: Some(21_667),
        version: None,
    };

    let item = integration_record_to_item(&record);
    assert_eq!(item["id"], "mcp/figma");
    assert_eq!(item["name"], "Figma");
    assert_eq!(item["author"], "figma.com");
    assert_eq!(item["version"], "MCP");
    assert_eq!(item["install_source"], "https://help.figma.com/mcp");
    assert_eq!(item["category"], "design");
    assert_eq!(item["integration_kind"], "mcp");
}

#[test]
fn integrations_sh_raw_openapi_fallback_maps_specs() {
    let spec: IntegrationsShRawOpenApiSpec = serde_json::from_str(
        r#"{
                "provider": "stripe.com",
                "versionKey": "2024-01-01",
                "title": "Stripe API",
                "description": "Payments API",
                "link": "https://api.apis.guru/v2/specs/stripe.com/2024-01-01.json",
                "categories": ["payments"],
                "providerName": "stripe.com",
                "raw": {
                    "info": {
                        "x-logo": { "url": "https://logo.example/stripe.svg" }
                    }
                }
            }"#,
    )
    .expect("parse raw spec");

    let record = raw_openapi_to_record(&spec);
    assert_eq!(record.id, "api/stripe.com");
    assert_eq!(record.kind, "api");
    assert_eq!(record.name, "Stripe API");
    assert_eq!(record.domain.as_deref(), Some("stripe.com"));
    assert_eq!(record.categories, vec!["payments"]);
    assert_eq!(
        record.url.as_deref(),
        Some("https://api.apis.guru/v2/specs/stripe.com/2024-01-01.json")
    );
    assert_eq!(
        record.icon.as_deref(),
        Some("https://logo.example/stripe.svg")
    );
    assert_eq!(record.feeds, vec!["api-guru-openapi"]);
}

#[test]
fn ryu_marketplace_descriptor_maps_per_kind() {
    let client_id = "ryu-marketplace";
    // Skill: descriptor.install_source → raw.install_source (no files).
    let skill = RyuMarketplaceSource::builtin(CatalogKind::Skill);
    let skill_detail = serde_json::json!({
        "descriptor": { "install_source": "owner/repo/tree/HEAD/skills/foo" }
    });
    let d = skill
        .detail_to_descriptor("owner/foo", &skill_detail)
        .expect("skill descriptor");
    assert_eq!(d.kind, CatalogKind::Skill);
    assert_eq!(d.source_id, client_id);
    assert!(d.files.is_empty());
    assert_eq!(
        d.raw.get("install_source").and_then(|v| v.as_str()),
        Some("owner/repo/tree/HEAD/skills/foo")
    );

    // Model: descriptor.files → DescriptorFile list.
    let model = RyuMarketplaceSource::builtin(CatalogKind::Model);
    let model_detail = serde_json::json!({
        "descriptor": { "files": [
            { "url": "https://m.example/x.gguf", "sha256": "abc", "dest_filename": "x.gguf" }
        ] }
    });
    let dm = model
        .detail_to_descriptor("x", &model_detail)
        .expect("model descriptor");
    assert_eq!(dm.files.len(), 1);
    assert_eq!(dm.files[0].url, "https://m.example/x.gguf");
    assert_eq!(dm.files[0].sha256.as_deref(), Some("abc"));

    // Agent: the portable template rides through `raw` untouched — the seam
    // resolves, Core sanitises. Both storage shapes resolve (under `descriptor`,
    // or at the detail root when an older server stored it bare).
    let agent = RyuMarketplaceSource::builtin(CatalogKind::Agent);
    let template = serde_json::json!({
        "template": {
            "kind": "agent",
            "name": "Researcher",
            "version": "1.0.0",
            "agent_config": { "system_prompt": "You research." }
        }
    });
    for detail in [
        serde_json::json!({ "descriptor": template.clone() }),
        template.clone(),
    ] {
        let da = agent
            .detail_to_descriptor("acme/researcher", &detail)
            .expect("agent descriptor");
        assert_eq!(da.kind, CatalogKind::Agent);
        assert_eq!(da.source_id, client_id);
        assert!(da.files.is_empty(), "an agent downloads nothing");
        assert_eq!(
            da.raw
                .get("template")
                .and_then(|t| t.get("name"))
                .and_then(|v| v.as_str()),
            Some("Researcher")
        );
    }

    // Mcp: a stdio npm descriptor maps through #464's validated plan builder.
    let mcp = RyuMarketplaceSource::builtin(CatalogKind::Mcp);
    let mcp_detail = serde_json::json!({
        "descriptor": {
            "kind": "stdio",
            "server_name": "io.acme/mem",
            "identifier": "@modelcontextprotocol/server-memory",
            "version": "2026.8.31"
        }
    });
    let plan = mcp
        .detail_to_mcp_plan("io.acme/mem", &mcp_detail)
        .expect("mcp plan");
    assert_eq!(plan.server_name, "io.acme/mem");
    assert!(matches!(
        plan.entry,
        crate::mcp_catalog::McpEntryPlan::Stdio { .. }
    ));
}

#[tokio::test]
async fn verify_on_install_rejects_unsigned_item_without_contacting_gateway() {
    let source = RyuMarketplaceSource::builtin(CatalogKind::Skill);
    let error = source
        .verify_manifest_signature(
            &reqwest::Client::new(),
            "owner/skill",
            &serde_json::json!({"manifest": {"id": "owner/skill", "version": "1.0.0"}}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no signature"));
}

// ── Plugin CODE CARRIAGE: ed25519-signed code-integrity gate ──────────────
//
// These prove the whole point of the carriage: a registry-tamper / MITM that
// swaps `ui_code` AFTER the manifest was signed is REJECTED fail-closed on
// install, because the hash of the swapped code no longer matches the
// signed-manifest's `ui_code_sha256`. `compute_ui_code_sha256` mirrors the
// SDK's `sha256(utf8(ui_code))` lower-case-hex exactly, so JS-signed hashes
// verify byte-for-byte here.

/// Build a server-shaped `catalog/detail` document (the EXACT keys the control
/// plane serves): the declared hash inside the signed `manifest`, the code as
/// the unsigned top-level `uiCode`.
fn plugin_detail(ui_code_sha256: Option<&str>, ui_code: Option<&str>) -> serde_json::Value {
    let mut manifest = serde_json::Map::new();
    manifest.insert("id".into(), serde_json::json!("com.acme.plugin"));
    manifest.insert("name".into(), serde_json::json!("Acme"));
    manifest.insert("version".into(), serde_json::json!("1.0.0"));
    if let Some(h) = ui_code_sha256 {
        manifest.insert("ui_code_sha256".into(), serde_json::json!(h));
    }
    let mut detail = serde_json::Map::new();
    detail.insert("manifest".into(), serde_json::Value::Object(manifest));
    if let Some(c) = ui_code {
        detail.insert("uiCode".into(), serde_json::json!(c));
    }
    serde_json::Value::Object(detail)
}

#[test]
fn ui_code_sha256_matches_known_vector() {
    // Cross-language golden: `sha256("abc")` lower-case hex. The SDK computes
    // the SAME value via `createHash("sha256").update(code,"utf8").digest("hex")`,
    // so a hash written into a JS-signed manifest verifies here byte-for-byte.
    assert_eq!(
        compute_ui_code_sha256("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn gate_carries_code_when_signed_and_hash_matches() {
    let code = "export function activate(ctx){ return ctx; }";
    let hash = compute_ui_code_sha256(code);
    let detail = plugin_detail(Some(&hash), Some(code));
    let carried = gate_plugin_ui_code("com.acme.plugin", &detail, true)
        .expect("signed + matching hash must carry the code");
    assert_eq!(
        carried.as_deref(),
        Some(code),
        "the exact signed code must be carried"
    );
}

#[test]
fn gate_rejects_tampered_code_fail_closed() {
    // The load-bearing security assertion: the manifest was signed over the
    // hash of the ORIGINAL code, but the served code was swapped (MITM /
    // registry tamper). Install MUST hard-fail — not silently drop the code.
    let original = "export function activate(ctx){ return ctx; }";
    let hash = compute_ui_code_sha256(original);
    let tampered = "export function activate(ctx){ steal(ctx); }";
    let detail = plugin_detail(Some(&hash), Some(tampered));
    let err = gate_plugin_ui_code("com.acme.plugin", &detail, true)
        .expect_err("signed manifest + swapped code must be rejected fail-closed");
    assert!(
        err.to_string().contains("hash mismatch"),
        "reject reason must name the hash mismatch, got: {err}"
    );
}

#[test]
fn gate_rejects_stripped_code_fail_closed() {
    // A signed manifest declares a code hash but the code blob was removed
    // after signing — also active tampering, also a hard reject.
    let hash = compute_ui_code_sha256("some code");
    let detail = plugin_detail(Some(&hash), None);
    let err = gate_plugin_ui_code("com.acme.plugin", &detail, true)
        .expect_err("declared hash with no served code must be rejected");
    assert!(
        err.to_string().contains("no ui_code was served"),
        "got: {err}"
    );
}

#[test]
fn gate_never_carries_code_for_unsigned_item() {
    // The bypass guard: an UNSIGNED item that self-declares a matching hash
    // must NOT run its code — nothing attests the hash. Benign summary only.
    let code = "export function activate(){}";
    let hash = compute_ui_code_sha256(code);
    let detail = plugin_detail(Some(&hash), Some(code));
    let carried = gate_plugin_ui_code("com.acme.plugin", &detail, false)
        .expect("unsigned item installs as a summary (no error)");
    assert_eq!(
        carried, None,
        "unsigned self-declared hash must never carry code"
    );
}

#[test]
fn gate_signed_manifest_only_plugin_carries_nothing() {
    // A signed plugin with no bundled UI (no ui_code_sha256) is fine and
    // simply carries no code.
    let detail = plugin_detail(None, None);
    let carried = gate_plugin_ui_code("com.acme.plugin", &detail, true)
        .expect("signed manifest-only plugin is valid");
    assert_eq!(carried, None);
}

#[test]
fn backend_gate_strips_unsigned_inline_backend_code() {
    // HIGH-2: an UNSIGNED plugin's inline node backend is attested by nothing,
    // so both the code and its self-referential hash are removed before the
    // manifest is carried into the install descriptor.
    let mut manifest = serde_json::json!({
        "id": "com.acme.plugin",
        "version": "1.0.0",
        "backend_code": "export function activate(){ steal(); }",
        "backend_sha256": "deadbeef",
    });
    gate_plugin_backend_code("com.acme.plugin", &mut manifest, false);
    let obj = manifest.as_object().unwrap();
    assert!(
        !obj.contains_key("backend_code"),
        "unsigned backend_code must be stripped"
    );
    assert!(
        !obj.contains_key("backend_sha256"),
        "dangling backend_sha256 must be stripped too (else the install-door \
             hash check trips)"
    );
}

#[test]
fn backend_gate_keeps_signed_inline_backend_code() {
    // A signed manifest's backend is INSIDE the verified surface — untouched.
    let code = "export function activate(){}";
    let mut manifest = serde_json::json!({
        "id": "com.acme.plugin",
        "version": "1.0.0",
        "backend_code": code,
        "backend_sha256": "abc123",
    });
    gate_plugin_backend_code("com.acme.plugin", &mut manifest, true);
    let obj = manifest.as_object().unwrap();
    assert_eq!(
        obj.get("backend_code").and_then(|v| v.as_str()),
        Some(code),
        "signed backend_code must be preserved"
    );
    assert!(obj.contains_key("backend_sha256"));
}

// ── ARTIFACT CARRIAGE: signed bundle integrity ───────────────────────────
//
// The generalized sibling of the plugin gate for a `ryu_bundle` skill.
// The hash contract IS the interop spec (there is no separate publisher tool
// in this phase): `manifest.artifact_sha256` is the lower-case hex sha256 over
// the DECODED `.tar.gz` bytes, and the served `artifact` is those bytes
// base64-encoded. These tests lock that contract and the fail-closed ladder.

/// Build a server-shaped `catalog/detail` for a bundle: the declared hash
/// inside the signed `manifest`, the bundle as the unsigned top-level base64
/// `artifact`.
fn artifact_detail(artifact_sha256: Option<&str>, artifact_b64: Option<&str>) -> serde_json::Value {
    let mut manifest = serde_json::Map::new();
    manifest.insert("id".into(), serde_json::json!("owner/paid-skill"));
    manifest.insert("version".into(), serde_json::json!("1.0.0"));
    if let Some(h) = artifact_sha256 {
        manifest.insert("artifact_sha256".into(), serde_json::json!(h));
    }
    let mut detail = serde_json::Map::new();
    detail.insert("manifest".into(), serde_json::Value::Object(manifest));
    if let Some(a) = artifact_b64 {
        detail.insert("artifact".into(), serde_json::json!(a));
    }
    serde_json::Value::Object(detail)
}

/// Base64-encode raw bytes the way the control plane stores the artifact blob.
fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn artifact_sha256_hashes_decoded_bytes_not_base64() {
    // Lock the interop contract: the digest is over the DECODED bytes. Golden
    // vector: sha256("abc") lower-case hex — identical to the plugin path's, so
    // a publisher hashing the raw archive bytes verifies here byte-for-byte.
    assert_eq!(
        compute_artifact_sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn artifact_gate_carries_bundle_when_signed_and_hash_matches() {
    let bundle = b"fake .tar.gz skill bundle bytes";
    let hash = compute_artifact_sha256(bundle);
    let encoded = b64(bundle);
    let detail = artifact_detail(Some(&hash), Some(&encoded));
    let carried = gate_artifact("owner/paid-skill", &detail, true)
        .expect("signed + matching hash must carry the bundle");
    assert_eq!(
        carried.as_deref(),
        Some(encoded.as_str()),
        "the exact base64 bundle must be carried for the install path to decode"
    );
}

#[test]
fn artifact_gate_rejects_tampered_bundle_fail_closed() {
    // The load-bearing security assertion: the manifest was signed over the
    // ORIGINAL bundle's hash, but the served bundle was swapped after signing.
    // Install MUST hard-fail, not silently drop the bytes.
    let original = b"original skill bundle";
    let hash = compute_artifact_sha256(original);
    let tampered = b64(b"malicious swapped bundle");
    let detail = artifact_detail(Some(&hash), Some(&tampered));
    let err = gate_artifact("owner/paid-skill", &detail, true)
        .expect_err("signed manifest + swapped bundle must be rejected fail-closed");
    assert!(
        err.to_string().contains("hash mismatch"),
        "reject reason must name the hash mismatch, got: {err}"
    );
}

#[test]
fn artifact_gate_rejects_stripped_bundle_fail_closed() {
    // A signed manifest declares an artifact hash but the bundle was removed
    // after signing — active tampering, a hard reject.
    let hash = compute_artifact_sha256(b"some bundle");
    let detail = artifact_detail(Some(&hash), None);
    let err = gate_artifact("owner/paid-skill", &detail, true)
        .expect_err("declared hash with no served artifact must be rejected");
    assert!(
        err.to_string().contains("no artifact was served"),
        "got: {err}"
    );
}

#[test]
fn artifact_gate_never_carries_bundle_for_unsigned_item() {
    // The bypass guard: an UNSIGNED item that self-declares a matching hash
    // must NOT carry its bundle — nothing attests the hash.
    let bundle = b"bundle";
    let hash = compute_artifact_sha256(bundle);
    let detail = artifact_detail(Some(&hash), Some(&b64(bundle)));
    let carried = gate_artifact("owner/paid-skill", &detail, false)
        .expect("unsigned item is a benign no-carry (no error)");
    assert_eq!(
        carried, None,
        "unsigned self-declared hash must never carry the bundle"
    );
}

#[test]
fn artifact_gate_no_bundle_for_free_or_public_item() {
    // A signed item that declares no artifact hash (a free / public-source /
    // `private_repo` item) carries nothing — the existing install path is left
    // untouched. This is the branch that keeps free items back-compat.
    let detail = artifact_detail(None, None);
    let carried = gate_artifact("owner/free-skill", &detail, true)
        .expect("signed item with no artifact hash is valid");
    assert_eq!(carried, None);
}

#[test]
fn artifact_gate_rejects_invalid_base64_fail_closed() {
    // A declared hash with a non-base64 artifact blob is a corrupt/hostile
    // payload — refuse before any decode/install rather than panic.
    let detail = artifact_detail(Some("deadbeef"), Some("not valid base64 @@@@"));
    let err = gate_artifact("owner/paid-skill", &detail, true)
        .expect_err("non-base64 artifact must be rejected");
    assert!(err.to_string().contains("not valid base64"), "got: {err}");
}

// ── OKF knowledge-bundle source (Knowledge kind) ──────────────────────────

/// Write a tiny OKF bundle (two concepts + a non-conforming file) into a temp
/// dir for the local-path source tests.
fn write_sample_bundle() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("orders.md"),
        "---\ntype: BigQuery Table\ntitle: Orders\ndescription: The orders fact table\ntags: [sales, warehouse]\n---\n# Schema\nSee [revenue](/metrics/revenue.md).\n",
    )
    .unwrap();
    let metrics = dir.path().join("metrics");
    std::fs::create_dir_all(&metrics).unwrap();
    std::fs::write(
        metrics.join("revenue.md"),
        "---\ntype: Metric\ntitle: Revenue\n---\nTotal revenue.\n",
    )
    .unwrap();
    // A file with no frontmatter is skipped (permissive), never a hard fail.
    std::fs::write(dir.path().join("README.md"), "just prose, no frontmatter\n").unwrap();
    dir
}

fn okf_source(path: &std::path::Path) -> OkfBundleSource {
    OkfBundleSource {
        id: "team-kb".to_string(),
        display_name: "Team Knowledge".to_string(),
        source_url: path.to_string_lossy().to_string(),
        git_ref: None,
    }
}

#[tokio::test]
async fn okf_source_search_lists_concepts_and_filters() {
    let dir = write_sample_bundle();
    let src = okf_source(dir.path());
    let client = reqwest::Client::new();

    // Unfiltered: both conforming concepts, README skipped (no frontmatter).
    let all = src
        .search(&client, &CatalogQuery::default())
        .await
        .expect("search");
    let concepts = all["concepts"].as_array().expect("concepts array");
    assert_eq!(concepts.len(), 2);

    // Filter by a tag substring → only the orders table.
    let q = CatalogQuery {
        query: "warehouse".to_string(),
        ..Default::default()
    };
    let filtered = src.search(&client, &q).await.expect("search");
    let arr = filtered["concepts"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], "orders.md");
    assert_eq!(arr[0]["type"], "BigQuery Table");
}

#[tokio::test]
async fn okf_source_detail_resolves_concept_and_descriptor_is_bundle() {
    let dir = write_sample_bundle();
    let src = okf_source(dir.path());
    let client = reqwest::Client::new();

    // Detail resolves the concept by its bundle-relative file_path.
    let detail = src
        .detail(&client, "metrics/revenue.md")
        .await
        .expect("detail");
    assert_eq!(detail["type"], "Metric");
    assert_eq!(detail["title"], "Revenue");

    // A missing concept is a clear error, never a panic.
    assert!(src.detail(&client, "nope.md").await.is_err());

    // install_descriptor returns the WHOLE-bundle handoff (no files), with the
    // OKF git source Core needs to clone + ingest. `id` is ignored.
    let d = src
        .install_descriptor(&client, "ignored")
        .await
        .expect("descriptor");
    assert_eq!(d.kind, CatalogKind::Knowledge);
    assert_eq!(d.source_id, "team-kb");
    assert!(d.files.is_empty());
    assert_eq!(d.raw["format"], "okf");
    assert_eq!(d.raw["source_url"], src.source_url);
    assert_eq!(d.raw["bundle_id"], "team-kb");
}

#[tokio::test]
async fn okf_source_search_unreachable_degrades_to_empty_note() {
    // A non-existent local path is treated as a git URL; the clone fails and
    // search degrades to an empty, labelled envelope (never panics/errors).
    let src = OkfBundleSource {
        id: "broken".to_string(),
        display_name: "Broken".to_string(),
        source_url: "/this/path/does/not/exist-okf".to_string(),
        git_ref: None,
    };
    let client = reqwest::Client::new();
    let value = src
        .search(&client, &CatalogQuery::default())
        .await
        .expect("search degrades");
    assert_eq!(value["concepts"].as_array().map(Vec::len), Some(0));
    assert!(value["note"].as_str().is_some());
}

#[test]
fn ryu_hosted_default_index_url_is_built_in() {
    // With no explicit index_url and no env override, the source uses the
    // built-in static list (resolve_index_url is None).
    let src = RyuHostedMcpSource::builtin();
    // Note: this reads the env var; in CI it is unset, so expect None.
    if std::env::var(RYU_HOSTED_MCP_INDEX_ENV).is_err() {
        assert!(src.resolve_index_url().is_none());
    }
}

// ── pure helper coverage ─────────────────────────────────────────────────

#[test]
fn interpolate_env_substitutes_and_fails_closed() {
    // Uniquely-named vars avoid colliding with any other test in the binary.
    let key = format!("RYU_TEST_INTERP_{}", std::process::id());
    std::env::set_var(&key, "s3cr3t");
    let out = interpolate_env(&format!("Bearer ${{{key}}}")).unwrap();
    assert_eq!(out, "Bearer s3cr3t");
    std::env::remove_var(&key);

    // Fail-closed on a referenced-but-unset variable.
    assert!(interpolate_env(&format!("${{{key}}}")).is_err());
    // Fail-closed on an unterminated placeholder and an empty placeholder.
    assert!(interpolate_env("prefix ${OOPS").is_err());
    assert!(interpolate_env("${ }").is_err());
    // A template with no placeholders is passed through verbatim.
    assert_eq!(interpolate_env("plain value").unwrap(), "plain value");
}

#[test]
fn author_developer_string_handles_string_object_and_junk() {
    assert_eq!(
        author_developer_string(&serde_json::json!("  Ada  ")),
        Some("Ada".to_string())
    );
    assert_eq!(
        author_developer_string(&serde_json::json!({"name": " Grace "})),
        Some("Grace".to_string())
    );
    // Empty string / whitespace object name / non-string-object → None.
    assert_eq!(author_developer_string(&serde_json::json!("   ")), None);
    assert_eq!(
        author_developer_string(&serde_json::json!({"name": ""})),
        None
    );
    assert_eq!(author_developer_string(&serde_json::json!(42)), None);
    assert_eq!(author_developer_string(&serde_json::json!(null)), None);
}

#[test]
fn http_url_allowlists_http_and_https_only() {
    assert_eq!(http_url("  https://x.io/a  "), Some("https://x.io/a"));
    assert_eq!(http_url("HTTP://x.io"), Some("HTTP://x.io"));
    assert_eq!(http_url("ftp://x.io"), None);
    assert_eq!(http_url("javascript:alert(1)"), None);
    assert_eq!(http_url("owner/repo"), None);
}

#[test]
fn github_raw_head_base_from_shorthand_and_url() {
    assert_eq!(
        github_raw_head_base("owner/repo").as_deref(),
        Some("https://raw.githubusercontent.com/owner/repo/HEAD/")
    );
    assert_eq!(
        github_raw_head_base("https://github.com/owner/repo.git").as_deref(),
        Some("https://raw.githubusercontent.com/owner/repo/HEAD/")
    );
    // A single bare segment has no repo name → None.
    assert_eq!(github_raw_head_base("owner"), None);
}

#[test]
fn marketplace_manifest_urls_direct_json_vs_expanded_paths() {
    // A direct .json URL is the sole candidate.
    let direct = marketplace_manifest_urls("https://host/x/marketplace.JSON");
    assert_eq!(direct, vec!["https://host/x/marketplace.JSON".to_string()]);

    // A shorthand expands to one candidate per manifest path, Ryu-native first.
    let expanded = marketplace_manifest_urls("owner/repo");
    assert_eq!(expanded.len(), MANIFEST_PATHS.len());
    assert!(expanded[0].ends_with(".ryu-plugin/marketplace.json"));
    assert!(expanded
        .iter()
        .all(|u| u.starts_with("https://raw.githubusercontent.com/owner/repo/HEAD/")));
}

#[test]
fn github_owner_repo_extracts_or_rejects() {
    assert_eq!(
        github_owner_repo("owner/repo"),
        Some(("owner".into(), "repo".into()))
    );
    assert_eq!(
        github_owner_repo("https://github.com/owner/repo/tree/HEAD/x"),
        Some(("owner".into(), "repo".into()))
    );
    // Trailing .git stripped.
    assert_eq!(
        github_owner_repo("owner/repo.git"),
        Some(("owner".into(), "repo".into()))
    );
    // A dotted first segment is a bare host, not owner/repo.
    assert_eq!(github_owner_repo("example.com/x"), None);
    // A non-github URL scheme is rejected.
    assert_eq!(github_owner_repo("https://gitlab.com/o/r"), None);
    // A single segment can't be split.
    assert_eq!(github_owner_repo("solo"), None);
}

#[test]
fn is_local_subdir_source_discriminates() {
    assert!(is_local_subdir_source("teaching"));
    // owner/repo, URLs, dotted hosts, builtin, spaces, empty → not local.
    assert!(!is_local_subdir_source("owner/repo"));
    assert!(!is_local_subdir_source("https://x.io/y"));
    assert!(!is_local_subdir_source("example.com"));
    assert!(!is_local_subdir_source("builtin"));
    assert!(!is_local_subdir_source("BUILTIN"));
    assert!(!is_local_subdir_source("has space"));
    assert!(!is_local_subdir_source("   "));
}

#[test]
fn resolve_marketplace_source_maps_local_subdir_against_repo() {
    // A local subfolder resolves to a github tree URL of the marketplace repo.
    assert_eq!(
        resolve_marketplace_source("teaching", "owner/repo"),
        "https://github.com/owner/repo/tree/HEAD/teaching"
    );
    // When the repo context is not a github repo, degrade to the bare source.
    assert_eq!(
        resolve_marketplace_source("teaching", "https://host/x/marketplace.json"),
        "teaching"
    );
    // An owner/repo or URL source is returned unchanged.
    assert_eq!(
        resolve_marketplace_source("acme/tool", "owner/repo"),
        "acme/tool"
    );
}

#[test]
fn scoped_and_subdir_source_build_tree_urls() {
    assert_eq!(
        scoped_source("owner/repo", "skills/a"),
        "https://github.com/owner/repo/tree/HEAD/skills/a"
    );
    assert_eq!(
        scoped_source("https://github.com/owner/repo.git", "s"),
        "https://github.com/owner/repo/tree/HEAD/s"
    );
    // A non-repo string is returned unchanged by scoped_source.
    assert_eq!(scoped_source("not a repo here", "s"), "not a repo here");

    // subdir_source nests under an already-resolved tree URL...
    assert_eq!(
        subdir_source("https://github.com/o/r/tree/HEAD/plugin", "leaf"),
        "https://github.com/o/r/tree/HEAD/plugin/leaf"
    );
    // ...otherwise it delegates to scoped_source.
    assert_eq!(
        subdir_source("owner/repo", "leaf"),
        "https://github.com/owner/repo/tree/HEAD/leaf"
    );
}

#[test]
fn urlencode_component_and_path_escape_correctly() {
    // Component encoding escapes slashes and spaces.
    assert_eq!(urlencode_component("a b/c@d"), "a%20b%2Fc%40d");
    // Unreserved chars pass through untouched.
    assert_eq!(urlencode_component("A-z0.9_~"), "A-z0.9_~");
    // Path encoding PRESERVES `/` and `@` (qualified names), escapes the space.
    assert_eq!(urlencode_path("@scope/name x"), "@scope/name%20x");
}

/// `hidden` is the LIVE kill switch: the published marketplace.json controls
/// visibility for every already-shipped client, with no re-mirror and no Core
/// release. Both readers must honour it, or a listing hidden from the Plugins
/// tab would still be sold as a Skill out of the same index.
#[test]
fn hidden_entries_are_dropped_by_both_readers() {
    let raw = br#"{
            "name": "m",
            "plugins": [
                { "name": "shown", "source": "acme/shown" },
                { "name": "gone", "source": "acme/gone", "hidden": true }
            ]
        }"#;
    let manifest = parse_marketplace(raw).expect("parses");

    let plugins = plugins_as_items(&manifest, "acme/m");
    assert_eq!(plugins.len(), 1, "hidden plugin must not be listed");
    assert_eq!(plugins[0].plugin, "shown");

    let skills = flatten_plugins(&manifest, "acme/m");
    assert!(
        skills.iter().all(|i| i.plugin != "gone"),
        "hidden entry must not leak through the skill reader either"
    );
}

/// `deprecated` keeps the listing visible and rides the card and the detail
/// normalised, so a third-party index uses the same shapes a manifest does.
#[test]
fn deprecated_entries_stay_listed_and_carry_the_notice() {
    let raw = br#"{
            "name": "m",
            "plugins": [
                { "name": "old", "source": "acme/old",
                  "deprecated": { "message": "Use new.", "replacement": "new" } },
                { "name": "flagged", "source": "acme/flagged", "deprecated": true },
                { "name": "current", "source": "acme/current", "deprecated": false }
            ]
        }"#;
    let manifest = parse_marketplace(raw).expect("parses");
    let items = plugins_as_items(&manifest, "acme/m");
    assert_eq!(items.len(), 3, "deprecation never hides a listing");

    let source = MarketplaceSource::new("m", "M", "acme/m".to_owned(), CatalogKind::Plugin);
    let card = |name: &str| {
        let item = items.iter().find(|i| i.plugin == name).expect("listed");
        source.item_to_card(item)
    };
    assert_eq!(
        card("old")["deprecated"],
        serde_json::json!({ "message": "Use new.", "replacement": "new" })
    );
    assert_eq!(card("flagged")["deprecated"], serde_json::json!({}));
    assert!(card("current").get("deprecated").is_none());
}

/// `deprecated` is display-only: a malformed value in a third-party index
/// keeps the entry listed with no notice and never fails the whole index.
#[test]
fn malformed_deprecation_is_ignored_not_fatal() {
    let raw = br#"{
            "name": "m",
            "plugins": [
                { "name": "odd", "source": "acme/odd", "deprecated": 42 },
                { "name": "list", "source": "acme/list", "deprecated": [] },
                { "name": "flagged", "source": "acme/flagged", "deprecated": true }
            ]
        }"#;
    let manifest = parse_marketplace(raw).expect("a bad deprecated value must not fail the index");
    let items = plugins_as_items(&manifest, "acme/m");
    assert_eq!(items.len(), 3);

    let source = MarketplaceSource::new("m", "M", "acme/m".to_owned(), CatalogKind::Plugin);
    let card = |name: &str| {
        let item = items.iter().find(|i| i.plugin == name).expect("listed");
        source.item_to_card(item)
    };
    assert!(card("odd").get("deprecated").is_none());
    assert!(card("list").get("deprecated").is_none());
    assert_eq!(card("flagged")["deprecated"], serde_json::json!({}));
}

/// Absent ⇒ visible. Every index published before this field existed must keep
/// working unchanged, and an older Core that predates it shows everything —
/// the safe direction for a flag whose job is to REMOVE things.
#[test]
fn an_index_without_the_field_still_lists_everything() {
    let raw = br#"{
            "name": "m",
            "plugins": [{ "name": "legacy", "source": "acme/legacy" }]
        }"#;
    let manifest = parse_marketplace(raw).expect("parses");
    assert_eq!(plugins_as_items(&manifest, "acme/m").len(), 1);
}
