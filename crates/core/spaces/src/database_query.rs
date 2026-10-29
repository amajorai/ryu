//! Read-only SQL queries over a Space database document's grid rows.
//!
//! The document remains the source of truth. Queries run against a bounded,
//! in-memory SQLite projection so the editor's collaborative data model is not
//! bypassed by a second persistent store.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::database_formula::{apply_formula_columns, FormulaColumn, FormulaProjectionBudget};
use crate::{DocumentUpdateOutcome, SpaceStore};

const MAX_QUERY_BYTES: usize = 8_000;
const MAX_PARAMETERS: usize = 64;
const MAX_COLUMNS: usize = 128;
const MAX_ROWS: usize = 10_000;
const MAX_RESULT_ROWS: usize = 500;
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const MAX_FORMULA_PROJECTION_BYTES: usize = 16 * 1024 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Deserialize)]
struct DatabaseDocument {
    #[serde(default)]
    columns: Vec<DatabaseDocumentColumn>,
    #[serde(default)]
    rows: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DatabaseDocumentColumn {
    id: String,
    label: String,
    /// The grid's cell config; only a `formula` variant's `expression` is read.
    #[serde(default)]
    cell: Option<Value>,
}

impl DatabaseDocumentColumn {
    /// The formula expression when this is a computed (formula) column.
    fn formula_expression(&self) -> Option<&str> {
        let cell = self.cell.as_ref()?;
        (cell.get("variant").and_then(Value::as_str) == Some("formula"))
            .then(|| cell.get("expression").and_then(Value::as_str).unwrap_or(""))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatabaseQuerySchemaColumn {
    pub id: String,
    pub label: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub schema: Vec<DatabaseQuerySchemaColumn>,
    pub truncated: bool,
}

impl SpaceStore {
    /// Run one bounded, read-only SELECT against a native Space database document.
    /// `data` is the stable SQL table name; column names are normalized from the
    /// database's display labels and returned in `schema` for discoverability.
    pub async fn query_database(
        &self,
        space_id: &str,
        document_id: &str,
        query: &str,
        parameters: &[Value],
    ) -> Result<DatabaseQueryResult> {
        if query.len() > MAX_QUERY_BYTES || query.trim().is_empty() {
            return Err(anyhow!("query must contain 1 to {MAX_QUERY_BYTES} bytes"));
        }
        if parameters.len() > MAX_PARAMETERS {
            return Err(anyhow!(
                "query supports at most {MAX_PARAMETERS} parameters"
            ));
        }

        let document = self
            .get_document(document_id)
            .await?
            .ok_or_else(|| anyhow!("database not found"))?;
        if document.space_id != space_id || document.kind != "database" {
            return Err(anyhow!("database not found"));
        }

        let source = document.source;
        let query = query.to_owned();
        let parameters = parameters.to_owned();
        tokio::task::spawn_blocking(move || run_query(&source, &query, &parameters))
            .await
            .context("database query task panicked")?
    }

    /// Save a database document through the normal indexed, revision-aware path.
    pub async fn update_database_document(
        &self,
        space_id: &str,
        document_id: &str,
        title: &str,
        source: &str,
        expected_revision: i64,
    ) -> Result<DocumentUpdateOutcome> {
        let document = self
            .get_document(document_id)
            .await?
            .ok_or_else(|| anyhow!("database not found"))?;
        if document.space_id != space_id || document.kind != "database" {
            return Err(anyhow!("database not found"));
        }
        self.update_document_versioned(
            document_id,
            title,
            source,
            Some(expected_revision),
            None,
            None,
        )
        .await
    }

    /// Remove one native Space database document after verifying its parent.
    pub async fn delete_database_document(&self, space_id: &str, document_id: &str) -> Result<()> {
        let document = self
            .get_document(document_id)
            .await?
            .ok_or_else(|| anyhow!("database not found"))?;
        if document.space_id != space_id || document.kind != "database" {
            return Err(anyhow!("database not found"));
        }
        self.delete_document(document_id).await?;
        Ok(())
    }
}

fn run_query(source: &str, query: &str, parameters: &[Value]) -> Result<DatabaseQueryResult> {
    let deadline = Instant::now() + QUERY_TIMEOUT;
    let budget = FormulaProjectionBudget::new(MAX_FORMULA_PROJECTION_BYTES, deadline);
    if source.len() > MAX_RESULT_BYTES * 16 {
        return Err(anyhow!("database is too large to query"));
    }
    if !starts_with_select(query) || has_multiple_statements(query) {
        return Err(anyhow!("only one read-only SELECT query is allowed"));
    }

    let mut document = if source.trim().is_empty() {
        DatabaseDocument {
            columns: Vec::new(),
            rows: Vec::new(),
        }
    } else {
        serde_json::from_str::<DatabaseDocument>(source)
            .context("database document is not valid grid JSON")?
    };
    if document.columns.len() > MAX_COLUMNS || document.rows.len() > MAX_ROWS {
        return Err(anyhow!("database exceeds the query size limit"));
    }

    // Formula columns store only their expression; compute them so SQL sees
    // the same values the grid shows.
    let formula_columns = document
        .columns
        .iter()
        .map(|column| FormulaColumn {
            id: &column.id,
            label: &column.label,
            expression: column.formula_expression(),
        })
        .collect::<Vec<_>>();
    apply_formula_columns(&formula_columns, &mut document.rows, &budget)
        .map_err(|error| anyhow!(error))?;

    let schema = make_schema(document.columns)?;
    let connection = Connection::open_in_memory().context("opening query database")?;
    // The rows are decrypted database cells: keep the sorter and any temp
    // b-tree in memory so an ORDER BY or GROUP BY never spills them to a
    // temp file.
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .context("keeping query temp storage in memory")?;
    connection.progress_handler(10_000, Some(move || Instant::now() >= deadline))?;
    let create_table = if schema.is_empty() {
        "CREATE TABLE data (__empty)".to_owned()
    } else {
        format!(
            "CREATE TABLE data ({})",
            schema
                .iter()
                .map(|column| quote_identifier(&column.name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    connection
        .execute(&create_table, [])
        .context("creating query table")?;

    if !document.rows.is_empty() {
        let names = if schema.is_empty() {
            "__empty".to_owned()
        } else {
            schema
                .iter()
                .map(|column| quote_identifier(&column.name))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let placeholders = std::iter::repeat_n("?", schema.len().max(1))
            .collect::<Vec<_>>()
            .join(", ");
        let insert = format!("INSERT INTO data ({names}) VALUES ({placeholders})");
        let mut statement = connection
            .prepare(&insert)
            .context("preparing query data")?;
        for row in &document.rows {
            budget.check().map_err(|error| anyhow!(error))?;
            let values = if schema.is_empty() {
                vec![SqlValue::Null]
            } else {
                schema
                    .iter()
                    .map(|column| {
                        row.get(&column.id)
                            .map(json_to_sql)
                            .unwrap_or(SqlValue::Null)
                    })
                    .collect()
            };
            statement
                .execute(params_from_iter(values))
                .context("loading query rows")?;
        }
    }

    // Input projection is separately bounded. Apply caller-query limits only
    // after loading it so long grid labels/cells cannot break ordinary counts.
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_RESULT_BYTES as i32)?;
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_QUERY_BYTES as i32)?;
    connection
        .pragma_update(None, "query_only", "ON")
        .context("locking query database read-only")?;
    budget.check().map_err(|error| anyhow!(error))?;
    let mut statement = connection.prepare(query).context("invalid SQL query")?;
    if !statement.readonly() {
        return Err(anyhow!("only read-only SELECT queries are allowed"));
    }
    if statement.column_count() > MAX_COLUMNS {
        return Err(anyhow!("query returns too many columns"));
    }
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let bound_parameters = parameters.iter().map(json_to_sql).collect::<Vec<_>>();
    let mut query_rows = statement
        .query(params_from_iter(bound_parameters))
        .context("running SQL query")?;
    let mut rows = Vec::new();
    let mut result_bytes = 0usize;
    let mut truncated = false;
    while let Some(row) = query_rows.next().context("reading SQL result")? {
        budget.check().map_err(|error| anyhow!(error))?;
        if rows.len() >= MAX_RESULT_ROWS {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(columns.len());
        let mut row_bytes = 0usize;
        for index in 0..columns.len() {
            let value = row.get_ref(index)?;
            row_bytes += match value {
                ValueRef::Text(bytes) => bytes.len(),
                ValueRef::Blob(bytes) => bytes.len().saturating_mul(std::mem::size_of::<Value>()),
                _ => 32,
            };
            if row_bytes > MAX_RESULT_BYTES {
                return Err(anyhow!("query result row exceeds the size limit"));
            }
            values.push(sql_to_json(value));
        }
        let bytes = serde_json::to_vec(&values)?.len();
        if result_bytes + bytes > MAX_RESULT_BYTES {
            truncated = true;
            break;
        }
        result_bytes += bytes;
        rows.push(values);
    }
    connection.progress_handler(0, None::<fn() -> bool>)?;
    Ok(DatabaseQueryResult {
        columns,
        rows,
        schema,
        truncated,
    })
}

fn make_schema(columns: Vec<DatabaseDocumentColumn>) -> Result<Vec<DatabaseQuerySchemaColumn>> {
    let mut ids = HashSet::new();
    let mut aliases = HashSet::new();
    let mut schema = Vec::with_capacity(columns.len());
    for (index, column) in columns.into_iter().enumerate() {
        if column.id.trim().is_empty() || !ids.insert(column.id.clone()) {
            return Err(anyhow!("database has an invalid or duplicate column id"));
        }
        let base = normalize_label(&column.label);
        let mut name = base.clone();
        let mut suffix = 2usize;
        while !aliases.insert(name.clone()) {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        if name.is_empty() {
            name = format!("column_{}", index + 1);
        }
        schema.push(DatabaseQuerySchemaColumn {
            id: column.id,
            label: column.label,
            name,
        });
    }
    Ok(schema)
}

fn normalize_label(label: &str) -> String {
    let mut normalized = String::new();
    let mut underscore = false;
    for character in label.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            underscore = false;
        } else if !underscore && !normalized.is_empty() {
            normalized.push('_');
            underscore = true;
        }
    }
    while normalized.ends_with('_') {
        normalized.pop();
    }
    if normalized.is_empty() {
        "column".to_owned()
    } else if normalized.as_bytes()[0].is_ascii_digit() {
        format!("column_{normalized}")
    } else {
        normalized
    }
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .unwrap_or_else(|| SqlValue::Text(value.to_string())),
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(value.to_string()),
    }
}

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(value.iter().copied().map(Value::from).collect()),
    }
}

fn starts_with_select(query: &str) -> bool {
    let mut rest = query.trim_start();
    loop {
        if let Some(comment) = rest.strip_prefix("--") {
            rest = comment
                .find('\n')
                .map_or("", |index| &comment[index + 1..])
                .trim_start();
            continue;
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            let Some(end) = comment.find("*/") else {
                return false;
            };
            rest = comment[end + 2..].trim_start();
            continue;
        }
        break;
    }
    let keyword = rest
        .split(|character: char| !character.is_ascii_alphabetic())
        .next()
        .unwrap_or_default();
    keyword.eq_ignore_ascii_case("select") || keyword.eq_ignore_ascii_case("with")
}

fn has_multiple_statements(query: &str) -> bool {
    #[derive(Clone, Copy)]
    enum Quote {
        None,
        Single,
        Double,
        Backtick,
        Bracket,
        LineComment,
        BlockComment,
    }
    let bytes = query.as_bytes();
    let mut quote = Quote::None;
    let mut statements = 0usize;
    let mut has_content = false;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        match quote {
            Quote::None => match (byte, next) {
                (b'-', Some(b'-')) => {
                    quote = Quote::LineComment;
                    index += 1;
                }
                (b'/', Some(b'*')) => {
                    quote = Quote::BlockComment;
                    index += 1;
                }
                (b'\'', _) => {
                    quote = Quote::Single;
                    has_content = true;
                }
                (b'"', _) => {
                    quote = Quote::Double;
                    has_content = true;
                }
                (b'`', _) => {
                    quote = Quote::Backtick;
                    has_content = true;
                }
                (b'[', _) => {
                    quote = Quote::Bracket;
                    has_content = true;
                }
                (b';', _) => {
                    if has_content {
                        statements += 1;
                        has_content = false;
                    }
                }
                (byte, _) if byte.is_ascii_whitespace() => {}
                _ => has_content = true,
            },
            Quote::Single if byte == b'\'' => {
                if next == Some(b'\'') {
                    index += 1;
                } else {
                    quote = Quote::None;
                }
            }
            Quote::Double if byte == b'"' => {
                if next == Some(b'"') {
                    index += 1;
                } else {
                    quote = Quote::None;
                }
            }
            Quote::Backtick if byte == b'`' => quote = Quote::None,
            Quote::Bracket if byte == b']' => quote = Quote::None,
            Quote::LineComment if byte == b'\n' => quote = Quote::None,
            Quote::BlockComment if byte == b'*' && next == Some(b'/') => {
                quote = Quote::None;
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    if has_content {
        statements += 1;
    }
    statements > 1
}

#[cfg(test)]
mod tests {
    use super::{run_query, DatabaseQuerySchemaColumn, SpaceStore};
    use serde_json::json;

    #[test]
    fn sqlite_rejects_large_intermediates_before_result_conversion() {
        for query in [
            "SELECT zeroblob(1000000000)",
            "SELECT hex(zeroblob(600000))",
            "SELECT printf('%1000000000s', 'x')",
        ] {
            assert!(run_query("", query, &[]).is_err(), "{query}");
        }
        let result = run_query("", "SELECT hex(zeroblob(16)), 'ordinary'", &[]).unwrap();
        assert_eq!(result.rows[0][1], json!("ordinary"));
    }

    #[test]
    fn long_grid_labels_do_not_consume_the_caller_sql_limit() {
        let document = json!({"columns": [{"id": "one", "label": "x".repeat(9000)}], "rows": [{"one": "y".repeat(2 * 1024 * 1024)}]}).to_string();
        let result = run_query(&document, "SELECT COUNT(*) FROM data", &[]).unwrap();
        assert_eq!(result.rows, vec![vec![json!(1)]]);
    }

    fn source() -> String {
        json!({
            "columns": [
                {"id":"name", "label":"Task Name"},
                {"id":"status", "label":"Status"},
                {"id":"summary", "label":"Task Name"}
            ],
            "rows": [
                {"name":"Ship SQL", "status":"Done", "summary":"safe"},
                {"name":"Write docs", "status":"Open", "summary":"pending"}
            ]
        })
        .to_string()
    }

    #[test]
    fn runs_parameterized_select_and_returns_normalized_schema() {
        let result = run_query(
            &source(),
            "SELECT task_name, COUNT(*) AS count FROM data WHERE status = ? GROUP BY task_name",
            &[json!("Done")],
        )
        .unwrap();
        assert_eq!(result.columns, ["task_name", "count"]);
        assert_eq!(result.rows, [vec![json!("Ship SQL"), json!(1)]]);
        assert_eq!(
            result.schema,
            [
                DatabaseQuerySchemaColumn {
                    id: "name".into(),
                    label: "Task Name".into(),
                    name: "task_name".into(),
                },
                DatabaseQuerySchemaColumn {
                    id: "status".into(),
                    label: "Status".into(),
                    name: "status".into(),
                },
                DatabaseQuerySchemaColumn {
                    id: "summary".into(),
                    label: "Task Name".into(),
                    name: "task_name_2".into(),
                },
            ]
        );
    }

    #[test]
    fn refuses_writes_and_multiple_statements() {
        for query in [
            "DELETE FROM data",
            "INSERT INTO data (task_name) VALUES ('bad')",
            "SELECT * FROM data; DELETE FROM data",
            "PRAGMA table_info(data)",
        ] {
            assert!(run_query(&source(), query, &[]).is_err(), "{query}");
        }
    }

    #[test]
    fn computes_formula_columns_for_sql() {
        let document = json!({
            "columns": [
                {"id": "price", "label": "Price", "cell": {"variant": "number"}},
                {"id": "qty", "label": "Qty", "cell": {"variant": "number"}},
                {"id": "total", "label": "Total", "cell": {"variant": "formula", "expression": "{Price} * {Qty}"}},
                {"id": "flag", "label": "Flag", "cell": {"variant": "formula", "expression": "IF({Total} > 10, \"big\", \"small\")"}}
            ],
            "rows": [
                {"price": 2, "qty": 3, "total": ""},
                {"price": 2.5, "qty": 6, "total": ""}
            ]
        })
        .to_string();
        let result = run_query(
            &document,
            "SELECT total, flag FROM data WHERE total > 5 ORDER BY total",
            &[],
        )
        .expect("query");
        assert_eq!(
            result.rows,
            vec![
                vec![json!(6), json!("small")],
                vec![json!(15), json!("big")]
            ]
        );
    }

    fn formula_fanout_source(row_count: usize) -> String {
        let columns = (0..128)
            .map(|index| {
                json!({
                    "id": format!("C{index}"), "label": format!("C{index}"),
                    "cell": {"variant": "formula", "expression": if index == 0 {
                        format!("\"{}\"", "x".repeat(32_767))
                    } else { "{C0}".to_owned() }}
                })
            })
            .collect::<Vec<_>>();
        json!({"columns": columns, "rows": vec![json!({}); row_count]}).to_string()
    }

    #[test]
    fn rejects_compact_formula_fanout_before_sql_count_projection() {
        let source = formula_fanout_source(10_000);
        assert!(source.len() < 100_000);
        let error = run_query(&source, "SELECT COUNT(*) FROM data", &[]).unwrap_err();
        assert!(error.to_string().contains("size limit"), "{error}");
        let result =
            run_query(&formula_fanout_source(1), "SELECT COUNT(*) FROM data", &[]).unwrap();
        assert_eq!(result.rows, vec![vec![json!(1)]]);
    }

    #[tokio::test]
    async fn saved_formula_fanout_fails_without_mutating_document_or_revision() {
        let store = SpaceStore::open_in_memory().unwrap();
        let owner = crate::DocOwner::unattributed();
        let space = store
            .ensure_named_space("Formula budget", None, &owner)
            .await
            .unwrap();
        let database = store
            .create_database(&space, "Fanout", &owner)
            .await
            .unwrap();
        let document = store.get_document(&database).await.unwrap().unwrap();
        let source = formula_fanout_source(10_000);
        store
            .update_database_document(&space, &database, "Fanout", &source, document.revision)
            .await
            .unwrap();
        let before = store.get_document(&database).await.unwrap().unwrap();
        assert!(store
            .query_database(&space, &database, "SELECT COUNT(*) FROM data", &[])
            .await
            .unwrap_err()
            .to_string()
            .contains("size limit"));
        let after = store.get_document(&database).await.unwrap().unwrap();
        assert_eq!(after.source, before.source);
        assert_eq!(after.revision, before.revision);
    }

    #[test]
    fn treats_sql_looking_cell_values_as_data() {
        let source = json!({
            "columns": [{"id":"name", "label":"Name"}],
            "rows": [{"name":"'); DROP TABLE data; --"}]
        })
        .to_string();
        let result = run_query(&source, "SELECT name FROM data", &[]).unwrap();
        assert_eq!(result.rows, [vec![json!("'); DROP TABLE data; --")]]);
    }

    #[tokio::test]
    async fn queries_the_saved_space_database_and_rejects_stale_updates() {
        let store = SpaceStore::open_in_memory().unwrap();
        let owner = crate::DocOwner::unattributed();
        let space_id = store
            .ensure_named_space("SQL query test", None, &owner)
            .await
            .unwrap();
        let database_id = store
            .create_database(&space_id, "Tasks", &owner)
            .await
            .unwrap();
        let source = json!({
            "columns": [
                {"id":"name", "label":"Name", "cell":{"variant":"short-text"}},
                {"id":"status", "label":"Status", "cell":{"variant":"short-text"}}
            ],
            "rows": [{"name":"Ship query", "status":"Done"}],
            "views": [{"id":"view_table", "name":"Table", "kind":"table"}]
        })
        .to_string();
        let update = store
            .update_database_document(&space_id, &database_id, "Tasks", &source, 0)
            .await
            .unwrap();
        assert!(matches!(
            update,
            crate::DocumentUpdateOutcome::Applied(ref result) if result.revision == 1
        ));
        let query = store
            .query_database(
                &space_id,
                &database_id,
                "SELECT name FROM data WHERE status = ?",
                &[json!("Done")],
            )
            .await
            .unwrap();
        assert_eq!(query.rows, [vec![json!("Ship query")]]);

        let stale = store
            .update_database_document(&space_id, &database_id, "Tasks", &source, 0)
            .await
            .unwrap();
        assert!(matches!(
            stale,
            crate::DocumentUpdateOutcome::Conflict {
                current_revision: 1
            }
        ));
    }
}
