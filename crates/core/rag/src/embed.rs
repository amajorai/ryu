//! Text embedders: the local hashing embedder and the remote
//! OpenAI-compatible `/v1/embeddings` client.

use super::*;

/// Produces a fixed-length embedding vector for a piece of text.
///
/// The default implementation is a dependency-free local hashing embedder so
/// Core can ground answers with no external model. Operators who want real
/// semantic embeddings can point `RYU_EMBED_BASE_URL` at an OpenAI-compatible
/// `/v1/embeddings` endpoint (see [`Embedder::from_registry`]).
#[derive(Clone)]
pub enum Embedder {
    /// Deterministic local hashing embedder (no network). Dims from the registry.
    Local { dims: usize },
    /// Remote OpenAI-compatible embeddings endpoint.
    Remote {
        base_url: String,
        model: String,
        dims: usize,
        api_key: Option<String>,
    },
}

impl Embedder {
    /// Build a remote OpenAI-compatible embedder from plain config, or fall back to
    /// the dependency-free local hashing embedder when `base_url` is blank.
    ///
    /// The registry/env read (`RYU_EMBED_BASE_URL`, `RYU_EMBED_API_KEY`,
    /// `OPENAI_API_KEY`, registry dims/model) is the Core-side resolver's job
    /// (`apps/core/src/rag_host.rs`) — this crate only takes the resolved config so
    /// it stays free of the model registry.
    pub fn remote(base_url: &str, model: &str, dims: usize, api_key: Option<String>) -> Self {
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return Self::Local { dims };
        }
        Self::Remote {
            base_url: base_url.to_string(),
            model: model.to_string(),
            dims,
            api_key: api_key.filter(|s| !s.is_empty()),
        }
    }

    /// Returns `true` for the deterministic local hashing embedder (no network).
    /// Callers use this to decide whether embedding work can run inline (local,
    /// never blocks) or must be spawned off the request path (remote sidecar).
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }

    /// Returns the dimensionality this embedder produces.
    pub fn dims(&self) -> usize {
        match self {
            Self::Local { dims } => *dims,
            Self::Remote { dims, .. } => *dims,
        }
    }

    /// Returns the model identifier for this embedder (local or remote).
    pub fn model_id(&self) -> &str {
        match self {
            Self::Local { .. } => "local-hashing",
            Self::Remote { model, .. } => model.as_str(),
        }
    }

    /// Embed a single piece of text into a normalized vector.
    pub async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        match self {
            Self::Local { dims } => Ok(local_embed(text, *dims)),
            Self::Remote {
                base_url,
                model,
                api_key,
                dims,
            } => {
                let embedding =
                    remote_embed(base_url, model, *dims, api_key.as_deref(), text).await?;
                anyhow::ensure!(
                    embedding.len() == *dims,
                    "embedding provider returned {} dimensions for model '{}' (expected {})",
                    embedding.len(),
                    model,
                    dims
                );
                Ok(embedding)
            }
        }
    }

    /// Embed many texts, returning one vector per input in input order.
    ///
    /// A remote embedder sends up to [`EMBED_BATCH_SIZE`] inputs per request instead
    /// of one round trip per text, which is what dominates ingesting a long
    /// document. A batch the endpoint refuses (some servers take only a single
    /// string, or cap the batch below ours) is retried one text at a time, so the
    /// result is never worse than calling [`Self::embed`] in a loop.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        anyhow::ensure!(
            texts.len() <= 256,
            "embedding batches may contain at most 256 inputs"
        );
        let Self::Remote {
            base_url,
            model,
            api_key,
            dims,
        } = self
        else {
            let mut vectors = Vec::with_capacity(texts.len());
            for text in texts {
                vectors.push(self.embed(text).await?);
            }
            return Ok(vectors);
        };
        let mut vectors = Vec::with_capacity(texts.len());
        for batch in texts.chunks(EMBED_BATCH_SIZE) {
            let embedded = if batch.len() == 1 {
                Err(anyhow::anyhow!("single input uses the scalar path"))
            } else {
                remote_embed_batch(base_url, model, *dims, api_key.as_deref(), batch).await
            };
            match embedded {
                Ok(batch_vectors) => {
                    for embedding in &batch_vectors {
                        anyhow::ensure!(
                            embedding.len() == *dims,
                            "embedding provider returned {} dimensions for model '{}' (expected {})",
                            embedding.len(),
                            model,
                            dims
                        );
                    }
                    vectors.extend(batch_vectors);
                }
                Err(_) => {
                    for text in batch {
                        vectors.push(self.embed(text).await?);
                    }
                }
            }
        }
        Ok(vectors)
    }
}

/// Inputs per remote `/v1/embeddings` request in [`Embedder::embed_batch`]. Small
/// enough to stay under llama-server's per-request token budget for typical
/// chunk sizes and under hosted APIs' input-count caps.
pub const EMBED_BATCH_SIZE: usize = 32;

/// Deterministic local embedding: a normalized bag-of-token-hashes vector.
///
/// Tokens are lowercased word-ish spans; each token is hashed into a bucket and
/// accumulated. The vector is L2-normalized so cosine similarity reduces to a
/// dot product. This is intentionally simple but gives meaningful term-overlap
/// relevance offline.
pub(crate) fn local_embed(text: &str, dims: usize) -> Vec<f32> {
    let mut vec = vec![0.0f32; dims];
    for token in tokenize(text) {
        let bucket = (fnv1a(&token) as usize) % dims;
        vec[bucket] += 1.0;
    }
    l2_normalize(&mut vec);
    vec
}

/// Split text into lowercased alphanumeric tokens.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// FNV-1a 64-bit hash — small, fast, dependency-free, stable across runs.
pub(crate) fn fnv1a(s: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in s.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

pub(crate) fn l2_normalize(vec: &mut [f32]) {
    let norm: f32 = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for v in vec.iter_mut() {
            *v /= norm;
        }
    }
}

/// Cosine similarity of two equal-length vectors. Returns 0.0 on length
/// mismatch (e.g. a stored embedding from a different embedder).
pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom > f32::EPSILON {
        dot / denom
    } else {
        0.0
    }
}

/// [`cosine_similarity`] against a little-endian f32 embedding blob, without
/// decoding it into a `Vec`. Same length rule and accumulation order, so the
/// score matches `cosine_similarity(a, &decode_embedding_blob(blob))` exactly.
#[cfg(test)]
pub(crate) fn cosine_similarity_blob(a: &[f32], blob: &[u8]) -> f32 {
    if a.len() != blob.len() / 4 {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, bytes) in a.iter().zip(blob.chunks_exact(4)) {
        let y = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom > f32::EPSILON {
        dot / denom
    } else {
        0.0
    }
}

/// Call an OpenAI-compatible `/v1/embeddings` endpoint for a single input.
pub(crate) fn embeddings_http_client() -> &'static reqwest::Client {
    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

/// A non-success `/v1/embeddings` reply: status plus a bounded body excerpt so
/// callers can tell a parameter rejection from other failures.
#[derive(Debug)]
pub(crate) struct EmbeddingsHttpError {
    status: reqwest::StatusCode,
    body: String,
}

impl std::fmt::Display for EmbeddingsHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "embeddings endpoint returned HTTP {}", self.status)?;
        if !self.body.is_empty() {
            write!(f, ": {}", self.body)?;
        }
        Ok(())
    }
}

impl std::error::Error for EmbeddingsHttpError {}

impl EmbeddingsHttpError {
    /// True when the provider refused the request because of the `dimensions`
    /// parameter (e.g. OpenAI `text-embedding-ada-002`, or an OpenAI-compatible
    /// server hosting a model without Matryoshka truncation).
    fn rejects_dimensions(&self) -> bool {
        (self.status == reqwest::StatusCode::BAD_REQUEST
            || self.status == reqwest::StatusCode::UNPROCESSABLE_ENTITY)
            && self.body.to_ascii_lowercase().contains("dimensions")
    }
}

/// Maximum bytes of an error body kept for diagnostics.
pub(crate) const EMBEDDINGS_ERROR_BODY_LIMIT: usize = 512;

/// POST one `/v1/embeddings` request and return the decoded body.
pub(crate) async fn post_embeddings(
    base_url: &str,
    api_key: Option<&str>,
    payload: &serde_json::Value,
) -> Result<serde_json::Value> {
    let endpoint = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));
    let mut builder = embeddings_http_client().post(endpoint).json(payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.send().await.context("embeddings request failed")?;
    let status = resp.status();
    if !status.is_success() {
        let mut body = resp.text().await.unwrap_or_default();
        if body.len() > EMBEDDINGS_ERROR_BODY_LIMIT {
            let mut cut = EMBEDDINGS_ERROR_BODY_LIMIT;
            while !body.is_char_boundary(cut) {
                cut -= 1;
            }
            body.truncate(cut);
        }
        return Err(EmbeddingsHttpError { status, body }.into());
    }
    resp.json().await.context("decoding embeddings response")
}

/// Whether `model` is known to accept the OpenAI `dimensions` parameter
/// (Matryoshka-trained models that can truncate their output). Models without
/// it, such as `text-embedding-ada-002`, reject the field with HTTP 400, so it
/// is only sent where it is understood. Provider prefixes (`openai/…`) are
/// ignored.
pub(crate) fn model_supports_dimensions(model: &str) -> bool {
    let name = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    const MATRYOSHKA_PREFIXES: &[&str] = &[
        "text-embedding-3-",
        "nomic-embed-text-v1.5",
        "jina-embeddings-v3",
        "gemini-embedding-",
        "voyage-3",
        "voyage-code-3",
    ];
    MATRYOSHKA_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// POST an embeddings request, adding `dimensions` only for models that support
/// it. If the provider still rejects the field, retry exactly once without it;
/// callers verify the returned width against the index dims either way, so a
/// provider that ignores the request can never write a mismatched vector.
pub(crate) async fn post_embeddings_for_model(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    dims: usize,
    input: serde_json::Value,
) -> Result<serde_json::Value> {
    let mut payload = serde_json::json!({ "model": model, "input": input });
    if !model_supports_dimensions(model) {
        return post_embeddings(base_url, api_key, &payload).await;
    }
    payload["dimensions"] = serde_json::json!(dims);
    match post_embeddings(base_url, api_key, &payload).await {
        Err(error)
            if error
                .downcast_ref::<EmbeddingsHttpError>()
                .is_some_and(EmbeddingsHttpError::rejects_dimensions) =>
        {
            tracing::warn!(
                model,
                dims,
                "embedding provider rejected the `dimensions` parameter; retrying without it"
            );
            if let Some(object) = payload.as_object_mut() {
                object.remove("dimensions");
            }
            post_embeddings(base_url, api_key, &payload).await
        }
        other => other,
    }
}

/// Decode one `data[].embedding` entry, refusing non-finite values.
pub(crate) fn decode_embedding(entry: &serde_json::Value) -> Result<Vec<f32>> {
    let vec = entry
        .get("embedding")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|n| {
                    n.as_f64()
                        .map(|f| f as f32)
                        .context("embedding response contains a non-numeric value")
                })
                .collect::<Result<Vec<f32>>>()
        })
        .context("embeddings response entry missing its embedding")??;
    anyhow::ensure!(
        vec.iter().all(|value| value.is_finite()),
        "embeddings response contains a non-finite value"
    );
    Ok(vec)
}

pub(crate) async fn remote_embed(
    base_url: &str,
    model: &str,
    dims: usize,
    api_key: Option<&str>,
    text: &str,
) -> Result<Vec<f32>> {
    let body =
        post_embeddings_for_model(base_url, api_key, model, dims, serde_json::json!(text)).await?;
    let entry = body
        .get("data")
        .and_then(|d| d.get(0))
        .context("embeddings response missing data[0].embedding")?;
    decode_embedding(entry)
}

/// Embed several inputs in one request. Entries are placed by their `index`
/// field (the OpenAI contract), never by response position, and the response
/// must account for every input exactly once.
pub(crate) async fn remote_embed_batch(
    base_url: &str,
    model: &str,
    dims: usize,
    api_key: Option<&str>,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    let body =
        post_embeddings_for_model(base_url, api_key, model, dims, serde_json::json!(texts)).await?;
    parse_remote_embedding_batch(&body, texts.len(), dims)
}

pub(crate) fn parse_remote_embedding_batch(
    body: &serde_json::Value,
    expected_count: usize,
    expected_dims: usize,
) -> Result<Vec<Vec<f32>>> {
    let data = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .context("embeddings response missing data")?;
    anyhow::ensure!(
        data.len() == expected_count,
        "embedding provider returned {} vectors for {expected_count} inputs",
        data.len()
    );

    let mut ordered = vec![None; expected_count];
    for item in data {
        let index = item
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .context("embedding response item missing a valid index")?;
        anyhow::ensure!(
            index < expected_count,
            "embedding provider returned an out-of-range index"
        );
        anyhow::ensure!(
            ordered[index].is_none(),
            "embedding provider returned a duplicate index"
        );

        let embedding = item
            .get("embedding")
            .and_then(serde_json::Value::as_array)
            .context("embedding response item missing a vector")?;
        anyhow::ensure!(
            embedding.len() == expected_dims,
            "embedding provider returned {} dimensions (expected {expected_dims})",
            embedding.len()
        );
        let vector = embedding
            .iter()
            .map(|value| {
                value
                    .as_f64()
                    .map(|number| number as f32)
                    .context("embedding response contains a non-numeric value")
            })
            .collect::<Result<Vec<_>>>()?;
        anyhow::ensure!(
            vector.iter().all(|value| value.is_finite()),
            "embedding response contains a non-finite value"
        );
        ordered[index] = Some(vector);
    }

    ordered
        .into_iter()
        .map(|vector| vector.context("embedding response omitted an input index"))
        .collect()
}
