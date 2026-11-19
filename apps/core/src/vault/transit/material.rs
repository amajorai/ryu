//! Transit key material: generation, import normalization, AEAD, and signatures.

use super::*;

pub(super) fn ecdsa_p256(material: &[u8]) -> Result<p256::ecdsa::SigningKey> {
    let secret = p256::SecretKey::from_pkcs8_der(material)
        .map_err(|_| anyhow!("stored ecdsa-p256 key is not PKCS#8"))?;
    Ok(p256::ecdsa::SigningKey::from(secret))
}

pub(super) fn ecdsa_p384(material: &[u8]) -> Result<p384::ecdsa::SigningKey> {
    let secret = p384::SecretKey::from_pkcs8_der(material)
        .map_err(|_| anyhow!("stored ecdsa-p384 key is not PKCS#8"))?;
    Ok(p384::ecdsa::SigningKey::from(secret))
}

pub(super) fn rsa_key(material: &[u8]) -> Result<RsaPrivateKey> {
    RsaPrivateKey::from_pkcs8_der(material).map_err(|_| anyhow!("stored RSA key is not PKCS#8"))
}

pub(super) fn ed25519_seed(material: &[u8]) -> Result<[u8; 32]> {
    material
        .try_into()
        .map_err(|_| anyhow!("ed25519 seed has the wrong length"))
}

pub(super) fn der_bytes(
    result: std::result::Result<rsa::pkcs8::SecretDocument, rsa::pkcs8::Error>,
) -> Result<Vec<u8>> {
    result
        .map(|doc| doc.as_bytes().to_vec())
        .map_err(|error| anyhow!("encoding private key: {error}"))
}

pub(super) fn ec_der_bytes(
    result: std::result::Result<p256::pkcs8::SecretDocument, p256::pkcs8::Error>,
) -> Result<Vec<u8>> {
    result
        .map(|doc| doc.as_bytes().to_vec())
        .map_err(|error| anyhow!("encoding private key: {error}"))
}

pub(super) fn ec_secret<K: Generate>() -> Result<K> {
    K::try_generate().map_err(|error| anyhow!("generating ECDSA key: {error}"))
}

/// Fresh key material and its public key.
pub(super) fn new_material(key_type: TransitKeyType) -> Result<(Vec<u8>, Option<String>)> {
    let material = match key_type {
        TransitKeyType::Aes256Gcm96
        | TransitKeyType::Chacha20Poly1305
        | TransitKeyType::Hmac
        | TransitKeyType::Ed25519
        | TransitKeyType::Aes256Cmac => random_bytes(32),
        TransitKeyType::Aes128Cmac | TransitKeyType::Aes128Gcm96 => random_bytes(16),
        TransitKeyType::EcdsaP256 => ec_der_bytes(ec_secret::<p256::SecretKey>()?.to_pkcs8_der())?,
        TransitKeyType::EcdsaP384 => ec_der_bytes(ec_secret::<p384::SecretKey>()?.to_pkcs8_der())?,
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let bits = key_type.rsa_bits().unwrap_or(2048);
            der_bytes(
                RsaPrivateKey::new(&mut OsRng, bits)
                    .map_err(|error| anyhow!("generating RSA key: {error}"))?
                    .to_pkcs8_der(),
            )?
        }
    };
    let public_key = public_key_of(key_type, &material)?;
    Ok((material, public_key))
}

pub(super) fn spki_pem(
    result: std::result::Result<String, rsa::pkcs8::spki::Error>,
) -> Result<String> {
    result.map_err(|error| anyhow!("encoding public key: {error}"))
}

pub(super) fn ec_spki_pem(
    result: std::result::Result<String, p256::pkcs8::spki::Error>,
) -> Result<String> {
    result.map_err(|error| anyhow!("encoding public key: {error}"))
}

/// Validate stored-form material and compute its public key.
pub(super) fn public_key_of(key_type: TransitKeyType, material: &[u8]) -> Result<Option<String>> {
    match key_type {
        TransitKeyType::Aes256Gcm96 | TransitKeyType::Chacha20Poly1305 | TransitKeyType::Hmac => {
            if material.len() != 32 {
                return Err(invalid(format!("{} keys are 32 bytes", key_type.as_str())));
            }
            Ok(None)
        }
        TransitKeyType::Aes128Gcm96 => {
            if material.len() != 16 {
                return Err(invalid("aes128-gcm96 keys are 16 bytes"));
            }
            Ok(None)
        }
        TransitKeyType::Aes128Cmac | TransitKeyType::Aes256Cmac => {
            let bytes = key_type.cmac_key_bytes().unwrap_or(32);
            if material.len() != bytes {
                return Err(invalid(format!(
                    "{} keys are {bytes} bytes",
                    key_type.as_str()
                )));
            }
            Ok(None)
        }
        TransitKeyType::Ed25519 => {
            let seed = ed25519_seed(material).map_err(|_| invalid("ed25519 seeds are 32 bytes"))?;
            let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
            Ok(Some(B64.encode(signing.verifying_key().to_bytes())))
        }
        TransitKeyType::EcdsaP256 => {
            let secret = p256::SecretKey::from_pkcs8_der(material)
                .map_err(|_| invalid("ecdsa-p256 keys must be PKCS#8 DER"))?;
            Ok(Some(ec_spki_pem(
                secret.public_key().to_public_key_pem(EcLineEnding::LF),
            )?))
        }
        TransitKeyType::EcdsaP384 => {
            let secret = p384::SecretKey::from_pkcs8_der(material)
                .map_err(|_| invalid("ecdsa-p384 keys must be PKCS#8 DER"))?;
            Ok(Some(ec_spki_pem(
                secret.public_key().to_public_key_pem(EcLineEnding::LF),
            )?))
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let key = RsaPrivateKey::from_pkcs8_der(material)
                .map_err(|_| invalid("RSA keys must be PKCS#8 DER"))?;
            let expected = key_type.rsa_bits().unwrap_or_default();
            if key.size() * 8 != expected {
                return Err(invalid(format!(
                    "{} requires a {expected}-bit modulus",
                    key_type.as_str()
                )));
            }
            Ok(Some(spki_pem(
                RsaPublicKey::from(&key).to_public_key_pem(LineEnding::LF),
            )?))
        }
    }
}

/// Normalize imported material to the stored form (raw bytes for symmetric
/// and HMAC keys and Ed25519 seeds, canonical PKCS#8 DER for ECDSA/RSA).
pub(super) fn normalize_import(key_type: TransitKeyType, raw: Vec<u8>) -> Result<Vec<u8>> {
    match key_type {
        TransitKeyType::Ed25519 if raw.len() == 48 && raw.starts_with(&ED25519_PKCS8_PREFIX) => {
            Ok(raw[16..].to_vec())
        }
        TransitKeyType::EcdsaP256 => ec_der_bytes(
            p256::SecretKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("ecdsa-p256 imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        TransitKeyType::EcdsaP384 => ec_der_bytes(
            p384::SecretKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("ecdsa-p384 imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => der_bytes(
            RsaPrivateKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("RSA imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        _ => Ok(raw),
    }
}

/// PKCS#8 PEM of stored ECDSA/RSA material.
pub(super) fn private_pem(key_type: TransitKeyType, material: &[u8]) -> Result<String> {
    let encode_error = |error: &dyn std::fmt::Display| anyhow!("encoding private key: {error}");
    let pem = match key_type {
        TransitKeyType::EcdsaP256 => p256::SecretKey::from_pkcs8_der(material)
            .map_err(|_| anyhow!("stored key is not PKCS#8"))?
            .to_pkcs8_pem(EcLineEnding::LF)
            .map_err(|error| encode_error(&error))?,
        TransitKeyType::EcdsaP384 => p384::SecretKey::from_pkcs8_der(material)
            .map_err(|_| anyhow!("stored key is not PKCS#8"))?
            .to_pkcs8_pem(EcLineEnding::LF)
            .map_err(|error| encode_error(&error))?,
        _ => rsa_key(material)?
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|error| encode_error(&error))?,
    };
    Ok(pem.as_str().to_owned())
}

pub(super) fn hkdf_sha256(ikm: &[u8], info: &[u8]) -> Vec<u8> {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    out.to_vec()
}

/// The HMAC key for a version. Raw material for symmetric, HMAC, and Ed25519
/// keys (unchanged from the first release); an HKDF subkey for ECDSA/RSA.
pub(super) fn hmac_key(key_type: TransitKeyType, material: &[u8]) -> Vec<u8> {
    match key_type {
        TransitKeyType::EcdsaP256
        | TransitKeyType::EcdsaP384
        | TransitKeyType::Rsa2048
        | TransitKeyType::Rsa3072
        | TransitKeyType::Rsa4096 => hkdf_sha256(material, b"ryu-transit-hmac"),
        _ => material.to_vec(),
    }
}

/// The AEAD key and associated data for one operation.
pub(super) fn aead_key_and_aad(
    meta: &Meta,
    material: &[u8],
    context: Option<Vec<u8>>,
    associated_data: Option<Vec<u8>>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    if meta.derived {
        let context = context
            .filter(|context| !context.is_empty())
            .ok_or_else(|| invalid("derived keys require a `context`"))?;
        let mut subkey = hkdf_sha256(material, &context);
        // A derived key has the size of the key it derives from.
        subkey.truncate(material.len());
        Ok((subkey, associated_data.unwrap_or_default()))
    } else {
        if context.is_some() && associated_data.is_some() {
            return Err(invalid(
                "use either `context` or `associatedData` with a non-derived key",
            ));
        }
        Ok((
            material.to_vec(),
            context.or(associated_data).unwrap_or_default(),
        ))
    }
}

pub(super) fn convergent_nonce(key: &[u8], aad: &[u8], plaintext: &[u8]) -> [u8; 12] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(b"ryu-transit-convergent");
    mac.update(&(aad.len() as u64).to_be_bytes());
    mac.update(aad);
    mac.update(plaintext);
    let digest = mac.finalize().into_bytes();
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&digest[..12]);
    nonce
}

pub(super) fn aead_encrypt(
    key_type: TransitKeyType,
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
    nonce: Option<[u8; 12]>,
) -> Result<Vec<u8>> {
    let nonce = nonce.map_or_else(|| random_bytes(12), |nonce| nonce.to_vec());
    let payload = Payload {
        msg: plaintext,
        aad,
    };
    let sealed = match key_type {
        TransitKeyType::Chacha20Poly1305 => ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .encrypt(chacha20poly1305::Nonce::from_slice(&nonce), payload),
        TransitKeyType::Aes128Gcm96 => aes_gcm::Aes128Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .encrypt(Nonce::from_slice(&nonce), payload),
        _ => Aes256Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .encrypt(Nonce::from_slice(&nonce), payload),
    }
    .map_err(|_| anyhow!("transit encryption failed"))?;
    let mut out = nonce;
    out.extend(sealed);
    Ok(out)
}

pub(super) fn aead_decrypt(
    key_type: TransitKeyType,
    key: &[u8],
    blob: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>> {
    if blob.len() < 12 + 16 {
        bail!(VaultError::Invalid(
            "transit ciphertext is too short".into()
        ));
    }
    let (nonce, body) = blob.split_at(12);
    let payload = Payload { msg: body, aad };
    match key_type {
        TransitKeyType::Chacha20Poly1305 => ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .decrypt(chacha20poly1305::Nonce::from_slice(nonce), payload),
        TransitKeyType::Aes128Gcm96 => aes_gcm::Aes128Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .decrypt(Nonce::from_slice(nonce), payload),
        _ => Aes256Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .decrypt(Nonce::from_slice(nonce), payload),
    }
    .map_err(|_| invalid("transit ciphertext failed authentication"))
}

pub(super) fn rsa_signature_is_pss(algorithm: Option<&str>) -> Result<bool> {
    match algorithm.map(str::trim) {
        None | Some("") | Some("pss") => Ok(true),
        Some("pkcs1v15") => Ok(false),
        Some(other) => Err(invalid(format!(
            "unknown signatureAlgorithm `{other}` (use pss or pkcs1v15)"
        ))),
    }
}

pub(super) fn reject_algorithm_for_non_rsa(
    key_type: TransitKeyType,
    algorithm: Option<&str>,
) -> Result<()> {
    if key_type.rsa_bits().is_none() && algorithm.is_some_and(|value| !value.trim().is_empty()) {
        return Err(invalid("signatureAlgorithm applies only to RSA keys"));
    }
    Ok(())
}

pub(super) fn sign_material(
    key_type: TransitKeyType,
    material: &[u8],
    input: &[u8],
    algorithm: Option<&str>,
) -> Result<Vec<u8>> {
    reject_algorithm_for_non_rsa(key_type, algorithm)?;
    Ok(match key_type {
        TransitKeyType::Ed25519 => ed25519_dalek::SigningKey::from_bytes(&ed25519_seed(material)?)
            .sign(input)
            .to_bytes()
            .to_vec(),
        TransitKeyType::EcdsaP256 => {
            let signature: p256::ecdsa::Signature = ecdsa_p256(material)?.sign(input);
            signature.to_der().as_bytes().to_vec()
        }
        TransitKeyType::EcdsaP384 => {
            let signature: p384::ecdsa::Signature = ecdsa_p384(material)?.sign(input);
            signature.to_der().as_bytes().to_vec()
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let key = rsa_key(material)?;
            if rsa_signature_is_pss(algorithm)? {
                rsa::pss::BlindedSigningKey::<Sha256>::new(key)
                    .sign_with_rng(&mut OsRng, input)
                    .to_vec()
            } else {
                rsa::pkcs1v15::SigningKey::<Sha256>::new(key)
                    .sign(input)
                    .to_vec()
            }
        }
        _ => return Err(invalid("this key type cannot sign")),
    })
}

pub(super) fn verify_material(
    key_type: TransitKeyType,
    material: &[u8],
    input: &[u8],
    signature: &[u8],
    algorithm: Option<&str>,
) -> Result<bool> {
    reject_algorithm_for_non_rsa(key_type, algorithm)?;
    Ok(match key_type {
        TransitKeyType::Ed25519 => {
            let verifying =
                ed25519_dalek::SigningKey::from_bytes(&ed25519_seed(material)?).verifying_key();
            ed25519_dalek::Signature::from_slice(signature)
                .map(|sig| verifying.verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::EcdsaP256 => {
            let signing = ecdsa_p256(material)?;
            p256::ecdsa::Signature::from_der(signature)
                .map(|sig| signing.verifying_key().verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::EcdsaP384 => {
            let signing = ecdsa_p384(material)?;
            p384::ecdsa::Signature::from_der(signature)
                .map(|sig| signing.verifying_key().verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let public = RsaPublicKey::from(&rsa_key(material)?);
            if rsa_signature_is_pss(algorithm)? {
                rsa::pss::Signature::try_from(signature)
                    .map(|sig| {
                        rsa::pss::VerifyingKey::<Sha256>::new(public)
                            .verify(input, &sig)
                            .is_ok()
                    })
                    .unwrap_or(false)
            } else {
                rsa::pkcs1v15::Signature::try_from(signature)
                    .map(|sig| {
                        rsa::pkcs1v15::VerifyingKey::<Sha256>::new(public)
                            .verify(input, &sig)
                            .is_ok()
                    })
                    .unwrap_or(false)
            }
        }
        _ => return Err(invalid("this key type cannot verify")),
    })
}

// ── AES key wrap with padding (RFC 5649) ──────────────────────────────────
