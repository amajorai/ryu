//! W3C trace-context propagation helpers.
//!
//! `telemetry::build_otlp_layer` installs the global `TraceContextPropagator`, so
//! these helpers read/write `traceparent`/`tracestate`. They work on the active
//! `tracing` span through `tracing-opentelemetry`: with no OTLP layer installed,
//! or with export consent off (the consent filter keeps spans from the OTel
//! layer), the span has no valid OTel context and NOTHING is injected — a trace
//! id never leaves the machine without consent.
//!
//! Mirror of `apps/core/src/telemetry/propagation.rs` (the crates share no code).

// Consumed by outbound HTTP/MCP call sites as they adopt propagation.
#![allow(dead_code)]

use http::{HeaderMap, HeaderName, HeaderValue};
use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::Context;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

/// The W3C `traceparent` header / MCP `_meta` key.
pub const TRACEPARENT: &str = "traceparent";
/// The W3C `tracestate` header / MCP `_meta` key.
pub const TRACESTATE: &str = "tracestate";

struct HeaderInjector<'a>(&'a mut HeaderMap);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            self.0.insert(name, value);
        }
    }
}

struct HeaderExtractor<'a>(&'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

struct MapInjector<'a>(&'a mut Vec<(String, String)>);

impl Injector for MapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.push((key.to_owned(), value));
    }
}

/// Inject `cx` into `headers` (no-op for an invalid/empty context).
pub fn inject_context(cx: &Context, headers: &mut HeaderMap) {
    if !cx.span().span_context().is_valid() {
        return;
    }
    opentelemetry::global::get_text_map_propagator(|propagator| {
        propagator.inject_context(cx, &mut HeaderInjector(headers));
    });
}

/// Inject the current `tracing` span's context into outbound request headers.
/// `reqwest::header::HeaderMap` is the same `http::HeaderMap`, so this serves
/// reqwest builders (`.headers(map)`) and axum/hyper requests alike.
pub fn inject_current(headers: &mut HeaderMap) {
    inject_context(&tracing::Span::current().context(), headers);
}

/// Extract a parent context from inbound request headers (empty when absent or
/// malformed).
pub fn extract_context(headers: &HeaderMap) -> Context {
    opentelemetry::global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(headers))
    })
}

/// Parent `span` under the caller's inbound `traceparent`, if any. A request
/// without a valid `traceparent` leaves the span as a local root.
pub fn set_parent_from_headers(span: &tracing::Span, headers: &HeaderMap) {
    let parent = extract_context(headers);
    if parent.span().span_context().is_valid() {
        let _ = span.set_parent(parent);
    }
}

/// The current span's W3C trace-context fields as `(key, value)` pairs — for
/// MCP requests, put each into `params._meta` (`traceparent`, and `tracestate`
/// when present). Empty when there is no exportable span context.
pub fn current_trace_context_fields() -> Vec<(String, String)> {
    let cx = tracing::Span::current().context();
    let mut fields = Vec::new();
    if cx.span().span_context().is_valid() {
        opentelemetry::global::get_text_map_propagator(|propagator| {
            propagator.inject_context(&cx, &mut MapInjector(&mut fields));
        });
    }
    fields
}

/// The current span's `traceparent` string (for MCP `params._meta.traceparent`),
/// or `None` when there is no exportable span context.
pub fn current_traceparent() -> Option<String> {
    current_trace_context_fields()
        .into_iter()
        .find_map(|(key, value)| (key == TRACEPARENT).then_some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    #[test]
    fn traceparent_round_trips_through_headers() {
        opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
        let span_context = SpanContext::new(
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap(),
            SpanId::from_hex("00f067aa0ba902b7").unwrap(),
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );
        let cx = Context::new().with_remote_span_context(span_context);
        let mut headers = HeaderMap::new();
        inject_context(&cx, &mut headers);
        assert_eq!(
            headers.get(TRACEPARENT).unwrap(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        let extracted = extract_context(&headers);
        assert_eq!(
            extracted.span().span_context().trace_id(),
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap()
        );
        assert!(extracted.span().span_context().is_sampled());

        // An empty context injects nothing.
        let mut empty = HeaderMap::new();
        inject_context(&Context::new(), &mut empty);
        assert!(empty.is_empty());
        // No traceparent → invalid (local-root) context.
        assert!(!extract_context(&HeaderMap::new())
            .span()
            .span_context()
            .is_valid());
    }
}
