use super::*;

///
/// `conversations` persists chat history server-side (U10): the inbound user
/// message is written before streaming begins, and the streamed assistant reply
/// is accumulated and written once the stream completes.
///
/// `agent_store` supplies the selected agent's **bound engine** (U6) rather than
/// only the `agent_id` prefix: a local-engine binding triggers a managed swap
/// (U4) via `manager` so the requested engine becomes the single resident one
/// before streaming; a cloud/registry binding routes without touching local
/// engines; an unknown/unbound agent falls back to the default plain-LLM agent.
///
/// Two-tier memory (spec unit U11): when `enable_long_term` is set, durable
/// cross-session facts are recalled and prepended as a leading `system` message,
/// and the user's turn is recorded for future sessions once the stream completes.
pub(crate) fn apply_hook_effort(req: &mut ChatStreamRequest, effort: &str) {
    req.inference
        .get_or_insert_with(Default::default)
        .extra
        .insert("reasoning_effort".to_owned(), serde_json::json!(effort));

    if let Some(config) = req.acp_config.as_mut() {
        if let Some(config_id) = ["effort", "thought_level", "reasoning_effort"]
            .into_iter()
            .find(|id| config.contains_key(*id))
        {
            config.insert(config_id.to_owned(), effort.to_owned());
        }
    }
}

pub(crate) fn clear_hook_effort(req: &mut ChatStreamRequest) {
    if let Some(inference) = req.inference.as_mut() {
        inference.extra.remove("reasoning_effort");
    }
    if let Some(config) = req.acp_config.as_mut() {
        for key in ["effort", "thought_level", "reasoning_effort"] {
            config.remove(key);
        }
    }
}

/// Merge ACP config options selected by a pre-model hook into this turn only.
/// Non-ACP routes carry the field harmlessly and ignore it; ACP applies the
/// resulting map through its existing best-effort `session/set_config_option`
/// path. Hook options intentionally win over the client's same-turn value so a
/// quota policy can activate an emergency mode at the threshold it describes.
pub(crate) fn apply_hook_acp_config(
    req: &mut ChatStreamRequest,
    acp_config: &std::collections::HashMap<String, String>,
) {
    if acp_config.is_empty() {
        return;
    }
    req.acp_config.get_or_insert_with(Default::default).extend(
        acp_config
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
}

/// Apply an ACP agent's configured session defaults to this turn. Explicit
/// per-turn picks win; a model outside the agent's allowlist is dropped (so the
/// default, or the agent's own default, applies). `model_unbound` is false when
/// the agent record binds its own model, which keeps precedence.
pub(crate) fn apply_acp_session_defaults(
    req: &mut ChatStreamRequest,
    settings: &crate::acp_agent_settings::AcpAgentSettings,
    model_unbound: bool,
) {
    let picked = req
        .acp_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty());
    if let Some(model) = picked {
        if !settings.allows_model(model) {
            tracing::warn!(
                model,
                "ACP model pick is outside the agent's allowed models"
            );
            req.acp_model = None;
        }
    }
    // Agents that expose the model as a session config option conventionally
    // name it `model`; hold that pick to the same allowlist.
    if let Some(config) = req.acp_config.as_mut() {
        if config
            .get("model")
            .is_some_and(|model| !settings.allows_model(model))
        {
            tracing::warn!("ACP model option is outside the agent's allowed models");
            config.remove("model");
        }
    }
    let unset = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());
    // A saved default is held to the same allowlist as a per-turn pick: a
    // default that was later unchecked must not keep running the excluded model.
    if model_unbound && unset(&req.acp_model) {
        if let Some(model) = settings.default_model.as_deref() {
            if settings.allows_model(model) {
                req.acp_model = Some(model.to_owned());
            } else {
                tracing::warn!(
                    model,
                    "ACP default model is outside the agent's allowed models"
                );
            }
        }
    }
    if unset(&req.acp_mode) {
        req.acp_mode.clone_from(&settings.default_mode);
    }
    if !settings.default_config_options.is_empty() {
        let config = req.acp_config.get_or_insert_with(Default::default);
        for (id, value) in &settings.default_config_options {
            if id == "model" && !settings.allows_model(value) {
                tracing::warn!(
                    model = value.as_str(),
                    "ACP default model option is outside the agent's allowed models"
                );
                continue;
            }
            config.entry(id.clone()).or_insert_with(|| value.clone());
        }
    }
}

pub(crate) async fn capture_acp_conversation_generation(
    req: &mut ChatStreamRequest,
    conversations: &ConversationStore,
) -> Result<(), String> {
    if req.acp_conversation_generation.is_some() {
        return Ok(());
    }
    let Some(id) = req.conversation_id.as_deref() else {
        req.acp_conversation_generation = Some(None);
        return Ok(());
    };
    let mut identity = conversations
        .get_access_meta_with_generation(id)
        .await
        .map_err(|error| format!("Conversation identity unavailable: {error}"))?;
    if identity.is_none() && req.persist {
        let tenancy = req
            .verified_caller
            .as_ref()
            .map(|caller| Tenancy::Owned {
                user_id: caller.user_id.clone(),
                org_id: caller.org_id.clone(),
            })
            .unwrap_or(Tenancy::Unattributed);
        let created = conversations
            .ensure_conversation_with_generation(id, req.agent_id.as_deref(), None, tenancy)
            .await
            .map_err(|error| format!("Conversation identity unavailable: {error}"))?;
        identity = conversations
            .get_access_meta_with_generation(id)
            .await
            .map_err(|error| format!("Conversation identity unavailable: {error}"))?;
        if identity.as_ref().map(|(_, generation)| generation.as_str()) != Some(created.as_str()) {
            return Err("Conversation changed during admission".to_owned());
        }
    }
    if let Some((meta, generation)) = identity {
        // Human turns recheck the exact identity whose generation is captured.
        // Internal node/channel writers retain their existing machine authority.
        if req.verified_caller.is_some() {
            crate::server::require_resource_write(
                Ok(Some(meta)),
                req.verified_caller.as_ref(),
                "Conversation unavailable",
            )
            .map_err(|_| "Conversation access denied".to_owned())?;
        }
        req.acp_conversation_generation = Some(Some(generation));
    } else {
        req.acp_conversation_generation = Some(None);
    }
    Ok(())
}
