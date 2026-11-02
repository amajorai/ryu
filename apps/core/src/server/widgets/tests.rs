//! Tests for the widget instance store, routes' validators and asset proxy.

use super::asset::{
    content_type_is_allowed, normalize_allow_host, parse_resource_domains, widget_asset_response,
};
use super::instances::{VerifiedWidgetProvenance, WidgetInstance, WidgetInstanceStore};
use super::state::{validate_widget_state, WIDGET_STATE_MAX_BYTES, WIDGET_STATE_MAX_DEPTH};
use super::tool_call::{allow_gateway_fallback, tool_forward_timeout};
use super::{err_reply, WidgetErrorCode};
use axum::http::StatusCode;
use serde_json::{json, Value};

#[test]
fn scoped_tool_forwards_allow_form_waits_without_extending_detached_calls() {
    assert_eq!(
        tool_forward_timeout("conversation"),
        std::time::Duration::from_secs(360)
    );
    assert_eq!(tool_forward_timeout(""), std::time::Duration::from_secs(30));
    assert_eq!(
        tool_forward_timeout("  "),
        std::time::Duration::from_secs(30)
    );
}

#[test]
fn normalize_accepts_public_hosts_rejects_wildcards_and_bare_labels() {
    assert_eq!(
        normalize_allow_host("https://cdn.example.com"),
        Some("cdn.example.com".to_owned())
    );
    assert_eq!(
        normalize_allow_host("cdn.example.com:443/x"),
        Some("cdn.example.com".to_owned())
    );
    assert_eq!(
        normalize_allow_host("CDN.Example.COM"),
        Some("cdn.example.com".to_owned())
    );
    // Wildcards, single-label hosts, and empties are rejected (fail-closed).
    assert_eq!(normalize_allow_host("*.example.com"), None);
    assert_eq!(normalize_allow_host("localhost"), None);
    assert_eq!(normalize_allow_host("com"), None);
    assert_eq!(normalize_allow_host("   "), None);
}

#[test]
fn shared_egress_guard_blocks_private_loopback_linklocal_and_metadata() {
    // Metadata + private + loopback + link-local IPv4.
    for value in [
        "169.254.169.254",
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "172.16.0.1",
        "0.0.0.0",
    ] {
        assert!(
            ryu_egress::is_blocked_ip(value.parse().expect("valid IP")),
            "{value}"
        );
    }
    // IPv6 loopback + ULA + link-local + IPv4-mapped private.
    for value in ["::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"] {
        assert!(
            ryu_egress::is_blocked_ip(value.parse().expect("valid IP")),
            "{value}"
        );
    }
    // Internal names.
    for value in ["localhost", "db.internal", "printer.local"] {
        assert!(ryu_egress::is_blocked_hostname(value), "{value}");
    }
    // A real public host is NOT blocked.
    assert!(!ryu_egress::is_blocked_hostname("cdn.example.com"));
    assert!(!ryu_egress::is_blocked_ip(
        "8.8.8.8".parse().expect("valid IP")
    ));
}

#[test]
fn content_type_allows_media_rejects_html_and_js() {
    assert!(content_type_is_allowed("image/png"));
    assert!(content_type_is_allowed("image/svg+xml; charset=utf-8"));
    assert!(content_type_is_allowed("font/woff2"));
    assert!(content_type_is_allowed("audio/mpeg"));
    assert!(content_type_is_allowed("video/mp4"));
    assert!(content_type_is_allowed("application/octet-stream"));
    assert!(!content_type_is_allowed("text/html"));
    assert!(!content_type_is_allowed("application/javascript"));
    assert!(!content_type_is_allowed("text/javascript; charset=utf-8"));
}

#[test]
fn parse_resource_domains_reads_every_spelling() {
    // Top-level snake + camel.
    let m = json!({ "resource_domains": ["https://a.example.com"], "resourceDomains": ["b.example.com"] });
    let hosts = parse_resource_domains(&m);
    assert!(hosts.contains(&"a.example.com".to_owned()));
    assert!(hosts.contains(&"b.example.com".to_owned()));

    // Nested openai/ryu widgetCSP + ui.csp.
    let m2 = json!({
        "openai/widgetCSP": { "resource_domains": ["c.example.com"] },
        "ryu/widgetCSP": { "resourceDomains": ["d.example.com"] },
        "ui": { "csp": { "resource_domains": ["e.example.com"] } },
    });
    let hosts2 = parse_resource_domains(&m2);
    for h in ["c.example.com", "d.example.com", "e.example.com"] {
        assert!(hosts2.contains(&h.to_owned()), "missing {h}");
    }

    // Wildcards dropped; no domains → empty (deny-all).
    let m3 = json!({ "resource_domains": ["*.evil.com"] });
    assert!(parse_resource_domains(&m3).is_empty());
    assert!(parse_resource_domains(&json!({})).is_empty());
}

/// Serializes the `RYU_ALLOW_GATEWAY_FALLBACK` env mutation.
static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The per-session concurrency cap is enforced at mint: over cap → `None` (no
/// widget part emitted, D4). A different session is unaffected by another's cap.
#[test]
fn mint_enforces_per_session_cap() {
    let store = WidgetInstanceStore::new(2);
    let a1 = store.mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false);
    let a2 = store.mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false);
    assert!(a1.is_some() && a2.is_some(), "first two in a session mint");
    // Third for the SAME session is over cap → None.
    assert!(
        store
            .mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false)
            .is_none(),
        "over-cap mint must return None"
    );
    // A different session has its own budget.
    assert!(
        store
            .mint("sess-b".into(), "ag".into(), "srv".into(), vec![], false)
            .is_some(),
        "the cap is per-session, not global"
    );
}

/// Minted instances get unguessable, unique ids and resolve by id; an unknown id
/// fails closed (the capability the public asset proxy authenticates against).
#[test]
fn mint_ids_are_unique_and_resolvable() {
    let store = WidgetInstanceStore::new(8);
    let i1 = store
        .mint(
            "s".into(),
            "ag".into(),
            "srv".into(),
            vec!["tool.x".into()],
            false,
        )
        .unwrap();
    let i2 = store
        .mint("s".into(), "ag".into(), "srv".into(), vec![], false)
        .unwrap();
    assert_ne!(i1.instance_id, i2.instance_id, "ids must be unique");
    assert!(i1.instance_id.starts_with("wgt_"));
    // Resolvable by id, carrying the server-resolved provenance.
    let got = store.get(&i1.instance_id).expect("live instance resolves");
    assert_eq!(got.origin_server, "srv");
    assert_eq!(got.widget_accessible_tool_ids, vec!["tool.x".to_owned()]);
    // Unknown id → None (fail-closed).
    assert!(store.get("wgt_does_not_exist").is_none());
}

/// `set_state` persists a server-authoritative snapshot for a live instance and is
/// a silent no-op for an unknown id (never mints a phantom row).
#[test]
fn set_state_persists_for_live_and_noops_for_unknown() {
    let store = WidgetInstanceStore::new(8);
    let inst = store
        .mint("s".into(), "ag".into(), "srv".into(), vec![], false)
        .unwrap();
    assert!(store.get(&inst.instance_id).unwrap().widget_state.is_none());
    store.set_state(&inst.instance_id, json!({ "count": 5 }));
    assert_eq!(
        store.get(&inst.instance_id).unwrap().widget_state,
        Some(json!({ "count": 5 }))
    );
    // No-op for an unknown id — must not create a resolvable instance.
    store.set_state("wgt_ghost", json!({ "x": 1 }));
    assert!(store.get("wgt_ghost").is_none());
}

#[test]
fn widget_state_accepts_size_and_depth_boundaries() {
    let state = Value::String("x".repeat(WIDGET_STATE_MAX_BYTES - 2));
    assert!(validate_widget_state(&state).is_ok());

    let mut nested = json!(null);
    for _ in 0..WIDGET_STATE_MAX_DEPTH {
        nested = json!([nested]);
    }
    assert!(validate_widget_state(&nested).is_ok());
}

#[test]
fn widget_state_rejects_oversized_or_deep_state_with_stable_messages() {
    let oversized = Value::String("x".repeat(WIDGET_STATE_MAX_BYTES - 1));
    assert_eq!(
        validate_widget_state(&oversized),
        Err("widget state exceeds the maximum serialized size")
    );

    let mut too_deep = json!(null);
    for _ in 0..=WIDGET_STATE_MAX_DEPTH {
        too_deep = json!([too_deep]);
    }
    assert_eq!(
        validate_widget_state(&too_deep),
        Err("widget state exceeds the maximum nesting depth")
    );
}

/// The D6 error envelope is `{ ok:false, error, code }` at the given status — the
/// shape every widget route returns on a denial / bad-args.
#[test]
fn err_reply_shapes_the_d6_error_envelope() {
    let resp = err_reply(StatusCode::FORBIDDEN, "denied", "nope");
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

/// The shared SSRF IP guard blocks IPv4-mapped IPv6 metadata and carrier-grade
/// NAT ranges, and passes genuine public addresses.
#[test]
fn ip_guard_blocks_mapped_and_ula_passes_public() {
    assert!(ryu_egress::is_blocked_ip(
        "::ffff:169.254.169.254".parse().unwrap()
    ));
    assert!(ryu_egress::is_blocked_ip("100.64.0.1".parse().unwrap()));
    assert!(!ryu_egress::is_blocked_ip("1.1.1.1".parse().unwrap()));
    assert!(!ryu_egress::is_blocked_ip(
        "2606:4700:4700::1111".parse().unwrap()
    ));
}

/// The gateway-fallback escape hatch is OFF unless explicitly opted in with a
/// documented truthy token — a stray value keeps the safe default.
#[test]
fn gateway_fallback_is_opt_in_only() {
    let _guard = ENV_GUARD.lock().unwrap();
    let prior = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();

    std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    assert!(!allow_gateway_fallback(), "unset → off");
    for on in ["1", "true", "yes"] {
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", on);
        assert!(allow_gateway_fallback(), "'{on}' enables fallback");
    }
    for off in ["0", "false", "", "on"] {
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", off);
        assert!(!allow_gateway_fallback(), "'{off}' keeps fallback off");
    }

    match prior {
        Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
        None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
    }
}

/// Extra `normalize_allow_host` edges: an entry with a path/port strips to the
/// bare host; a `://`-scheme entry parses its host; an IPv6-literal-ish or
/// dotless label is rejected.
#[test]
fn normalize_allow_host_strips_port_path_and_scheme() {
    assert_eq!(
        normalize_allow_host("https://cdn.example.com:8443/a/b?x=1"),
        Some("cdn.example.com".to_owned())
    );
    assert_eq!(
        normalize_allow_host("assets.example.co.uk/path"),
        Some("assets.example.co.uk".to_owned())
    );
    // Dotless single label (even non-localhost) is rejected — exact public host only.
    assert_eq!(normalize_allow_host("intranet"), None);
}

/// Content-type gate is case-insensitive and ignores parameters, and never
/// permits active types (html/js/json) that could turn the lane into a loader.
#[test]
fn content_type_gate_is_case_and_param_insensitive() {
    assert!(content_type_is_allowed("IMAGE/PNG"));
    assert!(content_type_is_allowed("Font/WOFF2 ; charset=binary"));
    assert!(content_type_is_allowed("application/vnd.ms-fontobject"));
    assert!(!content_type_is_allowed("application/json"));
    assert!(!content_type_is_allowed(""));
    assert!(!content_type_is_allowed("text/html; charset=utf-8"));
}

/// The proxy is public on Core's origin and relays scriptable `image/svg+xml`,
/// so every 200 must carry a sandboxing CSP: `sandbox` with no `allow-*` token
/// (no script, opaque origin) and `default-src 'none'` with no script/connect
/// widening. The passive-subresource headers the widget frame relies on stay
/// exactly as they were.
#[test]
fn asset_response_is_csp_sandboxed_for_every_proxied_type() {
    use axum::http::header;

    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    for content_type in [
        "image/svg+xml",
        "image/svg+xml; charset=utf-8",
        "image/png",
        "font/woff2",
        "video/mp4",
        "application/octet-stream",
    ] {
        let resp = widget_asset_response(content_type.to_owned(), svg.to_vec());
        assert_eq!(resp.status(), StatusCode::OK);
        let headers = resp.headers();
        let csp = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_else(|| panic!("{content_type}: asset response must set a CSP"));
        let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
        assert!(directives.contains(&"sandbox"), "{content_type}: {csp}");
        assert!(
            directives.contains(&"default-src 'none'"),
            "{content_type}: {csp}"
        );
        assert!(!csp.contains("allow-"), "{content_type}: {csp}");
        assert!(
            !directives
                .iter()
                .any(|d| d.starts_with("script-src") || d.starts_with("connect-src")),
            "{content_type}: {csp}"
        );

        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), content_type);
        assert_eq!(
            headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "*"
        );
        assert_eq!(
            headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=3600"
        );
    }
}

fn mint(store: &WidgetInstanceStore, may_send_follow_up: bool) -> WidgetInstance {
    store
        .mint(
            "conv1".to_owned(),
            "agent1".to_owned(),
            "srv".to_owned(),
            vec![],
            may_send_follow_up,
        )
        .expect("under the per-session cap")
}

/// The follow-up permission must survive the round-trip from emit to the
/// governed route, because that route is where it is enforced. If the flag
/// were dropped on the way into the store, `widget_follow_up` would read
/// `false` for every widget and silently refuse all of them — or, had the
/// default gone the other way, allow all of them.
#[test]
fn follow_up_permission_round_trips_through_the_instance_store() {
    let store = WidgetInstanceStore::new(4);

    let allowed = mint(&store, true);
    assert!(allowed.may_send_follow_up);
    assert!(
        store
            .get(&allowed.instance_id)
            .expect("just minted")
            .may_send_follow_up,
        "a widget granted `ui:send_message` must still be permitted when the \
         governed route re-reads its instance"
    );

    let refused = mint(&store, false);
    assert!(!refused.may_send_follow_up);
    assert!(
        !store
            .get(&refused.instance_id)
            .expect("just minted")
            .may_send_follow_up,
        "a widget that was never granted `ui:send_message` must not become \
         permitted by passing through the store"
    );
}

#[test]
fn follow_up_ticket_is_bound_to_prompt_and_conversation_and_is_one_shot() {
    let store = WidgetInstanceStore::new(4);
    let record = mint(&store, true);
    let ticket = store
        .issue_follow_up_ticket(&record, "Use the selected row")
        .expect("ticket is minted");

    assert_eq!(
        store.consume_follow_up_ticket(&ticket, "other-conversation", "Use the selected row"),
        Err("widget follow-up ticket does not match this chat turn")
    );
    assert_eq!(
        store.consume_follow_up_ticket(&ticket, "conv1", "Use another prompt"),
        Err("widget follow-up ticket does not match this chat turn")
    );

    let provenance = store
        .consume_follow_up_ticket(&ticket, "conv1", "Use the selected row")
        .expect("matching ticket is accepted");
    assert_eq!(provenance.source, "widget");
    assert_eq!(provenance.widget_instance_id, record.instance_id);
    assert_eq!(provenance.origin_server, "srv");

    assert_eq!(
        store.consume_follow_up_ticket(&ticket, "conv1", "Use the selected row"),
        Err("unknown, expired, or already-used widget follow-up ticket")
    );
}

#[test]
fn follow_up_ticket_peek_survives_rejected_pre_stream_request() {
    let store = WidgetInstanceStore::new(4);
    let record = mint(&store, true);
    let ticket = store
        .issue_follow_up_ticket(&record, "Use the selected row")
        .expect("ticket is minted");

    assert_eq!(
        store.validate_follow_up_ticket(&ticket, "conv1", "Use the selected row"),
        Ok(VerifiedWidgetProvenance {
            source: "widget",
            widget_instance_id: record.instance_id.clone(),
            origin_server: "srv".to_owned(),
            conversation_id: "conv1".to_owned(),
        })
    );
    assert!(store
        .validate_follow_up_ticket(&ticket, "other-conversation", "Use the selected row")
        .is_err());

    store
        .consume_follow_up_ticket(&ticket, "conv1", "Use the selected row")
        .expect("a ticket remains usable after pre-stream rejection");
}

#[test]
fn widget_error_codes_are_closed_and_wire_stable() {
    assert_eq!(
        serde_json::to_value(WidgetErrorCode::OverBudget).unwrap(),
        serde_json::json!("over_budget")
    );
    assert!(matches!(
        WidgetErrorCode::from_wire("unexpected"),
        WidgetErrorCode::ServerError
    ));
}
