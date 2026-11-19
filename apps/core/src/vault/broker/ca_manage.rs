//! Operator management of the broker CA: status, rotation, and a bring-your-own
//! CA import.
//!
//! Replacing the CA (rotation or import) keeps the previous certificate in the
//! trust bundle for [`PREVIOUS_GRACE_MILLIS`] (the longest a session lives),
//! so agents started before the change keep verifying until they end; leaves
//! are signed by the new CA at once. An imported CA must be a CA certificate
//! (basic constraints `CA:TRUE`, `keyCertSign` when key usage is present),
//! currently valid for at least a day, with a matching PKCS#8 private key. The
//! key is sealed like a generated one and never returned. Every replacement
//! bumps [`generation`], so a running broker drops its cached leaves.

use rcgen::PublicKeyData as _;
use serde::Serialize;

use super::*;

/// How long a replaced CA stays trusted.
pub const PREVIOUS_GRACE_MILLIS: i64 = super::super::sessions::MAX_TTL_SECS * 1000;
const MIN_REMAINING_SECS: i64 = 24 * 3600;
const MAX_PEM_BYTES: usize = 64 * 1024;

/// Columns added after the first release of the table.
pub(super) const ADDED_COLUMNS: &[(&str, &str)] = &[
    ("source", "TEXT NOT NULL DEFAULT 'generated'"),
    ("previous_certificate", "TEXT"),
    ("rotated_at", "INTEGER"),
];

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Bumped whenever the CA is replaced.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// The previous CA, while it is still trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousCa {
    pub fingerprint_sha256: String,
    pub trusted_until: i64,
}

/// Public facts about the CA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaInfo {
    pub certificate_pem: String,
    pub fingerprint_sha256: String,
    pub subject: String,
    pub not_after: i64,
    /// `generated` or `imported`.
    pub source: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<PreviousCa>,
}

fn fingerprint(pem: &str) -> Result<String> {
    Ok(crate::vault::sha256_hex(rustls_pemfile_cert(pem)?.as_ref()))
}

fn subject_of(pem: &str) -> Result<String> {
    let der = rustls_pemfile_cert(pem)?;
    let (_, certificate) =
        x509_parser::parse_x509_certificate(der.as_ref()).context("parsing the broker CA")?;
    Ok(certificate.subject().to_string())
}

type CaRow = (String, i64, String, i64, Option<String>, Option<i64>);

fn row_locked(conn: &Connection) -> Result<Option<CaRow>> {
    Ok(conn
        .query_row(
            "SELECT certificate, not_after, source, created_at, previous_certificate, rotated_at
             FROM vault_broker_ca WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?)
}

/// The previous certificate and when its grace ends, if still in it.
fn previous_in_grace(row: &CaRow, now: i64) -> Option<(String, i64)> {
    let (_, _, _, _, previous, rotated_at) = row;
    let until = rotated_at.as_ref()? + PREVIOUS_GRACE_MILLIS;
    let previous = previous.clone()?;
    (now < until).then_some((previous, until))
}

/// The certificates agents should trust: the CA, plus the previous one
/// during its grace period. Reads public columns only.
pub(super) fn trust_pem_locked(conn: &Connection) -> Result<Option<String>> {
    let Some(row) = row_locked(conn)? else {
        return Ok(None);
    };
    let mut pem = row.0.trim_end().to_owned();
    pem.push('\n');
    if let Some((previous, _)) = previous_in_grace(&row, now_millis()) {
        pem.push_str(previous.trim_end());
        pem.push('\n');
    }
    Ok(Some(pem))
}

/// The CA's public facts, if it exists. Never creates the CA.
pub async fn info(store: &PluginSecretStore) -> Result<Option<CaInfo>> {
    let row = {
        let conn = store.conn.lock().await;
        row_locked(&conn)?
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let previous = match previous_in_grace(&row, now_millis()) {
        Some((pem, until)) => Some(PreviousCa {
            fingerprint_sha256: fingerprint(&pem)?,
            trusted_until: until,
        }),
        None => None,
    };
    let (certificate_pem, not_after, source, created_at, _, _) = row;
    Ok(Some(CaInfo {
        fingerprint_sha256: fingerprint(&certificate_pem)?,
        subject: subject_of(&certificate_pem)?,
        certificate_pem,
        not_after,
        source,
        created_at,
        previous,
    }))
}

/// Replace the CA, keeping the old certificate trusted for the grace period.
async fn replace(
    store: &PluginSecretStore,
    certificate_pem: &str,
    key_der: &[u8],
    not_after_millis: i64,
    source: &str,
    actor: &AuditActor,
) -> Result<CaInfo> {
    {
        let conn = store.conn.lock().await;
        let previous: Option<String> = conn
            .query_row(
                "SELECT certificate FROM vault_broker_ca WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let (key_version, nonce, ciphertext) = store.seal_row(key_der)?;
        let now = now_millis();
        conn.execute(
            "INSERT OR REPLACE INTO vault_broker_ca
                (id, certificate, nonce, ciphertext, key_version, not_after, created_at, source,
                 previous_certificate, rotated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                certificate_pem,
                nonce,
                ciphertext,
                key_version,
                not_after_millis,
                now,
                source,
                previous,
                previous.as_ref().map(|_| now),
            ],
        )?;
        GENERATION.fetch_add(1, Ordering::SeqCst);
        let action = if source == "imported" {
            "broker.ca.import"
        } else {
            "broker.ca.rotate"
        };
        store.audit_locked(
            &conn,
            &AuditEntry::new(actor, action, "ok").details(serde_json::json!({
                "fingerprintSha256": fingerprint(certificate_pem)?,
                "previousFingerprintSha256": previous.as_deref().map(fingerprint).transpose()?,
            })),
        );
    }
    info(store)
        .await?
        .ok_or_else(|| anyhow!("the broker CA disappeared after it was replaced"))
}

/// Replace the CA with a freshly generated one.
pub async fn rotate(store: &PluginSecretStore, actor: &AuditActor) -> Result<CaInfo> {
    if store.keyring.is_sealed() {
        return Err(crate::vault::VaultError::Sealed.into());
    }
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(rcgen_error)?;
    let now = OffsetDateTime::now_utc();
    let not_after = now + ROOT_TTL;
    let certificate_pem = ca_params(now - Duration::minutes(5), not_after)
        .self_signed(&key)
        .map_err(rcgen_error)?
        .pem();
    replace(
        store,
        &certificate_pem,
        &key.serialize_der(),
        not_after.unix_timestamp() * 1000,
        "generated",
        actor,
    )
    .await
}

fn invalid(message: &str) -> anyhow::Error {
    crate::vault::VaultError::Invalid(message.to_owned()).into()
}

/// Validate an operator CA: the certificate (normalized PEM), the PKCS#8 key
/// DER, and its expiry in epoch millis.
pub fn validate_import(certificate_pem: &str, key_pem: &str) -> Result<(String, Vec<u8>, i64)> {
    if certificate_pem.len() > MAX_PEM_BYTES || key_pem.len() > MAX_PEM_BYTES {
        return Err(invalid("the CA certificate or key is too large"));
    }
    let key = KeyPair::from_pem(key_pem)
        .map_err(|_| invalid("privateKey must be an unencrypted PKCS#8 PEM (BEGIN PRIVATE KEY)"))?;
    let (rest, pem) = x509_parser::pem::parse_x509_pem(certificate_pem.as_bytes())
        .map_err(|_| invalid("certificate must be one PEM certificate"))?;
    if pem.label != "CERTIFICATE" || x509_parser::pem::parse_x509_pem(rest).is_ok() {
        return Err(invalid("certificate must be exactly one PEM certificate"));
    }
    let (_, certificate) = x509_parser::parse_x509_certificate(&pem.contents)
        .map_err(|_| invalid("certificate could not be parsed"))?;
    let is_ca = certificate
        .basic_constraints()
        .ok()
        .flatten()
        .is_some_and(|constraints| constraints.value.ca);
    if !is_ca {
        return Err(invalid(
            "certificate is not a CA (basic constraints CA:TRUE)",
        ));
    }
    match certificate.key_usage() {
        Ok(Some(usage)) if !usage.value.key_cert_sign() => {
            return Err(invalid(
                "the CA key usage does not allow certificate signing",
            ))
        }
        Err(_) => return Err(invalid("the CA key usage could not be parsed")),
        _ => {}
    }
    let validity = certificate.validity();
    let not_after = validity.not_after.timestamp();
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if !validity.is_valid() || not_after - now < MIN_REMAINING_SECS {
        return Err(invalid(
            "the CA must be valid now and for at least another day",
        ));
    }
    if certificate.public_key().raw != key.subject_public_key_info().as_slice() {
        return Err(invalid("privateKey does not match the certificate"));
    }
    let normalized = der_to_pem(&pem.contents);
    // Prove the pair can actually issue the leaves the broker serves.
    let material = CaMaterial {
        certificate_pem: normalized.clone(),
        key_der: key.serialize_der(),
    };
    LeafCache::new(
        &material,
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .and_then(|cache| cache.leaf("broker-ca-check.invalid").map(|_| ()))
    .map_err(|_| invalid("the CA cannot issue broker leaves with this key"))?;
    Ok((normalized, material.key_der, not_after * 1000))
}

/// Replace the CA with an operator-supplied certificate and key.
pub async fn import(
    store: &PluginSecretStore,
    certificate_pem: &str,
    key_pem: &str,
    actor: &AuditActor,
) -> Result<CaInfo> {
    if store.keyring.is_sealed() {
        return Err(crate::vault::VaultError::Sealed.into());
    }
    let (certificate_pem, key_der, not_after) = validate_import(certificate_pem, key_pem)?;
    replace(
        store,
        &certificate_pem,
        &key_der,
        not_after,
        "imported",
        actor,
    )
    .await
}
