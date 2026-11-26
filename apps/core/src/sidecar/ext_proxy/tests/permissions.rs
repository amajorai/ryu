use super::*;

// ── App-declared route permissions ──────────────────────────────────────────

fn route_for_method(
    path: &str,
    method: &str,
    permission: &str,
) -> crate::plugin_manifest::schema::RouteSpec {
    crate::plugin_manifest::schema::RouteSpec {
        path: path.to_owned(),
        method: Some(method.to_owned()),
        auth: Default::default(),
        permission: Some(permission.to_owned()),
        resource_param: None,
    }
}

/// The back-compat property the whole gate rests on: a route nobody annotated
/// imposes NOTHING, so every app installed today keeps proxying unchanged.
#[test]
fn an_unannotated_route_imposes_no_permission() {
    assert_eq!(
        required_permission_for(
            &route("/tabs/:id", None, None),
            "/tabs/t-42",
            "com.acme.app"
        ),
        None
    );
}

#[test]
fn a_rule_naming_no_resource_gates_on_the_app_itself() {
    // A route that identifies no object (`POST /settings`) is still grantable —
    // as the app. Without this fallback such a route could only be granted
    // node-wide or not at all.
    assert_eq!(
        required_permission_for(
            &route("/settings", Some("settings.write"), None),
            "/settings",
            "com.acme.app"
        ),
        Some(("settings.write".to_owned(), "com.acme.app".to_owned()))
    );
}

#[test]
fn a_rule_naming_a_resource_param_gates_on_the_captured_value() {
    assert_eq!(
        required_permission_for(
            &route("/tabs/:id/close", Some("tabs.close"), Some("id")),
            "/tabs/t-42/close",
            "com.acme.app"
        ),
        Some(("tabs.close".to_owned(), "t-42".to_owned()))
    );
    // The param is positional, so a LATER param must not be read off the first
    // one's segment — that would gate every tab on the wrong id.
    assert_eq!(
        required_permission_for(
            &route("/w/:workspace/tabs/:id", Some("tabs.close"), Some("id")),
            "/w/main/tabs/t-42",
            "com.acme.app"
        ),
        Some(("tabs.close".to_owned(), "t-42".to_owned()))
    );
}

/// Validation rejects a `resource_param` its path does not contain, so this is
/// the belt-and-braces case (a manifest that reached disk some other way). It
/// must degrade to the APP, never to an empty resource id — `"<plugin>:"` would
/// be a key an admin cannot see and cannot address.
#[test]
fn a_resource_param_that_captures_nothing_falls_back_to_the_app() {
    assert_eq!(
        required_permission_for(
            &route("/files/*rest", Some("files.read"), Some("id")),
            "/files/a/b",
            "com.acme.app"
        ),
        Some(("files.read".to_owned(), "com.acme.app".to_owned()))
    );
}

/// A `:param` sitting AFTER a wildcard cannot be captured positionally: the
/// wildcard swallows an unknown number of segments, so the index the param
/// occupies in the pattern no longer corresponds to anything in the actual
/// path. Reading whatever happens to sit there would let the CALLER choose
/// which resource the ACL is evaluated against — a request could name a
/// resource it has an allow on while acting on a different one.
///
/// Falling back to the app id is the fail-closed answer: the grant still has
/// to exist, it is just scoped to the app rather than to a caller-chosen id.
#[test]
fn a_param_after_a_wildcard_captures_nothing_rather_than_the_wrong_segment() {
    assert_eq!(
        captured_param("/a/*rest/:id", "/a/one/two/three", "id"),
        None
    );
    assert_eq!(
        required_permission_for(
            &route("/a/*rest/:id", Some("x.edit"), Some("id")),
            "/a/one/two/three",
            "com.acme.app"
        ),
        Some(("x.edit".to_owned(), "com.acme.app".to_owned())),
        "must fall back to the app id, never to a caller-chosen segment"
    );
}

/// The rule and the forward decision must come from the SAME matched route:
/// a request to an app's un-annotated route is not gated by the annotation on a
/// sibling route, and the annotated one is.
#[test]
fn only_the_matched_route_imposes_its_own_rule() {
    let mut manifest = provider_manifest(9099, None);
    let http = manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the provider fixture declares http");
    http.routes = vec![
        route("/health", None, None),
        route("/tabs/:id/close", Some("tabs.close"), Some("id")),
    ];

    let (_, _, health) =
        resolve_route(&manifest, "/health", "GET").expect("declared route resolves");
    assert_eq!(
        required_permission_for(health, "/health", &manifest.id),
        None,
        "an un-annotated route must not inherit a sibling's rule"
    );

    let (_, _, close) =
        resolve_route(&manifest, "/tabs/t-42/close", "POST").expect("declared route resolves");
    assert_eq!(
        required_permission_for(close, "/tabs/t-42/close", &manifest.id),
        Some(("tabs.close".to_owned(), "t-42".to_owned()))
    );

    // And an UNDECLARED path still resolves to nothing at all (404), which is
    // the gate that runs before any of this.
    assert!(resolve_route(&manifest, "/tabs/t-42/steal", "GET").is_none());
}

#[test]
fn one_path_resolves_different_permissions_by_http_method() {
    let mut manifest = provider_manifest(9099, None);
    manifest.sidecars[0].http.as_mut().expect("http").routes = vec![
        route_for_method("/items", "GET", "items.view"),
        route_for_method("/items", "POST", "items.edit"),
    ];

    let (_, _, read) = resolve_route(&manifest, "/items", "GET").expect("GET route");
    let (_, _, write) = resolve_route(&manifest, "/items", "POST").expect("POST route");
    assert_eq!(read.permission.as_deref(), Some("items.view"));
    assert_eq!(write.permission.as_deref(), Some("items.edit"));
    assert!(resolve_route(&manifest, "/items", "DELETE").is_none());
}

/// The other half of the chain: the `(permission, resource_id)` the proxy hands
/// to the resolver is one that actually DENIES by default and can be granted
/// per-resource. Without this an app could declare a level that no role holds
/// and no overwrite can reach — enforcement that is really just a wall.
///
/// Drives the pure resolver (no disk, no process-global node-org state); the
/// glue in between is `crate::server::enforce_permission_on`, which the kernel's
/// own per-resource routes share.
#[test]
fn an_app_declared_level_denies_a_member_until_it_is_granted_on_the_resource() {
    use crate::acl::vocabulary::{build_vocabulary, builtin_role_catalog, DeclaredLevel};
    use crate::acl::{resolve, Decision, Overwrite, OverwriteTarget, Principal, ResourceAcl};

    let plugin_id = "com.acme.app";
    let (permission, resource_id) = required_permission_for(
        &route("/tabs/:id/close", Some("tabs.close"), Some("id")),
        "/tabs/t-42/close",
        plugin_id,
    )
    .expect("the route is annotated");

    let vocab = build_vocabulary(vec![DeclaredLevel {
        plugin_id: plugin_id.to_owned(),
        builtin: false,
        id: permission.clone(),
        label: "Can close tabs".to_owned(),
        description: "Closes tabs.".to_owned(),
        implies: Vec::new(),
    }]);
    let catalog = builtin_role_catalog();
    let member = Principal {
        user_id: "u1".to_owned(),
        org_id: Some("org1".to_owned()),
        team_ids: Default::default(),
        role_ids: ["member".to_owned()].into_iter().collect(),
    };

    // No built-in role knows what an app's own level means, so the default is
    // denial — an app cannot widen its callers' authority by declaring a level.
    assert_eq!(
        resolve(
            &vocab.registry,
            &catalog,
            &member,
            &ResourceAcl::new(),
            &permission
        ),
        Decision::Denied
    );

    // …and an admin granting it on exactly the resource the proxy computed is
    // what turns it on. A grant on a DIFFERENT id must not carry over.
    let granted = ResourceAcl::new().with(
        Overwrite::new(OverwriteTarget::Member(member.user_id.clone()))
            .allowing([permission.clone()]),
    );
    assert_eq!(resource_id, "t-42");
    assert_eq!(
        resolve(&vocab.registry, &catalog, &member, &granted, &permission),
        Decision::Allowed
    );
}

// ── A record id the app would decode a second time (SA-33) ──────────────────

fn record_manifest() -> crate::plugin_manifest::PluginManifest {
    let mut manifest = provider_manifest(9099, None);
    manifest.sidecars[0].http.as_mut().expect("http").routes = vec![
        route("/:room_id", Some("rooms.view"), Some("room_id")),
        route("/:room_id/turn", Some("rooms.run"), Some("room_id")),
        route("/files/:name", Some("files.read"), None),
        route("/raw/:id", None, None),
    ];
    manifest
}

/// The apps decode the record id once more than Core does (axum's `Path`,
/// `decodeURIComponent`). An id that still changes under one more decode would be
/// checked on text no per-record rule names and served as another record, so it
/// resolves no route, with the method of either lane (the WebSocket lane resolves
/// as GET).
#[test]
fn a_record_id_that_decodes_again_resolves_no_route() {
    let manifest = record_manifest();
    for sub_path in [
        "/%72oom_1",
        "/%72oom_1/turn",
        "/room_%31",
        "/%2572oom_1",
        "/room%3A1",
    ] {
        for method in ["GET", "POST"] {
            assert!(
                resolve_route(&manifest, sub_path, method).is_none(),
                "{method} {sub_path} must not resolve"
            );
        }
    }
}

#[test]
fn a_plain_record_id_and_routes_without_a_record_resolve_as_before() {
    let manifest = record_manifest();
    for (sub_path, permission, id) in [
        ("/room_1", "rooms.view", "room_1"),
        ("/room:1", "rooms.view", "room:1"),
        ("/room_1/turn", "rooms.run", "room_1"),
    ] {
        for method in ["GET", "POST"] {
            let (_, _, matched) = resolve_route(&manifest, sub_path, method)
                .unwrap_or_else(|| panic!("{method} {sub_path} must resolve"));
            assert_eq!(
                required_permission_for(matched, sub_path, &manifest.id),
                Some((permission.to_owned(), id.to_owned()))
            );
        }
    }
    // No `resource_param`, so an escape in the path changes nothing here.
    let (_, _, files) = resolve_route(&manifest, "/files/%72eport", "GET").expect("files");
    assert_eq!(
        required_permission_for(files, "/files/%72eport", &manifest.id),
        Some(("files.read".to_owned(), manifest.id.clone()))
    );
    let (_, _, raw) = resolve_route(&manifest, "/raw/%72", "GET").expect("raw");
    assert_eq!(required_permission_for(raw, "/raw/%72", &manifest.id), None);
}

/// An id that is not text once decoded (`%ff`) resolves no route either: no app
/// could read it as the text Core checked. The dot segment guard at the top of
/// `resolve_route` already refuses such a path on every route, because its own
/// decode fails, so this holds with and without the record id check. It pins the
/// answer for a route that names a record.
#[test]
fn a_record_id_that_is_not_text_once_decoded_resolves_no_route() {
    let manifest = record_manifest();
    for sub_path in ["/%ff", "/%ff/turn", "/room_%c3"] {
        for method in ["GET", "POST"] {
            assert!(
                resolve_route(&manifest, sub_path, method).is_none(),
                "{method} {sub_path} must not resolve"
            );
        }
    }
    // The same without a `resource_param`, which is why this needs no record check.
    assert!(resolve_route(&manifest, "/raw/%ff", "GET").is_none());
}

/// A `%` that is not followed by two hex digits is no escape: one more decode
/// leaves the id as it is, so the app reads the same text Core checked. Such an id
/// resolves as before, and the permission is checked on the id as given.
#[test]
fn a_record_id_with_a_percent_that_is_no_escape_resolves_as_before() {
    let manifest = record_manifest();
    for (sub_path, permission, id) in [
        ("/100%", "rooms.view", "100%"),
        ("/room%zz", "rooms.view", "room%zz"),
        ("/room%4", "rooms.view", "room%4"),
        ("/room%4z", "rooms.view", "room%4z"),
        ("/%", "rooms.view", "%"),
        ("/room%/turn", "rooms.run", "room%"),
    ] {
        for method in ["GET", "POST"] {
            let (_, _, matched) = resolve_route(&manifest, sub_path, method)
                .unwrap_or_else(|| panic!("{method} {sub_path} must resolve"));
            assert_eq!(
                required_permission_for(matched, sub_path, &manifest.id),
                Some((permission.to_owned(), id.to_owned()))
            );
        }
    }
}

/// End to end through the real `/api/ext` router, so axum's own decode is part of
/// the test: on the HTTP lane and on the WebSocket lane, an id escaped twice is a
/// 404 before any permission check, and a plain id still gets past the route gate.
#[tokio::test]
async fn both_lanes_refuse_a_record_id_escaped_twice() {
    use tower::ServiceExt as _;

    const APP: &str = "@acme/records";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state.app_store.set_enabled(APP, &[]).await.unwrap();
    let mut manifest = web_app(APP, None, false, &[]);
    let mut room = route("/:room_id", Some("rooms.view"), Some("room_id"));
    room.auth = RouteAuth::Public;
    manifest.sidecars[0].http.as_mut().expect("http").routes = vec![room];
    state.app_manifests.write().await.push(manifest);
    let router = ext_routes(None).with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = router.clone();
    let server = tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    let ws_status = |id: &'static str| async move {
        let url = format!("ws://127.0.0.1:{port}/api/ext/ws/{APP}/{id}");
        match tokio_tungstenite::connect_async(url).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                Some(response.status().as_u16())
            }
            _ => None,
        }
    };

    for (id, refused) in [("%2572oom_1", true), ("room_1", false)] {
        let request = Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}/{id}"))
            .body(Body::empty())
            .unwrap();
        let http = router.clone().oneshot(request).await.unwrap().status();
        assert_eq!(
            http == StatusCode::NOT_FOUND,
            refused,
            "HTTP {id} gave {http}"
        );
        let ws = ws_status(id).await;
        assert_eq!(ws == Some(404), refused, "WebSocket {id} gave {ws:?}");
    }
    server.abort();
}
