//! Local, in-process vector store on SQLite + sqlite-vec — the default backend.
//!
//! Each collection is one ordinary table (`vs_<name>`) holding the id, the vector
//! as a little-endian `f32` blob, the text and a JSON metadata object, plus one
//! row in `vs_collections` recording its dimensions and metric. A query is an
//! **exact** scan ranked by sqlite-vec's `vec_distance_cosine`/`vec_distance_l2`
//! with the metadata filter pushed into the `WHERE` clause via `json_extract`, so a
//! filter can never starve the top-K the way post-filtering an approximate index
//! does. That is the right trade for a per-node knowledge collection; a corpus that
//! outgrows exact search belongs in one of the server backends.
//!
//! sqlite-vec has no inner-product distance function, so the `dot` metric is
//! scored in Rust over the filtered rows.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::{
    check_query, check_records, validate_collection_name, CollectionSpec, DistanceMetric,
    MetadataFilter, VectorMatch, VectorQuery, VectorRecord, VectorStore, VectorStoreProvider,
};

/// The sqlite-vec backend.
pub struct SqliteVecStore {
    conn: Arc<Mutex<Connection>>,
}

/// Register sqlite-vec as a process auto-extension exactly once. Idempotent with
/// other crates' registrations: SQLite ignores a duplicate auto-extension pointer.
fn register_sqlite_vec() {
    use std::sync::Once;
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `sqlite3_vec_init` has the SQLite extension entry-point ABI and
        // `sqlite3_auto_extension` stores the pointer for use on connection open.
        // Mirrors sqlite-vec's own documented rusqlite registration.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                unsafe extern "C" fn(
                    *mut rusqlite::ffi::sqlite3,
                    *mut *mut std::os::raw::c_char,
                    *const rusqlite::ffi::sqlite3_api_routines,
                ) -> std::os::raw::c_int,
            >(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

impl SqliteVecStore {
    /// Open (or create) the store at `path`; `":memory:"` opens a private
    /// in-memory database.
    pub fn open(path: &Path) -> Result<Self> {
        register_sqlite_vec();
        let conn = if path == Path::new(":memory:") {
            Connection::open_in_memory().context("opening in-memory vector store")?
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
            Connection::open(path)
                .with_context(|| format!("opening vector store {}", path.display()))?
        };
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS vs_collections (
                 name       TEXT PRIMARY KEY,
                 dimensions INTEGER NOT NULL,
                 metric     TEXT NOT NULL
             );",
        )
        .context("initializing vector store schema")?;
        // Fail at open, not at first query, when the extension did not load.
        conn.query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0))
            .context("sqlite-vec extension is not available")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    async fn with_conn<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| anyhow!("vector store connection lock poisoned"))?;
            work(&mut guard)
        })
        .await
        .context("vector store task panicked")?
    }
}

fn table_name(collection: &str) -> String {
    // Collection names are validated to `[A-Za-z][A-Za-z0-9_-]*`; quoting keeps
    // the `-` legal in an identifier.
    format!("\"vs_{collection}\"")
}

fn metric_name(metric: DistanceMetric) -> &'static str {
    match metric {
        DistanceMetric::Cosine => "cosine",
        DistanceMetric::Dot => "dot",
        DistanceMetric::Euclidean => "euclidean",
    }
}

fn collection_info(conn: &Connection, collection: &str) -> Result<(usize, DistanceMetric)> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT dimensions, metric FROM vs_collections WHERE name = ?1",
            params![collection],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (dims, metric) =
        row.with_context(|| format!("vector collection '{collection}' does not exist"))?;
    Ok((usize::try_from(dims).unwrap_or(0), metric.parse()?))
}

fn vector_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn blob_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn sql_scalar(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or_default()),
        },
        other => bail!("unsupported filter value {other}"),
    })
}

/// Lower a filter into a `WHERE` fragment over `json_extract(metadata, '$.field')`.
/// Field names are validated identifiers, so splicing them into the JSON path
/// literal is safe; every value is a bound parameter.
pub(crate) fn filter_sql(filter: &MetadataFilter, params: &mut Vec<SqlValue>) -> Result<String> {
    Ok(match filter {
        MetadataFilter::Eq { field, value } => {
            params.push(sql_scalar(value)?);
            format!("json_extract(metadata, '$.{field}') = ?{}", params.len())
        }
        MetadataFilter::In { field, values } => {
            let mut placeholders = Vec::with_capacity(values.len());
            for value in values {
                params.push(sql_scalar(value)?);
                placeholders.push(format!("?{}", params.len()));
            }
            format!(
                "json_extract(metadata, '$.{field}') IN ({})",
                placeholders.join(", ")
            )
        }
        MetadataFilter::And(children) | MetadataFilter::Or(children) => {
            let joiner = if matches!(filter, MetadataFilter::And(_)) {
                " AND "
            } else {
                " OR "
            };
            let parts = children
                .iter()
                .map(|child| filter_sql(child, params))
                .collect::<Result<Vec<_>>>()?;
            format!("({})", parts.join(joiner))
        }
    })
}

#[async_trait::async_trait]
impl VectorStore for SqliteVecStore {
    fn provider(&self) -> VectorStoreProvider {
        VectorStoreProvider::SqliteVec
    }

    async fn ensure_collection(&self, spec: &CollectionSpec) -> Result<()> {
        validate_collection_name(&spec.name)?;
        if spec.dimensions == 0 {
            bail!("collection '{}' needs non-zero dimensions", spec.name);
        }
        let spec = spec.clone();
        self.with_conn(move |conn| {
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT dimensions FROM vs_collections WHERE name = ?1",
                    params![spec.name],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(dims) = existing {
                if usize::try_from(dims).ok() != Some(spec.dimensions) {
                    bail!(
                        "vector collection '{}' has {dims} dimensions, not {}",
                        spec.name,
                        spec.dimensions
                    );
                }
                return Ok(());
            }
            let tx = conn.transaction()?;
            tx.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS {} (
                     id        TEXT PRIMARY KEY,
                     embedding BLOB NOT NULL,
                     document  TEXT,
                     metadata  TEXT NOT NULL DEFAULT '{{}}'
                 );",
                table_name(&spec.name)
            ))?;
            tx.execute(
                "INSERT INTO vs_collections (name, dimensions, metric) VALUES (?1, ?2, ?3)",
                params![
                    spec.name,
                    i64::try_from(spec.dimensions)?,
                    metric_name(spec.metric)
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    async fn upsert(&self, collection: &str, records: &[VectorRecord]) -> Result<()> {
        check_records(collection, records)?;
        let collection = collection.to_owned();
        let records = records.to_vec();
        self.with_conn(move |conn| {
            let (dims, _) = collection_info(conn, &collection)?;
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(&format!(
                    "INSERT INTO {} (id, embedding, document, metadata) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                         embedding = excluded.embedding,
                         document = excluded.document,
                         metadata = excluded.metadata",
                    table_name(&collection)
                ))?;
                for record in &records {
                    if record.vector.len() != dims {
                        bail!(
                            "record '{}' has {} dimensions; collection '{collection}' has {dims}",
                            record.id,
                            record.vector.len()
                        );
                    }
                    stmt.execute(params![
                        record.id,
                        vector_blob(&record.vector),
                        record.document,
                        Value::Object(record.metadata.clone()).to_string(),
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    async fn query(&self, collection: &str, query: &VectorQuery) -> Result<Vec<VectorMatch>> {
        check_query(collection, query)?;
        if query.top_k == 0 {
            return Ok(Vec::new());
        }
        let collection = collection.to_owned();
        let query = query.clone();
        self.with_conn(move |conn| {
            let (dims, metric) = collection_info(conn, &collection)?;
            if query.vector.len() != dims {
                bail!(
                    "query has {} dimensions; collection '{collection}' has {dims}",
                    query.vector.len()
                );
            }
            let mut sql_params: Vec<SqlValue> = vec![SqlValue::Blob(vector_blob(&query.vector))];
            let where_clause = match &query.filter {
                Some(filter) => format!("WHERE {}", filter_sql(filter, &mut sql_params)?),
                None => String::new(),
            };
            let table = table_name(&collection);
            let limit = i64::try_from(query.top_k).unwrap_or(i64::MAX);
            let sql = match metric {
                DistanceMetric::Cosine | DistanceMetric::Euclidean => {
                    let function = if metric == DistanceMetric::Cosine {
                        "vec_distance_cosine"
                    } else {
                        "vec_distance_l2"
                    };
                    sql_params.push(SqlValue::Integer(limit));
                    format!(
                        "SELECT id, document, metadata, {function}(embedding, ?1) AS distance
                         FROM {table} {where_clause} ORDER BY distance ASC, id ASC LIMIT ?{}",
                        sql_params.len()
                    )
                }
                // No inner-product function in sqlite-vec: fetch the filtered rows
                // and score them below. `?1` stays bound (and unused) so parameter
                // numbering is identical across metrics.
                DistanceMetric::Dot => format!(
                    "SELECT id, document, metadata, embedding FROM {table} \
                     WHERE (?1 IS NOT NULL) {}",
                    where_clause.replacen("WHERE", "AND", 1)
                ),
            };
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params_from_iter(sql_params.iter()))?;
            let mut matches = Vec::new();
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let document: Option<String> = row.get(1)?;
                let metadata: String = row.get(2)?;
                let metadata = match serde_json::from_str::<Value>(&metadata) {
                    Ok(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                let score = if metric == DistanceMetric::Dot {
                    let blob: Vec<u8> = row.get(3)?;
                    blob_vector(&blob)
                        .iter()
                        .zip(&query.vector)
                        .map(|(a, b)| a * b)
                        .sum()
                } else {
                    #[allow(clippy::cast_possible_truncation)]
                    let distance = row.get::<_, f64>(3)? as f32;
                    metric.distance_to_score(distance)
                };
                matches.push(VectorMatch {
                    id,
                    score,
                    document,
                    metadata,
                });
            }
            if metric == DistanceMetric::Dot {
                matches.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
                matches.truncate(query.top_k);
            }
            Ok(matches)
        })
        .await
    }

    async fn delete(&self, collection: &str, ids: &[String]) -> Result<()> {
        validate_collection_name(collection)?;
        if ids.is_empty() {
            return Ok(());
        }
        let collection = collection.to_owned();
        let ids = ids.to_vec();
        self.with_conn(move |conn| {
            collection_info(conn, &collection)?;
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(&format!(
                    "DELETE FROM {} WHERE id = ?1",
                    table_name(&collection)
                ))?;
                for id in &ids {
                    stmt.execute(params![id])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: &str, vector: Vec<f32>, meta: Value) -> VectorRecord {
        VectorRecord {
            id: id.into(),
            vector,
            document: Some(format!("doc {id}")),
            metadata: meta.as_object().cloned().unwrap_or_default(),
        }
    }

    async fn seeded(metric: DistanceMetric) -> SqliteVecStore {
        let store = SqliteVecStore::open(Path::new(":memory:")).unwrap();
        store
            .ensure_collection(&CollectionSpec {
                name: "docs".into(),
                dimensions: 3,
                metric,
            })
            .await
            .unwrap();
        store
            .upsert(
                "docs",
                &[
                    record("a", vec![1.0, 0.0, 0.0], json!({"lang": "en", "tier": 1})),
                    record("b", vec![0.9, 0.1, 0.0], json!({"lang": "de", "tier": 2})),
                    record(
                        "c",
                        vec![0.0, 1.0, 0.0],
                        json!({"lang": "en", "tier": 3, "draft": true}),
                    ),
                ],
            )
            .await
            .unwrap();
        store
    }

    fn query(filter: Option<MetadataFilter>) -> VectorQuery {
        VectorQuery {
            vector: vec![1.0, 0.0, 0.0],
            top_k: 10,
            filter,
        }
    }

    #[tokio::test]
    async fn cosine_query_ranks_nearest_first_and_round_trips_payload() {
        let store = seeded(DistanceMetric::Cosine).await;
        let hits = store.query("docs", &query(None)).await.unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert!((hits[0].score - 1.0).abs() < 1e-5);
        assert_eq!(hits[0].document.as_deref(), Some("doc a"));
        assert_eq!(hits[0].metadata["lang"], "en");
    }

    #[tokio::test]
    async fn metadata_filters_are_applied_before_the_limit() {
        let store = seeded(DistanceMetric::Cosine).await;
        let mut q = query(Some(MetadataFilter::eq("lang", "en")));
        q.top_k = 1;
        let hits = store.query("docs", &q).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");

        let hits = store
            .query(
                "docs",
                &query(Some(MetadataFilter::Or(vec![
                    MetadataFilter::eq("draft", true),
                    MetadataFilter::In {
                        field: "tier".into(),
                        values: vec![json!(2)],
                    },
                ]))),
            )
            .await
            .unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["b", "c"]);
    }

    #[tokio::test]
    async fn euclidean_and_dot_metrics_rank_correctly() {
        for metric in [DistanceMetric::Euclidean, DistanceMetric::Dot] {
            let store = seeded(metric).await;
            let hits = store.query("docs", &query(None)).await.unwrap();
            assert_eq!(hits[0].id, "a", "{metric:?}");
            assert_eq!(hits.last().unwrap().id, "c", "{metric:?}");
        }
    }

    #[tokio::test]
    async fn upsert_replaces_and_delete_removes() {
        let store = seeded(DistanceMetric::Cosine).await;
        store
            .upsert(
                "docs",
                &[record("c", vec![1.0, 0.0, 0.0], json!({"lang": "fr"}))],
            )
            .await
            .unwrap();
        store
            .delete("docs", &["a".into(), "missing".into()])
            .await
            .unwrap();
        let hits = store.query("docs", &query(None)).await.unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["c", "b"]);
        assert_eq!(hits[0].metadata["lang"], "fr");
    }

    #[tokio::test]
    async fn dimension_mismatches_are_errors() {
        let store = seeded(DistanceMetric::Cosine).await;
        assert!(store
            .upsert("docs", &[record("x", vec![1.0, 0.0], json!({}))])
            .await
            .is_err());
        assert!(store
            .ensure_collection(&CollectionSpec {
                name: "docs".into(),
                dimensions: 4,
                metric: DistanceMetric::Cosine,
            })
            .await
            .is_err());
        assert!(store.query("missing", &query(None)).await.is_err());
    }

    #[tokio::test]
    async fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/vector-store.db");
        {
            let store = SqliteVecStore::open(&path).unwrap();
            store
                .ensure_collection(&CollectionSpec {
                    name: "docs".into(),
                    dimensions: 2,
                    metric: DistanceMetric::Cosine,
                })
                .await
                .unwrap();
            store
                .upsert("docs", &[record("a", vec![1.0, 0.0], json!({}))])
                .await
                .unwrap();
        }
        let store = SqliteVecStore::open(&path).unwrap();
        let hits = store
            .query(
                "docs",
                &VectorQuery {
                    vector: vec![1.0, 0.0],
                    top_k: 1,
                    filter: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(hits[0].id, "a");
    }
}
