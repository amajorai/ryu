use super::*;

#[test]
fn ext_token_is_random_per_plugin_and_owner_token_independent() {
    let a1 = ext_token(Some("node-secret"), "com.acme.a");
    let a2 = ext_token(Some("node-secret"), "com.acme.a");
    let b = ext_token(Some("node-secret"), "com.acme.b");
    assert_eq!(a1, a2, "one plugin keeps one credential");
    assert_ne!(a1, b, "plugin A's token must never equal plugin B's");
    assert_eq!(ext_token(Some("other"), "com.acme.a"), a1);
    assert!(a1.starts_with("ryux_"));
    assert_eq!(a1.len(), 69);
}

#[test]
fn route_matches_literals_params_and_wildcards() {
    // Literal.
    assert!(route_matches("/status", "/status"));
    assert!(!route_matches("/status", "/other"));
    // `:param` matches exactly one non-empty segment (mail's /inboxes/:id).
    assert!(route_matches("/inboxes/:id", "/inboxes/abc"));
    assert!(!route_matches("/inboxes/:id", "/inboxes")); // too short
    assert!(!route_matches("/inboxes/:id", "/inboxes/abc/extra")); // too long
                                                                   // Undeclared subpath of a declared prefix is NOT admitted (no wildcard).
    assert!(!route_matches("/inboxes", "/inboxes/abc"));
    // Trailing wildcard matches the remainder.
    assert!(route_matches("/files/*rest", "/files/a/b/c"));
    assert!(route_matches("/files/*rest", "/files/a"));
    // Multi-segment literal + param.
    assert!(route_matches("/inboxes/:id/send", "/inboxes/xyz/send"));
    assert!(!route_matches("/inboxes/:id/send", "/inboxes/xyz/recv"));
}

#[test]
fn route_resolution_prefers_a_specific_literal_over_a_broad_param() {
    let mut manifest = provider_manifest(9099, None);
    let http = manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the provider fixture declares http");
    let mut broad = route("/:id", None, None);
    broad.auth = crate::plugin_manifest::schema::RouteAuth::Public;
    http.routes = vec![broad, route("/admin", None, None)];

    let (_, _, matched) = resolve_route(&manifest, "/admin", "GET").expect("a route resolves");
    assert_eq!(matched.path, "/admin");
    assert_eq!(
        matched.auth,
        crate::plugin_manifest::schema::RouteAuth::Protected
    );
}

#[test]
fn route_resolution_fails_closed_on_equal_specificity_ties() {
    let mut manifest = provider_manifest(9099, None);
    let http = manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the provider fixture declares http");
    http.routes = vec![route("/:id", None, None), route("/:slug", None, None)];

    assert!(
        resolve_route(&manifest, "/admin", "GET").is_none(),
        "equal-specificity routes must not fall back to declaration order"
    );
}

#[test]
fn route_resolution_fails_closed_on_cross_sidecar_ties() {
    let mut manifest = provider_manifest(9099, None);
    manifest.sidecars[0]
        .http
        .as_mut()
        .expect("provider http")
        .routes = vec![route("/:id", None, None)];
    let mut second = manifest.sidecars[0].clone();
    second.name = "other".to_owned();
    second.port = 9100;
    second.http.as_mut().expect("provider http").routes = vec![route("/:slug", None, None)];
    manifest.sidecars.push(second);

    assert!(resolve_route(&manifest, "/admin", "GET").is_none());
}

#[test]
fn dot_segments_are_rejected() {
    // The traversal-to-auth-confusion guard: any `.`/`..` segment is refused so a
    // raw sub-path can never match a Public route yet normalize onto a Protected
    // mount after reqwest collapses `..`.
    assert!(has_dot_segment("/webhook/../admin"));
    assert!(has_dot_segment("/webhook/..")); // trailing
    assert!(has_dot_segment("/a/./b"));
    assert!(has_dot_segment("..")); // no leading slash
                                    // Legitimate paths (including a dot INSIDE a segment) are untouched.
    assert!(!has_dot_segment("/webhook/abc"));
    assert!(!has_dot_segment("/files/a.b.c/d"));
    assert!(!has_dot_segment("/inboxes/:id"));
    assert!(!has_dot_segment(""));
}

#[test]
fn multiply_encoded_dot_segments_are_rejected() {
    for path in [
        "/admin%2Fforms",
        "/admin%252Fforms",
        "/admin%5cforms",
        "/admin%255cforms",
    ] {
        assert!(has_dot_segment(path));
    }
    // The single-decode assumption this guard used to rest on holds for a route,
    // but not for a path parameter VALUE. A derived tool fills `{id}` from model
    // arguments and `build_rest_request` percent-encodes on the way in, so a model
    // sending `%2e%2e` arrives here as `%2e%2e` after the extractor's one decode —
    // which is not the literal `..`, but the sidecar's own framework will decode it
    // a second time and get one.
    assert!(has_dot_segment("/records/%2e%2e/admin"));
    assert!(has_dot_segment("/records/%2E%2E/admin"));
    assert!(has_dot_segment("/records/.%2e/admin"));
    assert!(has_dot_segment("/records/%2e./admin"));
    // Separator that only appears after decoding: the pre-decode split never saw
    // a boundary here, so only re-splitting on the next round catches it.
    assert!(has_dot_segment("/webhook/..%2fadmin"));
    assert!(has_dot_segment("/webhook/%2e%2e%2fadmin"));
    // Double-encoded, i.e. what `urlencoding::encode("%2e%2e")` actually produces.
    assert!(has_dot_segment("/records/%252e%252e/admin"));

    // Encoded content that is NOT a dot segment still passes — the guard must not
    // become "reject anything with a percent sign", or ordinary ids with spaces in them stop working. Encoded separators
    // remain ambiguous across the proxy and sidecar and are refused.
    assert!(!has_dot_segment("/records/my%20record/fields"));
    assert!(!has_dot_segment("/records/a%2Eb/fields"));
    assert!(!has_dot_segment("/search/%7Bquery%7D"));
}

/// Every plugin's public routes refuse a raw URI whose decoding would introduce a
/// dot segment or a new separator, not just one app's. Protected routes are left
/// to the decoded-path check in [`resolve_route`].
#[test]
fn public_routes_refuse_encoded_separators_in_the_raw_uri_for_every_plugin() {
    for raw in [
        "/bots/support%2F..%2Fadmin",
        "/f/contact/%2e%2e/admin",
        "/api/ext/@ryu/bot-flows/support%2Fsessions",
        "/api/ext/@ryu/anything/hook/..%5Cadmin",
        "/bots/support/../admin",
    ] {
        assert!(
            public_route_raw_path_is_unsafe(RouteAuth::Public, raw),
            "public route must refuse {raw}"
        );
        assert!(
            !public_route_raw_path_is_unsafe(RouteAuth::Protected, raw),
            "protected routes keep only the decoded-path check: {raw}"
        );
    }
    for raw in [
        "/bots/support",
        "/bots/support/embed.js",
        "/api/ext/@ryu/bot-flows/support/sessions/abc123/reply",
        "/f/my%20form",
    ] {
        assert!(
            !public_route_raw_path_is_unsafe(RouteAuth::Public, raw),
            "clean public path must pass: {raw}"
        );
    }
}

/// `GET /api/ext/<app>/<victim>%3F` reaches the proxy as the sub-path `/<victim>?`.
/// The gates must never match it (they would check the resource `<victim>?`) while
/// the forward ends the path at the `?` and the sidecar serves `/<victim>`.
#[test]
fn query_and_fragment_delimiters_in_a_sub_path_resolve_no_route() {
    let mut manifest = provider_manifest(9099, None);
    manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the provider fixture declares http")
        .routes = vec![route("/:id", Some("jobs.view"), Some("id"))];

    let (_, _, matched) = resolve_route(&manifest, "/job-1", "GET").expect("plain id");
    assert_eq!(
        required_permission_for(matched, "/job-1", &manifest.id),
        Some(("jobs.view".to_owned(), "job-1".to_owned()))
    );
    for sub_path in [
        "/job-1?",
        "/job-1?x=1",
        "/job-1#",
        "/job-1#frag",
        "/job-1%3F",
        "/job-1%3f",
        "/job-1%23",
        "/job-1%253F",
    ] {
        assert!(
            resolve_route(&manifest, sub_path, "GET").is_none(),
            "{sub_path} must not resolve"
        );
    }
    assert!(has_query_or_fragment_delimiter("/a/b?c"));
    assert!(!has_query_or_fragment_delimiter("/records/my%20record"));
    assert!(!has_query_or_fragment_delimiter(""));
}

/// A manifest with a Public `/*rest`, a Public `/webhook/*rest` and a Protected
/// `/admin`: the shape where a rewritten forward path crosses the auth boundary.
fn public_wildcards_beside_a_protected_route() -> crate::plugin_manifest::PluginManifest {
    let mut manifest = provider_manifest(9099, None);
    let mut catch_all = route("/*rest", None, None);
    catch_all.auth = RouteAuth::Public;
    let mut webhook = route("/webhook/*rest", None, None);
    webhook.auth = RouteAuth::Public;
    manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the provider fixture declares http")
        .routes = vec![catch_all, webhook, route("/admin", None, None)];
    manifest
}

/// `GET /api/ext/<app>/webhook/.%09./admin` reaches the proxy as the sub-path
/// `/webhook/.<TAB>./admin`. No segment is literally `..`, so the Public
/// `/webhook/*rest` route matches it, yet the URL parser behind the forward deletes
/// the tab, sees `..`, and the sidecar serves the Protected `/admin` with Core's hop
/// bearer. Deletion alone forwards `/ad<TAB>min` (matched by the Public `/*rest`)
/// as `/admin`.
#[test]
fn tabs_and_newlines_the_forward_url_parser_deletes_resolve_no_route() {
    let manifest = public_wildcards_beside_a_protected_route();

    // The disagreement being guarded: the path the forward actually requests.
    for (forwarded, requested) in [
        ("http://127.0.0.1:9099/webhook/.\t./admin", "/admin"),
        ("http://127.0.0.1:9099/webhook/.\n./admin", "/admin"),
        ("http://127.0.0.1:9099/webhook/.\r./admin", "/admin"),
        ("http://127.0.0.1:9099/ad\tmin", "/admin"),
        // Other characters inside the path are percent-encoded, not dropped, so
        // the sidecar receives what the gates matched.
        ("http://127.0.0.1:9099/webhook/a\u{0}b", "/webhook/a%00b"),
        (
            "http://127.0.0.1:9099/webhook/my record",
            "/webhook/my%20record",
        ),
    ] {
        let url = url::Url::parse(forwarded).expect("the forward URL parses");
        assert_eq!(url.path(), requested, "{forwarded:?}");
    }

    for sub_path in [
        "/webhook/.\t./admin",
        "/webhook/.\n./admin",
        "/webhook/.\r./admin",
        "/ad\tmin",
        // One layer deeper: the sidecar's own framework may decode once more.
        "/webhook/.%09./admin",
        "/webhook/.%0A./admin",
        "/webhook/.%2509./admin",
    ] {
        assert!(
            has_url_parser_deleted_character(sub_path),
            "{sub_path:?} holds a deleted character"
        );
        assert!(
            resolve_route(&manifest, sub_path, "GET").is_none(),
            "{sub_path:?} must not resolve"
        );
    }

    // Ordinary paths, and characters the forward carries faithfully, still resolve.
    let (_, _, matched) = resolve_route(&manifest, "/admin", "GET").expect("/admin");
    assert_eq!(matched.path, "/admin");
    for sub_path in [
        "/webhook/abc",
        "/webhook/my record",
        "/webhook/my%20record",
        "/webhook/name ",
        "/webhook/a\u{0}b",
        "/webhook/a.b",
    ] {
        assert!(!has_url_parser_deleted_character(sub_path), "{sub_path:?}");
        let (_, _, matched) = resolve_route(&manifest, sub_path, "GET")
            .unwrap_or_else(|| panic!("{sub_path:?} must resolve"));
        assert_eq!(matched.path, "/webhook/*rest");
    }
}

/// The forward's URL parser trims spaces and C0 controls off the end of the WHOLE
/// URL, so they come off the path when no query follows it, and only then. Each
/// refused case is one the forward would already send to a different path.
#[test]
fn a_trailing_space_or_control_is_refused_only_where_the_forward_trims_it() {
    // Trimmed: the sidecar would be asked for a different path from the gated one.
    for (sub_path, forwarded, requested) in [
        ("/webhook/.. ", "http://127.0.0.1:9099/webhook/.. ", "/"),
        (
            "/webhook/..\u{0}",
            "http://127.0.0.1:9099/webhook/..\u{0}",
            "/",
        ),
        ("/admin ", "http://127.0.0.1:9099/admin ", "/admin"),
        (
            "/webhook/x ",
            "http://127.0.0.1:9099/webhook/x ",
            "/webhook/x",
        ),
        (
            "/webhook/x \u{1f}",
            "http://127.0.0.1:9099/webhook/x \u{1f}",
            "/webhook/x",
        ),
    ] {
        let url = url::Url::parse(forwarded).expect("the forward URL parses");
        assert_eq!(url.path(), requested, "{forwarded:?}");
        assert!(
            forward_url_trims_path_end(sub_path, None),
            "{sub_path:?} without a query must be refused"
        );
    }

    // Not trimmed: a query follows the path (even an empty one), or the space is
    // still encoded. The sidecar receives the path the gates matched.
    for (sub_path, query, forwarded, requested) in [
        (
            "/webhook/x ",
            Some("x=1"),
            "http://127.0.0.1:9099/webhook/x ?x=1",
            "/webhook/x%20",
        ),
        (
            "/webhook/x ",
            Some(""),
            "http://127.0.0.1:9099/webhook/x ?",
            "/webhook/x%20",
        ),
        (
            "/webhook/..\u{0}",
            Some("x=1"),
            "http://127.0.0.1:9099/webhook/..\u{0}?x=1",
            "/webhook/..%00",
        ),
        (
            "/webhook/x%20",
            None,
            "http://127.0.0.1:9099/webhook/x%20",
            "/webhook/x%20",
        ),
    ] {
        let url = url::Url::parse(forwarded).expect("the forward URL parses");
        assert_eq!(url.path(), requested, "{forwarded:?}");
        assert!(!forward_url_trims_path_end(sub_path, query), "{sub_path:?}");
    }
    assert!(!forward_url_trims_path_end("/", None));
    assert!(!forward_url_trims_path_end("/webhook/my record", None));
}

/// The WebSocket bridge parses its upstream URL as an `http::Uri`, which refuses a
/// literal space or control character, so that lane can never forward a path the
/// HTTP lane's parser would trim or delete characters from.
#[test]
fn the_ws_bridge_never_forwards_a_space_or_control_character() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    for url in [
        "ws://127.0.0.1:9099/admin ",
        "ws://127.0.0.1:9099/webhook/..\u{0}",
        "ws://127.0.0.1:9099/webhook/.\t./admin",
    ] {
        assert!(url.into_client_request().is_err(), "{url:?}");
    }
    assert!("ws://127.0.0.1:9099/webhook/x%20"
        .into_client_request()
        .is_ok());
}

/// End to end through the real `/api/ext` router, so axum's decoding of the request
/// path is part of the test: every path the forward would rewrite is refused (404)
/// before any auth decision or sidecar gate, while the forms the forward carries
/// faithfully still reach the registration gate (503: no sidecar is registered in
/// this isolated state).
#[tokio::test]
async fn the_ext_lane_refuses_paths_the_forward_would_rewrite() {
    use tower::ServiceExt as _;

    const APP: &str = "@acme/rewrite";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state.app_store.set_enabled(APP, &[]).await.unwrap();
    let mut manifest = web_app(APP, None, false, &[]);
    let mut webhook = route("/webhook/*rest", None, None);
    webhook.auth = RouteAuth::Public;
    manifest.sidecars[0]
        .http
        .as_mut()
        .expect("the web app fixture declares http")
        .routes = vec![webhook, route("/admin", None, None)];
    state.app_manifests.write().await.push(manifest);
    let router = ext_routes(None).with_state(state);

    for (path, expected) in [
        ("/webhook/.%09./admin", StatusCode::NOT_FOUND),
        ("/webhook/.%0A./admin", StatusCode::NOT_FOUND),
        ("/webhook/.%0D./admin", StatusCode::NOT_FOUND),
        ("/webhook/.%2509./admin", StatusCode::NOT_FOUND),
        ("/webhook/..%20", StatusCode::NOT_FOUND),
        ("/webhook/..%00", StatusCode::NOT_FOUND),
        ("/webhook/x%20", StatusCode::NOT_FOUND),
        ("/webhook/x%20?x=1", StatusCode::SERVICE_UNAVAILABLE),
        ("/webhook/x%20?", StatusCode::SERVICE_UNAVAILABLE),
        ("/webhook/name%2520", StatusCode::SERVICE_UNAVAILABLE),
        ("/webhook/my%20record", StatusCode::SERVICE_UNAVAILABLE),
        ("/webhook/abc", StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let request = Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}{path}"))
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected, "{path}");
    }
}
