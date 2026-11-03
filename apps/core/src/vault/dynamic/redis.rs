//! Redis and Valkey dynamic credentials (ACL users).
//!
//! Issue runs `ACL SETUSER <name> reset on ><password> <rules…>` with the
//! role's ACL rules (default `~* +@read`); revoke runs `ACL DELUSER`. Redis
//! has no per-user expiry, so renewal is lease bookkeeping only and the
//! reaper deletes the user at lease expiry. Static roles rotate an existing
//! user with `ACL SETUSER <name> resetpass ><password>`, which keeps its rules.
//!
//! The client speaks RESP directly over TCP (`redis://`, `valkey://`) or TLS
//! (`rediss://`, `valkeys://`, platform trust store), so Core needs no Redis
//! client crate. The connection URL's userinfo authenticates the admin
//! connection (`AUTH [user] password`).

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::target_guard::{self, TargetEgress};
use super::{random_suffix, Issued};

const DEFAULT_RULES: &[&str] = &["~*", "+@read"];
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BULK_BYTES: i64 = 1 << 20;
const MAX_ARRAY_LEN: i64 = 4096;

/// Redis/Valkey provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConfig {
    /// `redis://admin:password@host:6379` (`rediss://` for TLS; `valkey://`
    /// and `valkeys://` are accepted spellings).
    pub connection_url: String,
    /// ACL rules granted to each issued user, e.g. `["~app:*", "+@read",
    /// "+@write"]`. Password and on/off rules are managed by Core.
    #[serde(default)]
    pub acl_rules: Vec<String>,
    /// Username prefix (default `ryu`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

fn url_tls(url: &url::Url) -> Result<bool> {
    match url.scheme() {
        "redis" | "valkey" => Ok(false),
        "rediss" | "valkeys" => Ok(true),
        _ => bail!("connectionUrl must be a redis://, rediss://, valkey://, or valkeys:// URL"),
    }
}

/// Validate a username Core sends inside an ACL command.
pub(crate) fn validate_username(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@' | b':'))
    {
        bail!("username must be 1-128 letters, digits, or _ - . @ :");
    }
    if name.eq_ignore_ascii_case("default") {
        bail!("the default user cannot be managed");
    }
    Ok(())
}

impl RedisConfig {
    pub(super) fn validate(&self) -> Result<()> {
        validate_connection_url(&self.connection_url)?;
        for rule in &self.acl_rules {
            validate_rule(rule)?;
        }
        if let Some(prefix) = &self.username_prefix {
            if prefix.is_empty()
                || prefix.len() > 16
                || !prefix
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            {
                bail!("usernamePrefix must be 1-16 lowercase letters, digits, or underscores");
            }
        }
        Ok(())
    }

    /// `host:port` without credentials.
    pub(super) fn redacted_target(&self) -> String {
        redacted_target(&self.connection_url)
    }

    fn rules(&self) -> Vec<String> {
        if self.acl_rules.is_empty() {
            DEFAULT_RULES
                .iter()
                .map(|rule| (*rule).to_owned())
                .collect()
        } else {
            self.acl_rules.clone()
        }
    }
}

pub(crate) fn validate_connection_url(connection_url: &str) -> Result<()> {
    let url = url::Url::parse(connection_url).context("connectionUrl is not a URL")?;
    url_tls(&url)?;
    if url.host_str().is_none() {
        bail!("connectionUrl needs a host");
    }
    Ok(())
}

pub(crate) fn redacted_target(connection_url: &str) -> String {
    url::Url::parse(connection_url)
        .map(|url| {
            format!(
                "{}:{}",
                url.host_str().unwrap_or("?"),
                url.port().unwrap_or(6379)
            )
        })
        .unwrap_or_else(|_| "invalid".to_owned())
}

/// ACL rules must not touch passwords, the user's on/off state, or reset it:
/// those belong to Core.
fn validate_rule(rule: &str) -> Result<()> {
    let lower = rule.to_ascii_lowercase();
    if rule.is_empty()
        || rule.len() > 256
        || rule
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        bail!("ACL rules must be single non-empty tokens");
    }
    if rule.starts_with(['>', '<', '#', '!'])
        || matches!(
            lower.as_str(),
            "on" | "off" | "nopass" | "resetpass" | "reset"
        )
    {
        bail!("ACL rule `{rule}` manages passwords or user state, which Core owns");
    }
    Ok(())
}

/// One RESP reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reply {
    Simple(String),
    Error(String),
    Integer(i64),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<Reply>>),
}

/// Encode a command as a RESP array of bulk strings.
pub(crate) fn encode_command(args: &[&str]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(arg.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out
}

async fn read_line<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<String> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await?;
    if read == 0 {
        bail!("redis closed the connection");
    }
    if !line.ends_with("\r\n") {
        bail!("malformed redis reply");
    }
    line.truncate(line.len() - 2);
    Ok(line)
}

fn read_reply<'a, R: AsyncRead + Unpin + Send>(
    reader: &'a mut BufReader<R>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Reply>> + Send + 'a>> {
    Box::pin(async move {
        let line = read_line(reader).await?;
        let (kind, rest) = line.split_at(1.min(line.len()));
        match kind {
            "+" => Ok(Reply::Simple(rest.to_owned())),
            "-" => Ok(Reply::Error(rest.to_owned())),
            ":" => Ok(Reply::Integer(rest.parse().context("bad redis integer")?)),
            "$" => {
                let len: i64 = rest.parse().context("bad redis bulk length")?;
                if len < 0 {
                    return Ok(Reply::Bulk(None));
                }
                if len > MAX_BULK_BYTES {
                    bail!("redis bulk reply is too large");
                }
                let mut buf = vec![0u8; len as usize + 2];
                reader.read_exact(&mut buf).await?;
                buf.truncate(len as usize);
                Ok(Reply::Bulk(Some(buf)))
            }
            "*" => {
                let len: i64 = rest.parse().context("bad redis array length")?;
                if len < 0 {
                    return Ok(Reply::Array(None));
                }
                if len > MAX_ARRAY_LEN {
                    bail!("redis array reply is too large");
                }
                let mut items = Vec::with_capacity(len as usize);
                for _ in 0..len {
                    items.push(read_reply(reader).await?);
                }
                Ok(Reply::Array(Some(items)))
            }
            _ => bail!("unknown redis reply type"),
        }
    })
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// A minimal authenticated RESP connection.
pub(crate) struct Connection {
    stream: BufReader<Box<dyn Stream>>,
}

impl Connection {
    /// Connect and authenticate from `connection_url`; a screened connection
    /// goes only to the screened, resolved address.
    pub(crate) async fn open(connection_url: &str, egress: TargetEgress) -> Result<Self> {
        let url = url::Url::parse(connection_url).context("parsing connectionUrl")?;
        let tls = url_tls(&url)?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("connectionUrl needs a host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url.port().unwrap_or(6379);
        let tcp = tokio::time::timeout(IO_TIMEOUT, target_guard::tcp_connect(&host, port, egress))
            .await
            .map_err(|_| anyhow!("timed out connecting to redis"))?
            .context("connecting to redis")?;
        let stream: Box<dyn Stream> = if tls {
            let connector = native_tls::TlsConnector::new().context("building TLS connector")?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            Box::new(
                tokio::time::timeout(IO_TIMEOUT, connector.connect(&host, tcp))
                    .await
                    .map_err(|_| anyhow!("timed out negotiating TLS with redis"))?
                    .context("negotiating TLS with redis")?,
            )
        } else {
            Box::new(tcp)
        };
        let mut connection = Self {
            stream: BufReader::new(stream),
        };
        let password = url
            .password()
            .map(|value| urlencoding::decode(value).map(|v| v.into_owned()))
            .transpose()
            .context("decoding connectionUrl password")?;
        if let Some(password) = password {
            let username = urlencoding::decode(url.username())
                .context("decoding connectionUrl username")?
                .into_owned();
            if username.is_empty() {
                connection.ok(&["AUTH", &password]).await?;
            } else {
                connection.ok(&["AUTH", &username, &password]).await?;
            }
        }
        if let Some(db) = url.path().trim_start_matches('/').split('/').next() {
            if !db.is_empty() {
                let db: u32 = db
                    .parse()
                    .context("connectionUrl database must be a number")?;
                connection.ok(&["SELECT", &db.to_string()]).await?;
            }
        }
        Ok(connection)
    }

    /// Send one command and read its reply.
    pub(crate) async fn command(&mut self, args: &[&str]) -> Result<Reply> {
        let encoded = encode_command(args);
        tokio::time::timeout(IO_TIMEOUT, async {
            self.stream.get_mut().write_all(&encoded).await?;
            self.stream.get_mut().flush().await?;
            read_reply(&mut self.stream).await
        })
        .await
        .map_err(|_| anyhow!("timed out waiting for redis"))?
    }

    /// Send one command; an error reply becomes an error. Only the command
    /// name and an allow-listed `ACL` subcommand are reported, never other
    /// arguments: `AUTH <password>` puts the admin password in `args[1]`.
    pub(crate) async fn ok(&mut self, args: &[&str]) -> Result<Reply> {
        match self.command(args).await? {
            Reply::Error(message) => {
                let name = args.first().copied().unwrap_or("command");
                let sub = args
                    .get(1)
                    .copied()
                    .filter(|sub| {
                        name.eq_ignore_ascii_case("ACL")
                            && ["SETUSER", "DELUSER"]
                                .iter()
                                .any(|allowed| sub.eq_ignore_ascii_case(allowed))
                    })
                    .map(|sub| format!(" {sub}"))
                    .unwrap_or_default();
                bail!("redis {name}{sub} failed: {message}")
            }
            reply => Ok(reply),
        }
    }
}

pub(super) async fn issue(config: &RedisConfig, role: &str) -> Result<Issued> {
    let prefix = config.username_prefix.as_deref().unwrap_or("ryu");
    let role_part: String = role
        .bytes()
        .filter(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        .take(16)
        .map(char::from)
        .collect();
    let name = format!("{prefix}_{role_part}_{}", random_suffix(10));
    let password = random_suffix(32);
    let secret = format!(">{password}");
    let rules = config.rules();
    let mut args: Vec<&str> = vec!["ACL", "SETUSER", &name, "reset", "on", &secret];
    args.extend(rules.iter().map(String::as_str));
    let mut connection = Connection::open(&config.connection_url, config.egress).await?;
    connection.ok(&args).await?;
    Ok(Issued {
        data: BTreeMap::from([
            ("username".to_owned(), name.clone()),
            ("password".to_owned(), password),
        ]),
        revoke_data: json!({ "username": name }),
        ttl_cap_secs: None,
    })
}

pub(super) async fn revoke(config: &RedisConfig, revoke_data: &Value) -> Result<()> {
    let name = revoke_data
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("lease has no username"))?;
    validate_username(name)?;
    let mut connection = Connection::open(&config.connection_url, config.egress).await?;
    connection.ok(&["ACL", "DELUSER", name]).await?;
    Ok(())
}

/// Set a new password on an existing user, keeping its rules.
pub(crate) async fn rotate_password(
    connection_url: &str,
    username: &str,
    password: &str,
    egress: TargetEgress,
) -> Result<()> {
    validate_username(username)?;
    let secret = format!(">{password}");
    let mut connection = Connection::open(connection_url, egress).await?;
    connection
        .ok(&["ACL", "SETUSER", username, "resetpass", &secret])
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "redis_test.rs"]
pub(crate) mod tests;
