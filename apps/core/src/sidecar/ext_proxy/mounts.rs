//! The ext and public-mount routers and their entry handlers.

use super::*;

/// The ext-proxy sub-router. Registered on the PUBLIC router; carries its OWN copy of
/// the node-token `Extension<Option<String>>` (the identical value `require_auth`
/// reads on the protected router) so [`ext_proxy`] replicates the exact node-bearer
/// check — including the `None` (no token configured) ⇒ allow branch — without
/// re-deriving the token by hand (which is how such a check silently drifts).
pub fn ext_routes(auth_token: Option<String>) -> Router<ServerState> {
    Router::new()
        // The bare `/api/ext/:plugin_id` exact route is registered ALONGSIDE the
        // `/*rest` catch-all: axum's `*rest` cannot match an empty tail, so without it
        // the plugin ROOT (a third-party app whose list/create lives at "/") 404s. No
        // trailing-slash form (`/api/ext/:plugin_id/`) — axum panics on it; the bare
        // route forwards sub_path "/", which `upstream_path_for` maps to the bare mount.
        .route("/api/ext/:plugin_id", any(ext_root_proxy))
        .route("/api/ext/:plugin_id/*rest", any(ext_proxy))
        // WebSocket twin of the HTTP ext-proxy: `/api/ext/ws/<plugin>/<route>` upgrades
        // the caller and bridges to the sidecar's declared WS endpoint on loopback. The
        // desktop noVNC stream rides this (the interactive remote-desktop panel); any
        // manifest sidecar can declare a WS route the same way it declares HTTP ones.
        .route("/api/ext/ws/:plugin_id", get(ext_ws_root_proxy))
        .route("/api/ext/ws/:plugin_id/*rest", get(ext_ws_proxy))
        .layer(Extension(auth_token))
}

/// Carried in a per-route `Extension` so a **public-mount** route (whose path does
/// NOT contain the plugin id) can tell [`proxy_for_plugin`] which plugin it fronts.
#[derive(Clone)]
pub(super) struct PublicMountPlugin(pub(super) String);

/// Build the **public-mount** sub-router for the built-in manifests in `manifests`.
///
/// A built-in app may own a stable, externally-committed public URL prefix (e.g. mail
/// serves `/api/mail/*`) that cannot live under the generic `/api/ext/<id>/*` catch-all
/// — external callers (a mail forwarder) have the URL baked in. Such a sidecar declares
/// `http.public_mount`; Core registers `<public_mount>/*rest` at router-build time and
/// dispatches it through the SAME [`proxy_for_plugin`] machinery (enabled-gate +
/// per-route auth + declared-route-404 + provider-token hop) as `/api/ext`, keyed by
/// the owning plugin id via [`PublicMountPlugin`].
///
/// Build-time registration is deliberate: axum routers are immutable after serve, so a
/// custom public prefix is expressible for manifests known in the startup snapshot.
/// Runtime-installed apps that arrive after serving still use `/api/ext/<id>/*`.
/// Nothing is hardcoded per-app: this iterates whatever startup manifest declares a
/// `public_mount`.
pub fn public_mount_routes(
    manifests: &[crate::plugin_manifest::PluginManifest],
    auth_token: Option<String>,
) -> Result<Router<ServerState>, String> {
    let mut router = Router::new();
    let mut seen: HashSet<String> = HashSet::new();
    for manifest in manifests {
        for spec in &manifest.sidecars {
            let Some(http) = &spec.http else { continue };
            let Some(mount) = http.public_mount.as_deref() else {
                continue;
            };
            let mount = mount.trim_end_matches('/');
            if mount.is_empty() {
                continue;
            }
            // A mount is a literal prefix, never route syntax: `:param`/`*rest`
            // would shadow Core routes or panic axum at boot.
            if !crate::plugin_manifest::public_mount_policy::is_literal_public_mount(mount) {
                tracing::warn!(plugin = %manifest.id, mount, "skipping non-literal public_mount");
                continue;
            }
            // Guard against two built-ins claiming the same public prefix. Choosing
            // the first owner would silently route one app's auth/ownership policy
            // through another app's public URL.
            if !seen.insert(mount.to_owned()) {
                return Err(format!(
                    "public-mount '{mount}' is claimed by more than one built-in manifest"
                ));
            }
            let plugin = PublicMountPlugin(manifest.id.clone());
            // Register BOTH the wildcard `<mount>/*rest` (sub-paths) AND the bare
            // `<mount>` exact route: axum's `/*rest` requires a non-empty tail, so
            // without the exact route the mount ROOT (a sidecar's declared "/" route,
            // e.g. the teams/recipes list endpoint) 404s. The trailing-slash form
            // `<mount>/` is deliberately NOT registered (axum panics on it). Both
            // routes share the same per-manifest Extension(plugin).
            router = router.merge(
                Router::new()
                    .route(mount, any(public_mount_root_proxy))
                    .route(&format!("{mount}/*rest"), any(public_mount_proxy))
                    .layer(Extension(plugin)),
            );
        }
    }
    Ok(router.layer(Extension(auth_token)))
}

/// Reverse-proxy one `/api/ext/<plugin_id>/<rest>` request to the owning plugin's
/// declared sidecar, verbatim. See the module docs for the auth/route model.
pub(super) async fn ext_proxy(
    State(state): State<ServerState>,
    Path((plugin_id, rest)): Path<(String, String)>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    let (plugin_id, rest) = split_scoped_plugin_path(plugin_id, rest);
    proxy_for_plugin(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        req,
    )
    .await
}

/// Same as [`ext_proxy`] but for the bare `/api/ext/:plugin_id` root: a separate handler
/// is required because that exact route has no `*rest` wildcard, so `Path<(String,String)>`
/// would fail — only `plugin_id` is extracted and the sub-path is fixed to `/` (the
/// plugin's declared root route).
pub(super) async fn ext_root_proxy(
    State(state): State<ServerState>,
    Path(plugin_id): Path<String>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    proxy_for_plugin(&state, &plugin_id, "/", expected_node_token, req).await
}

/// Reunite a **scoped** plugin id that the router split across two path segments.
///
/// A scoped id contains a slash (`@ryu/meetings`), and `/api/ext/:plugin_id/*rest`
/// binds `:plugin_id` to ONE segment — so `/api/ext/@ryu/meetings/health` arrives as
/// `plugin_id = "@ryu"`, `rest = "meetings/health"`. This takes the first segment of
/// `rest` back as the name half.
///
/// Keyed on the leading `@`, which is unambiguous: a legacy flat id can never start
/// with one ([`crate::plugin_manifest::validate_plugin_id`] permits `@` only as the
/// scoped marker), so a legacy id keeps its old single-segment routing untouched.
///
/// This is why the id needs no percent-encoding anywhere: the slash inside a scoped
/// id IS a path separator, so it round-trips through a URL as itself. `%2F` would
/// have been the alternative, and reverse proxies routinely normalize it away.
pub(super) fn split_scoped_plugin_path(plugin_id: String, rest: String) -> (String, String) {
    if !plugin_id.starts_with('@') {
        return (plugin_id, rest);
    }
    match rest.split_once('/') {
        // `@ryu` + `meetings/health` → `@ryu/meetings` + `health`
        Some((name, tail)) => (format!("{plugin_id}/{name}"), tail.to_owned()),
        // `@ryu` + `meetings` → the plugin ROOT of `@ryu/meetings`. `proxy_for_plugin`
        // maps an empty sub-path to the bare mount the same way `ext_root_proxy` does.
        None => (format!("{plugin_id}/{rest}"), String::new()),
    }
}

/// The public-mount handler: same job as [`ext_proxy`], but the plugin id comes from
/// the per-route [`PublicMountPlugin`] extension (the path is `<mount>/*rest`, not
/// `/api/ext/:id/*`), and the sub-path is the wildcard tail.
pub(super) async fn public_mount_proxy(
    State(state): State<ServerState>,
    Extension(PublicMountPlugin(plugin_id)): Extension<PublicMountPlugin>,
    Extension(expected_node_token): Extension<Option<String>>,
    Path(rest): Path<String>,
    req: Request,
) -> Response {
    proxy_for_plugin(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        req,
    )
    .await
}

/// Same as [`public_mount_proxy`] but for the bare `<mount>` root: a separate handler
/// is required because that exact route has no `*rest` wildcard, so a `Path` extractor
/// would fail — the sub-path is fixed to `/` (the sidecar's declared root route).
pub(super) async fn public_mount_root_proxy(
    State(state): State<ServerState>,
    Extension(PublicMountPlugin(plugin_id)): Extension<PublicMountPlugin>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    proxy_for_plugin(&state, &plugin_id, "/", expected_node_token, req).await
}

/// The upstream path a proxied request forwards to. Root special-case: sidecars
/// nest their routers at the bare mount and axum does no trailing-slash redirect,
/// so `{mount}/` would 404 upstream — the declared "/" route resolves as usual but
/// forwards to the bare mount (both the public-mount root and `/api/ext/:id/` with
/// an empty tail produce a "/" sub-path).
pub(super) fn upstream_path_for(mount: &str, sub_path: &str) -> String {
    if sub_path == "/" {
        mount.to_owned()
    } else {
        format!("{mount}{sub_path}")
    }
}

// ── Web-delegated admission ───────────────────────────────────────────────────
