use super::*;

#[test]
fn core_key_write_parses_with_safe_inworld_defaults_and_multiple_keys() {
    let providers: ProvidersConfig =
        toml::from_str("[inworld]\napi_key = \"primary\"\napi_keys = [\"primary\", \"extra\"]\n")
            .unwrap();
    let config = providers.inworld.unwrap();
    assert_eq!(config.base_url, "https://api.inworld.ai");
    assert_eq!(config.all_keys(), vec!["primary", "extra"]);
}

#[test]
fn core_key_write_parses_with_safe_assemblyai_defaults() {
    let providers: ProvidersConfig =
        toml::from_str("[assemblyai]\napi_key = \"test-key\"\n").unwrap();
    let config = providers.assemblyai.unwrap();
    assert_eq!(config.base_url, "https://api.assemblyai.com");
    assert_eq!(config.poll_interval_ms, 1500);
    assert_eq!(config.poll_timeout_secs, 180);
    assert_eq!(config.all_keys(), vec!["test-key"]);
}
