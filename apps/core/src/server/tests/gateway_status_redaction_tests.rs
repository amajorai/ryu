use crate::server::redact_gateway_config;

#[test]
fn masks_prefixed_provider_credentials_and_preserves_account_settings() {
    let mut config: toml::Value = toml::from_str(
        r#"
                [providers.genai]
                gemini_api_keys = ["sdk-secret-first", "sdk-secret-second"]
                [providers.example]
                UPSTREAM_API_KEY = "sdk-secret-primary"
                upstream_api_keys = ["sdk-secret-extra"]
                model = "safe-model"
                enabled = true
                priority = 10
            "#,
    )
    .unwrap();
    redact_gateway_config(&mut config);
    assert!(!toml::to_string(&config).unwrap().contains("sdk-secret"));
    let provider = &config["providers"]["example"];
    assert_eq!(provider["model"].as_str(), Some("safe-model"));
    assert_eq!(provider["enabled"].as_bool(), Some(true));
    assert_eq!(provider["priority"].as_integer(), Some(10));
    assert_eq!(
        config["providers"]["genai"]["gemini_api_keys"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn persisted_gateway_credentials_are_redacted_before_status_serialization() {
    let mut config: toml::Value = toml::from_str(
        r#"
                [providers.openai]
                api_key = "openai-secret"
                api_keys = ["openai-extra"]

                [providers.core]
                token = "core-secret"

                [providers.genai.keys]
                gemini = "gemini-secret"

                [auth]
                master_key = "master-secret"

                [[auth.api_keys]]
                name = "forwarder"
                key = "forwarder-secret"
                trusted_forwarder = true

                [firewall]
                enabled = true
            "#,
    )
    .expect("test gateway config parses");

    redact_gateway_config(&mut config);

    let json = serde_json::to_value(config).expect("redacted gateway config serializes");
    let body = json.to_string();
    for secret in [
        "openai-secret",
        "openai-extra",
        "core-secret",
        "gemini-secret",
        "master-secret",
        "forwarder-secret",
    ] {
        assert!(!body.contains(secret), "status response leaked {secret}");
    }
    assert_eq!(json["providers"]["openai"]["api_key"], "***");
    assert_eq!(json["providers"]["openai"]["api_keys"][0], "***");
    assert_eq!(json["providers"]["core"]["token"], "***");
    assert_eq!(json["providers"]["genai"]["keys"]["gemini"], "***");
    assert_eq!(json["auth"]["master_key"], "***");
    assert_eq!(json["auth"]["api_keys"][0]["name"], "forwarder");
    assert_eq!(json["auth"]["api_keys"][0]["key"], "***");
    assert_eq!(json["auth"]["api_keys"][0]["trusted_forwarder"], true);
    assert_eq!(json["firewall"]["enabled"], true);
}

#[test]
fn channel_speech_service_and_sealed_values_are_redacted() {
    let mut config: toml::Value = toml::from_str(
        r#"
                [[providers.polly.accounts]]
                access_key_id = "AKIA-secret"
                secret_access_key = "polly-secret"
                session_token = "polly-session-secret"
                region = "us-east-1"

                [channels.slack]
                app_token = "xapp-secret"
                bot_token = "xoxb-secret"

                [channels.whatsapp]
                verify_token = "wa-verify-secret"
                app_secret = "wa-app-secret"

                [control_plane]
                gateway_key = "cp-secret"

                [credits]
                internal_secret = "credits-secret"

                [unknown_future]
                odd_name = "encc:v1:c2VhbGVkLXNlY3JldA=="
            "#,
    )
    .unwrap();
    redact_gateway_config(&mut config);
    let body = toml::to_string(&config).unwrap();
    for value in [
        "AKIA-secret",
        "polly-secret",
        "polly-session-secret",
        "xapp-secret",
        "xoxb-secret",
        "wa-verify-secret",
        "wa-app-secret",
        "cp-secret",
        "credits-secret",
        "encc:v1:",
    ] {
        assert!(!body.contains(value), "status response leaked {value}");
    }
    assert_eq!(
        config["providers"]["polly"]["accounts"][0]["region"].as_str(),
        Some("us-east-1")
    );
}
