//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning: `install_agent_runtime` through `create_agent`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Actually fetch an agent's runtime (Zed-style), dispatched by how the agent is
/// distributed. Best-effort and non-fatal: every npx/uvx agent also self-fetches
/// on first spawn, so a failure here only costs a one-time first-run delay.
pub(in crate::server) async fn install_agent_runtime(
    entry: crate::sidecar::adapters::acp::AcpAgentEntry,
    downloads: crate::downloads::DownloadCenter,
) {
    use crate::sidecar::adapters::acp::{binary_in_path, AgentTransport};
    use crate::sidecar::agents;

    // Bots on Ryu's managed Pi need nothing extra: Core installs that Pi itself,
    // and warming the entry's display-only `pi-acp` command would fetch the
    // user's Pi instead.
    if crate::agents::runs_on_ryu_engine(&entry.id) {
        return;
    }

    // Already resolvable on PATH — nothing to fetch.
    if let Some(bin) = entry.detect_binary {
        if binary_in_path(bin) {
            return;
        }
    }

    let id = entry.id.clone();
    let result: anyhow::Result<()> = async {
        // Registry `binary` distribution — full archive under `~/.ryu/agents/<id>`.
        if let Some(dist) = entry.direct_archive.as_ref() {
            crate::sidecar::agents::acp_registry::ensure_direct_archive(dist, &downloads).await?;
            return Ok(());
        }
        // Per-platform GitHub-release binary agents (e.g. goose).
        if let Some(spec) = entry.archive_spec.as_ref() {
            agents::archive_agent::ensure_installed(spec, &downloads).await?;
            return Ok(());
        }
        // Native managed agents with dedicated installers/downloaders. ZeroClaw
        // fetches a GitHub-release binary through the download center so its
        // install shows real progress in the Agents tab (kind `agent`/name),
        // instead of only being added to the picker.
        match id.as_str() {
            // A subprocess installer (npm), so it registers as an indeterminate row
            // — the same id `/api/setup/openclaw/install` uses, so triggering the
            // install from the Agents tab and from the Engines tab shows ONE row
            // rather than two competing ones.
            //
            // Sharing the id shares the ROW, not the WORK: `register_indeterminate`
            // cannot hand a second caller the first one's result, so both futures
            // still run. `openclaw::installer::ensure_installed` therefore holds its
            // own install lock and re-checks the fast path under it.
            "openclaw" => {
                downloads
                    .register_indeterminate(
                        "agent:openclaw".to_string(),
                        crate::downloads::DownloadKind::Agent,
                        "OpenClaw".to_string(),
                        agents::openclaw::installer::ensure_installed(),
                    )
                    .await?;
                return Ok(());
            }
            "zeroclaw" => {
                agents::zeroclaw::ZeroClawDownloader::new()
                    .ensure_installed(&downloads)
                    .await?;
                return Ok(());
            }
            // Runs on Ryu's managed Pi, which Core installs itself; warming the
            // entry's display-only `pi-acp` command would fetch the user's Pi.
            crate::agents::jay_jr::AGENT_ID => return Ok(()),
            _ => {}
        }
        // Native entries without a downloader/package require their vendor
        // installation. Adding one to the picker does not install its runtime.
        if entry.detect_binary.is_some()
            && matches!(&entry.transport, AgentTransport::Acp { spawn_cmd } if npx_package_of(spawn_cmd).is_none())
            && entry.version_probe.as_ref().is_none_or(|probe| {
                probe.npm_package.is_none() && probe.bridge_npm_package.is_none()
            })
        {
            anyhow::bail!("manual runtime installation required: {}", entry.install_hint);
        }
        // npx self-fetching agents (claude/codex/gemini/pi, …): warm the cache.
        // uvx agents and OpenAI-compat servers self-fetch on first use.
        //
        // Tracked, one row per package: this leg is what the *majority* of catalog
        // agents install through, and it used to be completely invisible — the CLI
        // and its ACP bridge could be pulling ~100 MB through npm with an empty
        // Downloads page in front of the user.
        if let AgentTransport::Acp { spawn_cmd } = &entry.transport {
            if let Some(pkg) = npx_package_of(spawn_cmd) {
                let tagged = format!("{pkg}@latest");
                warm_npx_package_tracked(&downloads, &tagged, &npx_row_label(&tagged)).await;
            }
        }
        if let Some(probe) = entry.version_probe.as_ref() {
            if let Some(pkg) = probe.npm_package.as_deref() {
                let tagged = format!(
                    "{}@latest",
                    crate::sidecar::agents::acp_registry::npm_package_name(pkg)
                );
                warm_npx_package_tracked(&downloads, &tagged, &npx_row_label(&tagged)).await;
            }
            if let Some(bridge) = probe.bridge_npm_package.as_deref() {
                let tagged = format!(
                    "{}@latest",
                    crate::sidecar::agents::acp_registry::npm_package_name(bridge)
                );
                // Named as the bridge so the two rows are tellable apart — this is
                // the "downloading bridge AND agent" the user could not follow.
                let label = format!("{} (bridge)", npx_row_label(&tagged));
                warm_npx_package_tracked(&downloads, &tagged, &label).await;
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => tracing::info!(agent = %id, "agent runtime install complete"),
        Err(e) => tracing::warn!(
            agent = %id,
            error = %e,
            "agent runtime is not ready; follow the catalog installation instructions"
        ),
    }
}

/// Add a built-in agent to the installed set so it appears in the picker, and
/// kick off a background fetch of its runtime so it's ready before first chat.
/// The fetch is best-effort and non-blocking: registration succeeds immediately
/// and the npx/binary download continues after the response (npx agents also
/// self-fetch on first spawn, so a failure only costs a one-time first-run delay).
#[utoipa::path(
    post,
    path = "/api/agents/catalog/install",
    tag = "Agents",
    summary = "Install an agent or preview the runtime plan",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_agent_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<AgentCatalogAction>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }
    let Some(entry) = state
        .agents
        .entries
        .iter()
        .find(|e| e.id == body.id)
        .cloned()
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown agent id: {}", body.id) })),
        );
    };
    if !crate::fleet::is_agent_available(&body.id) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": format!("agent '{}' is blocked by organization policy", body.id)
            })),
        );
    }
    if body.dry_run {
        let installed = state
            .agent_store
            .installed_ids()
            .await
            .map(|ids| ids.contains(&body.id))
            .unwrap_or(false);
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "success": true,
                "dryRun": true,
                "action": "install",
                "id": body.id,
                "name": entry.name,
                "alreadyInstalled": installed,
                "wouldInstall": !installed,
                "writes": ["agent installed flag", "optional runtime files"],
            })),
        );
    }
    match state.agent_store.set_installed(&body.id, true).await {
        Ok(_) => {
            sync_builtin_agent_schedules(&body.id, true);
            let downloads = state.downloads.clone();
            tokio::spawn(install_agent_runtime(entry, downloads));
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "id": body.id, "installed": true })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Built-in bots that ship with schedules (Patrol) pause them when removed from
/// the catalog and resume them when added back. The installed flag is already
/// committed, so a scheduler write failure is logged rather than undoing it.
pub(in crate::server) fn sync_builtin_agent_schedules(agent_id: &str, installed: bool) {
    if !crate::agents::patrol::is_patrol(agent_id) {
        return;
    }
    if let Err(error) = crate::agents::patrol::sync_schedules_with_install(installed) {
        tracing::warn!(%error, installed, "could not update Patrol schedules");
    }
}

/// Remove a built-in agent from the installed set (hides it from the picker).
/// The flagship `ryu` cannot be removed.
#[utoipa::path(
    post,
    path = "/api/agents/catalog/uninstall",
    tag = "Agents",
    summary = "Uninstall a catalog agent or preview the removal",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn uninstall_agent_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<AgentCatalogAction>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UNINSTALL,
    )
    .await
    {
        return response;
    }
    if !state.agents.entries.iter().any(|e| e.id == body.id) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown agent id: {}", body.id) })),
        );
    }
    if body.dry_run {
        let installed = state
            .agent_store
            .installed_ids()
            .await
            .map(|ids| ids.contains(&body.id))
            .unwrap_or(false);
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "success": true,
                "dryRun": true,
                "action": "uninstall",
                "id": body.id,
                "alreadyInstalled": installed,
                "wouldUninstall": installed,
                "writes": ["agent installed flag"],
            })),
        );
    }
    match state.agent_store.set_installed(&body.id, false).await {
        Ok(_) => {
            sync_builtin_agent_schedules(&body.id, false);
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "id": body.id, "installed": false })),
            )
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/agents",
    tag = "Agents",
    summary = "Create an agent",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<CreateAgent>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.edit" })),
        );
    }
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name is required" })),
        );
    }
    match state.agent_store.create(input).await {
        Ok(record) => {
            let agent_id = record.id.clone();
            record_gateway_control_attributed(
                &state,
                "agent.create",
                &format!("agent:{agent_id}"),
                Some("initial agent configuration"),
                &caller,
                Some(&agent_id),
            )
            .await;
            let source = serde_json::to_string_pretty(&record).unwrap_or_default();
            (
                StatusCode::CREATED,
                Json(json!({ "agent": record, "source": source })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}
