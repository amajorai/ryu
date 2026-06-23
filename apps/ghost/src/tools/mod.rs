pub mod actions;
pub mod annotate;
pub mod learning;
pub mod perception;
pub mod recipes;
pub mod snapshot;
pub mod vision;
pub mod wait;

use serde_json::Value;

/// Extract a string param, returning a helpful error if required and missing.
pub fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params[key].as_str()
}

/// Extract a bool param with default.
pub fn bool_param(params: &Value, key: &str, default: bool) -> bool {
    params[key].as_bool().unwrap_or(default)
}

/// Extract an i64 param with default.
pub fn int_param(params: &Value, key: &str, default: i64) -> i64 {
    params[key].as_i64().unwrap_or(default)
}

/// Extract a f64 param with default.
pub fn f64_param(params: &Value, key: &str, default: f64) -> f64 {
    params[key].as_f64().unwrap_or(default)
}
