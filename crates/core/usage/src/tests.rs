//! Unit tests for the pure logic in the usage module: agent→engine mapping and
//! the unverified-JWT `exp` reader. The network calls and file reads are not
//! covered here (they need a live token / fixture).

use super::*;

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
