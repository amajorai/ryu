//! Ollama Cloud subscription usage from Ollama's existing local signing key.
//!
//! The provider endpoint is undocumented. This reader follows OpenUsage's
//! current integration: read Ollama's unencrypted OpenSSH Ed25519 key, sign the
//! fixed usage request in memory, and send only the public key and signature.
//! It never creates, refreshes, or writes provider credentials.

use std::io::Read;

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use reqwest::Url;
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use super::{
    credential_http_client, read_json_limited, UsageMeter, UsageSnapshot, UsageUnavailable,
    UsageValue, UsageValueKind, UsageWindow,
};

const USAGE_URL: &str = "https://ollama.com/api/usage";
const OPENSSH_MAGIC: &[u8] = b"openssh-key-v1\0";
const OPENSSH_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END: &str = "-----END OPENSSH PRIVATE KEY-----";
const ED25519_KEY_TYPE: &[u8] = b"ssh-ed25519";
const MAX_PRIVATE_KEY_BYTES: usize = 16 * 1024;
const SESSION_SECONDS: i64 = 5 * 60 * 60;
const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;

struct OllamaKey {
    signing_key: SigningKey,
    public_key_blob: Vec<u8>,
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "ollama", reason);
    let private_key = match tokio::task::spawn_blocking(read_private_key).await {
        Ok(Some(private_key)) => private_key,
        Ok(None) => return unavailable(UsageUnavailable::NotLoggedIn),
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let Some(key) = parse_private_key(&private_key) else {
        return unavailable(UsageUnavailable::Error);
    };
    fetch_with_key(agent_id, &key, USAGE_URL).await
}

async fn fetch_with_key(agent_id: &str, key: &OllamaKey, usage_url: &str) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "ollama", reason);
    let client = match credential_http_client() {
        Ok(client) => client,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let timestamp = chrono::Utc::now().timestamp();
    let (url, request_uri) = match signed_usage_url(usage_url, timestamp) {
        Some(url) => url,
        None => return unavailable(UsageUnavailable::Error),
    };
    let authorization = key.authorization_header(&request_uri);
    let response = match client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "Ryu")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !response.status().is_success() {
        let mut snapshot = unavailable(match response.status().as_u16() {
            401 | 403 => UsageUnavailable::NotLoggedIn,
            429 => UsageUnavailable::RateLimited,
            _ => UsageUnavailable::Error,
        });
        snapshot.retry_after_seconds = super::retry_after_seconds(response.headers());
        return snapshot;
    }
    let body = match read_json_limited(response).await {
        Ok(body) => body,
        Err(()) => return unavailable(UsageUnavailable::Error),
    };
    match map_response(agent_id, &body) {
        Ok(snapshot) => snapshot,
        Err(reason) => unavailable(reason),
    }
}

fn signed_usage_url(base: &str, timestamp: i64) -> Option<(Url, String)> {
    let mut url = Url::parse(base).ok()?;
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    url.query_pairs_mut()
        .append_pair("ts", &timestamp.to_string());
    let query = url.query()?;
    Some((url.clone(), format!("{}?{query}", url.path())))
}

fn read_private_key() -> Option<Zeroizing<Vec<u8>>> {
    let path = dirs::home_dir()?.join(".ollama").join("id_ed25519");
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take((MAX_PRIVATE_KEY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_PRIVATE_KEY_BYTES).then_some(bytes)
}

fn parse_private_key(pem: &[u8]) -> Option<OllamaKey> {
    if pem.is_empty() || pem.len() > MAX_PRIVATE_KEY_BYTES {
        return None;
    }
    let text = std::str::from_utf8(pem).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim() != OPENSSH_BEGIN {
        return None;
    }

    let mut encoded = Zeroizing::new(String::new());
    let mut found_end = false;
    for line in lines.by_ref() {
        let line = line.trim();
        if line == OPENSSH_END {
            found_end = true;
            break;
        }
        if line.is_empty()
            || !line
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            || encoded.len().saturating_add(line.len()) > MAX_PRIVATE_KEY_BYTES
        {
            return None;
        }
        encoded.push_str(line);
    }
    if !found_end || lines.any(|line| !line.trim().is_empty()) {
        return None;
    }

    let decoded = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str())
            .ok()?,
    );
    if decoded.len() > MAX_PRIVATE_KEY_BYTES || !decoded.starts_with(OPENSSH_MAGIC) {
        return None;
    }

    let mut container = &decoded[OPENSSH_MAGIC.len()..];
    if read_ssh_string(&mut container)? != b"none"
        || read_ssh_string(&mut container)? != b"none"
        || !read_ssh_string(&mut container)?.is_empty()
        || read_ssh_u32(&mut container)? != 1
    {
        return None;
    }
    let public_key_blob = read_ssh_string(&mut container)?;
    let private_block = read_ssh_string(&mut container)?;
    if !container.is_empty() {
        return None;
    }

    let mut public_fields = public_key_blob;
    if read_ssh_string(&mut public_fields)? != ED25519_KEY_TYPE {
        return None;
    }
    let public_key = read_ssh_string(&mut public_fields)?;
    if public_key.len() != 32 || !public_fields.is_empty() {
        return None;
    }

    let mut private_fields = private_block;
    if private_block.len() % 8 != 0
        || read_ssh_u32(&mut private_fields)? != read_ssh_u32(&mut private_fields)?
        || read_ssh_string(&mut private_fields)? != ED25519_KEY_TYPE
    {
        return None;
    }
    let private_public_key = read_ssh_string(&mut private_fields)?;
    let private_key_data = read_ssh_string(&mut private_fields)?;
    let _comment = read_ssh_string(&mut private_fields)?;
    if private_public_key != public_key
        || private_key_data.len() != 64
        || private_key_data.get(32..)? != public_key
        || private_fields.is_empty()
        || private_fields.len() > 8
        || private_fields
            .iter()
            .enumerate()
            .any(|(index, byte)| *byte != (index + 1) as u8)
    {
        return None;
    }

    let mut seed: [u8; 32] = private_key_data[..32].try_into().ok()?;
    let signing_key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    if signing_key.verifying_key().to_bytes().as_slice() != public_key {
        return None;
    }

    Some(OllamaKey {
        signing_key,
        public_key_blob: public_key_blob.to_vec(),
    })
}

fn read_ssh_u32(input: &mut &[u8]) -> Option<u32> {
    if input.len() < 4 {
        return None;
    }
    let (length, rest) = input.split_at(4);
    *input = rest;
    Some(u32::from_be_bytes(length.try_into().ok()?))
}

fn read_ssh_string<'a>(input: &mut &'a [u8]) -> Option<&'a [u8]> {
    let length = usize::try_from(read_ssh_u32(input)?).ok()?;
    if length > MAX_PRIVATE_KEY_BYTES || length > input.len() {
        return None;
    }
    let (value, rest) = input.split_at(length);
    *input = rest;
    Some(value)
}

impl OllamaKey {
    fn authorization_header(&self, request_uri: &str) -> String {
        let message = format!("GET,{request_uri}");
        let signature = self.signing_key.sign(message.as_bytes());
        format!(
            "{}:{}",
            base64::engine::general_purpose::STANDARD.encode(&self.public_key_blob),
            base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
        )
    }
}

fn map_response(agent_id: &str, body: &Value) -> Result<UsageSnapshot, UsageUnavailable> {
    let limits = body
        .get("limits")
        .and_then(Value::as_object)
        .ok_or(UsageUnavailable::Error)?;
    let mut windows = Vec::new();
    for (field, label, window_seconds) in [
        ("session", "Session", SESSION_SECONDS),
        ("weekly", "Weekly", WEEK_SECONDS),
    ] {
        let Some(raw_window) = limits.get(field) else {
            continue;
        };
        if raw_window.is_null() {
            continue;
        }
        let raw_usage = raw_window.get("usage").unwrap_or(raw_window);
        let Some(fraction) = raw_usage
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        else {
            continue;
        };
        windows.push(UsageWindow {
            label: label.to_owned(),
            used_percent: fraction * 100.0,
            resets_at: None,
            window_seconds: Some(window_seconds),
            model: None,
        });
    }
    if windows.is_empty() {
        return Err(UsageUnavailable::Error);
    }

    let mut snapshot = UsageSnapshot::available(agent_id, "ollama", None);
    snapshot.windows = windows;
    if let Some(cost) = last_four_weeks_cost(body) {
        snapshot.meters.push(UsageMeter::new(
            "Last 4 weeks",
            vec![UsageValue::new(cost, UsageValueKind::Dollars, None)],
        ));
    }
    Ok(snapshot)
}

fn last_four_weeks_cost(body: &Value) -> Option<f64> {
    let cost = body
        .get("activity")
        .and_then(Value::as_object)
        .and_then(|activity| activity.get("cost"))
        .or_else(|| body.get("cost"))?;
    let value = cost
        .as_f64()
        .or_else(|| cost.as_str()?.trim().parse::<f64>().ok())?;
    (value.is_finite() && value >= 0.0).then_some(value)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use ed25519_dalek::{Signature, Verifier};

    use super::*;

    const TEST_PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
QyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYgAAAJgAIAxdACAM\n\
XQAAAAtzc2gtZWQyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYg\n\
AAAEC2BsIi0QwW2uFscKTUUXNHLsYX4FxlaSDSblbAj7WR7bM+rvN+ot98qgEN796jTiQf\n\
ZfG1KaT0PtFDJ/XFSqtiAAAAEHVzZXJAZXhhbXBsZS5jb20BAgMEBQ==\n\
-----END OPENSSH PRIVATE KEY-----\n";

    const USAGE_BODY: &str = r#"{
        "limits": {
            "session": { "usage": 0.349 },
            "weekly": { "usage": 0.12 }
        },
        "activity": { "cost": "2.75" }
    }"#;

    #[test]
    fn parses_ollamas_existing_openssh_ed25519_key_and_signs_exact_request() {
        let key = parse_private_key(TEST_PRIVATE_KEY.as_bytes()).expect("test private key");
        let request_uri = "/api/usage?ts=42";
        let authorization = key.authorization_header(request_uri);
        let (public_key, signature) = authorization.split_once(':').expect("header fields");
        let public_key_blob = base64::engine::general_purpose::STANDARD
            .decode(public_key)
            .unwrap();
        assert_eq!(public_key_blob, key.public_key_blob);

        let signature = base64::engine::general_purpose::STANDARD
            .decode(signature)
            .unwrap();
        let signature = Signature::from_slice(&signature).unwrap();
        key.signing_key
            .verifying_key()
            .verify(format!("GET,{request_uri}").as_bytes(), &signature)
            .unwrap();
        assert!(key
            .signing_key
            .verifying_key()
            .verify(b"GET,/api/usage?ts=43", &signature)
            .is_err());
    }

    #[test]
    fn refuses_malformed_and_encrypted_keys() {
        assert!(parse_private_key(b"not a key").is_none());
        assert!(parse_private_key(
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nAA==\n-----END OPENSSH PRIVATE KEY-----"
        )
        .is_none());
        let encoded = TEST_PRIVATE_KEY
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let mut encrypted_blob = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let cipher_name_start = OPENSSH_MAGIC.len() + 4;
        encrypted_blob[cipher_name_start..cipher_name_start + 4].copy_from_slice(b"fail");
        let encrypted = format!(
            "{OPENSSH_BEGIN}\n{}\n{OPENSSH_END}",
            base64::engine::general_purpose::STANDARD.encode(encrypted_blob)
        );
        assert!(parse_private_key(encrypted.as_bytes()).is_none());
    }

    #[test]
    fn maps_fractional_windows_without_guessing_reset_times() {
        let body: Value = serde_json::from_str(USAGE_BODY).unwrap();
        let snapshot = map_response("acp:ollama", &body).unwrap();
        assert!(snapshot.available);
        assert_eq!(snapshot.engine, "ollama");
        assert_eq!(snapshot.plan, None);
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].used_percent, 34.9);
        assert_eq!(snapshot.windows[0].window_seconds, Some(SESSION_SECONDS));
        assert_eq!(snapshot.windows[0].resets_at, None);
        assert_eq!(snapshot.windows[1].used_percent, 12.0);
        assert_eq!(snapshot.windows[1].window_seconds, Some(WEEK_SECONDS));
        assert_eq!(snapshot.meters[0].label, "Last 4 weeks");
        assert_eq!(snapshot.meters[0].values[0].number, 2.75);
    }

    #[test]
    fn invalid_fractions_and_missing_limits_are_rejected() {
        for body in [
            serde_json::json!({ "limits": { "session": { "usage": 1.01 } } }),
            serde_json::json!({ "limits": {} }),
            serde_json::json!({ "activity": { "cost": "1.25" } }),
        ] {
            assert!(matches!(
                map_response("acp:ollama", &body),
                Err(UsageUnavailable::Error)
            ));
        }
    }

    #[test]
    fn malformed_window_does_not_hide_another_valid_window() {
        let body = serde_json::json!({
            "limits": {
                "session": {"usage": "not-a-fraction"},
                "weekly": {"usage": 0.12}
            }
        });

        let snapshot = map_response("acp:ollama", &body).unwrap();

        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].label, "Weekly");
        assert_eq!(snapshot.windows[0].used_percent, 12.0);
    }

    #[tokio::test]
    async fn fetches_over_https_shape_with_signed_read_only_request() {
        let key = parse_private_key(TEST_PRIVATE_KEY.as_bytes()).unwrap();
        let (url, request_rx) = spawn_capture(USAGE_BODY);
        let snapshot = fetch_with_key("acp:ollama", &key, &url).await;
        let request = request_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("request captured");
        let request_line = request.lines().next().unwrap();
        assert!(request_line.starts_with("GET /api/usage?ts="));
        let request_uri = request_line.split_whitespace().nth(1).unwrap();
        let authorization = request
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
            .and_then(|line| line.split_once(':'))
            .map(|(_, value)| value.trim())
            .expect("authorization header");
        let (_, signature) = authorization.split_once(':').unwrap();
        let signature = base64::engine::general_purpose::STANDARD
            .decode(signature)
            .unwrap();
        let signature = Signature::from_slice(&signature).unwrap();
        key.signing_key
            .verifying_key()
            .verify(format!("GET,{request_uri}").as_bytes(), &signature)
            .unwrap();
        assert!(!request.contains(OPENSSH_BEGIN));
        assert!(snapshot.available);
        assert_eq!(snapshot.windows.len(), 2);
    }

    fn spawn_capture(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let Ok(read) = stream.read(&mut chunk) else {
                    return;
                };
                if read == 0 || request.len().saturating_add(read) > 16 * 1024 {
                    return;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (format!("http://{address}/api/usage"), request_rx)
    }
}
