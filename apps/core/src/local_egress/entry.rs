//! Node (entry) side: the cloud node's local proxy and the desktop session it
//! forwards through.
//!
//! The node runs one credentialed proxy listener on loopback (and, when Docker
//! is present, on the bridge gateway so cloud task containers can reach it).
//! Every connection is dialed by [`dial`]:
//!
//! - **routed** and the org allows it: the connection is carried over the
//!   attached desktop session. With no desktop attached the connection is
//!   refused (fail closed) rather than silently leaving from the cloud IP.
//! - otherwise: Core dials directly after the shared SSRF screening.
//!
//! A second loopback listener, with its own credential, serves model-provider
//! clients. Its connections take the desktop path only when the destination
//! belongs to a provider route the owner turned on (see [`super::providers`]);
//! everything else on it dials directly.
//!
//! "Routed" is persisted when a desktop attaches and cleared only by an explicit
//! detach, so a sleeping laptop keeps the node failing closed until it returns.

use super::{
    admin_policy,
    frame::RefuseCode,
    mux::{Mux, OpenError},
    providers,
    proxy::{self, Credential, Protocol},
    AdminPolicy, ROUTED_PREF_KEY,
};
use crate::server::preferences::PreferencesStore;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};

/// Opt-in for self-hosted nodes; managed cloud nodes enable it implicitly.
const ENTRY_ENV: &str = "RYU_LOCAL_EGRESS_ENTRY";
/// Explicit bridge address for task containers (otherwise Docker is asked).
const BRIDGE_ADDR_ENV: &str = "RYU_LOCAL_EGRESS_BRIDGE_ADDR";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Sessions are re-established periodically so a revoked desktop credential
/// stops carrying traffic without waiting for the socket to drop.
const MAX_SESSION: Duration = Duration::from_secs(30 * 60);
const POLICY_RECHECK: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const MAX_CLIENTS: usize = 512;

struct Attached {
    generation: u64,
    mux: Arc<Mux>,
    desktop: String,
    since_ms: i64,
    superseded: Arc<Notify>,
}

/// Where local consumers reach the proxy, and the credential they must present.
#[derive(Clone)]
pub(crate) struct ProxyEndpoint {
    pub credential: Credential,
    pub loopback: SocketAddr,
    pub bridge: Option<SocketAddr>,
    /// The provider listener (loopback only) and its own credential.
    pub provider: Option<(SocketAddr, Credential)>,
}

/// Which listener a connection arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Listener {
    /// Browser tabs and cloud tasks: every destination follows the route.
    General,
    /// Model-provider clients: only enabled provider routes follow it.
    Provider,
}

struct Entry {
    attached: Mutex<Option<Attached>>,
    routed: AtomicBool,
    generation: AtomicU64,
    endpoint: OnceLock<ProxyEndpoint>,
    preferences: OnceLock<PreferencesStore>,
    clients: Arc<tokio::sync::Semaphore>,
}

fn entry() -> &'static Entry {
    static ENTRY: OnceLock<Entry> = OnceLock::new();
    ENTRY.get_or_init(|| Entry {
        attached: Mutex::new(None),
        routed: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        endpoint: OnceLock::new(),
        preferences: OnceLock::new(),
        clients: Arc::new(tokio::sync::Semaphore::new(MAX_CLIENTS)),
    })
}

fn truthy(value: Option<String>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Whether this Core should run the entry side at all.
pub(crate) fn entry_enabled() -> bool {
    truthy(std::env::var("RYU_MANAGED_NODE").ok()) || truthy(std::env::var(ENTRY_ENV).ok())
}

/// The proxy endpoint, once the listener is up.
pub(crate) fn endpoint() -> Option<ProxyEndpoint> {
    entry().endpoint.get().cloned()
}

/// Whether traffic is currently meant to leave through a desktop. False when an
/// admin has disabled the route, so consumers fall back to the cloud path.
pub(crate) async fn routing_active() -> bool {
    routed() && admin_policy().await != AdminPolicy::Disabled
}

/// A desktop asked for routing and has not turned it off (no policy lookup).
pub(crate) fn routed() -> bool {
    entry().routed.load(Ordering::Acquire)
}

/// Boot: restore the routed flag and start the listener(s).
pub(crate) async fn init(preferences: PreferencesStore) {
    if !entry_enabled() {
        return;
    }
    let state = entry();
    if let Ok(Some(value)) = preferences.get(ROUTED_PREF_KEY).await {
        state.routed.store(truthy(Some(value)), Ordering::Release);
    }
    let _ = state.preferences.set(preferences.clone());
    providers::init(preferences).await;

    let credential = Credential::generate();
    let loopback = match bind(
        SocketAddr::from(([127, 0, 0, 1], 0)),
        credential.clone(),
        Listener::General,
    )
    .await
    {
        Ok(address) => address,
        Err(error) => {
            tracing::warn!("local egress: proxy listener unavailable: {error}");
            return;
        }
    };
    let bridge = match bridge_address().await {
        Some(ip) => match bind(
            SocketAddr::new(ip, 0),
            credential.clone(),
            Listener::General,
        )
        .await
        {
            Ok(address) => Some(address),
            Err(error) => {
                tracing::debug!("local egress: no task-container listener on {ip}: {error}");
                None
            }
        },
        None => None,
    };
    let provider_credential = Credential::generate();
    let provider = match bind(
        SocketAddr::from(([127, 0, 0, 1], 0)),
        provider_credential.clone(),
        Listener::Provider,
    )
    .await
    {
        Ok(address) => Some((address, provider_credential)),
        Err(error) => {
            tracing::warn!("local egress: provider listener unavailable: {error}");
            None
        }
    };
    let _ = state.endpoint.set(ProxyEndpoint {
        credential,
        loopback,
        bridge,
        provider,
    });
    // The state file was first written before the provider listener existed;
    // publish it again so the Gateway learns the listener.
    providers::publish_state();
    tracing::info!(
        routed = state.routed.load(Ordering::Acquire),
        "local egress: proxy listening on {loopback}"
    );
}

async fn bridge_address() -> Option<IpAddr> {
    if let Ok(value) = std::env::var(BRIDGE_ADDR_ENV) {
        return value.trim().parse().ok();
    }
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("docker")
            .args([
                "network",
                "inspect",
                "bridge",
                "--format",
                "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
            ])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

async fn bind(
    address: SocketAddr,
    credential: Credential,
    kind: Listener,
) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                continue;
            };
            let Ok(permit) = entry().clients.clone().try_acquire_owned() else {
                drop(socket);
                continue;
            };
            let credential = credential.clone();
            tokio::spawn(async move {
                serve_client(socket, &credential, kind).await;
                drop(permit);
            });
        }
    });
    Ok(bound)
}

async fn serve_client(mut socket: TcpStream, credential: &Credential, kind: Listener) {
    let Ok(Ok(request)) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, proxy::accept(&mut socket, credential)).await
    else {
        return;
    };
    match dial(&request.host, request.port, kind).await {
        Ok(Upstream::Direct(mut upstream)) => {
            if proxy::reply_success(&mut socket, &request.protocol)
                .await
                .is_err()
            {
                return;
            }
            if let Protocol::Forward(head) = &request.protocol {
                use tokio::io::AsyncWriteExt;
                if upstream.write_all(head).await.is_err() {
                    return;
                }
            }
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
        }
        Ok(Upstream::Desktop(mux, io)) => {
            if proxy::reply_success(&mut socket, &request.protocol)
                .await
                .is_err()
            {
                return;
            }
            if let Protocol::Forward(head) = request.protocol {
                // Prepend the rewritten request so the pump sends it first.
                let socket = PrefixedStream::new(head, socket);
                mux.pump(io, socket).await;
            } else {
                mux.pump(io, socket).await;
            }
        }
        Err(reason) => proxy::reply_failure(&mut socket, &request.protocol, &reason).await,
    }
}

/// The only port a provider route carries: its hosts are HTTPS APIs.
const PROVIDER_ROUTE_PORT: u16 = 443;

/// Connect without the SSRF screen, for the provider listener's off-route
/// traffic (see [`dial`]).
async fn connect_direct(host: &str, port: u16) -> Result<TcpStream, String> {
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((literal, port))).await {
        Ok(Ok(socket)) => {
            let _ = socket.set_nodelay(true);
            Ok(socket)
        }
        Ok(Err(_)) => Err(RefuseCode::Unreachable.describe().to_owned()),
        Err(_) => Err(RefuseCode::Timeout.describe().to_owned()),
    }
}

enum Upstream {
    Direct(TcpStream),
    Desktop(Arc<Mux>, super::mux::StreamIo),
}

/// Whether a connection on `kind` to `host` should take the desktop path, given
/// whether routing is active at all.
fn takes_desktop_path(kind: Listener, host: &str, active: bool) -> bool {
    active
        && match kind {
            Listener::General => true,
            Listener::Provider => providers::route_for_host(host).is_some(),
        }
}

async fn dial(host: &str, port: u16, kind: Listener) -> Result<Upstream, String> {
    if takes_desktop_path(kind, host, routing_active().await) {
        if kind == Listener::Provider && port != PROVIDER_ROUTE_PORT {
            return Err("provider routes carry HTTPS on port 443 only".to_owned());
        }
        let mux = entry()
            .attached
            .lock()
            .ok()
            .and_then(|attached| attached.as_ref().map(|attached| attached.mux.clone()))
            .ok_or_else(|| "the desktop route is offline; open Ryu on that computer or turn off \"Route traffic through this computer\"".to_owned())?;
        return match mux.open(host, port).await {
            Ok(io) => Ok(Upstream::Desktop(mux, io)),
            Err(OpenError::Refused(code)) => Err(code.describe().to_owned()),
            Err(OpenError::Timeout) => Err("the desktop did not answer in time".to_owned()),
            Err(OpenError::Busy) => Err("the desktop route is at its connection limit".to_owned()),
            Err(OpenError::Closed) => Err("the desktop route disconnected".to_owned()),
        };
    }
    match kind {
        Listener::General => super::connect_screened(host, port, CONNECT_TIMEOUT)
            .await
            .map(Upstream::Direct)
            .map_err(|code| code.describe().to_owned()),
        // Off the route the provider listener is a plain local proxy. Claude
        // Code hands its proxy variables to the tools it runs (git, package
        // managers), whose own destinations (a private registry, an internal
        // Git host) were reachable before the route existed and must stay so.
        // Only local processes holding the listener's credential reach here.
        Listener::Provider => connect_direct(host, port).await.map(Upstream::Direct),
    }
}

/// A socket whose reads first yield a fixed prefix (the rewritten HTTP head).
struct PrefixedStream {
    prefix: Vec<u8>,
    offset: usize,
    inner: TcpStream,
}

impl PrefixedStream {
    fn new(prefix: Vec<u8>, inner: TcpStream) -> Self {
        Self {
            prefix,
            offset: 0,
            inner,
        }
    }
}

impl tokio::io::AsyncRead for PrefixedStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.offset < self.prefix.len() {
            let remaining = &self.prefix[self.offset..];
            let take = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..take]);
            self.offset += take;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for PrefixedStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

async fn persist_routed(routed: bool) {
    entry().routed.store(routed, Ordering::Release);
    providers::publish_state();
    if let Some(preferences) = entry().preferences.get() {
        if let Err(error) = preferences
            .set(ROUTED_PREF_KEY, if routed { "true" } else { "false" })
            .await
        {
            tracing::warn!("local egress: could not persist route state: {error}");
        }
    }
}

/// Run one attached desktop session until it ends, is replaced, expires, or
/// the org disables the route.
pub(crate) async fn run_session(socket: WebSocket, desktop: String) {
    let state = entry();
    let (mux, mut outbound) = Mux::new(None);
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let superseded = Arc::new(Notify::new());
    let previous = state.attached.lock().ok().and_then(|mut attached| {
        attached.replace(Attached {
            generation,
            mux: mux.clone(),
            desktop: desktop.clone(),
            since_ms: chrono::Utc::now().timestamp_millis(),
            superseded: superseded.clone(),
        })
    });
    if let Some(previous) = previous {
        previous.mux.close();
        previous.superseded.notify_one();
    }
    persist_routed(true).await;
    tracing::info!("local egress: desktop \"{desktop}\" attached");

    let (mut sink, mut stream) = socket.split();
    let expiry = tokio::time::sleep(MAX_SESSION);
    tokio::pin!(expiry);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    let mut policy = tokio::time::interval(POLICY_RECHECK);
    loop {
        tokio::select! {
            frame = outbound.recv() => {
                let Some(frame) = frame else { break };
                if sink.send(Message::Binary(frame)).await.is_err() {
                    break;
                }
            }
            message = stream.next() => match message {
                Some(Ok(Message::Binary(frame))) => mux.receive(&frame),
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_))) => {}
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
            },
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            _ = policy.tick() => {
                if admin_policy().await == AdminPolicy::Disabled {
                    tracing::info!("local egress: route disabled by the organization");
                    break;
                }
            }
            () = &mut expiry => break,
            () = superseded.notified() => break,
        }
    }
    let _ = sink.close().await;
    mux.close();
    if let Ok(mut attached) = state.attached.lock() {
        if attached
            .as_ref()
            .is_some_and(|current| current.generation == generation)
        {
            *attached = None;
        }
    }
    tracing::info!("local egress: desktop \"{desktop}\" detached");
}

/// Stop routing through any desktop and return to the cloud path.
pub(crate) async fn detach() {
    let previous = entry()
        .attached
        .lock()
        .ok()
        .and_then(|mut attached| attached.take());
    if let Some(previous) = previous {
        previous.mux.close();
        previous.superseded.notify_one();
    }
    persist_routed(false).await;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryStatus {
    /// This node can route through a desktop at all.
    pub supported: bool,
    /// A desktop asked for routing and has not turned it off.
    pub routed: bool,
    /// The org allows routing (`false` when an admin disabled it).
    pub allowed: bool,
    pub connected: bool,
    pub desktop: Option<String>,
    pub connected_since_ms: Option<i64>,
    pub active_connections: usize,
}

pub(crate) async fn status() -> EntryStatus {
    let state = entry();
    let attached = state.attached.lock().ok().and_then(|attached| {
        attached.as_ref().map(|attached| {
            (
                attached.desktop.clone(),
                attached.since_ms,
                attached.mux.active_streams(),
            )
        })
    });
    EntryStatus {
        supported: entry_enabled() && state.endpoint.get().is_some(),
        routed: state.routed.load(Ordering::Acquire),
        allowed: admin_policy().await != AdminPolicy::Disabled,
        connected: attached.is_some(),
        desktop: attached.as_ref().map(|(desktop, _, _)| desktop.clone()),
        connected_since_ms: attached.as_ref().map(|(_, since, _)| *since),
        active_connections: attached.map(|(_, _, streams)| streams).unwrap_or(0),
    }
}

/// Proxy variables for a cloud task container while routing is active. `None`
/// means the task network is not routed (or not reachable), so callers must
/// decide whether to fail closed.
pub(crate) fn container_proxy_env() -> Option<Vec<(&'static str, String)>> {
    let endpoint = endpoint()?;
    let bridge = endpoint.bridge?;
    let Credential { username, password } = &endpoint.credential;
    let http = format!("http://{username}:{password}@{bridge}");
    let socks = format!("socks5h://{username}:{password}@{bridge}");
    let no_proxy = "localhost,127.0.0.1,::1".to_owned();
    Some(vec![
        ("HTTP_PROXY", http.clone()),
        ("HTTPS_PROXY", http.clone()),
        ("http_proxy", http.clone()),
        ("https_proxy", http),
        ("ALL_PROXY", socks.clone()),
        ("all_proxy", socks),
        ("NO_PROXY", no_proxy.clone()),
        ("no_proxy", no_proxy),
    ])
}

/// HTTP proxy URL for provider clients on this node (Core and the Gateway).
pub(crate) fn provider_proxy_url() -> Option<String> {
    let (address, Credential { username, password }) = endpoint()?.provider?;
    Some(format!("http://{username}:{password}@{address}"))
}

/// Gateway spawn environment: the provider proxy and the route state file. The
/// Gateway's Anthropic passthrough uses the proxy only while the state file
/// says the Claude route is active, so it follows the owner's choice without a
/// restart and keeps its direct path otherwise.
///
/// The state file is passed whenever this Core runs the entry side, even
/// without a provider listener: the file then names no proxy, and the Gateway
/// refuses Anthropic while the Claude route is active instead of going direct.
/// The file also carries the current listener, so a Gateway that outlives a
/// Core restart follows the new one; the proxy variable is only a fallback for
/// a file the Gateway cannot read.
pub(crate) fn gateway_proxy_env() -> Vec<(&'static str, String)> {
    if !entry_enabled() {
        return Vec::new();
    }
    let mut env = vec![(
        super::PROVIDER_STATE_ENV,
        providers::state_file().to_string_lossy().into_owned(),
    )];
    if let Some(url) = provider_proxy_url() {
        env.push((super::PROVIDER_PROXY_ENV, url));
    }
    env
}

/// SOCKS URL handed to the browser app on this node.
pub(crate) fn browser_proxy_url() -> Option<String> {
    let endpoint = endpoint()?;
    let Credential { username, password } = &endpoint.credential;
    Some(format!(
        "socks5://{username}:{password}@{}",
        endpoint.loopback
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_listener_only_routes_enabled_provider_hosts() {
        // With routing inactive nothing takes the desktop path.
        assert!(!takes_desktop_path(Listener::General, "example.com", false));
        assert!(!takes_desktop_path(
            Listener::Provider,
            "api.anthropic.com",
            false
        ));
        // General traffic follows the route for every destination.
        assert!(takes_desktop_path(Listener::General, "example.com", true));
        // Provider traffic to a host no enabled route claims stays direct.
        assert!(!takes_desktop_path(Listener::Provider, "example.com", true));
    }
}
