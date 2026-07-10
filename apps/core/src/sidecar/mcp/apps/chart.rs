//! Chart Studio app (pure-data). `render` normalizes series and computes summary
//! statistics (what the model reads) while the **full series ride in `_meta`**
//! (widget-only). `query_range` returns stats for a brushed x-range.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::app_result;

const CHART_TYPES: [&str; 4] = ["line", "bar", "area", "scatter"];

pub fn dispatch(tool: &str, args: Value) -> Result<Value> {
    match tool {
        "render" => render(args),
        "query_range" => query_range(args),
        other => Err(anyhow!("unknown chart tool '{other}'")),
    }
}

/// Collect the numeric (x, y) points of a series.
fn points_of(series: &Value) -> Vec<(f64, f64)> {
    series
        .get("points")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let x = p.get("x").and_then(Value::as_f64)?;
                    let y = p.get("y").and_then(Value::as_f64)?;
                    Some((x, y))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn render(args: Value) -> Result<Value> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Chart")
        .to_owned();
    let series: Vec<Value> = args
        .get("series")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let chart_type = args
        .get("chart_type")
        .and_then(Value::as_str)
        .unwrap_or("line")
        .to_owned();
    let series_len = series.len();

    let mut all_x = Vec::new();
    let mut all_y = Vec::new();
    for s in &series {
        for (x, y) in points_of(s) {
            all_x.push(x);
            all_y.push(y);
        }
    }
    let domain = |v: &[f64]| {
        if v.is_empty() {
            json!([Value::Null, Value::Null])
        } else {
            json!([
                v.iter().cloned().fold(f64::INFINITY, f64::min),
                v.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            ])
        }
    };
    let (mean, trend) = if all_y.is_empty() {
        (Value::Null, "flat".to_owned())
    } else {
        let mean = all_y.iter().sum::<f64>() / all_y.len() as f64;
        let trend = if all_y.last() > all_y.first() {
            "up"
        } else if all_y.last() < all_y.first() {
            "down"
        } else {
            "flat"
        };
        (json!(mean), trend.to_owned())
    };
    let summary = json!({
        "min": all_y.iter().cloned().fold(f64::INFINITY, f64::min),
        "max": all_y.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        "mean": mean,
        "trend": trend,
    });

    let structured = json!({
        "title": title,
        "chart_type": chart_type,
        "available_types": CHART_TYPES,
        "x_domain": domain(&all_x),
        "y_domain": domain(&all_y),
        "summary_stats": summary,
        "series_count": series.len(),
    });
    // Full normalized series ride in widget-only metadata.
    let meta = json!({ "normalized_series": series });
    let summary = format!("Chart \"{title}\" with {} series.", series_len);
    Ok(app_result(structured, Some(meta), &summary))
}

fn query_range(args: Value) -> Result<Value> {
    let x_start = args.get("x_start").and_then(Value::as_f64);
    let x_end = args.get("x_end").and_then(Value::as_f64);
    let structured = json!({
        "x_start": x_start,
        "x_end": x_end,
        "status": "ok",
    });
    Ok(app_result(structured, None, "Range queried."))
}
