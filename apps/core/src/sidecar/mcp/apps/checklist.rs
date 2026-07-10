//! Checklist app (pure-data). `render` structures an item list; `update`
//! acknowledges a single mutation the widget applies optimistically.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, gen_id};

pub fn dispatch(tool: &str, args: Value) -> Result<Value> {
    match tool {
        "render" => render(args),
        "update" => update(args),
        other => Err(anyhow!("unknown checklist tool '{other}'")),
    }
}

fn render(args: Value) -> Result<Value> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Checklist")
        .to_owned();
    let items: Vec<Value> = args
        .get("items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .enumerate()
                .map(|(i, it)| {
                    json!({
                        "id": gen_id("itm"),
                        "text": it.get("text").and_then(Value::as_str).unwrap_or_default(),
                        "done": it.get("done").and_then(Value::as_bool).unwrap_or(false),
                        "order": i,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let list_id = gen_id("lst");
    let structured = json!({ "list_id": list_id, "title": title, "items": items });
    Ok(app_result(
        structured,
        None,
        &format!("Checklist \"{title}\" with {} item(s).", items.len()),
    ))
}

fn update(args: Value) -> Result<Value> {
    let list_id = args
        .get("list_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("list_id is required"))?
        .to_owned();
    let op = args
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("op is required"))?
        .to_owned();
    // Stateless: acknowledge the mutation. The widget owns the authoritative item
    // list in widgetState and applies the change optimistically; the fold-in of
    // confirmed values into model context happens on the governed round-trip.
    let item = json!({
        "id": args.get("item_id").cloned().unwrap_or_else(|| json!(gen_id("itm"))),
        "text": args.get("text").cloned().unwrap_or(Value::Null),
        "done": args.get("done").cloned().unwrap_or(Value::Null),
        "op": op,
    });
    let structured = json!({ "list_id": list_id, "applied": item });
    Ok(app_result(structured, None, &format!("Applied {op}.")))
}
