//! A minimal SQL Server client over TDS: PRELOGIN, TLS, LOGIN7 with SQL
//! authentication, and SQL batches. Enough to run account statements without
//! a SQL Server driver in Core.
//!
//! `encrypt` in the connection URL picks the transport:
//!
//! * `true` (default): TDS 7.4 with the TLS handshake carried inside
//!   PRELOGIN packets, then everything over TLS;
//! * `strict`: TDS 8.0, TLS first (ALPN `tds/8.0`), as SQL Server 2022 and
//!   Azure SQL offer;
//! * `false`: no TLS, only when the server does not require it (the admin
//!   password then crosses the network obfuscated, not encrypted).
//!
//! TLS verifies against the platform trust store plus an optional
//! operator-pinned CA (`caPem`). Named instances (`host\instance`), which need
//! the SQL Browser service, are not supported: give the port instead.

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::mssql_tds::{self as tds, HEADER, MAX_MESSAGE_BYTES};
use super::target_guard::{self, TargetEgress};

const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// How the connection is encrypted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encrypt {
    On,
    Strict,
    Off,
}

/// Where and how to connect, parsed from
/// `sqlserver://user:pass@host:1433/db?encrypt=true`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    pub encrypt: Encrypt,
}

impl Target {
    pub(crate) fn parse(raw: &str) -> Result<Self> {
        let url = url::Url::parse(raw).context("connectionUrl is not a URL")?;
        if !matches!(url.scheme(), "sqlserver" | "mssql") {
            bail!("connectionUrl must be a sqlserver:// or mssql:// URL");
        }
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("connectionUrl needs a host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let query = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.to_ascii_lowercase())
        };
        let encrypt = match query("encrypt").as_deref() {
            None | Some("true" | "yes" | "mandatory") => Encrypt::On,
            Some("strict") => Encrypt::Strict,
            Some("false" | "no" | "optional") => Encrypt::Off,
            Some(other) => bail!("encrypt `{other}` is not supported"),
        };
        let decode = |value: &str| -> Result<String> {
            Ok(urlencoding::decode(value)
                .context("connectionUrl is not valid UTF-8")?
                .into_owned())
        };
        let path = url.path().trim_start_matches('/');
        let database = if path.is_empty() {
            "master".to_owned()
        } else {
            decode(path)?
        };
        let user = decode(url.username())?;
        if user.is_empty() {
            bail!("connectionUrl needs a SQL login");
        }
        Ok(Self {
            host,
            port: url.port().unwrap_or(1433),
            user,
            password: decode(url.password().unwrap_or_default())?,
            database,
            encrypt,
        })
    }
}

/// TLS over a TCP stream, driven by hand so the handshake can travel inside
/// PRELOGIN packets. Either side (the tests run the server half).
struct TlsLink {
    tcp: TcpStream,
    tls: rustls::Connection,
}

impl TlsLink {
    async fn flush(&mut self) -> Result<()> {
        while self.tls.wants_write() {
            let mut out = Vec::new();
            self.tls.write_tls(&mut out)?;
            self.tcp.write_all(&out).await?;
        }
        Ok(())
    }

    fn absorb(&mut self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            self.tls.read_tls(&mut bytes)?;
            self.tls
                .process_new_packets()
                .map_err(|error| anyhow!("TLS with sql server failed: {error}"))?;
        }
        Ok(())
    }

    async fn feed(&mut self) -> Result<()> {
        let mut buf = vec![0u8; 16 * 1024];
        let n = self.tcp.read(&mut buf).await?;
        if n == 0 {
            bail!("sql server closed the connection");
        }
        self.absorb(&buf[..n])?;
        self.flush().await
    }

    /// TLS directly on the socket (TDS 8.0).
    async fn handshake_raw(&mut self) -> Result<()> {
        while self.tls.is_handshaking() {
            self.flush().await?;
            if self.tls.is_handshaking() {
                self.feed().await?;
            }
        }
        self.flush().await
    }

    /// TLS records wrapped in PRELOGIN packets (TDS 7.x).
    async fn handshake_in_prelogin(&mut self) -> Result<()> {
        loop {
            if self.tls.wants_write() {
                let mut out = Vec::new();
                while self.tls.wants_write() {
                    self.tls.write_tls(&mut out)?;
                }
                self.tcp
                    .write_all(&tds::packets(tds::TYPE_PRELOGIN, &out))
                    .await?;
            }
            if !self.tls.is_handshaking() {
                return Ok(());
            }
            let (_, payload) = read_message_plain(&mut self.tcp).await?;
            self.absorb(&payload)?;
        }
    }
}

enum Transport {
    Plain(TcpStream),
    Tls(Box<TlsLink>),
}

impl Transport {
    async fn write_all(&mut self, data: &[u8]) -> Result<()> {
        match self {
            Self::Plain(tcp) => tcp.write_all(data).await?,
            Self::Tls(link) => {
                link.tls.writer().write_all(data)?;
                link.flush().await?;
            }
        }
        Ok(())
    }

    async fn read_exact(&mut self, out: &mut [u8]) -> Result<()> {
        match self {
            Self::Plain(tcp) => {
                tcp.read_exact(out).await?;
            }
            Self::Tls(link) => {
                let mut filled = 0;
                while filled < out.len() {
                    match link.tls.reader().read(&mut out[filled..]) {
                        Ok(0) => bail!("sql server closed the connection"),
                        Ok(n) => filled += n,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            link.feed().await?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        Ok(())
    }

    /// Read packets up to end-of-message: (type, payload).
    async fn read_message(&mut self) -> Result<(u8, Vec<u8>)> {
        let mut payload = Vec::new();
        loop {
            let mut header = [0u8; HEADER];
            self.read_exact(&mut header).await?;
            let (kind, eom, len) = tds::header(&header)?;
            if payload.len() + len > MAX_MESSAGE_BYTES {
                bail!("sql server reply is too large");
            }
            let start = payload.len();
            payload.resize(start + len, 0);
            self.read_exact(&mut payload[start..]).await?;
            if eom {
                return Ok((kind, payload));
            }
        }
    }
}

/// Read packets up to end-of-message straight off the socket (the TLS
/// handshake inside PRELOGIN).
async fn read_message_plain(tcp: &mut TcpStream) -> Result<(u8, Vec<u8>)> {
    let mut payload = Vec::new();
    loop {
        let mut header = [0u8; HEADER];
        tcp.read_exact(&mut header).await?;
        let (kind, eom, len) = tds::header(&header)?;
        if payload.len() + len > MAX_MESSAGE_BYTES {
            bail!("sql server reply is too large");
        }
        let start = payload.len();
        payload.resize(start + len, 0);
        tcp.read_exact(&mut payload[start..]).await?;
        if eom {
            return Ok((kind, payload));
        }
    }
}

fn tls_config(ca_pem: Option<&str>, alpn: bool) -> Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if let Some(pem) = ca_pem {
        roots.add(
            crate::vault::broker::ca::pem_to_der(pem).context("caPem is not a certificate")?,
        )?;
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    if alpn {
        config.alpn_protocols = vec![b"tds/8.0".to_vec()];
    }
    Ok(Arc::new(config))
}

/// An authenticated connection.
pub(crate) struct Connection {
    transport: Transport,
}

impl Connection {
    pub(crate) async fn open(
        target: &Target,
        ca_pem: Option<&str>,
        egress: TargetEgress,
    ) -> Result<Self> {
        tokio::time::timeout(IO_TIMEOUT * 2, Self::open_inner(target, ca_pem, egress))
            .await
            .map_err(|_| anyhow!("timed out connecting to sql server"))?
    }

    async fn open_inner(
        target: &Target,
        ca_pem: Option<&str>,
        egress: TargetEgress,
    ) -> Result<Self> {
        let tcp = target_guard::tcp_connect(&target.host, target.port, egress)
            .await
            .context("connecting to sql server")?;
        let new_tls = |alpn: bool| -> Result<rustls::Connection> {
            let name = rustls::pki_types::ServerName::try_from(target.host.clone())
                .map_err(|_| anyhow!("connectionUrl host is not a valid TLS name"))?;
            Ok(rustls::ClientConnection::new(tls_config(ca_pem, alpn)?, name)?.into())
        };
        let mut transport = match target.encrypt {
            Encrypt::Strict => {
                let mut link = TlsLink {
                    tcp,
                    tls: new_tls(true)?,
                };
                link.handshake_raw().await?;
                let mut transport = Transport::Tls(Box::new(link));
                transport
                    .write_all(&tds::packets(
                        tds::TYPE_PRELOGIN,
                        &tds::prelogin(tds::ENCRYPT_ON),
                    ))
                    .await?;
                transport.read_message().await?;
                transport
            }
            Encrypt::On | Encrypt::Off => {
                let mut transport = Transport::Plain(tcp);
                let ask = if target.encrypt == Encrypt::On {
                    tds::ENCRYPT_ON
                } else {
                    tds::ENCRYPT_NOT_SUP
                };
                transport
                    .write_all(&tds::packets(tds::TYPE_PRELOGIN, &tds::prelogin(ask)))
                    .await?;
                let (kind, reply) = transport.read_message().await?;
                if kind != tds::TYPE_REPLY {
                    bail!("unexpected PRELOGIN reply");
                }
                let answer = tds::prelogin_encryption(&reply)?;
                match (target.encrypt, answer) {
                    (Encrypt::On, tds::ENCRYPT_ON | tds::ENCRYPT_REQ) => {
                        let Transport::Plain(tcp) = transport else {
                            unreachable!("PRELOGIN runs in plaintext");
                        };
                        let mut link = TlsLink { tcp, tls: new_tls(false)? };
                        link.handshake_in_prelogin().await?;
                        Transport::Tls(Box::new(link))
                    }
                    (Encrypt::On, _) => bail!("the sql server does not support encryption; set encrypt=false to connect without TLS"),
                    (_, tds::ENCRYPT_REQ) => bail!("the sql server requires encryption; set encrypt=true"),
                    _ => transport,
                }
            }
        };
        transport
            .write_all(&tds::packets(
                tds::TYPE_LOGIN7,
                &tds::login7(
                    &target.user,
                    &target.password,
                    &target.host,
                    &target.database,
                ),
            ))
            .await?;
        let (_, reply) = transport.read_message().await?;
        let outcome = tds::parse_reply(&reply)?;
        if !outcome.logged_in {
            bail!(
                "sql server login failed: {}",
                outcome
                    .error
                    .unwrap_or_else(|| "no login acknowledgement".into())
            );
        }
        Ok(Self { transport })
    }

    /// Run one batch.
    pub(crate) async fn query(&mut self, sql: &str) -> Result<()> {
        tokio::time::timeout(IO_TIMEOUT, async {
            self.transport
                .write_all(&tds::packets(tds::TYPE_BATCH, &tds::batch(sql)))
                .await?;
            let (_, reply) = self.transport.read_message().await?;
            let outcome = tds::parse_reply(&reply)?;
            if let Some(error) = outcome.error {
                bail!("sql server statement failed: {error}");
            }
            if outcome.done_error {
                bail!("sql server statement failed");
            }
            Ok(())
        })
        .await
        .map_err(|_| anyhow!("timed out waiting for sql server"))?
    }
}

#[cfg(test)]
#[path = "mssql_wire_test.rs"]
pub(crate) mod tests;
