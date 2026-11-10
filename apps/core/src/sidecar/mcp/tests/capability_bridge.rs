//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

fn adapter_bridge(target: &str, allowed: &[&str]) -> CapabilityAdapterBridge {
    CapabilityAdapterBridge {
        registry: global_registry().unwrap_or_else(|| {
            // Only the resolve decision is under test; the registry handle is
            // never dereferenced on these paths.
            Arc::new(McpRegistry::default())
        }),
        target: target.to_owned(),
        allowed: allowed.iter().map(|s| (*s).to_owned()).collect(),
        provider_id: "com.example.provider".to_owned(),
        agent_id: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
    }
}

#[test]
fn adapter_primary_path_always_resolves_to_the_manifest_fixed_tool() {
    let bridge = adapter_bridge("firecrawl.scrape", &[]);
    let target = bridge
        .resolve_target(
            crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH,
            &serde_json::json!({ "url": "https://example.com" }),
        )
        .expect("the primary path is always callable");
    assert_eq!(target, "firecrawl.scrape");
}

#[test]
fn adapter_cannot_redirect_the_primary_path_at_another_tool() {
    // Arguments are attacker-shaped (an adapter builds them freely), so a `tool`
    // key riding along in them must NOT steer the primary call.
    let bridge = adapter_bridge("firecrawl.scrape", &[]);
    let target = bridge
        .resolve_target(
            crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH,
            &serde_json::json!({ "tool": "fs.read_file" }),
        )
        .expect("primary path resolves");
    assert_eq!(target, "firecrawl.scrape");
}

#[test]
fn adapter_named_path_refuses_a_tool_the_manifest_did_not_declare() {
    let bridge = adapter_bridge("firecrawl.crawl_start", &["firecrawl.crawl_status"]);

    let allowed = bridge
        .resolve_target(
            crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH,
            &serde_json::json!({ "tool": "firecrawl.crawl_status" }),
        )
        .expect("a declared tool is callable");
    assert_eq!(allowed, "firecrawl.crawl_status");

    // The escalation this seam exists to prevent.
    let denied = bridge.resolve_target(
        crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH,
        &serde_json::json!({ "tool": "fs.read_file" }),
    );
    assert!(denied.is_err(), "an undeclared tool must be refused");

    // Naming the primary explicitly is the same call `callTool` makes.
    assert_eq!(
        bridge
            .resolve_target(
                crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH,
                &serde_json::json!({ "tool": "firecrawl.crawl_start" }),
            )
            .expect("the primary tool is reachable by name"),
        "firecrawl.crawl_start"
    );
}

#[test]
fn adapter_cannot_re_enter_the_capability_facade() {
    // A provider that declared a facade verb as a callable tool would loop the
    // facade back into itself — the manifest-driven infinite loop the
    // declarative arm already refuses for `binding.tool`.
    let bridge = adapter_bridge("firecrawl.crawl_start", &["web.crawl"]);
    let denied = bridge.resolve_target(
        crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH,
        &serde_json::json!({ "tool": "web.crawl" }),
    );
    assert!(denied.is_err(), "the facade must not be re-enterable");
}

#[test]
fn adapter_refuses_unknown_bridge_paths_and_empty_ids() {
    let bridge = adapter_bridge("firecrawl.scrape", &["firecrawl.crawl_status"]);
    // `host.*` is the plugin-hook surface an adapter deliberately does not get.
    assert!(bridge
        .resolve_target("host.sideModel", &serde_json::json!({}))
        .is_err());
    assert!(bridge
        .resolve_target(
            crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH,
            &serde_json::json!({})
        )
        .is_err());
}

#[test]
fn adapter_results_carry_the_provider_like_declarative_ones() {
    let stamped = stamp_provider(serde_json::json!({ "results": [] }), "@ryu/firecrawl");
    assert_eq!(stamped["provider"], serde_json::json!("@ryu/firecrawl"));

    // An adapter that reported its own provider is trusted over the stamp.
    let explicit = stamp_provider(
        serde_json::json!({ "provider": "proxied" }),
        "@ryu/firecrawl",
    );
    assert_eq!(explicit["provider"], serde_json::json!("proxied"));

    // A non-object result is wrapped, never dropped.
    let wrapped = stamp_provider(serde_json::json!([1, 2]), "@ryu/firecrawl");
    assert_eq!(wrapped["provider"], serde_json::json!("@ryu/firecrawl"));
    assert_eq!(wrapped["raw"], serde_json::json!([1, 2]));
}
