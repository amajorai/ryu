use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use dashmap::DashMap;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::debug;

use crate::config::{OpenAiProviderConfig, SemanticCacheConfig};

struct Entry {
    org_id: Option<String>,
    embedding: Vec<f32>,
    response: Value,
    inserted_at: Instant,
}

pub struct SemanticCache {
    config: SemanticCacheConfig,
    store: DashMap<u64, Entry>,
    ttl_secs: u64,
    /// Monotonic counter used as insert key — safe across evictions.
    next_key: AtomicU64,
}

impl SemanticCache {
    pub fn new(config: SemanticCacheConfig, ttl_secs: u64) -> Self {
        Self {
            config,
            store: DashMap::new(),
            ttl_secs,
            next_key: AtomicU64::new(0),
        }
    }

    /// Fetch an embedding vector for `text` via the OpenAI embeddings endpoint,
    /// using this cache's configured embedding model.
    pub async fn get_embedding(
        &self,
        text: &str,
        http: &Client,
        openai: &OpenAiProviderConfig,
    ) -> anyhow::Result<Vec<f32>> {
        embed_text(text, http, openai, &self.config.embedding_model).await
    }

    /// Look up a cached response whose embedding is within the similarity threshold.
    ///
    /// `org_id` scopes the nearest-neighbor search to the caller's tenant so the
    /// match can never cross orgs. `None` (no org) forms its own bucket and never
    /// matches a real org's entries.
    pub fn lookup(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value> {
        let threshold = self.config.similarity_threshold;
        let now = Instant::now();

        let mut best_score = -1.0_f32;
        let mut best_response: Option<Value> = None;

        for entry in self.store.iter() {
            if entry.org_id.as_deref() != org_id {
                continue;
            }
            let age = now.duration_since(entry.inserted_at).as_secs();
            if age > self.ttl_secs {
                continue;
            }
            let score = cosine_similarity(query, &entry.embedding);
            if score > best_score {
                best_score = score;
                best_response = Some(entry.response.clone());
            }
        }

        if best_score >= threshold {
            debug!(score = best_score, threshold, "semantic cache hit");
            best_response
        } else {
            None
        }
    }

    /// Store a new embedding + response, tagged with the caller's tenant.
    pub fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
        let key = self.next_key.fetch_add(1, Ordering::Relaxed);
        self.store.insert(
            key,
            Entry {
                org_id,
                embedding,
                response,
                inserted_at: Instant::now(),
            },
        );
    }

    /// Evict expired entries.  Called from the same background task as the
    /// exact-match cache eviction.
    pub fn evict_expired(&self) {
        let now = Instant::now();
        self.store
            .retain(|_, e| now.duration_since(e.inserted_at).as_secs() <= self.ttl_secs);
    }

    /// Flatten the `messages` array into a single string suitable for embedding.
    pub fn messages_to_text(messages: &Value) -> String {
        messages
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let role = m["role"].as_str().unwrap_or("");
                        let content = m["content"].as_str().unwrap_or("");
                        if content.is_empty() {
                            None
                        } else {
                            Some(format!("{role}: {content}"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }
}

/// Fetch an embedding vector for `text` via an OpenAI-compatible `/embeddings`
/// endpoint with the given model. Shared by the semantic cache and the
/// `Embedding` routing strategy so both hit the same (local by default) embedder.
pub(crate) async fn embed_text(
    text: &str,
    http: &Client,
    openai: &OpenAiProviderConfig,
    model: &str,
) -> anyhow::Result<Vec<f32>> {
    let url = format!("{}/embeddings", openai.base_url);
    let resp = http
        .post(&url)
        .bearer_auth(&openai.api_key)
        .json(&json!({
            "model": model,
            "input": text,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    let embedding = resp["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing embedding in response"))?
        .iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    Ok(embedding)
}

pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return -1.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return -1.0;
    }
    dot / (norm_a * norm_b)
}
