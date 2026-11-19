//! One Box per session, each with its own screen (design
//! `docs/box-per-session-desktop.md` §7).
//!
//! The registry is keyed by [`SessionBoxKey`]: `(owner, conversation_id)` for a
//! conversation, or `(owner, "<conversation_id>#sub:<n>")` for a parallel
//! sub-agent child. The child number comes from a Core counter
//! ([`next_child_index`]); a model argument never sets it.
//!
//! Heavy work acquires a Box ([`desktop_target`]): a cloud task already bound
//! to the conversation is attached to (never a second create), and otherwise a
//! session Box is created with its own desktop. The idle sweep, exhaustion
//! (`kill_balance`), the lifetime and an explicit Stop **park** it (state is
//! saved, compute released); the next heavy call resumes it. Deleting the
//! conversation deletes the parent and every child Box.
//!
//! Session Boxes never change `cloud_tasks::has_bound_task`: only a cloud task
//! flips a conversation into "cloud tools only".
//!
//! Every Box call uses the node's Box credential
//! ([`ryu_sandbox::box_credential::current`]); that bearer never leaves Core.
//! A lease file under `state/session-box-leases` is written before every
//! create, so a crash between the lease and the create is still recoverable by
//! the Box's deterministic name.
#[path = "session_box/acquire.rs"]
mod acquire;
#[path = "session_box/api.rs"]
mod api;
#[path = "session_box/broker_relay.rs"]
mod broker_relay;
#[path = "session_box/caps.rs"]
mod caps;
#[path = "session_box/idle.rs"]
mod idle;
#[path = "session_box/inference.rs"]
mod inference;
#[path = "session_box/leases.rs"]
mod leases;
#[path = "session_box/lifecycle.rs"]
mod lifecycle;
#[path = "session_box/metering.rs"]
mod metering;
#[path = "session_box/notice.rs"]
pub(crate) mod notice;
#[path = "session_box/registry.rs"]
mod registry;
#[path = "session_box/relay.rs"]
mod relay;
#[path = "session_box/release.rs"]
mod release;
#[path = "session_box/status.rs"]
mod status;
#[cfg(test)]
#[path = "session_box/tests.rs"]
pub(crate) mod tests;

pub(crate) use acquire::*;
pub(crate) use leases::*;
pub(crate) use lifecycle::*;
pub(crate) use metering::*;
pub(crate) use registry::*;
pub(crate) use release::*;
pub(crate) use status::*;

pub(crate) use caps::BoxCaps;

use super::{cloud_environments as environments, cloud_tasks, ResolvedAuthorization};
use anyhow::{anyhow, ensure, Result};
use axum::{http::StatusCode, Json};
use ryu_sandbox::{
    box_credential::{BillingOwner, BoxCredential},
    box_session::{BoxNetwork, BoxSessionClient, DisposableBoxSpec},
    box_types::{BoxApiError, BoxSize, BoxStatus, BoxView, ParkReason},
    heartbeat::{self, KillAction, KillReason, ParkFn, RunOptions},
    spec::SandboxSpec,
    WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub(crate) type ApiError = (StatusCode, Json<Value>);

/// The Box service's own time to live for a session Box (its maximum,
/// `MAX_BOX_TTL_SECONDS`). A parked Box older than this is reaped by the
/// service; Core forgets its lease then.
const BOX_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
/// How long a session Box may run before it is parked (design §7.3). The UI
/// can extend it.
const RUN_LIFETIME_SECONDS: u64 = 4 * 60 * 60;
/// Longest a single extension may push the run deadline ahead of now.
const MAX_RUN_AHEAD_SECONDS: u64 = 24 * 60 * 60;
/// The per-start credit pre-flight horizon (design §7.3): the five-minute
/// minimum every Box start is billed for (`minimumSecondsPerStart` in the
/// shared fixture `crates/gateway/contracts/fixtures/box-rates.json`, which the
/// Gateway's ticks charge on a run's first tick).
const PREFLIGHT_SECONDS: u64 = 300;
/// Most sub-agent children per conversation.
const MAX_CHILDREN: u32 = 64;
/// How long a fetched Box view is reused for status reads.
const VIEW_CACHE_TTL: Duration = Duration::from_secs(5);
const LEASE_FILE_LIMIT: u64 = 16 * 1024;
const MAX_LEASES: usize = 1000;
const NAME_PREFIX: &str = "ryu-sb-";
/// The owner preference that sends `computer.*` and `browser.*` to the node
/// (`node`) instead of a session Box (`auto`, the default).
pub(crate) const PREF_COMPUTER_TARGET: &str = "session-box-computer-target";

/// Who and what a session Box belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct SessionBoxKey {
    pub owner: String,
    pub conversation_id: String,
    /// `Some(n)` for the `n`th sub-agent child of the conversation.
    pub child: Option<u32>,
}

impl SessionBoxKey {
    pub(crate) fn session(owner: &str, conversation_id: &str) -> Self {
        Self {
            owner: owner.to_owned(),
            conversation_id: conversation_id.to_owned(),
            child: None,
        }
    }

    pub(crate) fn child(owner: &str, conversation_id: &str, index: u32) -> Self {
        Self {
            child: Some(index),
            ..Self::session(owner, conversation_id)
        }
    }

    /// The conversation's own key.
    pub(crate) fn parent(&self) -> Self {
        Self::session(&self.owner, &self.conversation_id)
    }

    /// `conversation_id`, or `conversation_id#sub:n` for a child. Used as the
    /// Box inference session id and in routes.
    pub(crate) fn session_id(&self) -> String {
        match self.child {
            Some(index) => format!("{}#sub:{index}", self.conversation_id),
            None => self.conversation_id.clone(),
        }
    }

    /// Parse a route segment (`conversation_id` or `conversation_id#sub:n`).
    pub(crate) fn parse(owner: &str, segment: &str) -> Option<Self> {
        let (conversation, child) = match segment.split_once("#sub:") {
            Some((conversation, raw)) => {
                let index: u32 = raw.parse().ok()?;
                if index == 0 || index > MAX_CHILDREN || raw != index.to_string() {
                    return None;
                }
                (conversation, Some(index))
            }
            None => (segment, None),
        };
        if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation) {
            return None;
        }
        Some(Self {
            owner: owner.to_owned(),
            conversation_id: conversation.to_owned(),
            child,
        })
    }
}

/// Why a Box is being acquired (design §7.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcquireReason {
    /// The conversation's cloud task: attach to its Box, never create one.
    /// Cloud tasks create their own Box (`cloud_tasks::ensure_task_workspace`),
    /// so this reason only ever attaches.
    #[allow(dead_code)]
    CloudTask,
    /// The first `computer.*` or `browser.*` call in the conversation.
    ComputerUse,
    /// The first heavy call of a `delegate.fanout` or `threads.*` child.
    SubAgent,
}

/// Where a [`BoxTarget`] came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TargetSource {
    CloudTask,
    Session,
    SubAgent,
}

impl TargetSource {
    fn label(self) -> &'static str {
        match self {
            Self::CloudTask => "cloud_task",
            Self::Session => "session",
            Self::SubAgent => "sub_agent",
        }
    }
}

/// The Box a conversation's heavy work runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BoxTarget {
    pub box_id: WorkspaceId,
    pub lease_id: String,
    /// The heartbeat run id of the Box's current run. A session Box gets a
    /// new one for every live phase ([`Entry::run_id`]); a cloud task Box
    /// uses its lease id.
    pub run_id: String,
    pub size: BoxSize,
    pub desktop: bool,
    pub source: TargetSource,
}

// ── Router ───────────────────────────────────────────────────────────────────

/// The node-authenticated routes (`GatewayRoute`).
pub(crate) fn routes() -> axum::Router<super::ServerState> {
    api::routes()
}

/// Routes on the public router: the relay WebSocket (a browser cannot set an
/// authorization header; it presents a one-use Core ticket) and the Box
/// inference relay (authenticated by the Box's `gwb1` key).
pub(crate) fn public_routes() -> axum::Router<super::ServerState> {
    api::public_routes()
}

/// Start the 30 s idle sweep (and the lease recovery on its first tick).
pub(crate) fn start_idle_sweep() {
    idle::start();
}

pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    api::openapi()
}
