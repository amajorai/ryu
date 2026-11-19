//! PKI key types for issuers and issued leaves: ECDSA (P-256 or P-384), RSA
//! (2048, 3072, or 4096 bits), and Ed25519.
//!
//! rcgen with ring can generate ECDSA and Ed25519 keys but not RSA, so RSA
//! keys come from the `rsa` crate as PKCS#8 and load into an rcgen
//! [`KeyPair`]. Stored issuer keys are PKCS#8 DER whatever their type;
//! [`KeyPair::try_from`] detects the algorithm when they are loaded.

use rand::rngs::OsRng;
use rsa::pkcs8::EncodePrivateKey;

use super::*;

/// The algorithm family of a key.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PkiKeyType {
    /// ECDSA; `keyBits` 256 (P-256, the default) or 384 (P-384).
    #[default]
    Ec,
    /// RSA; `keyBits` 2048 (default), 3072, or 4096. Signs with SHA-256.
    Rsa,
    /// Ed25519; takes no `keyBits`.
    Ed25519,
}

impl PkiKeyType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ec => "ec",
            Self::Rsa => "rsa",
            Self::Ed25519 => "ed25519",
        }
    }
}

/// A validated key type and size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySpec {
    pub key_type: PkiKeyType,
    pub bits: u32,
}

impl Default for KeySpec {
    fn default() -> Self {
        Self {
            key_type: PkiKeyType::Ec,
            bits: 256,
        }
    }
}

impl KeySpec {
    /// Validate `key_type` and `key_bits` (`None` or `0` picks the default
    /// size for the type).
    pub fn new(key_type: PkiKeyType, key_bits: Option<u32>) -> Result<Self> {
        let bits = key_bits.filter(|bits| *bits != 0);
        let bits = match (key_type, bits) {
            (PkiKeyType::Ec, None) => 256,
            (PkiKeyType::Ec, Some(bits @ (256 | 384))) => bits,
            (PkiKeyType::Rsa, None) => 2048,
            (PkiKeyType::Rsa, Some(bits @ (2048 | 3072 | 4096))) => bits,
            (PkiKeyType::Ed25519, None) => 0,
            (PkiKeyType::Ec, Some(_)) => {
                return Err(VaultError::Invalid("ec keyBits must be 256 or 384".into()).into())
            }
            (PkiKeyType::Rsa, Some(_)) => {
                return Err(
                    VaultError::Invalid("rsa keyBits must be 2048, 3072, or 4096".into()).into(),
                )
            }
            (PkiKeyType::Ed25519, Some(_)) => {
                return Err(VaultError::Invalid("ed25519 keys take no keyBits".into()).into())
            }
        };
        Ok(Self { key_type, bits })
    }
}

/// Generate a key pair. RSA generation is slow: callers off the async
/// runtime use [`generate_key_blocking`].
pub(super) fn generate_key(spec: KeySpec) -> Result<KeyPair> {
    match (spec.key_type, spec.bits) {
        (PkiKeyType::Ec, 384) => {
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384).map_err(pki_error)
        }
        (PkiKeyType::Ec, _) => {
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(pki_error)
        }
        (PkiKeyType::Ed25519, _) => KeyPair::generate_for(&rcgen::PKCS_ED25519).map_err(pki_error),
        (PkiKeyType::Rsa, bits) => {
            let key = rsa::RsaPrivateKey::new(&mut OsRng, bits as usize)
                .map_err(|error| anyhow!("generating RSA key: {error}"))?;
            let der = key
                .to_pkcs8_der()
                .map_err(|error| anyhow!("encoding RSA key: {error}"))?;
            KeyPair::try_from(der.as_bytes()).map_err(pki_error)
        }
    }
}

/// [`generate_key`] on the blocking pool.
pub(super) async fn generate_key_blocking(spec: KeySpec) -> Result<KeyPair> {
    tokio::task::spawn_blocking(move || generate_key(spec)).await?
}

/// The key type of a PEM certificate or CSR, from its public key algorithm
/// (`ec`, `rsa`, `ed25519`, or empty when it cannot be read).
pub(super) fn key_type_of_pem(pem: &str) -> String {
    use x509_parser::prelude::FromDer as _;
    let Some(Ok(block)) = x509_parser::pem::Pem::iter_from_buffer(pem.as_bytes()).next() else {
        return String::new();
    };
    let oid = match block.label.as_str() {
        "CERTIFICATE" => x509_parser::parse_x509_certificate(&block.contents)
            .ok()
            .map(|(_, cert)| cert.public_key().algorithm.algorithm.to_id_string()),
        "CERTIFICATE REQUEST" => {
            x509_parser::certification_request::X509CertificationRequest::from_der(&block.contents)
                .ok()
                .map(|(_, csr)| {
                    csr.certification_request_info
                        .subject_pki
                        .algorithm
                        .algorithm
                        .to_id_string()
                })
        }
        _ => None,
    };
    match oid.as_deref() {
        Some("1.2.840.10045.2.1") => "ec",
        Some("1.2.840.113549.1.1.1") => "rsa",
        Some("1.3.101.112") => "ed25519",
        _ => "",
    }
    .to_owned()
}
