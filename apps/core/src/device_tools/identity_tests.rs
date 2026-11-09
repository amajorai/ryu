use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::pkcs8::EncodePublicKey as _;

use super::identity::{
    canonical_string, decode_public_key, replay_key, verify_request, verify_signature,
    DevicePrincipal, SignatureError, SignedHeaders,
};

/// A deterministic test device key: `(signing key, base64 DER SPKI)`.
pub(crate) fn test_key(seed: u8) -> (p256::ecdsa::SigningKey, String) {
    let secret = p256::SecretKey::from_slice(&[seed.max(1); 32]).expect("valid scalar");
    let signing = p256::ecdsa::SigningKey::from(secret);
    let spki = signing.verifying_key().to_public_key_der().expect("spki");
    (
        signing,
        base64::engine::general_purpose::STANDARD.encode(spki.as_bytes()),
    )
}

/// Base64 DER ECDSA signature over `message`.
pub(crate) fn sign_b64(key: &p256::ecdsa::SigningKey, message: &str) -> String {
    let signature: p256::ecdsa::Signature = key.sign(message.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(signature.to_der().as_bytes())
}

#[test]
fn canonical_string_binds_route_principal_device_time_and_body() {
    let text = canonical_string(
        "post",
        "/api/device-tools/claim",
        "user:u1",
        "dev-1",
        42,
        b"{}",
    );
    assert_eq!(
        text,
        "ryu-device-v1\nPOST\n/api/device-tools/claim\nuser:u1\ndev-1\n42\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
}

#[test]
fn der_and_raw_signatures_verify_and_tampering_fails() {
    let (key, spki) = test_key(3);
    let der = decode_public_key(&spki).expect("valid spki");
    let sig = sign_b64(&key, "hello");
    assert!(verify_signature(&der, b"hello", &sig));
    assert!(!verify_signature(&der, b"hellO", &sig));
    let raw: p256::ecdsa::Signature = key.sign(b"hello");
    let raw_b64 = base64::engine::general_purpose::STANDARD.encode(raw.to_bytes());
    assert!(verify_signature(&der, b"hello", &raw_b64));
    assert!(decode_public_key("bm90IGEga2V5").is_none());
}

#[test]
fn stale_replayed_unpaired_and_forged_requests_are_refused() {
    let (key, spki) = test_key(4);
    let der = decode_public_key(&spki).unwrap();
    let now = 1_800_000_000_000;
    let device = uuid::Uuid::new_v4().to_string();
    let sign_at = |ts: i64| SignedHeaders {
        device_id: device.clone(),
        timestamp_ms: ts,
        signature: sign_b64(
            &key,
            &canonical_string("POST", "/r", "user:u1", &device, ts, b"body"),
        ),
    };
    let fresh = sign_at(now);
    assert!(verify_request(&fresh, "POST", "/r", "user:u1", Some(&der), b"body", now).is_ok());
    assert_eq!(
        verify_request(&fresh, "POST", "/r", "user:u1", Some(&der), b"body", now),
        Err(SignatureError::Replayed)
    );
    let stale = sign_at(now - 121_000);
    assert_eq!(
        verify_request(&stale, "POST", "/r", "user:u1", Some(&der), b"body", now),
        Err(SignatureError::Stale)
    );
    let other = sign_at(now + 1);
    assert_eq!(
        verify_request(&other, "POST", "/r", "user:u1", None, b"body", now),
        Err(SignatureError::NotPaired)
    );
    assert_eq!(
        verify_request(&other, "POST", "/r", "user:u2", Some(&der), b"body", now),
        Err(SignatureError::BadSignature)
    );
    assert_eq!(
        verify_request(&other, "POST", "/r", "user:u1", Some(&der), b"other", now),
        Err(SignatureError::BadSignature)
    );
}

#[test]
fn a_re_encoded_signature_is_still_a_replay() {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
    let (key, spki) = test_key(5);
    let der = decode_public_key(&spki).unwrap();
    let now = 1_800_000_000_000;
    let device = uuid::Uuid::new_v4().to_string();
    let message = canonical_string("POST", "/r", "user:u1", &device, now, b"body");
    let signature: p256::ecdsa::Signature = key.sign(message.as_bytes());
    let (r, s) = signature.split_scalars();
    let high_s =
        p256::ecdsa::Signature::from_scalars(p256::FieldBytes::from(r), p256::FieldBytes::from(-s))
            .expect("high-S twin");
    let der_b64 = STANDARD.encode(signature.to_der().as_bytes());
    let headers = |text: String| SignedHeaders {
        device_id: device.clone(),
        timestamp_ms: now,
        signature: text,
    };
    let verify = |text: String| {
        verify_request(
            &headers(text),
            "POST",
            "/r",
            "user:u1",
            Some(&der),
            b"body",
            now,
        )
    };
    let first = verify(der_b64.clone()).expect("first use");
    let variants = [
        STANDARD.encode(signature.to_bytes()),
        URL_SAFE.encode(signature.to_der().as_bytes()),
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        STANDARD.encode(high_s.to_der().as_bytes()),
        format!("  {der_b64}  "),
    ];
    for variant in variants {
        assert_eq!(
            replay_key(&variant).as_deref(),
            Some(first.as_str()),
            "{variant}"
        );
        assert!(
            matches!(
                verify(variant.clone()),
                Err(SignatureError::Replayed | SignatureError::BadSignature)
            ),
            "{variant} must not be accepted again"
        );
    }
}

#[test]
fn ownership_is_never_none_equals_none() {
    let user = DevicePrincipal::User("u1".into());
    assert!(user.owns_conversation(Some("u1"), true));
    assert!(!user.owns_conversation(None, false));
    assert!(!user.owns_conversation(Some("u2"), false));
    assert!(DevicePrincipal::LocalOwner.owns_conversation(None, false));
    assert!(!DevicePrincipal::LocalOwner.owns_conversation(None, true));
    assert!(!DevicePrincipal::LocalOwner.owns_conversation(Some("u1"), false));
    assert_ne!(user.id(), DevicePrincipal::LocalOwner.id());
}
