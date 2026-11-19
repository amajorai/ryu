//! SQL Server wire tests against a fake server that speaks plaintext TDS,
//! TDS 7.4 with TLS inside PRELOGIN (TLS 1.2, as SQL Server does), and
//! TDS 8.0 strict TLS.

use super::*;
use crate::vault::dynamic::mssql_tds::tests::{
    batch_sql, done, error_token, login7_fields, loginack, prelogin_reply,
};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use std::sync::Mutex;
use tokio::net::TcpListener;

pub(crate) const PASSWORD: &str = "Adm1n-s3cret";

/// How the fake server encrypts.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Plain { require: bool },
    Prelogin,
    Strict,
}

/// A test CA and a server certificate for 127.0.0.1.
pub(crate) struct TestCert {
    pub ca_pem: String,
    chain: Vec<rustls::pki_types::CertificateDer<'static>>,
    key: Vec<u8>,
}

pub(crate) fn test_cert() -> TestCert {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "Test SQL CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);
    let key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["127.0.0.1".to_owned()])
        .unwrap()
        .signed_by(&key, &issuer)
        .unwrap();
    TestCert {
        ca_pem: ca.pem(),
        chain: vec![leaf.der().clone()],
        key: key.serialize_der(),
    }
}

fn server_config(cert: &TestCert, strict: bool) -> Arc<rustls::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ServerConfig::builder_with_provider(provider);
    let builder = if strict {
        builder.with_safe_default_protocol_versions()
    } else {
        builder.with_protocol_versions(&[&rustls::version::TLS12])
    }
    .unwrap();
    let mut config = builder
        .with_no_client_auth()
        .with_single_cert(
            cert.chain.clone(),
            rustls::pki_types::PrivateKeyDer::Pkcs8(cert.key.clone().into()),
        )
        .unwrap();
    if strict {
        config.alpn_protocols = vec![b"tds/8.0".to_vec()];
    }
    Arc::new(config)
}

async fn reply(transport: &mut Transport, tokens: Vec<u8>) -> Result<()> {
    transport
        .write_all(&tds::packets(tds::TYPE_REPLY, &tokens))
        .await
}

async fn serve(
    tcp: TcpStream,
    mode: Mode,
    config: Arc<rustls::ServerConfig>,
    log: Arc<Mutex<Vec<String>>>,
) -> Result<()> {
    let server = || -> Result<rustls::Connection> {
        Ok(rustls::ServerConnection::new(config.clone())?.into())
    };
    let mut transport = if mode == Mode::Strict {
        let mut link = TlsLink {
            tcp,
            tls: server()?,
        };
        link.handshake_raw().await?;
        let alpn = link.tls.alpn_protocol().map(<[u8]>::to_vec);
        log.lock().unwrap().push(format!(
            "alpn {}",
            String::from_utf8_lossy(&alpn.unwrap_or_default())
        ));
        let mut transport = Transport::Tls(Box::new(link));
        transport.read_message().await?;
        reply(&mut transport, prelogin_reply(tds::ENCRYPT_ON)).await?;
        transport
    } else {
        let mut transport = Transport::Plain(tcp);
        let (_, ask) = transport.read_message().await?;
        let ask = tds::prelogin_encryption(&ask)?;
        let answer = match mode {
            Mode::Plain { require: true } => tds::ENCRYPT_REQ,
            Mode::Plain { require: false } => tds::ENCRYPT_NOT_SUP,
            _ if ask == tds::ENCRYPT_NOT_SUP => tds::ENCRYPT_REQ,
            _ => tds::ENCRYPT_ON,
        };
        reply(&mut transport, prelogin_reply(answer)).await?;
        if answer != tds::ENCRYPT_ON {
            transport
        } else {
            let Transport::Plain(tcp) = transport else {
                unreachable!()
            };
            let mut link = TlsLink {
                tcp,
                tls: server()?,
            };
            loop {
                let (_, payload) = read_message_plain(&mut link.tcp).await?;
                link.absorb(&payload)?;
                let mut out = Vec::new();
                while link.tls.wants_write() {
                    link.tls.write_tls(&mut out)?;
                }
                if !out.is_empty() {
                    link.tcp
                        .write_all(&tds::packets(tds::TYPE_PRELOGIN, &out))
                        .await?;
                }
                if !link.tls.is_handshaking() {
                    break;
                }
            }
            Transport::Tls(Box::new(link))
        }
    };
    let (_, login) = transport.read_message().await?;
    let (user, password, database) = login7_fields(&login);
    log.lock().unwrap().push(format!("login {user} {database}"));
    if user != "sa" || password != PASSWORD {
        let mut tokens = error_token(18456, "Login failed for user 'sa'.");
        tokens.extend(done(true));
        return reply(&mut transport, tokens).await;
    }
    let mut tokens = loginack();
    tokens.extend(done(false));
    reply(&mut transport, tokens).await?;
    loop {
        let (_, message) = transport.read_message().await?;
        let sql = batch_sql(&message);
        log.lock().unwrap().push(sql.clone());
        let tokens = if sql.contains("FAIL") {
            let mut tokens = error_token(102, &format!("Incorrect syntax near '{sql}'."));
            tokens.extend(done(true));
            tokens
        } else if sql.starts_with("SELECT") {
            vec![0x81, 1, 0]
        } else {
            done(false)
        };
        reply(&mut transport, tokens).await?;
    }
}

/// Start a fake SQL Server; returns a `sqlserver://sa:…@127.0.0.1:port/app`
/// URL (with the `encrypt` the mode needs), the CA PEM, and the log.
pub(crate) async fn fake_mssql(mode: Mode) -> (String, String, Arc<Mutex<Vec<String>>>) {
    let cert = test_cert();
    let config = server_config(&cert, mode == Mode::Strict);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let recorded = log.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve(socket, mode, config.clone(), recorded.clone()));
        }
    });
    let encrypt = match mode {
        Mode::Plain { .. } => "false",
        Mode::Prelogin => "true",
        Mode::Strict => "strict",
    };
    (
        format!("sqlserver://sa:{PASSWORD}@{address}/app?encrypt={encrypt}"),
        cert.ca_pem,
        log,
    )
}

async fn open(url: &str, ca: Option<&str>) -> Result<Connection> {
    Connection::open(&Target::parse(url)?, ca, TargetEgress::Trusted).await
}

#[test]
fn urls_parse_into_targets() {
    let target = Target::parse("mssql://sa:p%40ss@db.example.com/app").unwrap();
    assert_eq!((target.port, target.encrypt), (1433, Encrypt::On));
    assert_eq!(
        (target.password.as_str(), target.database.as_str()),
        ("p@ss", "app")
    );
    assert_eq!(
        Target::parse("sqlserver://sa@h:1500?encrypt=strict")
            .unwrap()
            .database,
        "master"
    );
    assert_eq!(
        Target::parse("sqlserver://sa@h?encrypt=false")
            .unwrap()
            .encrypt,
        Encrypt::Off
    );
    assert!(Target::parse("sqlserver://h").is_err());
    assert!(Target::parse("sqlserver://sa@h?encrypt=maybe").is_err());
    assert!(Target::parse("mysql://sa@h").is_err());
}

#[tokio::test]
async fn every_transport_logs_in_and_runs_batches() {
    for mode in [Mode::Plain { require: false }, Mode::Prelogin, Mode::Strict] {
        let (url, ca, log) = fake_mssql(mode).await;
        let mut connection = open(&url, Some(&ca)).await.unwrap();
        connection
            .query("CREATE LOGIN [x] WITH PASSWORD = 'y'")
            .await
            .unwrap();
        let error = connection
            .query("SELECT name FROM sys.logins")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("return rows"), "{error}");
        let mut log = log.lock().unwrap().clone();
        if mode == Mode::Strict {
            assert_eq!(log.remove(0), "alpn tds/8.0");
        }
        assert_eq!(
            log[..2],
            ["login sa app", "CREATE LOGIN [x] WITH PASSWORD = 'y'"]
        );
    }
}

#[tokio::test]
async fn tls_needs_a_trusted_certificate() {
    let (url, _, log) = fake_mssql(Mode::Prelogin).await;
    let other = test_cert();
    assert!(open(&url, Some(&other.ca_pem)).await.is_err());
    assert!(
        log.lock().unwrap().is_empty(),
        "no login over an untrusted channel"
    );
}

#[tokio::test]
async fn encryption_mismatches_and_bad_logins_fail_clearly() {
    let (url, _, _) = fake_mssql(Mode::Plain { require: true }).await;
    let error = open(&url, None).await.err().unwrap().to_string();
    assert!(error.contains("requires encryption"), "{error}");
    let (url, _, _) = fake_mssql(Mode::Plain { require: false }).await;
    let error = open(&url.replace("encrypt=false", "encrypt=true"), None)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("does not support encryption"), "{error}");
    let error = open(&url.replace(PASSWORD, "wrong"), None)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("[18456]"), "{error}");
}
