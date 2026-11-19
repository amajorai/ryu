//! Core half of share and request link encryption. The browser half is
//! `apps/web/src/lib/vault-share-crypto.ts`; both test suites pin the same
//! vectors, so a change on one side that breaks the other fails a test.
//!
//! * Share: AES-256-GCM, a fresh random key per link, AAD
//!   `ryu-vault-share-v1`, blob = base64url(nonce ‖ ciphertext). The key goes
//!   only into the link's `#fragment`.
//! * Request answer: ECDH P-256 (x-coordinate of the shared point) between the
//!   browser's ephemeral key and this node's request key, HKDF-SHA256 with
//!   salt = ephemeral ‖ request public key and info `ryu-vault-request-v1`,
//!   then AES-256-GCM with the same AAD.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use p256::elliptic_curve::group::Curve as _;
use p256::elliptic_curve::point::AffineCoordinates as _;
use p256::elliptic_curve::zeroize::Zeroizing;
use rand::RngCore as _;
use sha2::Sha256;

pub const SHARE_AAD: &[u8] = b"ryu-vault-share-v1";
pub const REQUEST_INFO: &[u8] = b"ryu-vault-request-v1";
const NONCE_BYTES: usize = 12;
/// Largest plaintext a share link carries (the control plane caps blobs too).
pub const MAX_SHARE_PLAINTEXT: usize = 64 * 1024;

/// A sealed share: the blob for the server and the key for the fragment.
pub struct SealedShare {
    pub blob: String,
    pub fragment_key: Zeroizing<String>,
}

fn aes_encrypt(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow!("invalid key length"))?
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| anyhow!("encryption failed"))
}

fn aes_decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow!("invalid key length"))?
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| anyhow!("the answer could not be decrypted"))
}

/// Seal `plaintext` (JSON) under `key` and `nonce`. Exposed for the vectors;
/// [`seal_share`] picks fresh ones.
pub fn seal_share_with(
    plaintext: &[u8],
    key: &[u8; 32],
    nonce: &[u8; NONCE_BYTES],
) -> Result<String> {
    let mut blob = nonce.to_vec();
    blob.extend(aes_encrypt(key, nonce, plaintext, SHARE_AAD)?);
    Ok(URL_SAFE_NO_PAD.encode(blob))
}

/// Seal a share with a fresh key and nonce.
pub fn seal_share(plaintext: &[u8]) -> Result<SealedShare> {
    if plaintext.len() > MAX_SHARE_PLAINTEXT {
        bail!("a share link carries at most 64 KiB");
    }
    let mut key = Zeroizing::new([0u8; 32]);
    let mut nonce = [0u8; NONCE_BYTES];
    rand::thread_rng().fill_bytes(key.as_mut());
    rand::thread_rng().fill_bytes(&mut nonce);
    Ok(SealedShare {
        blob: seal_share_with(plaintext, &key, &nonce)?,
        fragment_key: Zeroizing::new(URL_SAFE_NO_PAD.encode(key.as_ref())),
    })
}

/// A fresh request key: (secret scalar bytes, base64url uncompressed public key).
pub fn new_request_key() -> Result<(Zeroizing<Vec<u8>>, String)> {
    loop {
        let mut bytes = Zeroizing::new(vec![0u8; 32]);
        rand::thread_rng().fill_bytes(&mut bytes);
        if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
            let public = URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes());
            return Ok((bytes, public));
        }
    }
}

/// The base64url public key for a stored request secret.
pub fn request_public_key(secret: &[u8]) -> Result<String> {
    let secret = p256::SecretKey::from_slice(secret).map_err(|_| anyhow!("bad request key"))?;
    Ok(URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes()))
}

/// An encrypted answer as the browser sends it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct SealedAnswer {
    pub epk: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn decode(field: &str, value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| anyhow!("{field} is not base64url"))
}

/// Open an answer with the request's secret scalar.
pub fn open_answer(secret: &[u8], answer: &SealedAnswer) -> Result<Zeroizing<Vec<u8>>> {
    let secret = p256::SecretKey::from_slice(secret).map_err(|_| anyhow!("bad request key"))?;
    let epk_bytes = decode("epk", &answer.epk)?;
    let nonce = decode("nonce", &answer.nonce)?;
    if nonce.len() != NONCE_BYTES {
        bail!("nonce must be 12 bytes");
    }
    let ephemeral = p256::PublicKey::from_sec1_bytes(&epk_bytes)
        .map_err(|_| anyhow!("epk is not a P-256 point"))?;
    let shared_point = (ephemeral.to_projective() * *secret.to_nonzero_scalar()).to_affine();
    let shared = Zeroizing::new(shared_point.x().to_vec());
    let mut salt = epk_bytes.clone();
    salt.extend_from_slice(&secret.public_key().to_sec1_bytes());
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), &shared)
        .expand(REQUEST_INFO, key.as_mut())
        .map_err(|_| anyhow!("key derivation failed"))?;
    let ciphertext = decode("ciphertext", &answer.ciphertext)?;
    Ok(Zeroizing::new(aes_decrypt(
        key.as_ref(),
        &nonce,
        &ciphertext,
        REQUEST_INFO,
    )?))
}

#[cfg(test)]
#[path = "crypto_tests.rs"]
mod tests;
