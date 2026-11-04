//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `install_sidecar` through `install_sidecar`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/setup/{name}/install",
    tag = "Sidecars",
    summary = "Install a sidecar (SSE progress)",
    params(
        ("name" = String, Path),
        ("force" = Option<bool>, Query, description = "Re-download even when already installed"),
        ("version" = Option<String>, Query, description = "Expected release-train version for Island"),
        ("wait" = Option<bool>, Query, description = "Wait for Island extraction to finish"),
        ("dryRun" = Option<bool>, Query, description = "Return the install plan without downloading or changing status"),
    ),
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn install_sidecar(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    Query(query): Query<InstallSidecarQuery>,
) -> Json<serde_json::Value> {
    let setup = Arc::clone(&state.setup);
    let install_status = Arc::clone(&state.install_status);
    // Downloads route through the global center (#456) so installs show in the
    // overlay; same instance the auto-spawn `start()` path uses.
    let downloads = state.downloads.clone();
    let sidecar_name = name.clone();

    // Node-gate platform-locked engines (e.g. MLX = Apple Silicon only). The check
    // is on THIS Core node's OS/arch — authoritative, since the client may be a
    // remote desktop on a different platform. Refuse before marking installing so
    // an unsupported node never shows a phantom install.
    if !crate::catalog::registry::supported_on_node(&sidecar_name) {
        return Json(json!({
            "success": false,
            "error": format!(
                "'{sidecar_name}' is not supported on this node ({}/{})",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        }));
    }

    if query.dry_run {
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "install",
            "name": name,
            "supported": true,
            "installed": binary_installed_on_disk(&sidecar_name),
            "force": query.force,
            "version": query.version,
            "writes": ["sidecar binary or runtime files", "install status"],
        }));
    }

    // One install per sidecar at a time. Claimed BEFORE the forced path clears
    // the version record, so a duplicate request cannot clear it again or start
    // a second installer extracting over the first.
    if !install_status.try_begin_installing(&sidecar_name).await {
        return Json(json!({
            "success": false,
            "forced": query.force,
            "error": format!("'{sidecar_name}' is already being installed"),
        }));
    }

    // A forced install is how an UPDATE is applied. Every downloader's
    // `ensure_installed` opens with an already-installed fast path — keyed on the
    // recorded version for pinned engines, on the recorded checksum for the
    // archive downloaders, on mere presence for the subprocess installers. All
    // three read `versions.json`, so dropping this entry's record (version AND
    // checksum, atomically) is enough to make every variant miss and re-download.
    // Without it, "Update" returned 200 having done nothing at all.
    //
    // The binary is deliberately left in place: the downloaders install
    // atomically over it, so a failed re-download leaves the working install
    // intact rather than a hole where the engine used to be.
    // The records cleared below, kept so a FAILED reinstall can put them back:
    // the binary stays in place, and without its record a working engine reads
    // as `not_installed` after the next restart and loses its checksum fast path.
    let cleared_records: Vec<(String, Option<String>, Option<String>)> = if query.force {
        let store = crate::sidecar::download_manager::VersionStore::load();
        forced_update_version_keys(&name)
            .into_iter()
            .map(|key| {
                let version = store.versions.get(&key).cloned();
                let checksum = store.checksums.get(&key).cloned();
                (key, version, checksum)
            })
            .collect()
    } else {
        Vec::new()
    };
    for (key, _, _) in &cleared_records {
        if let Err(e) = crate::sidecar::download_manager::VersionStore::remove_persisted(key) {
            tracing::warn!(
                "could not clear the version record '{key}' before a forced reinstall of '{name}': {e}"
            );
        } else {
            tracing::info!("forced reinstall of '{name}' — cleared its version record '{key}'");
        }
    }

    // Island is a desktop-owned Electron bundle, not a lifecycle sidecar. Keep
    // its install/update bytes in the same global DownloadCenter, but allow the
    // local Desktop bootstrap to await the final extracted bundle before a future
    // launch toggle uses it.
    if sidecar_name == "island" && query.wait {
        let version = query
            .version
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
        install_status.set_installing("island").await;
        match crate::sidecar::tools::island::ensure_installed(&downloads, &version, query.force)
            .await
        {
            Ok(path) => {
                install_status
                    .set_installed("island", version.clone())
                    .await;
                return Json(json!({
                    "success": true,
                    "forced": query.force,
                    "version": version,
                    "path": path,
                }));
            }
            Err(error) => {
                install_status.set_failed("island", error.to_string()).await;
                return Json(json!({
                    "success": false,
                    "forced": query.force,
                    "error": error.to_string(),
                }));
            }
        }
    }

    // Mark as installing
    install_status.set_installing(&sidecar_name).await;

    // A forced reinstall replaces the binary (and, for llama.cpp, wipes its whole
    // directory). Doing that under a running process fails on Windows, where a
    // running executable and its DLLs are locked, and on Unix leaves a live
    // server whose backend libraries were unlinked. Stop it first; it is started
    // again afterwards whether or not the update landed, since the downloaders
    // leave the previous install in place on failure.
    let manager = Arc::clone(&state.manager);
    let stopped_for_update: Vec<&'static str> = if query.force {
        sidecars_sharing_install(&sidecar_name)
            .into_iter()
            .filter(|name| manager.is_sidecar_running(name))
            .collect()
    } else {
        Vec::new()
    };
    for running in &stopped_for_update {
        if let Err(e) = manager.stop_sidecar(running).await {
            tracing::warn!("could not stop '{running}' before updating '{sidecar_name}': {e}");
        }
    }

    tokio::spawn(async move {
        let result: anyhow::Result<String> =
            run_sidecar_downloader(&sidecar_name, &downloads, query.version, query.force).await;

        for stopped in &stopped_for_update {
            if let Err(e) = manager.start_sidecar(stopped).await {
                tracing::warn!(
                    "could not restart '{stopped}' after updating '{sidecar_name}': {e}"
                );
            }
        }

        match result {
            Ok(version) => {
                // The mesh daemon is the ONE sidecar whose "installed" flag is owned
                // by the mesh pref rather than by having the binaries — the same
                // invariant `seed_installed_from_disk` and `main()` keep at boot.
                // Marking it here would let `POST /api/sidecar/start-all` try to
                // start a daemon for someone who installed the client but never
                // enabled the mesh; `TailscaleManager::start` bails immediately on
                // `!is_enabled()`, so the only possible product is a confusing
                // error. `POST /api/mesh/config` marks it when the mesh is actually
                // turned on.
                if !matches!(sidecar_name.as_str(), "tailscale" | "tailcat")
                    || ryu_mesh::is_enabled()
                {
                    setup.mark_installed(&sidecar_name).await;
                }
                tracing::info!("sidecar '{}' installed successfully", sidecar_name);
                install_status.set_installed(&sidecar_name, version).await;
            }
            Err(e) => {
                tracing::error!("failed to install sidecar '{}': {e:#}", sidecar_name);
                for (key, version, checksum) in &cleared_records {
                    if let Some(version) = version {
                        restore_cleared_version_record(key, version, checksum.as_deref());
                    }
                }
                install_status
                    .set_failed(&sidecar_name, format!("{e:#}"))
                    .await;
            }
        }
    });

    Json(json!({
        "success": true,
        "forced": query.force,
        "message": format!("Sidecar '{}' installation started in background", name)
    }))
}
