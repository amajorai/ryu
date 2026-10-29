//! Weaviate over its REST (schema, batch, objects) and GraphQL (`nearVector`) APIs.
//!
//! A collection maps to a Weaviate **class** whose name is the collection name
//! with its first letter upper-cased (Weaviate requires that). Objects are stored
//! with caller-supplied vectors (`vectorizer: none`):
//!
//! - `GET  /v1/schema/{Class}` / `POST /v1/schema` — existence + create;
//! - `POST /v1/batch/objects` — upsert (an object with an existing id is replaced);
//! - `POST /v1/graphql` — `Get { Class(nearVector, limit, where) }`;
//! - `DELETE /v1/objects/{Class}/{uuid}` — delete (404 is not an error).
//!
//! Each object carries `ryuId` (the original id; object ids are
//! [`crate::derive_uuid`]s), the text under `textKey`, `ryuMetadata` (the
//! metadata as JSON text, so it round-trips exactly), and every scalar metadata
//! key as its own property so `where` filters can address it. `Authorization:
//! Bearer` carries the credential.
//!
//! A class Ryu did not create (for example one LangChain wrote) is queried as-is:
//! `ensure_collection` reads its schema, requires the configured `textKey`
//! property, and the `Get` query selects `ryuId`/`ryuMetadata` only when the
//! class has them (GraphQL rejects a query for an unknown field). Hits from such
//! a class are identified by their object id and carry no metadata.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::http::{as_f32, segment, JsonClient, Probe};
use crate::{
    check_query, check_records, derive_uuid, validate_collection_name, CollectionSpec,
    DistanceMetric, MetadataFilter, MetricCache, VectorMatch, VectorQuery, VectorRecord,
    VectorStore, VectorStoreConfig, VectorStoreProvider,
};

const ID_PROPERTY: &str = "ryuId";
const METADATA_PROPERTY: &str = "ryuMetadata";

/// The Weaviate backend.
pub struct WeaviateStore {
    http: JsonClient,
    text_key: String,
    metrics: MetricCache,
    /// Per-class: does it have the `ryuId` / `ryuMetadata` properties? Learnt
    /// from the schema in `ensure_collection`; unknown classes assume both.
    shapes: Mutex<HashMap<String, ClassShape>>,
}

/// Which of Ryu's bookkeeping properties a class has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassShape {
    pub has_id: bool,
    pub has_metadata: bool,
}

impl Default for ClassShape {
    fn default() -> Self {
        Self {
            has_id: true,
            has_metadata: true,
        }
    }
}

impl WeaviateStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let auth = config
            .api_key()
            .map(|key| ("Authorization".to_owned(), format!("Bearer {key}")));
        Ok(Self {
            http: JsonClient::new(config, config.required_url()?, auth, "weaviate")?,
            text_key: config.text_key()?,
            metrics: MetricCache::default(),
            shapes: Mutex::new(HashMap::new()),
        })
    }

    fn shape(&self, class: &str) -> ClassShape {
        self.shapes
            .lock()
            .ok()
            .and_then(|shapes| shapes.get(class).copied())
            .unwrap_or_default()
    }

    fn remember_shape(&self, class: &str, shape: ClassShape) {
        if let Ok(mut shapes) = self.shapes.lock() {
            shapes.insert(class.to_owned(), shape);
        }
    }
}

/// The Weaviate class name for a collection: `-` is not legal in a class name,
/// so it becomes `_`, and the first letter is upper-cased.
pub fn class_name(collection: &str) -> Result<String> {
    validate_collection_name(collection)?;
    let replaced = collection.replace('-', "_");
    let mut chars = replaced.chars();
    let first = chars.next().context("empty collection name")?;
    Ok(first.to_ascii_uppercase().to_string() + chars.as_str())
}

fn distance_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "cosine",
        DistanceMetric::Dot => "dot",
        DistanceMetric::Euclidean => "l2-squared",
    }
}

fn parse_distance(name: &str) -> DistanceMetric {
    match name {
        "dot" => DistanceMetric::Dot,
        "l2-squared" | "manhattan" | "hamming" => DistanceMetric::Euclidean,
        _ => DistanceMetric::Cosine,
    }
}

/// A JSON scalar as a GraphQL literal (JSON string syntax is valid GraphQL).
fn graphql_literal(value: &Value) -> String {
    value.to_string()
}

fn value_field(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "valueBoolean",
        // Auto-schema types every JSON number as `number`, which `valueInt`
        // would not match.
        Value::Number(_) => "valueNumber",
        _ => "valueText",
    }
}

fn equal_clause(field: &str, value: &Value) -> String {
    format!(
        "{{path: [{}], operator: Equal, {}: {}}}",
        graphql_literal(&Value::String(field.to_owned())),
        value_field(value),
        graphql_literal(value)
    )
}

/// Lower a [`MetadataFilter`] into a GraphQL `where` argument. Field names are
/// validated identifiers and every value is rendered as an escaped literal.
pub fn where_graphql(filter: &MetadataFilter) -> String {
    match filter {
        MetadataFilter::Eq { field, value } => equal_clause(field, value),
        MetadataFilter::In { field, values } => format!(
            "{{operator: Or, operands: [{}]}}",
            values
                .iter()
                .map(|value| equal_clause(field, value))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        MetadataFilter::And(children) | MetadataFilter::Or(children) => format!(
            "{{operator: {}, operands: [{}]}}",
            if matches!(filter, MetadataFilter::And(_)) {
                "And"
            } else {
                "Or"
            },
            children
                .iter()
                .map(where_graphql)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Build the `Get` query for a nearest-neighbour search on a class Ryu created.
pub fn near_vector_query(class: &str, text_key: &str, query: &VectorQuery) -> String {
    near_vector_query_for(class, text_key, ClassShape::default(), query)
}

/// Build the `Get` query, selecting only the bookkeeping properties `shape` has.
pub fn near_vector_query_for(
    class: &str,
    text_key: &str,
    shape: ClassShape,
    query: &VectorQuery,
) -> String {
    let vector = query
        .vector
        .iter()
        .map(|v| format!("{v:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let where_arg = query
        .filter
        .as_ref()
        .map(|filter| format!(", where: {}", where_graphql(filter)))
        .unwrap_or_default();
    let mut fields = Vec::with_capacity(3);
    if shape.has_id {
        fields.push(ID_PROPERTY);
    }
    fields.push(text_key);
    if shape.has_metadata {
        fields.push(METADATA_PROPERTY);
    }
    format!(
        "{{ Get {{ {class}(nearVector: {{vector: [{vector}]}}, limit: {limit}{where_arg}) \
         {{ {fields} _additional {{ id distance }} }} }} }}",
        fields = fields.join(" "),
        limit = query.top_k,
    )
}

#[async_trait::async_trait]
impl VectorStore for WeaviateStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Weaviate
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        let class = class_name(&spec.name)?;
        match self
            .http
            .send_probe(
                Method::GET,
                &format!("/v1/schema/{}", segment(&class)),
                None,
            )
            .await?
        {
            Probe::Found(body) => {
                let properties: Vec<&str> = body["properties"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|property| property["name"].as_str())
                    .collect();
                if !properties.contains(&self.text_key.as_str()) {
                    bail!(
                        "weaviate class '{class}' has no '{}' property; set the vector store \
                         text field to the property that holds each object's text",
                        self.text_key
                    );
                }
                self.remember_shape(
                    &class,
                    ClassShape {
                        has_id: properties.contains(&ID_PROPERTY),
                        has_metadata: properties.contains(&METADATA_PROPERTY),
                    },
                );
                let metric = body["vectorIndexConfig"]["distance"]
                    .as_str()
                    .map_or(spec.metric, parse_distance);
                self.metrics.remember(&spec.name, metric);
            }
            Probe::NotFound => {
                let body = json!({
                    "class": class,
                    "vectorizer": "none",
                    "vectorIndexConfig": {"distance": distance_name(spec.metric)},
                    "properties": [
                        {"name": ID_PROPERTY, "dataType": ["text"]},
                        {"name": self.text_key, "dataType": ["text"]},
                        {"name": METADATA_PROPERTY, "dataType": ["text"]},
                    ],
                });
                self.http
                    .send(Method::POST, "/v1/schema", Some(&body))
                    .await?;
                self.remember_shape(&class, ClassShape::default());
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
        let class = class_name(collection)?;
        let reserved = [ID_PROPERTY, METADATA_PROPERTY, self.text_key.as_str()];
        let objects: Vec<Value> = records
            .iter()
            .map(|record| {
                let mut properties = Map::new();
                for (key, value) in &record.metadata {
                    let filterable =
                        matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_));
                    if filterable && !reserved.contains(&key.as_str()) {
                        properties.insert(key.clone(), value.clone());
                    }
                }
                properties.insert(ID_PROPERTY.into(), Value::String(record.id.clone()));
                properties.insert(
                    METADATA_PROPERTY.into(),
                    Value::String(Value::Object(record.metadata.clone()).to_string()),
                );
                if let Some(document) = &record.document {
                    properties.insert(self.text_key.clone(), Value::String(document.clone()));
                }
                json!({
                    "class": class,
                    "id": derive_uuid(&record.id),
                    "vector": record.vector,
                    "properties": properties,
                })
            })
            .collect();
        let response = self
            .http
            .send(
                Method::POST,
                "/v1/batch/objects",
                Some(&json!({"objects": objects})),
            )
            .await?;
        // Batch answers 200 with per-object errors.
        if let Some(results) = response.as_array() {
            for result in results {
                if let Some(errors) = result["result"]["errors"]["error"].as_array() {
                    if let Some(first) = errors.first() {
                        bail!(
                            "weaviate rejected object {}: {}",
                            result["id"].as_str().unwrap_or("?"),
                            first["message"].as_str().unwrap_or("unknown error")
                        );
                    }
                }
            }
        }
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let class = class_name(collection)?;
        let graphql = near_vector_query_for(&class, &self.text_key, self.shape(&class), query);
        let response = self
            .http
            .send(
                Method::POST,
                "/v1/graphql",
                Some(&json!({"query": graphql})),
            )
            .await?;
        if let Some(error) = response["errors"].as_array().and_then(|e| e.first()) {
            bail!(
                "weaviate graphql error: {}",
                error["message"].as_str().unwrap_or("unknown error")
            );
        }
        let metric = self.metrics.get(collection);
        let hits = response["data"]["Get"][&class]
            .as_array()
            .context("weaviate graphql response has no results array")?;
        hits.iter()
            .map(|hit| {
                let distance = as_f32(&hit["_additional"]["distance"])
                    .context("weaviate hit has no distance")?;
                let id = hit[ID_PROPERTY]
                    .as_str()
                    .or_else(|| hit["_additional"]["id"].as_str())
                    .context("weaviate hit has no id")?
                    .to_owned();
                let metadata = hit[METADATA_PROPERTY]
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                Ok(VectorMatch {
                    id,
                    // cosine distance is `1 - cos`; `dot` distance is `-dot`;
                    // `l2-squared` is a distance.
                    score: metric.distance_to_score(distance),
                    document: hit[&self.text_key].as_str().map(str::to_owned),
                    metadata,
                })
            })
            .collect()
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        let class = class_name(collection)?;
        for id in ids {
            let path = format!(
                "/v1/objects/{}/{}",
                segment(&class),
                segment(&derive_uuid(id))
            );
            // A missing object is already deleted.
            self.http.send_probe(Method::DELETE, &path, None).await?;
        }
        Ok(())
    }
}
