//! Tests of the cross-device sync client, loop and payloads.

use super::*;
use crate::server::conversations::ConversationStore;
use axum::body::Body;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::sync::Arc;
use tokio::net::TcpListener;

mod backend;
mod branches;
mod documents;
mod loop_helpers;
mod merge;
mod transport;

/// Serializes env mutations for the sync-toggle tests so they never race the
/// shared `RYU_SYNC_ENABLED` var across the crate's single test binary.
static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn sample_payload(id: &str) -> SyncPayload {
    SyncPayload {
        conversation_id: id.to_owned(),
        title: Some("t".to_owned()),
        agent_id: Some("a".to_owned()),
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: Some("bob".to_owned()),
        created_at: 1,
        updated_at: 2,
        messages: vec![SyncMessage {
            id: "m1".to_owned(),
            role: "user".to_owned(),
            content: "hi".to_owned(),
            created_at: 1,
            parent_message_id: None,
            version_root: false,
        }],
    }
}
