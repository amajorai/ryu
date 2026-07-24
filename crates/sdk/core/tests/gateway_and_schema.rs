//! Egress-rule edge cases, gateway URL/token resolution, and the exported JSON
//! Schema — all via the crate's public surface.

use ryu_sdk::gateway::{
    assert_allowed_egress, resolve_gateway_token, resolve_gateway_url, DEFAULT_GATEWAY_URL,
    ENV_GATEWAY_TOKEN, ENV_GATEWAY_URL,
};

#[test]
fn blocks_every_known_provider_pattern() {
    for blocked in [
        "https://api.openai.com/v1",
        "https://api.anthropic.com",
        "https://generativelanguage.googleapis.com/v1beta",
        "https://api.cohere.ai",
        "https://api.mistral.ai",
        "https://openrouter.ai/api/v1",
        "https://api.groq.com/openai/v1",
        "https://api.together.xyz/v1",
        "https://api.replicate.com",
        "https://api.perplexity.ai",
    ] {
        assert!(
            assert_allowed_egress(blocked).is_err(),
            "should block {blocked}"
        );
    }
}

#[test]
fn block_is_case_insensitive_and_substring_based() {
    // Uppercased host is still blocked (the patterns are compiled case-insensitive).
    assert!(assert_allowed_egress("https://API.OPENAI.COM/v1").is_err());
    // A provider host appearing anywhere in the URL is blocked, even as a path-ish
    // substring — the blocklist is deliberately conservative.
    assert!(assert_allowed_egress("http://127.0.0.1:7981/proxy/api.openai.com").is_err());
}

#[test]
fn allows_gateway_loopback_and_private_hosts() {
    for ok in [
        "http://127.0.0.1:7981",
        "http://localhost:7981",
        "https://gateway.internal.example",
        "http://192.168.1.50:7981",
        "http://10.0.0.5:7981/v1",
        "", // empty is not a known provider → allowed (construction default handles emptiness)
    ] {
        assert!(assert_allowed_egress(ok).is_ok(), "should allow {ok:?}");
    }
}

#[test]
fn egress_error_message_names_the_offending_url() {
    let err = assert_allowed_egress("https://api.openai.com").unwrap_err();
    assert_eq!(err.url, "https://api.openai.com");
    assert!(err.to_string().contains("api.openai.com"));
}

/// All env-mutating assertions live in ONE test so they run sequentially within
/// this (single-process) test binary and never race each other.
#[test]
fn gateway_url_and_token_resolve_from_env_with_fallbacks() {
    // Snapshot + restore so we do not leak state to any sibling test.
    let prev_url = std::env::var(ENV_GATEWAY_URL).ok();
    let prev_token = std::env::var(ENV_GATEWAY_TOKEN).ok();

    // Unset → defaults.
    std::env::remove_var(ENV_GATEWAY_URL);
    std::env::remove_var(ENV_GATEWAY_TOKEN);
    assert_eq!(resolve_gateway_url(), DEFAULT_GATEWAY_URL);
    assert_eq!(resolve_gateway_token(), None);

    // Set, with surrounding whitespace → trimmed.
    std::env::set_var(ENV_GATEWAY_URL, "  http://gw.example:9000  ");
    std::env::set_var(ENV_GATEWAY_TOKEN, "  abc123  ");
    assert_eq!(resolve_gateway_url(), "http://gw.example:9000");
    assert_eq!(resolve_gateway_token().as_deref(), Some("abc123"));

    // Empty / whitespace-only → treated as unset (fall back / None).
    std::env::set_var(ENV_GATEWAY_URL, "   ");
    std::env::set_var(ENV_GATEWAY_TOKEN, "   ");
    assert_eq!(resolve_gateway_url(), DEFAULT_GATEWAY_URL);
    assert_eq!(resolve_gateway_token(), None);

    // Restore.
    match prev_url {
        Some(v) => std::env::set_var(ENV_GATEWAY_URL, v),
        None => std::env::remove_var(ENV_GATEWAY_URL),
    }
    match prev_token {
        Some(v) => std::env::set_var(ENV_GATEWAY_TOKEN, v),
        None => std::env::remove_var(ENV_GATEWAY_TOKEN),
    }
}

#[test]
fn default_gateway_url_is_the_documented_loopback_port() {
    assert_eq!(DEFAULT_GATEWAY_URL, "http://127.0.0.1:7981");
}

#[test]
fn exported_json_schema_describes_the_manifest_object() {
    let schema = ryu_sdk::json_schema::plugin_manifest_schema();
    let props = schema
        .get("properties")
        .and_then(|p| p.as_object())
        .expect("schema has properties");
    for key in ["id", "name", "version", "runnables"] {
        assert!(props.contains_key(key), "schema missing '{key}'");
    }
}
