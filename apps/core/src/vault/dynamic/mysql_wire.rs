//! A minimal MySQL/MariaDB client: the v10 handshake, TLS upgrade,
//! `mysql_native_password` and `caching_sha2_password` authentication, and
//! `COM_QUERY` with result sets drained. Enough to run account statements
//! without a MySQL client crate in Core.
//!
//! `caching_sha2_password` full authentication sends the password only over
//! TLS; Core never asks a server for its RSA key over plaintext, since a
//! machine in the middle could hand over its own.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::target_guard::{self, TargetEgress};

const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PACKET_BYTES: usize = 1 << 20;

const CLIENT_LONG_PASSWORD: u32 = 0x1;
const CLIENT_CONNECT_WITH_DB: u32 = 0x8;
const CLIENT_PROTOCOL_41: u32 = 0x200;
const CLIENT_SSL: u32 = 0x800;
const CLIENT_TRANSACTIONS: u32 = 0x2000;
const CLIENT_SECURE_CONNECTION: u32 = 0x8000;
const CLIENT_MULTI_RESULTS: u32 = 0x20000;
const CLIENT_PLUGIN_AUTH: u32 = 0x80000;
const CLIENT_PLUGIN_AUTH_LENENC: u32 = 0x20_0000;
const SERVER_MORE_RESULTS_EXISTS: u16 = 0x8;
/// `utf8mb4_general_ci`.
const CHARSET: u8 = 45;

/// When to use TLS (`ssl-mode` in the connection URL).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SslMode {
    Disabled,
    Preferred,
    Required,
}

/// Where and how to connect, parsed from `mysql://user:pass@host:port/db`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    pub ssl: SslMode,
}

impl Target {
    pub(crate) fn parse(raw: &str) -> Result<Self> {
        let url = url::Url::parse(raw).context("connectionUrl is not a URL")?;
        if !matches!(url.scheme(), "mysql" | "mariadb") {
            bail!("connectionUrl must be a mysql:// or mariadb:// URL");
        }
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("connectionUrl needs a host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let decode = |value: &str| -> Result<String> {
            Ok(urlencoding::decode(value)
                .context("connectionUrl is not valid UTF-8")?
                .into_owned())
        };
        let mode = url
            .query_pairs()
            .find(|(key, _)| matches!(key.as_ref(), "ssl-mode" | "sslmode" | "ssl_mode"))
            .map(|(_, value)| value.to_ascii_lowercase());
        let ssl = match mode.as_deref() {
            None | Some("preferred" | "prefer") => SslMode::Preferred,
            Some("disabled" | "disable") => SslMode::Disabled,
            Some("required" | "require" | "verify_ca" | "verify_identity") => SslMode::Required,
            Some(other) => bail!("ssl-mode `{other}` is not supported"),
        };
        let database = url.path().trim_start_matches('/');
        Ok(Self {
            host,
            port: url.port().unwrap_or(3306),
            user: decode(url.username())?,
            password: decode(url.password().unwrap_or_default())?,
            database: (!database.is_empty()).then(|| database.to_owned()),
            ssl,
        })
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// The server's initial handshake.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Handshake {
    pub capabilities: u32,
    pub nonce: Vec<u8>,
    pub plugin: String,
}

pub(crate) fn parse_handshake(packet: &[u8]) -> Result<Handshake> {
    if packet.first() == Some(&0xFF) {
        bail!("mysql refused the connection: {}", parse_error(packet));
    }
    if packet.first() != Some(&10) {
        bail!("unsupported mysql protocol version");
    }
    let mut at = 1
        + packet[1..]
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| anyhow!("malformed mysql handshake"))?
        + 1;
    let need = |at: usize, n: usize| -> Result<()> {
        if packet.len() < at + n {
            bail!("truncated mysql handshake");
        }
        Ok(())
    };
    need(at, 4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10)?;
    at += 4; // connection id
    let mut nonce = packet[at..at + 8].to_vec();
    at += 9;
    let low = u16::from_le_bytes([packet[at], packet[at + 1]]) as u32;
    at += 3; // capabilities low, charset
    at += 2; // status
    let high = u16::from_le_bytes([packet[at], packet[at + 1]]) as u32;
    at += 2;
    let capabilities = low | (high << 16);
    let auth_len = packet[at] as usize;
    at += 11;
    if capabilities & CLIENT_SECURE_CONNECTION != 0 {
        let part = auth_len.saturating_sub(8).max(13);
        need(at, part)?;
        nonce.extend(packet[at..at + part].iter().take_while(|&&b| b != 0));
        at += part;
    }
    let plugin = if capabilities & CLIENT_PLUGIN_AUTH != 0 && at < packet.len() {
        String::from_utf8_lossy(
            &packet[at..]
                .iter()
                .copied()
                .take_while(|&b| b != 0)
                .collect::<Vec<_>>(),
        )
        .into_owned()
    } else {
        "mysql_native_password".to_owned()
    };
    Ok(Handshake {
        capabilities,
        nonce,
        plugin,
    })
}

/// `ERR` packet text: `[code] message`.
pub(crate) fn parse_error(packet: &[u8]) -> String {
    if packet.len() < 3 {
        return "unknown error".into();
    }
    let code = u16::from_le_bytes([packet[1], packet[2]]);
    let mut text = &packet[3..];
    if text.first() == Some(&b'#') && text.len() >= 6 {
        text = &text[6..];
    }
    format!("[{code}] {}", String::from_utf8_lossy(text))
}

fn xor(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b.iter().cycle()).map(|(x, y)| x ^ y).collect()
}

/// The auth response for `plugin` over `nonce`.
pub(crate) fn scramble(plugin: &str, password: &str, nonce: &[u8]) -> Result<Vec<u8>> {
    if password.is_empty() {
        return Ok(Vec::new());
    }
    match plugin {
        "mysql_native_password" => {
            let stage1 = Sha1::digest(password.as_bytes());
            let stage2 = Sha1::digest(stage1);
            let mut hasher = Sha1::new();
            hasher.update(nonce);
            hasher.update(stage2);
            Ok(xor(&stage1, &hasher.finalize()))
        }
        "caching_sha2_password" => {
            let stage1 = Sha256::digest(password.as_bytes());
            let stage2 = Sha256::digest(stage1);
            let mut hasher = Sha256::new();
            hasher.update(stage2);
            hasher.update(nonce);
            Ok(xor(&stage1, &hasher.finalize()))
        }
        other => bail!("mysql auth plugin `{other}` is not supported"),
    }
}

fn lenenc(bytes: &[u8], out: &mut Vec<u8>) {
    let len = bytes.len();
    if len < 0xFB {
        out.push(len as u8);
    } else if len < 0x1_0000 {
        out.push(0xFC);
        out.extend_from_slice(&(len as u16).to_le_bytes());
    } else {
        out.push(0xFD);
        out.extend_from_slice(&(len as u32).to_le_bytes()[..3]);
    }
    out.extend_from_slice(bytes);
}

/// Read a length-encoded integer at `at`, advancing it.
fn read_lenenc(packet: &[u8], at: &mut usize) -> Result<u64> {
    let first = *packet
        .get(*at)
        .ok_or_else(|| anyhow!("truncated mysql packet"))?;
    let width = match first {
        0xFC => 2,
        0xFD => 3,
        0xFE => 8,
        0xFB | 0xFF => bail!("unexpected mysql length marker"),
        value => {
            *at += 1;
            return Ok(u64::from(value));
        }
    };
    let bytes = packet
        .get(*at + 1..*at + 1 + width)
        .ok_or_else(|| anyhow!("truncated mysql packet"))?;
    *at += 1 + width;
    let mut buf = [0u8; 8];
    buf[..width].copy_from_slice(bytes);
    Ok(u64::from_le_bytes(buf))
}

/// The status flags of an `OK` or `EOF` packet.
fn status_flags(packet: &[u8]) -> Result<u16> {
    let mut at = 1;
    if packet[0] == 0x00 {
        read_lenenc(packet, &mut at)?;
        read_lenenc(packet, &mut at)?;
    } else {
        at += 2; // warnings
    }
    let bytes = packet
        .get(at..at + 2)
        .ok_or_else(|| anyhow!("truncated mysql status"))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn is_eof(packet: &[u8]) -> bool {
    packet.first() == Some(&0xFE) && packet.len() < 9
}

/// An authenticated connection.
pub(crate) struct Connection {
    stream: Box<dyn Stream>,
    seq: u8,
}

async fn read_raw<S: AsyncRead + Unpin + ?Sized>(stream: &mut S, seq: &mut u8) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    loop {
        let mut header = [0u8; 4];
        stream.read_exact(&mut header).await?;
        let len = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
        *seq = header[3].wrapping_add(1);
        if payload.len() + len > MAX_PACKET_BYTES {
            bail!("mysql packet is too large");
        }
        let start = payload.len();
        payload.resize(start + len, 0);
        stream.read_exact(&mut payload[start..]).await?;
        if len < 0xFF_FFFF {
            return Ok(payload);
        }
    }
}

async fn write_raw<S: AsyncWrite + Unpin + ?Sized>(
    stream: &mut S,
    seq: &mut u8,
    payload: &[u8],
) -> Result<()> {
    let len = payload.len() as u32;
    let mut packet = len.to_le_bytes()[..3].to_vec();
    packet.push(*seq);
    packet.extend_from_slice(payload);
    *seq = seq.wrapping_add(1);
    stream.write_all(&packet).await?;
    stream.flush().await?;
    Ok(())
}

impl Connection {
    /// Connect and authenticate; a screened connection goes only to the
    /// screened, resolved address.
    pub(crate) async fn open(target: &Target, egress: TargetEgress) -> Result<Self> {
        tokio::time::timeout(IO_TIMEOUT * 2, Self::open_inner(target, egress))
            .await
            .map_err(|_| anyhow!("timed out connecting to mysql"))?
    }

    async fn open_inner(target: &Target, egress: TargetEgress) -> Result<Self> {
        let mut tcp = target_guard::tcp_connect(&target.host, target.port, egress)
            .await
            .context("connecting to mysql")?;
        let mut seq = 0;
        let handshake = parse_handshake(&read_raw(&mut tcp, &mut seq).await?)?;
        let server = handshake.capabilities;
        if server & CLIENT_PROTOCOL_41 == 0 || server & CLIENT_PLUGIN_AUTH == 0 {
            bail!("the mysql server is too old (needs protocol 4.1 and auth plugins)");
        }
        let tls = match target.ssl {
            SslMode::Disabled => false,
            SslMode::Preferred => server & CLIENT_SSL != 0,
            SslMode::Required if server & CLIENT_SSL != 0 => true,
            SslMode::Required => bail!("ssl-mode is REQUIRED but the mysql server has no TLS"),
        };
        let mut caps = CLIENT_LONG_PASSWORD
            | CLIENT_PROTOCOL_41
            | CLIENT_TRANSACTIONS
            | CLIENT_SECURE_CONNECTION
            | CLIENT_MULTI_RESULTS
            | CLIENT_PLUGIN_AUTH
            | (server & CLIENT_PLUGIN_AUTH_LENENC);
        if target.database.is_some() {
            caps |= CLIENT_CONNECT_WITH_DB;
        }
        if tls {
            caps |= CLIENT_SSL;
        }
        let mut prefix = caps.to_le_bytes().to_vec();
        prefix.extend_from_slice(&(MAX_PACKET_BYTES as u32).to_le_bytes());
        prefix.push(CHARSET);
        prefix.extend_from_slice(&[0u8; 23]);
        let stream: Box<dyn Stream> = if tls {
            write_raw(&mut tcp, &mut seq, &prefix).await?;
            let connector = native_tls::TlsConnector::new().context("building TLS connector")?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            Box::new(
                connector
                    .connect(&target.host, tcp)
                    .await
                    .context("negotiating TLS with mysql")?,
            )
        } else {
            Box::new(tcp)
        };
        let mut connection = Self { stream, seq };
        let mut response = prefix;
        response.extend_from_slice(target.user.as_bytes());
        response.push(0);
        // An unknown default plugin gets an empty answer; the server then
        // switches to one Core speaks or refuses.
        let auth =
            scramble(&handshake.plugin, &target.password, &handshake.nonce).unwrap_or_default();
        if caps & CLIENT_PLUGIN_AUTH_LENENC != 0 {
            lenenc(&auth, &mut response);
        } else {
            response.push(auth.len() as u8);
            response.extend_from_slice(&auth);
        }
        if let Some(database) = &target.database {
            response.extend_from_slice(database.as_bytes());
            response.push(0);
        }
        response.extend_from_slice(handshake.plugin.as_bytes());
        response.push(0);
        connection.write(&response).await?;
        connection
            .authenticate(target, tls, handshake.plugin)
            .await?;
        Ok(connection)
    }

    async fn read(&mut self) -> Result<Vec<u8>> {
        read_raw(&mut self.stream, &mut self.seq).await
    }

    async fn write(&mut self, payload: &[u8]) -> Result<()> {
        write_raw(&mut self.stream, &mut self.seq, payload).await
    }

    async fn authenticate(&mut self, target: &Target, tls: bool, mut plugin: String) -> Result<()> {
        loop {
            let packet = self.read().await?;
            match packet.first() {
                Some(0x00) => return Ok(()),
                Some(0xFF) => bail!("mysql authentication failed: {}", parse_error(&packet)),
                Some(0xFE) => {
                    let rest = &packet[1..];
                    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
                    plugin = String::from_utf8_lossy(&rest[..end]).into_owned();
                    let nonce: Vec<u8> = rest
                        .get(end + 1..)
                        .unwrap_or_default()
                        .iter()
                        .copied()
                        .take_while(|&b| b != 0)
                        .collect();
                    let auth = scramble(&plugin, &target.password, &nonce)?;
                    self.write(&auth).await?;
                }
                Some(0x01) if plugin == "caching_sha2_password" => match packet.get(1) {
                    Some(0x03) => {}
                    Some(0x04) if tls => {
                        let mut clear = target.password.as_bytes().to_vec();
                        clear.push(0);
                        self.write(&clear).await?;
                    }
                    Some(0x04) => bail!(
                        "caching_sha2_password needs TLS for a full login; set ssl-mode=REQUIRED"
                    ),
                    _ => bail!("unexpected caching_sha2_password reply"),
                },
                _ => bail!("unexpected mysql authentication reply"),
            }
        }
    }

    /// Run one statement, draining any result sets it returns.
    pub(crate) async fn query(&mut self, sql: &str) -> Result<()> {
        tokio::time::timeout(IO_TIMEOUT, self.query_inner(sql))
            .await
            .map_err(|_| anyhow!("timed out waiting for mysql"))?
    }

    async fn query_inner(&mut self, sql: &str) -> Result<()> {
        self.seq = 0;
        let mut command = vec![0x03];
        command.extend_from_slice(sql.as_bytes());
        self.write(&command).await?;
        loop {
            let packet = self.read().await?;
            let status = match packet.first() {
                Some(0x00) => status_flags(&packet)?,
                Some(0xFF) => bail!("mysql statement failed: {}", parse_error(&packet)),
                Some(0xFB) => bail!("mysql asked for a local file, which is refused"),
                Some(_) => self.drain_result_set().await?,
                None => bail!("empty mysql reply"),
            };
            if status & SERVER_MORE_RESULTS_EXISTS == 0 {
                return Ok(());
            }
        }
    }

    /// Skip column definitions and rows; return the final status flags.
    async fn drain_result_set(&mut self) -> Result<u16> {
        let mut eofs = 0;
        loop {
            let packet = self.read().await?;
            if packet.first() == Some(&0xFF) {
                bail!("mysql statement failed: {}", parse_error(&packet));
            }
            if is_eof(&packet) {
                eofs += 1;
                if eofs == 2 {
                    return status_flags(&packet);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "mysql_wire_test.rs"]
pub(crate) mod tests;
