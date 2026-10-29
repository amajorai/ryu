use super::*;

/// A fresh context request is deliberately unpooled even when it has a normal
/// conversation id. The id remains on [`AcpTurn`] so permissions/cancellation
/// stay scoped to the same chat while the model receives no prior ACP session.
pub(super) fn should_reuse_acp_session(conversation: &str, fresh_session: bool) -> bool {
    !conversation.is_empty() && !fresh_session
}

/// Stable, explicit fingerprint for the security context captured by a pooled
/// ACP session. `None` and `Some([])` remain distinct because the former means
/// "use the default allowlist" while the latter means "offer no tools".
pub(super) fn acp_security_key(
    mcp: &Option<Arc<McpRegistry>>,
    allowlist: &Option<Vec<String>>,
    composio_actions: &[String],
    agent_id: &str,
    identity_profile_ids: &[String],
    composio_connection_scope: &Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    conversation_scope: &Option<Vec<String>>,
    permission_scope_id: &Option<String>,
    tool_authority_fingerprint: Option<[u8; 32]>,
    provider_account_identity: Option<&str>,
) -> String {
    let mut allowlist = allowlist.clone();
    if let Some(values) = allowlist.as_mut() {
        values.sort();
    }
    let mut composio_actions = composio_actions.to_vec();
    composio_actions.sort();
    let mut identity_profile_ids = identity_profile_ids.to_vec();
    identity_profile_ids.sort();
    let mut composio_connection_scope = composio_connection_scope.clone();
    if let Some(values) = composio_connection_scope.as_mut() {
        values.sort_by(|left, right| {
            left.toolkit
                .cmp(&right.toolkit)
                .then(left.id.cmp(&right.id))
        });
    }
    let mut conversation_scope = conversation_scope.clone();
    if let Some(values) = conversation_scope.as_mut() {
        values.sort();
    }
    serde_json::json!({
        "mcp": mcp.as_ref().map(|registry| format!("{:p}", Arc::as_ptr(registry))),
        "allowlist": allowlist,
        "composioActions": composio_actions,
        "agentId": agent_id,
        "identityProfileIds": identity_profile_ids,
        "composioConnectionScope": composio_connection_scope,
        "conversationScope": conversation_scope,
        "permissionScopeId": permission_scope_id,
        "toolAuthority": tool_authority_fingerprint.map(hex::encode),
        "providerAccount": provider_account_identity,
    })
    .to_string()
}

pub(crate) fn managed_pi_session_identity(provider_id: &str, account_id: Option<&str>) -> String {
    account_id
        .map(|account_id| format!("{provider_id}:{account_id}"))
        .unwrap_or_else(|| provider_id.to_owned())
}

pub(super) fn acp_pool_key(
    conversation: &str,
    agent_key: &str,
    spawn_cmd: &str,
    cwd: &PathBuf,
    workspace_key: &str,
    environment_key: &str,
    security_key: &str,
) -> String {
    // Only the managed Pi runtime swaps generations under a live conversation;
    // any other agent whose command path changes must get a fresh instance.
    let spawn_cmd = if is_managed_pi_extension(spawn_cmd, agent_key) {
        generation_neutral_spawn_cmd(spawn_cmd)
    } else {
        std::borrow::Cow::Borrowed(spawn_cmd)
    };
    format!(
		"{conversation}\u{1}{agent_key}\u{1}{spawn_cmd}\u{1}{}\u{1}{workspace_key}\u{1}{environment_key}\u{1}{security_key}",
		cwd.display(),
	)
}

/// Environment variable an OpenAI-compatible ACP agent reads its key from.
pub(super) const INFERENCE_API_KEY_ENV: &str = "OPENAI_API_KEY";
/// Environment variable an OpenAI-compatible ACP agent reads its base URL from.
pub(super) const INFERENCE_BASE_URL_ENV: &str = "OPENAI_BASE_URL";
/// Stands in for the per-instance inference credential in a redeemed spawn
/// command, which keeps the command (and pool key) identical across turns.
/// `run_acp_instance` replaces it, by name, with the instance's credential.
pub(super) const INFERENCE_CREDENTIAL_PLACEHOLDER: &str = "ryu-acp-inference-credential";

/// A spawn command whose Core-signed Gateway bearer was exchanged for the
/// scope it names.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct RedeemedInference {
    /// The command with the bearer replaced by
    /// [`INFERENCE_CREDENTIAL_PLACEHOLDER`] and the base URL pointed at Core's
    /// inference proxy.
    pub(super) spawn_cmd: String,
    pub(super) scope: crate::server::acp_inference_proxy::AcpInferenceScope,
    /// Fingerprint of the key that signed the bearer.
    pub(super) signer: String,
}

impl RedeemedInference {
    /// Fold the scope and signer into a pool security key.
    pub(super) fn extend_security_key(&self, security_key: &mut String) {
        security_key.push_str("\u{1}inference:");
        security_key.push_str(&self.scope.fingerprint());
        security_key.push('\u{1}');
        security_key.push_str(&self.signer);
    }
}

/// Redeem the `OPENAI_API_KEY` bearer a route built into `spawn_cmd`.
///
/// Only a bearer that `verify` accepts (signed by this Core's current key and
/// unexpired) and that names this turn's agent, and either no session or this
/// turn's conversation, is redeemed. Anything else, including a bearer copied
/// into a user-authored command for another agent, yields `None`, and the
/// command runs unchanged with whatever it carries.
pub(super) fn redeem_inference_bearer(
    spawn_cmd: &str,
    agent_id: &str,
    conversation_id: Option<&str>,
    verify: impl Fn(&str) -> Option<(ryu_gw_credentials::InferenceScope, String)>,
) -> Option<RedeemedInference> {
    if !spawn_cmd.contains("gws1.") {
        return None;
    }
    let McpServer::Stdio(mut stdio) = AcpSpawn::from_str(spawn_cmd).ok()?.into_server() else {
        return None;
    };
    let mut keys = stdio
        .env
        .iter_mut()
        .filter(|variable| variable.name.eq_ignore_ascii_case(INFERENCE_API_KEY_ENV));
    let key = keys.next()?;
    if keys.next().is_some() {
        return None;
    }
    let (bearer, signer) = verify(&key.value)?;
    let session_matches = match (bearer.session_id.as_deref(), conversation_id) {
        (None, _) => true,
        (Some(session), Some(conversation)) => session == conversation,
        // A chat that is not kept has no pooled instance to keep alive.
        (Some(_), None) => return None,
    };
    if bearer.agent_id != agent_id || !session_matches {
        tracing::warn!("ACP spawn carried a scoped Gateway bearer for another turn; not redeemed");
        return None;
    }
    INFERENCE_CREDENTIAL_PLACEHOLDER.clone_into(&mut key.value);
    set_stdio_env(
        &mut stdio.env,
        INFERENCE_BASE_URL_ENV.to_owned(),
        crate::sidecar::gateway::acp_inference_proxy_v1(),
    );
    Some(RedeemedInference {
        spawn_cmd: serde_json::to_string(&McpServer::Stdio(stdio)).ok()?,
        scope: crate::server::acp_inference_proxy::AcpInferenceScope::from_bearer_scope(&bearer),
        signer,
    })
}

/// `spawn_cmd` with every scoped Gateway bearer replaced by a fixed marker, for
/// keys that must not change on a remint nor persist a bearer to disk.
pub(super) fn without_scoped_bearers(spawn_cmd: &str) -> std::borrow::Cow<'_, str> {
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    BEARER
        .get_or_init(|| {
            regex::Regex::new(r"gws1\.[0-9a-fA-F]+\.[0-9a-fA-F]+").expect("static bearer pattern")
        })
        .replace_all(spawn_cmd, "gws1.scoped")
}

/// The managed Pi spawn command names its runtime generation directory
/// (`…/generations/generation-<id>`). Keying the pool on that would make an
/// activated update look like a different command, so the next turn of a
/// running conversation would abandon its live instance for a fresh Pi session.
/// The generation is erased from the key: a live conversation keeps the
/// generation it started with, and only a respawn resolves the new one.
pub(super) fn generation_neutral_spawn_cmd(spawn_cmd: &str) -> std::borrow::Cow<'_, str> {
    const PARENT: &str = "generations";
    const PREFIX: &str = "generation-";
    if !spawn_cmd.contains(PREFIX) {
        return std::borrow::Cow::Borrowed(spawn_cmd);
    }
    let mut neutral = String::with_capacity(spawn_cmd.len());
    let mut rest = spawn_cmd;
    while let Some(index) = rest.find(PARENT) {
        let (before, after) = rest.split_at(index + PARENT.len());
        neutral.push_str(before);
        let separators = after.len() - after.trim_start_matches(['/', '\\']).len();
        let (separator, name) = after.split_at(separators);
        rest = after;
        if separators == 0 || !name.starts_with(PREFIX) {
            continue;
        }
        let id_len = name[PREFIX.len()..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            .count();
        neutral.push_str(separator);
        neutral.push_str(PREFIX);
        neutral.push('*');
        rest = &name[PREFIX.len() + id_len..];
    }
    neutral.push_str(rest);
    std::borrow::Cow::Owned(neutral)
}
