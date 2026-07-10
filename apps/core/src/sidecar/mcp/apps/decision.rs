//! Decision Wizard app (pure-data). `flow` structures a step-by-step decision;
//! `submit` records the answers + outcome (and a weighted score when applicable).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, gen_id};

pub fn dispatch(tool: &str, args: Value) -> Result<Value> {
    match tool {
        "flow" => flow(args),
        "submit" => submit(args),
        other => Err(anyhow!("unknown app.decision tool '{other}'")),
    }
}

fn flow(args: Value) -> Result<Value> {
    let mode = args
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("quiz")
        .to_owned();
    let steps: Vec<Value> = args
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let flow_id = gen_id("flw");
    let structured = json!({
        "flowId": flow_id,
        "mode": mode,
        "steps": steps,
    });
    Ok(app_result(
        structured,
        None,
        &format!("Decision flow with {} step(s).", steps.len()),
    ))
}

fn submit(args: Value) -> Result<Value> {
    let flow_id = args
        .get("flowId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("flowId is required"))?
        .to_owned();
    let answers: Vec<Value> = args
        .get("answers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let outcome = args.get("outcome").cloned().unwrap_or(Value::Null);
    // Weighted score: sum of any numeric `value`s in the answers.
    let score: f64 = answers
        .iter()
        .filter_map(|a| a.get("value").and_then(Value::as_f64))
        .sum();
    let structured = json!({
        "flowId": flow_id,
        "answers": answers,
        "outcome": outcome,
        "score": score,
    });
    Ok(app_result(structured, None, "Decision submitted."))
}
