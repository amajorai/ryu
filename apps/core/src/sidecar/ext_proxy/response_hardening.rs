//! Response-side browser hardening for the ext-proxy.
//!
//! Every app's proxied responses share Core's browser origin. [`super::response_cookies`]
//! stops an app's `Set-Cookie` from touching another app's cookies, but an app that
//! serves an HTML (or XML/SVG) document on that origin could otherwise run script there:
//! write any cookie with `document.cookie`, make credentialed same-origin requests to
//! other apps' routes, or register an origin-wide service worker.
//!
//! This module closes that gap at the last point Core controls the response:
//!
//! - `Service-Worker-Allowed` never crosses the proxy, so no app can widen a service
//!   worker's scope beyond its own `/api/ext/<id>/` path.
//! - `X-Content-Type-Options: nosniff` is always set, so a response is never sniffed
//!   into an active document type the app did not declare.
//! - A document-capable response (HTML, XML, SVG, or no declared type) from an app that
//!   is not an exact compiled first-party manifest gets an added
//!   `Content-Security-Policy: sandbox ...` policy without `allow-same-origin`. Its
//!   script then runs in an opaque origin. The app's own CSP is kept; browsers enforce
//!   every policy, so the app can tighten but never loosen this one.

use axum::http::{header, HeaderMap, HeaderValue};

/// The CSP added to third-party documents. Deliberately omits `allow-same-origin`.
pub(super) const THIRD_PARTY_DOCUMENT_CSP: &str = "sandbox allow-scripts allow-forms allow-popups";

/// Response headers that never cross the proxy, whatever the hop.
const STRIPPED_RESPONSE_HEADERS: &[&str] = &["service-worker-allowed"];

/// Whether an upstream response header is dropped before it reaches the browser.
pub(super) fn is_stripped_response_header(name: &str) -> bool {
    STRIPPED_RESPONSE_HEADERS
        .iter()
        .any(|stripped| name.eq_ignore_ascii_case(stripped))
}

/// Whether a response with these headers could render as an active document.
/// A missing or unparseable `Content-Type` counts, so the check fails closed.
fn is_document_capable(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(header::CONTENT_TYPE) else {
        return true;
    };
    let Ok(raw) = value.to_str() else {
        return true;
    };
    let essence = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence.is_empty()
        || essence == "text/html"
        || essence == "text/xml"
        || essence == "text/xsl"
        || essence == "application/xml"
        || essence.ends_with("+xml")
}

/// Add Core's browser-hardening headers to a proxied response's headers.
///
/// `trusted_first_party` is true only for an exact compiled first-party manifest
/// (`is_exact_compiled_manifest`), whose documents keep the shared origin.
pub(super) fn harden_response_headers(headers: &mut HeaderMap, trusted_first_party: bool) {
    for stripped in STRIPPED_RESPONSE_HEADERS {
        headers.remove(*stripped);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if !trusted_first_party && is_document_capable(headers) {
        headers.append(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(THIRD_PARTY_DOCUMENT_CSP),
        );
    }
}
