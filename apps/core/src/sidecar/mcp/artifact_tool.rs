//! Built-in artifact-creation tool (`artifact__create`).
//!
//! An agent-callable tool that writes a generated file (pptx, xlsx, csv, pdf,
//! html, png, …) into a Space as a first-class `kind='file'` document. When no
//! `space_id` is given the file lands in the default, undeletable **Artifacts**
//! system space. This is what lets the flagship `ryu` agent and any ACP agent
//! "create artifacts" — the bytes go to the content-addressed blob store and the
//! doc becomes retrievable via RAG and downloadable at
//! `/api/spaces/{space}/documents/{doc}/blob`.
//!
//! Registered as a reserved registry server (`artifact`) like `notify`/`ui`, so
//! the `<server>__<tool>` id scheme, per-agent allowlist, and single `call_tool`
//! entry all work for free. Content is provided as `data_base64` (binary) or
//! `text` (utf-8). A bare built-in cannot serve a `ui://` widget preview, so the
//! result carries a blob URL + a markdown link/image instead.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::server::spaces::SpaceStore;

/// Reserved registry server name for the built-in artifact provider.
pub const SERVER_NAME: &str = "artifact";

/// Default Space that receives artifacts when the caller omits `space_id`.
const ARTIFACTS_SPACE_NAME: &str = "Artifacts";

/// Upper bound on a single artifact's decoded size (200 MiB). Mirrors the HTTP
/// `create_file` route's cap so the tool and the API agree.
const MAX_ARTIFACT_BYTES: usize = 200 * 1024 * 1024;

fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "space_id": {
                "type": "string",
                "description": "Target Space id. Omit to file into the default Artifacts space."
            },
            "title": {
                "type": "string",
                "description": "File name / title, e.g. \"Q3 deck.pptx\"."
            },
            "mime": {
                "type": "string",
                "description": "MIME type, e.g. application/pdf, image/png, text/csv, \
                    application/vnd.openxmlformats-officedocument.presentationml.presentation."
            },
            "data_base64": {
                "type": "string",
                "description": "Standard base64 of the file bytes. Provide this OR `text`."
            },
            "text": {
                "type": "string",
                "description": "UTF-8 text content (for html/csv/txt/svg). Provide this OR `data_base64`."
            }
        },
        "required": ["title", "mime"]
    })
}

/// The artifact tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__create"),
        server: SERVER_NAME.to_owned(),
        name: "create".to_owned(),
        description: Some(
            "Create a file artifact (pptx, xlsx, csv, pdf, html, png, …) and save it into a \
             Space (defaults to the Artifacts space). Provide bytes via `data_base64` or text \
             via `text`. Returns the document id and a download URL."
                .to_owned(),
        ),
        input_schema: Some(create_schema()),
        ..Default::default()
    }]
}

/// Dispatch an artifact tool call. `spaces` is `None` in test/CLI contexts that
/// don't wire the store; the tool then reports itself unavailable rather than
/// failing the whole call. `Err` only for a malformed call (unknown tool, missing
/// title/mime, no content, or bad base64).
pub async fn dispatch(tool: &str, arguments: Value, spaces: Option<&SpaceStore>) -> Result<Value> {
    match tool {
        "create" => {
            let title = arguments
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'title'"))?;
            let mime = arguments
                .get("mime")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'mime'"))?;

            // Resolve content: data_base64 (binary) takes precedence over text.
            let bytes: Vec<u8> = if let Some(b64) = arguments.get("data_base64").and_then(Value::as_str)
            {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(b64.as_bytes())
                    .map_err(|e| anyhow::anyhow!("invalid base64 in 'data_base64': {e}"))?
            } else if let Some(text) = arguments.get("text").and_then(Value::as_str) {
                text.as_bytes().to_vec()
            } else {
                return Err(anyhow::anyhow!(
                    "artifact requires content: provide 'data_base64' or 'text'"
                ));
            };

            if bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(anyhow::anyhow!(
                    "artifact exceeds {MAX_ARTIFACT_BYTES} byte limit"
                ));
            }

            let Some(store) = spaces else {
                return Ok(json!({
                    "ok": false,
                    "available": false,
                    "error": "spaces store not wired in this context"
                }));
            };

            // Resolve the target space: explicit id, else the default Artifacts space.
            let space_id = match arguments.get("space_id").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id.trim().to_owned(),
                _ => store
                    .ensure_system_space(ARTIFACTS_SPACE_NAME, Some("Files created by Ryu and agents"))
                    .await
                    .map_err(|e| anyhow::anyhow!("resolving Artifacts space: {e}"))?,
            };

            let byte_size = bytes.len();
            let doc_id = store
                .create_file(&space_id, title, &bytes, mime)
                .await
                .map_err(|e| anyhow::anyhow!("saving artifact: {e}"))?;

            let url = format!("/api/spaces/{space_id}/documents/{doc_id}/blob");
            // A small markdown rendering so a chat surface can show a link/image.
            let markdown = if mime.starts_with("image/") {
                format!("![{title}]({url})")
            } else {
                format!("[{title}]({url})")
            };
            Ok(json!({
                "ok": true,
                "id": doc_id,
                "space_id": space_id,
                "mime": mime,
                "byte_size": byte_size,
                "url": url,
                "content": [{ "type": "text", "text": markdown }],
            }))
        }
        other => Err(anyhow::anyhow!("unknown artifact tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_create_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "artifact__create");
        assert_eq!(tools[0].server, SERVER_NAME);
        assert!(tools[0].input_schema.is_some());
    }

    #[tokio::test]
    async fn missing_title_is_an_error() {
        assert!(dispatch("create", json!({ "mime": "text/csv", "text": "a,b" }), None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn no_content_is_an_error() {
        let store = SpaceStore::open_in_memory().unwrap();
        assert!(
            dispatch("create", json!({ "title": "x", "mime": "text/csv" }), Some(&store))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn unavailable_without_store() {
        let out = dispatch(
            "create",
            json!({ "title": "x", "mime": "text/csv", "text": "a,b" }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["available"], json!(false));
    }

    #[tokio::test]
    async fn round_trips_text_into_default_artifacts_space() {
        let store = SpaceStore::open_in_memory().unwrap();
        let out = dispatch(
            "create",
            json!({ "title": "notes.csv", "mime": "text/csv", "text": "a,b\n1,2" }),
            Some(&store),
        )
        .await
        .unwrap();
        assert_eq!(out["ok"], json!(true));
        let doc_id = out["id"].as_str().unwrap();
        let (mime, bytes) = store.read_file_blob(doc_id).await.unwrap().unwrap();
        assert_eq!(mime, "text/csv");
        assert_eq!(bytes, b"a,b\n1,2");
        // Landed in a system Artifacts space.
        let spaces = store.list_spaces().await.unwrap();
        assert!(spaces.iter().any(|s| s.name == ARTIFACTS_SPACE_NAME));
    }

    #[tokio::test]
    async fn round_trips_base64_binary() {
        use base64::Engine as _;
        let store = SpaceStore::open_in_memory().unwrap();
        let png = b"\x89PNG\r\n\x1a\n payload";
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let out = dispatch(
            "create",
            json!({ "title": "chart.png", "mime": "image/png", "data_base64": b64 }),
            Some(&store),
        )
        .await
        .unwrap();
        let doc_id = out["id"].as_str().unwrap();
        let (_mime, bytes) = store.read_file_blob(doc_id).await.unwrap().unwrap();
        assert_eq!(bytes, png);
        // Image renders as a markdown image link.
        assert!(out["content"][0]["text"].as_str().unwrap().starts_with("!["));
    }
}
