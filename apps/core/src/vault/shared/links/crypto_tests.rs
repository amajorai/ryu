//! Share and request crypto, pinned to the browser's vectors in
//! `apps/web/src/lib/vault-share-crypto.test.ts`.

use super::*;

const REQUEST_SECRET: &str = "AMR1Y-unyaHdsXjFtRW_z3kCaUXuMn4eaHyVwxoVAHE";
const REQUEST_PUBLIC: &str =
    "BK9FhGbY4FVzEarlTeT_mfFVFz9Qb51pT2FuHHHg9-0XCQjnBtAJFhMrlg6XHNvcBFglnWX3FVxXS_S7sFtA658";
const SHARE_BLOB: &str =
    "AAECAwQFBgcICQoLPCC4eqiA4CGvAMfC7qI9NKH6pUKRFyoZGl3H9i4Kctd1MtNy6p3evFLeXLHQ0NUyAieL";

fn browser_answer() -> SealedAnswer {
    SealedAnswer {
        epk: "BL9OWMTvo3HgXooEls0_NVl53iaRJ2d9LXihcj88tzDW7qUifsuygwSuEJqeFwy36e0HdAxz9mcd-4WGWLwxcBw"
            .into(),
        nonce: "ZGVmZ2hpamtsbW5v".into(),
        ciphertext: "L3ACXEXo8-Y6yL6hkHcSdXkXvRyL0-LMxZoI7ojm".into(),
    }
}

fn secret() -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(REQUEST_SECRET).unwrap()
}

#[test]
fn shares_match_the_browser_vector() {
    let key: [u8; 32] = std::array::from_fn(|index| index as u8);
    let nonce: [u8; 12] = std::array::from_fn(|index| index as u8);
    let plaintext =
        serde_json::to_vec(&serde_json::json!({ "name": "API_KEY", "value": "s3cret" })).unwrap();
    assert_eq!(
        seal_share_with(&plaintext, &key, &nonce).unwrap(),
        SHARE_BLOB
    );
}

#[test]
fn fresh_shares_use_fresh_keys_and_respect_the_size_cap() {
    let first = seal_share(b"{}").unwrap();
    let second = seal_share(b"{}").unwrap();
    assert_ne!(first.blob, second.blob);
    assert_ne!(*first.fragment_key, *second.fragment_key);
    assert_eq!(first.fragment_key.len(), 43);
    assert!(seal_share(&vec![b'a'; MAX_SHARE_PLAINTEXT + 1]).is_err());
}

#[test]
fn browser_answers_open_with_the_request_key() {
    assert_eq!(request_public_key(&secret()).unwrap(), REQUEST_PUBLIC);
    let plain = open_answer(&secret(), &browser_answer()).unwrap();
    assert_eq!(plain.as_slice(), b"sk_live_answer");
}

#[test]
fn tampered_answers_and_other_keys_fail() {
    let mut tampered = browser_answer();
    tampered.ciphertext = tampered.ciphertext.replace('L', "M");
    assert!(open_answer(&secret(), &tampered).is_err());
    let mut bad_point = browser_answer();
    bad_point.epk = REQUEST_PUBLIC.replace('B', "C");
    assert!(open_answer(&secret(), &bad_point).is_err());
    let (other, public) = new_request_key().unwrap();
    assert_eq!(URL_SAFE_NO_PAD.decode(&public).unwrap().len(), 65);
    assert!(open_answer(&other, &browser_answer()).is_err());
}
