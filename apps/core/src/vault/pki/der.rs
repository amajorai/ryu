//! A minimal DER reader and writer for the OCSP messages (RFC 6960), which
//! rcgen does not build. Only single-byte (low-number) tags and definite
//! lengths occur there; anything else is refused.

use anyhow::{bail, Result};

pub(super) const SEQUENCE: u8 = 0x30;
pub(super) const OCTET_STRING: u8 = 0x04;
pub(super) const INTEGER: u8 = 0x02;
pub(super) const ENUMERATED: u8 = 0x0a;
pub(super) const OID: u8 = 0x06;
pub(super) const BIT_STRING: u8 = 0x03;
pub(super) const NULL: u8 = 0x05;
pub(super) const GENERALIZED_TIME: u8 = 0x18;

/// Context-specific tag `[n]`, constructed (EXPLICIT or a constructed
/// IMPLICIT type).
pub(super) const fn context(n: u8) -> u8 {
    0xa0 | n
}

/// Context-specific tag `[n]`, primitive (IMPLICIT primitive type).
pub(super) const fn context_primitive(n: u8) -> u8 {
    0x80 | n
}

/// One TLV: its tag, its contents, and its full encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Tlv<'a> {
    pub tag: u8,
    pub value: &'a [u8],
    pub raw: &'a [u8],
}

/// Read the TLV at the start of `input`; returns it and the rest.
pub(super) fn read(input: &[u8]) -> Result<(Tlv<'_>, &[u8])> {
    let (&tag, rest) = input
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("DER: truncated tag"))?;
    if tag & 0x1f == 0x1f {
        bail!("DER: high-number tags are not supported");
    }
    let (&first, mut rest) = rest
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("DER: truncated length"))?;
    let length = if first < 0x80 {
        usize::from(first)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || rest.len() < count {
            bail!("DER: unsupported or truncated length");
        }
        let mut length = 0usize;
        for &byte in &rest[..count] {
            length = (length << 8) | usize::from(byte);
        }
        if length < 0x80 || rest[0] == 0 {
            bail!("DER: non-minimal length");
        }
        rest = &rest[count..];
        length
    };
    if rest.len() < length {
        bail!("DER: truncated value");
    }
    let header = input.len() - rest.len();
    Ok((
        Tlv {
            tag,
            value: &rest[..length],
            raw: &input[..header + length],
        },
        &rest[length..],
    ))
}

/// Read a TLV that must carry `tag`.
pub(super) fn expect(input: &[u8], tag: u8) -> Result<(Tlv<'_>, &[u8])> {
    let (tlv, rest) = read(input)?;
    if tlv.tag != tag {
        bail!("DER: expected tag {tag:#04x}, found {:#04x}", tlv.tag);
    }
    Ok((tlv, rest))
}

/// Every TLV inside `value` (a SEQUENCE's contents).
pub(super) fn items(mut value: &[u8]) -> Result<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    while !value.is_empty() {
        let (tlv, rest) = read(value)?;
        out.push(tlv);
        value = rest;
    }
    Ok(out)
}

/// Encode one TLV.
pub(super) fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let length = value.len();
    if length < 0x80 {
        out.push(length as u8);
    } else {
        let bytes = length.to_be_bytes();
        let skip = bytes.iter().take_while(|byte| **byte == 0).count();
        out.push(0x80 | (bytes.len() - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(value);
    out
}

/// A SEQUENCE of already-encoded parts.
pub(super) fn sequence(parts: &[&[u8]]) -> Vec<u8> {
    tlv(SEQUENCE, &parts.concat())
}

/// An OBJECT IDENTIFIER from its dotted form (`1.3.6.1.5.5.7.48.1.1`).
pub(super) fn oid(dotted: &str) -> Vec<u8> {
    let arcs: Vec<u64> = dotted
        .split('.')
        .map(|arc| arc.parse().expect("a numeric OID arc"))
        .collect();
    let mut body = Vec::new();
    let mut push = |mut arc: u64| {
        let mut chunk = vec![(arc & 0x7f) as u8];
        arc >>= 7;
        while arc > 0 {
            chunk.push(0x80 | (arc & 0x7f) as u8);
            arc >>= 7;
        }
        chunk.reverse();
        body.extend(chunk);
    };
    push(arcs[0] * 40 + arcs[1]);
    for &arc in &arcs[2..] {
        push(arc);
    }
    tlv(OID, &body)
}

/// A GeneralizedTime (`YYYYMMDDHHMMSSZ`) for a Unix time in seconds.
pub(super) fn generalized_time(unix_secs: i64) -> Vec<u8> {
    let time = time::OffsetDateTime::from_unix_timestamp(unix_secs)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let text = format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second()
    );
    tlv(GENERALIZED_TIME, text.as_bytes())
}

/// A BIT STRING with no unused bits.
pub(super) fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 1);
    body.push(0);
    body.extend_from_slice(bytes);
    tlv(BIT_STRING, &body)
}
