use super::*;

/// The agent id, whether managed-Pi history applies, and the turn's usage-history row.
pub(crate) struct AcpHistorySetup {
    pub(crate) agent_id: String,
    pub(crate) managed_pi_history: bool,
    pub(crate) history_turn: crate::usage_history::live::TurnHistory,
}

/// Resolve the agent id and open this turn's usage-history row.
pub(crate) fn acp_history_setup(
    req: &ChatStreamRequest,
    spawn_cmd: &str,
    sdk_turn_selection: &Option<SdkTurnSelection>,
    conversation_id: &Option<String>,
) -> AcpHistorySetup {
    let agent_id = req.agent_id.clone().unwrap_or_default();
    let managed_pi_history =
        sdk_turn_selection.is_some() || acp::is_managed_pi_extension(&spawn_cmd, &agent_id);
    let history_pi_config = managed_pi_history.then(crate::pi_config::current);
    let history_provider = if let Some(selection) = &sdk_turn_selection {
        Some(selection.account.provider_id.clone())
    } else if let Some(config) = &history_pi_config {
        Some(config.provider.clone())
    } else {
        match agent_id.strip_prefix("acp:").unwrap_or(&agent_id) {
            "codex" => Some("openai".to_owned()),
            "claude" | "claude-code" => Some("anthropic".to_owned()),
            "gemini" => Some("google".to_owned()),
            _ => None,
        }
    };
    let history_turn = crate::usage_history::live::TurnHistory::new(
        if managed_pi_history { "pi" } else { &agent_id },
        history_provider,
        if let Some(selection) = &sdk_turn_selection {
            selection.model.clone()
        } else {
            req.acp_model
                .clone()
                .filter(|model| !model.trim().is_empty())
                .or_else(|| req.model.clone().filter(|model| !model.trim().is_empty()))
                .or_else(|| {
                    history_pi_config
                        .and_then(|config| config.model)
                        .filter(|model| !model.trim().is_empty())
                })
        },
        conversation_id.clone(),
    )
    .with_account_id(
        sdk_turn_selection
            .as_ref()
            .map(|selection| selection.account.account_id.clone()),
    );
    AcpHistorySetup {
        agent_id,
        managed_pi_history,
        history_turn,
    }
}

/// Subscription-cost attribution for a tracked managed-Pi OAuth subscription turn.
pub(crate) fn acp_cost_attribution(
    req: &ChatStreamRequest,
    subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
    managed_pi_history: bool,
    sdk_turn_selection: &Option<SdkTurnSelection>,
) -> Option<crate::server::subscription_costs::SubscriptionCostAttribution> {
    subscription_costs.and_then(|store| {
        match store.is_enabled() {
            Ok(true) => {}
            Ok(false) => return None,
            Err(error) => {
                tracing::warn!(error = %error, "subscription cost tracking setting unavailable");
                return None;
            }
        }
        if !managed_pi_history {
            return None;
        }
        let pi_config = crate::pi_config::current();
        let provider = sdk_turn_selection
            .as_ref()
            .map_or(pi_config.provider.as_str(), |selection| {
                selection.account.provider_id.as_str()
            });
        if !crate::pi_config::oauth_login::is_subscription_oauth_provider(provider) {
            return None;
        }
        let captured_account = sdk_turn_selection
            .as_ref()
            .map(|captured| captured.account.account_id.clone());
        let account_id = captured_account.or_else(|| {
            crate::pi_config::list_provider_accounts(&pi_config.provider)
                .into_iter()
                .find(|account| account.active && account.kind == "oauth")
                .map(|account| account.account_id)
        })?;
        let model_id = if let Some(selection) = &sdk_turn_selection {
            selection.model.clone()
        } else {
            req.acp_model
                .clone()
                .filter(|model| !model.trim().is_empty())
                .or_else(|| req.model.clone().filter(|model| !model.trim().is_empty()))
                .or_else(|| {
                    pi_config
                        .model
                        .clone()
                        .filter(|model| !model.trim().is_empty())
                })
        };
        Some(
            crate::server::subscription_costs::SubscriptionCostAttribution {
                store,
                turn_id: uuid::Uuid::new_v4(),
                provider_id: provider.to_owned(),
                account_id,
                model_id,
            },
        )
    })
}

/// The prompt material assembled for this turn.
pub(crate) struct AcpPromptTexts {
    pub(crate) watch_model: Option<String>,
    pub(crate) compaction_summary: Option<String>,
    pub(crate) delta_prompt: String,
    pub(crate) prompt: String,
    pub(crate) images: Vec<ImagePart>,
}

/// Build the full first-turn prompt, the warm-session delta, and the turn's images.
pub(crate) async fn acp_prompt_texts(
    req: &ChatStreamRequest,
    user_message: &str,
    short_term: Option<String>,
    long_term_system: Option<String>,
    mcp: &Arc<McpRegistry>,
    allowlist: &Option<Vec<String>>,
    skills_allowlist: &[String],
) -> AcpPromptTexts {
    // The model this turn is pinned to, captured for the failover watch before
    // `req` is moved into the stream generator. `None` means the agent runs on
    // whatever its binding says, which is also what the windows reader is told —
    // an unattributed turn is not judged against a per-model cap.
    let watch_model = req.acp_model.clone().filter(|m| !m.trim().is_empty());
    let compaction_summary = short_term
        .as_deref()
        .and_then(|context| context.strip_prefix("[Earlier conversation summary]\n"))
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_owned);
    let source_folders_hint = if req.workspace_folders.len() > 1 {
        let mut hint = String::from(
            "## Project source folders\nThis project includes these source folders. ".to_owned(),
        );
        hint.push_str("You may read and edit files in any of them:\n");
        for folder in &req.workspace_folders {
            hint.push_str("- `");
            hint.push_str(&folder.replace('`', "'").replace('\n', " "));
            hint.push_str("`\n");
        }
        Some(hint)
    } else {
        None
    };
    let capability_suggestions = if crate::safe_mode::is_active() {
        crate::sidecar::mcp::suggestions::CapabilitySuggestions::default()
    } else {
        crate::sidecar::mcp::suggestions::suggest(
            &mcp,
            &user_message,
            &skills_allowlist,
            allowlist.as_deref(),
        )
        .await
    };
    let capability_hint = capability_suggestions.prompt_block();
    let turn_context = append_turn_context(req.turn_context.clone(), capability_hint.clone());
    // What a live session's later turns send instead of the full prompt. The session
    // already holds its first prompt, recent memory included, so this carries only
    // what was chosen for this message. It follows the user's text so the plan-mode
    // sentinel stays on the first line, where the extension reads it.
    let delta_prompt = acp_turn_delta(
        &user_message,
        req.turn_query_context.clone(),
        capability_hint,
    );
    let prompt = build_acp_prompt_with_turn_context(
        merge_system_prompt(long_term_system, source_folders_hint),
        short_term,
        turn_context.as_deref(),
        &user_message,
    );
    let images = last_user_images(&req.messages);
    AcpPromptTexts {
        watch_model,
        compaction_summary,
        delta_prompt,
        prompt,
        images,
    }
}

/// Persist the composer's model pick for the flagship `ryu` agent and fire `model_select`.
pub(crate) fn acp_apply_ryu_model_pick(
    req: &ChatStreamRequest,
    agent_id: &String,
    sdk_turn_selection: &Option<SdkTurnSelection>,
) {
    // [QA B2] Make the composer's model pick actually reach the flagship `ryu`
    // agent (Pi). pi-acp implements no `session/set_model`, so beyond the live
    // config-option fallback (acp::apply_turn_config) the pick is persisted into
    // the managed Pi's isolated settings.json/models.json BEFORE the turn's
    // session is built — pi-acp spawns a fresh Pi process per session/new (one
    // per turn), so the persisted model applies to this very turn and becomes
    // Pi's defaultModel for later chats. Only the `ryu` agent reads that config
    // dir; other ACP agents are untouched.
    if agent_id == "ryu" {
        if let Some(model) = req
            .acp_model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            if !req.lane_default && sdk_turn_selection.is_none() {
                if let Err(e) = crate::pi_config::persist_turn_model(model) {
                    tracing::warn!(error = %e, model, "could not persist ryu model pick into Pi config");
                }
            }
            // Keep the resident local engine aligned with the pick: selecting
            // Apple Intelligence (apple-foundationmodel) makes the on-device
            // `apfel` engine resident so the gateway's `local` provider forwards
            // there; switching away restores the default local engine.
            sync_ryu_local_engine(model.to_string());
            // The `model_select` phase. Fired DETACHED because it is purely
            // observational — a plugin can watch the per-turn pick (telemetry, a
            // cost guard's ledger, a "you switched off your local model" nudge) but
            // nothing it returns can change the model, so making the turn wait on it
            // would buy latency for no decision.
            fire_model_select_hooks(
                model.to_string(),
                req.conversation_id.clone(),
                agent_id.clone(),
            );
        }
    }
}

/// The user-chosen ACP session controls for this turn.
pub(crate) fn acp_turn_config(req: &ChatStreamRequest) -> acp::AcpTurnConfig {
    // User-chosen ACP session controls for this turn (permission mode /
    // reasoning effort / model), all agent-reported via session/new. The desktop
    // streaming path is interactive: tool-permission requests are surfaced to the
    // user and awaited (vs. headless auto-approve).
    acp::AcpTurnConfig {
        session_mode: req.acp_mode.clone().filter(|s| !s.is_empty()),
        config_options: req
            .acp_config
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect(),
        model_id: req.acp_model.clone().filter(|s| !s.is_empty()),
        agent_effort: req
            .agent_control_applied
            .as_ref()
            .and_then(|control| control.requested_effort.clone()),
        interactive: true,
    }
}

/// The prompt texts after the `context` hooks, and whether the session must start fresh.
pub(crate) struct AcpHookedPrompts {
    pub(crate) prompt: String,
    pub(crate) delta_prompt: String,
    pub(crate) fresh_session: bool,
}

/// Run the ACP-plane `context` hooks and fold their addition into both prompt texts.
pub(crate) async fn acp_context_hook_phase(
    req: &ChatStreamRequest,
    prompt: String,
    delta_prompt: String,
    project_instructions: &Option<String>,
    project_rules: &Option<Vec<Value>>,
) -> AcpHookedPrompts {
    // The `context` phase on the ACP plane — the last stop before the assembled
    // window leaves Ryu, hence its position immediately above the spawn. There is
    // no message array to hand a hook here: the whole window is already flattened
    // into this ONE string, which `acp.rs` sends as a single text block. So the
    // prompt rides in `ctx.input` and a hook answers with `Replace`. This is what
    // makes context engineering govern Claude/Codex/Pi and not just the
    // OpenAI-compat route. Bound to its own local first so the borrow of `prompt`
    // ends before the rewrite can replace it.
    let rewritten_prompt = run_context_hooks_prompt(
        &prompt,
        req.conversation_id.as_deref(),
        req.agent_id.as_deref(),
        &req.plugin_flags,
        project_instructions.as_deref(),
        project_rules.as_deref(),
    )
    .await;
    // The hook's addition rides on BOTH texts: the full prompt a new session
    // starts with and the delta a warm pooled session receives, so the pooled
    // session (and its cached prefix) survives the turn.
    let fresh_session = req.fresh_session;
    let mut prompt = prompt;
    let mut delta_prompt = delta_prompt;
    if let Some(suffix) = rewritten_prompt {
        prompt.push_str(&suffix);
        delta_prompt.push_str(&suffix);
    }
    AcpHookedPrompts {
        prompt,
        delta_prompt,
        fresh_session,
    }
}

/// The session's secondary filesystem roots and its managed-Pi tool authority.
pub(crate) struct AcpSessionScope {
    pub(crate) additional_directories: Vec<PathBuf>,
    pub(crate) tool_authority: Option<crate::server::acp_tool_broker::AcpToolSessionAuthority>,
}

/// Validate secondary workspace roots and authorize the managed-Pi tool session.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_session_scope(
    req: &ChatStreamRequest,
    cwd: &PathBuf,
    spawn_cmd: &str,
    agent_id: &str,
    persist_store: &ConversationStore,
    conversation_id: &Option<String>,
    allowlist: &Option<Vec<String>>,
    composio_actions: &Vec<String>,
    identity_profile_ids: &Vec<String>,
) -> AcpSessionScope {
    // The primary cwd is already the first ACP root. Secondary roots are
    // validated here and included in the session pool key so a warm session can
    // never inherit a different project's filesystem scope.
    let requested_cwd = req.cwd.as_deref().map(PathBuf::from);
    let additional_directories = req
        .workspace_folders
        .iter()
        .map(PathBuf::from)
        .filter(|path| requested_cwd.as_ref() != Some(path))
        .filter(|path| path != cwd)
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();

    // ACP event channel — the completion task is the sole consumer.
    let tool_authority = if acp::is_managed_pi_extension(&spawn_cmd, &agent_id) {
        crate::server::acp_tool_broker::AcpToolSessionAuthority::authorize_managed_pi_session(
            &persist_store,
            &spawn_cmd,
            &agent_id,
            conversation_id.as_deref(),
            req.verified_caller.clone(),
            allowlist.clone(),
            composio_actions.clone(),
            identity_profile_ids.clone(),
            req.composio_connection_scope.clone(),
            req.profile_conversation_scope.clone(),
        )
        .await
    } else {
        None
    };
    AcpSessionScope {
        additional_directories,
        tool_authority,
    }
}
