use super::spawn_launch::{
    classify_spawn_reason, retire_for_respawn, spawn_pooled, spawn_unpooled,
    try_reuse_live_instance, AcpLaunch, AcpLaunchGrants, LiveReuse,
};
use super::spawn_prepare::{
    apply_native_account, capture_pi_account, extend_spawn_security_key, pool_key_parts,
    resolve_provider_account_identity, scope_spawn_cmd,
};
use super::*;

/// Spawn an ACP subprocess and return a receiver that yields structured events
/// (text, tool calls, tool results) as they arrive. The channel closes when the
/// session completes or errors.
///
/// `cwd` is the working directory the ACP session runs in. Pass the worktree
/// path when worktree isolation is active; otherwise pass the user's folder or
/// `std::env::current_dir()` as a fallback.
///
/// `mcp` and `allowlist` wire Ryu's registered tools (Ghost, Shadow, config
/// servers) into the ACP session so the agent can call them during its tool
/// loop. `mcp = None` or an empty allowlist offers no Ryu tools (legacy/test
/// path and the explicit "no tools" case, respectively). Every bridged call is
/// gated by the allowlist inside `McpRegistry::call_tool` (AC3 governance).
pub fn spawn_acp_task(
    spawn_cmd: String,
    prompt: String,
    // Raw new user message (no history). Sent instead of `prompt` on every turn
    // after a live ACP session's first, so history is not double-counted.
    delta_prompt: String,
    // When true, do not reuse the pooled ACP session: this turn must receive the
    // complete rewritten prompt so prior hidden context injections are absent.
    // `permission_scope_id` is still carried on the turn for ACL/cancel scope.
    fresh_session: bool,
    images: Vec<ImagePart>,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    mut environment: Vec<(String, String)>,
    mcp: Option<Arc<McpRegistry>>,
    allowlist: Option<Vec<String>>,
    // Per-agent Composio action slugs + the effective agent id, threaded into the
    // MCP bridge so Composio reaches the ACP plane and PTC execution is scoped (#477).
    composio_actions: Vec<String>,
    agent_id: String,
    // The route passes its captured account for ledger-tracked turns. If absent,
    // the managed Pi's current metadata-only account snapshot is used instead.
    mut provider_account_identity_override: Option<String>,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge for the tool-call-time vault consult. Empty = no consult.
    identity_profile_ids: Vec<String>,
    // Optional server-validated Composio connections and conversation scope
    // used by the onboarding profile builder.
    composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    conversation_scope: Option<Vec<String>>,
    tool_authority: Option<crate::server::acp_tool_broker::AcpToolSessionAuthority>,
    // User-chosen ACP session controls (permission mode / reasoning effort /
    // model) applied to this turn's session. All agent-reported; see
    // [`AcpTurnConfig`].
    turn: AcpTurnConfig,
    // Stable chat-session key for Core-owned interactive MCP permissions.
    permission_scope_id: Option<String>,
    conversation_generation: Option<String>,
    // Whether this turn runs under a public-agent policy (an anonymous visitor's
    // request). Such a turn never keeps the managed Pi's own shell and file
    // tools; see [`confines_managed_pi_tools`].
    public_agent_turn: bool,
    // What the OS sandbox must hide because of the agent's account access
    // (see [`crate::agent_access::account_confinement_for_agent`]).
    account_confinement: crate::agent_access::AccountConfinement,
) -> mpsc::UnboundedReceiver<AcpEvent> {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    if apply_native_account(
        &spawn_cmd,
        permission_scope_id.as_deref(),
        &agent_id,
        &mut environment,
        &mut provider_account_identity_override,
        &events_tx,
    )
    .is_none()
    {
        return events_rx;
    }
    let Some((spawn_cmd, is_managed_pi)) = scope_spawn_cmd(
        spawn_cmd,
        &agent_id,
        allowlist.as_deref(),
        public_agent_turn,
        &account_confinement,
        &events_tx,
    ) else {
        return events_rx;
    };
    // A route put this turn's Core-signed Gateway bearer in the command. Redeem
    // it for a per-instance credential that Core's inference proxy refreshes, so
    // the command, and the pool key, no longer change when the bearer is
    // reminted. A bearer that does not verify, or names another agent or
    // conversation, is left in place and the instance runs on it as before.
    let inference = redeem_inference_bearer(
        &spawn_cmd,
        &agent_id,
        permission_scope_id.as_deref(),
        crate::sidecar::gateway::verify_scoped_inference_bearer,
    );
    let spawn_cmd = match inference.as_ref() {
        Some(redeemed) => redeemed.spawn_cmd.clone(),
        None => spawn_cmd,
    };
    if capture_pi_account(
        is_managed_pi,
        &spawn_cmd,
        permission_scope_id.as_deref(),
        &agent_id,
        &mut environment,
        &mut provider_account_identity_override,
        &events_tx,
    )
    .is_none()
    {
        return events_rx;
    }
    let tool_authority = if is_managed_pi { tool_authority } else { None };
    let provider_account_identity =
        resolve_provider_account_identity(is_managed_pi, provider_account_identity_override);
    // Resolved concrete agent id for this turn (== the effective/bridge agent id).
    // Folded into the pool key below so the session is keyed by (conversation,
    // agent, spawn_cmd, cwd): switching agents mid-conversation — including the
    // Plane B agent-auto case (spec §2.3) — starts a FRESH session for the newly
    // chosen agent while the previous agent's instance is kept warm in the pool.
    // Keying on the agent id (not just spawn_cmd) is what separates two agent
    // records that happen to share a binary/spawn command but differ in config.
    let agent_key = agent_id.clone();
    // A pooled ACP session retains the first turn's MCP server and bridge
    // credentials. Include every security-sensitive input in the pool key so a
    // later request with a narrower allowlist, different Composio actions, or a
    // different Identity Vault binding cannot inherit the first turn's tools.
    let mut security_key = acp_security_key(
        &mcp,
        &allowlist,
        &composio_actions,
        &agent_id,
        &identity_profile_ids,
        &composio_connection_scope,
        &conversation_scope,
        &permission_scope_id,
        tool_authority
            .as_ref()
            .map(crate::server::acp_tool_broker::AcpToolSessionAuthority::binding_fingerprint),
        provider_account_identity.as_deref(),
    );
    extend_spawn_security_key(
        &mut security_key,
        conversation_generation.as_deref(),
        inference.as_ref(),
        &cwd,
        &additional_directories,
        &account_confinement,
    );
    let acp_turn = AcpTurn {
        admission: crate::execution_control::admit(),
        prompt,
        delta_prompt,
        images,
        turn,
        mcp,
        allowlist,
        composio_actions,
        agent_id,
        provider_account_identity,
        identity_profile_ids,
        composio_connection_scope,
        conversation_scope,
        permission_scope_id: permission_scope_id.clone(),
        conversation_generation: conversation_generation.clone(),
        events: events_tx,
    };

    let keys = pool_key_parts(
        permission_scope_id,
        conversation_generation.as_deref(),
        &environment,
        &spawn_cmd,
        &additional_directories,
    );
    let launch = AcpLaunch {
        spawn_cmd,
        cwd,
        additional_directories,
        environment,
        account_confinement,
    };
    let grants = AcpLaunchGrants {
        tool_authority: tool_authority.as_ref(),
        inference: inference.as_ref(),
    };
    if !should_reuse_acp_session(&keys.conversation, fresh_session) {
        spawn_unpooled(
            launch,
            &keys,
            &agent_key,
            &security_key,
            fresh_session,
            grants,
            acp_turn,
        );
        return events_rx;
    }

    let key = acp_pool_key(
        &keys.conversation,
        &agent_key,
        &launch.spawn_cmd,
        &launch.cwd,
        &keys.workspace_key,
        &keys.environment_key,
        &security_key,
    );
    let mut pool = acp_pool().lock().expect("acp pool mutex poisoned");
    let mut spawn_reason = classify_spawn_reason(&mut pool, &key);
    let pending = match try_reuse_live_instance(
        &mut pool,
        &key,
        acp_turn,
        tool_authority.as_ref(),
        &mut spawn_reason,
    ) {
        LiveReuse::Reused => return events_rx,
        LiveReuse::Spawn(pending) => pending,
    };
    let released_slot = retire_for_respawn(
        &mut pool,
        &keys.conversation,
        &agent_key,
        &key,
        &mut spawn_reason,
    );
    spawn_pooled(&mut pool, key, launch, pending, grants, released_slot);
    events_rx
}
