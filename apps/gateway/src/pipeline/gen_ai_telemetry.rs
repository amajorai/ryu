//! Pipeline glue for the OTel GenAI model-call spans
//! (`crate::telemetry::gen_ai_span`): which operation/output type a route maps
//! to, how a `GatewayError` reads as `error.type`, and the per-call span
//! constructors the chat, streaming, multimodal and embedding paths share.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use serde_json::Value;

use crate::config::{FirewallPolicy, Modality};
use crate::error::GatewayError;
use crate::providers::Provider;
use crate::state::AppState;
use crate::telemetry::gen_ai_span::{
    chat_response, reported_usage, stream_response, ContentGuard, ModelCallRequest,
    ModelCallResponse, ModelCallSpan, OPERATION_CHAT, OPERATION_EMBEDDINGS,
    OPERATION_GENERATE_CONTENT,
};

use super::provider_usage::{
    provider_cache_write_tokens_reported, provider_cached_tokens_reported,
    sse_parse_cache_write_tokens_reported, sse_parse_cached_tokens_reported, sse_parse_usage,
};
use super::{EmbeddingOperation, RequestContext};

/// `error.type` for a failed provider call: the gateway's stable error code
/// (the same `type` the HTTP error envelope carries).
pub(super) fn error_type(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::ProviderError(_) => "provider_error",
        GatewayError::ProviderRejected { .. } => "provider_rejected",
        GatewayError::ProviderTransport(_) => "provider_transport_error",
        GatewayError::ProviderDeliveryUncertain(_) => "provider_delivery_uncertain",
        GatewayError::ProviderPaymentRequired { .. } => "provider_payment_required",
        GatewayError::ProviderRateLimited { .. } => "provider_rate_limited",
        GatewayError::CircuitOpen(_) => "circuit_open",
        GatewayError::Overloaded(_) => "engine_overloaded",
        GatewayError::RateLimited | GatewayError::RateLimitedBy(_) => "rate_limit_exceeded",
        GatewayError::FirewallBlocked(..)
        | GatewayError::PolicyViolation(_)
        | GatewayError::PlatformRefused { .. }
        | GatewayError::StandingRefused(_) => "policy_violation",
        GatewayError::ScreeningUnavailable { .. } => "screening_unavailable",
        GatewayError::ContentBlocked(_) | GatewayError::UpstreamSafetyRefused(_) => {
            "policy_violation"
        }
        GatewayError::ScreeningDegradedThrottle { .. } => "screening_degraded_throttle",
        GatewayError::ScreeningCapacityExceeded => "screening_capacity_exceeded",
        GatewayError::StandingUnavailable => "standing_unavailable",
        GatewayError::AbuseThrottled(_) => "abuse_throttled",
        GatewayError::AccountRestricted(_) => "account_restricted",
        GatewayError::NewKeyRateLimited { .. } => "new_key_rate_limited",
        GatewayError::BudgetExceeded(_) => "budget_exceeded",
        GatewayError::InsufficientCredits => "insufficient_credits",
        GatewayError::AccountingUnavailable => "credit_accounting_unavailable",
        GatewayError::ToolUnpriced(_) => "tool_unpriced",
        GatewayError::ToolNotServable(_) => "tool_not_servable",
        GatewayError::ToolPaymentRequired(detail) => detail.code(),
        GatewayError::ProviderResponseTooLarge { .. } => "provider_response_too_large",
        GatewayError::ProviderBodyUnreadable { .. } => "provider_body_unreadable",
        GatewayError::BudgetStoreUnavailable(_) => "budget_store_unavailable",
        GatewayError::AllProvidersUnavailable(_) => "all_providers_unavailable",
        GatewayError::BadRequest(_) | GatewayError::InvalidRequest { .. } => {
            "invalid_request_error"
        }
        GatewayError::Unauthorized(_) => "invalid_api_key",
        GatewayError::NoProvider(_) => "model_not_found",
        GatewayError::ConfigConflict(_) => "config_revision_conflict",
        GatewayError::Internal(_) => "_OTHER",
    }
}

/// `gen_ai.output.type` of a chat request: `json` for a structured
/// `response_format`, else `text`.
pub(super) fn chat_output_type(body: &Value) -> &'static str {
    match body["response_format"]["type"].as_str() {
        Some("json_object" | "json_schema") => "json",
        _ => "text",
    }
}

/// `(gen_ai.operation.name, gen_ai.output.type)` for a multimodal route.
pub(super) fn multimodal_operation(
    modality: &Modality,
    body: &Value,
) -> (&'static str, &'static str) {
    match modality {
        Modality::Chat => (OPERATION_CHAT, chat_output_type(body)),
        Modality::Image => (OPERATION_GENERATE_CONTENT, "image"),
        Modality::Tts => (OPERATION_GENERATE_CONTENT, "speech"),
        Modality::Stt => (OPERATION_GENERATE_CONTENT, "text"),
        Modality::Video => (OPERATION_GENERATE_CONTENT, "video"),
        Modality::Audio => (OPERATION_GENERATE_CONTENT, "audio"),
    }
}

/// `gen_ai.operation.name` for an embedding-family route. Rerank has no GenAI
/// well-known value, so it reports its own name.
pub(super) fn embedding_operation(operation: EmbeddingOperation) -> &'static str {
    match operation {
        EmbeddingOperation::Embed => OPERATION_EMBEDDINGS,
        EmbeddingOperation::Rerank => "rerank",
    }
}

/// Open the model-call span for one provider attempt under the current
/// (inbound HTTP server) span. In content mode the span's content passes the
/// request's outbound firewall before export (see [`dlp_content_guard`]).
#[allow(clippy::too_many_arguments)]
pub(super) fn start_span(
    state: &AppState,
    ctx: &RequestContext,
    operation: &str,
    output_type: Option<&str>,
    provider: &str,
    model: &str,
    body: &Value,
    stream: bool,
) -> ModelCallSpan {
    let mut span = ModelCallSpan::start(ModelCallRequest {
        operation,
        provider,
        model,
        body: Some(body),
        stream,
        output_type,
        request_id: &ctx.request_id,
        conversation_id: ctx.session_id.as_deref(),
    });
    if span.wants_content() {
        span.set_content_guard(dlp_content_guard(state, ctx));
    }
    span
}

/// The request's outbound firewall applied to exported span content, so a
/// completion the client only ever sees redacted (or blocked) never reaches
/// the collector raw: Block withholds the content, Sanitize sanitizes it, and
/// everything else gets the unconditional outbound redaction — the same
/// decision `apply_outbound_json_dlp` makes for the client response.
pub(super) fn dlp_content_guard(state: &AppState, ctx: &RequestContext) -> ContentGuard {
    let scanner = state.resolved_scanner(ctx);
    Arc::new(move |value: &mut Value| {
        let text = super::json_string_projection(value);
        if scanner.scan_outbound(&text).is_none() {
            super::redact_json_strings(value, scanner.as_ref());
            return true;
        }
        match scanner.policy() {
            FirewallPolicy::Block => false,
            FirewallPolicy::Sanitize => {
                super::sanitize_json_strings(value, scanner.as_ref());
                true
            }
            FirewallPolicy::WarnAndContinue => {
                super::redact_json_strings(value, scanner.as_ref());
                true
            }
        }
    })
}

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// A [`Provider`] view that opens one CLIENT model-call span per buffered
/// completion / embedding call, so multi-call paths (the gateway tool loops,
/// pool legs, smart-routing and other auxiliary inference) export one real
/// `chat {model}` span per upstream round-trip, each with its own
/// `traceparent`, `server.*` and status. Everything else forwards untouched.
pub(super) struct TracedProvider<'a> {
    inner: &'a dyn Provider,
    request_id: String,
    conversation_id: Option<String>,
    guard: Option<ContentGuard>,
}

impl<'a> TracedProvider<'a> {
    pub(super) fn new(state: &AppState, ctx: &RequestContext, inner: &'a dyn Provider) -> Self {
        let guard = crate::telemetry::content_enabled().then(|| dlp_content_guard(state, ctx));
        Self {
            inner,
            request_id: ctx.request_id.clone(),
            conversation_id: ctx.session_id.clone(),
            guard,
        }
    }

    fn span(&self, operation: &str, model: &str, body: &Value) -> ModelCallSpan {
        let mut span = ModelCallSpan::start(ModelCallRequest {
            operation,
            provider: self.inner.name(),
            model,
            body: Some(body),
            stream: false,
            output_type: (operation == OPERATION_CHAT).then(|| chat_output_type(body)),
            request_id: &self.request_id,
            conversation_id: self.conversation_id.as_deref(),
        });
        if let Some(guard) = &self.guard {
            span.set_content_guard(Arc::clone(guard));
        }
        span
    }
}

fn finish_provider_error(mut span: ModelCallSpan, error: &ryu_gw_providers::ProviderError) {
    span.record_error(error_type(&GatewayError::from(error.clone())));
    span.finish();
}

impl Provider for TracedProvider<'_> {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn web_descriptor(&self) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
        self.inner.web_descriptor()
    }

    fn web_search_for_session<'b>(
        &'b self,
        request: &'b ryu_gw_providers::web::WebSearchRequest,
        session: Option<&'b str>,
    ) -> ProviderFuture<'b, ryu_gw_providers::web::WebSearchOutput> {
        self.inner.web_search_for_session(request, session)
    }

    fn web_fetch_for_session<'b>(
        &'b self,
        request: &'b ryu_gw_providers::web::WebFetchRequest,
        session: Option<&'b str>,
    ) -> ProviderFuture<'b, ryu_gw_providers::web::WebFetchOutput> {
        self.inner.web_fetch_for_session(request, session)
    }

    fn configure_account_policies(&self, policies: &[ryu_gw_providers::ProviderAccountPolicy]) {
        self.inner.configure_account_policies(policies);
    }

    fn configure_account_strategy(&self, strategy: ryu_gw_providers::AccountSelectionStrategy) {
        self.inner.configure_account_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.inner.configure_fill_first_drain_percent(percent);
    }

    fn has_rotating_accounts(&self) -> bool {
        self.inner.has_rotating_accounts()
    }

    fn discover_models<'b>(
        &'b self,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<Value>>> + Send + 'b>> {
        self.inner.discover_models()
    }

    fn complete<'b>(&'b self, model: &'b str, body: &'b Value) -> ProviderFuture<'b, Value> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
        session: Option<&'b str>,
    ) -> ProviderFuture<'b, Value> {
        Box::pin(async move {
            let span = self.span(OPERATION_CHAT, model, body);
            let result = span
                .instrument(self.inner.complete_for_session(model, body, session))
                .await;
            match &result {
                Ok(response) => finish_chat(span, response),
                Err(error) => finish_provider_error(span, error),
            }
            result
        })
    }

    fn complete_stream<'b>(&'b self, model: &'b str, body: &'b Value) -> ProviderFuture<'b, Body> {
        self.inner.complete_stream(model, body)
    }

    fn complete_stream_for_session<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
        session: Option<&'b str>,
    ) -> ProviderFuture<'b, Body> {
        self.inner.complete_stream_for_session(model, body, session)
    }

    fn embed<'b>(&'b self, model: &'b str, body: &'b Value) -> ProviderFuture<'b, Value> {
        Box::pin(async move {
            let span = self.span(OPERATION_EMBEDDINGS, model, body);
            let result = span.instrument(self.inner.embed(model, body)).await;
            match &result {
                Ok(response) => finish_reported(span, response),
                Err(error) => finish_provider_error(span, error),
            }
            result
        })
    }

    fn rerank<'b>(&'b self, model: &'b str, body: &'b Value) -> ProviderFuture<'b, Value> {
        self.inner.rerank(model, body)
    }

    fn generate_image<'b>(&'b self, model: &'b str, body: &'b Value) -> ProviderFuture<'b, Value> {
        self.inner.generate_image(model, body)
    }

    fn synthesize_speech<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
    ) -> ProviderFuture<'b, Value> {
        self.inner.synthesize_speech(model, body)
    }

    fn synthesize_speech_bound<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
        session: Option<&'b str>,
    ) -> ProviderFuture<'b, ryu_gw_providers::BoundSpeech> {
        self.inner.synthesize_speech_bound(model, body, session)
    }

    fn transcribe_audio<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
    ) -> ProviderFuture<'b, Value> {
        self.inner.transcribe_audio(model, body)
    }

    fn submit_video_bound<'b>(
        &'b self,
        model: &'b str,
        body: &'b Value,
    ) -> ProviderFuture<'b, ryu_gw_providers::AcceptedVideo> {
        self.inner.submit_video_bound(model, body)
    }
}

/// Close a buffered chat call's span with the provider's response metadata.
pub(super) fn finish_chat(mut span: ModelCallSpan, response: &Value) {
    if !span.is_recording() {
        return;
    }
    let mut parsed = chat_response(response, span.wants_content());
    parsed.usage.cache_read_input_tokens = provider_cached_tokens_reported(response);
    parsed.usage.cache_write_input_tokens = provider_cache_write_tokens_reported(response);
    span.record_response(parsed);
    span.finish();
}

/// Close a streamed chat call's span from the assembled upstream SSE. Output
/// content is assembled only in content mode.
pub(super) fn finish_stream(mut span: ModelCallSpan, sse: &str) {
    if !span.is_recording() {
        return;
    }
    let mut parsed = stream_response(sse, span.wants_content());
    // `sse_parse_usage` reports (0, 0) without a usage frame: omit the counts
    // then rather than exporting zeros (the audit row keeps its estimate).
    let (input, output) = sse_parse_usage(sse);
    if input > 0 || output > 0 {
        parsed.usage.input_tokens = Some(input);
        parsed.usage.output_tokens = Some(output);
    }
    parsed.usage.cache_read_input_tokens = sse_parse_cached_tokens_reported(sse);
    parsed.usage.cache_write_input_tokens = sse_parse_cache_write_tokens_reported(sse);
    span.record_response(parsed);
    span.finish();
}

/// Close a non-chat (media / embedding) call's span with whatever usage the
/// provider reported; absent token counts are omitted, never reported as 0.
pub(super) fn finish_reported(mut span: ModelCallSpan, response: &Value) {
    if !span.is_recording() {
        return;
    }
    span.record_response(ModelCallResponse {
        id: response["id"].as_str().map(str::to_owned),
        model: response["model"].as_str().map(str::to_owned),
        usage: reported_usage(response),
        ..ModelCallResponse::default()
    });
    span.finish();
}

/// Close a failed call's span: status ERROR with the gateway error code.
pub(super) fn finish_error(mut span: ModelCallSpan, error: &GatewayError) {
    span.record_error(error_type(error));
    span.finish();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn operations_and_output_types_map_to_gen_ai_values() {
        assert_eq!(chat_output_type(&json!({})), "text");
        assert_eq!(
            chat_output_type(&json!({"response_format": {"type": "json_schema"}})),
            "json"
        );
        assert_eq!(
            multimodal_operation(&Modality::Image, &json!({})),
            ("generate_content", "image")
        );
        assert_eq!(
            multimodal_operation(&Modality::Tts, &json!({})),
            ("generate_content", "speech")
        );
        assert_eq!(
            multimodal_operation(&Modality::Chat, &json!({})),
            ("chat", "text")
        );
        assert_eq!(embedding_operation(EmbeddingOperation::Embed), "embeddings");
        assert_eq!(
            error_type(&GatewayError::ProviderRateLimited {
                provider: "openai".into(),
                retry_after: None,
                reset_at: None,
            }),
            "provider_rate_limited"
        );
        assert_eq!(
            error_type(&GatewayError::ProviderTransport("x".into())),
            "provider_transport_error"
        );
    }
}
