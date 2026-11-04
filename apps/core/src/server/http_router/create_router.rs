//! Data folder ("Storage" setting).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Data folder ("Storage" setting) ──────────────────────────────────────────────

pub fn create_router(
    state: ServerState,
    auth_token: Option<String>,
    bind_addr: &str,
    router_manifests: &[crate::plugin_manifest::PluginManifest],
    cloudflared_ingress_enabled: bool,
) -> Router {
    crate::backups::start_scheduler(state.clone());
    cloud_environments::start_vpn_recovery();
    cloud_tasks::start_recovery();
    session_box::start_idle_sweep();
    // Fail-closed under an external tunnel or remote bind: a node reachable beyond
    // loopback MUST have an auth token, or every protected route is open to the
    // tailnet/LAN. Refuse to build the router (which stops startup) otherwise.
    // The non-loopback decision uses the SAME `bind_addr` `main()` actually
    // listens on (resolved from `--bind=` → `RYU_BIND` → default), so the
    // `--bind=0.0.0.0` flag can no longer bypass the gate (#478 V1).
    let auth_token = match enforce_remote_auth(
        auth_token,
        crate::node_token::resolve_and_export().map(|r| r.source),
        ryu_mesh::is_enabled() || cloudflared_ingress_enabled,
        host_is_non_loopback(bind_addr),
    ) {
        Ok(t) => t,
        Err(msg) => panic!("{msg}"),
    };

    // The presence registry is shared between the tracking middleware (as its
    // state) and `GET /api/connections` (via `ServerState`); clone the handle out
    // before `state` is moved into `.with_state(state)` below.
    let connections = state.connections.clone();

    // CORS: allow the Desktop webview (dev + prod), localhost dev servers, and
    // the hosted browser surfaces. The web app and docs can both be used as a
    // visitor-approved direct bridge to loopback Core: the browser sends the
    // node token to Core, never to the Ryu control plane. This is both
    // cross-origin and a private-network request (public page → loopback), so
    // the exact trusted origins and `allow_private_network` are required.
    // Extra origins (e.g. a staging web host) can be added without a rebuild via
    // RYU_CORS_ORIGINS (comma-separated).
    let mut cors_origins: Vec<HeaderValue> = [
        "http://localhost:5173",   // desktop vite dev
        "http://localhost:5174",   // webapp vite dev
        "http://127.0.0.1:5173",   // desktop vite dev (127 variant)
        "http://127.0.0.1:5174",   // webapp vite dev (127 variant)
        "http://localhost:1420",   // tauri dev
        "tauri://localhost",       // tauri prod (macOS/Linux)
        "https://tauri.localhost", // tauri prod (Windows)
        "http://tauri.localhost",  // tauri prod (Windows alt)
        "https://app.ryuhq.com",   // hosted web app → local Core
        "http://localhost:3001",   // marketing web dev
        "http://127.0.0.1:3001",   // marketing web dev (127 variant)
        "http://localhost:4000",   // Fumadocs dev
        "http://127.0.0.1:4000",   // Fumadocs dev (127 variant)
        "https://ryuhq.com",       // hosted marketing site → local Core
        "https://www.ryuhq.com",   // hosted marketing site (www variant)
        "https://docs.ryuhq.com",  // hosted docs → local Core
    ]
    .into_iter()
    .filter_map(|origin| origin.parse::<HeaderValue>().ok())
    .collect();
    if let Ok(extra) = std::env::var("RYU_CORS_ORIGINS") {
        cors_origins.extend(
            extra
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .filter_map(|origin| origin.parse::<HeaderValue>().ok()),
        );
    }
    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any)
        // The desktop webview reads the resume replay kind cross-origin.
        .expose_headers([axum::http::HeaderName::from_static(
            crate::sidecar::adapters::live_turn::RESUME_REPLAY_HEADER,
        )])
        .allow_private_network(true)
        .allow_origin(cors_origins);

    let public = public_routes(&state);
    // Agent mail (Self-host Agent Inboxes) is now a fully manifest-driven app:
    // `@ryu/mail` declares the `ryu-mail` sidecar + a `/api/mail` `public_mount`,
    // and the generic ext-proxy loader below serves `/api/mail/*` (public inbound +
    // protected CRUD) when the app is enabled. The hand-coded `sidecar::mail` proxy
    // and the in-process `crate::mail` path were both retired here — mail is
    // sidecar-only. See `docs/platform-decomposition-handoff.md` (Track C).

    // ── Generic app ⇄ HTTP loader (the manifest-declared sidecar-as-app) ─────────
    // `/api/ext/<plugin_id>/*` reverse-proxies onto an enabled plugin's declared
    // sidecar, and `/api/host/*` is the sidecar's authenticated callback into Core.
    // BOTH ride the PUBLIC router: a single catch-all cannot be gated two ways by
    // router middleware, and the sidecar callback holds only its minted token, not
    // the node bearer — so the ext sub-router carries its OWN copy of the node-token
    // Extension and `ext_proxy` enforces per-route auth in-handler (see
    // `sidecar::ext_proxy`). Registered unconditionally (no feature/env gate): the
    // proxy is inert unless an enabled plugin declares an `http`/`host_api` sidecar.
    let public = public
        .merge(crate::a2a::public_routes())
        // Machine login and vault-token agent routes: CI runners and services
        // hold no node bearer, so these authenticate in-handler with an
        // AppRole secret id, an OIDC JWT, or an `x-ryu-vault-token`.
        .merge(vault_public_routes())
        .merge(crate::sidecar::ext_proxy::ext_routes(auth_token.clone()))
        .merge(crate::sidecar::ext_proxy::host_routes())
        // Session Box screen relay (Core ticket) and Box inference relay
        // (`gwb1` key): neither caller holds the node bearer.
        .merge(session_box::public_routes())
        // Public-mount routes for apps that own a stable external URL prefix
        // (e.g. mail's `/api/mail/*`). Axum routers are immutable after serve,
        // so use the startup snapshot of installed and bootstrap manifests.
        .merge(
            crate::sidecar::ext_proxy::public_mount_routes(router_manifests, auth_token.clone())
                .expect("built-in public-mount ownership must be unambiguous"),
        );

    let protected = protected_routes_1(&state)
        .merge(protected_routes_2(&state))
        .merge(protected_routes_3(&state))
        .merge(protected_routes_4(&state))
        .merge(protected_routes_5(&state))
        .merge(protected_routes_6(&state));
    // Agent-mail management routes (`/api/mail/*` protected CRUD) are served by the
    // `@ryu/mail` app's `ryu-mail` sidecar via the generic `public_mount` loader
    // (registered on the PUBLIC router, which enforces the same node bearer per-route);
    // the hand-coded proxy + in-process path were retired (Track C, sidecar-only).
    // Compile-out-able leaf features (research/clips/recipes). Each is merged here —
    // after every protected `.route(...)`, before the `.layer(...)` stack — so its
    // gated sub-router still inherits require_auth/attach_verified_caller, exactly
    // like the mail rebind above. Behind a cargo feature (in `default`), so a lean
    // `--no-default-features` kernel drops the module, its routes, and the merge.
    // Router merge is path-based, so moving them out of the mid-chain is identical.
    // Research `/api/research/*` is now served OUT-OF-PROCESS by the `ryu-research`
    // sidecar via the manifest `public_mount` (generic ext-proxy loader) — no
    // in-process route merge. See `@ryu/research` in `plugin_manifest`.
    // Clips `/api/clips/*` is now served OUT-OF-PROCESS by the `ryu-clips` sidecar
    // via the manifest `public_mount` (generic ext-proxy loader) — no in-process
    // route merge. See `@ryu/clips` in `plugin_manifest`.
    // Recipes `/api/recipes/*` is now served OUT-OF-PROCESS by the `ryu-recipes`
    // sidecar via the manifest `public_mount` (generic ext-proxy loader) — no
    // in-process route merge. Its two live-ghost paths (replay + the recording
    // session) proxy back to Core's `/api/host/capability/ghost.*` (the shared MCP registry +
    // the recorder subprocess are kernel; see `recipes_host`).
    // The workflow executor's `Recipe`/`GhostAction` nodes reach the same registry
    // directly via Core's built-in ghost MCP tool — Core links no recipes code.
    // See `@ryu/recipes` in `plugin_manifest`.
    // Healing `/api/healing/*` is now served OUT-OF-PROCESS by the `ryu-healing`
    // sidecar via the manifest `public_mount` — no in-process route merge. See
    // `@ryu/healing` in `plugin_manifest`, `crate::run_failures` and `app_runs`.
    // ── The network MCP surface ──────────────────────────────────────────────
    // Registered on the PROTECTED chain, before the `.layer(...)` stack below, so
    // it inherits `require_auth` (bearer with constant-time compare + the
    // paired-device carve-out) exactly like every `.merge(...)` above. Never on
    // `public`: this dispatches registry tools.
    //
    // It then adds ONE rule of its own that no other route has — it refuses when
    // the node has no token configured, instead of inheriting `require_auth`'s
    // no-token pass-through. See [`mcp_admission`] for why a general tool
    // dispatcher cannot take that carve-out.
    //
    // The bare `/mcp` exists only to turn a base-URL misconfiguration into an
    // actionable 400; matchit will not match it against `/mcp/:agent_id`.
    //
    // The body limit is DECLARED per route (on the `MethodRouter`, never on the
    // `protected` Router — a Router-level layer would re-cap the upload routes that
    // declare their own, larger ceilings). It equals axum's implicit default, so it
    // changes no behaviour today; it exists so this route's ceiling is a stated
    // property that survives a future layer edit rather than an inherited accident.
    //
    // CORS is deliberately NOT narrowed here. The process layer admits a fixed
    // origin list with `allow_private_network(true)` — but it sets no
    // `allow_credentials`, so a browser attaches no ambient credential, and this
    // route additionally requires a node bearer the page would have to already
    // possess. A second `CorsLayer` on the route would emit duplicate
    // `Access-Control-Allow-Origin` headers, which browsers reject outright.
    let protected = protected
        .merge(crate::a2a::management_routes())
        .route(
            "/mcp",
            post(mcp_http_no_agent).layer(axum::extract::DefaultBodyLimit::max(MCP_MAX_BODY_BYTES)),
        )
        .route(
            "/mcp/:agent_id",
            post(mcp_http).layer(axum::extract::DefaultBodyLimit::max(MCP_MAX_BODY_BYTES)),
        );

    let protected = protected
        // Verified user identity (Phase 0): the innermost layer, so it runs AFTER
        // require_auth admits the node and just before the handler. It attaches an
        // `Option<VerifiedCaller>` extension (anonymous when no/invalid user JWT),
        // never rejecting — RYU_TOKEN remains the gate.
        .layer(middleware::from_fn(attach_verified_caller))
        // Presence tracking runs INSIDE require_auth (added before it here, so it
        // is the inner layer): only authenticated requests are recorded.
        .layer(middleware::from_fn_with_state(
            connections,
            track_connection,
        ))
        .layer(middleware::from_fn(require_auth))
        .layer(axum::Extension(auth_token));

    public
        .merge(protected)
        // Inbound W3C `traceparent` → a server span the request's spans nest under.
        .route_layer(middleware::from_fn(trace_context::server_span))
        .layer(cors)
        .with_state(state)
}
