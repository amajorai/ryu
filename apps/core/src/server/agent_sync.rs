//! Ryu-canonical import/export state for external agent roots.
//!
//! This module deliberately keeps the sync ledger separate from the conversation
//! database.  A sync retry can therefore reconcile setup files and ACP metadata
//! without changing conversation rows, and a crash between a projection write and
//! the ledger update is recoverable by comparing the content hash again.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::{import::ImportSelection, server::ServerState};

// One module, split over files by responsibility. Each part is spliced in
// here, so every item keeps its path, its visibility and its order.
include!("agent_sync/types.rs");
include!("agent_sync/store.rs");
include!("agent_sync/routes.rs");
include!("agent_sync/item_handlers.rs");
include!("agent_sync/export.rs");
include!("agent_sync/projection.rs");
include!("agent_sync/hashing.rs");
include!("agent_sync/worker.rs");

#[cfg(test)]
#[path = "agent_sync_reconcile_test.rs"]
mod reconcile_tests;

#[cfg(test)]
#[path = "agent_sync_mcp_skip_test.rs"]
mod mcp_skip_tests;

#[cfg(test)]
#[path = "agent_sync_skill_sync_test.rs"]
mod skill_sync_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    include!("agent_sync/tests/profiles_and_bundle.rs");
    include!("agent_sync/tests/hashing_and_bindings.rs");
}
