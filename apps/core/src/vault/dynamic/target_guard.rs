//! Connect-time egress screening for roles written by a delegate.
//!
//! A dynamic or static role names a target (a Postgres or Redis server, a
//! webhook, an STS endpoint) that Core connects to with its own network
//! position. Configuration managers (and the unbound local operator) may point
//! a role anywhere, including this host's loopback and LAN. A principal that
//! holds only `admin` on `sys/dynamic/<name>` or `sys/static/<name>` (a
//! delegate) must not borrow that position, so each role row records its
//! writer (`writer`: `manager` or `delegate`) and every connection a
//! delegate-written role makes (issue, renew, revoke, rotate, webhook call) is
//! screened when it is made:
//!
//! * the host must be one TCP host (no Unix sockets, `host=` or `hostaddr=`
//!   overrides) and must not be an internal name or literal;
//! * it is resolved once, every answer must be public (no loopback,
//!   link-local, RFC 1918, CGNAT, ULA, unspecified, multicast, or those
//!   embedded in IPv6), and the connection goes to exactly the screened
//!   address, so DNS rebinding cannot swap it;
//! * webhooks and STS endpoints must be `https`, never follow redirects, and
//!   never use an HTTP proxy.
//!
//! The writer is the role's, not the caller's: a machine token or member that
//! issues against a manager's role still reaches its target unscreened, and a
//! role written through a machine token is a delegate's (a token has policy
//! grants, never configuration-manager authority).
//!
//! The screen itself is the canonical one in [`ryu_egress`]. Re-writing a role
//! re-stamps its writer, so a delegate's edit of a manager's role makes it
//! screened. Rows written before the writer was recorded are screened only on a
//! node bound to an organization, team, or account (where delegation exists);
//! on an unbound node every writer was the local operator. The first time such
//! a row is used on a bound node it is stamped `delegate`, so unbinding the node
//! later does not trust it again; a manager's save restores it.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use ryu_egress::target::{self, TargetAuthority};

use super::static_roles::StaticProvider;
use super::ProviderConfig;

/// Column that records who wrote a role row.
pub const WRITER_COLUMN: &str = "writer";
/// Largest webhook or STS response read.
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How a role's target connections are made.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TargetEgress {
    /// Public targets only, resolved, screened, and pinned. The default, so a
    /// configuration that was never classified fails closed.
    #[default]
    Screened,
    /// The host's own network position (manager-written roles).
    Trusted,
}

impl TargetEgress {
    /// The egress for a stored writer label on this node.
    pub(crate) fn for_writer(label: Option<&str>) -> Self {
        Self::resolve(TargetAuthority::from_label(label), node_is_bound())
    }

    /// The egress for `authority` where delegation does (`multi_user`) or
    /// does not exist.
    pub(crate) fn resolve(authority: TargetAuthority, multi_user: bool) -> Self {
        if target::must_screen(authority, multi_user) {
            Self::Screened
        } else {
            Self::Trusted
        }
    }
}

/// Whether this node is bound to the control plane, where other principals
/// can be delegated role administration.
fn node_is_bound() -> bool {
    crate::sidecar::control_plane::registered_node().is_some()
}

/// Who is writing a role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleWriter {
    /// A configuration manager or the unbound local operator.
    Manager,
    /// A principal granted `admin` on this role only.
    Delegate,
}

impl RoleWriter {
    /// Classify the caller of a role write.
    pub fn from_manager(manager: bool) -> Self {
        if manager {
            Self::Manager
        } else {
            Self::Delegate
        }
    }

    /// The label stored in [`WRITER_COLUMN`].
    pub fn label(self) -> &'static str {
        self.authority().label().unwrap_or("delegate")
    }

    fn authority(self) -> TargetAuthority {
        match self {
            Self::Manager => TargetAuthority::Operator,
            Self::Delegate => TargetAuthority::Delegate,
        }
    }

    /// Whether this writer's targets are screened.
    pub(crate) fn egress(self) -> TargetEgress {
        TargetEgress::resolve(self.authority(), node_is_bound())
    }
}

/// Add the writer column to a role table created by an earlier release.
/// Existing rows keep `NULL` (unrecorded).
pub(crate) fn ensure_writer_column(conn: &rusqlite::Connection, table: &str) -> Result<()> {
    crate::vault::ensure_columns(conn, table, &[(WRITER_COLUMN, "TEXT")])
}

/// Whether re-stamping a role from `old` to `new` turns a trusted role into a
/// screened one (a delegate editing a manager's role).
pub(crate) fn screens_existing_role(old: Option<&str>, new: RoleWriter) -> bool {
    TargetEgress::for_writer(old) == TargetEgress::Trusted && new.egress() == TargetEgress::Screened
}

/// The egress for a role row read from `table`. An unrecorded row used on a
/// bound node is stamped `delegate` (see the module docs) before it connects.
pub(crate) fn row_egress(
    conn: &rusqlite::Connection,
    table: &str,
    name: &str,
    writer: Option<&str>,
) -> Result<TargetEgress> {
    let egress = TargetEgress::for_writer(writer);
    if writer.is_none() && egress == TargetEgress::Screened {
        conn.execute(
            &format!("UPDATE {table} SET {WRITER_COLUMN} = ?1 WHERE name = ?2 AND {WRITER_COLUMN} IS NULL"),
            rusqlite::params![RoleWriter::Delegate.label(), name],
        )?;
    }
    Ok(egress)
}

fn invalid(error: String) -> anyhow::Error {
    anyhow!("{error} (roles written by a delegated admin may only target public hosts)")
}

/// Write-time check of a URL target: no Unix-socket or `host`/`hostaddr`
/// overrides, and a public host literal. DNS is checked at connect time.
fn precheck_url(raw: &str, https_only: bool) -> Result<()> {
    let url = url::Url::parse(raw.trim()).map_err(|_| anyhow!("target is not a URL"))?;
    if https_only && url.scheme() != "https" {
        bail!("target must be https for a role written by a delegated admin");
    }
    if url
        .query_pairs()
        .any(|(key, _)| matches!(key.as_ref(), "host" | "hostaddr"))
    {
        return Err(invalid(
            "host and hostaddr overrides are not allowed".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default();
    target::screen_host_literal(host).map_err(invalid)
}

/// Write-time screen of a dynamic role's target for a delegate writer.
pub(crate) fn precheck_provider(config: &ProviderConfig) -> Result<()> {
    match config {
        ProviderConfig::Postgres(config) => precheck_url(&config.connection_url, false),
        ProviderConfig::Redis(config) => precheck_url(&config.connection_url, false),
        ProviderConfig::Webhook(config) => precheck_url(&config.url, true),
        ProviderConfig::AwsSts(config) => match &config.endpoint {
            Some(endpoint) => precheck_url(endpoint, true),
            None => Ok(()),
        },
        ProviderConfig::Random { .. } => Ok(()),
    }
}

/// Write-time screen of a static role's target for a delegate writer.
pub(crate) fn precheck_static(provider: &StaticProvider) -> Result<()> {
    match provider {
        StaticProvider::Postgres { connection_url, .. }
        | StaticProvider::Redis { connection_url, .. } => precheck_url(connection_url, false),
        StaticProvider::Webhook { url, .. } => precheck_url(url, true),
        // IAM calls go to the fixed AWS endpoint.
        StaticProvider::AwsIam { .. } => Ok(()),
    }
}

impl ProviderConfig {
    /// Attach the egress the role's writer earned. Never serialized.
    pub(crate) fn set_egress(&mut self, egress: TargetEgress) {
        match self {
            Self::Postgres(config) => config.egress = egress,
            Self::AwsSts(config) => config.egress = egress,
            Self::Webhook(config) => config.egress = egress,
            Self::Redis(config) => config.egress = egress,
            Self::Random { .. } => {}
        }
    }
}

/// Resolve and screen a host for a screened connection.
async fn screened_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    target::resolve_screened(host, port).await.map_err(invalid)
}

/// Open a TCP connection to `host:port`. A screened connection goes to the
/// screened, resolved address, never back through DNS.
pub(crate) async fn tcp_connect(
    host: &str,
    port: u16,
    egress: TargetEgress,
) -> Result<tokio::net::TcpStream> {
    let stream = match egress {
        TargetEgress::Trusted => tokio::net::TcpStream::connect((host, port)).await?,
        TargetEgress::Screened => {
            let addresses = screened_addresses(host, port).await?;
            tokio::net::TcpStream::connect(addresses.as_slice()).await?
        }
    };
    Ok(stream)
}

/// Pin a parsed Postgres configuration to one screened address. Unix sockets,
/// several hosts, and caller-supplied `hostaddr` are refused; the TLS server
/// name stays the configured host.
pub(crate) async fn pin_postgres(
    pg: &mut tokio_postgres::Config,
    egress: TargetEgress,
) -> Result<()> {
    if egress == TargetEgress::Trusted {
        return Ok(());
    }
    if !pg.get_hostaddrs().is_empty() {
        return Err(invalid("hostaddr overrides are not allowed".into()));
    }
    let [tokio_postgres::config::Host::Tcp(host)] = pg.get_hosts() else {
        return Err(invalid(
            "the connection must name exactly one TCP host (no Unix sockets or host lists)".into(),
        ));
    };
    let port = match pg.get_ports() {
        [] => 5432,
        [port] => *port,
        _ => return Err(invalid("the connection must name one port".into())),
    };
    let host = host.clone();
    let addresses = screened_addresses(&host, port).await?;
    pg.hostaddr(addresses[0].ip());
    Ok(())
}

/// POST `body` to `url` and return the status and response body. A screened
/// call is https-only, resolved, screened, pinned, sent without a proxy, never
/// follows a redirect, and reads at most 1 MiB, through [`ryu_egress`]. A
/// trusted call is unchanged from before writers were recorded.
pub(crate) async fn post(
    url: &str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    egress: TargetEgress,
) -> Result<(u16, Vec<u8>)> {
    if egress == TargetEgress::Screened {
        let policy = ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_RESPONSE_BYTES,
            max_redirect_hops: 0,
            timeout: REQUEST_TIMEOUT,
        };
        let request = ryu_egress::GuardedRequest {
            method: "POST".to_owned(),
            url: url.to_owned(),
            headers,
            body: Some(body),
        };
        let response = ryu_egress::guarded_request_direct(request, policy)
            .await
            .map_err(invalid)?;
        return Ok((response.status, response.body));
    }
    // A manager's role keeps today's client: the host's network, its proxy
    // settings, and reqwest's default redirect policy.
    let mut request = reqwest::Client::new()
        .post(url)
        .timeout(REQUEST_TIMEOUT)
        .body(body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.unwrap_or_default().to_vec();
    Ok((status, bytes))
}

#[cfg(test)]
#[path = "target_guard_test.rs"]
mod tests;
