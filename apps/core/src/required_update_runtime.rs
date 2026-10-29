//! Managed agent dependencies that must work before a provisional app commits.
use crate::sidecar::adapters::acp_direct_spawn::process_path_argument;
use crate::win_process::NoWindow;
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::contained_process::{prepare_command, ContainedProcessLease};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Compiled baseline: the oldest engine/bridge pair this build accepts, and the
/// pair installed when the npm registry cannot be reached. Newer releases are
/// picked up by [`spawn_auto_update`] and the explicit agent update action.
pub const PI_VERSION: &str = "1.0.0";
pub const BRIDGE_VERSION: &str = "0.0.34";
pub const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";
pub const BRIDGE_PACKAGE: &str = "pi-acp";
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(20);
/// Loads the given extension files with the candidate engine's own loader, which
/// is what Pi does at startup. Load errors or a skipped file land in `errors.txt`.
const EXTENSION_PROBE: &str = r#"import { writeFileSync } from "node:fs";
const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
const [cwd, agentDir, ...files] = process.argv.slice(2);
const loaded = await discoverAndLoadExtensions(files, cwd, agentDir);
const errors = loaded.errors.map((entry) => `${entry.path}: ${entry.error}`);
for (const file of files) {
	if (!loaded.extensions.some((extension) => extension.resolvedPath === file)) {
		errors.push(`${file}: not loaded`);
	}
}
if (errors.length > 0) {
	writeFileSync("errors.txt", errors.join("\n"));
	process.exit(1);
}
"#;
/// Bound on the load-error detail carried into the readiness error.
const EXTENSION_ERROR_LIMIT: usize = 4096;

/// Same supply-chain quarantine as the repository's `bunfig.toml`: a release is
/// eligible only once it has been public this long.
const MINIMUM_RELEASE_AGE: chrono::TimeDelta = chrono::TimeDelta::days(7);
/// First background check waits for startup traffic to settle.
const AUTO_UPDATE_DELAY: Duration = Duration::from_secs(120);
const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
static READY: AtomicBool = AtomicBool::new(false);
static NONCE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

#[derive(Debug)]
struct UnverifiedProcessDrain;

impl std::fmt::Display for UnverifiedProcessDrain {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("managed Pi runtime descendant drainage was not verified")
    }
}

fn retain_unverified_directory(
    directory: tempfile::TempDir,
    error: anyhow::Error,
) -> anyhow::Error {
    if error.downcast_ref::<UnverifiedProcessDrain>().is_some() {
        let path = directory.keep();
        error.context(format!(
            "managed Pi runtime data retained at {}",
            path.display()
        ))
    } else {
        error
    }
}

pub fn ready() -> bool {
    READY.load(Ordering::Acquire)
}
pub fn nonce() -> Option<&'static str> {
    NONCE.get().and_then(|nonce| nonce.as_deref())
}

/// Environment overrides are managed writable state too, so discovery and
/// admission must use the same absolute root before any settings are written.
pub fn pi_config_root(data: &Path, config: &Path) -> Result<PathBuf> {
    let root = crate::config_file::pi_agent_override_at(config)?
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value.trim()))
        .unwrap_or_else(|| ryu_sidecar_runtime::layout::runtime_dir(data, "pi-agent"));
    Ok(absolute_root(root)?)
}

fn absolute_root(root: PathBuf) -> std::io::Result<PathBuf> {
    if root.is_absolute() {
        Ok(root)
    } else {
        Ok(std::env::current_dir()?.join(root))
    }
}

pub fn lifecycle_roots(data: &Path, config: &Path) -> Result<Vec<PathBuf>> {
    Ok(vec![pi_config_root(data, config)?])
}

pub fn bridge_entry(prefix: &Path) -> PathBuf {
    prefix.join("node_modules/pi-acp/dist/ryu-index.js")
}

const BRIDGE_STORE_ORIGINAL: &str = "return join(homedir(), \".pi\", \"pi-acp\");";
const BRIDGE_STORE_SCOPED: &str = "return join(process.env.PI_CODING_AGENT_DIR, \".acp\");";

fn scoped_bridge_source(prefix: &Path) -> Result<String> {
    let source = std::fs::read_to_string(prefix.join("node_modules/pi-acp/dist/index.js"))?;
    ensure!(
        source.matches(BRIDGE_STORE_ORIGINAL).count() == 1,
        "pi-acp session-store implementation changed; this bridge release cannot be scoped"
    );
    Ok(source.replacen(BRIDGE_STORE_ORIGINAL, BRIDGE_STORE_SCOPED, 1))
}

fn bridge_scoped(prefix: &Path) -> bool {
    scoped_bridge_source(prefix).ok().is_some_and(|expected| {
        std::fs::read_to_string(bridge_entry(prefix)).is_ok_and(|actual| actual == expected)
    })
}

fn pi_launcher(prefix: &Path) -> PathBuf {
    prefix
        .join("node_modules/.bin")
        .join(if cfg!(windows) { "pi.cmd" } else { "pi" })
}

fn launcher_present(prefix: &Path) -> bool {
    #[cfg(windows)]
    {
        prefix.join("node_modules/.bin/pi.exe").is_file()
            && std::fs::read(pi_launcher(prefix))
                .is_ok_and(|bytes| bytes == b"@\"%~dp0pi.exe\" %*\r\n")
    }
    #[cfg(not(windows))]
    {
        pi_launcher(prefix).is_file()
    }
}

/// The exact engine/bridge pair one runtime generation holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeVersions {
    pub pi: String,
    pub bridge: String,
}

impl RuntimeVersions {
    pub fn baseline() -> Self {
        Self {
            pi: PI_VERSION.to_owned(),
            bridge: BRIDGE_VERSION.to_owned(),
        }
    }

    fn specs(&self) -> [String; 2] {
        [
            format!("{PI_PACKAGE}@{}", self.pi),
            format!("{BRIDGE_PACKAGE}@{}", self.bridge),
        ]
    }

    /// Neither package may be older than this build's compiled baseline.
    fn meets_baseline(&self) -> bool {
        version_at_least(&self.pi, PI_VERSION) && version_at_least(&self.bridge, BRIDGE_VERSION)
    }
}

fn version_at_least(version: &str, floor: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(floor),
    ) {
        (Ok(version), Ok(floor)) => version >= floor,
        _ => false,
    }
}

fn installed_package_version(prefix: &Path, package: &str) -> Option<String> {
    let path = prefix
        .join("node_modules")
        .join(package)
        .join("package.json");
    let bytes = std::fs::read(path).ok()?;
    let value = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    if value.get("name").and_then(|v| v.as_str()) != Some(package) {
        return None;
    }
    let version = value.get("version").and_then(|v| v.as_str())?;
    semver::Version::parse(version).ok()?;
    Some(version.to_owned())
}

/// The complete, patched engine/bridge pair in `prefix`, or `None` when any
/// part of the generation is missing or unpatched.
fn installed_versions(prefix: &Path) -> Option<RuntimeVersions> {
    let versions = RuntimeVersions {
        pi: installed_package_version(prefix, PI_PACKAGE)?,
        bridge: installed_package_version(prefix, BRIDGE_PACKAGE)?,
    };
    (bridge_entry(prefix).is_file() && bridge_scoped(prefix) && launcher_present(prefix))
        .then_some(versions)
}

/// Like [`installed_versions`], but also rejects a generation below the baseline.
fn accepted_versions(prefix: &Path) -> Option<RuntimeVersions> {
    installed_versions(prefix).filter(RuntimeVersions::meets_baseline)
}

fn tool(name: &str) -> Result<PathBuf> {
    crate::sidecar::manifest_sidecar::which_on_path(name)
        .with_context(|| format!("{name} is required to validate the managed Pi runtime"))
}

async fn checked_status(command: &mut tokio::process::Command, timeout: Duration) -> Result<()> {
    prepare_command(command);
    let mut child = command.spawn()?;
    let scope = ContainedProcessLease::attach(&child)?;
    let result = tokio::time::timeout(timeout, async {
        while scope.active_processes()? != 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("managed Pi runtime command timed out")
    .and_then(|result| result);
    scope.terminate_and_wait().context(UnverifiedProcessDrain)?;
    drop(scope);
    let status = child.wait().await?;
    result?;
    ensure!(
        status.success(),
        "managed Pi runtime command failed: {status}"
    );
    Ok(())
}

fn valid_initialize_response(value: &serde_json::Value) -> bool {
    value.get("id").and_then(|id| id.as_u64()) == Some(1)
        && value.get("error").is_none()
        && value
            .pointer("/result/protocolVersion")
            .and_then(|v| v.as_u64())
            == Some(1)
}

/// Load engine modules and create an isolated local ACP session. No prompt or
/// provider request is sent by this probe.
async fn validate(prefix: &Path) -> Result<()> {
    let versions = accepted_versions(prefix).with_context(|| {
        format!("managed Pi runtime is incomplete or older than {PI_PACKAGE}@{PI_VERSION} / {BRIDGE_PACKAGE}@{BRIDGE_VERSION}")
    })?;
    // `providers/all` is the surface the OAuth login bridge (`pi_oauth_login.mjs`)
    // drives, so an engine update that moves it is rejected here, not at sign-in.
    let mut imports = tokio::process::Command::new(tool("bun")?);
    imports.args(["-e", "await import('@earendil-works/pi-ai'); await import('@earendil-works/pi-coding-agent'); const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all'); if (typeof builtinProviders !== 'function') throw new Error('builtinProviders missing');"])
        .current_dir(prefix).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .kill_on_drop(true).no_window();
    checked_status(&mut imports, PROBE_TIMEOUT).await?;
    #[cfg(windows)]
    let mut launcher = tokio::process::Command::new(prefix.join("node_modules/.bin/pi.exe"));
    #[cfg(not(windows))]
    let mut launcher = tokio::process::Command::new(pi_launcher(prefix));
    launcher
        .arg("--version")
        .current_dir(prefix)
        .env("PI_CODING_AGENT_DIR", prefix.join("probe-config"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window();
    prepare_command(&mut launcher);
    let mut child = launcher.spawn()?;
    let output = child.stdout.take().context("missing Pi version output")?;
    let scope = ContainedProcessLease::attach(&child)?;
    let launch_result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(
            &mut tokio::io::AsyncReadExt::take(output, 65537),
            &mut bytes,
        )
        .await?;
        ensure!(bytes.len() <= 65536, "oversized Pi version output");
        ensure!(
            String::from_utf8(bytes)?
                .split_whitespace()
                .any(|part| part.trim_start_matches('v') == versions.pi),
            "managed Pi launcher reports a different dependency version"
        );
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("managed Pi launcher validation timed out")
    .and_then(|result| result);
    scope.terminate_and_wait().context(UnverifiedProcessDrain)?;
    drop(scope);
    let status = child.wait().await?;
    launch_result?;
    ensure!(status.success(), "managed Pi launcher failed");
    check_shipped_extensions(prefix).await?;
    let probe_dir = tempfile::Builder::new()
        .prefix(".ryu runtime probe ")
        .tempdir_in(prefix)?;
    let probe_config = probe_dir.path().join("config");
    std::fs::create_dir_all(&probe_config)?;
    std::fs::write(probe_config.join("models.json"), br#"{"providers":{"ryu-probe":{"baseUrl":"http://127.0.0.1:1","api":"openai-completions","apiKey":"not-a-credential","models":[{"id":"probe","name":"Local readiness probe","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":4096,"maxTokens":256}]}}}"#)?;
    std::fs::write(probe_config.join("settings.json"), br#"{"defaultProvider":"ryu-probe","defaultModel":"probe","quietStartup":true,"skills":["!**"]}"#)?;
    let mut command = tokio::process::Command::new(tool("node")?);
    command
        .arg(process_path_argument(&bridge_entry(prefix)))
        .current_dir(probe_dir.path())
        .env("PI_CODING_AGENT_DIR", process_path_argument(&probe_config))
        .env(
            "PI_ACP_PI_COMMAND",
            process_path_argument(&prefix.join("node_modules/.bin").join(if cfg!(windows) {
                "pi.cmd"
            } else {
                "pi"
            })),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window();
    prepare_command(&mut command);
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("missing ACP probe stdin")?;
    let output = child.stdout.take().context("missing ACP probe stdout")?;
    let scope = ContainedProcessLease::attach(&child)?;
    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{},\"clientInfo\":{\"name\":\"ryu-update-probe\",\"version\":\"1\"}}}\n").await?;
        input.flush().await?;
        let mut output = BufReader::new(output);
        let mut line = Vec::new();
        let mut wanted_id = 1;
        loop {
            line.clear();
            // ACP is newline framed; bound diagnostic/output memory as well as time.
            let count = tokio::io::AsyncReadExt::take(&mut output, 65537).read_until(b'\n', &mut line).await?;
            ensure!(count != 0 && line.len() <= 65536, "missing or oversized ACP initialization response");
            let response: serde_json::Value = serde_json::from_slice(&line)?;
            if response.get("id").and_then(|id| id.as_u64()) == Some(wanted_id) {
                if wanted_id == 1 {
                    ensure!(valid_initialize_response(&response), "managed ACP bridge initialization failed");
                    let request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":process_path_argument(probe_dir.path()),"mcpServers":[]}});
                    input.write_all(format!("{request}\n").as_bytes()).await?;
                    input.flush().await?;
                    wanted_id = 2;
                } else {
                    ensure!(response.get("error").is_none() && response.pointer("/result/sessionId").and_then(|id| id.as_str()).is_some_and(|id| !id.is_empty()), "managed Pi/ACP session readiness failed: {response}");
                    // EOF invokes the pinned bridge's dispose path, stopping Pi.
                    input.shutdown().await?;
                    drop(input);
                    return Ok::<(), anyhow::Error>(());
                }
            }
        }
    }).await.context("managed ACP bridge initialization timed out").and_then(|result| result);
    if let Err(error) = scope.terminate_and_wait().context(UnverifiedProcessDrain) {
        return Err(retain_unverified_directory(probe_dir, error));
    }
    drop(scope);
    let _ = child.wait().await?;
    result
}

/// Make sure a validated managed Pi generation is active.
///
/// `update == false` keeps any complete generation at or above the compiled
/// baseline and only installs when none exists. `update == true` resolves the
/// newest published engine and bridge and stages them unless the active
/// generation already holds that exact pair. A staged generation is published
/// only after [`validate`] passes, so a broken release leaves the previous
/// generation running.
/// Reject an engine that cannot load every Pi extension Ryu ships. An update
/// that removes or renames an extension API would otherwise only surface when a
/// conversation starts.
async fn check_shipped_extensions(prefix: &Path) -> Result<()> {
    check_extensions(prefix, crate::pi_config::shipped_pi_extensions()).await
}

async fn check_extensions(prefix: &Path, extensions: Vec<(String, &str)>) -> Result<()> {
    let probe_dir = tempfile::Builder::new()
        .prefix(".ryu extension probe ")
        .tempdir_in(prefix)?;
    let result = async {
        let root = probe_dir.path();
        let config = root.join("config");
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&config)?;
        std::fs::create_dir_all(&cwd)?;
        let mut files = Vec::new();
        for (index, (name, source)) in extensions.into_iter().enumerate() {
            let directory = root.join("extensions").join(index.to_string());
            std::fs::create_dir_all(&directory)?;
            let file = directory.join(name);
            std::fs::write(&file, source)?;
            files.push(process_path_argument(&file));
        }
        let script = root.join("probe.mjs");
        std::fs::write(&script, EXTENSION_PROBE)?;
        let mut command = tokio::process::Command::new(tool("node")?);
        command
            .arg(process_path_argument(&script))
            .arg(process_path_argument(&cwd))
            .arg(process_path_argument(&config))
            .args(files)
            .current_dir(root)
            .env("PI_CODING_AGENT_DIR", process_path_argument(&config))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .no_window();
        if let Err(error) = checked_status(&mut command, PROBE_TIMEOUT).await {
            let mut detail = std::fs::read_to_string(root.join("errors.txt")).unwrap_or_default();
            if detail.len() > EXTENSION_ERROR_LIMIT {
                let end = detail.floor_char_boundary(EXTENSION_ERROR_LIMIT);
                detail.truncate(end);
            }
            return Err(error.context(format!(
                "managed Pi cannot load Ryu's Pi extensions: {}",
                detail.trim()
            )));
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    result.map_err(|error| retain_unverified_directory(probe_dir, error))
}

pub async fn ensure_managed_pi(update: bool) -> Result<()> {
    static INSTALL: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _install = INSTALL
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let root = crate::paths::runtime_dir("pi");
    let generations = ryu_runtime_install::RuntimeGenerations::new(root.clone());
    let active = generations.active_dir()?;
    let mut current = accepted_versions(&active);
    // The top-level manifests can match while a transitive file is missing or
    // corrupt; a generation that fails readiness is repaired, not kept.
    if current.is_some() {
        match validate(&active).await {
            Ok(()) if !update => return Ok(()),
            Ok(()) => {}
            Err(error) => {
                tracing::warn!(error = %error, "managed Pi: active generation failed readiness; reinstalling");
                current = None;
            }
        }
    }
    // No usable generation (first install, or a damaged or outdated one being
    // repaired) must still end with a working agent.
    let must_install = !update || current.is_none();
    let target = match latest_versions().await {
        Ok(latest) => latest,
        Err(error) if must_install => {
            tracing::warn!(error = %error, "managed Pi: npm registry unavailable; installing the compiled baseline");
            RuntimeVersions::baseline()
        }
        Err(error) => return Err(error.context("resolve the latest managed Pi release")),
    };
    if current.as_ref() == Some(&target) {
        return Ok(());
    }
    match install_generation(&generations, &root, &target).await {
        Ok(()) => Ok(()),
        // A first install or repair must still yield a working agent when the
        // newest release fails readiness; an update keeps the active generation.
        Err(error) if must_install && target != RuntimeVersions::baseline() => {
            tracing::warn!(error = %error, versions = ?target, "managed Pi: newest release failed readiness; installing the compiled baseline");
            install_generation(&generations, &root, &RuntimeVersions::baseline()).await
        }
        Err(error) => Err(error),
    }
}

async fn install_generation(
    generations: &ryu_runtime_install::RuntimeGenerations,
    root: &Path,
    target: &RuntimeVersions,
) -> Result<()> {
    let staged = generations.stage()?;
    let prefix = staged.path();
    let prepared = async {
        std::fs::write(
            prefix.join("package.json"),
            br#"{"name":"ryu-managed-pi","private":true,"type":"module"}"#,
        )?;
        // Hold transitive dependencies to the same release-age quarantine.
        std::fs::write(
            prefix.join("bunfig.toml"),
            format!(
                "[install]\nminimumReleaseAge = {}\n",
                MINIMUM_RELEASE_AGE.num_seconds()
            ),
        )?;
        let cache = root.join("package-cache");
        std::fs::create_dir_all(&cache)?;
        let mut install = tokio::process::Command::new(tool("bun")?);
        install
            .args(["add", "--exact"])
            .args(target.specs())
            .env("BUN_INSTALL_CACHE_DIR", cache)
            .current_dir(prefix)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .no_window();
        checked_status(&mut install, Duration::from_secs(180)).await?;
        std::fs::write(bridge_entry(prefix), scoped_bridge_source(prefix)?)?;
        #[cfg(windows)]
        if prefix.join("node_modules/.bin/pi.exe").is_file() {
            std::fs::write(
                prefix.join("node_modules/.bin/pi.cmd"),
                "@\"%~dp0pi.exe\" %*\r\n",
            )?;
        }
        ensure!(
            installed_versions(prefix).as_ref() == Some(target),
            "managed Pi install resolved different versions than requested"
        );
        validate(prefix).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = prepared {
        if error.downcast_ref::<UnverifiedProcessDrain>().is_none() {
            return Err(error);
        }
        // A descendant may still run from this generation; mark it so startup
        // pruning keeps it.
        return Err(match generations.retain_unverified(staged) {
            Ok(path) => error.context(format!(
                "managed Pi runtime data retained at {}",
                path.display()
            )),
            Err(mark) => error.context(format!(
                "could not mark retained managed Pi runtime: {mark:#}"
            )),
        });
    }
    generations.activate(staged)?;
    tracing::info!(pi = %target.pi, bridge = %target.bridge, "managed Pi: activated runtime generation");
    Ok(())
}

/// The newest settled engine and bridge, never below the compiled baseline.
/// This is exactly the pair an update installs, so update checks compare
/// against it rather than the unquarantined `latest` dist-tag.
pub async fn latest_versions() -> Result<RuntimeVersions> {
    let client = reqwest::Client::builder()
        .timeout(REGISTRY_TIMEOUT)
        .build()?;
    let (pi, bridge) = tokio::try_join!(
        settled_release(&client, PI_PACKAGE),
        settled_release(&client, BRIDGE_PACKAGE),
    )?;
    Ok(newest_of(pi, bridge))
}

async fn settled_release(client: &reqwest::Client, package: &str) -> Result<String> {
    let url = format!(
        "https://registry.npmjs.org/{}",
        urlencoding::encode(package)
    );
    let packument: serde_json::Value = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    newest_settled(&packument, chrono::Utc::now())
        .with_context(|| format!("{package} has no release older than the minimum release age"))
}

/// Newest stable, non-deprecated version published at least
/// [`MINIMUM_RELEASE_AGE`] before `now` and not above the `latest` dist-tag.
fn newest_settled(
    packument: &serde_json::Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let latest = semver::Version::parse(packument.pointer("/dist-tags/latest")?.as_str()?).ok()?;
    let times = packument.get("time")?.as_object()?;
    let versions = packument.get("versions")?.as_object()?;
    let cutoff = now - MINIMUM_RELEASE_AGE;
    versions
        .iter()
        .filter(|(_, manifest)| manifest.get("deprecated").is_none())
        .filter_map(|(raw, _)| {
            let version = semver::Version::parse(raw).ok()?;
            let published = times.get(raw)?.as_str()?;
            let published = chrono::DateTime::parse_from_rfc3339(published).ok()?;
            (version.pre.is_empty() && version <= latest && published <= cutoff).then_some(version)
        })
        .max()
        .map(|version| version.to_string())
}

fn newest_of(pi: String, bridge: String) -> RuntimeVersions {
    let pick = |published: String, floor: &str| {
        if version_at_least(&published, floor) {
            published
        } else {
            floor.to_owned()
        }
    };
    RuntimeVersions {
        pi: pick(pi, PI_VERSION),
        bridge: pick(bridge, BRIDGE_VERSION),
    }
}

/// Engine/bridge pair of the active generation, if one is complete.
pub fn active_versions() -> Option<RuntimeVersions> {
    let root = crate::paths::runtime_dir("pi");
    let active = ryu_runtime_install::RuntimeGenerations::new(root)
        .active_dir()
        .ok()?;
    installed_versions(&active)
}

/// Whether a managed Pi runtime was ever installed, complete or not.
fn runtime_present() -> bool {
    let root = crate::paths::runtime_dir("pi");
    root.join("active.json").exists() || root.join("node_modules").exists()
}

/// An installed runtime whose active generation is incomplete, damaged, or
/// below this build's baseline. The update action repairs it.
pub fn needs_repair() -> bool {
    runtime_present()
        && active_versions()
            .filter(RuntimeVersions::meets_baseline)
            .is_none()
}

fn auto_update_disabled() -> bool {
    std::env::var("RYU_PI_AUTO_UPDATE")
        .is_ok_and(|value| matches!(value.trim(), "0" | "off" | "false"))
}

/// Keep the managed Pi engine and its ACP bridge on their newest releases, the
/// way registry ACP bridges re-resolve `@latest` on every spawn. Only an
/// already-installed runtime is updated, or repaired when its active generation
/// is damaged; first install stays with onboarding.
pub fn spawn_auto_update() {
    if auto_update_disabled() {
        tracing::info!("managed Pi: auto-update disabled by RYU_PI_AUTO_UPDATE");
        return;
    }
    tokio::spawn(async {
        tokio::time::sleep(AUTO_UPDATE_DELAY).await;
        loop {
            if runtime_present() {
                if let Err(error) = ensure_managed_pi(true).await {
                    tracing::warn!(error = %format!("{error:#}"), "managed Pi: auto-update skipped; keeping the active runtime");
                }
            }
            tokio::time::sleep(AUTO_UPDATE_INTERVAL).await;
        }
    });
}

/// Remove generations that are neither active nor the rollback target. Run at
/// startup only, before any Pi process can hold a retired generation open.
pub fn prune_generations() {
    let root = crate::paths::runtime_dir("pi");
    match ryu_runtime_install::RuntimeGenerations::new(root).prune_inactive() {
        Ok(0) => {}
        Ok(removed) => tracing::info!(removed, "managed Pi: pruned inactive runtime generations"),
        Err(error) => {
            tracing::warn!(%error, "managed Pi: could not prune inactive runtime generations")
        }
    }
}

pub async fn initialize(nonce: Option<String>) -> Result<()> {
    let provisional = nonce.is_some();
    let _ = NONCE.set(nonce);
    if provisional {
        ensure_managed_pi(false).await?;
    }
    READY.store(true, Ordering::Release);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_typed_unverified_drain_errors_retain_owned_temporary_data() {
        let home = tempfile::tempdir().unwrap();
        for typed in [false, true] {
            let directory = tempfile::tempdir_in(home.path()).unwrap();
            let path = directory.path().to_owned();
            std::fs::write(path.join("partial-data"), "owned").unwrap();
            let error = anyhow::anyhow!("managed Pi runtime descendant drainage was not verified");
            let error = if typed {
                error
                    .context(UnverifiedProcessDrain)
                    .context("validation failed")
            } else {
                error
            };
            let error = retain_unverified_directory(directory, error);
            assert_eq!(path.exists(), typed);
            assert_eq!(
                error.downcast_ref::<UnverifiedProcessDrain>().is_some(),
                typed
            );
            if typed {
                assert_eq!(
                    std::fs::read_to_string(path.join("partial-data")).unwrap(),
                    "owned"
                );
                assert!(error.to_string().contains(path.to_string_lossy().as_ref()));
            }
        }
    }
    #[test]
    fn readiness_requires_successful_matching_acp_initialization() {
        assert!(valid_initialize_response(
            &serde_json::json!({"id":1,"result":{"protocolVersion":1}})
        ));
        for value in [
            serde_json::json!({"id":1,"error":{"code":-1}}),
            serde_json::json!({"id":2,"result":{"protocolVersion":1}}),
            serde_json::json!({"id":1,"result":{"protocolVersion":2}}),
        ] {
            assert!(!valid_initialize_response(&value));
        }
    }
    fn write_package(root: &Path, package: &str, version: &str) {
        let dir = root.join("node_modules").join(package);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_vec(&serde_json::json!({"name":package,"version":version})).unwrap(),
        )
        .unwrap();
    }

    fn write_patched_bridge_and_launcher(root: &Path) {
        let bridge = bridge_entry(root);
        std::fs::create_dir_all(bridge.parent().unwrap()).unwrap();
        std::fs::write(
            root.join("node_modules/pi-acp/dist/index.js"),
            BRIDGE_STORE_ORIGINAL,
        )
        .unwrap();
        std::fs::write(bridge, scoped_bridge_source(root).unwrap()).unwrap();
        std::fs::create_dir_all(pi_launcher(root).parent().unwrap()).unwrap();
        #[cfg(windows)]
        {
            std::fs::write(root.join("node_modules/.bin/pi.exe"), "").unwrap();
            std::fs::write(pi_launcher(root), b"@\"%~dp0pi.exe\" %*\r\n").unwrap();
        }
        #[cfg(not(windows))]
        std::fs::write(pi_launcher(root), "").unwrap();
    }

    #[test]
    fn incomplete_or_unversioned_packages_are_not_ready() {
        let root = tempfile::tempdir().unwrap();
        assert!(installed_versions(root.path()).is_none());
        write_package(root.path(), BRIDGE_PACKAGE, "latest");
        assert!(installed_package_version(root.path(), BRIDGE_PACKAGE).is_none());
        write_package(root.path(), "@earendil-works/pi-ai", PI_VERSION);
        assert!(installed_package_version(root.path(), PI_PACKAGE).is_none());
    }

    #[test]
    fn complete_generation_reports_its_versions_and_enforces_the_baseline() {
        let root = tempfile::tempdir().unwrap();
        write_package(root.path(), PI_PACKAGE, PI_VERSION);
        write_package(root.path(), BRIDGE_PACKAGE, BRIDGE_VERSION);
        assert!(
            installed_versions(root.path()).is_none(),
            "missing bridge launcher cannot pass"
        );
        write_patched_bridge_and_launcher(root.path());
        assert_eq!(
            accepted_versions(root.path()),
            Some(RuntimeVersions::baseline())
        );
        // A newer engine than the baseline is accepted as-is.
        write_package(root.path(), PI_PACKAGE, "99.0.0");
        assert_eq!(accepted_versions(root.path()).unwrap().pi, "99.0.0");
        // A generation left over from an older build must be replaced.
        write_package(root.path(), PI_PACKAGE, "0.84.4");
        assert!(installed_versions(root.path()).is_some());
        assert!(accepted_versions(root.path()).is_none());
    }

    #[test]
    fn baseline_specs_name_both_packages_exactly() {
        assert_eq!(
            RuntimeVersions::baseline().specs(),
            [
                format!("{PI_PACKAGE}@{PI_VERSION}"),
                format!("{BRIDGE_PACKAGE}@{BRIDGE_VERSION}"),
            ]
        );
    }

    #[test]
    fn only_settled_stable_releases_up_to_latest_are_eligible() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-08T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let packument = serde_json::json!({
            "dist-tags": {"latest": "1.2.0"},
            "versions": {
                "1.0.0": {},
                "1.1.0": {},
                "1.1.1": {"deprecated": "broken"},
                "1.2.0": {},
                "2.0.0-beta.1": {},
                "3.0.0": {}
            },
            "time": {
                "created": "2026-01-01T00:00:00Z",
                "1.0.0": "2026-09-01T00:00:00Z",
                "1.1.0": "2026-09-30T00:00:00Z",
                "1.1.1": "2026-09-30T06:00:00Z",
                "1.2.0": "2026-10-07T00:00:00Z",
                "2.0.0-beta.1": "2026-09-01T00:00:00Z",
                "3.0.0": "2026-09-01T00:00:00Z"
            }
        });
        assert_eq!(newest_settled(&packument, now).as_deref(), Some("1.1.0"));
        let later = now + chrono::TimeDelta::days(7);
        assert_eq!(newest_settled(&packument, later).as_deref(), Some("1.2.0"));
        let early = chrono::DateTime::parse_from_rfc3339("2026-09-02T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(newest_settled(&packument, early), None);
    }

    #[test]
    fn registry_versions_never_go_below_the_baseline() {
        assert_eq!(
            newest_of("99.1.0".into(), "0.9.0".into()),
            RuntimeVersions {
                pi: "99.1.0".into(),
                bridge: "0.9.0".into()
            }
        );
        assert_eq!(
            newest_of("0.1.0".into(), "not-a-version".into()),
            RuntimeVersions::baseline()
        );
    }

    #[test]
    fn relative_root_discovery_is_absolute() {
        assert_eq!(
            absolute_root(PathBuf::from("pi-override")).unwrap(),
            std::env::current_dir().unwrap().join("pi-override")
        );
    }

    #[tokio::test]
    #[ignore = "downloads pinned packages and starts real local Pi/ACP probes"]
    async fn real_pinned_generation_validates_existing_and_rejects_corruption() {
        let root = tempfile::Builder::new()
            .prefix("ryu profile with spaces ")
            .tempdir()
            .unwrap();
        let previous = std::env::var_os("RYU_DIR");
        std::env::set_var("RYU_DIR", root.path());
        let result = async {
            ensure_managed_pi(false).await?;
            let store = ryu_runtime_install::RuntimeGenerations::new(root.path().join("pi"));
            let first = store.active_dir()?;
            validate(&first).await?;
            ensure_managed_pi(false).await?;
            ensure!(store.active_dir()? == first, "existing validated generation should be reused");
            let bridge_metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(first.join("node_modules/pi-acp/package.json"))?)?;
            ensure!(bridge_metadata["dependencies"].as_object().is_some_and(|deps| !deps.keys().any(|name| name.contains("pi-coding-agent"))), "bridge must use explicitly supplied Pi executable rather than its own engine");
            let launcher = pi_launcher(&first);
            let original = std::fs::read(&launcher)?;
            std::fs::write(&launcher, "broken launcher")?;
            ensure!(validate(&first).await.is_err(), "corrupt launcher must fail readiness");
            std::fs::write(&launcher, original)?;
            let ai = first.join("node_modules/@earendil-works/pi-ai");
            let missing = first.join("missing-pi-ai");
            std::fs::rename(&ai, &missing)?;
            ensure!(validate(&first).await.is_err(), "missing transitive module must fail readiness");
            std::fs::rename(&missing, &ai)?;
            validate(&first).await?;
            let shipped = crate::pi_config::shipped_pi_extensions();
            ensure!(shipped.len() >= 6, "every shipped Pi extension must be probed");
            let broken = check_extensions(
                &first,
                vec![("ryu-removed-api.ts".to_owned(), "export default function (pi) { pi.registerRemovedThing(); }")],
            )
            .await
            .expect_err("an extension using a missing Pi API must fail readiness");
            ensure!(
                format!("{broken:#}").contains("registerRemovedThing"),
                "extension load error must name the failure: {broken:#}"
            );
            println!("real managed runtime proof: engine={PI_VERSION}, bridge={BRIDGE_VERSION}; staged and existing generation accepted; corrupt launcher and missing pi-ai rejected; actual Pi --version, shipped extension load, broken extension rejection and ACP initialize/session-new passed; no provider/prompts; profile path contains spaces");
            Ok::<(), anyhow::Error>(())
        }.await;
        match previous {
            Some(value) => std::env::set_var("RYU_DIR", value),
            None => std::env::remove_var("RYU_DIR"),
        }
        // Keep the completed real artifact for manual inspection. A large
        // synchronous Windows teardown must not hide the test's terminal result.
        if result.is_ok() {
            let artifact = root.keep();
            println!(
                "real managed runtime artifact retained at {}",
                artifact.display()
            );
        }
        result.unwrap();
    }
}
