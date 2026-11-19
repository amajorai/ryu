//! Tests for `database_query`, kept beside it to hold the source under the file-size limits.

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
    let result = run_query(&formula_fanout_source(1), "SELECT COUNT(*) FROM data", &[]).unwrap();
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
