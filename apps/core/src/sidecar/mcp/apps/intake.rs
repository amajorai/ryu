//! Smart Intake Form app (pure-data). `render` prepares pre-filled fields;
//! `submit` confirms the corrected values and reports which keys the user edited.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, gen_id};

pub fn dispatch(tool: &str, args: Value) -> Result<Value> {
    match tool {
        "render" => render(args),
        "submit" => submit(args),
        other => Err(anyhow!("unknown app.form tool '{other}'")),
    }
}

fn render(args: Value) -> Result<Value> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Form")
        .to_owned();
    let submit_label = args
        .get("submitLabel")
        .and_then(Value::as_str)
        .unwrap_or("Submit")
        .to_owned();
    let fields: Vec<Value> = args
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let form_id = gen_id("frm");
    let structured = json!({
        "formId": form_id,
        "title": title,
        "submitLabel": submit_label,
        "fields": fields,
        "status": "awaiting_user",
    });
    Ok(app_result(
        structured,
        None,
        &format!("Form \"{title}\" with {} field(s).", fields.len()),
    ))
}

fn submit(args: Value) -> Result<Value> {
    let form_id = args
        .get("formId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("formId is required"))?
        .to_owned();
    let values = args.get("values").cloned().unwrap_or(json!({}));
    // The widget already knows which keys it edited; when it passes them we echo
    // them back, otherwise derive an empty set (the model reads `values`).
    let edited_keys: Vec<String> = values
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let structured = json!({
        "formId": form_id,
        "values": values,
        "edited_keys": edited_keys,
        "status": "confirmed",
    });
    Ok(app_result(structured, None, "Form submitted."))
}
