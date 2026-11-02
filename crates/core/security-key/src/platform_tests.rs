use serde_json::json;

use crate::*;

fn assertion_args() -> AssertionArgs {
    AssertionArgs {
        rp_id: "example.com".to_owned(),
        origin: "https://example.com".to_owned(),
        client_data_json: b"{}".to_vec(),
        client_data_hash: [0; 32],
        options: parse_get_options(&json!({})).unwrap(),
        timeout_ms: 30_000,
        pin: None,
    }
}

fn registration_args() -> RegistrationArgs {
    RegistrationArgs {
        rp_id: "example.com".to_owned(),
        origin: "https://example.com".to_owned(),
        client_data_json: b"{}".to_vec(),
        client_data_hash: [0; 32],
        options: parse_make_options(&json!({
            "user": { "id": "dXNlcg", "name": "me", "displayName": "Me" },
            "pubKeyCredParams": []
        }))
        .unwrap(),
        timeout_ms: 30_000,
        pin: None,
    }
}

#[test]
fn unavailable_reports_its_reason_and_refuses_both_ceremonies() {
    let key = Unavailable {
        reason: "off".to_owned(),
    };
    let availability = key.availability();
    assert!(!availability.available);
    assert_eq!(availability.platform, std::env::consts::OS);
    assert_eq!(availability.reason.as_deref(), Some("off"));
    assert_eq!(
        key.get_assertion(&assertion_args()),
        Err(KeyError::Unavailable("off".to_owned()))
    );
    assert_eq!(
        key.make_credential(&registration_args()),
        Err(KeyError::Unavailable("off".to_owned()))
    );
}

#[test]
fn availability_serializes_for_the_desktop() {
    let value = serde_json::to_value(
        Unavailable {
            reason: "off".into(),
        }
        .availability(),
    )
    .unwrap();
    assert_eq!(value["available"], json!(false));
    assert_eq!(value["reason"], json!("off"));
    assert!(value["platform"].is_string());
}

#[cfg(not(feature = "native"))]
#[test]
fn a_build_without_native_support_reports_why() {
    let key = platform_authenticator(None);
    let availability = key.availability();
    assert!(!availability.available);
    assert_eq!(
        availability.reason.as_deref(),
        Some("this build has no security key support")
    );
    assert_eq!(
        key.get_assertion(&assertion_args()),
        Err(KeyError::Unavailable(
            "this build has no security key support".to_owned()
        ))
    );
    assert_eq!(
        key.make_credential(&registration_args()),
        Err(KeyError::Unavailable(
            "this build has no security key support".to_owned()
        ))
    );
}
