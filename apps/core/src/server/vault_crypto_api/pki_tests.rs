//! `keyType`/`keyBits` on intermediate generation: the requested key is the
//! key in the CSR, and an invalid type or size is refused before any key is
//! generated.

use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

use super::*;

fn actor() -> AuditActor {
    AuditActor::new("operator", None)
}

fn body(value: Value) -> IntermediateBody {
    serde_json::from_value(value).unwrap()
}

async fn answer(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// The key type and size of the public key in a CSR: `("rsa", modulus
/// bits)`, `("ec", curve bits)` or `("ed25519", 0)`.
fn csr_key(csr: &str) -> (&'static str, usize) {
    let (_, pem) = x509_parser::pem::parse_x509_pem(csr.as_bytes()).unwrap();
    let (_, request) = X509CertificationRequest::from_der(&pem.contents).unwrap();
    let info = &request.certification_request_info.subject_pki;
    match info.parsed().unwrap() {
        PublicKey::RSA(rsa) => ("rsa", rsa.key_size()),
        PublicKey::EC(point) => match point.data().len() {
            65 => ("ec", 256),
            97 => ("ec", 384),
            other => panic!("unexpected EC point length {other}"),
        },
        _ if info.algorithm.algorithm.to_id_string() == "1.3.101.112" => ("ed25519", 0),
        other => panic!("unexpected key {other:?}"),
    }
}

async fn generate(store: &PluginSecretStore, name: &str, request: Value) -> (StatusCode, Value) {
    answer(generate_intermediate(store, name, &body(request), &actor()).await).await
}

#[tokio::test]
async fn intermediates_take_the_requested_key_type_and_size() {
    let store = PluginSecretStore::in_memory().unwrap();
    let cases = [
        ("int-default", json!({ "commonName": "Default" }), "ec", 256),
        (
            "int-p384",
            json!({ "commonName": "P-384", "keyType": "ec", "keyBits": 384 }),
            "ec",
            384,
        ),
        (
            "int-rsa",
            json!({ "commonName": "RSA", "keyType": "rsa" }),
            "rsa",
            2048,
        ),
        (
            "int-ed",
            json!({ "commonName": "Edge", "keyType": "ed25519" }),
            "ed25519",
            0,
        ),
    ];
    for (name, request, key_type, bits) in cases {
        let (status, value) = generate(&store, name, request).await;
        assert_eq!(status, StatusCode::OK, "{name}: {value}");
        let issuer = &value["issuer"];
        assert_eq!(issuer["keyType"], key_type, "{name}");
        assert_eq!(issuer["kind"], "intermediate", "{name}");
        let csr = issuer["csr"].as_str().expect("a pending CSR");
        assert_eq!(csr_key(csr), (key_type, bits), "{name}");
    }
}

#[tokio::test]
async fn an_invalid_key_type_or_size_is_refused_before_anything_is_stored() {
    let store = PluginSecretStore::in_memory().unwrap();
    for request in [
        json!({ "commonName": "Weak", "keyType": "rsa", "keyBits": 1024 }),
        json!({ "commonName": "Curve", "keyType": "ec", "keyBits": 521 }),
        json!({ "commonName": "Edge", "keyType": "ed25519", "keyBits": 256 }),
    ] {
        let (status, value) = generate(&store, "int-bad", request.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{request}: {value}");
    }
    assert!(store.pki_list_issuers().await.unwrap().is_empty());
    assert!(serde_json::from_value::<IntermediateBody>(
        json!({ "commonName": "Old", "keyType": "dsa" })
    )
    .is_err());
}
