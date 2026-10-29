//! Pinecone over its control-plane and data-plane REST APIs.
//!
//! A Ryu *collection* maps to a Pinecone **namespace** inside one configured index
//! (`index`), because Pinecone indexes are heavyweight, billed resources while
//! namespaces are free partitions — the layout Pinecone itself recommends for
//! multi-tenant data.
//!
//! - control plane (`url`, default `https://api.pinecone.io`):
//!   `GET /indexes/{index}` (describe → data-plane `host`, `dimension`, `metric`),
//!   `POST /indexes` (create a serverless index when `cloud`+`region` are set);
//! - data plane (`https://{host}`): `POST /vectors/upsert`, `POST /query`,
//!   `POST /vectors/delete`, each with a `namespace`.
//!
//! The record text is stored in metadata under `textKey` (LangChain's Pinecone
//! integration uses `text`). Pinecone's filter language is Mongo-style (`$eq`,
//! `$in`, `$and`, `$or`). `Api-Key` carries the credential and every request pins
//! `X-Pinecone-API-Version`.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;

use crate::http::{as_f32, segment, JsonClient, Probe};
use crate::{
    check_query, check_records, validate_collection_name, CollectionSpec, DistanceMetric,
    MetadataFilter, VectorMatch, VectorQuery, VectorRecord, VectorStore, VectorStoreConfig,
    VectorStoreProvider,
};

/// Default control-plane endpoint.
pub const DEFAULT_CONTROL_URL: &str = "https://api.pinecone.io";
/// Pinned REST API version.
pub const API_VERSION: &str = "2025-01";
/// How long `ensure_collection` waits for a freshly created index to become ready.
const READY_POLLS: u32 = 60;
const READY_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The Pinecone backend.
pub struct PineconeStore {
    control: JsonClient,
    index: String,
    text_key: String,
    cloud: Option<String>,
    region: Option<String>,
    data: OnceCell<(JsonClient, DistanceMetric)>,
}

impl PineconeStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let index = config
            .index
            .as_deref()
            .map(str::trim)
            .filter(|i| !i.is_empty())
            .context("the pinecone vector store needs an `index`")?
            .to_owned();
        validate_collection_name(&index)?;
        let url = config
            .url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .unwrap_or(DEFAULT_CONTROL_URL)
            .trim_end_matches('/')
            .to_owned();
        let key = config
            .api_key()
            .context("the pinecone vector store needs an API key credential")?;
        Ok(Self {
            control: JsonClient::new_with_headers(
                config,
                url,
                vec![
                    ("Api-Key".to_owned(), key),
                    ("X-Pinecone-API-Version".to_owned(), API_VERSION.to_owned()),
                ],
                "pinecone",
            )?,
            index,
            text_key: config.text_key()?,
            cloud: config.cloud.clone(),
            region: config.region.clone(),
            data: OnceCell::new(),
        })
    }

    async fn describe(&self) -> Result<Option<Value>> {
        match self
            .control
            .send_probe(
                Method::GET,
                &format!("/indexes/{}", segment(&self.index)),
                None,
            )
            .await?
        {
            Probe::Found(body) => Ok(Some(body)),
            Probe::NotFound => Ok(None),
        }
    }

    /// The data-plane client for the index, resolved once from `describe`.
    async fn data_plane(&self) -> Result<&(JsonClient, DistanceMetric)> {
        self.data
            .get_or_try_init(|| async {
                let body = self
                    .describe()
                    .await?
                    .with_context(|| format!("pinecone index '{}' does not exist", self.index))?;
                self.data_plane_from(&body)
            })
            .await
    }

    fn data_plane_from(&self, body: &Value) -> Result<(JsonClient, DistanceMetric)> {
        let host = body["host"]
            .as_str()
            .filter(|h| !h.is_empty())
            .context("pinecone describe_index response has no `host`")?;
        let base = if host.starts_with("http://") || host.starts_with("https://") {
            host.trim_end_matches('/').to_owned()
        } else {
            format!("https://{host}")
        };
        let metric = match body["metric"].as_str() {
            Some("dotproduct") => DistanceMetric::Dot,
            Some("euclidean") => DistanceMetric::Euclidean,
            _ => DistanceMetric::Cosine,
        };
        Ok((self.control.with_base_url(base), metric))
    }
}

fn metric_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "cosine",
        DistanceMetric::Dot => "dotproduct",
        DistanceMetric::Euclidean => "euclidean",
    }
}

/// Lower a [`MetadataFilter`] into Pinecone's filter document.
pub fn filter_json(filter: &MetadataFilter) -> Value {
    match filter {
        MetadataFilter::Eq { field, value } => json!({ field: {"$eq": value} }),
        MetadataFilter::In { field, values } => json!({ field: {"$in": values} }),
        MetadataFilter::And(children) => {
            json!({"$and": children.iter().map(filter_json).collect::<Vec<_>>()})
        }
        MetadataFilter::Or(children) => {
            json!({"$or": children.iter().map(filter_json).collect::<Vec<_>>()})
        }
    }
}

fn ready(body: &Value) -> bool {
    body["status"]["ready"].as_bool().unwrap_or(false)
}

#[async_trait::async_trait]
impl VectorStore for PineconeStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Pinecone
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        // The collection is a namespace (created implicitly by the first upsert);
        // what must exist is the index, with matching dimensions.
        validate_collection_name(&spec.name)?;
        let mut body = match self.describe().await? {
            Some(body) => body,
            None => {
                let (Some(cloud), Some(region)) = (&self.cloud, &self.region) else {
                    bail!(
                        "pinecone index '{}' does not exist; create it or set `cloud` and `region` so Ryu can",
                        self.index
                    );
                };
                let create = json!({
                    "name": self.index,
                    "dimension": spec.dimensions,
                    "metric": metric_name(spec.metric),
                    "spec": {"serverless": {"cloud": cloud, "region": region}},
                });
                self.control
                    .send(Method::POST, "/indexes", Some(&create))
                    .await?
            }
        };
        let mut polls = 0;
        while !ready(&body) {
            polls += 1;
            if polls > READY_POLLS {
                bail!("pinecone index '{}' did not become ready", self.index);
            }
            tokio::time::sleep(READY_POLL_INTERVAL).await;
            body = self
                .describe()
                .await?
                .with_context(|| format!("pinecone index '{}' disappeared", self.index))?;
        }
        if let Some(dimension) = body["dimension"].as_u64() {
            if usize::try_from(dimension).ok() != Some(spec.dimensions) {
                bail!(
                    "pinecone index '{}' has {dimension} dimensions, not {}",
                    self.index,
                    spec.dimensions
                );
            }
        }
        let plane = self.data_plane_from(&body)?;
        // A concurrent caller may have initialised it first; either value is the
        // same index.
        let _ = self.data.set(plane);
        Ok(())
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        if records.is_empty() {
            return Ok(());
        }
        let (data, _) = self.data_plane().await?;
        let vectors: Vec<Value> = records
            .iter()
            .map(|record| {
                let mut metadata: Map<String, Value> = record
                    .metadata
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                if let Some(document) = &record.document {
                    metadata.insert(self.text_key.clone(), Value::String(document.clone()));
                }
                json!({"id": record.id, "values": record.vector, "metadata": metadata})
            })
            .collect();
        data.send(
            Method::POST,
            "/vectors/upsert",
            Some(&json!({"vectors": vectors, "namespace": collection})),
        )
        .await?;
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let (data, metric) = self.data_plane().await?;
        let mut body = json!({
            "vector": query.vector,
            "topK": query.top_k,
            "namespace": collection,
            "includeMetadata": true,
            "includeValues": false,
        });
        if let Some(filter) = &query.filter {
            body["filter"] = filter_json(filter);
        }
        let response = data.send(Method::POST, "/query", Some(&body)).await?;
        let matches = response["matches"]
            .as_array()
            .context("pinecone query response has no `matches` array")?;
        matches
            .iter()
            .map(|hit| {
                let mut metadata = hit["metadata"].as_object().cloned().unwrap_or_default();
                let document = metadata
                    .remove(&self.text_key)
                    .and_then(|v| v.as_str().map(str::to_owned));
                let raw = as_f32(&hit["score"]).context("pinecone match has no score")?;
                Ok(VectorMatch {
                    id: hit["id"]
                        .as_str()
                        .context("pinecone match has no id")?
                        .to_owned(),
                    // Pinecone reports similarity for cosine/dotproduct and the
                    // distance for euclidean.
                    score: if *metric == DistanceMetric::Euclidean {
                        -raw
                    } else {
                        raw
                    },
                    document,
                    metadata,
                })
            })
            .collect()
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        validate_collection_name(collection)?;
        if ids.is_empty() {
            return Ok(());
        }
        let (data, _) = self.data_plane().await?;
        data.send(
            Method::POST,
            "/vectors/delete",
            Some(&json!({"ids": ids, "namespace": collection})),
        )
        .await?;
        Ok(())
    }
}
