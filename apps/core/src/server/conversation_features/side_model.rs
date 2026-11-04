//! Goals, context-window management, `/btw` side questions and multi-agent participants: `resolve_side_effort` through `call_side_model_with_images`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Resolve a "side model" effort/thinking level from a preference key, falling
/// back to an env var then empty (= provider default). Shared by the goal judge
/// and the double-check reviewer.
pub(in crate::server) async fn resolve_side_effort(
    state: &ServerState,
    pref_key: &str,
    env_var: &str,
) -> String {
    if let Ok(Some(pref)) = state.preferences.get(pref_key).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var(env_var).ok().unwrap_or_default()
}

/// Run a one-shot, non-streaming completion of `model` over `(system, user)`
/// through the local gateway and return the assistant text. This is the single
/// place the goal judge and the double-check reviewer make a "side model" call,
/// so the request shape (and the effort param) lives in exactly one spot.
///
/// `effort` (when non-empty) is forwarded as `reasoning_effort`. The gateway's
/// OpenAI/local/OpenRouter providers clone the request body verbatim, so it
/// reaches them as-is; the Anthropic-direct transform (`to_anthropic_body`)
/// rebuilds the request and currently drops it (caveat, not a hard failure).
///
/// `purpose` is sent as the Gateway's side-call attribution headers, so the
/// audit log can tell this spend apart from the chat turn it sits beside.
pub(crate) async fn call_side_model(
    state: &ServerState,
    purpose: &crate::sidecar::gateway::SidePurpose,
    model: &str,
    effort: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    call_side_model_with_provider(state, purpose, model, None, effort, system, user).await
}

/// Same governed side-model call, with an optional explicit provider slot.
/// Provider selection is carried as the existing Gateway slot header so the
/// request still passes through the normal router, policy, budget, and audit
/// path; callers never receive provider credentials.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_side_model_with_provider(
    state: &ServerState,
    purpose: &crate::sidecar::gateway::SidePurpose,
    model: &str,
    provider: Option<&str>,
    effort: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    call_side_model_with_images(
        state,
        purpose,
        model,
        provider,
        effort,
        system,
        user,
        &[],
        None,
    )
    .await
}

/// The OpenAI chat body for a side-model call. With no images the user turn
/// stays a plain string (the long-standing wire shape every provider accepts).
/// With images it becomes OpenAI content parts — the text first, then one
/// `image_url` part per image — which the Gateway already translates for
/// Anthropic, Bedrock, Gemini and OpenRouter. A model that cannot read images
/// answers with the Gateway's own error rather than silently ignoring them.
pub(crate) fn side_model_payload(
    model: &str,
    effort: &str,
    system: &str,
    user: &str,
    images: &[String],
) -> serde_json::Value {
    let user_content = if images.is_empty() {
        json!(user)
    } else {
        let mut parts = vec![json!({ "type": "text", "text": user })];
        parts.extend(
            images
                .iter()
                .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
        );
        serde_json::Value::Array(parts)
    };
    let mut payload = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user_content },
        ],
    });
    let effort = effort.trim();
    if !effort.is_empty() {
        payload["reasoning_effort"] = json!(effort);
    }
    payload
}

/// The Gateway's `/v1/chat/completions` body limit (axum's 2 MiB default; the
/// route sets no larger one).
pub(crate) const MAX_SIDE_MODEL_REQUEST_BYTES: usize = 2 * 1024 * 1024;

/// Serialize a side-model chat body, refusing one the Gateway would reject.
///
/// Per-field limits count characters, and JSON escaping can grow a character
/// to six bytes (`\u0001`), so only the encoded size says whether the prompt,
/// system text and images fit together. Checking here turns what would be an
/// opaque Gateway 413 into a reason the caller can act on.
pub(crate) fn encode_side_model_request(payload: &serde_json::Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("side-model request could not be encoded: {error}"))?;
    if bytes.len() > MAX_SIDE_MODEL_REQUEST_BYTES {
        return Err(format!(
            "side-model request is {} bytes once encoded, over the 2 MiB chat request limit; send fewer or smaller images, or shorter prompt and system text",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// The governed side-model call with optional image inputs (already validated
/// by the caller; see the plugin bridge's `host.sideModel`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_side_model_with_images(
    state: &ServerState,
    purpose: &crate::sidecar::gateway::SidePurpose,
    model: &str,
    provider: Option<&str>,
    effort: &str,
    system: &str,
    user: &str,
    images: &[String],
    provider_access: Option<&str>,
) -> Result<String, String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let payload = side_model_payload(model, effort, system, user, images);
    let body = encode_side_model_request(&payload)?;
    let mut req = state
        .client
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(60))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    req = crate::sidecar::gateway::with_side_call_headers(req, purpose);
    if let Some(provider) = provider.filter(|value| !value.trim().is_empty()) {
        req = req.header("x-ryu-slot-chat-provider", provider.trim());
    }
    if let Some(access) = provider_access {
        req = req.header("x-ryu-agent-provider-access", access);
    }
    if let Some(t) = crate::sidecar::gateway::gateway_inference_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {e}"))?;
    if !resp.status().is_success() {
        // Carry the gateway's OWN error text through. Without it every failure
        // reached the user as a bare "gateway returned HTTP 400", which hides the
        // one thing that identifies the fault (no provider for the model, missing
        // key, quota). Truncated so a stray HTML error page can't flood the client.
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("gateway returned HTTP {status} (model `{model}`)"));
        }
        let detail: String = detail.chars().take(400).collect();
        return Err(format!(
            "gateway returned HTTP {status} for model `{model}`: {detail}"
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("response was not valid JSON: {e}"))?;
    crate::sidecar::gateway::log_side_usage(purpose, model, &body);
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    Ok(text.to_string())
}
