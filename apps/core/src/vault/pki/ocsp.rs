//! OCSP responder (RFC 6960) for each issuer.
//!
//! The responder is the issuer itself: answers are signed with the issuer key
//! (so no delegated responder certificate is needed) and name the responder by
//! the SHA-1 hash of the issuer's public key. For each requested `CertID` it
//! answers `good` for a serial this issuer recorded and has not revoked,
//! `revoked` (with the revocation time) for a revoked one, and `unknown` for a
//! serial it never issued or a `CertID` whose issuer hashes do not match this
//! issuer. A request nonce is echoed back. An unknown or pending issuer gets
//! `unauthorized`, a request that does not parse gets `malformedRequest`, and
//! a sealed vault gets `tryLater`, all unsigned, as RFC 6960 §2.3 allows. The responder only reads: it never
//! writes or audits, like the CRL.

use rcgen::SigningKey as _;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::der::{self, Tlv};
use super::*;

/// Media type of an OCSP response.
pub const OCSP_RESPONSE_CONTENT_TYPE: &str = "application/ocsp-response";
/// Largest accepted DER request.
pub const MAX_OCSP_REQUEST_BYTES: usize = 16 * 1024;
/// Most `CertID`s answered in one request.
const MAX_OCSP_REQUESTS: usize = 32;
/// How long an answer may be cached (`nextUpdate`), as Vault's `ocsp_expiry`.
const OCSP_VALIDITY_SECS: i64 = 12 * 3600;

const OID_OCSP_BASIC: &str = "1.3.6.1.5.5.7.48.1.1";
const OID_OCSP_NONCE: &str = "1.3.6.1.5.5.7.48.1.2";
const OID_SHA1: &str = "1.3.14.3.2.26";
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";

/// `OCSPResponseStatus` values used here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcspResponseStatus {
    Successful = 0,
    MalformedRequest = 1,
    InternalError = 2,
    TryLater = 3,
    Unauthorized = 6,
}

/// One requested certificate.
struct CertId<'a> {
    /// The full `CertID` encoding, echoed in the answer.
    raw: &'a [u8],
    /// The hash algorithm OID (encoded TLV).
    hash_algorithm: &'a [u8],
    name_hash: &'a [u8],
    key_hash: &'a [u8],
    serial: &'a [u8],
}

struct OcspRequest<'a> {
    cert_ids: Vec<CertId<'a>>,
    /// The nonce `Extension`, echoed in `responseExtensions`.
    nonce: Option<&'a [u8]>,
}

fn parse_cert_id(tlv: Tlv<'_>) -> Result<CertId<'_>> {
    let fields = der::items(tlv.value)?;
    let [algorithm, name_hash, key_hash, serial] = fields.as_slice() else {
        bail!("CertID has the wrong shape");
    };
    let (hash_algorithm, _) = der::expect(algorithm.value, der::OID)?;
    for (field, tag) in [
        (name_hash, der::OCTET_STRING),
        (key_hash, der::OCTET_STRING),
        (serial, der::INTEGER),
    ] {
        if field.tag != tag {
            bail!("CertID field has the wrong type");
        }
    }
    Ok(CertId {
        raw: tlv.raw,
        hash_algorithm: hash_algorithm.raw,
        name_hash: name_hash.value,
        key_hash: key_hash.value,
        serial: serial.value,
    })
}

fn find_nonce(extensions: Tlv<'_>) -> Result<Option<&[u8]>> {
    let (list, _) = der::expect(extensions.value, der::SEQUENCE)?;
    let nonce_oid = der::oid(OID_OCSP_NONCE);
    for extension in der::items(list.value)? {
        let (id, _) = der::read(extension.value)?;
        if id.raw == nonce_oid.as_slice() {
            return Ok(Some(extension.raw));
        }
    }
    Ok(None)
}

fn parse_request(input: &[u8]) -> Result<OcspRequest<'_>> {
    let (request, rest) = der::expect(input, der::SEQUENCE)?;
    if !rest.is_empty() {
        bail!("trailing data after the OCSP request");
    }
    let (tbs, _) = der::expect(request.value, der::SEQUENCE)?;
    let mut cert_ids = Vec::new();
    let mut nonce = None;
    let mut seen_list = false;
    for field in der::items(tbs.value)? {
        match field.tag {
            tag if tag == der::context(0) || tag == der::context(1) => {}
            der::SEQUENCE if !seen_list => {
                seen_list = true;
                for single in der::items(field.value)? {
                    let (cert_id, _) = der::expect(single.value, der::SEQUENCE)?;
                    cert_ids.push(parse_cert_id(cert_id)?);
                }
            }
            tag if tag == der::context(2) => nonce = find_nonce(field)?,
            _ => bail!("unexpected field in the OCSP request"),
        }
    }
    if cert_ids.is_empty() || cert_ids.len() > MAX_OCSP_REQUESTS {
        bail!("an OCSP request names 1 to {MAX_OCSP_REQUESTS} certificates");
    }
    Ok(OcspRequest { cert_ids, nonce })
}

/// An unsigned response carrying only a non-successful status.
pub(super) fn status_response(status: OcspResponseStatus) -> Vec<u8> {
    der::sequence(&[&der::tlv(der::ENUMERATED, &[status as u8])])
}

/// What the responder needs from its issuer.
struct Responder {
    name_der: Vec<u8>,
    public_key: Vec<u8>,
}

impl Responder {
    fn from_pem(certificate: &str) -> Result<Self> {
        let der = pem_certificates(certificate)?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("issuer has no certificate"))?;
        let (_, cert) = x509_parser::parse_x509_certificate(&der)
            .map_err(|_| anyhow!("issuer certificate is not valid X.509"))?;
        Ok(Self {
            name_der: cert.subject().as_raw().to_vec(),
            public_key: cert.public_key().subject_public_key.data.to_vec(),
        })
    }

    /// Whether `id` names this issuer (hash algorithm SHA-1 or SHA-256).
    fn matches(&self, id: &CertId<'_>) -> bool {
        let (name, key) = if id.hash_algorithm == der::oid(OID_SHA1).as_slice() {
            (
                Sha1::digest(&self.name_der).to_vec(),
                Sha1::digest(&self.public_key).to_vec(),
            )
        } else if id.hash_algorithm == der::oid(OID_SHA256).as_slice() {
            (
                Sha256::digest(&self.name_der).to_vec(),
                Sha256::digest(&self.public_key).to_vec(),
            )
        } else {
            return false;
        };
        name == id.name_hash && key == id.key_hash
    }
}

/// The DER `AlgorithmIdentifier` of the signature an issuer key makes.
fn signature_algorithm(key: &KeyPair) -> Result<Vec<u8>> {
    let alg = key.algorithm();
    Ok(if alg == &rcgen::PKCS_ECDSA_P256_SHA256 {
        der::sequence(&[&der::oid("1.2.840.10045.4.3.2")])
    } else if alg == &rcgen::PKCS_ECDSA_P384_SHA384 {
        der::sequence(&[&der::oid("1.2.840.10045.4.3.3")])
    } else if alg == &rcgen::PKCS_ED25519 {
        der::sequence(&[&der::oid("1.3.101.112")])
    } else if alg == &rcgen::PKCS_RSA_SHA256 {
        der::sequence(&[
            &der::oid("1.2.840.113549.1.1.11"),
            &der::tlv(der::NULL, &[]),
        ])
    } else {
        bail!("unsupported issuer key algorithm for OCSP");
    })
}

/// Lowercase hex of a DER INTEGER's magnitude (leading zeros dropped), the
/// form serials are recorded in.
fn serial_hex(serial: &[u8]) -> String {
    let start = serial
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(serial.len());
    hex::encode(&serial[start..])
}

impl PluginSecretStore {
    /// Answer a DER `OCSPRequest` for `issuer_name`. Always returns a DER
    /// `OCSPResponse`; failures are encoded as response statuses.
    pub async fn pki_ocsp(&self, issuer_name: &str, request: &[u8]) -> Vec<u8> {
        if request.len() > MAX_OCSP_REQUEST_BYTES {
            return status_response(OcspResponseStatus::MalformedRequest);
        }
        let Ok(parsed) = parse_request(request) else {
            return status_response(OcspResponseStatus::MalformedRequest);
        };
        match self.pki_ocsp_answer(issuer_name, &parsed).await {
            Ok(Some(response)) => response,
            Ok(None) => status_response(OcspResponseStatus::Unauthorized),
            Err(error) => {
                tracing::warn!("OCSP response for issuer `{issuer_name}` failed: {error:#}");
                status_response(OcspResponseStatus::InternalError)
            }
        }
    }

    async fn pki_ocsp_answer(
        &self,
        issuer_name: &str,
        request: &OcspRequest<'_>,
    ) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().await;
        let issuer = match self.load_issuer(&conn, issuer_name) {
            Ok(issuer) => issuer,
            Err(error)
                if matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Sealed)) =>
            {
                return Ok(Some(status_response(OcspResponseStatus::TryLater)));
            }
            Err(_) => return Ok(None),
        };
        let responder = Responder::from_pem(&issuer.certificate)?;
        let now = now_millis() / 1000;
        let this_update = der::generalized_time(now);
        let next_update = der::tlv(
            der::context(0),
            &der::generalized_time(now + OCSP_VALIDITY_SECS),
        );
        let mut responses = Vec::new();
        for id in &request.cert_ids {
            let status = if responder.matches(id) {
                let revoked: Option<Option<i64>> = conn
                    .query_row(
                        "SELECT revoked_at FROM vault_pki_certs WHERE serial = ?1 AND issuer = ?2",
                        params![serial_hex(id.serial), issuer_name],
                        |row| row.get(0),
                    )
                    .optional()?;
                match revoked {
                    Some(None) => der::tlv(der::context_primitive(0), &[]),
                    Some(Some(at)) => der::tlv(der::context(1), &der::generalized_time(at / 1000)),
                    None => der::tlv(der::context_primitive(2), &[]),
                }
            } else {
                der::tlv(der::context_primitive(2), &[])
            };
            responses.push(der::sequence(&[
                id.raw,
                &status,
                &this_update,
                &next_update,
            ]));
        }
        drop(conn);
        let key_hash = Sha1::digest(&responder.public_key);
        let responder_id = der::tlv(der::context(2), &der::tlv(der::OCTET_STRING, &key_hash));
        let mut tbs_parts = vec![
            responder_id,
            der::generalized_time(now),
            der::tlv(der::SEQUENCE, &responses.concat()),
        ];
        if let Some(nonce) = request.nonce {
            tbs_parts.push(der::tlv(der::context(1), &der::sequence(&[nonce])));
        }
        let tbs = der::tlv(der::SEQUENCE, &tbs_parts.concat());
        let signature = issuer.key.sign(&tbs).map_err(pki_error)?;
        let basic = der::sequence(&[
            &tbs,
            &signature_algorithm(&issuer.key)?,
            &der::bit_string(&signature),
        ]);
        let response_bytes = der::sequence(&[
            &der::oid(OID_OCSP_BASIC),
            &der::tlv(der::OCTET_STRING, &basic),
        ]);
        Ok(Some(der::sequence(&[
            &der::tlv(der::ENUMERATED, &[OcspResponseStatus::Successful as u8]),
            &der::tlv(der::context(0), &response_bytes),
        ])))
    }
}
