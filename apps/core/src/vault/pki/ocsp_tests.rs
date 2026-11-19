//! Tests for [`super::ocsp`]: good, revoked, and unknown answers whose
//! signatures verify against the issuer, nonces, and refusals.

use sha1::Sha1;
use sha2::{Digest, Sha256};
use x509_parser::asn1_rs::BitString;
use x509_parser::prelude::*;

use super::der;
use super::keys::{KeySpec, PkiKeyType};
use super::tests::{actor, setup};
use super::*;

/// A `CertID` for `serial` (hex) under the issuer certificate `issuer_pem`.
fn cert_id(issuer_pem: &str, serial: &str, sha256: bool) -> Vec<u8> {
    let der_cert = pem_certificates(issuer_pem).unwrap().remove(0);
    let (_, cert) = parse_x509_certificate(&der_cert).unwrap();
    let name = cert.subject().as_raw();
    let key = &cert.public_key().subject_public_key.data;
    let (oid, name_hash, key_hash) = if sha256 {
        (
            "2.16.840.1.101.3.4.2.1",
            Sha256::digest(name).to_vec(),
            Sha256::digest(key).to_vec(),
        )
    } else {
        (
            "1.3.14.3.2.26",
            Sha1::digest(name).to_vec(),
            Sha1::digest(key).to_vec(),
        )
    };
    let mut serial = hex::decode(serial).unwrap();
    if serial[0] & 0x80 != 0 {
        serial.insert(0, 0);
    }
    der::sequence(&[
        &der::sequence(&[&der::oid(oid), &der::tlv(der::NULL, &[])]),
        &der::tlv(der::OCTET_STRING, &name_hash),
        &der::tlv(der::OCTET_STRING, &key_hash),
        &der::tlv(der::INTEGER, &serial),
    ])
}

fn request(ids: &[Vec<u8>], nonce: Option<&[u8]>) -> Vec<u8> {
    let singles: Vec<Vec<u8>> = ids.iter().map(|id| der::sequence(&[id])).collect();
    let mut tbs = vec![der::tlv(der::SEQUENCE, &singles.concat())];
    if let Some(nonce) = nonce {
        let extension = der::sequence(&[
            &der::oid("1.3.6.1.5.5.7.48.1.2"),
            &der::tlv(der::OCTET_STRING, &der::tlv(der::OCTET_STRING, nonce)),
        ]);
        tbs.push(der::tlv(der::context(2), &der::sequence(&[&extension])));
    }
    der::sequence(&[&der::tlv(der::SEQUENCE, &tbs.concat())])
}

/// A parsed, signature-checked successful response: the status tag of each
/// answer in order, and whether the nonce came back.
struct Answer {
    statuses: Vec<u8>,
    revoked_at: Vec<Option<String>>,
    echoed_nonce: bool,
}

fn status_of(response: &[u8]) -> u8 {
    let (outer, _) = der::expect(response, der::SEQUENCE).unwrap();
    let (status, _) = der::expect(outer.value, der::ENUMERATED).unwrap();
    status.value[0]
}

fn verify_answer(response: &[u8], issuer_pem: &str, nonce: &[u8]) -> Answer {
    assert_eq!(status_of(response), 0, "successful");
    let (outer, _) = der::expect(response, der::SEQUENCE).unwrap();
    let fields = der::items(outer.value).unwrap();
    let (bytes, _) = der::expect(fields[1].value, der::SEQUENCE).unwrap();
    let parts = der::items(bytes.value).unwrap();
    assert_eq!(parts[0].raw, der::oid("1.3.6.1.5.5.7.48.1.1").as_slice());
    let (basic, _) = der::expect(parts[1].value, der::SEQUENCE).unwrap();
    let basic = der::items(basic.value).unwrap();
    let (tbs, algorithm, signature) = (basic[0], basic[1], basic[2]);
    // The signature verifies with the issuer certificate's key.
    let issuer_der = pem_certificates(issuer_pem).unwrap().remove(0);
    let (_, issuer) = parse_x509_certificate(&issuer_der).unwrap();
    let (_, algorithm) = AlgorithmIdentifier::from_der(algorithm.raw).unwrap();
    assert_eq!(signature.value[0], 0, "no unused bits");
    let bits = BitString::new(0, &signature.value[1..]);
    x509_parser::verify::verify_signature(issuer.public_key(), &algorithm, &bits, tbs.raw)
        .expect("the OCSP response signature verifies against the issuer");
    // A flipped byte in the signed data no longer verifies.
    let mut tampered = tbs.raw.to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(x509_parser::verify::verify_signature(
        issuer.public_key(),
        &algorithm,
        &bits,
        &tampered
    )
    .is_err());
    let data = der::items(tbs.value).unwrap();
    // responderID byKey: SHA-1 of the issuer public key.
    let (key_hash, _) = der::expect(data[0].value, der::OCTET_STRING).unwrap();
    assert_eq!(
        key_hash.value,
        Sha1::digest(&issuer.public_key().subject_public_key.data).as_slice()
    );
    let mut statuses = Vec::new();
    let mut revoked_at = Vec::new();
    for single in der::items(data[2].value).unwrap() {
        let parts = der::items(single.value).unwrap();
        statuses.push(parts[1].tag);
        revoked_at.push((parts[1].tag == 0xa1).then(|| {
            let (time, _) = der::expect(parts[1].value, der::GENERALIZED_TIME).unwrap();
            String::from_utf8(time.value.to_vec()).unwrap()
        }));
        assert_eq!(parts[2].tag, der::GENERALIZED_TIME, "thisUpdate");
        assert_eq!(parts[3].tag, der::context(0), "nextUpdate");
    }
    let echoed_nonce = data.get(3).is_some_and(|extensions| {
        extensions.tag == der::context(1)
            && extensions
                .raw
                .windows(nonce.len())
                .any(|window| window == nonce)
    });
    Answer {
        statuses,
        revoked_at,
        echoed_nonce,
    }
}

const GOOD: u8 = 0x80;
const REVOKED: u8 = 0xa1;
const UNKNOWN: u8 = 0x82;

#[tokio::test]
async fn ocsp_answers_good_revoked_and_unknown_signed_by_the_issuer() {
    let store = setup().await;
    let root = &store.pki_list_issuers().await.unwrap()[0];
    let good = store
        .pki_issue("web", "a.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    let revoked = store
        .pki_issue("web", "b.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    store.pki_revoke(&revoked.serial, &actor()).await.unwrap();
    let never_issued = "1122334455667788990011223344556677";
    let ids = vec![
        cert_id(&root.certificate, &good.serial, false),
        cert_id(&root.certificate, &revoked.serial, true),
        cert_id(&root.certificate, never_issued, false),
    ];
    let nonce = b"nonce-0123456789";
    let response = store
        .pki_ocsp("internal", &request(&ids, Some(nonce)))
        .await;
    let answer = verify_answer(&response, &root.certificate, nonce);
    assert_eq!(answer.statuses, vec![GOOD, REVOKED, UNKNOWN]);
    assert!(answer.revoked_at[1].as_deref().unwrap().ends_with('Z'));
    assert!(answer.echoed_nonce);
    // Without a nonce, none comes back.
    let response = store.pki_ocsp("internal", &request(&ids[..1], None)).await;
    let answer = verify_answer(&response, &root.certificate, nonce);
    assert_eq!(answer.statuses, vec![GOOD]);
    assert!(!answer.echoed_nonce);
}

#[tokio::test]
async fn ocsp_from_rsa_and_ed25519_issuers_verifies_and_rejects_foreign_cert_ids() {
    let store = setup().await;
    let internal = store.pki_list_issuers().await.unwrap()[0].clone();
    for (name, spec) in [
        ("rsa", KeySpec::new(PkiKeyType::Rsa, None).unwrap()),
        ("ed", KeySpec::new(PkiKeyType::Ed25519, None).unwrap()),
    ] {
        let root = store
            .pki_create_root_with(name, "Other CA", 86_400, spec, &actor())
            .await
            .unwrap();
        // A serial issued by `internal`, asked of this issuer: its hashes do
        // not match, so the answer is unknown, never good.
        let issued = store
            .pki_issue("web", "c.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        let ids = vec![
            cert_id(&internal.certificate, &issued.serial, false),
            cert_id(&root.certificate, &issued.serial, false),
        ];
        let response = store.pki_ocsp(name, &request(&ids, None)).await;
        let answer = verify_answer(&response, &root.certificate, b"-");
        assert_eq!(answer.statuses, vec![UNKNOWN, UNKNOWN], "{name}");
    }
}

#[tokio::test]
async fn ocsp_refuses_malformed_requests_and_unknown_issuers_unsigned() {
    let store = setup().await;
    let root = &store.pki_list_issuers().await.unwrap()[0];
    let id = cert_id(&root.certificate, "01", false);
    assert_eq!(status_of(&store.pki_ocsp("internal", b"not der").await), 1);
    assert_eq!(
        status_of(&store.pki_ocsp("internal", &request(&[], None)).await),
        1
    );
    let too_many = vec![id.clone(); 33];
    assert_eq!(
        status_of(&store.pki_ocsp("internal", &request(&too_many, None)).await),
        1
    );
    let unknown = store
        .pki_ocsp("nobody", &request(&[id.clone()], None))
        .await;
    assert_eq!(unknown, [0x30, 0x03, 0x0a, 0x01, 0x06]);
    // A pending intermediate cannot answer either.
    store
        .pki_generate_intermediate("pending", "Pending", &actor())
        .await
        .unwrap();
    assert_eq!(
        status_of(&store.pki_ocsp("pending", &request(&[id], None)).await),
        6
    );
}

#[tokio::test]
async fn openssl_verifies_the_ocsp_response_when_available() {
    if std::process::Command::new("openssl")
        .arg("version")
        .output()
        .is_err()
    {
        return;
    }
    let store = setup().await;
    let root = store.pki_list_issuers().await.unwrap()[0].clone();
    let good = store
        .pki_issue("web", "d.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    let revoked = store
        .pki_issue("web", "e.svc.local", &[], &[], None, &actor())
        .await
        .unwrap();
    store.pki_revoke(&revoked.serial, &actor()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ca = dir.path().join("ca.pem");
    std::fs::write(&ca, &root.certificate).unwrap();
    for (serial, expected) in [(&good.serial, "good"), (&revoked.serial, "revoked")] {
        let id = cert_id(&root.certificate, serial, false);
        let response = store.pki_ocsp("internal", &request(&[id], None)).await;
        let path = dir.path().join("response.der");
        std::fs::write(&path, &response).unwrap();
        let output = std::process::Command::new("openssl")
            .args(["ocsp", "-respin"])
            .arg(&path)
            .arg("-issuer")
            .arg(&ca)
            .arg("-VAfile")
            .arg(&ca)
            .arg("-serial")
            .arg(format!("0x{serial}"))
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(text.contains("Response verify OK"), "{text}");
        assert!(text.contains(&format!(": {expected}")), "{text}");
    }
}
