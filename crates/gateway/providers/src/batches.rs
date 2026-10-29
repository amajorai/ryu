//! Provider-native asynchronous inference batches.

use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// OpenRouter's supported request shapes for one batch.
pub const BATCH_ENDPOINTS: [&str; 4] = [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/embeddings",
];

/// One request inside an OpenRouter batch. `custom_id` is the stable join key
/// used to correlate an independent result with its input row.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BatchRequestItem {
    pub custom_id: String,
    pub body: Value,
}

/// Optional provider pin accepted by OpenRouter's Batch API.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchProviderRouting {
    pub only: Vec<String>,
}

/// OpenRouter Batch API create request. Field order is intentional: OpenRouter
/// stream-parses large request arrays and requires `requests` to be last.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchCreateRequest {
    pub endpoint: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<BatchProviderRouting>,
    pub requests: Vec<BatchRequestItem>,
}

/// Bounded filters for listing batches. OpenRouter uses a cursor (`after`), not
/// offsets, and accepts repeated `status` query parameters.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct BatchListQuery {
    pub limit: Option<usize>,
    pub after: Option<String>,
    #[serde(default)]
    pub status: Vec<String>,
    pub created_after: Option<String>,
    pub created_before: Option<String>,
}

/// Safe upstream error metadata for a batch operation.
#[derive(Debug, Clone)]
pub struct BatchProviderError {
    pub status: u16,
    pub message: String,
    pub retry_after: Option<String>,
}

/// Capability for providers that support asynchronous batch operations.
pub trait BatchProvider: Send + Sync {
    fn create_batch<'a>(
        &'a self,
        request: &'a BatchCreateRequest,
    ) -> Pin<Box<dyn Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>;

    fn list_batches<'a>(
        &'a self,
        query: &'a BatchListQuery,
    ) -> Pin<Box<dyn Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>;

    fn get_batch<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>;

    fn delete_batch<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>;
}
