//! Minimal, allocation-frugal GGUF metadata reader.
//!
//! GGUF files start with a metadata block (key/value pairs) followed by the
//! tensor table and the weights. The metadata carries `tokenizer.chat_template`,
//! which is the single signal we need to decide whether a *local* model supports
//! tool-calling (the chat template renders a `tools` section) the same way Jan
//! does (`isToolSupported` reads `tokenizer.chat_template` and checks for
//! `tools`). We only need a handful of string-valued keys, and the weights can be
//! many gigabytes, so this reader parses *only* the leading metadata block — it
//! reads string values into a map and skips every other value via `seek` without
//! ever touching the tensor data.
//!
//! Placement (Core vs Gateway): this is read-only metadata inspection of an
//! on-disk file to drive UI affordances — pure orchestration-side capability
//! discovery. It is not policy, so it lives in Core's model catalog.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// GGUF magic — the ASCII bytes `GGUF` in little-endian file order.
const GGUF_MAGIC: u32 = 0x4655_4747;
/// Defensive cap on the metadata KV count (a real model has < ~1k entries).
const MAX_KV_COUNT: u64 = 1_000_000;
/// Defensive cap on a single string value (a chat template is large but bounded;
/// 64 MiB is far beyond any real template and guards against a corrupt length).
const MAX_STRING_LEN: u64 = 64 * 1024 * 1024;

/// The subset of GGUF metadata we surface: every string-valued key, keyed by its
/// metadata name (e.g. `tokenizer.chat_template`, `general.architecture`).
#[derive(Debug, Default, Clone)]
pub struct GgufMetadata {
    /// String-valued metadata entries. Non-string values are skipped during
    /// parsing (we never need them for capability detection).
    pub strings: HashMap<String, String>,
}

/// GGUF `general.architecture` values that identify a diffusion image/video
/// model served by stable-diffusion.cpp. Sourced from the sd.cpp ggml model
/// registry and community GGUF converter repos (city96 FLUX, SDXL, SD3).
/// Conservative by design — unknown architectures default to `false` so a
/// chat model is never mis-classified as diffusion.
const DIFFUSION_ARCHITECTURES: &[&str] = &[
    "flux",  // FLUX.1 dev / schnell / pro (city96 et al.)
    "sd",    // Stable Diffusion 1.x generic
    "sd1",   // SD 1.x explicit variant
    "sd2",   // SD 2.x explicit variant
    "sdxl",  // Stable Diffusion XL
    "sd3",   // Stable Diffusion 3.x / 3.5
    "mmdit", // Multimodal Diffusion Transformer (SD3 alternate)
    "auraflow",
];

/// True when `arch` (a `general.architecture` value) identifies a diffusion
/// model. Public so callers that only have the raw architecture string (e.g.
/// from the Hub's `gguf.architecture` field) can check without constructing a
/// full [`GgufMetadata`].
pub fn is_diffusion_architecture(arch: &str) -> bool {
    DIFFUSION_ARCHITECTURES.contains(&arch)
}

impl GgufMetadata {
    /// The model's chat template, if present.
    pub fn chat_template(&self) -> Option<&str> {
        self.strings
            .get("tokenizer.chat_template")
            .map(String::as_str)
    }

    /// The model architecture (`general.architecture`), if present.
    pub fn architecture(&self) -> Option<&str> {
        self.strings.get("general.architecture").map(String::as_str)
    }

    /// True when the GGUF's `general.architecture` identifies it as a
    /// generative diffusion model (image/video synthesis, not chat).
    pub fn is_diffusion(&self) -> bool {
        self.architecture()
            .is_some_and(|a| DIFFUSION_ARCHITECTURES.contains(&a))
    }
}

/// Read the leading metadata block of a GGUF file. Returns every string-valued
/// key; all other value types are skipped without being materialised. Stops at
/// the end of the metadata block — the tensor table and weights are never read.
pub fn read_metadata(path: &Path) -> io::Result<GgufMetadata> {
    let file = File::open(path)?;
    let mut r = BufReader::new(file);

    let magic = read_u32(&mut r)?;
    if magic != GGUF_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a GGUF file (bad magic)",
        ));
    }
    let version = read_u32(&mut r)?;
    if !(2..=3).contains(&version) {
        // v1 used 32-bit counts and is effectively extinct; refuse rather than
        // misparse. v3 is current; v2 is identical for our purposes.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported GGUF version {version}"),
        ));
    }
    // tensor_count (unused — we never read the tensor table).
    let _tensor_count = read_u64(&mut r)?;
    let kv_count = read_u64(&mut r)?;
    if kv_count > MAX_KV_COUNT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "implausible GGUF metadata count",
        ));
    }

    let mut strings = HashMap::new();
    for _ in 0..kv_count {
        let key = read_gguf_string(&mut r)?;
        let value_type = read_u32(&mut r)?;
        match read_or_skip_value(&mut r, value_type)? {
            Some(value) => {
                strings.insert(key, value);
            }
            None => {}
        }
    }
    Ok(GgufMetadata { strings })
}

/// GGUF value type tags (the on-disk `u32` discriminant).
mod val {
    pub const UINT8: u32 = 0;
    pub const INT8: u32 = 1;
    pub const UINT16: u32 = 2;
    pub const INT16: u32 = 3;
    pub const UINT32: u32 = 4;
    pub const INT32: u32 = 5;
    pub const FLOAT32: u32 = 6;
    pub const BOOL: u32 = 7;
    pub const STRING: u32 = 8;
    pub const ARRAY: u32 = 9;
    pub const UINT64: u32 = 10;
    pub const INT64: u32 = 11;
    pub const FLOAT64: u32 = 12;
}

/// Byte width of a fixed-size scalar value type, or `None` for variable-width
/// (string/array) types.
fn scalar_size(value_type: u32) -> Option<u64> {
    match value_type {
        val::UINT8 | val::INT8 | val::BOOL => Some(1),
        val::UINT16 | val::INT16 => Some(2),
        val::UINT32 | val::INT32 | val::FLOAT32 => Some(4),
        val::UINT64 | val::INT64 | val::FLOAT64 => Some(8),
        _ => None,
    }
}

/// Read a value of the given type. Returns `Some(text)` for a STRING value
/// (which we keep) and `None` for every other type (which is skipped in place).
fn read_or_skip_value<R: Read + Seek>(r: &mut R, value_type: u32) -> io::Result<Option<String>> {
    if let Some(size) = scalar_size(value_type) {
        r.seek(SeekFrom::Current(size as i64))?;
        return Ok(None);
    }
    match value_type {
        val::STRING => Ok(Some(read_gguf_string(r)?)),
        val::ARRAY => {
            skip_array(r)?;
            Ok(None)
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown GGUF value type {other}"),
        )),
    }
}

/// Skip an ARRAY value: `<elem_type:u32><count:u64><elements...>`.
fn skip_array<R: Read + Seek>(r: &mut R) -> io::Result<()> {
    let elem_type = read_u32(r)?;
    let count = read_u64(r)?;
    if let Some(size) = scalar_size(elem_type) {
        let total = size
            .checked_mul(count)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "array length overflow"))?;
        r.seek(SeekFrom::Current(total as i64))?;
        return Ok(());
    }
    if elem_type == val::STRING {
        for _ in 0..count {
            let len = read_u64(r)?;
            if len > MAX_STRING_LEN {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "implausible GGUF string length",
                ));
            }
            r.seek(SeekFrom::Current(len as i64))?;
        }
        return Ok(());
    }
    // Nested arrays are not produced by real model exporters; refuse rather than
    // risk a misaligned parse corrupting every subsequent key.
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "nested GGUF arrays are unsupported",
    ))
}

/// Read a GGUF string: `<len:u64><utf8 bytes>`. Lossy-decodes invalid UTF-8
/// (chat templates are UTF-8 in practice, but we never want to error a capability
/// probe over an exotic byte).
fn read_gguf_string<R: Read>(r: &mut R) -> io::Result<String> {
    let len = read_u64(r)?;
    if len > MAX_STRING_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "implausible GGUF string length",
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn read_u32<R: Read>(r: &mut R) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build an in-memory GGUF v3 file with the given string KV pairs (all
    /// string-valued, plus one fixed scalar to exercise the skip path).
    fn synth_gguf(strings: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&GGUF_MAGIC.to_le_bytes());
        out.extend_from_slice(&3u32.to_le_bytes()); // version
        out.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
                                                    // +1 for the scalar entry we append below.
        out.extend_from_slice(&((strings.len() as u64) + 1).to_le_bytes());
        let push_str = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        for (k, v) in strings {
            push_str(&mut out, k);
            out.extend_from_slice(&val::STRING.to_le_bytes());
            push_str(&mut out, v);
        }
        // A UINT32 entry to prove the scalar-skip keeps subsequent reads aligned.
        push_str(&mut out, "general.quantization_version");
        out.extend_from_slice(&val::UINT32.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out
    }

    fn parse(bytes: &[u8]) -> GgufMetadata {
        // read_metadata wants a path; exercise the inner reader directly instead.
        let mut r = Cursor::new(bytes);
        let magic = read_u32(&mut r).unwrap();
        assert_eq!(magic, GGUF_MAGIC);
        let _version = read_u32(&mut r).unwrap();
        let _tc = read_u64(&mut r).unwrap();
        let kv = read_u64(&mut r).unwrap();
        let mut strings = HashMap::new();
        for _ in 0..kv {
            let key = read_gguf_string(&mut r).unwrap();
            let vt = read_u32(&mut r).unwrap();
            if let Some(v) = read_or_skip_value(&mut r, vt).unwrap() {
                strings.insert(key, v);
            }
        }
        GgufMetadata { strings }
    }

    #[test]
    fn is_diffusion_matches_known_architectures() {
        for arch in [
            "flux", "sdxl", "sd3", "sd", "sd1", "sd2", "mmdit", "auraflow",
        ] {
            let bytes = synth_gguf(&[("general.architecture", arch)]);
            let meta = parse(&bytes);
            assert!(
                meta.is_diffusion(),
                "{arch} should be classified as diffusion"
            );
        }
        for arch in ["llama", "gemma3", "mistral", "qwen2", "phi3"] {
            let bytes = synth_gguf(&[("general.architecture", arch)]);
            let meta = parse(&bytes);
            assert!(
                !meta.is_diffusion(),
                "{arch} must not be classified as diffusion"
            );
        }
        // No architecture key → not diffusion (e.g. city96 GGUF with no arch).
        let bytes = synth_gguf(&[("tokenizer.chat_template", "hi")]);
        let meta = parse(&bytes);
        assert!(!meta.is_diffusion());
    }

    #[test]
    fn reads_chat_template_and_skips_scalar() {
        let bytes = synth_gguf(&[
            ("general.architecture", "gemma3"),
            (
                "tokenizer.chat_template",
                "{% if tools %}...{{ tool }}...{% endif %}",
            ),
        ]);
        let meta = parse(&bytes);
        assert_eq!(meta.architecture(), Some("gemma3"));
        assert!(meta.chat_template().unwrap().contains("tools"));
        // The trailing scalar entry must not have desynced the parse.
        assert_eq!(meta.strings.len(), 2);
    }

    #[test]
    fn round_trips_via_temp_file() {
        let bytes = synth_gguf(&[("tokenizer.chat_template", "no tool support here")]);
        let dir = std::env::temp_dir();
        let path = dir.join(format!("ryu-gguf-test-{}.gguf", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let meta = read_metadata(&path).unwrap();
        assert_eq!(
            meta.chat_template(),
            Some("no tool support here"),
            "template read from a real file on disk"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_non_gguf() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("ryu-not-gguf-{}.bin", std::process::id()));
        std::fs::write(&path, b"this is not a gguf file at all").unwrap();
        assert!(read_metadata(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
