//! Milvus (and Zilliz Cloud) over the RESTful API v2.
//!
//! - `POST /v2/vectordb/collections/has` / `.../describe` / `.../create`;
//! - `POST /v2/vectordb/entities/upsert` — rows `{id, vector, <textKey>, ...metadata}`;
//! - `POST /v2/vectordb/entities/search` — `data: [vector]`, `filter` expression;
//! - `POST /v2/vectordb/entities/delete` — `filter: id in [...]`.
//!
//! Collections are created with the quick-setup shape (VarChar primary key `id`,
//! vector field `vector`, dynamic fields enabled), so metadata keys become dynamic
//! fields that filter expressions address by name. Milvus answers HTTP 200 with a
//! non-zero `code` on failure; that is surfaced as an error. `Authorization:
//! Bearer` carries the token (`user:password` or a Zilliz API key).

use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::http::{as_f32, JsonClient};
use crate::{
    check_query, check_records, validate_collection_name, CollectionSpec, DistanceMetric,
    MetadataFilter, MetricCache, VectorMatch, VectorQuery, VectorRecord, VectorStore,
    VectorStoreConfig, VectorStoreProvider,
};

const ID_FIELD: &str = "id";
const VECTOR_FIELD: &str = "vector";
/// VarChar primary-key capacity.
const MAX_ID_LENGTH: usize = 512;

/// The Milvus backend.
pub struct MilvusStore {
    http: JsonClient,
    text_key: String,
    metrics: MetricCache,
}

impl MilvusStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let auth = config
            .api_key()
            .map(|key| ("Authorization".to_owned(), format!("Bearer {key}")));
        Ok(Self {
            http: JsonClient::new(config, config.required_url()?, auth, "milvus")?,
            text_key: config.text_key()?,
            metrics: MetricCache::default(),
        })
    }

    /// POST and unwrap Milvus' `{code, message, data}` envelope.
    async fn call(&self, path: &str, body: &Value) -> Result<Value> {
        let response = self.http.send(Method::POST, path, Some(body)).await?;
        let code = response["code"].as_i64().unwrap_or(0);
        if code != 0 {
            bail!(
                "milvus {path}: code {code}: {}",
                response["message"].as_str().unwrap_or("unknown error")
            );
        }
        Ok(response["data"].clone())
    }
}

fn metric_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "COSINE",
        DistanceMetric::Dot => "IP",
        DistanceMetric::Euclidean => "L2",
    }
}

fn parse_metric(name: &str) -> DistanceMetric {
    match name {
        "IP" => DistanceMetric::Dot,
        "L2" => DistanceMetric::Euclidean,
        _ => DistanceMetric::Cosine,
    }
}

/// A JSON scalar as a Milvus expression literal. JSON string syntax (double
/// quotes, backslash escapes) is what Milvus' expression parser accepts.
fn literal(value: &Value) -> String {
    match value {
        Value::Bool(b) => if *b { "true" } else { "false" }.to_owned(),
        other => other.to_string(),
    }
}

/// Lower a [`MetadataFilter`] into a Milvus boolean expression.
pub fn filter_expression(filter: &MetadataFilter) -> String {
    match filter {
        MetadataFilter::Eq { field, value } => format!("{field} == {}", literal(value)),
        MetadataFilter::In { field, values } => format!(
            "{field} in [{}]",
            values.iter().map(literal).collect::<Vec<_>>().join(", ")
        ),
        MetadataFilter::And(children) | MetadataFilter::Or(children) => {
            let joiner = if matches!(filter, MetadataFilter::And(_)) {
                " and "
            } else {
                " or "
            };
            format!(
                "({})",
                children
                    .iter()
                    .map(|child| format!("({})", filter_expression(child)))
                    .collect::<Vec<_>>()
                    .join(joiner)
            )
        }
    }
}

#[async_trait::async_trait]
impl VectorStore for MilvusStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Milvus
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        validate_collection_name(&spec.name)?;
        if spec.name.contains('-') {
            bail!(
                "milvus collection names may not contain '-': '{}'",
                spec.name
            );
        }
        let name = json!({"collectionName": spec.name});
        let has = self.call("/v2/vectordb/collections/has", &name).await?;
        if has["has"].as_bool().unwrap_or(false) {
            let described = self
                .call("/v2/vectordb/collections/describe", &name)
                .await?;
            let mut metric = spec.metric;
            if let Some(index) = described["indexes"].as_array().and_then(|i| i.first()) {
                if let Some(name) = index["metricType"].as_str() {
                    metric = parse_metric(name);
                }
            }
            for field in described["fields"].as_array().into_iter().flatten() {
                if field["name"] == VECTOR_FIELD {
                    let dim = field["params"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|p| p["key"] == "dim")
                        .and_then(|p| p["value"].as_str().and_then(|v| v.parse::<usize>().ok()));
                    if let Some(dim) = dim {
                        if dim != spec.dimensions {
                            bail!(
                                "milvus collection '{}' has {dim} dimensions, not {}",
                                spec.name,
                                spec.dimensions
                            );
                        }
                    }
                }
            }
            self.metrics.remember(&spec.name, metric);
            return Ok(());
        }
        let body = json!({
            "collectionName": spec.name,
            "dimension": spec.dimensions,
            "metricType": metric_name(spec.metric),
            "idType": "VarChar",
            "primaryFieldName": ID_FIELD,
            "vectorFieldName": VECTOR_FIELD,
            "params": {"max_length": MAX_ID_LENGTH, "enableDynamicField": true},
        });
        self.call("/v2/vectordb/collections/create", &body).await?;
        self.metrics.remember(&spec.name, spec.metric);
        Ok(())
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        if records.is_empty() {
            return Ok(());
        }
        let mut rows = Vec::with_capacity(records.len());
        for record in records {
            if record.id.len() > MAX_ID_LENGTH {
                bail!("milvus ids are limited to {MAX_ID_LENGTH} bytes");
            }
            let mut row = Map::new();
            for (key, value) in &record.metadata {
                if key == ID_FIELD || key == VECTOR_FIELD || *key == self.text_key {
                    bail!("metadata key '{key}' collides with a milvus field");
                }
                row.insert(key.clone(), value.clone());
            }
            row.insert(ID_FIELD.into(), Value::String(record.id.clone()));
            row.insert(VECTOR_FIELD.into(), json!(record.vector));
            if let Some(document) = &record.document {
                row.insert(self.text_key.clone(), Value::String(document.clone()));
            }
            rows.push(Value::Object(row));
        }
        self.call(
            "/v2/vectordb/entities/upsert",
            &json!({"collectionName": collection, "data": rows}),
        )
        .await?;
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let mut body = json!({
            "collectionName": collection,
            "data": [query.vector],
            "annsField": VECTOR_FIELD,
            "limit": query.top_k,
            "outputFields": ["*"],
        });
        if let Some(filter) = &query.filter {
            body["filter"] = Value::String(filter_expression(filter));
        }
        let data = self.call("/v2/vectordb/entities/search", &body).await?;
        let metric = self.metrics.get(collection);
        let hits = data
            .as_array()
            .context("milvus search response has no `data` array")?;
        hits.iter()
            .map(|hit| {
                let mut fields = hit.as_object().cloned().unwrap_or_default();
                let id = match fields.remove(ID_FIELD) {
                    Some(Value::String(s)) => s,
                    Some(Value::Number(n)) => n.to_string(),
                    _ => bail!("milvus hit has no id"),
                };
                let raw = fields
                    .remove("distance")
                    .as_ref()
                    .and_then(as_f32)
                    .context("milvus hit has no distance")?;
                fields.remove(VECTOR_FIELD);
                let document = fields
                    .remove(&self.text_key)
                    .and_then(|v| v.as_str().map(str::to_owned));
                Ok(VectorMatch {
                    id,
                    // COSINE and IP are similarities; L2 is a distance.
                    score: if metric == DistanceMetric::Euclidean {
                        -raw
                    } else {
                        raw
                    },
                    document,
                    metadata: fields,
                })
            })
            .collect()
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        validate_collection_name(collection)?;
        if ids.is_empty() {
            return Ok(());
        }
        let filter = MetadataFilter::In {
            field: ID_FIELD.into(),
            values: ids.iter().cloned().map(Value::String).collect(),
        };
        self.call(
            "/v2/vectordb/entities/delete",
            &json!({"collectionName": collection, "filter": filter_expression(&filter)}),
        )
        .await?;
        Ok(())
    }
}
