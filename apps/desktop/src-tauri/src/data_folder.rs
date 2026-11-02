//! Data folder relocation / import commands (offline, run while Core is stopped).

use tauri::Emitter;

use crate::core_lifecycle::{resolve_core_binary, CoreState};
use crate::fs_command_error::{FsCommandError, FsCommandErrorCode as Code};
use crate::profile;

/// The `ryu-core` binary these offline commands drive, or `core_missing`.
fn core_binary() -> Result<std::path::PathBuf, FsCommandError> {
    resolve_core_binary().ok_or_else(|| FsCommandError::new(Code::CoreMissing))
}

// ── Data folder relocation / import (offline, runs while Core is stopped) ─────────

/// Stop the Core we manage, then wait until its HTTP server is actually down.
/// Refuses (rather than copying a live database) if Core stays up — this covers
/// dev, where Core is owned by the `core#dev` turbo task and we can't stop it.
pub(crate) async fn stop_core_and_wait(
    state: &tauri::State<'_, CoreState>,
) -> Result<(), FsCommandError> {
    let _operation = state.operation.lock().await;
    if crate::app_update::runtime_update_in_progress() {
        return Err(FsCommandError::new(Code::UpdatePending));
    }
    let stop_failed =
        |e: &dyn std::fmt::Display| FsCommandError::with_detail(Code::CoreStopFailed, e);
    let process = {
        let mut guard = state.process.lock().map_err(|e| stop_failed(&e))?;
        guard.take()
    };
    if let Some(mut process) = process {
        process.stop().await.map_err(|e| stop_failed(&e))?;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .map_err(|e| stop_failed(&e))?;
    for _ in 0..8 {
        let up = client
            .get(format!("{}/api/health", profile::core_base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !up {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    // In dev, Core is owned by the `core#dev` turbo task and cannot be stopped.
    Err(FsCommandError::new(Code::CoreRunning))
}

/// Run `ryu-core data-path …`, forwarding `@@PROGRESS {json}` lines to the
/// `data-folder-progress` frontend event. A failure carries the subcommand's
/// stderr as `detail`, classified by [`FsCommandError::from_data_command`].
pub(crate) async fn run_data_path_subcommand(
    app: &tauri::AppHandle,
    binary: &std::path::Path,
    args: &[String],
    secret_env: &[(&str, String)],
) -> Result<(), FsCommandError> {
    run_data_path_process(app, binary, args, secret_env)
        .await
        .map_err(FsCommandError::from_data_command)
}

async fn run_data_path_process(
    app: &tauri::AppHandle,
    binary: &std::path::Path,
    args: &[String],
    secret_env: &[(&str, String)],
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    use crate::win_process::NoWindow;

    let mut command = Command::new(binary);
    // Secrets (the backup passphrase) travel in the child's environment, which
    // only the same OS user can read, never on its command line.
    for (name, value) in secret_env {
        command.env(name, value);
    }
    let mut child = command
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("failed to launch ryu-core: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ryu-core stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ryu-core stderr was not captured".to_string())?;
    let progress_app = app.clone();
    let read_stdout = async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("@@PROGRESS ") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(rest) {
                    let _ = progress_app.emit("data-folder-progress", value);
                }
            }
        }
        Ok::<(), String>(())
    };
    let read_stderr = async move {
        let mut err = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            err.push_str(&line);
            err.push('\n');
        }
        Ok::<String, String>(err)
    };
    let (stdout_result, stderr_result, status_result) =
        tokio::join!(read_stdout, read_stderr, child.wait());
    stdout_result?;
    let err = stderr_result?;
    let status = status_result.map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    Err(if err.trim().is_empty() {
        format!("ryu-core exited with {status}")
    } else {
        err.trim().to_string()
    })
}

/// Remove the auxiliary roots a node reset never reaches — the profile's OS
/// config dir holding `gateway.toml` + the data-path pointer — optionally
/// clearing the profile's data dir too (`depth`). Shadow and Ghost live under the
/// data dir's `services/`, so there are no machine-wide shared roots to clear.
///
/// Stops Core first, and does not restart: the data dir is untouched, so there is
/// nothing for the running node to re-resolve.
#[tauri::command]
pub(crate) async fn deep_clean_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    profile: Option<String>,
    depth: Option<String>,
) -> Result<(), FsCommandError> {
    let binary = core_binary()?;
    stop_core_and_wait(&state).await?;
    let mut args = vec!["data-path".to_string(), "deep-clean".to_string()];
    // Passed EXPLICITLY rather than letting the child infer the profile from its
    // inherited env — the same trap `copy_data_folder_to_profile` avoids. A user
    // cleaning `canary` from a release app must not have the child resolve
    // `release` because that is what RYU_PROFILE happened to say.
    args.push("--profile".to_string());
    args.push(profile.unwrap_or_else(crate::profile::name));
    args.push("--depth".to_string());
    args.push(depth.unwrap_or_else(|| "none".to_string()));
    run_data_path_subcommand(&app, &binary, &args, &[]).await
}

/// Copy THIS profile's data folder into another profile's, carrying the master
/// key, so a canary (or any) profile can be tested against real state instead of
/// one rebuilt by hand.
///
/// Deliberately does NOT restart: neither profile's pointer file is touched, so
/// the running app's own data dir is unchanged and there is nothing to re-resolve.
/// The target profile picks the copy up the next time it starts.
///
/// `--from-profile` is passed EXPLICITLY rather than letting the child infer it.
/// `run_data_path_subcommand` spawns with inherited env only, so a child would
/// otherwise resolve whatever `RYU_PROFILE` this process happens to carry — which
/// is right by luck today and wrong the moment a dev build drives the copy.
#[tauri::command]
pub(crate) async fn copy_data_folder_to_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    to_profile: String,
) -> Result<(), FsCommandError> {
    let binary = core_binary()?;
    // WAL is on for every store, so a live copy captures a torn snapshot.
    stop_core_and_wait(&state).await?;
    let args = vec![
        "data-path".to_string(),
        "copy-profile".to_string(),
        "--from-profile".to_string(),
        crate::profile::name(),
        "--to-profile".to_string(),
        to_profile,
    ];
    run_data_path_subcommand(&app, &binary, &args, &[]).await
}

/// Copy-relocate the data folder to `to`, then restart the app to apply.
#[tauri::command]
pub(crate) async fn migrate_data_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    to: String,
    move_source: bool,
) -> Result<(), FsCommandError> {
    let binary = core_binary()?;
    stop_core_and_wait(&state).await?;
    let mut args = vec![
        "data-path".to_string(),
        "migrate".to_string(),
        "--to".to_string(),
        to,
    ];
    if move_source {
        args.push("--move".to_string());
    }
    run_data_path_subcommand(&app, &binary, &args, &[]).await?;
    app.restart();
}

/// Env var `ryu-core data-path import` reads an encrypted backup's passphrase from
/// (`data_path::ARCHIVE_PASSPHRASE_ENV` in Core).
pub(crate) const DATA_ARCHIVE_PASSPHRASE_ENV: &str = "RYU_DATA_ARCHIVE_PASSPHRASE";

/// Restore the data folder from a backup zip, then restart the app to apply.
#[tauri::command]
pub(crate) async fn import_data_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    archive: String,
    to: Option<String>,
    passphrase: Option<String>,
) -> Result<(), FsCommandError> {
    let binary = core_binary()?;
    stop_core_and_wait(&state).await?;
    let mut args = vec![
        "data-path".to_string(),
        "import".to_string(),
        "--archive".to_string(),
        archive,
    ];
    if let Some(to) = to {
        args.push("--to".to_string());
        args.push(to);
    }
    let secret_env: Vec<(&str, String)> = passphrase
        .filter(|value| !value.is_empty())
        .map(|value| (DATA_ARCHIVE_PASSPHRASE_ENV, value))
        .into_iter()
        .collect();
    run_data_path_subcommand(&app, &binary, &args, &secret_env).await?;
    app.restart();
}
