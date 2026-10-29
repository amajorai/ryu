use super::test_config_path::ConfigPathGuard;
use super::GatewayConfig;

#[test]
fn secrets_are_sealed_on_disk_and_opened_on_load() {
    let guard = ConfigPathGuard::isolated("sealed-secrets");
    let authored = "# operator note\n[auth]\nmaster_key = \"gwadm_sealed_test\"\n\n\
                    [composio]\napi_key = \"composio-sealed-test\"\n\n\
                    [channels.discord]\ntoken = \"discord-sealed-test\"\n";
    // A hand-written plaintext file loads without any migration step.
    std::fs::write(guard.path(), authored).unwrap();
    let legacy = GatewayConfig::load().unwrap();
    assert_eq!(
        legacy.composio.api_key.as_deref(),
        Some("composio-sealed-test")
    );
    // Startup migration seals it in place, keeping the comment.
    assert!(ryu_gw_credentials::sealed_config::reseal_file(guard.path()).unwrap());
    let disk = std::fs::read_to_string(guard.path()).unwrap();
    for secret in [
        "gwadm_sealed_test",
        "composio-sealed-test",
        "discord-sealed-test",
    ] {
        assert!(!disk.contains(secret), "{secret} is plaintext on disk");
    }
    assert!(disk.contains("encc:v1:"));
    assert!(disk.contains("# operator note"));
    // Every typed reader sees the plaintext again.
    let loaded = GatewayConfig::load().unwrap();
    assert_eq!(loaded.auth.master_key.as_deref(), Some("gwadm_sealed_test"));
    assert_eq!(
        loaded.composio.api_key.as_deref(),
        Some("composio-sealed-test")
    );
    assert_eq!(
        loaded
            .channels
            .discord
            .as_ref()
            .map(|discord| discord.token.as_str()),
        Some("discord-sealed-test")
    );
    let parsed = GatewayConfig::from_authored_str(&disk).unwrap();
    assert_eq!(parsed.auth.master_key, loaded.auth.master_key);
    // A tampered envelope is an error, never an empty credential.
    let tampered = disk.replacen("encc:v1:", "encc:v1:AAAA", 1);
    assert!(GatewayConfig::from_authored_str(&tampered).is_err());
}

#[test]
fn phone_line_numbers_are_sealed_on_disk_and_opened_before_validation() {
    let guard = ConfigPathGuard::isolated("sealed-phone-lines");
    let authored = "[[channels.phone_calls.lines]]\nid = \"home\"\nlabel = \"Home\"\n\
                    twilio_number = \"+14155550100\"\ncaller_id = \"+14155550101\"\n\
                    transfer_to = \"+14155550111\"\n\
                    allowed_callers = [\"+14155550122\"]\n";
    std::fs::write(guard.path(), authored).unwrap();
    // Legacy plaintext loads unchanged.
    let legacy = GatewayConfig::load().unwrap();
    assert_eq!(
        legacy.channels.phone_calls.lines[0].allowed_callers,
        vec!["+14155550122"]
    );
    // The startup reseal seals the other people's numbers only.
    assert!(ryu_gw_credentials::sealed_config::reseal_file(guard.path()).unwrap());
    let disk = std::fs::read_to_string(guard.path()).unwrap();
    assert!(
        !disk.contains("+14155550111"),
        "transfer_to is plaintext on disk"
    );
    assert!(
        !disk.contains("+14155550122"),
        "a caller is plaintext on disk"
    );
    assert!(
        disk.contains("+14155550100"),
        "the line's own number stays readable"
    );
    // Load opens them before validation and caller matching.
    let loaded = GatewayConfig::load().unwrap();
    let line = &loaded.channels.phone_calls.lines[0];
    assert_eq!(line.transfer_to.as_deref(), Some("+14155550111"));
    assert!(line.lists_caller("+14155550122"));
    loaded.channels.phone_calls.validate().unwrap();
}
