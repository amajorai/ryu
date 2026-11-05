use super::*;

// ── Web-delegated admission ─────────────────────────────────────────────────

fn caller_header(id: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(HDR_APP_CALLER, id.parse().unwrap());
    headers
}

#[test]
fn a_web_delegated_forward_is_marked_admitted_over_any_sidecar_value() {
    let mut response = Response::builder()
        .header(HDR_WEB_DELEGATION, "forged-by-sidecar")
        .body(Body::empty())
        .unwrap();
    mark_web_delegation_admitted(&mut response);
    let values: Vec<_> = response
        .headers()
        .get_all(HDR_WEB_DELEGATION)
        .iter()
        .collect();
    assert_eq!(values, vec![WEB_DELEGATION_ADMITTED]);
}

#[test]
fn copy_headers_strips_the_web_delegation_headers() {
    let mut src = HeaderMap::new();
    src.insert(HDR_WEB_DELEGATION, "1".parse().unwrap());
    src.insert(HDR_APP_CALLER, "@acme/caller".parse().unwrap());
    src.insert("accept", "application/json".parse().unwrap());
    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);
    assert!(dst.get(HDR_WEB_DELEGATION).is_none());
    assert!(dst.get(HDR_APP_CALLER).is_none());
    assert!(dst.get("accept").is_some());
}

/// Only Core's own event fan-out may carry the delivery marker: a caller's copy
/// never crosses a proxied hop, so a subscriber can trust it.
#[test]
fn copy_headers_strips_a_caller_supplied_event_delivery_marker() {
    let mut src = HeaderMap::new();
    src.insert(HDR_EVENT_DELIVERY, "forged".parse().unwrap());
    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);
    assert!(dst.get(HDR_EVENT_DELIVERY).is_none());
}

/// Only an explicit `full` or `limited` web entry counts. The listing rule
/// (`supports_surface`) admits legacy manifests and unknown levels; this gate must
/// not.
#[test]
fn strict_web_support_admits_only_full_and_limited() {
    for (level, expected) in [
        (Some("full"), true),
        (Some("limited"), true),
        (Some("list"), false),
        (Some("commands"), false),
        (Some("none"), false),
        (Some("future-level"), false),
        (None, false),
    ] {
        let manifest = web_app("@acme/app", level, true, &[]);
        assert_eq!(
            strictly_supports_web(&manifest),
            expected,
            "web support {level:?}"
        );
    }
    // Legacy: no `surfaces` and an empty `targets` list is "every surface" for
    // listing, but never a credential-bearing web hop.
    let legacy = web_app("@acme/app", None, true, &[]);
    assert!(legacy.supports_surface(crate::plugin_manifest::Surface::Web));
    assert!(!strictly_supports_web(&legacy));
    // Another surface's entry does not stand in for web.
    let mut desktop_only = web_app("@acme/app", None, true, &[]);
    desktop_only.surfaces = serde_json::from_value(json!({
        "desktop": { "support": "full" }
    }))
    .unwrap();
    assert!(!strictly_supports_web(&desktop_only));
}

#[test]
fn web_delegation_facts_read_only_a_valid_installed_caller_app() {
    let target = web_app("@acme/target", Some("full"), true, &[]);
    let caller = web_app("@acme/caller", Some("limited"), true, &["app:http"]);
    let headless = web_app("@acme/headless", Some("full"), false, &[]);
    let manifests = vec![target.clone(), caller, headless];

    let facts = web_delegation_facts(&manifests, &target, true, &caller_header("@acme/caller"));
    assert_eq!(
        facts,
        WebDelegationFacts {
            route_declares_permission: true,
            target_supports_web: true,
            caller_app: Some(WebCallerApp {
                id: "@acme/caller".to_owned(),
                supports_web: true,
                has_companion: true,
            }),
        }
    );
    let facts = web_delegation_facts(&manifests, &target, true, &caller_header("@acme/headless"));
    assert_eq!(facts.caller_app.map(|app| app.has_companion), Some(false));
    // Missing, malformed and uninstalled caller ids name no app at all.
    for headers in [
        HeaderMap::new(),
        caller_header("@ACME/caller"),
        caller_header("@acme/caller/extra"),
        caller_header("@acme/missing"),
    ] {
        assert_eq!(
            web_delegation_facts(&manifests, &target, true, &headers).caller_app,
            None
        );
    }
}

#[test]
fn web_delegated_route_gate_refuses_with_404_until_every_manifest_fact_holds() {
    let caller = WebCallerApp {
        id: "@acme/caller".to_owned(),
        supports_web: true,
        has_companion: true,
    };
    let admitted = WebDelegationFacts {
        route_declares_permission: true,
        target_supports_web: true,
        caller_app: Some(caller.clone()),
    };
    assert_eq!(web_delegated_route_gate(&admitted), Ok(&caller));

    let refusals = [
        WebDelegationFacts {
            route_declares_permission: false,
            ..admitted.clone()
        },
        WebDelegationFacts {
            target_supports_web: false,
            ..admitted.clone()
        },
        WebDelegationFacts {
            caller_app: None,
            ..admitted.clone()
        },
        WebDelegationFacts {
            caller_app: Some(WebCallerApp {
                supports_web: false,
                ..caller.clone()
            }),
            ..admitted.clone()
        },
        WebDelegationFacts {
            caller_app: Some(WebCallerApp {
                has_companion: false,
                ..caller.clone()
            }),
            ..admitted.clone()
        },
    ];
    for facts in refusals {
        assert_eq!(
            web_delegated_route_gate(&facts),
            Err(StatusCode::NOT_FOUND),
            "{facts:?}"
        );
    }
}

#[test]
fn web_caller_grant_is_own_app_http_or_the_exact_target_edge() {
    assert_eq!(
        web_caller_required_grant("@ryu/finetune", "@ryu/finetune"),
        "app:http"
    );
    assert_eq!(
        web_caller_required_grant("@ryu/workflows", "@ryu/recipes"),
        "app:http:@ryu/recipes"
    );
}

/// The caller app must be enabled and hold the exact edge in its CURRENT approved
/// set: plain `app:http` never reaches another app, a target grant never reaches
/// the caller's own sidecar, a wildcard is not an edge, and an approval the
/// manifest no longer declares does not count.
#[tokio::test]
async fn web_caller_app_admission_requires_the_exact_reviewed_grant() {
    const CALLER: &str = "@acme/caller";
    const TARGET: &str = "@acme/target";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_manifests.write().await.push(web_app(
        CALLER,
        Some("full"),
        true,
        &["app:http", "app:http:@acme/target", "app:http:@acme/*"],
    ));

    // Not installed, then installed but disabled.
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, CALLER).await,
        Err(StatusCode::NOT_FOUND)
    );
    state.app_store.insert(CALLER, "1.0.0").await.unwrap();
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, CALLER).await,
        Err(StatusCode::NOT_FOUND)
    );

    let approve = |grants: &[&str]| grants.iter().map(|g| (*g).to_owned()).collect::<Vec<_>>();

    state
        .app_store
        .set_enabled(CALLER, &approve(&["app:http"]))
        .await
        .unwrap();
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, CALLER).await,
        Ok(())
    );
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, TARGET).await,
        Err(StatusCode::NOT_FOUND),
        "plain app:http never reaches another app"
    );

    state
        .app_store
        .set_enabled(CALLER, &approve(&["app:http:@acme/target"]))
        .await
        .unwrap();
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, TARGET).await,
        Ok(())
    );
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, CALLER).await,
        Err(StatusCode::NOT_FOUND),
        "a target grant does not cover the caller's own sidecar"
    );

    state
        .app_store
        .set_enabled(CALLER, &approve(&["app:http:@acme/*"]))
        .await
        .unwrap();
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, TARGET).await,
        Err(StatusCode::NOT_FOUND),
        "a wildcard is not a reviewed edge"
    );

    // Approved but no longer declared by the manifest: not current.
    state
        .app_store
        .set_enabled(CALLER, &approve(&["app:http:@acme/other"]))
        .await
        .unwrap();
    assert_eq!(
        web_caller_app_admitted(&state, CALLER, "@acme/other").await,
        Err(StatusCode::NOT_FOUND)
    );
}

/// Anonymous callers and an unbound node (this test process) are refused before
/// any manifest or grant fact is consulted, even when every one of them holds.
#[tokio::test]
async fn web_delegated_admission_refuses_anonymous_and_unbound_callers() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let facts = WebDelegationFacts {
        route_declares_permission: true,
        target_supports_web: true,
        caller_app: Some(WebCallerApp {
            id: "@acme/target".to_owned(),
            supports_web: true,
            has_companion: true,
        }),
    };
    assert_eq!(
        web_delegated_admission(&state, "@acme/target", &None, &facts).await,
        Err(StatusCode::FORBIDDEN)
    );
    let member = crate::identity_verify::VerifiedCaller {
        user_id: "alice".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    assert!(crate::sidecar::control_plane::registered_org().is_none());
    assert_eq!(
        web_delegated_admission(&state, "@acme/target", &Some(member), &facts).await,
        Err(StatusCode::FORBIDDEN)
    );
}
