//! Brokered WebSocket upgrades.
//!
//! An `Upgrade: websocket` request (absolute-form, or inside an intercepted
//! tunnel) is authorized exactly like any brokered request and gets its
//! handshake credentials (auth headers and header, path, and query
//! placeholders). The broker then dials the upstream itself (network guard,
//! normal certificate verification, `http/1.1` only), sends the handshake,
//! and answers the client with the upstream's response. After a `101` the two
//! connections are relayed until either side closes, the session ends, or
//! its tunnel slot is released:
//!
//! * a service with `websocket` substitutions has its extensions stripped
//!   from the handshake (frames stay uncompressed), placeholders in client
//!   text messages substituted, and the substituted values swapped back to
//!   their placeholders in upstream text messages, so an echo does not return
//!   them to the agent. Each message that carries a placeholder is resolved
//!   afresh under the session's current policies (and the minting machine
//!   token's, which must still exist), so a deny, a revoked token, or a
//!   rotated value applies to the next message. A message whose credential
//!   cannot be resolved closes the connection with `1008` and is never sent;
//! * any other upgraded connection is copied unchanged.
//!
//! An OAuth service's token is fetched for [`ConnectionAction::Delete`]: the
//! handshake is a `GET`, but the channel it opens carries messages that can
//! write or delete, which the broker cannot classify. Only a connection whose
//! access level allows deletes can open one.
//!
//! Card placeholders are never substituted on WebSockets, so a host covered
//! only by a card merchant allowlist is refused.

use std::sync::Mutex;

use futures_util::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _};

use super::super::box_relay;
use super::ws_frame::{self, PumpError, Sender, TextRewriter};
use super::*;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether `request` asks to upgrade to a WebSocket (RFC 6455 section 4.1).
pub(super) fn is_upgrade<B>(request: &Request<B>) -> bool {
    let has_token = |name: HeaderName, token: &str| {
        request.headers().get_all(name).iter().any(|value| {
            value.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case(token))
            })
        })
    };
    request.method() == Method::GET
        && has_token(hyper::header::UPGRADE, "websocket")
        && has_token(hyper::header::CONNECTION, "upgrade")
}

/// The connection action an OAuth token for a WebSocket is fetched for: the
/// strictest, since messages on the channel are not classified.
pub(super) const WEBSOCKET_OAUTH_ACTION: ConnectionAction = ConnectionAction::Delete;

/// Placeholder substitution for client text messages.
struct Substituter {
    broker: Arc<Broker>,
    session: BrokerSession,
    /// `(placeholder, reference)` for each `websocket` substitution.
    substitutions: Vec<(String, String)>,
    /// Values substituted so far, shared with the upstream direction.
    used: Arc<Mutex<Vec<(String, String)>>>,
}

impl TextRewriter for Substituter {
    fn rewrite<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<Option<String>, ()>> {
        Box::pin(async move {
            let mut pairs = Vec::new();
            // A fresh resolver per message: policies, the minting machine
            // token, and values are read as they are now, never cached for
            // the life of the connection.
            let mut resolver = None;
            for (placeholder, reference) in &self.substitutions {
                if !text.contains(placeholder.as_str()) {
                    continue;
                }
                if resolver.is_none() {
                    resolver = Some(self.broker.resolver(&self.session).await.map_err(|_| ())?);
                }
                let Some(resolver) = resolver.as_mut() else {
                    return Err(());
                };
                // The refusal is not sent anywhere: the connection closes.
                let value = resolver.resolve(reference).await.map_err(|_| ())?;
                pairs.push((placeholder.clone(), value));
            }
            if pairs.is_empty() {
                return Ok(None);
            }
            if let Ok(mut used) = self.used.lock() {
                for pair in &pairs {
                    if !used.contains(pair) {
                        used.push(pair.clone());
                    }
                }
            }
            Ok(substitute::substitute_message(text, &pairs))
        })
    }
}

/// Swaps substituted values back to placeholders in upstream text messages.
struct Redactor {
    used: Arc<Mutex<Vec<(String, String)>>>,
}

impl TextRewriter for Redactor {
    fn rewrite<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<Option<String>, ()>> {
        let redacted = match self.used.lock() {
            Ok(used) => Ok(substitute::redact_message(text, &used)),
            // Fail closed: without the list nothing could be redacted.
            Err(_) => Err(()),
        };
        Box::pin(async move { redacted })
    }
}

impl Broker {
    pub(super) async fn forward_websocket(
        self: &Arc<Self>,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        let started = Instant::now();
        let path = request.uri().path().to_owned();
        let (response, service, outcome) = match self.open_websocket(session, target, request).await
        {
            Ok((response, service, outcome)) => (response, service, outcome),
            Err((refusal, service)) => (refusal.response, service, refusal.outcome),
        };
        let row = Self::log_row(
            session,
            &Method::GET,
            target,
            &path,
            service,
            response.status(),
            started,
            outcome,
        );
        self.record(row).await;
        response
    }

    async fn open_websocket(
        self: &Arc<Self>,
        session: &BrokerSession,
        target: &Target,
        mut request: Request<Incoming>,
    ) -> Result<(Response<ProxyBody>, Option<String>, &'static str), (Refusal, Option<String>)>
    {
        let route = self.route(session, target, request.uri().path()).await?;
        let name = route.service.as_ref().map(|s| s.name().to_owned());
        let fail = |refusal: Refusal| (refusal, name.clone());
        if route.merchant_only {
            return Err(fail(forbidden_unmatched(&target.host)));
        }
        let permit = self.acquire_tunnel(&session.id).ok_or_else(|| {
            fail(Refusal::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_tunnels",
                "the broker session has too many open tunnels",
            ))
        })?;
        let client_upgrade = hyper::upgrade::on(&mut request);
        let mut outgoing = self.read_request(request).await.map_err(fail)?;
        let mut substituter = None;
        if let Some(service) = &route.service {
            self.inject(session, service, &mut outgoing, WEBSOCKET_OAUTH_ACTION)
                .await
                .map_err(fail)?;
            let substitutions: Vec<(String, String)> = service
                .input
                .substitutions
                .iter()
                .filter(|s| s.surfaces.contains(&Surface::WebSocket))
                .map(|s| (s.placeholder.clone(), s.reference.clone()))
                .collect();
            // Never for a Box's relay session: a host can echo messages.
            if !substitutions.is_empty() && !box_relay::is_box_session(session) {
                // Compressed frames could not be rewritten.
                outgoing
                    .headers
                    .remove(HeaderName::from_static("sec-websocket-extensions"));
                substituter = Some(Substituter {
                    broker: self.clone(),
                    session: session.clone(),
                    substitutions,
                    used: Arc::new(Mutex::new(Vec::new())),
                });
            }
        }
        let mut upstream = self.dial_websocket(target, outgoing).await.map_err(fail)?;
        if upstream.status() != StatusCode::SWITCHING_PROTOCOLS {
            let (parts, body) = upstream.into_parts();
            let mut response = Response::new(
                body.map_err(|error| Box::new(error) as BoxError)
                    .boxed_unsync(),
            );
            *response.status_mut() = parts.status;
            *response.headers_mut() = end_to_end(&parts.headers, false);
            return Ok((response, name, "forwarded"));
        }
        let headers = end_to_end(upstream.headers(), false);
        if substituter.is_some() && headers.contains_key("sec-websocket-extensions") {
            return Err(fail(Refusal::new(
                StatusCode::BAD_GATEWAY,
                "upstream_invalid",
                "the upstream negotiated a WebSocket extension that was not offered",
            )));
        }
        let upstream_upgrade = hyper::upgrade::on(&mut upstream);
        let mut response = Response::new(empty());
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        *response.headers_mut() = headers;
        let response_headers = response.headers_mut();
        response_headers.insert(
            hyper::header::CONNECTION,
            HeaderValue::from_static("upgrade"),
        );
        response_headers.insert(
            hyper::header::UPGRADE,
            HeaderValue::from_static("websocket"),
        );
        let broker = self.clone();
        let session = session.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let (client, upstream) = match tokio::join!(client_upgrade, upstream_upgrade) {
                (Ok(client), Ok(upstream)) => (client, upstream),
                _ => {
                    tracing::debug!("broker WebSocket upgrade did not complete");
                    return;
                }
            };
            broker
                .relay_websocket(&session, client, upstream, substituter)
                .await;
        });
        Ok((response, name, "websocket"))
    }

    /// Connect to the upstream and send the handshake.
    async fn dial_websocket(
        &self,
        target: &Target,
        outgoing: Outgoing,
    ) -> Result<Response<Incoming>, Refusal> {
        let unreachable = |what: &str| {
            Refusal::new(
                StatusCode::BAD_GATEWAY,
                "upstream_unreachable",
                &format!("upstream {what}"),
            )
        };
        let addrs = self
            .guard
            .resolve(&target.host, target.port)
            .await
            .map_err(|error| {
                Refusal::new(
                    StatusCode::FORBIDDEN,
                    "netguard_blocked",
                    &error.to_string(),
                )
            })?;
        let request = handshake_request(target, outgoing)?;
        let dial = async {
            let tcp = TcpStream::connect(&addrs[..])
                .await
                .map_err(|_| unreachable("connection failed"))?;
            if target.scheme == "http" {
                return send_handshake(tcp, request).await;
            }
            let server_name = rustls::pki_types::ServerName::try_from(target.host.clone())
                .map_err(|_| unreachable("name is invalid"))?;
            let connector = tokio_rustls::TlsConnector::from(self.upstream_tls_config()?);
            let tls = connector
                .connect(server_name, tcp)
                .await
                .map_err(|_| unreachable("TLS handshake failed"))?;
            send_handshake(tls, request).await
        };
        tokio::time::timeout(HANDSHAKE_TIMEOUT, dial)
            .await
            .map_err(|_| unreachable("timed out"))?
    }

    /// Client TLS for upstreams: OS roots plus any configured extra roots,
    /// `http/1.1` only.
    fn upstream_tls_config(&self) -> Result<Arc<rustls::ClientConfig>, Refusal> {
        let internal = || {
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "broker_internal",
                "upstream TLS is unavailable",
            )
        };
        let mut roots = rustls::RootCertStore::empty();
        let loaded = rustls_native_certs::load_native_certs();
        roots.add_parsable_certificates(loaded.certs);
        for pem in &self.config.extra_upstream_roots_pem {
            roots
                .add(ca::pem_to_der(pem).map_err(|_| internal())?)
                .map_err(|_| internal())?;
        }
        let mut config = rustls::ClientConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|_| internal())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }

    /// Relay an upgraded connection until it closes or the session ends.
    async fn relay_websocket(
        &self,
        session: &BrokerSession,
        client: hyper::upgrade::Upgraded,
        upstream: hyper::upgrade::Upgraded,
        substituter: Option<Substituter>,
    ) {
        let mut client = TokioIo::new(client);
        let mut upstream = TokioIo::new(upstream);
        let ended = self.session_ended(&session.id, session.expires_at);
        let Some(mut substituter) = substituter else {
            tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {}
                () = ended => tracing::debug!(session = session.id, "closing broker WebSocket: session ended"),
            }
            return;
        };
        let mut redactor = Redactor {
            used: substituter.used.clone(),
        };
        let max = substitute::MAX_BODY_SUBSTITUTION_BYTES;
        let (mut client_read, mut client_write) = tokio::io::split(client);
        let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
        let to_upstream = ws_frame::pump(
            &mut client_read,
            &mut upstream_write,
            Sender::Client,
            &mut substituter,
            max,
        );
        let to_client = ws_frame::pump(
            &mut upstream_read,
            &mut client_write,
            Sender::Server,
            &mut redactor,
            max,
        );
        let end = relay_both(to_upstream, to_client, ended).await;
        if let RelayEnd::Stopped(error) = end {
            let reason = match error {
                PumpError::Refused => "broker credential unavailable",
                PumpError::Protocol(violation) => {
                    tracing::debug!(session = session.id, "broker WebSocket: {violation}");
                    "broker protocol error"
                }
                PumpError::Io(error) => {
                    tracing::debug!(session = session.id, "broker WebSocket ended: {error}");
                    ""
                }
            };
            if !reason.is_empty() {
                let _ = ws_frame::write_close(
                    &mut client_write,
                    Sender::Server,
                    ws_frame::CLOSE_POLICY_VIOLATION,
                    reason,
                )
                .await;
            }
        }
        let _ = client_write.shutdown().await;
        let _ = upstream_write.shutdown().await;
    }
}

/// How a two-way relay ended.
enum RelayEnd {
    Closed,
    SessionEnded,
    Stopped(PumpError),
}

/// Run both directions: a clean end waits for the other direction, an error
/// or the session ending stops both.
async fn relay_both(
    to_upstream: impl std::future::Future<Output = Result<(), PumpError>>,
    to_client: impl std::future::Future<Output = Result<(), PumpError>>,
    ended: impl std::future::Future<Output = ()>,
) -> RelayEnd {
    tokio::pin!(to_upstream, to_client, ended);
    let (mut upstream_done, mut client_done) = (false, false);
    while !(upstream_done && client_done) {
        tokio::select! {
            result = &mut to_upstream, if !upstream_done => match result {
                Ok(()) => upstream_done = true,
                Err(error) => return RelayEnd::Stopped(error),
            },
            result = &mut to_client, if !client_done => match result {
                Ok(()) => client_done = true,
                Err(error) => return RelayEnd::Stopped(error),
            },
            () = &mut ended => return RelayEnd::SessionEnded,
        }
    }
    RelayEnd::Closed
}

/// The origin-form handshake request for the upstream.
fn handshake_request(
    target: &Target,
    outgoing: Outgoing,
) -> Result<Request<Empty<Bytes>>, Refusal> {
    let query = outgoing
        .query
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let default_port = if target.scheme == "http" { 80 } else { 443 };
    let host = if target.port == default_port {
        target.host.clone()
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let invalid = || {
        Refusal::new(
            StatusCode::BAD_REQUEST,
            "invalid_target",
            "invalid upstream URL",
        )
    };
    let mut request = Request::builder()
        .method(Method::GET)
        .uri(format!("{}{query}", outgoing.path))
        .body(Empty::new())
        .map_err(|_| invalid())?;
    let headers = request.headers_mut();
    *headers = outgoing.headers;
    headers.insert(
        hyper::header::HOST,
        HeaderValue::from_str(&host).map_err(|_| invalid())?,
    );
    headers.insert(
        hyper::header::CONNECTION,
        HeaderValue::from_static("upgrade"),
    );
    headers.insert(
        hyper::header::UPGRADE,
        HeaderValue::from_static("websocket"),
    );
    Ok(request)
}

async fn send_handshake<T>(
    io: T,
    request: Request<Empty<Bytes>>,
) -> Result<Response<Incoming>, Refusal>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // The error text can echo the request, which may hold a substituted
    // value; report only that it failed.
    let failed = || {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "upstream_unreachable",
            "upstream handshake failed",
        )
    };
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|_| failed())?;
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!("broker WebSocket upstream connection ended: {error}");
        }
    });
    sender.send_request(request).await.map_err(|_| failed())
}

#[cfg(test)]
#[path = "websocket_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "websocket_policy_tests.rs"]
mod policy_tests;
