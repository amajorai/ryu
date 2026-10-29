//! Pluggable vector stores for Ryu.
//!
//! One [`VectorStore`] trait — `ensure_collection`, `upsert`, `query` (with an
//! optional [`MetadataFilter`]) and `delete` — and one implementation per backend:
//!
//! | Provider | Module | Transport |
//! | --- | --- | --- |
//! | `sqlite-vec` (default) | [`sqlite_vec`] | in-process SQLite + sqlite-vec distance functions |
//! | `qdrant` | [`qdrant`] | Qdrant REST API |
//! | `chroma` | [`chroma`] | Chroma REST API v2 |
//! | `pinecone` | [`pinecone`] | Pinecone control + data plane REST |
//! | `weaviate` | [`weaviate`] | Weaviate REST (schema, batch) + GraphQL (`nearVector`) |
//! | `milvus` | [`milvus`] | Milvus RESTful API v2 |
//! | `pgvector` | [`pgvector`] | Postgres wire protocol (`tokio-postgres`) |
//!
//! The crate takes plain, already-resolved config ([`VectorStoreConfig`]): the
//! data-dir path of the local store, the endpoint URL and the *resolved* credential
//! are Core's job (`apps/core/src/rag_host.rs`), so this crate has no dependency on
//! the model registry, the secret store, or the data-dir layout.
//!
//! # Conventions every backend honours
//!
//! - **Ids are opaque strings.** Backends that only accept UUID/integer point ids
//!   (Qdrant, Weaviate) derive a stable UUID from the string ([`derive_uuid`]) and
//!   keep the original in the payload, so callers never see the difference.
//! - **Scores are similarities: higher is better.** Distances are converted per
//!   metric (`cosine`: `1 - distance`; `euclidean`: `-distance`; `dot`: the inner
//!   product), so a caller can sort any backend's matches the same way.
//! - **Metadata is a flat JSON object.** Filters address top-level keys only, and a
//!   key must be a plain identifier ([`validate_field_name`]) because several
//!   backends splice it into an expression language (Milvus, Weaviate, SQL).
//! - **Collection names are validated** ([`validate_collection_name`]) before they
//!   reach a URL path or an SQL identifier.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod chroma;
mod http;
pub mod milvus;
pub mod pgvector;
pub mod pinecone;
pub mod qdrant;
pub mod sqlite_vec;
pub mod weaviate;

/// Default payload/property key that holds a record's text.
pub const DEFAULT_TEXT_KEY: &str = "document";

/// A vector store backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VectorStoreProvider {
    /// Local SQLite file with sqlite-vec distance functions (the default).
    SqliteVec,
    Qdrant,
    Chroma,
    Pinecone,
    Weaviate,
    Milvus,
    Pgvector,
}

impl VectorStoreProvider {
    /// Every provider, in documentation order.
    pub const ALL: [Self; 7] = [
        Self::SqliteVec,
        Self::Qdrant,
        Self::Chroma,
        Self::Pinecone,
        Self::Weaviate,
        Self::Milvus,
        Self::Pgvector,
    ];

    /// The canonical config id (`sqlite-vec`, `qdrant`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SqliteVec => "sqlite-vec",
            Self::Qdrant => "qdrant",
            Self::Chroma => "chroma",
            Self::Pinecone => "pinecone",
            Self::Weaviate => "weaviate",
            Self::Milvus => "milvus",
            Self::Pgvector => "pgvector",
        }
    }

    /// `true` for backends reached over the network (everything but sqlite-vec).
    pub fn is_remote(self) -> bool {
        !matches!(self, Self::SqliteVec)
    }
}

impl fmt::Display for VectorStoreProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for VectorStoreProvider {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
        Ok(match normalized.as_str() {
            "sqlite-vec" | "sqlitevec" | "sqlite" => Self::SqliteVec,
            "qdrant" => Self::Qdrant,
            "chroma" | "chromadb" => Self::Chroma,
            "pinecone" => Self::Pinecone,
            "weaviate" => Self::Weaviate,
            "milvus" | "zilliz" => Self::Milvus,
            "pgvector" | "postgres" | "postgresql" => Self::Pgvector,
            other => bail!(
                "unknown vector store provider '{other}' (expected one of: {})",
                Self::ALL.map(Self::as_str).join(", ")
            ),
        })
    }
}

/// Similarity metric of a collection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistanceMetric {
    #[default]
    Cosine,
    Dot,
    Euclidean,
}

impl FromStr for DistanceMetric {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        Ok(match value.trim().to_ascii_lowercase().as_str() {
            "cosine" | "cos" => Self::Cosine,
            "dot" | "ip" | "inner-product" | "inner_product" => Self::Dot,
            "euclidean" | "l2" => Self::Euclidean,
            other => bail!("unknown distance metric '{other}' (expected cosine, dot or euclidean)"),
        })
    }
}

impl DistanceMetric {
    /// Convert a backend *distance* (lower is closer) into a similarity score
    /// (higher is better). For `dot` this assumes the backend reports the
    /// negative inner product as the distance (pgvector `<#>`, Weaviate `dot`).
    pub(crate) fn distance_to_score(self, distance: f32) -> f32 {
        match self {
            Self::Cosine => 1.0 - distance,
            Self::Euclidean => -distance,
            Self::Dot => -distance,
        }
    }
}

/// What a collection must look like.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSpec {
    pub name: String,
    pub dimensions: usize,
    #[serde(default)]
    pub metric: DistanceMetric,
}

/// One stored vector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorRecord {
    pub id: String,
    pub vector: Vec<f32>,
    /// The text the vector was computed from, when the caller wants it back.
    #[serde(default)]
    pub document: Option<String>,
    /// Flat metadata. Values used in filters must be strings, numbers or booleans.
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

/// A nearest-neighbour query.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorQuery {
    pub vector: Vec<f32>,
    pub top_k: usize,
    #[serde(default)]
    pub filter: Option<MetadataFilter>,
}

/// One query hit. `score` is a similarity: higher is better.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorMatch {
    pub id: String,
    pub score: f32,
    #[serde(default)]
    pub document: Option<String>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

/// A metadata filter over top-level metadata keys.
///
/// Serialized as a small tagged tree, e.g.
/// `{"and":[{"eq":{"field":"lang","value":"en"}},{"in":{"field":"tier","values":[1,2]}}]}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataFilter {
    /// `field == value`.
    Eq { field: String, value: Value },
    /// `field` equals any of `values`.
    In { field: String, values: Vec<Value> },
    /// Every child matches.
    And(Vec<MetadataFilter>),
    /// At least one child matches.
    Or(Vec<MetadataFilter>),
}

impl MetadataFilter {
    /// `field == value` shorthand.
    pub fn eq(field: impl Into<String>, value: impl Into<Value>) -> Self {
        Self::Eq {
            field: field.into(),
            value: value.into(),
        }
    }

    /// Reject filters a backend could not express faithfully: non-identifier field
    /// names, non-scalar values, empty `in`/`and`/`or` lists.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Eq { field, value } => {
                validate_field_name(field)?;
                validate_scalar(value)
            }
            Self::In { field, values } => {
                validate_field_name(field)?;
                if values.is_empty() {
                    bail!("metadata filter `in` on '{field}' needs at least one value");
                }
                values.iter().try_for_each(validate_scalar)
            }
            Self::And(children) | Self::Or(children) => {
                if children.is_empty() {
                    bail!("metadata filter `and`/`or` needs at least one child");
                }
                children.iter().try_for_each(Self::validate)
            }
        }
    }

    /// Evaluate the filter against a metadata object (used by tests and by
    /// backends that post-filter).
    pub fn matches(&self, metadata: &Map<String, Value>) -> bool {
        match self {
            Self::Eq { field, value } => metadata.get(field).is_some_and(|v| scalar_eq(v, value)),
            Self::In { field, values } => metadata
                .get(field)
                .is_some_and(|v| values.iter().any(|candidate| scalar_eq(v, candidate))),
            Self::And(children) => children.iter().all(|child| child.matches(metadata)),
            Self::Or(children) => children.iter().any(|child| child.matches(metadata)),
        }
    }
}

fn scalar_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

fn validate_scalar(value: &Value) -> Result<()> {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Ok(()),
        other => bail!("metadata filter values must be strings, numbers or booleans, got {other}"),
    }
}

/// A collection name safe for URL paths and SQL identifiers:
/// `^[A-Za-z][A-Za-z0-9_-]{0,62}$`.
pub fn validate_collection_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let valid = name.len() <= 63
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        bail!(
            "invalid collection name '{name}': use 1-63 ASCII letters, digits, '_' or '-', starting with a letter"
        );
    }
    Ok(())
}

/// A metadata key safe to splice into an expression: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
pub fn validate_field_name(field: &str) -> Result<()> {
    let mut chars = field.chars();
    let valid = field.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        bail!("invalid metadata field name '{field}': use ASCII letters, digits and '_'");
    }
    Ok(())
}

/// A stable RFC 4122 (version 5 layout) UUID derived from an opaque id, for
/// backends whose point ids must be UUIDs. An id that already *is* a UUID is
/// returned unchanged (lower-cased) so records written by other tools keep their ids.
pub fn derive_uuid(id: &str) -> String {
    if is_uuid(id) {
        return id.to_ascii_lowercase();
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("ryu-vector-store:{id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(index, c)| match index {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The store contract every backend implements.
#[async_trait::async_trait]
pub trait VectorStore: Send + Sync {
    /// Which backend this is.
    fn provider(&self) -> VectorStoreProvider;

    /// Create the collection when it does not exist; verify its dimensions when it
    /// does. Idempotent.
    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()>;

    /// Insert or replace records by id.
    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()>;

    /// Nearest neighbours of `query.vector`, best first, at most `query.top_k`.
    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>>;

    /// Delete records by id. Unknown ids are not an error.
    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()>;
}

/// Plain, resolved backend configuration.
///
/// `api_key` is the **resolved** credential value; Core resolves it from a secret
/// reference and never persists it here. `Debug` redacts it.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorStoreConfig {
    pub provider: Option<VectorStoreProvider>,
    /// Endpoint URL (HTTP backends) or Postgres connection string (pgvector).
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    /// Local database file (sqlite-vec).
    #[serde(default)]
    pub path: Option<std::path::PathBuf>,
    /// Payload/property key holding the record text (default `document`).
    #[serde(default)]
    pub text_key: Option<String>,
    /// Chroma tenant (default `default_tenant`).
    #[serde(default)]
    pub tenant: Option<String>,
    /// Chroma database (default `default_database`).
    #[serde(default)]
    pub database: Option<String>,
    /// Pinecone index name (collections map to namespaces inside it).
    #[serde(default)]
    pub index: Option<String>,
    /// Pinecone serverless cloud/region, used only to create a missing index.
    #[serde(default)]
    pub cloud: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    /// Request timeout for HTTP backends (default 30 s).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl fmt::Debug for VectorStoreConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VectorStoreConfig")
            .field("provider", &self.provider)
            .field("url", &self.url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("path", &self.path)
            .field("text_key", &self.text_key)
            .field("tenant", &self.tenant)
            .field("database", &self.database)
            .field("index", &self.index)
            .field("cloud", &self.cloud)
            .field("region", &self.region)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl VectorStoreConfig {
    /// The provider, defaulting to sqlite-vec.
    pub fn provider(&self) -> VectorStoreProvider {
        self.provider.unwrap_or(VectorStoreProvider::SqliteVec)
    }

    pub(crate) fn text_key(&self) -> Result<String> {
        let key = self
            .text_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .unwrap_or(DEFAULT_TEXT_KEY);
        validate_field_name(key)?;
        Ok(key.to_owned())
    }

    pub(crate) fn required_url(&self) -> Result<String> {
        let url = self
            .url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .with_context(|| format!("the {} vector store needs a url", self.provider()))?;
        Ok(url.trim_end_matches('/').to_owned())
    }

    pub(crate) fn api_key(&self) -> Option<String> {
        self.api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
    }
}

/// Build the configured backend. Network backends connect lazily: this never
/// performs I/O except opening the sqlite-vec file.
pub fn build(config: &VectorStoreConfig) -> Result<Arc<dyn VectorStore>> {
    Ok(match config.provider() {
        VectorStoreProvider::SqliteVec => {
            let path = config
                .path
                .clone()
                .context("the sqlite-vec vector store needs a database path")?;
            Arc::new(sqlite_vec::SqliteVecStore::open(&path)?)
        }
        VectorStoreProvider::Qdrant => Arc::new(qdrant::QdrantStore::new(config)?),
        VectorStoreProvider::Chroma => Arc::new(chroma::ChromaStore::new(config)?),
        VectorStoreProvider::Pinecone => Arc::new(pinecone::PineconeStore::new(config)?),
        VectorStoreProvider::Weaviate => Arc::new(weaviate::WeaviateStore::new(config)?),
        VectorStoreProvider::Milvus => Arc::new(milvus::MilvusStore::new(config)?),
        VectorStoreProvider::Pgvector => Arc::new(pgvector::PgvectorStore::new(config)?),
    })
}

/// Per-collection metric memory: backends that report raw distances need the
/// metric to convert them to scores. Populated by `ensure_collection`; unknown
/// collections fall back to cosine (every backend's default).
#[derive(Default)]
pub(crate) struct MetricCache(Mutex<HashMap<String, DistanceMetric>>);

impl MetricCache {
    pub(crate) fn remember(&self, collection: &str, metric: DistanceMetric) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(collection.to_owned(), metric);
        }
    }

    pub(crate) fn get(&self, collection: &str) -> DistanceMetric {
        self.0
            .lock()
            .ok()
            .and_then(|map| map.get(collection).copied())
            .unwrap_or_default()
    }
}

pub(crate) fn check_query(collection: &str, query: &VectorQuery) -> Result<()> {
    validate_collection_name(collection)?;
    if query.vector.is_empty() {
        bail!("query vector is empty");
    }
    // A NaN/inf would serialize as `null` in JSON bodies and as `NaN` in the
    // Weaviate GraphQL and pgvector text forms; reject it before any backend.
    if query.vector.iter().any(|v| !v.is_finite()) {
        bail!("query vector contains a non-finite value");
    }
    if let Some(filter) = &query.filter {
        filter.validate()?;
    }
    Ok(())
}

pub(crate) fn check_records(collection: &str, records: &[VectorRecord]) -> Result<()> {
    validate_collection_name(collection)?;
    for record in records {
        if record.id.is_empty() {
            bail!("vector record ids must not be empty");
        }
        if record.vector.is_empty() {
            bail!("vector record '{}' has an empty vector", record.id);
        }
        if record.vector.iter().any(|v| !v.is_finite()) {
            bail!("vector record '{}' contains a non-finite value", record.id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_ids_round_trip_and_accept_aliases() {
        for provider in VectorStoreProvider::ALL {
            assert_eq!(
                provider.as_str().parse::<VectorStoreProvider>().unwrap(),
                provider
            );
        }
        assert_eq!(
            "sqlite_vec".parse::<VectorStoreProvider>().unwrap(),
            VectorStoreProvider::SqliteVec
        );
        assert_eq!(
            "Postgres".parse::<VectorStoreProvider>().unwrap(),
            VectorStoreProvider::Pgvector
        );
        assert!("faiss".parse::<VectorStoreProvider>().is_err());
    }

    #[test]
    fn filter_validation_rejects_injection_and_non_scalars() {
        assert!(MetadataFilter::eq("lang", "en").validate().is_ok());
        assert!(MetadataFilter::eq("lang) or (1", "en").validate().is_err());
        assert!(MetadataFilter::eq("a.b", "en").validate().is_err());
        assert!(MetadataFilter::eq("lang", json!({"x": 1}))
            .validate()
            .is_err());
        assert!(MetadataFilter::In {
            field: "lang".into(),
            values: vec![]
        }
        .validate()
        .is_err());
        assert!(MetadataFilter::And(vec![]).validate().is_err());
    }

    #[test]
    fn filter_matches_evaluates_the_tree() {
        let meta = json!({"lang": "en", "tier": 2, "draft": false});
        let meta = meta.as_object().unwrap();
        let filter = MetadataFilter::And(vec![
            MetadataFilter::eq("lang", "en"),
            MetadataFilter::In {
                field: "tier".into(),
                values: vec![json!(1), json!(2.0)],
            },
            MetadataFilter::Or(vec![
                MetadataFilter::eq("draft", false),
                MetadataFilter::eq("missing", 1),
            ]),
        ]);
        assert!(filter.matches(meta));
        assert!(!MetadataFilter::eq("lang", "de").matches(meta));
    }

    #[test]
    fn filter_json_shape_is_stable() {
        let filter: MetadataFilter =
            serde_json::from_value(json!({"and":[{"eq":{"field":"lang","value":"en"}}]})).unwrap();
        assert_eq!(
            filter,
            MetadataFilter::And(vec![MetadataFilter::eq("lang", "en")])
        );
    }

    #[test]
    fn collection_names_are_restricted() {
        assert!(validate_collection_name("ryu_knowledge").is_ok());
        assert!(validate_collection_name("Docs-2").is_ok());
        for bad in ["", "1abc", "a/b", "a b", "a\"b", "../x", &"a".repeat(64)] {
            assert!(validate_collection_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn derived_uuids_are_stable_versioned_and_preserve_real_uuids() {
        let a = derive_uuid("memory:42");
        assert_eq!(a, derive_uuid("memory:42"));
        assert_ne!(a, derive_uuid("memory:43"));
        assert!(is_uuid(&a));
        assert_eq!(&a[14..15], "5");
        let real = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
        assert_eq!(derive_uuid(real), real.to_ascii_lowercase());
    }

    #[test]
    fn config_debug_redacts_the_credential() {
        let config = VectorStoreConfig {
            provider: Some(VectorStoreProvider::Qdrant),
            api_key: Some("sk-very-secret".into()),
            ..VectorStoreConfig::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("sk-very-secret"));
        assert!(rendered.contains("<redacted>"));
        assert!(serde_json::to_string(&config)
            .unwrap()
            .find("sk-very")
            .is_none());
    }

    #[test]
    fn distance_conversion_is_higher_is_better() {
        assert!(
            DistanceMetric::Cosine.distance_to_score(0.1)
                > DistanceMetric::Cosine.distance_to_score(0.5)
        );
        assert!(
            DistanceMetric::Euclidean.distance_to_score(1.0)
                > DistanceMetric::Euclidean.distance_to_score(2.0)
        );
    }
}
