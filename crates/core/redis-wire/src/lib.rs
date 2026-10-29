//! Minimal, binary-safe RESP2 client shared by Ryu's pluggable state stores.
//!
//! - [`codec`] — command encoding and an incremental, bounded reply parser.
//! - [`RedisUrl`] — `redis://`, `rediss://`, `valkey://`, `valkeys://` URL parsing
//!   (userinfo → `AUTH`, path → `SELECT`), with a credential-free display form.
//! - [`RedisClient`] — a small pool of lazily-opened connections. Each command
//!   borrows one connection; an I/O error or timeout drops that connection so
//!   the next call reconnects. Commands are never retried automatically, so a
//!   non-idempotent write is never applied twice.
//! - [`testing`] (feature `testing`) — an in-process RESP server implementing the
//!   command subset Ryu's stores use, for unit tests that need a transport.
//!
//! Error messages name the command only, never its arguments: `AUTH` carries a
//! password and data commands carry user content.

pub mod codec;
#[cfg(feature = "testing")]
pub mod testing;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

pub use codec::{Cmd, Frame};

/// Errors from the RESP client.
#[derive(Debug)]
pub enum RedisError {
    /// The connection URL is invalid.
    Url(String),
    /// A socket or TLS error.
    Io(String),
    /// Connecting or a command exceeded its deadline.
    Timeout(String),
    /// The server sent bytes that are not valid RESP2.
    Protocol(String),
    /// The server answered with an error reply.
    Server(String),
}

impl std::fmt::Display for RedisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Url(message) => write!(f, "invalid redis URL: {message}"),
            Self::Io(message) => write!(f, "redis I/O error: {message}"),
            Self::Timeout(message) => write!(f, "redis timeout: {message}"),
            Self::Protocol(message) => write!(f, "redis protocol error: {message}"),
            Self::Server(message) => write!(f, "redis error reply: {message}"),
        }
    }
}

impl std::error::Error for RedisError {}

/// A parsed Redis/Valkey connection URL.
#[derive(Clone, PartialEq, Eq)]
pub struct RedisUrl {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub db: u32,
}

impl std::fmt::Debug for RedisUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.redacted())
    }
}

impl RedisUrl {
    /// Parse `redis[s]://[user[:password]@]host[:port][/db]` (also `valkey[s]://`).
    pub fn parse(raw: &str) -> Result<Self, RedisError> {
        let url = url::Url::parse(raw).map_err(|_| RedisError::Url("not a URL".to_owned()))?;
        let tls = match url.scheme() {
            "redis" | "valkey" => false,
            "rediss" | "valkeys" => true,
            _ => {
                return Err(RedisError::Url(
                    "scheme must be redis, rediss, valkey, or valkeys".to_owned(),
                ))
            }
        };
        let host = url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| RedisError::Url("missing host".to_owned()))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let decode = |value: &str| {
            urlencoding::decode(value)
                .map(std::borrow::Cow::into_owned)
                .map_err(|_| RedisError::Url("userinfo is not valid UTF-8".to_owned()))
        };
        let password = url.password().map(decode).transpose()?;
        let username = Some(decode(url.username())?).filter(|name| !name.is_empty());
        let db = match url.path().trim_start_matches('/') {
            "" => 0,
            path => path
                .parse()
                .map_err(|_| RedisError::Url("database path must be a number".to_owned()))?,
        };
        Ok(Self {
            host,
            port: url.port().unwrap_or(6379),
            tls,
            username,
            password,
            db,
        })
    }

    /// `scheme://host:port/db` without credentials, safe for logs and status.
    pub fn redacted(&self) -> String {
        let scheme = if self.tls { "rediss" } else { "redis" };
        format!("{scheme}://{}:{}/{}", self.host, self.port, self.db)
    }
}

/// Pool sizing and deadlines.
#[derive(Debug, Clone, Copy)]
pub struct ClientOptions {
    /// Number of pooled connections (at least 1).
    pub pool_size: usize,
    /// Deadline for TCP connect + TLS + `AUTH`/`SELECT`.
    pub connect_timeout: Duration,
    /// Deadline for one command or pipeline round trip.
    pub io_timeout: Duration,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            pool_size: 4,
            connect_timeout: Duration::from_secs(5),
            io_timeout: Duration::from_secs(5),
        }
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

struct Connection {
    stream: Box<dyn Stream>,
    buf: Vec<u8>,
}

impl Connection {
    async fn open(url: &RedisUrl) -> Result<Self, RedisError> {
        let tcp = tokio::net::TcpStream::connect((url.host.as_str(), url.port))
            .await
            .map_err(|error| RedisError::Io(format!("connect {}: {error}", url.redacted())))?;
        let _ = tcp.set_nodelay(true);
        let stream: Box<dyn Stream> = if url.tls {
            Self::tls(&url.host, tcp).await?
        } else {
            Box::new(tcp)
        };
        let mut connection = Self {
            stream,
            buf: Vec::with_capacity(4096),
        };
        if let Some(password) = &url.password {
            let auth = match &url.username {
                Some(user) => Cmd::new("AUTH").arg(user).arg(password),
                None => Cmd::new("AUTH").arg(password),
            };
            connection
                .round_trip(&[auth])
                .await?
                .remove(0)
                .into_result()?;
        }
        if url.db != 0 {
            connection
                .round_trip(&[Cmd::new("SELECT").arg(url.db.to_string())])
                .await?
                .remove(0)
                .into_result()?;
        }
        Ok(connection)
    }

    #[cfg(feature = "tls")]
    async fn tls(host: &str, tcp: tokio::net::TcpStream) -> Result<Box<dyn Stream>, RedisError> {
        let connector = native_tls::TlsConnector::new()
            .map_err(|error| RedisError::Io(format!("TLS setup: {error}")))?;
        let stream = tokio_native_tls::TlsConnector::from(connector)
            .connect(host, tcp)
            .await
            .map_err(|error| RedisError::Io(format!("TLS handshake: {error}")))?;
        Ok(Box::new(stream))
    }

    #[cfg(not(feature = "tls"))]
    async fn tls(_host: &str, _tcp: tokio::net::TcpStream) -> Result<Box<dyn Stream>, RedisError> {
        Err(RedisError::Url(
            "rediss:// needs ryu-redis-wire built with the `tls` feature".to_owned(),
        ))
    }

    /// Write every command, then read exactly one reply per command.
    async fn round_trip(&mut self, cmds: &[Cmd]) -> Result<Vec<Frame>, RedisError> {
        let mut out = Vec::new();
        for cmd in cmds {
            cmd.encode_into(&mut out);
        }
        self.stream
            .write_all(&out)
            .await
            .map_err(|error| RedisError::Io(error.to_string()))?;
        self.stream
            .flush()
            .await
            .map_err(|error| RedisError::Io(error.to_string()))?;
        let mut replies = Vec::with_capacity(cmds.len());
        while replies.len() < cmds.len() {
            replies.push(self.read_frame().await?);
        }
        Ok(replies)
    }

    async fn read_frame(&mut self) -> Result<Frame, RedisError> {
        loop {
            if let Some((frame, consumed)) = codec::parse_frame(&self.buf)? {
                self.buf.drain(..consumed);
                return Ok(frame);
            }
            let mut chunk = [0u8; 8192];
            let read = self
                .stream
                .read(&mut chunk)
                .await
                .map_err(|error| RedisError::Io(error.to_string()))?;
            if read == 0 {
                return Err(RedisError::Io("server closed the connection".to_owned()));
            }
            self.buf.extend_from_slice(&chunk[..read]);
        }
    }
}

/// A pooled RESP2 client. Connections open lazily on first use, so building a
/// client never blocks or fails on an unreachable server.
pub struct RedisClient {
    url: RedisUrl,
    options: ClientOptions,
    pool: Vec<Mutex<Option<Connection>>>,
    next: AtomicUsize,
}

impl std::fmt::Debug for RedisClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisClient")
            .field("url", &self.url)
            .field("pool_size", &self.pool.len())
            .finish()
    }
}

impl RedisClient {
    /// Build a client for `url` with `options` (no I/O happens here).
    pub fn new(url: RedisUrl, options: ClientOptions) -> Self {
        let size = options.pool_size.max(1);
        Self {
            url,
            options,
            pool: (0..size).map(|_| Mutex::new(None)).collect(),
            next: AtomicUsize::new(0),
        }
    }

    /// Parse `url` and build a client with default options.
    pub fn from_url(url: &str) -> Result<Self, RedisError> {
        Ok(Self::new(RedisUrl::parse(url)?, ClientOptions::default()))
    }

    /// The parsed URL (use [`RedisUrl::redacted`] for display).
    pub fn url(&self) -> &RedisUrl {
        &self.url
    }

    /// Run one command. An error reply becomes [`RedisError::Server`].
    pub async fn query(&self, cmd: Cmd) -> Result<Frame, RedisError> {
        let name = cmd.name();
        let mut replies = self.pipeline(std::slice::from_ref(&cmd)).await?;
        replies
            .pop()
            .ok_or_else(|| RedisError::Protocol(format!("{name}: no reply")))?
            .into_result()
            .map_err(|error| match error {
                RedisError::Server(message) => RedisError::Server(format!("{name}: {message}")),
                other => other,
            })
    }

    /// Send several commands in one round trip and return one frame per
    /// command, in order. Error replies stay as [`Frame::Error`] items so a
    /// `MULTI`/`EXEC` block or a partial batch can be inspected per command.
    pub async fn pipeline(&self, cmds: &[Cmd]) -> Result<Vec<Frame>, RedisError> {
        if cmds.is_empty() {
            return Ok(Vec::new());
        }
        let slot = self.next.fetch_add(1, Ordering::Relaxed) % self.pool.len();
        let mut guard = self.pool[slot].lock().await;
        // Take the connection out of its slot for the round trip and put it
        // back only after every reply was read. If this future is dropped
        // mid-flight (a cancelled request), the connection is dropped with it
        // instead of staying pooled with unread replies that the next caller
        // would take for its own.
        let mut connection = match guard.take() {
            Some(connection) => connection,
            None => tokio::time::timeout(self.options.connect_timeout, Connection::open(&self.url))
                .await
                .map_err(|_| {
                    RedisError::Timeout(format!("connecting to {}", self.url.redacted()))
                })??,
        };
        let outcome =
            tokio::time::timeout(self.options.io_timeout, connection.round_trip(cmds)).await;
        match outcome {
            Ok(Ok(replies)) => {
                *guard = Some(connection);
                Ok(replies)
            }
            // The stream may hold a half-read reply; never reuse it.
            Ok(Err(error)) => Err(error),
            Err(_) => Err(RedisError::Timeout(cmds[0].name())),
        }
    }

    /// Run commands inside `MULTI`/`EXEC` in one round trip and return the
    /// `EXEC` results. Fails if the transaction was aborted or any queued
    /// command was rejected.
    pub async fn transaction(&self, cmds: &[Cmd]) -> Result<Vec<Frame>, RedisError> {
        let mut batch = Vec::with_capacity(cmds.len() + 2);
        batch.push(Cmd::new("MULTI"));
        batch.extend_from_slice(cmds);
        batch.push(Cmd::new("EXEC"));
        let mut replies = self.pipeline(&batch).await?;
        let exec = replies
            .pop()
            .ok_or_else(|| RedisError::Protocol("EXEC: no reply".to_owned()))?;
        for (index, reply) in replies.into_iter().enumerate() {
            if let Frame::Error(message) = reply {
                let name = batch.get(index).map(Cmd::name).unwrap_or_default();
                return Err(RedisError::Server(format!("{name}: {message}")));
            }
        }
        match exec {
            Frame::Array(Some(results)) => {
                for (cmd, result) in cmds.iter().zip(&results) {
                    if let Frame::Error(message) = result {
                        return Err(RedisError::Server(format!("{}: {message}", cmd.name())));
                    }
                }
                Ok(results)
            }
            Frame::Error(message) => Err(RedisError::Server(format!("EXEC: {message}"))),
            _ => Err(RedisError::Server("EXEC: transaction aborted".to_owned())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_parse_auth_tls_and_database() {
        let url = RedisUrl::parse("rediss://app:p%40ss@cache.internal:6380/3").unwrap();
        assert!(url.tls);
        assert_eq!(url.host, "cache.internal");
        assert_eq!(url.port, 6380);
        assert_eq!(url.username.as_deref(), Some("app"));
        assert_eq!(url.password.as_deref(), Some("p@ss"));
        assert_eq!(url.db, 3);
        assert_eq!(url.redacted(), "rediss://cache.internal:6380/3");
        assert!(!format!("{url:?}").contains("p@ss"));

        let plain = RedisUrl::parse("valkey://:secret@[::1]").unwrap();
        assert!(!plain.tls);
        assert_eq!(plain.host, "::1");
        assert_eq!(plain.port, 6379);
        assert_eq!(plain.username, None);
        assert_eq!(plain.password.as_deref(), Some("secret"));
    }

    /// A command whose caller is cancelled mid-flight must not leave its reply
    /// on a pooled connection, where the next command would read it as its own.
    #[tokio::test]
    async fn a_cancelled_command_never_leaks_its_reply_to_the_next_one() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Echo server: replies with the command's first argument, after a delay
        // when that argument is `slow`.
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    loop {
                        while let Ok(Some((frame, used))) = codec::parse_frame(&buf) {
                            buf.drain(..used);
                            let arg = frame
                                .into_array()
                                .into_iter()
                                .nth(1)
                                .and_then(Frame::into_bytes)
                                .unwrap_or_default();
                            if arg == b"slow" {
                                tokio::time::sleep(Duration::from_millis(300)).await;
                            }
                            let mut out = Vec::new();
                            codec::encode_frame(&Frame::Bulk(Some(arg)), &mut out);
                            if socket.write_all(&out).await.is_err() {
                                return;
                            }
                        }
                        let mut chunk = [0u8; 1024];
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => buf.extend_from_slice(&chunk[..read]),
                        }
                    }
                });
            }
        });
        let client = RedisClient::new(
            RedisUrl::parse(&format!("redis://{addr}")).unwrap(),
            ClientOptions {
                pool_size: 1,
                ..ClientOptions::default()
            },
        );
        let cancelled = tokio::time::timeout(
            Duration::from_millis(50),
            client.query(Cmd::new("ECHO").arg("slow")),
        )
        .await;
        assert!(cancelled.is_err(), "the slow command was cancelled");
        let reply = client.query(Cmd::new("ECHO").arg("fast")).await.unwrap();
        assert_eq!(reply, Frame::Bulk(Some(b"fast".to_vec())));
    }

    #[test]
    fn bad_urls_are_rejected() {
        for bad in ["http://x", "redis://", "redis://host/notanumber", "nope"] {
            assert!(RedisUrl::parse(bad).is_err(), "{bad}");
        }
    }
}
