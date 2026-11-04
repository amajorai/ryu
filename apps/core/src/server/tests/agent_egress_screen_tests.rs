use crate::server::{
    agent_egress_guard_enabled_from, host_is_allowlisted_in, is_blocked_ip,
    screen_agent_egress_url, screen_egress_url_pinned, ScreenedEgress,
};

#[test]
fn guard_default_on_and_disable_tokens() {
    // Absent env => on (secure default).
    assert!(agent_egress_guard_enabled_from(None));
    // Explicit disable tokens (case-insensitive, trimmed) => off.
    for v in ["0", "false", "off", "no", "FALSE", "Off", " no "] {
        assert!(
            !agent_egress_guard_enabled_from(Some(v)),
            "{v:?} should disable the egress guard"
        );
    }
    // Anything else keeps it on.
    for v in ["1", "true", "on", "yes", "", "anything"] {
        assert!(
            agent_egress_guard_enabled_from(Some(v)),
            "{v:?} should keep the egress guard on"
        );
    }
}

#[test]
fn allowlist_parsing_is_case_and_whitespace_insensitive() {
    assert!(host_is_allowlisted_in(
        "169.254.169.254",
        80,
        Some("169.254.169.254")
    ));
    // Whitespace around entries is trimmed; case is ignored.
    assert!(host_is_allowlisted_in(
        "internal.example.com",
        443,
        Some(" a.com , Internal.Example.COM ,b.com")
    ));
    // Empty entries are ignored and non-members are rejected.
    let evil = |list| host_is_allowlisted_in("evil.com", 443, list);
    assert!(!evil(Some("a.com,,b.com")));
    assert!(!evil(Some("")));
    assert!(!evil(None));
}

/// A `host:port` entry grants THAT port and nothing else.
///
/// This variable is shared with `tool_exec`, where the URL being screened comes
/// from a model-supplied tool argument. So the developer who allowlists their
/// local MCP server must not thereby hand every model-chosen URL the whole
/// loopback interface — Core's own admin port included. Host-only entries stay
/// wide on purpose (they are the pre-existing format); the narrow form is the
/// one the refusal message recommends.
#[test]
fn allowlist_entry_with_a_port_does_not_grant_other_ports() {
    // One narrow entry, asked about several targets.
    let narrow = |host, port| host_is_allowlisted_in(host, port, Some("127.0.0.1:3000"));
    // The port that was named is granted…
    assert!(narrow("127.0.0.1", 3000));
    // …and every other port on the same host is NOT. 7980 is Core's own
    // surface, which is precisely what a bare-host entry would expose.
    assert!(!narrow("127.0.0.1", 7980));
    assert!(!narrow("127.0.0.1", 80));
    // A port entry does not leak to another host either.
    assert!(!narrow("10.0.0.1", 3000));

    // Backwards compatibility: a bare host still matches any port.
    let wide = |port| host_is_allowlisted_in("127.0.0.1", port, Some("127.0.0.1"));
    assert!(wide(3000));
    assert!(wide(7980));

    // Mixed lists resolve per entry, and case/whitespace still do not matter.
    let list = Some(" Internal.Example.COM:8443 , 127.0.0.1 ");
    assert!(host_is_allowlisted_in("internal.example.com", 8443, list));
    assert!(!host_is_allowlisted_in("internal.example.com", 443, list));
    assert!(host_is_allowlisted_in("127.0.0.1", 9999, list));

    // IPv6: the entry is written exactly as the host appears in the URL, so
    // the bracketed literal is what an operator copies. Both forms behave.
    let v6 = |port, list| host_is_allowlisted_in("[fc00::1]", port, Some(list));
    assert!(v6(3000, "[fc00::1]:3000"));
    assert!(!v6(3001, "[fc00::1]:3000"));
    assert!(v6(3001, "[fc00::1]"));
}

/// The port-scoped entry has to work through the REAL screen, not just the
/// parser — which means the port must be computed before the allowlist check.
/// If that ordering ever inverts, this fails while the pure test above passes.
#[tokio::test]
async fn the_screen_honours_a_port_scoped_allowlist_entry() {
    let (_, exempt) =
        screen_egress_url_pinned("http://127.0.0.1:3000/mcp", true, Some("127.0.0.1:3000"))
            .await
            .expect("the named port is the supported escape hatch");
    assert!(
        matches!(exempt, ScreenedEgress::Exempt),
        "an allowlisted host:port must report Exempt"
    );

    // The same entry must NOT unblock Core's own port on the same host.
    assert!(
        screen_egress_url_pinned(
            "http://127.0.0.1:7980/api/health",
            true,
            Some("127.0.0.1:3000")
        )
        .await
        .is_err(),
        "a port-scoped entry must not open the rest of loopback"
    );

    // The default port is what an entry must name when the URL omits one.
    assert!(
        screen_egress_url_pinned("http://127.0.0.1/mcp", true, Some("127.0.0.1:80"))
            .await
            .is_ok(),
        "an omitted port screens as the scheme default"
    );

    // IPv6, MEASURED not assumed: the entry an operator writes must match what
    // `Url::host_str` produces, and this pins which spelling that is. If the
    // bracket handling ever changes, this fails instead of the narrow form
    // silently degrading to "no entry matches".
    let (_, v6) =
        screen_egress_url_pinned("http://[fc00::1]:3000/mcp", true, Some("[fc00::1]:3000"))
            .await
            .expect("a bracketed IPv6 literal is written the same way in the allowlist");
    assert!(matches!(v6, ScreenedEgress::Exempt));
    assert!(
        screen_egress_url_pinned("http://[fc00::1]:3001/mcp", true, Some("[fc00::1]:3000"))
            .await
            .is_err(),
        "the port scoping holds for IPv6 too"
    );
}

/// A credential in the URL must never reach an error string — the `headers`
/// map is deliberately never logged, and leaking the same secret through the
/// URL instead would make that care pointless.
#[test]
fn guarded_post_error_redacts_url_credentials() {
    let dirty = "https://alice:s3cr3t@mcp.example.com/v1/mcp?api_key=AKIAsecret&x=1";
    let shown = crate::server::redact_url_for_display(dirty);
    for secret in ["s3cr3t", "AKIAsecret", "alice:", "api_key"] {
        assert!(
            !shown.contains(secret),
            "redacted form still carries {secret:?}: {shown}"
        );
    }
    // …while staying diagnostic: which server, and which path.
    assert_eq!(
        shown,
        "https://<redacted>@mcp.example.com/v1/mcp?<redacted>"
    );

    // A fragment is treated like a query (it is equally caller-authored text).
    assert_eq!(
        crate::server::redact_url_for_display("http://host/p#tok=abc"),
        "http://host/p?<redacted>"
    );
    // No credentials, no query: unchanged, so the common case reads normally.
    assert_eq!(
        crate::server::redact_url_for_display("http://127.0.0.1:3000/mcp"),
        "http://127.0.0.1:3000/mcp"
    );
    // Unparseable input is redacted too — that is exactly when the caller
    // cannot reason about what the string holds.
    assert!(!crate::server::redact_url_for_display("user:pw@ho st/x?k=v").contains("pw"));
}

/// The same, asserted on a real error message rather than on the helper: a
/// blocked endpoint whose URL carries a credential must not print it.
#[tokio::test]
async fn a_blocked_credentialed_url_is_refused_without_echoing_the_credential() {
    // Matched rather than `expect_err`: the success type carries a
    // `ScreenedEgress`, which is deliberately not `Debug` (its addresses are
    // not error text).
    let msg = match screen_egress_url_pinned(
        "http://alice:s3cr3t@169.254.169.254/mcp?api_key=AKIAsecret",
        true,
        None,
    )
    .await
    {
        Ok(_) => panic!("the metadata address must be refused"),
        Err(e) => e.to_string(),
    };
    assert!(
        !msg.contains("s3cr3t") && !msg.contains("AKIAsecret"),
        "the refusal leaked a credential: {msg}"
    );
    assert!(
        msg.contains("169.254.169.254"),
        "the refusal must still name the host it blocked: {msg}"
    );
}

#[test]
fn ip_screen_ranges_match_first_party_guard() {
    // Sanity-check the reused classifier covers the intended ranges.
    for ip in [
        "169.254.169.254",
        "10.0.0.1",
        "127.0.0.1",
        "192.168.1.1",
        "172.16.0.1",
        "fc00::1",
        "fe80::1",
    ] {
        assert!(
            is_blocked_ip(ip.parse().unwrap()),
            "{ip} must be classified as blocked"
        );
    }
    assert!(!is_blocked_ip("93.184.216.34".parse().unwrap()));
}

#[tokio::test]
async fn non_http_scheme_is_rejected() {
    assert!(screen_agent_egress_url("file:///etc/passwd").await.is_err());
    assert!(screen_agent_egress_url("ftp://example.com").await.is_err());
    assert!(screen_agent_egress_url("not a url").await.is_err());
}

#[tokio::test]
async fn metadata_and_private_ip_literals_are_blocked_by_default() {
    // Pre-installed (no env mutation): IP-literal hosts are screened directly,
    // no DNS needed.
    for url in [
        "http://169.254.169.254/",
        "http://10.0.0.1/",
        "http://127.0.0.1/",
        "https://192.168.1.1/",
        "http://[fc00::1]/",
    ] {
        assert!(
            screen_agent_egress_url(url).await.is_err(),
            "{url} must be blocked by the egress screen"
        );
    }
}

#[test]
fn pinned_fetch_does_not_delegate_destination_to_ambient_proxy() {
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let url = format!("http://{}", proxy.local_addr().unwrap());
    let mut proof = std::process::Command::new(std::env::current_exe().unwrap());
    proof.args([
        "--exact",
        "server::tests::agent_egress_screen_tests::pinned_fetch_reaches_exact_screened_address",
        "--test-threads=1",
        "--nocapture",
    ]);
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        proof.env(name, &url);
    }
    proof.env("NO_PROXY", "").env("no_proxy", "");
    let result = proof.output().expect("start actual production pin proof");
    assert!(
        result.status.success(),
        "pinned fetch failed: {} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed; 0 failed"));
    assert_eq!(
        proxy.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "a screened fetch must not connect to an ambient proxy"
    );
}

#[tokio::test]
async fn pinned_fetch_reaches_exact_screened_address() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut buffer = [0; 1024];
            let count =
                tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut buffer))
                    .await
                    .expect("request headers arrive")
                    .unwrap();
            assert!(count > 0);
            head.extend_from_slice(&buffer[..count]);
            assert!(head.len() <= 8192);
        }
        let request = String::from_utf8_lossy(&head);
        assert!(request.starts_with("GET /screened HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("host: pinned.invalid:{}\r\n", address.port())));
        let body = b"screened";
        let response_head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
        stream.write_all(response_head.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    let client = crate::server::pin_screened_http_client(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none()),
        "pinned.invalid",
        &[address],
    )
    .build()
    .unwrap();
    let response = client
        .get(format!("http://pinned.invalid:{}/screened", address.port()))
        .send()
        .await
        .expect("screened address receives request without a DNS lookup");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "screened");
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

/// The screen must hand back the addresses it validated, so an in-process
/// fetcher pins to exactly those. A caller that instead re-resolves pins to
/// addresses nobody checked; a caller that additionally swallows a failed
/// re-resolve as "must have been exempt" is fail-open, and an attacker who
/// controls DNS walks straight through it — public answer passes the screen,
/// private answer fails the pin, request proceeds unpinned.
#[tokio::test]
async fn a_screened_host_yields_the_addresses_to_pin_to() {
    // IP literal: screened directly, no DNS needed, and public so it passes.
    let (url, screened) = screen_egress_url_pinned("http://93.184.216.34:8080/mcp", true, None)
        .await
        .expect("a public IP literal must pass the screen");
    assert_eq!(url.host_str(), Some("93.184.216.34"));
    match screened {
        ScreenedEgress::Pinned(addrs) => {
            assert!(!addrs.is_empty(), "a validated host must yield addresses");
            assert!(
                addrs.iter().all(|a| a.port() == 8080),
                "the pin must carry the URL's port, not a default"
            );
        }
        ScreenedEgress::Exempt => {
            panic!("a resolved, non-allowlisted host must be Pinned, never Exempt")
        }
    }
}

/// Exemption is reported, never inferred. These two are the ONLY ways a caller
/// may legitimately skip the pin.
#[tokio::test]
async fn exemption_is_explicit_for_both_of_its_causes() {
    let (_, guard_off) = screen_egress_url_pinned("http://127.0.0.1:3000/mcp", false, None)
        .await
        .expect("a disabled guard passes everything");
    assert!(
        matches!(guard_off, ScreenedEgress::Exempt),
        "a disabled guard must report Exempt"
    );

    // The loopback development target, allowlisted by the operator. Resolution
    // would refuse it by design, so it must short-circuit BEFORE resolving.
    let (_, allowlisted) =
        screen_egress_url_pinned("http://127.0.0.1:3000/mcp", true, Some("127.0.0.1"))
            .await
            .expect("an allowlisted host is the supported escape hatch");
    assert!(
        matches!(allowlisted, ScreenedEgress::Exempt),
        "an allowlisted host must report Exempt"
    );
}

/// A blocked host must ERROR, not return `Exempt`. Collapsing refusal into
/// exemption is the same fail-open by another route.
#[tokio::test]
async fn a_blocked_host_errors_rather_than_reporting_exempt() {
    for url in ["http://169.254.169.254/mcp", "http://10.0.0.1/mcp"] {
        assert!(
            screen_egress_url_pinned(url, true, None).await.is_err(),
            "{url} must be refused outright, never reported as exempt"
        );
    }
}
