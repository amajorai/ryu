use super::*;

/// …and the plugin-scoped clear must reach BOTH of them. `deactivate_plugin` and
/// `update_app_handler` know only the plugin id, so a sidecar-keyed store with a
/// `map.remove(plugin_id)` clear would leave the second sidecar's rows searchable
/// and callable for an app the user just disabled — tools that the ext-proxy then
/// refuses at the hop, i.e. tools that can only fail.
///
/// The look-alike plugin is the other half of the keying invariant: ownership
/// requires a `/` boundary, so disabling `@ryu/twin` must not strip `@ryu/twin-x`.
#[tokio::test]
async fn deactivate_clears_every_sidecar_for_the_plugin() {
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let alpha = namespaced_name("@ryu/twin", "alpha");
    let beta = namespaced_name("@ryu/twin", "beta");
    let neighbour = namespaced_name("@ryu/twin-x", "alpha");

    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &alpha,
        vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
    );
    // A zero-route entry is still an entry — it is what makes the latch terminate,
    // so a clear that only removed non-empty ones would re-arm nothing.
    registry.set_ext_api_routes_for_sidecar("@ryu/twin", &beta, vec![]);
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin-x",
        &neighbour,
        vec![derived_row("ryu_ext.ryu_twin_x.get_alpha", "@ryu/twin-x")],
    );

    registry.clear_ext_api_routes("@ryu/twin");

    assert!(
        !registry.has_ext_api_routes_for_sidecar(&alpha),
        "the clear must reach the first sidecar"
    );
    assert!(
        !registry.has_ext_api_routes_for_sidecar(&beta),
        "…and the second, including one that lowered to zero rows"
    );
    assert!(
        !registry.has_ext_api_routes("@ryu/twin"),
        "the plugin-scoped read model must agree, so a re-enable re-lowers"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&neighbour),
        "a plugin whose id merely PREFIXES the cleared one must be untouched"
    );
    assert!(
        registry
            .describe("ryu_ext.ryu_twin_x.get_alpha")
            .await
            .is_some(),
        "…and its rows must still dispatch"
    );
}

/// **FIX 4.** An in-place app update rewrites the manifest without re-running
/// `apply_sidecars`: it reloads `state.app_manifests` and clears the derived rows,
/// leaving the next Healthy edge to re-lower. If the lowering inputs were the
/// arm-time snapshot, that re-lowering would intersect the NEW spec against the OLD
/// declared routes and strip the OLD mount — deriving tools for paths the update
/// withdrew (which then 404 at the proxy) while silently dropping the ones it added.
///
/// So the inputs are a live read, with the snapshot as the fallback. All three
/// branches are pinned here, because each fails differently: no store at all (test
/// and CLI contexts), a store that does not know this sidecar (uninstalled or
/// renamed mid-fetch), and the hit that is the whole point.
#[tokio::test]
async fn lowering_inputs_are_read_live_from_the_updated_manifest() {
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

    // No store wired ⇒ the arm-time snapshot, unchanged.
    let bare = probe_import_named(&registry, "@ryu/updated", "worker");
    assert_eq!(
        bare.lowering_inputs().await,
        ("/api".to_owned(), Vec::new()),
        "with no manifest store the snapshot must still be used"
    );

    // The manifest as it looks AFTER an update: a different mount, different routes.
    let mut spec = binary_spec();
    spec.name = "worker".to_owned();
    spec.http = Some(
        serde_json::from_value(serde_json::json!({
            "mount": "/api/new/",
            "routes": [{ "path": "/added" }],
        }))
        .expect("the http fixture must match HttpProxySpec"),
    );
    let manifest = crate::plugin_manifest::PluginManifest {
        id: "@ryu/updated".to_owned(),
        name: "Updated".to_owned(),
        version: "2.0.0".to_owned(),
        sidecars: vec![spec],
        ..Default::default()
    };
    let store = Arc::new(tokio::sync::RwLock::new(vec![manifest]));

    let live = OpenApiImport {
        manifests: Some(Arc::clone(&store)),
        ..probe_import_named(&registry, "@ryu/updated", "worker")
    };
    let (mount, routes) = live.lowering_inputs().await;
    assert_eq!(mount, "/api/new");
    assert_eq!(
        routes
            .iter()
            .map(|route| route.path.as_str())
            .collect::<Vec<_>>(),
        ["/added"]
    );

    // A sidecar the live manifest does not describe (renamed, or the app was
    // uninstalled mid-fetch) falls back rather than lowering against nothing.
    let renamed = OpenApiImport {
        manifests: Some(store),
        ..probe_import_named(&registry, "@ryu/updated", "gone")
    };
    assert_eq!(
        renamed.lowering_inputs().await,
        ("/api".to_owned(), Vec::new()),
        "a miss must fall back to the snapshot, not to an empty declaration set"
    );
}
