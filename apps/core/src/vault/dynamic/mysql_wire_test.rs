//! MySQL wire tests against a fake server that verifies scrambles the way a
//! real server does (from the stored password hash, not by recomputing the
//! client's formula).

use super::*;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

pub(crate) const PASSWORD: &str = "adm1n-s3cret";

/// How the fake server authenticates.
#[derive(Clone, Copy)]
pub(crate) struct FakeMysql {
    pub plugin: &'static str,
    /// Answer the first response with an auth switch to this plugin.
    pub switch_to: Option<&'static str>,
    /// `caching_sha2_password` asks for a full login (needs TLS).
    pub full_auth: bool,
}

impl FakeMysql {
    pub(crate) const NATIVE: Self = Self {
        plugin: "mysql_native_password",
        switch_to: None,
        full_auth: false,
    };
}

/// Check a scramble from the server's side: it knows only the stored hash.
fn server_accepts(plugin: &str, nonce: &[u8], response: &[u8]) -> bool {
    match plugin {
        "mysql_native_password" => {
            let stored = Sha1::digest(Sha1::digest(PASSWORD.as_bytes()));
            let mut hasher = Sha1::new();
            hasher.update(nonce);
            hasher.update(stored);
            let stage1 = xor(response, &hasher.finalize());
            Sha1::digest(&stage1)[..] == stored[..]
        }
        "caching_sha2_password" => {
            let stored = Sha256::digest(Sha256::digest(PASSWORD.as_bytes()));
            let mut hasher = Sha256::new();
            hasher.update(stored);
            hasher.update(nonce);
            let stage1 = xor(response, &hasher.finalize());
            Sha256::digest(&stage1)[..] == stored[..]
        }
        _ => false,
    }
}

fn ok_packet() -> Vec<u8> {
    vec![0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]
}

fn err_packet(code: u16, message: &str) -> Vec<u8> {
    let mut packet = vec![0xFF];
    packet.extend_from_slice(&code.to_le_bytes());
    packet.extend_from_slice(b"#42000");
    packet.extend_from_slice(message.as_bytes());
    packet
}

const NONCE: &[u8; 20] = b"abcdefghijklmnopqrst";

fn handshake(plugin: &str) -> Vec<u8> {
    let caps = CLIENT_LONG_PASSWORD
        | CLIENT_CONNECT_WITH_DB
        | CLIENT_PROTOCOL_41
        | CLIENT_TRANSACTIONS
        | CLIENT_SECURE_CONNECTION
        | CLIENT_MULTI_RESULTS
        | CLIENT_PLUGIN_AUTH
        | CLIENT_PLUGIN_AUTH_LENENC;
    let mut packet = vec![10];
    packet.extend_from_slice(b"8.0.36-fake\0");
    packet.extend_from_slice(&7u32.to_le_bytes());
    packet.extend_from_slice(&NONCE[..8]);
    packet.push(0);
    packet.extend_from_slice(&(caps as u16).to_le_bytes());
    packet.push(CHARSET);
    packet.extend_from_slice(&2u16.to_le_bytes());
    packet.extend_from_slice(&((caps >> 16) as u16).to_le_bytes());
    packet.push(21);
    packet.extend_from_slice(&[0; 10]);
    packet.extend_from_slice(&NONCE[8..]);
    packet.push(0);
    packet.extend_from_slice(plugin.as_bytes());
    packet.push(0);
    packet
}

/// Parse a HandshakeResponse41: user, auth response, database.
fn parse_response(packet: &[u8]) -> (String, Vec<u8>, Option<String>) {
    let caps = u32::from_le_bytes(packet[..4].try_into().unwrap());
    let mut at = 32;
    let end = at + packet[at..].iter().position(|&b| b == 0).unwrap();
    let user = String::from_utf8_lossy(&packet[at..end]).into_owned();
    at = end + 1;
    let len = packet[at] as usize;
    let auth = packet[at + 1..at + 1 + len].to_vec();
    at += 1 + len;
    let database = (caps & CLIENT_CONNECT_WITH_DB != 0).then(|| {
        let end = at + packet[at..].iter().position(|&b| b == 0).unwrap();
        String::from_utf8_lossy(&packet[at..end]).into_owned()
    });
    (user, auth, database)
}

async fn serve(
    mut socket: tokio::net::TcpStream,
    mode: FakeMysql,
    log: Arc<Mutex<Vec<String>>>,
) -> Result<()> {
    let mut seq = 0u8;
    write_raw(&mut socket, &mut seq, &handshake(mode.plugin)).await?;
    let (user, mut auth, database) = parse_response(&read_raw(&mut socket, &mut seq).await?);
    log.lock()
        .unwrap()
        .push(format!("login {user} {}", database.unwrap_or_default()));
    let mut plugin = mode.plugin;
    if let Some(switch) = mode.switch_to {
        let mut packet = vec![0xFE];
        packet.extend_from_slice(switch.as_bytes());
        packet.push(0);
        packet.extend_from_slice(NONCE);
        packet.push(0);
        write_raw(&mut socket, &mut seq, &packet).await?;
        auth = read_raw(&mut socket, &mut seq).await?;
        plugin = switch;
    }
    if plugin == "caching_sha2_password" && mode.full_auth {
        write_raw(&mut socket, &mut seq, &[0x01, 0x04]).await?;
        let _ = read_raw(&mut socket, &mut seq).await;
        return Ok(());
    }
    if user != "admin" || !server_accepts(plugin, NONCE, &auth) {
        write_raw(
            &mut socket,
            &mut seq,
            &err_packet(1045, "Access denied for user"),
        )
        .await?;
        return Ok(());
    }
    if plugin == "caching_sha2_password" {
        write_raw(&mut socket, &mut seq, &[0x01, 0x03]).await?;
    }
    write_raw(&mut socket, &mut seq, &ok_packet()).await?;
    loop {
        let packet = read_raw(&mut socket, &mut seq).await?;
        if packet.first() != Some(&0x03) {
            return Ok(());
        }
        let sql = String::from_utf8_lossy(&packet[1..]).into_owned();
        log.lock().unwrap().push(sql.clone());
        if sql.contains("FAIL") {
            let message = format!("You have an error in your SQL syntax near '{sql}'");
            write_raw(&mut socket, &mut seq, &err_packet(1064, &message)).await?;
        } else if sql.starts_with("SELECT") {
            for part in [
                &[1u8][..],
                b"\x03def\x00\x00\x00\x01a\x00",
                &[0xFE, 0, 0, 0, 0],
                b"\x011",
                &[0xFE, 0, 0, 2, 0],
            ] {
                write_raw(&mut socket, &mut seq, part).await?;
            }
        } else {
            write_raw(&mut socket, &mut seq, &ok_packet()).await?;
        }
    }
}

/// Start a fake MySQL server; returns a `mysql://admin:…@host/app` URL and
/// the log of logins and statements.
pub(crate) async fn fake_mysql(mode: FakeMysql) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let recorded = log.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve(socket, mode, recorded.clone()));
        }
    });
    (
        format!("mysql://admin:{PASSWORD}@{address}/app?ssl-mode=disabled"),
        log,
    )
}

#[test]
fn urls_parse_into_targets() {
    let target = Target::parse("mysql://root:p%40ss@db.example.com/app?ssl-mode=REQUIRED").unwrap();
    assert_eq!(target.host, "db.example.com");
    assert_eq!(target.port, 3306);
    assert_eq!(target.password, "p@ss");
    assert_eq!(target.database.as_deref(), Some("app"));
    assert_eq!(target.ssl, SslMode::Required);
    assert_eq!(
        Target::parse("mariadb://u@h:3307").unwrap().ssl,
        SslMode::Preferred
    );
    assert!(Target::parse("postgres://u@h").is_err());
    assert!(Target::parse("mysql://u@h?ssl-mode=sometimes").is_err());
}

#[test]
fn handshakes_parse_and_errors_read_cleanly() {
    let parsed = parse_handshake(&handshake("caching_sha2_password")).unwrap();
    assert_eq!(parsed.nonce, NONCE);
    assert_eq!(parsed.plugin, "caching_sha2_password");
    assert_eq!(
        parse_error(&err_packet(1045, "Access denied")),
        "[1045] Access denied"
    );
    assert!(parse_handshake(&err_packet(1040, "Too many connections")).is_err());
}

#[tokio::test]
async fn both_plugins_and_auth_switches_log_in() {
    for mode in [
        FakeMysql::NATIVE,
        FakeMysql {
            plugin: "caching_sha2_password",
            ..FakeMysql::NATIVE
        },
        FakeMysql {
            plugin: "caching_sha2_password",
            switch_to: Some("mysql_native_password"),
            full_auth: false,
        },
    ] {
        let (url, log) = fake_mysql(mode).await;
        let mut connection = Connection::open(&Target::parse(&url).unwrap(), TargetEgress::Trusted)
            .await
            .unwrap();
        connection.query("SELECT 1").await.unwrap();
        connection.query("CREATE USER 'x'@'%'").await.unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            ["login admin app", "SELECT 1", "CREATE USER 'x'@'%'"]
        );
    }
}

#[tokio::test]
async fn wrong_passwords_and_plaintext_full_logins_fail() {
    let (url, _) = fake_mysql(FakeMysql::NATIVE).await;
    let wrong = url.replace(PASSWORD, "nope");
    let error = Connection::open(&Target::parse(&wrong).unwrap(), TargetEgress::Trusted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("[1045]"), "{error}");
    let (url, _) = fake_mysql(FakeMysql {
        plugin: "caching_sha2_password",
        switch_to: None,
        full_auth: true,
    })
    .await;
    let error = Connection::open(&Target::parse(&url).unwrap(), TargetEgress::Trusted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("needs TLS"), "{error}");
}

#[tokio::test]
async fn screened_connections_refuse_loopback() {
    let (url, log) = fake_mysql(FakeMysql::NATIVE).await;
    assert!(
        Connection::open(&Target::parse(&url).unwrap(), TargetEgress::Screened)
            .await
            .is_err()
    );
    assert!(log.lock().unwrap().is_empty());
}
