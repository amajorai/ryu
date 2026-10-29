//! Parse external MCP App declarations; no declaration is an authorization grant.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Entrypoint {
    Global,
    Thread,
    File { extensions: Vec<String> },
}

pub fn resource_uri(meta: Option<&Value>) -> Option<&str> {
    let uri = meta?.get("ui")?.get("resourceUri")?.as_str()?;
    (uri.starts_with("ui://") && uri.len() <= 2048 && !uri.chars().any(char::is_control))
        .then_some(uri)
}

pub fn annotations_with_title(tool: &Value) -> Option<Value> {
    let mut annotations = tool
        .get("annotations")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(title) = tool
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty() && title.len() <= 512)
    {
        annotations.insert("title".to_owned(), Value::String(title.to_owned()));
    }
    (!annotations.is_empty()).then_some(Value::Object(annotations))
}

pub fn entrypoints(meta: Option<&Value>) -> Vec<Entrypoint> {
    let Some(meta) = meta else { return Vec::new() };
    if resource_uri(Some(meta)).is_none() {
        return Vec::new();
    }
    let Some(rows) = meta
        .get("openai/ui")
        .and_then(|ui| ui.get("entrypoints"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    if rows.len() > 3 {
        return Vec::new();
    }
    let mut result = Vec::new();
    for row in rows {
        let Ok(mut entry) = serde_json::from_value::<Entrypoint>(row.clone()) else {
            continue;
        };
        if let Entrypoint::File { extensions } = &mut entry {
            if extensions.is_empty() || extensions.len() > 64 {
                continue;
            }
            if extensions.iter().any(|ext| {
                let suffix = ext.strip_prefix('.').unwrap_or(ext);
                suffix.is_empty()
                    || ext.len() > 32
                    || !suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            }) {
                continue;
            }
            for ext in extensions.iter_mut() {
                *ext = ext.strip_prefix('.').unwrap_or(ext).to_ascii_lowercase();
            }
            extensions.sort();
            extensions.dedup();
            if let Some(Entrypoint::File {
                extensions: existing,
            }) = result
                .iter_mut()
                .find(|entry| matches!(entry, Entrypoint::File { .. }))
            {
                existing.extend(extensions.iter().cloned());
                existing.sort();
                existing.dedup();
                if existing.len() > 64 {
                    return Vec::new();
                }
                continue;
            }
        }
        if !result.contains(&entry) {
            result.push(entry);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_registered_mcp_apps_and_rejects_unsafe_declarations() {
        let valid = json!({"ui":{"resourceUri":"ui://demo/editor"},"openai/ui":{"entrypoints":[{"type":"global"},{"type":"thread"},{"type":"file","extensions":[".STL","stl"]}]}});
        assert_eq!(
            entrypoints(Some(&valid)),
            vec![
                Entrypoint::Global,
                Entrypoint::Thread,
                Entrypoint::File {
                    extensions: vec!["stl".into()]
                }
            ]
        );
        for uri in ["https://example.com/editor", "ui://demo/\neditor"] {
            let mut invalid = valid.clone();
            invalid["ui"]["resourceUri"] = json!(uri);
            assert!(entrypoints(Some(&invalid)).is_empty());
        }
        let invalid = json!({"ui":{"resourceUri":"ui://editor"},"openai/ui":{"entrypoints":[{"type":"file","extensions":["../secret"]}]}});
        assert!(entrypoints(Some(&invalid)).is_empty());
        assert!(entrypoints(None).is_empty());
    }

    #[test]
    fn file_entrypoints_merge_normalized_extensions_into_one_handler() {
        let value = json!({"ui":{"resourceUri":"ui://editor"},"openai/ui":{"entrypoints":[{"type":"file","extensions":[".STL","obj"]},{"type":"global"},{"type":"file","extensions":["stl",".PLY"]}]}});
        assert_eq!(
            entrypoints(Some(&value)),
            vec![
                Entrypoint::File {
                    extensions: vec!["obj".into(), "ply".into(), "stl".into()]
                },
                Entrypoint::Global,
            ]
        );
        let first: Vec<String> = (0..64).map(|index| format!("a{index}")).collect();
        let oversized = json!({"ui":{"resourceUri":"ui://editor"},"openai/ui":{"entrypoints":[{"type":"file","extensions":first},{"type":"file","extensions":["extra"]}]}});
        assert!(entrypoints(Some(&oversized)).is_empty());
    }

    #[test]
    fn top_level_tool_title_wins_without_dropping_annotations() {
        let value = annotations_with_title(
            &json!({"title":"Parts","annotations":{"title":"Old","readOnlyHint":true}}),
        )
        .unwrap();
        assert_eq!(value["title"], "Parts");
        assert_eq!(value["readOnlyHint"], true);
    }
}
