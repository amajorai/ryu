//! Background auto-start of the managed Ryu Core (and its sidecars) at launch.

use tauri::Manager;

use crate::core::process::RyuCoreProcess;
use crate::core_lifecycle::{resolve_core_binary, CoreState};
#[cfg(not(debug_assertions))]
use crate::ISLAND_ENABLED;

/// Auto-start Ryu Core on app launch.
pub(crate) fn spawn(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        #[allow(unused_mut)]
        let mut binary = resolve_core_binary();
        // Production only: run the canonical one-line installer when the
        // managed local stack is missing or stale. The installer owns Core,
        // Gateway, CLI, and the start of Core's bundled defaults. In dev the
        // binary is owned by turbo (`bun run dev:core`), so this branch is
        // disabled — resolve_core_binary's dev fallback finds the debug build.
        //
        // The missing-binary half is now gated on the user having chosen
        // to run locally (`nodes.json` exists and its default node is this
        // machine's Core). The desktop no longer requires a local Core to
        // open — onboarding offers cloud and "connect to an existing node"
        // — so downloading one at boot would install a backend on behalf
        // of a user who may never want it. A fresh install therefore
        // downloads nothing until the local path is picked, which does it
        // through `ensure_core_installed`. The STALE half stays ungated: a
        // binary already on disk means this is a local user, and letting
        // an old core linger is the bug that check exists to prevent.
        #[cfg(not(debug_assertions))]
        if (binary.is_none()
            && (crate::nodes::default_node_is_local()
                || crate::core::install::has_prepared_runtime()))
            || (binary.is_some() && crate::core::install::is_managed_core_stale(&handle))
        {
            match crate::core::install::ensure_unified_installed(&handle).await {
                Ok(p) => binary = Some(p),
                Err(e) => {
                    binary = None;
                    tracing::error!(
                        "Failed to install the matching Ryu stack; previous binaries retained: {}",
                        e
                    );
                }
            }
        }
        // Ensure the ryu-gateway sidecar is on disk BEFORE Core starts: Core
        // spawns it as a managed sidecar at boot and hands it every model
        // call, so a missing gateway degrades chat with no auto-retry. A
        // failure here is loud but non-fatal — the app still opens.
        //
        // Only when there IS a local Core to serve, though: the gateway is
        // that Core's sidecar, so downloading it for a user whose node is
        // in the cloud or on their company's server buys nothing.
        #[cfg(not(debug_assertions))]
        if binary.is_some() {
            if let Err(e) = crate::core::install::ensure_gateway_installed(&handle).await {
                binary = None;
                tracing::error!(
                    "Failed to auto-install ryu-gateway (chat will be degraded until it is installed to ~/.ryu/bin/ or RYU_GATEWAY_BIN is set): {}",
                    e
                );
            }
        }
        if let Some(binary) = binary {
            let lifecycle_state = handle.state::<CoreState>();
            let _operation = lifecycle_state.operation.lock().await;
            if crate::app_update::runtime_update_in_progress() {
                return;
            }
            let mut process = RyuCoreProcess::new_for_app(&handle, binary);
            if let Err(e) = process.start().await {
                tracing::error!("Failed to auto-start Ryu Core: {}", e);
            } else {
                // Store the process in state after successful start
                let state = handle.state::<CoreState>();
                if let Ok(mut guard) = state.process.lock() {
                    *guard = Some(process);
                }
                tracing::info!("Ryu Core auto-started successfully");
            }
        } else {
            tracing::warn!(
                "Ryu Core binary not found — install to ~/.ryu/bin/ or set RYU_CORE_BIN"
            );
        }

        // NOTE: the desktop no longer prefetches the opt-in app sidecar bins
        // (mail/teams/research/…) at boot. Those binaries are now downloaded
        // by Core on-demand the first time their app is *enabled* (and removed
        // on uninstall) — see `apps/core/src/sidecar/manifest_sidecar.rs`
        // (`ensure_local_sidecar_present`) and `plans/019-sidecar-binary-lifecycle.md`.
        // The Tauri layer therefore fetches only core + gateway directly;
        // Core owns the default Shadow/Ghost/Island provisioning above.
        // An opt-in app's binary arrives when the user turns that app on,
        // not before.

        // Island (the Electron companion overlay, loopback :7989) — keep the
        // bundle installed and current. The install is routed through Core's
        // global DownloadCenter, so a disabled companion still receives the
        // same resumable/progress-visible update treatment as every other
        // managed artifact. It is only launched when the `ISLAND_ENABLED`
        // release gate is on; the desktop UI entry points (NodeSelector row,
        // Preflight item, onboarding install, Keyboard Shortcuts rows, tray
        // Show/Hide Companion, and the User Nav Show/Hide Island control)
        // follow the same gate.
        #[cfg(not(debug_assertions))]
        {
            let island_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                match crate::core::install::ensure_island_installed(&island_handle).await {
                    Ok(_) if ISLAND_ENABLED => {
                        if let Err(error) = crate::core::install::launch_island() {
                            tracing::debug!("Ryu Island not launched: {}", error);
                        }
                    }
                    Ok(_) => tracing::debug!("Ryu Island installed and ready; autostart disabled"),
                    Err(error) => {
                        tracing::debug!("Ryu Island preinstall failed: {}", error)
                    }
                }
            });
        }
    });
}
