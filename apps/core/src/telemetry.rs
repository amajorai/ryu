//! OpenTelemetry export seam (#539, P1) — the consent-gated OTLP drain.
//!
//! OTel is **not a backend**; it is the vendor-neutral instrumentation seam. Core
//! already writes `tracing` spans everywhere and keeps an always-on local sink
//! (`server/trace.rs`, the `~/.ryu/traces.db` SQLite store, plus the stdout `fmt`
//! layer). This module adds an *additional, consented* drain: when — and only
//! when — the user has opted in (`diagnostics-export-enabled`) **and** an OTLP
//! endpoint is configured (`diagnostics-otlp-endpoint` / the OTel-standard
//! `OTEL_EXPORTER_OTLP_ENDPOINT`), `main.rs` installs a `tracing-opentelemetry`
//! layer that exports the same `tracing` spans over OTLP/HTTP. With the pref off
//! the layer is `None` — a true no-op — so **zero spans egress** and `trace.rs`
//! behaviour is unchanged by construction (it is a plain SQLite store, not a
//! `tracing-subscriber` layer).
//!
//! Placement (Core vs Gateway): this exports *what runs* on the local node for
//! the user's own diagnostics; it never enforces policy. The destination is a
//! swappable config value, never a hardcoded vendor — pointing at Axiom, Grafana,
//! a self-hosted Collector, or off is one pref/env change with no code change.

use std::sync::atomic::{AtomicBool, Ordering};

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing::Level;
use tracing_subscriber::{filter::LevelFilter, Layer};

use crate::server::preferences::PreferencesStore;

/// The OTel service name reported for Core's exported spans.
const SERVICE_NAME: &str = "ryu-core";

/// The instrumentation scope name passed to `provider.tracer(..)`.
const TRACER_SCOPE: &str = "ryu-core";

/// Process-global seeded once from the `diagnostics-export-enabled` pref at Core
/// startup ([`build_otlp_layer`]), so the SYNC `gateway_spawn_env()` can forward
/// the same consent into the gateway sidecar (which has no `PreferencesStore`,
/// exactly like the crash tier). The data-plane default is OFF (§6 opt-in), so a
/// spawn that races startup seeding errs to "no export". The endpoint itself
/// stays the gate's other half — consent alone never egresses anything.
static EXPORT_CONSENT: AtomicBool = AtomicBool::new(false);

/// The resolved OTLP endpoint, seeded once at startup so the gateway-spawn path
/// can forward it. `None` (unset/empty) means no destination → no export.
static OTLP_ENDPOINT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Env var carrying OTLP request headers (the OTel-standard name; e.g.
/// `Authorization=Bearer <key>`). Read directly here only to FORWARD it to the
/// gateway child — `opentelemetry-otlp` itself reads this env when it builds the
/// exporter, so a destination needing auth (PostHog, Axiom) works with no
/// Ryu-specific code. This is the vendor-neutral primitive.
pub const OTLP_HEADERS_ENV: &str = "OTEL_EXPORTER_OTLP_HEADERS";

/// PostHog convenience (#548, P6). PostHog's OTLP ingestion authenticates with the
/// project API key as a bearer token. Rather than make the user hand-assemble the
/// `OTEL_EXPORTER_OTLP_HEADERS` string, an operator/desktop may set just the key
/// here and Core derives the standard headers env from it. Still fully swappable:
/// any OTLP destination works via the raw headers env; this is only sugar for the
/// PostHog-LLM-analytics path the issue names. Never hardcodes a vendor endpoint —
/// the endpoint is still `diagnostics-otlp-endpoint`.
pub const POSTHOG_KEY_ENV: &str = "RYU_POSTHOG_KEY";

/// Whether the user consented to data-plane OTLP export (the seeded process-global).
/// Used by `gateway_spawn_env()` to forward consent into the gateway sidecar so the
/// gateway's `gen_ai.*` spans drain to the SAME configured destination only when the
/// user opted in. Defaults to `false` until seeded (§6 opt-in posture).
pub fn is_export_consented() -> bool {
    EXPORT_CONSENT.load(Ordering::Relaxed)
}

/// The seeded OTLP endpoint, exposed so `gateway_spawn_env()` can forward it under
/// the OTel-standard `OTEL_EXPORTER_OTLP_ENDPOINT` name. `None` = no destination.
pub fn otlp_endpoint() -> Option<String> {
    OTLP_ENDPOINT.get().cloned().flatten()
}

/// Resolve the OTLP request-headers env value to forward to the gateway child.
///
/// Resolution (nothing hardcoded): an explicit `OTEL_EXPORTER_OTLP_HEADERS` always
/// wins (the vendor-neutral primitive, works for Axiom/Grafana/any OTLP sink). If
/// it is unset but a PostHog key is configured (`RYU_POSTHOG_KEY`), derive the
/// standard bearer-auth headers string PostHog expects. Returns `None` when neither
/// is set (an endpoint that needs no auth, e.g. a local Collector, still works).
pub fn otlp_headers_env() -> Option<String> {
    if let Ok(raw) = std::env::var(OTLP_HEADERS_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(key) = std::env::var(POSTHOG_KEY_ENV) {
        let key = key.trim();
        if !key.is_empty() {
            // OTLP headers are a comma-joined `k=v` list; PostHog ingests with the
            // project key as a bearer token.
            return Some(format!("Authorization=Bearer {key}"));
        }
    }
    None
}

/// Pure gate decision: does the resolved config call for an OTLP exporter?
///
/// Export happens only when the user opted in **and** a non-empty destination is
/// configured. Extracted as a pure fn (mirrors `privacy::SupportAccessLocal::is_active`)
/// so the "pref off / no endpoint → layer absent" rule is unit-testable without
/// touching the process-global subscriber.
pub fn should_export(enabled: bool, endpoint: &str) -> bool {
    enabled && !endpoint.trim().is_empty()
}

/// Resolve the export config from prefs (+ env mirrors) and, when consented,
/// build the OTLP exporter + tracer provider and return a ready
/// `tracing-opentelemetry` layer to add to the subscriber.
///
/// Returns `None` (a no-op layer) whenever export is off or no endpoint is set,
/// or if the exporter fails to build — failing open so a misconfigured drain
/// never blocks Core startup. The returned tuple's second element is the provider
/// the caller should hold for the process lifetime (dropping it stops export);
/// `main.rs` leaks it so spans flush for the whole run.
///
/// The layer is boxed (`dyn Layer`) so `main.rs` can add an `Option<BoxedLayer>`
/// uniformly — `Option<L: Layer>` is itself a `Layer`, with `None` doing nothing.
pub async fn build_otlp_layer<S>(
    prefs: &PreferencesStore,
) -> Option<(Box<dyn Layer<S> + Send + Sync>, SdkTracerProvider)>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a> + Send + Sync,
{
    let enabled = crate::privacy::diagnostics_export_enabled(prefs).await;
    let endpoint = crate::privacy::diagnostics_otlp_endpoint(prefs).await;

    // Seed the process-globals so the SYNC `gateway_spawn_env()` forwards the SAME
    // consent + destination to the gateway sidecar (which has no `PreferencesStore`).
    // Seeded whether or not Core itself builds a layer — the gateway is a separate
    // process with its own spans, and the user's one opt-in should drive both.
    EXPORT_CONSENT.store(enabled, Ordering::Relaxed);
    let _ = OTLP_ENDPOINT.set(if endpoint.trim().is_empty() {
        None
    } else {
        Some(endpoint.trim().to_string())
    });

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
                "telemetry: OTLP exporter build failed; export disabled (local sink unaffected)"
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

    // Only export INFO+ spans so the drain stays a wide-event stream, not a
    // debug firehose; the local fmt/SQLite sinks keep their own verbosity.
    let layer = tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_filter(LevelFilter::from_level(Level::INFO))
        .boxed();

    Some((layer, provider))
}

#[cfg(test)]
mod tests {
    use super::should_export;

    #[test]
    fn export_requires_consent_and_endpoint() {
        // The opt-in default posture: off + empty → no export.
        assert!(!should_export(false, ""));
        // Endpoint set but consent withheld → still no export (pref off wins).
        assert!(!should_export(false, "https://otlp.example"));
        // Consented but no destination → nothing to export to.
        assert!(!should_export(true, ""));
        assert!(!should_export(true, "   "));
        // Both present → export.
        assert!(should_export(true, "https://otlp.example"));
    }
}
