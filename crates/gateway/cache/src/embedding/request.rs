//! The cacheable shape of an embeddings request and its per-input cache key.

use hex::encode as hex_encode;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The cacheable parts of an embeddings request body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingRequest {
    /// Inputs in request order.
    pub inputs: Vec<String>,
    /// `dimensions`, when the caller asked for truncated vectors.
    pub dimensions: Option<u64>,
    /// `encoding_format` (`float` when absent).
    pub encoding_format: String,
}

impl EmbeddingRequest {
    /// Extract the cacheable shape, or `None` when the request must bypass the
    /// cache: token-array inputs, an empty batch, a `user` field (an attribution
    /// signal the provider may act on), or unknown `encoding_format`.
    pub fn from_body(body: &Value) -> Option<Self> {
        if body.get("user").is_some_and(|user| !user.is_null()) {
            return None;
        }
        let inputs = match body.get("input")? {
            Value::String(text) => vec![text.clone()],
            Value::Array(items) => items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
            _ => return None,
        };
        if inputs.is_empty() {
            return None;
        }
        let encoding_format = match body.get("encoding_format") {
            None | Some(Value::Null) => "float".to_owned(),
            Some(Value::String(format)) if matches!(format.as_str(), "float" | "base64") => {
                format.clone()
            }
            Some(_) => return None,
        };
        let dimensions = match body.get("dimensions") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64()?),
        };
        Some(Self {
            inputs,
            dimensions,
            encoding_format,
        })
    }
}

/// Trim and fold line endings; see the module docs.
pub fn normalize_input(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_owned()
}

fn hash_segment(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

/// The cache key for one input.
pub fn embedding_key(scope: &str, request: &EmbeddingRequest, input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-embedding-cache-v1\0");
    hash_segment(&mut hasher, scope.as_bytes());
    match request.dimensions {
        Some(dimensions) => {
            hasher.update([1]);
            hasher.update(dimensions.to_be_bytes());
        }
        None => hasher.update([0]),
    }
    hash_segment(&mut hasher, request.encoding_format.as_bytes());
    hash_segment(&mut hasher, normalize_input(input).as_bytes());
    hex_encode(hasher.finalize())
}
