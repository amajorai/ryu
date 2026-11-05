use super::*;

// ── Broker route resolution ─────────────────────────────────────────────────

#[test]
fn resolve_provider_route_maps_a_root_route_to_the_bare_mount() {
    // Sidecars nest their routers at the bare mount and axum does no
    // trailing-slash redirect, so a `"/"` capability route must not become
    // `{mount}/` (which 404s upstream) — same rule as the inbound proxy.
    let m = provider_manifest(9099, Some("/api/rag"));
    let mut entry = m.provided_capabilities()[0].clone();
    entry.route = Some("/".to_owned());
    let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
    assert_eq!(route.upstream_path, "/api/rag");
}

#[test]
fn resolve_provider_route_pins_sidecar_mount_and_path() {
    let m = provider_manifest(9099, Some("/api/rag/"));
    let entry = m.provided_capabilities()[0].clone();
    let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
    assert_eq!(route.provider_id, "@ryu/rag");
    // The route carries the manager KEY, never a manifest-derived port: the port is
    // resolved through `forward_target` at the hop, so a provider whose declared port
    // is squatted by another process is refused rather than dialed.
    assert_eq!(route.sidecar_name, "@ryu/rag/rag");
    // Mount trailing slash trimmed, route appended.
    assert_eq!(route.upstream_path, "/api/rag/query");
    // The fixture provider is eager (lazy=false, no idle_stop_secs) ⇒ no wake.
    assert_eq!(route.wake_name, None);
}

/// The refusal body must be diagnosable on its own: the sidecar key, the port, and
/// a reason that distinguishes "another process holds the port" from "our process
/// is down". And it must be 503, never 502 — 502 in this file is reserved for "we
/// dialed a sidecar we own and the hop failed", which is a different instruction to
/// whoever is reading the log.
#[tokio::test]
async fn refusal_is_a_503_naming_the_sidecar_port_and_reason() {
    let not_registered = ForwardDenied::NotRegistered {
        name: "@ryu/monitors/ryu-monitors".to_owned(),
        declared_port: Some(8003),
    };
    let resp = sidecar_unavailable(&not_registered);
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "sidecar unavailable");
    assert_eq!(v["sidecar"], "@ryu/monitors/ryu-monitors");
    assert_eq!(v["port"], 8003);
    assert!(
        v["reason"]
            .as_str()
            .unwrap()
            .contains("held by another process"),
        "the not-registered reason must name the actual cause: {v}"
    );

    // The other arm is a DIFFERENT reason — a status panel (and a human) must be
    // able to tell "someone else owns this port" from "our own process crashed".
    let dead = ForwardDenied::NotRunning {
        name: "@ryu/monitors/ryu-monitors".to_owned(),
        port: 8003,
    };
    let resp = sidecar_unavailable(&dead);
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["reason"].as_str().unwrap().contains("not running"));
}

#[test]
fn resolve_provider_route_names_wake_target_for_lazy_provider() {
    let mut m = provider_manifest(9099, Some("/api/rag"));
    m.sidecars[0].lazy = true;
    let entry = m.provided_capabilities()[0].clone();
    let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
    // A lazy provider sidecar is named for the broker to wake before forwarding.
    assert_eq!(route.wake_name.as_deref(), Some("@ryu/rag/rag"));
}

#[test]
fn public_mount_routes_rejects_duplicate_prefixes() {
    // Two built-ins claiming the SAME public_mount must fail closed rather than
    // silently routing the later owner's URL through the first owner's policy.
    let mut a = provider_manifest(9001, Some("/api/mail"));
    a.id = "@ryu/mail".to_owned();
    if let Some(http) = a.sidecars[0].http.as_mut() {
        http.public_mount = Some("/api/mail".to_owned());
    }
    let mut b = provider_manifest(9002, Some("/api/mail"));
    b.id = "com.other.dup".to_owned();
    if let Some(http) = b.sidecars[0].http.as_mut() {
        http.public_mount = Some("/api/mail".to_owned());
    }
    assert!(public_mount_routes(&[a, b], Some("tok".to_owned())).is_err());
}

#[test]
fn public_mount_routes_registers_bare_root_route() {
    use crate::plugin_manifest::schema::RouteSpec;
    // A sidecar declaring public_mount "/api/x" and a root route "/" must be
    // reachable at the bare mount (GET /api/x), not only at sub-paths. The bare
    // exact route is registered alongside the `/*rest` wildcard; building the
    // router exercises the `mount` (no-wildcard) path in `public_mount_routes`
    // — a duplicate exact route (or a trailing-slash form) would panic here.
    let mut a = provider_manifest(9001, Some("/api/x"));
    a.id = "@ryu/teams".to_owned();
    if let Some(http) = a.sidecars[0].http.as_mut() {
        http.public_mount = Some("/api/x".to_owned());
        // The list endpoint the sidecar serves at the mount ROOT.
        http.routes = vec![RouteSpec {
            path: "/".to_owned(),
            method: None,
            auth: Default::default(),
            permission: None,
            resource_param: None,
        }];
    }
    // A second built-in with a different mount proves both mount roots can be
    // registered in one router without a duplicate-route panic.
    let mut b = provider_manifest(9002, Some("/api/x"));
    b.id = "com.other.dup".to_owned();
    if let Some(http) = b.sidecars[0].http.as_mut() {
        http.public_mount = Some("/api/y".to_owned());
    }
    let _router: Router<ServerState> =
        public_mount_routes(&[a, b], Some("tok".to_owned())).expect("unique mounts");
}

#[test]
fn public_mount_routes_include_installed_and_compiled_apps() {
    let installed = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .filter(|manifest| manifest.id == "@ryu/mail")
        .collect::<Vec<_>>();
    let manifests = crate::plugin_manifest::PluginManifestLoader::for_router(&installed);

    assert!(
        manifests.iter().any(|manifest| manifest.id == "@ryu/mail"),
        "installed Mail manifest must be available when the router is built"
    );
    for id in ["@ryu/meetings", "@ryu/teams", "@ryu/dashboards"] {
        assert!(
            manifests.iter().any(|manifest| manifest.id == id),
            "compiled manifest {id} must be available when the router is built"
        );
    }
    assert!(
        manifests.iter().any(|manifest| manifest.id == "@ryu/rooms"),
        "compiled Rooms manifest must register its opt-in public guest mount"
    );

    // Build the actual public-mount router: these manifests must reach route
    // construction even when production BUILTIN_MANIFESTS is system-only.
    let _router: Router<ServerState> =
        public_mount_routes(&manifests, Some("tok".to_owned())).expect("unique mounts");
}

#[test]
fn public_mount_routes_include_compiled_opt_in_sidecars() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::for_router(&[]);

    for id in [
        "@ryu/finetune",
        "@ryu/healing",
        "@ryu/research",
        "@ryu/clips",
        "@ryu/recipes",
    ] {
        assert!(
            manifests.iter().any(|manifest| manifest.id == id),
            "compiled opt-in sidecar {id} must be available when the router is built"
        );
    }

    let _router: Router<ServerState> =
        public_mount_routes(&manifests, Some("tok".to_owned())).expect("unique mounts");
}

/// The declared "/" route must forward to the BARE mount, never `{mount}/` —
/// sidecars nest at the bare mount and axum does no trailing-slash redirect.
#[test]
fn upstream_path_root_forwards_bare_mount() {
    assert_eq!(upstream_path_for("/api/monitors", "/"), "/api/monitors");
    assert_eq!(
        upstream_path_for("/api/monitors", "/alerts"),
        "/api/monitors/alerts"
    );
    // No mount declared: the root forwards to the sidecar's own root.
    assert_eq!(upstream_path_for("", "/"), "");
    assert_eq!(upstream_path_for("", "/health"), "/health");
}

/// Regression for the trailing-slash root 404: a real sidecar-shaped stub (router
/// nested at the bare mount, list endpoint at its root) must be reachable through
/// the forwarder via [`upstream_path_for`]'s root form. The `{mount}/` form the
/// proxy used to build 404s against the very same stub — asserted here so the
/// bare-mount requirement stays pinned to observed sidecar behavior.
#[tokio::test]
async fn root_forward_reaches_bare_mount_nested_sidecar() {
    use axum::routing::get;
    use axum::Router;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let inner = Router::new().route("/", get(|| async { "ROOT-MARKER" }));
    let app = Router::new().nest("/api/x", inner);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // The old proxy form (`{mount}/`) 404s against a bare-mount-nested sidecar.
    let trailing = reqwest::get(format!("http://127.0.0.1:{port}/api/x/"))
        .await
        .unwrap();
    assert_eq!(trailing.status(), reqwest::StatusCode::NOT_FOUND);

    let src_headers = HeaderMap::new();
    let resp = forward_to_sidecar(ForwardArgs {
        target: ForwardTarget::for_test(port),
        upstream_path: &upstream_path_for("/api/x", "/"),
        query: "",
        method: reqwest::Method::GET,
        src_headers: &src_headers,
        body: Vec::new(),
        hop_plugin_id: "com.test.root",
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_restricted: false,
        event_delivery: None,
    })
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    assert_eq!(&body[..], b"ROOT-MARKER");
}

/// Regression for the bare-root 404 in the generic `/api/ext/:plugin_id` lane:
/// axum's `*rest` catch-all cannot match an empty tail, so the wildcard-only shape
/// 404s the bare `/api/ext/:id` (a third-party app whose list/create lives at "/").
/// Adding the exact route alongside the catch-all makes both the root and sub-paths
/// resolve — pinned here at the routing layer (the same two-route shape `ext_routes`
/// registers), which is where the bug lived.
///
/// Uses a FLAT id deliberately: this pins raw axum matching, and a scoped id
/// (`@ryu/teams`) spans two segments, so it would exercise the wildcard route
/// rather than the bare-root one this regression is about. The scoped root is
/// covered by `scoped_plugin_ids_are_reunited_from_two_path_segments`, which
/// asserts the empty-tail rejoin.
#[tokio::test]
async fn ext_lane_bare_root_routes_with_exact_route() {
    use axum::routing::any;
    use axum::Router;

    // Wildcard-ONLY (the pre-fix shape): the bare `/api/ext/:id` 404s.
    let only_wild: Router<()> =
        Router::new().route("/api/ext/:plugin_id/*rest", any(|| async { "SUB" }));
    let l1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p1 = l1.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l1, only_wild).await.unwrap() });
    let bare = reqwest::get(format!("http://127.0.0.1:{p1}/api/ext/com.acme.app"))
        .await
        .unwrap();
    assert_eq!(bare.status(), reqwest::StatusCode::NOT_FOUND);

    // Exact + wildcard (the fixed shape `ext_routes` builds): root AND sub resolve.
    let fixed: Router<()> = Router::new()
        .route("/api/ext/:plugin_id", any(|| async { "ROOT" }))
        .route("/api/ext/:plugin_id/*rest", any(|| async { "SUB" }));
    let l2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p2 = l2.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l2, fixed).await.unwrap() });
    let root = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.acme.app"))
        .await
        .unwrap();
    assert_eq!(root.status(), reqwest::StatusCode::OK);
    assert_eq!(root.text().await.unwrap(), "ROOT");
    let sub = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.acme.app/42"))
        .await
        .unwrap();
    assert_eq!(sub.status(), reqwest::StatusCode::OK);
    assert_eq!(sub.text().await.unwrap(), "SUB");
}

#[test]
fn mail_builtin_declares_public_mount_and_local_process() {
    use crate::plugin_manifest::schema::SidecarProcess;
    let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let mail = builtins
        .iter()
        .find(|m| m.id == "@ryu/mail")
        .expect("@ryu/mail is a registered built-in");
    let sc = &mail.sidecars[0];
    // Spawned as a local sibling binary (ryu-mail), not a download; the child is
    // told its (profile-shifted) bind port via `port_env` so Core's proxy +
    // health target the same port across concurrent profiles.
    match &sc.process {
        SidecarProcess::Local(local) => {
            assert_eq!(local.command, "ryu-mail");
            assert_eq!(local.port_env.as_deref(), Some("RYU_MAIL_PORT"));
        }
        other => panic!("mail process must be Local, got {other:?}"),
    }
    assert_eq!(sc.port, 7996);
    // Health probes the public process liveness route; the bearer-gated
    // `/api/mail/status` remains the service-level status endpoint.
    assert_eq!(sc.health_path, "/health");
    let http = sc.http.as_ref().expect("mail declares http");
    assert_eq!(http.public_mount.as_deref(), Some("/api/mail"));
    assert_eq!(http.mount.as_deref(), Some("/api/mail"));
    // The inbound webhook is public (per-inbox HMAC); everything else Protected.
    let inbound = http
        .routes
        .iter()
        .find(|r| r.path == "/inbound/:id")
        .expect("declares inbound route");
    assert_eq!(inbound.auth, RouteAuth::Public);
    assert!(http
        .routes
        .iter()
        .any(|r| r.path == "/status" && r.auth == RouteAuth::Protected));
}
