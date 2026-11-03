use super::{ChannelsConfig, PhoneCallLineConfig, PhoneCallsConfig};

fn line(id: &str, number: &str) -> PhoneCallLineConfig {
    PhoneCallLineConfig {
        id: id.to_owned(),
        label: "Personal".to_owned(),
        twilio_number: number.to_owned(),
        caller_id: "+14155550100".to_owned(),
        agent_id: Some("assistant.main".to_owned()),
        tts_engine: None,
        tts_voice: None,
        transfer_to: Some("+14155550101".to_owned()),
        greeting: "Keep it concise".to_owned(),
        allowed_callers: Vec::new(),
        max_concurrent_calls: None,
    }
}

#[test]
fn phone_lines_validate_caller_allowlist_and_concurrency_cap() {
    let mut guarded = line("personal", "+14155550123");
    guarded.allowed_callers = vec!["+14155550199".to_owned()];
    guarded.max_concurrent_calls = Some(1);
    let config = PhoneCallsConfig {
        enabled: true,
        lines: vec![guarded.clone()],
    };
    assert!(config.validate().is_ok());
    assert!(guarded.accepts_caller("+14155550199"));
    assert!(!guarded.accepts_caller("+14155550100"));
    assert_eq!(guarded.concurrent_call_limit(), 1);

    let open = line("open", "+14155550124");
    assert!(open.accepts_caller("+14155550100"));
    assert!(!open.lists_caller("+14155550100"));
    assert_eq!(
        open.concurrent_call_limit(),
        super::DEFAULT_PHONE_LINE_MAX_CONCURRENT_CALLS as usize
    );

    for bad in [
        {
            let mut bad = guarded.clone();
            bad.allowed_callers = vec!["4155550199".to_owned()];
            bad
        },
        {
            let mut bad = guarded.clone();
            bad.max_concurrent_calls = Some(0);
            bad
        },
        {
            let mut bad = guarded.clone();
            bad.max_concurrent_calls = Some(21);
            bad
        },
    ] {
        let config = PhoneCallsConfig {
            enabled: true,
            lines: vec![bad],
        };
        assert!(config.validate().is_err());
    }
}

#[test]
fn disabled_empty_phone_policy_keeps_existing_gateway_toml_compact() {
    let channels = toml::to_string(&ChannelsConfig::default()).unwrap();
    assert!(!channels.contains("phone_calls"));
}

#[test]
fn phone_lines_validate_ids_numbers_and_bounds() {
    let valid = PhoneCallsConfig {
        enabled: true,
        lines: vec![line("personal", "+14155550123")],
    };
    assert!(valid.validate().is_ok());

    let duplicate_numbers = PhoneCallsConfig {
        enabled: true,
        lines: vec![line("one", "+14155550123"), line("two", "+14155550123")],
    };
    assert!(duplicate_numbers.validate().is_err());

    let invalid_number = PhoneCallsConfig {
        enabled: true,
        lines: vec![line("personal", "4155550123")],
    };
    assert!(invalid_number.validate().is_err());
}

#[test]
fn inbound_only_line_can_omit_a_verified_caller_id() {
    let mut inbound_only = line("personal", "+14155550123");
    inbound_only.caller_id.clear();
    let config = PhoneCallsConfig {
        enabled: true,
        lines: vec![inbound_only],
    };
    assert!(config.validate().is_ok());
}
