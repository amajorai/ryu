use super::{ApiKeyConfig, ApiKeyOperation, ApiKeyPurpose};

fn relay_key() -> ApiKeyConfig {
    ApiKeyConfig {
        allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
        key: "sk-relay".to_owned(),
        name: "relay".to_owned(),
        org_id: None,
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: false,
    }
}

#[test]
fn static_keys_are_inference_relays_not_admin_keys() {
    let key = relay_key();
    assert_eq!(key.purpose(), ApiKeyPurpose::InferenceRelay);
    assert!(key.allows_operation(ApiKeyOperation::Inference));
}

#[test]
fn legacy_keys_do_not_implicitly_gain_web_permissions() {
    let key: ApiKeyConfig =
        serde_json::from_value(serde_json::json!({"key":"synthetic-client-key","name":"legacy"}))
            .unwrap();
    assert!(key.allows_operation(ApiKeyOperation::Inference));
    assert!(!key.allows_operation(ApiKeyOperation::WebSearch));
    assert!(!key.allows_operation(ApiKeyOperation::WebFetch));
    let mut web = key;
    web.allowed_operations = vec![ApiKeyOperation::WebSearch];
    assert!(web.validate_operations().is_ok());
    assert!(web.allows_operation(ApiKeyOperation::WebSearch));
    assert!(!web.allows_operation(ApiKeyOperation::Inference));
    web.name = "local-core".to_owned();
    assert!(web.validate_operations().is_err());
    assert!(!web.allows_operation(ApiKeyOperation::WebSearch));
}

#[test]
fn operation_lists_reject_duplicates_empty_and_unknown_grants() {
    let mut key = relay_key();
    key.allowed_operations.clear();
    assert!(key.validate_operations().is_err());
    key.allowed_operations = vec![ApiKeyOperation::WebFetch, ApiKeyOperation::WebFetch];
    assert!(key.validate_operations().is_err());
    assert!(serde_json::from_value::<ApiKeyConfig>(serde_json::json!({"key":"synthetic-client-key","name":"bad","allowed_operations":["admin"]})).is_err());
}
