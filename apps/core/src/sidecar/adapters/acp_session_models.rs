//! Lenient reading of the `models` member of ACP session setup responses.
//!
//! ACP 3.x dropped the unstable `SessionModelState` (0.11's
//! `unstable_session_model`) from the typed `session/new`, `session/load` and
//! `session/resume` responses, but agents still send it and the desktop model
//! picker reads it. The desktop validates the whole acp-config payload at once,
//! so a malformed `models` value would cost it the modes, config options and
//! auth methods too. This mirrors the 0.11 schema (0.12.0) serde: a `models`
//! value that does not parse reads as absent (`DefaultOnError`), and an
//! `availableModels` list that is not a list reads as empty while malformed
//! entries in it are skipped (`DefaultOnError<VecSkipError<_>>`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Mirror of schema 0.12.0's `SessionModelState`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionModelState {
    current_model_id: String,
    #[serde(default, deserialize_with = "lenient_models")]
    available_models: Vec<ModelInfo>,
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    meta: Option<Map<String, Value>>,
}

/// Mirror of schema 0.12.0's `ModelInfo`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    model_id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    meta: Option<Map<String, Value>>,
}

fn lenient_models<'de, D>(deserializer: D) -> Result<Vec<ModelInfo>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Value::Array(entries) = Value::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

/// Normalize a setup response's `models` member as 0.11 did: the cleaned
/// object, or `null` when it is missing or does not parse.
pub(crate) fn normalize_models(raw: Option<&Value>) -> Value {
    raw.cloned()
        .and_then(|value| serde_json::from_value::<SessionModelState>(value).ok())
        .and_then(|state| serde_json::to_value(state).ok())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::normalize_models;
    use serde_json::json;

    #[test]
    fn keeps_a_well_formed_model_state() {
        let models = json!({
            "currentModelId": "a",
            "availableModels": [
                {"modelId": "a", "name": "A", "description": "first", "_meta": {"k": 1}},
                {"modelId": "b", "name": "B"}
            ],
            "_meta": {"x": true}
        });
        assert_eq!(normalize_models(Some(&models)), models);
    }

    #[test]
    fn skips_malformed_entries_and_drops_unknown_fields() {
        let models = json!({
            "currentModelId": "a",
            "availableModels": [
                {"modelId": "a", "name": "A", "extra": 1},
                {"modelId": "b"},
                {"modelId": "c", "name": "C", "description": 7},
                "not-a-model"
            ],
            "unknown": "dropped"
        });
        assert_eq!(
            normalize_models(Some(&models)),
            json!({
                "currentModelId": "a",
                "availableModels": [{"modelId": "a", "name": "A"}]
            })
        );
    }

    #[test]
    fn non_list_available_models_reads_as_empty() {
        let models = json!({"currentModelId": "a", "availableModels": "nope"});
        assert_eq!(
            normalize_models(Some(&models)),
            json!({"currentModelId": "a", "availableModels": []})
        );
    }

    #[test]
    fn unparseable_or_missing_state_reads_as_null() {
        assert!(normalize_models(Some(&json!({}))).is_null());
        assert!(normalize_models(Some(&json!({"availableModels": []}))).is_null());
        assert!(normalize_models(Some(&json!("models"))).is_null());
        assert!(normalize_models(Some(&json!(null))).is_null());
        assert!(normalize_models(None).is_null());
    }
}
