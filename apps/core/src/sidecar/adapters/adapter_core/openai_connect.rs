use super::*;

/// Build and send the OpenAI-compat HTTP request, returning the upstream response
/// or a transport-level error string. Separating the connection step from streaming
/// allows the caller to fall back to an alternative provider on transport failure
/// before committing to a stream (self-healing, AC1/AC2).
///
/// `slots` carries the agent's per-attribute modality slot selections (M3 / #164).
/// When forwarding to the ryu-gateway, these are attached as `x-ryu-slot-*`
/// headers so the gateway can route each modality call to the provider specified
/// on the agent card rather than the static `modality_map` default. On the
/// direct-to-provider path the headers are sent but harmlessly ignored.
pub(crate) async fn connect_openai(
    messages: &[Value],
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    agent_id: Option<&str>,
    // Verified Better Auth user id of the caller (from the inbound `x-ryu-user-id`
    // header via `identity_from_headers`, stamped onto `ChatStreamRequest`). Forwarded
    // as `x-ryu-user-id` so the gateway's per-user usage attribution / budgets are live.
    // `None` in the single-tenant / loopback (anonymous) flow.
    user_id: Option<&str>,
    // The verified caller's Better Auth JWT, forwarded as `x-ryu-user-jwt` so a
    // hosted gateway can verify the attribution itself (an `rgw_` gateway
    // ignores the bare `x-ryu-user-id`). `Some` ONLY on the gateway-forward
    // hop: it is a credential and must never reach a raw provider endpoint.
    user_jwt: Option<&str>,
    // Active skill ids for Gateway attribution (AC3). Forwarded as
    // `x-ryu-skill-ids: id1,id2` so the Gateway can record them in the audit row.
    skill_ids: &[String],
    // Per-agent Composio action allowlist (#456). Forwarded as
    // `x-ryu-composio-actions: A,B` so the gateway's Composio tool loop offers and
    // executes only these actions for this agent.
    composio_actions: &[String],
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    // Forwarded as `x-ryu-session-id` so the gateway can key audit rows to a session.
    session_id: Option<&str>,
    // Per-attribute modality slot overrides (M3 / #164). Each populated slot is
    // forwarded as `x-ryu-slot-<modality>-provider` / `x-ryu-slot-<modality>-model`
    // so the gateway can route the same agent's image/TTS/STT calls differently.
    slots: &AgentSlots,
    // True when the request originates from the context companion (M7 / #199).
    // Forwarded as `x-ryu-companion-source` so Gateway DLP fires unconditionally.
    companion_source: bool,
    // True for programmatic background fan-out. Forwarded as `x-ryu-priority:
    // background` so the gateway's local-engine admission queue serves
    // interactive turns first when the resident engine's slots are full.
    background: bool,
    // Advanced sampling params, merged into the body below and translated for
    // `sampling_engine` (field names differ per engine; the remote-OpenAI safety
    // gate lives inside `apply_to_body`).
    sampling: &crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
    // OpenAI-compat `tools` array for the Core-owned governed chat tool loop
    // (R1 / A3-A4). Empty on the ordinary no-tool chat path (unchanged). When
    // non-empty it is attached to the request body AND `x-ryu-raw-tools: on` is
    // set so the gateway passes `tools`/`tool_calls` through untouched (Core owns
    // the loop; the gateway still governs each dispatch via `/v1/exec/tool`).
    tools: &[Value],
    // Core's saved per-agent capability allowlist. Suggestions never widen it.
    tool_allowlist: Option<&[String]>,
    // JSON-encoded, turn-scoped capability hint IDs. Never persisted.
    capability_hints: Option<&str>,
    // Per-agent Plane A model-routing override (spec §1). When `Some`, Core injects
    // it into the body as `ryu_smart_route`; the gateway reads and strips it,
    // building an ephemeral per-agent smart router for this request. Only ever set
    // on the gateway-forward path — the raw provider on the fallback leg never sees
    // it (an unknown body field can 400 a strict OpenAI endpoint).
    smart_route_override: Option<&Value>,
    // This node's own routing PREFERENCES, pre-encoded as the `x-ryu-node-routing`
    // value. Forwarded ONLY on the gateway-forward path, for the same reason
    // `ryu_smart_route` is: a raw provider endpoint handles an unknown header far
    // less gracefully than a gateway ignores one. `None` on an untouched install,
    // which keeps the request byte-identical to before this channel existed.
    node_routing: Option<String>,
    // Provider-native llama.cpp control is request-scoped and must never be
    // inferred for a Gateway or arbitrary OpenAI-compatible endpoint.
    reasoning_control: bool,
    // The turn is spoken by an unverified caller. On the Gateway hop this adds
    // the restrict-only headers from `caller_trust_headers`.
    untrusted_caller: bool,
    // Endpoint kind, which picks the idle-read limit (see `StreamHop`).
    stream_hop: StreamHop,
    // The conversation the Gateway's tool loop may act for, already checked to
    // be owned by the turn's author (`gateway_host_conversation_for_turn`).
    // Sent with its proof on the Gateway hop only.
    host_conversation_id: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut payload_map = serde_json::Map::new();
    payload_map.insert("model".to_owned(), Value::String(model.to_owned()));
    payload_map.insert("stream".to_owned(), Value::Bool(true));
    // Ask any OpenAI-compatible endpoint to emit a final `usage` chunk
    // (prompt/completion/total tokens). llama.cpp additionally streams a
    // non-standard `timings` object with `predicted_per_second` — both feed the
    // per-message inference stats surfaced by `build_stats_part` (mirrors Jan's
    // `includeUsage: true`). Harmless to providers that ignore the option.
    payload_map.insert(
        "stream_options".to_owned(),
        serde_json::json!({ "include_usage": true }),
    );
    payload_map.insert("messages".to_owned(), Value::Array(messages.to_vec()));
    // Governed chat tool loop (R1): offer the app tools so the model can call a
    // widget-rendering tool. Only set when non-empty, so the ordinary no-tool
    // chat body is byte-for-byte unchanged.
    if !tools.is_empty() {
        payload_map.insert("tools".to_owned(), Value::Array(tools.to_vec()));
    }
    // Per-agent Plane A override (spec §1): inject the agent's private
    // `SmartRoutingConfig` so the gateway routes THIS request with the agent's own
    // rules instead of the global smart router. Opaque to Core; the gateway strips
    // it before the provider call. Only present on the gateway-forward path.
    if let Some(cfg) = smart_route_override {
        payload_map.insert("ryu_smart_route".to_owned(), cfg.clone());
    }
    // Merge advanced sampling (temperature/top_p/top_k/penalties/…). No-op when the
    // agent set nothing, so the body stays identical to the pre-feature shape.
    if !sampling.is_empty() {
        sampling.apply_to_body(sampling_engine, &mut payload_map);
    }
    if reasoning_control {
        payload_map.insert("reasoning_control".to_owned(), Value::Bool(true));
    }
    let payload = Value::Object(payload_map);

    let client = stream_hop.http_client();
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let mut builder = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    if let Some(aid) = agent_id.filter(|a| !a.is_empty()) {
        let to_gateway = base_url.trim_end_matches('/')
            == crate::sidecar::gateway::gateway_url().trim_end_matches('/');
        // Gateway skips every provider outside the agent's access; a direct
        // (fallback) hop with a provider key cannot be limited, so it is refused.
        if let Some(access) =
            provider_access_for_hop(to_gateway, agent_provider_access_header(aid).await, api_key)?
        {
            builder = builder.header("x-ryu-agent-provider-access", access);
        }
        builder = builder.header("x-ryu-agent-id", aid);
        // Only the configured Gateway receives Core's bearer-bound agent proof.
        // Direct-provider fallback requests must never receive this authority.
        if to_gateway {
            let bearer = api_key
                .filter(|key| !key.is_empty())
                .ok_or_else(|| "Gateway inference credential unavailable".to_owned())?;
            if let Some(proof) = crate::sidecar::gateway::gateway_inference_agent_proof(bearer, aid)
                .map_err(|error| format!("Gateway agent proof unavailable: {error}"))?
            {
                builder = builder.header("x-ryu-agent-proof", proof);
            }
        }
    }
    // Forward the verified caller so the gateway's per-user usage attribution and
    // per-user budgets are live (previously never sent, leaving them inert). Only
    // set when non-empty — anonymous/loopback turns leave it off, as before.
    if let Some(uid) = user_id.filter(|u| !u.is_empty()) {
        builder = builder.header("x-ryu-user-id", uid);
    }
    if let Some(jwt) = user_jwt.filter(|token| !token.is_empty()) {
        builder = builder.header("x-ryu-user-jwt", jwt);
    }
    // Feature tag so the gateway can attribute usage/budgets per feature. This
    // connector serves the chat-completions path exclusively (only reached via
    // `route_openai_stream`); programmatic turns with no human author are agent
    // usage, not chat.
    builder = builder.header("x-ryu-feature", chat_feature_tag(background, user_id));
    // Raw-tools passthrough (R1 / A4): when Core offers its own `tools`, the
    // gateway must NOT run its managed tool loop over them — it passes `tools` and
    // the model's `tool_calls` through untouched, so Core owns the loop while chat
    // egress stays governed. An unverified caller's turn also marks the Gateway
    // hop (see `caller_trust_headers`).
    let gateway_hop = base_url.trim_end_matches('/')
        == crate::sidecar::gateway::gateway_url().trim_end_matches('/');
    for (name, value) in caller_trust_headers(
        gateway_hop,
        untrusted_caller,
        !tools.is_empty(),
        tool_allowlist,
    ) {
        builder = builder.header(name, value);
    }
    // Thread the Core session/conversation id so the gateway can correlate audit
    // rows back to a specific chat run without a separate session store (M4 / #176).
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        builder = builder.header("x-ryu-session-id", sid);
    }
    for (name, value) in host_conversation_headers(gateway_hop, host_conversation_id) {
        builder = builder.header(name, value);
    }
    // Provider prompt caching: the user's node-level preference, forwarded as
    // `x-ryu-prompt-cache`. Sent ONLY when the user has actually set it, so an
    // untouched install leaves the gateway's own `[prompt_cache]` policy in
    // charge instead of pinning it from here.
    if let Some(mode) = prompt_cache_pref(PROMPT_CACHE_PREF, is_prompt_cache_mode).await {
        builder = builder.header("x-ryu-prompt-cache", mode);
    }
    if let Some(ttl) = prompt_cache_pref(PROMPT_CACHE_TTL_PREF, is_prompt_cache_ttl).await {
        builder = builder.header("x-ryu-prompt-cache-ttl", ttl);
    }
    // This node's routing preferences (fallback order + its own extra firewall
    // rules), which on a remote data plane have no other way to reach the fleet.
    // Already gated to the gateway-forward leg by the caller; omitted entirely
    // when the node has stated none. The fleet clamps every knob so it can only
    // narrow the org's envelope, and IGNORES anything it cannot honour — a
    // preference must never fail a turn that would otherwise succeed.
    if let Some(prefs) = node_routing.filter(|p| !p.is_empty()) {
        builder = builder.header("x-ryu-node-routing", prefs);
    }
    // Companion-source tag (M7 / #199): when set, the gateway applies unconditional
    // DLP/PII redaction before the provider call regardless of local firewall config.
    if companion_source {
        builder = builder.header("x-ryu-companion-source", "true");
    }
    // Admission priority for the shared local engine (interactive vs background).
    // Only background is forwarded — the gateway defaults an absent header to
    // interactive, so a directly-typing user never needs the header.
    if background {
        builder = builder.header("x-ryu-priority", "background");
    }
    if !skill_ids.is_empty() {
        builder = builder.header("x-ryu-skill-ids", skill_ids.join(","));
    }
    // Per-agent egress allowlist (#456/#477): the gateway uses this to scope
    // both normal tool calls and the automatic capability suggestions.
    let mut tool_ids = tool_allowlist
        .map(|allow| allow.to_vec())
        .unwrap_or_default();
    if !composio_actions.is_empty() {
        builder = builder.header("x-ryu-composio-actions", composio_actions.join(","));
        for slug in composio_actions {
            let id = format!("composio.{slug}");
            if !tool_ids.contains(&id) {
                tool_ids.push(id);
            }
        }
    }
    if tool_allowlist.is_some() || !tool_ids.is_empty() {
        builder = builder.header("x-ryu-tools", tool_ids.join(","));
    }
    if let Some(hints) = capability_hints.filter(|value| !value.is_empty()) {
        builder = builder.header("x-ryu-capability-hints", hints);
    }
    // Forward per-attribute slot selections so the gateway can apply
    // per-agent modality routing (M3 / #164). Each slot that has a provider
    // set emits `x-ryu-slot-<modality>-provider`; model is emitted only when
    // explicitly set on the slot so the gateway falls back to the modality map
    // or caller model when the agent card doesn't pin a specific model.
    //
    // Chat slot: gateway's pre_process calls route_modality_with_slot(Chat,...)
    // when x-ryu-slot-chat-provider is present, overriding eval/model routing.
    if let Some((prov, mdl)) = &slots.chat {
        builder = builder.header("x-ryu-slot-chat-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-chat-model", m.as_str());
        }
    }
    // Image/TTS/STT slots are forwarded on the chat call as pre-registration so
    // the gateway session context knows the agent's modality preferences. They
    // are also forwarded on the respective modality calls when those are made.
    if let Some((prov, mdl)) = &slots.image {
        builder = builder.header("x-ryu-slot-image-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-image-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.video {
        builder = builder.header("x-ryu-slot-video-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-video-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.tts {
        builder = builder.header("x-ryu-slot-tts-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-tts-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.stt {
        builder = builder.header("x-ryu-slot-stt-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-stt-model", m.as_str());
        }
    }
    // W3C trace context from the current turn span, so the Gateway's model-call
    // span nests under `invoke_agent`. No-op without an exportable context.
    let mut trace_headers = reqwest::header::HeaderMap::new();
    crate::telemetry::propagation::inject_current(&mut trace_headers);
    if !trace_headers.is_empty() {
        builder = builder.headers(trace_headers);
    }
    builder.send().await.map_err(|e| {
        format!(
            "Agent unreachable: {}",
            describe_stream_error(&e, stream_hop.idle_read_timeout())
        )
    })
}
