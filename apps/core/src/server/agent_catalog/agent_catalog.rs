//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `list_agent_catalog` through `npx_row_label`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Mirrors the model/skills catalog shape (`GET /api/{models,skills}/catalog`).
#[utoipa::path(
    get,
    path = "/api/agents/catalog",
    params(AgentCatalogQuery),
    tag = "Agents",
    summary = "List the agent catalog (detected CLIs)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_agent_catalog(
    State(state): State<ServerState>,
    Query(params): Query<AgentCatalogQuery>,
) -> Json<serde_json::Value> {
    let registry = crate::registry::ProviderRegistry::load();
    let installed_set = state.agent_store.installed_ids().await.unwrap_or_default();
    let with_versions = params.with_versions();
    let tasks = state
        .agents
        .list_infos_with_default(&registry.default_agent_id)
        .into_iter()
        .map(|i| {
            let added = i.id == "ryu" || installed_set.contains(&i.id);
            let entry = state.agents.find_by_prefix(&i.id).cloned();
            let catalog = state.catalog.clone();
            tokio::spawn(async move {
                // `?versions=0` drops the version columns and, with them, every
                // network call this handler makes. See `AgentCatalogQuery`.
                let version_probe = if with_versions {
                    entry.as_ref().and_then(|e| e.version_probe.clone())
                } else {
                    None
                };
                let registry_id = entry.as_ref().and_then(|e| e.registry_id.clone());
                let registry_bridge_version = entry.as_ref().and_then(|e| e.bridge_version.clone());
                let icon_url = entry.as_ref().and_then(|e| e.icon_url.clone());
                // A registry agent with no host spawn plan is listed but not
                // one-click installable: its ACP transport carries an empty
                // spawn command. Non-ACP transports (OpenAI-compat) are always
                // available. Absent entries default to available.
                let runtime_available = entry.as_ref().is_none_or(|e| {
                    !matches!(
                        &e.transport,
                        crate::sidecar::adapters::acp::AgentTransport::Acp { spawn_cmd }
                            if spawn_cmd.trim().is_empty()
                    )
                });
                let policy_blocked = !crate::fleet::is_agent_available(&i.id);

                let (
                    installed_version,
                    latest_version,
                    installed_bridge_version,
                    latest_bridge_version,
                ) = match version_probe {
                    Some(probe) => {
                        let agent_installed = if i.installed == Some(true) {
                            match probe.binary {
                                Some(bin) => {
                                    crate::sidecar::adapters::acp::probe_cli_version_cached(bin)
                                        .await
                                }
                                None => None,
                            }
                        } else {
                            None
                        };
                        let agent_latest = match probe.npm_package.as_deref() {
                            Some(pkg) => resolve_npm_latest_for_agent(&catalog, pkg).await,
                            None => None,
                        };
                        // Catalog browsing must remain metadata-only. Probing a
                        // registry bridge here invokes `npx -y`, which can install
                        // and execute an unpinned package merely because a user
                        // opened the catalog. The update-check path retains the
                        // explicit probe for an installed agent; this browse path
                        // reports only the registry metadata.
                        let bridge_installed: Option<String> = None;
                        let bridge_latest = match probe.bridge_npm_package.as_deref() {
                            Some(pkg) => resolve_npm_latest_for_agent(&catalog, pkg).await,
                            None => registry_bridge_version.clone(),
                        };
                        (
                            agent_installed,
                            agent_latest,
                            bridge_installed,
                            bridge_latest,
                        )
                    }
                    None => (None, None, None, registry_bridge_version),
                };

                let version_status =
                    agent_version_status(installed_version.as_deref(), latest_version.as_deref());
                let bridge_version_status = agent_version_status(
                    installed_bridge_version.as_deref(),
                    latest_bridge_version.as_deref(),
                );
                json!({
                    "id": i.id,
                    "registry_id": registry_id,
                    "icon_url": icon_url,
                    "name": i.name,
                    "description": i.description,
                    "install_hint": i.install_hint,
                    "recommended": i.recommended,
                    "detected": i.installed,
                    "added": added,
                    "available": runtime_available && !policy_blocked,
                    "policy_blocked": policy_blocked,
                    "gateway_bypass": i.gateway_bypass,
                    "engine": i.engine,
                    "transport": i.transport,
                    "installed_version": installed_version,
                    "latest_version": latest_version,
                    "version_status": version_status,
                    "installed_bridge_version": installed_bridge_version,
                    "latest_bridge_version": latest_bridge_version,
                    "bridge_version_status": bridge_version_status,
                })
            })
        })
        .collect::<Vec<_>>();
    let mut agents = Vec::with_capacity(tasks.len());
    for task in tasks {
        if let Ok(agent) = task.await {
            agents.push(agent);
        }
    }
    Json(json!({ "agents": agents }))
}

pub(in crate::server) fn agent_version_status(
    current: Option<&str>,
    latest: Option<&str>,
) -> Option<&'static str> {
    let (Some(current), Some(latest)) = (current, latest) else {
        return current.or(latest).map(|_| "unknown");
    };
    let current = semver::Version::parse(current).ok()?;
    let latest = semver::Version::parse(latest).ok()?;
    Some(if current < latest {
        "behind_latest"
    } else {
        "current"
    })
}

pub(in crate::server) async fn resolve_npm_latest_for_agent(
    catalog: &crate::catalog::CatalogManager,
    package: &str,
) -> Option<String> {
    let package = crate::sidecar::agents::acp_registry::npm_package_name(package);
    catalog
        .npm_latest_cached(&format!("agent:npm:{package}"), &package)
        .await
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct AgentCatalogAction {
    pub(in crate::server) id: String,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// Extract the npm package from an `npx -y [--] <pkg> [args]` spawn command,
/// skipping env-var prefixes (`FOO=bar`), `npx` flags, and the `--` separator.
/// Returns `None` for non-npx commands (uvx self-fetch, managed binaries).
pub(in crate::server) fn npx_package_of(spawn_cmd: &str) -> Option<String> {
    let tokens: Vec<&str> = spawn_cmd.split_whitespace().collect();
    let npx_idx = tokens.iter().position(|t| *t == "npx")?;
    let raw = tokens.iter().skip(npx_idx + 1).find_map(|t| {
        if *t == "-y" || *t == "--yes" || *t == "--" || t.starts_with('-') {
            None
        } else {
            Some((*t).to_string())
        }
    })?;
    Some(crate::sidecar::agents::acp_registry::npm_package_name(&raw))
}

pub(in crate::server) async fn probe_npx_package_version(pkg: &str) -> Option<String> {
    let base = crate::sidecar::agents::acp_registry::npm_package_name(pkg);
    let spec = format!("{base}@latest");
    #[cfg(target_os = "windows")]
    let (prog, args): (&str, Vec<&str>) = ("cmd", vec!["/c", "npx", "-y", &spec, "--version"]);
    #[cfg(not(target_os = "windows"))]
    let (prog, args): (&str, Vec<&str>) = ("npx", vec!["-y", &spec, "--version"]);

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(prog)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_window()
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    crate::sidecar::adapters::acp::parse_cli_version(&combined)
}

/// Warm npx's cache for `pkg` so the package is downloaded and ready before the
/// first chat, mirroring Zed's `npm exec --yes`. We run a cheap `--version` so
/// npx fetches + caches the package without launching the long-lived ACP server;
/// a timeout bounds agents that ignore `--version` (the package is already
/// fetched by the time npx executes it, so the cache stays warm regardless).
pub(in crate::server) async fn warm_npx_package(pkg: &str) {
    #[cfg(target_os = "windows")]
    let (prog, args): (&str, Vec<&str>) = ("cmd", vec!["/c", "npx", "-y", pkg, "--version"]);
    #[cfg(not(target_os = "windows"))]
    let (prog, args): (&str, Vec<&str>) = ("npx", vec!["-y", pkg, "--version"]);

    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.no_window();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.status()).await;
}

/// [`warm_npx_package`], tracked as a row in the global download center.
///
/// The npx cache warm IS the install for every self-fetching agent (Claude Code,
/// Codex, Gemini, Pi and every ACP bridge), and it is the slow part — up to the
/// 180 s bound above, pulling tens of MB. Untracked, clicking Install in the store
/// or the composer's agent picker produced no row anywhere: the Downloads page and
/// the tray popover both stayed empty while npm downloaded, which is exactly the
/// "can't track it" report. Only the archive/binary legs (`ensure_direct_archive`,
/// `archive_agent`, ZeroClaw) ever showed up, because those fetch through
/// `download_blocking`.
///
/// One row PER PACKAGE, not per agent: an ACP agent is usually a CLI plus a
/// separate bridge package, and the user sees both being fetched. The id is the
/// package name so a re-install dedups onto the same row rather than stacking.
///
/// A subprocess reports no byte counts, so this is an INDETERMINATE task: it shows
/// active → done/failed and is cancelable (cancel drops the future, which kills the
/// child), without a progress bar.
pub(in crate::server) async fn warm_npx_package_tracked(
    downloads: &crate::downloads::DownloadCenter,
    pkg: &str,
    label: &str,
) {
    let _ = downloads
        .register_indeterminate(
            format!("npx:{pkg}"),
            crate::downloads::DownloadKind::Agent,
            label.to_string(),
            async {
                warm_npx_package(pkg).await;
                Ok(())
            },
        )
        .await;
}

/// The display name for an npx package row — the bare package name, without the
/// `@latest` the warm appends or the npm scope, which reads as noise in a list of
/// downloads ("`@zed-industries/claude-code-acp`" → "claude-code-acp").
pub(in crate::server) fn npx_row_label(pkg_with_tag: &str) -> String {
    let base = pkg_with_tag
        .rsplit_once('@')
        .map(|(name, _tag)| name)
        .filter(|name| !name.is_empty())
        .unwrap_or(pkg_with_tag);
    base.rsplit('/').next().unwrap_or(base).to_string()
}
