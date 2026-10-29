//! Short-lived, one-use tickets for browser WebSocket upgrades.
//!
//! Browsers cannot set an `Authorization` header on a WebSocket constructor, but
//! putting a node bearer or user JWT in the URL makes those credentials visible to
//! URI access logs, browser history, and intermediaries. The HTTP issuer below is
//! authenticated with the normal node bearer (or the local loopback boundary),
//! then stores only an opaque ticket and the already-verified caller context.
//! A managed member's own session credential (a managed user JWT or a
//! control-plane delegation) may also mint a `voice` ticket, admitted exactly as
//! `POST /api/chat/stream` admits it; every other route stays owner-only.
//! Upgrade handlers consume the ticket before accepting the socket.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Json},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::identity_verify::VerifiedCaller;

const TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_TICKETS: usize = 4096;
/// Live member voice tickets, in total and per member. Members share the store
/// with the owner's Desktop, Island and phone-bridge sockets, so they can never
/// fill it: the owner always keeps at least `MAX_TICKETS - MAX_MEMBER_TICKETS`.
const MAX_MEMBER_TICKETS: usize = MAX_TICKETS / 4;
const MAX_TICKETS_PER_MEMBER: usize = 4;
const MAX_BINDING_LENGTH: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsTicketRoute {
    Realtime,
    Voice,
    Extension,
    /// The self-hosted relay of a session Box screen
    /// (`/api/session-boxes/:conversationId/screen/ws`). Path-bound; the
    /// handler also requires the ticket's caller to own the session.
    SessionBox,
}

impl WsTicketRoute {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "realtime" => Some(Self::Realtime),
            "voice" => Some(Self::Voice),
            "ext" => Some(Self::Extension),
            "session-box" => Some(Self::SessionBox),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssueWsTicketRequest {
    /// `realtime`, `voice`, `ext`, or `session-box`.
    pub route: String,
    /// Exact resource path for an extension WebSocket, including `/api/ext/ws/`,
    /// or for a session Box screen relay
    /// (`/api/session-boxes/{conversationId}/screen/ws`).
    #[serde(default)]
    pub path: Option<String>,
    /// Room/conversation binding for realtime and, when supplied, voice.
    #[serde(default)]
    pub room_id: Option<String>,
    /// Realtime room kind (`conversation`, `document`, or `application`).
    #[serde(default)]
    pub kind: Option<String>,
    /// Application id for application rooms.
    #[serde(default)]
    pub app_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IssueWsTicketResponse {
    /// Opaque single-use value. It is not a node or user credential.
    pub ticket: String,
    pub expires_in: u64,
}

#[derive(Clone)]
pub struct WsTicketClaims {
    pub app_id: Option<String>,
    pub caller: Option<VerifiedCaller>,
    pub kind: Option<String>,
    pub path: Option<String>,
    /// Minted with a managed member's session credential, not the owner's
    /// boundary. Such a session gets typed chat's per-caller gates and cannot
    /// use owner-only voice options.
    pub member: bool,
    pub peer_is_loopback: bool,
    pub room_id: Option<String>,
    pub route: WsTicketRoute,
    /// Validated user-JWT expiry, when this ticket was minted for a user.
    /// `None` is reserved for the local single-user/node-token flow.
    pub jwt_expires_at: Option<i64>,
    /// Verified managed user JWT carried to the session's chat turns (`user_jwt`),
    /// as `chat_stream` carries it. Never serialized or returned to a client.
    pub user_jwt: Option<String>,
    /// The node-token generation observed while issuing the ticket. Keeping it
    /// in the returned claims closes the consume-to-upgrade rotation race.
    pub node_generation: u64,
}

/// Manual so the carried user JWT can never reach a log line.
impl std::fmt::Debug for WsTicketClaims {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WsTicketClaims")
            .field("app_id", &self.app_id)
            .field("caller", &self.caller)
            .field("kind", &self.kind)
            .field("path", &self.path)
            .field("member", &self.member)
            .field("peer_is_loopback", &self.peer_is_loopback)
            .field("room_id", &self.room_id)
            .field("route", &self.route)
            .field("jwt_expires_at", &self.jwt_expires_at)
            .field("node_generation", &self.node_generation)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct StoredTicket {
    claims: WsTicketClaims,
    expires_at: Instant,
    node_generation: u64,
}

static TICKETS: OnceLock<Mutex<HashMap<String, StoredTicket>>> = OnceLock::new();

fn tickets() -> &'static Mutex<HashMap<String, StoredTicket>> {
    TICKETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_binding(
    value: Option<String>,
    field: &'static str,
) -> Result<Option<String>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_BINDING_LENGTH || value.contains('\0') {
        return Err(field);
    }
    Ok(Some(value))
}

fn normalize_path(value: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(value) = normalize_binding(value, "path")? else {
        return Ok(None);
    };
    if !value.starts_with('/') || value.contains('?') || value.contains('#') {
        return Err("path");
    }
    // Extension paths may contain an encoded agent id. Compare decoded paths so
    // the HTTP issuer and Axum's route extractor bind the same value.
    let decoded = urlencoding::decode(&value)
        .map(std::borrow::Cow::into_owned)
        .map_err(|_| "path")?;
    if decoded.split('/').any(|segment| segment == "..") {
        return Err("path");
    }
    Ok(Some(decoded))
}

/// `/api/session-boxes/<conversation>/screen/ws` with exactly one non-empty
/// conversation segment (a sub-agent key's `#` is percent-encoded by clients and
/// decoded before this check).
fn is_session_box_screen_path(path: &str) -> bool {
    path.strip_prefix("/api/session-boxes/")
        .and_then(|rest| rest.strip_suffix("/screen/ws"))
        .is_some_and(|conversation| {
            !conversation.is_empty() && !conversation.contains('/') && conversation != "inference"
        })
}

fn normalize_request(
    request: IssueWsTicketRequest,
) -> Result<(WsTicketRoute, WsTicketClaims), &'static str> {
    let route = WsTicketRoute::parse(&request.route).ok_or("route")?;
    let path = normalize_path(request.path)?;
    let room_id = normalize_binding(request.room_id, "roomId")?;
    let kind = normalize_binding(request.kind, "kind")?;
    let app_id = normalize_binding(request.app_id, "appId")?;

    match route {
        WsTicketRoute::Realtime => {
            if path.is_some() || room_id.is_none() {
                return Err("realtime binding");
            }
            let Some(kind_value) = kind.as_deref() else {
                return Err("kind");
            };
            if !matches!(kind_value, "conversation" | "document" | "application") {
                return Err("kind");
            }
            if kind_value == "application" {
                if app_id.is_none() {
                    return Err("appId");
                }
            } else if app_id.is_some() {
                return Err("appId");
            }
        }
        WsTicketRoute::Voice => {
            if path.is_some() || kind.is_some() || app_id.is_some() {
                return Err("voice binding");
            }
        }
        WsTicketRoute::Extension => {
            if path.is_none() || room_id.is_some() || kind.is_some() || app_id.is_some() {
                return Err("extension binding");
            }
        }
        WsTicketRoute::SessionBox => {
            if room_id.is_some()
                || kind.is_some()
                || app_id.is_some()
                || !path.as_deref().is_some_and(is_session_box_screen_path)
            {
                return Err("session-box binding");
            }
        }
    }

    Ok((
        route,
        WsTicketClaims {
            app_id,
            caller: None,
            kind,
            path,
            member: false,
            peer_is_loopback: false,
            room_id,
            route,
            jwt_expires_at: None,
            user_jwt: None,
            node_generation: 0,
        },
    ))
}

/// Issue a ticket after authenticating the HTTP request with the node boundary.
/// On a tokenless development node only a genuine local peer may mint one.
#[utoipa::path(
    post,
    path = "/api/ws/ticket",
    tag = "Core",
    request_body = IssueWsTicketRequest,
    responses(
        (status = 200, description = "One-use WebSocket ticket", body = IssueWsTicketResponse),
        (status = 400, description = "Invalid ticket binding"),
        (status = 401, description = "Missing or invalid node authentication"),
        (status = 503, description = "Ticket issuer unavailable")
    )
)]
pub async fn issue(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<IssueWsTicketRequest>,
) -> Response {
    // The node owner may mint any route. A managed member may mint only a voice
    // ticket, admitted exactly as `POST /api/chat/stream` would admit them; the
    // ticket then carries that member's identity and credential expiry.
    let member = if authorized_http_request(&headers, peer) {
        None
    } else if WsTicketRoute::parse(&request.route) == Some(WsTicketRoute::Voice) {
        match super::authorize_member_voice_ticket(&headers).await {
            Some(member) => Some(member),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    } else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let (_, mut claims) = match normalize_request(request) {
        Ok(value) => value,
        Err(field) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid WebSocket ticket binding: {field}"),
            )
                .into_response();
        }
    };
    let is_member = member.is_some();
    if let Some(grant) = member {
        claims.caller = Some(grant.caller);
        claims.jwt_expires_at = Some(grant.expires_at);
        claims.user_jwt = grant.user_jwt;
        claims.member = true;
    } else if let Some((caller, expires_at)) =
        super::verified_caller_with_expiry_from_headers(&headers).await
    {
        claims.caller = Some(caller);
        claims.jwt_expires_at = Some(expires_at);
    }
    // The local single-user grant belongs to the owner's boundary only.
    claims.peer_is_loopback = !is_member
        && super::is_trusted_local_peer(peer.ip(), crate::sidecar::forwarding_tunnel_active());
    claims.node_generation = crate::node_token::active_generation();

    let token = uuid::Uuid::new_v4().simple().to_string();
    let node_generation = claims.node_generation;
    let stored = StoredTicket {
        claims,
        expires_at: Instant::now() + TICKET_TTL,
        node_generation,
    };
    let Ok(mut store) = tickets().lock() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let now = Instant::now();
    store.retain(|_, item| item.expires_at > now);
    if store.len() >= MAX_TICKETS {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if stored.claims.member && member_quota_reached(&store, stored.claims.caller.as_ref()) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    store.insert(token.clone(), stored);
    Json(IssueWsTicketResponse {
        ticket: token,
        expires_in: TICKET_TTL.as_secs(),
    })
    .into_response()
}

/// Consume a ticket exactly once. Route-specific handlers perform any final
/// frame-level binding (the realtime/voice room is named inside the first frame).
pub fn consume(
    token: Option<&str>,
    expected_route: WsTicketRoute,
    expected_path: Option<&str>,
) -> Option<WsTicketClaims> {
    let token = token?.trim();
    if token.is_empty() || token.len() > MAX_BINDING_LENGTH {
        return None;
    }
    let mut store = tickets().lock().ok()?;
    let stored = store.remove(token)?;
    if stored.expires_at <= Instant::now()
        || stored.node_generation != crate::node_token::active_generation()
        || stored.claims.route != expected_route
    {
        return None;
    }
    if let Some(expected_path) = expected_path {
        let expected_path = normalize_path(Some(expected_path.to_owned()))
            .ok()
            .flatten()?;
        if stored.claims.path.as_deref() != Some(expected_path.as_str()) {
            return None;
        }
    }
    Some(stored.claims)
}

/// Store `claims` as a live ticket and return its value, so a test can drive a
/// ticket-gated socket with claims (an expired JWT, say) the HTTP issuer would
/// only mint from a real identity.
#[cfg(test)]
pub(crate) fn mint_for_test(claims: WsTicketClaims) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let node_generation = claims.node_generation;
    if let Ok(mut store) = tickets().lock() {
        store.insert(
            token.clone(),
            StoredTicket {
                claims,
                expires_at: Instant::now() + TICKET_TTL,
                node_generation,
            },
        );
    }
    token
}

/// A connection-lifetime signal for a validated user JWT. Local node-token-only
/// tickets never expire through this path, so they remain pending until the
/// node-generation signal closes them.
pub async fn wait_for_jwt_expiry(expires_at: Option<i64>) {
    let Some(expires_at) = expires_at else {
        std::future::pending::<()>().await;
        return;
    };
    let now = chrono::Utc::now().timestamp();
    if expires_at <= now {
        return;
    }
    tokio::time::sleep(Duration::from_secs((expires_at - now) as u64)).await;
}

/// Whether one more member ticket for `caller` would exceed the member share of
/// the store or that member's own limit.
fn member_quota_reached(
    store: &HashMap<String, StoredTicket>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    let member_id = caller.map(|caller| caller.user_id.as_str());
    let mut members = 0_usize;
    let mut mine = 0_usize;
    for item in store.values().filter(|item| item.claims.member) {
        members += 1;
        if item
            .claims
            .caller
            .as_ref()
            .map(|caller| caller.user_id.as_str())
            == member_id
        {
            mine += 1;
        }
    }
    members >= MAX_MEMBER_TICKETS || mine >= MAX_TICKETS_PER_MEMBER
}

fn authorized_http_request(headers: &HeaderMap, peer: SocketAddr) -> bool {
    let expected = crate::node_token::active_token().filter(|token| !token.trim().is_empty());
    if let Some(expected) = expected {
        let provided = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        return provided.is_some_and(|value| super::ct_eq(value, expected.trim()));
    }
    super::is_trusted_local_peer(peer.ip(), crate::sidecar::forwarding_tunnel_active())
}

#[cfg(test)]
mod tests {
    use super::{normalize_path, normalize_request, IssueWsTicketRequest, WsTicketRoute};

    /// Issue an extension-route ticket from a loopback peer, authenticating with
    /// the node token when this process has one, and return its HTTP status
    /// plus the claims it was minted with.
    async fn issue_from_loopback() -> (axum::http::StatusCode, Option<super::WsTicketClaims>) {
        const PATH: &str = "/api/ext/ws/@ryu/desktop/bots/acp:pi/ws";
        let mut headers = axum::http::HeaderMap::new();
        if let Some(token) = crate::node_token::active_token() {
            headers.insert(
                "authorization",
                format!("Bearer {}", token.trim()).parse().unwrap(),
            );
        }
        let response = super::issue(
            axum::extract::ConnectInfo(std::net::SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                50_000,
            ))),
            headers,
            axum::Json(IssueWsTicketRequest {
                route: "ext".to_owned(),
                path: Some(PATH.to_owned()),
                room_id: None,
                kind: None,
                app_id: None,
            }),
        )
        .await;
        let status = response.status();
        if !status.is_success() {
            return (status, None);
        }
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let ticket: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let claims = super::consume(
            ticket["ticket"].as_str(),
            WsTicketRoute::Extension,
            Some(PATH),
        );
        (status, claims)
    }

    #[tokio::test]
    async fn tunneled_loopback_never_mints_a_local_ticket() {
        let (status, claims) = issue_from_loopback().await;
        assert!(status.is_success(), "a local peer may mint a ticket");
        assert!(claims.expect("ticket redeems").peer_is_loopback);

        let (status, claims) = crate::sidecar::FORCE_FORWARDING_FOR_TEST
            .scope(true, issue_from_loopback())
            .await;
        if crate::node_token::active_token().is_some() {
            // The node token still authenticates, but the ticket must not
            // carry the local single-user grant.
            assert!(status.is_success());
            assert!(!claims.expect("ticket redeems").peer_is_loopback);
        } else {
            // A tokenless node only serves genuine local peers.
            assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        }
    }

    fn member_ticket(user: &str) -> super::StoredTicket {
        let (_, mut claims) = normalize_request(IssueWsTicketRequest {
            route: "voice".to_owned(),
            path: None,
            room_id: None,
            kind: None,
            app_id: None,
        })
        .unwrap();
        claims.member = true;
        claims.caller = Some(crate::identity_verify::VerifiedCaller {
            user_id: user.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-acme".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        });
        super::StoredTicket {
            claims,
            expires_at: std::time::Instant::now() + super::TICKET_TTL,
            node_generation: 0,
        }
    }

    #[test]
    fn members_cannot_crowd_the_owner_out_of_tickets() {
        let mut store = std::collections::HashMap::new();
        let alice = member_ticket("alice").claims.caller;
        for index in 0..super::MAX_TICKETS_PER_MEMBER {
            assert!(!super::member_quota_reached(&store, alice.as_ref()));
            store.insert(format!("a{index}"), member_ticket("alice"));
        }
        assert!(super::member_quota_reached(&store, alice.as_ref()));
        // Another member still has room until the shared member share is spent.
        let bob = member_ticket("bob").claims.caller;
        assert!(!super::member_quota_reached(&store, bob.as_ref()));
        for index in 0..super::MAX_MEMBER_TICKETS {
            store.insert(
                format!("m{index}"),
                member_ticket(&format!("member-{index}")),
            );
        }
        assert!(super::member_quota_reached(&store, bob.as_ref()));
        assert!(super::MAX_MEMBER_TICKETS < super::MAX_TICKETS);
    }

    #[test]
    fn ticket_bindings_are_route_specific_and_paths_are_decoded() {
        let (route, claims) = normalize_request(IssueWsTicketRequest {
            route: "ext".to_owned(),
            path: Some("/api/ext/ws/@ryu/desktop/bots/acp%3Api/ws".to_owned()),
            room_id: None,
            kind: None,
            app_id: None,
        })
        .unwrap();
        assert_eq!(route, WsTicketRoute::Extension);
        assert_eq!(
            claims.path.as_deref(),
            Some("/api/ext/ws/@ryu/desktop/bots/acp:pi/ws")
        );
        assert!(normalize_path(Some("/api/ext/ws/../secret".to_owned())).is_err());
    }

    fn session_box_request(path: Option<&str>) -> IssueWsTicketRequest {
        IssueWsTicketRequest {
            route: "session-box".to_owned(),
            path: path.map(str::to_owned),
            room_id: None,
            kind: None,
            app_id: None,
        }
    }

    #[test]
    fn ws_ticket_session_box_route_is_path_bound_to_a_screen_relay() {
        let (route, claims) = normalize_request(session_box_request(Some(
            "/api/session-boxes/conv-1/screen/ws",
        )))
        .unwrap();
        assert_eq!(route, WsTicketRoute::SessionBox);
        assert_eq!(
            claims.path.as_deref(),
            Some("/api/session-boxes/conv-1/screen/ws")
        );
        // A sub-agent key arrives percent-encoded and is bound decoded.
        let (_, child) = normalize_request(session_box_request(Some(
            "/api/session-boxes/conv-1%23sub%3A2/screen/ws",
        )))
        .unwrap();
        assert_eq!(
            child.path.as_deref(),
            Some("/api/session-boxes/conv-1#sub:2/screen/ws")
        );
        for bad in [
            None,
            Some("/api/ext/ws/@ryu/desktop/ws"),
            Some("/api/session-boxes//screen/ws"),
            Some("/api/session-boxes/a/b/screen/ws"),
            Some("/api/session-boxes/conv-1/screen"),
            Some("/api/session-boxes/inference/screen/ws"),
            Some("/api/session-boxes/../screen/ws"),
        ] {
            assert!(
                normalize_request(session_box_request(bad)).is_err(),
                "{bad:?} must be refused"
            );
        }
        let mut with_room = session_box_request(Some("/api/session-boxes/conv-1/screen/ws"));
        with_room.room_id = Some("room".to_owned());
        assert!(normalize_request(with_room).is_err());
    }

    #[test]
    fn ws_ticket_session_box_tickets_redeem_only_for_their_route_and_path() {
        let (_, claims) = normalize_request(session_box_request(Some(
            "/api/session-boxes/conv-9/screen/ws",
        )))
        .unwrap();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let insert = |token: &str| {
            super::tickets().lock().unwrap().insert(
                token.to_owned(),
                super::StoredTicket {
                    claims: super::WsTicketClaims {
                        node_generation: crate::node_token::active_generation(),
                        ..claims.clone()
                    },
                    expires_at: std::time::Instant::now() + super::TICKET_TTL,
                    node_generation: crate::node_token::active_generation(),
                },
            );
        };
        insert(&token);
        assert!(super::consume(
            Some(&token),
            WsTicketRoute::Extension,
            Some("/api/session-boxes/conv-9/screen/ws")
        )
        .is_none());
        insert(&token);
        assert!(super::consume(
            Some(&token),
            WsTicketRoute::SessionBox,
            Some("/api/session-boxes/other/screen/ws")
        )
        .is_none());
        insert(&token);
        let redeemed = super::consume(
            Some(&token),
            WsTicketRoute::SessionBox,
            Some("/api/session-boxes/conv-9/screen/ws"),
        )
        .expect("the bound path redeems");
        assert_eq!(redeemed.route, WsTicketRoute::SessionBox);
        assert!(
            super::consume(
                Some(&token),
                WsTicketRoute::SessionBox,
                Some("/api/session-boxes/conv-9/screen/ws")
            )
            .is_none(),
            "a ticket is single-use"
        );
    }

    #[test]
    fn realtime_tickets_require_room_and_kind() {
        assert!(normalize_request(IssueWsTicketRequest {
            route: "realtime".to_owned(),
            path: None,
            room_id: None,
            kind: Some("conversation".to_owned()),
            app_id: None,
        })
        .is_err());
        assert!(normalize_request(IssueWsTicketRequest {
            route: "realtime".to_owned(),
            path: None,
            room_id: Some("room".to_owned()),
            kind: Some("bogus".to_owned()),
            app_id: None,
        })
        .is_err());
    }
}
