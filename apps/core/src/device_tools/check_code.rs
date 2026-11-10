//! The pairing check code: a short fingerprint of a paired phone's signing
//! key that the phone and the host both show, so the owner can confirm that
//! the device they approve is the phone in their hand.
//!
//! Shared contract (Core, phones, desktop):
//! `code = Crockford-base32(SHA-256("ryu-device-check-v1\n" || device_id ||
//! "\n" || public_key_spki))[..6]`, shown as `XXX-XXX`. `device_id` is the
//! lowercase UUID as UTF-8; `public_key_spki` is the exact DER registered at
//! pairing. The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, bits taken
//! most-significant first, so the 6 characters are the hash's first 30 bits.

use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"ryu-device-check-v1\n";
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS: usize = 6;

/// The `XXX-XXX` check code of `device_id` paired with `public_key_spki`.
pub(crate) fn check_code(device_id: &str, public_key_spki: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(device_id.to_lowercase().as_bytes());
    hasher.update(b"\n");
    hasher.update(public_key_spki);
    let digest = hasher.finalize();
    // The first 30 bits, as a big-endian integer of the first four bytes.
    let head = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut code = String::with_capacity(CODE_CHARS + 1);
    for index in 0..CODE_CHARS {
        if index == CODE_CHARS / 2 {
            code.push('-');
        }
        let shift = 32 - 5 * (index + 1);
        let value = (head >> shift) & 0x1f;
        code.push(char::from(ALPHABET[value as usize]));
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_DEVICE_ID: &str = "00000000-0000-4000-8000-000000000001";

    /// Bit-by-bit reference encoder, independent of the shift arithmetic.
    fn reference(device_id: &str, spki: &[u8]) -> String {
        let mut input = DOMAIN.to_vec();
        input.extend_from_slice(device_id.to_lowercase().as_bytes());
        input.push(b'\n');
        input.extend_from_slice(spki);
        let digest = Sha256::digest(&input);
        let bits: Vec<u8> = digest
            .iter()
            .flat_map(|byte| (0..8).rev().map(move |bit| (byte >> bit) & 1))
            .collect();
        let chars: String = bits
            .chunks(5)
            .take(CODE_CHARS)
            .map(|chunk| {
                let value = chunk
                    .iter()
                    .fold(0usize, |acc, bit| (acc << 1) | *bit as usize);
                char::from(ALPHABET[value])
            })
            .collect();
        format!("{}-{}", &chars[..3], &chars[3..])
    }

    #[test]
    fn the_golden_vector_matches_the_shared_contract() {
        let code = check_code(GOLDEN_DEVICE_ID, &[0u8; 91]);
        assert_eq!(code, reference(GOLDEN_DEVICE_ID, &[0u8; 91]));
        assert_eq!(code, "ZDX-MJ5");
    }

    #[test]
    fn the_code_is_three_and_three_crockford_characters() {
        let code = check_code(GOLDEN_DEVICE_ID, b"spki");
        assert_eq!(code.len(), 7);
        assert_eq!(&code[3..4], "-");
        assert!(code
            .chars()
            .filter(|c| *c != '-')
            .all(|c| ALPHABET.contains(&(c as u8))));
    }

    #[test]
    fn the_code_binds_the_device_id_and_the_key() {
        let base = check_code(GOLDEN_DEVICE_ID, &[0u8; 91]);
        assert_ne!(
            base,
            check_code("00000000-0000-4000-8000-000000000002", &[0u8; 91])
        );
        let mut other_key = [0u8; 91];
        other_key[90] = 1;
        assert_ne!(base, check_code(GOLDEN_DEVICE_ID, &other_key));
        // The device id is compared lowercase.
        assert_eq!(
            base,
            check_code(&GOLDEN_DEVICE_ID.to_uppercase(), &[0u8; 91])
        );
    }
}
