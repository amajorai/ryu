//! Rerankers: local term-overlap and a remote scoring endpoint.

use super::*;

/// Re-scores and reorders candidate chunks relative to a query.
///
/// The local default uses exact term-overlap (Jaccard-style token intersection)
/// as a second signal that is orthogonal to the hashed cosine used in the first
/// pass — so the two passes can genuinely disagree on ordering, which makes the
/// reranker testable with a deterministic fixture.
///
/// Operators can point `RYU_RERANKER_BASE_URL` at an OpenAI-compatible scoring
/// endpoint (e.g. a hosted `BAAI/bge-reranker` instance) for real neural
/// reranking.
#[derive(Clone)]
pub enum Reranker {
    /// Local exact term-overlap reranker (no network). Always available.
    Local,
    /// Remote cross-encoder scoring endpoint (model id from registry).
    Remote {
        base_url: String,
        model: String,
        api_key: Option<String>,
    },
}

impl Reranker {
    /// Build a remote cross-encoder reranker from plain config, or the local
    /// term-overlap reranker when `base_url` is blank.
    ///
    /// The registry/env read (`RYU_RERANKER_BASE_URL`, `RYU_RERANKER_API_KEY`, the
    /// registry reranker model/base-url) is the Core-side resolver's job
    /// (`apps/core/src/rag_host.rs`) — this crate only takes the resolved config.
    pub fn remote(base_url: &str, model: &str, api_key: Option<String>) -> Self {
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return Self::Local;
        }
        Self::Remote {
            base_url: base_url.to_string(),
            model: model.to_string(),
            api_key: api_key.filter(|s| !s.is_empty()),
        }
    }

    /// Score `documents` against `query`, returning `(original_index, score)`
    /// pairs sorted best-first. A lower-level primitive for callers (e.g. Spaces
    /// search) that hold their own chunk type rather than [`ScoredChunk`]. The
    /// `Remote` branch reuses the same `/rerank` request/response contract as
    /// [`remote_rerank`] (the bundled llama-server `--reranking` endpoint).
    pub async fn rank_documents(
        &self,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<(usize, f32)>> {
        match self {
            Self::Local => {
                let query_tokens = token_set(query);
                let mut ranked: Vec<(usize, f32)> = documents
                    .iter()
                    .enumerate()
                    .map(|(i, doc)| (i, jaccard(&query_tokens, &token_set(doc))))
                    .collect();
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                Ok(ranked)
            }
            Self::Remote {
                base_url,
                model,
                api_key,
            } => {
                static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> =
                    std::sync::OnceLock::new();
                let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
                let endpoint = format!("{}/rerank", base_url.trim_end_matches('/'));
                let payload = serde_json::json!({
                    "model": model,
                    "query": query,
                    "documents": documents,
                });
                let mut builder = client.post(endpoint).json(&payload);
                if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
                    builder = builder.bearer_auth(key);
                }
                let resp = builder.send().await.context("reranking request failed")?;
                if !resp.status().is_success() {
                    anyhow::bail!("rerank endpoint returned HTTP {}", resp.status());
                }
                let body: serde_json::Value =
                    resp.json().await.context("decoding rerank response")?;
                let results = body
                    .get("results")
                    .and_then(|r| r.as_array())
                    .context("rerank response missing 'results' array")?;
                let mut ranked: Vec<(usize, f32)> = Vec::with_capacity(results.len());
                for result in results {
                    let idx = result
                        .get("index")
                        .and_then(serde_json::Value::as_u64)
                        .context("rerank result missing 'index'")?
                        as usize;
                    let score = result
                        .get("relevance_score")
                        .and_then(serde_json::Value::as_f64)
                        .context("rerank result missing 'relevance_score'")?
                        as f32;
                    if idx < documents.len() {
                        ranked.push((idx, score));
                    }
                }
                anyhow::ensure!(
                    ranked.len() == documents.len()
                        && ranked
                            .iter()
                            .map(|(idx, _)| *idx)
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == documents.len(),
                    "rerank response must contain exactly one result for every document"
                );
                anyhow::ensure!(
                    ranked.iter().all(|(_, score)| score.is_finite()),
                    "rerank response contains a non-finite score"
                );
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                Ok(ranked)
            }
        }
    }

    /// Returns the model identifier for this reranker. The `Local` reranker has no
    /// model of its own, so callers pass the configured default reranker id as the
    /// fallback (the Core-side resolver supplies it from the registry).
    pub fn model_id<'a>(&'a self, local_fallback: &'a str) -> &'a str {
        match self {
            Self::Local => local_fallback,
            Self::Remote { model, .. } => model.as_str(),
        }
    }

    /// Re-score `candidates` relative to `query` and return them sorted by the
    /// new score (highest first).
    pub async fn rerank(
        &self,
        query: &str,
        mut candidates: Vec<ScoredChunk>,
    ) -> Result<Vec<ScoredChunk>> {
        match self {
            Self::Local => {
                let query_tokens = token_set(query);
                for chunk in &mut candidates {
                    let chunk_tokens = token_set(&chunk.content);
                    chunk.score = jaccard(&query_tokens, &chunk_tokens);
                }
                candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
                Ok(candidates)
            }
            Self::Remote {
                base_url,
                model,
                api_key,
            } => remote_rerank(base_url, model, api_key.as_deref(), query, candidates).await,
        }
    }
}

/// Build a lowercased token set from text (for Jaccard reranking).
pub(crate) fn token_set(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 when both sets are empty.
pub(crate) fn jaccard(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f32;
    let union = (a.len() + b.len()) as f32 - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

/// Call a remote cross-encoder scoring endpoint (OpenAI-compatible pattern for
/// reranking APIs that accept `{"model", "query", "documents"}`).
pub(crate) async fn remote_rerank(
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    query: &str,
    mut candidates: Vec<ScoredChunk>,
) -> Result<Vec<ScoredChunk>> {
    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let endpoint = format!("{}/rerank", base_url.trim_end_matches('/'));
    let documents: Vec<&str> = candidates.iter().map(|c| c.content.as_str()).collect();
    let payload = serde_json::json!({
        "model": model,
        "query": query,
        "documents": documents,
    });
    let mut builder = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.send().await.context("reranking request failed")?;
    if !resp.status().is_success() {
        anyhow::bail!("rerank endpoint returned HTTP {}", resp.status());
    }
    let body: serde_json::Value = resp.json().await.context("decoding rerank response")?;
    let results = body
        .get("results")
        .and_then(|r| r.as_array())
        .context("rerank response missing 'results' array")?;
    for result in results {
        let idx = result
            .get("index")
            .and_then(|v| v.as_u64())
            .context("rerank result missing 'index'")? as usize;
        let score = result
            .get("relevance_score")
            .and_then(|v| v.as_f64())
            .context("rerank result missing 'relevance_score'")? as f32;
        if idx < candidates.len() {
            candidates[idx].score = score;
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(candidates)
}
