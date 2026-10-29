//! Notion-style imports for editable Space pages and databases.
//!
//! File bytes are converted through Core's existing `document.parse` facade, while
//! delimited text is mapped directly into the database grid schema. Composio imports
//! are intentionally read-only: the action is catalog-verified and screened before
//! execution, then its result follows the same page/database creation path.
//! Connector imports ([`connectors`]) read Notion, Google Drive, Confluence, GitHub,
//! and web URLs natively with a vault-held credential and feed the same pipeline.

use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    path::Path as FilePath,
    time::Duration,
};

use super::spaces::{DocOwner, SpaceImportResultDocument};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::ServerState;

mod connectors;
mod html_markdown;
#[cfg(test)]
mod routes_test;

const MAX_ARCHIVE_ENTRIES: usize = 1_000;
const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DATABASE_ROWS: usize = 25_000;
const MAX_DATABASE_COLUMNS: usize = 200;
const PARSE_POLL_LIMIT: usize = 240;

pub(super) fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/spaces/:id/imports", get(list_imports))
        .route(
            "/api/spaces/:id/imports/files",
            super::uploads::SPACE_FILE_BODY_LIMIT.apply(post(import_file)),
        )
        .route("/api/spaces/:id/imports/composio", post(import_composio))
        .route("/api/spaces/:id/imports/connector", post(import_connector))
}

#[derive(Debug, Deserialize)]
struct FileImportBody {
    title: String,
    #[serde(default)]
    mime: Option<String>,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
struct ComposioImportBody {
    toolkit: String,
    action: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    destination_kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Clone)]
struct ImportSource {
    name: String,
    mime: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImportKind {
    Page,
    Database,
    Archive,
}

async fn list_imports(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(space_id): Path<String>,
) -> Response {
    if super::enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
        crate::acl::KIND_SPACE,
        &space_id,
    )
    .await
    .is_err()
    {
        return super::json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    if let Err(response) = super::require_resource_read(
        super::spaces::space_access_meta(&state.spaces, &space_id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return response;
    }
    match state.spaces.list_imports(&space_id, 100).await {
        Ok(imports) => Json(json!({ "space_id": space_id, "imports": imports })).into_response(),
        Err(error) => super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn import_file(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(space_id): Path<String>,
    Json(body): Json<FileImportBody>,
) -> Response {
    if let Err(response) = require_import_write(&state, &caller, &space_id).await {
        return response;
    }
    let title = body.title.trim();
    if title.is_empty() {
        return super::json_error(StatusCode::BAD_REQUEST, "file name is required".to_owned());
    }
    let Some(kind) = import_kind(title) else {
        return super::json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!(
                "{} is not a supported import format",
                display_extension(title)
            ),
        );
    };
    if super::uploads::decoded_len_lower_bound(body.data_base64.len())
        > super::uploads::MAX_UPLOAD_BYTES
    {
        return super::json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            super::uploads::SPACE_FILE_BODY_LIMIT
                .too_large_message(super::uploads::Observed::BodyBytes(body.data_base64.len())),
        );
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(body.data_base64.as_bytes())
    {
        Ok(bytes) => bytes,
        Err(error) => {
            return super::json_error(StatusCode::BAD_REQUEST, format!("invalid base64: {error}"));
        }
    };
    if bytes.len() > super::uploads::MAX_UPLOAD_BYTES {
        return super::json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            super::uploads::SPACE_FILE_BODY_LIMIT
                .too_large_message(super::uploads::Observed::FileBytes(bytes.len())),
        );
    }
    let format = extension(title).unwrap_or("unknown");
    let destination = match kind {
        ImportKind::Page => "page",
        ImportKind::Database => "database",
        ImportKind::Archive => "mixed",
    };
    let record = match state
        .spaces
        .create_import_record(
            &space_id,
            "file",
            title,
            format,
            destination,
            bytes.len() as i64,
        )
        .await
    {
        Ok(record) => record,
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let source = ImportSource {
        name: title.to_owned(),
        mime: body
            .mime
            .as_deref()
            .map(str::trim)
            .filter(|mime| !mime.is_empty())
            .unwrap_or_else(|| mime_for_name(title))
            .to_owned(),
        bytes,
    };
    let import_id = record.id.clone();
    let owner = super::spaces::owner_of(&super::caller_tenancy(&caller));
    tokio::spawn(async move {
        run_file_import(state, space_id, import_id, source, owner).await;
    });
    (StatusCode::ACCEPTED, Json(json!({ "import": record }))).into_response()
}

async fn import_composio(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(space_id): Path<String>,
    Json(body): Json<ComposioImportBody>,
) -> Response {
    if let Err(response) = require_import_write(&state, &caller, &space_id).await {
        return response;
    }
    let toolkit = body.toolkit.trim().to_lowercase();
    let action = body.action.trim().to_uppercase();
    if toolkit.is_empty() || action.is_empty() {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "toolkit and action are required".to_owned(),
        );
    }
    if let Err(error) = verify_composio_action(&state, &toolkit, &action).await {
        return super::json_error(StatusCode::BAD_REQUEST, error);
    }
    let requested_destination = body
        .destination_kind
        .as_deref()
        .unwrap_or("auto")
        .to_owned();
    if !matches!(requested_destination.as_str(), "auto" | "page" | "database") {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "destination_kind must be auto, page, or database".to_owned(),
        );
    }
    let source_name = body
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| humanize_action(&action));
    let record = match state
        .spaces
        .create_import_record(
            &space_id,
            "composio",
            &source_name,
            &toolkit,
            &requested_destination,
            0,
        )
        .await
    {
        Ok(record) => record,
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let import_id = record.id.clone();
    let user_id = caller.as_ref().map(|identity| identity.user_id.clone());
    let owner = super::spaces::owner_of(&super::caller_tenancy(&caller));
    tokio::spawn(async move {
        run_composio_import(
            state,
            space_id,
            import_id,
            source_name,
            action,
            body.arguments,
            requested_destination,
            user_id,
            owner,
        )
        .await;
    });
    (StatusCode::ACCEPTED, Json(json!({ "import": record }))).into_response()
}

/// `POST /api/spaces/:id/imports/connector` — import from Notion, Google Drive,
/// Confluence, GitHub, or web URLs. The credential is a vault reference resolved
/// for the caller before the job starts, so a missing or unreadable secret is a
/// 400 here rather than a failed import later.
async fn import_connector(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(space_id): Path<String>,
    Json(body): Json<connectors::ConnectorImportBody>,
) -> Response {
    if let Err(response) = require_import_write(&state, &caller, &space_id).await {
        return response;
    }
    let request = match connectors::validate(body) {
        Ok(request) => request,
        Err(error) => return super::json_error(StatusCode::BAD_REQUEST, error),
    };
    let credential = match request.credential_ref.as_deref() {
        Some(reference) => match connectors::resolve_credential(caller.as_ref(), reference).await {
            Ok(credential) => Some(credential),
            Err(error) => return super::json_error(StatusCode::BAD_REQUEST, error),
        },
        None => None,
    };
    let record = match state
        .spaces
        .create_import_record(
            &space_id,
            "connector",
            &request.label,
            request.provider.as_str(),
            "auto",
            0,
        )
        .await
    {
        Ok(record) => record,
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let import_id = record.id.clone();
    let owner = super::spaces::owner_of(&super::caller_tenancy(&caller));
    tokio::spawn(async move {
        run_connector_import(state, space_id, import_id, request, credential, owner).await;
    });
    (StatusCode::ACCEPTED, Json(json!({ "import": record }))).into_response()
}

async fn run_connector_import(
    state: ServerState,
    space_id: String,
    import_id: String,
    request: connectors::ConnectorRequest,
    credential: Option<connectors::ConnectorCredential>,
    owner: DocOwner,
) {
    if let Err(error) = state.spaces.start_import(&import_id).await {
        tracing::warn!(import_id, "cannot start import: {error:#}");
        return;
    }
    let fetched =
        connectors::fetch_sources(&connectors::GuardedHttp, &request, credential.as_ref()).await;
    let result = match fetched {
        Ok(fetched) => {
            let skipped = fetched.failures;
            if fetched.sources.is_empty() {
                Err(if skipped.is_empty() {
                    "the connector returned nothing to import".to_owned()
                } else {
                    skipped.join("; ")
                })
            } else {
                import_many(&state, &space_id, fetched.sources, &owner)
                    .await
                    .map_err(|error| {
                        // Keep the fetch failures too: they are why fewer sources
                        // reached the pipeline than the request named.
                        if skipped.is_empty() {
                            error
                        } else {
                            format!("{error}; {}", skipped.join("; "))
                        }
                    })
                    .map(|(destination, documents, count, message)| {
                        let message = match (message, skipped.is_empty()) {
                            (message, true) => message,
                            (Some(message), false) => {
                                Some(format!("{message}; {}", skipped.join("; ")))
                            }
                            (None, false) => Some(format!("Skipped {}", skipped.join("; "))),
                        };
                        (destination, documents, count, message)
                    })
            }
        }
        Err(error) => Err(error),
    };
    finish_import(&state, &import_id, result).await;
}

async fn require_import_write(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    space_id: &str,
) -> Result<(), Response> {
    if super::enforce_permission_on(
        state,
        caller,
        crate::identity_verify::permissions::SPACE_WRITE,
        crate::acl::KIND_SPACE,
        space_id,
    )
    .await
    .is_err()
    {
        return Err(super::json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        ));
    }
    super::require_space_content_write(state, caller, space_id, "space not found").await
}

async fn run_file_import(
    state: ServerState,
    space_id: String,
    import_id: String,
    source: ImportSource,
    owner: DocOwner,
) {
    if let Err(error) = state.spaces.start_import(&import_id).await {
        tracing::warn!(import_id, "cannot start import: {error:#}");
        return;
    }
    let result = if import_kind(&source.name) == Some(ImportKind::Archive) {
        match extract_archive(&source.bytes) {
            Ok(sources) => import_many(&state, &space_id, sources, &owner).await,
            Err(error) => Err(error),
        }
    } else {
        import_many(&state, &space_id, vec![source], &owner).await
    };
    finish_import(&state, &import_id, result).await;
}

async fn run_composio_import(
    state: ServerState,
    space_id: String,
    import_id: String,
    title: String,
    action: String,
    arguments: Value,
    requested_destination: String,
    user_id: Option<String>,
    owner: DocOwner,
) {
    if let Err(error) = state.spaces.start_import(&import_id).await {
        tracing::warn!(import_id, "cannot start import: {error:#}");
        return;
    }
    let result = match crate::sidecar::mcp::composio::dispatch(
        &state.client,
        &action,
        arguments,
        user_id.as_deref(),
    )
    .await
    {
        Ok(output) => match composio_import_output(output) {
            Ok(output) => {
                // The action already executed. Accounting failure must not replay it
                // or persist its transport envelope as imported content.
                if let Err(error) = crate::sidecar::gateway::record_tool_charge(
                    &state.client,
                    None,
                    user_id.as_deref(),
                    None,
                    1,
                    output.billing.as_ref().and_then(|receipt| receipt.as_ref()),
                    matches!(output.billing, Some(None)),
                )
                .await
                {
                    tracing::warn!(import_id, error = %error, "Space import Composio charge notification failed");
                }
                import_composio_value(
                    &state,
                    &space_id,
                    &title,
                    &requested_destination,
                    output.data,
                    &owner,
                )
                .await
            }
            Err(error) => Err(error),
        },
        Err(error) => {
            // Composio bills a failure it logged; charge that receipt and still
            // fail the import with the same message.
            if let Some(receipt) = ryu_composio::service::failed_execution_receipt(&error) {
                if let Err(charge_error) = crate::sidecar::gateway::record_tool_charge(
                    &state.client,
                    None,
                    user_id.as_deref(),
                    None,
                    1,
                    Some(receipt),
                    false,
                )
                .await
                {
                    tracing::warn!(import_id, error = %charge_error, "Space import Composio charge notification failed");
                }
            }
            Err(error.to_string())
        }
    };
    finish_import(&state, &import_id, result).await;
}

struct ComposioImportOutput {
    data: Value,
    billing: Option<Option<ryu_composio::receipt::ComposioReceipt>>,
}

fn composio_import_output(mut output: Value) -> Result<ComposioImportOutput, String> {
    let billing = crate::sidecar::mcp::composio::take_receipt(&mut output);
    if let Some(elicitation) = output.get("__ryu_elicitation__") {
        let message = elicitation
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Composio connection required");
        let suffix = elicitation
            .get("url")
            .and_then(Value::as_str)
            .map(|url| format!(" Connect: {url}"))
            .unwrap_or_default();
        return Err(format!("{message}{suffix}"));
    }
    Ok(ComposioImportOutput {
        data: output,
        billing,
    })
}

async fn finish_import(
    state: &ServerState,
    import_id: &str,
    result: Result<
        (
            String,
            Vec<SpaceImportResultDocument>,
            usize,
            Option<String>,
        ),
        String,
    >,
) {
    match result {
        Ok((destination, documents, item_count, message)) => {
            if let Err(error) = state
                .spaces
                .complete_import(
                    import_id,
                    &destination,
                    &documents,
                    item_count as i64,
                    message.as_deref(),
                )
                .await
            {
                tracing::warn!(import_id, "cannot complete import history: {error:#}");
            }
        }
        Err(message) => {
            if let Err(error) = state.spaces.fail_import(import_id, &message).await {
                tracing::warn!(import_id, "cannot fail import history: {error:#}");
            }
        }
    }
}

async fn import_many(
    state: &ServerState,
    space_id: &str,
    sources: Vec<ImportSource>,
    owner: &DocOwner,
) -> Result<
    (
        String,
        Vec<SpaceImportResultDocument>,
        usize,
        Option<String>,
    ),
    String,
> {
    let mut documents = Vec::new();
    let mut failures = Vec::new();
    let mut item_count = 0;
    for source in sources {
        match import_one(state, space_id, &source, owner).await {
            Ok((mut created, rows)) => {
                documents.append(&mut created);
                item_count += rows;
            }
            Err(error) => failures.push(format!("{}: {error}", source.name)),
        }
    }
    if documents.is_empty() {
        return Err(failures.join("; "));
    }
    let destination = if documents.iter().all(|document| document.kind == "page") {
        "page"
    } else if documents.iter().all(|document| document.kind == "database") {
        "database"
    } else {
        "mixed"
    };
    let message = (!failures.is_empty()).then(|| format!("Skipped {}", failures.join("; ")));
    Ok((destination.to_owned(), documents, item_count, message))
}

async fn import_one(
    state: &ServerState,
    space_id: &str,
    source: &ImportSource,
    owner: &DocOwner,
) -> Result<(Vec<SpaceImportResultDocument>, usize), String> {
    match import_kind(&source.name) {
        Some(ImportKind::Database) if is_delimited(&source.name) => {
            let delimiter = delimiter_for(&source.name, &source.bytes);
            let (rows, row_count) = parse_delimited(&source.bytes, delimiter)?;
            let document = create_database_document(
                state,
                space_id,
                &title_from_filename(&source.name),
                rows,
                owner,
            )
            .await?;
            Ok((vec![document], row_count))
        }
        Some(ImportKind::Database) => {
            let markdown = parse_document(state, source).await?;
            let tables = markdown_tables(&markdown);
            if tables.is_empty() {
                return Err("the spreadsheet parser returned no tables".to_owned());
            }
            let multiple = tables.len() > 1;
            let mut documents = Vec::with_capacity(tables.len());
            let mut count = 0;
            for (index, table) in tables.into_iter().enumerate() {
                count += table.len().saturating_sub(1);
                let title = if multiple {
                    format!("{} {}", title_from_filename(&source.name), index + 1)
                } else {
                    title_from_filename(&source.name)
                };
                documents
                    .push(create_database_document(state, space_id, &title, table, owner).await?);
            }
            Ok((documents, count))
        }
        Some(ImportKind::Page) => {
            let markdown = parse_document(state, source).await?;
            let title = title_from_filename(&source.name);
            let id = state
                .spaces
                .create_page(space_id, &title, owner)
                .await
                .map_err(|error| error.to_string())?;
            state
                .spaces
                .update_document(&id, &title, &markdown)
                .await
                .map_err(|error| error.to_string())?;
            Ok((
                vec![SpaceImportResultDocument {
                    id,
                    kind: "page".to_owned(),
                    title,
                }],
                1,
            ))
        }
        Some(ImportKind::Archive) => Err("nested ZIP archives are not supported".to_owned()),
        None => Err("unsupported import format".to_owned()),
    }
}

async fn parse_document(state: &ServerState, source: &ImportSource) -> Result<String, String> {
    let store = state.spaces.clone();
    let bytes = source.bytes.clone();
    let sha = tokio::task::spawn_blocking(move || store.stage_import_blob(&bytes))
        .await
        .map_err(|error| format!("blob staging task failed: {error}"))?
        .map_err(|error| error.to_string())?;
    match crate::document_parse::submit_blob(
        state,
        &sha,
        &source.name,
        &source.mime,
        source.bytes.len() as u64,
    )
    .await
    .map_err(|error| error.to_string())?
    {
        crate::document_parse::ParseSubmission::Done(outcome) => Ok(outcome.markdown),
        crate::document_parse::ParseSubmission::Job { job_id, .. } => {
            for _ in 0..PARSE_POLL_LIMIT {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if let Some(outcome) = crate::document_parse::job_outcome(state, &job_id, &sha)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Ok(outcome.markdown);
                }
            }
            crate::document_parse::release_input(&job_id);
            Err("document conversion timed out".to_owned())
        }
    }
}

async fn create_database_document(
    state: &ServerState,
    space_id: &str,
    title: &str,
    rows: Vec<Vec<String>>,
    owner: &DocOwner,
) -> Result<SpaceImportResultDocument, String> {
    let source = database_source(&rows)?;
    let id = state
        .spaces
        .create_database(space_id, title, owner)
        .await
        .map_err(|error| error.to_string())?;
    state
        .spaces
        .update_document(&id, title, &source)
        .await
        .map_err(|error| error.to_string())?;
    Ok(SpaceImportResultDocument {
        id,
        kind: "database".to_owned(),
        title: title.to_owned(),
    })
}

async fn import_composio_value(
    state: &ServerState,
    space_id: &str,
    title: &str,
    requested_destination: &str,
    value: Value,
    owner: &DocOwner,
) -> Result<
    (
        String,
        Vec<SpaceImportResultDocument>,
        usize,
        Option<String>,
    ),
    String,
> {
    let object_rows = find_object_array(&value);
    let use_database = requested_destination == "database"
        || (requested_destination == "auto" && object_rows.is_some());
    if use_database {
        let Some(rows) = object_rows else {
            return Err("the action returned no list of records for a database import".to_owned());
        };
        let table = object_array_to_table(rows)?;
        let count = table.len().saturating_sub(1);
        let document = create_database_document(state, space_id, title, table, owner).await?;
        return Ok(("database".to_owned(), vec![document], count, None));
    }
    let markdown = value_to_markdown(&value);
    let id = state
        .spaces
        .create_page(space_id, title, owner)
        .await
        .map_err(|error| error.to_string())?;
    state
        .spaces
        .update_document(&id, title, &markdown)
        .await
        .map_err(|error| error.to_string())?;
    Ok((
        "page".to_owned(),
        vec![SpaceImportResultDocument {
            id,
            kind: "page".to_owned(),
            title: title.to_owned(),
        }],
        1,
        None,
    ))
}

async fn verify_composio_action(
    state: &ServerState,
    toolkit: &str,
    action: &str,
) -> Result<(), String> {
    let catalog = ryu_composio::catalog::list_actions_with_tags(
        &state.client,
        toolkit,
        action,
        100,
        &["readOnlyHint"],
    )
    .await
    .map_err(|error| format!("cannot read Composio actions: {error}"))?;
    let found = catalog["data"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(action))
                && item["toolkit"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(toolkit))
                && composio_action_has_tag(item, "readOnlyHint")
        })
    });
    if found {
        Ok(())
    } else {
        Err("the selected action is not marked read-only by Composio".to_owned())
    }
}

fn composio_action_has_tag(action: &Value, expected: &str) -> bool {
    action["tags"].as_array().is_some_and(|tags| {
        tags.iter()
            .filter_map(Value::as_str)
            .any(|tag| tag.eq_ignore_ascii_case(expected))
    })
}

fn import_kind(name: &str) -> Option<ImportKind> {
    match extension(name)? {
        "txt" | "text" | "md" | "markdown" | "mdown" | "mkdn" | "mkd" | "rmd" | "html" | "htm"
        | "docx" | "pdf" | "epub" | "opml" => Some(ImportKind::Page),
        "csv" | "tsv" | "dsv" | "xlsx" | "xls" | "ods" => Some(ImportKind::Database),
        "zip" => Some(ImportKind::Archive),
        _ => None,
    }
}

fn extension(name: &str) -> Option<&str> {
    FilePath::new(name)
        .extension()?
        .to_str()
        .map(str::to_ascii_lowercase)
        .map(|value| {
            // The supported extensions are static; returning the matching literal avoids
            // leaking the temporary lowercase allocation.
            match value.as_str() {
                "txt" => "txt",
                "text" => "text",
                "md" => "md",
                "markdown" => "markdown",
                "mdown" => "mdown",
                "mkdn" => "mkdn",
                "mkd" => "mkd",
                "rmd" => "rmd",
                "html" => "html",
                "htm" => "htm",
                "docx" => "docx",
                "pdf" => "pdf",
                "epub" => "epub",
                "opml" => "opml",
                "csv" => "csv",
                "tsv" => "tsv",
                "dsv" => "dsv",
                "xlsx" => "xlsx",
                "xls" => "xls",
                "ods" => "ods",
                "zip" => "zip",
                _ => "unknown",
            }
        })
}

fn display_extension(name: &str) -> String {
    FilePath::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_else(|| "this file".to_owned())
}

fn title_from_filename(name: &str) -> String {
    FilePath::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled import")
        .to_owned()
}

fn mime_for_name(name: &str) -> &'static str {
    match extension(name) {
        Some("txt" | "text") => "text/plain",
        Some("md" | "markdown" | "mdown" | "mkdn" | "mkd" | "rmd") => "text/markdown",
        Some("html" | "htm") => "text/html",
        Some("csv") => "text/csv",
        Some("tsv" | "dsv") => "text/tab-separated-values",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xls") => "application/vnd.ms-excel",
        Some("ods") => "application/vnd.oasis.opendocument.spreadsheet",
        Some("epub") => "application/epub+zip",
        Some("opml") => "text/x-opml",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn extract_archive(bytes: &[u8]) -> Result<Vec<ImportSource>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("invalid ZIP archive: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "ZIP contains more than {MAX_ARCHIVE_ENTRIES} entries"
        ));
    }
    let mut total = 0_u64;
    let mut sources = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let path = entry.enclosed_name().ok_or_else(|| {
            format!(
                "ZIP entry {} has an unsafe path",
                String::from_utf8_lossy(entry.name_raw())
            )
        })?;
        let name = path.to_string_lossy().replace('\\', "/");
        if name.starts_with("__MACOSX/") || name.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        if import_kind(&name).is_none() {
            continue;
        }
        if import_kind(&name) == Some(ImportKind::Archive) {
            return Err(format!("nested ZIP archive {name} is not supported"));
        }
        let mut contents = Vec::with_capacity(entry.size().min(8 * 1024 * 1024) as usize);
        let remaining = MAX_ARCHIVE_EXPANDED_BYTES.saturating_sub(total);
        let entry_limit = if is_delimited(&name) {
            remaining.min(super::uploads::MAX_UPLOAD_BYTES as u64)
        } else {
            remaining
        };
        entry
            .by_ref()
            .take(entry_limit.saturating_add(1))
            .read_to_end(&mut contents)
            .map_err(|error| error.to_string())?;
        if is_delimited(&name) && contents.len() > super::uploads::MAX_UPLOAD_BYTES {
            return Err(format!(
                "delimited ZIP member {name} exceeds the upload size limit"
            ));
        }
        if contents.len() as u64 > remaining {
            return Err("expanded ZIP content is over the 256 MB limit".to_owned());
        }
        total += contents.len() as u64;
        sources.push(ImportSource {
            mime: mime_for_name(&name).to_owned(),
            name,
            bytes: contents,
        });
    }
    if sources.is_empty() {
        Err("ZIP contains no supported import files".to_owned())
    } else {
        Ok(sources)
    }
}

fn is_delimited(name: &str) -> bool {
    matches!(extension(name), Some("csv" | "tsv" | "dsv"))
}

fn delimiter_for(name: &str, bytes: &[u8]) -> u8 {
    match extension(name) {
        Some("tsv") => b'\t',
        Some("csv") => b',',
        _ => detect_delimiter(bytes),
    }
}

fn detect_delimiter(bytes: &[u8]) -> u8 {
    let line = bytes
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    [b',', b'\t', b';', b'|']
        .into_iter()
        .max_by_key(|delimiter| line.iter().filter(|byte| **byte == *delimiter).count())
        .unwrap_or(b',')
}

fn parse_delimited(bytes: &[u8], delimiter: u8) -> Result<(Vec<Vec<String>>, usize), String> {
    if bytes.len() > super::uploads::MAX_UPLOAD_BYTES {
        return Err("delimited file exceeds the upload size limit".to_owned());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "delimited imports must use UTF-8 text".to_owned())?
        .trim_start_matches('\u{feff}');
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut column_index = 0_usize;
    let mut cell_has_content = false;
    let mut row_nonblank = false;
    let mut data_row_count = 0_usize;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    row_nonblank = true;
                    cell_has_content = true;
                    if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
                        cell.push('"');
                    }
                } else {
                    quoted = false;
                }
            } else {
                row_nonblank |= !character.is_whitespace();
                cell_has_content = true;
                if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
                    cell.push(character);
                }
            }
            continue;
        }
        match character {
            '"' if !cell_has_content => quoted = true,
            value if value as u32 == delimiter as u32 => {
                if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
                    row.push(std::mem::take(&mut cell));
                } else {
                    cell.clear();
                }
                column_index += 1;
                cell_has_content = false;
            }
            '\n' => {
                if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
                    row.push(std::mem::take(&mut cell));
                } else {
                    cell.clear();
                }
                if row_nonblank {
                    if rows.is_empty() {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        data_row_count += 1;
                        if rows.len() <= MAX_DATABASE_ROWS {
                            rows.push(std::mem::take(&mut row));
                        }
                    }
                }
                row.clear();
                column_index = 0;
                cell_has_content = false;
                row_nonblank = false;
            }
            '\r' if chars.peek() == Some(&'\n') => {}
            value => {
                row_nonblank |= !value.is_whitespace();
                cell_has_content = true;
                if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
                    cell.push(value);
                }
            }
        }
    }
    if quoted {
        return Err("delimited file has an unclosed quoted field".to_owned());
    }
    if row_nonblank {
        if rows.len() <= MAX_DATABASE_ROWS && column_index < MAX_DATABASE_COLUMNS {
            row.push(cell);
        }
        if rows.is_empty() {
            rows.push(row);
        } else {
            data_row_count += 1;
            if rows.len() <= MAX_DATABASE_ROWS {
                rows.push(row);
            }
        }
    }
    if rows.is_empty() {
        Err("delimited file is empty".to_owned())
    } else {
        Ok((rows, data_row_count))
    }
}

fn database_source(table: &[Vec<String>]) -> Result<String, String> {
    let Some(header_row) = table.first() else {
        return Err("table has no header row".to_owned());
    };
    if header_row.is_empty() {
        return Err("table has no columns".to_owned());
    }
    let width = header_row.len().min(MAX_DATABASE_COLUMNS);
    let headers = dedupe_headers(&header_row[..width]);
    let data_rows: Vec<&Vec<String>> = table.iter().skip(1).take(MAX_DATABASE_ROWS).collect();
    let variants: Vec<&str> = (0..headers.len())
        .map(|index| infer_cell_variant(&data_rows, index))
        .collect();
    let columns: Vec<Value> = headers
        .iter()
        .enumerate()
        .map(|(index, label)| {
            json!({
                "id": format!("col_{}", index + 1),
                "label": label,
                "cell": { "variant": variants[index] }
            })
        })
        .collect();
    let rows: Vec<Value> = data_rows
        .iter()
        .map(|values| {
            let mut row = Map::new();
            for index in 0..width {
                row.insert(
                    format!("col_{}", index + 1),
                    scalar_cell(
                        values.get(index).map(String::as_str).unwrap_or(""),
                        variants[index],
                    ),
                );
            }
            Value::Object(row)
        })
        .collect();
    serde_json::to_string(&json!({
        "columns": columns,
        "rows": rows,
        "views": [{ "id": "view_table", "name": "Table", "kind": "table" }]
    }))
    .map_err(|error| error.to_string())
}

fn dedupe_headers(headers: &[String]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            let base = if header.trim().is_empty() {
                format!("Column {}", index + 1)
            } else {
                header.trim().to_owned()
            };
            let count = seen.entry(base.clone()).or_default();
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base} {}", *count)
            }
        })
        .collect()
}

fn infer_cell_variant(rows: &[&Vec<String>], index: usize) -> &'static str {
    let values: Vec<&str> = rows
        .iter()
        .filter_map(|row| row.get(index).map(String::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if !values.is_empty()
        && values
            .iter()
            .all(|value| matches!(value.to_ascii_lowercase().as_str(), "true" | "false"))
    {
        "checkbox"
    } else if !values.is_empty() && values.iter().all(|value| value.parse::<f64>().is_ok()) {
        "number"
    } else if !values.is_empty()
        && values
            .iter()
            .all(|value| value.starts_with("https://") || value.starts_with("http://"))
    {
        "url"
    } else if values
        .iter()
        .any(|value| value.chars().count() > 120 || value.contains('\n'))
    {
        "long-text"
    } else {
        "short-text"
    }
}

fn scalar_cell(value: &str, variant: &str) -> Value {
    let trimmed = value.trim();
    if variant == "checkbox" && trimmed.eq_ignore_ascii_case("true") {
        Value::Bool(true)
    } else if variant == "checkbox" && trimmed.eq_ignore_ascii_case("false") {
        Value::Bool(false)
    } else if variant == "number" {
        let Ok(number) = trimmed.parse::<f64>() else {
            return json!(value);
        };
        serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or_else(|| json!(value))
    } else {
        json!(value)
    }
}

fn markdown_tables(markdown: &str) -> Vec<Vec<Vec<String>>> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut tables = Vec::new();
    let mut index = 0;
    while index + 1 < lines.len() {
        let header = split_markdown_row(lines[index]);
        let separator = split_markdown_row(lines[index + 1]);
        if header.len() > 1
            && separator.len() == header.len()
            && separator.iter().all(|cell| {
                let value = cell.trim().trim_matches(':');
                value.len() >= 3 && value.chars().all(|character| character == '-')
            })
        {
            let mut table = vec![header];
            index += 2;
            while index < lines.len() {
                let row = split_markdown_row(lines[index]);
                if row.len() != table[0].len() {
                    break;
                }
                table.push(row);
                index += 1;
            }
            tables.push(table);
            continue;
        }
        index += 1;
    }
    tables
}

fn split_markdown_row(line: &str) -> Vec<String> {
    let trimmed = line.trim().trim_matches('|');
    if !line.contains('|') {
        return Vec::new();
    }
    trimmed
        .split('|')
        .map(|value| value.trim().replace("\\|", "|"))
        .collect()
}

fn find_object_array(value: &Value) -> Option<&[Value]> {
    fn visit<'a>(value: &'a Value, best: &mut Option<&'a [Value]>) {
        match value {
            Value::Array(items) => {
                if !items.is_empty()
                    && items.iter().all(Value::is_object)
                    && best.is_none_or(|current| items.len() > current.len())
                {
                    *best = Some(items);
                }
                for item in items {
                    visit(item, best);
                }
            }
            Value::Object(map) => {
                for child in map.values() {
                    visit(child, best);
                }
            }
            _ => {}
        }
    }
    let mut best = None;
    visit(value, &mut best);
    best
}

fn object_array_to_table(items: &[Value]) -> Result<Vec<Vec<String>>, String> {
    let mut headers = Vec::new();
    let mut seen = HashSet::new();
    for item in items.iter().take(MAX_DATABASE_ROWS) {
        let Some(object) = item.as_object() else {
            continue;
        };
        for key in object.keys() {
            if seen.insert(key.clone()) && headers.len() < MAX_DATABASE_COLUMNS {
                headers.push(key.clone());
            }
        }
    }
    if headers.is_empty() {
        return Err("records have no fields".to_owned());
    }
    let mut table = vec![headers.clone()];
    for item in items.iter().take(MAX_DATABASE_ROWS) {
        let Some(object) = item.as_object() else {
            continue;
        };
        table.push(
            headers
                .iter()
                .map(|header| value_as_cell(object.get(header).unwrap_or(&Value::Null)))
                .collect(),
        );
    }
    Ok(table)
}

fn value_as_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn value_to_markdown(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| {
                format!(
                    "## {}\n\n{}",
                    humanize_action(key),
                    value_to_markdown(value)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Array(items) => items
            .iter()
            .map(|item| format!("- {}", value_as_cell(item)))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => value_as_cell(value),
    }
}

fn humanize_action(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .map(|first| {
                    format!(
                        "{}{}",
                        first.to_uppercase(),
                        characters.as_str().to_lowercase()
                    )
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composio_import_unwraps_receipt_without_importing_billing_metadata() {
        let receipt = ryu_composio::receipt::ComposioReceipt {
            auth_config_id: None,
            connected_account_id: None,
            transaction_id: "execution_123".to_owned(),
            usage: Default::default(),
        };
        let data = json!({"records": [{"title": "Imported page"}]});
        let output = composio_import_output(crate::sidecar::mcp::composio::billing_envelope(
            data.clone(),
            Some(receipt.clone()),
        ))
        .unwrap_or_else(|error| panic!("expected executed data: {error}"));
        assert_eq!(output.data, data);
        assert_eq!(output.billing, Some(Some(receipt)));
    }

    #[test]
    fn composio_import_preserves_unavailable_accounting_and_unmetered_data() {
        let data = json!({"title": "Imported page"});
        let metered = composio_import_output(crate::sidecar::mcp::composio::billing_envelope(
            data.clone(),
            None,
        ))
        .unwrap_or_else(|error| panic!("expected executed data: {error}"));
        assert_eq!(metered.data, data);
        assert_eq!(metered.billing, Some(None));
        let unmetered = composio_import_output(data.clone())
            .unwrap_or_else(|error| panic!("expected executed data: {error}"));
        assert_eq!(unmetered.data, data);
        assert_eq!(unmetered.billing, None);
    }

    #[test]
    fn composio_import_connection_prompt_keeps_message_and_optional_url() {
        for url in [None, Some("https://connect.example.test")] {
            let elicitation = crate::tool_exec::Elicitation {
                kind: "url".to_owned(),
                message: "Connect your account".to_owned(),
                url: url.map(str::to_owned),
                requested_schema: None,
            };
            let expected = url
                .map(|url| format!("Connect your account Connect: {url}"))
                .unwrap_or_else(|| "Connect your account".to_owned());
            let prompt = crate::identity::to_envelope(&elicitation);
            // A registered service can wrap the prompt in unavailable-accounting
            // metadata. Neither form represents an executed, chargeable action.
            for output in [
                prompt.clone(),
                crate::sidecar::mcp::composio::billing_envelope(prompt, None),
            ] {
                assert_eq!(composio_import_output(output).err(), Some(expected.clone()));
            }
        }
    }

    #[test]
    fn recognizes_every_supported_import_family() {
        for name in [
            "a.txt", "a.md", "a.docx", "a.pdf", "a.html", "a.epub", "a.opml", "a.csv", "a.tsv",
            "a.dsv", "a.xlsx", "a.xls", "a.ods", "a.zip",
        ] {
            assert!(import_kind(name).is_some(), "{name}");
        }
        assert_eq!(import_kind("script.exe"), None);
    }

    #[test]
    fn delimited_parser_handles_quotes_newlines_and_bom() {
        let (rows, count) = parse_delimited(
            "\u{feff}name,note\r\nAda,\"one, two\"\r\nLin,\"line 1\nline 2\"".as_bytes(),
            b',',
        )
        .expect("valid csv");
        assert_eq!(count, 2);
        assert_eq!(rows[1], ["Ada", "one, two"]);
        assert_eq!(rows[2][1], "line 1\nline 2");
    }

    #[test]
    fn delimited_parser_caps_materialized_rows_and_columns_but_counts_all_data() {
        let mut source = String::from("name,score\n");
        for index in 0..=MAX_DATABASE_ROWS {
            source.push_str(&format!("row-{index},1\n"));
        }
        let (rows, count) = parse_delimited(source.as_bytes(), b',').unwrap();
        assert_eq!(rows.len(), MAX_DATABASE_ROWS + 1);
        assert_eq!(count, MAX_DATABASE_ROWS + 1);
        assert_eq!(
            rows.last().unwrap()[0],
            format!("row-{}", MAX_DATABASE_ROWS - 1)
        );

        let mut wide = vec![String::new(); MAX_DATABASE_COLUMNS + 1];
        wide[MAX_DATABASE_COLUMNS] = "only-after-limit".to_owned();
        let text = format!("name\n{}\n", wide.join(","));
        let (rows, count) = parse_delimited(text.as_bytes(), b',').unwrap();
        assert_eq!(count, 1);
        assert_eq!(rows[1].len(), MAX_DATABASE_COLUMNS);
        assert!(rows[1].iter().all(String::is_empty));
    }

    #[test]
    fn delimited_parser_validates_quotes_after_the_materialized_row_limit() {
        let mut source = String::from("name\n");
        for _ in 0..MAX_DATABASE_ROWS {
            source.push_str("valid\n");
        }
        source.push_str("\"unfinished");
        assert_eq!(
            parse_delimited(source.as_bytes(), b',').unwrap_err(),
            "delimited file has an unclosed quoted field"
        );
    }

    #[test]
    fn database_source_deduplicates_headers_and_infers_cells() {
        let source = database_source(&[
            vec!["Name".into(), "Name".into(), "Done".into(), "Score".into()],
            vec!["Ada".into(), "A".into(), "true".into(), "3.5".into()],
        ])
        .expect("database json");
        let value: Value = serde_json::from_str(&source).expect("valid json");
        assert_eq!(value["columns"][1]["label"], "Name 2");
        assert_eq!(value["columns"][2]["cell"]["variant"], "checkbox");
        assert_eq!(value["columns"][3]["cell"]["variant"], "number");
    }

    #[test]
    fn markdown_tables_extracts_each_sheet_table() {
        let tables = markdown_tables(
            "# Sheet\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |",
        );
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[1][1], ["3", "4"]);
    }

    #[test]
    fn composio_actions_require_provider_owned_read_only_metadata() {
        assert!(composio_action_has_tag(
            &json!({"name": "GMAIL_LIST_EMAILS", "tags": ["readOnlyHint"]}),
            "readOnlyHint"
        ));
        assert!(!composio_action_has_tag(
            &json!({"name": "GMAIL_GET_AND_ACKNOWLEDGE_EMAIL", "tags": []}),
            "readOnlyHint"
        ));
        assert!(!composio_action_has_tag(
            &json!({"name": "GITHUB_LIST_AND_MARK_NOTIFICATIONS"}),
            "readOnlyHint"
        ));
    }
}
