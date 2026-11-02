use serde_json::json;

use super::*;

#[test]
fn get_options_decode_allow_list_and_user_verification() {
    let parsed = parse_get_options(&json!({
        "challenge": "Y2hhbGxlbmdl",
        "allowCredentials": [
            { "type": "public-key", "id": "AQID", "transports": ["usb", "nfc"] },
            { "type": "something-else", "id": "BAUG" },
            { "id": "BwgJ" }
        ],
        "userVerification": "required"
    }))
    .unwrap();
    assert_eq!(parsed.user_verification, Requirement::Required);
    assert_eq!(
        parsed.allow_credentials,
        vec![
            CredentialDescriptor {
                id: vec![1, 2, 3],
                transports: vec!["usb".into(), "nfc".into()],
            },
            CredentialDescriptor {
                id: vec![7, 8, 9],
                transports: Vec::new(),
            },
        ]
    );
}

#[test]
fn get_options_fall_back_to_the_webauthn_defaults() {
    let parsed = parse_get_options(&json!({ "userVerification": "sometimes" })).unwrap();
    assert_eq!(parsed.user_verification, Requirement::Preferred);
    assert!(parsed.allow_credentials.is_empty());
}

#[test]
fn malformed_credential_ids_are_refused() {
    for bad in [
        json!("not an array"),
        json!([{ "id": "" }]),
        json!([{ "id": "%%%" }]),
    ] {
        let error = parse_get_options(&json!({ "allowCredentials": bad })).unwrap_err();
        assert!(error.to_string().starts_with("invalid"), "{error}");
    }
}

fn create_options() -> serde_json::Value {
    json!({
        "challenge": "Y2hhbGxlbmdl",
        "rp": { "id": "example.com", "name": "Example" },
        "user": { "id": "dXNlcg", "name": "me@example.com", "displayName": "Me" },
        "pubKeyCredParams": [
            { "type": "public-key", "alg": -7 },
            { "type": "public-key", "alg": -7 },
            { "type": "other", "alg": -8 },
            { "type": "public-key", "alg": -257 }
        ],
        "excludeCredentials": [{ "type": "public-key", "id": "AQID" }],
        "authenticatorSelection": { "residentKey": "preferred", "userVerification": "discouraged" },
        "attestation": "direct"
    })
}

#[test]
fn create_options_decode_every_field() {
    let parsed = parse_make_options(&create_options()).unwrap();
    assert_eq!(parsed.rp_name.as_deref(), Some("Example"));
    assert_eq!(
        parsed.user,
        UserEntity {
            id: b"user".to_vec(),
            name: Some("me@example.com".into()),
            display_name: Some("Me".into()),
        }
    );
    assert_eq!(parsed.algorithms, vec![-7, -257]);
    assert_eq!(parsed.exclude_credentials.len(), 1);
    assert_eq!(parsed.resident_key, Requirement::Preferred);
    assert_eq!(parsed.user_verification, Requirement::Discouraged);
    assert_eq!(parsed.attestation, Attestation::Direct);
}

#[test]
fn legacy_require_resident_key_still_means_required() {
    let mut options = create_options();
    options["authenticatorSelection"] = json!({ "requireResidentKey": true });
    let parsed = parse_make_options(&options).unwrap();
    assert_eq!(parsed.resident_key, Requirement::Required);
    assert_eq!(parsed.user_verification, Requirement::Preferred);

    options
        .as_object_mut()
        .unwrap()
        .remove("authenticatorSelection");
    options.as_object_mut().unwrap().remove("attestation");
    let parsed = parse_make_options(&options).unwrap();
    assert_eq!(parsed.resident_key, Requirement::Discouraged);
    assert_eq!(parsed.attestation, Attestation::None);
}

#[test]
fn empty_algorithm_list_uses_es256_and_rs256() {
    let mut options = create_options();
    options["pubKeyCredParams"] = json!([]);
    assert_eq!(
        parse_make_options(&options).unwrap().algorithms,
        vec![-7, -257]
    );
    options["pubKeyCredParams"] = json!([{ "type": "other", "alg": -7 }]);
    let error = parse_make_options(&options).unwrap_err();
    assert!(error.to_string().starts_with("unsupported"), "{error}");
}

#[test]
fn create_needs_a_bounded_user_id() {
    let mut options = create_options();
    options["user"]["id"] = json!("");
    assert!(matches!(
        parse_make_options(&options),
        Err(KeyError::Invalid(_))
    ));
    options["user"]["id"] = json!(ryu_webauthn_relay::b64url_encode(&[7u8; 65]));
    assert!(matches!(
        parse_make_options(&options),
        Err(KeyError::Invalid(_))
    ));
    options.as_object_mut().unwrap().remove("user");
    assert!(matches!(
        parse_make_options(&options),
        Err(KeyError::Invalid(_))
    ));
}

#[test]
fn platform_authenticators_are_refused() {
    let mut options = create_options();
    options["authenticatorSelection"] = json!({ "authenticatorAttachment": "platform" });
    let error = parse_make_options(&options).unwrap_err();
    assert!(matches!(error, KeyError::Unsupported(_)));
    options["authenticatorSelection"] = json!({ "authenticatorAttachment": "cross-platform" });
    assert!(parse_make_options(&options).is_ok());
}
