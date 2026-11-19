//! SSH CA signing keys: Ed25519 (the default), RSA, and ECDSA.
//!
//! An Ed25519 CA is sealed as its 32-byte seed, as before; RSA and ECDSA CAs
//! are sealed as PKCS#8 DER, so the stored length tells the forms apart. RSA
//! CAs sign with `rsa-sha2-512` (OpenSSH's default for RSA CAs; SHA-1
//! `ssh-rsa` signatures are refused by current servers). ECDSA CAs sign with
//! `ecdsa-sha2-nistp256` (SHA-256) or `ecdsa-sha2-nistp384` (SHA-384).

use ed25519_dalek::Signer as _;
use p256::ecdsa::signature::Signer as _;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{DecodePrivateKey as _, EncodePrivateKey as _, EncodePublicKey as _};
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rsa::signature::SignatureEncoding;
use rsa::traits::PublicKeyParts;
use sha2::Sha512;

use super::*;

/// The key type of a new CA.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshCaKeyType {
    #[default]
    Ed25519,
    /// `keyBits` 2048, 3072, or 4096 (the default).
    Rsa,
    /// `keyBits` 256 (the default) or 384.
    Ecdsa,
}

/// A loaded CA key.
pub(super) enum CaKey {
    Ed25519(ed25519_dalek::SigningKey),
    Rsa(Box<rsa::RsaPrivateKey>),
    P256(p256::SecretKey),
    P384(p384::SecretKey),
}

/// SSH `mpint` is big-endian, no leading zeros, a zero byte added when the top
/// bit is set.
fn put_mpint(out: &mut Vec<u8>, bytes: &[u8]) {
    let trimmed: &[u8] = match bytes.iter().position(|byte| *byte != 0) {
        Some(start) => &bytes[start..],
        None => &[],
    };
    let mut value = Vec::with_capacity(trimmed.len() + 1);
    if trimmed.first().is_some_and(|byte| byte & 0x80 != 0) {
        value.push(0);
    }
    value.extend_from_slice(trimmed);
    put_string(out, &value);
}

/// An SSH ECDSA signature body from a fixed-size `r || s`.
fn ecdsa_signature(rs: &[u8]) -> Vec<u8> {
    let (r, s) = rs.split_at(rs.len() / 2);
    let mut inner = Vec::new();
    put_mpint(&mut inner, r);
    put_mpint(&mut inner, s);
    inner
}

/// The uncompressed point at the end of an EC SubjectPublicKeyInfo.
fn ec_point(spki: &[u8], len: usize) -> Result<&[u8]> {
    let point = spki
        .get(spki.len().saturating_sub(len)..)
        .filter(|point| point.len() == len && point[0] == 0x04)
        .ok_or_else(|| anyhow!("unexpected EC public key encoding"))?;
    Ok(point)
}

impl CaKey {
    /// Generate a key. RSA generation is slow; callers run it off the
    /// async runtime.
    pub(super) fn generate(key_type: SshCaKeyType, bits: Option<u32>) -> Result<Self> {
        let bits = bits.filter(|bits| *bits != 0);
        Ok(match (key_type, bits) {
            (SshCaKeyType::Ed25519, None) => {
                let seed: [u8; 32] = random_bytes(32).try_into().expect("32 bytes");
                Self::Ed25519(ed25519_dalek::SigningKey::from_bytes(&seed))
            }
            (SshCaKeyType::Rsa, None | Some(2048 | 3072 | 4096)) => {
                let bits = bits.unwrap_or(4096) as usize;
                let key = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, bits)
                    .map_err(|error| anyhow!("generating RSA key: {error}"))?;
                Self::Rsa(Box::new(key))
            }
            (SshCaKeyType::Ecdsa, None | Some(256)) => {
                let secret = p256::SecretKey::try_generate()
                    .map_err(|error| anyhow!("generating ECDSA key: {error}"))?;
                Self::P256(secret)
            }
            (SshCaKeyType::Ecdsa, Some(384)) => {
                let secret = p384::SecretKey::try_generate()
                    .map_err(|error| anyhow!("generating ECDSA key: {error}"))?;
                Self::P384(secret)
            }
            (SshCaKeyType::Ed25519, Some(_)) => {
                return Err(VaultError::Invalid("ed25519 CAs take no keyBits".into()).into())
            }
            (SshCaKeyType::Rsa, Some(_)) => {
                return Err(
                    VaultError::Invalid("rsa keyBits must be 2048, 3072, or 4096".into()).into(),
                )
            }
            (SshCaKeyType::Ecdsa, Some(_)) => {
                return Err(VaultError::Invalid("ecdsa keyBits must be 256 or 384".into()).into())
            }
        })
    }

    /// The form sealed at rest.
    pub(super) fn to_sealed(&self) -> Result<Vec<u8>> {
        let failed = |error: &dyn std::fmt::Display| anyhow!("encoding CA key: {error}");
        Ok(match self {
            Self::Ed25519(key) => key.to_bytes().to_vec(),
            Self::Rsa(key) => key
                .to_pkcs8_der()
                .map_err(|error| failed(&error))?
                .as_bytes()
                .to_vec(),
            Self::P256(key) => key
                .to_pkcs8_der()
                .map_err(|error| failed(&error))?
                .as_bytes()
                .to_vec(),
            Self::P384(key) => key
                .to_pkcs8_der()
                .map_err(|error| failed(&error))?
                .as_bytes()
                .to_vec(),
        })
    }

    pub(super) fn from_sealed(bytes: &[u8]) -> Result<Self> {
        if let Ok(seed) = <[u8; 32]>::try_from(bytes) {
            return Ok(Self::Ed25519(ed25519_dalek::SigningKey::from_bytes(&seed)));
        }
        if let Ok(secret) = p256::SecretKey::from_pkcs8_der(bytes) {
            return Ok(Self::P256(secret));
        }
        if let Ok(secret) = p384::SecretKey::from_pkcs8_der(bytes) {
            return Ok(Self::P384(secret));
        }
        rsa::RsaPrivateKey::from_pkcs8_der(bytes)
            .map(|key| Self::Rsa(Box::new(key)))
            .map_err(|_| anyhow!("stored CA key is not a supported key"))
    }

    fn algorithm(&self) -> &'static str {
        match self {
            Self::Ed25519(_) => "ssh-ed25519",
            Self::Rsa(_) => "ssh-rsa",
            Self::P256(_) => "ecdsa-sha2-nistp256",
            Self::P384(_) => "ecdsa-sha2-nistp384",
        }
    }

    /// The CA's public key in SSH wire form.
    pub(super) fn public_blob(&self) -> Result<Vec<u8>> {
        let mut blob = Vec::new();
        put_string(&mut blob, self.algorithm().as_bytes());
        let spki_error = |error: &dyn std::fmt::Display| anyhow!("encoding CA key: {error}");
        match self {
            Self::Ed25519(key) => put_string(&mut blob, &key.verifying_key().to_bytes()),
            Self::Rsa(key) => {
                put_mpint(&mut blob, &key.e().to_bytes_be());
                put_mpint(&mut blob, &key.n().to_bytes_be());
            }
            Self::P256(key) => {
                let spki = key
                    .public_key()
                    .to_public_key_der()
                    .map_err(|error| spki_error(&error))?;
                put_string(&mut blob, b"nistp256");
                put_string(&mut blob, ec_point(spki.as_bytes(), 65)?);
            }
            Self::P384(key) => {
                let spki = key
                    .public_key()
                    .to_public_key_der()
                    .map_err(|error| spki_error(&error))?;
                put_string(&mut blob, b"nistp384");
                put_string(&mut blob, ec_point(spki.as_bytes(), 97)?);
            }
        }
        Ok(blob)
    }

    /// An OpenSSH public key line for the CA.
    pub(super) fn public_line(&self, comment: &str) -> Result<String> {
        Ok(format!(
            "{} {} {comment}",
            self.algorithm(),
            B64.encode(self.public_blob()?)
        ))
    }

    /// Sign `data` and return the SSH signature blob.
    pub(super) fn sign(&self, data: &[u8]) -> Vec<u8> {
        let mut blob = Vec::new();
        match self {
            Self::Ed25519(key) => {
                put_string(&mut blob, b"ssh-ed25519");
                put_string(&mut blob, &key.sign(data).to_bytes());
            }
            Self::Rsa(key) => {
                let signer = rsa::pkcs1v15::SigningKey::<Sha512>::new((**key).clone());
                put_string(&mut blob, b"rsa-sha2-512");
                put_string(&mut blob, &signer.sign(data).to_vec());
            }
            Self::P256(key) => {
                let signature: p256::ecdsa::Signature =
                    p256::ecdsa::SigningKey::from(key.clone()).sign(data);
                let inner = ecdsa_signature(&signature.to_bytes());
                put_string(&mut blob, b"ecdsa-sha2-nistp256");
                put_string(&mut blob, &inner);
            }
            Self::P384(key) => {
                let signature: p384::ecdsa::Signature =
                    p384::ecdsa::SigningKey::from(key.clone()).sign(data);
                let inner = ecdsa_signature(&signature.to_bytes());
                put_string(&mut blob, b"ecdsa-sha2-nistp384");
                put_string(&mut blob, &inner);
            }
        }
        blob
    }
}

impl PluginSecretStore {
    /// Create an SSH CA of `key_type` and return its OpenSSH public key line.
    pub async fn ssh_create_ca_with(
        &self,
        name: &str,
        key_type: SshCaKeyType,
        key_bits: Option<u32>,
        actor: &AuditActor,
    ) -> Result<String> {
        if !super::super::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid CA name".into()).into());
        }
        let key =
            tokio::task::spawn_blocking(move || CaKey::generate(key_type, key_bits)).await??;
        let public = key.public_line(&format!("ryu-ssh-ca-{name}"))?;
        let (key_version, nonce, ciphertext) = self.seal_row(&key.to_sealed()?)?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_ssh_cas (name, nonce, ciphertext, key_version, public_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, nonce, ciphertext, key_version, public, now_millis()],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("SSH CA `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.ca.create", "ok")
                .details(serde_json::json!({ "ca": name, "keyType": key_type })),
        );
        Ok(public)
    }
}
