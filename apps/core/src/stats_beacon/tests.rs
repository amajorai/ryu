use super::*;

#[test]
fn marketplace_identity_is_normalized_and_path_safe() {
    assert_eq!(
        marketplace_id("AGENT", "ryu/design-director"),
        Some(("agent".to_owned(), "ryu/design-director".to_owned()))
    );
    assert!(marketplace_id("agent", "../secret").is_none());
    assert!(marketplace_id("unknown", "demo").is_none());
}

#[test]
fn private_discovered_skills_never_enter_the_per_listing_snapshot() {
    let private_id = "private-local-skill-0320a115a6c8819188e4edb47a4756ea";
    for kind in ["skill", "SKILL", " skill "] {
        assert!(marketplace_runtime_identity(kind, private_id).is_none());
        record_marketplace_event(kind, private_id, false);
        record_marketplace_event(kind, private_id, true);
    }
    let record = ryu_skills::parse_skill_md(
        private_id,
        "---\nname: Private review\n---\nPrivate instructions",
    )
    .expect("private record");
    record_skill_load(&record);
    let payload = serde_json::to_value(marketplace_stats_snapshot()).expect("snapshot");
    assert!(!payload.to_string().contains(private_id));
    assert!(!payload.to_string().contains("Private instructions"));
}

#[test]
fn private_agent_workflow_plugin_and_usage_ids_need_public_source_witnesses() {
    let mut items = PublicItemWitnesses {
        version: 1,
        authority: "https://api.ryuhq.com".into(),
        ..Default::default()
    };
    items
        .listing_ids
        .insert("agent:publisher/public-agent".into());
    items.runtime_ids.insert(
        "agent:installed-runtime".into(),
        ("agent".into(), "publisher/public-agent".into()),
    );
    assert_eq!(
        resolve_public_identity(&items, "agent".into(), "installed-runtime".into()),
        Some(("agent".into(), "publisher/public-agent".into()))
    );
    items.runtime_ids.insert(
        "agent:private-runtime".into(),
        ("agent".into(), "private/company-secret".into()),
    );
    assert!(resolve_public_identity(&items, "agent".into(), "private-runtime".into()).is_none());
    for kind in ["agent", "workflow", "plugin", "app", "model", "bundle"] {
        assert!(
            resolve_public_identity(&items, kind.into(), "private-company-name".into()).is_none()
        );
        assert!(marketplace_runtime_identity(kind, "private-company-0320-unknown").is_none());
    }
}

#[test]
fn marketplace_snapshot_uses_content_free_camel_case_fields() {
    let payload = IngestPayload {
        instance_id: "instance".to_owned(),
        session_id: "session".to_owned(),
        requests: 0,
        api_calls_protected: 0,
        malicious_calls_blocked: 0,
        input_tokens: 0,
        output_tokens: 0,
        tokens_saved: 0,
        cache_hit_rate: 0.0,
        os: "test".to_owned(),
        arch: "test".to_owned(),
        version: "test".to_owned(),
        engine: "test".to_owned(),
        marketplace_stats: vec![MarketplaceStatsSnapshot {
            id: "ryu/design-director".to_owned(),
            kind: "agent".to_owned(),
            downloads: 1,
            runs: 2,
        }],
    };
    let value = serde_json::to_value(payload).expect("payload should serialize");
    assert_eq!(value["marketplaceStats"][0]["downloads"], 1);
    assert_eq!(value["marketplaceStats"][0]["runs"], 2);
    assert_eq!(value["apiCallsProtected"], 0);
    assert_eq!(value["maliciousCallsBlocked"], 0);
    assert!(value.get("userId").is_none());
    assert!(value.get("hostname").is_none());
}
