//! Credential broker: an egress proxy that injects vault credentials so agents
//! never hold the real secrets (Infisical agent-vault parity).
//!
//! An agent process is started with `HTTPS_PROXY`/`HTTP_PROXY` pointing at a
//! loopback listener and a short-lived `rvb_` broker session in the proxy URL.
//! For each request the broker matches the target against the environment's
//! **services** ([`services`]), resolves the service's `secret:` references
//! through the vault resolver with the `use` capability (never `read`), injects
//! them as auth headers or in place of `__PLACEHOLDER__` tokens
//! ([`substitute`]), and forwards the request upstream with normal certificate
//! verification. HTTPS is intercepted with leaves minted by a local CA whose
//! key is sealed by the vault keyring ([`ca`]).
//!
//! * [`services`]: service records and the host/port/path matcher;
//! * [`oauth`]: services that inject a connected MCP OAuth access token;
//! * [`substitute`]: placeholder grammar and per-surface substitution;
//! * [`ca`]: the sealed broker CA and the per-host leaf cache;
//! * [`sessions`]: `rvb_` sessions bound to an environment and services;
//! * [`settings`]: per-environment unmatched-host policy and agent skills;
//! * [`netguard`]: dial-time SSRF guard over every resolved address;
//! * [`ratelimit`]: per-session token buckets;
//! * [`log`]: the value-free request log and discovered hosts;
//! * [`proposals`]: agent-raised requests for new services and credentials;
//! * [`proposal_notify`]: inbox, desktop, and push notices for pending proposals;
//! * [`catalog`]: built-in service templates;
//! * [`proxy`]: the listener (CONNECT and absolute-form);
//! * [`runtime`]: sessions Core mints for the agent runtimes it spawns;
//! * [`box_relay`]: per-Box sessions relayed into cloud-task Boxes.
//!
//! Authorization uses `sys/broker/<service>` (`use` to broker through a
//! service, `admin` to manage it) and `sys/broker` (`admin` for environment
//! settings, sessions, and proposals; `list` for the request log).

pub mod box_relay;
pub mod ca;
pub mod catalog;
pub mod command_tools;
pub mod log;
pub mod netguard;
pub mod oauth;
pub mod proposal_notify;
pub mod proposals;
pub mod proxy;
pub mod ratelimit;
pub mod runtime;
pub mod services;
pub mod session_identity;
pub mod sessions;
pub mod settings;
pub mod substitute;

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;
use rusqlite::Connection;

use crate::plugin_secrets::PluginSecretStore;

/// Loopback port for the broker listener. Unset binds an ephemeral loopback
/// port; `0`, `off`, `false`, or `disabled` turns the listener off.
pub const ENV_PORT: &str = "RYU_VAULT_BROKER_PORT";
/// `1`/`true` lets the broker dial private and loopback addresses (cloud
/// metadata stays blocked).
pub const ENV_ALLOW_PRIVATE: &str = "RYU_VAULT_BROKER_ALLOW_PRIVATE";
/// Comma-separated CIDRs the broker may dial despite the private-range block.
pub const ENV_NETWORK_ALLOWLIST: &str = "RYU_VAULT_BROKER_NETWORK_ALLOWLIST";
/// Requests per second per session (default 20).
pub const ENV_RPS: &str = "RYU_VAULT_BROKER_RPS";
/// Token-bucket burst per session (default 200).
pub const ENV_BURST: &str = "RYU_VAULT_BROKER_BURST";
/// Largest request body the broker buffers (default 10 MiB); larger is 413.
pub const ENV_MAX_REQUEST_BYTES: &str = "RYU_VAULT_BROKER_MAX_REQUEST_BYTES";
/// Request-log retention in hours (default 168).
pub const ENV_LOG_MAX_AGE_HOURS: &str = "RYU_VAULT_BROKER_LOG_MAX_AGE_HOURS";
/// Request-log row cap (default 10 000).
pub const ENV_LOG_MAX_ROWS: &str = "RYU_VAULT_BROKER_LOG_MAX_ROWS";

/// Policy key for environment settings, sessions, proposals, and logs.
pub const SYS_BROKER: &str = "sys/broker";

const DEFAULT_RPS: f64 = 20.0;
const DEFAULT_BURST: f64 = 200.0;
const DEFAULT_MAX_REQUEST_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_MAX_TUNNELS_PER_SESSION: usize = 32;
const DEFAULT_SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const DEFAULT_LOG_MAX_AGE_HOURS: i64 = 168;
const DEFAULT_LOG_MAX_ROWS: i64 = 10_000;
const MAINTENANCE_TICK: Duration = Duration::from_secs(60);

/// Policy key for one service: `sys/broker/<service>`.
pub fn service_key(name: &str) -> String {
    format!("{SYS_BROKER}/{name}")
}

/// Create every broker table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    services::init_schema(conn)?;
    sessions::init_schema(conn)?;
    settings::init_schema(conn)?;
    log::init_schema(conn)?;
    proposals::init_schema(conn)?;
    ca::init_schema(conn)
}

/// Listener and enforcement configuration.
#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// Loopback port; `0` binds an ephemeral port (tests).
    pub port: u16,
    pub guard: netguard::NetGuard,
    pub rps: f64,
    pub burst: f64,
    pub max_request_bytes: usize,
    /// Concurrent CONNECT tunnels (intercepted or raw) per session.
    pub max_tunnels_per_session: usize,
    /// How often an open tunnel re-checks that its session is still live
    /// (unrevoked, unexpired, and its minting token live); a dead session
    /// closes the tunnel.
    pub session_check_interval: Duration,
    /// Extra PEM roots trusted for upstream TLS, in addition to the system
    /// roots. Only tests set this (a local fake upstream).
    pub(crate) extra_upstream_roots_pem: Vec<String>,
}

fn env_parse<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok()?.trim().parse().ok()
}

impl BrokerConfig {
    /// Configuration from the environment; `None` when the listener is
    /// disabled (no port configured).
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var(ENV_PORT).ok();
        let port = listener_port(raw.as_deref());
        if port.is_none() {
            tracing::info!("vault credential broker listener is off ({ENV_PORT})");
        }
        Some(Self {
            port: port?,
            guard: netguard::NetGuard::from_env(),
            ..Self::defaults()
        })
    }

    /// Defaults with an ephemeral port and the strict network guard.
    pub fn defaults() -> Self {
        Self {
            port: 0,
            guard: netguard::NetGuard::default(),
            rps: env_parse(ENV_RPS)
                .filter(|v: &f64| *v > 0.0)
                .unwrap_or(DEFAULT_RPS),
            burst: env_parse(ENV_BURST)
                .filter(|v: &f64| *v >= 1.0)
                .unwrap_or(DEFAULT_BURST),
            max_request_bytes: env_parse(ENV_MAX_REQUEST_BYTES)
                .filter(|v: &usize| *v > 0)
                .unwrap_or(DEFAULT_MAX_REQUEST_BYTES),
            max_tunnels_per_session: DEFAULT_MAX_TUNNELS_PER_SESSION,
            session_check_interval: DEFAULT_SESSION_CHECK_INTERVAL,
            extra_upstream_roots_pem: Vec::new(),
        }
    }
}

/// The listener port [`ENV_PORT`] selects: unset or blank binds an ephemeral
/// loopback port (`Some(0)`), a port number binds that port, and `0`, `off`,
/// `false`, `disabled`, or anything unparsable turns the listener off
/// (`None`), so a mistyped value never opens an unexpected port.
pub fn listener_port(raw: Option<&str>) -> Option<u16> {
    let value = raw.map(str::trim).unwrap_or_default();
    if value.is_empty() {
        return Some(0);
    }
    match value.parse::<u16>() {
        Ok(0) | Err(_) => None,
        Ok(port) => Some(port),
    }
}

static LISTENING_PORT: OnceLock<u16> = OnceLock::new();
static SERVING: OnceLock<std::sync::Arc<proxy::Broker>> = OnceLock::new();

/// The port the process-wide broker listens on, once it is up.
pub fn listening_port() -> Option<u16> {
    LISTENING_PORT.get().copied()
}

/// The process-wide broker, once its listener is up ([`box_relay`] serves
/// relayed Box connections with it).
pub fn serving() -> Option<std::sync::Arc<proxy::Broker>> {
    SERVING.get().cloned()
}

/// Start broker maintenance, the proposal notifier, and, unless [`ENV_PORT`]
/// turns it off, the loopback listener.
pub fn spawn(store: &'static PluginSecretStore) {
    proposal_notify::spawn(store);
    tokio::spawn(async move {
        loop {
            maintain(store).await;
            tokio::time::sleep(MAINTENANCE_TICK).await;
        }
    });
    let Some(config) = BrokerConfig::from_env() else {
        return;
    };
    tokio::spawn(async move {
        match proxy::Broker::bind(store, config).await {
            Ok((broker, listener)) => {
                let _ = LISTENING_PORT.set(broker.port());
                let _ = SERVING.set(broker.clone());
                tracing::info!(port = broker.port(), "vault credential broker listening");
                broker.serve(listener).await;
            }
            Err(error) => tracing::warn!("vault credential broker failed to start: {error:#}"),
        }
    });
}

/// Prune expired sessions, proposals, password-manager grants, and card
/// approvals, and apply request-log retention.
pub async fn maintain(store: &PluginSecretStore) {
    let now = super::now_millis();
    let max_age_hours = env_parse(ENV_LOG_MAX_AGE_HOURS).unwrap_or(DEFAULT_LOG_MAX_AGE_HOURS);
    let max_rows = env_parse(ENV_LOG_MAX_ROWS).unwrap_or(DEFAULT_LOG_MAX_ROWS);
    let conn = store.conn.lock().await;
    if let Err(error) = sessions::prune(&conn, now) {
        tracing::warn!("pruning broker sessions failed: {error:#}");
    }
    if let Err(error) = proposals::expire(&conn, now) {
        tracing::warn!("expiring broker proposals failed: {error:#}");
    }
    if let Err(error) = log::prune(&conn, now, max_age_hours, max_rows) {
        tracing::warn!("pruning broker log failed: {error:#}");
    }
    if let Err(error) = crate::vault::items::cards::expire(&conn, now) {
        tracing::warn!("expiring card approvals failed: {error:#}");
    }
    if let Err(error) = crate::vault::password_managers::prune(&conn, now) {
        tracing::warn!("pruning password-manager grants failed: {error:#}");
    }
}

/// The node id runtime resolution uses for node-scoped credentials.
pub(crate) fn local_node_id() -> String {
    crate::sidecar::control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

/// Environment for a child process that should egress through the broker:
/// proxy variables carrying the session token, `NO_PROXY` for loopback, and
/// the CA variables common runtimes read. `NODE_EXTRA_CA_CERTS` adds to
/// Node's trust store, so it gets the broker CA alone; `SSL_CERT_FILE`
/// (OpenSSL), `REQUESTS_CA_BUNDLE` (Python requests), `CURL_CA_BUNDLE`, and
/// `GIT_SSL_CAINFO` replace the default store, so they get the combined OS
/// plus broker bundle and raw-tunneled (`passthrough`) hosts still verify.
/// `NODE_USE_ENV_PROXY=1` makes Node's built-in `fetch` honor the proxy
/// variables, and `DENO_CERT` adds the broker CA to Deno's trust store, so
/// neither runtime bypasses the broker.
pub fn proxy_env(token: &str, port: u16, ca: &ca::CaFiles) -> BTreeMap<String, String> {
    let proxy = format!("http://rvb:{token}@127.0.0.1:{port}");
    let mut env = BTreeMap::new();
    for name in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
        env.insert(name.to_owned(), proxy.clone());
    }
    for name in ["NO_PROXY", "no_proxy"] {
        env.insert(name.to_owned(), "localhost,127.0.0.1,::1".to_owned());
    }
    env.insert("NODE_USE_ENV_PROXY".to_owned(), "1".to_owned());
    for name in ["NODE_EXTRA_CA_CERTS", "DENO_CERT"] {
        env.insert(name.to_owned(), ca.ca_only.display().to_string());
    }
    for name in [
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
    ] {
        env.insert(name.to_owned(), ca.combined.display().to_string());
    }
    env
}

/// Test helper: an AppRole machine identity holding `policies`, logged in.
#[cfg(test)]
pub(crate) async fn test_machine_token(
    store: &PluginSecretStore,
    name: &str,
    policies: Vec<String>,
) -> crate::vault::machine::IssuedToken {
    use crate::vault::machine::AuthMethod;
    let actor = crate::vault::audit::AuditActor::system();
    let identity = store
        .machine_create(
            name,
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            policies,
            None,
            &actor,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = &identity.auth else {
        unreachable!("created as AppRole");
    };
    let (secret_id, _) = store
        .machine_issue_secret_id(&identity.id, None, None, &actor)
        .await
        .unwrap();
    store.approle_login(role_id, &secret_id).await.unwrap()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn proxy_env_points_every_runtime_at_the_broker() {
        let files = ca::CaFiles {
            ca_only: Path::new("/tmp/ca.pem").to_path_buf(),
            combined: Path::new("/tmp/ca-bundle.pem").to_path_buf(),
        };
        let env = proxy_env("rvb_abc", 8123, &files);
        assert_eq!(env["HTTPS_PROXY"], "http://rvb:rvb_abc@127.0.0.1:8123");
        assert_eq!(env["http_proxy"], env["HTTPS_PROXY"]);
        assert_eq!(env["NO_PROXY"], "localhost,127.0.0.1,::1");
        // Additive: the broker CA alone.
        assert_eq!(env["NODE_EXTRA_CA_CERTS"], "/tmp/ca.pem");
        assert_eq!(env["DENO_CERT"], "/tmp/ca.pem");
        // Node's built-in fetch ignores the proxy variables without this.
        assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
        // Replacing: the OS store plus the broker CA.
        for name in [
            "SSL_CERT_FILE",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "GIT_SSL_CAINFO",
        ] {
            assert_eq!(env[name], "/tmp/ca-bundle.pem", "{name}");
        }
    }

    #[test]
    fn the_listener_is_on_by_default_and_off_only_when_asked() {
        // Unset or blank: an ephemeral loopback port.
        assert_eq!(listener_port(None), Some(0));
        assert_eq!(listener_port(Some("  ")), Some(0));
        assert_eq!(listener_port(Some("8123")), Some(8123));
        assert_eq!(listener_port(Some(" 8123 ")), Some(8123));
        // Explicit opt-outs, and fail closed on anything unparsable.
        for off in ["0", "off", "false", "disabled", "70000", "-1", "yes"] {
            assert_eq!(listener_port(Some(off)), None, "{off}");
        }
    }

    #[test]
    fn service_keys_live_under_sys_broker() {
        assert_eq!(service_key("openai"), "sys/broker/openai");
    }

    #[tokio::test]
    async fn maintenance_runs_on_a_fresh_store() {
        let store = PluginSecretStore::in_memory().unwrap();
        maintain(&store).await;
    }
}
