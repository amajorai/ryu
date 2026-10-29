use super::*;

// ── ACP subprocess streaming ───────────────────────────────────────────────────

/// Compose the single ACP prompt string from optional long-term facts, optional
/// short-term context, and the new user message.
pub(crate) fn build_acp_prompt(
    long_term_system: Option<String>,
    short_term: Option<String>,
    user_message: &str,
) -> String {
    build_acp_prompt_with_turn_context(long_term_system, short_term, None, user_message)
}

/// Add a private, current-turn capability hint after the reusable context and
/// immediately before the new user text. The hint never enters the persisted
/// transcript or the long-term system prefix, so provider prompt caches keep
/// their stable prefix warm.
pub(crate) fn build_acp_prompt_with_turn_context(
    long_term_system: Option<String>,
    short_term: Option<String>,
    turn_context: Option<&str>,
    user_message: &str,
) -> String {
    let mut prompt = String::new();
    if let Some(system) = long_term_system {
        prompt.push_str(system.trim_end());
        prompt.push_str("\n\n");
    }
    if let Some(context) = short_term {
        prompt.push_str(context.trim_end());
        prompt.push_str("\n\n");
    }
    if let Some(context) = turn_context.filter(|value| !value.trim().is_empty()) {
        prompt.push_str(context.trim_end());
        prompt.push_str("\n\n");
    }
    prompt.push_str(user_message);
    prompt
}

/// The text a live ACP session's later turns send: the new user message, then this
/// turn's query context and capability hint. The user's text leads so a plan-mode
/// sentinel on its first line stays the first line of the whole turn.
pub(crate) fn acp_turn_delta(
    user_message: &str,
    query_context: Option<String>,
    capability_hint: Option<String>,
) -> String {
    match append_turn_context(query_context, capability_hint) {
        Some(context) => format!("{user_message}\n\n{context}"),
        None => user_message.to_owned(),
    }
}

/// Turn the composer's plan-mode pick into the in-band token the agent reads.
///
/// The pill is a Core-synthesized ACP config option ([`acp::PLAN_MODE_CONFIG_ID`])
/// that no agent has ever heard of, so it cannot be applied over the wire; the
/// only per-turn channel that exists is the prompt text itself. This puts the
/// token on its own FIRST LINE of the user's message, which is the placement the
/// receiving hook requires: it accepts the token as the first line of the whole
/// text (turn 2+, where Core sends the raw message as the turn delta) or as the
/// first line of the final `\n\n`-separated block (turn 1, where Core prepends a
/// preamble and short-term context). Applying it to `user_message` BEFORE
/// [`build_acp_prompt`] satisfies both at once, and nothing downstream re-splits
/// the message, so one edit covers both roads.
///
/// The exact token stays behind [`crate::pi_config::plan_mode_sentinel`] — this
/// module is agent-neutral ACP plumbing and must not learn one engine's grammar.
///
/// ONLY the `on` value is materialized, deliberately. The composer persists an
/// option's value per agent, so a user who ever touched the pill sends its value
/// on every later turn forever; emitting an "off" token on all of those would put
/// an unbounded number of tokens in front of prompts to no purpose, each one a
/// chance for the match to misfire and leak literal text to the model. The cost is
/// that switching the pill off does not itself leave a plan mode already in
/// progress — the agent leaves it when its plan is approved, and the user can
/// always say so in the chat. Known and accepted; do not "fix" it by emitting the
/// off token unconditionally.
///
/// THE STICKY-PILL CONSEQUENCE, and how it is closed: because the composer
/// persists the pick per agent (`use-composer-acp-sections.ts` seeds
/// `acpOptionValues` from `getAcpConfig(agentId)`), a pill left ON sends the token
/// on EVERY later turn. That used to undo an approved `ExitPlanMode` one turn
/// later, when the re-sent token re-entered plan mode. The fix it needed was for
/// the exit to be visible to whoever holds the stored option — not to this
/// producer, which sees only one turn's request, but to the CLIENT that persists
/// it. That is the write-back channel: the extension stamps
/// `details.ryuConfig = { "ryu.plan": "off" }` on the approved result, `acp.rs`'s
/// agent-neutral [`acp::AcpEvent::ConfigUpdate`] carries it, the desktop adopts and
/// persists it, and the next turn's request no longer carries `on` — so this
/// function emits nothing and there is no token to re-enter with.
///
/// It stays a REQUEST, not a latch. Every latch-shaped shortcut tried on the
/// extension side either made plan mode un-re-enterable or re-entered it a turn
/// later; here the user's own next click still wins, because the client's stored
/// value is the single source of truth and the write-back is just another writer
/// of it.
pub(crate) fn apply_plan_mode_sentinel(
    user_message: String,
    config: Option<&std::collections::HashMap<String, String>>,
) -> String {
    let on = config
        .and_then(|c| c.get(acp::PLAN_MODE_CONFIG_ID))
        .map(String::as_str)
        == Some(acp::PLAN_MODE_ON);
    if !on {
        return user_message;
    }
    format!(
        "{}\n{user_message}",
        crate::pi_config::plan_mode_sentinel(true)
    )
}

/// Keep the resident local engine aligned with the flagship `ryu` agent's model
/// pick. Today only Apple Foundation Models needs this: `apple-foundationmodel`
/// is served by the `apfel` engine, and apfel validates the request's model id
/// (unlike llama.cpp/Ollama, which ignore it), so that engine MUST be resident
/// for the pick to route on-device. Switching to any other model restores the
/// previously-active (model-store) local engine, else the default GGUF engine.
///
/// Runs in the background: a first-time pick may need to install apfel
/// (PATH-detect / `brew install`), and blocking the turn on that would stall the
/// composer. The swap catches up within a moment — the current turn may warm up
/// on the prior engine. A no-op outside a live server (tests/headless), where
/// [`crate::learning::global_state`] is unset.
pub(crate) fn sync_ryu_local_engine(model: String) {
    use crate::sidecar::providers::apfel;
    tokio::spawn(async move {
        let Some(state) = crate::learning::global_state() else {
            return;
        };

        let picks_apple = model == apfel::APPLE_FM_MODEL_ID;
        let resident = state.manager.active_local_engine().await;

        // The engine this pick requires (None ⇒ leave the resident engine as-is).
        let target: Option<String> = if picks_apple {
            if !crate::catalog::registry::supported_on_node("apfel") {
                tracing::warn!(
                    "ryu picked Apple Intelligence but this node cannot run it — ignoring"
                );
                return;
            }
            Some("apfel".to_string())
        } else if resident.as_deref() == Some("apfel") {
            Some(restore_local_engine(&state).await)
        } else {
            None
        };

        let Some(engine) = target else {
            return;
        };
        if resident.as_deref() == Some(engine.as_str()) {
            return; // already the resident engine
        }

        // Install-on-select for apfel: the swap gate requires the engine to be
        // marked installed, but apfel installs lazily (PATH-detect / `brew`).
        if engine == "apfel" && !state.setup.is_installed("apfel").await {
            if let Err(e) = apfel::installer::ensure_installed().await {
                tracing::warn!(error = %e, "could not install apfel for Apple Intelligence pick");
                return;
            }
            state.setup.mark_installed("apfel").await;
        }

        match state.manager.set_active_local_engine(&engine).await {
            Ok(_) => {
                if let Err(e) = state.gateway.refresh().await {
                    tracing::warn!(error = %e, "gateway refresh after ryu engine swap failed");
                }
                tracing::info!(engine = %engine, "swapped resident local engine for ryu model pick");
            }
            Err(e) => {
                tracing::warn!(error = %e, engine = %engine, "could not swap local engine for ryu pick");
            }
        }
    });
}

/// The engine to restore when switching the ryu agent away from Apple
/// Intelligence: the model store's persisted engine if still valid, else the
/// first node-supported GGUF engine (the default local chat stack).
async fn restore_local_engine(state: &crate::server::ServerState) -> String {
    use crate::model_catalog::installed;
    if let Ok(Some(raw)) = state.preferences.get(installed::ACTIVE_MODEL_PREF).await {
        if let Some(active) = installed::parse_active_pref(&raw) {
            if active.engine != "apfel"
                && crate::sidecar::active_engine::is_local_engine(&active.engine)
            {
                return active.engine;
            }
        }
    }
    crate::model_format::pick_engine(
        crate::model_format::ModelFormat::Gguf,
        None,
        crate::catalog::registry::supported_on_node,
    )
    .unwrap_or("llamacpp")
    .to_string()
}

/// Pre-rendered SSE frame for the UI message stream. The completion task
/// produces these; the SSE generator forwards them verbatim to the client.
pub(crate) type UiFrame = Vec<u8>;
