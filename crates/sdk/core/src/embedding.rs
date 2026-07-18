//! Gateway-mandatory embedding client — the retrieval-side sibling of
//! [`crate::model`].
//!
//! Mirrors [`ModelClient`](crate::model::ModelClient): every call POSTs to
//! `{base}/v1/embeddings` on the Ryu gateway (the same OpenAI-compat plane the
//! gateway's `semantic_cache` and Core's `/api/embeddings` speak), and the client
//! never contacts a provider directly. Egress is enforced at construction through
//! the shared [`assert_allowed_egress`] rule so SDK user code can never leak
//! provider credentials or route around policy.
//!
//! Wire contract (OpenAI-compat): request `{ "model", "input": [..] }`, response
//! `{ "data": [{ "embedding": [..], "index" }], "model", "usage" }`. The input is
//! always sent as an array so a single call can embed one text or a batch.

use serde::{Deserialize, Serialize};

use crate::gateway::{
    assert_allowed_egress, resolve_gateway_token, resolve_gateway_url, EgressNotAllowed,
};

/// One embedding vector with its position in the input batch.
#[derive(Debug, Clone, PartialEq)]
pub struct Embedding {
    /// The index of the source text in the request batch.
    pub index: usize,
    /// The embedding vector.
    pub vector: Vec<f32>,
}

/// Token usage as reported by the gateway for an embedding request.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingUsage {
    pub prompt_tokens: u64,
    pub total_tokens: u64,
}

/// The result of an embedding request: one vector per input text (in order).
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingResult {
    /// Embeddings in input order (sorted by the response `index`).
    pub embeddings: Vec<Embedding>,
    /// Usage stats when the gateway reports them.
    pub usage: Option<EmbeddingUsage>,
}

impl EmbeddingResult {
    /// The raw vectors in input order, dropping the index metadata.
    pub fn vectors(&self) -> Vec<Vec<f32>> {
        self.embeddings.iter().map(|e| e.vector.clone()).collect()
    }

    /// The first embedding vector, if any (the single-input convenience).
    pub fn first_vector(&self) -> Option<&[f32]> {
        self.embeddings.first().map(|e| e.vector.as_slice())
    }
}

/// Errors an [`EmbeddingClient`] can surface. Parallels [`crate::model::ModelError`].
#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    /// The configured base URL points at a blocked direct provider.
    #[error(transparent)]
    Egress(#[from] EgressNotAllowed),
    /// Network/transport failure talking to the gateway.
    #[error("[ryu-sdk] gateway embedding request failed: {0}")]
    Transport(#[from] reqwest::Error),
    /// The gateway returned a non-2xx status.
    #[error("[ryu-sdk] gateway returned HTTP {status} from {url}: {body}")]
    Http {
        status: u16,
        url: String,
        body: String,
    },
}

/// Options for [`EmbeddingClient::new`]. Mirrors
/// [`ModelClientOptions`](crate::model::ModelClientOptions).
#[derive(Debug, Default, Clone)]
pub struct EmbeddingClientOptions {
    /// Gateway base URL (no trailing `/v1`). Defaults to `RYU_GATEWAY_URL` then
    /// [`crate::gateway::DEFAULT_GATEWAY_URL`]. Direct provider URLs are rejected.
    pub base_url: Option<String>,
    /// Bearer token forwarded as `Authorization: Bearer <token>`. Defaults to
    /// `RYU_GATEWAY_TOKEN`.
    pub token: Option<String>,
}

/// A gateway-mandatory embedding client.
#[derive(Debug, Clone)]
pub struct EmbeddingClient {
    model: String,
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

// ── Wire types (deserialised from the gateway) ────────────────────────────────

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Option<Vec<WireEmbedding>>,
    usage: Option<WireUsage>,
}
#[derive(Deserialize)]
struct WireEmbedding {
    embedding: Option<Vec<f32>>,
    index: Option<usize>,
}
#[derive(Deserialize)]
struct WireUsage {
    prompt_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

// ── Request types (serialised to the gateway) ─────────────────────────────────

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

impl EmbeddingClient {
    /// Construct a client for embedding `model`. Rejects a direct-provider
    /// `base_url` at construction time (egress enforcement), exactly like
    /// [`ModelClient::new`](crate::model::ModelClient::new).
    pub fn new(
        model: impl Into<String>,
        options: EmbeddingClientOptions,
    ) -> Result<Self, EmbeddingError> {
        let base = options.base_url.unwrap_or_else(resolve_gateway_url);
        assert_allowed_egress(&base)?;
        Ok(Self {
            model: model.into(),
            base_url: base.trim_end_matches('/').to_string(),
            token: options.token.or_else(resolve_gateway_token),
            http: reqwest::Client::new(),
        })
    }

    /// The embedding model id this client targets.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The resolved gateway base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn embeddings_url(&self) -> String {
        format!("{}/v1/embeddings", self.base_url)
    }

    /// Embed a batch of texts, returning one vector per input (in input order).
    pub async fn embed(&self, inputs: &[String]) -> Result<EmbeddingResult, EmbeddingError> {
        let url = self.embeddings_url();
        let body = EmbeddingRequest {
            model: &self.model,
            input: inputs,
        };
        let mut req = self.http.post(&url).json(&body);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(EmbeddingError::Http { status, url, body });
        }
        let parsed: EmbeddingResponse = resp.json().await?;
        let mut embeddings: Vec<Embedding> = parsed
            .data
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(fallback_index, item)| Embedding {
                index: item.index.unwrap_or(fallback_index),
                vector: item.embedding.unwrap_or_default(),
            })
            .collect();
        embeddings.sort_by_key(|e| e.index);
        Ok(EmbeddingResult {
            embeddings,
            usage: parsed.usage.map(|u| EmbeddingUsage {
                prompt_tokens: u.prompt_tokens.unwrap_or(0),
                total_tokens: u.total_tokens.unwrap_or(0),
            }),
        })
    }

    /// Embed a single text, returning its vector. Convenience over [`Self::embed`].
    pub async fn embed_one(&self, input: impl Into<String>) -> Result<Vec<f32>, EmbeddingError> {
        let result = self.embed(&[input.into()]).await?;
        Ok(result
            .first_vector()
            .map(<[f32]>::to_vec)
            .unwrap_or_default())
    }
}

/// Convenience constructor mirroring the TS-style `defineEmbedding(id, opts)`
/// factory and [`crate::model::define_model`].
pub fn define_embedding(
    model: impl Into<String>,
    options: EmbeddingClientOptions,
) -> Result<EmbeddingClient, EmbeddingError> {
    EmbeddingClient::new(model, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_direct_provider_base_url() {
        let err = EmbeddingClient::new(
            "text-embedding-3-small",
            EmbeddingClientOptions {
                base_url: Some("https://api.openai.com".into()),
                token: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, EmbeddingError::Egress(_)));
    }

    #[test]
    fn defaults_to_gateway_and_strips_trailing_slash() {
        let c = EmbeddingClient::new(
            "nomic-embed-text-v1.5",
            EmbeddingClientOptions {
                base_url: Some("http://127.0.0.1:7981/".into()),
                token: None,
            },
        )
        .unwrap();
        assert_eq!(c.base_url(), "http://127.0.0.1:7981");
        assert_eq!(c.embeddings_url(), "http://127.0.0.1:7981/v1/embeddings");
        assert_eq!(c.model(), "nomic-embed-text-v1.5");
    }

    #[test]
    fn parses_embedding_response_in_order() {
        // Response with out-of-order indices must be sorted back to input order.
        let raw = r#"{
            "data": [
                {"embedding": [0.3, 0.4], "index": 1},
                {"embedding": [0.1, 0.2], "index": 0}
            ],
            "usage": {"prompt_tokens": 5, "total_tokens": 5}
        }"#;
        let parsed: EmbeddingResponse = serde_json::from_str(raw).unwrap();
        let mut embeddings: Vec<Embedding> = parsed
            .data
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(fallback_index, item)| Embedding {
                index: item.index.unwrap_or(fallback_index),
                vector: item.embedding.unwrap_or_default(),
            })
            .collect();
        embeddings.sort_by_key(|e| e.index);
        let result = EmbeddingResult {
            embeddings,
            usage: parsed.usage.map(|u| EmbeddingUsage {
                prompt_tokens: u.prompt_tokens.unwrap_or(0),
                total_tokens: u.total_tokens.unwrap_or(0),
            }),
        };
        assert_eq!(result.vectors(), vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
        assert_eq!(result.first_vector(), Some([0.1, 0.2].as_slice()));
        assert_eq!(
            result.usage,
            Some(EmbeddingUsage {
                prompt_tokens: 5,
                total_tokens: 5
            })
        );
    }

    #[test]
    fn request_serialises_input_as_array() {
        let body = EmbeddingRequest {
            model: "nomic-embed-text-v1.5",
            input: &["hello".to_string(), "world".to_string()],
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["model"], "nomic-embed-text-v1.5");
        assert_eq!(json["input"], serde_json::json!(["hello", "world"]));
    }

    #[test]
    fn define_embedding_factory_matches_constructor() {
        let c = define_embedding(
            "embed",
            EmbeddingClientOptions {
                base_url: Some("http://localhost:7981".into()),
                token: None,
            },
        )
        .unwrap();
        assert_eq!(c.base_url(), "http://localhost:7981");
    }
}
