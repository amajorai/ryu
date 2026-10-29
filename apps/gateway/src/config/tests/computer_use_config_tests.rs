use super::{ComputerUseConfig, GatewayConfig};

#[test]
fn locked_use_defaults_off_and_round_trips() {
    let mut config = GatewayConfig::default();
    assert!(!config.computer_use.locked_use);

    config.computer_use = ComputerUseConfig {
        locked_use: true,
        ..ComputerUseConfig::default()
    };
    let encoded = toml::to_string(&config).expect("serialize gateway config");
    let decoded: GatewayConfig = toml::from_str(&encoded).expect("deserialize gateway config");
    assert!(decoded.computer_use.locked_use);
}

#[test]
fn missing_computer_use_section_keeps_locked_use_disabled() {
    let decoded: GatewayConfig =
        toml::from_str("[auth]\nrequire_auth = false\n").expect("partial gateway config parses");
    assert!(!decoded.computer_use.locked_use);
    assert!(!decoded.computer_use.security_key);
}

#[test]
fn security_key_defaults_off_and_round_trips() {
    let mut config = GatewayConfig::default();
    assert!(!config.computer_use.security_key);

    config.computer_use = ComputerUseConfig {
        security_key: true,
        ..ComputerUseConfig::default()
    };
    let encoded = toml::to_string(&config).expect("serialize gateway config");
    let decoded: GatewayConfig = toml::from_str(&encoded).expect("deserialize gateway config");
    assert!(decoded.computer_use.security_key);
    assert!(!decoded.computer_use.locked_use);
}

#[test]
fn legacy_computer_use_section_without_security_key_parses() {
    let decoded: GatewayConfig = toml::from_str("[computer_use]\nlocked_use = true\n")
        .expect("legacy computer_use section parses");
    assert!(decoded.computer_use.locked_use);
    assert!(!decoded.computer_use.security_key);
}
