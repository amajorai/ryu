use super::*;

/// Attempt a primary OpenAI-compat connection; on transport failure, retry once
/// with each fallback in `fallback_chain` (single bounded retry per AC1).
/// Returns `Ok(upstream_response)` from whichever attempt succeeds first, or
/// `Err(last_error)` if every attempt fails.
///
/// Recovery attempts are logged via tracing with the original failure cause (AC4).
pub(crate) async fn connect_with_fallback(
    messages: &[Value],
    primary_base_url: &str,
    primary_model: &str,
    primary_api_key: Option<&str>,
    primary_agent_id: Option<&str>,
    // Verified caller user id forwarded to the gateway as `x-ryu-user-id` for
    // per-user attribution/budgets. `None` for anonymous/loopback turns.
    user_id: Option<&str>,
    // Verified caller JWT for the primary gateway attempt only (see
    // `connect_openai`); the raw-provider fallback leg never receives it.
    user_jwt: Option<&str>,
    // Active skill ids forwarded to Gateway attribution (M3 / #145 AC3).
    skill_ids: &[String],
    // Per-agent Composio action allowlist forwarded to the gateway (#456).
    composio_actions: &[String],
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    session_id: Option<&str>,
    fallback_chain: &[FallbackProvider],
    // Per-attribute slot overrides forwarded to the gateway (M3 / #164).
    slots: &AgentSlots,
    // Companion-source tag (M7 / #199): forwarded to trigger Gateway DLP.
    companion_source: bool,
    // Background fan-out tag (#queue): forwarded as `x-ryu-priority: background`.
    background: bool,
    // Advanced sampling params + the engine governing field-name translation.
    sampling: &crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
    // Governed chat tool-loop `tools` array (R1). Empty on the no-tool path.
    tools: &[Value],
    tool_allowlist: Option<&[String]>,
    capability_hints: Option<&str>,
    // Per-agent Plane A `ryu_smart_route` override (spec §1), forwarded ONLY on the
    // primary gateway-forward attempt. The fallback leg targets a raw provider, so
    // it is deliberately omitted there (the gateway strips the field; a provider
    // may 400 on it).
    smart_route_override: Option<&Value>,
    // This node's pre-encoded `x-ryu-node-routing` preferences. Like
    // `smart_route_override`, forwarded only on the primary gateway-forward
    // attempt; the fallback leg targets a raw provider.
    node_routing: Option<String>,
    reasoning_control: bool,
    // The turn is spoken by an unverified caller (see `connect_openai`).
    untrusted_caller: bool,
    // Endpoint kind of the primary hop. The fallback leg is always a provider.
    stream_hop: StreamHop,
    // Author-owned host conversation for the primary Gateway attempt only.
    host_conversation_id: Option<&str>,
) -> Result<reqwest::Response, String> {
    match connect_openai(
        messages,
        primary_base_url,
        primary_model,
        primary_api_key,
        primary_agent_id,
        user_id,
        user_jwt,
        skill_ids,
        composio_actions,
        session_id,
        slots,
        companion_source,
        background,
        sampling,
        sampling_engine,
        tools,
        tool_allowlist,
        capability_hints,
        smart_route_override,
        node_routing,
        reasoning_control,
        untrusted_caller,
        stream_hop,
        host_conversation_id,
    )
    .await
    {
        Ok(resp) => Ok(resp),
        Err(primary_err) => {
            if fallback_chain.is_empty() {
                return Err(primary_err);
            }
            // Single bounded fallback: try the first entry in the chain.
            // Slot overrides are not forwarded on the fallback path because the
            // fallback provider may not support the same slots; the gateway's own
            // fallback chain and modality_map take over from here.
            let fallback = &fallback_chain[0];
            tracing::warn!(
                primary_base_url = %primary_base_url,
                fallback_base_url = %fallback.base_url,
                cause = %primary_err,
                "ryu-agent: primary provider failed; attempting fallback recovery"
            );
            match connect_openai(
                messages,
                &fallback.base_url,
                &fallback.model,
                fallback.api_key.as_deref(),
                primary_agent_id,
                user_id,
                // A raw provider endpoint must never receive the user credential.
                None,
                skill_ids,
                composio_actions,
                session_id,
                &AgentSlots::default(),
                // Companion DLP must apply on the fallback path too (AC3 / #199).
                companion_source,
                background,
                sampling,
                sampling_engine,
                tools,
                None,
                None,
                // The fallback provider is a raw endpoint, not the gateway; never
                // send the gateway-only `ryu_smart_route` field to it.
                None,
                // Same discipline for the node-routing header: a strict endpoint
                // can reject an unknown header far less gracefully than it ignores
                // an unknown body field.
                None,
                false,
                // A raw provider runs no managed tool loop to restrict.
                false,
                StreamHop::Provider,
                // …nor relays a host conversation to Core.
                None,
            )
            .await
            {
                Ok(resp) => {
                    tracing::info!(
                        fallback_base_url = %fallback.base_url,
                        "ryu-agent: fallback recovery succeeded"
                    );
                    Ok(resp)
                }
                Err(fallback_err) => {
                    tracing::warn!(
                        primary_err = %primary_err,
                        fallback_err = %fallback_err,
                        "ryu-agent: fallback recovery also failed; returning error to client"
                    );
                    Err(format!(
                        "Primary provider failed ({primary_err}); fallback also failed ({fallback_err})"
                    ))
                }
            }
        }
    }
}
