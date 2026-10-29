//! Short-lived, session-bound authority for the managed Pi HTTP tool callback.
//!
//! The capability is intentionally accepted only by the dedicated ACP callbacks:
//! `/api/acp/tools` (the `ryu_call_tool` proxy) and `/api/acp/mcp` (the same
//! governed MCP bridge other ACP agents receive, served to Pi's native MCP
//! client). It never authorizes a general Core request and the record stores the caller,
//! conversation, agent, and profile ceilings that Core resolved before spawn.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::Engine as _;
use rand::RngCore as _;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    identity_verify::VerifiedCaller,
    server::conversations::ConversationStore,
    sidecar::adapters::{acp::AcpEvent, ComposioConnectionBinding},
};

/// The live ACP instance's event channel. Core's MCP bridge emits widget events
/// and interactive permission prompts on it; the instance relays each event to
/// whichever turn is currently streaming.
pub(crate) type AcpInstanceEvents = tokio::sync::mpsc::UnboundedSender<AcpEvent>;

const CAPABILITY_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_SCOPE_IDS: usize = 128;
const MAX_SCOPE_VALUE_BYTES: usize = 256;

#[derive(Clone)]
pub(crate) struct AcpToolSessionAuthority {
    conversation_id: String,
    agent_id: String,
    caller: Option<VerifiedCaller>,
    mcp_allowlist: Option<Vec<String>>,
    composio_actions: Vec<String>,
    identity_profile_ids: Vec<String>,
    profile_composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    profile_conversation_scope: Option<Vec<String>>,
    node_generation: u64,
    binding_fingerprint: [u8; 32],
}

impl AcpToolSessionAuthority {
    /// Build authority only from server-owned chat context and a conversation
    /// that this verified caller owns. An anonymous caller is accepted only on
    /// an unbound personal node and only for an unowned personal conversation.
    pub(crate) async fn authorize_managed_pi_session(
        conversations: &ConversationStore,
        spawn_cmd: &str,
        agent_id: &str,
        conversation_id: Option<&str>,
        caller: Option<VerifiedCaller>,
        mcp_allowlist: Option<Vec<String>>,
        composio_actions: Vec<String>,
        identity_profile_ids: Vec<String>,
        profile_composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
        profile_conversation_scope: Option<Vec<String>>,
    ) -> Option<Self> {
        // The managed Pi runs as Ryu, as a built-in that borrows its engine
        // (Jay Jr., Patrol), or as a limited custom agent on the credential-free
        // limited config; the grant carries that agent's own allowlist either way.
        if !crate::sidecar::adapters::acp::is_managed_pi_extension(spawn_cmd, agent_id) {
            return None;
        }
        let conversation_id = conversation_id?.to_owned();
        if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(&conversation_id)
            || !valid_scopes(
                profile_composio_connection_scope.as_deref(),
                profile_conversation_scope.as_deref(),
            )
        {
            return None;
        }

        let meta = conversations
            .get_access_meta(&conversation_id)
            .await
            .ok()??;
        let node_org = crate::sidecar::control_plane::registered_org().map(|org| org.id);
        let node_bound = node_org.is_some() || crate::sidecar::control_plane::is_managed_node();

        match caller.as_ref() {
            Some(caller) => {
                if node_org
                    .as_deref()
                    .is_some_and(|org_id| caller.org_id.as_deref() != Some(org_id))
                    || meta.owner_user_id.as_deref() != Some(caller.user_id.as_str())
                    || meta.org_id.as_deref() != caller.org_id.as_deref()
                {
                    return None;
                }
            }
            None => {
                if node_bound || meta.owner_user_id.is_some() || meta.org_id.is_some() {
                    return None;
                }
            }
        }

        let node_generation = crate::node_token::active_generation();
        let binding_fingerprint = fingerprint(
            &conversation_id,
            agent_id,
            caller.as_ref(),
            &mcp_allowlist,
            &composio_actions,
            &identity_profile_ids,
            profile_composio_connection_scope.as_deref(),
            profile_conversation_scope.as_deref(),
            node_generation,
        );

        Some(Self {
            conversation_id,
            agent_id: agent_id.to_owned(),
            caller,
            mcp_allowlist,
            composio_actions,
            identity_profile_ids,
            profile_composio_connection_scope,
            profile_conversation_scope,
            node_generation,
            binding_fingerprint,
        })
    }

    pub(crate) fn binding_fingerprint(&self) -> [u8; 32] {
        self.binding_fingerprint
    }
}

pub(crate) struct AcpToolCallAuthorization {
    pub(crate) session_id: Uuid,
    pub(crate) native_session_id: Option<String>,
    pub(crate) conversation_id: String,
    pub(crate) agent_id: String,
    pub(crate) caller: Option<VerifiedCaller>,
    pub(crate) mcp_allowlist: Option<Vec<String>>,
    /// Bare Composio action slugs selected for this agent. Their canonical ids
    /// are already merged into `mcp_allowlist`; the MCP bridge also offers them
    /// as shallow tool definitions.
    pub(crate) composio_actions: Vec<String>,
    pub(crate) identity_profile_ids: Vec<String>,
    pub(crate) profile_composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    pub(crate) profile_conversation_scope: Option<Vec<String>>,
    /// The ACP instance's event channel, once the instance attached it.
    pub(crate) events: Option<AcpInstanceEvents>,
}

#[derive(Clone, Default)]
pub(crate) struct AcpToolBroker {
    state: Arc<Mutex<BrokerState>>,
}

#[derive(Default)]
struct BrokerState {
    records: HashMap<[u8; 32], CapabilityRecord>,
    sessions: HashMap<Uuid, [u8; 32]>,
}

#[derive(Clone)]
struct CapabilityRecord {
    session_id: Uuid,
    native_session_id: Option<String>,
    conversation_id: String,
    agent_id: String,
    caller: Option<VerifiedCaller>,
    mcp_allowlist: Option<Vec<String>>,
    composio_actions: Vec<String>,
    identity_profile_ids: Vec<String>,
    profile_composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    profile_conversation_scope: Option<Vec<String>>,
    node_generation: u64,
    binding_fingerprint: [u8; 32],
    expires_at: Instant,
    events: Option<AcpInstanceEvents>,
}

/// The token is deliberately absent from Debug/Serialize and is never logged or
/// returned to a caller. Its Drop revokes the server-side record, including if
/// ACP startup is canceled before a session is established.
pub(crate) struct AcpToolSessionGrant {
    session_id: Uuid,
    token: String,
    broker: AcpToolBroker,
}

impl AcpToolSessionGrant {
    pub(crate) fn session_id(&self) -> Uuid {
        self.session_id
    }

    pub(crate) fn capability(&self) -> &str {
        &self.token
    }

    pub(crate) fn bind_native_session(&self, native_session_id: &str) -> bool {
        self.broker
            .bind_native_session(self.session_id, native_session_id)
    }

    /// Attach the ACP instance's event channel, so MCP calls made through this
    /// capability can render widgets and raise permission prompts in the live
    /// turn. Returns false once the record was revoked or expired.
    pub(crate) fn attach_events(&self, events: AcpInstanceEvents) -> bool {
        self.broker.attach_events(self.session_id, events)
    }
}

impl Drop for AcpToolSessionGrant {
    fn drop(&mut self) {
        self.broker.revoke_session(self.session_id);
    }
}

fn global_broker() -> &'static AcpToolBroker {
    static BROKER: OnceLock<AcpToolBroker> = OnceLock::new();
    BROKER.get_or_init(AcpToolBroker::default)
}

pub(crate) fn revoke_session(session_id: Uuid) {
    global_broker().revoke_session(session_id);
}

pub(crate) fn renew_session(session_id: Uuid, authority: &AcpToolSessionAuthority) -> bool {
    global_broker().renew_session(session_id, authority, Instant::now())
}

pub(crate) fn issue_session(authority: &AcpToolSessionAuthority) -> Option<AcpToolSessionGrant> {
    global_broker().issue_session(authority, Instant::now())
}

/// Resolve a bearer only on the dedicated ACP callback. The supplied session id
/// is a server-minted consistency check, never an authority source.
pub(crate) fn authorize_call(
    token: &str,
    supplied_session_id: Option<&str>,
    supplied_native_session_id: Option<&str>,
    require_native_session: bool,
) -> Option<AcpToolCallAuthorization> {
    global_broker().authorize_call(
        token,
        supplied_session_id,
        supplied_native_session_id,
        require_native_session,
        crate::node_token::active_generation(),
        Instant::now(),
    )
}

impl AcpToolBroker {
    fn issue_session(
        &self,
        authority: &AcpToolSessionAuthority,
        now: Instant,
    ) -> Option<AcpToolSessionGrant> {
        if authority.node_generation != crate::node_token::active_generation() {
            return None;
        }

        let mut state = self.state.lock().ok()?;
        state.remove_expired(now);
        state.revoke_conflicting_authority(authority);

        let mut random = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut random);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        random.fill(0);
        let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let session_id = Uuid::new_v4();
        state.sessions.insert(session_id, token_hash);
        state.records.insert(
            token_hash,
            CapabilityRecord {
                session_id,
                native_session_id: None,
                conversation_id: authority.conversation_id.clone(),
                agent_id: authority.agent_id.clone(),
                caller: authority.caller.clone(),
                mcp_allowlist: authority.mcp_allowlist.clone(),
                composio_actions: authority.composio_actions.clone(),
                identity_profile_ids: authority.identity_profile_ids.clone(),
                profile_composio_connection_scope: authority
                    .profile_composio_connection_scope
                    .clone(),
                profile_conversation_scope: authority.profile_conversation_scope.clone(),
                node_generation: authority.node_generation,
                binding_fingerprint: authority.binding_fingerprint,
                expires_at: now + CAPABILITY_TTL,
                events: None,
            },
        );
        Some(AcpToolSessionGrant {
            session_id,
            token,
            broker: self.clone(),
        })
    }

    fn bind_native_session(&self, session_id: Uuid, native_session_id: &str) -> bool {
        if native_session_id.is_empty() || native_session_id.len() > 512 {
            return false;
        }
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(token_hash) = state.sessions.get(&session_id).copied() else {
            return false;
        };
        let Some(record) = state.records.get_mut(&token_hash) else {
            return false;
        };
        if record.expires_at <= Instant::now()
            || record.node_generation != crate::node_token::active_generation()
        {
            state.remove_session(session_id);
            return false;
        }
        match record.native_session_id.as_deref() {
            None => {
                record.native_session_id = Some(native_session_id.to_owned());
                true
            }
            Some(existing) => existing == native_session_id,
        }
    }

    fn attach_events(&self, session_id: Uuid, events: AcpInstanceEvents) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(token_hash) = state.sessions.get(&session_id).copied() else {
            return false;
        };
        let Some(record) = state.records.get_mut(&token_hash) else {
            return false;
        };
        record.events = Some(events);
        true
    }

    fn renew_session(
        &self,
        session_id: Uuid,
        authority: &AcpToolSessionAuthority,
        now: Instant,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(token_hash) = state.sessions.get(&session_id).copied() else {
            return false;
        };
        let Some(record) = state.records.get_mut(&token_hash) else {
            state.sessions.remove(&session_id);
            return false;
        };
        if record.expires_at <= now
            || record.node_generation != crate::node_token::active_generation()
            || record.binding_fingerprint != authority.binding_fingerprint
            || authority.node_generation != record.node_generation
        {
            state.remove_session(session_id);
            return false;
        }
        record.expires_at = now + CAPABILITY_TTL;
        true
    }

    fn authorize_call(
        &self,
        token: &str,
        supplied_session_id: Option<&str>,
        supplied_native_session_id: Option<&str>,
        require_native_session: bool,
        current_generation: u64,
        now: Instant,
    ) -> Option<AcpToolCallAuthorization> {
        let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let mut state = self.state.lock().ok()?;
        let record = state.records.get(&token_hash)?.clone();
        let supplied_session_id = Uuid::parse_str(supplied_session_id?).ok()?;
        let native_session_matches = !require_native_session
            || supplied_native_session_id.is_some_and(|native_session_id| {
                record.native_session_id.as_deref() == Some(native_session_id)
            });
        if supplied_session_id != record.session_id
            || !native_session_matches
            || record.expires_at <= now
            || record.node_generation != current_generation
        {
            if record.expires_at <= now || record.node_generation != current_generation {
                state.remove_session(record.session_id);
            }
            return None;
        }
        Some(AcpToolCallAuthorization {
            session_id: record.session_id,
            native_session_id: record.native_session_id,
            conversation_id: record.conversation_id,
            agent_id: record.agent_id,
            caller: record.caller,
            mcp_allowlist: effective_allowlist(record.mcp_allowlist, &record.composio_actions),
            composio_actions: record.composio_actions,
            identity_profile_ids: record.identity_profile_ids,
            profile_composio_connection_scope: record.profile_composio_connection_scope,
            profile_conversation_scope: record.profile_conversation_scope,
            events: record.events,
        })
    }

    fn revoke_session(&self, session_id: Uuid) {
        if let Ok(mut state) = self.state.lock() {
            state.remove_session(session_id);
        }
    }
}

impl BrokerState {
    fn remove_session(&mut self, session_id: Uuid) {
        if let Some(token_hash) = self.sessions.remove(&session_id) {
            self.records.remove(&token_hash);
        }
    }

    fn remove_expired(&mut self, now: Instant) {
        let expired = self
            .records
            .values()
            .filter(|record| record.expires_at <= now)
            .map(|record| record.session_id)
            .collect::<Vec<_>>();
        for session_id in expired {
            self.remove_session(session_id);
        }
    }

    fn revoke_conflicting_authority(&mut self, authority: &AcpToolSessionAuthority) {
        let conflicting = self
            .records
            .values()
            .filter(|record| {
                record.conversation_id == authority.conversation_id
                    && record.agent_id == authority.agent_id
                    && record.binding_fingerprint != authority.binding_fingerprint
            })
            .map(|record| record.session_id)
            .collect::<Vec<_>>();
        for session_id in conflicting {
            self.remove_session(session_id);
        }
    }
}

fn valid_scopes(
    composio_scope: Option<&[ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
) -> bool {
    let within_limit = |count: usize| count <= MAX_SCOPE_IDS;
    composio_scope.is_none_or(|scope| {
        within_limit(scope.len())
            && scope.iter().all(|binding| {
                !binding.id.is_empty()
                    && binding.id.len() <= MAX_SCOPE_VALUE_BYTES
                    && !binding.toolkit.is_empty()
                    && binding.toolkit.len() <= MAX_SCOPE_VALUE_BYTES
            })
    }) && conversation_scope.is_none_or(|scope| {
        within_limit(scope.len())
            && scope.iter().all(|id| {
                !id.is_empty()
                    && id.len() <= MAX_SCOPE_VALUE_BYTES
                    && crate::sidecar::adapters::acp::is_safe_host_conversation_id(id)
            })
    })
}

fn fingerprint(
    conversation_id: &str,
    agent_id: &str,
    caller: Option<&VerifiedCaller>,
    mcp_allowlist: &Option<Vec<String>>,
    composio_actions: &[String],
    identity_profile_ids: &[String],
    composio_scope: Option<&[ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    node_generation: u64,
) -> [u8; 32] {
    let mut composio = composio_scope.map(<[ComposioConnectionBinding]>::to_vec);
    if let Some(scope) = &mut composio {
        scope.sort_by(|left, right| {
            left.toolkit
                .cmp(&right.toolkit)
                .then(left.id.cmp(&right.id))
        });
    }
    let mut conversations = conversation_scope.map(<[String]>::to_vec);
    if let Some(scope) = &mut conversations {
        scope.sort();
    }
    let user_id = caller.map(|caller| caller.user_id.as_str());
    let org_id = caller.and_then(|caller| caller.org_id.as_deref());
    let role_rank = caller.map(|caller| caller.role.rank());
    let teams = caller.map(|caller| format!("{:?}", caller.teams));
    let mut allowlist = mcp_allowlist.clone();
    if let Some(values) = &mut allowlist {
        values.sort();
    }
    let mut composio_actions = composio_actions.to_vec();
    composio_actions.sort();
    let mut identity_profile_ids = identity_profile_ids.to_vec();
    identity_profile_ids.sort();
    let value = serde_json::json!({
        "conversation": conversation_id,
        "agent": agent_id,
        "user": user_id,
        "org": org_id,
        "role": role_rank,
        "teams": teams,
        "mcpAllowlist": allowlist,
        "composioActions": composio_actions,
        "identityProfileIds": identity_profile_ids,
        "composioScope": composio,
        "conversationScope": conversations,
        "nodeGeneration": node_generation,
    });
    Sha256::digest(value.to_string().as_bytes()).into()
}

fn effective_allowlist(
    allowlist: Option<Vec<String>>,
    composio_actions: &[String],
) -> Option<Vec<String>> {
    let Some(mut allowlist) = allowlist else {
        return None;
    };
    for action in composio_actions {
        let id = format!("composio.{action}");
        if !allowlist.contains(&id) {
            allowlist.push(id);
        }
    }
    Some(allowlist)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::OrgRole;

    fn caller(user_id: &str, org_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org_id.to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn authority(user_id: &str, org_id: &str) -> AcpToolSessionAuthority {
        let caller = caller(user_id, org_id);
        let conversation_id = "conversation-1".to_owned();
        let agent_id = "ryu".to_owned();
        let profile_composio_connection_scope = Some(vec![ComposioConnectionBinding {
            id: "connection-1".to_owned(),
            toolkit: "mail".to_owned(),
        }]);
        let profile_conversation_scope = Some(vec!["source-1".to_owned()]);
        let mcp_allowlist = Some(vec!["core.echo".to_owned()]);
        let composio_actions = vec!["GITHUB_CREATE_ISSUE".to_owned()];
        let identity_profile_ids = vec!["profile-1".to_owned()];
        let node_generation = crate::node_token::active_generation();
        let binding_fingerprint = fingerprint(
            &conversation_id,
            &agent_id,
            Some(&caller),
            &mcp_allowlist,
            &composio_actions,
            &identity_profile_ids,
            profile_composio_connection_scope.as_deref(),
            profile_conversation_scope.as_deref(),
            node_generation,
        );
        AcpToolSessionAuthority {
            conversation_id,
            agent_id,
            caller: Some(caller),
            mcp_allowlist,
            composio_actions,
            identity_profile_ids,
            profile_composio_connection_scope,
            profile_conversation_scope,
            node_generation,
            binding_fingerprint,
        }
    }

    fn grant(broker: &AcpToolBroker) -> (AcpToolSessionGrant, Instant) {
        let authority = authority("alice", "org-1");
        let grant = broker
            .issue_session(&authority, Instant::now())
            .expect("broker grant issues at the active node generation");
        assert!(grant.bind_native_session("pi-session-1"));
        (grant, Instant::now())
    }

    #[test]
    fn legitimate_pi_capability_resolves_only_its_server_bound_context() {
        let broker = AcpToolBroker::default();
        let (grant, now) = grant(&broker);
        let authorization = broker
            .authorize_call(
                grant.capability(),
                Some(&grant.session_id().to_string()),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .expect("managed Pi callback is authorized after session binding");

        assert_eq!(authorization.session_id, grant.session_id());
        assert_eq!(
            authorization.native_session_id.as_deref(),
            Some("pi-session-1")
        );
        assert_eq!(authorization.conversation_id, "conversation-1");
        assert_eq!(authorization.agent_id, "ryu");
        assert_eq!(
            authorization.mcp_allowlist.as_deref(),
            Some(
                [
                    "core.echo".to_owned(),
                    "composio.GITHUB_CREATE_ISSUE".to_owned()
                ]
                .as_slice()
            )
        );
        assert_eq!(authorization.identity_profile_ids, vec!["profile-1"]);
        assert_eq!(
            authorization
                .caller
                .as_ref()
                .map(|value| value.user_id.as_str()),
            Some("alice")
        );
        assert_eq!(
            authorization
                .caller
                .as_ref()
                .and_then(|value| value.org_id.as_deref()),
            Some("org-1")
        );
        assert_eq!(
            authorization.profile_conversation_scope.as_deref(),
            Some(["source-1".to_owned()].as_slice())
        );
        assert_eq!(
            authorization
                .profile_composio_connection_scope
                .as_ref()
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn attached_instance_events_reach_authorized_calls_until_revoked() {
        let broker = AcpToolBroker::default();
        let (grant, now) = grant(&broker);
        let authorize = || {
            broker.authorize_call(
                grant.capability(),
                Some(&grant.session_id().to_string()),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
        };
        let before = authorize().expect("bound capability authorizes");
        assert!(before.events.is_none());
        assert_eq!(before.composio_actions, vec!["GITHUB_CREATE_ISSUE"]);

        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        assert!(grant.attach_events(events));
        let attached = authorize()
            .and_then(|authorization| authorization.events)
            .expect("authorized call carries the instance channel");
        attached
            .send(AcpEvent::Text("widget".to_owned()))
            .expect("instance channel is open");
        assert!(matches!(received.try_recv(), Ok(AcpEvent::Text(text)) if text == "widget"));

        broker.revoke_session(grant.session_id());
        let (late, _late_rx) = tokio::sync::mpsc::unbounded_channel();
        assert!(!grant.attach_events(late));
        assert!(authorize().is_none());
    }

    #[test]
    fn forged_missing_or_wrong_session_capabilities_fail_closed() {
        let broker = AcpToolBroker::default();
        let (grant, now) = grant(&broker);
        let wrong_session = Uuid::new_v4().to_string();
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&wrong_session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .is_none());
        assert!(broker
            .authorize_call(
                grant.capability(),
                None,
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .is_none());
        assert!(broker
            .authorize_call(
                "forged-capability",
                Some(&grant.session_id().to_string()),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .is_none());
    }

    #[test]
    fn unbound_or_expired_capabilities_are_never_accepted() {
        let broker = AcpToolBroker::default();
        let authority = authority("alice", "org-1");
        let grant = broker
            .issue_session(&authority, Instant::now())
            .expect("grant issues");
        let session = grant.session_id().to_string();
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_none());
        assert!(grant.bind_native_session("pi-session-1"));
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                Instant::now() + CAPABILITY_TTL,
            )
            .is_none());
    }

    #[test]
    fn revocation_and_node_token_generation_change_invalidate_a_live_claim() {
        let broker = AcpToolBroker::default();
        let (first_grant, now) = grant(&broker);
        let session = first_grant.session_id().to_string();
        assert!(broker
            .authorize_call(
                first_grant.capability(),
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation().wrapping_add(1),
                now,
            )
            .is_none());

        let (second, now) = grant(&broker);
        let second_session = second.session_id().to_string();
        broker.revoke_session(second.session_id());
        assert!(broker
            .authorize_call(
                second.capability(),
                Some(&second_session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .is_none());
    }

    #[test]
    fn caller_org_agent_conversation_and_narrowing_scopes_are_part_of_the_binding() {
        let original = authority("alice", "org-1");
        let other_user = authority("bob", "org-1");
        let other_org = authority("alice", "org-2");
        assert_ne!(
            original.binding_fingerprint(),
            other_user.binding_fingerprint()
        );
        assert_ne!(
            original.binding_fingerprint(),
            other_org.binding_fingerprint()
        );

        let mut other_scope = original.clone();
        other_scope.profile_conversation_scope = Some(vec!["source-2".to_owned()]);
        other_scope.binding_fingerprint = fingerprint(
            &other_scope.conversation_id,
            &other_scope.agent_id,
            other_scope.caller.as_ref(),
            &other_scope.mcp_allowlist,
            &other_scope.composio_actions,
            &other_scope.identity_profile_ids,
            other_scope.profile_composio_connection_scope.as_deref(),
            other_scope.profile_conversation_scope.as_deref(),
            other_scope.node_generation,
        );
        assert_ne!(
            original.binding_fingerprint(),
            other_scope.binding_fingerprint()
        );

        let broker = AcpToolBroker::default();
        let grant = broker
            .issue_session(&original, Instant::now())
            .expect("grant issues");
        let mut other_agent = AcpToolSessionAuthority {
            agent_id: "different-agent".to_owned(),
            ..original.clone()
        };
        other_agent.binding_fingerprint = fingerprint(
            &other_agent.conversation_id,
            &other_agent.agent_id,
            other_agent.caller.as_ref(),
            &other_agent.mcp_allowlist,
            &other_agent.composio_actions,
            &other_agent.identity_profile_ids,
            other_agent.profile_composio_connection_scope.as_deref(),
            other_agent.profile_conversation_scope.as_deref(),
            other_agent.node_generation,
        );
        assert!(!broker.renew_session(grant.session_id(), &other_agent, Instant::now()));
    }

    #[test]
    fn native_session_binding_is_immutable_and_required_for_tool_calls() {
        let broker = AcpToolBroker::default();
        let (grant, now) = grant(&broker);

        assert!(!grant.bind_native_session("pi-session-2"));
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&grant.session_id().to_string()),
                Some("pi-session-2"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .is_none());
        let authorization = broker
            .authorize_call(
                grant.capability(),
                Some(&grant.session_id().to_string()),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .expect("the original native session remains authorized");
        assert_eq!(
            authorization.native_session_id.as_deref(),
            Some("pi-session-1")
        );
    }

    #[test]
    fn discovery_can_precede_native_binding_but_tool_calls_cannot() {
        let broker = AcpToolBroker::default();
        let authority = authority("alice", "org-1");
        let grant = broker
            .issue_session(&authority, Instant::now())
            .expect("grant issues");
        let session = grant.session_id().to_string();

        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                None,
                false,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_some());
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                None,
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_none());
    }

    #[test]
    fn authority_replacement_revokes_conflicting_session_but_not_same_binding() {
        let broker = AcpToolBroker::default();
        let original = authority("alice", "org-1");
        let original_grant = broker
            .issue_session(&original, Instant::now())
            .expect("original grant issues");
        assert!(original_grant.bind_native_session("pi-session-1"));
        let original_session = original_grant.session_id().to_string();

        let mut replacement = original.clone();
        replacement.profile_conversation_scope = Some(vec!["source-2".to_owned()]);
        replacement.binding_fingerprint = fingerprint(
            &replacement.conversation_id,
            &replacement.agent_id,
            replacement.caller.as_ref(),
            &replacement.mcp_allowlist,
            &replacement.composio_actions,
            &replacement.identity_profile_ids,
            replacement.profile_composio_connection_scope.as_deref(),
            replacement.profile_conversation_scope.as_deref(),
            replacement.node_generation,
        );
        let replacement_grant = broker
            .issue_session(&replacement, Instant::now())
            .expect("replacement grant issues");
        assert!(replacement_grant.bind_native_session("pi-session-2"));

        assert!(broker
            .authorize_call(
                original_grant.capability(),
                Some(&original_session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_none());
        assert!(broker
            .authorize_call(
                replacement_grant.capability(),
                Some(&replacement_grant.session_id().to_string()),
                Some("pi-session-2"),
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_some());
    }

    #[test]
    fn dropping_a_session_grant_revokes_its_capability() {
        let broker = AcpToolBroker::default();
        let (token, session) = {
            let authority = authority("alice", "org-1");
            let grant = broker
                .issue_session(&authority, Instant::now())
                .expect("grant issues");
            assert!(grant.bind_native_session("pi-session-1"));
            (
                grant.capability().to_owned(),
                grant.session_id().to_string(),
            )
        };

        assert!(broker
            .authorize_call(
                &token,
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_none());
    }

    #[test]
    fn revocation_blocks_new_callbacks_but_leaves_an_authorized_snapshot_unchanged() {
        let broker = AcpToolBroker::default();
        let (grant, now) = grant(&broker);
        let session = grant.session_id().to_string();
        let authorization = broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                now,
            )
            .expect("callback is admitted before revocation");

        broker.revoke_session(grant.session_id());
        assert!(broker
            .authorize_call(
                grant.capability(),
                Some(&session),
                Some("pi-session-1"),
                true,
                crate::node_token::active_generation(),
                Instant::now(),
            )
            .is_none());
        assert_eq!(
            authorization.native_session_id.as_deref(),
            Some("pi-session-1")
        );
        assert_eq!(authorization.conversation_id, "conversation-1");
    }
}
