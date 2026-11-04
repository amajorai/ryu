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

mod mime_floor;
pub use mime_floor::*;
mod provider_resolution;
use provider_resolution::*;
mod routes;
pub use routes::*;
mod parse_failure;
pub use parse_failure::*;
mod decode_parse;
pub use decode_parse::*;
mod blob_submit;
pub use blob_submit::*;

#[cfg(test)]
mod tests;
