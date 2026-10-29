//! Shared input governance and irreversible usage settlement for nonrecursive provider operations.
use super::*;

#[async_trait::async_trait]
pub(crate) trait InferenceClient: Send + Sync {
    fn scope(&self) -> String;
    async fn complete(
        &self,
        model: &str,
        body: Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, GatewayError>;
    async fn embed(
        &self,
        model: &str,
        text: &str,
        timeout_ms: u64,
    ) -> Result<Option<Vec<f32>>, GatewayError>;
}

pub(super) fn authorize_model(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
) -> Result<(), GatewayError> {
    if !ctx.is_master_key
        && !ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| state.policy_snapshot())
            .allows_model(model)
    {
        return Err(GatewayError::PolicyViolation(format!(
            "Model '{model}' is not approved by control-plane policy"
        )));
    }
    Ok(())
}

/// Whether a provider slot uses none of the user's own credentials: Ryu's own
/// platform-credit supply, the keyless local engine, the classify tier, or a
/// keyless SDK route. These stay open to an agent whatever its provider access.
/// The slot list is shared with Core through `ryu_gw_router`
/// (`own_supply_slots_match_the_router_crate` pins it to the pool table).
fn provider_needs_no_user_credential(provider: &str) -> bool {
    ryu_gw_router::slot_uses_no_user_credential(provider)
        || ryu_gw_credentials::sdk_provider_by_id(provider)
            .is_some_and(|sdk| sdk.auth_kind == ryu_gw_credentials::SdkAuthKind::NoAuth)
}

/// Whether this request is a hosted organisation's managed inference on a
/// gateway that bills tenants: a control-plane resolved `rgw_` tenant
/// (`managed_inference` is set only on that path) on a gateway holding the
/// credits debit secret. Such a tenant is always served from the fleet's own
/// provider keys and billed to the organisation's wallet; there is no per-org
/// or per-user key on that path (see `ResolvedOrg::metered_credit`). So no slot
/// it reaches holds the user's own credentials. A gateway that does not bill
/// may be holding the operator's own keys, which can be the user's, so it is
/// never exempt.
fn serves_tenant_from_fleet_supply(state: &AppState, ctx: &RequestContext) -> bool {
    ctx.managed_inference
        && !ctx.is_master_key
        && ctx.org_id.is_some()
        && state.config.credits.is_active()
}

/// Enforce the calling agent's model provider access (its `provider:<id>`
/// account keys, resolved by Core). Runs before every other provider check,
/// including the master-key bypass: the list only narrows, so it binds every
/// caller that presents it. A denied provider is skipped like any other
/// policy refusal, so pools and fallbacks move on to an allowed slot.
///
/// The list limits only the user's own credentials. Slots that need none, and
/// a hosted organisation's fleet-served managed inference, stay open; the
/// organisation's model and provider/region policy still applies to them in
/// the callers below.
pub(super) fn authorize_agent_provider(
    state: &AppState,
    ctx: &RequestContext,
    provider: &crate::config::ProviderId,
) -> Result<(), GatewayError> {
    let Some(allowed) = ctx.agent_provider_access.as_deref() else {
        return Ok(());
    };
    let provider = provider.as_str();
    if provider_needs_no_user_credential(provider)
        || serves_tenant_from_fleet_supply(state, ctx)
        || allowed.contains(provider)
    {
        return Ok(());
    }
    Err(GatewayError::PolicyViolation(format!(
        "Provider '{provider}' is not in this agent's account access"
    )))
}

/// Enforce the resolved provider/data-region policy immediately before a
/// provider can be selected for dispatch. Providers without verified metadata
/// are denied when the policy contains an allowed-region restriction.
pub(super) fn authorize_provider_region(
    state: &AppState,
    ctx: &RequestContext,
    provider: &crate::config::ProviderId,
) -> Result<(), GatewayError> {
    authorize_agent_provider(state, ctx, provider)?;
    if ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    let region = super::provider_snapshot(&state, &ctx)
        .providers
        .region_for(provider.as_str());
    if !policy.allows_provider(provider.as_str()) || !policy.allows_region(region.as_deref()) {
        return Err(GatewayError::PolicyViolation(format!(
            "Provider '{}' is not authorized for the control-plane provider or region policy",
            provider.as_str()
        )));
    }
    Ok(())
}

/// Region authorization for a route already bound to the request's captured
/// provider snapshot. This prevents a later runtime publication from changing
/// the metadata checked by governance before the owned provider dispatches.
pub(super) fn authorize_bound_route_region(
    state: &AppState,
    ctx: &RequestContext,
    route: &crate::providers::BoundRoute,
) -> Result<(), GatewayError> {
    authorize_agent_provider(state, ctx, &route.provider_id)?;
    if ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    if !policy.allows_provider(route.provider_id.as_str())
        || !policy.allows_region(route.region.as_deref())
    {
        return Err(GatewayError::PolicyViolation(format!(
            "Provider '{}' is not authorized for the control-plane provider or region policy",
            route.provider_id.as_str()
        )));
    }
    Ok(())
}

/// Apply tenant-locked guardrails using the resolved request scanner. This is
/// shared by text, multimodal, and job-based media paths so modality routes
/// cannot silently fall back to the node-only firewall.
pub(super) fn enforce_locked_guardrails(
    state: &AppState,
    ctx: &RequestContext,
    text: &str,
) -> Result<(), GatewayError> {
    if ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    if !policy.available {
        return Err(GatewayError::PolicyViolation(
            "Control-plane policy is unavailable".into(),
        ));
    }
    if policy.requires_firewall()
        && state
            .resolved_scanner(ctx)
            .scan_locked_guardrails(text, &policy.locked_guardrails)
            .is_some()
    {
        return Err(GatewayError::PolicyViolation(
            "Provider input violates a locked guardrail".into(),
        ));
    }
    Ok(())
}

/// Locked guardrails for tool/function definitions: the secret and PII
/// categories only (see `definition_dlp_guardrails`). Runs after
/// [`enforce_locked_guardrails`], which already refused an unavailable policy.
pub(super) fn enforce_locked_dlp_on_definitions(
    state: &AppState,
    ctx: &RequestContext,
    definition_text: &str,
) -> Result<(), GatewayError> {
    if definition_text.is_empty() || ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    let categories = definition_dlp_guardrails(&policy.locked_guardrails);
    if policy.requires_firewall()
        && !categories.is_empty()
        && state
            .resolved_scanner(ctx)
            .scan_locked_guardrails(definition_text, &categories)
            .is_some()
    {
        return Err(GatewayError::PolicyViolation(
            "Provider input violates a locked guardrail".into(),
        ));
    }
    Ok(())
}

/// Locked guardrails over the residual leaves (see `outbound_text`). Runs
/// after [`enforce_locked_guardrails`], which already refused an unavailable
/// policy.
pub(super) fn enforce_locked_guardrails_on_residual(
    state: &AppState,
    ctx: &RequestContext,
    residual: &super::outbound_text::Residual,
) -> Result<(), GatewayError> {
    if ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    if !policy.requires_firewall() {
        return Ok(());
    }
    let scanner = state.resolved_scanner(ctx);
    if super::outbound_text::residual_locked_violation(
        state,
        scanner.as_ref(),
        &policy.locked_guardrails,
        residual,
    )?
    .is_some()
    {
        return Err(GatewayError::PolicyViolation(
            "Provider input violates a locked guardrail".into(),
        ));
    }
    Ok(())
}

/// Inspect and transform the text-bearing fields of a non-chat request using
/// the same resolved tenant scanner as chat/embedding input. This is deliberately
/// separate from `enforce_locked_guardrails`: locked rules always see the
/// original input, while a normal `Sanitize` policy must rewrite what reaches the
/// provider instead of merely logging a match.
pub(super) fn inspect_multimodal_input(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    modality: &Modality,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let original = governed_multimodal_text(body, modality);
    if original.len() > super::outbound_text::MAX_SCREENED_BYTES {
        return Err(super::outbound_text::governed_text_too_large(state));
    }
    // Every other string the provider receives (a nested Replicate/Fal
    // `input`, OpenRouter image `messages`, extra speech fields, the
    // transcription `prompt`). Detection-only: see `outbound_text`.
    // The slot model header replaces `model` on dispatch, so it is screened
    // with the body like `model` itself.
    let slot_model = ctx.slot_model.as_deref();
    let mut residual = multimodal_residual(body, modality).with_control_token(slot_model);
    enforce_locked_guardrails(state, ctx, &original)?;
    enforce_locked_guardrails_on_residual(state, ctx, &residual)?;
    let scanner = state.resolved_scanner(ctx);
    let mut alert = None;
    if let Some(hit) = scanner.scan_inbound(&original) {
        super::note_firewall_match(state, ctx, &hit, &scanner.policy());
        match scanner.policy() {
            FirewallPolicy::Block => {
                return Err(GatewayError::FirewallBlocked(
                    format!("Provider input blocked: {}", hit.pattern_name),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            FirewallPolicy::Sanitize => {
                sanitize_multimodal_text(body, modality, scanner.as_ref());
                residual = multimodal_residual(body, modality).with_control_token(slot_model);
            }
            FirewallPolicy::WarnAndContinue => {
                alert = firewall_policy_alert(scanner.config(), ctx, "notify");
            }
        }
    }
    let residual_alert =
        super::outbound_text::screen_residual_inbound(state, ctx, scanner.as_ref(), &residual)?;
    alert = super::merge_alert(alert, residual_alert);
    if ctx.companion_source {
        redact_companion_multimodal_text(body, modality, scanner.as_ref());
    }
    Ok(alert)
}

/// The residual of a non-chat request: every string outside the fields
/// [`multimodal_text_fields`] governs (see `outbound_text`). The governed
/// leaves are marked by reference, so each raw leaf is screened once.
fn multimodal_residual(body: &Value, modality: &Modality) -> super::outbound_text::Residual {
    super::outbound_text::residual_text(body, |visit| {
        visit_multimodal_text_leaves(body, modality, visit);
    })
}

/// Visits, by reference into `body`, exactly the leaves
/// [`multimodal_text_fields`] reads.
fn visit_multimodal_text_leaves(body: &Value, modality: &Modality, visit: &mut dyn FnMut(&str)) {
    match modality {
        Modality::Tts => {
            for key in TTS_TEXT_KEYS {
                if let Some(text) = body[key].as_str() {
                    visit(text);
                }
            }
        }
        Modality::Image | Modality::Video | Modality::Audio => {
            if let Some(text) = body["prompt"].as_str() {
                visit(text);
            }
            if let Some(object) = body.as_object() {
                for (key, value) in object {
                    if key == "prompt" || MEDIA_CONTROL_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    visit_text_leaves(value, super::outbound_text::is_media_zone_key(key), visit);
                }
            }
        }
        Modality::Stt | Modality::Chat => {}
    }
}

fn visit_text_leaves(value: &Value, media_zone: bool, visit: &mut dyn FnMut(&str)) {
    match value {
        Value::String(text) if is_scanned_leaf(text, media_zone) => visit(text),
        Value::Array(items) => {
            for item in items {
                visit_text_leaves(item, media_zone, visit);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                visit_text_leaves(
                    item,
                    media_zone || super::outbound_text::is_media_zone_key(key),
                    visit,
                );
            }
        }
        _ => {}
    }
}

/// Whether a string leaf is text the provider reads and the leaf scan covers:
/// not inline base64 media, and, inside a media zone (a key naming an image,
/// audio, video or file input), not a long base64 run either.
fn is_scanned_leaf(text: &str, media_zone: bool) -> bool {
    !is_inline_media(text) && !(media_zone && super::outbound_text::is_media_zone_blob(text))
}

/// Every governed text field, joined for the locked guardrails and the
/// inbound scan (see [`multimodal_text_fields`]).
fn governed_multimodal_text(body: &Value, modality: &Modality) -> String {
    super::multimodal_input_text(body, modality)
}

fn sanitize_multimodal_text(
    body: &mut Value,
    modality: &Modality,
    scanner: &dyn crate::firewall::FirewallBackend,
) {
    for text in multimodal_text_fields_mut(body, modality) {
        rewrite_scanned_text(text, |scanned| scanner.sanitize(scanned));
    }
}

fn redact_companion_multimodal_text(
    body: &mut Value,
    modality: &Modality,
    scanner: &crate::firewall::FirewallScanner,
) {
    for text in multimodal_text_fields_mut(body, modality) {
        rewrite_scanned_text(text, |scanned| scanner.redact_companion_egress(scanned).0);
    }
}

/// Top-level routing and correlation fields of a media body. They select the
/// model and route rather than carry user content, so the leaf scan leaves them
/// alone (rewriting a model id would only break routing).
const MEDIA_CONTROL_KEYS: [&str; 5] = ["model", "provider", "n", "request_id", "project_id"];

/// The provider-bound free-text fields of a speech request. Speech
/// `instructions` steers delivery and reaches chat-audio models as a system
/// message, so it is governed together with `input`.
const TTS_TEXT_KEYS: [&str; 2] = ["input", "instructions"];

/// Every provider-bound text field of a non-chat request, in a stable order.
///
/// - TTS: the `input` text, then any non-empty `instructions`.
/// - Image, video and audio: `prompt` first, then every other string leaf of
///   the body except inline base64 media and the routing keys above. Core
///   merges an app's `provider_input` object into the body for cloud
///   providers, so model-specific text such as a negative prompt, lyrics or a
///   caption arrives as an arbitrary (possibly nested) field; scanning only
///   `prompt` would let that text bypass DLP. See [`scanned_text`] for what
///   part of a leaf is scanned.
/// - STT and chat: none here (chat has its own message scan).
pub(super) fn multimodal_text_fields(body: &Value, modality: &Modality) -> Vec<String> {
    let mut fields = Vec::new();
    match modality {
        Modality::Tts => {
            for key in TTS_TEXT_KEYS {
                if let Some(text) = body[key].as_str().filter(|text| !text.is_empty()) {
                    fields.push(text.to_owned());
                }
            }
        }
        Modality::Image | Modality::Video | Modality::Audio => {
            if let Some(text) = body["prompt"].as_str() {
                fields.push(scanned_text(text).to_owned());
            }
            if let Some(object) = body.as_object() {
                for (key, value) in object {
                    if key == "prompt" || MEDIA_CONTROL_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    collect_text_leaves(
                        value,
                        super::outbound_text::is_media_zone_key(key),
                        &mut fields,
                    );
                }
            }
        }
        Modality::Stt | Modality::Chat => {}
    }
    fields
}

fn collect_text_leaves(value: &Value, media_zone: bool, out: &mut Vec<String>) {
    match value {
        Value::String(text) if is_scanned_leaf(text, media_zone) => {
            out.push(scanned_text(text).to_owned());
        }
        Value::Array(items) => {
            for item in items {
                collect_text_leaves(item, media_zone, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                collect_text_leaves(
                    item,
                    media_zone || super::outbound_text::is_media_zone_key(key),
                    out,
                );
            }
        }
        _ => {}
    }
}

/// Mutable view of exactly the fields [`multimodal_text_fields`] reads, so a
/// sanitize or redaction rewrites every scanned leaf and nothing else.
fn multimodal_text_fields_mut<'a>(body: &'a mut Value, modality: &Modality) -> Vec<&'a mut String> {
    let mut fields = Vec::new();
    match modality {
        Modality::Tts => {
            if let Some(object) = body.as_object_mut() {
                for (key, value) in object.iter_mut() {
                    if !TTS_TEXT_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    if let Value::String(text) = value {
                        fields.push(text);
                    }
                }
            }
        }
        Modality::Image | Modality::Video | Modality::Audio => {
            if let Some(object) = body.as_object_mut() {
                for (key, value) in object.iter_mut() {
                    if MEDIA_CONTROL_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    collect_text_leaves_mut(
                        value,
                        super::outbound_text::is_media_zone_key(key),
                        &mut fields,
                    );
                }
            }
        }
        Modality::Stt | Modality::Chat => {}
    }
    fields
}

fn collect_text_leaves_mut<'a>(
    value: &'a mut Value,
    media_zone: bool,
    out: &mut Vec<&'a mut String>,
) {
    match value {
        Value::String(text) => {
            if is_scanned_leaf(text, media_zone) {
                out.push(text);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                collect_text_leaves_mut(item, media_zone, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                collect_text_leaves_mut(
                    item,
                    media_zone || super::outbound_text::is_media_zone_key(key),
                    out,
                );
            }
        }
        _ => {}
    }
}

/// Whether a leaf is inline binary media: a well-formed
/// `data:(image|video|audio)/<subtype>[;param]*;base64,<base64>` URI. Only
/// that shape is binary payload. Any other `data:` string (`text/plain`,
/// `application/json`, a non-base64 form, a malformed header) can carry
/// readable text, so it is scanned like any other leaf.
fn is_inline_media(text: &str) -> bool {
    let Some(rest) = text
        .get(..5)
        .filter(|scheme| scheme.eq_ignore_ascii_case("data:"))
        .and_then(|_| text.get(5..))
    else {
        return false;
    };
    let Some((header, payload)) = rest.split_once(',') else {
        return false;
    };
    let mut parts = header.split(';');
    let Some((family, subtype)) = parts.next().and_then(|mime| mime.split_once('/')) else {
        return false;
    };
    let family_ok = ["image", "video", "audio"]
        .iter()
        .any(|allowed| family.eq_ignore_ascii_case(allowed));
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.' | b'_'))
    };
    let params: Vec<&str> = parts.collect();
    let Some((last, others)) = params.split_last() else {
        return false;
    };
    family_ok
        && token(subtype)
        && last.eq_ignore_ascii_case("base64")
        && others.iter().all(|param| {
            param
                .split_once('=')
                .is_some_and(|(name, value)| token(name) && token(value))
        })
        && !payload.is_empty()
        && payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

/// Query parameters that mark an `https` URL as presigned object storage
/// (S3 / R2 / MinIO, GCS, Azure SAS, CloudFront). Their query string is a
/// credential scoped to one object, and the provider must receive it intact
/// to fetch a reference input.
const PRESIGNED_QUERY_MARKERS: [&str; 5] = [
    "x-amz-signature=",
    "x-goog-signature=",
    "sig=",
    "signature=",
    "key-pair-id=",
];

/// The part of a text leaf DLP scans and rewrites.
///
/// For a presigned `https` reference URL (a single URL with no whitespace and
/// a query naming one of [`PRESIGNED_QUERY_MARKERS`]) that is the scheme, host
/// and path: the signed query string is excluded, because a signing key id
/// such as `X-Amz-Credential=AKIA…` matches credential patterns and blocking or
/// rewriting it would make the provider unable to fetch the input. Every
/// other leaf is scanned whole.
fn scanned_text(text: &str) -> &str {
    &text[..scanned_len(text)]
}

fn scanned_len(text: &str) -> usize {
    let is_https = text
        .get(..8)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"));
    if !is_https || text.chars().any(char::is_whitespace) {
        return text.len();
    }
    let Some(query_start) = text.find('?') else {
        return text.len();
    };
    let query = text[query_start + 1..].to_ascii_lowercase();
    let presigned = query.split('&').any(|param| {
        PRESIGNED_QUERY_MARKERS
            .iter()
            .any(|marker| param.starts_with(marker))
    });
    if presigned {
        query_start
    } else {
        text.len()
    }
}

/// Rewrite only the scanned part of a leaf, keeping an excluded signed query.
fn rewrite_scanned_text(text: &mut String, rewrite: impl FnOnce(&str) -> String) {
    let end = scanned_len(text);
    let rewritten = rewrite(&text[..end]);
    if rewritten != text[..end] {
        text.replace_range(..end, &rewritten);
    }
}

#[derive(Clone, Copy)]
pub(super) enum InputShape {
    Chat,
    Embedding,
    Rerank,
}

/// The chat-body keys that carry provider-bound prompt strings (see
/// `visit_conversation_strings` and `visit_definition_strings`). The chat
/// projection copies exactly these so the firewall scans, and Sanitize redacts,
/// tool arguments, tool definitions and predicted output as well as message
/// content.
const CHAT_PROMPT_KEYS: [&str; 4] = ["messages", "tools", "functions", "prediction"];

fn chat_prompt_projection(body: &Value) -> Value {
    let mut projection = serde_json::Map::new();
    for key in CHAT_PROMPT_KEYS {
        if let Some(value) = body.get(key) {
            projection.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(projection)
}

/// Inspect every provider-bound text field, preserving the operation's original wire shape.
/// Embedding/rerank text is projected into messages solely to reuse the canonical DLP transforms.
pub(super) fn inspect_input(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    shape: InputShape,
) -> Result<Option<PolicyAlert>, GatewayError> {
    super::zero_data_retention::enforce_requested_zdr(state, ctx, body)?;
    // The wire fields the projection below does not carry (detection-only, see
    // `outbound_text`). The locked guardrails read the original body; the
    // firewall reads the body as Sanitize leaves it.
    let residual = input_residual(body, shape);
    let mut projection = match shape {
        InputShape::Chat => chat_prompt_projection(body),
        InputShape::Embedding => {
            let values = match &body["input"] {
                Value::String(text) => vec![Value::String(text.clone())],
                Value::Array(values) if values.iter().all(Value::is_string) => values.clone(),
                _ => {
                    return Err(GatewayError::BadRequest(
                        "embedding input must be strings".into(),
                    ))
                }
            };
            json!({"messages":values.into_iter().map(|content| json!({"role":"user","content":content})).collect::<Vec<_>>()})
        }
        InputShape::Rerank => {
            let query = body["query"]
                .as_str()
                .ok_or_else(|| GatewayError::BadRequest("rerank query must be text".into()))?;
            let docs = body["documents"]
                .as_array()
                .filter(|docs| docs.iter().all(Value::is_string))
                .ok_or_else(|| {
                    GatewayError::BadRequest("rerank documents must be strings".into())
                })?;
            let mut messages = vec![json!({"role":"user","content":query})];
            messages.extend(
                docs.iter()
                    .map(|content| json!({"role":"user","content":content})),
            );
            json!({"messages":messages})
        }
    };
    let scanner = state.resolved_scanner(ctx);
    let text = extract_text_for_scanning(&projection);
    let definition_text = extract_definition_text(&projection);
    enforce_locked_guardrails(state, ctx, &text)?;
    enforce_locked_dlp_on_definitions(state, ctx, &definition_text)?;
    enforce_locked_guardrails_on_residual(state, ctx, &residual)?;
    let mut alert = None;
    let mut sanitized = false;
    if let Some(hit) = scanner
        .scan_inbound(&text)
        .or_else(|| scan_definitions_inbound(scanner.as_ref(), &definition_text))
    {
        super::note_firewall_match(state, ctx, &hit, &scanner.policy());
        match scanner.policy() {
            FirewallPolicy::Block => {
                return Err(GatewayError::FirewallBlocked(
                    format!("Provider input blocked: {}", hit.pattern_name),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ))
            }
            FirewallPolicy::Sanitize => {
                sanitized = sanitize_inbound_or_block(
                    state,
                    ctx,
                    &mut projection,
                    scanner.as_ref(),
                    "provider input",
                )?;
            }
            FirewallPolicy::WarnAndContinue => {
                alert = firewall_policy_alert(scanner.config(), ctx, "notify")
            }
        }
    }
    if ctx.companion_source {
        scanner.companion_sanitize_messages(&mut projection["messages"]);
    }
    match shape {
        InputShape::Chat => {
            for key in CHAT_PROMPT_KEYS {
                if body.get(key).is_some() {
                    body[key] = projection[key].take();
                }
            }
        }
        InputShape::Embedding => {
            let values: Vec<_> = projection["messages"]
                .as_array()
                .expect("projected messages")
                .iter()
                .map(|message| message["content"].clone())
                .collect();
            body["input"] = if body["input"].is_string() {
                values.into_iter().next().unwrap_or(json!(""))
            } else {
                json!(values)
            };
        }
        InputShape::Rerank => {
            let values = projection["messages"]
                .as_array()
                .expect("projected messages");
            body["query"] = values[0]["content"].clone();
            body["documents"] = json!(values[1..]
                .iter()
                .map(|message| message["content"].clone())
                .collect::<Vec<_>>());
        }
    }
    let sanitized_residual = sanitized.then(|| input_residual(body, shape));
    let residual_alert = super::outbound_text::screen_residual_inbound(
        state,
        ctx,
        scanner.as_ref(),
        sanitized_residual.as_ref().unwrap_or(&residual),
    )?;
    Ok(super::merge_alert(alert, residual_alert))
}

/// The residual of a chat, embedding or rerank body: every string the
/// projection in [`inspect_input`] does not carry (see `outbound_text`).
fn input_residual(body: &Value, shape: InputShape) -> super::outbound_text::Residual {
    match shape {
        InputShape::Chat => super::outbound_text::chat_residual_text(body),
        InputShape::Embedding | InputShape::Rerank => {
            super::outbound_text::residual_text(body, |visit| {
                for key in ["input", "query", "documents"] {
                    match &body[key] {
                        Value::String(text) => visit(text),
                        Value::Array(values) => {
                            for text in values.iter().filter_map(Value::as_str) {
                                visit(text);
                            }
                        }
                        _ => {}
                    }
                }
            })
        }
    }
}

pub(super) fn input_token_estimate(body: &Value, shape: InputShape) -> u64 {
    let text = match shape {
        InputShape::Chat => extract_all_prompt_text(body),
        InputShape::Embedding => body["input"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                body["input"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            }),
        InputShape::Rerank => format!(
            "{}\n{}",
            body["query"].as_str().unwrap_or(""),
            body["documents"]
                .as_array()
                .map(|values| values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n"))
                .unwrap_or_default()
        ),
    };
    (text.chars().count() as u64).div_ceil(4)
}

pub(super) fn enforce_lifetime_budget(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &mut RouteDecision,
) -> Result<(), GatewayError> {
    if !ctx.is_master_key && state.shared_budget.is_shared_exceeded() {
        return Err(GatewayError::BudgetExceeded(None));
    }
    if let Some(key) = &ctx.key_config {
        if key
            .token_budget_total
            .is_some_and(|limit| limit > 0 && state.audit.token_usage(&ctx.api_key) >= limit)
        {
            if let Some(model) = &key.downgrade_to {
                *decision = super::provider_snapshot(&state, &ctx).router.route(model);
                body["model"] = json!(model);
            } else {
                return Err(GatewayError::BudgetExceeded(None));
            }
        }
    }
    Ok(())
}

/// Reserve input spend separately from the output ceiling used by the general budget gate.
/// Embedding/rerank operations have no generated-token ceiling, but their inputs still cost money.
pub(super) fn reserve_input_credit(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
    input_tokens: u64,
) -> Result<Option<CreditReservation>, GatewayError> {
    if !state.config.credits.reserve_enabled || ctx.is_master_key {
        return Ok(None);
    }
    let pool = crate::credit_pools::pool_for_gateway_provider(decision.provider.as_str());
    let (Some(org), Some(headroom)) = (
        ctx.org_id.as_deref(),
        credit_headroom_micro_usd(state, ctx, pool),
    ) else {
        return Ok(None);
    };
    let cost = state
        .config
        .credits
        .debit_amount_for_provider(
            Some(decision.provider.as_str()),
            state
                .config
                .control_plane
                .cost_for(&decision.model, input_tokens, 0),
        )
        .min(i64::MAX as u64) as i64;
    state
        .wallet
        .try_reserve(org, cost, headroom)
        .map(Some)
        .ok_or(GatewayError::InsufficientCredits)
}

pub(super) struct CompletionReceipt {
    pub provider: String,
    pub model: String,
    /// What the spend was for when it is not the caller's own chat completion
    /// (`embedding`, `rerank`, `smart-routing`, `inspector`, ...). It becomes the
    /// ledger row's `taskLabel`. It is never the debit `reason`: the control
    /// plane accepts only its closed reason enum, and every inference settled
    /// here is `gateway_usage`.
    pub purpose: Option<&'static str>,
    pub audit_provider: String,
    pub backend: Option<&'static str>,
    pub start: Instant,
    /// Tokens kept out of the per-minute token check: already taken at
    /// admission, or a tool loop's earlier rounds, which the caller records
    /// separately without refusing the request for them.
    pub admitted_tokens: u64,
    pub estimated_input: u64,
    pub budget: Option<BudgetDecision>,
    pub reservations: Vec<CreditReservation>,
    pub zero_cost: bool,
}

/// Completed work is accounted immediately; its audit record is finalized on every exit,
/// including rejection/cancellation, after callers can attach output-policy and evaluation results.
pub(super) struct SettledCompletion {
    pub overrun: bool,
    state: Arc<AppState>,
    record: Option<AuditRecord>,
    /// What the traffic feed reports for the row: the error the request
    /// returned, once one is known. Inferred from the record otherwise.
    outcome: Option<crate::traffic::TrafficOutcome>,
    /// The request whose traffic note the row reads, when it settles under a
    /// derived ref rather than the request id.
    note_request_id: Option<String>,
}
impl SettledCompletion {
    pub fn record_mut(&mut self) -> &mut AuditRecord {
        self.record.as_mut().expect("unfinalized completion")
    }
    pub fn fail(&mut self, error: &GatewayError) {
        let source = match error {
            GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_)
            | GatewayError::ProviderDeliveryUncertain(_)
            | GatewayError::ProviderPaymentRequired { .. }
            | GatewayError::AllProvidersUnavailable(_) => {
                "upstream provider request failed".to_owned()
            }
            _ => error.to_string(),
        };
        let redacted = self.state.with_firewall(|fw| {
            let sanitized = fw.sanitize(&source);
            fw.redact_outbound(&sanitized).0
        });
        self.record_mut().error = Some(redacted);
        self.report(error);
    }
    /// Report `error`, what the request returned, on the traffic feed (its
    /// status, code and verdict) without changing the row's error text.
    pub fn report(&mut self, error: &GatewayError) {
        self.outcome = Some(crate::traffic::TrafficOutcome::failure(error));
    }
    /// Read the traffic note of `request_id`, the request this row bills.
    pub fn join_note_of(&mut self, request_id: &str) {
        self.note_request_id = Some(request_id.to_owned());
    }
}
impl Drop for SettledCompletion {
    fn drop(&mut self) {
        if let Some(record) = self.record.take() {
            let mut outcome = self
                .outcome
                .take()
                .unwrap_or_else(|| crate::traffic::TrafficOutcome::inferred(&record));
            if let Some(request_id) = self.note_request_id.take() {
                outcome = outcome.joining_note_of(&request_id);
            }
            self.state.log_audit_with(record, outcome);
        }
    }
}

/// Provider work has already happened. Settle all usage, audit and wallet accounting before
/// the caller can return a TPM error or reject the output. Reservations follow the debit task.
pub(super) fn settle_completion(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    response: &Value,
    receipt: CompletionReceipt,
) -> SettledCompletion {
    let input = response["usage"]["prompt_tokens"]
        .as_u64()
        .or_else(|| response["usage"]["input_tokens"].as_u64())
        .or_else(|| response["usage"]["total_tokens"].as_u64())
        .unwrap_or(receipt.estimated_input);
    let output = response["usage"]["completion_tokens"]
        .as_u64()
        .or_else(|| response["usage"]["output_tokens"].as_u64())
        .unwrap_or(0);
    let total = input.saturating_add(output);
    let extra = total.saturating_sub(receipt.admitted_tokens);
    let overrun = extra > 0
        && !state
            .rate_limiter
            .check_tokens_for_key(&ctx.api_key, extra, ctx.key_config.as_ref());
    if overrun {
        state
            .rate_limiter
            .record_tokens_for_key(&ctx.api_key, extra, ctx.key_config.as_ref());
    }
    // Org-limit TPM buckets (C1) settle the same excess; an exhausted bucket
    // reports the overrun exactly like the per-key limiter.
    let overrun = crate::org_limits::settle_tokens(state, ctx, extra) || overrun;
    state.audit.add_tokens(&ctx.api_key, total);
    state.metrics.add_tokens(input, output);
    let reported = if receipt.zero_cost {
        Some(0.0)
    } else {
        response_reported_cost_usd(response)
    };
    let upstream_provider = if receipt.provider == "openrouter" {
        super::provider_usage::response_upstream_provider(response)
    } else {
        None
    };
    let cache_usage = super::provider_usage::provider_cache_usage(response);
    let cost = response_cost_micro_usd(
        state,
        Some(receipt.provider.as_str()),
        reported,
        input,
        output,
        &receipt.model,
        cache_usage,
    );
    record_charged_budget(
        state,
        ctx,
        charged_budget_cost_micro_usd(
            state,
            Some(receipt.provider.as_str()),
            reported,
            input,
            output,
            &receipt.model,
            cache_usage,
        ),
    );
    let latency = receipt.start.elapsed().as_millis() as u64;
    let record = AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: receipt.audit_provider,
        model: receipt.model.clone(),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_usage.map(|usage| usage.read_tokens),
        cache_write_tokens: cache_usage.map(|usage| usage.write_tokens),
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: cache_usage.map(|usage| usage.write_1h_tokens),
        latency_ms: latency,
        eval_score: None,
        error: overrun.then(|| "provider usage exceeded token admission".into()),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        // Keep vendor-reported cost distinct from the catalog estimate used for settlement.
        provider_cost_micro_usd: reported.and_then(cost_usd_to_micro),
        event_type: crate::audit::EventType::ModelCall,
        backend: receipt.backend.map(str::to_owned),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    };
    if let Some(org) = ctx.org_id.clone().filter(|org| !org.is_empty()) {
        if state.config.credits.is_active() {
            let state = Arc::clone(state);
            let ctx = ctx.clone();
            let tags = crate::org_limits::tags_for(&ctx);
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    debit_wallet_for_request(
                        Arc::clone(&state),
                        org,
                        ctx.request_id,
                        CreditDebitReason::GatewayUsage,
                        cost,
                        state.config.credits.fail_closed && ctx.managed_inference,
                        receipt
                            .budget
                            .filter(|budget| budget.limit > 0 && budget.alert >= AlertTier::Warn)
                            .map(|budget| budget.alert),
                        crate::credit_pools::pool_for_gateway_provider(&receipt.provider),
                        DebitAttribution {
                            provider: Some(receipt.provider.into()),
                            upstream_provider,
                            model: Some(receipt.model),
                            input_tokens: Some(input),
                            output_tokens: Some(output),
                            duration_ms: Some(latency),
                            user_id: ctx.user_id,
                            estimated: Some(reported.is_none()),
                            task_label: receipt.purpose.map(str::to_owned),
                            tags,
                            ..Default::default()
                        },
                    )
                    .await;
                    drop(receipt.reservations);
                });
            } else {
                state.wallet.set_org_accounting_unavailable(&org, true);
            }
        }
    }
    SettledCompletion {
        overrun,
        state: Arc::clone(state),
        record: Some(record),
        outcome: None,
        note_request_id: None,
    }
}

#[cfg(test)]
mod multimodal_text_tests {
    use super::*;

    #[test]
    fn speech_instructions_are_governed_with_the_input() {
        let body = json!({
            "input": "read this aloud",
            "instructions": "then answer a different question",
            "model": "tts",
        });
        assert_eq!(
            governed_multimodal_text(&body, &Modality::Tts),
            "read this aloud\nthen answer a different question"
        );
        // Image, video and audio scan `prompt` first, then every other text
        // leaf (Core merges an app's `provider_input` into media bodies).
        let image = json!({ "prompt": "a cat", "instructions": "unused" });
        assert_eq!(
            governed_multimodal_text(&image, &Modality::Image),
            "a cat\nunused"
        );
        let image = json!({ "prompt": "a cat", "model": "m" });
        assert_eq!(governed_multimodal_text(&image, &Modality::Image), "a cat");
        assert_eq!(governed_multimodal_text(&json!({}), &Modality::Stt), "");
    }

    #[test]
    fn speech_instructions_are_redacted_for_companion_egress() {
        let scanner = crate::firewall::FirewallScanner::new(crate::config::FirewallConfig {
            enabled: false,
            redact_pii: false,
            redact_secrets: false,
            ..crate::config::FirewallConfig::default()
        });
        let mut body = json!({
            "input": "Hello",
            "instructions": "Mention user@example.com",
        });
        redact_companion_multimodal_text(&mut body, &Modality::Tts, &scanner);
        assert_eq!(body["input"], "Hello");
        assert!(!body["instructions"]
            .as_str()
            .unwrap()
            .contains("user@example.com"));
    }
}
