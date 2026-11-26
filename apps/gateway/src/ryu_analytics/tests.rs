use super::{
    diagnostics_relay_enabled, endpoint, read_relay_token, read_relay_token_with, relay_client,
    truthy, GatewayAnalyticsRelayFile, ModelCallEvent,
};

#[test]
fn relay_client_is_one_shared_instance() {
    assert!(std::ptr::eq(relay_client(), relay_client()));
    let from_other_thread =
        std::thread::spawn(|| relay_client() as *const reqwest::Client as usize)
            .join()
            .expect("join relay client thread");
    assert_eq!(
        from_other_thread,
        relay_client() as *const reqwest::Client as usize
    );
}

#[test]
fn hosted_and_local_gates_parse_explicit_values() {
    assert!(truthy(" true "));
    assert!(truthy("1"));
    assert!(!truthy("false"));
    assert!(!truthy(""));
}

#[test]
fn node_relay_requires_diagnostics_consent_and_destination() {
    assert!(diagnostics_relay_enabled("true", "https://posthog.example"));
    assert!(!diagnostics_relay_enabled("0", "https://posthog.example"));
    assert!(!diagnostics_relay_enabled("1", ""));
    assert!(!diagnostics_relay_enabled("", ""));
}

#[test]
fn endpoint_adds_the_relay_path_once() {
    assert_eq!(
        endpoint("https://api.example/"),
        "https://api.example/api/telemetry/ryu"
    );
    assert_eq!(
        endpoint("https://api.example/api/telemetry/ryu"),
        "https://api.example/api/telemetry/ryu"
    );
}

#[test]
fn core_relay_config_reads_only_the_expected_token_file() {
    let directory =
        std::env::temp_dir().join(format!("ryu-gateway-analytics-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("create test directory");
    let relay_token_path = directory.join("gateway-relay.token");
    std::fs::write(&relay_token_path, "relay-token\n").expect("write test token");
    let serialized = serde_json::json!({
        "status": "enabled",
        "url": "https://api.example/api/telemetry/ryu",
        "relay_token_path": relay_token_path.to_string_lossy(),
    });
    let parsed: GatewayAnalyticsRelayFile =
        serde_json::from_value(serialized).expect("parse relay config");

    let GatewayAnalyticsRelayFile::Enabled {
        url,
        relay_token_path,
    } = parsed
    else {
        panic!("enabled relay config should stay enabled");
    };
    assert_eq!(url, "https://api.example/api/telemetry/ryu");
    assert_eq!(
        read_relay_token(&relay_token_path).as_deref(),
        Some("relay-token")
    );
    assert_eq!(read_relay_token("/tmp/not-a-relay-token"), None);

    std::fs::remove_file(&relay_token_path).expect("remove test token");
    std::fs::remove_dir(directory).expect("remove test directory");
}

#[test]
fn sealed_relay_token_opens_only_with_the_gateway_key() {
    let directory =
        std::env::temp_dir().join(format!("ryu-gateway-sealed-relay-{}", uuid::Uuid::new_v4()));
    let path = directory.join("gateway-relay.token");
    let sealer = ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    )
    .unwrap();
    ryu_crypto::write_secret_file(&path, "rgw_relay_sealed_token", &sealer).unwrap();
    let path = path.to_string_lossy().into_owned();
    assert_eq!(
        read_relay_token_with(&path, Some(&sealer)).as_deref(),
        Some("rgw_relay_sealed_token")
    );
    assert_eq!(read_relay_token_with(&path, None), None);
    let master = ryu_crypto::FieldCipher::new(&[1u8; 32]);
    assert_eq!(read_relay_token_with(&path, Some(&master)), None);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn model_event_wire_shape_is_content_free() {
    let event = ModelCallEvent {
        kind: "gateway_model_call",
        event_id: "event".to_owned(),
        operation: "chat".to_owned(),
        provider: "provider".to_owned(),
        model: "model".to_owned(),
        input_tokens: 1,
        output_tokens: 2,
        latency_ms: 3,
        outcome: "error",
        error_code: Some("all_providers_unavailable".to_owned()),
        service_version: "0.2.0",
    };
    let value = serde_json::to_value(event).expect("serialize event");
    assert_eq!(value["kind"], "gateway_model_call");
    assert_eq!(value["errorCode"], "all_providers_unavailable");
    assert!(value.get("prompt").is_none());
    assert!(value.get("requestId").is_none());
}
