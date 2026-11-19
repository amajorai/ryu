//! The slice of BSON the MongoDB client ([`super::mongo_wire`]) sends and
//! reads: documents, arrays, strings, numbers, booleans, binary, and null.
//! Other types in replies are skipped as [`Bson::Other`]; nesting is capped.

use anyhow::{anyhow, bail, Result};

/// The BSON values Core sends and reads.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Bson {
    Double(f64),
    String(String),
    Document(Doc),
    Array(Vec<Bson>),
    Binary(Vec<u8>),
    Bool(bool),
    Null,
    Int32(i32),
    Int64(i64),
    /// A value Core skips (ObjectId, dates, timestamps, decimals, …).
    Other,
}

pub(crate) type Doc = Vec<(String, Bson)>;

pub(crate) fn get<'a>(doc: &'a Doc, key: &str) -> Option<&'a Bson> {
    doc.iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn cstring(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn encode_value(out: &mut Vec<u8>, key: &str, value: &Bson) {
    let tag = match value {
        Bson::Double(_) => 0x01,
        Bson::String(_) => 0x02,
        Bson::Document(_) => 0x03,
        Bson::Array(_) => 0x04,
        Bson::Binary(_) => 0x05,
        Bson::Bool(_) => 0x08,
        Bson::Null | Bson::Other => 0x0A,
        Bson::Int32(_) => 0x10,
        Bson::Int64(_) => 0x12,
    };
    out.push(tag);
    cstring(out, key);
    match value {
        Bson::Double(v) => out.extend_from_slice(&v.to_le_bytes()),
        Bson::String(v) => {
            out.extend_from_slice(&(v.len() as i32 + 1).to_le_bytes());
            cstring(out, v);
        }
        Bson::Document(doc) => out.extend(encode(doc)),
        Bson::Array(items) => {
            let doc: Doc = items
                .iter()
                .enumerate()
                .map(|(index, item)| (index.to_string(), item.clone()))
                .collect();
            out.extend(encode(&doc));
        }
        Bson::Binary(bytes) => {
            out.extend_from_slice(&(bytes.len() as i32).to_le_bytes());
            out.push(0);
            out.extend_from_slice(bytes);
        }
        Bson::Bool(v) => out.push(u8::from(*v)),
        Bson::Null | Bson::Other => {}
        Bson::Int32(v) => out.extend_from_slice(&v.to_le_bytes()),
        Bson::Int64(v) => out.extend_from_slice(&v.to_le_bytes()),
    }
}

pub(crate) fn encode(doc: &Doc) -> Vec<u8> {
    let mut body = Vec::new();
    for (key, value) in doc {
        encode_value(&mut body, key, value);
    }
    let mut out = ((body.len() + 5) as i32).to_le_bytes().to_vec();
    out.extend(body);
    out.push(0);
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let slice = self
            .bytes
            .get(self.at..self.at + n)
            .ok_or_else(|| anyhow!("truncated BSON"))?;
        self.at += n;
        Ok(slice)
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn cstring(&mut self) -> Result<String> {
        let end = self.bytes[self.at..]
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| anyhow!("unterminated BSON string"))?;
        let text = String::from_utf8(self.bytes[self.at..self.at + end].to_vec())?;
        self.at += end + 1;
        Ok(text)
    }

    fn document(&mut self, depth: usize) -> Result<Doc> {
        if depth > 32 {
            bail!("BSON nests too deeply");
        }
        let start = self.at;
        let len = usize::try_from(self.i32()?).map_err(|_| anyhow!("bad BSON length"))?;
        if len < 5 || start + len > self.bytes.len() {
            bail!("bad BSON length");
        }
        let end = start + len - 1;
        let mut doc = Vec::new();
        while self.at < end {
            let tag = self.take(1)?[0];
            let key = self.cstring()?;
            let value = match tag {
                0x01 => Bson::Double(f64::from_le_bytes(self.take(8)?.try_into()?)),
                0x02 => {
                    let len =
                        usize::try_from(self.i32()?).map_err(|_| anyhow!("bad BSON string"))?;
                    let raw = self.take(len)?;
                    Bson::String(String::from_utf8(raw[..len.saturating_sub(1)].to_vec())?)
                }
                0x03 => Bson::Document(self.document(depth + 1)?),
                0x04 => Bson::Array(
                    self.document(depth + 1)?
                        .into_iter()
                        .map(|(_, value)| value)
                        .collect(),
                ),
                0x05 => {
                    let len =
                        usize::try_from(self.i32()?).map_err(|_| anyhow!("bad BSON binary"))?;
                    self.take(1)?;
                    Bson::Binary(self.take(len)?.to_vec())
                }
                0x07 => {
                    self.take(12)?;
                    Bson::Other
                }
                0x08 => Bson::Bool(self.take(1)?[0] != 0),
                0x09 | 0x11 => {
                    self.take(8)?;
                    Bson::Other
                }
                0x0A | 0x7F | 0xFF => Bson::Null,
                0x0B => {
                    self.cstring()?;
                    self.cstring()?;
                    Bson::Other
                }
                0x10 => Bson::Int32(self.i32()?),
                0x12 => Bson::Int64(i64::from_le_bytes(self.take(8)?.try_into()?)),
                0x13 => {
                    self.take(16)?;
                    Bson::Other
                }
                other => bail!("unsupported BSON type {other:#x}"),
            };
            doc.push((key, value));
        }
        self.take(1)?;
        Ok(doc)
    }
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Doc> {
    Reader { bytes, at: 0 }.document(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bson_round_trips() {
        let doc: Doc = vec![
            ("createUser".into(), Bson::String("u".into())),
            (
                "roles".into(),
                Bson::Array(vec![Bson::Document(vec![(
                    "role".into(),
                    Bson::String("read".into()),
                )])]),
            ),
            ("n".into(), Bson::Int32(7)),
            ("big".into(), Bson::Int64(1 << 40)),
            ("f".into(), Bson::Double(1.5)),
            ("b".into(), Bson::Bool(true)),
            ("bin".into(), Bson::Binary(vec![1, 2, 3])),
            ("nil".into(), Bson::Null),
        ];
        assert_eq!(decode(&encode(&doc)).unwrap(), doc);
        assert_eq!(get(&doc, "n"), Some(&Bson::Int32(7)));
        assert!(decode(&[5, 0, 0]).is_err());
        let mut bad = encode(&doc);
        bad[0] = 0xFF;
        assert!(decode(&bad).is_err());
    }

    #[test]
    fn skipped_types_and_deep_nesting() {
        // {"id": ObjectId(..), "t": Date(..)}
        let mut body = vec![0x07, b'i', b'd', 0];
        body.extend_from_slice(&[0; 12]);
        body.extend_from_slice(&[0x09, b't', 0]);
        body.extend_from_slice(&[0; 8]);
        let mut doc = ((body.len() + 5) as i32).to_le_bytes().to_vec();
        doc.extend(body);
        doc.push(0);
        let parsed = decode(&doc).unwrap();
        assert_eq!(
            parsed,
            vec![("id".into(), Bson::Other), ("t".into(), Bson::Other)]
        );
        let mut nested: Doc = vec![];
        for _ in 0..40 {
            nested = vec![("d".into(), Bson::Document(nested))];
        }
        assert!(decode(&encode(&nested)).is_err());
    }
}
