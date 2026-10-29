//! Client-facing handshakes for the node's local egress proxy.
//!
//! One listener speaks both protocols, chosen by the first byte: SOCKS5 with
//! username/password authentication (RFC 1928/1929, used by the browser app and
//! `ALL_PROXY=socks5h://`), and HTTP proxying (`CONNECT` for TLS plus absolute-form
//! `http://` requests, used through `HTTP(S)_PROXY`). Both require the per-boot
//! credential so other local processes or containers cannot borrow the route.

use base64::Engine as _;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const MAX_HTTP_HEAD: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Credential {
    pub username: String,
    pub password: String,
}

impl Credential {
    pub(crate) fn generate() -> Self {
        use rand::distributions::{Alphanumeric, DistString};
        let mut rng = rand::thread_rng();
        Self {
            username: "ryu".to_owned(),
            password: Alphanumeric.sample_string(&mut rng, 32),
        }
    }

    fn matches(&self, username: &[u8], password: &[u8]) -> bool {
        // Both comparisons always run so timing does not reveal which failed.
        let user_ok = constant_time_eq(username, self.username.as_bytes());
        let pass_ok = constant_time_eq(password, self.password.as_bytes());
        user_ok & pass_ok
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Protocol {
    Socks,
    Connect,
    /// A plain-HTTP request whose rewritten head (plus any body bytes already
    /// read) must be written upstream before relaying.
    Forward(Vec<u8>),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub host: String,
    pub port: u16,
    pub protocol: Protocol,
}

/// Read and authenticate one client request. Errors have already been answered
/// on the socket where the protocol allows it.
pub(crate) async fn accept(socket: &mut TcpStream, credential: &Credential) -> Result<Request, ()> {
    let first = socket.read_u8().await.map_err(|_| ())?;
    if first == 5 {
        accept_socks(socket, credential).await
    } else {
        accept_http(socket, credential, first).await
    }
}

/// Tell the client its destination is connected.
pub(crate) async fn reply_success(
    socket: &mut TcpStream,
    protocol: &Protocol,
) -> std::io::Result<()> {
    match protocol {
        Protocol::Socks => socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await,
        Protocol::Connect => {
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
        }
        Protocol::Forward(_) => Ok(()),
    }
}

/// Tell the client the destination could not be reached, and why.
pub(crate) async fn reply_failure(socket: &mut TcpStream, protocol: &Protocol, reason: &str) {
    let _ = match protocol {
        // 0x02: connection not allowed by ruleset.
        Protocol::Socks => socket.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await,
        Protocol::Connect | Protocol::Forward(_) => {
            let body = format!("Ryu egress: {reason}\n");
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
        }
    };
    let _ = socket.shutdown().await;
}

async fn read_vec(socket: &mut TcpStream, len: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = vec![0u8; len];
    socket.read_exact(&mut bytes).await.map_err(|_| ())?;
    Ok(bytes)
}

async fn accept_socks(socket: &mut TcpStream, credential: &Credential) -> Result<Request, ()> {
    let count = socket.read_u8().await.map_err(|_| ())? as usize;
    let methods = read_vec(socket, count).await?;
    if !methods.contains(&2) {
        let _ = socket.write_all(&[5, 0xff]).await;
        return Err(());
    }
    socket.write_all(&[5, 2]).await.map_err(|_| ())?;
    if socket.read_u8().await.map_err(|_| ())? != 1 {
        return Err(());
    }
    let user_len = socket.read_u8().await.map_err(|_| ())? as usize;
    let username = read_vec(socket, user_len).await?;
    let pass_len = socket.read_u8().await.map_err(|_| ())? as usize;
    let password = read_vec(socket, pass_len).await?;
    if !credential.matches(&username, &password) {
        let _ = socket.write_all(&[1, 1]).await;
        return Err(());
    }
    socket.write_all(&[1, 0]).await.map_err(|_| ())?;

    let header = read_vec(socket, 4).await?;
    if header[0] != 5 || header[1] != 1 || header[2] != 0 {
        // 0x07: command not supported (only CONNECT is).
        let _ = socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(());
    }
    let host = match header[3] {
        1 => {
            let octets = read_vec(socket, 4).await?;
            std::net::Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]).to_string()
        }
        3 => {
            let len = socket.read_u8().await.map_err(|_| ())? as usize;
            String::from_utf8(read_vec(socket, len).await?).map_err(|_| ())?
        }
        4 => {
            let octets: [u8; 16] = read_vec(socket, 16).await?.try_into().map_err(|_| ())?;
            std::net::Ipv6Addr::from(octets).to_string()
        }
        _ => {
            let _ = socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(());
        }
    };
    let port = socket.read_u16().await.map_err(|_| ())?;
    if host.is_empty() || port == 0 {
        return Err(());
    }
    Ok(Request {
        host,
        port,
        protocol: Protocol::Socks,
    })
}

async fn accept_http(
    socket: &mut TcpStream,
    credential: &Credential,
    first: u8,
) -> Result<Request, ()> {
    let mut buffer = vec![first];
    let head_end = loop {
        if let Some(end) = find_head_end(&buffer) {
            break end;
        }
        if buffer.len() >= MAX_HTTP_HEAD {
            return Err(());
        }
        let mut chunk = [0u8; 2048];
        let read = socket.read(&mut chunk).await.map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    match parse_http(&buffer[..head_end], &buffer[head_end..], credential) {
        Ok(request) => Ok(request),
        Err(HttpRejection::Unauthorized) => {
            let _ = socket
                .write_all(
                    b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"ryu\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            Err(())
        }
        Err(HttpRejection::Malformed) => {
            let _ = socket
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            Err(())
        }
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

#[derive(Debug, PartialEq, Eq)]
enum HttpRejection {
    Unauthorized,
    Malformed,
}

/// Split `host[:port]` (with optional `[v6]` brackets) into its parts.
fn split_authority(authority: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        match after.strip_prefix(':') {
            Some(port) => (host, Some(port)),
            None if after.is_empty() => (host, None),
            None => return None,
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, Some(port)),
            _ if authority.contains(':') => return None,
            _ => (authority, None),
        }
    };
    let port = match port {
        Some(port) => port.parse::<u16>().ok()?,
        None => default_port?,
    };
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_owned(), port))
}

fn parse_http(head: &[u8], body: &[u8], credential: &Credential) -> Result<Request, HttpRejection> {
    let text = std::str::from_utf8(head).map_err(|_| HttpRejection::Malformed)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(HttpRejection::Malformed)?;
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(HttpRejection::Malformed);
    };
    if !version.starts_with("HTTP/1.") {
        return Err(HttpRejection::Malformed);
    }
    let headers: Vec<(&str, &str)> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim(), value.trim()))
                .ok_or(HttpRejection::Malformed)
        })
        .collect::<Result<_, _>>()?;

    let authorized = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
        .and_then(|(_, value)| value.strip_prefix("Basic "))
        .and_then(|encoded| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .ok()
        })
        .and_then(|decoded| {
            let colon = decoded.iter().position(|byte| *byte == b':')?;
            Some(credential.matches(&decoded[..colon], &decoded[colon + 1..]))
        })
        .unwrap_or(false);
    if !authorized {
        return Err(HttpRejection::Unauthorized);
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_authority(target, None).ok_or(HttpRejection::Malformed)?;
        return Ok(Request {
            host,
            port,
            protocol: Protocol::Connect,
        });
    }

    // Plain HTTP only; TLS destinations arrive as CONNECT.
    let rest = target
        .strip_prefix("http://")
        .ok_or(HttpRejection::Malformed)?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return Err(HttpRejection::Malformed);
    }
    let (host, port) = split_authority(authority, Some(80)).ok_or(HttpRejection::Malformed)?;
    let mut rewritten = format!("{method} {path} {version}\r\n");
    for (name, value) in &headers {
        let hop_by_hop = [
            "proxy-authorization",
            "proxy-connection",
            "connection",
            "keep-alive",
        ]
        .iter()
        .any(|hop| name.eq_ignore_ascii_case(hop));
        if !hop_by_hop {
            rewritten.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    // One origin per client connection keeps forwarding unambiguous.
    rewritten.push_str("Connection: close\r\n\r\n");
    let mut forward = rewritten.into_bytes();
    forward.extend_from_slice(body);
    Ok(Request {
        host,
        port,
        protocol: Protocol::Forward(forward),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential() -> Credential {
        Credential {
            username: "ryu".into(),
            password: "secret".into(),
        }
    }

    fn basic() -> String {
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode("ryu:secret")
        )
    }

    #[test]
    fn connect_requires_the_credential() {
        let head = format!(
            "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n{}\r\n",
            basic()
        );
        assert_eq!(
            parse_http(head.as_bytes(), b"", &credential()),
            Ok(Request {
                host: "example.com".into(),
                port: 443,
                protocol: Protocol::Connect,
            })
        );
        let anonymous = "CONNECT example.com:443 HTTP/1.1\r\n\r\n";
        assert_eq!(
            parse_http(anonymous.as_bytes(), b"", &credential()),
            Err(HttpRejection::Unauthorized)
        );
        let wrong = format!(
            "CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic {}\r\n\r\n",
            base64::engine::general_purpose::STANDARD.encode("ryu:nope")
        );
        assert_eq!(
            parse_http(wrong.as_bytes(), b"", &credential()),
            Err(HttpRejection::Unauthorized)
        );
    }

    #[test]
    fn absolute_form_is_rewritten_to_origin_form() {
        let head = format!(
            "POST http://example.com:8080/a?b=1 HTTP/1.1\r\nHost: example.com:8080\r\n{}Proxy-Connection: keep-alive\r\nContent-Length: 2\r\n\r\n",
            basic()
        );
        let request = parse_http(head.as_bytes(), b"hi", &credential()).unwrap();
        assert_eq!((request.host.as_str(), request.port), ("example.com", 8080));
        let Protocol::Forward(forward) = request.protocol else {
            panic!("expected a forwarded request");
        };
        let forward = String::from_utf8(forward).unwrap();
        assert!(forward.starts_with("POST /a?b=1 HTTP/1.1\r\nHost: example.com:8080\r\n"));
        assert!(!forward.to_ascii_lowercase().contains("proxy-"));
        assert!(forward.ends_with("Connection: close\r\n\r\nhi"));
    }

    #[test]
    fn authorities_and_targets_are_validated() {
        assert_eq!(
            split_authority("[::1]:443", None),
            Some(("::1".into(), 443))
        );
        assert_eq!(
            split_authority("example.com", Some(80)),
            Some(("example.com".into(), 80))
        );
        assert_eq!(split_authority("example.com", None), None);
        assert_eq!(split_authority("example.com:0", None), None);
        assert_eq!(split_authority("::1:443", None), None);
        for target in [
            "https://example.com/",
            "http://user@example.com/",
            "/relative",
        ] {
            let head = format!("GET {target} HTTP/1.1\r\n{}\r\n", basic());
            assert_eq!(
                parse_http(head.as_bytes(), b"", &credential()),
                Err(HttpRejection::Malformed),
                "{target}"
            );
        }
    }

    #[tokio::test]
    async fn socks_handshake_authenticates_and_parses_the_target() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut client = TcpStream::connect(address).await.unwrap();
            client.write_all(&[5, 1, 2]).await.unwrap();
            let mut reply = [0u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, [5, 2]);
            client
                .write_all(&[
                    1, 3, b'r', b'y', b'u', 6, b's', b'e', b'c', b'r', b'e', b't',
                ])
                .await
                .unwrap();
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, [1, 0]);
            let mut request = vec![5, 1, 0, 3, 11];
            request.extend_from_slice(b"example.com");
            request.extend_from_slice(&443u16.to_be_bytes());
            client.write_all(&request).await.unwrap();
            client
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let request = accept(&mut server, &credential()).await.unwrap();
        assert_eq!(
            request,
            Request {
                host: "example.com".into(),
                port: 443,
                protocol: Protocol::Socks,
            }
        );
        drop(client.await.unwrap());
    }

    #[tokio::test]
    async fn socks_without_password_auth_is_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut client = TcpStream::connect(address).await.unwrap();
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut reply = [0u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            reply
        });
        let (mut server, _) = listener.accept().await.unwrap();
        assert!(accept(&mut server, &credential()).await.is_err());
        assert_eq!(client.await.unwrap(), [5, 0xff]);
    }
}
