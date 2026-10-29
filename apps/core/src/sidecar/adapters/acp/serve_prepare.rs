use super::*;

/// Values the start-up checks in [`prepare_instance`] resolve for the later phases.
pub(super) struct InstancePrep {
    pub(super) bridge_spawn_cmd: String,
    pub(super) is_claude_code: bool,
    pub(super) workspace_autonomy: WorkspaceAutonomy,
    pub(super) is_managed_pi: bool,
    pub(super) captured_pi_account: Option<crate::pi_config::session_accounts::SessionAccount>,
    pub(super) projection: Option<crate::pi_config::session_accounts::ProjectionLease>,
}

/// Account checks, tool-access logging and managed-Pi materialization before spawn.
#[allow(clippy::ptr_arg)]
pub(super) async fn prepare_instance(
    spawn_cmd: &String,
    cwd: &PathBuf,
    additional_directories: &Vec<PathBuf>,
    environment: &[(String, String)],
) -> anyhow::Result<InstancePrep> {
    let account_failure = |code: &str, title: &str| {
        let code = code.to_owned();
        let title = title.to_owned();
        move |error: anyhow::Error| {
            let message = format!("{error:#}");
            error.context(AcpFailure {
                code: code.clone(),
                title: title.clone(),
                message,
            })
        }
    };
    let native = crate::pi_config::native_accounts::for_spawn(&spawn_cmd)?;
    async {
        if let Some(native) = native {
            let account_id = environment
                .iter()
                .find(|(key, _)| key == "RYU_NATIVE_ACCOUNT_ID")
                .map(|(_, value)| value)
                .ok_or_else(|| anyhow::anyhow!("Native account capture missing"))?;
            let identity = environment
                .iter()
                .find(|(key, _)| key == "RYU_NATIVE_ACCOUNT_IDENTITY")
                .map(|(_, value)| value)
                .ok_or_else(|| anyhow::anyhow!("Native account identity capture missing"))?;
            let captured = native.capture(account_id)?;
            if captured.affinity.process_identity() != *identity {
                anyhow::bail!("Native account changed before process launch");
            }
            native.verify_capture(&captured).await?;
        }
        anyhow::Ok(())
    }
    .await
    .map_err(account_failure(
        "native_account_required",
        "Native account unavailable",
    ))?;
    // The spawn command is consumed below (`AcpSpawn::from_str` then the move into
    // the session closure), but the bridge decision also needs it — and it must be
    // taken with BOTH halves in one place (`acp_tool_bridge_enabled`) so the
    // transport guard cannot be forgotten at this call site. One small clone per
    // pooled instance, i.e. once per chat, buys that.
    let bridge_spawn_cmd = spawn_cmd.clone();
    // Claude Code sessions get `claude_code_session_meta` (user-level settings only,
    // Ryu's MCP bridge only) via the `_meta.claudeCode.options` passthrough,
    // applied at `build_session_from` below.
    let is_claude_code = is_claude_code_spawn(&spawn_cmd);
    // Trust is read once per instance: it also picks the OS sandbox profile at
    // spawn, and it is part of the pool key, so a trust change respawns.
    let workspace_autonomy =
        WorkspaceAutonomy::evaluate(&cwd, &additional_directories, is_claude_code);
    // Which road (if any) Ryu's tools can take to this agent. Recorded once per
    // pooled instance — i.e. once per chat's subprocess — because until now the
    // `None` case was completely silent: an agent that structurally cannot reach a
    // single configured tool looked, from every log and every surface, exactly like
    // an agent that simply chose not to call one.
    let tool_access = ryu_tool_access(&spawn_cmd);
    match tool_access {
        RyuToolAccess::None => tracing::warn!(
            access = tool_access.as_str(),
            "ACP agent has NO access to Ryu tools: this is a pi-acp transport (which does not \
             honor session/new mcpServers) spawned WITHOUT Ryu's managed Pi config dir, so it \
             gets neither the MCP bridge nor the ryu-mcp Pi extension. Use the flagship `ryu` \
             agent for Ryu tools on Pi."
        ),
        _ => tracing::debug!(access = tool_access.as_str(), "ACP tool access"),
    }
    // The flagship managed `ryu` agent: pi-acp pointed at Ryu's ISOLATED config dir
    // (`PI_CODING_AGENT_DIR` → `~/.ryu/pi-agent`). Only this Pi reads the managed
    // `auth.json`, so it is the only agent whose subscription OAuth logins we
    // proactively refresh before a turn — never bare `acp:pi` (the user's own
    // `~/.pi`) or any other engine. Both platforms carry the `PI_CODING_AGENT_DIR`
    // substring (POSIX inline `VAR=…`, Windows `set VAR=…`), see `ryu_pi_acp_cmd`.
    //
    // Derived from `ryu_tool_access` rather than re-spelling the two substrings:
    // `PiExtension` IS "this is the managed Pi", and one predicate that two call
    // sites read cannot drift the way two copies of it can.
    let is_managed_pi = tool_access == RyuToolAccess::PiExtension;
    let pi_account_failure = account_failure("pi_account_required", "Pi account unavailable");
    let captured_pi_account = environment
        .iter()
        .find(|(name, _)| name == "RYU_PI_ACCOUNT_CAPTURE")
        .map(|(_, value)| {
            serde_json::from_str::<crate::pi_config::session_accounts::SessionAccount>(value)
        })
        .transpose()
        .map_err(|error| pi_account_failure(error.into()))?;
    if captured_pi_account.is_some() && !is_managed_pi {
        return Err(pi_account_failure(anyhow::anyhow!(
            "Pi account capture requires the managed Pi runtime"
        )));
    }

    // The per-session credential projection is removed when the last instance
    // using it ends, however it ends (see `SessionAccount::lease_projection`).
    // Taken before `prepare_turn` below writes it.
    let _projection = captured_pi_account
        .as_ref()
        .map(crate::pi_config::session_accounts::SessionAccount::lease_projection);

    if is_managed_pi {
        // Resolve every enabled plugin's `contributes.lsp_servers` and drop the
        // arbitrated table into the managed Pi config dir, where the Ryu-LSP
        // extension picks it up. It MUST happen here and not in `ryu_pi_acp_cmd`:
        // that function is sync and state-free by design, and the enabled-plugin
        // set only exists behind the published `ServerState`.
        //
        // Cadence: once per pooled instance, i.e. once per Pi process, which is
        // exactly when Pi reads its extensions. A live Pi cannot be told about a
        // new language server, so enabling an LSP-contributing plugin mid-chat
        // lands on the NEXT spawn for that chat — matching Claude Code, where
        // servers are likewise read at startup. Do not move this into the per-turn
        // loop below to "fix" that; there is nothing to send that would make a
        // running Pi re-read, so it would be pure disk churn.
        crate::lsp::ensure_lsp_servers_materialized().await;

        // Same cadence, same argument, one directory over: project every enabled
        // plugin's `contributes.pi_extensions` onto the managed Pi's `extensions/`
        // folder, adding what is enabled and DELETING what is not. The removal half
        // is why it is a reconcile and not an enable hook — Pi auto-discovers that
        // folder, so an uninstalled plugin's file would otherwise keep loading
        // forever.
        crate::pi_config::app_extensions::ensure_pi_extensions_materialized().await;
        if let Some(captured) = captured_pi_account.as_ref() {
            // A revoked OAuth refresh fails here on the first message of a chat
            // and after an idle respawn; the per-turn refresh below reports the
            // same code.
            async {
                captured.materialize_assets()?;
                captured.prepare_turn().await
            }
            .await
            .map_err(&pi_account_failure)?;
        }
    }
    Ok(InstancePrep {
        bridge_spawn_cmd,
        is_claude_code,
        workspace_autonomy,
        is_managed_pi,
        captured_pi_account,
        projection: _projection,
    })
}
