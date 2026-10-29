use super::{is_e164, outbound_caller_id, outbound_opening_prompt, valid_call_sid, xml_escape};
use crate::config::PhoneCallLineConfig;

#[test]
fn phone_number_and_twilio_sid_validation_are_strict() {
    assert!(is_e164("+14155550123"));
    assert!(!is_e164("4155550123"));
    assert!(!is_e164("+1abc5550123"));
    assert!(valid_call_sid("CA1234567890abcdef1234567890abcdef"));
    assert!(!valid_call_sid("CA123"));
}

#[test]
fn outbound_prompt_discloses_assistant_and_handoff_rule() {
    let line = PhoneCallLineConfig {
        label: "Ryu Service Desk".to_owned(),
        transfer_to: Some("+14155550111".to_owned()),
        ..PhoneCallLineConfig::default()
    };
    let prompt = outbound_opening_prompt(&line, "Reschedule the repair to Friday");
    assert!(prompt.contains("AI phone assistant"));
    assert!(prompt.contains("Reschedule the repair to Friday"));
    assert!(prompt.contains("+14155550111"));
}

#[test]
fn empty_caller_id_uses_the_line_twilio_number() {
    let line = PhoneCallLineConfig {
        twilio_number: "+14155550123".to_owned(),
        caller_id: String::new(),
        ..PhoneCallLineConfig::default()
    };
    assert_eq!(outbound_caller_id(&line), "+14155550123");
}

#[test]
fn handoff_twiml_values_cannot_close_their_attribute_or_add_elements() {
    assert_eq!(
        xml_escape("+1555\"><Dial>'&"),
        "+1555&quot;&gt;&lt;Dial&gt;&apos;&amp;"
    );
}
