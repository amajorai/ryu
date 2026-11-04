//! User-upload kernel surface — files land in the **Uploads** system space.
//!
//! Chat attachments, page/editor media, and the host `ui.uploadFile` bridge all
//! persist here (content-addressed Spaces blobs), not in the legacy
//! `~/.ryu/media/` store. The HTTP surface stays **ungated** by the Spaces app
//! (same reason `/api/media/*` is ungated): uploads are kernel storage that Voice
//! / chat / the editor need even when the Spaces UI is off. Serving is scoped to
//! documents that actually live in the Uploads space so this is not a backdoor
//! into arbitrary Space files.

use std::collections::HashMap;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::MethodRouter,
    Extension, Json,
};
use serde_json::json;

use super::spaces::{self, UPLOADS_SPACE_NAME};
use super::{caller_tenancy, ServerState};

mod limit_file;
pub use limit_file::*;
mod upload_file;
pub use upload_file::*;

#[cfg(test)]
mod tests;
