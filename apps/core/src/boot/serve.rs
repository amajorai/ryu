use super::*;

/// Build the router and bind the listener (exits cleanly if Core already runs there).
pub(super) async fn build_router_and_listener(
    server_state: &server::ServerState,
    auth_token: Option<String>,
    bind_addr: &str,
) -> (axum::Router, tokio::net::TcpListener) {
    // Resolve the bind address ONCE (the same chain the listener uses below) and
    // hand it to the fail-closed gate so a `--bind=0.0.0.0` flag cannot bypass the
    // RYU_BIND-only check (#478 V1).
    let router_manifests = crate::plugin_manifest::PluginManifestLoader::for_router(
        &server_state.app_manifests.read().await,
    );
    let cloudflared_ingress_enabled = matches!(
        crate::webhook_ingress::configured_kind(&server_state.preferences).await,
        crate::webhook_ingress::IngressKind::Cloudflared
    );
    let router = server::create_router(
        server_state.clone(),
        auth_token,
        &bind_addr,
        &router_manifests,
        cloudflared_ingress_enabled,
    );

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Another Core instance is already running on this address — treat as success.
            tracing::info!("ryu-core already running on {bind_addr}, exiting");
            crate::telemetry::shutdown();
            std::process::exit(0);
        }
        Err(e) => boot_fail!("failed to bind {bind_addr}: {e}"),
    };

    let local_addr = listener
        .local_addr()
        .unwrap_or_else(|e| boot_fail!("failed to read local address of {bind_addr}: {e}"));
    tracing::info!("HTTP server listening on {local_addr}");
    (router, listener)
}

/// Serve the HTTP API until shutdown, then stop the Gateway, headroom and sidecars.
pub(super) async fn serve_until_shutdown(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    gateway: &Arc<sidecar::gateway::GatewayManager>,
    headroom: &Arc<sidecar::headroom::HeadroomManager>,
    sidecars: &Arc<SidecarManager>,
) {
    // Serve HTTP API. `into_make_service_with_connect_info` threads the peer
    // `SocketAddr` so `/api/realtime/ws` can distinguish a genuine loopback peer
    // (the local single user) from a remote holder of the shared `RYU_TOKEN` when
    // deciding access to unpersisted rooms. Handlers that don't extract
    // `ConnectInfo` are unaffected — it is a superset of the plain make-service.
    // Each connection also records its local address so `/api/health/identity`
    // binds its proof to the address the client dialed (`core_identity.rs`);
    // `expose_connection_addrs` republishes the peer as `ConnectInfo<SocketAddr>`.
    let serve = axum::serve(
        listener,
        router
            .layer(axum::middleware::from_fn(
                server::core_identity::expose_connection_addrs,
            ))
            .into_make_service_with_connect_info::<server::core_identity::ConnectionAddrs>(),
    )
    .with_graceful_shutdown(wait_for_shutdown_signal());
    // Graceful shutdown waits for every open connection, and the event streams
    // (downloads/all-events SSE, the realtime socket) never close on their own.
    // A restart-for-update must not hang on a connected desktop with the
    // listener already closed, so it gets a bounded drain before cleanup runs.
    let result = tokio::select! {
        result = serve => result,
        () = async {
            crate::update::restart_requested().await;
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        } => {
            tracing::warn!("restart-for-update: connections did not drain in time; stopping anyway");
            Ok(())
        }
    };
    if let Err(e) = result {
        boot_fail!("HTTP server error: {e}");
    }
    tracing::info!("shutdown signal received; stopping managed Gateway and sidecars");
    if let Err(e) = gateway.stop().await {
        tracing::warn!(error = %e, "could not stop managed Gateway during shutdown");
    }
    if let Err(e) = headroom.stop().await {
        tracing::warn!(error = %e, "could not stop headroom during shutdown");
    }
    sidecars.stop_all().await;
    // Idempotent: on SIGTERM/Ctrl-C the shutdown future already aborted them;
    // a restart-for-update reaches here only after its drain window.
    crate::sidecar::adapters::acp_instance_tasks::abort_all();
    // Flush consented OTLP spans before exit (bounded; no-op without an exporter).
    let _ = tokio::task::spawn_blocking(crate::telemetry::shutdown).await;
    if crate::update::restart_was_requested() {
        tracing::warn!("exiting for restart onto the updated binary");
        std::process::exit(crate::update::RESTART_EXIT_CODE);
    }
}
