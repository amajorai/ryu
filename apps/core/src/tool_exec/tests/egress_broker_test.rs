//! Egress broker: every child connection is authenticated, screened, and pinned.
//! The resolver and connector are injected, so no test touches the real network:
//! "public" names resolve to documentation-free public addresses and the
//! connector redirects any approved address to a local fixture upstream while
//! recording the address the broker asked for.
use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

const PUBLIC_IP: &str = "93.184.216.34";

struct Fixture {
    broker: EgressBroker,
    connected: Arc<Mutex<Vec<SocketAddr>>>,
    upstream_heads: Arc<Mutex<Vec<String>>>,
}

fn policy(allow_hosts: Option<&str>) -> BrokerPolicy {
    BrokerPolicy {
        guard_enabled: true,
        allow_hosts: allow_hosts.map(str::to_owned),
        max_connections: 8,
        lifetime: Duration::from_secs(30),
    }
}

/// A fixture upstream: reads whatever the broker sends first, records it, then
/// echoes for CONNECT-style traffic or answers an HTTP request.
async fn spawn_upstream(heads: Arc<Mutex<Vec<String>>>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let heads = heads.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let Ok(n) = socket.read(&mut buf).await else {
                    return;
                };
                let first = String::from_utf8_lossy(&buf[..n]).into_owned();
                heads.lock().unwrap().push(first.clone());
                if first.starts_with("GET ") {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await;
                    return;
                }
                let _ = socket.write_all(&buf[..n]).await;
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    addr
}

async fn fixture_with(
    policy: BrokerPolicy,
    dns: HashMap<&'static str, Vec<Vec<IpAddr>>>,
) -> Fixture {
    let upstream_heads = Arc::new(Mutex::new(Vec::new()));
    let upstream = spawn_upstream(upstream_heads.clone()).await;
    let connected = Arc::new(Mutex::new(Vec::new()));
    // Each hostname maps to a sequence of answers; successive lookups walk it
    // (last answer repeats), which models a DNS-rebinding resolver.
    let dns: Arc<Mutex<HashMap<String, (usize, Vec<Vec<IpAddr>>)>>> = Arc::new(Mutex::new(
        dns.into_iter()
            .map(|(host, answers)| (host.to_owned(), (0, answers)))
            .collect(),
    ));
    let recorder = connected.clone();
    let net = BrokerNet::custom(
        move |host, port| {
            let dns = dns.clone();
            Box::pin(async move {
                let mut table = dns.lock().unwrap();
                let Some((cursor, answers)) = table.get_mut(&host) else {
                    return Err(io::Error::new(io::ErrorKind::NotFound, "no such host"));
                };
                let index = (*cursor).min(answers.len() - 1);
                *cursor += 1;
                Ok(answers[index]
                    .iter()
                    .map(|ip| SocketAddr::new(*ip, port))
                    .collect())
            })
        },
        move |addr| {
            recorder.lock().unwrap().push(addr);
            Box::pin(TcpStream::connect(upstream))
        },
    );
    Fixture {
        broker: EgressBroker::start_with(policy, net).await.unwrap(),
        connected,
        upstream_heads,
    }
}

fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

fn default_dns() -> HashMap<&'static str, Vec<Vec<IpAddr>>> {
    HashMap::from([
        ("public.example", vec![vec![ip(PUBLIC_IP)]]),
        ("internal.example", vec![vec![ip("10.0.0.5")]]),
        (
            "mixed.example",
            vec![vec![ip(PUBLIC_IP), ip("192.168.1.10")]],
        ),
        (
            "rebind.example",
            vec![vec![ip(PUBLIC_IP)], vec![ip("127.0.0.1")]],
        ),
    ])
}

async fn new_fixture() -> Fixture {
    fixture_with(policy(None), default_dns()).await
}

fn basic(credential: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(credential)
    )
}

/// Send one request head through the broker; returns (status code, stream).
async fn send(fixture: &Fixture, request_line: &str, auth: Option<&str>) -> (u16, TcpStream) {
    let mut stream = TcpStream::connect(fixture.broker.local_addr())
        .await
        .unwrap();
    let mut head = format!("{request_line}\r\nHost: ignored\r\n");
    if let Some(auth) = auth {
        head.push_str(&format!("Proxy-Authorization: {auth}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        let n = stream.read(&mut byte).await.unwrap();
        assert_ne!(n, 0, "broker closed before a response head");
        response.push(byte[0]);
    }
    let text = String::from_utf8(response).unwrap();
    let code = text.split(' ').nth(1).unwrap().parse().unwrap();
    (code, stream)
}

async fn connect(fixture: &Fixture, authority: &str) -> (u16, TcpStream) {
    let auth = basic(&fixture.broker.credential());
    send(
        fixture,
        &format!("CONNECT {authority} HTTP/1.1"),
        Some(&auth),
    )
    .await
}

#[tokio::test]
async fn broker_tunnels_public_target_to_pinned_address() {
    let fixture = new_fixture().await;
    let (code, mut stream) = connect(&fixture, "public.example:443").await;
    assert_eq!(code, 200);
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    assert_eq!(
        *fixture.connected.lock().unwrap(),
        vec![SocketAddr::new(ip(PUBLIC_IP), 443)],
        "the broker must connect to the screened address, not re-resolve the name"
    );
}

#[tokio::test]
async fn broker_refuses_private_literal_targets() {
    let fixture = new_fixture().await;
    for authority in [
        "127.0.0.1:443",
        "10.1.2.3:443",
        "169.254.169.254:80",
        "[::1]:443",
        "[::ffff:127.0.0.1]:443",
        // Numeric IPv4 spellings canonicalize to loopback before screening.
        "2130706433:443",
        "0x7f.1:443",
        "localhost:443",
        "metadata.google.internal:80",
    ] {
        let (code, _) = connect(&fixture, authority).await;
        assert_eq!(code, 403, "{authority} must be refused");
    }
    assert!(fixture.connected.lock().unwrap().is_empty());
}

#[tokio::test]
async fn broker_refuses_hostnames_resolving_to_private_addresses() {
    let fixture = new_fixture().await;
    for authority in ["internal.example:443", "mixed.example:443"] {
        let (code, _) = connect(&fixture, authority).await;
        assert_eq!(code, 403, "{authority} must be refused");
    }
    assert!(fixture.connected.lock().unwrap().is_empty());
}

#[tokio::test]
async fn broker_refuses_disallowed_ports_unless_allowlisted() {
    let fixture = new_fixture().await;
    let (code, _) = connect(&fixture, "public.example:22").await;
    assert_eq!(code, 403);
    let (code, _) = connect(&fixture, "public.example:8443").await;
    assert_eq!(code, 403);
    assert!(fixture.connected.lock().unwrap().is_empty());

    let allowlisted = fixture_with(policy(Some("public.example:8443")), default_dns()).await;
    let (code, _) = connect(&allowlisted, "public.example:8443").await;
    assert_eq!(code, 200);
    // The narrow entry grants only that port; a bare-host entry grants nothing
    // here because these URLs are model-supplied.
    let (code, _) = connect(&allowlisted, "public.example:8080").await;
    assert_eq!(code, 403);
    let bare = fixture_with(policy(Some("public.example")), default_dns()).await;
    let (code, _) = connect(&bare, "public.example:8443").await;
    assert_eq!(code, 403);
}

#[tokio::test]
async fn broker_allowlisted_host_port_reaches_private_target() {
    let fixture = fixture_with(policy(Some("internal.example:443")), default_dns()).await;
    let (code, _) = connect(&fixture, "internal.example:443").await;
    assert_eq!(code, 200);
    let (code, _) = connect(&fixture, "10.1.2.3:443").await;
    assert_eq!(
        code, 403,
        "the allowlist exempts exactly the listed host:port"
    );
}

#[tokio::test]
async fn broker_requires_the_per_invocation_credential() {
    let fixture = new_fixture().await;
    let (code, _) = send(&fixture, "CONNECT public.example:443 HTTP/1.1", None).await;
    assert_eq!(code, 407);
    let (code, _) = send(
        &fixture,
        "CONNECT public.example:443 HTTP/1.1",
        Some(&basic("ryu:not-the-secret")),
    )
    .await;
    assert_eq!(code, 407);
    let (code, _) = send(
        &fixture,
        "GET http://public.example/ HTTP/1.1",
        Some("Bearer whatever"),
    )
    .await;
    assert_eq!(code, 407);
    // A second broker never accepts the first broker's credential.
    let other = new_fixture().await;
    let (code, _) = send(
        &other,
        "CONNECT public.example:443 HTTP/1.1",
        Some(&basic(&fixture.broker.credential())),
    )
    .await;
    assert_eq!(code, 407);
    assert!(fixture.connected.lock().unwrap().is_empty());
}

#[tokio::test]
async fn broker_rescreens_every_connection_in_a_session() {
    let fixture = new_fixture().await;
    let (code, _) = connect(&fixture, "public.example:443").await;
    assert_eq!(code, 200);
    // A crawled link / redirect to an internal target on the SAME broker.
    let (code, _) = connect(&fixture, "internal.example:443").await;
    assert_eq!(code, 403);
    let (code, _) = connect(&fixture, "169.254.169.254:80").await;
    assert_eq!(code, 403);
    // DNS rebinding: the first lookup is public, the second is loopback.
    let (code, _) = connect(&fixture, "rebind.example:443").await;
    assert_eq!(code, 200);
    let (code, _) = connect(&fixture, "rebind.example:443").await;
    assert_eq!(code, 403);
    assert_eq!(fixture.connected.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn broker_forwards_absolute_form_http_in_origin_form() {
    let fixture = new_fixture().await;
    let auth = basic(&fixture.broker.credential());
    let (code, _) = send(
        &fixture,
        "GET http://public.example/path?q=1 HTTP/1.1",
        Some(&auth),
    )
    .await;
    assert_eq!(code, 200);
    let heads = fixture.upstream_heads.lock().unwrap().clone();
    let head = heads.first().expect("upstream saw the request");
    assert!(head.starts_with("GET /path?q=1 HTTP/1.1\r\n"), "{head}");
    assert!(head.contains("Host: public.example\r\n"), "{head}");
    assert!(head.contains("Connection: close\r\n"), "{head}");
    assert!(
        !head.to_ascii_lowercase().contains("proxy-authorization"),
        "{head}"
    );
    assert!(
        !head.contains("ignored"),
        "client Host header must be replaced: {head}"
    );

    let (code, _) = send(&fixture, "GET http://10.0.0.1/ HTTP/1.1", Some(&auth)).await;
    assert_eq!(code, 403);
    let (code, _) = send(
        &fixture,
        "GET http://internal.example/ HTTP/1.1",
        Some(&auth),
    )
    .await;
    assert_eq!(code, 403);
    let (code, _) = send(
        &fixture,
        "GET http://public.example:8080/ HTTP/1.1",
        Some(&auth),
    )
    .await;
    assert_eq!(code, 403);
    let (code, _) = send(&fixture, "GET /relative HTTP/1.1", Some(&auth)).await;
    assert_eq!(code, 400);
    let (code, _) = send(&fixture, "GET ftp://public.example/ HTTP/1.1", Some(&auth)).await;
    assert_eq!(code, 400);
}

/// reqwest (the HTTP stack the Spider CLI uses) authenticates to the broker from
/// the proxy URL's userinfo, for both plain HTTP and CONNECT tunnels.
#[tokio::test]
async fn broker_accepts_reqwest_proxy_url_credentials() {
    let fixture = new_fixture().await;
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(fixture.broker.proxy_url()).unwrap())
        .build()
        .unwrap();
    let body = client
        .get("http://public.example/page")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "ok");
    // The fixture upstream is not TLS, so the handshake fails AFTER the broker
    // accepted the authenticated CONNECT and connected to the pinned address.
    let _ = client.get("https://public.example/secure").send().await;
    assert_eq!(
        *fixture.connected.lock().unwrap(),
        vec![
            SocketAddr::new(ip(PUBLIC_IP), 80),
            SocketAddr::new(ip(PUBLIC_IP), 443)
        ]
    );
    // A private target through the same client is refused by the broker.
    let refused = client.get("http://internal.example/").send().await.unwrap();
    assert_eq!(refused.status().as_u16(), 403);
}

#[tokio::test]
async fn broker_caps_concurrent_connections_and_stops_on_drop() {
    let mut capped = policy(None);
    capped.max_connections = 1;
    let fixture = fixture_with(capped, default_dns()).await;
    let (code, held) = connect(&fixture, "public.example:443").await;
    assert_eq!(code, 200);
    let (code, _) = connect(&fixture, "public.example:443").await;
    assert_eq!(code, 503, "a second concurrent connection exceeds the cap");
    drop(held);

    let addr = fixture.broker.local_addr();
    drop(fixture);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "the listener must close when the broker handle is dropped"
    );
}

#[tokio::test]
async fn broker_lifetime_is_bounded() {
    let mut short = policy(None);
    short.lifetime = Duration::from_millis(100);
    let fixture = fixture_with(short, default_dns()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(TcpStream::connect(fixture.broker.local_addr())
        .await
        .is_err());
}

#[test]
fn broker_env_sets_proxies_and_removes_exemptions() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let fixture = runtime.block_on(new_fixture());
    let mut env = std::collections::BTreeMap::from([
        ("NO_PROXY".to_owned(), "*".to_owned()),
        ("no_proxy".to_owned(), "*".to_owned()),
        ("REQUEST_METHOD".to_owned(), "GET".to_owned()),
        ("HTTPS_PROXY".to_owned(), "http://evil.example:1".to_owned()),
    ]);
    fixture.broker.apply_to_env(&mut env);
    let url = fixture.broker.proxy_url();
    assert!(url.starts_with("http://ryu:") && url.contains("@127.0.0.1:"));
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        assert_eq!(env.get(key), Some(&url), "{key}");
    }
    for key in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
        assert!(!env.contains_key(key), "{key}");
    }
}
