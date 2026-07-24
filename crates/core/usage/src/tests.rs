//! Unit tests for the pure logic in the usage module: agent→engine mapping and
//! the unverified-JWT `exp` reader. The network calls and file reads are not
//! covered here (they need a live token / fixture).

use super::*;

/// A one-shot hermetic HTTP/1.1 server bound to `127.0.0.1:0` (loopback only —
/// no external network). Serves the given status + JSON body to every incoming
/// connection on a detached thread, so `fetch`'s reqwest call can be driven
/// end-to-end. Returns the base URL to point `RYU_USAGE_*_URL` at.
pub(crate) fn spawn_loopback(status_line: &'static str, body: &'static str) -> String {
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
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
fn engine_none_for_unsupported_agents() {
    for id in [
        "ryu",
        "acp:gemini",
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
    let snap = fetch_usage("acp:gemini").await;
    assert!(!snap.available);
    assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
    assert!(snap.windows.is_empty());
    assert_eq!(snap.engine, "");
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
    assert!(matches!(engine_for_agent("ACP:CLAUDE"), Some(Engine::Claude)));
    assert!(matches!(engine_for_agent("ACP:CODEX"), Some(Engine::Codex)));
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
    // skip_serializing_if — must be absent when None.
    assert!(!obj.contains_key("plan"));
    assert!(!obj.contains_key("extra_usage_usd"));
}

#[test]
fn available_snapshot_serializes_all_fields() {
    let snap = UsageSnapshot {
        agent_id: "acp:claude".to_string(),
        engine: "claude".to_string(),
        available: true,
        plan: Some("Max 20x".to_string()),
        reason: None,
        windows: vec![
            UsageWindow {
                label: "Session".to_string(),
                used_percent: 42.5,
                resets_at: Some("2026-07-23T00:00:00Z".to_string()),
            },
            UsageWindow {
                label: "Weekly".to_string(),
                used_percent: 0.0,
                resets_at: None,
            },
        ],
        extra_usage_usd: Some(1.25),
    };
    let v = serde_json::to_value(&snap).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("available").unwrap(), true);
    assert_eq!(obj.get("plan").unwrap(), "Max 20x");
    assert_eq!(obj.get("extra_usage_usd").unwrap(), 1.25);
    // reason absent because None.
    assert!(!obj.contains_key("reason"));
    let windows = obj.get("windows").unwrap().as_array().unwrap();
    assert_eq!(windows.len(), 2);
    // First window carries resets_at, second omits it (skip_serializing_if).
    assert!(windows[0].as_object().unwrap().contains_key("resets_at"));
    assert!(!windows[1].as_object().unwrap().contains_key("resets_at"));
    assert_eq!(windows[0].get("used_percent").unwrap(), 42.5);
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
