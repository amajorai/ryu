//! The **`document.parse` facade** — Core's single document-extraction path.
//!
//! Before this module a PDF dropped into the composer was silently discarded: all
//! three desktop composers filtered attachments to `image/*`, and the two chat
//! planes filtered again at [`crate::sidecar::adapters`]. Nothing in the tree read a
//! document. The `unstructured` app (`apps-store/unstructured/`) registered a
//! `document.parse` provider, but the capability had no caller.
//!
//! This is that caller, and it is deliberately the **only** one. Every surface that
//! wants text out of a file goes through these three routes; there is no second
//! extraction path to drift from.
//!
//! ## Shape: submit → poll, never one long request
//!
//! [`parse_document`] returns either a finished result (builtin floor) or a
//! `job_id` to poll ([`parse_job`]). It never blocks on a parse. That is forced by
//! the ext-proxy's activity guard, which drops when response *headers* arrive: a
//! `lazy` + `idle_stop_secs` provider sidecar can be reaped mid-parse if the caller
//! holds one long request open. Polling re-arms the guard. The provider
//! (`ryu_unstructured.server`) is built to the same contract for the same reason.
//!
//! ## The builtin floor is not a fallback, it is a floor
//!
//! A `.txt`/`.md`/`.csv` file *is* its own text. Routing it through a 1-2 GB Python
//! sidecar to learn that would make plain-text attachments depend on an opt-in
//! install, so Core reads those itself ([`builtin_markdown`]) and never consults a
//! provider. The floor is intentionally narrow — UTF-8 families where the bytes are
//! the content. Anything else (PDF, the Office family, EPUB, scanned images) needs a
//! real parser, and when none is bound the caller gets a **415 that names the
//! extension**, so the UI can say "no parser for .pdf — install one" instead of
//! dropping the file.
//!
//! ## What is wired, and what is not — read this before trusting the module doc above
//!
//! This module shipped in `9bf1e2023` with **no `mod document_parse;` line in
//! `main.rs`**. It was not in the module tree, so it had never been compiled, let
//! alone called — the module doc below describes a design, not a running system.
//! Declaring it (and widening `ext_proxy::{resolve_provider_route, ProviderRoute}`
//! to `pub(crate)`) was step zero of wiring Spaces ingest into it.
//!
//! As of that change, **the typed in-process API is live** — [`submit_blob`],
//! [`job_outcome`] and [`builtin_parse`] are called by
//! [`crate::space_file_index`], which is how an uploaded file's contents reach a
//! Space index.
//!
//! **All three HTTP routes are registered** in the main route table of
//! `apps/core/src/server/mod.rs`, deliberately *outside* the Spaces `AppGate` — the
//! bound provider serves chat attachments too, so a node with Spaces turned off must
//! still answer them.
//!
//! - [`parse_capability`] (`GET /api/documents/parse/capability`) feeds the
//!   desktop's **Storage** settings panel (`components/settings/StorageSettings.tsx`),
//!   which prints `max_input_bytes` as the node's upload ceiling, and the composer
//!   attachment seam (`lib/composer/attachments.ts`). The provider itself is bound
//!   from the node dropdown's Toolkits row, the generic surface every swappable
//!   capability uses.
//! - [`parse_document`] (`POST /api/documents/parse`) and [`parse_job`]
//!   (`GET /api/documents/parse/jobs/:job_id`) are the submit → poll pair. Their
//!   first consumer is the TypeScript SDK's document loaders (`coreDocumentParser`
//!   in `@ryuhq/sdk/loaders`), which send local PDF and Office files here; the
//!   desktop composer seam (`stageComposerFiles`) calls the same pair. The POST is
//!   registered with [`crate::server::uploads::DOCUMENT_PARSE_BODY_LIMIT`], so a
//!   body over [`MAX_PARSE_BYTES`] is refused with a message naming the ceiling
//!   rather than axum's implicit 2 MiB default.
//!
//! ## There is no `/api/document-parse/*` and there never was
//!
//! Which backend is bound is **not** served by a bespoke route here. The desktop
//! reads it from the generic capability read model (`GET /api/capabilities`,
//! filtered to `document.parse`) and writes it through
//! `PUT /api/capabilities/bindings`, the same pair every other hot-swappable layer
//! uses. A `document.parse`-specific pair was documented in the desktop client for
//! one release and never existed in Core; see `apps/desktop/src/lib/api/documents.ts`
//! for the removal. Do not add one back: the write endpoint REPLACES the whole
//! override map, so a second write path would have to re-derive the read-merge-write
//! or silently wipe every other capability's selection.
//!
//! ## Provider-agnostic by construction
//!
//! Nothing here names `@ryu/unstructured`. The provider is resolved through
//! [`crate::plugins::binding`] exactly like `web.search` or `computer.control`:
//! user override > sole provider > declared default > lowest id. A second backend is
//! pure manifest data. The normalized response shape (`status` / `markdown` /
//! `error` / `missing_dependencies`) is this facade's contract, not any one
//! backend's — [`normalize_job`] maps the provider's snapshot onto it.

use std::collections::HashSet;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::server::ServerState;
use crate::sidecar::ext_proxy::{ext_token, node_token, resolve_provider_route, ProviderRoute};

/// The capability this facade consumes. One string, one place.
pub const CAP_DOCUMENT_PARSE: &str = "document.parse";

/// Cap on bytes accepted for a parse, mirroring [`crate::server::uploads::MAX_UPLOAD_BYTES`]
/// so a file the user could attach is a file the parser will look at.
///
/// Reported to clients as `max_input_bytes` by [`parse_capability`], which is what
/// makes it the number the desktop's parsing panel prints instead of a client-side
/// constant. Equality with the upload ceiling is the *design* — a document only
/// reaches a parser by being uploaded first — not a coincidence to be hidden: the
/// panel renders the reported figure whether or not it happens to agree.
///
/// The in-process floor is bounded by [`MAX_BLOB_PARSE_BYTES`] instead, because a
/// blob address is not a request body.
pub const MAX_PARSE_BYTES: usize = crate::server::uploads::MAX_UPLOAD_BYTES;

/// Cap on bytes the typed in-process floor ([`builtin_parse`]) will read.
///
/// Deliberately NOT [`MAX_PARSE_BYTES`]: that one is an *HTTP upload* limit and means
/// nothing to a caller holding a blob address rather than a request body. A Space file
/// goes to 200 MiB, and a 50 MiB `.csv` must not be refused as "too large" on a path
/// where the same 50 MiB as a `.pdf` reaches a provider whose own ceiling is 200 MiB.
/// The read costs memory but the OUTPUT is clamped by [`MAX_MARKDOWN_BYTES`] either
/// way, so the wider bound buys correctness for free.
pub const MAX_BLOB_PARSE_BYTES: usize = 200 * 1024 * 1024;

/// Cap on extracted markdown returned to a caller, in bytes.
///
/// This bound exists because the extracted text lands in a chat turn and is
/// persisted with it: an unbounded 900-page PDF would be re-sent on every
/// subsequent turn of that thread. Truncation is REPORTED (`truncated: true`), never
/// silent — the whole point of this change is that files stop disappearing quietly.
pub const MAX_MARKDOWN_BYTES: usize = 400_000;

/// How long a single hop to the provider sidecar may take. Submit and poll are both
/// short by construction (the parse itself happens on the provider's worker pool),
/// so this is a transport bound, not a parse bound.
const PROVIDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Budget for the never-wakes `/capability` probe. Short on purpose: an asleep
/// provider must cost the caller a refused loopback connection, not a stall — this
/// runs on a settings-panel mount and on every composer mount.
const CAPABILITY_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long to WAIT for a lazy/idle-stopped provider sidecar to become healthy
/// before declining the submit. Matches the ext-proxy's own wake budget. Only the
/// wait: the start itself runs detached in the sidecar manager with its own long
/// provisioning budget ([`crate::sidecar::manager::WAKE_START_BUDGET`]), so a first
/// start's venv + `pip install` is never cancelled by this timeout.
const WAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Extensions Core decodes itself, with no provider bound — the floor.
///
/// Every entry is a UTF-8 text family whose bytes ARE the document. Deliberately
/// excludes anything needing a real parser (`.pdf`, `.docx`, `.pptx`, `.xlsx`,
/// `.epub`, images): guessing at those would produce mojibake presented as content,
/// which is worse than the honest "no parser for this" the caller gets instead.
pub const BUILTIN_EXTENSIONS: &[&str] = &[
    ".txt",
    ".text",
    ".md",
    ".markdown",
    ".mdx",
    ".rst",
    ".org",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".ndjson",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".htm",
    ".log",
    ".ini",
    ".conf",
    ".env",
    ".sql",
    ".tex",
    ".srt",
    ".vtt",
];

/// The lowercase extension of `filename`, dot included (`"a/b/Report.PDF"` → `".pdf"`).
///
/// Takes the LAST dot only. A compound suffix like `.tar.gz` therefore reads as
/// `.gz`, which is correct here: the floor does not claim archives, and a provider
/// that does matches on its own list.
pub fn extension_of(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    match base.rfind('.') {
        Some(i) if i + 1 < base.len() => base[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Percent-decode a header value. Invalid escapes are kept verbatim rather than
/// dropped — a mangled character in a filename is recoverable, a silently shortened
/// one is not.
///
/// Route-only: decodes `x-filename` for [`parse_document`]. The in-process API is
/// handed a title directly and needs no decode.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether Core itself can read `filename` with no provider bound.
///
/// Keys on the **extension**, which is the whole answer only when the caller holds a
/// filename. A caller holding a *title* wants [`mime_floor_name`] as its second
/// signal — see that function for why the split is two calls and not one.
pub fn is_builtin_readable(filename: &str) -> bool {
    let ext = extension_of(filename);
    !ext.is_empty() && BUILTIN_EXTENSIONS.contains(&ext.as_str())
}

/// MIME types that map onto a [`BUILTIN_EXTENSIONS`] entry, for a document whose
/// **name carries no extension at all**.
///
/// Every right-hand side is already on the floor: this table can only re-route a
/// document to a reader Core would have used anyway for the same content, never widen
/// the floor to a new family. `text/rtf`, `application/octet-stream` and the
/// `text/x-<language>` source types are deliberately absent — the first is markup the
/// floor would emit as control words, the second is "unknown" (and is exactly what
/// `POST /api/spaces/:id/files` defaults to when a client sends no mime), and the
/// third has no floor extension to map onto.
const MIME_FLOOR_EXTENSIONS: &[(&str, &str)] = &[
    ("text/plain", ".txt"),
    ("text/markdown", ".md"),
    ("text/x-markdown", ".md"),
    ("text/csv", ".csv"),
    ("text/tab-separated-values", ".tsv"),
    ("application/json", ".json"),
    ("text/json", ".json"),
    ("application/x-ndjson", ".jsonl"),
    ("application/jsonl", ".jsonl"),
    ("application/yaml", ".yaml"),
    ("text/yaml", ".yaml"),
    ("application/x-yaml", ".yaml"),
    ("text/x-yaml", ".yaml"),
    ("application/toml", ".toml"),
    ("text/x-toml", ".toml"),
    ("application/xml", ".xml"),
    ("text/xml", ".xml"),
    ("text/html", ".html"),
    ("application/xhtml+xml", ".html"),
];

/// The floor filename for a **title with no extension**, recovered from its declared
/// MIME type — or `None` when the title already carries an extension, or the mime
/// names no floor family.
///
/// # Why this exists
///
/// [`is_builtin_readable`] keys on the extension, and two of the three
/// [`crate::space_file_index::create_file_indexed`] callers pass a **title**, not a
/// filename: `POST /api/spaces/:id/files` takes `body.title` and the `artifact.create`
/// MCP tool takes a `title` argument. So a note called `notes` with `mime:
/// text/plain` answered `false`, went to the bound provider, and landed on
/// `skipped/no_provider` — telling the user to install a document parser for a file
/// Core can read in-process, in microseconds, with no install at all.
///
/// # Why it refuses a title that HAS an extension
///
/// This may only *widen* the floor, never redirect a binary into a text reader. A
/// mime is client-supplied and can disagree with the bytes; if the title already says
/// `.pptx`, that extension is the more specific signal and it is the one the floor
/// already refused. Honouring a `text/plain` claim over it would hand a zip container
/// to [`decode_text`] — the exact failure the floor's narrowness exists to prevent. A
/// title with no extension carries no such contradiction, so the mime is the only
/// signal there is.
///
/// **This rule is a filter on the NAME, and a name check can never be the whole
/// answer.** It stops `deck.pptx` + `text/plain`; it cannot stop `notes` +
/// `text/plain` carrying the same zip, because a title with no extension contradicts
/// nothing. That case reaches the decoder, which is why [`decode_text`] refuses bytes
/// that are not plausibly text instead of lossily converting them. The two guards are
/// a pair, and neither alone closes the hole: this one keeps a *declared* binary off
/// the floor, that one keeps *actual* binary bytes from being stored as prose.
///
/// The cost of that rule is a title like `v1.2 notes`, whose "extension" (`.2 notes`)
/// is not one — it stays on the provider path. Refusing to read a text file is a
/// recoverable miss; confidently misreading a binary is not.
pub fn mime_floor_name(title: &str, mime: &str) -> Option<String> {
    if !extension_of(title).is_empty() {
        return None;
    }
    // Strip any `; charset=…` parameter and normalize case — `Text/Plain; charset=utf-8`
    // is the same type as `text/plain` and a client may send either.
    let essence = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let ext = MIME_FLOOR_EXTENSIONS
        .iter()
        .find(|(m, _)| *m == essence)
        .map(|(_, ext)| *ext)?;
    Some(format!("{title}{ext}"))
}

/// Decode floor bytes to markdown, or `None` when they are not valid UTF-8.
///
/// Strict, not lossy, on purpose: a `.txt` that is actually UTF-16 or a mislabelled
/// binary should surface as "cannot read this" rather than as a page of replacement
/// characters the model would then reason about as if it were content. This is the
/// **route** floor and its strictness is the shipped `415 not_text` contract; the
/// in-process floor ([`builtin_parse`]) is allowed a lossy last resort because it can
/// report it in `warnings`, which an HTTP status code cannot.
///
/// HTML is tag-stripped rather than passed through: `.html` is on the floor because
/// its bytes are text, but handing a model raw `<div class="…">` markup as "the
/// document" spends the context window on layout. Minimal on purpose — see
/// [`strip_html`].
///
/// Route-only: [`parse_document`] is its sole caller. The in-process floor is
/// [`builtin_parse`], which differs deliberately — see there.
pub fn builtin_markdown(filename: &str, bytes: &[u8]) -> Option<(String, bool)> {
    let text = std::str::from_utf8(bytes).ok()?;
    Some(truncate_markdown(&apply_html_strip(filename, text)))
}

/// Tag-strip when the extension says HTML, pass through otherwise.
fn apply_html_strip(filename: &str, text: &str) -> String {
    match extension_of(filename).as_str() {
        ".html" | ".htm" => strip_html(text),
        _ => text.to_owned(),
    }
}

/// The minimal HTML-to-text reduction the floor performs.
///
/// Deliberately NOT an HTML parser: it drops `<script>`/`<style>` bodies, removes
/// tags, resolves the five XML entities plus `&nbsp;`/`&#39;`, and collapses runs of
/// blank lines. A real DOM-aware conversion (tables, headings, lists) is exactly what
/// a `document.parse` provider is for — the floor's job is to stop plain files from
/// needing one, not to compete with it.
fn strip_html(html: &str) -> String {
    // Drop the two element bodies that are never document content. Case-insensitive
    // on the tag name; an unclosed one swallows the remainder, which is the safe
    // direction (script text is never prose).
    let mut rest = html.to_owned();
    for tag in ["script", "style"] {
        rest = drop_element(&rest, tag);
    }

    let mut out = String::with_capacity(rest.len());
    let mut in_tag = false;
    for ch in rest.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                // A removed tag is a word boundary: `a<br>b` must not become `ab`.
                out.push('\n');
            }
            _ if in_tag => {}
            _ => out.push(ch),
        }
    }

    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        // `&amp;` last, so `&amp;lt;` stays the literal `&lt;` it encoded.
        .replace("&amp;", "&");

    let mut lines: Vec<&str> = Vec::new();
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() && lines.last().is_some_and(|l: &&str| l.is_empty()) {
            continue;
        }
        lines.push(trimmed);
    }
    lines.join("\n").trim().to_owned()
}

/// Remove every `<tag …>…</tag>` region from `src`, tag name matched case-insensitively.
fn drop_element(src: &str, tag: &str) -> String {
    let lower = src.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0usize;
    while let Some(hit) = lower[cursor..].find(&open) {
        let start = cursor + hit;
        out.push_str(&src[cursor..start]);
        match lower[start..].find(&close) {
            Some(end) => {
                let after = start + end;
                cursor = src[after..]
                    .find('>')
                    .map_or(src.len(), |gt| after + gt + 1);
            }
            // Unclosed: everything after the open tag is script/style text.
            None => cursor = src.len(),
        }
    }
    out.push_str(&src[cursor.min(src.len())..]);
    out
}

/// Clamp markdown to [`MAX_MARKDOWN_BYTES`] on a char boundary. Returns the text and
/// whether it was cut.
fn truncate_markdown(text: &str) -> (String, bool) {
    if text.len() <= MAX_MARKDOWN_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = MAX_MARKDOWN_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

// ── Provider resolution ───────────────────────────────────────────────────────

/// The bound `document.parse` provider: its plugin id, display name, and the
/// resolved route to its sidecar. `None` when no enabled app provides the capability.
///
/// Mirrors [`crate::memory_provider::bound_provider`] in intent — "who serves this
/// capability right now" — but resolves through the binding registry rather than the
/// MCP verb table, because this capability is served by an HTTP route on a sidecar
/// (`provides[].sidecar` + `provides[].route`), not by MCP verbs.
async fn bound_provider(state: &ServerState) -> Option<(ProviderRoute, String)> {
    let records = state.app_store.list().await.ok()?;
    let enabled: HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();

    let manifests = state.app_manifests.read().await;
    let candidates: Vec<crate::plugin_manifest::PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains(&m.id))
        .cloned()
        .collect();
    drop(manifests);

    let cfg = crate::plugins::binding::active_config();
    let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &candidates);
    let req = crate::plugin_manifest::CapabilityReq {
        capability: CAP_DOCUMENT_PARSE.to_owned(),
        min_version: None,
    };
    let binding = registry.resolve(&req).ok()?;
    let provider = candidates.iter().find(|m| m.id == binding.provider_id)?;
    let entry = provider
        .provided_capabilities()
        .iter()
        .find(|e| e.capability == CAP_DOCUMENT_PARSE)?
        .clone();
    let route = resolve_provider_route(provider, &entry, &binding.provider_id).ok()?;
    Some((route, provider.name.clone()))
}

/// The provider's sibling route for `name`, derived from its declared submit route.
///
/// **The convention, stated once:** a `document.parse` provider declares its *submit*
/// route in `provides[].route` (`/parse`) and serves `capability` and `jobs/{id}` as
/// siblings of it. The manifest schema has one `route` field, and inventing three
/// would push backend-specific layout into the kernel contract for every capability;
/// pinning the sibling names here keeps the manifest a single line while the poll and
/// discovery surfaces stay provider-agnostic. `/parse` → `/capability`, `/jobs/<id>`,
/// and a mounted provider (`/api/doc/parse`) keeps its mount.
fn sibling_path(route: &ProviderRoute, name: &str) -> String {
    let base = match route.upstream_path.rfind('/') {
        Some(i) => &route.upstream_path[..i],
        None => "",
    };
    format!("{base}/{name}")
}

/// Wake a lazy provider sidecar and hold it for the hop.
///
/// The returned guard must stay alive across the request: the ext-proxy's activity
/// guard drops at header arrival, so without it an idle-stop sidecar can be reaped
/// between the wake and the call.
///
/// Route-only: the in-process API uses its typed twin [`hold_provider`].
async fn wake_provider(
    state: &ServerState,
    route: &ProviderRoute,
) -> Result<Option<crate::sidecar::manager::ActivityGuard>, Response> {
    let Some(wake) = route.wake_name.as_ref() else {
        return Ok(None);
    };
    state
        .manager
        .wake_and_await_healthy(wake, WAKE_TIMEOUT)
        .await
        .map_err(|e| {
            tracing::warn!("document.parse: waking provider '{wake}' failed: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "document parser is warming up, retry shortly",
                    "code": "provider_warming",
                })),
            )
                .into_response()
        })?;
    Ok(Some(state.manager.enter_request(wake)))
}

/// One authenticated hop to the provider sidecar. The bearer is the PROVIDER's
/// minted `ext_token` — the same secret the ext-proxy stamps — so the sidecar's
/// fail-closed middleware accepts it and no other local process can.
///
/// Typed variant: the HTTP handlers below flatten this into a [`Response`]
/// ([`provider_call`]), the in-process API keeps the reason so a caller can tell a
/// transport timeout from a refused connection.
///
/// Takes `state` for ONE reason: the port is resolved here, from the sidecar manager's
/// live port claim, and nowhere else in this file. Pinning the derivation to the single
/// dial site is what keeps this facade from re-growing a second, drifting copy of "which
/// port is the provider on" — the copy that, when it disagreed with the manager, sent
/// the document bytes and the provider's minted `ext_token` to whatever unrelated
/// process happened to hold the manifest's declared port. See
/// [`crate::sidecar::manager::ForwardTarget`].
async fn provider_call_typed(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: std::time::Duration,
) -> Result<(StatusCode, Value), ParseFailure> {
    let target = state
        .manager
        .forward_target(&route.sidecar_name)
        .map_err(|denied| {
            tracing::warn!(
                sidecar = %denied.name(),
                port = ?denied.port(),
                "document.parse refused to forward: {}",
                denied.reason()
            );
            ParseFailure::new(
                ParseFailureReason::ProviderError,
                format!(
                    "document parser '{}' is unavailable: {}",
                    denied.name(),
                    denied.reason()
                ),
            )
        })?;
    let url = format!("http://127.0.0.1:{}{}", target.port(), path);
    let token = ext_token(node_token().as_deref(), &route.provider_id);
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, &url)
        .timeout(timeout)
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.map_err(|e| {
        tracing::warn!("document.parse: provider call to {url} failed: {e}");
        let reason = if e.is_timeout() {
            ParseFailureReason::ProviderTimeout
        } else {
            ParseFailureReason::ProviderError
        };
        ParseFailure::new(reason, "document parser is unreachable")
    })?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let value: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    Ok((status, value))
}

/// [`provider_call_typed`] flattened for the HTTP handlers.
///
/// Both transport reasons collapse to the SAME 502 `provider_unreachable` the route
/// contract has always returned — the typed split is new information for in-process
/// callers, not a change to a shipped wire response.
///
/// Route-only: the three HTTP handlers are its only callers, and [`parse_capability`]
/// (the one that is mounted) is what keeps it live.
async fn provider_call(
    state: &ServerState,
    route: &ProviderRoute,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: std::time::Duration,
) -> Result<(StatusCode, Value), Response> {
    provider_call_typed(state, route, method, path, body, timeout)
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": "document parser is unreachable",
                    "code": "provider_unreachable",
                })),
            )
                .into_response()
        })
}

// ── Routes ────────────────────────────────────────────────────────────────────
//
// All three are mounted in `apps/core/src/server/mod.rs` (see the module doc).

/// `GET /api/documents/parse/capability` — what this node can read, right now.
///
/// **Mounted** in the main route table (not `spaces_routes`): the bound provider
/// serves chat attachments as well as Space uploads, so this must answer on a node
/// with the Spaces app disabled.
///
/// Two consumers, one response:
/// - the desktop's **Document parsing** settings panel renders `provider_name`,
///   `available`, `extensions`, `missing_dependencies` and `max_input_bytes` from it
///   — every figure it prints about parsing comes from here rather than from a
///   client-side constant that cannot know which backend is bound;
/// - the composer's file-picker `accept` list is built from `extensions`, so the
///   picker offers exactly what the bound backend (plus the floor) can actually
///   handle instead of a hardcoded guess that drifts the moment a provider is
///   swapped.
///
/// Cheap by construction: it never wakes a sleeping provider (see the probe below),
/// so mounting a settings panel or a composer costs at most one refused loopback
/// connection.
#[utoipa::path(
    get,
    path = "/api/documents/parse/capability",
    tag = "Documents",
    summary = "Formats this node can extract text from",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn parse_capability(State(state): State<ServerState>) -> Response {
    let builtin: Vec<String> = BUILTIN_EXTENSIONS.iter().map(|s| (*s).to_owned()).collect();

    let Some((route, provider_name)) = bound_provider(&state).await else {
        // No provider bound. Honest, not empty: the floor still works, and the
        // caller needs to know the difference so it can tell the user why a PDF is
        // refused rather than dropping it.
        return Json(json!({
            "provider": Value::Null,
            "provider_name": Value::Null,
            "available": true,
            "extensions": builtin,
            "builtin_extensions": BUILTIN_EXTENSIONS,
            "missing_dependencies": [],
            "max_input_bytes": MAX_PARSE_BYTES,
        }))
        .into_response();
    };

    // A lazy provider is deliberately NOT woken to answer this. Every composer mount
    // asks what formats are readable; spinning a 1-2 GB Python process for a picker's
    // `accept` list would make opening a chat expensive. So the probe is a plain
    // short-timeout call: an asleep sidecar is refused by the manager's forward gate
    // (registered, claim held, process down) before anything is dialed at all, and we
    // answer with the floor plus the provider's identity. The format list fills in once
    // a real parse has woken it.
    let probe = provider_call(
        &state,
        &route,
        reqwest::Method::GET,
        &sibling_path(&route, "capability"),
        None,
        CAPABILITY_PROBE_TIMEOUT,
    )
    .await
    .ok();

    let (formats, missing, available) = match probe {
        Some((status, body)) if status.is_success() => {
            let formats: Vec<String> = body
                .get("formats")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let missing: Vec<String> = body
                .get("missing_dependencies")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let available = body
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            (formats, missing, available)
        }
        _ => (Vec::new(), Vec::new(), true),
    };

    let mut extensions: Vec<String> = builtin.clone();
    for f in formats {
        if !extensions.contains(&f) {
            extensions.push(f);
        }
    }
    extensions.sort();

    Json(json!({
        "provider": route.provider_id,
        "provider_name": provider_name,
        "available": available,
        "extensions": extensions,
        "builtin_extensions": BUILTIN_EXTENSIONS,
        "missing_dependencies": missing,
        "max_input_bytes": MAX_PARSE_BYTES,
    }))
    .into_response()
}

/// `POST /api/documents/parse` — submit bytes for extraction.
///
/// Raw request body + `x-filename` (the same shape as `POST /api/uploads`, so a
/// caller that already stages an upload does not have to learn a second encoding).
///
/// Returns one of three things, and **never** silently succeeds with nothing:
/// - `{ status: "succeeded", via: "builtin", markdown, truncated }` — the floor read it;
/// - `{ status: "queued", via: "<provider id>", job_id }` — poll [`parse_job`];
/// - `415 { code: "no_provider", extension }` — no floor, no provider that claims
///   it (or `415 { code: "not_text" }` for a text extension that is not UTF-8). The
///   caller shows this on the attachment chip.
///
/// Mounted with [`crate::server::uploads::DOCUMENT_PARSE_BODY_LIMIT`]: without that
/// layer, axum's implicit 2 MiB default would refuse the body before this handler's
/// `too_large` branch could name the real ceiling.
#[utoipa::path(
    post,
    path = "/api/documents/parse",
    tag = "Documents",
    summary = "Extract markdown from a document",
    description = "Send the document as the raw request body (any content type) with its \
        percent-encoded file name in `x-filename`; the extension decides how it is read. \
        Text formats are answered at once with `{ status: \"succeeded\", via: \"builtin\", \
        markdown, truncated }`. Other formats go to the node's bound document parser and \
        return `{ status: \"queued\", via, job_id }`; poll \
        `GET /api/documents/parse/jobs/{job_id}`. Errors: `400 empty`, \
        `413 too_large` (the body is over the node's upload ceiling), `415 not_text` \
        (a text extension whose bytes are not UTF-8), and `415 no_provider` (no installed \
        parser reads this format; `extension` names it).",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn parse_document(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "empty document", "code": "empty" })),
        )
            .into_response();
    }
    if body.len() > MAX_PARSE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": format!(
                    "document too large: {} bytes (max {} MB)",
                    body.len(),
                    MAX_PARSE_BYTES / (1024 * 1024)
                ),
                "code": "too_large",
            })),
        )
            .into_response();
    }

    // `x-filename` is percent-encoded by the caller. HTTP headers are Latin-1, so a
    // raw `Rapport financier — Q3.pdf` either throws in the browser's fetch or
    // arrives mojibake'd; percent-encoding is the only way a non-ASCII document name
    // survives the hop, and losing it would cost the extension the dispatch depends on.
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "document".to_owned());
    let ext = extension_of(&filename);

    // 1. Floor first — a text file must not depend on an opt-in 1-2 GB install.
    if is_builtin_readable(&filename) {
        return match builtin_markdown(&filename, &body) {
            Some((markdown, truncated)) => Json(json!({
                "status": "succeeded",
                "via": "builtin",
                "filename": filename,
                "markdown": markdown,
                "truncated": truncated,
            }))
            .into_response(),
            None => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({
                    "error": format!("{filename} is not valid UTF-8 text"),
                    "code": "not_text",
                    "extension": ext,
                })),
            )
                .into_response(),
        };
    }

    // 2. Otherwise the bound provider, or an honest refusal that names the format.
    let Some((route, provider_name)) = bound_provider(&state).await else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(json!({
                "error": format!(
                    "no document parser is installed that can read {}",
                    if ext.is_empty() { "this file" } else { ext.as_str() }
                ),
                "code": "no_provider",
                "extension": ext,
            })),
        )
            .into_response();
    };

    let _activity = match wake_provider(&state, &route).await {
        Ok(guard) => guard,
        Err(resp) => return resp,
    };

    // The provider takes inline bytes (`content_base64`) rather than a path: Core
    // holds the request body in memory and has no shared staging contract with an
    // arbitrary provider, and handing a provider a filesystem path it then reads
    // would be an arbitrary-file-read primitive if the path ever came from a client.
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
    let (status, value) = match provider_call(
        &state,
        &route,
        reqwest::Method::POST,
        &route.upstream_path,
        Some(json!({ "content_base64": encoded, "filename": filename })),
        PROVIDER_TIMEOUT,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("document parser rejected this file");
        return (
            status,
            Json(json!({
                "error": msg,
                "code": value.get("error_code").and_then(Value::as_str).unwrap_or("provider_error"),
                "provider": route.provider_id,
                "provider_name": provider_name,
            })),
        )
            .into_response();
    }

    let Some(job_id) = value.get("job_id").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "document parser accepted the file but returned no job id",
                "code": "provider_contract",
            })),
        )
            .into_response();
    };

    Json(json!({
        "status": value.get("status").and_then(Value::as_str).unwrap_or("queued"),
        "via": route.provider_id,
        "provider_name": provider_name,
        "job_id": job_id,
        "filename": filename,
    }))
    .into_response()
}

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
fn normalize_job(snapshot: &Value) -> Value {
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

/// Decode bytes Core can read itself, or say precisely why it cannot.
///
/// The floor, as a typed call. Differs from [`builtin_markdown`] in exactly one way:
/// a *mis-encoded* input is decoded anyway (BOM'd UTF-16 properly, anything else
/// lossily) with the compromise recorded in `warnings`, because this caller CAN carry
/// that nuance where an HTTP status code cannot. That tolerance stops at bytes which
/// are not text at all — those are [`ParseFailureReason::NotText`], see [`decode_text`].
/// A non-floor extension is [`ParseFailureReason::Unsupported`] — never an empty
/// string, which is the one answer that would let a document disappear silently.
pub fn builtin_parse(filename: &str, bytes: &[u8]) -> Result<ParseOutcome, ParseFailure> {
    if bytes.len() > MAX_BLOB_PARSE_BYTES {
        return Err(ParseFailure::new(
            ParseFailureReason::TooLarge,
            // No file name: this message is stored in the file-index status.
            format!(
                "the file is {} bytes, over the {}-byte limit",
                bytes.len(),
                MAX_BLOB_PARSE_BYTES
            ),
        ));
    }
    if !is_builtin_readable(filename) {
        return Err(ParseFailure::new(
            ParseFailureReason::Unsupported,
            format!(
                "Core reads no text out of {} on its own",
                display_extension(filename)
            ),
        ));
    }

    let (text, mut warnings) = decode_text(bytes)?;
    let (markdown, truncated) = truncate_markdown(&apply_html_strip(filename, &text));
    if truncated {
        warnings.push(format!(
            "output was truncated at {MAX_MARKDOWN_BYTES} bytes"
        ));
    }
    Ok(ParseOutcome {
        markdown,
        backend_id: BUILTIN_BACKEND_ID.to_owned(),
        backend_version: env!("CARGO_PKG_VERSION").to_owned(),
        source_sha256: sha256_hex(bytes),
        parsed_at: chrono::Utc::now(),
        warnings,
        truncated,
    })
}

/// `".pdf"`, or `"this file"` when there is no extension — for a message a human reads.
fn display_extension(filename: &str) -> String {
    let ext = extension_of(filename);
    if ext.is_empty() {
        "this file".to_owned()
    } else {
        ext
    }
}

/// How many leading bytes the NUL probe in [`decode_text`] looks at.
///
/// 8 KiB, the same window `git` uses to call a blob binary. Bounded rather than
/// whole-file for one reason: a NUL is only *evidence* of a binary, and a text file
/// with one stray NUL a megabyte in is still a text file. Every real container puts
/// its NULs in the header — a zip's local file header has them by byte 30, PNG's
/// IHDR length by byte 8 — so a window this size costs nothing in detection.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// The share of decoded characters that may be U+FFFD before [`decode_text`] calls
/// the input binary rather than merely mis-encoded.
///
/// 10% is where "a legacy encoding we are approximating" stops and "these bytes are
/// not prose" starts. A latin-1 document decoded lossily loses only its accented
/// characters — a few percent of a European-language page — while a binary that
/// happens to carry no NUL in its first 8 KiB (a JPEG, a bare `%PDF` header) shreds
/// into replacement characters at several times this rate. The threshold is over
/// **decoded characters, not bytes**, because `from_utf8_lossy` collapses a run of
/// invalid bytes into one U+FFFD and the ratio must not depend on how they clump.
const MAX_REPLACEMENT_RATIO: f64 = 0.10;

/// UTF-8 first, BOM'd UTF-16 second, lossy last — with a warning for anything but the
/// first. Returns the text and whatever had to be compromised to get it, or
/// [`ParseFailureReason::NotText`] when the bytes are not plausibly text at all.
///
/// # Why this refuses rather than always decoding
///
/// The lossy last resort used to be unconditional, and the floor's `is_builtin_readable`
/// gate was the only thing standing between a binary and it. That gate is keyed on the
/// **name**, and a name is client-supplied:
///
/// - `payload.txt` holding a zip takes the extension arm;
/// - `notes` + `mime: text/plain` takes the [`mime_floor_name`] arm, and title and mime
///   arrive independently from the same request body (`POST /api/spaces/:id/files`), the
///   same tool arguments (`artifact.create`), or the request's own `content-type`
///   (`POST /api/uploads`).
///
/// Either way the bytes reached the decoder and came back as a page of replacement
/// characters, which [`crate::space_file_index`] then chunked, embedded and stored **as
/// the document's contents**. Mojibake presented as prose is worse than an unreadable
/// file, because a model will reason about it and a user cannot tell it happened.
///
/// # The two signals, and why they are only these two
///
/// This is not a content sniffer and must not grow into one — guessing formats is what
/// a `document.parse` provider is for. It refuses the *obvious* case on two cheap,
/// standard tests: a NUL byte in the first [`BINARY_SNIFF_BYTES`] (no text encoding
/// this floor accepts produces one — UTF-16, which does, is decoded on the arm above
/// and never reaches the probe), and a decoded U+FFFD share over
/// [`MAX_REPLACEMENT_RATIO`]. Anything subtler is allowed through with the warning it
/// always had; the compromise stays visible either way.
fn decode_text(bytes: &[u8]) -> Result<(String, Vec<String>), ParseFailure> {
    // UTF-16 leads, because its ASCII content is half NUL bytes and the probe below
    // would refuse a legitimately-decodable file. A BOM'd stream is never valid UTF-8
    // (0xFF/0xFE cannot start one), so testing it before or after the UTF-8 arm is the
    // same answer — but it MUST come before the NUL probe.
    if let Some(text) = decode_utf16_bom(bytes) {
        return Ok((text, vec!["input was UTF-16; decoded to UTF-8".to_owned()]));
    }
    if let Some(at) = nul_byte_offset(bytes) {
        return Err(ParseFailure::new(
            ParseFailureReason::NotText,
            format!(
                "these bytes are not text: a NUL byte at offset {at} means the file is \
                 binary, whatever its name or declared type says"
            ),
        ));
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_owned(), Vec::new()));
    }

    let text = String::from_utf8_lossy(bytes).into_owned();
    let ratio = replacement_ratio(&text);
    if ratio > MAX_REPLACEMENT_RATIO {
        return Err(ParseFailure::new(
            ParseFailureReason::NotText,
            format!(
                "these bytes are not text: {:.0}% of them do not decode as UTF-8, so \
                 reading this file would store replacement characters as its contents",
                ratio * 100.0
            ),
        ));
    }
    Ok((
        text,
        vec!["input was not valid UTF-8; undecodable bytes were replaced".to_owned()],
    ))
}

/// Offset of the first NUL byte within the sniff window, or `None`.
fn nul_byte_offset(bytes: &[u8]) -> Option<usize> {
    bytes.iter().take(BINARY_SNIFF_BYTES).position(|b| *b == 0)
}

/// The share of `text`'s characters that are U+FFFD. `0.0` for empty input — an empty
/// file is not binary, it is empty, and [`crate::space_file_index`] already has a state
/// for that (`skipped/empty_document`).
fn replacement_ratio(text: &str) -> f64 {
    let mut total = 0usize;
    let mut replacements = 0usize;
    for c in text.chars() {
        total += 1;
        if c == '\u{FFFD}' {
            replacements += 1;
        }
    }
    if total == 0 {
        return 0.0;
    }
    replacements as f64 / total as f64
}

/// Decode a BOM-prefixed UTF-16 stream, or `None` when there is no BOM.
///
/// BOM-only: sniffing UTF-16 without one means guessing from byte statistics, and a
/// wrong guess produces confident nonsense. No BOM ⇒ fall through to lossy, which at
/// least says so.
fn decode_utf16_bom(bytes: &[u8]) -> Option<String> {
    let (rest, big_endian) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (rest, false),
        [0xFE, 0xFF, rest @ ..] => (rest, true),
        _ => return None,
    };
    if rest.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = rest
        .chunks_exact(2)
        .map(|p| {
            if big_endian {
                u16::from_be_bytes([p[0], p[1]])
            } else {
                u16::from_le_bytes([p[0], p[1]])
            }
        })
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// Lowercase hex sha256. Mirrors the Spaces store's blob addressing so a caller can
/// hand us a sha and get the same one back on the outcome.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// The on-disk path of a content-addressed blob, after validating the address.
///
/// **The validation is the point.** `sha256` reaches us from a store row that
/// ultimately came from a client, and the result is joined onto a filesystem root
/// and handed to another process to open. A 64-lowercase-hex check makes traversal
/// unrepresentable — there is no `..`, no separator, and no absolute path in the
/// accepted alphabet — which is a stronger guarantee than sanitising after the fact.
/// (The sidecar re-checks containment on its side; this is the near half of the same
/// fence.)
///
/// A rejected address is [`ParseFailureReason::BlobUnavailable`], **not**
/// `Unsupported`: the commonest way to get here is a file document whose `sha256` is
/// empty, and calling that "no parser can read this format" sent the user to the
/// Store to fix a broken storage row.
pub fn blob_input_path(sha256: &str) -> Result<std::path::PathBuf, ParseFailure> {
    let valid = sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            if sha256.is_empty() {
                "this document has no stored blob to read".to_owned()
            } else {
                "blob address is not a 64-character lowercase hex sha256".to_owned()
            },
        ));
    }
    let shard = &sha256[..2];
    Ok(crate::paths::files_path("blobs").join(shard).join(sha256))
}

/// Owner of the decrypted parser inputs under `tmp/`.
const PARSE_TMP_OWNER: &str = "document-parse";

/// Decrypted inputs older than this are crash or abandoned-job leftovers.
const PARSE_INPUT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// A blob decrypted for a parser that needs a path: an owner-only (`0600`) file
/// in `tmp/document-parse/` (`0700`), removed when this value drops.
///
/// Blobs are sealed (`RYU-SF01`) at rest, so a provider can no longer open the
/// stored file. This is the plaintext-in-flight copy the design allows for tools
/// that need a path: unique name, owner-only, deleted when the job ends or its
/// poller gives up ([`release_input`]). A crash leaves no job to finish, so Core
/// empties the directory at startup ([`sweep_on_start`]), and every submission
/// removes any file no running job holds.
struct DecryptedBlobInput {
    path: std::path::PathBuf,
    created: std::time::Instant,
}

impl DecryptedBlobInput {
    /// Claim `path` before anything is written to it, so a concurrent sweep
    /// never removes a copy whose job id is not known yet.
    fn claim(path: std::path::PathBuf) -> Self {
        if let Ok(mut live) = live_parse_inputs().lock() {
            live.insert(path.clone());
        }
        Self {
            path,
            created: std::time::Instant::now(),
        }
    }
}

impl Drop for DecryptedBlobInput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Ok(mut live) = live_parse_inputs().lock() {
            live.remove(&self.path);
        }
    }
}

/// Paths of every decrypted input alive in this process (submitting or
/// waiting for its job).
fn live_parse_inputs() -> &'static std::sync::Mutex<HashSet<std::path::PathBuf>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<HashSet<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

/// Decrypted inputs of provider jobs still running, by job id.
fn pending_parse_inputs(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, DecryptedBlobInput>> {
    static PENDING: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, DecryptedBlobInput>>,
    > = std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Drop decrypted inputs of jobs nobody polled for a long time, and remove
/// every file in the scratch directory that no running job holds (crash
/// leftovers), whatever its age.
fn sweep_parse_inputs(dir: &std::path::Path) {
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.retain(|_, input| input.created.elapsed() < PARSE_INPUT_MAX_AGE);
    }
    let held: HashSet<std::path::PathBuf> = live_parse_inputs()
        .lock()
        .map(|live| live.clone())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !held.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Empty the decrypted-input directory at Core startup. No provider job
/// survives a restart (the job map lives in memory), so anything there is a
/// plaintext copy a crash or kill left behind. Call before any parse can be
/// submitted.
pub fn sweep_on_start() {
    sweep_parse_inputs(&crate::paths::tmp_dir_for(PARSE_TMP_OWNER));
}

/// Release the decrypted input of a job its poller abandoned (poll budget
/// spent): the file is deleted now rather than when the job map entry ages
/// out. Harmless for an unknown or already finished job.
pub fn release_input(job_id: &str) {
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.remove(job_id);
    }
}

/// Decrypt the blob `sha256` into a fresh owner-only file whose name keeps the
/// original extension (parsers dispatch on it).
async fn decrypt_blob_input(
    sha256: &str,
    filename: &str,
) -> Result<DecryptedBlobInput, ParseFailure> {
    blob_input_path(sha256)?;
    let dir = crate::paths::tmp_dir_for(PARSE_TMP_OWNER);
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty() && ext.len() <= 16 && ext.chars().all(char::is_alphanumeric))
        .map(|ext| format!(".{}", ext.to_ascii_lowercase()))
        .unwrap_or_default();
    let path = dir.join(format!("{}{extension}", uuid::Uuid::new_v4().simple()));
    // Claimed first: dropped on any error below, which deletes a partial copy.
    let input = DecryptedBlobInput::claim(path.clone());
    let blob_root = crate::paths::files_path("blobs");
    let sha = sha256.to_owned();
    let target = path.clone();
    let decrypted = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        sweep_parse_inputs(&dir);
        ryu_spaces::decrypt_blob_to_path(&blob_root, &sha, &target)
    })
    .await
    .map_err(|e| {
        ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("decrypting blob {sha256} failed: {e}"),
        )
    })?
    .map_err(|e| {
        ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: {e:#}"),
        )
    })?;
    if !decrypted {
        return Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: it is not in the blob store"),
        ));
    }
    Ok(input)
}

/// Read (and decrypt) a whole blob for the built-in floor, verifying its digest.
async fn read_blob_bytes(sha256: &str) -> Result<Vec<u8>, ParseFailure> {
    blob_input_path(sha256)?;
    let blob_root = crate::paths::files_path("blobs");
    let sha = sha256.to_owned();
    let read = tokio::task::spawn_blocking(move || ryu_spaces::read_blob_at(&blob_root, &sha))
        .await
        .map_err(|e| {
            ParseFailure::new(
                ParseFailureReason::BlobUnavailable,
                format!("reading blob {sha256} failed: {e}"),
            )
        })?;
    match read {
        Ok(Some(bytes)) => Ok(bytes),
        Ok(None) => Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: it is not in the blob store"),
        )),
        Err(e) => Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            format!("cannot read blob {sha256}: {e:#}"),
        )),
    }
}

/// Whether the host has a Python interpreter to bootstrap a sidecar venv from.
///
/// Probed only on the failure path — a bound provider that will not start is either
/// a broken install or a host with no Python, and only the second one has an
/// instruction the user can act on.
async fn host_python_missing() -> bool {
    let exe = crate::sidecar::external_runtime::bootstrap_python();
    tokio::process::Command::new(exe)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .is_err()
}

/// Wake the provider sidecar if it is lazy, and hold it for this hop — the typed twin
/// of [`wake_provider`].
///
/// Used by BOTH submit and poll, deliberately. Polling is the documented mechanism
/// that re-arms the activity guard across a multi-minute parse, so a poll that only
/// took `enter_request` would fail against exactly the provider the job protocol
/// exists for: one that idle-stopped while its own parse was queued.
async fn hold_provider(
    state: &ServerState,
    route: &ProviderRoute,
) -> Result<Option<crate::sidecar::manager::ActivityGuard>, ParseFailure> {
    let Some(wake) = route.wake_name.as_ref() else {
        return Ok(None);
    };
    if let Err(failure) = state
        .manager
        .wake_and_await_healthy(wake, WAKE_TIMEOUT)
        .await
    {
        // A bound provider that will not start is either a broken install or a host
        // with no Python, and only the second has an instruction the user can act on.
        if host_python_missing().await {
            return Err(ParseFailure::new(
                ParseFailureReason::PythonMissing,
                format!("document parser '{wake}' did not become healthy"),
            ));
        }
        // Still starting: the manager's detached start keeps provisioning, so this is
        // the retryable answer, and the next parse finds the sidecar warm.
        return Err(if crate::sidecar::manager::is_still_starting(&failure) {
            ParseFailure::new(
                ParseFailureReason::ProviderTimeout,
                format!(
                    "document parser '{wake}' is still starting (a first start installs \
                     its Python environment); retry shortly"
                ),
            )
        } else {
            ParseFailure::new(
                ParseFailureReason::ProviderError,
                format!("document parser '{wake}' failed to start: {failure:#}"),
            )
        });
    }
    Ok(Some(state.manager.enter_request(wake)))
}

/// Submit a Spaces blob for extraction: floor if Core can read it, otherwise a job on
/// the bound provider.
///
/// **The blob travels as a PATH, not as bytes.** Space files reach 200 MiB while the
/// ext-proxy caps a forwarded body at 10 MiB and base64 costs another third on top,
/// so inlining a large document is not merely wasteful, it is unrepresentable. The
/// provider runs on this machine and already has `${RYU_DIR}` in its allow-list, so it
/// opens the file itself. Core resolves the sha (never the provider), which keeps
/// the shard layout — and therefore a future object-store backend — Core's
/// business alone. Blobs are sealed at rest, so the path handed over is a
/// decrypted owner-only copy under `tmp/document-parse/`, deleted when the job
/// ends (see [`DecryptedBlobInput`]).
pub async fn submit_blob(
    state: &ServerState,
    blob_sha256: &str,
    filename: &str,
    mime: &str,
    size_bytes: u64,
) -> Result<ParseSubmission, ParseFailure> {
    blob_input_path(blob_sha256)?;

    // The floor, in the same two arms as
    // [`crate::space_file_index::create_file_indexed`] and for the same reason: the
    // extension is the primary signal, and a name that carries none is judged by its
    // declared mime instead (see [`mime_floor_name`]). Spelled out rather than hidden
    // behind one combined helper so that both entry points to the floor read
    // identically and neither can quietly acquire a different notion of it.
    let floor_name: Option<std::borrow::Cow<'_, str>> = if is_builtin_readable(filename) {
        Some(std::borrow::Cow::Borrowed(filename))
    } else {
        mime_floor_name(filename, mime).map(std::borrow::Cow::Owned)
    };

    if let Some(floor_name) = floor_name {
        // The address validated but the blob is not there (or does not open or
        // verify). That is this node's storage, not a missing parser — same
        // reasoning as [`blob_input_path`].
        let bytes = read_blob_bytes(blob_sha256).await?;
        let mut outcome = builtin_parse(&floor_name, &bytes)?;
        // Trust the caller's address over a recomputed one only when they agree;
        // a mismatch means the blob store handed us the wrong file, which the
        // caller must see rather than inherit silently.
        if outcome.source_sha256 != blob_sha256 {
            outcome.warnings.push(format!(
                "blob content hashes to {} but was addressed as {blob_sha256}",
                outcome.source_sha256
            ));
        }
        return Ok(ParseSubmission::Done(Box::new(outcome)));
    }

    let Some((route, _)) = bound_provider(state).await else {
        return Err(ParseFailure::new(
            ParseFailureReason::NoProvider,
            format!(
                "no document parser is installed that can read {}",
                display_extension(filename)
            ),
        ));
    };

    let _activity = hold_provider(state, &route).await?;

    // Blobs are sealed at rest: the provider gets a decrypted owner-only copy,
    // kept until the job is polled to an end (then deleted).
    let input = decrypt_blob_input(blob_sha256, filename).await?;
    let (status, value) = provider_call_typed(
        state,
        &route,
        reqwest::Method::POST,
        &route.upstream_path,
        Some(json!({
            "path": input.path.to_string_lossy(),
            "blob_sha256": blob_sha256,
            "filename": filename,
            "mime": mime,
            "size_bytes": size_bytes,
        })),
        PROVIDER_TIMEOUT,
    )
    .await?;

    if !status.is_success() {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("document parser rejected this file")
                .to_owned(),
        ));
    }
    let Some(job_id) = value.get("job_id").and_then(Value::as_str) else {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            "document parser accepted the file but returned no job id",
        ));
    };
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.insert(job_id.to_owned(), input);
    }
    Ok(ParseSubmission::Job {
        job_id: job_id.to_owned(),
        backend_id: route.provider_id.clone(),
    })
}

/// Poll a job from [`submit_blob`]. `Ok(None)` means still running — not an error and
/// not an empty document.
pub async fn job_outcome(
    state: &ServerState,
    job_id: &str,
    source_sha256: &str,
) -> Result<Option<ParseOutcome>, ParseFailure> {
    let outcome = job_outcome_inner(state, job_id, source_sha256).await;
    // Any end of the job (success, failure, unknown job) releases its decrypted
    // input; only "still running" keeps it.
    if !matches!(outcome, Ok(None)) {
        if let Ok(mut pending) = pending_parse_inputs().lock() {
            pending.remove(job_id);
        }
    }
    outcome
}

async fn job_outcome_inner(
    state: &ServerState,
    job_id: &str,
    source_sha256: &str,
) -> Result<Option<ParseOutcome>, ParseFailure> {
    let Some((route, _)) = bound_provider(state).await else {
        return Err(ParseFailure::new(
            ParseFailureReason::NoProvider,
            "the document parser was disabled while this file was parsing",
        ));
    };
    let _activity = hold_provider(state, &route).await?;

    let (status, value) = provider_call_typed(
        state,
        &route,
        reqwest::Method::GET,
        &sibling_path(&route, &format!("jobs/{job_id}")),
        None,
        PROVIDER_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        return Err(ParseFailure::new(
            ParseFailureReason::ProviderError,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown parse job")
                .to_owned(),
        ));
    }

    let normalized = normalize_job(&value);
    match normalized["status"].as_str().unwrap_or("running") {
        "queued" | "running" => Ok(None),
        "succeeded" => {
            let markdown = normalized["markdown"].as_str().unwrap_or_default();
            let mut warnings: Vec<String> = value
                .get("result")
                .and_then(|r| r.get("warnings"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            for dep in normalized["missing_dependencies"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                warnings.push(format!("missing system dependency: {dep}"));
            }
            let truncated = normalized["truncated"].as_bool().unwrap_or(false);
            if truncated {
                warnings.push("output was truncated".to_owned());
            }
            Ok(Some(ParseOutcome {
                markdown: markdown.to_owned(),
                backend_id: route.provider_id.clone(),
                backend_version: value
                    .get("result")
                    .and_then(|r| r.get("backend_version"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                source_sha256: source_sha256.to_owned(),
                parsed_at: chrono::Utc::now(),
                warnings,
                truncated,
            }))
        }
        // `cancelled` and `failed` are both "no text, and here is why".
        _ => {
            let message = normalized["error"]
                .as_str()
                .unwrap_or("the parser returned no text for this file")
                .to_owned();
            let reason = if value.get("error_code").and_then(Value::as_str) == Some("timeout") {
                ParseFailureReason::ProviderTimeout
            } else {
                ParseFailureReason::ProviderError
            };
            Err(ParseFailure::new(reason, message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `apps/core/src/server/mod.rs`, read as text. The route table is a builder
    /// chain inside an `async fn` that needs a live `ServerState`, so there is no
    /// cheap way to introspect the assembled `Router` for a path; the two source
    /// tests below therefore read the registration the same way
    /// `server::mod`'s own guard tests read theirs (`include_str!("voice_ws.rs")`,
    /// `include_str!("learning.rs")`).
    const SERVER_MOD_SRC: &str = include_str!("server/mod.rs");

    /// Whether the route table registers `path` as a literal route.
    ///
    /// Anchored on `.route(` + the QUOTED path, not a bare `contains`. Two ways a
    /// bare substring test lies here, and this module trips both:
    ///
    /// - `"/api/documents/parse"` is a prefix of the registered
    ///   `"/api/documents/parse/capability"`, so `contains` on the unquoted form
    ///   cannot tell the submit route from the capability route;
    /// - rustfmt moves a registration onto its own lines once the handler list
    ///   grows, so an indentation-sensitive needle reports a mounted route as
    ///   absent.
    ///
    /// The closing quote is what makes the prefix case exact; `\s*` is what makes
    /// it formatting-proof. Mirrors `isRegistered` in
    /// `apps/desktop/src/lib/api/documents.test.ts`, deliberately: the same
    /// question is asked from both sides of the wire.
    fn is_registered(path: &str) -> bool {
        let needle = format!("\"{path}\"");
        SERVER_MOD_SRC.match_indices(".route(").any(|(at, marker)| {
            let rest = SERVER_MOD_SRC[at + marker.len()..].trim_start();
            rest.starts_with(&needle)
        })
    }

    /// The mounted route is registered, by literal path AND by handler.
    ///
    /// Both halves matter and neither implies the other: the path string alone
    /// could be a doc comment, and the handler alone could be a re-export. This
    /// pair is what failed before — the handler existed, carried its `utoipa`
    /// annotation and was `pub`, and simply appeared in no route table, so the
    /// desktop's only reader of it 404'd and rendered an empty panel.
    #[test]
    fn parse_capability_is_registered_in_the_route_table() {
        assert!(
            is_registered("/api/documents/parse/capability"),
            "the capability route's path must appear in the route table"
        );
        assert!(
            SERVER_MOD_SRC.contains("get(crate::document_parse::parse_capability)"),
            "the capability path must be wired to THIS handler"
        );
    }

    /// The submit and poll routes are registered and wired to these handlers, and
    /// neither still carries the `#[allow(dead_code)]` gate it had while unmounted
    /// (a live route documented as dead code misleads the next reader).
    #[test]
    fn the_submit_and_poll_handlers_are_mounted_and_ungated() {
        let this_file = include_str!("document_parse.rs");
        for (handler, path) in [
            ("parse_document", "/api/documents/parse"),
            ("parse_job", "/api/documents/parse/jobs/:job_id"),
        ] {
            let signature = format!("pub async fn {handler}(");
            let declaration = this_file
                .find(&signature)
                .unwrap_or_else(|| panic!("{handler} is declared in this module"));
            let preamble = &this_file[declaration.saturating_sub(200)..declaration];
            assert!(
                !preamble.contains("#[allow(dead_code)]"),
                "{handler} is mounted, so it must not be gated as dead code"
            );
            assert!(
                is_registered(path),
                "{handler} must be registered at {path}"
            );
            assert!(
                SERVER_MOD_SRC.contains(&format!("crate::document_parse::{handler}")),
                "{path} must be wired to {handler}"
            );
        }
        assert!(
            SERVER_MOD_SRC.contains(
                "uploads::DOCUMENT_PARSE_BODY_LIMIT.apply(post(crate::document_parse::parse_document))"
            ),
            "the submit route must carry its explicit body limit"
        );
    }

    /// The number the desktop's parsing panel prints is the node's real ceiling.
    ///
    /// `max_input_bytes` in the capability response is [`MAX_PARSE_BYTES`], and a
    /// document only reaches a parser by being uploaded first, so the two must not
    /// drift: a panel that printed a parse ceiling above the upload ceiling would
    /// promise a file size the node refuses at the door.
    #[test]
    fn the_reported_parse_ceiling_is_the_upload_ceiling() {
        assert_eq!(MAX_PARSE_BYTES, crate::server::uploads::MAX_UPLOAD_BYTES);
    }

    #[test]
    fn extension_of_takes_the_last_dot_lowercased() {
        assert_eq!(extension_of("Report.PDF"), ".pdf");
        assert_eq!(extension_of("/tmp/a.b/notes.md"), ".md");
        assert_eq!(extension_of("archive.tar.gz"), ".gz");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("trailing."), "");
    }

    #[test]
    fn floor_claims_text_families_and_refuses_real_documents() {
        assert!(is_builtin_readable("notes.md"));
        assert!(is_builtin_readable("data.CSV"));
        // The floor must never claim a format it would mangle.
        assert!(!is_builtin_readable("report.pdf"));
        assert!(!is_builtin_readable("deck.pptx"));
        assert!(!is_builtin_readable("scan.png"));
    }

    #[test]
    fn builtin_markdown_refuses_non_utf8_rather_than_producing_mojibake() {
        assert!(builtin_markdown("a.txt", b"hello").is_some());
        assert!(builtin_markdown("a.txt", &[0xff, 0xfe, 0x00, 0x41]).is_none());
    }

    #[test]
    fn html_is_tag_stripped_and_script_bodies_are_dropped() {
        let html = "<html><head><style>p{color:red}</style></head><body>\
             <h1>Title</h1><p>Body &amp; more</p><script>alert('x')</script></body></html>";
        let (md, _) = builtin_markdown("page.html", html.as_bytes()).expect("utf-8");
        assert!(md.contains("Title"), "{md}");
        assert!(md.contains("Body & more"), "{md}");
        assert!(!md.contains("color:red"), "style body survived: {md}");
        assert!(!md.contains("alert"), "script body survived: {md}");
        assert!(!md.contains('<'), "markup survived: {md}");
    }

    #[test]
    fn amp_entity_is_decoded_last_so_double_encoding_survives() {
        assert_eq!(strip_html("<p>&amp;lt;</p>"), "&lt;");
    }

    #[test]
    fn typed_floor_reports_a_lossy_decode_instead_of_hiding_it() {
        // A line of prose with one byte from some other encoding in it — a latin-1
        // accent, a truncated write. That is still a text file, so it decodes with the
        // compromise recorded rather than being refused.
        //
        // The fixture used to be `b"hi\xff"`, which no longer qualifies: one bad byte
        // in three is 33% of the decoded characters, over `MAX_REPLACEMENT_RATIO`, and
        // a file that is a third replacement characters is not a file whose text we
        // recovered. The invariant this test is named for — a compromise is REPORTED,
        // never silent — is unchanged and is what the assertions below still check.
        let mut bytes = b"the colony subsists on native grasses".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b" and succulents.");
        let outcome = builtin_parse("a.txt", &bytes).expect("lossy floor answers");
        assert!(outcome.markdown.starts_with("the colony"));
        assert!(outcome.markdown.ends_with("succulents."));
        assert_eq!(outcome.warnings.len(), 1, "{:?}", outcome.warnings);
        assert!(outcome.warnings[0].contains("not valid UTF-8"));
        assert_eq!(outcome.backend_id, BUILTIN_BACKEND_ID);
    }

    #[test]
    fn the_floor_refuses_bytes_that_are_not_text_rather_than_decoding_them_lossily() {
        // The defect: `is_builtin_readable` is keyed on the NAME, and the name is
        // client-supplied, so binary bytes under a floor extension reached the lossy
        // decoder and their mojibake was stored as the document's contents.
        //
        // Two signals, one case each. A NUL byte (every real container has one in its
        // header) and an undecodable-character share over the threshold (for the
        // formats that do not, like a bare `%PDF` header).
        for (name, bytes) in [
            ("payload.txt", b"PK\x03\x04\x14\x00\x00\x00".to_vec()),
            ("logo.txt", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec()),
            ("report.txt", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec()),
        ] {
            let err = builtin_parse(name, &bytes)
                .expect_err("binary bytes must not decode into a document");
            assert_eq!(err.reason, ParseFailureReason::NotText, "{name}");
            assert_eq!(err.reason.code(), "not_text");
            assert!(
                err.message.contains("not text"),
                "the user has to be told what actually happened: {}",
                err.message
            );
        }
    }

    #[test]
    fn a_bomless_utf16_file_is_refused_rather_than_read_as_nul_separated_ascii() {
        // UTF-16LE ASCII is `A\0B\0…`, which IS valid UTF-8 — so the strict arm used to
        // accept it, with no warning at all, and store a string full of NULs. The NUL
        // probe runs before the UTF-8 arm precisely for this.
        let mut bytes = Vec::new();
        for unit in "hello there".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let err = builtin_parse("a.txt", &bytes).expect_err("NUL-riddled bytes are not text");
        assert_eq!(err.reason, ParseFailureReason::NotText);
        // And the BOM'd form of the same content still decodes, because the UTF-16 arm
        // is deliberately ahead of the probe. Refusing that would be a regression.
        let mut bommed = vec![0xFF, 0xFE];
        bommed.extend_from_slice(&bytes);
        assert_eq!(
            builtin_parse("a.txt", &bommed)
                .expect("BOM'd UTF-16 still reads")
                .markdown,
            "hello there"
        );
    }

    #[test]
    fn typed_floor_decodes_bom_utf16_without_replacement_characters() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "héllo".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let outcome = builtin_parse("a.txt", &bytes).expect("utf-16 floor answers");
        assert_eq!(outcome.markdown, "héllo");
        assert!(!outcome.markdown.contains('\u{FFFD}'));
    }

    #[test]
    fn typed_floor_refuses_a_binary_format_instead_of_returning_empty() {
        let err = builtin_parse("report.pdf", b"%PDF-1.7").expect_err("no floor for pdf");
        assert_eq!(err.reason, ParseFailureReason::Unsupported);
    }

    #[test]
    fn typed_floor_reports_source_sha_of_the_input_bytes() {
        let outcome = builtin_parse("a.md", b"hello").expect("floor");
        // sha256("hello")
        assert_eq!(
            outcome.source_sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    // ── The mime floor fallback ───────────────────────────────────────────────

    #[test]
    fn a_title_with_no_extension_reaches_the_floor_through_its_mime() {
        // The defect: `POST /api/spaces/:id/files` and `artifact.create` pass a
        // TITLE, so a plain-text note called `notes` answered `false` to the
        // extension-keyed floor and was sent to a provider that would refuse it —
        // `skipped/no_provider`, "install a document parser", for a file Core reads
        // itself in microseconds.
        assert!(!is_builtin_readable("notes"));
        assert_eq!(
            mime_floor_name("notes", "text/plain").as_deref(),
            Some("notes.txt")
        );
        assert!(is_builtin_readable(
            &mime_floor_name("notes", "text/plain").unwrap()
        ));
        // A charset parameter and odd casing are the same media type.
        assert_eq!(
            mime_floor_name("Q3 summary", "Text/Plain; charset=utf-8").as_deref(),
            Some("Q3 summary.txt")
        );
        assert_eq!(
            mime_floor_name("data", "text/csv").as_deref(),
            Some("data.csv")
        );
        assert_eq!(
            mime_floor_name("page", "text/html").as_deref(),
            Some("page.html")
        );
    }

    #[test]
    fn the_mime_fallback_never_redirects_a_binary_into_the_text_reader() {
        // ── Arm one: inputs that DECLARE themselves binary are not given a floor name.
        //
        // A mime is client-supplied; when it disagrees with an extension the floor
        // already refused, honouring it would hand a zip container to the decoder.
        assert_eq!(mime_floor_name("deck.pptx", "text/plain"), None);
        assert_eq!(mime_floor_name("report.pdf", "text/markdown"), None);
        // Nothing binary-ish maps at all, extension or not.
        assert_eq!(mime_floor_name("scan", "application/pdf"), None);
        assert_eq!(mime_floor_name("blob", "application/octet-stream"), None);
        assert_eq!(mime_floor_name("archive", "application/zip"), None);
        // `application/octet-stream` is what `POST /api/spaces/:id/files` DEFAULTS to
        // when a client sends no mime, so a hit on it would widen the floor to every
        // untyped upload — the single worst case.
        assert_eq!(mime_floor_name("notes", ""), None);
        // An extension that is already on the floor needs no fallback and gets none:
        // arm one has already claimed it.
        assert_eq!(mime_floor_name("notes.md", "text/markdown"), None);

        // ── Arm two: binary BYTES that the fallback DOES accept a name for.
        //
        // This half is why the test was rewritten. Its name claims the fallback never
        // redirects a binary into the text reader, and every assertion above is about
        // a binary-*declaring* input — the case the name check catches. It never fed
        // binary bytes down the path the fallback ACCEPTS, which is the only path that
        // could break the invariant, and that path was broken the whole time: title and
        // mime are independent client input, so `notes` + `text/plain` holding a zip got
        // the floor name `notes.txt`, decoded lossily, and stored a page of replacement
        // characters as the document's contents.
        //
        // The floor name is still handed out here — a title with no extension
        // contradicts nothing, so there is nothing for `mime_floor_name` to refuse on.
        // The refusal is the decoder's, one layer down, and that is what this asserts.
        for (mime, bytes) in [
            ("text/plain", b"PK\x03\x04\x14\x00\x00\x00".to_vec()),
            ("text/csv", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec()),
            ("text/markdown", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec()),
        ] {
            let floor_name =
                mime_floor_name("notes", mime).expect("an extensionless title still gets a name");
            assert!(is_builtin_readable(&floor_name));
            let err = builtin_parse(&floor_name, &bytes)
                .expect_err("binary bytes must not become a document's text");
            assert_eq!(err.reason, ParseFailureReason::NotText, "{mime}");
        }

        // The control: the same accepted path with bytes that ARE text still reads,
        // which is the whole point of the fallback and must not be collateral damage.
        let floor_name = mime_floor_name("notes", "text/plain").unwrap();
        assert_eq!(
            builtin_parse(&floor_name, b"quokkas are small macropods")
                .expect("real text still reaches the floor")
                .markdown,
            "quokkas are small macropods"
        );
    }

    #[test]
    fn every_mime_fallback_lands_on_an_extension_the_floor_already_reads() {
        // The invariant that makes this table safe to extend: it may only re-route a
        // document to a reader Core would have used anyway, never introduce a family.
        for (mime, ext) in MIME_FLOOR_EXTENSIONS {
            assert!(
                BUILTIN_EXTENSIONS.contains(ext),
                "{mime} maps to {ext}, which is not on the floor"
            );
            assert!(
                is_builtin_readable(&format!("x{ext}")),
                "{ext} does not survive the floor's own check"
            );
        }
    }

    #[test]
    fn crash_leftovers_go_at_startup_and_abandoned_jobs_release_their_input() {
        let dir = crate::paths::tmp_dir_for(PARSE_TMP_OWNER);
        std::fs::create_dir_all(&dir).unwrap();
        // A fresh plaintext copy a killed Core left behind.
        let leftover = dir.join(format!("{}.pdf", uuid::Uuid::new_v4().simple()));
        std::fs::write(&leftover, b"plaintext left by a crash").unwrap();
        // A copy a running job still needs.
        let live_path = dir.join(format!("{}.pdf", uuid::Uuid::new_v4().simple()));
        let live = DecryptedBlobInput::claim(live_path.clone());
        std::fs::write(&live_path, b"in use").unwrap();

        sweep_on_start();
        assert!(!leftover.exists(), "a leftover of any age is removed");
        assert!(live_path.exists(), "a live job's input is kept");

        // The poller gives up: the input goes now, not hours later.
        let job_id = format!("job-{}", uuid::Uuid::new_v4().simple());
        pending_parse_inputs()
            .lock()
            .unwrap()
            .insert(job_id.clone(), live);
        release_input(&job_id);
        assert!(!live_path.exists(), "an abandoned job's input is deleted");
        assert!(!live_parse_inputs().lock().unwrap().contains(&live_path));
    }

    #[tokio::test]
    async fn sealed_blobs_reach_parsers_only_as_private_temporary_copies() {
        let bytes = b"quarterly figures for the parser".to_vec();
        let sha: String = {
            use sha2::{Digest, Sha256};
            Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        };
        let path = blob_input_path(&sha).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let cipher = ryu_crypto::content_cipher(ryu_spaces::BLOB_STORE).unwrap();
        let context = ryu_crypto::content::ContentContext::for_id("blob", &sha);
        let mut writer = ryu_crypto::SealedFileWriter::create(&path, &cipher, &context).unwrap();
        writer.write_plain(&bytes).unwrap();
        writer.finish().unwrap();

        // The floor reads decrypted, verified bytes.
        assert_eq!(read_blob_bytes(&sha).await.unwrap(), bytes);
        // A provider gets an owner-only copy that disappears with the job.
        let input = decrypt_blob_input(&sha, "report.PDF").await.unwrap();
        assert!(input
            .path
            .starts_with(crate::paths::tmp_dir_for(PARSE_TMP_OWNER)));
        assert_eq!(input.path.extension().and_then(|e| e.to_str()), Some("pdf"));
        assert_eq!(std::fs::read(&input.path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&input.path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let copy = input.path.clone();
        drop(input);
        assert!(
            !copy.exists(),
            "the decrypted copy is removed after the job"
        );
        // A missing blob is BlobUnavailable, not a missing parser.
        let missing = "b".repeat(64);
        let err = read_blob_bytes(&missing).await.unwrap_err();
        assert_eq!(err.reason, ParseFailureReason::BlobUnavailable);
    }

    #[test]
    fn a_missing_blob_is_not_reported_as_a_missing_parser() {
        // An empty `sha256` column used to fail as `Unsupported`, which
        // `space_file_index` records as `skipped` — whose remedy text is "install a
        // `document.parse` app". Nothing about a broken storage row is fixed by
        // installing a parser.
        let err = blob_input_path("").expect_err("an empty address is not a blob");
        assert_eq!(err.reason, ParseFailureReason::BlobUnavailable);
        assert_eq!(err.reason.code(), "blob_unavailable");
        assert_ne!(err.reason, ParseFailureReason::Unsupported);
        assert!(
            err.message.contains("no stored blob"),
            "the message must say what actually happened: {}",
            err.message
        );
    }

    #[test]
    fn blob_addresses_that_are_not_plain_hex_are_refused_before_any_join() {
        for bad in [
            "../../etc/passwd",
            "/etc/passwd",
            "ABCD",
            "",
            &"g".repeat(64),
            &"a".repeat(63),
        ] {
            assert!(
                blob_input_path(bad).is_err(),
                "accepted a bad blob address: {bad}"
            );
        }
        let good = "a".repeat(64);
        let path = blob_input_path(&good).expect("64 lowercase hex is the whole alphabet");
        // Component-wise, not a literal separator — this crate builds on Windows too.
        assert!(path.ends_with(std::path::Path::new("blobs").join("aa").join(&good)));
    }

    #[test]
    fn truncation_is_reported_and_lands_on_a_char_boundary() {
        let text = "é".repeat(MAX_MARKDOWN_BYTES);
        let (out, truncated) = truncate_markdown(&text);
        assert!(truncated);
        assert!(out.len() <= MAX_MARKDOWN_BYTES);
        // Round-trips as valid UTF-8 — the cut did not split a code point.
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn succeeded_with_no_markdown_normalizes_to_failed() {
        let snap = json!({ "status": "succeeded", "job_id": "j1", "result": {} });
        let out = normalize_job(&snap);
        assert_eq!(out["status"], "failed");
        assert!(out["error"].is_string(), "a caller must get a reason");
    }

    #[test]
    fn succeeded_with_markdown_passes_through_with_missing_deps() {
        let snap = json!({
            "status": "succeeded",
            "job_id": "j1",
            "filename": "a.pdf",
            "missing_dependencies": ["tesseract"],
            "result": { "markdown": "# Hi", "truncated": false },
        });
        let out = normalize_job(&snap);
        assert_eq!(out["status"], "succeeded");
        assert_eq!(out["markdown"], "# Hi");
        assert_eq!(out["missing_dependencies"][0], "tesseract");
    }

    #[test]
    fn provider_truncation_flag_survives_normalization() {
        let snap = json!({
            "status": "succeeded",
            "result": { "markdown": "short", "truncated": true },
        });
        assert_eq!(normalize_job(&snap)["truncated"], true);
    }
}
