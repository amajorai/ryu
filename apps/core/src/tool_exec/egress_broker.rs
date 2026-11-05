//! Per-invocation SSRF-screening forward proxy for URL-fetching command tools.
//!
//! A command tool that declares `egress_url_arg` (the `spider` crawler) is a
//! child process that fetches URLs itself. Screening only the URL argument in
//! Core is not enough: the child re-resolves DNS (rebinding), follows redirects,
//! and crawls links Core never saw. This broker closes that gap for children
//! that honour the standard `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` variables.
//!
//! For every connection the child opens through the broker:
//!
//! 1. the `Proxy-Authorization` credential must match the random per-invocation
//!    secret carried in the proxy URL's userinfo (`407` otherwise);
//! 2. the target authority is canonicalized with the WHATWG URL parser (IDNA,
//!    lowercase, numeric IPv4 forms such as `2130706433` → `127.0.0.1`);
//! 3. the port must be 80 or 443 unless the exact `host:port` is in
//!    `RYU_AGENT_EGRESS_ALLOW_HOSTS` (`403` otherwise);
//! 4. unless the agent egress guard is disabled or the `host:port` is
//!    allowlisted, internal hostnames are refused and the host is resolved once;
//!    if ANY resolved address is loopback / private / link-local / metadata /
//!    ULA / CGNAT (`ryu_egress::is_blocked_ip`) the connection is refused (`403`);
//! 5. the upstream socket is opened to exactly the resolved address, never to the
//!    hostname, so the address that was screened is the address connected to.
//!
//! The allowlist and guard semantics are Core's agent-egress ones
//! (`screen_agent_egress_url`): narrow `host:port` entries only, because the URLs
//! here are model-supplied.
//!
//! `CONNECT host:port` tunnels (HTTPS) and absolute-form plain HTTP requests are
//! supported. A forwarded plain HTTP request is rewritten to origin-form with
//! `Connection: close` and its proxy headers removed, so one upstream socket never
//! carries a second, unscreened request target.
//!
//! The broker binds `127.0.0.1:0`, caps concurrent connections, lives at most for
//! the tool timeout, and is torn down (listener and every tunnel) when its handle
//! is dropped after the child exits.
//!
//! Residual: this mediates a cooperating client. A binary that ignores the proxy
//! environment could still open sockets directly; only allowlisted, Core-trusted
//! command binaries reach this path, and the `spider` CLI (reqwest with system
//! proxy support, no `no_proxy()` override) honours the variables — verified for
//! `spider_cli` 2.53.9, the version the plugin's install instructions pin
//! (`plugins-store/plugins/spider/README.md`). Core enforces that version: an
//! `egress_url_arg` tool must declare `bin_version` (validated at manifest load
//! and again by the command runner), and the binary is probed against it before
//! spawn (`tool_exec::bin_version`). Moving the pin requires re-verifying proxy
//! environment support for the new release and updating `bin_version.requirement`,
//! the install hint, and the README together.

use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

#[path = "egress_broker_connection.rs"]
mod connection;

use self::connection::{handle_connection, read_head, write_status};

/// Default cap on concurrent proxied connections for one tool invocation.
pub(crate) const DEFAULT_MAX_CONNECTIONS: usize = 64;
/// Largest request head (request line + headers) the broker reads.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// How long a client may take to send its request head.
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// How long an upstream TCP connect may take.
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Username in the proxy URL; the password is the per-invocation secret.
const PROXY_USER: &str = "ryu";
/// Ports reachable without an explicit `host:port` allowlist entry.
const DEFAULT_ALLOWED_PORTS: [u16; 2] = [80, 443];

pub(crate) type ResolveFuture = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send>>;
pub(crate) type ConnectFuture = Pin<Box<dyn Future<Output = io::Result<TcpStream>> + Send>>;
type Resolver = dyn Fn(String, u16) -> ResolveFuture + Send + Sync;
type Connector = dyn Fn(SocketAddr) -> ConnectFuture + Send + Sync;

/// The network seam: DNS resolution and the upstream TCP connect. Production uses
/// the system resolver and a plain connect; tests inject both.
#[derive(Clone)]
pub(crate) struct BrokerNet {
    resolve: Arc<Resolver>,
    connect: Arc<Connector>,
}

impl BrokerNet {
    pub(crate) fn system() -> Self {
        Self {
            resolve: Arc::new(|host, port| {
                Box::pin(async move {
                    Ok(tokio::net::lookup_host((host.as_str(), port))
                        .await?
                        .collect())
                })
            }),
            connect: Arc::new(|addr| Box::pin(TcpStream::connect(addr))),
        }
    }

    #[cfg(test)]
    pub(crate) fn custom(
        resolve: impl Fn(String, u16) -> ResolveFuture + Send + Sync + 'static,
        connect: impl Fn(SocketAddr) -> ConnectFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            resolve: Arc::new(resolve),
            connect: Arc::new(connect),
        }
    }
}

/// The screening decision inputs, snapshotted once per invocation.
#[derive(Clone, Debug)]
pub(crate) struct BrokerPolicy {
    /// `RYU_AGENT_EGRESS_SSRF_GUARD` (on unless explicitly disabled).
    pub(crate) guard_enabled: bool,
    /// `RYU_AGENT_EGRESS_ALLOW_HOSTS` (narrow `host:port` entries only).
    pub(crate) allow_hosts: Option<String>,
    pub(crate) max_connections: usize,
    /// Hard lifetime; the listener and every tunnel stop after this.
    pub(crate) lifetime: Duration,
}

impl BrokerPolicy {
    pub(crate) fn from_env(lifetime: Duration) -> Self {
        Self {
            guard_enabled: crate::server::agent_egress_guard_enabled(),
            allow_hosts: crate::server::agent_egress_allow_hosts(),
            max_connections: DEFAULT_MAX_CONNECTIONS,
            lifetime,
        }
    }

    fn is_allowlisted(&self, host: &str, port: u16) -> bool {
        crate::server::host_is_allowlisted_in_with_mode(
            host,
            port,
            self.allow_hosts.as_deref(),
            false,
        )
    }

    /// The port rule shared by the pre-spawn URL screen and every proxied
    /// connection: 80/443, or an exact `host:port` allowlist entry.
    pub(crate) fn check_port(&self, host: &str, port: u16) -> Result<(), String> {
        if DEFAULT_ALLOWED_PORTS.contains(&port) || self.is_allowlisted(host, port) {
            return Ok(());
        }
        Err(format!(
            "port {port} is not allowed for {host}; only 80 and 443 are reachable unless \
             `{host}:{port}` is listed in RYU_AGENT_EGRESS_ALLOW_HOSTS"
        ))
    }
}

/// Why a proxied connection was refused, mapped to an HTTP status.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    BadRequest(String),
    Forbidden(String),
    BadGateway(String),
}

/// A canonical, screened upstream: the authority to present and the exact
/// addresses that may be connected to.
#[derive(Debug)]
struct ScreenedTarget {
    host: String,
    port: u16,
    addresses: Vec<SocketAddr>,
}

/// Canonicalize `host` (already split from its port) with the WHATWG URL parser.
fn canonical_host(host: &str, port: u16) -> Result<String, Refusal> {
    if host.is_empty()
        || host.chars().any(|c| {
            c.is_control() || c.is_whitespace() || matches!(c, '@' | '/' | '?' | '#' | '\\')
        })
    {
        return Err(Refusal::BadRequest("invalid target host".to_owned()));
    }
    let parsed = url::Url::parse(&format!("http://{host}:{port}/"))
        .map_err(|e| Refusal::BadRequest(format!("invalid target host: {e}")))?;
    parsed
        .host_str()
        .map(str::to_owned)
        .ok_or_else(|| Refusal::BadRequest("target has no host".to_owned()))
}

/// Split a CONNECT authority (`host:port` or `[v6]:port`); the port is required.
fn split_authority(authority: &str) -> Result<(&str, u16), Refusal> {
    let bad = || Refusal::BadRequest(format!("invalid CONNECT authority '{authority}'"));
    let colon = authority.rfind(':').ok_or_else(bad)?;
    let (host, port) = (&authority[..colon], &authority[colon + 1..]);
    if host.starts_with('[') != host.ends_with(']')
        || (!host.starts_with('[') && host.contains(':'))
    {
        return Err(bad());
    }
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let port: u16 = port.parse().map_err(|_| bad())?;
    if port == 0 {
        return Err(bad());
    }
    Ok((host, port))
}

/// The full per-connection screen. Pure apart from the injected resolver.
async fn screen_target(
    raw_host: &str,
    port: u16,
    policy: &BrokerPolicy,
    net: &BrokerNet,
) -> Result<ScreenedTarget, Refusal> {
    let host = canonical_host(raw_host, port)?;
    policy.check_port(&host, port).map_err(Refusal::Forbidden)?;
    let exempt = !policy.guard_enabled || policy.is_allowlisted(&host, port);
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    let literal = unbracketed.parse::<IpAddr>().ok();
    if !exempt && literal.is_none() && ryu_egress::is_blocked_hostname(&host) {
        return Err(Refusal::Forbidden(format!(
            "blocked egress to {host}:{port}: internal host is not allowed"
        )));
    }
    let addresses = match literal {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => (net.resolve)(host.clone(), port)
            .await
            .map_err(|e| Refusal::BadGateway(format!("failed to resolve {host}: {e}")))?,
    };
    if addresses.is_empty() {
        return Err(Refusal::BadGateway(format!("{host} did not resolve")));
    }
    if !exempt
        && addresses
            .iter()
            .any(|addr| ryu_egress::is_blocked_ip(addr.ip()))
    {
        return Err(Refusal::Forbidden(format!(
            "blocked egress to {host}:{port}: private/loopback address is not allowed. If this \
             is an intentional local or internal target, add `{host}:{port}` to \
             RYU_AGENT_EGRESS_ALLOW_HOSTS"
        )));
    }
    Ok(ScreenedTarget {
        host,
        port,
        addresses,
    })
}

/// Connect to one of the screened addresses (pinned: never the hostname).
async fn connect_pinned(target: &ScreenedTarget, net: &BrokerNet) -> Result<TcpStream, Refusal> {
    let mut last_error = None;
    for addr in &target.addresses {
        match tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, (net.connect)(*addr)).await {
            Ok(Ok(stream)) => {
                // Nagle + delayed ACK would stall each small relayed write ~40 ms.
                if let Err(error) = stream.set_nodelay(true) {
                    tracing::debug!("egress broker could not set upstream TCP_NODELAY: {error}");
                }
                return Ok(stream);
            }
            Ok(Err(e)) => last_error = Some(e.to_string()),
            Err(_) => last_error = Some("connect timed out".to_owned()),
        }
    }
    Err(Refusal::BadGateway(format!(
        "failed to connect to {}:{}: {}",
        target.host,
        target.port,
        last_error.unwrap_or_else(|| "no address".to_owned())
    )))
}

/// A running broker. Dropping it stops the listener and every open tunnel.
pub(crate) struct EgressBroker {
    addr: SocketAddr,
    secret: String,
    task: JoinHandle<()>,
}

impl EgressBroker {
    /// Bind `127.0.0.1:0` with the system resolver/connector.
    pub(crate) async fn start(policy: BrokerPolicy) -> io::Result<Self> {
        Self::start_with(policy, BrokerNet::system()).await
    }

    pub(crate) async fn start_with(policy: BrokerPolicy, net: BrokerNet) -> io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let addr = listener.local_addr()?;
        let secret = random_secret();
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{PROXY_USER}:{secret}"))
        );
        let task = tokio::spawn(accept_loop(listener, Arc::new(policy), net, expected));
        Ok(Self { addr, secret, task })
    }

    /// `http://ryu:<secret>@127.0.0.1:<port>` — the value for the proxy env vars.
    pub(crate) fn proxy_url(&self) -> String {
        format!("http://{PROXY_USER}:{}@{}", self.secret, self.addr)
    }

    #[cfg(test)]
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    #[cfg(test)]
    pub(crate) fn credential(&self) -> String {
        format!("{PROXY_USER}:{}", self.secret)
    }

    /// Install the proxy variables into a child environment. `NO_PROXY` is
    /// removed so nothing is exempted, and `REQUEST_METHOD` is removed because
    /// hyper-util's env matcher ignores `HTTP_PROXY` under CGI.
    pub(crate) fn apply_to_env(&self, env: &mut std::collections::BTreeMap<String, String>) {
        let url = self.proxy_url();
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            env.insert(key.to_owned(), url.clone());
        }
        for key in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
            env.remove(key);
        }
    }
}

impl Drop for EgressBroker {
    fn drop(&mut self) {
        // Aborting the accept loop drops its JoinSet, which aborts every tunnel.
        self.task.abort();
    }
}

fn random_secret() -> String {
    use rand::RngCore as _;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn accept_loop(
    listener: TcpListener,
    policy: Arc<BrokerPolicy>,
    net: BrokerNet,
    expected_auth: String,
) {
    let permits = Arc::new(tokio::sync::Semaphore::new(policy.max_connections.max(1)));
    let expected_auth = Arc::new(expected_auth);
    let mut connections = JoinSet::new();
    let deadline = tokio::time::sleep(policy.lifetime);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => {
                let Ok((mut stream, _)) = accepted else { continue };
                // Nagle + delayed ACK would stall each small relayed write ~40 ms.
                if let Err(error) = stream.set_nodelay(true) {
                    tracing::debug!("egress broker could not set TCP_NODELAY: {error}");
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    connections.spawn(async move {
                        // Drain the head first: closing with unread input would
                        // reset the socket before the client reads the 503.
                        let _ = read_head(&mut stream).await;
                        let _ = write_status(&mut stream, 503, "Service Unavailable", "too many concurrent connections").await;
                    });
                    continue;
                };
                let policy = policy.clone();
                let net = net.clone();
                let expected_auth = expected_auth.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    handle_connection(stream, &policy, &net, &expected_auth).await;
                });
            }
        }
    }
    connections.abort_all();
}

#[cfg(test)]
#[path = "tests/egress_broker_test.rs"]
mod tests;
