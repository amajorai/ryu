use super::*;

/// Seed the installed set and mark or pre-install the selected network backend.
pub(super) async fn prepare_network_backend(
    setup: &Arc<SetupManager>,
    seed_names: Vec<String>,
    download_center: &crate::downloads::DownloadCenter,
    sidecars: &Arc<SidecarManager>,
    install_status: &Arc<InstallStatusStore>,
    mesh_preinstall_client: bool,
    offline_test_bootstrap: bool,
) {
    // Seed the installed set from the persisted `versions.json` BEFORE starting
    // sidecars. `install_local_stack` + `start_all` are spawned concurrently, so
    // without this `start_all` can win the race and skip the already-on-disk
    // resident local engine (`llamacpp`) for the whole session — leaving the
    // gateway with no provider and hanging every chat through it (e.g. `ryu`).
    // Awaited (not spawned) so the seed is in place before `start_all` reads it.
    setup.seed_installed_from_disk(&seed_names).await;

    // Tunnel manager: make `start_all` start the selected backend when enabled.
    // `seed_installed_from_disk` skips the network sidecars because a managed
    // binary may exist from preinstallation while the tunnel was off. The
    // enabled preference marks the selected sidecar installed.
    let selected_network_backend = crate::sidecar::tailscale::mesh_backend().await.0;
    let selected_network_available = match selected_network_backend {
        crate::sidecar::tailscale::MeshBackend::Tailcat => {
            crate::sidecar::tailcat::resolve_binary().is_ok()
        }
        crate::sidecar::tailscale::MeshBackend::Cloudflared => {
            crate::sidecar::cloudflared::resolve_binary().is_ok()
        }
        crate::sidecar::tailscale::MeshBackend::OpenTunnel => {
            crate::sidecar::opentunnel::resolve_binary().is_ok()
        }
        // The adapter is an app; the Store installed it, Core has nothing to stage.
        crate::sidecar::tailscale::MeshBackend::Plugin => true,
        crate::sidecar::tailscale::MeshBackend::Headscale
        | crate::sidecar::tailscale::MeshBackend::Tailscale => {
            crate::sidecar::tailscale::ensure_mesh_binaries().is_ok()
        }
    };
    if ryu_mesh::is_enabled() && selected_network_available {
        setup
            .mark_installed(selected_network_backend.sidecar_name())
            .await;
        tracing::info!(
            backend = selected_network_backend.as_str(),
            sidecar = selected_network_backend.sidecar_name(),
            "network: selected backend will start with the other sidecars"
        );
    } else if ryu_mesh::is_enabled() {
        tracing::info!(
            backend = selected_network_backend.as_str(),
            "network: selected backend is not installed yet; background installation will make it startable"
        );
    }

    // Tunnel client install — separate from enabling the tunnel. Staging the
    // selected backend on an off node makes first use behave like the default
    // engines. Tailcat uses its CLI; Headscale and Tailscale share the managed
    // Tailscale pair; Cloudflared uses its pinned release.
    //
    // This does NOT turn the mesh on. `spawn_mesh_backend_install` re-reads
    // `ryu_mesh::is_enabled()` only AFTER the download and, when false, leaves
    // the sidecar unmarked and stopped. The fail-closed token gate therefore
    // remains untouched while a mesh-OFF node is being prepared.
    let should_preinstall_network = ryu_mesh::is_enabled() || mesh_preinstall_client;
    let can_install_selected_backend = match selected_network_backend {
        crate::sidecar::tailscale::MeshBackend::Tailcat => {
            crate::sidecar::tailcat_downloader::can_install()
        }
        crate::sidecar::tailscale::MeshBackend::Cloudflared => {
            crate::sidecar::cloudflared_downloader::can_install()
        }
        crate::sidecar::tailscale::MeshBackend::OpenTunnel => {
            crate::sidecar::opentunnel_downloader::can_install()
        }
        crate::sidecar::tailscale::MeshBackend::Plugin => false,
        crate::sidecar::tailscale::MeshBackend::Headscale
        | crate::sidecar::tailscale::MeshBackend::Tailscale => {
            crate::sidecar::tailscale::downloader::can_install()
        }
    };
    if !offline_test_bootstrap
        && should_preinstall_network
        && !selected_network_available
        && can_install_selected_backend
    {
        if ryu_mesh::is_enabled() {
            tracing::info!(
                backend = selected_network_backend.as_str(),
                "mesh: selected network client is missing — installing one now"
            );
        } else {
            tracing::info!(
                backend = selected_network_backend.as_str(),
                "mesh: pre-installing the selected network client (mesh stays off; set \
                 {}=0 or the `{}` pref to skip)",
                crate::mesh_host::MESH_PREINSTALL_ENV,
                crate::mesh_host::MESH_PREINSTALL_PREF_KEY,
            );
        }
        crate::server::spawn_mesh_backend_install(
            download_center.clone(),
            Arc::clone(&sidecars),
            Arc::clone(&install_status),
            selected_network_backend,
        );
    }
}
