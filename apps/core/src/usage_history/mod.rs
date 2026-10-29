//! Local historical token metadata. Conversations and credentials never enter this ledger.
mod adapters;
pub(crate) mod http;
#[cfg(test)]
mod http_tests;
pub(crate) mod live;
pub(crate) mod operations;
pub(crate) mod provider_api;
mod provider_exports;
pub(crate) mod ryu_sessions;
mod scan;
mod store;
#[cfg(test)]
mod tests;

pub use scan::sources;
use serde::{Deserialize, Serialize};
pub use store::UsageHistoryStore;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cached_output_tokens: u64,
    /// Informational subset of output, already included in output_tokens.
    pub reasoning_tokens: u64,
    pub missing_input_records: u64,
    pub missing_output_records: u64,
    #[serde(default)]
    pub missing_cache_read_records: u64,
    #[serde(default)]
    pub missing_cache_write_records: u64,
    #[serde(default)]
    pub missing_cached_output_records: u64,
    #[serde(default)]
    pub missing_reasoning_records: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub scope: String,
    pub bucket_seconds: Option<u64>,
    pub request_count: Option<u64>,
    pub source_id: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub session_id: String,
    pub event_id: String,
    pub timestamp: String,
    /// Input excludes cache read/write; output includes reasoning and cached output.
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cached_output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    /// Source-reported cost may itself be a tool's estimate, never assumed billed.
    pub reported_cost_usd: Option<f64>,
    pub cost_kind: String,
    pub provenance: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySource {
    pub id: String,
    pub label: String,
    pub transport: String,
    pub available: bool,
    pub limitations: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub roots: Vec<ScanRoot>,
    pub max_files: Option<usize>,
    #[serde(default)]
    pub retry_failed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRoot {
    pub source_id: String,
    pub path: String,
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = UsageHistoryImportReport)]
pub struct ImportReport {
    pub scanned_files: u64,
    pub imported_records: u64,
    pub updated_records: u64,
    pub duplicate_records: u64,
    pub skipped_files: u64,
    pub error_count: u64,
    pub errors: Vec<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub scope: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBucket {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub date: String,
    pub source_id: String,
    pub model_id: Option<String>,
    pub totals: TokenTotals,
    pub sessions: u64,
    pub records: u64,
    pub estimated_cost_usd: Option<f64>,
    pub reported_cost_usd: Option<f64>,
    pub billed_cost_usd: Option<f64>,
    pub source_estimated_cost_usd: Option<f64>,
    pub cache_savings_usd: Option<f64>,
    pub unpriced_records: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<HistoryBucket>,
    pub totals: TokenTotals,
    pub sessions: u64,
    pub records: u64,
    pub estimated_cost_usd: Option<f64>,
    pub reported_cost_usd: Option<f64>,
    pub billed_cost_usd: Option<f64>,
    pub source_estimated_cost_usd: Option<f64>,
    pub cache_savings_usd: Option<f64>,
    pub unpriced_records: u64,
    pub daily: Vec<HistoryBucket>,
    pub models: Vec<HistoryBucket>,
    pub sources: Vec<HistoryBucket>,
}

#[derive(Clone, Debug, Default)]
pub struct ModelRates {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}
