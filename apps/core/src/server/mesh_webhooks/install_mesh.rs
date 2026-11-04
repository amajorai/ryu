//! Mesh status, the webhook ingress seam and sandbox enable/disable: `TAILSCALE_INSTALL_IN_FLIGHT` through `spawn_mesh_backend_install`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Whether a mesh-client install is already in flight, so a user tapping the mesh
/// toggle twice does not queue a second 38 MB transfer (or a second
/// `brew install`). Cleared by the task itself, in both the success and the
/// failure arm — a stuck flag would make the mesh permanently uninstallable.
pub(in crate::server) static TAILSCALE_INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub(in crate::server) static TAILCAT_INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub(in crate::server) static CLOUDFLARED_INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub(in crate::server) static OPENTUNNEL_INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// Never set: a plugin tunnel is installed by the Store, not by Core.
pub(in crate::server) static PLUGIN_TUNNEL_INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(in crate::server) fn mesh_install_key(
    backend: crate::sidecar::tailscale::MeshBackend,
) -> &'static str {
    match backend {
        crate::sidecar::tailscale::MeshBackend::Tailcat => "tailcat",
        crate::sidecar::tailscale::MeshBackend::Cloudflared => "cloudflared",
        crate::sidecar::tailscale::MeshBackend::OpenTunnel => "opentunnel",
        crate::sidecar::tailscale::MeshBackend::Plugin => "tunnel-plugin",
        crate::sidecar::tailscale::MeshBackend::Headscale
        | crate::sidecar::tailscale::MeshBackend::Tailscale => "tailscale",
    }
}

pub(in crate::server) fn mesh_install_flag(
    backend: crate::sidecar::tailscale::MeshBackend,
) -> &'static std::sync::atomic::AtomicBool {
    match backend {
        crate::sidecar::tailscale::MeshBackend::Tailcat => &TAILCAT_INSTALL_IN_FLIGHT,
        crate::sidecar::tailscale::MeshBackend::Cloudflared => &CLOUDFLARED_INSTALL_IN_FLIGHT,
        crate::sidecar::tailscale::MeshBackend::OpenTunnel => &OPENTUNNEL_INSTALL_IN_FLIGHT,
        crate::sidecar::tailscale::MeshBackend::Plugin => &PLUGIN_TUNNEL_INSTALL_IN_FLIGHT,
        crate::sidecar::tailscale::MeshBackend::Headscale
        | crate::sidecar::tailscale::MeshBackend::Tailscale => &TAILSCALE_INSTALL_IN_FLIGHT,
    }
}

/// Install the mesh client in the background and, if the mesh is (still) enabled
/// when it lands, start the daemon.
///
/// Returns whether THIS call started the work: `false` means an install was
/// already running, which the caller reports as "installing" all the same — the
/// user's request is being served either way.
///
/// Shared by `POST /api/mesh/config` and Core's boot self-heal so a node that
/// wants the mesh converges on having it from either entry point. The
/// enabled-check is re-read AFTER the download rather than captured before it,
/// because a minute-long install gives the user ample time to switch the mesh
/// back off — starting a daemon they just disabled would be a surprise.
pub(crate) fn spawn_mesh_backend_install(
    downloads: crate::downloads::DownloadCenter,
    manager: Arc<SidecarManager>,
    install_status: Arc<InstallStatusStore>,
    backend: crate::sidecar::tailscale::MeshBackend,
) -> bool {
    use std::sync::atomic::Ordering;
    let install_key = mesh_install_key(backend);
    if mesh_install_flag(backend).swap(true, Ordering::SeqCst) {
        tracing::info!(
            backend = backend.as_str(),
            "mesh: a network client install is already running — not starting another"
        );
        return false;
    }
    tokio::spawn(async move {
        install_status.set_installing(install_key).await;
        let result = match backend {
            crate::sidecar::tailscale::MeshBackend::Tailcat => {
                crate::sidecar::tailcat_downloader::install_tailcat(&downloads).await
            }
            crate::sidecar::tailscale::MeshBackend::Cloudflared => {
                crate::sidecar::cloudflared_downloader::install_cloudflared(&downloads).await
            }
            crate::sidecar::tailscale::MeshBackend::OpenTunnel => {
                crate::sidecar::opentunnel_downloader::install_opentunnel(&downloads).await
            }
            crate::sidecar::tailscale::MeshBackend::Plugin => Err(anyhow::anyhow!(
                "plugin tunnels are installed from the Store, not by Core"
            )),
            crate::sidecar::tailscale::MeshBackend::Headscale
            | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                crate::sidecar::tailscale::downloader::install_mesh_client(&downloads).await
            }
        };
        mesh_install_flag(backend).store(false, Ordering::SeqCst);
        match result {
            Ok(version) => {
                install_status.set_installed(install_key, version).await;
                let selected_backend = crate::sidecar::tailscale::mesh_backend().await.0;
                let selected_uses_installed_client = match backend {
                    crate::sidecar::tailscale::MeshBackend::Tailcat => {
                        selected_backend == crate::sidecar::tailscale::MeshBackend::Tailcat
                    }
                    crate::sidecar::tailscale::MeshBackend::Cloudflared
                    | crate::sidecar::tailscale::MeshBackend::OpenTunnel
                    | crate::sidecar::tailscale::MeshBackend::Plugin => selected_backend == backend,
                    crate::sidecar::tailscale::MeshBackend::Headscale
                    | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                        matches!(
                            selected_backend,
                            crate::sidecar::tailscale::MeshBackend::Headscale
                                | crate::sidecar::tailscale::MeshBackend::Tailscale
                        )
                    }
                };
                if ryu_mesh::is_enabled() && selected_uses_installed_client {
                    let sidecar = selected_backend.sidecar_name();
                    manager.mark_installed(sidecar).await;
                    if let Err(e) = manager.start_sidecar(sidecar).await {
                        tracing::warn!(
                            backend = selected_backend.as_str(),
                            "mesh: daemon failed to start after auto-install: {e}"
                        );
                    } else {
                        tracing::info!(
                            backend = selected_backend.as_str(),
                            "mesh: client installed and daemon started"
                        );
                    }
                } else if ryu_mesh::is_enabled() {
                    tracing::info!(
                        backend = selected_backend.as_str(),
                        installed_backend = backend.as_str(),
                        "mesh: network client installed, but another backend is selected; leaving it stopped"
                    );
                } else {
                    tracing::info!(
                        backend = backend.as_str(),
                        "mesh: client installed, but the mesh was turned off meanwhile"
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    backend = backend.as_str(),
                    "mesh: automatic network client install failed: {e:#}"
                );
                install_status
                    .set_failed(install_key, format!("{e:#}"))
                    .await;
            }
        }
    });
    true
}
