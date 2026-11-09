//! Browser hardening of proxied responses on the shared Core origin.

use super::*;
use crate::sidecar::ext_proxy::response_hardening::{
    harden_response_headers, THIRD_PARTY_DOCUMENT_CSP,
};

/// Serve one stub route that answers with the given headers and body.
async fn stub_sidecar(headers: Vec<(&'static str, &'static str)>) -> u16 {
    use axum::response::IntoResponse;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().route(
        "/p",
        get(move || {
            let headers = headers.clone();
            async move {
                let mut out = HeaderMap::new();
                for (name, value) in headers {
                    out.append(name, value.parse().unwrap());
                }
                (out, "<script>document.cookie='x=1'</script>").into_response()
            }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

async fn forward(port: u16, plugin: &str, trusted_first_party: bool) -> Response {
    let src_headers = HeaderMap::new();
    forward_to_sidecar(ForwardArgs {
        target: ForwardTarget::for_test(port),
        upstream_path: "/p",
        query: "",
        method: reqwest::Method::GET,
        src_headers: &src_headers,
        body: Vec::new(),
        hop_plugin_id: plugin,
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_egress_allowlist: None,
        caller_agent_restricted: false,
        event_delivery: None,
        trusted_first_party,
    })
    .await
}

fn all(response: &Response, name: &str) -> Vec<String> {
    response
        .headers()
        .get_all(name)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect()
}

/// Regression: a third-party app's public HTML page must not run script with Core's
/// origin (cookie fixation, credentialed same-origin reads, origin-wide service worker).
#[tokio::test]
async fn third_party_html_is_sandboxed_and_cannot_widen_service_worker_scope() {
    let port = stub_sidecar(vec![
        ("content-type", "text/html; charset=utf-8"),
        ("service-worker-allowed", "/"),
        ("set-cookie", "ryu_rooms_session=x; Path=/api/rooms/guest"),
        ("content-security-policy", "default-src *"),
    ])
    .await;
    let response = forward(port, "@acme/x", false).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("service-worker-allowed").is_none());
    assert!(response.headers().get("set-cookie").is_none());
    assert_eq!(all(&response, "x-content-type-options"), vec!["nosniff"]);
    let policies = all(&response, "content-security-policy");
    assert!(policies.contains(&THIRD_PARTY_DOCUMENT_CSP.to_owned()));
    assert!(policies.iter().any(|policy| policy.contains("sandbox")));
    assert!(policies
        .iter()
        .all(|policy| !policy.contains("allow-same-origin")));
}

#[tokio::test]
async fn first_party_documents_keep_their_own_csp_but_are_still_nosniff() {
    let port = stub_sidecar(vec![
        ("content-type", "text/html"),
        ("content-security-policy", "default-src 'self'"),
        ("service-worker-allowed", "/"),
    ])
    .await;
    let response = forward(port, "@ryu/forms", true).await;

    assert_eq!(
        all(&response, "content-security-policy"),
        vec!["default-src 'self'"]
    );
    assert_eq!(all(&response, "x-content-type-options"), vec!["nosniff"]);
    assert!(response.headers().get("service-worker-allowed").is_none());
}

#[test]
fn only_document_capable_third_party_responses_get_the_sandbox() {
    let sandboxed = |content_type: Option<&str>, trusted: bool| {
        let mut headers = HeaderMap::new();
        if let Some(value) = content_type {
            headers.insert("content-type", value.parse().unwrap());
        }
        harden_response_headers(&mut headers, trusted);
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
        headers.contains_key("content-security-policy")
    };
    for active in [
        Some("text/html"),
        Some("TEXT/HTML; charset=utf-8"),
        Some("image/svg+xml"),
        Some("application/xhtml+xml"),
        Some("application/xml"),
        Some("text/xml"),
        Some("multipart/x-mixed-replace; boundary=b"),
        Some("Multipart/Mixed; boundary=x"),
        Some(""),
        Some("text/plain, text/html"),
        Some("application/json,text/html"),
        Some("text/plain,"),
        Some("text/plain, image/png"),
        Some("nonsense"),
        None,
    ] {
        assert!(sandboxed(active, false), "{active:?} must be sandboxed");
        assert!(
            !sandboxed(active, true),
            "{active:?} first-party keeps origin"
        );
    }
    for inert in [
        "application/json",
        "text/event-stream",
        "image/png",
        "text/plain",
    ] {
        assert!(!sandboxed(Some(inert), false), "{inert} is not a document");
    }
}

/// Regression: duplicate `Content-Type` headers are combined by the browser, which then
/// renders the last valid type, so a leading inert value must not skip the sandbox.
#[test]
fn duplicate_content_type_headers_are_sandboxed_for_third_parties() {
    let mut headers = HeaderMap::new();
    headers.append("content-type", "application/json".parse().unwrap());
    headers.append("content-type", "text/html".parse().unwrap());
    harden_response_headers(&mut headers, false);
    let policies: Vec<_> = headers.get_all("content-security-policy").iter().collect();
    assert_eq!(policies, vec![THIRD_PARTY_DOCUMENT_CSP]);
}

#[tokio::test]
async fn forwarded_multi_valued_content_type_is_sandboxed() {
    let port = stub_sidecar(vec![
        ("content-type", "application/json"),
        ("content-type", "text/html"),
    ])
    .await;
    let response = forward(port, "@acme/x", false).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        all(&response, "content-security-policy").contains(&THIRD_PARTY_DOCUMENT_CSP.to_owned())
    );
}
