//! One delegate's model call: the registered agent, the Gateway completion, the fallback.
// test-exempt: moved verbatim out of workflow/delegation.rs by the module split; covered by delegation/tests/gateway_path.rs.

use super::*;

/// Execute a single delegate with a clean context under its wall-time cap.
pub(super) async fn run_one(
    spec: &DelegateSpec,
    caps: &DelegationCaps,
    execution_policy: DelegationExecutionPolicy,
) -> DelegateResult {
    let wall_time = Duration::from_secs(caps.wall_time_secs.max(1));
    let fut = call_sub_agent(spec, caps.max_tokens, execution_policy);

    match tokio::time::timeout(wall_time, fut).await {
        Ok(Ok(call)) => DelegateResult::ok(spec.id.clone(), spec.preset, call.text)
            .with_child_conversation_id(call.child_conversation_id),
        Ok(Err(e)) => DelegateResult::failed(spec.id.clone(), spec.preset, e.message)
            .with_child_conversation_id(e.child_conversation_id),
        Err(_) => DelegateResult::failed(
            spec.id.clone(),
            spec.preset,
            format!("wall-time limit of {}s exceeded", caps.wall_time_secs),
        ),
    }
}

/// Call the sub-agent with a clean context (task prompt only) and the preset's
/// capability hints. Routes through the Gateway (`gateway_url()`/`gateway_token()`)
/// so every delegate model call passes through the Gateway firewall, DLP, budget,
/// and audit pipeline — never direct to a provider.
///
/// Fail-closed: if the gateway URL resolves to the default and is unreachable,
/// the call returns an error (matching the hard constraint for `via_gateway=true`).
/// Set `RYU_ALLOW_GATEWAY_FALLBACK=1` to opt in to provider-direct fallback.
struct SubAgentCall {
    text: String,
    child_conversation_id: Option<String>,
}

struct SubAgentError {
    message: String,
    child_conversation_id: Option<String>,
}

impl SubAgentError {
    fn new(message: String) -> Self {
        Self {
            message,
            child_conversation_id: None,
        }
    }

    fn with_child(message: String, child_conversation_id: String) -> Self {
        Self {
            message,
            child_conversation_id: Some(child_conversation_id),
        }
    }
}

pub(super) fn should_use_registered_agent(
    spec: &DelegateSpec,
    execution_policy: DelegationExecutionPolicy,
) -> bool {
    matches!(execution_policy, DelegationExecutionPolicy::Normal)
        && spec.inline.is_none()
        && spec.preset.allows_mutation()
        && spec.agent_id.as_deref().is_some_and(|id| !id.is_empty())
}

/// Ends a registered-agent delegate's one-shot conversation when the call
/// returns. The pooled ACP instance behind `delegate-<uuid>` would otherwise
/// idle out with a resident agent process for the whole idle timeout, although
/// nothing will send it another turn. A call dropped by the wall-time limit
/// also cancels its in-flight turn, so a subagent whose result was already
/// discarded stops working instead of finishing in the background.
struct DelegateConversationGuard {
    conversation_id: String,
    finished: bool,
}

impl Drop for DelegateConversationGuard {
    fn drop(&mut self) {
        if !self.finished {
            crate::sidecar::adapters::acp::request_cancel(&self.conversation_id);
        }
        crate::sidecar::adapters::acp::close_conversation_instances(&self.conversation_id);
        // The delegate is done: park its child Box and free its sub-agent
        // number, so later delegates neither share one number nor keep
        // finished children's Boxes registered.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let conversation_id = self.conversation_id.clone();
            handle.spawn(async move {
                crate::sidecar::mcp::box_desktop::release_child_conversation(&conversation_id)
                    .await;
            });
        }
    }
}

async fn call_sub_agent(
    spec: &DelegateSpec,
    max_tokens: u32,
    execution_policy: DelegationExecutionPolicy,
) -> Result<SubAgentCall, SubAgentError> {
    // Only an explicitly mutation-capable delegate may enter a registered agent's
    // full tool loop. Research/read/summarise presets use the clean completion path
    // below, so their read-only promise cannot be bypassed by naming a powerful
    // registered agent.
    //
    // An **inline** ephemeral definition always takes the clean-context Gateway
    // path below, regardless of any `agent_id` also present. This keeps precedence
    // identical across every entry point (the `delegate.fanout` tool, the workflow
    // `AgentDelegate` node, and the raw `/api/delegate/stream` API) and independent
    // of whether a runner happens to be live: `inline` set ⇒ inline runs, period.
    if should_use_registered_agent(spec, execution_policy) {
        if let Some(id) = spec.agent_id.as_deref().filter(|s| !s.is_empty()) {
            if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                let conversation_id = format!("delegate-{}", uuid::Uuid::new_v4().simple());
                crate::sidecar::mcp::box_desktop::bind_child_conversation(&conversation_id);
                let mut guard = DelegateConversationGuard {
                    conversation_id: conversation_id.clone(),
                    finished: false,
                };
                let text = runner
                    .run_with_max_tokens(
                        Some(id.to_string()),
                        conversation_id.clone(),
                        spec.task.clone(),
                        max_tokens,
                    )
                    .await;
                guard.finished = true;
                let text = text.map_err(|e| {
                    SubAgentError::with_child(
                        format!("delegate '{id}' failed: {e}"),
                        conversation_id.clone(),
                    )
                })?;
                return Ok(SubAgentCall {
                    text,
                    child_conversation_id: Some(conversation_id),
                });
            }
        }
    }

    let gw_url = crate::sidecar::gateway::gateway_url();
    let gw_token = crate::sidecar::gateway::gateway_inference_token();

    // Model + clean-context system message. An inline ephemeral agent definition
    // (an LLM-authored "dynamic subagent" with no registered `agent_id`) overrides
    // the preset-derived model and system prompt; otherwise the preset supplies
    // both. Either way this is a single clean-context completion routed through the
    // Gateway — no parent conversation history is ever included.
    let env_model = || {
        std::env::var("RYU_DEFAULT_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gpt-4o-mini".to_string())
    };
    let (model, system) = match spec.inline.as_ref() {
        Some(inline) => {
            let model = inline
                .model
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(env_model);
            let advertised = if inline.tools.is_empty() {
                "none".to_string()
            } else {
                inline.tools.join(", ")
            };
            let system = format!(
                "{}\n\nYou are a Ryu sub-agent running in a clean context: you have no \
                 access to the parent agent's conversation history — work only from the \
                 task below. Advertised tools: {}.",
                inline.system_prompt.trim(),
                advertised,
            );
            (model, system)
        }
        None => {
            let system = format!(
                "You are a Ryu sub-agent running under the '{:?}' permission preset. \
                 Allowed tools: {}. You have no access to the parent agent's conversation \
                 history; work only from the task below.",
                spec.preset,
                spec.preset.allowed_tools().join(", "),
            );
            (env_model(), system)
        }
    };

    let payload = serde_json::json!({
        "model": model,
        "stream": false,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": spec.task },
        ],
    });

    let client = crate::sidecar::gateway::gateway_http_client();
    let endpoint = format!("{}/v1/chat/completions", gw_url.trim_end_matches('/'));
    let mut builder = crate::sidecar::gateway::with_side_call_headers(
        client.post(&endpoint).json(&payload),
        &crate::sidecar::gateway::SidePurpose::Delegate,
    );
    if let Some(token) = gw_token.as_deref() {
        builder = builder.bearer_auth(token);
    }

    let result = builder.send().await;

    match result {
        Err(e) => {
            // Gateway unreachable — fail-closed unless fallback is opted in.
            let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
                .map(|v| v == "1")
                .unwrap_or(false);
            if allow_fallback {
                // Opt-in: fall back to direct provider POST using the legacy env vars.
                call_sub_agent_direct(spec, max_tokens, &payload)
                    .await
                    .map(|text| SubAgentCall {
                        text,
                        child_conversation_id: None,
                    })
                    .map_err(SubAgentError::new)
            } else {
                Err(SubAgentError::new(format!(
                    "sub-agent: fail-closed — gateway unreachable at {gw_url} \
                     and RYU_ALLOW_GATEWAY_FALLBACK is not set: {e}"
                )))
            }
        }
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let retry_after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let body = resp.text().await.unwrap_or_default();
                return Err(SubAgentError::new(
                    super::super::limits::gateway_error_message(
                        "sub-agent",
                        status,
                        retry_after.as_deref(),
                        &body,
                    ),
                ));
            }
            let body: serde_json::Value = resp.json().await.map_err(|e| {
                SubAgentError::new(format!("sub-agent: invalid gateway response: {e}"))
            })?;
            crate::sidecar::gateway::log_side_usage(
                &crate::sidecar::gateway::SidePurpose::Delegate,
                &model,
                &body,
            );
            Ok(SubAgentCall {
                text: extract_completion_text(&body),
                child_conversation_id: None,
            })
        }
    }
}

/// Opt-in direct-provider fallback for `call_sub_agent` (only used when
/// `RYU_ALLOW_GATEWAY_FALLBACK=1`). Mirrors the legacy env-var approach so
/// test helpers that point at a blackhole can still exercise wall-time caps.
/// Keyless only: a call that would carry a provider credential is refused, so
/// the switch never takes a key around the Gateway (CE-37).
async fn call_sub_agent_direct(
    spec: &DelegateSpec,
    _max_tokens: u32,
    payload: &serde_json::Value,
) -> Result<String, String> {
    let base_url = std::env::var("RYU_DEFAULT_LLM_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com".to_string());
    let api_key = std::env::var("RYU_DEFAULT_LLM_API_KEY")
        .ok()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|s| !s.is_empty());
    if let Some(refusal) =
        crate::sidecar::adapters::keyed_direct_hop_refusal(&base_url, api_key.as_deref())
    {
        return Err(format!("sub-agent (direct): {refusal}"));
    }

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(payload);
    if let Some(key) = api_key.as_deref() {
        builder = builder.bearer_auth(key);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("sub-agent (direct): provider unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "sub-agent (direct): provider returned HTTP {}",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("sub-agent (direct): invalid response: {e}"))?;
    let _ = spec; // suppress unused warning
    Ok(extract_completion_text(&body))
}

/// Extract the assistant content text from an OpenAI-compatible completion response.
fn extract_completion_text(body: &serde_json::Value) -> String {
    body.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string()
}
