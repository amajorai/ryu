//! Ryu model aliases on the way OUT.
//!
//! A managed tier ("Ryu Code", "Ryu Fast", …) is sold under a Ryu-branded alias
//! (`ryu-code/max`) and must never name the supplier behind it. The router
//! resolves the alias to the supplier's own id before dispatch
//! (`ryu_gw_router::POOL_MODEL_ALIASES`), so everything the provider sends back —
//! the response `model`, every streamed chunk's `model` — carries the upstream
//! id. This module puts the alias back:
//!
//! - [`requested_alias`] / [`apply_to_output`] / [`alias_stream`] rewrite the
//!   client-facing response (JSON body, SSE chunks, `x-routed-model`,
//!   `x-provider`) to the alias the client asked for;
//! - [`display_model`] is the name user-visible usage records carry (audit
//!   `model`, ledger debit attribution). Cost and pricing lookups keep using the
//!   upstream id; only the recorded/displayed name changes.
//! - [`served_display_id`] extends the response rewrite to a pre-alias raw id
//!   (`ryu-code/claude-sonnet-4-5`, `@cf/…`) whenever an own-supply slot served
//!   it: the user sees the Ryu Router id (`anthropic/claude-sonnet-4.5`) when one
//!   names the same model, else the alias;
//! - own-supply routing (`pipeline::own_supply`) reuses [`apply_to_output`] /
//!   [`alias_stream`] / [`mask_model`] to show the id the user PICKED;
//! - [`mask_pool_slots`] puts "Ryu Router" in place of a Ryu-operated slot id in
//!   a managed caller's errors.

use std::borrow::Cow;

use axum::body::Body;
use bytes::Bytes;
use serde_json::Value;

use crate::error::GatewayError;

/// Provider id reported (`x-provider`) for Ryu-served work in place of the
/// supplier's slot id — the Ryu Router's provider id.
pub(super) const ALIAS_PROVIDER_LABEL: &str = "ryu";

/// The provider NAME a managed caller reads in an error, in place of a slot id.
pub(super) const RYU_ROUTER_LABEL: &str = "Ryu Router";

/// The canonical alias the request body names, when it names one.
pub(super) fn requested_alias(body: &Value) -> Option<&'static str> {
    body["model"]
        .as_str()
        .and_then(ryu_gw_router::pool_model_alias_id)
}

/// The id a USER may see for work an own-supply slot served under its upstream
/// id: the Ryu Router id naming the same model
/// (the live own-supply table, then the compiled seed), else the Ryu alias,
/// else `None`.
/// Keyed on the serving slot, so BYOK traffic with the same id keeps its name.
pub(super) fn served_display_id(provider_used: &str, model_used: &str) -> Option<String> {
    crate::own_supply_table::display_id(provider_used, model_used).or_else(|| {
        ryu_gw_router::pool_model_alias_for(provider_used, model_used).map(str::to_owned)
    })
}

/// The model name a USER may see for work `provider` served as `model`
/// ([`served_display_id`]), else `model`. Usage records (audit rollups, ledger
/// attribution) carry this; pricing keeps the upstream id.
pub(crate) fn display_model<'a>(provider: &str, model: &'a str) -> Cow<'a, str> {
    served_display_id(provider, model).map_or(Cow::Borrowed(model), Cow::Owned)
}

/// Replace the `model` of an OpenAI-, Anthropic- (`message.model`) or
/// Responses-shaped (`response.model`) payload with `alias`. Returns whether
/// anything changed.
pub(super) fn rewrite_json_model(value: &mut Value, alias: &str) -> bool {
    let mut changed = false;
    for pointer in ["/model", "/message/model", "/response/model"] {
        if let Some(slot) = value.pointer_mut(pointer) {
            if slot.is_string() && slot.as_str() != Some(alias) {
                *slot = Value::String(alias.to_owned());
                changed = true;
            }
        }
    }
    changed
}

/// Show `shown` (the id the user asked for) on a finished non-streaming output.
pub(super) fn apply_to_output(
    response: &mut Value,
    model_used: &mut String,
    provider_used: &mut &'static str,
    shown: &str,
) {
    rewrite_json_model(response, shown);
    *model_used = shown.to_owned();
    *provider_used = ALIAS_PROVIDER_LABEL;
}

/// Replace the upstream id in an error message with the alias, so a failure
/// does not name what a success would have hidden.
pub(super) fn mask_error(error: GatewayError, alias: Option<&'static str>) -> GatewayError {
    let Some(alias) = alias else {
        return error;
    };
    let Some((_, upstream)) = ryu_gw_router::pool_model_alias_route(alias) else {
        return error;
    };
    mask_model(error, upstream, alias)
}

/// Replace `upstream` with `shown` in every message an error carries.
pub(super) fn mask_model(error: GatewayError, upstream: &str, shown: &str) -> GatewayError {
    if upstream.is_empty() || upstream == shown {
        return error;
    }
    let mask = |message: String| message.replace(upstream, shown);
    match error {
        GatewayError::ProviderError(m) => GatewayError::ProviderError(mask(m)),
        GatewayError::ProviderTransport(m) => GatewayError::ProviderTransport(mask(m)),
        GatewayError::ProviderDeliveryUncertain(m) => {
            GatewayError::ProviderDeliveryUncertain(mask(m))
        }
        GatewayError::AllProvidersUnavailable(m) => GatewayError::AllProvidersUnavailable(mask(m)),
        GatewayError::NoProvider(m) => GatewayError::NoProvider(mask(m)),
        GatewayError::BadRequest(m) => GatewayError::BadRequest(mask(m)),
        GatewayError::PolicyViolation(m) => GatewayError::PolicyViolation(mask(m)),
        GatewayError::ProviderPaymentRequired { provider, message } => {
            GatewayError::ProviderPaymentRequired {
                provider,
                message: mask(message),
            }
        }
        other => other,
    }
}

/// Replace Ryu-operated slot ids ("anthropic-credits", "bedrock", the managed
/// "openrouter" pass-through, …) in a MANAGED caller's error with "Ryu Router".
/// Covers the provider fields of the rate-limit, payment and circuit errors and
/// every message string, so a failure never names the supplier a success would
/// have hidden. BYOK slots keep their names, and a non-managed caller (an
/// operator running their own gateway) sees the real slot ids.
pub(super) fn mask_pool_slots(error: GatewayError, managed: bool) -> GatewayError {
    if !managed {
        return error;
    }
    let label = |provider: String| {
        if crate::credit_pools::is_ryu_router_slot(&provider) {
            RYU_ROUTER_LABEL.to_owned()
        } else {
            provider
        }
    };
    let mask = |mut message: String| {
        for (slot, _) in crate::credit_pools::own_supply_slots() {
            if message.contains(slot) {
                message = message.replace(slot, RYU_ROUTER_LABEL);
            }
        }
        // `openrouter` is also a model namespace (`openrouter/auto`), so only
        // its provider mentions are masked, never a model id.
        message
            .replace("provider: openrouter", "provider: Ryu Router")
            .replace("provider 'openrouter'", "provider 'Ryu Router'")
    };
    match error {
        GatewayError::CircuitOpen(provider) => GatewayError::CircuitOpen(label(provider)),
        GatewayError::ProviderRateLimited {
            provider,
            retry_after,
            reset_at,
        } => GatewayError::ProviderRateLimited {
            provider: label(provider),
            retry_after,
            reset_at,
        },
        GatewayError::ProviderPaymentRequired { provider, message } => {
            GatewayError::ProviderPaymentRequired {
                provider: label(provider),
                message: mask(message),
            }
        }
        GatewayError::ProviderError(m) => GatewayError::ProviderError(mask(m)),
        GatewayError::ProviderTransport(m) => GatewayError::ProviderTransport(mask(m)),
        GatewayError::ProviderDeliveryUncertain(m) => {
            GatewayError::ProviderDeliveryUncertain(mask(m))
        }
        GatewayError::AllProvidersUnavailable(m) => GatewayError::AllProvidersUnavailable(mask(m)),
        GatewayError::NoProvider(m) => GatewayError::NoProvider(mask(m)),
        GatewayError::BadRequest(m) => GatewayError::BadRequest(mask(m)),
        GatewayError::PolicyViolation(m) => GatewayError::PolicyViolation(mask(m)),
        GatewayError::Overloaded(m) => GatewayError::Overloaded(mask(m)),
        other => other,
    }
}

/// Rewrite one SSE line (`data: {…}`) so its JSON payload names `alias`.
/// Anything that is not a JSON `data:` frame carrying a `model` is returned
/// borrowed and byte-identical.
fn rewrite_sse_line<'a>(line: &'a str, alias: &str) -> Cow<'a, str> {
    let Some(data) = line.strip_prefix("data:") else {
        return Cow::Borrowed(line);
    };
    // Cheap pre-filter: most frames are deltas that carry no `model` at all.
    if !data.contains("\"model\"") {
        return Cow::Borrowed(line);
    }
    let Ok(mut payload) = serde_json::from_str::<Value>(data.trim()) else {
        return Cow::Borrowed(line);
    };
    if !rewrite_json_model(&mut payload, alias) {
        return Cow::Borrowed(line);
    }
    match serde_json::to_string(&payload) {
        Ok(encoded) => Cow::Owned(format!("data: {encoded}")),
        Err(_) => Cow::Borrowed(line),
    }
}

/// Rewrite every complete line in `text` (each terminated by `\n`).
fn rewrite_sse_lines(text: &str, alias: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let (content, ending) = match line.strip_suffix("\r\n") {
            Some(content) => (content, "\r\n"),
            None => match line.strip_suffix('\n') {
                Some(content) => (content, "\n"),
                None => (line, ""),
            },
        };
        out.push_str(&rewrite_sse_line(content, alias));
        out.push_str(ending);
    }
    out
}

struct AliasStreamState<S> {
    inner: S,
    alias: String,
    pending: Vec<u8>,
    finished: bool,
}

/// Wrap a streamed SSE body so each frame's `model` names `alias`. Frames are
/// re-split on line boundaries (a provider chunk may end mid-frame), so a
/// partial line is held until its newline arrives and flushed at end of stream.
pub(super) fn alias_stream(body: Body, alias: impl Into<String>) -> Body {
    use futures_util::StreamExt;

    let init = AliasStreamState {
        inner: body.into_data_stream(),
        alias: alias.into(),
        pending: Vec::new(),
        finished: false,
    };
    let stream = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            if s.finished {
                return None;
            }
            match s.inner.next().await {
                Some(Ok(bytes)) => {
                    s.pending.extend_from_slice(&bytes);
                    let Some(last_newline) = s.pending.iter().rposition(|b| *b == b'\n') else {
                        continue;
                    };
                    let complete: Vec<u8> = s.pending.drain(..=last_newline).collect();
                    let text = String::from_utf8_lossy(&complete);
                    let out = rewrite_sse_lines(&text, &s.alias);
                    return Some((Ok::<Bytes, std::io::Error>(Bytes::from(out)), s));
                }
                Some(Err(error)) => {
                    s.finished = true;
                    return Some((Err(std::io::Error::other(error.to_string())), s));
                }
                None => {
                    s.finished = true;
                    if s.pending.is_empty() {
                        return None;
                    }
                    let rest = std::mem::take(&mut s.pending);
                    let text = String::from_utf8_lossy(&rest);
                    let out = rewrite_sse_lines(&text, &s.alias);
                    return Some((Ok(Bytes::from(out)), s));
                }
            }
        }
    });
    Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requested_alias_is_canonical_and_only_for_alias_ids() {
        assert_eq!(
            requested_alias(&json!({"model": "Ryu-Code/MAX"})),
            Some("ryu-code/max")
        );
        assert_eq!(
            requested_alias(&json!({"model": "ryu-code/claude-opus-4-5"})),
            None
        );
        assert_eq!(requested_alias(&json!({"model": "gpt-5"})), None);
        assert_eq!(requested_alias(&json!({})), None);
    }

    #[test]
    fn display_model_aliases_only_managed_pool_slots() {
        assert_eq!(
            display_model("anthropic-credits", "claude-opus-4-5"),
            "anthropic/claude-opus-4.5"
        );
        // The delisted Claude 3.5 row is gone: its Ryu alias still hides the id.
        assert_eq!(
            display_model("bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0"),
            "ryu-frontier/max"
        );
        assert_eq!(
            display_model("cloudflare", "@cf/qwen/qwen1.5-14b-chat-awq"),
            "ryu-fast/max"
        );
        // BYOK and unaliased ids keep their real names.
        assert_eq!(
            display_model("anthropic", "claude-opus-4-5"),
            "claude-opus-4-5"
        );
        assert_eq!(
            display_model("bedrock", "mistral.mistral-large-2407-v1:0"),
            "mistral.mistral-large-2407-v1:0"
        );
    }

    #[test]
    fn non_streaming_openai_and_anthropic_bodies_carry_the_alias() {
        let mut openai = json!({"id": "x", "model": "claude-opus-4-5", "choices": []});
        let mut model_used = "claude-opus-4-5".to_owned();
        let mut provider_used: &'static str = "anthropic-credits";
        apply_to_output(
            &mut openai,
            &mut model_used,
            &mut provider_used,
            "ryu-code/max",
        );
        assert_eq!(openai["model"], "ryu-code/max");
        assert_eq!(model_used, "ryu-code/max");
        assert_eq!(provider_used, ALIAS_PROVIDER_LABEL);

        let mut anthropic =
            json!({"type": "message_start", "message": {"model": "claude-opus-4-5"}});
        assert!(rewrite_json_model(&mut anthropic, "ryu-code/max"));
        assert_eq!(anthropic["message"]["model"], "ryu-code/max");

        // A payload without a model is left alone.
        let mut bare = json!({"choices": []});
        assert!(!rewrite_json_model(&mut bare, "ryu-code/max"));
        assert!(bare.get("model").is_none());
    }

    #[test]
    fn sse_lines_are_rewritten_and_everything_else_is_byte_identical() {
        let raw = "data: {\"id\":\"1\",\"model\":\"o3\",\"choices\":[]}\r\n\r\n\
                   : keep-alive\n\
                   event: message_start\n\
                   data: {\"type\":\"message_start\",\"message\":{\"model\":\"o3\"}}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
                   data: [DONE]\n\n";
        let out = rewrite_sse_lines(raw, "ryu-reasoning/standard");
        assert!(!out.contains("\"o3\""), "{out}");
        assert_eq!(out.matches("ryu-reasoning/standard").count(), 2);
        assert!(out.contains("\r\n\r\n"));
        assert!(out.contains(": keep-alive\n"));
        assert!(out.contains("event: message_start\n"));
        assert!(out.contains("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
        assert!(out.ends_with("data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn streamed_frames_split_across_chunks_are_rewritten() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(b"data: {\"model\":\"gpt")),
            Ok(Bytes::from_static(b"-5\",\"choices\":[]}\n\ndata: {\"mo")),
            Ok(Bytes::from_static(b"del\":\"gpt-5\"}\n\ndata: [DONE]")),
        ];
        let body = Body::from_stream(futures_util::stream::iter(chunks));
        let out = alias_stream(body, "ryu-reasoning/max");
        let bytes = axum::body::to_bytes(out, usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("gpt-5"), "{text}");
        assert_eq!(text.matches("ryu-reasoning/max").count(), 2);
        assert!(text.ends_with("data: [DONE]"));
    }

    #[test]
    fn served_display_id_prefers_the_ryu_router_id_then_the_alias() {
        assert_eq!(
            served_display_id("anthropic-credits", "claude-sonnet-4-5").as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
        assert_eq!(
            served_display_id("bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0").as_deref(),
            Some("ryu-frontier/max")
        );
        assert_eq!(
            served_display_id("vertex", "google/gemini-2.5-pro").as_deref(),
            Some("google/gemini-2.5-pro")
        );
        // No Ryu Router equivalent: the alias still hides the supplier id.
        assert_eq!(
            served_display_id("cloudflare", "@cf/qwen/qwen1.5-14b-chat-awq").as_deref(),
            Some("ryu-fast/max")
        );
        assert_eq!(served_display_id("anthropic", "claude-sonnet-4-5"), None);
        assert_eq!(
            served_display_id("openrouter", "google/gemini-2.5-pro"),
            None
        );
        assert_eq!(served_display_id("cache", "o3"), None);
    }

    #[test]
    fn managed_errors_name_ryu_router_not_the_supplier() {
        let circuit = mask_pool_slots(GatewayError::CircuitOpen("anthropic-credits".into()), true);
        assert_eq!(circuit.to_string(), "Circuit open for provider: Ryu Router");

        let limited = mask_pool_slots(
            GatewayError::ProviderRateLimited {
                provider: "bedrock".into(),
                retry_after: Some(3),
                reset_at: None,
            },
            true,
        );
        assert!(matches!(
            limited,
            GatewayError::ProviderRateLimited { ref provider, retry_after: Some(3), .. }
                if provider == "Ryu Router"
        ));

        let payment = mask_pool_slots(
            GatewayError::ProviderPaymentRequired {
                provider: "openai-credits".into(),
                message: "openai-credits: insufficient quota".into(),
            },
            true,
        );
        assert_eq!(
            payment.to_string(),
            "Provider payment required: Ryu Router: Ryu Router: insufficient quota"
        );

        let chained = mask_pool_slots(
            GatewayError::AllProvidersUnavailable(
                "All providers unavailable for model 'openrouter/auto': Circuit open for provider: openrouter"
                    .into(),
            ),
            true,
        );
        assert_eq!(
            chained.to_string(),
            "All providers unavailable: All providers unavailable for model 'openrouter/auto': Circuit open for provider: Ryu Router"
        );
        let openrouter = mask_pool_slots(GatewayError::CircuitOpen("openrouter".into()), true);
        assert_eq!(
            openrouter.to_string(),
            "Circuit open for provider: Ryu Router"
        );

        // BYOK slots keep their names; so does everything for a non-managed caller.
        let byok = mask_pool_slots(GatewayError::CircuitOpen("anthropic".into()), true);
        assert_eq!(byok.to_string(), "Circuit open for provider: anthropic");
        let operator = mask_pool_slots(GatewayError::CircuitOpen("bedrock".into()), false);
        assert_eq!(operator.to_string(), "Circuit open for provider: bedrock");
    }

    #[test]
    fn errors_do_not_name_the_upstream_id() {
        let masked = mask_error(
            GatewayError::AllProvidersUnavailable(
                "All providers unavailable for model 'claude-opus-4-5'".into(),
            ),
            Some("ryu-code/max"),
        );
        assert_eq!(
            masked.to_string(),
            "All providers unavailable: All providers unavailable for model 'ryu-code/max'"
        );
        // No alias: untouched.
        let plain = mask_error(GatewayError::ProviderError("claude-opus-4-5".into()), None);
        assert_eq!(plain.to_string(), "Provider error: claude-opus-4-5");
    }
}
