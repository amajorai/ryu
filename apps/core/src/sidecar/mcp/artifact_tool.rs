//! Built-in artifact tools (`artifact.create` / `artifact.render`).
//!
//! `artifact.create` writes a generated file (pptx, xlsx, csv, pdf, html, png,
//! …) into a Space as a first-class `kind='file'` document. When no `space_id`
//! is given the file lands in the default, undeletable **Artifacts** system
//! space. This is what lets the flagship `ryu` agent and any ACP agent "create
//! artifacts" — the bytes go to the content-addressed blob store and the doc
//! becomes retrievable via RAG and downloadable at
//! `/api/spaces/{space}/documents/{doc}/blob`.
//!
//! `artifact.render` is the **client-rendered, no-op** half (mirroring
//! `ui.render`): the agent sends a small artifact payload (code file, page,
//! database, space doc, …) and the desktop renders it as a live card inline in
//! the chat, with "Open" (right dock) / "Open in tab" (workspace tab)
//! affordances. Core does not execute anything — dispatch only sanity-checks the
//! shape and acknowledges.
//!
//! Set `placement` to `turn-end` to keep the completed artifact card after the
//! assistant's tool work; the default is `inline`.
//!
//! Registered as a reserved registry server (`artifact`) like `notify`/`ui`, so
//! the `<server>.<tool>` id scheme, per-agent allowlist, and single `call_tool`
//! entry all work for free. Content is provided as `data_base64` (binary) or
//! `text` (utf-8). A bare built-in cannot serve a `ui://` widget preview, so the
//! create result carries a blob URL + a markdown link/image instead.

use anyhow::Result;
use serde_json::{json, Value};

use super::spaces_tool::{owner_for_principal, require_space_access};
use super::{RegistryTool, ToolPrincipal};
use crate::server::spaces::SpaceStore;

/// Reserved registry server name for the built-in artifact provider.
pub const SERVER_NAME: &str = "artifact";

/// Default Space that receives artifacts when the caller omits `space_id`.
const ARTIFACTS_SPACE_NAME: &str = "Artifacts";

/// Upper bound on a single artifact's decoded size (200 MiB). Mirrors the HTTP
/// `create_file` route's cap so the tool and the API agree.
const MAX_ARTIFACT_BYTES: usize = 200 * 1024 * 1024;

/// The kinds `artifact.render` accepts. Must stay in sync with the desktop's
/// `ArtifactKind` union (`apps/desktop/src/lib/artifacts.ts`); anything unknown
/// collapses to a code card on the client, so the allowlist here is the
/// contract the model is trained against.
const RENDER_KINDS: &[&str] = &[
    "html", "svg", "mermaid", "code", "file", "space", "database",
];

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

fn render_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "artifact": {
                "type": "object",
                "description": "The artifact to render inline in the chat: \
                    { kind, title, content, language?, filePath?, actions? }. \
                    `kind` is one of html/svg/mermaid/code/file/space/database; \
                    `content` is the body (HTML/SVG source, mermaid DSL, code, \
                    markdown, or tabular JSON/CSV); `actions` is an optional \
                    list of { id, label, tone? } approval-style choices rendered \
                    with the app's own approval component."
            },
            "title": {
                "type": "string",
                "description": "Optional heading shown above the rendered artifact card."
            },
            "placement": {
                "type": "string",
                "enum": ["inline", "turn-end"],
                "description": "Render inline in the tool row (default) or once at the end of the completed assistant turn."
            }
        },
        "required": ["artifact"]
    })
}

/// The artifact tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}.create"),
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
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.render"),
            server: SERVER_NAME.to_owned(),
            name: "render".to_owned(),
            description: Some(
                "Render an artifact inline in the chat (a code file, a web page, a diagram, a \
                 Space document, or a database table). Pass the payload as `artifact` \
                 ({ kind, title, content, language?, filePath?, actions? }); the client draws it \
                 as a card the user can open in the side panel or a workspace tab. This tool \
                 stores nothing — for a persisted file artifact use `artifact.create`.\n\n\
                 Use kind `html` for answers the ui.render catalog can't express: custom \
                 visualizations (treemaps, heatmaps, annotated charts), interactive explainers, \
                 small games, or mocks of a product screen. html/svg/mermaid render at full \
                 width and their natural height (up to ~960px, then the frame scrolls), so \
                 size the page to its content rather than to the viewport.\n\n\
                 The page runs in a sandbox with no network: inline all CSS, JS and data \
                 (embed datasets as JSON in a <script>; draw large ones on a <canvas>). \
                 The app's theme is available as CSS variables that follow light/dark mode: \
                 --background, --foreground, --card, --muted, --muted-foreground, --border, \
                 --primary, --primary-foreground, --accent, --destructive, --radius, \
                 --chart-1 … --chart-5, --font-sans and --font-mono. Use them instead of \
                 hard-coded colors so the page looks native in both themes. An HTML fragment \
                 gets a themed body; a full document keeps its own styles.\n\n\
                 To keep page state (a game score, ticked items, form input) across reloads, \
                 call window.ryu.state.set(obj) with a plain JSON object (up to 63KB as UTF-8 \
                 JSON, at most 31 levels deep; set() throws a RangeError beyond that) whenever \
                 it changes, and start from window.ryu.state.get() (null on first load). The \
                 state of the page's card in the chat is saved with the conversation, and \
                 ui.get_state returns it under this tool call's id (kind \"artifact\") so you can \
                 see what the user did. Opening the page in the side panel or a tab shows a \
                 fresh copy whose changes are not saved. localStorage and cookies are \
                 unavailable in the sandbox."
                    .to_owned(),
            ),
            input_schema: Some(render_schema()),
            ..Default::default()
        },
    ]
}

/// Dispatch an artifact tool call. `spaces` is `None` in test/CLI contexts that
/// don't wire the store; the tool then reports itself unavailable rather than
/// failing the whole call. `Err` only for a malformed call (unknown tool, missing
/// title/mime, no content, or bad base64).
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    spaces: Option<&SpaceStore>,
    principal: &ToolPrincipal,
) -> Result<Value> {
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
            let bytes: Vec<u8> =
                if let Some(b64) = arguments.get("data_base64").and_then(Value::as_str) {
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
            if principal.is_unresolved() {
                return Err(anyhow::anyhow!(
                    "Spaces are unavailable: this agent turn has no identifiable owner on a shared node"
                ));
            }

            // Resolve the target space: explicit id, else the default Artifacts space.
            let space_id = match arguments.get("space_id").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id.trim().to_owned(),
                _ => store
                    .ensure_system_space(
                        ARTIFACTS_SPACE_NAME,
                        Some("Files created by Ryu and agents"),
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("resolving Artifacts space: {e}"))?,
            };
            require_space_access(store, principal, &space_id, true, true)
                .await
                .map_err(|e| anyhow::anyhow!("artifact Space access denied: {e}"))?;

            let byte_size = bytes.len();
            // Attribute the document to the server-derived principal. An explicit
            // Space cannot use the old background-owner fallback to cross an ACL.
            // Shared ingest path, so an agent-generated .docx/.pdf artifact is
            // retrievable by what is IN it and not merely by its filename. The MCP
            // registry holds a `SpaceStore` but no `ServerState`, so the detached
            // variant borrows the published handle and — when there is none (test /
            // CLI) — still stores the file and says extraction was never attempted.
            let created = crate::space_file_index::create_file_indexed_detached(
                store,
                &space_id,
                title,
                &bytes,
                mime,
                &owner_for_principal(principal),
            )
            .await
            .map_err(|e| anyhow::anyhow!("saving artifact: {e}"))?;
            let doc_id = created.document_id;

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
                // Whether the artifact's CONTENTS made it into the Space index, so
                // the calling agent can tell "saved and searchable" from "saved, but
                // nothing here can read this format".
                "index": created.index.to_json(),
                "content": [{ "type": "text", "text": markdown }],
            }))
        }
        "render" => render_dispatch(arguments).await,
        other => Err(anyhow::anyhow!("unknown artifact tool '{other}'")),
    }
}

/// Dispatch an `artifact.render` call. Client-rendered by design — the desktop
/// draws the card from the tool input, so Core only sanity-checks the payload and
/// acknowledges, giving the model useful feedback for an obviously malformed call.
async fn render_dispatch(arguments: Value) -> Result<Value> {
    let artifact = arguments
        .get("artifact")
        .ok_or_else(|| anyhow::anyhow!("missing required object argument 'artifact'"))?;
    let obj = artifact
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("'artifact' must be an object"))?;
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("'artifact.kind' must be a string"))?;
    if !RENDER_KINDS.contains(&kind) {
        return Err(anyhow::anyhow!(
            "'artifact.kind' must be one of {RENDER_KINDS:?}, got '{kind}'"
        ));
    }
    if !obj.get("content").is_some_and(Value::is_string) {
        return Err(anyhow::anyhow!(
            "'artifact.content' must be a string (the artifact body)"
        ));
    }
    Ok(json!({ "ok": true, "rendered": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal() -> ToolPrincipal {
        ToolPrincipal::Unrestricted
    }

    #[test]
    fn lists_create_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].id, "artifact.create");
        assert_eq!(tools[0].server, SERVER_NAME);
        assert!(tools[0].input_schema.is_some());
        assert_eq!(tools[1].id, "artifact.render");
        assert_eq!(tools[1].server, SERVER_NAME);
        assert!(tools[1].input_schema.is_some());
        assert_eq!(
            tools[1].input_schema.as_ref().unwrap()["properties"]["placement"]["enum"],
            json!(["inline", "turn-end"])
        );
    }

    #[tokio::test]
    async fn missing_title_is_an_error() {
        assert!(dispatch(
            "create",
            json!({ "mime": "text/csv", "text": "a,b" }),
            None,
            &principal()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn no_content_is_an_error() {
        let store = SpaceStore::open_in_memory().unwrap();
        assert!(dispatch(
            "create",
            json!({ "title": "x", "mime": "text/csv" }),
            Some(&store),
            &principal()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn unavailable_without_store() {
        let out = dispatch(
            "create",
            json!({ "title": "x", "mime": "text/csv", "text": "a,b" }),
            None,
            &principal(),
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
            &principal(),
        )
        .await
        .unwrap();
        assert_eq!(out["ok"], json!(true));
        let doc_id = out["id"].as_str().unwrap();
        let (mime, bytes) = store.read_file_blob(doc_id).await.unwrap().unwrap();
        assert_eq!(mime, "text/csv");
        assert_eq!(bytes, b"a,b\n1,2");
        // Landed in a system Artifacts space.
        let spaces = store
            .list_spaces(crate::server::spaces::DocFilter::unrestricted())
            .await
            .unwrap();
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
            &principal(),
        )
        .await
        .unwrap();
        let doc_id = out["id"].as_str().unwrap();
        let (_mime, bytes) = store.read_file_blob(doc_id).await.unwrap().unwrap();
        assert_eq!(bytes, png);
        // Image renders as a markdown image link.
        assert!(out["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("!["));
    }

    #[tokio::test]
    async fn render_acknowledges_a_valid_payload() {
        let out = dispatch(
            "render",
            json!({
                "artifact": {
                    "kind": "database",
                    "title": "Q3 numbers",
                    "content": "[{\"a\":1,\"b\":2}]",
                    "language": "json",
                    "actions": [{ "id": "ok", "label": "Looks good", "tone": "primary" }]
                }
            }),
            None,
            &principal(),
        )
        .await
        .expect("dispatch ok");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    }

    #[tokio::test]
    async fn render_missing_artifact_is_an_error() {
        assert!(
            dispatch("render", json!({ "title": "x" }), None, &principal())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn render_unknown_kind_is_an_error() {
        assert!(dispatch(
            "render",
            json!({ "artifact": { "kind": "banana", "content": "x" } }),
            None,
            &principal()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn render_non_string_content_is_an_error() {
        assert!(dispatch(
            "render",
            json!({ "artifact": { "kind": "code", "content": 42 } }),
            None,
            &principal()
        )
        .await
        .is_err());
    }
}
