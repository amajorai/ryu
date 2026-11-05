use super::*;

/// The caller email is an explicit per-app opt-in. Sites declares it to match
/// named editors and invited viewers; every other compiled app must not, so a
/// new opt-in is a reviewed manifest change rather than a default.
#[test]
fn only_the_sites_manifest_opts_into_the_caller_email() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let opted_in: Vec<&str> = manifests
        .iter()
        .filter(|manifest| {
            manifest
                .sidecars
                .iter()
                .filter_map(|sidecar| sidecar.http.as_ref())
                .any(|http| http.forward_caller_email)
        })
        .map(|manifest| manifest.id.as_str())
        .collect();
    assert_eq!(opted_in, vec!["@ryu/sites"]);
}

/// The Sites database console actions are four-segment routes that the
/// generic `/projects/:id/:action` route cannot reach. Pin that Core's own
/// matcher, fed the shipped Sites manifest, admits them and nothing nearby.
#[test]
fn sites_manifest_declares_its_database_and_visitor_data_routes() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let sites = manifests
        .iter()
        .find(|manifest| manifest.id == "@ryu/sites")
        .expect("the Sites manifest is compiled into the catalog");
    for (path, method) in [
        ("/projects/site-1/database/connect", "POST"),
        ("/projects/site-1/database/query", "POST"),
        ("/projects/site-1/database", "GET"),
        ("/projects/site-1/visitors", "GET"),
        ("/projects/site-1/visitors/dmlzaXRvci1h/data", "DELETE"),
    ] {
        let (_, _, route) = resolve_route(sites, path, method)
            .unwrap_or_else(|| panic!("{method} {path} must resolve"));
        assert_eq!(route.permission.as_deref(), Some("sites.manage"), "{path}");
    }
    for (path, method) in [
        ("/projects/site-1/database/drop", "POST"),
        ("/projects/site-1/database/query", "GET"),
        ("/projects/site-1/visitors/dmlzaXRvci1h/data", "GET"),
        ("/projects/site-1/visitors/dmlzaXRvci1h/files", "DELETE"),
    ] {
        assert!(
            resolve_route(sites, path, method).is_none(),
            "{method} {path} must stay undeclared"
        );
    }
}

#[test]
fn copy_headers_forwards_only_manifest_declared_app_cookies() {
    let mut src = HeaderMap::new();
    src.insert(
        "cookie",
        "better-auth.session=secret; com.acme.app_session=app-secret; unknown=drop"
            .parse()
            .unwrap(),
    );

    let allowed = vec!["com.acme.app_session".to_owned()];
    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &allowed);

    assert_eq!(
        dst.get("cookie").and_then(|value| value.to_str().ok()),
        Some("com.acme.app_session=app-secret")
    );

    // No declaration means no browser cookie crosses the process boundary.
    let mut empty = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut empty, &[]);
    assert!(empty.get("cookie").is_none());
}

#[test]
fn payment_authorization_is_forwarded_only_for_public_routes() {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        "Payment credential-proof".parse().unwrap(),
    );

    assert_eq!(
        forwarded_payment_authorization(&headers, true)
            .and_then(|value| value.to_str().ok().map(str::to_owned))
            .as_deref(),
        Some("Payment credential-proof")
    );
    assert!(forwarded_payment_authorization(&headers, false).is_none());

    headers.insert(
        axum::http::header::AUTHORIZATION,
        "Bearer node-secret".parse().unwrap(),
    );
    assert!(forwarded_payment_authorization(&headers, true).is_none());
}

#[test]
fn resolve_provider_route_501s_for_in_process_capability() {
    use crate::plugin_manifest::ProvidesEntry;
    let m = provider_manifest(9099, None);
    // A provides entry with no sidecar/route is in-process → broker declines.
    let in_proc = ProvidesEntry {
        capability: "rag".to_owned(),
        version: "1.0.0".to_owned(),
        ..Default::default()
    };
    let resp = resolve_provider_route(&m, &in_proc, "@ryu/rag").unwrap_err();
    assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
}

/// Built-in sidecars need distinct nonzero bind ports. Dialing clients use
/// the manager registry, so a missing app is unavailable rather than a boot panic.
#[test]
fn builtin_app_sidecars_declare_distinct_bind_ports() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let resolved = [
        "dashboards",
        "finetune",
        "healing",
        "meetings",
        "monitors",
        "quests",
        "teams",
    ]
    .map(|app| {
        let plugin_id = format!("@ryu/{app}");
        let sidecar_name = format!("ryu-{app}");
        let manifest = manifests
            .iter()
            .find(|manifest| manifest.id == plugin_id)
            .unwrap_or_else(|| panic!("missing built-in manifest {plugin_id}"));
        let spec = manifest
            .sidecars
            .iter()
            .find(|spec| spec.name == sidecar_name)
            .unwrap_or_else(|| panic!("missing sidecar {sidecar_name} in {plugin_id}"));
        (app, crate::profile::port(spec.port))
    });
    for (app, port) in resolved {
        assert_ne!(port, 0, "{app}: manifest must declare a real sidecar port");
    }
    // Two sidecars sharing a port means whichever binds second dies and its
    // driver becomes unavailable — worth catching at fixture-edit
    // time rather than at runtime.
    let mut ports: Vec<u16> = resolved.iter().map(|(_, p)| *p).collect();
    ports.sort_unstable();
    let before = ports.len();
    ports.dedup();
    assert_eq!(
        ports.len(),
        before,
        "two built-in sidecars declare the same port: {resolved:?}"
    );
}
