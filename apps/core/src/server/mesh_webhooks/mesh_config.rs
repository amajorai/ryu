//! Mesh status, the webhook ingress seam and sandbox enable/disable: `mesh_config` through `mesh_config`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/mesh/config",
    tag = "Nodes",
    summary = "Enable or disable the network plane",
    request_body = MeshConfigBody,
    responses((status = 200, description = "Mesh status after applying the change", body = serde_json::Value))
)]
pub(in crate::server) async fn mesh_config(
    State(state): State<ServerState>,
    Json(body): Json<MeshConfigBody>,
) -> axum::response::Response {
    let was_enabled = ryu_mesh::is_enabled();
    let current_backend = crate::sidecar::tailscale::mesh_backend().await.0;
    let requested_backend = match body.backend.as_deref() {
        Some(raw) => {
            let Some(backend) = crate::sidecar::tailscale::parse_backend_choice(raw) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "backend must be one of: headscale, tailscale, tailcat, cloudflared, \
                     opentunnel, plugin"
                        .to_owned(),
                );
            };
            backend
        }
        None => current_backend,
    };

    // Refuse an OpenTunnel choice this platform can never run BEFORE stopping
    // the current backend or persisting the preference, so a working tunnel is
    // not swapped for one that cannot start.
    if body.backend.is_some()
        && requested_backend == crate::sidecar::tailscale::MeshBackend::OpenTunnel
        && !crate::sidecar::opentunnel::platform_supported()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "OpenTunnel runs on macOS and Linux only; pick another tunnel on Windows".to_owned(),
        );
    }

    // An operator environment override is authoritative. Do not report a
    // successful UI switch that the next status read will silently override.
    if let Some(raw) = std::env::var("RYU_MESH_BACKEND")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        let env_backend = crate::sidecar::tailscale::parse_backend(Some(&raw));
        if body.backend.is_some() && requested_backend != env_backend {
            return json_error(
                StatusCode::CONFLICT,
                format!(
                    "RYU_MESH_BACKEND pins this node to {}; remove or change that environment override before selecting another backend",
                    env_backend.as_str()
                ),
            );
        }
    }

    if body.enabled {
        let resolved = crate::node_token::resolve_and_export();
        let token = resolved.as_ref().map(|value| value.token.clone());
        let source = resolved.as_ref().map(|value| value.source);
        if let Err(error) = enforce_remote_auth(token, source, true, false) {
            return json_error(StatusCode::FORBIDDEN, error);
        }
    }

    // A backend swap while enabled must stop the old process before the new
    // adapter starts. This is kept server-side so clients cannot leave both
    // network listeners active by racing preference writes.
    if was_enabled && current_backend != requested_backend {
        if let Err(error) = state
            .manager
            .stop_sidecar(current_backend.sidecar_name())
            .await
        {
            tracing::warn!(
                backend = current_backend.as_str(),
                "network: failed to stop previous backend during switch: {error}"
            );
        }
        state
            .manager
            .unmark_installed(current_backend.sidecar_name())
            .await;
    }

    if body.backend.is_some() {
        if let Err(error) = state
            .preferences
            .set(
                crate::mesh_host::MESH_BACKEND_PREF_KEY,
                requested_backend.as_str(),
            )
            .await
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("failed to persist mesh-backend pref: {error}") })),
            )
                .into_response();
        }
    }

    let value = if body.enabled { "true" } else { "false" };
    if let Err(e) = state
        .preferences
        .set(crate::mesh_host::MESH_ENABLED_PREF_KEY, value)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to persist mesh-enabled pref: {e}") })),
        )
            .into_response();
    }
    ryu_mesh::set_pref_enabled(body.enabled);

    let mut start_error: Option<String> = None;
    let mut installing = false;
    let mut missing = crate::sidecar::tailscale::MissingMesh {
        missing: Vec::new(),
        can_install: false,
    };
    if body.enabled {
        match requested_backend {
            crate::sidecar::tailscale::MeshBackend::Tailcat => {
                state.manager.unmark_installed("tailscale").await;
                if let Err(error) = crate::sidecar::tailcat::resolve_binary() {
                    tracing::warn!("network: {error}");
                    start_error = Some(error.to_string());
                    missing.missing = vec!["tailcat".to_owned()];
                    missing.can_install = crate::sidecar::tailcat_downloader::can_install();
                    if missing.can_install {
                        spawn_mesh_backend_install(
                            state.downloads.clone(),
                            Arc::clone(&state.manager),
                            Arc::clone(&state.install_status),
                            requested_backend,
                        );
                        installing = true;
                    }
                    state.manager.unmark_installed("tailcat").await;
                } else {
                    state.manager.mark_installed("tailcat").await;
                    if let Err(error) = state.manager.start_sidecar("tailcat").await {
                        tracing::warn!("network: Tailcat failed to start: {error}");
                        start_error = Some(error.to_string());
                    }
                }
            }
            crate::sidecar::tailscale::MeshBackend::Cloudflared => {
                state.manager.unmark_installed("tailscale").await;
                state.manager.unmark_installed("tailcat").await;
                if let Err(error) = crate::sidecar::cloudflared::resolve_binary() {
                    tracing::warn!("network: {error}");
                    start_error = Some(error.to_string());
                    missing.missing = vec!["cloudflared".to_owned()];
                    missing.can_install = crate::sidecar::cloudflared_downloader::can_install();
                    if missing.can_install {
                        spawn_mesh_backend_install(
                            state.downloads.clone(),
                            Arc::clone(&state.manager),
                            Arc::clone(&state.install_status),
                            requested_backend,
                        );
                        installing = true;
                    }
                    state.manager.unmark_installed("cloudflared").await;
                } else {
                    state.manager.unmark_installed("tailscale").await;
                    state.manager.unmark_installed("tailcat").await;
                    state.manager.mark_installed("cloudflared").await;
                    if let Err(error) = state.manager.start_sidecar("cloudflared").await {
                        tracing::warn!("network: Cloudflare Quick Tunnel failed to start: {error}");
                        start_error = Some(error.to_string());
                    }
                }
            }
            crate::sidecar::tailscale::MeshBackend::OpenTunnel => {
                for other in ["tailscale", "tailcat", "cloudflared", "tunnel-plugin"] {
                    state.manager.unmark_installed(other).await;
                }
                if let Err(error) = crate::sidecar::opentunnel::resolve_binary() {
                    tracing::warn!("network: {error}");
                    start_error = Some(error.to_string());
                    missing.missing = vec!["opentunnel".to_owned()];
                    missing.can_install = crate::sidecar::opentunnel_downloader::can_install();
                    if missing.can_install {
                        spawn_mesh_backend_install(
                            state.downloads.clone(),
                            Arc::clone(&state.manager),
                            Arc::clone(&state.install_status),
                            requested_backend,
                        );
                        installing = true;
                    }
                    state.manager.unmark_installed("opentunnel").await;
                } else {
                    state.manager.mark_installed("opentunnel").await;
                    if let Err(error) = state.manager.start_sidecar("opentunnel").await {
                        tracing::warn!("network: OpenTunnel failed to start: {error}");
                        start_error = Some(error.to_string());
                    }
                }
            }
            crate::sidecar::tailscale::MeshBackend::Plugin => {
                for other in ["tailscale", "tailcat", "cloudflared", "opentunnel"] {
                    state.manager.unmark_installed(other).await;
                }
                // Re-run the start even when the plugin tunnel is already up: the
                // caller may have re-pointed the `network.tunnel` binding, and the
                // adapter stops the previously started provider before starting
                // the newly bound one.
                let sidecar = crate::sidecar::plugin_tunnel::SIDECAR_NAME;
                if was_enabled && current_backend == requested_backend {
                    let _ = state.manager.stop_sidecar(sidecar).await;
                }
                state.manager.mark_installed(sidecar).await;
                if let Err(error) = state.manager.start_sidecar(sidecar).await {
                    tracing::warn!("network: plugin tunnel failed to start: {error}");
                    start_error = Some(error.to_string());
                }
            }
            crate::sidecar::tailscale::MeshBackend::Headscale
            | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                // The PURE pre-check first, so a missing client is diagnosed
                // structurally rather than scraped back out of the start error's
                // prose.
                if let Err(m) = crate::sidecar::tailscale::ensure_mesh_binaries() {
                    tracing::warn!("mesh: {m}");
                    // Install it FOR them when this node has a route, instead of
                    // handing back a sentence about `brew`. The task starts the
                    // daemon itself once the binaries land.
                    if m.can_install {
                        tracing::info!(
                            "mesh: no Tailscale client on this node — installing one in the background"
                        );
                        spawn_mesh_backend_install(
                            state.downloads.clone(),
                            Arc::clone(&state.manager),
                            Arc::clone(&state.install_status),
                            requested_backend,
                        );
                        installing = true;
                    }
                    start_error = Some(m.to_string());
                    missing = m;
                    state.manager.unmark_installed("tailscale").await;
                } else {
                    state.manager.unmark_installed("tailcat").await;
                    // Make the daemon eligible to run, then start it.
                    state.manager.mark_installed("tailscale").await;
                    if let Err(error) = state.manager.start_sidecar("tailscale").await {
                        tracing::warn!("mesh: daemon failed to start after enable: {error}");
                        start_error = Some(error.to_string());
                    }
                }
            }
        }
    } else {
        // Best-effort stop — a daemon that never started is not an error for a
        // disable request. Stop BOTH adapters so disabling after a backend
        // preference change cannot leave the old listener alive.
        for backend in [
            crate::sidecar::tailscale::MeshBackend::Headscale,
            crate::sidecar::tailscale::MeshBackend::Tailcat,
            crate::sidecar::tailscale::MeshBackend::Cloudflared,
            crate::sidecar::tailscale::MeshBackend::OpenTunnel,
            crate::sidecar::tailscale::MeshBackend::Plugin,
        ] {
            if let Err(error) = state.manager.stop_sidecar(backend.sidecar_name()).await {
                tracing::warn!(
                    backend = backend.as_str(),
                    "network: stop after disable failed: {error}"
                );
            }
        }
        state.manager.unmark_installed("tailscale").await;
        state.manager.unmark_installed("tailcat").await;
        state.manager.unmark_installed("cloudflared").await;
        state.manager.unmark_installed("opentunnel").await;
        state
            .manager
            .unmark_installed(crate::sidecar::plugin_tunnel::SIDECAR_NAME)
            .await;
    }

    let status = state.mesh.status().await;
    let mut value = serde_json::to_value(status).unwrap_or_default();
    if let Some(err) = start_error {
        // Non-contract fields: `MeshStatus` doesn't carry them, but the desktop
        // reads them to warn without treating the (persisted) enable as a failure —
        // and, when `can_install` is true, to offer the install instead of a
        // dead-end toast. Emitted only alongside `start_error`, which is already the
        // precedent for exactly this shape, so the OpenAPI contract is unchanged.
        value["start_error"] = serde_json::Value::String(err);
        value["missing_binaries"] = serde_json::json!(missing.missing);
        value["can_install"] = serde_json::Value::Bool(missing.can_install);
        // Inside this block on purpose, not by accident: `installing` is only ever
        // true because the client was MISSING, which always sets `start_error`. The
        // desktop branches on the field's presence, so an "improvement" that emits
        // it on a clean enable would move it out of a block the client never reads
        // and silently lose the progress state.
        value["installing"] = serde_json::Value::Bool(installing);
    }
    Json(value).into_response()
}
