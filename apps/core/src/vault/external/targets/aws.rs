//! AWS Secrets Manager: one secret holds the folder as a JSON object.
//!
//! Requests are the JSON 1.1 protocol (`POST /` with `X-Amz-Target`), signed
//! with Signature Version 4. A push reads the secret first and writes a new
//! version only when the JSON differs; a missing secret is created.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{connect, status_error, StoreCredentials, StoreRecord};
use crate::vault::external::client::join_remote_path;
use crate::vault::external::net;

const SERVICE: &str = "secretsmanager";
const CONTENT_TYPE: &str = "application/x-amz-json-1.1";
/// Secrets Manager's limit for one `SecretString`.
const MAX_SECRET_BYTES: usize = 64 * 1024;

/// The secret name: the store's prefix joined with the destination's path.
pub fn secret_name(store: &StoreRecord, remote_path: &str) -> String {
    join_remote_path(&[&store.path_prefix, remote_path])
        .map(|segments| segments.join("/"))
        .unwrap_or_default()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// The SigV4 signing key for `date` (`YYYYMMDD`).
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, service);
    hmac(&k_service, "aws4_request")
}

/// What one signed request carries.
pub struct Signed {
    pub amz_date: String,
    pub authorization: String,
}

/// Sign a `POST /` JSON request. `headers` are the lower-case headers to
/// sign besides `host` and `x-amz-date` (added here).
pub fn sign(
    credentials: &StoreCredentials,
    region: &str,
    host: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Signed> {
    let access_key = credentials
        .access_key_id
        .as_deref()
        .ok_or_else(|| anyhow!("the AWS store has no access key"))?;
    let secret = credentials
        .secret_access_key
        .as_deref()
        .ok_or_else(|| anyhow!("the AWS store has no secret access key"))?;
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = &amz_date[..8];
    let mut signed: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .chain([
            ("host".to_owned(), host.to_owned()),
            ("x-amz-date".to_owned(), amz_date.clone()),
        ])
        .collect();
    signed.sort();
    let canonical_headers: String = signed
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = signed
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!(
        "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{}",
        hex::encode(Sha256::digest(body))
    );
    let scope = format!("{date}/{region}/{SERVICE}/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let signature = hex::encode(hmac(&signing_key(secret, date, region, SERVICE), &to_sign));
    Ok(Signed {
        amz_date,
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
        ),
    })
}

/// An AWS JSON error type such as `ResourceNotFoundException`.
#[derive(Debug)]
struct AwsError {
    status: reqwest::StatusCode,
    kind: String,
}

struct Client<'a> {
    base: url::Url,
    http: reqwest::Client,
    host: String,
    region: &'a str,
    credentials: &'a StoreCredentials,
}

impl<'a> Client<'a> {
    async fn open(store: &'a StoreRecord, credentials: &'a StoreCredentials) -> Result<Self> {
        let region = store
            .options
            .region
            .as_deref()
            .ok_or_else(|| anyhow!("the AWS store has no region"))?;
        let (base, http) = connect(store).await?;
        let host_name = base.host_str().unwrap_or_default();
        let host = match base.port() {
            Some(port) => format!("{host_name}:{port}"),
            None => host_name.to_owned(),
        };
        Ok(Self {
            base,
            http,
            host,
            region,
            credentials,
        })
    }

    async fn call(&self, action: &str, payload: &Value) -> Result<Result<Value, AwsError>> {
        let body = serde_json::to_vec(payload)?;
        let target = format!("secretsmanager.{action}");
        let mut headers = vec![("content-type", CONTENT_TYPE), ("x-amz-target", &target)];
        let session_token = self
            .credentials
            .session_token
            .as_deref()
            .filter(|token| !token.trim().is_empty());
        if let Some(token) = session_token {
            headers.push(("x-amz-security-token", token));
        }
        let signed = sign(
            self.credentials,
            self.region,
            &self.host,
            &headers,
            &body,
            chrono::Utc::now(),
        )?;
        let mut request = self
            .http
            .post(self.base.clone())
            .header("X-Amz-Date", signed.amz_date)
            .header(reqwest::header::AUTHORIZATION, signed.authorization)
            .body(body);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("AWS {action}"))?;
        let status = response.status();
        let parsed = net::read_json(response).await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(Ok(parsed));
        }
        let kind = parsed["__type"]
            .as_str()
            .and_then(|text| text.rsplit('#').next())
            .unwrap_or_default()
            .to_owned();
        Ok(Err(AwsError { status, kind }))
    }
}

fn failed(action: &str, error: AwsError) -> anyhow::Error {
    if error.kind.is_empty() {
        status_error(&format!("AWS {action}"), error.status)
    } else {
        anyhow!(
            "AWS {action} failed with HTTP {} ({})",
            error.status.as_u16(),
            error.kind
        )
    }
}

/// List one secret name (proves the key and region) without reading values.
pub async fn check(store: &StoreRecord, credentials: &StoreCredentials) -> Result<()> {
    let client = Client::open(store, credentials).await?;
    client
        .call("ListSecrets", &json!({ "MaxResults": 1 }))
        .await?
        .map(|_| ())
        .map_err(|error| failed("ListSecrets", error))
}

pub async fn push(
    store: &StoreRecord,
    credentials: &StoreCredentials,
    remote_path: &str,
    values: &BTreeMap<String, String>,
) -> Result<usize> {
    let name = secret_name(store, remote_path);
    if name.is_empty() {
        bail!("an AWS destination needs a secret name");
    }
    let secret_string = serde_json::to_string(values)?;
    if secret_string.len() > MAX_SECRET_BYTES {
        bail!("the folder is larger than one AWS secret allows; push aborted");
    }
    let client = Client::open(store, credentials).await?;
    let current = match client
        .call("GetSecretValue", &json!({ "SecretId": name }))
        .await?
    {
        Ok(body) => Some(body["SecretString"].as_str().unwrap_or_default().to_owned()),
        Err(error) if error.kind == "ResourceNotFoundException" => None,
        // Without read access the push still works; it just cannot skip an
        // unchanged value or protect a non-empty secret from an empty folder.
        Err(error) if error.kind == "AccessDeniedException" && !values.is_empty() => {
            Some(String::new())
        }
        Err(error) => return Err(failed("GetSecretValue", error)),
    };
    if values.is_empty() {
        let remote_has_values = current.as_deref().is_some_and(|text| {
            serde_json::from_str::<BTreeMap<String, Value>>(text)
                .map_or(!text.is_empty(), |map| !map.is_empty())
        });
        if remote_has_values {
            bail!(
                "the folder is empty and the remote secret is not; refusing to wipe it \
                 (delete it in AWS, or delete this destination)"
            );
        }
        if current.is_none() {
            return Ok(0);
        }
    }
    match current {
        Some(text) if text == secret_string => return Ok(values.len()),
        Some(_) => client
            .call(
                "PutSecretValue",
                &json!({ "SecretId": name, "SecretString": secret_string }),
            )
            .await?
            .map_err(|error| failed("PutSecretValue", error))?,
        None => client
            .call(
                "CreateSecret",
                &json!({ "Name": name, "SecretString": secret_string }),
            )
            .await?
            .map_err(|error| failed("CreateSecret", error))?,
    };
    Ok(values.len())
}
