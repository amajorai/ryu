use super::*;

/// Apply the OS sandbox an agent about to spawn needs: the untrusted-workspace
/// profile when its folder is not trusted, the account-access profile when its
/// account access is limited, or both merged. Returns the stdio to launch and
/// an optional notice for the user's first turn.
///
/// An untrusted folder alone degrades to running unconfined with a notice when
/// the host cannot sandbox. Account access never does: a limited agent's
/// engine that cannot be confined is refused, except Ryu's own engine running
/// with only its brokered tools (see [`spawn_acp_task`]).
pub(super) async fn confine_for_agent(
    stdio: McpServerStdio,
    is_managed_pi: bool,
    is_claude_code: bool,
    trusted: bool,
    account: crate::agent_access::AccountConfinement,
    cwd: &Path,
    additional_directories: &[PathBuf],
) -> Result<(McpServerStdio, Option<String>), LaunchRefusal> {
    if trusted && !account.is_confined() {
        return Ok((stdio, None));
    }
    let keep = sandbox_keep_paths(&stdio, cwd, additional_directories, is_claude_code);
    let deny_keychain = account_denies_keychain(
        account,
        is_claude_code && crate::acp_agent_settings::stdio_launches_claude_code_acp(&stdio),
    );
    let account_masks =
        account_confinement_masks(account, dirs::home_dir().as_deref(), deny_keychain);
    // Ryu's own engine may run unsandboxed only with its shell and file tools
    // off; every other engine of a limited agent must be confined.
    // `is_managed_pi` is a substring test on the spawn command, so also require
    // the config dir to be one Core manages (its own, or a limited agent's): a
    // user's own Pi never loads the extension that narrows the tools.
    let account_fallback_allowed =
        is_managed_pi && pi_config_dir_is_managed(&stdio) && pi_runs_brokered_tools_only(&stdio);
    if !trusted {
        return confine_for_untrusted_workspace(
            stdio,
            is_managed_pi,
            &keep,
            account_masks,
            deny_keychain,
            account_fallback_allowed,
        )
        .await
        .map(|(stdio, notice)| (stdio, Some(notice)));
    }
    let masks = crate::agent_sandbox::keep_visible(account_masks.unwrap_or_default(), &keep);
    confine_account_access(
        stdio,
        masks,
        deny_keychain,
        crate::agent_sandbox::untrusted_support(),
        account_fallback_allowed,
    )
    .map(|stdio| (stdio, None))
}

/// Whether a confined agent's engine is denied the user's Keychain (macOS).
/// Every confined engine is, except Claude Code, recognised by the program
/// actually launched ([`crate::acp_agent_settings::launches_claude_code_acp`]),
/// never by a command line that merely mentions its adapter: on macOS it keeps its own
/// sign-in in the login Keychain, and Seatbelt cannot allow one item without
/// the rest, so denying it would sign the agent out. It reaches this point
/// only when its vendor is allowed
/// ([`crate::agent_access::self_called_provider_permitted`]), so it keeps the
/// Keychain with the sign-in. Codex, Gemini CLI, Kiro and Ryu's engine
/// normally sign in from files, so they lose it; one set to keep its sign-in
/// in the Keychain cannot sign in for a confined agent (fails closed).
pub(super) fn account_denies_keychain(
    account: crate::agent_access::AccountConfinement,
    is_claude_code: bool,
) -> bool {
    account.is_confined() && !is_claude_code
}

/// Rebuild a limited agent's own managed Pi config right before its Pi starts
/// ([`crate::pi_config::refresh_limited_agent_dir`]), when `stdio` reads one.
/// The sandbox keeps that folder visible and writable to the agent, so what
/// it wrote there from an earlier Pi must not load into this one.
pub(super) fn refresh_limited_pi_config(stdio: &McpServerStdio) -> anyhow::Result<()> {
    let root = crate::pi_config::limited_agents_root();
    for variable in stdio
        .env
        .iter()
        .filter(|variable| variable.name == "PI_CODING_AGENT_DIR")
    {
        let dir = Path::new(&variable.value);
        if dir.starts_with(&root) {
            crate::pi_config::refresh_limited_agent_dir(dir)?;
        }
    }
    Ok(())
}

/// What the account-access profile hides from a limited agent, in any folder,
/// before [`crate::agent_sandbox::keep_visible`] spares the engine's own
/// paths; `None` for an unconfined agent. All of Core's data; the user's
/// provider sign-ins when its providers are limited; the home credential
/// stores (SSH, cloud, package-registry and Git keys, browser profiles), which
/// are the user's accounts too, so a trusted folder does not expose them; the
/// Ryu Desktop's and Ryu Browser's data; and every limited agent's managed Pi
/// config, of which the agent's own is kept through its `PI_CODING_AGENT_DIR`.
/// With `deny_keychain` ([`account_denies_keychain`]), also the user's Keychain
/// files.
pub(super) fn account_confinement_masks(
    account: crate::agent_access::AccountConfinement,
    home: Option<&Path>,
    deny_keychain: bool,
) -> Option<Vec<PathBuf>> {
    if !account.is_confined() {
        return None;
    }
    let stores = account
        .hides_providers()
        .then(crate::agent_access::user_provider_stores);
    let mut masks =
        crate::agent_sandbox::account_restricted_masks(&crate::paths::ryu_dir(), stores.as_deref());
    masks.extend(crate::agent_sandbox::home_credential_masks(home));
    if deny_keychain {
        masks.extend(crate::agent_sandbox::keychain_masks(home));
    }
    masks.extend(crate::agent_sandbox::ryu_app_data_masks(
        &crate::agent_sandbox::ryu_app_data_roots(home),
    ));
    // Pi loads code from its config dir, so a confined agent sees only its
    // own, never another agent's.
    masks.push(crate::pi_config::limited_agents_root());
    masks.sort();
    masks.dedup();
    Some(masks)
}

/// The account-access profile alone (a trusted folder): hide `masks`, deny the
/// Keychain when `deny_keychain`, leave the network alone. `support` is
/// whether this host has the sandbox runner.
/// Without it, or when wrapping fails, the agent is refused, unless
/// `fallback_allowed` (Ryu's own engine on brokered tools only), which runs it
/// unconfined.
pub(super) fn confine_account_access(
    stdio: McpServerStdio,
    masks: Vec<PathBuf>,
    deny_keychain: bool,
    support: Result<(), String>,
    fallback_allowed: bool,
) -> Result<McpServerStdio, LaunchRefusal> {
    let refuse_or_fallback = |stdio: McpServerStdio, reason: String| {
        if fallback_allowed {
            tracing::warn!(%reason, "limited agent: running Ryu's engine unsandboxed with brokered tools only");
            Ok(stdio)
        } else {
            tracing::warn!(%reason, "limited agent: refusing an engine Ryu cannot sandbox");
            Err(LaunchRefusal::AccountAccess(reason))
        }
    };
    if let Err(reason) = support {
        return refuse_or_fallback(stdio, reason);
    }
    let profile = crate::agent_sandbox::UntrustedProfile {
        masks,
        loopback_ports: None,
        deny_keychain,
    };
    match crate::agent_sandbox::confine_stdio(stdio.clone(), &profile, None) {
        Ok(confined) => Ok(confined),
        Err(error) => refuse_or_fallback(stdio, format!("{error:#}")),
    }
}

/// Apply the untrusted-workspace OS profile to an agent about to spawn, and
/// describe what the user is getting. When this host cannot sandbox, the agent
/// runs unconfined and the notice says so (the untrusted-workspace permission
/// rules still apply), unless `account_masks` is set: an agent with limited
/// account access is then refused instead, or, for Ryu's own engine on
/// brokered tools only (`account_fallback_allowed`), run with that notice.
/// `deny_keychain` ([`account_denies_keychain`]) denies the Keychain too.
/// `Err(refusal)` when the agent must not start here
/// ([`untrusted_launch_refusal`]).
async fn confine_for_untrusted_workspace(
    stdio: McpServerStdio,
    is_managed_pi: bool,
    keep: &[PathBuf],
    account_masks: Option<Vec<PathBuf>>,
    deny_keychain: bool,
    account_fallback_allowed: bool,
) -> Result<(McpServerStdio, String), LaunchRefusal> {
    const PREFIX: &str =
        "This folder is not trusted, so Ryu keeps the agent asking before it runs \
                          commands and refuses modes that skip those prompts.";
    let account_limited = account_masks.is_some();
    // The host could not sandbox: an untrusted folder alone runs unconfined
    // with `notice`; a limited agent's engine is refused unless it is Ryu's
    // own engine on brokered tools only.
    let unconfined = |stdio: McpServerStdio, reason: String, notice: String| {
        if account_limited && !account_fallback_allowed {
            tracing::warn!(%reason, "limited agent: refusing an engine Ryu cannot sandbox");
            Err(LaunchRefusal::AccountAccess(reason))
        } else {
            Ok((stdio, notice))
        }
    };
    if let Err(reason) = crate::agent_sandbox::untrusted_support() {
        tracing::warn!(%reason, "untrusted workspace: agent sandbox unavailable on this host");
        let notice = format!(
            "{PREFIX} Ryu could not sandbox the agent on this computer ({reason}), so it can \
             read your files and use the network as you. Trust the folder only if you trust its code."
        );
        return unconfined(stdio, reason, notice);
    }
    if let Some(refusal) = untrusted_launch_refusal(&stdio) {
        tracing::warn!("untrusted workspace: refusing a package-runner agent launch");
        return Err(LaunchRefusal::Untrusted(refusal));
    }
    let home = dirs::home_dir();
    let mut masks = crate::agent_sandbox::home_credential_masks(home.as_deref());
    masks.extend(crate::agent_sandbox::ryu_app_data_masks(
        &crate::agent_sandbox::ryu_app_data_roots(home.as_deref()),
    ));
    let mut core = crate::agent_sandbox::untrusted_core_masks(&crate::paths::ryu_dir());
    core.extend(account_masks.unwrap_or_default());
    masks.extend(crate::agent_sandbox::keep_visible(core, keep));
    masks.sort();
    masks.dedup();
    let (loopback_ports, network_note) = if !stdio_targets_local_gateway(&stdio) {
        (
            None,
            " Its network stays open because it connects to its model provider directly instead \
             of through the Ryu Gateway.",
        )
    } else {
        let mut ports = Vec::new();
        ports.extend(loopback_port(
            &crate::sidecar::gateway::configured_gateway_url(),
        ));
        if is_managed_pi || stdio_targets_inference_proxy(&stdio) {
            ports.extend(loopback_port(&crate::sidecar::gateway::core_self_url()));
        }
        ports.sort_unstable();
        ports.dedup();
        (
            Some(ports),
            " It can only reach the network through the Ryu Gateway, so web fetches and \
             sign-in refreshes from the agent itself will fail.",
        )
    };
    let profile = crate::agent_sandbox::UntrustedProfile {
        masks,
        loopback_ports,
        deny_keychain,
    };

    #[cfg(unix)]
    let relay_dir = match profile.loopback_ports.as_deref() {
        Some(ports) if !ports.is_empty() => {
            let prepared = async {
                let dir = crate::agent_sandbox::relay_dir()?;
                for port in ports {
                    crate::agent_sandbox::ensure_loopback_relay(&dir, *port).await?;
                }
                anyhow::Ok(dir)
            }
            .await;
            match prepared {
                Ok(dir) => Some(dir),
                Err(error) => {
                    tracing::warn!(%error, "untrusted workspace: agent network relay unavailable");
                    let notice = format!(
                        "{PREFIX} Ryu could not set up the agent's sandboxed network ({error:#}), \
                         so it runs without a sandbox."
                    );
                    return unconfined(stdio, format!("{error:#}"), notice);
                }
            }
        }
        _ => None,
    };
    #[cfg(not(unix))]
    let relay_dir: Option<PathBuf> = None;

    match crate::agent_sandbox::confine_stdio(stdio.clone(), &profile, relay_dir.as_deref()) {
        Ok(confined) => Ok((
            confined,
            format!(
                "{PREFIX} The agent runs in a sandbox that hides your SSH keys, cloud and package \
                 credentials, browser profiles, and Ryu's own data.{network_note} Trust the folder \
                 to lift these limits."
            ),
        )),
        Err(error) => {
            tracing::warn!(%error, "untrusted workspace: could not confine the agent");
            let notice = format!(
                "{PREFIX} Ryu could not sandbox the agent ({error:#}), so it runs without one."
            );
            unconfined(stdio, format!("{error:#}"), notice)
        }
    }
}
