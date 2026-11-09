//! The per-turn device offer and the strict own-chat allowlist (design §0.8).
//!
//! An offer is stamped ONLY by the interactive `POST /api/chat/stream`
//! handler, after the device signature verified and the conversation passed
//! [`is_own_chat`]. Every other ingress (channels, A2A, routines, workflows,
//! teams, subagents, PTC, `ryu_call_tool`, network MCP) never constructs one,
//! and the cloud-task and public/read-only/untrusted gates clear it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use crate::approvals::policy::ApprovalMode;
use crate::identity_verify::ResourceTenancy;

use super::caps::DeviceToolCaps;
use super::catalog::catalog;
use super::declaration::{offerable, ClientDeviceDecl};
use super::gate::AdminCap;
use super::identity::DevicePrincipal;

/// Device calls allowed per turn (design §3.4).
pub(crate) const MAX_CALLS_PER_TURN: u32 = 10;

/// What one turn may do with the origin phone.
#[derive(Debug)]
pub(crate) struct DeviceOffer {
    pub(crate) turn_id: String,
    pub(crate) conversation_id: String,
    pub(crate) principal: DevicePrincipal,
    pub(crate) origin: ClientDeviceDecl,
    /// Canonical ids offered on this turn.
    pub(crate) offerable: Vec<String>,
    pub(crate) approval_mode: ApprovalMode,
    /// The caller's admin caps when the offer was stamped (P5). Dispatch
    /// resolves them again per call; these only shape what is offered.
    pub(crate) caps: DeviceToolCaps,
    /// How long a call waits for a device or the OS prompt before it parks
    /// (design §1.6). Fixed at five minutes outside tests.
    pub(crate) wait_window_ms: i64,
    calls: AtomicU32,
    tainted_input: AtomicBool,
    /// Set by the first successful device read; later egress in this turn is
    /// held for Layer A approval (see `taint`).
    pub(crate) private_read: Arc<crate::tool_exec::RunDataFlow>,
    /// A device read already present in this conversation's stored history.
    /// An ACP agent keeps its own history, so on that plane the raw result is
    /// still in its context and the turn starts private (`turn_context`).
    pub(crate) history_private_read: Option<String>,
    /// The device calls the ACP bridge dispatched on this turn, so the agent's
    /// own echo of them is redacted whatever it titles them (`agent_events`).
    pub(crate) bridge_calls: super::bridge_calls::BridgeCallLedger,
}

impl DeviceOffer {
    pub(crate) fn new(
        conversation_id: String,
        principal: DevicePrincipal,
        origin: ClientDeviceDecl,
        approval_mode: ApprovalMode,
    ) -> Self {
        let offerable = offerable_tools(&origin);
        Self {
            turn_id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            principal,
            origin,
            offerable,
            approval_mode,
            caps: DeviceToolCaps::none(),
            wait_window_ms: super::claims::WAIT_WINDOW_MS,
            calls: AtomicU32::new(0),
            tainted_input: AtomicBool::new(false),
            private_read: Arc::new(crate::tool_exec::RunDataFlow::default()),
            history_private_read: None,
            bridge_calls: super::bridge_calls::BridgeCallLedger::default(),
        }
    }

    /// Apply what the conversation's history already holds: untrusted
    /// external content makes every device call in this turn ask, and an
    /// earlier device read is recorded for the ACP plane (see
    /// [`DeviceOffer::history_private_read`]).
    pub(crate) fn with_history(self, untrusted: bool, private_read: Option<String>) -> Self {
        if untrusted {
            self.mark_tainted_input();
        }
        Self {
            history_private_read: private_read,
            ..self
        }
    }

    /// Apply the caller's caps and add the apps other paired phones declared
    /// (cross-device routing, P3). An app capped `never` is never offered.
    pub(crate) fn with_caps_and_peers(
        mut self,
        caps: DeviceToolCaps,
        peer_apps: &[String],
    ) -> Self {
        let origin = offerable_tools(&self.origin);
        let offerable = catalog()
            .available_tools()
            .filter(|tool| origin.contains(&tool.id) || peer_apps.contains(&tool.app))
            .filter(|tool| caps.cap_for(&tool.app) != AdminCap::Never)
            .map(|tool| tool.id.clone())
            .collect();
        self.offerable = offerable;
        self.caps = caps;
        self
    }

    pub(crate) fn offers(&self, canonical_id: &str) -> bool {
        self.offerable.iter().any(|id| id == canonical_id)
    }

    /// Count one call; `false` once the per-turn cap is reached.
    pub(crate) fn take_call_slot(&self) -> bool {
        self.calls
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                (used < MAX_CALLS_PER_TURN).then_some(used + 1)
            })
            .is_ok()
    }

    /// The turn now holds untrusted external content (a web page, a browser
    /// result, an email, a connector read): every later device call asks.
    pub(crate) fn mark_tainted_input(&self) {
        self.tainted_input.store(true, Ordering::SeqCst);
    }

    pub(crate) fn tainted_input(&self) -> bool {
        self.tainted_input.load(Ordering::SeqCst)
    }

    /// The model-facing tool schemas for this turn.
    pub(crate) fn openai_tool_schemas(&self) -> Vec<serde_json::Value> {
        self.offerable
            .iter()
            .filter_map(|id| catalog().tool(id))
            .map(super::catalog::openai_tool_schema)
            .collect()
    }
}

/// Available catalog tools whose app the phone declared as offerable and whose
/// platform supports it.
pub(crate) fn offerable_tools(origin: &ClientDeviceDecl) -> Vec<String> {
    catalog()
        .available_tools()
        .filter(|tool| {
            let platform_ok = catalog()
                .app(&tool.app)
                .is_some_and(|app| app.platforms.iter().any(|p| *p == origin.platform));
            platform_ok && origin.app(&tool.app).is_some_and(offerable)
        })
        .map(|tool| tool.id.clone())
        .collect()
}

/// The strict own-chat check: the conversation is KNOWN, its stored owner is
/// this principal (never `None == None` for a user), and it is private, not a
/// team, shared or collaborator conversation. Channel-created conversations
/// are refused by the caller before this runs.
pub(crate) fn is_own_chat(
    meta: Option<&ResourceTenancy>,
    principal: &DevicePrincipal,
    node_bound: bool,
) -> bool {
    let Some(meta) = meta else {
        return false;
    };
    meta.visibility == "private"
        && meta.team_id.is_none()
        && meta.collaborators.is_empty()
        && principal.owns_conversation(meta.owner_user_id.as_deref(), node_bound)
}

// The ACP turn context (which live ACP turn may serve this offer) lives in
// `turn_context`; re-exported here so existing paths keep working.
pub(crate) use super::turn_context::register_turn_context;

/// The device-tool fields of a chat request (flattened into
/// `ChatStreamRequest`).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct DeviceTurnFields {
    /// A paired phone's declaration of the app groups it can run (design
    /// §1.2). A routing hint only: Core verifies the device signature, caps
    /// every field and decides what to offer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_device: Option<ClientDeviceDecl>,
    /// Per-turn consent to let Ryu use the declared phone apps.
    #[serde(default)]
    pub(crate) device_tools_consent: bool,
    /// Server-stamped device offer for this turn. Never deserialized; set only
    /// by the interactive chat-stream handler after the own-chat check.
    #[serde(skip)]
    pub(crate) device_tools_offer: Option<Arc<DeviceOffer>>,
}
