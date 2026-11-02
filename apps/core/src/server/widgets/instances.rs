//! The per-render widget instance store and single-use follow-up tickets.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How long a minted widget instance stays valid.
const WIDGET_TTL: Duration = Duration::from_secs(60 * 60 * 6);

/// Default per-session concurrency cap (mirrors the Gateway `[widget]`
/// `max_concurrent_instances_per_session`, enforced here at mint time — D4).
const DEFAULT_MAX_CONCURRENT: usize = 8;

/// One minted widget instance: the round-trip identity a widget echoes on every
/// RPC. `agent_id` / `origin_server` are server-resolved and never client-supplied.
#[derive(Debug, Clone)]
pub struct WidgetInstance {
    pub instance_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub origin_server: String,
    /// Tools on `origin_server` a mounted widget may `callTool` (widgetAccessible).
    pub widget_accessible_tool_ids: Vec<String>,
    pub created_at: Instant,
    /// Server-side authoritative `widgetState` snapshot (D4).
    pub widget_state: Option<Value>,
    /// Whether this widget may inject a follow-up turn into the conversation.
    ///
    /// Mirrors the condition that mints the frame's `ui:send_message` grant at
    /// emit time, recorded here so the SERVER can re-decide it. The desktop host
    /// already refuses `ui.sendMessage` for a frame without the capability, but
    /// that is a client-side check on a route that is reachable directly — and
    /// injecting text into the user's conversation is the one widget power that
    /// reaches the model, so it must not rest on the caller being well-behaved.
    pub may_send_follow_up: bool,
}

/// Server-only provenance recovered from a single-use follow-up ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWidgetProvenance {
    pub source: &'static str,
    pub widget_instance_id: String,
    pub origin_server: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone)]
struct WidgetFollowUpTicket {
    token: String,
    prompt: String,
    provenance: VerifiedWidgetProvenance,
    created_at: Instant,
}

impl WidgetInstance {
    fn is_live(&self) -> bool {
        self.created_at.elapsed() < WIDGET_TTL
    }
}

/// Process-global widget instance store. Minted by the bridge at emit time,
/// resolved by the governed routes.
pub struct WidgetInstanceStore {
    inner: Mutex<HashMap<String, WidgetInstance>>,
    follow_up_tickets: Mutex<HashMap<String, WidgetFollowUpTicket>>,
    max_concurrent: usize,
}

impl WidgetInstanceStore {
    pub(super) fn new(max_concurrent: usize) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            follow_up_tickets: Mutex::new(HashMap::new()),
            max_concurrent,
        }
    }

    /// Mint a new instance, enforcing the per-session concurrency cap (D4). Over
    /// cap → `None` (no widget part is emitted; the tool still returns text).
    pub fn mint(
        &self,
        conversation_id: String,
        agent_id: String,
        origin_server: String,
        widget_accessible_tool_ids: Vec<String>,
        may_send_follow_up: bool,
    ) -> Option<WidgetInstance> {
        let mut map = self.inner.lock().ok()?;
        // Evict expired instances opportunistically.
        map.retain(|_, v| v.is_live());
        let live_for_session = map
            .values()
            .filter(|v| v.conversation_id == conversation_id)
            .count();
        if live_for_session >= self.max_concurrent {
            tracing::warn!(
                "widget instance cap reached for session '{conversation_id}' ({}); no widget emitted",
                self.max_concurrent
            );
            return None;
        }
        let instance_id = gen_instance_id();
        let instance = WidgetInstance {
            instance_id: instance_id.clone(),
            conversation_id,
            agent_id,
            origin_server,
            widget_accessible_tool_ids,
            created_at: Instant::now(),
            widget_state: None,
            may_send_follow_up,
        };
        map.insert(instance_id, instance.clone());
        Some(instance)
    }

    /// Resolve a live instance by id.
    pub fn get(&self, instance_id: &str) -> Option<WidgetInstance> {
        let map = self.inner.lock().ok()?;
        map.get(instance_id).filter(|v| v.is_live()).cloned()
    }

    /// Persist a `widgetState` snapshot for an instance (D4). No-op for an
    /// unknown/expired instance.
    pub fn set_state(&self, instance_id: &str, state: Value) {
        if let Ok(mut map) = self.inner.lock() {
            if let Some(inst) = map.get_mut(instance_id) {
                inst.widget_state = Some(state);
            }
        }
    }

    pub(super) fn issue_follow_up_ticket(
        &self,
        record: &WidgetInstance,
        prompt: &str,
    ) -> Option<String> {
        let token = format!("wft_{}", uuid::Uuid::new_v4().simple());
        let ticket = WidgetFollowUpTicket {
            token: token.clone(),
            prompt: prompt.to_owned(),
            provenance: VerifiedWidgetProvenance {
                source: "widget",
                widget_instance_id: record.instance_id.clone(),
                origin_server: record.origin_server.clone(),
                conversation_id: record.conversation_id.clone(),
            },
            created_at: Instant::now(),
        };
        let mut tickets = self.follow_up_tickets.lock().ok()?;
        tickets.retain(|_, ticket| ticket.created_at.elapsed() < WIDGET_TTL);
        tickets.insert(token.clone(), ticket);
        Some(token)
    }

    /// Consume a ticket only after every binding check matches. A mismatch does
    /// not burn the ticket, so a delayed desktop request can still be retried on
    /// the original conversation; a successful use is strictly one-shot.
    pub fn validate_follow_up_ticket(
        &self,
        token: &str,
        conversation_id: &str,
        prompt: &str,
    ) -> Result<VerifiedWidgetProvenance, &'static str> {
        let tickets = self
            .follow_up_tickets
            .lock()
            .map_err(|_| "widget follow-up ticket store unavailable")?;
        let Some(ticket) = tickets.get(token) else {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        };
        if ticket.created_at.elapsed() >= WIDGET_TTL {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        }
        if ticket.token != token
            || ticket.provenance.conversation_id != conversation_id
            || ticket.prompt != prompt
        {
            return Err("widget follow-up ticket does not match this chat turn");
        }
        Ok(ticket.provenance.clone())
    }

    pub fn consume_follow_up_ticket(
        &self,
        token: &str,
        conversation_id: &str,
        prompt: &str,
    ) -> Result<VerifiedWidgetProvenance, &'static str> {
        let mut tickets = self
            .follow_up_tickets
            .lock()
            .map_err(|_| "widget follow-up ticket store unavailable")?;
        let Some(ticket) = tickets.get(token) else {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        };
        if ticket.created_at.elapsed() >= WIDGET_TTL {
            tickets.remove(token);
            return Err("unknown, expired, or already-used widget follow-up ticket");
        }
        if ticket.token != token
            || ticket.provenance.conversation_id != conversation_id
            || ticket.prompt != prompt
        {
            return Err("widget follow-up ticket does not match this chat turn");
        }
        let ticket = tickets
            .remove(token)
            .expect("ticket remains present while the store lock is held");
        Ok(ticket.provenance)
    }
}

fn gen_instance_id() -> String {
    // Crypto-random (v4). The instance id is now also the capability the public
    // asset proxy authenticates against (`GET /api/widgets/asset`), so it must be
    // unguessable — a time+counter id was enumerable.
    format!("wgt_{}", uuid::Uuid::new_v4().simple())
}

static STORE: OnceLock<WidgetInstanceStore> = OnceLock::new();

/// The process-global widget instance store.
pub fn store() -> &'static WidgetInstanceStore {
    STORE.get_or_init(|| WidgetInstanceStore::new(DEFAULT_MAX_CONCURRENT))
}

pub fn consume_follow_up_ticket(
    token: &str,
    conversation_id: &str,
    prompt: &str,
) -> Result<VerifiedWidgetProvenance, &'static str> {
    store().consume_follow_up_ticket(token, conversation_id, prompt)
}

pub fn validate_follow_up_ticket(
    token: &str,
    conversation_id: &str,
    prompt: &str,
) -> Result<VerifiedWidgetProvenance, &'static str> {
    store().validate_follow_up_ticket(token, conversation_id, prompt)
}

/// Mint a widget instance from the emit path (the MCP bridge). Returns the
/// minted record, or `None` when the per-session cap is hit.
pub fn mint_widget_instance(
    conversation_id: String,
    agent_id: String,
    origin_server: String,
    widget_accessible_tool_ids: Vec<String>,
    may_send_follow_up: bool,
) -> Option<WidgetInstance> {
    store().mint(
        conversation_id,
        agent_id,
        origin_server,
        widget_accessible_tool_ids,
        may_send_follow_up,
    )
}
