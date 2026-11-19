//! AES key wrap with padding (RFC 5649) for bring-your-own-key import.

use super::*;

pub(super) const KWP_IV: [u8; 4] = [0xA6, 0x59, 0x59, 0xA6];

pub(super) fn kw_cipher(kek: &[u8]) -> Result<Aes256> {
    Aes256::new_from_slice(kek).map_err(|_| invalid("key-wrapping keys are 32 bytes"))
}

/// The RFC 3394 wrapping function W over 64-bit blocks `r` with IV `a`.
pub(super) fn kw_wrap_blocks(cipher: &Aes256, mut a: [u8; 8], r: &mut [[u8; 8]]) -> [u8; 8] {
    let n = r.len();
    for j in 0..6 {
        for (i, block) in r.iter_mut().enumerate() {
            let mut b = GenericArray::from([0u8; 16]);
            b[..8].copy_from_slice(&a);
            b[8..].copy_from_slice(block);
            cipher.encrypt_block(&mut b);
            let t = ((n * j) + i + 1) as u64;
            for (k, mask) in t.to_be_bytes().iter().enumerate() {
                a[k] = b[k] ^ mask;
            }
            block.copy_from_slice(&b[8..]);
        }
    }
    a
}

/// The RFC 3394 unwrapping function W⁻¹; returns the recovered IV.
pub(super) fn kw_unwrap_blocks(cipher: &Aes256, mut a: [u8; 8], r: &mut [[u8; 8]]) -> [u8; 8] {
    let n = r.len();
    for j in (0..6).rev() {
        for i in (0..n).rev() {
            let t = ((n * j) + i + 1) as u64;
            let mut b = GenericArray::from([0u8; 16]);
            for (k, mask) in t.to_be_bytes().iter().enumerate() {
                b[k] = a[k] ^ mask;
            }
            b[8..].copy_from_slice(&r[i]);
            cipher.decrypt_block(&mut b);
            a.copy_from_slice(&b[..8]);
            r[i].copy_from_slice(&b[8..]);
        }
    }
    a
}

pub(super) fn to_blocks(bytes: &[u8]) -> Vec<[u8; 8]> {
    bytes
        .chunks(8)
        .map(|chunk| {
            let mut block = [0u8; 8];
            block[..chunk.len()].copy_from_slice(chunk);
            block
        })
        .collect()
}

/// AES-256 key wrap with padding (RFC 5649).
pub fn kwp_wrap(kek: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.is_empty() || plaintext.len() > MAX_INPUT_BYTES {
        return Err(invalid("key material must be 1 byte to 1 MiB"));
    }
    let cipher = kw_cipher(kek)?;
    let mut aiv = [0u8; 8];
    aiv[..4].copy_from_slice(&KWP_IV);
    aiv[4..].copy_from_slice(&(plaintext.len() as u32).to_be_bytes());
    let mut blocks = to_blocks(plaintext);
    if blocks.len() == 1 {
        let mut b = GenericArray::from([0u8; 16]);
        b[..8].copy_from_slice(&aiv);
        b[8..].copy_from_slice(&blocks[0]);
        cipher.encrypt_block(&mut b);
        return Ok(b.to_vec());
    }
    let a = kw_wrap_blocks(&cipher, aiv, &mut blocks);
    let mut out = a.to_vec();
    for block in blocks {
        out.extend_from_slice(&block);
    }
    Ok(out)
}

/// Inverse of [`kwp_wrap`]; fails on any integrity or padding mismatch.
pub fn kwp_unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>> {
    let bad = || invalid("wrapped key material failed AES-KWP integrity checks");
    if wrapped.len() < 16 || wrapped.len() % 8 != 0 {
        return Err(bad());
    }
    let cipher = kw_cipher(kek)?;
    let n = wrapped.len() / 8 - 1;
    let (a, blocks) = if n == 1 {
        let mut b = GenericArray::clone_from_slice(wrapped);
        cipher.decrypt_block(&mut b);
        let mut a = [0u8; 8];
        a.copy_from_slice(&b[..8]);
        (a, to_blocks(&b[8..]))
    } else {
        let mut a = [0u8; 8];
        a.copy_from_slice(&wrapped[..8]);
        let mut blocks = to_blocks(&wrapped[8..]);
        let a = kw_unwrap_blocks(&cipher, a, &mut blocks);
        (a, blocks)
    };
    if a[..4] != KWP_IV {
        return Err(bad());
    }
    let mli = u32::from_be_bytes([a[4], a[5], a[6], a[7]]) as usize;
    if mli <= 8 * (n - 1) || mli > 8 * n {
        return Err(bad());
    }
    let plain: Vec<u8> = blocks.concat();
    if plain[mli..].iter().any(|byte| *byte != 0) {
        return Err(bad());
    }
    Ok(plain[..mli].to_vec())
}
