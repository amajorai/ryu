use super::*;

/// The rate subject tells clients apart without carrying their address: one
/// subject per IPv4 address or IPv6 /64, scoped to the plugin, keyed on the
/// verified user when there is one, and `unknown` when Core cannot tell.
#[test]
fn rate_subject_distinguishes_clients_and_never_carries_the_address() {
    use std::net::IpAddr;
    let ip = |raw: &str| Some(raw.parse::<IpAddr>().unwrap());
    let app = "@ryu/feedback-board";
    let a = rate_subject_for(app, None, ip("203.0.113.7"));
    assert!(
        a.starts_with("peer:") && a.len() == "peer:".len() + 24,
        "{a}"
    );
    assert!(!a.contains("203.0.113.7"));
    assert_eq!(a, rate_subject_for(app, None, ip("203.0.113.7")));
    assert_ne!(a, rate_subject_for(app, None, ip("203.0.113.8")));
    assert_ne!(a, rate_subject_for("@ryu/other", None, ip("203.0.113.7")));
    // An IPv4-mapped IPv6 peer is the same client as its IPv4 form.
    assert_eq!(a, rate_subject_for(app, None, ip("::ffff:203.0.113.7")));
    // One /64 is one client: rotating the interface id does not mint subjects.
    assert_eq!(
        rate_subject_for(app, None, ip("2001:db8:1:2::1")),
        rate_subject_for(app, None, ip("2001:db8:1:2:ffff::9"))
    );
    assert_ne!(
        rate_subject_for(app, None, ip("2001:db8:1:2::1")),
        rate_subject_for(app, None, ip("2001:db8:1:3::1"))
    );
    assert_eq!(rate_subject_for(app, None, None), "unknown");
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: "member-a".to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    let user = rate_subject_for(app, Some(&caller), ip("203.0.113.7"));
    assert!(user.starts_with("user:"), "{user}");
    assert_eq!(
        user,
        rate_subject_for(app, Some(&caller), ip("198.51.100.1"))
    );
}

/// The subject Core stamps for an anonymous request, exactly as the forward
/// path computes it (`rate_subject_for(.., request_client_ip(&req))`), for a
/// request whose socket peer is `peer` and which carries `forwarded_for`.
fn anonymous_subject_for_peer(peer: &str, forwarded_for: Option<&str>) -> String {
    let peer: std::net::SocketAddr = peer.parse().unwrap();
    let mut builder = Request::builder().uri("/api/ext/@ryu/feedback-board/x");
    if let Some(forwarded_for) = forwarded_for {
        builder = builder.header("x-forwarded-for", forwarded_for);
    }
    let mut req = builder.body(Body::empty()).unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(peer));
    rate_subject_for("@ryu/feedback-board", None, request_client_ip(&req))
}

/// The round-2 gap: a reverse proxy on the same host (nginx, Caddy, a
/// user-run cloudflared) or the LAN that Core was not told to trust is the
/// socket peer of EVERY visitor. Keying a per-client bucket on it let one
/// visitor spend the 5/hour bound for the whole board. Such a peer is not a
/// distinct client, so its subject is `unknown` (the node-wide backstop), and
/// a forged `X-Forwarded-For` through it still cannot pick a subject.
#[test]
fn a_local_or_private_peer_is_not_a_per_client_subject() {
    // Loopback with no forwarding tunnel: a same-host reverse proxy.
    assert!(!crate::sidecar::forwarding_tunnel_active());
    assert!(crate::vault::tokens::trusted_proxies().is_empty());
    for peer in [
        "127.0.0.1:50000",
        "[::1]:50000",
        "[::ffff:127.0.0.1]:50000",
        // RFC 1918, carrier-grade NAT, link-local, IPv6 ULA and link-local.
        "10.0.0.5:443",
        "172.16.4.2:443",
        "192.168.1.20:443",
        "100.64.1.1:443",
        "169.254.10.10:443",
        "[::ffff:10.0.0.5]:443",
        "[fd12:3456:789a::1]:443",
        "[fe80::1]:443",
    ] {
        assert_eq!(anonymous_subject_for_peer(peer, None), "unknown", "{peer}");
        // A visitor behind that proxy cannot pick a subject by forging the
        // header: the peer is not a trusted proxy, so it is ignored.
        assert_eq!(
            anonymous_subject_for_peer(peer, Some("203.0.113.9")),
            "unknown",
            "{peer}"
        );
    }
    // Visitors behind one untrusted local proxy therefore never share a
    // small per-client bucket keyed on the proxy's address.
    assert_eq!(
        anonymous_subject_for_peer("127.0.0.1:1", None),
        anonymous_subject_for_peer("127.0.0.1:2", None)
    );

    // A public peer is still its own client, and a forged header from it is
    // ignored rather than letting it rotate subjects.
    let public = anonymous_subject_for_peer("198.51.100.20:443", None);
    assert!(public.starts_with("peer:"), "{public}");
    assert_eq!(
        public,
        anonymous_subject_for_peer("198.51.100.20:443", Some("203.0.113.9"))
    );
    assert!(anonymous_subject_for_peer("[2001:db8:5::1]:443", None).starts_with("peer:"));
    // Behind a proxy Core does trust, the forwarded client address is the
    // subject: a public client is per-client, a private one is `unknown`.
    let trusted = [crate::vault::tokens::Cidr::parse("127.0.0.1/32").unwrap()];
    let via_trusted = |forwarded: &str| {
        rate_subject_for(
            "@ryu/feedback-board",
            None,
            crate::vault::tokens::resolve_client_ip(
                Some("127.0.0.1".parse().unwrap()),
                Some(forwarded),
                &trusted,
                false,
            ),
        )
    };
    assert!(via_trusted("203.0.113.9").starts_with("peer:"));
    assert_ne!(via_trusted("203.0.113.9"), via_trusted("203.0.113.10"));
    assert_eq!(via_trusted("10.1.2.3"), "unknown");
    // Boundary addresses just outside the local/shared ranges stay public.
    for peer in [
        "172.32.0.1:443",
        "100.128.0.1:443",
        "11.0.0.1:443",
        "[fe00::1]:443",
    ] {
        assert!(
            anonymous_subject_for_peer(peer, None).starts_with("peer:"),
            "{peer}"
        );
    }
}

/// With the forwarding tunnel active, a loopback peer is a remote client of
/// unknown address: also `unknown`.
#[tokio::test]
async fn a_loopback_peer_behind_the_tunnel_is_unknown() {
    let subject = crate::sidecar::FORCE_FORWARDING_FOR_TEST
        .scope(true, async {
            anonymous_subject_for_peer("127.0.0.1:50000", None)
        })
        .await;
    assert_eq!(subject, "unknown");
}

/// Only Core's rate subject crosses the hop: a forged copy is replaced when
/// the sidecar opted in and stripped when it did not.
#[tokio::test]
async fn forward_stamps_cores_rate_subject_over_a_forged_copy() {
    use axum::routing::get;
    use axum::Router;
    use std::sync::Arc;

    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
    let captured = seen.clone();
    let app = Router::new().route(
        "/who",
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                captured.lock().await.push(
                    headers
                        .get(HDR_CALLER_RATE_SUBJECT)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                "ok"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut forged = HeaderMap::new();
    forged.insert(HDR_CALLER_RATE_SUBJECT, "peer:forged".parse().unwrap());
    for subject in [Some("peer:0123456789abcdef01234567"), None] {
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/who",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &forged,
            body: Vec::new(),
            hop_plugin_id: "com.test.rate-subject",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: subject,
            caller_agent_id: None,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: false,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(
        *seen.lock().await,
        vec![Some("peer:0123456789abcdef01234567".to_owned()), None]
    );
    server.abort();
}

/// The rate subject is an explicit per-app opt-in, declared only by the public
/// feedback board to bound anonymous vote identities per client.
#[test]
fn only_the_feedback_board_opts_into_the_rate_subject() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let opted_in: Vec<&str> = manifests
        .iter()
        .filter(|manifest| {
            manifest
                .sidecars
                .iter()
                .filter_map(|sidecar| sidecar.http.as_ref())
                .any(|http| http.forward_caller_rate_subject)
        })
        .map(|manifest| manifest.id.as_str())
        .collect();
    assert_eq!(opted_in, vec!["@ryu/feedback-board"]);
}
