use super::*;

/// The startup banner the agent declared in its `session/new` response `_meta`,
/// if any.
///
/// pi-acp computes its prelude (a "## Skills" listing of every skill root it can
/// see — including the hard-coded `~/.agents/skills` — and/or an available-update
/// notice), returns it verbatim under `_meta.piAcp.startupInfo`, and then emits
/// that *same string, whole, as a single* `agent_message_chunk` once the session
/// is live (`sendStartupInfoIfPending`). Capturing it here is what lets
/// [`take_startup_banner`] recognise that chunk **by identity**: the agent told
/// us in-band exactly what it was about to say. That is deliberately not a
/// content heuristic — matching something like `## Skills` would silently
/// swallow a genuine model reply that happened to discuss skills.
///
/// Agents that declare nothing return `None` and the whole path is inert for
/// them, so no other agent's first chunk can ever be reclassified.
pub(super) fn declared_startup_banner(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let text = meta?.get("piAcp")?.get("startupInfo")?.as_str()?;
    (!text.is_empty()).then(|| text.to_owned())
}

/// Whether `text` is this session's still-unconsumed startup banner — consuming
/// it when so, so it can match at most once.
///
/// The consume is the load-bearing part. The ACP instance is **pooled per
/// conversation** and reused for every turn of the chat, so a naive "first agent
/// chunk of the instance" rule would swallow real assistant text on turn 2+.
/// Matching the exact declared string, once, cannot: the banner is emitted
/// before the user has said anything, and after it is taken the slot is empty
/// for the rest of the session.
pub(super) fn take_startup_banner(pending: &Mutex<Option<String>>, text: &str) -> bool {
    let Ok(mut slot) = pending.lock() else {
        return false;
    };
    if slot.as_deref() != Some(text) {
        return false;
    }
    *slot = None;
    true
}

/// The conventional ACP session-config-option id for model selection. Agents
/// that predate the (unstable) `session/set_model` capability — pi-acp among
/// them — expose the model as a `select` config option under this id instead.
pub(super) const MODEL_CONFIG_OPTION_ID: &str = "model";

/// Conventional ACP ids used by agents for reasoning effort. The protocol does
/// not standardize this option yet, so agent-level control may need to probe the
/// known ids when the client deliberately omitted its config map.
const EFFORT_CONFIG_OPTION_IDS: &[&str] = &["effort", "thought_level", "reasoning_effort"];

fn is_effort_config_id(config_id: &str) -> bool {
    EFFORT_CONFIG_OPTION_IDS.contains(&config_id)
}

/// Order config-option writes so the model is applied FIRST, keeping every other
/// option in the order it was given.
///
/// Config options are not independent: an agent may validate one against the
/// value of another, and the model is the one every other option is plausibly
/// scoped to. opencode 1.18.5 is the proof — its `effort` values are the current
/// model's effort levels, so writing effort BEFORE the model is rejected
/// (`Invalid params: effort not found: high`) and the later model write resets
/// effort to that model's default. The user's pick is silently lost.
///
/// This is not a nicety: the values arrive as a `HashMap` from the request body,
/// so without an explicit order the pair that goes first is whatever Rust's
/// randomized hashing yields *this process* — the failure is intermittent, which
/// is strictly worse than always broken. Nothing here names an agent; it encodes
/// "the model scopes the rest", which is true of the ACP shape in general.
///
/// Core-synthesized ids never reach an agent (see
/// [`is_core_synthesized_config_id`]) and are dropped here, so both callers get
/// the same filtering.
pub(super) fn model_first<'a, I>(pairs: I) -> Vec<(&'a String, &'a String)>
where
    I: IntoIterator<Item = (&'a String, &'a String)>,
{
    let mut ordered: Vec<(&String, &String)> = pairs
        .into_iter()
        .filter(|(id, _)| !id.is_empty() && !is_core_synthesized_config_id(id))
        .collect();
    // Stable sort ⇒ everything that is not the model keeps its relative order.
    ordered.sort_by_key(|(id, _)| u8::from(id.as_str() != MODEL_CONFIG_OPTION_ID));
    ordered
}

/// JSON-RPC code for ACP's `ErrorCode::AuthRequired`. Compared numerically
/// because the error arrives from the wire, where only the integer is carried.
pub(super) const ACP_AUTH_REQUIRED_CODE: i32 = -32000;

/// Turn a client-supplied config value string into the ACP wire value.
///
/// Every layer above this holds config picks as `String` — the desktop persists
/// `{ optionId: value }` to localStorage and posts it on the turn body — but the
/// protocol distinguishes a select's value id from a boolean toggle
/// (`SessionConfigKind::Boolean`, stable since ACP 3.x; formerly
/// `unstable_boolean_config`).
/// Sending a boolean option the string `"true"` as a VALUE ID is simply wrong:
/// the agent looks for an option whose id is `"true"`, finds none, and rejects
/// the write.
///
/// Exactly `"true"`/`"false"` map to the boolean form; everything else is a
/// value id. The ambiguity that leaves — a SELECT option whose value id is
/// literally the string `"true"` would be sent as a boolean — is accepted
/// knowingly: the alternative is threading the option's declared type through
/// the turn body from a client that has only ever stored strings, and no
/// observed agent names a select value `"true"`. If one ever does, the fix is a
/// typed value on `AcpTurnConfig`, not a heuristic here.
pub(super) fn config_option_value(raw: &str) -> SessionConfigOptionValue {
    match raw {
        "true" => SessionConfigOptionValue::boolean(true),
        "false" => SessionConfigOptionValue::boolean(false),
        other => SessionConfigOptionValue::value_id(other.to_owned()),
    }
}

/// Apply a turn's chosen session controls (mode / config options / model) to a
/// live ACP session over its connection. Each is best-effort: a failure
/// (unsupported capability or unknown id) is logged and skipped so the turn
/// still proceeds with the agent's defaults.
///
/// An explicit model config option is authoritative. Otherwise model selection
/// has a two-step application: `session/set_model` first, then —
/// when that is rejected (pi-acp returns JSON-RPC -32601 "Method not found"; QA
/// finding B2) — the `model` session config option, which pi-acp DOES implement.
/// If both fail, a non-fatal [`AcpEvent::ConfigWarning`] is emitted on `events`
/// so the client can stop displaying a model the agent never applied.
pub(super) async fn apply_turn_config(
    connection: ConnectionTo<Agent>,
    session_id: SessionId,
    turn: &AcpTurnConfig,
    workspace: &WorkspaceAutonomy,
    events: &mpsc::UnboundedSender<AcpEvent>,
) {
    if let Some(mode) = turn.session_mode.as_ref().filter(|m| !m.is_empty()) {
        if let Some(message) = workspace.refuse_mode(mode) {
            tracing::warn!(mode = %mode, "ACP session mode refused in an untrusted workspace");
            let _ = events.send(AcpEvent::ConfigWarning {
                field: WORKSPACE_TRUST_WARNING_FIELD.to_owned(),
                requested: mode.clone(),
                message,
            });
        } else {
            match connection
                .send_request_to(
                    Agent,
                    SetSessionModeRequest::new(session_id.clone(), mode.clone()),
                )
                .block_task()
                .await
            {
                Ok(_) => tracing::info!("ACP applied session mode '{mode}'"),
                Err(e) => tracing::warn!("ACP set_mode '{mode}' failed: {e}"),
            }
        }
    }
    // Model first, then the rest in their given order — an option can be scoped
    // to the model (see [`model_first`]), so the reverse order loses the pick.
    // `model_first` also drops the Core-synthesized ids, which never go on the
    // wire: the agent never advertised them and rejects them. `ryu.plan` is
    // applied by prepending the sentinel to the prompt instead
    // (`super::route_acp_stream`), which is the whole reason it exists. Filtered
    // rather than removed from `turn.config_options`, because the model fallback
    // below still has to see the full list to decide whether `model` was already
    // sent explicitly.
    for (config_id, value) in model_first(turn.config_options.iter().map(|(a, b)| (a, b))) {
        let applied: Result<SetSessionConfigOptionResponse, _> = connection
            .send_request_to(
                Agent,
                SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id.clone(),
                    config_option_value(value),
                ),
            )
            .block_task()
            .await;
        match applied {
            // The response is the FULL refreshed option list, not an ack — the
            // same contract the probe path consumes. Forwarding it is the only
            // way an option that exists only for another option's VALUE reaches
            // the client mid-session (codex reveals its reasoning `effort` list
            // once a model that has one is picked). Discarding it left the
            // pickers showing the set `session/new` happened to answer with.
            Ok(refreshed) => {
                if let Ok(json) = serde_json::to_value(&refreshed.config_options) {
                    let _ = events.send(AcpEvent::ConfigOptions(json));
                }
            }
            Err(e) => {
                tracing::warn!("ACP set_config_option '{config_id}'='{value}' failed: {e}");
                let _ = events.send(AcpEvent::ConfigWarning {
                    field: config_id.clone(),
                    requested: value.clone(),
                    message: format!("agent did not accept the config selection: {e}"),
                });
            }
        }
    }
    if let Some(model) = turn.model_id.as_ref().filter(|m| {
        !m.is_empty()
            && !turn
                .config_options
                .iter()
                .any(|(id, _)| id == MODEL_CONFIG_OPTION_ID)
    }) {
        let set_model_result = connection
            .send_request_to(
                Agent,
                SetSessionModelRequest::new(session_id.clone(), model.clone()),
            )
            .block_task()
            .await;
        if let Err(e) = set_model_result {
            tracing::info!(
                    "ACP set_model '{model}' failed ({e}); retrying as config option '{MODEL_CONFIG_OPTION_ID}'"
                );
            match connection
                .send_request_to(
                    Agent,
                    SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        MODEL_CONFIG_OPTION_ID.to_owned(),
                        config_option_value(&model),
                    ),
                )
                .block_task()
                .await
            {
                Ok(refreshed) => {
                    tracing::info!("ACP applied model '{model}' via config option");
                    if let Ok(json) = serde_json::to_value(&refreshed.config_options) {
                        let _ = events.send(AcpEvent::ConfigOptions(json));
                    }
                }
                Err(e2) => {
                    tracing::warn!(
                        "ACP set_model '{model}' failed: {e}; config-option fallback failed: {e2}"
                    );
                    let _ = events.send(AcpEvent::ConfigWarning {
                        field: MODEL_CONFIG_OPTION_ID.to_owned(),
                        requested: model.clone(),
                        message: format!("agent did not accept the model selection: {e2}"),
                    });
                }
            }
        }
    }
    if let Some(effort) = turn
        .agent_effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        let has_explicit_effort_option = turn
            .config_options
            .iter()
            .any(|(id, _)| is_effort_config_id(id));
        if !has_explicit_effort_option {
            let mut applied = false;
            for config_id in EFFORT_CONFIG_OPTION_IDS {
                let result: Result<SetSessionConfigOptionResponse, _> = connection
                    .send_request_to(
                        Agent,
                        SetSessionConfigOptionRequest::new(
                            session_id.clone(),
                            (*config_id).to_owned(),
                            config_option_value(effort),
                        ),
                    )
                    .block_task()
                    .await;
                match result {
                    Ok(refreshed) => {
                        tracing::info!(
                            "ACP applied agent-requested effort '{effort}' via config option '{config_id}'"
                        );
                        if let Ok(json) = serde_json::to_value(&refreshed.config_options) {
                            let _ = events.send(AcpEvent::ConfigOptions(json));
                        }
                        applied = true;
                        break;
                    }
                    Err(error) => {
                        tracing::debug!(
                            "ACP agent-requested effort option '{config_id}'='{effort}' was rejected: {error}"
                        );
                    }
                }
            }
            if !applied {
                let _ = events.send(AcpEvent::ConfigWarning {
                    field: "effort".to_owned(),
                    requested: effort.to_owned(),
                    message: "agent did not advertise a supported reasoning-effort option"
                        .to_owned(),
                });
            }
        }
    }
}
