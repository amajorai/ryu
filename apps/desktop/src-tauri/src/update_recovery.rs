//! Startup admission runs before identifier migration, plugins, or Core startup.
use ryu_runtime_install::{
    recovery::{RecoveryCheckpoint, RecoveryPhase},
    startup::{self, StartupAdmission},
    supervision::{write_acknowledgement, StartupAcknowledgement},
};
use std::path::PathBuf;
use tauri::{Manager, State};

pub(crate) struct UpdateStartupState {
    pub admission: Option<StartupAdmission>,
}

pub(crate) fn schedule_retention(app: &tauri::AppHandle) {
    // A provisional process must not do maintenance before its guard commits.
    if app.state::<UpdateStartupState>().admission.is_some() {
        return;
    }
    let namespace = match recovery_root(&app.config().identifier) {
        Ok(namespace) => namespace,
        Err(error) => {
            tracing::warn!(%error, "update checkpoint maintenance deferred");
            return;
        }
    };
    let app_roots = app.path().app_data_dir().and_then(|data| {
        app.path()
            .app_local_data_dir()
            .map(|local| vec![data, local])
    });
    let mut protected = match app_roots {
        Ok(roots) => roots,
        Err(error) => {
            tracing::warn!(%error, "update checkpoint maintenance could not resolve app data");
            return;
        }
    };
    let active_profile = crate::profile::name();
    let current_version = app.package_info().version.to_string();
    let prepared_cache = match app.path().app_cache_dir() {
        Ok(cache) => cache.join("prepared-app-update"),
        Err(error) => {
            tracing::warn!(%error, "update artifact maintenance deferred");
            return;
        }
    };
    let public_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let core = crate::resolve_core_binary();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<usize> {
            let profiles = ["release", "dev", "beta", "nightly", "canary"];
            let layouts = profiles
                .iter()
                .map(|profile| {
                    ryu_runtime_install::data_paths::DataPaths::for_profile(
                        profile,
                        dirs::home_dir(),
                        dirs::config_dir(),
                    )
                })
                .collect::<std::io::Result<Vec<_>>>()?;
            let config_roots: Vec<_> = layouts
                .iter()
                .map(|paths| paths.config_dir.clone())
                .collect();
            let cache = namespace
                .parent()
                .ok_or_else(|| anyhow::anyhow!("maintenance cache has no parent"))?;
            // Migration/import take an exclusive config lease before changing
            // the pointer. Keep these reads stable until cleanup finishes.
            let _config_lease =
                ryu_runtime_install::data_lease::DataLease::writer(cache, &config_roots)?;
            let core = core
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Core runtime root discovery is unavailable"))?;
            // Selected offline profiles are protected too: a user may have
            // promoted a former backup to their configured data directory.
            for (profile, paths) in profiles.into_iter().zip(layouts) {
                protected.push(paths.resolve_data_dir(None)?);
                protected.extend(
                    tauri::async_runtime::block_on(crate::update_handoff::discover_runtime_roots(
                        core, profile, false,
                    ))
                    .map_err(anyhow::Error::msg)?,
                );
                if profile == active_profile {
                    if let Some(override_dir) = std::env::var_os("RYU_DIR") {
                        protected.push(paths.resolve_data_dir(Some(override_dir))?);
                    }
                    protected.extend(
                        tauri::async_runtime::block_on(
                            crate::update_handoff::discover_runtime_roots(core, profile, true),
                        )
                        .map_err(anyhow::Error::msg)?,
                    );
                }
                protected.push(paths.config_dir);
            }
            let report = ryu_runtime_install::retention::prune_terminal_history_report(
                &namespace,
                &active_profile,
                &protected,
            )?;
            if let Some(key) = &public_key {
                crate::installer_retention::prune(
                    &namespace,
                    &active_profile,
                    &current_version,
                    &prepared_cache,
                    &protected,
                    key,
                    &report.retired_transactions,
                )?;
            }
            Ok(report.newly_retired)
        })();
        match result {
            Ok(retired) => tracing::info!(retired, "update checkpoint maintenance finished"),
            Err(error) => {
                tracing::warn!(%error, "update checkpoint maintenance deferred; backups preserved")
            }
        }
    });
}

// This stays outside app data/local-data roots, including Tauri directory
// overrides: those roots are among the trees recovery may have to restore.
pub(crate) fn recovery_root(identifier: &str) -> Result<PathBuf, String> {
    if identifier.is_empty()
        || matches!(identifier, "." | "..")
        || identifier.len() > 160
        || !identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Invalid application recovery namespace".into());
    }
    dirs::cache_dir()
        .map(|root| root.join("ryu-update-recovery").join(identifier))
        .ok_or_else(|| "Could not resolve the private update recovery directory".into())
}

pub(crate) fn before_boot(identifier: &str, version: &str) -> Result<UpdateStartupState, String> {
    let nonce = std::env::var("RYU_UPDATE_NONCE").ok();
    // This token admits this one application process. It must not leak into a
    // later ordinary relaunch or user tool process after the marker is cleared.
    std::env::remove_var("RYU_UPDATE_NONCE");
    let root = recovery_root(identifier)?;
    if nonce.is_none() && resume_interrupted(&root, &crate::profile::name())? {
        return Err("Interrupted update recovery was restarted; the previous coherent app will reopen when recovery finishes".into());
    }
    let executable = if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe().map_err(|error| error.to_string())?)
    } else {
        std::env::current_exe().map_err(|error| error.to_string())?
    };
    startup::admit_startup(
        &root,
        &crate::profile::name(),
        version,
        &executable,
        nonce.as_deref(),
    )
    .map(|admission| UpdateStartupState { admission })
    .map_err(|error| format!("Update recovery blocked startup: {error:#}"))
}

fn resume_interrupted(root: &std::path::Path, profile: &str) -> Result<bool, String> {
    use crate::win_process::NoWindow;
    use ryu_runtime_install::handoff::HandoffReady;
    use ryu_runtime_install::supervision::identify_process;
    let marker = startup::marker_path(root, profile).map_err(|error| error.to_string())?;
    let bytes = match ryu_runtime_install::bounded_file::read(&marker, 65536) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let pending: startup::PendingRecovery =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if pending.transaction.is_empty()
        || pending.transaction.len() > 100
        || !pending
            .transaction
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid interrupted recovery transaction".into());
    }
    let checkpoint = root.join("transactions").join(&pending.transaction);
    if let Ok(observer) = RecoveryCheckpoint::observe(checkpoint) {
        if matches!(
            observer.read().map_err(|error| error.to_string())?.phase,
            RecoveryPhase::Committed | RecoveryPhase::Restored
        ) {
            return Ok(false);
        }
    }
    let directory = std::fs::canonicalize(root.join("handoffs").join(&pending.transaction))
        .map_err(|error| error.to_string())?;
    let request: ryu_runtime_install::handoff::HandoffRequest = serde_json::from_slice(
        &ryu_runtime_install::bounded_file::read(&directory.join("request.json"), 1024 * 1024)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if identify_process(request.parent.pid).is_some_and(|actual| {
        actual.executable == request.parent.executable
            && actual.start_time == request.parent.start_time
    }) {
        return Ok(false); // The live initiating desktop handles handoff failure.
    }
    if let Some(bytes) =
        ryu_runtime_install::bounded_file::read_optional(&directory.join("ready.json"), 65536)
            .map_err(|error| error.to_string())?
    {
        let ready: HandoffReady =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if ready.nonce != pending.nonce {
            return Err("Interrupted guard acknowledgement has a different nonce".into());
        }
        if identify_process(ready.guard.pid).is_some_and(|actual| {
            actual.executable == ready.guard.executable
                && actual.start_time == ready.guard.start_time
        }) {
            return Ok(false);
        }
    }
    let guard = directory.join(if cfg!(windows) {
        "ryu-update-guard.exe"
    } else if cfg!(target_os = "linux") && directory.join("ryu-update-guard.AppImage").is_file() {
        "ryu-update-guard.AppImage"
    } else {
        "ryu-update-guard"
    });
    std::process::Command::new(guard)
        .arg("--ryu-update-guard")
        .arg(directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_window()
        .spawn()
        .map_err(|error| format!("Could not restart interrupted update recovery: {error}"))?;
    Ok(true)
}

fn matching_runtime_health(value: &serde_json::Value, expected: &str, nonce: &str) -> bool {
    value.get("status").and_then(serde_json::Value::as_str) == Some("ok")
        && value.get("version").and_then(serde_json::Value::as_str) == Some(expected)
        && value
            .get("gatewayVersion")
            .and_then(serde_json::Value::as_str)
            == Some(expected)
        && value
            .get("requiredRuntimeReady")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && value
            .get("updateRuntimeNonce")
            .and_then(serde_json::Value::as_str)
            == Some(nonce)
}

async fn runtime_ready(
    app: &tauri::AppHandle,
    admission: &StartupAdmission,
) -> Result<bool, String> {
    let checkpoint = RecoveryCheckpoint::observe(admission.checkpoint.clone())
        .map_err(|error| error.to_string())?;
    if checkpoint.read().map_err(|error| error.to_string())?.phase != RecoveryPhase::AwaitingHealth
    {
        return Err("The update is no longer awaiting startup health".into());
    }
    if !admission.runtime_required {
        return Ok(true);
    }
    let owned = app
        .state::<crate::CoreState>()
        .process
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .is_some_and(|process| process.owns_process());
    if !owned {
        return Ok(false);
    }
    let response = app
        .state::<crate::HttpClient>()
        .inner()
        .0
        .get(format!(
            "{}/api/health",
            crate::profile::core_localhost_url()
        ))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(false);
    };
    if !response.status().is_success() {
        return Ok(false);
    }
    let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    Ok(matching_runtime_health(
        &value,
        &admission.expected_version,
        &admission.nonce,
    ))
}

#[tauri::command]
pub async fn get_update_startup_health(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, UpdateStartupState>,
) -> Result<Option<bool>, String> {
    if window.label() != "main" {
        return Err("Only the main application can acknowledge update startup".into());
    }
    let Some(admission) = &state.admission else {
        return Ok(None);
    };
    let checkpoint = RecoveryCheckpoint::observe(admission.checkpoint.clone())
        .map_err(|error| error.to_string())?;
    if checkpoint.read().map_err(|error| error.to_string())?.phase == RecoveryPhase::Committed {
        // Renderer work is admitted only after the guard's durable commit.
        return Ok(None);
    }
    runtime_ready(&app, admission).await.map(Some)
}

#[tauri::command]
pub async fn acknowledge_update_startup(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, UpdateStartupState>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Only the main application can acknowledge update startup".into());
    }
    let Some(admission) = &state.admission else {
        return Ok(false);
    };
    if !runtime_ready(&app, admission).await? {
        return Ok(false);
    }
    let pid = std::process::id();
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    let start_time = system
        .process(sysinfo::Pid::from_u32(pid))
        .ok_or_else(|| "Could not identify this app process".to_string())?
        .start_time();
    if start_time == 0 {
        return Err("Could not verify this app's creation time".into());
    }
    let checkpoint = RecoveryCheckpoint::observe(admission.checkpoint.clone())
        .map_err(|error| error.to_string())?;
    write_acknowledgement(
        &checkpoint,
        &StartupAcknowledgement {
            version: app.package_info().version.to_string(),
            nonce: admission.nonce.clone(),
            pid,
            start_time,
            renderer_ready: true,
            runtime_ready: true,
        },
    )
    .map_err(|error| error.to_string())?;
    tracing::info!(version = %admission.expected_version, "app_update provisional renderer and owned runtime acknowledged healthy startup");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_requires_an_observed_matching_gateway_and_core() {
        let healthy = serde_json::json!({"status":"ok", "version":"2", "gatewayVersion":"2", "requiredRuntimeReady":true, "updateRuntimeNonce":"proof"});
        assert!(matching_runtime_health(&healthy, "2", "proof"));
        for value in [
            serde_json::json!({"status":"ok", "version":"1", "gatewayVersion":"2"}),
            serde_json::json!({"status":"ok", "version":"2", "gatewayVersion":null}),
            serde_json::json!({"status":"ok", "version":"2", "gatewayVersion":"1"}),
            serde_json::json!({"status":"warming", "version":"2", "gatewayVersion":"2"}),
        ] {
            assert!(!matching_runtime_health(&value, "2", "proof"));
        }
    }

    #[test]
    fn matching_versions_cannot_commit_with_missing_or_failed_required_runtime() {
        for readiness in [
            serde_json::Value::Null,
            serde_json::json!(false),
            serde_json::json!("ready"),
        ] {
            let value = serde_json::json!({"status":"ok", "version":"2", "gatewayVersion":"2", "requiredRuntimeReady":readiness, "updateRuntimeNonce":"proof"});
            assert!(
                !matching_runtime_health(&value, "2", "proof"),
                "matching versions accepted an unready required runtime"
            );
        }
    }

    #[test]
    fn ordinary_or_other_update_runtime_cannot_satisfy_provisional_health() {
        for nonce in [
            serde_json::Value::Null,
            serde_json::json!("another-update"),
            serde_json::json!(true),
        ] {
            let value = serde_json::json!({"status":"ok", "version":"2", "gatewayVersion":"2", "requiredRuntimeReady":true, "updateRuntimeNonce":nonce});
            assert!(!matching_runtime_health(&value, "2", "proof"));
        }
    }
}
