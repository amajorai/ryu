//! Postgres + the `pgvector` extension over the Postgres wire protocol.
//!
//! Each collection is one table:
//!
//! ```sql
//! CREATE TABLE "<collection>" (
//!     id        TEXT PRIMARY KEY,
//!     embedding vector(<dims>) NOT NULL,
//!     document  TEXT,
//!     metadata  JSONB NOT NULL DEFAULT '{}'
//! );
//! CREATE INDEX "<collection>_embedding_hnsw" ON "<collection>" USING hnsw (embedding <ops>);
//! ```
//!
//! Vectors cross the wire as pgvector's text form (`'[1,2,3]'::text::vector`) so
//! no pgvector-specific client type is needed. Metadata filters compare
//! `metadata->>'field'` against text parameters (`jsonb ->>` renders numbers and
//! booleans as text, so `1` matches `"1"` — documented, and symmetric for every
//! value type). The connection string is the `url`; `sslmode=require` (or
//! `verify-ca`/`verify-full`) switches to TLS through the platform TLS stack, which
//! verifies the certificate chain and host name. A resolved credential, when
//! present, is used as the password. A connection the server closed is reopened
//! on the next call.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, Config};

use crate::{
    check_query, check_records, validate_collection_name, CollectionSpec, DistanceMetric,
    MetadataFilter, MetricCache, VectorMatch, VectorQuery, VectorRecord, VectorStore,
    VectorStoreConfig, VectorStoreProvider,
};

/// The pgvector backend.
pub struct PgvectorStore {
    config: Config,
    tls: bool,
    /// The live connection. Replaced when the server closes it (restart,
    /// failover, idle timeout), so one dropped connection does not fail every
    /// later call until Core restarts.
    client: Mutex<Option<Arc<Client>>>,
    metrics: MetricCache,
}

/// Map libpq's certificate-verifying modes onto tokio-postgres, which only
/// parses `disable`/`prefer`/`require`. The TLS connector verifies the chain and
/// the host name by default, which is what `verify-full` asks for (and stricter
/// than `verify-ca`).
fn normalize_sslmode(url: &str) -> String {
    url.replace("sslmode=verify-full", "sslmode=require")
        .replace("sslmode=verify-ca", "sslmode=require")
}

impl PgvectorStore {
    pub fn new(config: &VectorStoreConfig) -> Result<Self> {
        let url = normalize_sslmode(&config.required_url()?);
        let mut pg: Config = url
            .parse()
            .context("the pgvector url is not a valid Postgres connection string")?;
        if let Some(password) = config.api_key() {
            pg.password(password);
        }
        let tls = matches!(pg.get_ssl_mode(), tokio_postgres::config::SslMode::Require);
        Ok(Self {
            config: pg,
            tls,
            client: Mutex::new(None),
            metrics: MetricCache::default(),
        })
    }

    async fn client(&self) -> Result<Arc<Client>> {
        let mut slot = self.client.lock().await;
        if let Some(client) = slot.as_ref().filter(|client| !client.is_closed()) {
            return Ok(Arc::clone(client));
        }
        let client = Arc::new(self.connect().await?);
        *slot = Some(Arc::clone(&client));
        Ok(client)
    }

    async fn connect(&self) -> Result<Client> {
        let client = if self.tls {
            let connector =
                native_tls::TlsConnector::new().context("building the Postgres TLS connector")?;
            let (client, connection) = self
                .config
                .connect(postgres_native_tls::MakeTlsConnector::new(connector))
                .await
                .context("connecting to Postgres")?;
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    tracing::warn!("pgvector connection closed: {error}");
                }
            });
            client
        } else {
            let (client, connection) = self
                .config
                .connect(tokio_postgres::NoTls)
                .await
                .context("connecting to Postgres")?;
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    tracing::warn!("pgvector connection closed: {error}");
                }
            });
            client
        };
        Ok(client)
    }
}

/// `"name"` — collection names are validated, quoting keeps `-` legal.
fn table(collection: &str) -> String {
    format!("\"{collection}\"")
}

fn operator(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "<=>",
        DistanceMetric::Dot => "<#>",
        DistanceMetric::Euclidean => "<->",
    }
}

fn opclass(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "vector_cosine_ops",
        DistanceMetric::Dot => "vector_ip_ops",
        DistanceMetric::Euclidean => "vector_l2_ops",
    }
}

fn parse_opclass(definition: &str) -> Option<DistanceMetric> {
    if definition.contains("vector_ip_ops") {
        Some(DistanceMetric::Dot)
    } else if definition.contains("vector_l2_ops") {
        Some(DistanceMetric::Euclidean)
    } else if definition.contains("vector_cosine_ops") {
        Some(DistanceMetric::Cosine)
    } else {
        None
    }
}

/// pgvector's text representation of a vector.
pub fn vector_literal(vector: &[f32]) -> String {
    format!(
        "[{}]",
        vector
            .iter()
            .map(f32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// A filter value as the text `jsonb ->>` would produce for it.
fn text_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A bound query parameter.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    Text(String),
    TextArray(Vec<String>),
    Int(i64),
}

/// Lower a filter into SQL over `metadata ->> 'field'`; values become parameters
/// starting at `$<params.len() + 1>`.
pub fn filter_sql(filter: &MetadataFilter, params: &mut Vec<SqlParam>) -> String {
    match filter {
        MetadataFilter::Eq { field, value } => {
            params.push(SqlParam::Text(text_value(value)));
            format!("metadata ->> '{field}' = ${}", params.len())
        }
        MetadataFilter::In { field, values } => {
            params.push(SqlParam::TextArray(values.iter().map(text_value).collect()));
            format!("metadata ->> '{field}' = ANY(${}::text[])", params.len())
        }
        MetadataFilter::And(children) | MetadataFilter::Or(children) => {
            let joiner = if matches!(filter, MetadataFilter::And(_)) {
                " AND "
            } else {
                " OR "
            };
            format!(
                "({})",
                children
                    .iter()
                    .map(|child| filter_sql(child, params))
                    .collect::<Vec<_>>()
                    .join(joiner)
            )
        }
    }
}

/// The KNN statement and its parameters (`$1` is the query vector).
pub fn query_sql(
    collection: &str,
    metric: DistanceMetric,
    query: &VectorQuery,
) -> (String, Vec<SqlParam>) {
    let mut params = vec![SqlParam::Text(vector_literal(&query.vector))];
    let where_clause = query
        .filter
        .as_ref()
        .map(|filter| format!(" WHERE {}", filter_sql(filter, &mut params)))
        .unwrap_or_default();
    params.push(SqlParam::Int(
        i64::try_from(query.top_k).unwrap_or(i64::MAX),
    ));
    let op = operator(metric);
    let sql = format!(
        "SELECT id, document, metadata::text, (embedding {op} $1::text::vector)::float8 AS distance \
         FROM {table}{where_clause} ORDER BY embedding {op} $1::text::vector, id LIMIT ${limit}",
        table = table(collection),
        limit = params.len(),
    );
    (sql, params)
}

fn bind(params: &[SqlParam]) -> Vec<&(dyn ToSql + Sync)> {
    params
        .iter()
        .map(|param| match param {
            SqlParam::Text(value) => value as &(dyn ToSql + Sync),
            SqlParam::TextArray(values) => values as &(dyn ToSql + Sync),
            SqlParam::Int(value) => value as &(dyn ToSql + Sync),
        })
        .collect()
}

#[async_trait::async_trait]
impl VectorStore for PgvectorStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::Pgvector
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        validate_collection_name(&spec.name)?;
        if spec.dimensions == 0 {
            bail!("collection '{}' needs non-zero dimensions", spec.name);
        }
        let client = self.client().await?;
        // Needs CREATE privilege on the database; an operator who installed the
        // extension already makes this a no-op.
        if let Err(error) = client
            .batch_execute("CREATE EXTENSION IF NOT EXISTS vector")
            .await
        {
            tracing::debug!("pgvector: CREATE EXTENSION skipped: {error}");
        }
        let dims: Option<i32> = client
            .query_opt(
                "SELECT a.atttypmod FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relname = $1 AND n.nspname = current_schema() \
                   AND a.attname = 'embedding' AND NOT a.attisdropped",
                &[&spec.name],
            )
            .await?
            .map(|row| row.get(0));
        if let Some(dims) = dims {
            if usize::try_from(dims).ok() != Some(spec.dimensions) {
                bail!(
                    "pgvector table '{}' has {dims} dimensions, not {}",
                    spec.name,
                    spec.dimensions
                );
            }
            let index_def: Option<String> = client
                .query_opt(
                    "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%vector_%_ops%' LIMIT 1",
                    &[&spec.name],
                )
                .await?
                .map(|row| row.get(0));
            let metric = index_def
                .as_deref()
                .and_then(parse_opclass)
                .unwrap_or(spec.metric);
            self.metrics.remember(&spec.name, metric);
            return Ok(());
        }
        client
            .batch_execute(&format!(
                "CREATE TABLE IF NOT EXISTS {table} (
                     id        TEXT PRIMARY KEY,
                     embedding vector({dims}) NOT NULL,
                     document  TEXT,
                     metadata  JSONB NOT NULL DEFAULT '{{}}'
                 );
                 CREATE INDEX IF NOT EXISTS \"{name}_embedding_hnsw\" ON {table} USING hnsw (embedding {ops});",
                table = table(&spec.name),
                dims = spec.dimensions,
                name = spec.name,
                ops = opclass(spec.metric),
            ))
            .await
            .context("creating the pgvector table")?;
        self.metrics.remember(&spec.name, spec.metric);
        Ok(())
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        if records.is_empty() {
            return Ok(());
        }
        let client = self.client().await?;
        let statement = client
            .prepare(&format!(
                "INSERT INTO {} (id, embedding, document, metadata)
                 VALUES ($1, $2::text::vector, $3, $4::text::jsonb)
                 ON CONFLICT (id) DO UPDATE SET
                     embedding = EXCLUDED.embedding,
                     document = EXCLUDED.document,
                     metadata = EXCLUDED.metadata",
                table(collection)
            ))
            .await?;
        for record in records {
            let vector = vector_literal(&record.vector);
            let metadata = Value::Object(record.metadata.clone()).to_string();
            client
                .execute(
                    &statement,
                    &[&record.id, &vector, &record.document, &metadata],
                )
                .await
                .with_context(|| format!("upserting '{}'", record.id))?;
        }
        Ok(())
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        let metric = self.metrics.get(collection);
        let (sql, params) = query_sql(collection, metric, query);
        let client = self.client().await?;
        let rows = client.query(&sql, &bind(&params)).await?;
        rows.iter()
            .map(|row| {
                let metadata: Option<String> = row.try_get(2)?;
                let metadata = metadata
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                #[allow(clippy::cast_possible_truncation)]
                let distance = row.try_get::<_, f64>(3)? as f32;
                Ok(VectorMatch {
                    id: row.try_get(0)?,
                    score: metric.distance_to_score(distance),
                    document: row.try_get(1)?,
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
        let client = self.client().await?;
        client
            .execute(
                &format!(
                    "DELETE FROM {} WHERE id = ANY($1::text[])",
                    table(collection)
                ),
                &[&ids],
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_sql_binds_every_value_and_orders_by_the_metric_operator() {
        let query = VectorQuery {
            vector: vec![0.5, -1.0],
            top_k: 3,
            filter: Some(MetadataFilter::And(vec![
                MetadataFilter::eq("lang", "en"),
                MetadataFilter::In {
                    field: "tier".into(),
                    values: vec![json!(1), json!(true)],
                },
            ])),
        };
        let (sql, params) = query_sql("docs", DistanceMetric::Cosine, &query);
        assert_eq!(
            sql,
            "SELECT id, document, metadata::text, (embedding <=> $1::text::vector)::float8 AS distance \
             FROM \"docs\" WHERE (metadata ->> 'lang' = $2 AND metadata ->> 'tier' = ANY($3::text[])) \
             ORDER BY embedding <=> $1::text::vector, id LIMIT $4"
        );
        assert_eq!(
            params,
            vec![
                SqlParam::Text("[0.5,-1]".into()),
                SqlParam::Text("en".into()),
                SqlParam::TextArray(vec!["1".into(), "true".into()]),
                SqlParam::Int(3),
            ]
        );
        assert_eq!(bind(&params).len(), 4);
    }

    #[test]
    fn unfiltered_query_uses_two_parameters() {
        let query = VectorQuery {
            vector: vec![1.0],
            top_k: 5,
            filter: None,
        };
        let (sql, params) = query_sql("docs", DistanceMetric::Euclidean, &query);
        assert!(sql.contains("embedding <-> $1::text::vector"));
        assert!(sql.ends_with("LIMIT $2"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn dot_scores_negate_the_negative_inner_product() {
        // `<#>` returns -(a·b); a larger inner product must score higher.
        assert!(
            DistanceMetric::Dot.distance_to_score(-0.9)
                > DistanceMetric::Dot.distance_to_score(-0.1)
        );
    }

    #[test]
    fn opclass_round_trips() {
        for metric in [
            DistanceMetric::Cosine,
            DistanceMetric::Dot,
            DistanceMetric::Euclidean,
        ] {
            let def = format!(
                "CREATE INDEX x ON t USING hnsw (embedding {})",
                opclass(metric)
            );
            assert_eq!(parse_opclass(&def), Some(metric));
        }
    }

    #[test]
    fn connection_string_is_validated_and_password_comes_from_the_credential() {
        let store = PgvectorStore::new(&VectorStoreConfig {
            provider: Some(VectorStoreProvider::Pgvector),
            url: Some("postgres://ryu@db.internal:5432/knowledge?sslmode=require".into()),
            api_key: Some("hunter2".into()),
            ..VectorStoreConfig::default()
        })
        .unwrap();
        assert!(store.tls);
        assert_eq!(store.config.get_password(), Some(b"hunter2".as_slice()));
        for mode in ["verify-full", "verify-ca"] {
            let store = PgvectorStore::new(&VectorStoreConfig {
                provider: Some(VectorStoreProvider::Pgvector),
                url: Some(format!(
                    "postgres://ryu@db.internal/knowledge?sslmode={mode}"
                )),
                ..VectorStoreConfig::default()
            })
            .unwrap();
            assert!(store.tls, "{mode}");
        }
        let plain = PgvectorStore::new(&VectorStoreConfig {
            provider: Some(VectorStoreProvider::Pgvector),
            url: Some("postgres://ryu@localhost/knowledge".into()),
            ..VectorStoreConfig::default()
        })
        .unwrap();
        assert!(!plain.tls);
        assert!(PgvectorStore::new(&VectorStoreConfig {
            provider: Some(VectorStoreProvider::Pgvector),
            url: Some("not a url ::".into()),
            ..VectorStoreConfig::default()
        })
        .is_err());
    }
}
