//! The document.parse facade: `parse_job` through `BUILTIN_BACKEND_ID`.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::document_parse::*;

/// `GET /api/documents/parse/jobs/:job_id` — poll a submitted parse.
///
/// Normalized to this facade's shape, so a caller written against `unstructured`
/// keeps working when a different backend is bound.
///
/// The poll half of [`parse_document`]; the two are mounted together.
#[utoipa::path(
    get,
    path = "/api/documents/parse/jobs/{job_id}",
    tag = "Documents",
    summary = "Poll a document-parse job",
    description = "Returns the job's `status` (`queued`, `running`, `succeeded`, `failed`, or \
        `cancelled`), and on success its `markdown`. A finished job reports `error` when it \
        failed. A non-2xx answer with `status: \"failed\"` means the job id is unknown or \
        the parser was disabled while the job ran; a malformed id is `400 bad_job_id`.",
    params(("job_id" = String, Path, description = "Job id from POST /api/documents/parse")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn parse_job(State(state): State<ServerState>, Path(job_id): Path<String>) -> Response {
    // A job id is opaque and goes into a URL path; refuse anything that could
    // traverse out of the provider's `/jobs/` namespace rather than encoding around
    // it (the ext-proxy rejects `..` for the same reason).
    if job_id.is_empty()
        || job_id.contains("..")
        || job_id.contains('/')
        || job_id.contains('\\')
        || job_id.contains('?')
        || job_id.contains('#')
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid job id", "code": "bad_job_id" })),
        )
            .into_response();
    }

    let Some((route, _)) = bound_provider(&state).await else {
        // The provider was disabled mid-parse. The job died with it; say so rather
        // than leaving the caller polling forever.
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "status": "failed",
                "error": "the document parser was disabled while this file was parsing",
                "code": "no_provider",
            })),
        )
            .into_response();
    };

    let _activity = match wake_provider(&state, &route).await {
        Ok(guard) => guard,
        Err(resp) => return resp,
    };

    let (status, value) = match provider_call(
        &state,
        &route,
        reqwest::Method::GET,
        &sibling_path(&route, &format!("jobs/{job_id}")),
        None,
        PROVIDER_TIMEOUT,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if !status.is_success() {
        return (
            status,
            Json(json!({
                "status": "failed",
                "error": value.get("error").and_then(Value::as_str).unwrap_or("unknown parse job"),
                "code": "unknown_job",
            })),
        )
            .into_response();
    }

    Json(normalize_job(&value)).into_response()
}

/// Map a provider job snapshot onto this facade's contract.
///
/// The provider's own vocabulary (`result.markdown`, `missing_dependencies`) is an
/// implementation detail of one backend; callers see `markdown` / `error` /
/// `missing_dependencies` at the top level regardless of who parsed.
pub(in crate::document_parse) fn normalize_job(snapshot: &Value) -> Value {
    let status = snapshot
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running");
    let result = snapshot.get("result");
    let (markdown, truncated) = result
        .and_then(|r| r.get("markdown"))
        .and_then(Value::as_str)
        .map(truncate_markdown)
        .map(|(md, cut)| {
            let already = result
                .and_then(|r| r.get("truncated"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (Some(md), cut || already)
        })
        .unwrap_or((None, false));

    let missing: Vec<&str> = snapshot
        .get("missing_dependencies")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    // A `succeeded` job with no markdown is a failure from the caller's side: the
    // whole contract is "you get text back". Reporting it as success would recreate
    // the silent-drop bug one layer up.
    let effective_status = if status == "succeeded" && markdown.is_none() {
        "failed"
    } else {
        status
    };
    let error = snapshot
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            (effective_status == "failed" && markdown.is_none())
                .then(|| "the parser returned no text for this file".to_owned())
        });

    json!({
        "status": effective_status,
        "job_id": snapshot.get("job_id").cloned().unwrap_or(Value::Null),
        "filename": snapshot.get("filename").cloned().unwrap_or(Value::Null),
        "markdown": markdown,
        "truncated": truncated,
        "error": error,
        "missing_dependencies": missing,
    })
}

// ── The typed, in-process API ─────────────────────────────────────────────────
//
// The three routes above serve HTTP callers (the composers). Everything else in
// Core that needs text out of a file — Spaces ingest first — calls THIS, because a
// `Response` is not an answer an ingest pipeline can branch on: it needs to tell
// "this format has no parser" (skip the file, say so on the doc) from "the parser
// timed out" (retry later) from "the host has no Python" (tell the user to install
// it), and an axum `Response` flattens all three into bytes.

/// Why a parse produced no text. Every variant is a DIFFERENT action for the caller,
/// which is the whole reason this is an enum and not a string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailureReason {
    /// No floor claims this extension and no bound provider does either. The file is
    /// readable by nothing on this node **right now** — a permanent answer only until
    /// a provider is installed.
    Unsupported,
    /// A provider-needing format with no provider bound at all. Distinct from
    /// [`Self::Unsupported`] because the fix is "install a `document.parse` app",
    /// not "this format is unreadable".
    NoProvider,
    /// The provider was reachable but did not answer inside the hop budget, or the
    /// parse job itself hit the backend's wall-clock ceiling. Retryable.
    ProviderTimeout,
    /// The provider answered, and the answer was a failure (missing native tool,
    /// corrupt document, backend crash). `message` carries its words.
    ProviderError,
    /// Over [`MAX_PARSE_BYTES`]. Nothing was attempted.
    TooLarge,
    /// A provider is bound but its sidecar cannot run because the HOST has no Python
    /// interpreter to build a venv from. Core bundles none
    /// ([`crate::sidecar::external_runtime`]), so this is a real and common
    /// deployment state, and it MUST NOT read as "the document has no text" — that
    /// is the failure mode the builtin floor exists to make impossible.
    PythonMissing,
    /// The document's stored bytes could not be located or opened: a blob address
    /// that is not a sha256 at all (an empty `sha256` column, a truncated row), or a
    /// blob file that is missing or unreadable under `~/.ryu/blobs/`.
    ///
    /// Split out of [`Self::Unsupported`], which is where an unusable address used to
    /// land ([`blob_input_path`] returned it) and which is a **`skipped`** state whose
    /// remedy text is "install a `document.parse` app". Nothing about a broken blob
    /// reference is fixed by installing a parser, and sending the user to the Store
    /// for it is the kind of confidently-wrong remedy this module exists to stop
    /// emitting. Nothing was attempted; the fault is on this node's storage.
    BlobUnavailable,
    /// The name (or the declared MIME type) put this file on the text floor, and the
    /// **bytes are not text** — see [`decode_text`] for the two signals.
    ///
    /// The failure the floor's narrowness exists to prevent, now caught on the one
    /// path that could still reach it. A binary under a floor extension (`payload.txt`
    /// holding a zip) or under an extensionless title with a declared text mime
    /// (`notes` + `text/plain`) used to be decoded LOSSILY: a page of replacement
    /// characters, stored as the document's contents and handed to a model as prose.
    ///
    /// Not [`Self::Unsupported`] (whose remedy is "install a parser", and installing
    /// one does not make a mislabelled file text) and not silence: the fault is that
    /// the name/mime disagrees with the bytes, which is something the user can act on
    /// by re-uploading under a truthful name.
    NotText,
}

impl ParseFailureReason {
    /// The stable wire code, shared with the HTTP routes' `code` field.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported_format",
            Self::NoProvider => "no_provider",
            Self::ProviderTimeout => "provider_timeout",
            Self::ProviderError => "provider_error",
            Self::TooLarge => "too_large",
            Self::PythonMissing => "python_missing",
            Self::BlobUnavailable => "blob_unavailable",
            Self::NotText => "not_text",
        }
    }
}

/// A parse that produced no text, with the reason a caller can branch on.
#[derive(Debug, Clone)]
pub struct ParseFailure {
    pub reason: ParseFailureReason,
    pub message: String,
}

impl ParseFailure {
    /// `pub` so an in-process caller can construct the failure it is about to
    /// record — [`crate::space_file_index`]'s tests build one to prove that a
    /// failed parse still stores the file, and its orchestration builds one for the
    /// two failure modes that never reach a provider at all (a poll budget that
    /// expires, and a tool context with no [`ServerState`] wired).
    pub fn new(reason: ParseFailureReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ParseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason.code(), self.message)
    }
}

impl std::error::Error for ParseFailure {}

/// A parse that produced text, and everything a store needs to record about it.
///
/// `backend_id` + `backend_version` + `parsed_at` exist so a re-index can tell rows
/// extracted by an old backend from rows extracted by the current one: swapping the
/// bound provider changes the text, and a chunk table with no provenance cannot know
/// which of its rows are stale.
#[derive(Debug, Clone)]
pub struct ParseOutcome {
    /// The extracted text, clamped to [`MAX_MARKDOWN_BYTES`].
    pub markdown: String,
    /// `"builtin"` for the floor, otherwise the provider's plugin id.
    pub backend_id: String,
    /// The backend's own version string. Empty when it reported none.
    pub backend_version: String,
    /// Lowercase hex sha256 of the SOURCE bytes — the blob address, so a caller can
    /// dedupe an extraction against the file it came from.
    pub source_sha256: String,
    /// When the extraction finished. Carried for a re-index that needs to tell a row
    /// extracted by an old backend from a current one; no consumer reads it yet
    /// ([`crate::space_file_index`] stamps its own `updated_at`), which is why the
    /// gate is here and not a deletion — dropping provenance is not free to re-add.
    #[allow(dead_code)]
    pub parsed_at: chrono::DateTime<chrono::Utc>,
    /// Non-fatal notes: a lossy decode, a missing OCR tool, a truncated result.
    /// Populated, not swallowed — a degraded parse the caller cannot see is the
    /// silent-drop bug wearing a hat.
    pub warnings: Vec<String>,
    /// Whether `markdown` was cut at a cap. Not read as a flag: every producer also
    /// pushes a "output was truncated" line into `warnings`, which is the form the
    /// status row and the UI actually surface, so the boolean is kept for a caller
    /// that needs to branch rather than to display.
    #[allow(dead_code)]
    pub truncated: bool,
}

/// What a submit produced: a finished parse (the floor answered) or a job to poll.
#[derive(Debug, Clone)]
pub enum ParseSubmission {
    Done(Box<ParseOutcome>),
    Job {
        job_id: String,
        /// The provider that accepted the job. Unread today —
        /// [`crate::space_file_index`] learns the backend id from the finished
        /// [`ParseOutcome`] instead — but a caller that wants to name the parser
        /// while the job is still `pending` has nowhere else to get it.
        #[allow(dead_code)]
        backend_id: String,
    },
}

/// `"builtin"` — the backend id the floor reports. Not a plugin id, and deliberately
/// not a name any app may take (`plugins::binding` ids are reverse-DNS).
pub const BUILTIN_BACKEND_ID: &str = "builtin";
