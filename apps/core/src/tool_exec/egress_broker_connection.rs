//! Per-connection handling: request-head parsing, authentication, and the
//! `CONNECT` tunnel and plain-HTTP forward paths.

use super::*;

pub(super) struct RequestHead {
    method: String,
    target: String,
    version: String,
    headers: Vec<(String, String)>,
}

/// Read up to the end of the request head; returns the head and any bytes after it.
pub(super) async fn read_head(stream: &mut TcpStream) -> Result<(RequestHead, Vec<u8>), Refusal> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Err(Refusal::BadRequest("request head too large".to_owned()));
        }
        let read = tokio::time::timeout(HEAD_READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| Refusal::BadRequest("timed out reading request head".to_owned()))?
            .map_err(|e| Refusal::BadRequest(e.to_string()))?;
        if read == 0 {
            return Err(Refusal::BadRequest(
                "connection closed before request head".to_owned(),
            ));
        }
        buf.extend_from_slice(&chunk[..read]);
    };
    let rest = buf[end + 4..].to_vec();
    let text = std::str::from_utf8(&buf[..end])
        .map_err(|_| Refusal::BadRequest("request head is not UTF-8".to_owned()))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Refusal::BadRequest("malformed request line".to_owned()));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(Refusal::BadRequest("unsupported HTTP version".to_owned()));
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| Refusal::BadRequest("malformed header".to_owned()))?;
        if name.is_empty()
            || name
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(Refusal::BadRequest("malformed header name".to_owned()));
        }
        headers.push((name.to_owned(), value.trim().to_owned()));
    }
    Ok((
        RequestHead {
            method: method.to_owned(),
            target: target.to_owned(),
            version: version.to_owned(),
            headers,
        },
        rest,
    ))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn authorized(head: &RequestHead, expected: &str) -> bool {
    head.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("proxy-authorization")
            && constant_time_eq(value.as_bytes(), expected.as_bytes())
    })
}

pub(super) async fn write_status(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    body: &str,
) -> io::Result<()> {
    let extra = if code == 407 {
        "Proxy-Authenticate: Basic realm=\"ryu-egress\"\r\n"
    } else {
        ""
    };
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\n{extra}Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

async fn refuse(stream: &mut TcpStream, refusal: Refusal) {
    let (code, reason, body) = match refusal {
        Refusal::BadRequest(body) => (400, "Bad Request", body),
        Refusal::Forbidden(body) => (403, "Forbidden", body),
        Refusal::BadGateway(body) => (502, "Bad Gateway", body),
    };
    tracing::debug!(code, reason = %body, "egress broker refused a child connection");
    let _ = write_status(stream, code, reason, &body).await;
}

pub(super) async fn handle_connection(
    mut stream: TcpStream,
    policy: &BrokerPolicy,
    net: &BrokerNet,
    expected_auth: &str,
) {
    let (head, rest) = match read_head(&mut stream).await {
        Ok(parsed) => parsed,
        Err(refusal) => return refuse(&mut stream, refusal).await,
    };
    if !authorized(&head, expected_auth) {
        let _ = write_status(
            &mut stream,
            407,
            "Proxy Authentication Required",
            "proxy authentication required",
        )
        .await;
        return;
    }
    if head.method.eq_ignore_ascii_case("CONNECT") {
        handle_connect(stream, &head, rest, policy, net).await;
    } else {
        handle_forward(stream, &head, rest, policy, net).await;
    }
}

async fn handle_connect(
    mut stream: TcpStream,
    head: &RequestHead,
    rest: Vec<u8>,
    policy: &BrokerPolicy,
    net: &BrokerNet,
) {
    let screened = match split_authority(&head.target) {
        Ok((host, port)) => screen_target(host, port, policy, net).await,
        Err(refusal) => Err(refusal),
    };
    let target = match screened {
        Ok(target) => target,
        Err(refusal) => return refuse(&mut stream, refusal).await,
    };
    let mut upstream = match connect_pinned(&target, net).await {
        Ok(upstream) => upstream,
        Err(refusal) => return refuse(&mut stream, refusal).await,
    };
    if stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    if !rest.is_empty() && upstream.write_all(&rest).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
}

/// Headers never forwarded upstream: proxy credentials, hop-by-hop connection
/// management (replaced by `Connection: close`), and `Host` (rewritten from the
/// screened target so it always names what the socket is pinned to).
const STRIPPED_FORWARD_HEADERS: &[&str] = &[
    "proxy-authorization",
    "proxy-connection",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "host",
];

async fn handle_forward(
    mut stream: TcpStream,
    head: &RequestHead,
    rest: Vec<u8>,
    policy: &BrokerPolicy,
    net: &BrokerNet,
) {
    let parsed = match url::Url::parse(&head.target) {
        Ok(parsed) if parsed.scheme() == "http" => parsed,
        Ok(_) => {
            return refuse(
                &mut stream,
                Refusal::BadRequest(
                    "only absolute http:// requests or CONNECT are proxied".to_owned(),
                ),
            )
            .await
        }
        Err(_) => {
            return refuse(
                &mut stream,
                Refusal::BadRequest("proxy requests must use an absolute http:// URL".to_owned()),
            )
            .await
        }
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return refuse(
            &mut stream,
            Refusal::BadRequest("credentials in the request URL are not proxied".to_owned()),
        )
        .await;
    }
    let Some(host) = parsed.host_str().map(str::to_owned) else {
        return refuse(
            &mut stream,
            Refusal::BadRequest("target has no host".to_owned()),
        )
        .await;
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let target = match screen_target(&host, port, policy, net).await {
        Ok(target) => target,
        Err(refusal) => return refuse(&mut stream, refusal).await,
    };
    let mut upstream = match connect_pinned(&target, net).await {
        Ok(upstream) => upstream,
        Err(refusal) => return refuse(&mut stream, refusal).await,
    };
    let mut origin_form = parsed.path().to_owned();
    if let Some(query) = parsed.query() {
        origin_form.push('?');
        origin_form.push_str(query);
    }
    let host_header = match parsed.port() {
        Some(explicit) => format!("{}:{explicit}", target.host),
        None => target.host.clone(),
    };
    let mut out = format!(
        "{} {origin_form} {}\r\nHost: {host_header}\r\n",
        head.method, head.version
    );
    for (name, value) in &head.headers {
        if STRIPPED_FORWARD_HEADERS
            .iter()
            .any(|stripped| name.eq_ignore_ascii_case(stripped))
        {
            continue;
        }
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    if upstream.write_all(out.as_bytes()).await.is_err() {
        return;
    }
    if !rest.is_empty() && upstream.write_all(&rest).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
}
