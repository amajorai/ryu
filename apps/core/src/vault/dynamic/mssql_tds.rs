//! TDS message encoding and decoding for the SQL Server client
//! ([`super::mssql_wire`]): packet framing, PRELOGIN, LOGIN7, SQL batches,
//! and the response tokens account statements produce. Statements that
//! return rows are refused rather than parsed.

use anyhow::{anyhow, bail, Result};

pub(crate) const PACKET_SIZE: usize = 4096;
pub(crate) const HEADER: usize = 8;
pub(crate) const MAX_MESSAGE_BYTES: usize = 1 << 20;

pub(crate) const TYPE_BATCH: u8 = 0x01;
pub(crate) const TYPE_REPLY: u8 = 0x04;
pub(crate) const TYPE_LOGIN7: u8 = 0x10;
pub(crate) const TYPE_PRELOGIN: u8 = 0x12;
const STATUS_EOM: u8 = 0x01;

pub(crate) const ENCRYPT_ON: u8 = 0x01;
pub(crate) const ENCRYPT_NOT_SUP: u8 = 0x02;
pub(crate) const ENCRYPT_REQ: u8 = 0x03;

/// TDS 7.4.
const TDS_VERSION: u32 = 0x7400_0004;

/// Split `payload` into packets of `kind`.
pub(crate) fn packets(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + HEADER);
    let chunks: Vec<&[u8]> = if payload.is_empty() {
        vec![&[]]
    } else {
        payload.chunks(PACKET_SIZE - HEADER).collect()
    };
    let last = chunks.len() - 1;
    for (index, chunk) in chunks.into_iter().enumerate() {
        let len = (chunk.len() + HEADER) as u16;
        out.push(kind);
        out.push(if index == last { STATUS_EOM } else { 0 });
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&[0, 0, ((index + 1) % 256) as u8, 0]);
        out.extend_from_slice(chunk);
    }
    out
}

/// Parse a packet header: (type, end of message, payload length).
pub(crate) fn header(bytes: &[u8; HEADER]) -> Result<(u8, bool, usize)> {
    let len = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    if !(HEADER..=32_768).contains(&len) {
        bail!("bad TDS packet length");
    }
    Ok((bytes[0], bytes[1] & STATUS_EOM != 0, len - HEADER))
}

/// The client's PRELOGIN: version, encryption, and MARS off.
pub(crate) fn prelogin(encryption: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for (token, offset, len) in [(0x00u8, 16u16, 6u16), (0x01, 22, 1), (0x04, 23, 1)] {
        out.push(token);
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&len.to_be_bytes());
    }
    out.push(0xFF);
    out.extend_from_slice(&[0x10, 0, 0, 0, 0, 0]);
    out.push(encryption);
    out.push(0);
    out
}

/// The ENCRYPTION option of a PRELOGIN reply.
pub(crate) fn prelogin_encryption(reply: &[u8]) -> Result<u8> {
    let mut at = 0;
    while let Some(&token) = reply.get(at) {
        if token == 0xFF {
            break;
        }
        let entry = reply
            .get(at..at + 5)
            .ok_or_else(|| anyhow!("truncated PRELOGIN reply"))?;
        let offset = u16::from_be_bytes([entry[1], entry[2]]) as usize;
        if token == 0x01 {
            return reply
                .get(offset)
                .copied()
                .ok_or_else(|| anyhow!("truncated PRELOGIN reply"));
        }
        at += 5;
    }
    bail!("the PRELOGIN reply has no encryption option")
}

pub(crate) fn utf16(value: &str) -> Vec<u8> {
    value.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// LOGIN7 password obfuscation: swap nibbles, then XOR 0xA5.
fn obfuscate(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| ((b << 4) | (b >> 4)) ^ 0xA5).collect()
}

/// A LOGIN7 message with SQL authentication.
pub(crate) fn login7(user: &str, password: &str, server: &str, database: &str) -> Vec<u8> {
    const FIXED: usize = 94;
    let fields: [Vec<u8>; 9] = [
        utf16("ryu-core"),           // HostName
        utf16(user),                 // UserName
        obfuscate(&utf16(password)), // Password
        utf16("Ryu Vault"),          // AppName
        utf16(server),               // ServerName
        Vec::new(),                  // Extension (unused)
        utf16("ryu"),                // CltIntName
        Vec::new(),                  // Language
        utf16(database),             // Database
    ];
    let mut out = Vec::with_capacity(FIXED + 256);
    out.extend_from_slice(&0u32.to_le_bytes()); // length, patched below
    out.extend_from_slice(&TDS_VERSION.to_le_bytes());
    out.extend_from_slice(&(PACKET_SIZE as u32).to_le_bytes());
    out.extend_from_slice(&0x0700_0000u32.to_le_bytes());
    out.extend_from_slice(&std::process::id().to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&[0xE0, 0x03, 0x00, 0x00]);
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0x0409u32.to_le_bytes());
    let mut data = Vec::new();
    for field in &fields {
        let offset = (FIXED + data.len()) as u16;
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&((field.len() / 2) as u16).to_le_bytes());
        data.extend_from_slice(field);
    }
    out.extend_from_slice(&[0; 6]); // ClientID
    let end = (FIXED + data.len()) as u16;
    for _ in 0..3 {
        // SSPI, AtchDBFile, ChangePassword: empty.
        out.extend_from_slice(&end.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // cbSSPILong
    debug_assert_eq!(out.len(), FIXED);
    out.extend(data);
    let len = out.len() as u32;
    out[..4].copy_from_slice(&len.to_le_bytes());
    out
}

/// A SQL batch with the transaction-descriptor header TDS 7.2+ requires.
pub(crate) fn batch(sql: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(22 + sql.len() * 2);
    out.extend_from_slice(&22u32.to_le_bytes());
    out.extend_from_slice(&18u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend(utf16(sql));
    out
}

/// What a reply said.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub logged_in: bool,
    /// The first ERROR token: `[number] message`.
    pub error: Option<String>,
    /// A DONE token carried the error flag.
    pub done_error: bool,
}

fn read_u16(reply: &[u8], at: usize) -> Result<usize> {
    reply
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
        .ok_or_else(|| anyhow!("truncated TDS token"))
}

fn error_text(token: &[u8]) -> Result<String> {
    let number = token
        .get(..4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| anyhow!("truncated TDS error"))?;
    let chars = read_u16(token, 6)?;
    let text = token
        .get(8..8 + chars * 2)
        .ok_or_else(|| anyhow!("truncated TDS error"))?;
    let units: Vec<u16> = text
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Ok(format!("[{number}] {}", String::from_utf16_lossy(&units)))
}

/// Walk the tokens of a login or batch reply.
pub(crate) fn parse_reply(reply: &[u8]) -> Result<Outcome> {
    let mut outcome = Outcome::default();
    let mut at = 0;
    while let Some(&token) = reply.get(at) {
        at += 1;
        match token {
            // Tokens with a two-byte length.
            0xAA | 0xAB | 0xAD | 0xE3 | 0xA9 | 0xED => {
                let len = read_u16(reply, at)?;
                let body = reply
                    .get(at + 2..at + 2 + len)
                    .ok_or_else(|| anyhow!("truncated TDS token"))?;
                match token {
                    0xAA if outcome.error.is_none() => outcome.error = Some(error_text(body)?),
                    0xAD => outcome.logged_in = true,
                    _ => {}
                }
                at += 2 + len;
            }
            0xE4 => {
                let len = reply
                    .get(at..at + 4)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
                    .ok_or_else(|| anyhow!("truncated TDS token"))?;
                at += 4 + len;
            }
            0xFD | 0xFE | 0xFF => {
                let status = read_u16(reply, at)?;
                outcome.done_error |= status & 0x2 != 0;
                at += 12;
            }
            0x79 => at += 4,
            0xAE => loop {
                let feature = *reply
                    .get(at)
                    .ok_or_else(|| anyhow!("truncated TDS token"))?;
                at += 1;
                if feature == 0xFF {
                    break;
                }
                let len = reply
                    .get(at..at + 4)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
                    .ok_or_else(|| anyhow!("truncated TDS token"))?;
                at += 4 + len;
            },
            0x81 => bail!("statements that return rows are not supported"),
            other => bail!("unsupported TDS token {other:#x}"),
        }
    }
    Ok(outcome)
}

#[cfg(test)]
#[path = "mssql_tds_test.rs"]
pub(crate) mod tests;
