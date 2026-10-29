//! Pre-launch phases of [`spawn_acp_task`]: account capture, spawn-command
//! scoping, provider identity, and the pool-key inputs. Each phase that can
//! fail has already sent its `AcpEvent::Error`; `None` means the caller must
//! return its event receiver as-is.

use super::*;

/// Captures the conversation's native vendor account into the child environment.
pub(super) fn apply_native_account(
    spawn_cmd: &str,
    permission_scope_id: Option<&str>,
    agent_id: &str,
    environment: &mut Vec<(String, String)>,
    provider_account_identity_override: &mut Option<String>,
    events_tx: &mpsc::UnboundedSender<AcpEvent>,
) -> Option<()> {
    let native_capture =
        crate::pi_config::native_accounts::for_spawn(spawn_cmd).and_then(|native| {
            native
                .map(|native| native.capture_conversation(permission_scope_id, agent_id))
                .transpose()
        });
    match native_capture {
        Ok(Some(launch)) => {
            let captured = crate::pi_config::native_accounts::isolated_env(launch.env);
            environment.retain(|(name, _)| {
                !captured.contains_key(name)
                    && !crate::pi_config::native_accounts::is_vendor_auth_env(name)
            });
            environment.extend(captured);
            environment.push((
                "RYU_NATIVE_ACCOUNT_ID".into(),
                launch.affinity.account_id.clone(),
            ));
            environment.push((
                "RYU_NATIVE_ACCOUNT_IDENTITY".into(),
                launch.affinity.process_identity(),
            ));
            environment.sort();
            *provider_account_identity_override = Some(launch.affinity.process_identity());
        }
        Err(error) => {
            let _ = events_tx.send(AcpEvent::Error(AcpFailure {
                code: "native_account_required".into(),
                title: "Native account unavailable".into(),
                message: error.to_string(),
            }));
            return None;
        }
        Ok(None) => {}
    }
    Some(())
}

/// Limits the managed Pi's own tools; returns the scoped command and whether it is the managed Pi.
pub(super) fn scope_spawn_cmd(
    spawn_cmd: String,
    agent_id: &str,
    allowlist: Option<&[String]>,
    public_agent_turn: bool,
    account_confinement: &crate::agent_access::AccountConfinement,
    events_tx: &mpsc::UnboundedSender<AcpEvent>,
) -> Option<(String, bool)> {
    crate::acp_runtime::refresh_from_local_file();
    let is_managed_pi = is_managed_pi_extension(&spawn_cmd, agent_id);
    // A least-privilege built-in (Jay Jr.) or a public-agent turn must not keep
    // Pi's own shell and file tools just because it runs on the managed Pi.
    // Applied here, the single spawn choke point, before the pool key is derived
    // from the command.
    let spawn_cmd = if is_managed_pi {
        match managed_pi_tool_scope(&spawn_cmd, agent_id, allowlist, public_agent_turn) {
            Ok(command) => command,
            Err(error) => {
                let _ = events_tx.send(AcpEvent::Error(AcpFailure {
                    code: "pi_tool_scope".into(),
                    title: "Agent tools unavailable".into(),
                    message: format!("Could not limit this agent to its allowed tools: {error}"),
                }));
                return None;
            }
        }
    } else {
        spawn_cmd
    };
    // A limited agent's engine runs in the OS sandbox that hides the user's
    // provider sign-ins and Core's own data. On a host without one, Ryu's own
    // engine may still run, but only with its brokered tools (no shell or file
    // tool to read those stores); every other engine is refused at launch
    // (`confine_for_agent`).
    let spawn_cmd = if account_confinement.is_confined()
        && is_managed_pi
        && crate::agent_sandbox::untrusted_support().is_err()
    {
        match acp_spawn_with_env(
            &spawn_cmd,
            vec![(PI_ACTIVE_TOOLS_ENV.to_owned(), RYU_MCP_PI_TOOLS.join(","))],
        ) {
            Ok(command) => command,
            Err(error) => {
                let _ = events_tx.send(AcpEvent::Error(AcpFailure {
                    code: "pi_tool_scope".into(),
                    title: "Agent tools unavailable".into(),
                    message: format!("Could not limit this agent to its allowed tools: {error}"),
                }));
                return None;
            }
        }
    } else {
        spawn_cmd
    };
    Some((spawn_cmd, is_managed_pi))
}

/// Seals the direct managed Pi's session account into `RYU_PI_ACCOUNT_CAPTURE`.
pub(super) fn capture_pi_account(
    is_managed_pi: bool,
    spawn_cmd: &str,
    permission_scope_id: Option<&str>,
    agent_id: &str,
    environment: &mut Vec<(String, String)>,
    provider_account_identity_override: &mut Option<String>,
    events_tx: &mpsc::UnboundedSender<AcpEvent>,
) -> Option<()> {
    // Account custody metadata is generated here, never accepted from an agent's
    // supplied process environment. Only Ryu's own direct Pi directory qualifies.
    environment.retain(|(name, _)| name != "RYU_PI_ACCOUNT_CAPTURE");
    if is_managed_pi && is_direct_managed_pi_account_spawn(spawn_cmd) {
        let provider = crate::pi_config::current().provider;
        match crate::pi_config::session_accounts::capture(
            &provider,
            permission_scope_id,
            agent_id,
            provider_account_identity_override.as_deref(),
        ) {
            Ok(Some(captured)) => {
                *provider_account_identity_override = Some(captured.process_identity());
                // Secrets are resolved in the runtime immediately before launch.
                // This environment marker contains only sealed account metadata.
                match serde_json::to_string(&captured) {
                    Ok(value) => environment.push(("RYU_PI_ACCOUNT_CAPTURE".into(), value)),
                    Err(error) => {
                        let _ = events_tx.send(AcpEvent::Error(AcpFailure {
                            code: "pi_account_required".into(),
                            title: "Pi account unavailable".into(),
                            message: error.to_string(),
                        }));
                        return None;
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                let _ = events_tx.send(AcpEvent::Error(AcpFailure {
                    code: "pi_account_required".into(),
                    title: "Pi account unavailable".into(),
                    message: error.to_string(),
                }));
                return None;
            }
        }
    }
    Some(())
}

/// The turn's provider account identity, defaulting to the managed Pi's active account.
pub(super) fn resolve_provider_account_identity(
    is_managed_pi: bool,
    provider_account_identity_override: Option<String>,
) -> Option<String> {
    if is_managed_pi {
        provider_account_identity_override.or_else(|| {
            let pi_config = crate::pi_config::current();
            let account_id = crate::pi_config::list_provider_accounts(&pi_config.provider)
                .into_iter()
                .find(|account| account.active)
                .map(|account| account.account_id);
            Some(managed_pi_session_identity(
                &pi_config.provider,
                account_id.as_deref(),
            ))
        })
    } else {
        provider_account_identity_override
    }
}

/// Appends the generation, redeemed-bearer scope, workspace trust and sandbox to the key.
pub(super) fn extend_spawn_security_key(
    security_key: &mut String,
    conversation_generation: Option<&str>,
    inference: Option<&RedeemedInference>,
    cwd: &Path,
    additional_directories: &[PathBuf],
    account_confinement: &crate::agent_access::AccountConfinement,
) {
    security_key.push_str("\u{1}");
    security_key.push_str(conversation_generation.unwrap_or("unbound"));
    // The redeemed bearer's scope replaces the bearer in the key: different
    // agents, users, sessions or signing keys never share an instance.
    if let Some(redeemed) = inference {
        redeemed.extend_security_key(security_key);
    }
    // Workspace trust picks the instance's sandbox profile and permission
    // posture at spawn, so trusting or untrusting the folder must start a new
    // instance rather than reuse one launched under the other posture.
    security_key.push_str(
        if WorkspaceAutonomy::evaluate(cwd, additional_directories, false).trusted {
            "\u{1}workspace-trusted"
        } else {
            "\u{1}workspace-untrusted"
        },
    );
    // The account-access sandbox is also fixed at spawn.
    security_key.push('\u{1}');
    security_key.push_str(account_confinement.key());
}

/// The conversation, environment and workspace components of the pool key.
pub(super) struct PoolKeyParts {
    pub(super) conversation: String,
    pub(super) environment_key: String,
    pub(super) workspace_key: String,
}

/// Derives the conversation, environment and workspace pool-key components.
pub(super) fn pool_key_parts(
    permission_scope_id: Option<String>,
    conversation_generation: Option<&str>,
    environment: &[(String, String)],
    spawn_cmd: &str,
    additional_directories: &[PathBuf],
) -> PoolKeyParts {
    // One live subprocess/connection per CHAT, keyed by the conversation id (Ryu's
    // interactive-permission scope) — chats never share an instance. A message with
    // no conversation id runs an ephemeral, un-pooled instance that dies after the
    // turn. `is_closed()` detects an instance that hit its idle TTL or crashed, so
    // the chat's next message transparently respawns it (auto-restore).
    let conversation = if conversation_generation.is_some() {
        permission_scope_id.unwrap_or_default()
    } else {
        String::new()
    };
    let mut environment_key = environment
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\u{2}");
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        // A managed Pi receives provider keys and bearers in its environment
        // (`pi_config::secret_env`), fixed at spawn. When one changes, key the
        // pool on the new digest so the next turn respawns with current values.
        environment_key.push('\u{2}');
        environment_key.push_str(&crate::pi_config::secret_env::fingerprint());
    }
    let workspace_key = additional_directories
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("\u{2}");
    PoolKeyParts {
        conversation,
        environment_key,
        workspace_key,
    }
}
