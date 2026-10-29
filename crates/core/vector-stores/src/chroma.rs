//! Chroma over its REST API v2.
//!
//! Collections live under `/api/v2/tenants/{tenant}/databases/{database}`:
//!
//! - `POST .../collections` with `get_or_create: true` — idempotent create, returns
//!   the collection `id` that every record operation is addressed by;
//! - `GET  .../collections/{name}` — resolve an existing collection's id;
//! - `POST .../collections/{id}/upsert` — `ids`/`embeddings`/`documents`/`metadatas`;
//! - `POST .../collections/{id}/query` — `query_embeddings`, `n_results`, `where`;
//! - `POST .../collections/{id}/delete` — by `ids`.
//!
//! Chroma stores documents natively and its `where` language is Mongo-style
//! (`$eq`, `$in`, `$and`, `$or`). Metadata values must be scalars, so nested
//! values are stored as their JSON text. Distances are converted to similarities
//! from the collection's `hnsw` space. The `x-chroma-token` header carries the
//! credential.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::http::{as_f32, segment, JsonClient, Probe};
use crate::{
    check_query, check_records, validate_collection_name, CollectionSpec, DistanceMetric,
    MetadataFilter, MetricCache, VectorMatch, VectorQuery, VectorRecord, VectorStore,
    VectorStoreConfig, VectorStoreProvider,
};

/// The Chroma backend.
pub struct ChromaStore {
    http: JsonClient,
    prefix: String,
    ids: Mutex<HashMap<String, String>>,
    metrics: MetricCache,
}

impl ChromaStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let tenant = config.tenant.as_deref().unwrap_or("default_tenant");
        let database = config.database.as_deref().unwrap_or("default_database");
        let auth = config
            .api_key()
            .map(|key| ("x-chroma-token".to_owned(), key));
        Ok(Self {
            http: JsonClient::new(config, config.required_url()?, auth, "chroma")?,
            prefix: format!(
                "/api/v2/tenants/{}/databases/{}/collections",
                segment(tenant),
                segment(database)
            ),
            ids: Mutex::new(HashMap::new()),
            metrics: MetricCache::default(),
        })
    }

    fn remember(&self, name: &str, body: &Value) -> Result<String> {
        let id = body["id"]
            .as_str()
            .context("chroma collection response has no `id`")?
            .to_owned();
        let space = body["configuration_json"]["hnsw"]["space"]
            .as_str()
            .or_else(|| body["configuration"]["hnsw"]["space"].as_str())
            .or_else(|| body["metadata"]["hnsw:space"].as_str());
        if let Some(space) = space {
            self.metrics.remember(name, parse_space(space));
        }
        if let Ok(mut ids) = self.ids.lock() {
            ids.insert(name.to_owned(), id.clone());
        }
        Ok(id)
    }

    /// POST `body` to `.../collections/{id}/{operation}`. A 404 means the cached
    /// id is stale (the collection was deleted and recreated, which gives it a new
    /// id): the cache entry is dropped and the id re-resolved once by name.
    async fn post_to_collection(
        &self,
        collection: &str,
        operation: &str,
        body: &Value,
    ) -> Result<Value> {
        for attempt in 0..2 {
            let id = self.collection_id(collection).await?;
            let path = format!("{}/{}/{operation}", self.prefix, segment(&id));
            match self
                .http
                .send_probe(Method::POST, &path, Some(body))
                .await?
            {
                Probe::Found(value) => return Ok(value),
                Probe::NotFound if attempt == 0 => {
                    if let Ok(mut ids) = self.ids.lock() {
                        ids.remove(collection);
                    }
                }
                Probe::NotFound => {}
            }
        }
        bail!("chroma collection '{collection}' does not exist")
    }

    async fn collection_id(&self, name: &str) -> Result<String> {
        validate_collection_name(name)?;
        if let Some(id) = self.ids.lock().ok().and_then(|ids| ids.get(name).cloned()) {
            return Ok(id);
        }
        let path = format!("{}/{}", self.prefix, segment(name));
        match self.http.send_probe(Method::GET, &path, None).await? {
            Probe::Found(body) => self.remember(name, &body),
            Probe::NotFound => bail!("chroma collection '{name}' does not exist"),
        }
    }
}

fn space_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "cosine",
        DistanceMetric::Dot => "ip",
        DistanceMetric::Euclidean => "l2",
    }
}

fn parse_space(space: &str) -> DistanceMetric {
    match space {
        "ip" => DistanceMetric::Dot,
        "l2" => DistanceMetric::Euclidean,
        _ => DistanceMetric::Cosine,
    }
}

/// Lower a [`MetadataFilter`] into a Chroma `where` document.
pub fn where_json(filter: &MetadataFilter) -> Value {
    match filter {
        MetadataFilter::Eq { field, value } => json!({ field: {"$eq": value} }),
        MetadataFilter::In { field, values } => json!({ field: {"$in": values} }),
        // Chroma requires at least two operands for `$and`/`$or`.
        MetadataFilter::And(children) | MetadataFilter::Or(children) if children.len() == 1 => {
            where_json(&children[0])
        }
        MetadataFilter::And(children) => {
            json!({"$and": children.iter().map(where_json).collect::<Vec<_>>()})
        }
        MetadataFilter::Or(children) => {
            json!({"$or": children.iter().map(where_json).collect::<Vec<_>>()})
        }
    }
}

fn flat_metadata(metadata: &Map<String, Value>) -> Value {
    if metadata.is_empty() {
        return Value::Null;
    }
    Value::Object(
        metadata
            .iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(key, value)| {
                let flat = match value {
                    Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
                    other => Value::String(other.to_string()),
                };
                (key.clone(), flat)
            })
            .collect(),
    )
}

/// `body[key][0]` — Chroma answers one row per query embedding.
fn first_row<'a>(body: &'a Value, key: &str) -> &'a [Value] {
    body[key]
        .get(0)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

#[async_trait::async_trait]
impl VectorStore for ChromaStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Chroma
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        validate_collection_name(&spec.name)?;
        let body = json!({
            "name": spec.name,
            "get_or_create": true,
            "configuration": {"hnsw": {"space": space_name(spec.metric)}},
        });
        let created = self
            .http
            .send(Method::POST, &self.prefix, Some(&body))
            .await?;
        if let Some(dimension) = created["dimension"].as_u64() {
            if usize::try_from(dimension).ok() != Some(spec.dimensions) {
                bail!(
                    "chroma collection '{}' has {dimension} dimensions, not {}",
                    spec.name,
                    spec.dimensions
                );
            }
        }
        self.metrics.remember(&spec.name, spec.metric);
        self.remember(&spec.name, &created)?;
        Ok(())
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        if records.is_empty() {
            return Ok(());
        }
        let body = json!({
            "ids": records.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            "embeddings": records.iter().map(|r| r.vector.clone()).collect::<Vec<_>>(),
            "documents": records.iter().map(|r| r.document.clone()).collect::<Vec<_>>(),
            "metadatas": records.iter().map(|r| flat_metadata(&r.metadata)).collect::<Vec<_>>(),
        });
        self.post_to_collection(collection, "upsert", &body).await?;
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let mut body = json!({
            "query_embeddings": [query.vector],
            "n_results": query.top_k,
            "include": ["documents", "metadatas", "distances"],
        });
        if let Some(filter) = &query.filter {
            body["where"] = where_json(filter);
        }
        let response = self.post_to_collection(collection, "query", &body).await?;
        let metric = self.metrics.get(collection);
        let ids = first_row(&response, "ids");
        let distances = first_row(&response, "distances");
        let documents = first_row(&response, "documents");
        let metadatas = first_row(&response, "metadatas");
        ids.iter()
            .enumerate()
            .map(|(index, id)| {
                let distance = distances
                    .get(index)
                    .and_then(as_f32)
                    .context("chroma query response is missing a distance")?;
                // Chroma's `ip` distance is `1 - dot`, so it converts like cosine.
                let score = match metric {
                    DistanceMetric::Euclidean => -distance,
                    DistanceMetric::Cosine | DistanceMetric::Dot => 1.0 - distance,
                };
                Ok(VectorMatch {
                    id: id
                        .as_str()
                        .context("chroma query response has a non-string id")?
                        .to_owned(),
                    score,
                    document: documents
                        .get(index)
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    metadata: metadatas
                        .get(index)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                })
            })
            .collect()
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return validate_collection_name(collection);
        }
        self.post_to_collection(collection, "delete", &json!({"ids": ids}))
            .await?;
        Ok(())
    }
}
