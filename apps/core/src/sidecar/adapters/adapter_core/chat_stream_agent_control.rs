use super::*;

/// Give plugins one capability-gated chance to pick this turn's model (`ON_PRE_MODEL_SELECT`).
pub(super) async fn select_plugin_model(
    req: &mut ChatStreamRequest,
    binding: &mut TurnBinding,
    durable_conversation: bool,
) {
    let TurnBinding {
        effective_agent_id,
        model,
        ..
    } = binding;
    // Plugins get one generic, capability-gated chance to pick a cheaper model
    // after the normal routing policy settles and before either transport opens.
    // The selection is per-turn (`acp_model`), never a mutation of the agent card.
    let selected_model = req
        .acp_model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| model.clone())
        .unwrap_or_default();
    if !selected_model.is_empty() {
        // Predicted provider/account/pool strategy for pool-aware hooks. The vault
        // and settings reads run on the blocking pool under a short timeout, so a
        // slow read drops the prediction instead of holding up the turn.
        let prediction = model_select_context::predict(
            effective_agent_id.clone(),
            if durable_conversation {
                req.conversation_id.clone()
            } else {
                None
            },
            req.cloud_task_context.is_some(),
        )
        .await;
        let directives = crate::plugin_host::dispatch_global(
            crate::plugin_host::ON_PRE_MODEL_SELECT,
            crate::plugin_host::HookContext {
                conversation_id: req.conversation_id.clone(),
                agent_id: effective_agent_id.clone(),
                caller_user_id: req
                    .verified_caller
                    .as_ref()
                    .map(|caller| caller.user_id.clone()),
                verified_caller: req.verified_caller.clone(),
                event: Some(model_select_context::event(
                    &selected_model,
                    req.background,
                    prediction.as_ref(),
                )),
                ..Default::default()
            },
        )
        .await;
        if let Some((replacement, effort, acp_config, reason)) =
            directives
                .into_iter()
                .find_map(|directive| match directive {
                    crate::plugin_host::HookDirective::SelectModel {
                        model,
                        effort,
                        acp_config,
                        reason,
                    } if !model.trim().is_empty() => Some((model, effort, acp_config, reason)),
                    _ => None,
                })
        {
            tracing::info!(
                agent = ?effective_agent_id,
                from = %selected_model,
                to = %replacement,
                reason = ?reason,
                "plugin model selection applied"
            );
            *model = Some(replacement.clone());
            req.acp_model = Some(replacement);
            if let Some(effort) = effort
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                apply_hook_effort(req, effort);
            }
            if let Some(acp_config) = acp_config.as_ref() {
                apply_hook_acp_config(req, acp_config);
            }
        }
    }
}

/// Apply a pending `agent_control.set_active_target` patch to a normal interactive turn.
pub(super) async fn apply_pending_agent_control(
    req: &mut ChatStreamRequest,
    binding: &mut TurnBinding,
    conversations: &ConversationStore,
    agent_store: &AgentStore,
    durable_conversation: bool,
) {
    let TurnBinding {
        effective_agent_id,
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
    } = binding;
    // An active agent may request a one-turn promotion or handoff through the
    // governed `agent_control.set_active_target` tool. Consume the persisted
    // patch only for a normal interactive turn: an explicit @agent, team, or
    // workflow target is a stronger user intent and leaves the pending control
    // for the next ordinary turn. Applying here keeps the ordinary model router
    // as the default and makes agent control the deliberate post-routing override.
    if durable_conversation
        && !req.background
        && req.target_agent_id.is_none()
        && req.team_id.is_none()
        && req.workflow_id.is_none()
    {
        if let Some(conversation_id) = req.conversation_id.clone() {
            match conversations
                .take_pending_agent_control(&conversation_id)
                .await
            {
                Ok(Some(control)) => {
                    if let Err(error) = crate::agent_control::validate_pending_control(
                        &control,
                        effective_agent_id.as_deref(),
                        agent_store,
                    )
                    .await
                    {
                        tracing::warn!(
                            requested_by = %control.requested_by,
                            agent_id = ?control.patch.agent_id,
                            error = %error,
                            "discarding stale or invalid agent control before applying it"
                        );
                    } else {
                        let patch = control.patch;
                        if patch.clear_agent_id {
                            // Clearing the agent resumes the node's ordinary
                            // interactive lane. Re-resolve the full binding so
                            // the old agent's persona, tools, skills, and identity
                            // scope cannot leak into the automatic target.
                            let selection = if req.background {
                                crate::agent_selection::local_default_selection()
                            } else {
                                crate::agent_selection::chat_default_selection()
                            };
                            let target_agent_id = if selection.agent_id.trim().is_empty() {
                                crate::registry::DEFAULT_AGENT_ID.to_owned()
                            } else {
                                selection.agent_id.trim().to_owned()
                            };
                            let (
                                next_engine,
                                next_model,
                                next_slots,
                                next_persona,
                                next_composio_actions,
                                next_skills_allowlist,
                                next_identity_profile_ids,
                            ) = resolve_binding(&target_agent_id, agent_store).await;
                            *effective_agent_id = Some(target_agent_id.clone());
                            req.agent_id = Some(target_agent_id.clone());
                            req.lane_default = true;
                            req.acp_model = (!selection.model.trim().is_empty())
                                .then(|| selection.model.trim().to_owned());
                            if !selection.effort.trim().is_empty() {
                                apply_hook_effort(req, selection.effort.trim());
                            }
                            *engine = next_engine;
                            *model = next_model;
                            *agent_slots = next_slots;
                            *persona = next_persona;
                            *composio_actions = next_composio_actions;
                            *skills_allowlist = next_skills_allowlist;
                            *identity_profile_ids = next_identity_profile_ids;
                            if let Err(error) = conversations
                                .add_participant(
                                    &conversation_id,
                                    &target_agent_id,
                                    Tenancy::Unattributed,
                                )
                                .await
                            {
                                tracing::warn!(
                                    conversation_id,
                                    agent_id = %target_agent_id,
                                    "agent control could not add the automatic target participant: {error:#}"
                                );
                            }
                            if let Err(error) = conversations
                                .set_active_agent(&conversation_id, &target_agent_id)
                                .await
                            {
                                tracing::warn!(
                                    conversation_id,
                                    agent_id = %target_agent_id,
                                    "agent control could not update the conversation target after clearing the agent: {error:#}"
                                );
                            }
                        }
                        if let Some(target_agent_id) = patch.agent_id.clone() {
                            let (
                                next_engine,
                                next_model,
                                next_slots,
                                next_persona,
                                next_composio_actions,
                                next_skills_allowlist,
                                next_identity_profile_ids,
                            ) = resolve_binding(&target_agent_id, agent_store).await;
                            *effective_agent_id = Some(target_agent_id.clone());
                            req.agent_id = Some(target_agent_id.clone());
                            // A handoff without an explicit model resumes the new
                            // agent's binding rather than leaking the old agent's
                            // per-turn model pin across the boundary.
                            req.acp_model = None;
                            *engine = next_engine;
                            *model = next_model;
                            *agent_slots = next_slots;
                            *persona = next_persona;
                            *composio_actions = next_composio_actions;
                            *skills_allowlist = next_skills_allowlist;
                            *identity_profile_ids = next_identity_profile_ids;
                            if let Err(error) = conversations
                                .add_participant(
                                    &conversation_id,
                                    &target_agent_id,
                                    Tenancy::Unattributed,
                                )
                                .await
                            {
                                tracing::warn!(
                                    conversation_id,
                                    agent_id = %target_agent_id,
                                    "agent control could not add the handoff participant: {error:#}"
                                );
                            }
                            if let Err(error) = conversations
                                .set_active_agent(&conversation_id, &target_agent_id)
                                .await
                            {
                                tracing::warn!(
                                    conversation_id,
                                    agent_id = %target_agent_id,
                                    "agent control could not update the conversation target: {error:#}"
                                );
                            }
                        }

                        if patch.clear_model {
                            req.acp_model = None;
                        } else if let Some(target_model) = patch.model.clone() {
                            *model = Some(target_model.clone());
                            req.acp_model = Some(target_model);
                        }
                        if patch.clear_effort {
                            clear_hook_effort(req);
                        } else if let Some(effort) = patch.effort.clone() {
                            apply_hook_effort(req, &effort);
                        }

                        let effective_model = req
                            .acp_model
                            .clone()
                            .filter(|value| !value.trim().is_empty())
                            .or_else(|| model.clone());
                        let effective_effort = req
                            .inference
                            .as_ref()
                            .and_then(|inference| inference.extra.get("reasoning_effort"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| {
                                req.acp_config.as_ref().and_then(|config| {
                                    ["effort", "thought_level", "reasoning_effort"]
                                        .into_iter()
                                        .find_map(|key| {
                                            config
                                                .get(key)
                                                .cloned()
                                                .filter(|value| !value.is_empty())
                                        })
                                })
                            });
                        let applied = crate::agent_control::AgentControlApplied {
                            requested_agent_id: patch.agent_id,
                            requested_model: patch.model,
                            requested_effort: patch.effort,
                            effective_agent_id: effective_agent_id.clone(),
                            effective_model,
                            effective_effort,
                            model_cleared: patch.clear_model,
                            effort_cleared: patch.clear_effort,
                        };
                        tracing::info!(
                            conversation_id,
                            agent_id = ?applied.effective_agent_id,
                            model = ?applied.effective_model,
                            effort = ?applied.effective_effort,
                            "agent-level control applied to next turn"
                        );
                        req.agent_control_applied = Some(applied);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        conversation_id,
                        "agent-level control could not be loaded; continuing with normal routing: {error:#}"
                    );
                }
            }
        }
    }
}
