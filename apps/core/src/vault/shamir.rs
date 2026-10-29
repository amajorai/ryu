//! Shamir secret sharing over GF(2^8), used by the `shamir` seal mode.
//!
//! Each byte of the secret is the constant term of an independent random
//! polynomial of degree `threshold - 1`; share `x` holds that polynomial's value
//! at `x` for every byte. Any `threshold` shares reconstruct the secret by
//! Lagrange interpolation at zero; fewer reveal nothing about it.
//!
//! The field uses the AES polynomial (x^8 + x^4 + x^3 + x + 1). Arithmetic is
//! done with log/exp tables built once; there is no secret-dependent branching
//! beyond table lookups, which is acceptable for an operator-driven unseal path.

use std::sync::OnceLock;

use anyhow::{bail, Result};
use base64::Engine as _;

const SHARE_PREFIX: &str = "rks1-";

struct Tables {
    exp: [u8; 512],
    log: [u8; 256],
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut value: u8 = 1;
        for (power, slot) in exp.iter_mut().enumerate().take(255) {
            *slot = value;
            log[value as usize] = power as u8;
            // Multiply by the generator 3: value * 2 xor value.
            let doubled = (value << 1) ^ if value & 0x80 != 0 { 0x1b } else { 0 };
            value ^= doubled;
        }
        for index in 255..512 {
            exp[index] = exp[index - 255];
        }
        Tables { exp, log }
    })
}

fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    let t = tables();
    t.exp[t.log[a as usize] as usize + t.log[b as usize] as usize]
}

fn div(a: u8, b: u8) -> u8 {
    debug_assert!(b != 0);
    if a == 0 {
        return 0;
    }
    let t = tables();
    t.exp[(t.log[a as usize] as usize + 255 - t.log[b as usize] as usize) % 255]
}

/// One share: an x coordinate and the y values for every secret byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub x: u8,
    pub y: Vec<u8>,
}

impl Share {
    /// Encode as `rks1-<base64url(x || y)>`.
    pub fn encode(&self) -> String {
        let mut raw = Vec::with_capacity(self.y.len() + 1);
        raw.push(self.x);
        raw.extend_from_slice(&self.y);
        format!(
            "{SHARE_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
        )
    }

    /// Decode a share produced by [`Share::encode`].
    pub fn decode(value: &str) -> Result<Self> {
        let Some(body) = value.trim().strip_prefix(SHARE_PREFIX) else {
            bail!("not a Ryu vault key share");
        };
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| anyhow::anyhow!("key share is not valid base64"))?;
        if raw.len() < 2 || raw[0] == 0 {
            bail!("key share is malformed");
        }
        Ok(Self {
            x: raw[0],
            y: raw[1..].to_vec(),
        })
    }
}

/// Split `secret` into `shares` shares, any `threshold` of which recover it.
pub fn split(secret: &[u8], shares: u8, threshold: u8) -> Result<Vec<Share>> {
    if secret.is_empty() {
        bail!("cannot split an empty secret");
    }
    if threshold < 2 || shares < threshold {
        bail!("threshold must be at least 2 and no greater than the share count");
    }
    let mut out: Vec<Share> = (1..=shares)
        .map(|x| Share {
            x,
            y: Vec::with_capacity(secret.len()),
        })
        .collect();
    for &byte in secret {
        let mut coefficients = super::random_bytes(threshold as usize);
        coefficients[0] = byte;
        for share in &mut out {
            // Horner evaluation at x.
            let mut acc = 0u8;
            for &coefficient in coefficients.iter().rev() {
                acc = mul(acc, share.x) ^ coefficient;
            }
            share.y.push(acc);
        }
    }
    Ok(out)
}

/// Recover the secret from at least `threshold` distinct shares.
pub fn combine(shares: &[Share]) -> Result<Vec<u8>> {
    if shares.len() < 2 {
        bail!("at least two key shares are required");
    }
    let len = shares[0].y.len();
    if shares.iter().any(|share| share.y.len() != len) {
        bail!("key shares have different lengths");
    }
    let mut seen = std::collections::HashSet::new();
    if !shares.iter().all(|share| seen.insert(share.x)) {
        bail!("duplicate key share");
    }
    let mut secret = vec![0u8; len];
    for (index, out) in secret.iter_mut().enumerate() {
        let mut acc = 0u8;
        for (i, share_i) in shares.iter().enumerate() {
            // Lagrange basis at zero: prod_{j != i} x_j / (x_j - x_i).
            let mut basis = 1u8;
            for (j, share_j) in shares.iter().enumerate() {
                if i != j {
                    basis = mul(basis, div(share_j.x, share_j.x ^ share_i.x));
                }
            }
            acc ^= mul(share_i.y[index], basis);
        }
        *out = acc;
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_threshold_subset_recovers_the_secret() {
        let secret = super::super::random_bytes(32);
        let shares = split(&secret, 5, 3).unwrap();
        assert_eq!(shares.len(), 5);
        for subset in [[0, 1, 2], [0, 2, 4], [1, 3, 4], [4, 3, 2]] {
            let picked: Vec<Share> = subset.iter().map(|&i| shares[i].clone()).collect();
            assert_eq!(combine(&picked).unwrap(), secret);
        }
    }

    #[test]
    fn fewer_than_threshold_shares_do_not_recover_the_secret() {
        let secret = vec![0x42; 32];
        let shares = split(&secret, 5, 3).unwrap();
        let recovered = combine(&shares[..2]).unwrap();
        assert_ne!(recovered, secret);
    }

    #[test]
    fn shares_round_trip_through_their_text_encoding() {
        let shares = split(b"0123456789abcdef0123456789abcdef", 3, 2).unwrap();
        for share in &shares {
            assert_eq!(&Share::decode(&share.encode()).unwrap(), share);
        }
        assert!(Share::decode("rks1-").is_err());
        assert!(Share::decode("nope").is_err());
    }

    #[test]
    fn invalid_parameters_and_duplicates_are_rejected() {
        assert!(split(b"x", 3, 1).is_err());
        assert!(split(b"x", 2, 3).is_err());
        let shares = split(b"secret", 3, 2).unwrap();
        assert!(combine(&[shares[0].clone(), shares[0].clone()]).is_err());
    }

    #[test]
    fn field_division_inverts_multiplication() {
        for a in 1..=255u8 {
            for b in [1u8, 2, 3, 0x53, 0xca, 0xff] {
                assert_eq!(div(mul(a, b), b), a);
            }
        }
    }
}
