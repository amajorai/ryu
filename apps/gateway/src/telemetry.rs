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
//! Exporter presets (Langfuse, LangSmith, Braintrust, Arize Phoenix, Helicone,
//! Datadog) come from `ryu_tracing::export_presets`. A Core-managed gateway
//! receives the destination Core already resolved (a verbatim
//! `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` plus headers); a standalone gateway
//! resolves `RYU_DIAGNOSTICS_OTLP_PRESET` itself, with credentials given as
//! `env:` / `file:` references. Either way the export gate above still applies.
//!
//! Placement (Core vs Gateway): this exports *what the gateway measured* (tokens,
//! model, provider, latency) for the user's own diagnostics; it never enforces
//! policy. The destination is a swappable config value, never a hardcoded vendor —
//! pointing at Axiom, Grafana, a self-hosted Collector, or off is one env change
//! with no code change.

pub mod content;
pub mod gen_ai_span;
pub mod propagation;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::{Key, KeyValue};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
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

/// The OTel-standard signal-specific traces URL, used verbatim when set.
const OTLP_TRACES_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";

/// Exporter preset env (`otlp` | `langfuse` | `langsmith` | `braintrust` |
/// `phoenix` | `helicone` | `datadog`) and its fields. Shares names with Core's
/// `diagnostics-otlp-*` preference mirrors.
const OTLP_PRESET_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PRESET";
const OTLP_PROJECT_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PROJECT";
const OTLP_REGION_ENV: &str = "RYU_DIAGNOSTICS_OTLP_REGION";
const OTLP_API_KEY_REF_ENV: &str = "RYU_DIAGNOSTICS_OTLP_API_KEY_REF";
const OTLP_PUBLIC_KEY_REF_ENV: &str = "RYU_DIAGNOSTICS_OTLP_PUBLIC_KEY_REF";

/// Env mirror: the OTel semconv stability opt-in. The GenAI conventions are
/// EXPERIMENTAL (no stable release), so the `gen_ai.*` attributes are only emitted
/// when this is opted into — exactly as the OTel spec prescribes.
const SEMCONV_STABILITY_OPT_IN_ENV: &str = "OTEL_SEMCONV_STABILITY_OPT_IN";

/// The token an operator sets in `OTEL_SEMCONV_STABILITY_OPT_IN` to enable the
/// GenAI conventions. Matched tolerantly (substring) so the standard comma-joined
/// multi-category form (e.g. `"gen_ai_latest_experimental,http"`) also enables it.
const SEMCONV_GEN_AI_TOKEN: &str = "gen_ai";

/// Env mirror: content mode (`metadata_only` default | `content`). Core forwards
/// the user's `diagnostics-otlp-content-mode` here only inside its consented
/// branch and forces `metadata_only` otherwise.
const DIAGNOSTICS_CONTENT_MODE_ENV: &str = "RYU_DIAGNOSTICS_CONTENT_MODE";

/// Env mirror: per-span exported content byte cap.
const DIAGNOSTICS_MAX_CONTENT_BYTES_ENV: &str = "RYU_DIAGNOSTICS_MAX_CONTENT_BYTES";

/// Default per-span content cap (Claude Platform parity: 750 KB).
pub const DEFAULT_MAX_CONTENT_BYTES: usize = 750_000;

/// The OTLP/HTTP traces signal path appended to a base endpoint.
const TRACES_PATH: &str = "/v1/traces";

/// Upper bound on a flush/shutdown so a dead destination cannot hang exit.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Set once the consented OTLP layer is installed. Content export requires it,
/// so content can never be attached to spans when export is off.
static EXPORT_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The installed tracer provider, kept for flush/shutdown on exit.
static PROVIDER: std::sync::OnceLock<SdkTracerProvider> = std::sync::OnceLock::new();

/// Content-mode env, resolved once (Core respawns the gateway on change).
static CONTENT_MODE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Content cap env, resolved once.
static MAX_CONTENT_BYTES: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

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

/// Pure parse of the content-mode env value: only an explicit `content` (or
/// `full`) opts in. Mirrors Core's `privacy::ContentMode::parse`.
pub fn content_mode_opted_in(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "content" | "full"
    )
}

/// Pure parse of the content cap; non-numeric or zero → the default.
pub fn parse_max_content_bytes(value: &str) -> usize {
    value
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|bytes| *bytes > 0)
        .unwrap_or(DEFAULT_MAX_CONTENT_BYTES)
}

/// Whether spans may carry prompt/completion/tool content: the consented OTLP
/// layer is installed AND content mode was opted into. Call sites must check
/// this before building any content attribute.
pub fn content_enabled() -> bool {
    EXPORT_ACTIVE.load(Ordering::Relaxed)
        && *CONTENT_MODE.get_or_init(|| {
            std::env::var(DIAGNOSTICS_CONTENT_MODE_ENV)
                .map(|value| content_mode_opted_in(&value))
                .unwrap_or(false)
        })
}

/// Whether the consented OTLP layer is installed (anything can be exported).
pub fn export_active() -> bool {
    EXPORT_ACTIVE.load(Ordering::Relaxed)
}

/// The per-span byte cap for exported content (default 750000).
pub fn max_content_bytes() -> usize {
    *MAX_CONTENT_BYTES.get_or_init(|| {
        std::env::var(DIAGNOSTICS_MAX_CONTENT_BYTES_ENV)
            .map(|value| parse_max_content_bytes(&value))
            .unwrap_or(DEFAULT_MAX_CONTENT_BYTES)
    })
}

/// Resolve a configured OTLP base endpoint to the traces signal URL. Mirrors
/// Core's `telemetry::resolve_traces_endpoint`: no path or `/` → `/v1/traces`;
/// a path already ending in `/v1/traces` is kept; any other path is a prefix
/// that gets `/v1/traces` appended. A query string is preserved.
pub fn resolve_traces_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    let (base, query) = match trimmed.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (trimmed, None),
    };
    let base = base.trim_end_matches('/');
    let mut resolved = if base.ends_with(TRACES_PATH) {
        base.to_owned()
    } else {
        format!("{base}{TRACES_PATH}")
    };
    if let Some(query) = query {
        resolved.push('?');
        resolved.push_str(query);
    }
    resolved
}

/// Where the gateway's spans go: the full traces URL plus any headers and
/// resource attributes a preset adds (operator `OTEL_EXPORTER_OTLP_HEADERS`
/// are read by the exporter itself).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Destination {
    pub traces_url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub resource_attributes: std::collections::BTreeMap<String, String>,
}

/// Resolve the export destination from an env lookup (pure for tests).
///
/// Order: a non-`otlp` preset (or an `otlp` preset with an API-key reference)
/// resolves through `ryu_tracing::export_presets` with `env:`/`file:`
/// credential references; else a verbatim `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`;
/// else `OTEL_EXPORTER_OTLP_ENDPOINT` with `/v1/traces` appended. `Ok(None)`
/// means no destination is configured.
pub fn resolve_destination(
    env: impl Fn(&str) -> Option<String>,
) -> Result<Option<Destination>, String> {
    use ryu_tracing::export_presets::{
        resolve, ExporterPreset, PresetError, PresetSettings, SecretReference,
    };

    let get = |name: &str| {
        env(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let raw_preset = get(OTLP_PRESET_ENV).unwrap_or_default();
    let preset = ExporterPreset::parse(&raw_preset)
        .ok_or_else(|| PresetError::UnknownPreset(raw_preset.clone()).to_string())?;
    let api_key_ref = get(OTLP_API_KEY_REF_ENV);
    let base_endpoint = get(DIAGNOSTICS_OTLP_ENDPOINT_ENV);
    let uses_preset =
        preset != ExporterPreset::Otlp || (api_key_ref.is_some() && base_endpoint.is_some());
    if uses_preset {
        let secret = |reference: Option<String>| -> Result<Option<String>, String> {
            reference
                .map(|raw| {
                    SecretReference::parse(&raw)
                        .and_then(|reference| reference.resolve_local())
                        .map_err(|error| error.to_string())
                })
                .transpose()
        };
        let settings = PresetSettings {
            preset,
            endpoint: base_endpoint,
            project: get(OTLP_PROJECT_ENV),
            region: get(OTLP_REGION_ENV),
            api_key: secret(api_key_ref)?,
            public_key: secret(get(OTLP_PUBLIC_KEY_REF_ENV))?,
        };
        let resolved = resolve(&settings).map_err(|error| error.to_string())?;
        return Ok(Some(Destination {
            traces_url: resolved.traces_endpoint,
            headers: resolved.headers.into_iter().collect(),
            resource_attributes: resolved.resource_attributes,
        }));
    }
    if let Some(url) = get(OTLP_TRACES_ENDPOINT_ENV) {
        return Ok(Some(Destination {
            traces_url: url,
            ..Destination::default()
        }));
    }
    Ok(base_endpoint.map(|endpoint| Destination {
        traces_url: resolve_traces_endpoint(&endpoint),
        ..Destination::default()
    }))
}

/// Whether a detected `service.name` came from the operator rather than the
/// SDK's `unknown_service` fallback.
fn is_operator_service_name(detected: Option<&str>) -> bool {
    detected.is_some_and(|name| !name.is_empty() && !name.starts_with("unknown_service"))
}

/// Build the exported resource: the SDK env detectors (`OTEL_SERVICE_NAME`,
/// `OTEL_RESOURCE_ATTRIBUTES`) win; otherwise `service.name` defaults to
/// `ryu-gateway` and `service.version` to this build's version.
fn build_resource(extra: &std::collections::BTreeMap<String, String>) -> Resource {
    let detected = Resource::builder().build();
    let service_name = detected
        .get(&Key::from_static_str("service.name"))
        .map(|value| value.as_str().into_owned());
    let mut builder = Resource::builder();
    if !is_operator_service_name(service_name.as_deref()) {
        builder = builder.with_service_name(SERVICE_NAME);
    }
    if detected
        .get(&Key::from_static_str("service.version"))
        .is_none()
    {
        builder =
            builder.with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")));
    }
    for (key, value) in extra {
        builder = builder.with_attribute(KeyValue::new(key.clone(), value.clone()));
    }
    builder.build()
}

/// Install the global W3C trace-context propagator (idempotent).
pub fn install_propagator() {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
}

/// Flush pending spans. No-op without an installed exporter. Blocking.
#[allow(dead_code)]
pub fn force_flush() -> Result<(), String> {
    match PROVIDER.get() {
        Some(provider) => provider.force_flush().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Flush and shut down the exporter on exit. Blocking, bounded by
/// [`FLUSH_TIMEOUT`]; safe without an exporter.
pub fn shutdown() {
    if let Some(provider) = PROVIDER.get() {
        if let Err(error) = provider.shutdown_with_timeout(FLUSH_TIMEOUT) {
            eprintln!("ryu-gateway: OTLP shutdown flush failed: {error}");
        }
    }
}

/// Resolve the export config from env and, when consented, build the OTLP exporter
/// + tracer provider and return a ready `tracing-opentelemetry` layer.
///
/// Returns `None` (a no-op layer) whenever export is off or no endpoint is set, or
/// if the exporter fails to build — failing open so a misconfigured drain never
/// blocks gateway startup. The returned tuple's second element is the provider the
/// caller may drop: a clone is retained here so [`shutdown`] can flush it on exit.
pub fn build_otlp_layer<S>() -> Option<(Box<dyn Layer<S> + Send + Sync>, SdkTracerProvider)>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a> + Send + Sync,
{
    let enabled = std::env::var(DIAGNOSTICS_EXPORT_ENABLED_ENV)
        .map(|v| parse_bool(&v, false))
        .unwrap_or(false);
    // Propagation is harmless without an exporter: with no OTel layer the spans
    // carry no valid context, so nothing is injected.
    install_propagator();

    if !enabled {
        return None;
    }
    let destination = match resolve_destination(|name| std::env::var(name).ok()) {
        Ok(Some(destination)) => destination,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "telemetry: OTLP exporter preset could not be resolved; export disabled"
            );
            return None;
        }
    };
    let endpoint = destination.traces_url.clone();
    if !should_export(enabled, &endpoint) {
        return None;
    }

    // `OTEL_EXPORTER_OTLP_HEADERS` (forwarded by Core, including the derived
    // PostHog bearer and any preset auth) is read by the exporter itself; a
    // standalone preset's headers are added here.
    let exporter = match SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint.clone())
        .with_headers(destination.headers.clone())
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

    // ParentBased(AlwaysOn): honor an inbound `traceparent`'s sampled flag.
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::AlwaysOn)))
        .with_resource(build_resource(&destination.resource_attributes))
        .build();
    let _ = PROVIDER.set(provider.clone());
    EXPORT_ACTIVE.store(true, Ordering::Relaxed);

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

#[cfg(test)]
mod destination_tests {
    use super::resolve_destination;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn nothing_configured_means_no_destination() {
        assert_eq!(resolve_destination(env(&[])), Ok(None));
    }

    #[test]
    fn plain_endpoint_and_verbatim_traces_url() {
        let plain = resolve_destination(env(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:4318")]))
            .unwrap()
            .unwrap();
        assert_eq!(plain.traces_url, "http://c:4318/v1/traces");
        // Core forwards a preset's exact URL; it must not get /v1/traces appended.
        let verbatim = resolve_destination(env(&[
            ("RYU_DIAGNOSTICS_OTLP_PRESET", "otlp"),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "https://api.helicone.ai/v1/trace/log-python",
            ),
            (
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "https://api.helicone.ai/v1/trace/log-python",
            ),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            verbatim.traces_url,
            "https://api.helicone.ai/v1/trace/log-python"
        );
        assert!(verbatim.headers.is_empty());
    }

    #[test]
    fn standalone_presets_resolve_file_references() {
        let dir = std::env::temp_dir().join(format!("ryu-gw-otlp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("dd");
        std::fs::write(&key, "dd-key\n").unwrap();
        let reference = format!("file:{}", key.display());
        let destination = resolve_destination(env(&[
            ("RYU_DIAGNOSTICS_OTLP_PRESET", "datadog"),
            ("RYU_DIAGNOSTICS_OTLP_REGION", "eu"),
            ("RYU_DIAGNOSTICS_OTLP_API_KEY_REF", reference.as_str()),
        ]))
        .unwrap()
        .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            destination.traces_url,
            "https://otlp.datadoghq.eu/v1/traces"
        );
        assert_eq!(destination.headers["dd-api-key"], "dd-key");
        assert_eq!(destination.headers["dd-otlp-source"], "llmobs");
    }

    #[test]
    fn standalone_presets_reject_literals_vault_refs_and_unknown_names() {
        let literal = resolve_destination(env(&[
            ("RYU_DIAGNOSTICS_OTLP_PRESET", "langsmith"),
            ("RYU_DIAGNOSTICS_OTLP_API_KEY_REF", "lsv2-raw"),
        ]))
        .unwrap_err();
        assert!(!literal.contains("lsv2-raw"));
        let vault = resolve_destination(env(&[
            ("RYU_DIAGNOSTICS_OTLP_PRESET", "langsmith"),
            ("RYU_DIAGNOSTICS_OTLP_API_KEY_REF", "secret:LANGSMITH"),
        ]))
        .unwrap_err();
        assert!(vault.contains("Core vault"), "{vault}");
        assert!(resolve_destination(env(&[("RYU_DIAGNOSTICS_OTLP_PRESET", "nope")])).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        content_mode_opted_in, gen_ai_semconv_opted_in, is_operator_service_name, parse_bool,
        parse_max_content_bytes, resolve_traces_endpoint, should_export, DEFAULT_MAX_CONTENT_BYTES,
    };

    #[test]
    fn traces_endpoint_appends_signal_path() {
        for (input, expected) in [
            ("https://otlp.example", "https://otlp.example/v1/traces"),
            ("https://otlp.example/", "https://otlp.example/v1/traces"),
            (
                "https://otlp.example/v1/traces",
                "https://otlp.example/v1/traces",
            ),
            (
                "https://us.i.posthog.com/i",
                "https://us.i.posthog.com/i/v1/traces",
            ),
            (
                "https://otlp.example/p?x=1",
                "https://otlp.example/p/v1/traces?x=1",
            ),
        ] {
            assert_eq!(resolve_traces_endpoint(input), expected, "{input}");
        }
    }

    #[test]
    fn content_mode_and_cap_parse() {
        assert!(content_mode_opted_in("content"));
        assert!(content_mode_opted_in(" Full "));
        assert!(!content_mode_opted_in("metadata_only"));
        assert!(!content_mode_opted_in(""));
        assert_eq!(parse_max_content_bytes("10"), 10);
        assert_eq!(parse_max_content_bytes("0"), DEFAULT_MAX_CONTENT_BYTES);
        assert_eq!(parse_max_content_bytes("nope"), DEFAULT_MAX_CONTENT_BYTES);
    }

    #[test]
    fn service_name_defaults_unless_operator_set() {
        assert!(!is_operator_service_name(None));
        assert!(!is_operator_service_name(Some(
            "unknown_service:ryu-gateway"
        )));
        assert!(is_operator_service_name(Some("edge-gw")));
    }

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
        assert!(gen_ai_semconv_opted_in(
            "http,gen_ai_latest_experimental,database"
        ));
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
