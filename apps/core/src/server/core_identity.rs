//! Credential-free proof that the process answering on Core's port is the Core
//! holding the node token.
//!
//! A loopback port is not an identity: any local account can claim an unused
//! port before Core starts and answer `/api/health`. Clients that hold the node
//! token therefore send a fresh nonce here, with no credential, and compare the
//! answer with
//! `HMAC-SHA256(node token, "ryu-core-identity-v2:<local address>:<nonce>")`
//! computed locally. Only a process that knows the token can answer.
//!
//! `<local address>` is the local socket address of the TCP connection that
//! carried the challenge (`127.0.0.1:7980`, `[::1]:7980`), not just the port.
//! A squatter on another loopback address with the same port number (Core on
//! `127.0.0.1:7980`, squatter on `[::1]:7980` or `127.0.0.2:7980`) can relay the
//! challenge to Core, but Core answers for the address the relay connected to,
//! which is never the address the client dialed. The client dials a literal
//! address, verifies the proof for that address, and sends its bearer on the
//! same connection, so the check is also bound to the connection it gates.
//! The proof is domain-separated, so it is never a bearer and authorizes nothing.
//!
//! In a debug `dev` build the public listener is the dev-execution facade
//! (`dev_execution::serve`), which relays each connection to a worker on a
//! private port. The worker would otherwise prove its private address, which
//! no client dialed. The facade therefore tags a leading identity challenge
//! with the local address of the connection it accepted, MACed with the
//! facade/worker key over that address and the nonce, and the worker proves
//! that address instead (`dev_execution::relayed_local_addr`). Only the facade
//! holds the key, so a squatter that relays to the worker directly (for
//! example on Core's public port after the facade stopped) still gets a proof
//! for the private address, and one that relays through the facade from
//! another address gets a proof for the facade's address, never its own.

use std::net::SocketAddr;

use axum::{
    extract::{connect_info::Connected, ConnectInfo, Query, Request},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    serve::IncomingStream,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

const IDENTITY_DOMAIN: &str = "ryu-core-identity-v2";
const NONCE_HEX_LEN: usize = 64;

/// Peer and local socket of one accepted HTTP connection. Core's listener
/// records this per connection; [`expose_connection_addrs`] republishes the
/// peer as the usual `ConnectInfo<SocketAddr>` for every other handler.
#[derive(Clone, Copy, Debug)]
pub struct ConnectionAddrs {
    pub peer: SocketAddr,
    pub local: Option<SocketAddr>,
}

impl Connected<IncomingStream<'_>> for ConnectionAddrs {
    fn connect_info(stream: IncomingStream<'_>) -> Self {
        Self {
            peer: stream.remote_addr(),
            local: stream.local_addr().ok(),
        }
    }
}

/// The local socket address of the connection a request arrived on.
#[derive(Clone, Copy, Debug)]
pub struct LocalAddr(pub SocketAddr);

/// Outermost middleware for Core's listener: re-exposes the peer as
/// `ConnectInfo<SocketAddr>` (what the rest of the router extracts) and the
/// connection's local address as [`LocalAddr`].
pub async fn expose_connection_addrs(mut request: Request, next: Next) -> Response {
    if let Some(ConnectInfo(addrs)) = request
        .extensions()
        .get::<ConnectInfo<ConnectionAddrs>>()
        .copied()
    {
        request.extensions_mut().insert(ConnectInfo(addrs.peer));
        if let Some(local) = addrs.local {
            request.extensions_mut().insert(LocalAddr(local));
        }
    }
    next.run(request).await
}

/// The canonical text of a local address: IPv4-mapped IPv6 (a dual-stack
/// listener accepting an IPv4 client) is written as plain IPv4, IPv6 is
/// bracketed, and flow and scope ids are dropped.
pub fn canonical_local_addr(local: SocketAddr) -> String {
    SocketAddr::new(local.ip().to_canonical(), local.port()).to_string()
}

/// The proof a client expects for `nonce` from a Core whose connection to it
/// is bound locally to `local`.
pub fn identity_proof(node_token: &str, local: SocketAddr, nonce: &str) -> String {
    ryu_crypto::hmac_sha256_hex(
        node_token.as_bytes(),
        format!("{IDENTITY_DOMAIN}:{}:{nonce}", canonical_local_addr(local)).as_bytes(),
    )
}

fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == NONCE_HEX_LEN && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Deserialize)]
pub struct IdentityQuery {
    nonce: Option<String>,
}

fn respond(token: Option<String>, local: Option<SocketAddr>, nonce: Option<&str>) -> Response {
    let Some(nonce) = nonce.filter(|nonce| valid_nonce(nonce)) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // Without a node token there is nothing to prove; without the connection's
    // local address the proof could not be bound to it. Either way a client
    // that holds a token must treat this listener as unverified.
    let (Some(token), Some(local)) = (token.filter(|token| !token.is_empty()), local) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "version": 2,
            "proof": identity_proof(&token, local, &nonce.to_ascii_lowercase()),
        })),
    )
        .into_response()
}

/// The answer for a challenge that arrived on a connection bound locally to
/// `connection_local`. `relay_key` is the dev-execution facade's key, present
/// only inside a dev execution worker: a challenge the facade tagged (and
/// MACed) with the address it accepted is proved for that address, and a tag
/// that does not verify is refused rather than ignored.
pub fn identity_response(
    token: Option<String>,
    connection_local: Option<SocketAddr>,
    headers: &HeaderMap,
    nonce: Option<&str>,
    relay_key: Option<&str>,
) -> Response {
    use crate::dev_execution::{relayed_local_addr, RelayedLocal};
    let local = match relayed_local_addr(headers, nonce, relay_key) {
        RelayedLocal::Absent => connection_local,
        RelayedLocal::Verified(facade_local) => Some(facade_local),
        RelayedLocal::Rejected => None,
    };
    respond(token, local, nonce)
}

/// `GET /api/health/identity?nonce=<64 hex>`: public, credential-free.
pub async fn identity_handler(
    local: Option<Extension<LocalAddr>>,
    headers: HeaderMap,
    Query(query): Query<IdentityQuery>,
) -> Response {
    identity_response(
        crate::node_token::active_token(),
        local.map(|Extension(LocalAddr(addr))| addr),
        &headers,
        query.nonce.as_deref(),
        crate::dev_execution::worker_relay_key().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn addr(text: &str) -> SocketAddr {
        text.parse().expect("socket address")
    }

    async fn body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    #[tokio::test]
    async fn proof_binds_token_local_address_and_nonce() {
        let core = addr("127.0.0.1:7980");
        let response = respond(Some("node-secret".into()), Some(core), Some(NONCE));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let proof = body(response).await["proof"].as_str().unwrap().to_string();
        assert_eq!(proof, identity_proof("node-secret", core, NONCE));
        assert_ne!(
            proof,
            identity_proof("node-secret", addr("127.0.0.1:7981"), NONCE)
        );
        assert_ne!(proof, identity_proof("other-secret", core, NONCE));
        assert!(!proof.contains("node-secret"));
        // Same port, another loopback address: what a relaying squatter on that
        // address would need, and cannot get.
        for other in ["[::1]:7980", "127.0.0.2:7980"] {
            assert_ne!(proof, identity_proof("node-secret", addr(other), NONCE));
        }
        // Pinned vectors shared with the CLI's verifier
        // (apps/cli/src/__tests__/node-health-target.test.ts).
        assert_eq!(
            identity_proof("node-secret", core, NONCE),
            "304649b1001efca1392c1cf317f23386536de2d0a6ff81c58944d967f5182d67"
        );
        assert_eq!(
            identity_proof("node-secret", addr("[::1]:7980"), NONCE),
            "b3ff0967bcc5d24f202186d01c9cb19f9e13628400bcfd566ff1eed72fbdfa87"
        );
    }

    #[test]
    fn dual_stack_ipv4_clients_prove_the_ipv4_address() {
        assert_eq!(
            canonical_local_addr(addr("[::ffff:127.0.0.1]:7980")),
            "127.0.0.1:7980"
        );
        assert_eq!(canonical_local_addr(addr("[::1]:7980")), "[::1]:7980");
        assert_eq!(
            identity_proof("node-secret", addr("[::ffff:127.0.0.1]:7980"), NONCE),
            identity_proof("node-secret", addr("127.0.0.1:7980"), NONCE)
        );
    }

    #[test]
    fn refuses_bad_nonces_and_missing_token_or_address() {
        let core = Some(addr("127.0.0.1:7980"));
        for nonce in [None, Some("short"), Some(&"z".repeat(64)[..])] {
            assert_eq!(
                respond(Some("node-secret".into()), core, nonce).status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            respond(None, core, Some(NONCE)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(Some(String::new()), core, Some(NONCE)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(Some("node-secret".into()), None, Some(NONCE)).status(),
            StatusCode::NOT_FOUND
        );
    }

    /// The real listener wiring: each connection's proof names the local
    /// address that connection was accepted on, and every other handler still
    /// sees the peer as `ConnectInfo<SocketAddr>`.
    #[tokio::test]
    async fn listener_binds_each_proof_to_the_accepting_address() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // `identity_handler` with a fixed token instead of the process-wide one.
        let router =
            axum::Router::new()
                .route(
                    "/api/health/identity",
                    axum::routing::get(
                        |local: Option<Extension<LocalAddr>>,
                         Query(query): Query<IdentityQuery>| async move {
                            respond(
                                Some("node-secret".into()),
                                local.map(|Extension(LocalAddr(addr))| addr),
                                query.nonce.as_deref(),
                            )
                        },
                    ),
                )
                .route(
                    "/peer",
                    axum::routing::get(|ConnectInfo(peer): ConnectInfo<SocketAddr>| async move {
                        peer.ip().to_string()
                    }),
                )
                .layer(axum::middleware::from_fn(expose_connection_addrs));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bound = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<ConnectionAddrs>(),
            )
            .await
            .unwrap();
        });

        let get = |path: String| async move {
            let mut stream = tokio::net::TcpStream::connect(bound).await.unwrap();
            stream
                .write_all(
                    format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut raw = String::new();
            stream.read_to_string(&mut raw).await.unwrap();
            raw.split("\r\n\r\n").nth(1).unwrap_or_default().to_string()
        };
        let answer: serde_json::Value =
            serde_json::from_str(&get(format!("/api/health/identity?nonce={NONCE}")).await)
                .unwrap();
        assert_eq!(
            answer["proof"],
            identity_proof("node-secret", bound, NONCE),
            "proof must name the accepting address {bound}"
        );
        assert_eq!(get("/peer".into()).await, "127.0.0.1");
    }
}
