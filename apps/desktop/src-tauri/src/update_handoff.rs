use crate::{
    app_update::{AppUpdateSource, PreparedAppUpdate},
    update_install_worker::CachedInstall,
};
use ryu_runtime_install::{
    handoff::{write_json, HandoffReady, HandoffRequest},
    startup::PendingRecovery,
    supervision::{identify_process, ProcessCommand, SupervisionPlan},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RetainedInstaller {
    pub(crate) version: String,
    pub(crate) signature: String,
    pub(crate) raw_feed: serde_json::Value,
    pub(crate) format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ownership: Option<crate::installer_retention::ArtifactOwnership>,
}

pub(crate) struct PreparedHandoff {
    pub directory: PathBuf,
    pub guard: PathBuf,
    pub request: HandoffRequest,
    directory_owner: Option<tempfile::TempDir>,
    runtime_discovery: Option<(PathBuf, BTreeMap<String, Vec<PathBuf>>)>,
}

fn installer_format(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    if path.ends_with(".exe") {
        "exe"
    } else if path.ends_with(".msi") {
        "msi"
    } else {
        "native"
    }
    .to_owned()
}

/// The feed channel a version's own release tag carries, from the first
/// semver prerelease identifier: `canary`, `nightly` and `beta` tags publish
/// `{stem}-{channel}.json`; everything else is a stable `{stem}.json` tag.
fn release_channel_for_version(version: &str) -> &'static str {
    let Ok(parsed) = semver::Version::parse(version) else {
        return "stable";
    };
    match parsed.pre.as_str().split('.').next() {
        Some("canary") => "canary",
        Some("nightly") => "nightly",
        Some("beta") => "beta",
        _ => "stable",
    }
}

#[cfg(test)]
mod format_tests {
    use super::{installer_format, release_channel_for_version};

    #[test]
    fn previous_installer_tag_channel_comes_from_the_prerelease_identifier() {
        assert_eq!(release_channel_for_version("0.4.1"), "stable");
        assert_eq!(release_channel_for_version("0.4.1-beta.2"), "beta");
        assert_eq!(
            release_channel_for_version("0.4.1-canary.20260804.36"),
            "canary"
        );
        assert_eq!(
            release_channel_for_version("0.4.1-nightly.20260804"),
            "nightly"
        );
        assert_eq!(release_channel_for_version("0.4.1-rc.1"), "stable");
        assert_eq!(release_channel_for_version("not-a-version"), "stable");
    }

    #[test]
    fn signed_download_queries_do_not_change_installer_format() {
        assert_eq!(
            installer_format("https://example.com/setup.exe?token=abc#download"),
            "exe"
        );
        assert_eq!(
            installer_format("https://example.com/setup.msi?token=abc"),
            "msi"
        );
        assert_eq!(
            installer_format("https://example.com/package.tar.gz?name=setup.exe"),
            "native"
        );
    }
}

fn absolute(path: PathBuf) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    ryu_runtime_install::data_lease::normalized(&path).map_err(|error| error.to_string())
}

pub(crate) fn runtime_roots_from_location(
    value: &serde_json::Value,
) -> Result<Vec<PathBuf>, String> {
    let values = value
        .get("runtimeRoots")
        .and_then(serde_json::Value::as_array)
        .ok_or("Core did not report its managed runtime data roots")?;
    if values.is_empty() || values.len() > 64 {
        return Err("Invalid managed runtime root count".into());
    }
    values
        .iter()
        .map(|value| {
            let text = value.as_str().ok_or("Invalid managed runtime root")?;
            if text.is_empty() || text.len() > 32768 || text.contains('\0') {
                return Err("Invalid managed runtime root path".into());
            }
            let path = PathBuf::from(text);
            if !path.is_absolute() {
                return Err("Managed runtime root must be absolute".into());
            }
            Ok(path)
        })
        .collect()
}

fn pi_config_root_from_location(value: &serde_json::Value) -> Result<PathBuf, String> {
    let roots = runtime_roots_from_location(value)?;
    let root = value
        .get("piConfigRoot")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or("Core did not report its Pi configuration root")?;
    if !roots.contains(&root) {
        return Err("Pi configuration root is outside the reported runtime roots".into());
    }
    Ok(root)
}

pub(crate) async fn discover_runtime_roots(
    core: &Path,
    profile: &str,
    scoped: bool,
) -> Result<Vec<PathBuf>, String> {
    runtime_roots_from_location(&read_core_location(core, profile, scoped).await?)
}

async fn read_core_location(
    core: &Path,
    profile: &str,
    scoped: bool,
) -> Result<serde_json::Value, String> {
    use crate::win_process::NoWindow;
    let mut command = tokio::process::Command::new(core);
    command
        .args(["data-path", "location", "--profile", profile])
        .kill_on_drop(true)
        .no_window();
    if !scoped {
        command.env_remove("RYU_DIR").env_remove("RYU_PI_AGENT_DIR");
    }
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "Managed runtime root discovery timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Core could not resolve its managed runtime data roots".into());
    }
    if output.stdout.len() > 1024 * 1024 {
        return Err("Managed runtime location response is too large".into());
    }
    let value = parse_core_location_output(&output.stdout)?;
    if value.get("profile").and_then(serde_json::Value::as_str) != Some(profile) {
        return Err("Core runtime location belongs to another profile".into());
    }
    Ok(value)
}

fn parse_core_location_output(output: &[u8]) -> Result<serde_json::Value, String> {
    // data-path's successful CLI response ends with its documented completion
    // frame. Consume exactly that frame, without accepting arbitrary log lines.
    let text = std::str::from_utf8(output).map_err(|error| error.to_string())?;
    let text = text.trim();
    let json = text.strip_suffix("\n@@DONE").unwrap_or(text).trim();
    serde_json::from_str(json).map_err(|error| error.to_string())
}

#[cfg(test)]
mod core_location_frame_tests {
    use super::parse_core_location_output;

    #[test]
    fn accepts_json_and_the_exact_cli_completion_frame() {
        for output in [
            b"{\"profile\":\"dev\"}".as_slice(),
            b"{\"profile\":\"dev\"}\n@@DONE\n".as_slice(),
            b"{\"profile\":\"dev\"}\r\n@@DONE\r\n".as_slice(),
        ] {
            assert_eq!(
                parse_core_location_output(output).unwrap()["profile"],
                "dev"
            );
        }
    }

    #[test]
    fn rejects_logs_extra_documents_and_malformed_frames() {
        for output in [
            "log\n{}\n@@DONE\n",
            "{}\n@@DONE\nlog",
            "{}\n@@DONE\n@@DONE\n",
            "{}\n@@DONEX\n",
            "{}@@DONE\n",
            "{}\n{}\n@@DONE\n",
        ] {
            assert!(
                parse_core_location_output(output.as_bytes()).is_err(),
                "{output}"
            );
        }
        assert!(parse_core_location_output(&[0xff]).is_err());
    }
}

fn compact_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots.sort_by_key(|root| root.components().count());
    let mut result: Vec<PathBuf> = Vec::new();
    for root in roots {
        if !result.iter().any(|existing| root.starts_with(existing)) {
            result.push(root);
        }
    }
    result
}

pub(crate) async fn prepare(
    app: &tauri::AppHandle,
    prepared: &PreparedAppUpdate,
    update: &tauri_plugin_updater::Update,
    bytes: &[u8],
) -> Result<PreparedHandoff, String> {
    if cfg!(debug_assertions) {
        return Err("Native app installation must be verified from a packaged Ryu build".into());
    }
    let recovery = update
        .raw_json
        .get("ryu_recovery")
        .ok_or("This release does not declare supervised update recovery support")?;
    if recovery.get("protocol").and_then(serde_json::Value::as_u64) != Some(1)
        || recovery
            .get("identifier")
            .and_then(serde_json::Value::as_str)
            != Some(app.config().identifier.as_str())
    {
        return Err("The prepared update is not a compatible recoverable build of this app".into());
    }
    let namespace = crate::update_recovery::recovery_root(&app.config().identifier)?;
    fs::create_dir_all(namespace.join("handoffs")).map_err(|error| error.to_string())?;
    let namespace = fs::canonicalize(namespace).map_err(|error| error.to_string())?;
    // Maintenance and preparation share the guard's namespace exclusion.
    // This handle is released before accept starts the independent guard.
    let _update_lease =
        crate::installer_retention::update_lease(&namespace).map_err(|error| error.to_string())?;
    let directory_owner = tempfile::Builder::new()
        .prefix("update-")
        .tempdir_in(namespace.join("handoffs"))
        .map_err(|error| error.to_string())?;
    let directory = directory_owner.path().to_path_buf();
    let transaction = directory
        .file_name()
        .ok_or("handoff has no name")?
        .to_string_lossy()
        .into_owned();
    let parent = identify_process(std::process::id())
        .ok_or("Could not verify the current desktop process")?;
    let executable = if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .map(absolute)
            .transpose()?
            .unwrap_or_else(|| parent.executable.clone())
    } else {
        parent.executable.clone()
    };
    let app_root = if cfg!(target_os = "macos") {
        executable
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("App bundle path is invalid")?
            .to_path_buf()
    } else if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| executable.clone())
    } else {
        executable
            .parent()
            .ok_or("App installation has no directory")?
            .to_path_buf()
    };
    let _permission_probe = tempfile::Builder::new()
        .prefix(".ryu-rollback-check-")
        .tempdir_in(app_root.parent().ok_or("App installation has no parent")?)
        .map_err(|error| {
            format!("Cannot reserve rollback in the app installation directory: {error}")
        })?;
    let guard = directory.join(if cfg!(windows) {
        "ryu-update-guard.exe"
    } else if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() {
        "ryu-update-guard.AppImage"
    } else {
        "ryu-update-guard"
    });
    fs::copy(&executable, &guard).map_err(|error| error.to_string())?;
    let current_profile = crate::profile::name();
    let explicitly_scoped = ["RYU_DIR", "RYU_PROFILE"]
        .iter()
        .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
        || cfg!(feature = "dev-variant");
    let target_profile = if explicitly_scoped {
        current_profile.clone()
    } else {
        crate::profile::profile_for_version(&prepared.version)
            .unwrap_or("release")
            .to_owned()
    };
    let mut profiles = vec![current_profile.clone()];
    if target_profile != current_profile {
        profiles.push(target_profile.clone());
    }
    let staged_core =
        crate::core::install::prepared_core_for_update(app, &prepared.version).await?;
    let runtime_required = staged_core.is_some();
    let mut roots = vec![
        absolute(app_root)?,
        absolute(
            app.path()
                .app_data_dir()
                .map_err(|error| error.to_string())?,
        )?,
        absolute(
            app.path()
                .app_local_data_dir()
                .map_err(|error| error.to_string())?,
        )?,
    ];
    let mut current_pi_root = None;
    let mut target_pi_root = None;
    let mut runtime_locations = BTreeMap::new();
    for profile in &profiles {
        // Resolved like Core: the scoped override, else that profile's
        // Storage pointer, else its `~/.ryu<sfx>` default.
        let home = if explicitly_scoped {
            crate::profile::ryu_home_dir()
        } else {
            crate::profile::resolve_data_dir_of(profile, None)
        };
        roots.push(absolute(home)?);
        if let Some(core) = &staged_core {
            let value = read_core_location(core, profile, true).await?;
            let runtime_roots = runtime_roots_from_location(&value)?;
            let pi_root = absolute(pi_config_root_from_location(&value)?)?;
            if profile == &current_profile {
                current_pi_root = Some(pi_root.clone());
            }
            if profile == &target_profile {
                target_pi_root = Some(pi_root);
            }
            let resolved = runtime_roots
                .into_iter()
                .map(absolute)
                .collect::<Result<Vec<_>, _>>()?;
            runtime_locations.insert(profile.clone(), resolved.clone());
            roots.extend(resolved);
            for key in ["data", "config"] {
                roots.push(absolute(PathBuf::from(
                    value
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .ok_or("Invalid Core data location response")?,
                ))?);
            }
        }
    }
    let current_version = app.package_info().version.to_string();
    let retained_root = namespace.join("retained-installers").join(&current_version);
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing updater verification key")?;
    let previous = match fs::read(retained_root.join("metadata.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RetainedInstaller>(&bytes).ok())
    {
        Some(record) if record.version == current_version => {
            let bytes =
                fs::read(retained_root.join("artifact.bin")).map_err(|error| error.to_string())?;
            crate::app_update::verify_minisign(&bytes, &record.signature, key)?;
            (record, bytes)
        }
        _ => {
            let source = AppUpdateSource::Tag {
                tag: format!("v{current_version}"),
                channel: release_channel_for_version(&current_version).into(),
            };
            let endpoint = source
                .endpoint_for_app(app)?
                .parse()
                .map_err(|error| format!("Invalid previous release endpoint: {error}"))?;
            let updater = app
                .updater_builder()
                .endpoints(vec![endpoint])
                .map_err(|error| error.to_string())?
                .version_comparator(|_, _| true)
                .build()
                .map_err(|error| error.to_string())?;
            let previous = updater.check().await.map_err(|error|format!("Could not prepare the previous signed installer; update was not started: {error}"))?.ok_or("The previous signed installer is unavailable; update was not started")?;
            if previous.version != current_version {
                return Err("Previous installer version does not match the installed app".into());
            }
            let bytes = previous
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?;
            crate::app_update::verify_minisign(&bytes, &previous.signature, key)?;
            (
                RetainedInstaller {
                    version: previous.version,
                    signature: previous.signature,
                    raw_feed: previous.raw_json,
                    format: installer_format(previous.download_url.as_str()),
                    ownership: None,
                },
                bytes,
            )
        }
    };
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).map_err(|error| error.to_string())?;
    let nonce = hex::encode(entropy);
    let make_install =
        |name: &str, record: &RetainedInstaller, bytes: &[u8]| -> Result<ProcessCommand, String> {
            let artifact = directory.join(format!("{name}.bin"));
            fs::write(&artifact, bytes).map_err(|error| error.to_string())?;
            let path = directory.join(format!("{name}.json"));
            write_json(
                &path,
                &CachedInstall {
                    artifact,
                    signature: record.signature.clone(),
                    version: record.version.clone(),
                    raw_feed: record.raw_feed.clone(),
                    target_executable: executable.clone(),
                    nonce: nonce.clone(),
                    format: record.format.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
            Ok(ProcessCommand {
                executable: guard.clone(),
                arguments: vec![
                    "--ryu-install-cached".into(),
                    path.to_string_lossy().into_owned(),
                ],
                environment: BTreeMap::from([("RYU_PROFILE".into(), target_profile.clone())]),
            })
        };
    let candidate = RetainedInstaller {
        version: prepared.version.clone(),
        signature: prepared.signature.clone(),
        raw_feed: update.raw_json.clone(),
        format: installer_format(update.download_url.as_str()),
        ownership: None,
    };
    let installer = make_install("candidate", &candidate, bytes)?;
    let rollback_installer = make_install("previous", &previous.0, &previous.1)?;
    for (record, artifact) in [(&previous.0, previous.1.as_slice()), (&candidate, bytes)] {
        crate::installer_retention::persist_installer(
            &namespace,
            &current_profile,
            &transaction,
            record,
            artifact,
            key,
        )
        .map_err(|error| error.to_string())?;
    }
    crate::installer_retention::record_handoff_ownership(&directory, &target_profile, &transaction)
        .map_err(|error| error.to_string())?;
    let pending = PendingRecovery {
        schema: 1,
        transaction,
        nonce: nonce.clone(),
        runtime_required,
        application: executable.clone(),
    };
    let mut application_environment = BTreeMap::from([
        ("RYU_UPDATE_NONCE".into(), nonce.clone()),
        ("RYU_PROFILE".into(), target_profile.clone()),
    ]);
    let mut previous_environment =
        BTreeMap::from([("RYU_PROFILE".into(), current_profile.clone())]);
    if let Some(root) = target_pi_root {
        application_environment.insert(
            "RYU_PI_AGENT_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
    }
    if let Some(root) = current_pi_root {
        previous_environment.insert(
            "RYU_PI_AGENT_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
    }
    let request = HandoffRequest {
        schema: 1,
        namespace: namespace.clone(),
        profiles,
        parent,
        targets: compact_roots(roots),
        previous_version: current_version,
        expected_version: prepared.version.clone(),
        target_profile: target_profile.clone(),
        pending,
        plan: SupervisionPlan {
            data_lease_cache: Some(
                namespace
                    .parent()
                    .ok_or("recovery namespace has no parent")?
                    .to_path_buf(),
            ),
            installer,
            rollback_installer: Some(rollback_installer),
            application: ProcessCommand {
                executable: executable.clone(),
                arguments: vec![],
                environment: application_environment,
            },
            previous_application: ProcessCommand {
                executable,
                arguments: vec![],
                environment: previous_environment,
            },
            nonce,
            startup_timeout_seconds: 600,
            installer_timeout_seconds: 900,
        },
    };
    write_json(&directory.join("request.json"), &request).map_err(|error| error.to_string())?;
    Ok(PreparedHandoff {
        directory,
        guard,
        request,
        directory_owner: Some(directory_owner),
        runtime_discovery: staged_core.map(|core| (core, runtime_locations)),
    })
}

#[cfg(test)]
mod runtime_root_tests {
    use super::*;
    #[test]
    fn managed_runtime_locations_reject_incomplete_or_relative_roots() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"runtimeRoots":[]}),
            serde_json::json!({"runtimeRoots":[null]}),
            serde_json::json!({"runtimeRoots":["relative/pi-agent"]}),
            serde_json::json!({"runtimeRoots":["/pi\u{0000}agent"]}),
        ] {
            assert!(runtime_roots_from_location(&value).is_err());
        }
    }
    #[test]
    fn managed_runtime_locations_accept_explicit_absolute_pi_overrides() {
        let path = std::env::current_dir().unwrap().join("pi-override");
        assert_eq!(
            runtime_roots_from_location(&serde_json::json!({"runtimeRoots":[path]})).unwrap(),
            vec![path]
        );
        let wide = serde_json::json!({"runtimeRoots": vec![std::env::current_dir().unwrap(); 65]});
        assert!(runtime_roots_from_location(&wide).is_err());
    }

    #[test]
    fn pi_configuration_root_must_be_explicit_and_capture_covered() {
        let root = std::env::current_dir().unwrap().join("pi-override");
        let other = std::env::current_dir().unwrap().join("uncaptured-pi");
        assert!(pi_config_root_from_location(&serde_json::json!({"runtimeRoots":[root]})).is_err());
        assert!(pi_config_root_from_location(
            &serde_json::json!({"runtimeRoots":[root], "piConfigRoot":other})
        )
        .is_err());
        assert_eq!(
            pi_config_root_from_location(
                &serde_json::json!({"runtimeRoots":[root], "piConfigRoot":root})
            )
            .unwrap(),
            root
        );
    }
}

pub(crate) async fn accept(prepared: &mut PreparedHandoff) -> Result<(), String> {
    use crate::win_process::NoWindow;
    let mut child = tokio::process::Command::new(&prepared.guard)
        .arg("--ryu-update-guard")
        .arg(&prepared.directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_window()
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.id().ok_or("Recovery guard has no process identity")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let accepted = async {
        loop {
            if let Ok(bytes) = fs::read(prepared.directory.join("ready.json")) {
                let ready: HandoffReady =
                    serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                if ready.nonce == prepared.request.plan.nonce
                    && ready.guard.pid == pid
                    && identify_process(pid).is_some_and(|actual| {
                        actual.executable == ready.guard.executable
                            && actual.start_time == ready.guard.start_time
                    })
                {
                    return Ok(());
                }
                return Err("Recovery guard acknowledgement changed identity".into());
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "Recovery guard exited before accepting the update: {status}"
                ));
            }
            if Instant::now() >= deadline {
                return Err("Recovery guard did not accept the update".into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    .await;
    if accepted.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    } else if let Some(directory) = prepared.directory_owner.take() {
        let _ = directory.keep();
    }
    accepted
}

pub(crate) async fn verify_quiesced(
    prepared: &PreparedHandoff,
    _managed_runtime_stopped: bool,
) -> Result<(), String> {
    if let Some((core, locations)) = &prepared.runtime_discovery {
        for (profile, expected) in locations {
            let actual = discover_runtime_roots(core, profile, true)
                .await?
                .into_iter()
                .map(absolute)
                .collect::<Result<Vec<_>, _>>()?;
            if &actual != expected {
                return Err(
                    "Managed runtime data locations changed during preparation; retry the update"
                        .into(),
                );
            }
        }
    }
    for profile in &prepared.request.profiles {
        let port = if profile == &crate::profile::name() {
            crate::profile::core_port()
        } else {
            7980 + crate::profile::offset_of(profile).ok_or("Unknown recovery profile")?
        };
        verify_runtime_port_closed(profile, port).await?;
    }
    for root in &prepared.request.targets {
        let path = crate::core::process::dev_execution_dir(root).join("worker.json");
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not inspect execution ownership; update was not started: {error}"
                ))
            }
        };
        let record: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
            format!("Invalid execution ownership; update was not started: {error}")
        })?;
        let Some(pid) = record
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
        else {
            return Err("An execution ownership record is invalid; update was not started".into());
        };
        let executable = record
            .get("executable")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("Invalid execution executable identity; update was not started")?;
        let start = record
            .get("start_time")
            .and_then(serde_json::Value::as_u64)
            .filter(|start| *start > 0)
            .ok_or("Invalid execution creation time; update was not started")?;
        if let Some(actual) = identify_process(pid) {
            let executable = fs::canonicalize(executable).map_err(|error| {
                format!("Could not verify live execution identity; update was not started: {error}")
            })?;
            if executable == actual.executable && start == actual.start_time {
                return Err("The independent execution runtime is still writing this profile; update was not started".into());
            }
        }
    }
    Ok(())
}

async fn verify_runtime_port_closed(profile: &str, port: u16) -> Result<(), String> {
    // Windows can take slightly over two seconds to report refusal on a closed
    // loopback port. An observation deadline must allow that actual response.
    let deadline = if cfg!(windows) { 10 } else { 2 };
    match tokio::time::timeout(
        Duration::from_secs(deadline),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
        Ok(Ok(_)) => Err(format!(
            "The {profile} runtime port is still occupied; update was not started"
        )),
        _ => Err(format!(
            "Could not establish that the {profile} runtime stopped; update was not started"
        )),
    }
}

#[cfg(test)]
mod runtime_port_tests {
    use super::verify_runtime_port_closed;

    #[test]
    fn accepts_an_actual_closed_loopback_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(verify_runtime_port_closed("dev", port))
            .unwrap();
    }

    #[test]
    fn rejects_an_actual_live_loopback_listener() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime
            .block_on(verify_runtime_port_closed("dev", port))
            .unwrap_err();
        assert!(error.contains("still occupied"));
    }
}
