//! A2A v1 Agent Card signatures (`AgentCard.signatures`).
//!
//! The A2A v1 specification signs an Agent Card with a JWS (RFC 7515) whose
//! payload is the RFC 8785 (JCS) canonical JSON of the card **without** its
//! `signatures` member. Each entry of `signatures` carries the base64url
//! protected header and signature; the payload is detached because it is the
//! card itself. The protected header names `alg`, `typ`, and `kid`, and may
//! name a `jku` (JWKS URL) where the verifier can fetch the public key.
//!
//! Ryu signs with Ed25519 (`alg: EdDSA`, RFC 8037) and identifies keys by their
//! RFC 7638 JWK thumbprint. Verification reads `alg`, `kid`, and `jku` only from
//! the integrity-protected header; the unprotected `header` is ignored.

use std::{cmp::Ordering, fmt::Write as _};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::protocol::{AgentCard, AgentCardSignature};

/// The only JWS algorithm Ryu emits or accepts for Agent Cards.
pub const CARD_SIGNATURE_ALG: &str = "EdDSA";
/// The `typ` the A2A specification recommends for Agent Card JWS headers.
pub const CARD_SIGNATURE_TYP: &str = "JOSE";
/// Upper bound on signatures examined per card, so a hostile card cannot make
/// verification do unbounded work.
pub const MAX_CARD_SIGNATURES: usize = 8;
/// Longest `kid` accepted; Ryu's RFC 7638 thumbprints are 43 bytes.
const MAX_KID_BYTES: usize = 256;

#[derive(Debug, Error)]
pub enum CardSignatureError {
    #[error("agent card could not be serialized: {0}")]
    Serialize(String),
    #[error("agent card must be a JSON object")]
    NotAnObject,
}

/// RFC 8785 JSON Canonicalization Scheme.
///
/// Object members are sorted by their UTF-16 code units, no insignificant
/// whitespace is emitted, strings use the minimal JSON escapes, and numbers
/// use the ECMAScript `Number.prototype.toString` form of their IEEE-754
/// double value.
#[must_use]
pub fn canonicalize_json(value: &Value) -> String {
    let mut output = String::new();
    write_canonical(value, &mut output);
    output
}

fn write_canonical(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(flag) => output.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => output.push_str(&canonical_number(number)),
        Value::String(text) => write_canonical_string(text, output),
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(item, output);
            }
            output.push(']');
        }
        Value::Object(members) => {
            let mut keys = members.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| utf16_order(left, right));
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_string(key, output);
                output.push(':');
                write_canonical(&members[key], output);
            }
            output.push('}');
        }
    }
}

fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_canonical_string(text: &str, output: &mut String) {
    output.push('"');
    for character in text.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if u32::from(control) < 0x20 => {
                let _ = write!(output, "\\u{:04x}", u32::from(control));
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

/// Largest integer magnitude an IEEE-754 double represents exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn canonical_number(number: &Number) -> String {
    if let Some(value) = number.as_u64() {
        if value <= MAX_SAFE_INTEGER {
            return value.to_string();
        }
    }
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() <= MAX_SAFE_INTEGER {
            return value.to_string();
        }
    }
    // serde_json only produces finite numbers; fall back to 0 defensively.
    number
        .as_f64()
        .map_or_else(|| "0".to_owned(), ecmascript_number)
}

/// ECMAScript `Number.prototype.toString(10)` for a finite double.
fn ecmascript_number(value: f64) -> String {
    if value == 0.0 || !value.is_finite() {
        return "0".to_owned();
    }
    // `{:e}` yields the shortest round-tripping digits, e.g. `1.2345e-7`.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted
        .split_once('e')
        .expect("LowerExp output always contains an exponent");
    let exponent: i32 = exponent.parse().expect("LowerExp exponent is an integer");
    let digits = mantissa.replace('.', "");
    let digit_count = i32::try_from(digits.len()).expect("a double has at most 17 digits");
    // `point` is ECMAScript's `n`: the decimal point sits after `point` digits.
    let point = exponent + 1;
    let mut output = String::new();
    if value < 0.0 {
        output.push('-');
    }
    if digit_count <= point && point <= 21 {
        output.push_str(&digits);
        output.push_str(&"0".repeat(usize::try_from(point - digit_count).unwrap_or(0)));
    } else if 0 < point && point <= 21 {
        let split = usize::try_from(point).unwrap_or(0);
        output.push_str(&digits[..split]);
        output.push('.');
        output.push_str(&digits[split..]);
    } else if -6 < point && point <= 0 {
        output.push_str("0.");
        output.push_str(&"0".repeat(usize::try_from(-point).unwrap_or(0)));
        output.push_str(&digits);
    } else {
        output.push_str(&digits[..1]);
        if digits.len() > 1 {
            output.push('.');
            output.push_str(&digits[1..]);
        }
        let shown = point - 1;
        let _ = write!(
            output,
            "e{}{}",
            if shown < 0 { '-' } else { '+' },
            shown.abs()
        );
    }
    output
}

/// The JWS payload for a card: JCS of the card JSON without `signatures`.
pub fn agent_card_signing_payload(card: &Value) -> Result<String, CardSignatureError> {
    let mut members = card
        .as_object()
        .cloned()
        .ok_or(CardSignatureError::NotAnObject)?;
    members.remove("signatures");
    Ok(canonicalize_json(&Value::Object(members)))
}

/// RFC 7638 JWK thumbprint of an Ed25519 public key (base64url SHA-256).
#[must_use]
pub fn ed25519_jwk_thumbprint(key: &VerifyingKey) -> String {
    let required = json!({
        "crv": "Ed25519",
        "kty": "OKP",
        "x": URL_SAFE_NO_PAD.encode(key.as_bytes()),
    });
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonicalize_json(&required).as_bytes()))
}

/// The public JWK (RFC 8037 OKP) for an Ed25519 card-signing key.
#[must_use]
pub fn ed25519_public_jwk(key: &VerifyingKey) -> Value {
    json!({
        "kty": "OKP",
        "crv": "Ed25519",
        "x": URL_SAFE_NO_PAD.encode(key.as_bytes()),
        "kid": ed25519_jwk_thumbprint(key),
        "use": "sig",
        "alg": CARD_SIGNATURE_ALG,
    })
}

/// A JWKS document (`{"keys": [...]}`) publishing the given keys.
#[must_use]
pub fn ed25519_jwks(keys: &[VerifyingKey]) -> Value {
    json!({ "keys": keys.iter().map(ed25519_public_jwk).collect::<Vec<_>>() })
}

/// Ed25519 public keys from a JWKS document, keyed by `kid`.
///
/// Entries that are not Ed25519 OKP signing keys are skipped. A key without a
/// `kid` is indexed by its RFC 7638 thumbprint.
#[must_use]
pub fn ed25519_keys_from_jwks(jwks: &Value) -> Vec<(String, VerifyingKey)> {
    let Some(keys) = jwks.get("keys").and_then(Value::as_array) else {
        return Vec::new();
    };
    keys.iter()
        .filter(|jwk| {
            jwk.get("kty").and_then(Value::as_str) == Some("OKP")
                && jwk.get("crv").and_then(Value::as_str) == Some("Ed25519")
                && jwk
                    .get("use")
                    .and_then(Value::as_str)
                    .is_none_or(|purpose| purpose == "sig")
        })
        .filter_map(|jwk| {
            let bytes = URL_SAFE_NO_PAD
                .decode(jwk.get("x")?.as_str()?)
                .ok()?
                .try_into()
                .ok()?;
            let key = VerifyingKey::from_bytes(&bytes).ok()?;
            let kid = jwk
                .get("kid")
                .and_then(Value::as_str)
                .map_or_else(|| ed25519_jwk_thumbprint(&key), ToOwned::to_owned);
            Some((kid, key))
        })
        .collect()
}

/// Sign an Agent Card. The returned entry belongs in `card.signatures`; any
/// signatures already on `card` are excluded from the signed payload.
pub fn sign_agent_card(
    card: &AgentCard,
    key: &SigningKey,
    jku: Option<&str>,
) -> Result<AgentCardSignature, CardSignatureError> {
    let value = serde_json::to_value(card)
        .map_err(|error| CardSignatureError::Serialize(error.to_string()))?;
    sign_agent_card_value(&value, key, jku)
}

/// [`sign_agent_card`] over an already-serialized card.
pub fn sign_agent_card_value(
    card: &Value,
    key: &SigningKey,
    jku: Option<&str>,
) -> Result<AgentCardSignature, CardSignatureError> {
    let payload = agent_card_signing_payload(card)?;
    let mut header = Map::new();
    header.insert("alg".to_owned(), Value::from(CARD_SIGNATURE_ALG));
    header.insert("typ".to_owned(), Value::from(CARD_SIGNATURE_TYP));
    header.insert(
        "kid".to_owned(),
        Value::from(ed25519_jwk_thumbprint(&key.verifying_key())),
    );
    if let Some(jku) = jku {
        header.insert("jku".to_owned(), Value::from(jku));
    }
    let protected = URL_SAFE_NO_PAD.encode(canonicalize_json(&Value::Object(header)));
    let signature = key.sign(signing_input(&protected, &payload).as_bytes());
    Ok(AgentCardSignature {
        protected,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        header: None,
    })
}

fn signing_input(protected: &str, payload: &str) -> String {
    format!("{protected}.{}", URL_SAFE_NO_PAD.encode(payload))
}

/// The integrity-protected header fields a verifier acts on.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CardSignatureHeader {
    pub alg: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub jku: Option<String>,
    #[serde(default)]
    pub typ: Option<String>,
    #[serde(default)]
    pub crit: Option<Vec<String>>,
}

/// Decode an entry's protected header.
pub fn decode_protected_header(signature: &AgentCardSignature) -> Option<CardSignatureHeader> {
    let bytes = URL_SAFE_NO_PAD
        .decode(signature.protected.as_bytes())
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// How a verifier located (or failed to locate) the key a header names.
#[derive(Debug)]
pub enum KeyResolution {
    /// The trusted key source publishes this key under the header's `kid`.
    Found(VerifyingKey),
    /// The key source answered but does not publish the header's `kid`.
    NotPublished,
    /// No trusted key source could be consulted.
    Unavailable(String),
}

/// The outcome of checking a card's `signatures`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CardSignatureStatus {
    /// The card carries no signatures.
    Unsigned,
    /// At least one signature verified against a key from a trusted source.
    Verified {
        kid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        jku: Option<String>,
    },
    /// Signatures are present but no key could be consulted to check them.
    Unverifiable { reason: String },
    /// A signature is malformed, names an unpublished key, or does not match
    /// the card content, and no other signature verified.
    Invalid { reason: String },
}

impl CardSignatureStatus {
    #[must_use]
    pub const fn is_verified(&self) -> bool {
        matches!(self, Self::Verified { .. })
    }
}

/// Signature entries on a raw card, as received.
pub fn card_signatures(card: &Value) -> Result<Vec<AgentCardSignature>, String> {
    match card.get("signatures") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value::<Vec<AgentCardSignature>>(value.clone())
            .map_err(|_| "signatures must be an array of JWS objects".to_owned()),
    }
}

/// Verify the `signatures` on a raw Agent Card JSON value.
///
/// Verification runs over the card exactly as received (not a re-serialized
/// typed card), so members Ryu does not model still count toward the payload.
pub fn verify_agent_card_signatures(
    card: &Value,
    mut resolve_key: impl FnMut(&CardSignatureHeader) -> KeyResolution,
) -> CardSignatureStatus {
    let signatures = match card_signatures(card) {
        Ok(signatures) => signatures,
        Err(reason) => return CardSignatureStatus::Invalid { reason },
    };
    if signatures.is_empty() {
        return CardSignatureStatus::Unsigned;
    }
    let payload = match agent_card_signing_payload(card) {
        Ok(payload) => payload,
        Err(error) => {
            return CardSignatureStatus::Invalid {
                reason: error.to_string(),
            }
        }
    };
    let mut invalid = None;
    let mut unverifiable = None;
    for entry in signatures.iter().take(MAX_CARD_SIGNATURES) {
        match verify_one(entry, &payload, &mut resolve_key) {
            Ok((kid, jku)) => return CardSignatureStatus::Verified { kid, jku },
            Err(SignatureFailure::Invalid(reason)) => {
                invalid.get_or_insert(reason);
            }
            Err(SignatureFailure::Unverifiable(reason)) => {
                unverifiable.get_or_insert(reason);
            }
        }
    }
    if let Some(reason) = invalid {
        return CardSignatureStatus::Invalid { reason };
    }
    CardSignatureStatus::Unverifiable {
        reason: unverifiable.unwrap_or_else(|| "no signature could be checked".to_owned()),
    }
}

enum SignatureFailure {
    Invalid(String),
    Unverifiable(String),
}

fn verify_one(
    entry: &AgentCardSignature,
    payload: &str,
    resolve_key: &mut impl FnMut(&CardSignatureHeader) -> KeyResolution,
) -> Result<(String, Option<String>), SignatureFailure> {
    let header = decode_protected_header(entry).ok_or_else(|| {
        SignatureFailure::Invalid("signature protected header is malformed".to_owned())
    })?;
    if header.alg != CARD_SIGNATURE_ALG {
        return Err(SignatureFailure::Unverifiable(
            "signature uses an unsupported algorithm".to_owned(),
        ));
    }
    if header.crit.as_ref().is_some_and(|crit| !crit.is_empty()) {
        return Err(SignatureFailure::Unverifiable(
            "signature declares critical header parameters".to_owned(),
        ));
    }
    let kid = header
        .kid
        .clone()
        .filter(|kid| !kid.is_empty() && kid.len() <= MAX_KID_BYTES)
        .ok_or_else(|| SignatureFailure::Invalid("signature header has no valid kid".to_owned()))?;
    let key = match resolve_key(&header) {
        KeyResolution::Found(key) => key,
        KeyResolution::NotPublished => {
            return Err(SignatureFailure::Invalid(
                "signing key is not published by the key source".to_owned(),
            ))
        }
        KeyResolution::Unavailable(reason) => return Err(SignatureFailure::Unverifiable(reason)),
    };
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(entry.signature.as_bytes())
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or_else(|| SignatureFailure::Invalid("signature value is malformed".to_owned()))?;
    key.verify_strict(
        signing_input(&entry.protected, payload).as_bytes(),
        &signature_bytes,
    )
    .map_err(|_| SignatureFailure::Invalid("signature does not match the card".to_owned()))?;
    Ok((kid, header.jku))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::protocol::{AgentCapabilities, AgentInterface};

    fn sample_card() -> AgentCard {
        AgentCard {
            name: "Ryu".to_owned(),
            description: "A Ryu agent endpoint".to_owned(),
            version: "1.2.3".to_owned(),
            supported_interfaces: vec![AgentInterface::new(
                "https://node.example.com/a2a",
                "JSONRPC",
            )],
            capabilities: AgentCapabilities {
                streaming: Some(true),
                push_notifications: Some(true),
                extensions: None,
                extended_agent_card: Some(false),
            },
            default_input_modes: vec!["text/plain".to_owned()],
            default_output_modes: vec!["text/plain".to_owned()],
            skills: Vec::new(),
            provider: None,
            documentation_url: None,
            icon_url: Some("https://node.example.com/a2a-card/icon.svg".to_owned()),
            security_schemes: None,
            security_requirements: None,
            signatures: None,
        }
    }

    fn signed_card(key: &SigningKey) -> Value {
        let mut card = sample_card();
        let signature = sign_agent_card(
            &card,
            key,
            Some("https://node.example.com/a2a-card/jwks.json"),
        )
        .expect("sign card");
        card.signatures = Some(vec![signature]);
        serde_json::to_value(card).expect("serialize card")
    }

    fn resolver(
        keys: Vec<(String, VerifyingKey)>,
    ) -> impl FnMut(&CardSignatureHeader) -> KeyResolution {
        let keys = keys.into_iter().collect::<HashMap<_, _>>();
        move |header| match header.kid.as_ref().and_then(|kid| keys.get(kid)) {
            Some(key) => KeyResolution::Found(*key),
            None => KeyResolution::NotPublished,
        }
    }

    #[test]
    fn sign_then_verify_roundtrips_through_the_published_jwks() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let card = signed_card(&key);
        let jwks = ed25519_jwks(&[key.verifying_key()]);
        let status = verify_agent_card_signatures(&card, resolver(ed25519_keys_from_jwks(&jwks)));
        assert_eq!(
            status,
            CardSignatureStatus::Verified {
                kid: ed25519_jwk_thumbprint(&key.verifying_key()),
                jku: Some("https://node.example.com/a2a-card/jwks.json".to_owned()),
            }
        );
        let header = decode_protected_header(&card_signatures(&card).expect("signatures")[0])
            .expect("header");
        assert_eq!(header.alg, "EdDSA");
        assert_eq!(header.typ.as_deref(), Some("JOSE"));
    }

    #[test]
    fn tampered_card_is_rejected() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let mut card = signed_card(&key);
        card["name"] = Value::from("Impostor");
        let status = verify_agent_card_signatures(
            &card,
            resolver(vec![(
                ed25519_jwk_thumbprint(&key.verifying_key()),
                key.verifying_key(),
            )]),
        );
        assert!(
            matches!(status, CardSignatureStatus::Invalid { .. }),
            "{status:?}"
        );

        let mut card = signed_card(&key);
        card["supportedInterfaces"][0]["url"] = Value::from("https://attacker.example/a2a");
        let status = verify_agent_card_signatures(
            &card,
            resolver(vec![(
                ed25519_jwk_thumbprint(&key.verifying_key()),
                key.verifying_key(),
            )]),
        );
        assert!(
            matches!(status, CardSignatureStatus::Invalid { .. }),
            "{status:?}"
        );
    }

    #[test]
    fn key_mismatch_is_rejected() {
        let signer = SigningKey::from_bytes(&[0x41; 32]);
        let other = SigningKey::from_bytes(&[0x42; 32]);
        let card = signed_card(&signer);
        // The JWKS claims the signer's kid but publishes a different key.
        let status = verify_agent_card_signatures(
            &card,
            resolver(vec![(
                ed25519_jwk_thumbprint(&signer.verifying_key()),
                other.verifying_key(),
            )]),
        );
        assert_eq!(
            status,
            CardSignatureStatus::Invalid {
                reason: "signature does not match the card".to_owned()
            }
        );
        // The JWKS does not publish the signer's kid at all.
        let jwks = ed25519_jwks(&[other.verifying_key()]);
        let status = verify_agent_card_signatures(&card, resolver(ed25519_keys_from_jwks(&jwks)));
        assert!(
            matches!(status, CardSignatureStatus::Invalid { .. }),
            "{status:?}"
        );
    }

    #[test]
    fn unsigned_and_unverifiable_cards_are_distinguished() {
        let unsigned = serde_json::to_value(sample_card()).expect("card");
        assert_eq!(
            verify_agent_card_signatures(&unsigned, |_| KeyResolution::NotPublished),
            CardSignatureStatus::Unsigned
        );
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let card = signed_card(&key);
        assert!(matches!(
            verify_agent_card_signatures(&card, |_| KeyResolution::Unavailable("offline".into())),
            CardSignatureStatus::Unverifiable { .. }
        ));
        let mut malformed = card;
        malformed["signatures"] = Value::from("not-an-array");
        assert!(matches!(
            verify_agent_card_signatures(&malformed, |_| KeyResolution::NotPublished),
            CardSignatureStatus::Invalid { .. }
        ));
    }

    #[test]
    fn unprotected_header_cannot_redirect_the_key_lookup() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let mut card = signed_card(&key);
        card["signatures"][0]["header"] =
            json!({"kid": "attacker", "jku": "https://attacker.example/jwks"});
        let status = verify_agent_card_signatures(&card, |header| {
            assert_ne!(header.kid.as_deref(), Some("attacker"));
            assert_ne!(header.jku.as_deref(), Some("https://attacker.example/jwks"));
            KeyResolution::Found(key.verifying_key())
        });
        assert!(status.is_verified());
    }

    #[test]
    fn verification_is_independent_of_member_order() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let card = signed_card(&key);
        // Serialize every object with its members in reverse order and with
        // extra whitespace, to prove the payload does not depend on the
        // member order or formatting received on the wire.
        fn reversed_text(value: &Value) -> String {
            match value {
                Value::Object(members) => {
                    let parts = members
                        .iter()
                        .rev()
                        .map(|(name, item)| {
                            format!(
                                "{} : {}",
                                serde_json::to_string(name).expect("key"),
                                reversed_text(item)
                            )
                        })
                        .collect::<Vec<_>>();
                    format!("{{ {} }}", parts.join(" , "))
                }
                Value::Array(items) => format!(
                    "[ {} ]",
                    items
                        .iter()
                        .map(reversed_text)
                        .collect::<Vec<_>>()
                        .join(" , ")
                ),
                other => serde_json::to_string(other).expect("scalar"),
            }
        }
        let reordered_text = reversed_text(&card);
        assert_ne!(reordered_text, serde_json::to_string(&card).expect("card"));
        let reordered: Value = serde_json::from_str(&reordered_text).expect("parse reordered");
        assert_eq!(
            agent_card_signing_payload(&card).expect("payload"),
            agent_card_signing_payload(&reordered).expect("payload")
        );
        assert!(
            verify_agent_card_signatures(&reordered, |_| KeyResolution::Found(key.verifying_key()))
                .is_verified()
        );
    }

    #[test]
    fn jcs_matches_rfc_8785_examples() {
        let value: Value = serde_json::from_str(
            r#"{"b":[1,2.5,{"y":null,"x":true}],"a":"\u20ac\n\u0001\"","é":0,"€":1,"😀":2,"\r":3}"#,
        )
        .expect("parse");
        assert_eq!(
            canonicalize_json(&value),
            "{\"\\r\":3,\"a\":\"€\\n\\u0001\\\"\",\"b\":[1,2.5,{\"x\":true,\"y\":null}],\"é\":0,\"€\":1,\"😀\":2}"
        );
        // RFC 8785 Appendix B number serializations. Values are built from
        // Rust literals (correctly rounded) so the test exercises the
        // serializer rather than serde_json's float parser.
        for (input, expected) in [
            (0.0_f64, "0"),
            (-0.0, "0"),
            (1e30, "1e+30"),
            (4.5, "4.5"),
            (2e-3, "0.002"),
            (0.000_001, "0.000001"),
            (1e-7, "1e-7"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (295_147_905_179_352_830_000.0, "295147905179352830000"),
            (-1.5e-10, "-1.5e-10"),
            (5e-324, "5e-324"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            (333_333_333.333_333_3, "333333333.3333333"),
        ] {
            let value = Value::Number(Number::from_f64(input).expect("finite number"));
            assert_eq!(canonicalize_json(&value), expected, "input {input:e}");
        }
        for (input, expected) in [
            ("0", "0"),
            ("-17", "-17"),
            ("9007199254740991", "9007199254740991"),
        ] {
            let value: Value = serde_json::from_str(input).expect("integer");
            assert_eq!(canonicalize_json(&value), expected);
        }
    }

    #[test]
    fn existing_signatures_are_excluded_from_the_payload() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let first = signed_card(&key);
        let unsigned = serde_json::to_value(sample_card()).expect("card");
        assert_eq!(
            agent_card_signing_payload(&first).expect("payload"),
            agent_card_signing_payload(&unsigned).expect("payload")
        );
    }

    #[test]
    fn jwks_round_trips_and_thumbprint_is_stable() {
        let key = SigningKey::from_bytes(&[0x41; 32]);
        let jwks = ed25519_jwks(&[key.verifying_key()]);
        let parsed = ed25519_keys_from_jwks(&jwks);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].1, key.verifying_key());
        assert_eq!(parsed[0].0, ed25519_jwk_thumbprint(&key.verifying_key()));
        // RFC 8037 Appendix A.3 thumbprint for its example key.
        let rfc_key = VerifyingKey::from_bytes(
            &URL_SAFE_NO_PAD
                .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")
                .expect("x")
                .try_into()
                .expect("32 bytes"),
        )
        .expect("key");
        assert_eq!(
            ed25519_jwk_thumbprint(&rfc_key),
            "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
        );
        let rejected = json!({"keys": [{"kty": "OKP", "crv": "X25519", "x": "AA"}]});
        assert!(ed25519_keys_from_jwks(&rejected).is_empty());
    }
}
