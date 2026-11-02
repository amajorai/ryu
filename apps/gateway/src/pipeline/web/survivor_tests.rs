//! Fail-closed web Sanitize: a query or result field whose PII or secret only
//! the normalized scan sees is redacted after a fold, or refused, and never
//! sent to the search vendor or returned to the caller verbatim.

use std::sync::atomic::Ordering;

use super::inspect::inspect_output;
use super::tests::{context, state};
use super::*;
use crate::config::FirewallPolicy;

const ZWSP_EMAIL: &str = "alice@exa\u{200B}mple.com";
const FULLWIDTH_EMAIL: &str = "alice\u{FF20}example.com";
/// An SSN with a TAG `Z` inside, which the in-place fold cannot remove.
const TAG_SSN: &str = "123-45\u{E005A}-6789";

fn leaks(text: &str) -> bool {
    ["alice", "mple.com", "IOSFODNN7EXAMPLE", "6789"]
        .iter()
        .any(|needle| text.contains(needle))
}

fn sanitizing_state() -> (Arc<AppState>, Arc<std::sync::atomic::AtomicUsize>) {
    let (state, primary, _) = state("http://127.0.0.1:1".into(), 6, false, false);
    let mut firewall = state.config.firewall.clone();
    firewall.enabled = true;
    firewall.policy = FirewallPolicy::Sanitize;
    state.update_firewall_config(firewall);
    (state, primary)
}

fn search(query: &str) -> WebRequest {
    WebRequest::Search(WebSearchRequest::new(query.into(), 1).unwrap())
}

fn query(request: &WebRequest) -> &str {
    match request {
        WebRequest::Search(request) => request.query(),
        WebRequest::Fetch(_) => unreachable!("search request"),
    }
}

#[test]
fn sanitized_query_folds_and_redacts_invisible_pii() {
    let (state, _) = sanitizing_state();
    let ctx = context(&state);
    for hidden in [ZWSP_EMAIL, FULLWIDTH_EMAIL] {
        let mut request = search(&format!("mail {hidden}"));
        request.inspect(&state, &ctx).expect("redactable query");
        assert!(
            !leaks(query(&request)),
            "{hidden:?} egressed: {}",
            query(&request)
        );
    }
}

#[tokio::test]
async fn query_whose_match_survives_redaction_is_blocked_before_vendor_io() {
    let (state, primary) = sanitizing_state();
    let result = run(
        Arc::clone(&state),
        context(&state),
        search(&format!("ssn {TAG_SSN}")),
        None,
    )
    .await;
    assert!(matches!(result, Err(GatewayError::FirewallBlocked(..))));
    assert_eq!(primary.load(Ordering::SeqCst), 0);
}

#[test]
fn sanitized_result_fields_fold_or_refuse() {
    let (state, _) = sanitizing_state();
    let ctx = context(&state);
    let mut output = serde_json::json!({"results": [{
        "title": format!("about {FULLWIDTH_EMAIL}"),
        "snippet": "key AKIA\u{200B}IOSFODNN7EXAMPLE",
        "url": "https://news.test/a"
    }]});
    inspect_output(&state, &ctx, &mut output).expect("redactable fields");
    assert!(!leaks(&output.to_string()), "{output}");

    let mut output = serde_json::json!({"results": [{
        "snippet": format!("ssn {TAG_SSN}"),
        "url": "https://news.test/a"
    }]});
    assert!(matches!(
        inspect_output(&state, &ctx, &mut output),
        Err(GatewayError::FirewallBlocked(..))
    ));
}

#[test]
fn companion_query_with_invisible_pii_is_redacted_with_the_firewall_off() {
    let (state, _, _) = state("http://127.0.0.1:1".into(), 6, false, false);
    assert!(!state.config.firewall.enabled);
    let mut ctx = context(&state);
    ctx.companion_source = true;
    let mut request = search(&format!("mail {ZWSP_EMAIL}"));
    request.inspect(&state, &ctx).expect("companion query");
    assert!(!leaks(query(&request)), "egressed: {}", query(&request));
}
