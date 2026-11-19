//! AES-CMAC (RFC 4493, NIST SP 800-38B) for the `aes128-cmac` and
//! `aes256-cmac` key types, and the `cmac` / `cmac/verify` operations.
//!
//! A CMAC is `ryu:v<version>:<base64 tag>`. `macLength` truncates the tag to
//! 1–16 bytes (default 16, as OpenBao); verification compares the leading
//! bytes of the recomputed tag with the supplied one in constant time.

use aes::cipher::KeyInit as _;
use aes::Aes128;

use super::*;

const BLOCK: usize = 16;

enum CmacCipher {
    Aes128(Aes128),
    Aes256(Aes256),
}

impl CmacCipher {
    fn new(key: &[u8]) -> Result<Self> {
        match key.len() {
            16 => Ok(Self::Aes128(
                Aes128::new_from_slice(key).map_err(|_| anyhow!("bad CMAC key"))?,
            )),
            32 => Ok(Self::Aes256(
                Aes256::new_from_slice(key).map_err(|_| anyhow!("bad CMAC key"))?,
            )),
            _ => Err(invalid("CMAC keys are 16 or 32 bytes")),
        }
    }

    fn encrypt(&self, block: &mut [u8; BLOCK]) {
        let block = GenericArray::from_mut_slice(block);
        match self {
            Self::Aes128(cipher) => cipher.encrypt_block(block),
            Self::Aes256(cipher) => cipher.encrypt_block(block),
        }
    }
}

/// Doubling in GF(2^128) (RFC 4493 §2.3 subkey generation).
fn double(block: [u8; BLOCK]) -> [u8; BLOCK] {
    let mut out = [0u8; BLOCK];
    for index in 0..BLOCK {
        let carry = block.get(index + 1).map_or(0, |next| next >> 7);
        out[index] = (block[index] << 1) | carry;
    }
    if block[0] & 0x80 != 0 {
        out[BLOCK - 1] ^= 0x87;
    }
    out
}

/// The full 16-byte AES-CMAC of `message` under a 16- or 32-byte key.
pub(super) fn aes_cmac(key: &[u8], message: &[u8]) -> Result<[u8; BLOCK]> {
    let cipher = CmacCipher::new(key)?;
    let mut l = [0u8; BLOCK];
    cipher.encrypt(&mut l);
    let k1 = double(l);
    let k2 = double(k1);
    let blocks = message.len().div_ceil(BLOCK).max(1);
    let last_start = (blocks - 1) * BLOCK;
    let tail = &message[last_start..];
    let mut last = [0u8; BLOCK];
    if tail.len() == BLOCK {
        for index in 0..BLOCK {
            last[index] = tail[index] ^ k1[index];
        }
    } else {
        last[..tail.len()].copy_from_slice(tail);
        last[tail.len()] = 0x80;
        for index in 0..BLOCK {
            last[index] ^= k2[index];
        }
    }
    let mut state = [0u8; BLOCK];
    for chunk in message[..last_start].chunks(BLOCK) {
        for (byte, input) in state.iter_mut().zip(chunk) {
            *byte ^= input;
        }
        cipher.encrypt(&mut state);
    }
    for (byte, input) in state.iter_mut().zip(last) {
        *byte ^= input;
    }
    cipher.encrypt(&mut state);
    Ok(state)
}

fn mac_length(requested: Option<u32>) -> Result<usize> {
    match requested {
        None | Some(0) => Ok(BLOCK),
        Some(length @ 1..=16) => Ok(length as usize),
        Some(_) => Err(invalid("macLength must be between 1 and 16 bytes")),
    }
}

fn cmac_meta(conn: &Connection, name: &str) -> Result<Meta> {
    let meta = meta(conn, name)?;
    if meta.key_type.cmac_key_bytes().is_none() {
        return Err(invalid("only aes128-cmac and aes256-cmac keys can CMAC"));
    }
    Ok(meta)
}

impl PluginSecretStore {
    /// AES-CMAC of base64 `input`, truncated to `mac_length` bytes.
    pub async fn transit_cmac(
        &self,
        name: &str,
        input_b64: &str,
        key_version: Option<u32>,
        mac_length_bytes: Option<u32>,
        actor: &AuditActor,
    ) -> Result<String> {
        let input = decode_input(input_b64)?;
        let length = mac_length(mac_length_bytes)?;
        let conn = self.conn.lock().await;
        let meta = cmac_meta(&conn, name)?;
        let version = meta.select_version(key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let tag = aes_cmac(&material, &input)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.cmac", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(encode(version, &tag[..length]))
    }

    /// Verify a CMAC produced by [`Self::transit_cmac`] (constant time). The
    /// supplied tag's length is the MAC length.
    pub async fn transit_verify_cmac(
        &self,
        name: &str,
        input_b64: &str,
        cmac: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        let input = decode_input(input_b64)?;
        let (version, expected) = decode(cmac)?;
        if expected.is_empty() || expected.len() > BLOCK {
            return Err(invalid("a CMAC is 1 to 16 bytes"));
        }
        let conn = self.conn.lock().await;
        let meta = cmac_meta(&conn, name)?;
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let tag = aes_cmac(&material, &input)?;
        let valid = constant_time_eq(&tag[..expected.len()], &expected);
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.verify", if valid { "ok" } else { "denied" })
                .details(serde_json::json!({ "key": name, "version": version, "cmac": true })),
        );
        Ok(valid)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}
