//! Identity token signing keys: one active key of the configured algorithm
//! (`ES256` on P-256, `RS256` on RSA-2048, or `EdDSA` on Ed25519), sealed as
//! PKCS#8 with the keyring, and the public JWK each key publishes.

use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rsa::traits::PublicKeyParts;

use super::*;

const RSA_BITS: usize = 2048;

/// The algorithm new signing keys use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdentitySigningAlgorithm {
    #[default]
    ES256,
    RS256,
    EdDSA,
}

impl IdentitySigningAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ES256 => "ES256",
            Self::RS256 => "RS256",
            Self::EdDSA => "EdDSA",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        [Self::ES256, Self::RS256, Self::EdDSA]
            .into_iter()
            .find(|alg| alg.as_str() == value)
    }

    fn jwt(self) -> Algorithm {
        match self {
            Self::ES256 => Algorithm::ES256,
            Self::RS256 => Algorithm::RS256,
            Self::EdDSA => Algorithm::EdDSA,
        }
    }
}

pub(super) struct SigningKey {
    pub(super) kid: String,
    pub(super) alg: IdentitySigningAlgorithm,
    pkcs8: Vec<u8>,
}

impl SigningKey {
    pub(super) fn header(&self) -> Header {
        let mut header = Header::new(self.alg.jwt());
        header.kid = Some(self.kid.clone());
        header
    }

    pub(super) fn encoding_key(&self) -> Result<EncodingKey> {
        Ok(match self.alg {
            IdentitySigningAlgorithm::ES256 => EncodingKey::from_ec_der(&self.pkcs8),
            IdentitySigningAlgorithm::EdDSA => EncodingKey::from_ed_der(&self.pkcs8),
            IdentitySigningAlgorithm::RS256 => {
                let key = rsa::RsaPrivateKey::from_pkcs8_der(&self.pkcs8)
                    .map_err(|_| anyhow!("stored identity key is not PKCS#8"))?;
                let pkcs1 = key
                    .to_pkcs1_der()
                    .map_err(|error| anyhow!("encoding identity key: {error}"))?;
                EncodingKey::from_rsa_der(pkcs1.as_bytes())
            }
        })
    }
}

/// A new key: its PKCS#8 form, kid, the EC `x`/`y` columns (empty for other
/// algorithms), and the public JWK without `kid`.
struct NewKey {
    pkcs8: Vec<u8>,
    kid: String,
    x: String,
    y: String,
    jwk: Value,
}

fn generate(alg: IdentitySigningAlgorithm) -> Result<NewKey> {
    let failed = |error: &dyn std::fmt::Display| anyhow!("generating identity key: {error}");
    match alg {
        IdentitySigningAlgorithm::ES256 => {
            let key = KeyPair::generate().map_err(|error| failed(&error))?;
            let raw = key.public_key_raw();
            if raw.len() != 65 || raw[0] != 0x04 {
                return Err(anyhow!("unexpected identity public key encoding"));
            }
            let (x, y) = (B64URL.encode(&raw[1..33]), B64URL.encode(&raw[33..65]));
            Ok(NewKey {
                pkcs8: key.serialize_der(),
                kid: sha256_hex(raw)[..16].to_owned(),
                jwk: json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y }),
                x,
                y,
            })
        }
        IdentitySigningAlgorithm::EdDSA => {
            let key =
                KeyPair::generate_for(&rcgen::PKCS_ED25519).map_err(|error| failed(&error))?;
            let raw = key.public_key_raw();
            Ok(NewKey {
                pkcs8: key.serialize_der(),
                kid: sha256_hex(raw)[..16].to_owned(),
                jwk: json!({ "kty": "OKP", "crv": "Ed25519", "x": B64URL.encode(raw) }),
                x: String::new(),
                y: String::new(),
            })
        }
        IdentitySigningAlgorithm::RS256 => {
            let key = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, RSA_BITS)
                .map_err(|error| failed(&error))?;
            let n = key.n().to_bytes_be();
            let e = key.e().to_bytes_be();
            let pkcs8 = key
                .to_pkcs8_der()
                .map_err(|error| failed(&error))?
                .as_bytes()
                .to_vec();
            Ok(NewKey {
                pkcs8,
                kid: sha256_hex(&n)[..16].to_owned(),
                jwk: json!({ "kty": "RSA", "n": B64URL.encode(&n), "e": B64URL.encode(&e) }),
                x: String::new(),
                y: String::new(),
            })
        }
    }
}

/// Add the algorithm columns to databases created before RS256 and EdDSA.
pub(super) fn migrate_schema(conn: &Connection) -> Result<()> {
    let has_column = |table: &str, column: &str| -> Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names.iter().any(|name| name == column))
    };
    if !has_column("vault_identity_keys", "alg")? {
        conn.execute_batch(
            "ALTER TABLE vault_identity_keys ADD COLUMN alg TEXT NOT NULL DEFAULT 'ES256';
             ALTER TABLE vault_identity_keys ADD COLUMN jwk TEXT;",
        )?;
    }
    if !has_column("vault_identity_config", "algorithm")? {
        conn.execute_batch("ALTER TABLE vault_identity_config ADD COLUMN algorithm TEXT;")?;
    }
    Ok(())
}

/// The published JWK for a key row (`jwk` is absent on ES256 rows written
/// before it existed).
pub(super) fn published_jwk(
    kid: String,
    alg: &str,
    x: String,
    y: String,
    jwk: Option<String>,
) -> Value {
    let mut key = jwk
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y }));
    key["kid"] = json!(kid);
    key["alg"] = json!(alg);
    key["use"] = json!("sig");
    key
}

impl PluginSecretStore {
    pub(super) fn insert_identity_key(
        &self,
        conn: &Connection,
        alg: IdentitySigningAlgorithm,
    ) -> Result<SigningKey> {
        let key = generate(alg)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&key.pkcs8)?;
        conn.execute(
            "INSERT INTO vault_identity_keys
                 (kid, nonce, ciphertext, key_version, x, y, created_at, alg, jwk)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                key.kid,
                nonce,
                ciphertext,
                key_version,
                key.x,
                key.y,
                now_millis(),
                alg.as_str(),
                key.jwk.to_string()
            ],
        )?;
        Ok(SigningKey {
            kid: key.kid,
            alg,
            pkcs8: key.pkcs8,
        })
    }

    /// The active key's kid and algorithm, if any.
    pub(super) fn active_identity_alg(
        &self,
        conn: &Connection,
    ) -> Result<Option<(String, String)>> {
        Ok(conn
            .query_row(
                "SELECT kid, alg FROM vault_identity_keys
                 WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// The active signing key, created (with the configured algorithm) on
    /// first use.
    pub(super) fn active_identity_key(
        &self,
        conn: &Connection,
        configured: IdentitySigningAlgorithm,
    ) -> Result<SigningKey> {
        let row: Option<(String, Vec<u8>, Vec<u8>, u32, String)> = conn
            .query_row(
                "SELECT kid, nonce, ciphertext, key_version, alg FROM vault_identity_keys
                 WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        match row {
            Some((kid, nonce, ciphertext, key_version, alg)) => Ok(SigningKey {
                kid,
                alg: IdentitySigningAlgorithm::parse(&alg)
                    .ok_or_else(|| anyhow!("identity key has an unknown algorithm `{alg}`"))?,
                pkcs8: self.open_row(key_version, &nonce, &ciphertext)?,
            }),
            None => self.insert_identity_key(conn, configured),
        }
    }

    /// Create the signing key now if none is active, so discovery and the JWKS
    /// are complete before the first token is issued.
    pub(super) fn ensure_identity_key(
        &self,
        conn: &Connection,
        configured: IdentitySigningAlgorithm,
    ) -> Result<()> {
        if self.active_identity_alg(conn)?.is_none() {
            self.insert_identity_key(conn, configured)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn algorithms_parse_and_new_keys_publish_their_jwk() {
        for alg in [
            IdentitySigningAlgorithm::ES256,
            IdentitySigningAlgorithm::RS256,
            IdentitySigningAlgorithm::EdDSA,
        ] {
            assert_eq!(IdentitySigningAlgorithm::parse(alg.as_str()), Some(alg));
        }
        assert_eq!(IdentitySigningAlgorithm::parse("HS256"), None);
        let key = generate(IdentitySigningAlgorithm::EdDSA).unwrap();
        assert!(key.x.is_empty() && key.y.is_empty());
        let published = published_jwk(
            key.kid.clone(),
            "EdDSA",
            key.x,
            key.y,
            Some(key.jwk.to_string()),
        );
        assert_eq!(published["kty"], "OKP");
        assert_eq!(published["crv"], "Ed25519");
        assert_eq!(published["kid"], key.kid.as_str());
        assert_eq!(published["use"], "sig");
    }
}
