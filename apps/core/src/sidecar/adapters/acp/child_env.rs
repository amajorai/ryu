use super::*;

/// Build the base environment for the managed Pi Ryu extension.
///
/// Caller, agent, conversation, and profile scopes are resolved server-side by
/// the ACP tool broker and are deliberately not duplicated as process-supplied
/// authorization fields. A per-session capability is added later, as a
/// structured stdio entry after Core selects the exact pooled ACP session.
/// Neither a node bearer nor a user JWT crosses this boundary.
pub(crate) fn pi_mcp_extension_env(
    _user_jwt: Option<&str>,
    _composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    _conversation_scope: Option<&[String]>,
    _host_conversation_id: Option<&str>,
) -> Vec<(String, String)> {
    vec![(
        "RYU_MCP_CORE_URL".to_owned(),
        crate::sidecar::gateway::core_self_url(),
    )]
}

/// Environment variable naming the only Pi tools a managed-Pi process may run,
/// comma-separated. Read by the shipped `ryu-plan.ts` extension, which narrows
/// Pi's active tool set to it at session start and refuses every other tool call
/// (Pi built-ins such as `bash`/`read`/`write`/`edit` and tools from plugin
/// extensions such as `Task` or `bash_background`). Absent = Pi's normal tools.
pub(crate) const PI_ACTIVE_TOOLS_ENV: &str = "RYU_PI_ACTIVE_TOOLS";

/// The `ryu-mcp.ts` proxy tools. Every call through them is brokered by Core and
/// checked against the agent's MCP allowlist, so they are the whole tool surface
/// of a managed-Pi agent that declares one.
pub(crate) const RYU_MCP_PI_TOOLS: [&str; 2] = ["ryu_call_tool", "ryu_list_tools"];

/// Whether a managed-Pi turn runs with only Ryu's brokered tools active.
///
/// An MCP allowlist names Ryu tools. Pi's own shell and file tools are not Ryu
/// tools, so a finite list (`Some(..)`, including an empty one) never grants them:
///
/// - a built-in that borrows the managed Pi under its own id (Jay Jr.) runs
///   without them;
/// - a public-agent turn (an anonymous visitor's request, whose allowlist is
///   already narrowed to read-only Ryu tools) runs without them on any agent;
/// - the flagship `ryu` on its owner's own turns keeps them. Its list has only
///   ever governed Ryu tools, and installs that predate the least-privilege
///   migration carry the migrated deny marker there, so reading that list as a
///   shell and file switch would strip the default agent's ability to work.
///
/// `None` (the `*` grant) never confines.
pub(crate) fn confines_managed_pi_tools(
    agent_id: &str,
    allowlist: Option<&[String]>,
    public_agent_turn: bool,
) -> bool {
    allowlist.is_some() && (public_agent_turn || agent_id != "ryu")
}

/// Confine a managed-Pi spawn to Ryu's brokered tools when
/// [`confines_managed_pi_tools`] says so; otherwise return it unchanged.
pub(crate) fn managed_pi_tool_scope(
    spawn_cmd: &str,
    agent_id: &str,
    allowlist: Option<&[String]>,
    public_agent_turn: bool,
) -> anyhow::Result<String> {
    if !confines_managed_pi_tools(agent_id, allowlist, public_agent_turn) {
        return Ok(spawn_cmd.to_owned());
    }
    acp_spawn_with_env(
        spawn_cmd,
        vec![(PI_ACTIVE_TOOLS_ENV.to_owned(), RYU_MCP_PI_TOOLS.join(","))],
    )
}

/// Keep the portable conversation identifier grammar bounded for server-side
/// ACP session and broker bindings.
pub(crate) fn is_safe_host_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) fn pi_session_env(host_conversation_id: Option<&str>) -> (String, String) {
    (
        "RYU_PI_HOST_CONVERSATION_ID".to_owned(),
        host_conversation_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ephemeral-{}", uuid::Uuid::new_v4().simple())),
    )
}

/// Give a Pi spawned on Core's own managed config dir the provider keys and
/// bearers its `auth.json` / `models.json` name only by `${RYU_PI_…}`
/// reference (`pi_config::secret_env`). Any other Pi (a user's own config dir,
/// a third-party agent) never receives them. Returns whether it applied.
pub(super) fn apply_managed_pi_secret_env(env: &mut Vec<EnvVariable>) -> bool {
    if !declares_managed_pi_config(env) {
        return false;
    }
    for (name, value) in crate::pi_config::secret_env::secret_env() {
        set_stdio_env(env, name, value);
    }
    true
}

fn declares_managed_pi_config(env: &[EnvVariable]) -> bool {
    let config_dir = crate::pi_config::config_dir();
    env.iter().any(|variable| {
        variable.name == "PI_CODING_AGENT_DIR" && PathBuf::from(&variable.value) == config_dir
    })
}

/// The part of a config-probe cache key that changes with the managed Pi's
/// secret environment, so a new or rotated key re-probes the models it
/// unlocks instead of serving the advertisement taken without it. A digest,
/// never the values.
pub(super) fn managed_pi_probe_context(spawn_cmd: &str) -> String {
    if !spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        return String::new();
    }
    format!(
        "\u{2}pi-secrets:{}",
        crate::pi_config::secret_env::fingerprint()
    )
}

pub(super) fn set_stdio_env(env: &mut Vec<EnvVariable>, name: String, value: String) {
    if is_unscoped_acp_bridge_credential(&name) {
        // Never forward the value, but keep a blank mask under this exact
        // spelling: ACP layers entries over Core's environment *at spawn*, so
        // a case variant Core acquires after this snapshot would otherwise be
        // inherited on case-sensitive platforms.
        if let Some(existing) = env.iter_mut().find(|entry| entry.name == name) {
            existing.value.clear();
        } else {
            env.push(EnvVariable::new(name, ""));
        }
        return;
    }
    if let Some(existing) = env
        .iter_mut()
        .find(|entry| entry.name.eq_ignore_ascii_case(&name))
    {
        existing.value = value;
    } else {
        env.push(EnvVariable::new(name, value));
    }
}

/// Bearers that used to authorize the managed-Pi HTTP extension are intentionally
/// never allowed into an ACP process environment. They are node-wide or user-wide,
/// not session-scoped, and this boundary has no broker that can safely attenuate
/// them for an agent process.
pub(super) const UNSCOPED_ACP_BRIDGE_CREDENTIALS: [&str; 15] = [
    "RYU_MCP_CORE_TOKEN",
    "RYU_MCP_USER_JWT",
    "RYU_TOKEN",
    "RYU_GATEWAY_TOKEN",
    "RYU_NODE_TOKEN",
    "RYU_USER_JWT",
    "X_RYU_USER_JWT",
    "GATEWAY_ADMIN_KEY",
    "GATEWAY_MASTER_KEY",
    "GATEWAY_CORE_RELAY_KEY",
    "GATEWAY_CORE_PROOF_KEY",
    "GATEWAY_RELAY_KEY",
    "RYU_GATEWAY_KEY",
    "RYU_GATEWAY_CORE_TOKEN",
    "RYU_GATEWAY_CORE_PROOF_KEY",
];

pub(super) fn is_unscoped_acp_bridge_credential(name: &str) -> bool {
    UNSCOPED_ACP_BRIDGE_CREDENTIALS
        .iter()
        .any(|credential| credential.eq_ignore_ascii_case(name))
}

/// ACP's stdio spec adds explicit values to the Core process environment; it
/// does not clear inherited values. Blank every Core-only Gateway secret so an
/// agent process cannot receive those values through `Command::env` inheritance.
fn mask_inherited_unscoped_credentials(env: &mut Vec<EnvVariable>) {
    for name in UNSCOPED_ACP_BRIDGE_CREDENTIALS {
        if let Some(entry) = env.iter_mut().find(|entry| entry.name == name) {
            entry.value.clear();
        } else {
            env.push(EnvVariable::new(name, ""));
        }
    }
}

pub(super) fn sanitize_acp_child_env(env: &mut Vec<EnvVariable>) {
    // Keep masks for inherited case variants too: removing an entry would let
    // the SDK inherit that spelling again on case-sensitive platforms.
    for entry in env.iter_mut() {
        if is_unscoped_acp_bridge_credential(&entry.name) {
            entry.value.clear();
        }
    }
    mask_inherited_unscoped_credentials(env);
}

/// ACP's stdio transport (`AcpAgent`, 0.11 and 3.x alike) adds configured
/// entries to the parent's complete environment; it has no `env_clear` switch. Recreate the same safe inherited
/// baseline used by Core's MCP stdio launcher, blank every other inherited name,
/// then restore only this agent's explicit configuration. This keeps PATH,
/// home, locale, platform runtime variables and explicit scoped credentials
/// available without exposing Core's ambient tokens, keys or deployment env.
pub(super) fn isolate_acp_child_env(env: &mut Vec<EnvVariable>) {
    let configured = std::mem::take(env);
    let inherited = std::env::vars_os()
        .filter_map(|(name, value)| {
            Some((
                name.into_string().ok()?,
                value.into_string().unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>();
    *env = isolated_acp_child_env(inherited, configured);
}

pub(super) fn isolated_acp_child_env(
    inherited: impl IntoIterator<Item = (String, String)>,
    configured: Vec<EnvVariable>,
) -> Vec<EnvVariable> {
    let inherited = inherited.into_iter().collect::<Vec<_>>();
    let safe = crate::sidecar::env_scrub::mcp_safe_env(inherited.clone())
        .into_iter()
        .map(|(name, value)| (name.to_ascii_uppercase(), value))
        .collect::<BTreeMap<_, _>>();
    let mut env = Vec::with_capacity(inherited.len() + configured.len());
    for (name, _) in inherited {
        let value = safe
            .get(&name.to_ascii_uppercase())
            .map(String::as_str)
            .unwrap_or_default();
        env.push(EnvVariable::new(name, value));
    }
    for entry in configured {
        // A credential spelling keeps its own blank entry. Merging it into a
        // case-insensitive match would drop the mask for that exact spelling,
        // which a case-sensitive platform could then inherit again.
        if is_unscoped_acp_bridge_credential(&entry.name) {
            if !env.iter().any(|existing| existing.name == entry.name) {
                env.push(EnvVariable::new(entry.name, ""));
            }
            continue;
        }
        set_stdio_env(&mut env, entry.name, entry.value);
    }
    sanitize_acp_child_env(&mut env);
    env
}

/// Serialize an ACP stdio configuration as JSON. ACP's structured transport
/// carries executable, argv, and environment separately, so values containing
/// shell metacharacters remain data and cannot alter process creation.
pub(crate) fn acp_stdio_spawn_json(
    name: &str,
    command: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
) -> anyhow::Result<String> {
    let mut variables = Vec::with_capacity(env.len());
    for (name, value) in env {
        set_stdio_env(&mut variables, name, value);
    }
    sanitize_acp_child_env(&mut variables);
    serde_json::to_string(&McpServer::Stdio(
        McpServerStdio::new(name, command).args(args).env(variables),
    ))
    .context("serializing structured ACP stdio configuration")
}

/// Parse an existing ACP spawn declaration and add environment values through
/// the ACP stdio structure. Legacy string commands are parsed once, but the
/// added values are never concatenated into that command string.
pub(crate) fn acp_spawn_with_env(
    spawn_cmd: &str,
    env: Vec<(String, String)>,
) -> anyhow::Result<String> {
    let agent = AcpSpawn::from_str(spawn_cmd)
        .map_err(|error| anyhow::anyhow!("ACP spawn parse: {error}"))?;
    let mut stdio = match agent.into_server() {
        McpServer::Stdio(stdio) => stdio,
        _ => anyhow::bail!("ACP spawn declaration is not a stdio process"),
    };
    sanitize_acp_child_env(&mut stdio.env);
    for (name, value) in env {
        set_stdio_env(&mut stdio.env, name, value);
    }
    serde_json::to_string(&McpServer::Stdio(stdio))
        .context("serializing structured ACP stdio configuration")
}

/// Pull `set NAME=VALUE&&` assignments out of a Windows `cmd /c` launcher's
/// arguments (the form [`claude_gateway_cmd`] emits there). Replacing that
/// launcher's program must not drop the Gateway environment it carried.
fn windows_cmd_set_env(stdio: &McpServerStdio) -> Vec<(String, String)> {
    let program = stdio
        .command
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_ascii_lowercase());
    if program.as_deref() != Some("cmd") {
        return Vec::new();
    }
    stdio
        .args
        .windows(2)
        .filter(|pair| pair[0].eq_ignore_ascii_case("set"))
        .filter_map(|pair| {
            let (name, value) = pair[1].strip_suffix("&&")?.split_once('=')?;
            Some((name.to_owned(), value.to_owned()))
        })
        .collect()
}

/// Apply a user's per-agent ACP launch settings to a resolved spawn
/// declaration (see [`crate::acp_agent_settings`]).
///
/// Environment Core already declared (Gateway URLs and credentials, managed
/// config homes) is never replaced by a user value. A replacement command drops
/// the default arguments but keeps that declared environment, including what a
/// Windows `cmd /c set …&&` launcher carried inline.
pub(crate) fn acp_spawn_with_overrides(
    spawn_cmd: &str,
    overrides: &crate::acp_agent_settings::LaunchOverrides,
    stable_name: Option<&str>,
) -> anyhow::Result<String> {
    let agent = AcpSpawn::from_str(spawn_cmd)
        .map_err(|error| anyhow::anyhow!("ACP spawn parse: {error}"))?;
    let mut stdio = match agent.into_server() {
        McpServer::Stdio(stdio) => stdio,
        _ => anyhow::bail!("ACP spawn declaration is not a stdio process"),
    };
    let inline = windows_cmd_set_env(&stdio);
    let declared = |stdio: &McpServerStdio, name: &str| {
        stdio
            .env
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case(name))
            || inline
                .iter()
                .any(|(inline, _)| inline.eq_ignore_ascii_case(name))
    };
    if let Some(command) = overrides.command.as_ref() {
        for (name, value) in &inline {
            if !declared_in_env(&stdio.env, name) {
                set_stdio_env(&mut stdio.env, name.clone(), value.clone());
            }
        }
        stdio.command = command.clone();
        stdio.args.clear();
    }
    stdio.args.extend(overrides.args.iter().cloned());
    for (name, value) in &overrides.env {
        if declared(&stdio, name) {
            tracing::debug!(
                name,
                "ACP agent setting ignored: Core manages this variable"
            );
            continue;
        }
        set_stdio_env(&mut stdio.env, name.clone(), value.clone());
    }
    if let Some(name) = stable_name {
        stdio.name = name.to_owned();
    }
    sanitize_acp_child_env(&mut stdio.env);
    serde_json::to_string(&McpServer::Stdio(stdio))
        .context("serializing structured ACP stdio configuration")
}

fn declared_in_env(env: &[EnvVariable], name: &str) -> bool {
    env.iter()
        .any(|entry| entry.name.eq_ignore_ascii_case(name))
}
