//! Pairing v2 cryptography (RHP v1.1 design §5.2 and §5.3).
//!
//! Every value here is pinned by `tests/vectors/rhp_v1_1_pairing.json`, which the
//! C firmware (`rhp_pair/pair_crypto`) and the TypeScript mirror test against too:
//!
//! ```text
//! commit      = SHA256("ryu-rhp-pair/2 commit" 0x00 device_pub(32) device_rand(16))
//! T           = "\n"-joined lines (see [`transcript`]), no trailing newline
//! T_hash      = SHA256(T)
//! SAS         = u32be(SHA256("ryu-rhp-pair/2 sas" 0x00 T_hash)[0..4]) mod 1000000
//! dh          = X25519(own_sk, peer_pub), all-zero rejected
//! prk         = HMAC-SHA256(key = T_hash, msg = dh)
//! K_conf      = HKDF-Expand(prk, "ryu-rhp-pair/2 confirm", 32)
//! K_seal      = HKDF-Expand(prk, "ryu-rhp-pair/2 seal key", 32)
//! N_seal      = HKDF-Expand(prk, "ryu-rhp-pair/2 seal nonce", 12)
//! confirm_tag = HMAC-SHA256(K_conf, "ryu-rhp-pair/2 device-confirm")
//! sealed      = AES-256-GCM(K_seal, N_seal, AD = T_hash, PT = credentials JSON)
//! ```
//!
//! The seal key and nonce are both HKDF outputs bound to a single-use transcript, so
//! a (key, nonce) pair is never reused.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use x25519_dalek::StaticSecret;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::noise;

/// First line of the transcript and the label prefix of every derivation.
pub const PAIR_LABEL: &str = "ryu-rhp-pair/2";
/// The only pairing policy in v1.1.
pub const POLICY_SAS_PRESS: &str = "sas_press";
/// The suite line of the transcript.
pub const SUITE: &str = noise::PROTOCOL_NAME;

const COMMIT_LABEL: &[u8] = b"ryu-rhp-pair/2 commit\x00";
const SAS_LABEL: &[u8] = b"ryu-rhp-pair/2 sas\x00";
const CONFIRM_INFO: &[u8] = b"ryu-rhp-pair/2 confirm";
const SEAL_KEY_INFO: &[u8] = b"ryu-rhp-pair/2 seal key";
const SEAL_NONCE_INFO: &[u8] = b"ryu-rhp-pair/2 seal nonce";
const DEVICE_CONFIRM_MSG: &[u8] = b"ryu-rhp-pair/2 device-confirm";

/// Length of `pairing_id` and `device_rand`.
pub const RANDOM_LEN: usize = 16;

// ---------------------------------------------------------------------------
// base64url (RFC 4648 §5, unpadded, strict)
// ---------------------------------------------------------------------------

/// Unpadded base64url.
pub fn b64u_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict unpadded base64url decode: rejects padding, characters outside the
/// alphabet, and non-zero trailing bits.
pub fn b64u_decode(text: &str) -> Option<Vec<u8>> {
    // The engine already rejects padding (RequireNoPad), foreign characters and
    // non-canonical trailing bits; the round-trip check is a belt-and-braces guard
    // that keeps the accepted language exactly the canonical encodings.
    let bytes = URL_SAFE_NO_PAD.decode(text.as_bytes()).ok()?;
    (b64u_encode(&bytes) == text).then_some(bytes)
}

/// Strict base64url decode of exactly `N` bytes.
pub fn b64u_decode_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    b64u_decode(text)?.try_into().ok()
}

// ---------------------------------------------------------------------------
// Commitment, transcript, SAS
// ---------------------------------------------------------------------------

/// `SHA256("ryu-rhp-pair/2 commit" 0x00 device_pub device_rand)`.
pub fn commit(device_pub: &[u8; 32], device_rand: &[u8; RANDOM_LEN]) -> [u8; 32] {
    noise::sha256(&[COMMIT_LABEL, device_pub, device_rand])
}

/// The inputs of the pairing transcript `T`.
#[derive(Clone, Copy, Debug)]
pub struct TranscriptInputs<'a> {
    pub device_id: &'a str,
    pub device_type: &'a str,
    pub pairing_nonce: &'a str,
    pub pairing_id: &'a [u8; RANDOM_LEN],
    pub device_pub: &'a [u8; 32],
    pub node_pub: &'a [u8; 32],
    pub device_rand: &'a [u8; RANDOM_LEN],
}

/// The exact transcript `T` (lines joined by `\n`, no trailing newline).
pub fn transcript(inputs: &TranscriptInputs<'_>) -> String {
    [
        PAIR_LABEL.to_string(),
        format!("device_id={}", inputs.device_id),
        format!("device_type={}", inputs.device_type),
        format!("pairing_nonce={}", inputs.pairing_nonce),
        format!("pairing_id={}", b64u_encode(inputs.pairing_id)),
        format!("policy={POLICY_SAS_PRESS}"),
        format!("device_pub={}", b64u_encode(inputs.device_pub)),
        format!("node_pub={}", b64u_encode(inputs.node_pub)),
        format!("device_rand={}", b64u_encode(inputs.device_rand)),
        format!("suite={SUITE}"),
    ]
    .join("\n")
}

/// `SHA256(T)`.
pub fn transcript_hash(transcript: &str) -> [u8; 32] {
    noise::sha256(&[transcript.as_bytes()])
}

/// The 6-digit short authentication string for a transcript hash.
pub fn sas(transcript_hash: &[u8; 32]) -> String {
    let digest = noise::sha256(&[SAS_LABEL, transcript_hash]);
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

/// The SAS as shown to the user: `"394 867"`.
pub fn sas_display(sas: &str) -> String {
    match sas.split_at_checked(3) {
        Some((head, tail)) => format!("{head} {tail}"),
        None => sas.to_string(),
    }
}

/// `hex(SHA256(pub)[0..8])` grouped as `xxxx-xxxx-xxxx-xxxx`.
pub fn fingerprint(public_key: &[u8; 32]) -> String {
    let digest = noise::sha256(&[public_key]);
    let hex = hex::encode(&digest[..8]);
    format!(
        "{}-{}-{}-{}",
        &hex[0..4],
        &hex[4..8],
        &hex[8..12],
        &hex[12..16]
    )
}

// ---------------------------------------------------------------------------
// Key derivation, confirmation, sealing
// ---------------------------------------------------------------------------

/// The pairing keys derived from the DH output and the transcript hash.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PairKeys {
    pub k_conf: [u8; 32],
    pub k_seal: [u8; 32],
    pub n_seal: [u8; 12],
}

impl std::fmt::Debug for PairKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairKeys { .. }")
    }
}

/// RFC 5869 HKDF-Expand for at most one SHA-256 block (`len <= 32`).
pub fn hkdf_expand(prk: &[u8; 32], info: &[u8], len: usize) -> Zeroizing<Vec<u8>> {
    assert!(len <= 32, "single-block HKDF-Expand");
    let block = Zeroizing::new(noise::hmac_sha256(prk, &[info, &[0x01]]));
    Zeroizing::new(block[..len].to_vec())
}

/// Derive [`PairKeys`] from a (non-zero) X25519 output and `T_hash`.
pub fn derive(dh: &[u8; 32], transcript_hash: &[u8; 32]) -> PairKeys {
    let prk = Zeroizing::new(noise::hmac_sha256(transcript_hash, &[dh]));
    let mut keys = PairKeys {
        k_conf: [0; 32],
        k_seal: [0; 32],
        n_seal: [0; 12],
    };
    keys.k_conf
        .copy_from_slice(&hkdf_expand(&prk, CONFIRM_INFO, 32));
    keys.k_seal
        .copy_from_slice(&hkdf_expand(&prk, SEAL_KEY_INFO, 32));
    keys.n_seal
        .copy_from_slice(&hkdf_expand(&prk, SEAL_NONCE_INFO, 12));
    keys
}

/// X25519 for the device role (tests, Core's device simulator): `None` for an
/// all-zero (low-order) result.
pub fn dh(own_secret: &[u8; 32], peer_public: &[u8; 32]) -> Option<Zeroizing<[u8; 32]>> {
    let secret = StaticSecret::from(*own_secret);
    noise::x25519(&secret, peer_public).ok()
}

/// The X25519 public key of a raw secret.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    noise::public_key(&StaticSecret::from(*secret))
}

/// `HMAC-SHA256(K_conf, "ryu-rhp-pair/2 device-confirm")`.
pub fn confirm_tag(keys: &PairKeys) -> [u8; 32] {
    noise::hmac_sha256(&keys.k_conf, &[DEVICE_CONFIRM_MSG])
}

/// Constant-time check of a presented confirm tag.
pub fn verify_confirm_tag(keys: &PairKeys, presented: &[u8]) -> bool {
    let expected = confirm_tag(keys);
    presented.len() == expected.len() && bool::from(expected.ct_eq(presented))
}

/// The credentials sealed to the device at `/pair/confirm`. Serialises in the
/// normative key order `device_token, node_url, wifi_ssid?, wifi_psk?`. The Debug
/// output redacts every secret and the value is wiped on drop.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SealedCredentials {
    pub device_token: String,
    pub node_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wifi_ssid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wifi_psk: Option<String>,
}

impl std::fmt::Debug for SealedCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedCredentials")
            .field("device_token", &"<redacted>")
            .field("node_url", &self.node_url)
            .field("wifi_ssid", &self.wifi_ssid)
            .field("wifi_psk", &self.wifi_psk.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// `AES-256-GCM(K_seal, N_seal, AD = T_hash, PT = credentials JSON)` as `ct || tag`.
pub fn seal_credentials(
    keys: &PairKeys,
    transcript_hash: &[u8; 32],
    credentials: &SealedCredentials,
) -> Vec<u8> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(credentials).expect("credentials always serialize"));
    seal_bytes(keys, transcript_hash, &plaintext)
}

fn seal_bytes(keys: &PairKeys, transcript_hash: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&keys.k_seal))
        .encrypt(
            Nonce::from_slice(&keys.n_seal),
            Payload {
                msg: plaintext,
                aad: transcript_hash,
            },
        )
        .expect("AES-GCM encryption of an in-memory buffer cannot fail")
}

/// Open a sealed credentials blob (the device side; used by tests and simulators).
pub fn open_credentials(
    keys: &PairKeys,
    transcript_hash: &[u8; 32],
    sealed: &[u8],
) -> Option<SealedCredentials> {
    let plaintext = Zeroizing::new(
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&keys.k_seal))
            .decrypt(
                Nonce::from_slice(&keys.n_seal),
                Payload {
                    msg: sealed,
                    aad: transcript_hash,
                },
            )
            .ok()?,
    );
    serde_json::from_slice(&plaintext).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const PAIRING: &str = include_str!("../tests/vectors/rhp_v1_1_pairing.json");

    fn vectors() -> Value {
        serde_json::from_str(PAIRING).unwrap()
    }

    fn hex_n<const N: usize>(value: &Value) -> [u8; N] {
        hex::decode(value.as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    #[test]
    fn reproduces_every_pairing_vector() {
        let v = vectors();
        let inputs = &v["inputs"];
        let device_sk: [u8; 32] = hex_n(&inputs["device_static_sk"]);
        let node_sk: [u8; 32] = hex_n(&inputs["node_static_sk"]);
        let pairing_id: [u8; 16] = hex_n(&inputs["pairing_id_hex"]);
        let device_rand: [u8; 16] = hex_n(&inputs["device_rand_hex"]);
        let device_pub = public_key(&device_sk);
        let node_pub = public_key(&node_sk);

        assert_eq!(hex::encode(device_pub), v["device_pub_hex"]);
        assert_eq!(b64u_encode(&device_pub), v["device_pub_b64url"]);
        assert_eq!(hex::encode(node_pub), v["node_pub_hex"]);
        assert_eq!(b64u_encode(&node_pub), v["node_pub_b64url"]);
        assert_eq!(b64u_encode(&pairing_id), v["pairing_id_b64url"]);
        assert_eq!(b64u_encode(&device_rand), v["device_rand_b64url"]);

        let c = commit(&device_pub, &device_rand);
        assert_eq!(hex::encode(c), v["device_commit_hex"]);
        assert_eq!(b64u_encode(&c), v["device_commit_b64url"]);

        let t = transcript(&TranscriptInputs {
            device_id: inputs["device_id"].as_str().unwrap(),
            device_type: inputs["device_type"].as_str().unwrap(),
            pairing_nonce: inputs["pairing_nonce"].as_str().unwrap(),
            pairing_id: &pairing_id,
            device_pub: &device_pub,
            node_pub: &node_pub,
            device_rand: &device_rand,
        });
        assert_eq!(t, v["transcript_utf8"]);
        let t_hash = transcript_hash(&t);
        assert_eq!(hex::encode(t_hash), v["transcript_hash_hex"]);
        assert_eq!(b64u_encode(&t_hash), v["transcript_hash_b64url"]);
        let code = sas(&t_hash);
        assert_eq!(code, v["sas"]);
        assert_eq!(sas_display(&code), v["sas_display"]);

        let node_dh = dh(&node_sk, &device_pub).unwrap();
        let device_dh = dh(&device_sk, &node_pub).unwrap();
        assert_eq!(*node_dh, *device_dh);
        assert_eq!(hex::encode(*node_dh), v["dh_hex"]);
        let prk = noise::hmac_sha256(&t_hash, &[node_dh.as_ref()]);
        assert_eq!(hex::encode(prk), v["prk_hex"]);

        let keys = derive(&node_dh, &t_hash);
        assert_eq!(hex::encode(keys.k_conf), v["k_conf_hex"]);
        assert_eq!(hex::encode(keys.k_seal), v["k_seal_hex"]);
        assert_eq!(hex::encode(keys.n_seal), v["n_seal_hex"]);
        let tag = confirm_tag(&keys);
        assert_eq!(hex::encode(tag), v["confirm_tag_hex"]);
        assert_eq!(b64u_encode(&tag), v["confirm_tag_b64url"]);
        assert!(verify_confirm_tag(&keys, &tag));
        assert!(!verify_confirm_tag(&keys, &tag[..31]));

        // The typed credentials serialise to exactly the vector plaintext.
        let plaintext = inputs["credentials_plaintext"].as_str().unwrap();
        let creds: SealedCredentials = serde_json::from_str(plaintext).unwrap();
        assert_eq!(serde_json::to_string(&creds).unwrap(), plaintext);
        let sealed = seal_credentials(&keys, &t_hash, &creds);
        assert_eq!(hex::encode(&sealed), v["sealed_credentials_hex"]);
        assert_eq!(b64u_encode(&sealed), v["sealed_credentials_b64url"]);
        let device_keys = derive(&device_dh, &t_hash);
        assert_eq!(
            open_credentials(&device_keys, &t_hash, &sealed),
            Some(creds.clone())
        );
        let mut wrong_ad = t_hash;
        wrong_ad[0] ^= 1;
        assert!(open_credentials(&device_keys, &wrong_ad, &sealed).is_none());
        let debug = format!("{creds:?}");
        assert!(
            !debug.contains("correct horse") && !debug.contains("rht_7777"),
            "{debug}"
        );

        assert_eq!(fingerprint(&device_pub), v["device_key_fingerprint"]);
        assert_eq!(fingerprint(&node_pub), v["node_key_fingerprint"]);
    }

    #[test]
    fn node_key_substitution_changes_sas_and_tag() {
        let v = vectors();
        let inputs = &v["inputs"];
        let neg = &v["negative_node_key_substituted"];
        let device_sk: [u8; 32] = hex_n(&inputs["device_static_sk"]);
        let attacker_sk: [u8; 32] = hex_n(&inputs["attacker_static_sk"]);
        let pairing_id: [u8; 16] = hex_n(&inputs["pairing_id_hex"]);
        let device_rand: [u8; 16] = hex_n(&inputs["device_rand_hex"]);
        let device_pub = public_key(&device_sk);
        let attacker_pub = public_key(&attacker_sk);
        assert_eq!(hex::encode(attacker_pub), neg["attacker_pub_hex"]);
        let t = transcript(&TranscriptInputs {
            device_id: inputs["device_id"].as_str().unwrap(),
            device_type: inputs["device_type"].as_str().unwrap(),
            pairing_nonce: inputs["pairing_nonce"].as_str().unwrap(),
            pairing_id: &pairing_id,
            device_pub: &device_pub,
            node_pub: &attacker_pub,
            device_rand: &device_rand,
        });
        let t_hash = transcript_hash(&t);
        assert_eq!(hex::encode(t_hash), neg["transcript_hash_hex"]);
        assert_eq!(sas(&t_hash), neg["sas"]);
        let device_keys = derive(&dh(&device_sk, &attacker_pub).unwrap(), &t_hash);
        let device_tag = confirm_tag(&device_keys);
        assert_eq!(hex::encode(device_tag), neg["device_confirm_tag_hex"]);

        // The node recomputes over the genuine transcript and rejects the tag.
        let node_sk: [u8; 32] = hex_n(&inputs["node_static_sk"]);
        let real_hash: [u8; 32] = hex_n(&v["transcript_hash_hex"]);
        let node_keys = derive(&dh(&node_sk, &device_pub).unwrap(), &real_hash);
        assert!(!verify_confirm_tag(&node_keys, &device_tag));
    }

    #[test]
    fn b64u_is_strict() {
        assert_eq!(b64u_decode("AQ"), Some(vec![1]));
        assert!(b64u_decode("AQ==").is_none(), "padding");
        assert!(b64u_decode("AR").is_none(), "non-zero trailing bits");
        assert!(b64u_decode("A+").is_none(), "standard alphabet");
        assert!(b64u_decode("A").is_none(), "impossible length");
        assert!(b64u_decode("A Q").is_none());
        assert_eq!(b64u_decode(""), Some(vec![]));
        assert!(b64u_decode_array::<32>("AQ").is_none());
    }

    #[test]
    fn low_order_dh_is_rejected() {
        assert!(dh(&[5u8; 32], &[0u8; 32]).is_none());
        let mut one = [0u8; 32];
        one[0] = 1;
        assert!(dh(&[5u8; 32], &one).is_none());
    }
}
