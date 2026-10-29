//! The broker's local interception CA.
//!
//! An ECDSA P-256 root generated on first use. Its private key is sealed with
//! the vault keyring in `vault_broker_ca` (so keyring rotation and rewrap
//! cover it), and only the certificate is ever returned. The proxy drops its
//! unsealed signing material whenever it sees the vault sealed, so a sealed
//! vault cannot intercept. Leaves for each intercepted host are minted on demand, valid
//! for 24 hours, and kept in a small least-recently-used cache.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use rusqlite::{params, Connection, OptionalExtension};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use time::{Duration, OffsetDateTime};

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::now_millis;

/// Root lifetime (10 years).
const ROOT_TTL: Duration = Duration::days(3650);
/// Leaf lifetime; a cached leaf is replaced an hour before it expires.
const LEAF_TTL: Duration = Duration::hours(24);
const LEAF_REFRESH_MARGIN: Duration = Duration::hours(1);
/// Most cached leaves.
pub const LEAF_CACHE_CAPACITY: usize = 256;
const CA_COMMON_NAME: &str = "Ryu Vault Broker CA";

/// Create the CA table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_ca (
             id          INTEGER PRIMARY KEY CHECK (id = 1),
             certificate TEXT NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             not_after   INTEGER NOT NULL,
             created_at  INTEGER NOT NULL
         );",
    )
    .context("initializing broker CA schema")
}

/// The CA certificate and its (unsealed) PKCS#8 key.
pub struct CaMaterial {
    pub certificate_pem: String,
    key_der: Vec<u8>,
}

fn ca_params(not_before: OffsetDateTime, not_after: OffsetDateTime) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, CA_COMMON_NAME);
    name.push(DnType::OrganizationName, "Ryu");
    params.distinguished_name = name;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.not_before = not_before;
    params.not_after = not_after;
    params
}

fn rcgen_error(error: rcgen::Error) -> anyhow::Error {
    anyhow!("broker CA: {error}")
}

/// Load the CA, generating and sealing it on first use.
pub async fn ensure(store: &PluginSecretStore) -> Result<CaMaterial> {
    let conn = store.conn.lock().await;
    if let Some(material) = load_locked(store, &conn)? {
        return Ok(material);
    }
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(rcgen_error)?;
    let now = OffsetDateTime::now_utc();
    let not_after = now + ROOT_TTL;
    let certificate_pem = ca_params(now - Duration::minutes(5), not_after)
        .self_signed(&key)
        .map_err(rcgen_error)?
        .pem();
    let key_der = key.serialize_der();
    let (key_version, nonce, ciphertext) = store.seal_row(&key_der)?;
    conn.execute(
        "INSERT INTO vault_broker_ca
            (id, certificate, nonce, ciphertext, key_version, not_after, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            certificate_pem,
            nonce,
            ciphertext,
            key_version,
            not_after.unix_timestamp() * 1000,
            now_millis()
        ],
    )?;
    store.audit_locked(
        &conn,
        &AuditEntry::new(&AuditActor::system(), "broker.ca.create", "ok"),
    );
    Ok(CaMaterial {
        certificate_pem,
        key_der,
    })
}

fn load_locked(store: &PluginSecretStore, conn: &Connection) -> Result<Option<CaMaterial>> {
    let row: Option<(String, Vec<u8>, Vec<u8>, u32)> = conn
        .query_row(
            "SELECT certificate, nonce, ciphertext, key_version FROM vault_broker_ca WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((certificate_pem, nonce, ciphertext, key_version)) = row else {
        return Ok(None);
    };
    let key_der = store.open_row(key_version, &nonce, &ciphertext)?;
    Ok(Some(CaMaterial {
        certificate_pem,
        key_der,
    }))
}

/// The CA certificate PEM (public), generating the CA if needed.
pub async fn certificate_pem(store: &PluginSecretStore) -> Result<String> {
    Ok(ensure(store).await?.certificate_pem)
}

/// The CA certificate PEM if the CA exists. Reads only the public column:
/// it never generates the CA, unseals its key, or writes an audit row, so it
/// is safe behind an unauthenticated route.
pub async fn existing_certificate_pem(store: &PluginSecretStore) -> Result<Option<String>> {
    let conn = store.conn.lock().await;
    Ok(conn
        .query_row(
            "SELECT certificate FROM vault_broker_ca WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// Where the broker CA was written for child processes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaFiles {
    /// The broker CA alone, for variables that add to the default trust
    /// store (`NODE_EXTRA_CA_CERTS`).
    pub ca_only: PathBuf,
    /// The OS trust store plus the broker CA, for variables that replace the
    /// default trust store (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
    /// `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`), so raw-tunneled hosts still
    /// verify under the `passthrough` policy.
    pub combined: PathBuf,
}

/// PEM-encode one DER certificate.
fn der_to_pem(der: &[u8]) -> String {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    let mut pem = String::with_capacity(encoded.len() + encoded.len() / 64 + 64);
    pem.push_str("-----BEGIN CERTIFICATE-----\n");
    for line in encoded.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}

/// The OS trust store followed by the broker CA.
pub fn combined_bundle(system_roots: &[CertificateDer<'_>], certificate_pem: &str) -> String {
    let mut bundle = String::new();
    for root in system_roots {
        bundle.push_str(&der_to_pem(root));
    }
    bundle.push_str(certificate_pem.trim_end());
    bundle.push('\n');
    bundle
}

/// Write the CA certificate (`<data dir>/state/vault/broker-ca.pem`) and the
/// combined OS-plus-broker bundle (`<data dir>/state/vault/broker-ca-bundle.pem`)
/// where child processes can read them.
pub fn write_bundle(certificate_pem: &str) -> Result<CaFiles> {
    let dir = crate::paths::state_path("vault");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let ca_only = dir.join("broker-ca.pem");
    std::fs::write(&ca_only, certificate_pem)
        .with_context(|| format!("writing {}", ca_only.display()))?;
    let loaded = rustls_native_certs::load_native_certs();
    if !loaded.errors.is_empty() {
        tracing::debug!(
            errors = loaded.errors.len(),
            "some OS trust anchors could not be loaded for the broker bundle"
        );
    }
    let combined = dir.join("broker-ca-bundle.pem");
    std::fs::write(&combined, combined_bundle(&loaded.certs, certificate_pem))
        .with_context(|| format!("writing {}", combined.display()))?;
    Ok(CaFiles { ca_only, combined })
}

struct CachedLeaf {
    key: Arc<CertifiedKey>,
    not_after: OffsetDateTime,
    last_used: u64,
}

/// Mints and caches per-host leaves signed by the broker CA.
pub struct LeafCache {
    issuer: Issuer<'static, KeyPair>,
    ca_der: CertificateDer<'static>,
    provider: Arc<CryptoProvider>,
    entries: Mutex<HashMap<String, CachedLeaf>>,
    clock: AtomicU64,
    capacity: usize,
}

impl std::fmt::Debug for LeafCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeafCache").finish_non_exhaustive()
    }
}

impl LeafCache {
    pub fn new(material: &CaMaterial, provider: Arc<CryptoProvider>) -> Result<Self> {
        let key = KeyPair::try_from(material.key_der.as_slice()).map_err(rcgen_error)?;
        let issuer =
            Issuer::from_ca_cert_pem(&material.certificate_pem, key).map_err(rcgen_error)?;
        let ca_der = rustls_pemfile_cert(&material.certificate_pem)?;
        Ok(Self {
            issuer,
            ca_der,
            provider,
            entries: Mutex::new(HashMap::new()),
            clock: AtomicU64::new(0),
            capacity: LEAF_CACHE_CAPACITY,
        })
    }

    /// The leaf for `host`, minting one when absent or near expiry.
    pub fn leaf(&self, host: &str) -> Result<Arc<CertifiedKey>> {
        let host = host.to_ascii_lowercase();
        let tick = self.clock.fetch_add(1, Ordering::Relaxed);
        let now = OffsetDateTime::now_utc();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("leaf cache poisoned"))?;
        if let Some(entry) = entries.get_mut(&host) {
            if entry.not_after - LEAF_REFRESH_MARGIN > now {
                entry.last_used = tick;
                return Ok(entry.key.clone());
            }
        }
        let (key, not_after) = self.mint(&host, now)?;
        if entries.len() >= self.capacity && !entries.contains_key(&host) {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(name, _)| name.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            host,
            CachedLeaf {
                key: key.clone(),
                not_after,
                last_used: tick,
            },
        );
        Ok(key)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    fn mint(&self, host: &str, now: OffsetDateTime) -> Result<(Arc<CertifiedKey>, OffsetDateTime)> {
        let mut params = CertificateParams::default();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, host);
        params.distinguished_name = name;
        params.subject_alt_names = vec![match host.parse::<IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) if !is_dns_name(host) => return Err(anyhow!("host is not a valid DNS name")),
            Err(_) => SanType::DnsName(
                host.to_owned()
                    .try_into()
                    .map_err(|_| anyhow!("host is not a valid DNS name"))?,
            ),
        }];
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        let not_after = now + LEAF_TTL;
        params.not_before = now - Duration::minutes(5);
        params.not_after = not_after;
        let leaf_key =
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(rcgen_error)?;
        let certificate = params
            .signed_by(&leaf_key, &self.issuer)
            .map_err(rcgen_error)?;
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let certified = CertifiedKey::from_der(
            vec![certificate.der().clone(), self.ca_der.clone()],
            key_der,
            &self.provider,
        )
        .map_err(|error| anyhow!("loading broker leaf: {error}"))?;
        Ok((Arc::new(certified), not_after))
    }
}

/// A conservative DNS-name check for leaf SANs (CONNECT authorities).
fn is_dns_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Decode the first certificate in a PEM string.
fn rustls_pemfile_cert(pem: &str) -> Result<CertificateDer<'static>> {
    use base64::Engine as _;
    let body: String = pem
        .lines()
        .skip_while(|line| !line.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|line| !line.starts_with("-----END CERTIFICATE-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .context("decoding broker CA PEM")?;
    Ok(CertificateDer::from(der))
}

/// Parse a PEM certificate into DER (for trust stores in tests and clients).
pub fn pem_to_der(pem: &str) -> Result<CertificateDer<'static>> {
    rustls_pemfile_cert(pem)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> Arc<CryptoProvider> {
        Arc::new(rustls::crypto::ring::default_provider())
    }

    #[tokio::test]
    async fn the_ca_is_created_once_and_sealed() {
        let store = PluginSecretStore::in_memory().unwrap();
        let first = certificate_pem(&store).await.unwrap();
        let second = certificate_pem(&store).await.unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("-----BEGIN CERTIFICATE-----"));
        let conn = store.conn.lock().await;
        let ciphertext: Vec<u8> = conn
            .query_row("SELECT ciphertext FROM vault_broker_ca", [], |row| {
                row.get(0)
            })
            .unwrap();
        let material = load_locked(&store, &conn).unwrap().unwrap();
        assert_ne!(ciphertext, material.key_der);
    }

    #[tokio::test]
    async fn the_public_read_never_creates_the_ca() {
        let store = PluginSecretStore::in_memory().unwrap();
        assert!(existing_certificate_pem(&store).await.unwrap().is_none());
        let created = certificate_pem(&store).await.unwrap();
        assert_eq!(
            existing_certificate_pem(&store).await.unwrap(),
            Some(created.clone())
        );
        store.keyring.seal();
        // The certificate is public: reading it needs no unsealed key.
        assert_eq!(
            existing_certificate_pem(&store).await.unwrap(),
            Some(created)
        );
    }

    #[test]
    fn the_combined_bundle_keeps_system_roots_and_adds_the_broker_ca() {
        let system = CertificateDer::from(vec![1u8, 2, 3, 4]);
        let bundle = combined_bundle(
            &[system],
            "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
        );
        assert_eq!(bundle.matches("-----BEGIN CERTIFICATE-----").count(), 2);
        assert!(bundle.starts_with("-----BEGIN CERTIFICATE-----\nAQIDBA==\n"));
        assert!(bundle.ends_with("QUJD\n-----END CERTIFICATE-----\n"));
    }

    #[tokio::test]
    async fn a_sealed_vault_cannot_load_the_ca_key() {
        let store = PluginSecretStore::in_memory().unwrap();
        ensure(&store).await.unwrap();
        store.keyring.seal();
        assert!(ensure(&store).await.is_err());
    }

    #[tokio::test]
    async fn leaves_chain_to_the_ca_and_are_cached() {
        let store = PluginSecretStore::in_memory().unwrap();
        let material = ensure(&store).await.unwrap();
        let cache = LeafCache::new(&material, provider()).unwrap();
        let first = cache.leaf("api.example.com").unwrap();
        let again = cache.leaf("API.example.com").unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.cert.len(), 2);
        assert_eq!(
            first.cert[1],
            pem_to_der(&material.certificate_pem).unwrap()
        );
        let ip = cache.leaf("127.0.0.1").unwrap();
        assert!(!Arc::ptr_eq(&first, &ip));
        assert!(cache.leaf("bad host").is_err());
    }

    #[tokio::test]
    async fn the_cache_evicts_the_least_recently_used_leaf() {
        let store = PluginSecretStore::in_memory().unwrap();
        let material = ensure(&store).await.unwrap();
        let mut cache = LeafCache::new(&material, provider()).unwrap();
        cache.capacity = 2;
        let a = cache.leaf("a.example.com").unwrap();
        cache.leaf("b.example.com").unwrap();
        cache.leaf("a.example.com").unwrap();
        cache.leaf("c.example.com").unwrap();
        assert_eq!(cache.len(), 2);
        assert!(Arc::ptr_eq(&a, &cache.leaf("a.example.com").unwrap()));
    }
}
