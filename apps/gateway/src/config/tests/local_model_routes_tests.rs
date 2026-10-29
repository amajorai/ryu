use super::{parse_local_model_routes, LocalProviderConfig};

#[test]
fn captured_routes_apply_and_change_the_reload_identity() {
    use super::provider_environment::ProviderEnvironment;
    use super::GatewayConfig;
    use std::collections::BTreeMap;

    let mut values = BTreeMap::from([
        (
            "LOCAL_LLM_URL".to_owned(),
            "http://127.0.0.1:11434/v1".to_owned(),
        ),
        (
            "RYU_LOCAL_MODEL_ROUTES".to_owned(),
            r#"{"llama3.2":"first-instance"}"#.to_owned(),
        ),
    ]);
    let first = ProviderEnvironment::from_values(values.clone());
    let mut config = GatewayConfig::default();
    first
        .apply(&mut config)
        .expect("apply captured environment");
    assert_eq!(
        config
            .providers
            .local
            .as_ref()
            .expect("local provider")
            .model_routes["llama3.2"],
        "first-instance"
    );

    values.insert(
        "RYU_LOCAL_MODEL_ROUTES".to_owned(),
        r#"{"llama3.2":"second-instance"}"#.to_owned(),
    );
    let second = ProviderEnvironment::from_values(values);
    assert_ne!(first.identity(), second.identity());
    second
        .apply(&mut config)
        .expect("apply reloaded environment");
    assert_eq!(
        config
            .providers
            .local
            .as_ref()
            .expect("local provider")
            .model_routes["llama3.2"],
        "second-instance"
    );
}

#[test]
fn parses_routes_and_drops_blank_entries() {
    let routes = parse_local_model_routes(r#"{"llama3.2":"ryu-llama3.2-abc","":"x","qwen":" "}"#);
    assert_eq!(routes.len(), 1);
    assert_eq!(routes["llama3.2"], "ryu-llama3.2-abc");
}

#[test]
fn malformed_routes_yield_none() {
    assert!(parse_local_model_routes("not json").is_empty());
    assert!(parse_local_model_routes(r#"{"a":1}"#).is_empty());
}

#[test]
fn routes_are_never_serialized_to_the_config_file() {
    let cfg = LocalProviderConfig {
        base_url: "http://127.0.0.1:11434/v1".to_owned(),
        model_routes: parse_local_model_routes(r#"{"a":"b"}"#),
    };
    let out = toml::to_string(&cfg).expect("serialize");
    assert!(!out.contains("model_routes"), "{out}");
    let back: LocalProviderConfig = toml::from_str(&out).expect("parse");
    assert!(back.model_routes.is_empty());
}
