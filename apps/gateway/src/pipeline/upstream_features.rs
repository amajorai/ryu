//! Upstream features the hosted Gateway refuses (catalogue
//! `feature_not_permitted`).
//!
//! Anthropic server tools (web fetch, web search, code execution and the other
//! typed tools) and opt-in betas make the upstream fetch pages, run code or
//! search the web from Ryu's provider account. The Gateway cannot screen what
//! those features reach, so on the fleet a chat request may declare only
//! function tools and only the prompt-caching betas. The refusal is made once,
//! before routing, so no provider is ever chosen for the request and nothing
//! can move it to another one.
//!
//! The same holds for the provider-side fields of the OpenAI-shape body that a
//! provider forwards verbatim: OpenRouter's `plugins` (web search, file
//! parser), `web_search_options`, `transforms` and `route`, xAI's
//! `search_parameters`, and the OpenRouter `:online` model variant. They make
//! the upstream retrieve third-party content that is injected into the prompt
//! after admission, so neither the screener nor the regex floor ever reads it.
//! Ryu's own operator-set plugins (`response-healing`) are added by the
//! provider after this check and are unaffected.
//!
//! The check reads the body, not a header: the `anthropic-beta` header arrives
//! as the private [`super::ANTHROPIC_BETA_FIELD`], which is also what the
//! Anthropic provider reads, so a value that reaches the field by any route is
//! refused the same way.

use axum::http::HeaderMap;
use serde_json::Value;

use crate::{custody::GatewayCustody, error::GatewayError};

/// Catalogue code for a feature the hosted Gateway does not offer.
const CODE: &str = "feature_not_permitted";

/// The request header that opts into Anthropic betas.
const BETA_HEADER: &str = "anthropic-beta";

const TOOLS_MESSAGE: &str =
    "Only function tools are available on the hosted Gateway. Upstream server tools are not permitted.";

const BETA_MESSAGE: &str =
    "This anthropic-beta value is not available on the hosted Gateway. Only the prompt caching betas are permitted.";

/// The `anthropic-beta` values the fleet forwards. Both only change how a
/// prompt prefix is cached; neither reaches anything outside the request.
const PERMITTED_BETAS: [&str; 2] = [
    ryu_gw_providers::anthropic::PROMPT_CACHING_BETA,
    ryu_gw_providers::anthropic::EXTENDED_CACHE_TTL_BETA,
];

const FIELDS_MESSAGE: &str =
    "Upstream web search, plugins and routing options are not available on the hosted Gateway.";

/// Top-level body fields a provider forwards verbatim and that let the
/// upstream fetch or inject content the Gateway never screens.
const UPSTREAM_ONLY_FIELDS: [&str; 5] = [
    "plugins",
    "web_search_options",
    "transforms",
    "route",
    "search_parameters",
];

/// The OpenRouter model variant that turns on web search.
const ONLINE_VARIANT: &str = "online";

/// Refuse an OpenAI-shape chat body that declares a non-function tool, a
/// provider-side retrieval field ([`UPSTREAM_ONLY_FIELDS`] or an `:online`
/// model variant) or an `anthropic-beta` value outside [`PERMITTED_BETAS`], on a Gateway whose
/// custody restricts upstream features. Every other custody passes the body
/// through unchanged.
pub(super) fn enforce(custody: GatewayCustody, body: &Value) -> Result<(), GatewayError> {
    if !custody.restricts_upstream_features() {
        return Ok(());
    }
    if declares_non_function_tool(body) {
        return Err(refusal(TOOLS_MESSAGE));
    }
    if carries_upstream_only_field(body) || names_online_model(body) {
        return Err(refusal(FIELDS_MESSAGE));
    }
    if carries_unpermitted_beta(body) {
        return Err(refusal(BETA_MESSAGE));
    }
    Ok(())
}

/// Whether the body sets any [`UPSTREAM_ONLY_FIELDS`] to something other than
/// null or an empty array or object (which enable nothing).
fn carries_upstream_only_field(body: &Value) -> bool {
    UPSTREAM_ONLY_FIELDS
        .iter()
        .filter_map(|field| body.get(*field))
        .any(|value| match value {
            Value::Null => false,
            Value::Array(items) => !items.is_empty(),
            Value::Object(fields) => !fields.is_empty(),
            _ => true,
        })
}

/// Whether `model`, or any entry of the fallback `models` list, names the
/// OpenRouter `:online` variant (alone or combined with another variant).
fn names_online_model(body: &Value) -> bool {
    let fallbacks = body
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    body.get("model")
        .into_iter()
        .chain(fallbacks)
        .filter_map(Value::as_str)
        .any(|model| {
            model
                .split(':')
                .skip(1)
                .any(|variant| variant.trim().eq_ignore_ascii_case(ONLINE_VARIANT))
        })
}

/// Refuse an Anthropic Messages body (`POST /v1/messages`) that declares a
/// typed Anthropic tool, before it is translated. The translation turns every
/// tool into a function tool, so a server tool would otherwise reach the model
/// as an ordinary function the caller never defined instead of being refused.
/// A custom tool (no `type`, or `type: "custom"`) is a function tool and passes.
pub(crate) fn enforce_native_anthropic_tools(
    custody: GatewayCustody,
    body: &Value,
) -> Result<(), GatewayError> {
    if !custody.restricts_upstream_features() {
        return Ok(());
    }
    let typed = tools(body).any(|tool| match tool.get("type") {
        None => false,
        Some(kind) => kind.as_str() != Some("custom"),
    });
    if typed {
        return Err(refusal(TOOLS_MESSAGE));
    }
    Ok(())
}

fn refusal(message: &'static str) -> GatewayError {
    GatewayError::PlatformRefused {
        code: CODE,
        message,
    }
}

fn tools(body: &Value) -> impl Iterator<Item = &Value> {
    body.get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Whether any declared tool is not `{"type": "function", ...}`. A missing
/// `type` counts as non-function, because a provider that forwards the body
/// verbatim decides for itself what an untyped entry means.
fn declares_non_function_tool(body: &Value) -> bool {
    tools(body).any(|tool| tool.get("type").and_then(Value::as_str) != Some("function"))
}

/// Whether the private beta field names any value outside the allowlist. A
/// field that is not a string fails toward refusal, since nothing on the
/// intake writes one.
fn carries_unpermitted_beta(body: &Value) -> bool {
    let Some(field) = body.get(super::ANTHROPIC_BETA_FIELD) else {
        return false;
    };
    let Some(betas) = field.as_str() else {
        return true;
    };
    names_unpermitted_beta(betas)
}

/// Whether a comma-separated `anthropic-beta` list names any value outside
/// the allowlist. Values match exactly; empty entries are ignored.
fn names_unpermitted_beta(betas: &str) -> bool {
    betas
        .split(',')
        .map(str::trim)
        .filter(|beta| !beta.is_empty())
        .any(|beta| !PERMITTED_BETAS.contains(&beta))
}

/// Every `anthropic-beta` header line on the request, joined into one
/// comma-separated list, or `None` when no line names a value.
///
/// A client may send the header more than once, and `HeaderMap::get` returns
/// only the first line, so a value on a later line would otherwise go
/// unchecked. A line that is not valid UTF-8 is kept in lossy form, which
/// never matches the allowlist, so it fails toward refusal instead of being
/// dropped without notice.
pub(crate) fn beta_header(headers: &HeaderMap) -> Option<String> {
    let lines: Vec<String> = headers
        .get_all(BETA_HEADER)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect();
    (!lines.is_empty()).then(|| lines.join(","))
}

/// Refuse an `anthropic-beta` header outside the allowlist on a route that
/// does not fold the header into the body (`POST /v1/messages` and
/// `POST /v1/responses`). Pass the value from [`beta_header`] so every header
/// line is checked. Such a route
/// never forwards the header, but the caller asked for a feature the hosted
/// Gateway does not offer, so it learns that at integration time instead of
/// getting an answer produced without it.
pub(crate) fn enforce_beta_header(
    custody: GatewayCustody,
    header: Option<&str>,
) -> Result<(), GatewayError> {
    if custody.restricts_upstream_features() && header.is_some_and(names_unpermitted_beta) {
        return Err(refusal(BETA_MESSAGE));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CODE_EXECUTION_BETA: &str = "code-execution-2025-08-25";

    fn function_tool() -> Value {
        json!({ "type": "function", "function": { "name": "lookup", "parameters": { "type": "object" } } })
    }

    fn with_beta(mut body: Value, betas: Value) -> Value {
        body[super::super::ANTHROPIC_BETA_FIELD] = betas;
        body
    }

    fn refused_code(result: Result<(), GatewayError>) -> Option<&'static str> {
        match result {
            Err(GatewayError::PlatformRefused { code, .. }) => Some(code),
            Err(other) => panic!("unexpected error: {other}"),
            Ok(()) => None,
        }
    }

    #[test]
    fn fleet_refuses_server_and_untyped_tools() {
        for tool in [
            json!({ "type": "web_fetch_20250910", "name": "web_fetch" }),
            json!({ "type": "code_execution_20250825", "name": "code_execution" }),
            json!({ "name": "lookup", "input_schema": { "type": "object" } }),
            json!({ "type": null, "function": { "name": "lookup" } }),
        ] {
            let body = json!({ "model": "m", "tools": [function_tool(), tool] });
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &body)),
                Some(CODE),
                "{body}"
            );
        }
    }

    #[test]
    fn fleet_refuses_provider_side_retrieval_fields_and_the_online_variant() {
        for extra in [
            json!({ "plugins": [{ "id": "web" }] }),
            json!({ "plugins": [{ "id": "file-parser" }] }),
            json!({ "web_search_options": { "search_context_size": "high" } }),
            json!({ "transforms": ["middle-out"] }),
            json!({ "route": "fallback" }),
            json!({ "search_parameters": { "mode": "on" } }),
            json!({ "model": "openai/gpt-4o:online" }),
            json!({ "model": "openai/gpt-4o:Online:nitro" }),
            json!({ "models": ["openai/gpt-4o", "anthropic/claude:online"] }),
        ] {
            let mut body = json!({ "model": "m", "tools": [function_tool()] });
            for (key, value) in extra.as_object().expect("object") {
                body[key] = value.clone();
            }
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &body)),
                Some(CODE),
                "{body}"
            );
            for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
                assert_eq!(refused_code(enforce(custody, &body)), None, "{custody:?}");
            }
        }
    }

    #[test]
    fn fleet_passes_inert_values_and_ordinary_model_variants() {
        for body in [
            json!({ "model": "m", "plugins": null, "transforms": [], "web_search_options": {} }),
            json!({ "model": "openai/gpt-4o:nitro", "models": ["a/b:floor", "c/d"] }),
            json!({ "model": "online-model-v1", "route_hint": "x" }),
        ] {
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &body)),
                None,
                "{body}"
            );
        }
    }

    #[test]
    fn fleet_refuses_any_beta_outside_the_allowlist() {
        for betas in [
            json!(CODE_EXECUTION_BETA),
            json!(format!(
                "{PROMPT}, {CODE_EXECUTION_BETA}",
                PROMPT = PERMITTED_BETAS[0]
            )),
            json!("PROMPT-CACHING-2024-07-31"),
            json!(["prompt-caching-2024-07-31"]),
        ] {
            let body = with_beta(json!({ "model": "m" }), betas);
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &body)),
                Some(CODE),
                "{body}"
            );
        }
    }

    #[test]
    fn fleet_passes_function_tools_and_caching_betas() {
        let body = with_beta(
            json!({ "model": "m", "tools": [function_tool()] }),
            json!(format!(" {} ,{},", PERMITTED_BETAS[0], PERMITTED_BETAS[1])),
        );
        assert_eq!(refused_code(enforce(GatewayCustody::Fleet, &body)), None);
        assert_eq!(
            refused_code(enforce(GatewayCustody::Fleet, &json!({ "model": "m" }))),
            None
        );
        assert_eq!(
            refused_code(enforce(
                GatewayCustody::Fleet,
                &json!({ "model": "m", "tools": [] })
            )),
            None
        );
    }

    #[test]
    fn other_custodies_pass_everything() {
        let body = with_beta(
            json!({
                "model": "m",
                "tools": [{ "type": "web_fetch_20250910", "name": "web_fetch" }],
            }),
            json!(CODE_EXECUTION_BETA),
        );
        for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
            assert_eq!(refused_code(enforce(custody, &body)), None, "{custody:?}");
            assert_eq!(
                refused_code(enforce_native_anthropic_tools(custody, &body)),
                None,
                "{custody:?}"
            );
        }
    }

    #[test]
    fn native_anthropic_tools_allow_only_custom_tools_on_fleet() {
        let custom = json!({ "name": "lookup", "input_schema": { "type": "object" } });
        let typed_custom = json!({ "type": "custom", "name": "lookup", "input_schema": {} });
        let body = json!({ "tools": [custom.clone(), typed_custom] });
        assert_eq!(
            refused_code(enforce_native_anthropic_tools(GatewayCustody::Fleet, &body)),
            None
        );
        for tool in [
            json!({ "type": "web_search_20250305", "name": "web_search" }),
            json!({ "type": "bash_20250124", "name": "bash" }),
            json!({ "type": 7, "name": "lookup" }),
        ] {
            let body = json!({ "tools": [custom.clone(), tool] });
            assert_eq!(
                refused_code(enforce_native_anthropic_tools(GatewayCustody::Fleet, &body)),
                Some(CODE),
                "{body}"
            );
        }
    }

    #[test]
    fn beta_header_is_refused_only_on_fleet_and_only_outside_the_allowlist() {
        let mixed = format!("{},{CODE_EXECUTION_BETA}", PERMITTED_BETAS[0]);
        for header in [CODE_EXECUTION_BETA, mixed.as_str()] {
            assert_eq!(
                refused_code(enforce_beta_header(GatewayCustody::Fleet, Some(header))),
                Some(CODE),
                "{header}"
            );
            for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
                assert_eq!(
                    refused_code(enforce_beta_header(custody, Some(header))),
                    None,
                    "{custody:?} {header}"
                );
            }
        }
        let caching = PERMITTED_BETAS.join(",");
        for header in [None, Some(""), Some(caching.as_str())] {
            assert_eq!(
                refused_code(enforce_beta_header(GatewayCustody::Fleet, header)),
                None,
                "{header:?}"
            );
        }
    }

    #[test]
    fn beta_header_joins_every_header_line() {
        use axum::http::HeaderValue;

        let mut headers = HeaderMap::new();
        assert_eq!(beta_header(&headers), None);
        headers.append(BETA_HEADER, HeaderValue::from_static("   "));
        assert_eq!(beta_header(&headers), None);
        headers.append(BETA_HEADER, HeaderValue::from_static(PERMITTED_BETAS[0]));
        headers.append(BETA_HEADER, HeaderValue::from_static(CODE_EXECUTION_BETA));
        let joined = beta_header(&headers).expect("two lines name values");
        assert_eq!(
            joined,
            format!("{},{CODE_EXECUTION_BETA}", PERMITTED_BETAS[0])
        );
        assert_eq!(
            refused_code(enforce_beta_header(GatewayCustody::Fleet, Some(&joined))),
            Some(CODE)
        );

        let mut opaque = HeaderMap::new();
        opaque.append(
            BETA_HEADER,
            HeaderValue::from_bytes(b"prompt-caching-2024-07-31\xff").expect("opaque bytes"),
        );
        let lossy = beta_header(&opaque).expect("opaque line is kept");
        assert_eq!(
            refused_code(enforce_beta_header(GatewayCustody::Fleet, Some(&lossy))),
            Some(CODE)
        );
    }

    #[test]
    fn refusal_messages_never_echo_the_request() {
        let body = json!({ "tools": [{ "type": "web_fetch_20250910", "name": "web_fetch" }] });
        let Err(error) = enforce(GatewayCustody::Fleet, &body) else {
            panic!("expected a refusal");
        };
        let GatewayError::PlatformRefused { message, .. } = error else {
            panic!("expected a platform refusal");
        };
        assert!(!message.contains("web_fetch"), "{message}");
    }
}
