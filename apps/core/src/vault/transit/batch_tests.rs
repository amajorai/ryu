//! Tests for [`super::batch`]: per-item results and errors, references, and
//! the batch bounds.

use super::tests::actor;
use super::*;

fn item(field: &str, value: &str) -> TransitBatchItem {
    let mut item = TransitBatchItem::default();
    let value = Some(value.to_owned());
    match field {
        "plaintext" => item.plaintext = value,
        "ciphertext" => item.ciphertext = value,
        "input" => item.input = value,
        _ => unreachable!("{field}"),
    }
    item
}

#[tokio::test]
async fn encrypt_decrypt_and_rewrap_batches_report_each_item() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("orders", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let defaults = TransitBatchItem::default();
    let mut items = vec![
        item("plaintext", &B64.encode(b"one")),
        item("plaintext", "not base64 !!"),
        TransitBatchItem::default(),
        item("plaintext", &B64.encode(b"three")),
    ];
    items[0].reference = Some("a".into());
    items[3].reference = Some("d".into());
    let encrypted = store
        .transit_batch(
            "orders",
            TransitBatchOp::Encrypt,
            &items,
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(encrypted.len(), 4);
    assert!(encrypted[0]
        .ciphertext
        .as_deref()
        .unwrap()
        .starts_with("ryu:v1:"));
    assert_eq!(encrypted[0].reference.as_deref(), Some("a"));
    assert!(encrypted[1].error.as_deref().unwrap().contains("base64"));
    assert!(encrypted[1].ciphertext.is_none());
    assert!(encrypted[2]
        .error
        .as_deref()
        .unwrap()
        .contains("`plaintext` is required"));
    assert_eq!(encrypted[3].reference.as_deref(), Some("d"));
    let failures = encrypted.iter().filter(|result| result.is_error()).count();
    assert_eq!(failures, 2);

    let decrypt_items = vec![
        item("ciphertext", encrypted[0].ciphertext.as_deref().unwrap()),
        item(
            "ciphertext",
            "ryu:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
        item("ciphertext", encrypted[3].ciphertext.as_deref().unwrap()),
    ];
    let decrypted = store
        .transit_batch(
            "orders",
            TransitBatchOp::Decrypt,
            &decrypt_items,
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(
        decrypted[0].plaintext.as_deref(),
        Some(B64.encode(b"one").as_str())
    );
    assert!(decrypted[1]
        .error
        .as_deref()
        .unwrap()
        .contains("authentication"));
    assert_eq!(
        decrypted[2].plaintext.as_deref(),
        Some(B64.encode(b"three").as_str())
    );

    store.transit_rotate("orders", &actor()).await.unwrap();
    let rewrapped = store
        .transit_batch(
            "orders",
            TransitBatchOp::Rewrap,
            &decrypt_items,
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert!(rewrapped[0]
        .ciphertext
        .as_deref()
        .unwrap()
        .starts_with("ryu:v2:"));
    assert!(rewrapped[1].is_error());
}

#[tokio::test]
async fn sign_verify_hmac_and_cmac_batches_use_item_and_default_fields() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("signer", TransitKeyType::Ed25519, &actor())
        .await
        .unwrap();
    store
        .transit_create("mac", TransitKeyType::Aes128Cmac, &actor())
        .await
        .unwrap();
    let defaults = TransitBatchItem::default();
    let inputs = vec![
        item("input", &B64.encode(b"a")),
        item("input", &B64.encode(b"b")),
    ];
    let signed = store
        .transit_batch("signer", TransitBatchOp::Sign, &inputs, &defaults, &actor())
        .await
        .unwrap();
    let mut checks = Vec::new();
    for (input, result) in inputs.iter().zip(&signed) {
        let mut check = input.clone();
        check.signature = result.signature.clone();
        checks.push(check);
    }
    // Swap one signature onto the other input: that item is invalid, not an error.
    let mut forged = checks[0].clone();
    forged.signature = checks[1].signature.clone();
    checks.push(forged);
    let mut ambiguous = checks[0].clone();
    ambiguous.hmac = Some("ryu:v1:AAAA".into());
    checks.push(ambiguous);
    let verified = store
        .transit_batch(
            "signer",
            TransitBatchOp::Verify,
            &checks,
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(verified[0].valid, Some(true));
    assert_eq!(verified[1].valid, Some(true));
    assert_eq!(verified[2].valid, Some(false));
    assert!(verified[3]
        .error
        .as_deref()
        .unwrap()
        .contains("exactly one"));

    let hmacs = store
        .transit_batch("signer", TransitBatchOp::Hmac, &inputs, &defaults, &actor())
        .await
        .unwrap();
    assert!(hmacs.iter().all(|result| result.hmac.is_some()));
    // The CMAC key refuses HMAC item by item.
    let refused = store
        .transit_batch("mac", TransitBatchOp::Hmac, &inputs, &defaults, &actor())
        .await
        .unwrap();
    assert!(refused.iter().all(TransitBatchResult::is_error));

    let short = TransitBatchItem {
        mac_length: Some(4),
        ..TransitBatchItem::default()
    };
    let cmacs = store
        .transit_batch("mac", TransitBatchOp::Cmac, &inputs, &short, &actor())
        .await
        .unwrap();
    let mut cmac_checks = Vec::new();
    for (input, result) in inputs.iter().zip(&cmacs) {
        assert_eq!(decode(result.cmac.as_deref().unwrap()).unwrap().1.len(), 4);
        let mut check = input.clone();
        check.cmac = result.cmac.clone();
        cmac_checks.push(check);
    }
    cmac_checks[1].input = Some(B64.encode(b"changed"));
    let cmac_verified = store
        .transit_batch(
            "mac",
            TransitBatchOp::CmacVerify,
            &cmac_checks,
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(cmac_verified[0].valid, Some(true));
    assert_eq!(cmac_verified[1].valid, Some(false));
}

#[tokio::test]
async fn batches_are_bounded_and_only_batchable_operations_parse() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .transit_create("k", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let defaults = TransitBatchItem::default();
    assert!(store
        .transit_batch("k", TransitBatchOp::Encrypt, &[], &defaults, &actor())
        .await
        .is_err());
    let too_many = vec![item("plaintext", &B64.encode(b"x")); MAX_BATCH_ITEMS + 1];
    let error = store
        .transit_batch("k", TransitBatchOp::Encrypt, &too_many, &defaults, &actor())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("at most"));
    // A missing key fails every item, not the batch.
    let results = store
        .transit_batch(
            "missing",
            TransitBatchOp::Encrypt,
            &too_many[..2],
            &defaults,
            &actor(),
        )
        .await
        .unwrap();
    assert!(results.iter().all(|result| result
        .error
        .as_deref()
        .unwrap()
        .starts_with("vault_not_found")));
    for op in [
        "encrypt",
        "decrypt",
        "rewrap",
        "sign",
        "verify",
        "hmac",
        "cmac",
        "cmac-verify",
    ] {
        assert!(TransitBatchOp::parse(op).is_some(), "{op}");
    }
    for op in ["datakey", "rotate", "export", ""] {
        assert!(TransitBatchOp::parse(op).is_none(), "{op}");
    }
}
