use std::sync::Mutex;

use ryu_webauthn_relay::{b64url_encode, client_data_hash, CeremonyKind, CredentialResponse};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::*;

const ORIGIN: &str = "https://login.example.com";
const RP_ID: &str = "example.com";
const CHALLENGE: &str = "c2lnbi1pbi1jaGFsbGVuZ2UtMTIzNA";
const NOW: u64 = 1_000_000;

fn client_data(kind: &str) -> String {
    let body =
        json!({ "type": kind, "challenge": CHALLENGE, "origin": ORIGIN, "crossOrigin": false });
    b64url_encode(body.to_string().as_bytes())
}

fn get_request() -> PendingRelayRequest {
    PendingRelayRequest {
        id: "req-1".to_owned(),
        kind: CeremonyKind::Get,
        agent_id: Some("bot-7".to_owned()),
        page_url: "https://login.example.com/sign-in".to_owned(),
        origin: ORIGIN.to_owned(),
        rp_id: RP_ID.to_owned(),
        client_data_json: client_data("webauthn.get"),
        options: json!({
            "challenge": CHALLENGE,
            "rpId": RP_ID,
            "allowCredentials": [{ "type": "public-key", "id": "AQID" }],
            "userVerification": "preferred"
        }),
        created_at_ms: NOW - 1_000,
        expires_at_ms: NOW + 30_000,
    }
}

fn create_request() -> PendingRelayRequest {
    PendingRelayRequest {
        kind: CeremonyKind::Create,
        client_data_json: client_data("webauthn.create"),
        options: json!({
            "challenge": CHALLENGE,
            "rp": { "id": RP_ID, "name": "Example" },
            "user": { "id": "dXNlcg", "name": "me", "displayName": "Me" },
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
            "excludeCredentials": [{ "type": "public-key", "id": "CQkJ" }]
        }),
        ..get_request()
    }
}

/// authenticatorData for `rp_id` with `flags`, counter 1.
fn auth_data(rp_id: &str, flags: u8) -> String {
    let mut bytes: Vec<u8> = Sha256::digest(rp_id.as_bytes()).to_vec();
    bytes.push(flags);
    bytes.extend_from_slice(&1u32.to_be_bytes());
    b64url_encode(&bytes)
}

fn assertion(id: &[u8], data: String) -> RelayCredential {
    RelayCredential {
        id: b64url_encode(id),
        response: CredentialResponse::Assertion {
            authenticator_data: data,
            signature: b64url_encode(b"sig"),
            user_handle: Some(b64url_encode(b"user")),
        },
    }
}

fn attestation(id: &[u8]) -> RelayCredential {
    RelayCredential {
        id: b64url_encode(id),
        response: CredentialResponse::Attestation {
            attestation_object: b64url_encode(b"\xa3cfmtdnone"),
            transports: vec!["usb".to_owned()],
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Get(AssertionArgs),
    Make(RegistrationArgs),
}

struct MockKey {
    available: bool,
    answer: Result<RelayCredential, KeyError>,
    seen: Mutex<Vec<Seen>>,
}

impl MockKey {
    fn answering(answer: Result<RelayCredential, KeyError>) -> Self {
        Self {
            available: true,
            answer,
            seen: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

impl Authenticator for MockKey {
    fn availability(&self) -> Availability {
        Availability {
            available: self.available,
            platform: "test".to_owned(),
            reason: (!self.available).then(|| "no backend".to_owned()),
        }
    }

    fn get_assertion(&self, args: &AssertionArgs) -> Result<RelayCredential, KeyError> {
        self.seen.lock().unwrap().push(Seen::Get(args.clone()));
        self.answer.clone()
    }

    fn make_credential(&self, args: &RegistrationArgs) -> Result<RelayCredential, KeyError> {
        self.seen.lock().unwrap().push(Seen::Make(args.clone()));
        self.answer.clone()
    }
}

fn good_assertion() -> RelayCredential {
    assertion(&[1, 2, 3], auth_data(RP_ID, 0x01))
}

#[test]
fn sign_in_passes_validated_inputs_to_the_key_and_returns_its_answer() {
    let key = MockKey::answering(Ok(good_assertion()));
    let request = get_request();
    let credential = perform_at(&request, Some("1234".to_owned()), &key, NOW).unwrap();
    assert_eq!(credential, good_assertion());
    let calls = key.calls();
    let [Seen::Get(args)] = calls.as_slice() else {
        panic!("expected one get_assertion call, got {calls:?}");
    };
    assert_eq!(args.rp_id, RP_ID);
    assert_eq!(args.origin, ORIGIN);
    assert_eq!(
        args.client_data_hash,
        client_data_hash(&request.client_data_json).unwrap()
    );
    assert_eq!(
        args.client_data_json,
        ryu_webauthn_relay::b64url_decode(&request.client_data_json).unwrap()
    );
    assert_eq!(args.options.allow_credentials[0].id, vec![1, 2, 3]);
    assert_eq!(args.timeout_ms, 30_000);
    assert_eq!(args.pin.as_deref(), Some("1234"));
}

#[test]
fn registration_reaches_make_credential() {
    let key = MockKey::answering(Ok(attestation(&[5, 5])));
    let credential = perform_at(&create_request(), None, &key, NOW).unwrap();
    assert!(credential.matches(CeremonyKind::Create));
    let calls = key.calls();
    let [Seen::Make(args)] = calls.as_slice() else {
        panic!("expected one make_credential call");
    };
    assert_eq!(args.options.user.id, b"user".to_vec());
    assert_eq!(args.options.algorithms, vec![-7]);
    assert_eq!(args.pin, None);
}

#[test]
fn requests_that_fail_validation_never_reach_the_key() {
    let mut wrong_origin = get_request();
    wrong_origin.client_data_json = b64url_encode(
        json!({ "type": "webauthn.get", "challenge": CHALLENGE, "origin": "https://evil.com" })
            .to_string()
            .as_bytes(),
    );
    let mut foreign_rp = get_request();
    foreign_rp.rp_id = "evil.com".to_owned();
    foreign_rp.options["rpId"] = json!("evil.com");
    let mut public_suffix = get_request();
    public_suffix.rp_id = "com".to_owned();
    public_suffix.options["rpId"] = json!("com");
    let mut wrong_type = get_request();
    wrong_type.kind = CeremonyKind::Create;

    for request in [wrong_origin, foreign_rp, public_suffix, wrong_type] {
        let key = MockKey::answering(Ok(good_assertion()));
        let error = perform_at(&request, None, &key, NOW).unwrap_err();
        assert!(matches!(error, KeyError::Invalid(_)), "{error}");
        assert!(key.calls().is_empty());
    }
}

#[test]
fn an_expired_request_is_refused() {
    let key = MockKey::answering(Ok(good_assertion()));
    let request = get_request();
    let error = perform_at(&request, None, &key, request.expires_at_ms).unwrap_err();
    assert_eq!(error, KeyError::Expired);
    assert!(key.calls().is_empty());
}

#[test]
fn a_badly_formed_pin_is_refused_before_the_key_spends_an_attempt() {
    let key = MockKey::answering(Ok(good_assertion()));
    let error = perform_at(&get_request(), Some("12".to_owned()), &key, NOW).unwrap_err();
    assert!(error.to_string().starts_with("pin_required"), "{error}");
    assert!(key.calls().is_empty());
    assert!(validate_pin(&"9".repeat(PIN_MAX_BYTES + 1)).is_err());
    assert!(validate_pin("éééé").is_ok());
    // An empty PIN means none was given.
    assert!(perform_at(&get_request(), Some(String::new()), &key, NOW).is_ok());
}

#[test]
fn pin_errors_keep_the_pin_required_prefix() {
    for error in [
        KeyError::PinRequired,
        KeyError::PinInvalid { retries: Some(3) },
        KeyError::PinFormat("too short".to_owned()),
    ] {
        let key = MockKey::answering(Err(error.clone()));
        let text = perform_at(&get_request(), None, &key, NOW)
            .unwrap_err()
            .to_string();
        assert!(text.starts_with("pin_required"), "{text}");
    }
}

#[test]
fn an_unavailable_backend_is_reported_without_a_call() {
    let mut key = MockKey::answering(Ok(good_assertion()));
    key.available = false;
    let error = perform_at(&get_request(), None, &key, NOW).unwrap_err();
    assert_eq!(error, KeyError::Unavailable("no backend".to_owned()));
    assert!(key.calls().is_empty());
}

#[test]
fn an_answer_of_the_wrong_kind_is_refused() {
    let key = MockKey::answering(Ok(attestation(&[1, 2, 3])));
    assert!(matches!(
        perform_at(&get_request(), None, &key, NOW),
        Err(KeyError::Device(_))
    ));
    let key = MockKey::answering(Ok(good_assertion()));
    assert!(matches!(
        perform_at(&create_request(), None, &key, NOW),
        Err(KeyError::Device(_))
    ));
}

#[test]
fn an_assertion_must_be_for_this_site_and_an_allowed_credential() {
    let cases = [
        assertion(&[9, 9], auth_data(RP_ID, 0x01)),
        assertion(&[1, 2, 3], auth_data("evil.com", 0x01)),
        assertion(&[1, 2, 3], auth_data(RP_ID, 0x00)),
        assertion(&[1, 2, 3], b64url_encode(&[0u8; 10])),
    ];
    for answer in cases {
        let key = MockKey::answering(Ok(answer));
        let error = perform_at(&get_request(), None, &key, NOW).unwrap_err();
        assert!(matches!(error, KeyError::Device(_)), "{error}");
    }
}

#[test]
fn required_user_verification_needs_the_uv_flag() {
    let mut request = get_request();
    request.options["userVerification"] = json!("required");
    let key = MockKey::answering(Ok(good_assertion()));
    assert!(matches!(
        perform_at(&request, None, &key, NOW),
        Err(KeyError::Device(_))
    ));
    let key = MockKey::answering(Ok(assertion(&[1, 2, 3], auth_data(RP_ID, 0x05))));
    assert!(perform_at(&request, None, &key, NOW).is_ok());
}

#[test]
fn a_registration_must_not_reuse_an_excluded_credential() {
    let key = MockKey::answering(Ok(attestation(&[9, 9, 9])));
    assert_eq!(
        perform_at(&create_request(), None, &key, NOW),
        Err(KeyError::CredentialExcluded)
    );
}

#[test]
fn the_key_wait_is_capped_by_the_relay_maximum() {
    let mut request = get_request();
    request.expires_at_ms = NOW + 10 * ryu_webauthn_relay::MAX_TIMEOUT_MS;
    let key = MockKey::answering(Ok(good_assertion()));
    perform_at(&request, None, &key, NOW).unwrap();
    let calls = key.calls();
    let [Seen::Get(args)] = calls.as_slice() else {
        panic!("expected one call");
    };
    assert_eq!(args.timeout_ms, ryu_webauthn_relay::MAX_TIMEOUT_MS);
}

/// The deadline is read on the clock the caller passes (the desktop's own;
/// the UI rebases Core's deadline onto it), and what is left of it becomes
/// the key's wait.
#[test]
fn the_key_waits_only_for_what_is_left_of_the_deadline() {
    let request = get_request();
    let key = MockKey::answering(Ok(good_assertion()));
    perform_at(&request, None, &key, request.expires_at_ms - 4_000).unwrap();
    let calls = key.calls();
    let [Seen::Get(args)] = calls.as_slice() else {
        panic!("expected one call");
    };
    assert_eq!(args.timeout_ms, 4_000);
    let late = MockKey::answering(Ok(good_assertion()));
    assert_eq!(
        perform_at(&request, None, &late, request.expires_at_ms + 1),
        Err(KeyError::Expired)
    );
    assert!(late.calls().is_empty());
}

#[test]
fn an_unavailable_platform_backend_refuses_before_the_key() {
    let key = Unavailable {
        reason: "this build has no security key support".to_owned(),
    };
    for request in [get_request(), create_request()] {
        assert_eq!(
            perform_at(&request, None, &key, NOW),
            Err(KeyError::Unavailable(
                "this build has no security key support".to_owned()
            ))
        );
    }
}
