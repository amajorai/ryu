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
    /// Connect and authenticate from `connection_url`.
    pub(crate) async fn open(connection_url: &str) -> Result<Self> {
        let url = url::Url::parse(connection_url).context("parsing connectionUrl")?;
        let tls = url_tls(&url)?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("connectionUrl needs a host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url.port().unwrap_or(6379);
        let tcp = tokio::time::timeout(
            IO_TIMEOUT,
            tokio::net::TcpStream::connect((host.as_str(), port)),
        )
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
    let mut connection = Connection::open(&config.connection_url).await?;
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
    let mut connection = Connection::open(&config.connection_url).await?;
    connection.ok(&["ACL", "DELUSER", name]).await?;
    Ok(())
}

/// Set a new password on an existing user, keeping its rules.
pub(crate) async fn rotate_password(
    connection_url: &str,
    username: &str,
    password: &str,
) -> Result<()> {
    validate_username(username)?;
    let secret = format!(">{password}");
    let mut connection = Connection::open(connection_url).await?;
    connection
        .ok(&["ACL", "SETUSER", username, "resetpass", &secret])
        .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    /// A fake RESP server that records every command and answers `+OK`, or
    /// `-ERR` for `ACL` commands while `fail_acl` is set.
    pub(crate) async fn fake_server_with(
        fail_acl: Arc<AtomicBool>,
    ) -> (String, Arc<Mutex<Vec<Vec<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let log: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let recorded = log.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let recorded = recorded.clone();
                let fail_acl = fail_acl.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(socket);
                    loop {
                        let Ok(Reply::Array(Some(items))) = read_reply(&mut reader).await else {
                            return;
                        };
                        let args: Vec<String> = items
                            .into_iter()
                            .filter_map(|item| match item {
                                Reply::Bulk(Some(bytes)) => String::from_utf8(bytes).ok(),
                                _ => None,
                            })
                            .collect();
                        let failing = fail_acl.load(Ordering::SeqCst)
                            && args.first().is_some_and(|name| name == "ACL");
                        recorded.lock().unwrap().push(args);
                        let answer: &[u8] = if failing {
                            b"-ERR denied\r\n"
                        } else {
                            b"+OK\r\n"
                        };
                        if reader.get_mut().write_all(answer).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (format!("redis://admin:s3cret@{address}"), log)
    }

    pub(crate) async fn fake_server(fail_acl: bool) -> (String, Arc<Mutex<Vec<Vec<String>>>>) {
        fake_server_with(Arc::new(AtomicBool::new(fail_acl))).await
    }

    #[test]
    fn rules_cannot_manage_passwords_or_state() {
        let mut config = RedisConfig {
            connection_url: "rediss://admin:pw@cache.example.com:6380".into(),
            acl_rules: vec!["~app:*".into(), "+@read".into()],
            username_prefix: None,
        };
        assert!(config.validate().is_ok());
        assert_eq!(config.redacted_target(), "cache.example.com:6380");
        for bad in [
            ">pw",
            "<pw",
            "#abc",
            "nopass",
            "on",
            "OFF",
            "reset",
            "resetpass",
            "a b",
            "",
        ] {
            config.acl_rules = vec![bad.into()];
            assert!(config.validate().is_err(), "{bad}");
        }
        config.acl_rules.clear();
        config.connection_url = "mysql://x".into();
        assert!(config.validate().is_err());
        assert!(validate_username("default").is_err());
        assert!(validate_username("app user").is_err());
        assert!(validate_username("svc-app_1").is_ok());
    }

    #[test]
    fn commands_encode_as_resp_bulk_arrays() {
        assert_eq!(
            encode_command(&["ACL", "DELUSER", "u"]),
            b"*3\r\n$3\r\nACL\r\n$7\r\nDELUSER\r\n$1\r\nu\r\n".to_vec()
        );
    }

    #[tokio::test]
    async fn issue_revoke_and_rotate_speak_acl() {
        let (url, log) = fake_server(false).await;
        let config = RedisConfig {
            connection_url: url.clone(),
            acl_rules: vec!["~app:*".into(), "+get".into()],
            username_prefix: Some("svc".into()),
        };
        let issued = issue(&config, "cache-ro").await.unwrap();
        let name = issued.data["username"].clone();
        assert!(name.starts_with("svc_cachero_"));
        revoke(&config, &issued.revoke_data).await.unwrap();
        rotate_password(&url, "app", "newpass").await.unwrap();
        let log = log.lock().unwrap().clone();
        assert_eq!(log[0], ["AUTH", "admin", "s3cret"]);
        assert_eq!(
            &log[1][..5],
            ["ACL", "SETUSER", name.as_str(), "reset", "on"]
        );
        assert_eq!(log[1][5], format!(">{}", issued.data["password"]));
        assert_eq!(&log[1][6..], ["~app:*", "+get"]);
        assert_eq!(log[3], ["ACL", "DELUSER", name.as_str()]);
        assert_eq!(log[5], ["ACL", "SETUSER", "app", "resetpass", ">newpass"]);
    }

    #[tokio::test]
    async fn error_replies_fail_without_echoing_secrets() {
        let (url, _) = fake_server(true).await;
        let error = rotate_password(&url, "app", "hunter2hunter2")
            .await
            .unwrap_err();
        let text = error.to_string();
        assert!(text.contains("ACL SETUSER failed"));
        assert!(!text.contains("hunter2"));
    }

    #[tokio::test]
    async fn rejected_auth_never_reports_the_admin_password() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let mut reader = BufReader::new(socket);
                if read_reply(&mut reader).await.is_ok() {
                    let _ = reader
                        .get_mut()
                        .write_all(b"-WRONGPASS invalid username-password pair\r\n")
                        .await;
                }
            }
        });
        for url in [
            format!("redis://:adm1n-s3cret@{address}"),
            format!("redis://admin:adm1n-s3cret@{address}"),
        ] {
            let text = rotate_password(&url, "app", "newpass")
                .await
                .unwrap_err()
                .to_string();
            assert!(text.contains("redis AUTH failed"), "{text}");
            assert!(!text.contains("adm1n-s3cret"), "{text}");
            assert!(!text.contains("admin failed"), "{text}");
        }
    }
}
