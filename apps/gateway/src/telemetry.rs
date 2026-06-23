//! OpenTelemetry export seam (#540, P1) — the consent-gated OTLP drain + the
//! experimental GenAI semantic-convention LLM spans.
//!
//! Mirrors Core's seam (`apps/core/src/telemetry.rs`). OTel is **not a backend**;
//! it is the vendor-neutral instrumentation seam. The gateway already writes
//! `tracing` spans and keeps an always-on local sink (the `audit/` SQLite store
//! plus the stdout `fmt` layer). This module adds an *additional, consented* drain:
//! when — and only when — diagnostics export is enabled (`RYU_DIAGNOSTICS_EXPORT_ENABLED`)
//! **and** an OTLP endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT`), `main.rs`
//! installs a `tracing-opentelemetry` layer that exports the same `tracing` spans
//! over OTLP/HTTP. With the flag off the layer is `None` — a true no-op — so **zero
//! spans egress** and the `audit/` behaviour is unchanged by construction (it is a
//! plain SQLite store, not a `tracing-subscriber` layer).
//!
//! Unlike Core, the gateway has no `PreferencesStore`: it resolves its config from
//! env/TOML. So the export gate reads env directly. Core's `gateway_spawn_env()`
//! is the place that forwards the user's desktop pref into these env vars when it
//! spawns the gateway as a sidecar (a Core-side follow-on, outside this crate).
//!
//! Placement (Core vs Gateway): this exports *what the gateway measured* (tokens,
//! model, provider, latency) for the user's own diagnostics; it never enforces
//! policy. The destination is a swappable config value, never a hardcoded vendor —
//! pointing at Axiom, Grafana, a self-hosted Collector, or off is one env change
//! with no code change.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing::Level;
use tracing_subscriber::{filter::LevelFilter, Layer};

/// The OTel service name reported for the gateway's exported spans.
const SERVICE_NAME: &str = "ryu-gateway";

/// The instrumentation scope name passed to `provider.tracer(..)`.
const TRACER_SCOPE: &str = "ryu-gateway";

/// Env mirror: data-plane OTLP export on/off. Shares the kebab pref name's intent
/// with Core's `diagnostics-export-enabled` (resolved there from a `PreferencesStore`).
const DIAGNOSTICS_EXPORT_ENABLED_ENV: &str = "RYU_DIAGNOSTICS_EXPORT_ENABLED";

/// Env mirror: the OTLP destination. The OTel-standard var, so pointing at a
/// Collector/Axiom needs no Ryu-specific knowledge. Empty/unset → no export.
const DIAGNOSTICS_OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";

/// Env mirror: the OTel semconv stability opt-in. The GenAI conventions are
/// EXPERIMENTAL (no stable release), so the `gen_ai.*` attributes are only emitted
/// when this is opted into — exactly as the OTel spec prescribes.
const SEMCONV_STABILITY_OPT_IN_ENV: &str = "OTEL_SEMCONV_STABILITY_OPT_IN";

/// The token an operator sets in `OTEL_SEMCONV_STABILITY_OPT_IN` to enable the
/// GenAI conventions. Matched tolerantly (substring) so the standard comma-joined
/// multi-category form (e.g. `"gen_ai_latest_experimental,http"`) also enables it.
const SEMCONV_GEN_AI_TOKEN: &str = "gen_ai";

/// Parse a boolean env value, treating only explicit truthy/falsey forms as
/// decisive and falling back to `default` for anything else. Mirrors Core's
/// `privacy::parse_bool` so the two seams agree on what "on" means.
fn parse_bool(value: &str, default: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => true,
        "false" | "0" | "off" | "no" => false,
        _ => default,
    }
}

/// Pure gate decision: does the resolved config call for an OTLP exporter?
///
/// Export happens only when the operator opted in **and** a non-empty destination
/// is configured. Extracted as a pure fn (mirrors Core) so the "off / no endpoint →
/// layer absent" rule is unit-testable without touching the process-global subscriber.
pub fn should_export(enabled: bool, endpoint: &str) -> bool {
    enabled && !endpoint.trim().is_empty()
}

/// Pure gate decision: are the experimental GenAI semantic conventions opted into?
///
/// The conventions are not stable, so `gen_ai.*` attributes are gated on
/// `OTEL_SEMCONV_STABILITY_OPT_IN` containing a `gen_ai` token. Default-unset →
/// `false` → no `gen_ai.*` span is emitted. Orthogonal to [`should_export`]: this
/// only controls whether the LLM span carries the experimental attribute names;
/// whether anything egresses is decided independently by the export gate.
pub fn gen_ai_semconv_opted_in(opt_in: &str) -> bool {
    opt_in.to_ascii_lowercase().contains(SEMCONV_GEN_AI_TOKEN)
}

/// Resolve the export config from env and, when consented, build the OTLP exporter
/// + tracer provider and return a ready `tracing-opentelemetry` layer.
///
/// Returns `None` (a no-op layer) whenever export is off or no endpoint is set, or
/// if the exporter fails to build — failing open so a misconfigured drain never
/// blocks gateway startup. The returned tuple's second element is the provider the
/// caller should hold for the process lifetime (dropping it stops export); `main.rs`
/// leaks it so spans flush for the whole run.
pub fn build_otlp_layer<S>() -> Option<(Box<dyn Layer<S> + Send + Sync>, SdkTracerProvider)>
where
    S: tracing::Subscriber
        + for<'a> tracing_subscriber::registry::LookupSpan<'a>
        + Send
        + Sync,
{
    let enabled = std::env::var(DIAGNOSTICS_EXPORT_ENABLED_ENV)
        .map(|v| parse_bool(&v, false))
        .unwrap_or(false);
    let endpoint = std::env::var(DIAGNOSTICS_OTLP_ENDPOINT_ENV)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if !should_export(enabled, &endpoint) {
        return None;
    }

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint.clone())
        .build()
    {
        Ok(exporter) => exporter,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "telemetry: OTLP exporter build failed; export disabled (local audit sink unaffected)"
            );
            return None;
        }
    };

    let resource = Resource::builder()
        .with_attribute(KeyValue::new("service.name", SERVICE_NAME))
        .build();

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();

    let tracer = provider.tracer(TRACER_SCOPE);

    tracing::info!(
        endpoint = %endpoint,
        "telemetry: OTLP export enabled (consented); spans drain to the configured endpoint"
    );

    // Only export INFO+ spans so the drain stays a wide-event stream, not a debug
    // firehose; the local fmt/SQLite sinks keep their own verbosity.
    let layer = tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_filter(LevelFilter::from_level(Level::INFO))
        .boxed();

    Some((layer, provider))
}

/// Cached resolution of the GenAI semconv opt-in, read once at process start.
///
/// `OTEL_SEMCONV_STABILITY_OPT_IN` is an operator/start-time setting (it cannot
/// change mid-process the way a pref could), so resolving it once avoids a
/// `std::env::var` lookup on every LLM call in the hot path.
static GEN_AI_OPT_IN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether to emit the experimental `gen_ai.*` attributes, resolved from
/// `OTEL_SEMCONV_STABILITY_OPT_IN` (cached). See [`gen_ai_semconv_opted_in`].
fn gen_ai_enabled() -> bool {
    *GEN_AI_OPT_IN.get_or_init(|| {
        std::env::var(SEMCONV_STABILITY_OPT_IN_ENV)
            .map(|v| gen_ai_semconv_opted_in(&v))
            .unwrap_or(false)
    })
}

/// Emit one LLM span carrying the experimental OTel GenAI semantic-convention
/// attributes for a completed model call, reusing data the audit/metrics layer
/// already has (model, provider, tokens, latency).
///
/// This is a no-op unless the GenAI conventions are opted into via
/// `OTEL_SEMCONV_STABILITY_OPT_IN` (see [`gen_ai_enabled`]) — the conventions are
/// EXPERIMENTAL. When the OTLP layer is also installed (consented export), the span
/// drains to the configured backend, which maps `gen_ai.*` with no re-instrumentation.
/// When export is off the span is still created locally (and dropped at the local
/// sinks) — emission and egress are orthogonal gates.
///
/// Emitted at INFO so it clears the OTLP layer's INFO+ filter; a debug span would
/// never reach the exporter. The span's own wall-clock is ~0 (the call already
/// completed), so `gen_ai.client.operation.duration` is set explicitly from the
/// measured `latency_ms` rather than from span timing.
///
/// Attribute names are the exact dotted strings from the OTel GenAI registry —
/// `tracing-opentelemetry` maps each field name 1:1 to an OTel attribute, so the
/// literal field names ARE the convention keys.
///
/// **No cost attribute:** the GenAI conventions define no first-class cost field;
/// cost is derived downstream from `gen_ai.usage.{input,output}_tokens`.
///
/// `operation` is the `gen_ai.operation.name` value (e.g. `"chat"` for chat
/// completions, the modality name for image/tts/stt) — never hardcoded by the helper.
pub fn emit_gen_ai_span(
    operation: &str,
    provider: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    latency_ms: u64,
) {
    if !gen_ai_enabled() {
        return;
    }

    // Duration per the GenAI convention is expressed in seconds (it is really a
    // histogram metric, `gen_ai.client.operation.duration`); we record the measured
    // wall-clock latency converted from ms so a backend reads true call duration,
    // not the ~0 span lifetime.
    let duration_secs = latency_ms as f64 / 1000.0;

    let span = tracing::info_span!(
        "gen_ai.chat",
        "gen_ai.operation.name" = operation,
        "gen_ai.provider.name" = provider,
        "gen_ai.request.model" = model,
        "gen_ai.usage.input_tokens" = input_tokens,
        "gen_ai.usage.output_tokens" = output_tokens,
        "gen_ai.client.operation.duration" = duration_secs,
    );
    // Entering+exiting immediately is enough for `tracing-opentelemetry` to record
    // a span carrying the attributes; the duration attribute (not the span lifetime)
    // is what conveys real latency to the backend.
    let _enter = span.enter();
}

#[cfg(test)]
mod tests {
    use super::{gen_ai_semconv_opted_in, parse_bool, should_export};

    #[test]
    fn export_requires_consent_and_endpoint() {
        // The opt-in default posture: off + empty → no export.
        assert!(!should_export(false, ""));
        // Endpoint set but consent withheld → still no export (flag off wins).
        assert!(!should_export(false, "https://otlp.example"));
        // Consented but no destination → nothing to export to.
        assert!(!should_export(true, ""));
        assert!(!should_export(true, "   "));
        // Both present → export.
        assert!(should_export(true, "https://otlp.example"));
    }

    #[test]
    fn gen_ai_gate_is_off_unless_opted_in() {
        // Default-unset / unrelated values → no gen_ai attributes.
        assert!(!gen_ai_semconv_opted_in(""));
        assert!(!gen_ai_semconv_opted_in("http"));
        // The bare token and the standard comma-joined multi-category form both enable it.
        assert!(gen_ai_semconv_opted_in("gen_ai"));
        assert!(gen_ai_semconv_opted_in("gen_ai_latest_experimental"));
        assert!(gen_ai_semconv_opted_in("http,gen_ai_latest_experimental,database"));
        // Case-insensitive.
        assert!(gen_ai_semconv_opted_in("GEN_AI"));
    }

    #[test]
    fn bool_parsing_honors_defaults() {
        assert!(parse_bool("true", false));
        assert!(parse_bool("  ON ", false));
        assert!(!parse_bool("0", true));
        assert!(!parse_bool("off", true));
        // Anything else falls back to the supplied default.
        assert!(parse_bool("", true));
        assert!(!parse_bool("garbage", false));
    }
}
