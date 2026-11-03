use serde_json::json;

use crate::*;

const ORIGIN: &str = "https://login.example.com";
const CHALLENGE: &str = "c2lnbi1pbi1jaGFsbGVuZ2UtMTIzNA";

fn client_data(kind: &str, origin: &str, challenge: &str) -> String {
    let body =
        json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false });
    b64url_encode(body.to_string().as_bytes())
}

fn get_request() -> RelayRequest {
    RelayRequest {
        kind: CeremonyKind::Get,
        agent_id: None,
        page_url: "https://login.example.com/sign-in?next=/".to_owned(),
        origin: ORIGIN.to_owned(),
        rp_id: "example.com".to_owned(),
        client_data_json: client_data("webauthn.get", ORIGIN, CHALLENGE),
        options: json!({ "challenge": CHALLENGE, "rpId": "example.com", "allowCredentials": [] }),
        timeout_ms: Some(5_000),
    }
}

#[test]
fn rp_id_may_be_the_host_or_a_registrable_parent() {
    assert!(validate_rp_id(ORIGIN, "login.example.com").is_ok());
    assert!(validate_rp_id(ORIGIN, "example.com").is_ok());
    assert!(validate_rp_id("http://localhost:3000", "localhost").is_ok());
}

#[test]
fn rp_id_must_belong_to_the_origin() {
    assert!(matches!(
        validate_rp_id(ORIGIN, "evil.com"),
        Err(RelayError::RpIdMismatch { .. })
    ));
    assert!(matches!(
        validate_rp_id(ORIGIN, "ample.com"),
        Err(RelayError::RpIdMismatch { .. })
    ));
    assert!(matches!(
        validate_rp_id(ORIGIN, "Example.com"),
        Err(RelayError::RpIdMismatch { .. })
    ));
}

#[test]
fn rp_id_must_not_be_a_public_suffix() {
    assert_eq!(
        validate_rp_id(ORIGIN, "com"),
        Err(RelayError::PublicSuffix("com".to_owned()))
    );
    assert_eq!(
        validate_rp_id("https://someone.github.io", "github.io"),
        Err(RelayError::PublicSuffix("github.io".to_owned()))
    );
}

#[test]
fn origin_must_be_secure_and_a_domain() {
    assert!(matches!(
        validate_rp_id("http://example.com", "example.com"),
        Err(RelayError::InsecureOrigin(_))
    ));
    assert!(matches!(
        validate_rp_id("https://10.0.0.1", "10.0.0.1"),
        Err(RelayError::InsecureOrigin(_))
    ));
}

#[test]
fn a_well_formed_request_validates_and_hashes_its_client_data() {
    let request = get_request();
    let validated = validate_relay(&request).expect("valid");
    assert_eq!(validated.client_data.challenge, CHALLENGE);
    assert_eq!(validated.timeout_ms, MIN_TIMEOUT_MS);
    assert_eq!(
        validated.client_data_hash,
        client_data_hash(&request.client_data_json).unwrap()
    );
}

#[test]
fn client_data_must_match_the_origin_type_and_challenge() {
    let mut wrong_origin = get_request();
    wrong_origin.client_data_json = client_data("webauthn.get", "https://evil.com", CHALLENGE);
    assert!(matches!(
        validate_relay(&wrong_origin),
        Err(RelayError::ClientData(_))
    ));

    let mut wrong_type = get_request();
    wrong_type.client_data_json = client_data("webauthn.create", ORIGIN, CHALLENGE);
    assert!(matches!(
        validate_relay(&wrong_type),
        Err(RelayError::ClientData(_))
    ));

    let mut wrong_challenge = get_request();
    wrong_challenge.options["challenge"] = json!("b3RoZXI");
    assert!(matches!(
        validate_relay(&wrong_challenge),
        Err(RelayError::Options(_))
    ));
}

#[test]
fn page_url_must_belong_to_the_claimed_origin() {
    let mut request = get_request();
    request.page_url = "https://evil.com/".to_owned();
    assert!(matches!(
        validate_relay(&request),
        Err(RelayError::PageOriginMismatch(_))
    ));
}

#[test]
fn create_needs_a_user_and_algorithms() {
    let mut request = get_request();
    request.kind = CeremonyKind::Create;
    request.client_data_json = client_data("webauthn.create", ORIGIN, CHALLENGE);
    request.options = json!({ "challenge": CHALLENGE, "rp": { "id": "example.com" } });
    assert!(matches!(
        validate_relay(&request),
        Err(RelayError::Options(_))
    ));
    request.options = json!({
        "challenge": CHALLENGE,
        "rp": { "id": "example.com", "name": "Example" },
        "user": { "id": "dXNlcg", "name": "me", "displayName": "Me" },
        "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }]
    });
    assert!(validate_relay(&request).is_ok());
}

#[test]
fn wire_shapes_are_stable() {
    let decision = RelayDecision::Approve {
        credential: RelayCredential {
            id: "aWQ".to_owned(),
            response: CredentialResponse::Assertion {
                authenticator_data: "YQ".to_owned(),
                signature: "cw".to_owned(),
                user_handle: None,
            },
        },
    };
    assert_eq!(
        serde_json::to_value(&decision).unwrap(),
        json!({ "decision": "approve", "credential": { "id": "aWQ", "response": {
            "kind": "assertion", "authenticator_data": "YQ", "signature": "cw", "user_handle": null } } })
    );
    assert_eq!(
        serde_json::to_value(RelayOutcome::Disabled).unwrap(),
        json!({ "status": "disabled" })
    );
    let deny: RelayDecision = serde_json::from_value(json!({ "decision": "deny" })).unwrap();
    assert_eq!(deny, RelayDecision::Deny { reason: None });
}

#[test]
fn credential_kind_must_match_the_ceremony() {
    let assertion = RelayCredential {
        id: "aWQ".to_owned(),
        response: CredentialResponse::Assertion {
            authenticator_data: String::new(),
            signature: String::new(),
            user_handle: None,
        },
    };
    assert!(assertion.matches(CeremonyKind::Get));
    assert!(!assertion.matches(CeremonyKind::Create));
}
