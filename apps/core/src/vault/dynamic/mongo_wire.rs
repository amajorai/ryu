//! A minimal MongoDB client: just enough BSON, `OP_MSG`, and SCRAM-SHA-256
//! to run user-management commands without a MongoDB driver in Core.
//!
//! One host per connection (no `mongodb+srv://` or seed lists): point the
//! role at the primary or at a `mongos`. TLS follows `tls=true` (or
//! `ssl=true`) and verifies against the platform trust store. The server's
//! SCRAM signature is checked, so a server that does not know the password
//! cannot pass as the real one.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::target_guard::{self, TargetEgress};

const IO_TIMEOUT: Duration = Duration::from_secs(10);
const OP_MSG: i32 = 2013;
const MAX_MESSAGE_BYTES: usize = 4 << 20;
/// Fewer SCRAM iterations than this are refused (MongoDB defaults to 15000).
const MIN_ITERATIONS: u32 = 4096;

pub(crate) use super::mongo_bson::{decode, encode, get, Bson, Doc};

fn s(value: &str) -> Bson {
    Bson::String(value.to_owned())
}

/// Where and how to connect, parsed from `mongodb://user:pass@host/db`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub auth_source: String,
    pub tls: bool,
}

impl Target {
    pub(crate) fn parse(raw: &str) -> Result<Self> {
        if raw.starts_with("mongodb+srv://") {
            bail!("mongodb+srv:// is not supported; name one host with mongodb://");
        }
        let url = url::Url::parse(raw).context("connectionUrl is not a URL")?;
        if url.scheme() != "mongodb" {
            bail!("connectionUrl must be a mongodb:// URL");
        }
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("connectionUrl must name exactly one host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let query = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.into_owned())
        };
        let tls = matches!(
            query("tls").or_else(|| query("ssl")).as_deref(),
            Some("true")
        );
        let decode = |value: &str| -> Result<String> {
            Ok(urlencoding::decode(value)
                .context("connectionUrl is not valid UTF-8")?
                .into_owned())
        };
        let path = url.path().trim_start_matches('/');
        let auth_source = query("authSource").unwrap_or_else(|| {
            if path.is_empty() {
                "admin".to_owned()
            } else {
                path.to_owned()
            }
        });
        let password = decode(url.password().unwrap_or_default())?;
        if !password.bytes().all(|b| (0x20..0x7F).contains(&b)) {
            bail!("the connectionUrl password must be printable ASCII");
        }
        Ok(Self {
            host,
            port: url.port().unwrap_or(27017),
            user: decode(url.username())?,
            password,
            auth_source,
            tls,
        })
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// PBKDF2-HMAC-SHA256 with one 32-byte block.
pub(crate) fn pbkdf2(password: &[u8], salt: &[u8], iterations: u32) -> Vec<u8> {
    let mut block = salt.to_vec();
    block.extend_from_slice(&1u32.to_be_bytes());
    let mut u = hmac(password, &block);
    let mut out = u.clone();
    for _ in 1..iterations {
        u = hmac(password, &u);
        for (acc, byte) in out.iter_mut().zip(&u) {
            *acc ^= byte;
        }
    }
    out
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// The SCRAM attributes of a server message (`r=…,s=…,i=…`).
fn attribute<'a>(message: &'a str, name: char) -> Option<&'a str> {
    message
        .split(',')
        .find_map(|part| part.strip_prefix(name)?.strip_prefix('='))
}

/// An authenticated connection.
pub(crate) struct Connection {
    stream: Box<dyn Stream>,
    request_id: i32,
}

impl Connection {
    pub(crate) async fn open(target: &Target, egress: TargetEgress) -> Result<Self> {
        tokio::time::timeout(IO_TIMEOUT * 2, Self::open_inner(target, egress))
            .await
            .map_err(|_| anyhow!("timed out connecting to mongodb"))?
    }

    async fn open_inner(target: &Target, egress: TargetEgress) -> Result<Self> {
        let tcp = target_guard::tcp_connect(&target.host, target.port, egress)
            .await
            .context("connecting to mongodb")?;
        let stream: Box<dyn Stream> = if target.tls {
            let connector = native_tls::TlsConnector::new().context("building TLS connector")?;
            Box::new(
                tokio_native_tls::TlsConnector::from(connector)
                    .connect(&target.host, tcp)
                    .await
                    .context("negotiating TLS with mongodb")?,
            )
        } else {
            Box::new(tcp)
        };
        let mut connection = Self {
            stream,
            request_id: 0,
        };
        if !target.user.is_empty() {
            connection.authenticate(target).await?;
        }
        Ok(connection)
    }

    async fn round_trip(&mut self, command: &Doc) -> Result<Doc> {
        self.request_id += 1;
        let body = encode(command);
        let mut message = Vec::with_capacity(body.len() + 21);
        message.extend_from_slice(&((body.len() + 21) as i32).to_le_bytes());
        message.extend_from_slice(&self.request_id.to_le_bytes());
        message.extend_from_slice(&0i32.to_le_bytes());
        message.extend_from_slice(&OP_MSG.to_le_bytes());
        message.extend_from_slice(&0u32.to_le_bytes());
        message.push(0);
        message.extend(body);
        self.stream.write_all(&message).await?;
        self.stream.flush().await?;
        let mut header = [0u8; 16];
        self.stream.read_exact(&mut header).await?;
        let len = i32::from_le_bytes(header[..4].try_into()?);
        let len = usize::try_from(len).map_err(|_| anyhow!("bad mongodb reply length"))?;
        if !(21..=MAX_MESSAGE_BYTES).contains(&len) {
            bail!("bad mongodb reply length");
        }
        if i32::from_le_bytes(header[12..].try_into()?) != OP_MSG {
            bail!("unexpected mongodb reply type");
        }
        let mut rest = vec![0u8; len - 16];
        self.stream.read_exact(&mut rest).await?;
        let flags = u32::from_le_bytes(rest[..4].try_into()?);
        let end = if flags & 1 == 1 {
            rest.len() - 4
        } else {
            rest.len()
        };
        if end <= 5 || rest[4] != 0 {
            bail!("unexpected mongodb reply section");
        }
        decode(&rest[5..end])
    }

    /// Run a command; a reply without `ok: 1` is an error. `allow` lists
    /// error codes that count as success.
    pub(crate) async fn command(&mut self, command: Doc, allow: &[i32]) -> Result<Doc> {
        let name = command
            .first()
            .map(|(key, _)| key.clone())
            .unwrap_or_default();
        let reply = tokio::time::timeout(IO_TIMEOUT, self.round_trip(&command))
            .await
            .map_err(|_| anyhow!("timed out waiting for mongodb"))??;
        let ok = match get(&reply, "ok") {
            Some(Bson::Double(v)) => *v == 1.0,
            Some(Bson::Int32(v)) => *v == 1,
            Some(Bson::Int64(v)) => *v == 1,
            Some(Bson::Bool(v)) => *v,
            _ => false,
        };
        if ok {
            return Ok(reply);
        }
        let code = match get(&reply, "code") {
            Some(Bson::Int32(code)) => *code,
            Some(Bson::Int64(code)) => *code as i32,
            Some(Bson::Double(code)) => *code as i32,
            _ => 0,
        };
        if allow.contains(&code) {
            return Ok(reply);
        }
        let message = match get(&reply, "errmsg") {
            Some(Bson::String(text)) => text.clone(),
            _ => "command failed".to_owned(),
        };
        bail!("mongodb {name} failed: [{code}] {message}")
    }

    async fn authenticate(&mut self, target: &Target) -> Result<()> {
        use rand::RngCore;
        let mut raw = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut raw);
        let nonce = b64().encode(raw);
        let user = target.user.replace('=', "=3D").replace(',', "=2C");
        let first_bare = format!("n={user},r={nonce}");
        let db = s(&target.auth_source);
        let reply = self
            .command(
                vec![
                    ("saslStart".into(), Bson::Int32(1)),
                    ("mechanism".into(), s("SCRAM-SHA-256")),
                    (
                        "payload".into(),
                        Bson::Binary(format!("n,,{first_bare}").into_bytes()),
                    ),
                    ("autoAuthorize".into(), Bson::Int32(1)),
                    (
                        "options".into(),
                        Bson::Document(vec![("skipEmptyExchange".into(), Bson::Bool(true))]),
                    ),
                    ("$db".into(), db.clone()),
                ],
                &[],
            )
            .await
            .map_err(|error| anyhow!("mongodb authentication failed: {error:#}"))?;
        let conversation = get(&reply, "conversationId")
            .cloned()
            .unwrap_or(Bson::Int32(1));
        let Some(Bson::Binary(server_first)) = get(&reply, "payload") else {
            bail!("mongodb sent no SCRAM challenge");
        };
        let server_first = String::from_utf8(server_first.clone())?;
        let server_nonce = attribute(&server_first, 'r').unwrap_or_default();
        if !server_nonce.starts_with(&nonce) || server_nonce.len() <= nonce.len() {
            bail!("mongodb sent a bad SCRAM nonce");
        }
        let salt = b64()
            .decode(attribute(&server_first, 's').unwrap_or_default())
            .context("mongodb sent a bad SCRAM salt")?;
        let iterations: u32 = attribute(&server_first, 'i')
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| anyhow!("mongodb sent no SCRAM iteration count"))?;
        if iterations < MIN_ITERATIONS {
            bail!("mongodb asked for too few SCRAM iterations");
        }
        let salted = pbkdf2(target.password.as_bytes(), &salt, iterations);
        let without_proof = format!("c=biws,r={server_nonce}");
        let auth_message = format!("{first_bare},{server_first},{without_proof}");
        let client_key = hmac(&salted, b"Client Key");
        let stored_key = Sha256::digest(&client_key);
        let signature = hmac(&stored_key, auth_message.as_bytes());
        let proof: Vec<u8> = client_key
            .iter()
            .zip(&signature)
            .map(|(a, b)| a ^ b)
            .collect();
        let mut payload = format!("{without_proof},p={}", b64().encode(proof)).into_bytes();
        let server_key = hmac(&salted, b"Server Key");
        let expected = b64().encode(hmac(&server_key, auth_message.as_bytes()));
        let mut verified = false;
        for _ in 0..3 {
            let reply = self
                .command(
                    vec![
                        ("saslContinue".into(), Bson::Int32(1)),
                        ("conversationId".into(), conversation.clone()),
                        ("payload".into(), Bson::Binary(std::mem::take(&mut payload))),
                        ("$db".into(), db.clone()),
                    ],
                    &[],
                )
                .await
                .map_err(|error| anyhow!("mongodb authentication failed: {error:#}"))?;
            if let Some(Bson::Binary(message)) = get(&reply, "payload") {
                let message = String::from_utf8_lossy(message);
                if let Some(signature) = attribute(&message, 'v') {
                    if signature != expected {
                        bail!("mongodb's SCRAM signature does not match");
                    }
                    verified = true;
                }
            }
            if matches!(get(&reply, "done"), Some(Bson::Bool(true))) {
                if !verified {
                    bail!("mongodb finished SCRAM without proving the password");
                }
                return Ok(());
            }
        }
        bail!("mongodb SCRAM did not finish")
    }
}

#[cfg(test)]
#[path = "mongo_wire_test.rs"]
pub(crate) mod tests;
