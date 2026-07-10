//! Data Grid Explorer app (pure-data). `render` returns column metadata + a
//! per-column summary to the model, with the **full rows carried in `_meta`**
//! (widget-only) so large tables never enter model context. `act_on_rows`
//! acknowledges an action on the selected keys.

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

use super::app_result;

pub fn dispatch(tool: &str, args: Value) -> Result<Value> {
    match tool {
        "render" => render(args),
        "act_on_rows" => act_on_rows(args),
        other => Err(anyhow!("unknown table tool '{other}'")),
    }
}

fn render(args: Value) -> Result<Value> {
    let columns: Vec<Value> = args
        .get("columns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rows: Vec<Value> = args
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let primary_key = args
        .get("primary_key")
        .and_then(Value::as_str)
        .unwrap_or("id")
        .to_owned();

    // Per-column stats the model can reason over without the full rows.
    let mut per_column = Map::new();
    for col in &columns {
        let Some(key) = col.get("key").and_then(Value::as_str) else {
            continue;
        };
        let mut numeric = Vec::new();
        let mut non_null = 0usize;
        for r in &rows {
            if let Some(v) = r.get(key) {
                if !v.is_null() {
                    non_null += 1;
                }
                if let Some(n) = v.as_f64() {
                    numeric.push(n);
                }
            }
        }
        let mut stats = json!({ "non_null": non_null });
        if !numeric.is_empty() {
            let min = numeric.iter().cloned().fold(f64::INFINITY, f64::min);
            let max = numeric.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let mean = numeric.iter().sum::<f64>() / numeric.len() as f64;
            stats["min"] = json!(min);
            stats["max"] = json!(max);
            stats["mean"] = json!(mean);
        }
        per_column.insert(key.to_owned(), stats);
    }

    let structured = json!({
        "columns": columns,
        "primary_key": primary_key,
        "row_count": rows.len(),
        "summary": { "per_column_stats": Value::Object(per_column) },
    });
    // Full rows ride in widget-only metadata.
    let meta = json!({ "rows": rows });
    Ok(app_result(
        structured,
        Some(meta),
        &format!("Data grid with {} row(s).", rows.len()),
    ))
}

fn act_on_rows(args: Value) -> Result<Value> {
    let selected: Vec<Value> = args
        .get("selected_keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let structured = json!({
        "action": action,
        "selected_keys": selected,
        "status": "done",
    });
    Ok(app_result(
        structured,
        None,
        &format!("Applied '{action}' to {} row(s).", selected.len()),
    ))
}
