//! Side questions (`/btw`).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Side questions (`/btw`) ───────────────────────────────────────────────────
//
// A `/btw` side question (modeled on Claude Code's interactive `/btw`) lets a
// user ask a quick question *about the current conversation* without polluting
// the chat history. It sees the conversation context but has NO tool access and
// produces a single, ephemeral answer the client shows in an overlay and then
// discards. This is the inverse of a sub-agent: full context, no tools.
//
// Like double-check it reuses [`call_side_model`] (one non-streaming gateway
// call). The endpoint is top-level (`POST /api/btw`, not under
// `/conversations/:id`) because some clients hold the transcript themselves and
// have no Core conversation id: the body carries either a `messages` array (CLI,
// mobile — the client's own transcript) or a `conversation_id` (desktop — Core
// has the authoritative, possibly-fuller transcript).

/// Resolve the model that answers `/btw` side questions: pref `btw-model` →
/// env `RYU_BTW_MODEL`/`RYU_DEFAULT_LLM_MODEL` → the built-in default. Nothing
/// hardcoded — the stored value is any gateway-routable model id.
pub(in crate::server) async fn resolve_btw_model(state: &ServerState) -> String {
    if let Ok(Some(pref)) = state.preferences.get(BTW_MODEL_PREF).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for var in ["RYU_BTW_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    // Nothing configured anywhere. `DEFAULT_LLM_MODEL` is a REMOTE id
    // (`gpt-4o-mini`), so on a node with no OpenAI credential the gateway
    // rejected every side question and `/btw` surfaced as a bare 502 — while the
    // main chat, pointed at a model the node can actually reach, worked fine.
    // Borrow that model: if chat works, the side question works. The constant
    // stays as the last resort for a node with no Pi selection at all.
    if let Some(model) = crate::pi_config::current().model {
        let trimmed = model.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    crate::registry::DEFAULT_LLM_MODEL.to_string()
}

/// One message in a client-supplied `/btw` transcript.
#[derive(serde::Deserialize)]
pub(in crate::server) struct BtwMessage {
    pub(in crate::server) role: String,
    pub(in crate::server) content: String,
}

/// `POST /api/btw` request body. The transcript comes from `messages` when the
/// client holds it (CLI/mobile), else it's loaded from `conversation_id`
/// (desktop). `question` is the side question to answer.
#[derive(serde::Deserialize)]
pub(in crate::server) struct BtwBody {
    pub(in crate::server) question: String,
    /// When supplied by the desktop, use the active main-chat model instead of
    /// the side-question preference. CLI/mobile may omit this and keep the
    /// existing `btw-model` resolution.
    #[serde(default)]
    pub(in crate::server) model: Option<String>,
    #[serde(default)]
    pub(in crate::server) messages: Option<Vec<BtwMessage>>,
    #[serde(default)]
    pub(in crate::server) conversation_id: Option<String>,
}

/// `POST /api/btw` — answer an ephemeral side question against the conversation
/// context. The answer is persisted as a side-chat entry when a parent
/// conversation id is supplied, but never added to the main message timeline.
/// Returns `{ answer, model, id }`.
#[utoipa::path(
    post,
    path = "/api/btw",
    tag = "Chat",
    summary = "Ask a side question (`/btw`) over a conversation",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn btw_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BtwBody>,
) -> axum::response::Response {
    let question = body.question.trim();
    if question.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "a side question is required".to_string(),
        );
    }
    // Per-resource ACL: `/btw` loads the conversation's stored transcript as context
    // and persists the aside back onto it — a read AND a write of that thread.
    if let Some(cid) = body.conversation_id.as_deref().filter(|s| !s.is_empty()) {
        if let Err(resp) = require_conversation_access_if_known(&state, &caller, cid, true).await {
            return resp;
        }
    }

    // Prefer a client-supplied transcript; otherwise load it from the stored
    // conversation. Either is fine — a `/btw` with no prior context still works
    // (it just has less to draw on).
    let transcript = match body.messages {
        Some(msgs) if !msgs.is_empty() => {
            let start = msgs.len().saturating_sub(BTW_TRANSCRIPT_LIMIT);
            msgs[start..]
                .iter()
                .map(|m| format!("[{}] {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        _ => match body.conversation_id.as_deref().filter(|s| !s.is_empty()) {
            Some(cid) => state
                .conversations
                .get_recent_messages(cid, BTW_TRANSCRIPT_LIMIT)
                .await
                .unwrap_or_default()
                .iter()
                .map(|m| format!("[{}] {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n\n"),
            None => String::new(),
        },
    };

    // A desktop selection action carries the active main-chat model explicitly,
    // so a side chat is a fork of the model/context view rather than silently
    // switching to a different advisor model. Clients that omit it retain the
    // original `btw-model` → node default → env/registry fallback.
    let requested_model = body
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned);
    let (model, effort) = if let Some(model) = requested_model {
        (
            model,
            resolve_side_effort(&state, BTW_EFFORT_PREF, "RYU_BTW_EFFORT").await,
        )
    } else {
        match crate::agent_selection::resolve_side_model(
            &state.preferences,
            BTW_MODEL_PREF,
            Some(BTW_EFFORT_PREF),
        )
        .await
        {
            Some(resolved) => (resolved.model, resolved.effort),
            None => (
                resolve_btw_model(&state).await,
                resolve_side_effort(&state, BTW_EFFORT_PREF, "RYU_BTW_EFFORT").await,
            ),
        }
    };

    let system = "You are answering a quick SIDE QUESTION about an ongoing conversation. \
        Answer ONLY from the conversation context provided — you have no tools and cannot run \
        commands, read files, or browse. If the context does not contain the answer, say so \
        briefly rather than guessing. Be concise and direct; this is a quick aside, not a new task.";
    let user = if transcript.is_empty() {
        format!("SIDE QUESTION:\n{question}\n\nAnswer concisely.")
    } else {
        format!(
            "CONVERSATION SO FAR:\n{transcript}\n\n\
             SIDE QUESTION:\n{question}\n\n\
             Answer the side question concisely, using only the conversation above."
        )
    };

    match call_side_model(
        &state,
        &crate::sidecar::gateway::SidePurpose::Btw,
        &model,
        &effort,
        system,
        user.as_str(),
    )
    .await
    {
        Ok(text) => {
            // Persist the aside as a "side chat" keyed to its parent conversation
            // so it can be listed later (in the Context rail and the sidebar). This
            // is best-effort: a persistence failure never fails the answer, and a
            // request that carried only a client-held transcript (no Core
            // conversation id) is simply not persisted.
            let mut entry_id: Option<String> = None;
            if let Some(cid) = body.conversation_id.as_deref().filter(|s| !s.is_empty()) {
                match state
                    .conversations
                    .append_btw(cid, question, &text, Some(&model))
                    .await
                {
                    Ok(entry) => entry_id = Some(entry.id),
                    Err(e) => tracing::warn!("failed to persist btw entry: {e:#}"),
                }
            }
            Json(json!({ "answer": text, "model": model, "id": entry_id })).into_response()
        }
        Err(e) => json_error(
            StatusCode::BAD_GATEWAY,
            format!("side-question model unavailable: {e}"),
        ),
    }
}

/// Preference key holding the (stronger) advisor model. Shared with the
/// `@ryu/advisor` turn-hook plugin's settings tab so one picker drives both
/// the auto-review hook and the `advisor.consult` tool.
pub(in crate::server) const ADVISOR_MODEL_PREF: &str = "advisor-model";

/// Resolve the advisor model, swappable and never hardcoded to a remote provider:
/// explicit body arg → preference `advisor-model` → the node-wide default
/// selection → env `RYU_ADVISOR_MODEL` / `RYU_DEFAULT_LLM_MODEL` → the bundled
/// local default. Mirrors the resolution the deleted `sidecar/mcp/advisor`
/// provider did, so the tool's model selection is unchanged by the move to a
/// declarative `http` tool.
pub(in crate::server) async fn resolve_advisor_model(
    state: &ServerState,
    explicit: Option<&str>,
) -> String {
    if let Some(m) = explicit {
        let t = m.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(resolved) =
        crate::agent_selection::resolve_side_model(&state.preferences, ADVISOR_MODEL_PREF, None)
            .await
    {
        return resolved.model;
    }
    for var in ["RYU_ADVISOR_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    crate::registry::local_chat_model_id()
}

/// `POST /api/advisor/consult` request body — mirrors the `advisor.consult`
/// tool's `input_schema` (fixtures/advisor.manifest.json). The agent supplies the
/// context it wants reviewed (the transcript is not reachable at tool dispatch).
#[derive(serde::Deserialize)]
pub(in crate::server) struct AdvisorConsultBody {
    pub(in crate::server) question: String,
    #[serde(default)]
    pub(in crate::server) context: Option<String>,
    #[serde(default)]
    pub(in crate::server) model: Option<String>,
}

/// `POST /api/advisor/consult` — the loopback bridge behind the declarative
/// `advisor.consult` plugin tool. Consult a stronger reviewer model for a second
/// opinion: resolve the swappable advisor model, build the review prompt from the
/// agent-supplied `question`/`context`, and route ONE high-effort, non-streaming
/// completion through the Gateway (`call_side_model`). Returns `{ ok, model,
/// advice }` (byte-shape identical to the former native provider) so the tool,
/// declared `unwrap_body: true`, surfaces it verbatim. A Gateway failure is a
/// `200 { ok: false, model, error }` (not an HTTP error) so the agent's turn
/// continues, matching the old provider's soft-failure posture.
#[utoipa::path(
    post,
    path = "/api/advisor/consult",
    tag = "Chat",
    summary = "Consult a stronger advisor model for a second opinion",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn advisor_consult_handler(
    State(state): State<ServerState>,
    Json(body): Json<AdvisorConsultBody>,
) -> axum::response::Response {
    let question = body.question.trim();
    if question.is_empty() {
        // The tool's schema marks `question` required, so this is only hit by a
        // hand-rolled caller. Return a soft failure (200) so a turn never aborts.
        return Json(json!({
            "ok": false,
            "error": "missing required field 'question'",
        }))
        .into_response();
    }
    let context = body.context.as_deref().map(str::trim).unwrap_or("");
    let model = resolve_advisor_model(&state, body.model.as_deref()).await;

    let system = "You are a stronger reviewer advising a capable assistant. The assistant has \
                  come to you for a second opinion before committing to an approach, while stuck, \
                  or before declaring a task done. Give concrete, actionable advice: flag wrong \
                  assumptions, missing steps, better approaches, and risks. If the direction is \
                  already sound, say so plainly and add the single highest-value improvement. Be \
                  specific and brief. Advise; do not just restate the plan back.";
    let mut user = format!("The assistant is asking for advice.\n\nQuestion:\n{question}");
    if !context.is_empty() {
        user.push_str(&format!("\n\nRelevant context / current plan:\n{context}"));
    }
    user.push_str("\n\nGive your advice now.");

    match call_side_model(
        &state,
        &crate::sidecar::gateway::SidePurpose::Advisor,
        &model,
        "high",
        system,
        user.as_str(),
    )
    .await
    {
        Ok(advice) if !advice.trim().is_empty() => Json(json!({
            "ok": true,
            "model": model,
            "advice": advice.trim(),
        }))
        .into_response(),
        Ok(_) => Json(json!({
            "ok": false,
            "model": model,
            "error": "the advisor model returned no advice",
        }))
        .into_response(),
        Err(e) => Json(json!({
            "ok": false,
            "model": model,
            "error": e,
        }))
        .into_response(),
    }
}
