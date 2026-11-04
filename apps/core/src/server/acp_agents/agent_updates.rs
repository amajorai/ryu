//! ACP agent config, accounts, sessions, updates and capability overrides: `agent_update_check` through `npm_install_agent_package`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/agents/:id/update-check` — the agent runtime's installed vs latest
/// version, mirroring the engine catalog's update check but per agent. Installed
/// version is tracked for the managed Pi (`ryu`); npx-fetched agents report a
/// latest only (npx caches globally, so there is no persisted installed version).
#[utoipa::path(
    get,
    path = "/api/agents/{id}/update-check",
    tag = "Agents",
    summary = "Check an agent runtime for updates",
    params(("id" = String, Path, description = "Agent id")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn agent_update_check(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let entry = match run_after_agent_resource_permission(
        enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            &agent_id,
        ),
        async { state.agents.find_by_prefix(&agent_id).cloned() },
    )
    .await
    {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    let probe = entry.as_ref().and_then(|e| e.version_probe.clone());
    let bridge_npm_package = probe.as_ref().and_then(|p| p.bridge_npm_package.clone());
    // `agent_npm_package` parses the SPAWN command, so for an ACP agent it yields
    // the bridge (`@zed-industries/claude-code-acp`), not the CLI the version
    // below is probed from (`claude`). Comparing one against the other reported a
    // permanent, unclearable update — the two packages version independently and
    // are never equal. The CLI's own package is the only correct `latest` source.
    let cli_npm_package = if agent_id == "ryu" {
        agent_npm_package(&state, &agent_id).await
    } else {
        probe.as_ref().and_then(|p| p.npm_package.clone())
    };
    let installed = if agent_id == "ryu" {
        crate::sidecar::adapters::acp::read_managed_pi_version()
    } else {
        match probe.as_ref().and_then(|p| p.binary) {
            Some(bin) if crate::sidecar::adapters::acp::binary_in_path(bin) => {
                crate::sidecar::adapters::acp::probe_cli_version_cached(bin).await
            }
            _ => None,
        }
    };
    // The managed Pi update installs the newest *settled* pair (the seven-day
    // release-age quarantine), so it is compared against that pair, never the
    // raw `latest` dist-tag an update would not move to.
    let managed_target = if agent_id == "ryu" {
        crate::required_update_runtime::latest_versions().await.ok()
    } else {
        None
    };
    let latest = match (agent_id == "ryu", cli_npm_package.as_deref()) {
        (true, _) => managed_target.as_ref().map(|target| target.pi.clone()),
        (false, Some(pkg)) => resolve_npm_latest_for_agent(&state.catalog, pkg).await,
        (false, None) => None,
    };
    // The managed Pi's bridge is installed beside the engine (not npx-fetched),
    // so its installed side is read from the active runtime generation.
    let managed_bridge = (agent_id == "ryu")
        .then(|| crate::required_update_runtime::active_versions().map(|versions| versions.bridge));
    let bridge_npm_package = if managed_bridge.is_some() {
        Some(crate::required_update_runtime::BRIDGE_PACKAGE.to_owned())
    } else {
        bridge_npm_package
    };
    let installed_bridge = match (managed_bridge.clone(), bridge_npm_package.as_deref()) {
        (Some(installed), _) => installed,
        (None, Some(pkg)) => probe_npx_package_version(pkg).await,
        (None, None) => None,
    };
    let latest_bridge = match (managed_bridge.is_some(), bridge_npm_package.as_deref()) {
        (true, _) => managed_target.as_ref().map(|target| target.bridge.clone()),
        (false, Some(pkg)) => resolve_npm_latest_for_agent(&state.catalog, pkg).await,
        (false, None) => entry.as_ref().and_then(|e| e.bridge_version.clone()),
    };
    // Semver-ordered, exactly like the catalog's `version_status`, so this row and
    // the Downloads row can never disagree. A raw `!=` also called a DOWNGRADE an
    // update, and called two unparseable strings an update forever.
    //
    // The bridge pair is reported for information but deliberately does NOT arm the
    // flag: the bridge is spawned as `npx -y <pkg>@latest`, so npx re-resolves it on
    // every launch and it cannot be behind. Its "installed" side is itself a
    // `@latest` probe, so comparing the two measures only the skew between that live
    // resolve and Core's cached npm latest — an update nothing could apply.
    // The managed Pi's bridge is the exception: it updates with the engine, so a
    // behind bridge is an update the `ryu` action really applies, and so is a
    // damaged or outdated managed generation the action repairs.
    let update_available = agent_version_status(installed.as_deref(), latest.as_deref())
        == Some("behind_latest")
        || (managed_bridge.is_some()
            && (crate::required_update_runtime::needs_repair()
                || agent_version_status(installed_bridge.as_deref(), latest_bridge.as_deref())
                    == Some("behind_latest")));
    Json(json!({
        "id": agent_id,
        "npmPackage": cli_npm_package,
        "bridgeNpmPackage": bridge_npm_package,
        "installedVersion": installed,
        "latestVersion": latest,
        "installedBridgeVersion": installed_bridge,
        "latestBridgeVersion": latest_bridge,
        "updateAvailable": update_available,
    }))
    .into_response()
}

/// How an on-PATH agent CLI was installed, which is what decides whether Ryu can
/// upgrade it in place.
pub(in crate::server) enum AgentInstallChannel {
    /// Under `<data dir>/runtimes/npm` — Core installed it with `npm install --prefix`.
    RyuPrefix,
    /// A global npm install: `<prefix>/bin/x` symlinked into `lib/node_modules/…`.
    NpmGlobal,
    /// A vendor installer, homebrew, volta/mise, a curl script. Not ours to move;
    /// the resolved path is carried so the user is told where it actually lives.
    External(std::path::PathBuf),
}

pub(in crate::server) fn agent_install_channel(binary: &str) -> Option<AgentInstallChannel> {
    let real = crate::sidecar::adapters::acp::resolve_in_path(binary)?;
    if real.starts_with(crate::paths::runtime_dir("npm")) {
        return Some(AgentInstallChannel::RyuPrefix);
    }
    let component = |name: &str| {
        real.components()
            .any(|c| c.as_os_str() == std::ffi::OsStr::new(name))
    };
    // A homebrew formula that happens to ship a Node CLI lands in
    // `<prefix>/Cellar/<formula>/<ver>/libexec/lib/node_modules/…`, so the
    // node_modules test alone would claim it. `npm install -g` would then plant a
    // second copy in the same prefix's `lib/node_modules` and shadow brew's link —
    // two package managers fighting over one binary. Brew's is brew's to update.
    if component("Cellar") || component("Homebrew") {
        return Some(AgentInstallChannel::External(real));
    }
    if component("node_modules") {
        return Some(AgentInstallChannel::NpmGlobal);
    }
    Some(AgentInstallChannel::External(real))
}

/// `npm install <pkg>@latest`, globally or into a prefix. Mirrors the openclaw
/// installer's invocation; bounded so a wedged registry can't hold the request open.
pub(in crate::server) async fn npm_install_agent_package(
    pkg: &str,
    prefix: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let spec = format!("{pkg}@latest");
    let mut args: Vec<String> = vec!["install".to_owned()];
    match &prefix {
        Some(dir) => {
            args.push("--prefix".to_owned());
            args.push(dir.to_string_lossy().into_owned());
        }
        None => args.push("-g".to_owned()),
    }
    args.push(spec.clone());

    #[cfg(target_os = "windows")]
    let (prog, args) = ("cmd", {
        let mut wrapped = vec!["/c".to_owned(), "npm".to_owned()];
        wrapped.extend(args);
        wrapped
    });
    #[cfg(not(target_os = "windows"))]
    let (prog, args) = ("npm", args);

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        tokio::process::Command::new(prog)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_window()
            .output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("`npm install {spec}` timed out after 300s"))?
    .map_err(|e| anyhow::anyhow!("spawn npm: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        anyhow::bail!("`npm install {spec}` failed: {tail}");
    }
    Ok(())
}
