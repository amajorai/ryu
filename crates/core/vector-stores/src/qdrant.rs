//! Qdrant over its REST API.
//!
//! - `GET  /collections/{name}` — existence + dimension check;
//! - `PUT  /collections/{name}` — create (`vectors: {size, distance}`);
//! - `PUT  /collections/{name}/points?wait=true` — upsert;
//! - `POST /collections/{name}/points/search` — KNN with a `filter`;
//! - `POST /collections/{name}/points/delete?wait=true` — delete by point id.
//!
//! Qdrant point ids must be UUIDs or unsigned integers, so string ids are mapped
//! through [`crate::derive_uuid`] and the original id is kept in the payload under
//! `ryu_id`. The payload layout is `{<textKey>: text, "metadata": {...}}` — the
//! same shape LangChain's Qdrant integration writes (with `textKey: page_content`),
//! so an existing LangChain collection can be queried as-is. Filters address
//! `metadata.<field>`. The `api-key` header carries the credential.

use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::http::{as_f32, segment, JsonClient, Probe};
use crate::{
    check_query, check_records, derive_uuid, validate_collection_name, CollectionSpec,
    DistanceMetric, MetadataFilter, MetricCache, VectorMatch, VectorQuery, VectorRecord,
    VectorStore, VectorStoreConfig, VectorStoreProvider,
};

/// Payload key holding the caller's original (pre-UUID) id.
const ID_KEY: &str = "ryu_id";

/// The Qdrant backend.
pub struct QdrantStore {
    http: JsonClient,
    text_key: String,
    metrics: MetricCache,
}

impl QdrantStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let auth = config.api_key().map(|key| ("api-key".to_owned(), key));
        Ok(Self {
            http: JsonClient::new(config, config.required_url()?, auth, "qdrant")?,
            text_key: config.text_key()?,
            metrics: MetricCache::default(),
        })
    }
}

fn distance_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "Cosine",
        DistanceMetric::Dot => "Dot",
        DistanceMetric::Euclidean => "Euclid",
    }
}

fn parse_distance(name: &str) -> DistanceMetric {
    match name {
        "Dot" => DistanceMetric::Dot,
        "Euclid" | "Manhattan" => DistanceMetric::Euclidean,
        _ => DistanceMetric::Cosine,
    }
}

/// Lower a [`MetadataFilter`] into Qdrant's `must`/`should` filter object.
pub fn filter_json(filter: &MetadataFilter) -> Value {
    match filter {
        MetadataFilter::Eq { field, value } => {
            json!({"must": [{"key": format!("metadata.{field}"), "match": {"value": value}}]})
        }
        MetadataFilter::In { field, values } => {
            json!({"must": [{"key": format!("metadata.{field}"), "match": {"any": values}}]})
        }
        MetadataFilter::And(children) => {
            json!({"must": children.iter().map(filter_json).collect::<Vec<_>>()})
        }
        MetadataFilter::Or(children) => {
            json!({"should": children.iter().map(filter_json).collect::<Vec<_>>()})
        }
    }
}

#[async_trait::async_trait]
impl VectorStore for QdrantStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Qdrant
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        validate_collection_name(&spec.name)?;
        let path = format!("/collections/{}", segment(&spec.name));
        match self.http.send_probe(Method::GET, &path, None).await? {
            Probe::Found(body) => {
                let vectors = &body["result"]["config"]["params"]["vectors"];
                if let Some(size) = vectors["size"].as_u64() {
                    if usize::try_from(size).ok() != Some(spec.dimensions) {
                        bail!(
                            "qdrant collection '{}' has {size} dimensions, not {}",
                            spec.name,
                            spec.dimensions
                        );
                    }
                }
                let metric = vectors["distance"]
                    .as_str()
                    .map_or(spec.metric, parse_distance);
                self.metrics.remember(&spec.name, metric);
            }
            Probe::NotFound => {
                let body = json!({
                    "vectors": {"size": spec.dimensions, "distance": distance_name(spec.metric)}
                });
                self.http.send(Method::PUT, &path, Some(&body)).await?;
                self.metrics.remember(&spec.name, spec.metric);
            }
        }
        Ok(())
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        if records.is_empty() {
            return Ok(());
        }
        let points: Vec<Value> = records
            .iter()
            .map(|record| {
                let mut payload = Map::new();
                payload.insert(ID_KEY.into(), Value::String(record.id.clone()));
                if let Some(document) = &record.document {
                    payload.insert(self.text_key.clone(), Value::String(document.clone()));
                }
                payload.insert("metadata".into(), Value::Object(record.metadata.clone()));
                json!({"id": derive_uuid(&record.id), "vector": record.vector, "payload": payload})
            })
            .collect();
        self.http
            .send(
                Method::PUT,
                &format!("/collections/{}/points?wait=true", segment(collection)),
                Some(&json!({"points": points})),
            )
            .await?;
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let mut body = json!({
            "vector": query.vector,
            "limit": query.top_k,
            "with_payload": true,
        });
        if let Some(filter) = &query.filter {
            body["filter"] = filter_json(filter);
        }
        let response = self
            .http
            .send(
                Method::POST,
                &format!("/collections/{}/points/search", segment(collection)),
                Some(&body),
            )
            .await?;
        let metric = self.metrics.get(collection);
        let hits = response["result"]
            .as_array()
            .context("qdrant search response has no `result` array")?;
        hits.iter()
            .map(|hit| {
                let payload = hit["payload"].as_object().cloned().unwrap_or_default();
                let id = payload
                    .get(ID_KEY)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| match &hit["id"] {
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })
                    .context("qdrant hit has no id")?;
                let raw = as_f32(&hit["score"]).context("qdrant hit has no score")?;
                // Qdrant reports similarity for Cosine/Dot and distance for Euclid.
                let score = if metric == DistanceMetric::Euclidean {
                    -raw
                } else {
                    raw
                };
                Ok(VectorMatch {
                    id,
                    score,
                    document: payload
                        .get(&self.text_key)
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    metadata: payload
                        .get("metadata")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                })
            })
            .collect()
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        validate_collection_name(collection)?;
        if ids.is_empty() {
            return Ok(());
        }
        let points: Vec<String> = ids.iter().map(|id| derive_uuid(id)).collect();
        self.http
            .send(
                Method::POST,
                &format!(
                    "/collections/{}/points/delete?wait=true",
                    segment(collection)
                ),
                Some(&json!({"points": points})),
            )
            .await?;
        Ok(())
    }
}
