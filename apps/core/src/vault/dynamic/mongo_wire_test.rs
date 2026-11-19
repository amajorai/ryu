//! MongoDB wire tests against a fake server that checks SCRAM-SHA-256 proofs
//! from its stored keys, as mongod does.

use super::*;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

pub(crate) const PASSWORD: &str = "adm1n-s3cret";
const SALT: &[u8] = b"0123456789abcdef";

/// Commands the fake server saw after authenticating.
pub(crate) type Log = Arc<Mutex<Vec<Doc>>>;

fn reply_ok(mut fields: Doc) -> Doc {
    fields.push(("ok".into(), Bson::Double(1.0)));
    fields
}

fn reply_err(code: i32, message: &str) -> Doc {
    vec![
        ("ok".into(), Bson::Double(0.0)),
        ("errmsg".into(), s(message)),
        ("code".into(), Bson::Int32(code)),
    ]
}

async fn read_command(socket: &mut tokio::net::TcpStream) -> Result<(i32, Doc)> {
    let mut header = [0u8; 16];
    socket.read_exact(&mut header).await?;
    let len = i32::from_le_bytes(header[..4].try_into()?) as usize;
    let id = i32::from_le_bytes(header[4..8].try_into()?);
    let mut rest = vec![0u8; len - 16];
    socket.read_exact(&mut rest).await?;
    Ok((id, decode(&rest[5..])?))
}

async fn write_reply(socket: &mut tokio::net::TcpStream, to: i32, doc: &Doc) -> Result<()> {
    let body = encode(doc);
    let mut message = ((body.len() + 21) as i32).to_le_bytes().to_vec();
    message.extend_from_slice(&99i32.to_le_bytes());
    message.extend_from_slice(&to.to_le_bytes());
    message.extend_from_slice(&OP_MSG.to_le_bytes());
    message.extend_from_slice(&0u32.to_le_bytes());
    message.push(0);
    message.extend(body);
    socket.write_all(&message).await?;
    Ok(())
}

fn binary(doc: &Doc, key: &str) -> String {
    match get(doc, key) {
        Some(Bson::Binary(bytes)) => String::from_utf8(bytes.clone()).unwrap(),
        _ => String::new(),
    }
}

async fn serve(mut socket: tokio::net::TcpStream, forge_signature: bool, log: Log) -> Result<()> {
    let salted = pbkdf2(PASSWORD.as_bytes(), SALT, 4096);
    let stored_key = Sha256::digest(hmac(&salted, b"Client Key"));
    let server_key = hmac(&salted, b"Server Key");
    let mut auth_message = String::new();
    let mut authenticated = false;
    loop {
        let (id, command) = read_command(&mut socket).await?;
        let name = command
            .first()
            .map(|(key, _)| key.as_str())
            .unwrap_or_default();
        let reply = match name {
            "saslStart" => {
                let first = binary(&command, "payload");
                let bare = first.trim_start_matches("n,,").to_owned();
                let nonce = attribute(&bare, 'r').unwrap_or_default();
                let server_first = format!("r={nonce}srv,s={},i=4096", b64().encode(SALT));
                auth_message = format!("{bare},{server_first}");
                reply_ok(vec![
                    ("conversationId".into(), Bson::Int32(1)),
                    ("done".into(), Bson::Bool(false)),
                    ("payload".into(), Bson::Binary(server_first.into_bytes())),
                ])
            }
            "saslContinue" => {
                let last = binary(&command, "payload");
                let (without_proof, proof) = last.rsplit_once(",p=").unwrap_or_default();
                auth_message = format!("{auth_message},{without_proof}");
                let signature = hmac(&stored_key, auth_message.as_bytes());
                let client_key: Vec<u8> = b64()
                    .decode(proof)
                    .unwrap_or_default()
                    .iter()
                    .zip(&signature)
                    .map(|(a, b)| a ^ b)
                    .collect();
                if Sha256::digest(&client_key) != stored_key {
                    reply_err(18, "Authentication failed.")
                } else {
                    authenticated = true;
                    let key = if forge_signature {
                        b"forged".to_vec()
                    } else {
                        server_key.clone()
                    };
                    let verifier =
                        format!("v={}", b64().encode(hmac(&key, auth_message.as_bytes())));
                    reply_ok(vec![
                        ("conversationId".into(), Bson::Int32(1)),
                        ("done".into(), Bson::Bool(true)),
                        ("payload".into(), Bson::Binary(verifier.into_bytes())),
                    ])
                }
            }
            _ if !authenticated => reply_err(13, "requires authentication"),
            "dropUser" if matches!(get(&command, "dropUser"), Some(Bson::String(user)) if user == "missing") => {
                reply_err(11, "User not found")
            }
            "createUser" if format!("{command:?}").contains("boom") => {
                reply_err(31, "No role named boom")
            }
            _ => {
                log.lock().unwrap().push(command.clone());
                reply_ok(vec![])
            }
        };
        write_reply(&mut socket, id, &reply).await?;
    }
}

/// Start a fake mongod; returns a `mongodb://admin:…@host/?authSource=admin`
/// URL and the commands it ran.
pub(crate) async fn fake_mongo(forge_signature: bool) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let log: Log = Arc::default();
    let recorded = log.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve(socket, forge_signature, recorded.clone()));
        }
    });
    (
        format!("mongodb://admin:{PASSWORD}@{address}/?authSource=admin"),
        log,
    )
}

#[test]
fn pbkdf2_matches_the_rfc_vectors() {
    // RFC 7914 §11 / the common PBKDF2-HMAC-SHA256 test vectors.
    assert_eq!(
        hex::encode(pbkdf2(b"password", b"salt", 1)),
        "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
    );
    assert_eq!(
        hex::encode(pbkdf2(b"password", b"salt", 4096)),
        "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
    );
}

#[test]
fn urls_parse_into_targets() {
    let target = Target::parse("mongodb://root:p%40ss@db.example.com/app?tls=true").unwrap();
    assert_eq!((target.port, target.tls), (27017, true));
    assert_eq!(target.password, "p@ss");
    assert_eq!(target.auth_source, "app");
    let target = Target::parse("mongodb://u:p@h:27018/app?authSource=admin").unwrap();
    assert_eq!((target.auth_source.as_str(), target.tls), ("admin", false));
    assert!(Target::parse("mongodb+srv://u:p@cluster.example.com").is_err());
    assert!(Target::parse("mongodb://u:p@a:1,b:2/").is_err());
    assert!(Target::parse("postgres://u@h").is_err());
}

#[tokio::test]
async fn scram_logs_in_and_commands_run() {
    let (url, log) = fake_mongo(false).await;
    let mut connection = Connection::open(&Target::parse(&url).unwrap(), TargetEgress::Trusted)
        .await
        .unwrap();
    connection
        .command(
            vec![("ping".into(), Bson::Int32(1)), ("$db".into(), s("admin"))],
            &[],
        )
        .await
        .unwrap();
    assert_eq!(log.lock().unwrap().len(), 1);
    let error = connection
        .command(
            vec![
                ("dropUser".into(), s("missing")),
                ("$db".into(), s("admin")),
            ],
            &[],
        )
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(error, "mongodb dropUser failed: [11] User not found");
    connection
        .command(
            vec![
                ("dropUser".into(), s("missing")),
                ("$db".into(), s("admin")),
            ],
            &[11],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn wrong_passwords_and_forged_servers_fail() {
    let (url, _) = fake_mongo(false).await;
    let wrong = url.replace(PASSWORD, "nope");
    let error = Connection::open(&Target::parse(&wrong).unwrap(), TargetEgress::Trusted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("Authentication failed"), "{error}");
    let (url, _) = fake_mongo(true).await;
    let error = Connection::open(&Target::parse(&url).unwrap(), TargetEgress::Trusted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("signature does not match"), "{error}");
}
