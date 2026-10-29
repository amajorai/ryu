use super::{GatewayConfig, PromptCacheConfig};
use ryu_gw_providers::PromptCacheMode;

#[test]
fn default_enables_automatic_cache_markers_without_session_affinity() {
    let cfg = PromptCacheConfig::default();
    assert_eq!(cfg.mode, "auto");
    assert_eq!(cfg.options().mode, PromptCacheMode::Auto);
    assert!(!cfg.session_affinity);
    assert!(cfg.allow_request_override);
    // A gateway.toml with no [prompt_cache] table deserializes to the same.
    assert_eq!(GatewayConfig::default().prompt_cache, cfg);
}

#[test]
fn a_missing_table_deserializes_to_the_auto_default() {
    let cfg: PromptCacheConfig =
        serde_json::from_value(serde_json::json!({})).expect("all fields default");
    assert_eq!(cfg, PromptCacheConfig::default());
}

#[test]
fn options_map_every_knob_through() {
    let cfg = PromptCacheConfig {
        mode: "explicit".into(),
        ttl: " 1h ".into(),
        min_prefix_tokens: 4096,
        breakpoints: 4,
        session_affinity: true,
        allow_request_override: false,
    };
    let o = cfg.options();
    assert_eq!(o.mode, PromptCacheMode::Explicit);
    assert_eq!(o.ttl.as_deref(), Some("1h"), "ttl is trimmed");
    assert_eq!(o.min_prefix_tokens, 4096);
    assert_eq!(o.breakpoints, 4);
    assert!(o.session_affinity);
}

#[test]
fn an_unparseable_mode_falls_back_to_off_not_auto() {
    // A typo must never silently start billing cache writes.
    let cfg = PromptCacheConfig {
        mode: "atuo".into(),
        ..Default::default()
    };
    assert_eq!(cfg.options().mode, PromptCacheMode::Off);
}

#[test]
fn an_empty_ttl_means_the_provider_default() {
    let cfg = PromptCacheConfig {
        mode: "auto".into(),
        ttl: "   ".into(),
        ..Default::default()
    };
    assert_eq!(cfg.options().ttl, None);
}

#[test]
fn an_unsupported_ttl_degrades_instead_of_being_forwarded() {
    // `10m` is not a documented value: forwarding it would be rejected
    // upstream mid-request, and on the Anthropic path it would also trigger
    // the extended-TTL beta header. Degrade to the provider default.
    for bad in ["10m", "forever", "3600"] {
        let cfg = PromptCacheConfig {
            mode: "auto".into(),
            ttl: bad.into(),
            ..Default::default()
        };
        assert_eq!(cfg.options().ttl, None, "{bad}");
    }
    // Case-insensitive on the values that ARE supported.
    let cfg = PromptCacheConfig {
        mode: "auto".into(),
        ttl: " 1H ".into(),
        ..Default::default()
    };
    assert_eq!(cfg.options().ttl.as_deref(), Some("1h"));
}
