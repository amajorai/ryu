//! Unit tests for the pure logic in the usage module: agent→engine mapping and
//! the unverified-JWT `exp` reader. The network calls and file reads are not
//! covered here (they need a live token / fixture).

use super::*;

/// A one-shot hermetic HTTP/1.1 server bound to `127.0.0.1:0` (loopback only —
/// no external network). Serves the given status + JSON body to every incoming
/// connection on a detached thread, so `fetch`'s reqwest call can be driven
/// end-to-end. Returns the base URL to point `RYU_USAGE_*_URL` at.
pub(crate) fn spawn_loopback(status_line: &'static str, body: &'static str) -> String {
    spawn_loopback_with_headers(status_line, "", body)
}

/// [`spawn_loopback`] with extra response headers, for the vendors that carry
/// data in headers (Codex's `x-codex-*-used-percent` / credit balance) or that
/// tell us when to retry (`Retry-After`). `extra_headers` must be a
/// already-CRLF-terminated block, e.g. `"Retry-After: 120\r\n"`.
pub(crate) fn spawn_loopback_with_headers(
    status_line: &'static str,
    extra_headers: &'static str,
    body: &'static str,
) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("addr");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            // Drain the request head so the client isn't left writing into a
            // closed socket; we don't parse it.
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://{addr}/usage")
}

#[test]
fn engine_maps_curated_acp_ids() {
    assert!(matches!(
        engine_for_agent("acp:claude"),
        Some(Engine::Claude)
    ));
    assert!(matches!(engine_for_agent("acp:codex"), Some(Engine::Codex)));
}

#[test]
fn engine_maps_engine_direct_and_custom_ids() {
    assert!(matches!(engine_for_agent("claude"), Some(Engine::Claude)));
    assert!(matches!(
        engine_for_agent("my-claude-agent"),
        Some(Engine::Claude)
    ));
    assert!(matches!(engine_for_agent("Codex"), Some(Engine::Codex)));
}

#[test]
fn engine_maps_ryu_subscription_provider_ids() {
    assert!(matches!(
        engine_for_agent("openai-codex"),
        Some(Engine::Codex)
    ));
    assert!(matches!(
        engine_for_agent("claude-pro-max"),
        Some(Engine::Claude)
    ));
    assert!(matches!(
        engine_for_agent("github-copilot"),
        Some(Engine::Copilot)
    ));
    assert!(matches!(engine_for_agent("devin"), Some(Engine::Devin)));
    assert!(matches!(
        engine_for_agent("opencode-go"),
        Some(Engine::OpenCode)
    ));
    assert!(matches!(engine_for_agent("ollama"), Some(Engine::Ollama)));
    assert!(matches!(engine_for_agent("chatgpt"), Some(Engine::ChatGpt)));
}

#[test]
fn engine_maps_every_curated_acp_id() {
    let cases = [
        ("acp:claude", Engine::Claude),
        ("acp:codex", Engine::Codex),
        ("acp:copilot", Engine::Copilot),
        ("acp:grok", Engine::Grok),
        ("acp:glm", Engine::Glm),
        ("acp:devin", Engine::Devin),
        ("acp:opencode", Engine::OpenCode),
        ("acp:ollama", Engine::Ollama),
        ("acp:cursor", Engine::Cursor),
        ("acp:gemini", Engine::Antigravity),
    ];
    for (id, expected) in cases {
        assert_eq!(engine_for_agent(id), Some(expected), "{id}");
    }
}

#[test]
fn engine_none_for_unsupported_agents() {
    for id in [
        "ryu",
        // Droid and Qwen have no readable subscription usage source.
        "acp:droid",
        "acp:qwen",
        "acp:codebuddy",
        "acp:pi",
        "openclaw",
        "zeroclaw",
        "hermes",
        "",
    ] {
        assert!(engine_for_agent(id).is_none(), "{id} should be unsupported");
    }
}

#[tokio::test]
async fn unsupported_agent_yields_hide_snapshot() {
    let snap = fetch_usage("acp:unknown").await;
    assert!(!snap.available);
    assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
    assert!(snap.windows.is_empty());
    assert_eq!(snap.engine, "");
}

#[tokio::test]
async fn account_usage_without_a_credential_is_structured_not_logged_in() {
    let snap = fetch_ryu_provider_usage_for_credential("claude-pro-max", None).await;
    assert!(!snap.available);
    assert_eq!(snap.agent_id, "claude-pro-max");
    assert_eq!(snap.engine, "claude");
    assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
}

#[tokio::test]
async fn cli_usage_providers_are_not_read_from_a_saved_pi_account() {
    for provider_id in ["devin", "opencode-go", "ollama", "cursor", "gemini"] {
        let snapshot = fetch_ryu_provider_usage_for_credential(
            provider_id,
            Some(serde_json::json!({ "apiKey": "account-specific-secret" })),
        )
        .await;
        assert!(!snapshot.available, "{provider_id}");
        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::Unsupported)
        ));
    }
}

#[test]
fn jwt_exp_reads_claim_without_verification() {
    use base64::Engine as _;
    // header.payload.signature — payload carries exp=1700000000.
    let payload =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1700000000,"sub":"u"}"#);
    let token = format!("aaa.{payload}.bbb");
    assert_eq!(jwt_exp_unix(&token), Some(1_700_000_000));
}

#[test]
fn jwt_exp_none_for_non_jwt() {
    assert_eq!(jwt_exp_unix("not-a-jwt"), None);
    assert_eq!(jwt_exp_unix("only.two"), None);
}

#[test]
fn engine_prefers_claude_when_both_substrings_present() {
    // Claude is checked first, so a mixed id resolves to Claude.
    assert!(matches!(
        engine_for_agent("claude-codex-hybrid"),
        Some(Engine::Claude)
    ));
    // Case-insensitivity applies to the exact-id branch too.
    assert!(matches!(
        engine_for_agent("ACP:CLAUDE"),
        Some(Engine::Claude)
    ));
    assert!(matches!(engine_for_agent("ACP:CODEX"), Some(Engine::Codex)));
    assert!(matches!(engine_for_agent("ACP:DEVIN"), Some(Engine::Devin)));
}

#[test]
fn engine_codex_substring_variants() {
    assert!(matches!(
        engine_for_agent("my-codex-runner"),
        Some(Engine::Codex)
    ));
    assert!(matches!(engine_for_agent("acp:codex"), Some(Engine::Codex)));
}

#[test]
fn jwt_exp_accepts_standard_base64_no_pad_payload() {
    use base64::Engine as _;
    // A payload that only decodes under STANDARD_NO_PAD (contains '+' / '/'
    // producing bytes), exercising the fallback decoder branch.
    let payload = base64::engine::general_purpose::STANDARD_NO_PAD.encode(br#"{"exp":42}"#);
    let token = format!("h.{payload}.s");
    assert_eq!(jwt_exp_unix(&token), Some(42));
}

#[test]
fn jwt_exp_none_when_exp_missing_or_non_numeric() {
    use base64::Engine as _;
    let no_exp = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"u"}"#);
    assert_eq!(jwt_exp_unix(&format!("a.{no_exp}.b")), None);

    let string_exp = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":"soon"}"#);
    assert_eq!(jwt_exp_unix(&format!("a.{string_exp}.b")), None);
}

#[test]
fn jwt_exp_none_when_payload_is_not_json() {
    use base64::Engine as _;
    let junk = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"not json at all");
    assert_eq!(jwt_exp_unix(&format!("a.{junk}.b")), None);
    // Non-base64 payload segment.
    assert_eq!(jwt_exp_unix("a.!!!not-base64!!!.b"), None);
}

#[test]
fn reason_for_status_maps_auth_and_ratelimit_and_default() {
    use reqwest::StatusCode;
    assert!(matches!(
        reason_for_status(StatusCode::UNAUTHORIZED),
        UsageUnavailable::TokenExpired
    ));
    assert!(matches!(
        reason_for_status(StatusCode::FORBIDDEN),
        UsageUnavailable::TokenExpired
    ));
    assert!(matches!(
        reason_for_status(StatusCode::TOO_MANY_REQUESTS),
        UsageUnavailable::RateLimited
    ));
    assert!(matches!(
        reason_for_status(StatusCode::INTERNAL_SERVER_ERROR),
        UsageUnavailable::Error
    ));
    // Any other 2xx/4xx that isn't specifically handled falls to Error.
    assert!(matches!(
        reason_for_status(StatusCode::BAD_REQUEST),
        UsageUnavailable::Error
    ));
    assert!(matches!(
        reason_for_status(StatusCode::OK),
        UsageUnavailable::Error
    ));
}

#[test]
fn read_file_reads_and_misses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cred.json");
    assert_eq!(read_file(&path), None, "absent file => None");
    std::fs::write(&path, "hello").unwrap();
    assert_eq!(read_file(&path).as_deref(), Some("hello"));

    std::fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(
        read_file(&path).is_none(),
        "oversized credential file => None"
    );
}

#[test]
fn unavailable_snapshot_shape() {
    let snap = UsageSnapshot::unavailable("acp:claude", "claude", UsageUnavailable::NotLoggedIn);
    assert_eq!(snap.agent_id, "acp:claude");
    assert_eq!(snap.engine, "claude");
    assert!(!snap.available);
    assert!(snap.plan.is_none());
    assert!(snap.windows.is_empty());
    assert!(snap.extra_usage_usd.is_none());
    assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
}

#[test]
fn unavailable_reason_serializes_snake_case() {
    let cases = [
        (UsageUnavailable::Unsupported, "unsupported"),
        (UsageUnavailable::NotLoggedIn, "not_logged_in"),
        (UsageUnavailable::TokenExpired, "token_expired"),
        (UsageUnavailable::MissingScope, "missing_scope"),
        (UsageUnavailable::NoPlan, "no_plan"),
        (UsageUnavailable::RateLimited, "rate_limited"),
        (UsageUnavailable::Error, "error"),
    ];
    for (reason, expected) in cases {
        let json = serde_json::to_string(&reason).unwrap();
        assert_eq!(json, format!("\"{expected}\""));
    }
}

#[test]
fn unavailable_snapshot_serialization_skips_optional_fields() {
    let snap = UsageSnapshot::unavailable("id", "", UsageUnavailable::Unsupported);
    let v = serde_json::to_value(&snap).unwrap();
    let obj = v.as_object().unwrap();
    // Present, mandatory fields.
    assert_eq!(obj.get("agent_id").unwrap(), "id");
    assert_eq!(obj.get("engine").unwrap(), "");
    assert_eq!(obj.get("available").unwrap(), false);
    assert_eq!(obj.get("reason").unwrap(), "unsupported");
    assert!(obj.get("windows").unwrap().as_array().unwrap().is_empty());
    // skip_serializing_if — must be absent when None/empty.
    assert!(!obj.contains_key("plan"));
    assert!(!obj.contains_key("extra_usage_usd"));
    assert!(!obj.contains_key("retry_after_seconds"));
    assert!(!obj.contains_key("meters"));
}

#[test]
fn available_snapshot_serializes_all_fields() {
    let mut snap = UsageSnapshot::available("acp:claude", "claude", Some("Max 20x".to_string()));
    snap.windows = vec![
        UsageWindow {
            label: "Session".to_string(),
            used_percent: 42.5,
            resets_at: Some("2026-07-23T00:00:00Z".to_string()),
            window_seconds: Some(18_000),
            model: None,
        },
        UsageWindow {
            label: "Weekly".to_string(),
            used_percent: 0.0,
            resets_at: None,
            window_seconds: None,
            model: None,
        },
    ];
    snap.extra_usage_usd = Some(1.25);
    let v = serde_json::to_value(&snap).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("available").unwrap(), true);
    assert_eq!(obj.get("plan").unwrap(), "Max 20x");
    assert_eq!(obj.get("extra_usage_usd").unwrap(), 1.25);
    // reason absent because None.
    assert!(!obj.contains_key("reason"));
    let windows = obj.get("windows").unwrap().as_array().unwrap();
    assert_eq!(windows.len(), 2);
    // First window carries resets_at + window_seconds, second omits both.
    assert!(windows[0].as_object().unwrap().contains_key("resets_at"));
    assert_eq!(windows[0].get("window_seconds").unwrap(), 18_000);
    assert!(!windows[1].as_object().unwrap().contains_key("resets_at"));
    assert!(!windows[1]
        .as_object()
        .unwrap()
        .contains_key("window_seconds"));
    assert_eq!(windows[0].get("used_percent").unwrap(), 42.5);
}

#[test]
fn meter_serializes_values_kinds_and_expiries() {
    let mut snap = UsageSnapshot::available("acp:codex", "codex", None);
    snap.meters = vec![
        UsageMeter::new(
            "Rate limit resets",
            vec![UsageValue::new(
                2.0,
                UsageValueKind::Count,
                Some("available"),
            )],
        )
        .with_expiries(vec![
            "2026-07-31T09:00:00+00:00".to_string(),
            "2026-08-02T17:30:00+00:00".to_string(),
        ]),
        UsageMeter::new(
            "Credits",
            vec![
                UsageValue::new(32.84, UsageValueKind::Dollars, None),
                UsageValue::new(821.0, UsageValueKind::Count, Some("credits")),
            ],
        )
        .with_resets_at(Some("2026-08-01T00:00:00+00:00".to_string())),
    ];
    let v = serde_json::to_value(&snap).unwrap();
    let meters = v.get("meters").unwrap().as_array().unwrap();
    assert_eq!(meters.len(), 2);

    let banked = meters[0].as_object().unwrap();
    assert_eq!(banked.get("label").unwrap(), "Rate limit resets");
    assert_eq!(
        banked.get("expires_at").unwrap().as_array().unwrap().len(),
        2
    );
    // A row with no period rollover omits resets_at entirely.
    assert!(!banked.contains_key("resets_at"));
    let value = banked.get("values").unwrap().as_array().unwrap()[0]
        .as_object()
        .unwrap();
    assert_eq!(value.get("kind").unwrap(), "count");
    assert_eq!(value.get("unit").unwrap(), "available");

    let credits = meters[1].as_object().unwrap();
    // No per-item expiries → the array is skipped rather than sent empty.
    assert!(!credits.contains_key("expires_at"));
    assert!(credits.contains_key("resets_at"));
    let dollars = credits.get("values").unwrap().as_array().unwrap()[0]
        .as_object()
        .unwrap();
    assert_eq!(dollars.get("kind").unwrap(), "dollars");
    // `unit` is skipped when the kind already says everything.
    assert!(!dollars.contains_key("unit"));
}

#[test]
fn clamp_percent_holds_the_range() {
    assert_eq!(clamp_percent(-4.0), 0.0);
    assert_eq!(clamp_percent(0.0), 0.0);
    assert_eq!(clamp_percent(55.5), 55.5);
    assert_eq!(clamp_percent(140.0), 100.0);
    assert_eq!(clamp_percent(f64::NAN), 0.0);
}

#[test]
fn timestamp_to_rfc3339_accepts_every_shape_vendors_send() {
    let parse = |v: serde_json::Value| timestamp_to_rfc3339(Some(&v));
    // ISO-8601 with a zone.
    assert!(parse(serde_json::json!("2026-07-31T09:00:00Z"))
        .unwrap()
        .starts_with("2026-07-31T09:00:00"));
    // A bare calendar date (Copilot's free tier) → midnight UTC.
    assert!(parse(serde_json::json!("2026-07-31"))
        .unwrap()
        .starts_with("2026-07-31T00:00:00"));
    // Epoch seconds vs. epoch milliseconds, told apart by magnitude.
    let secs = parse(serde_json::json!(1_800_000_000i64)).unwrap();
    let millis = parse(serde_json::json!(1_800_000_000_000i64)).unwrap();
    assert_eq!(secs, millis);
    // Junk yields None rather than a fabricated date.
    assert!(parse(serde_json::json!("not a date")).is_none());
    assert!(parse(serde_json::json!("")).is_none());
    assert!(timestamp_to_rfc3339(None).is_none());
}

#[test]
fn title_case_splits_on_separators() {
    assert_eq!(title_case("plus", &['_']), "Plus");
    assert_eq!(title_case("PRO", &['_']), "Pro");
    assert_eq!(title_case(" team ", &['_']), "Team");
    assert_eq!(title_case("copilot_pro", &['_']), "Copilot Pro");
    assert_eq!(title_case("business-plus", &['_', '-']), "Business Plus");
    assert_eq!(title_case("", &['_']), "");
}

#[test]
fn retry_after_reads_delta_seconds_only() {
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
    let mut headers = HeaderMap::new();
    assert_eq!(retry_after_seconds(&headers), None);
    headers.insert(RETRY_AFTER, HeaderValue::from_static("120"));
    assert_eq!(retry_after_seconds(&headers), Some(120));
    // A negative value is nonsense; an HTTP-date is deliberately unparsed rather
    // than guessed at.
    headers.insert(RETRY_AFTER, HeaderValue::from_static("-5"));
    assert_eq!(retry_after_seconds(&headers), None);
    headers.insert(
        RETRY_AFTER,
        HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
    );
    assert_eq!(retry_after_seconds(&headers), None);
}

struct FakeHost {
    codex_home: PathBuf,
}
impl UsageHost for FakeHost {
    fn ryu_codex_home(&self) -> PathBuf {
        self.codex_home.clone()
    }
}

#[test]
fn host_seam_install_and_read() {
    // set_global_host is a process-global OnceLock: we can deterministically
    // assert the "installed" side only. Installing a host must not panic and the
    // installed value must be readable back through host().
    let marker = PathBuf::from("/tmp/ryu-usage-test-codex-home");
    set_global_host(Arc::new(FakeHost {
        codex_home: marker.clone(),
    }));
    let got = host().expect("host installed");
    assert_eq!(got.ryu_codex_home(), marker);
    // Idempotent: a second install is ignored (no panic, value unchanged).
    set_global_host(Arc::new(FakeHost {
        codex_home: PathBuf::from("/tmp/other"),
    }));
    assert_eq!(host().unwrap().ryu_codex_home(), marker);
}

#[test]
fn subscription_agents_cover_every_engine() {
    // The exported candidate pool and the dispatch table must stay in lockstep:
    // an engine reachable by `fetch_usage` but missing from the pool is an agent
    // nothing can fail over to, and a pool entry with no reader would be offered
    // as a fallback that can never report a window.
    let mapped: Vec<&str> = AGENT_ENGINES.iter().map(|(id, _)| *id).collect();
    let mut pool = SUBSCRIPTION_AGENTS.to_vec();
    let mut mapped_sorted = mapped.clone();
    pool.sort_unstable();
    mapped_sorted.sort_unstable();
    assert_eq!(
        pool, mapped_sorted,
        "SUBSCRIPTION_AGENTS must list exactly the ids AGENT_ENGINES maps"
    );
    // And every pooled id must actually resolve through the public mapping.
    for id in SUBSCRIPTION_AGENTS {
        assert!(
            engine_for_agent(id).is_some(),
            "pooled agent {id} does not resolve to an engine"
        );
    }
}

#[test]
fn account_usage_support_matches_the_account_aware_engines() {
    // Only engines with a per-credential reader can report a saved account's
    // own windows. Everything else must stay `false` so callers never probe.
    for provider in [
        "claude-pro-max",
        "openai-codex",
        "chatgpt",
        "github-copilot",
    ] {
        assert!(
            supports_account_usage(provider),
            "{provider} has an account-aware reader"
        );
    }
    for provider in [
        "chatgpt-plan",
        "kiro",
        "kimi-coding",
        "radius",
        "ant-ling",
        "anthropic",
        "openrouter",
        "zai",
        "opencode",
        "acp:grok",
        "acp:glm",
        "",
        "definitely-unknown",
    ] {
        assert!(
            !supports_account_usage(provider),
            "{provider} must not report per-account usage"
        );
    }
}

#[test]
fn snapshot_omits_unset_provider_and_account_stamps() {
    let snapshot = UsageSnapshot::unavailable("claude-pro-max", "claude", UsageUnavailable::Error);
    let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
    let object = value.as_object().expect("snapshot object");
    assert!(!object.contains_key("provider_id"));
    assert!(!object.contains_key("account_id"));
    assert_eq!(object["agent_id"], "claude-pro-max");

    let stamped = UsageSnapshot {
        provider_id: Some("claude-pro-max".to_owned()),
        account_id: Some("acct_fixture".to_owned()),
        ..snapshot
    };
    let value = serde_json::to_value(&stamped).expect("serialize stamped snapshot");
    assert_eq!(value["provider_id"], "claude-pro-max");
    assert_eq!(value["account_id"], "acct_fixture");
}
