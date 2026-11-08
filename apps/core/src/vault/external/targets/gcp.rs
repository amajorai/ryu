//! Google Cloud Secret Manager: one secret per key.
//!
//! A push reads each secret's latest version and adds a version only when
//! the value changed; a missing secret is created (automatic replication)
//! first. Auth is a raw OAuth access token or a service-account key, signed
//! into a JWT (RS256) and exchanged at the key's `token_uri`, which passes
//! the same egress guard as the store address.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

use super::{connect, endpoint, status_error, StoreCredentials, StoreRecord};
use crate::vault::external::{net, AuthMethod};

const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const MAX_SECRET_ID_LEN: usize = 255;
/// Secret Manager's limit for one version payload.
const MAX_VALUE_BYTES: usize = 64 * 1024;

/// The fields of a service-account key file Core uses.
#[derive(Clone, Deserialize)]
pub struct ServiceAccountKey {
    #[serde(rename = "type")]
    kind: String,
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: Option<String>,
}

impl std::fmt::Debug for ServiceAccountKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServiceAccountKey(<redacted>)")
    }
}

impl ServiceAccountKey {
    /// Parse and check a key file. Errors never echo its content.
    pub fn parse(text: &str) -> Result<Self> {
        let key: Self = serde_json::from_str(text)
            .map_err(|_| anyhow!("`serviceAccountKey` is not a service-account key file"))?;
        if key.kind != "service_account" || key.client_email.trim().is_empty() {
            bail!("`serviceAccountKey` is not a service-account key file");
        }
        jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
            .map_err(|_| anyhow!("`serviceAccountKey` has no usable private key"))?;
        net::validate_address(&key.token_uri(), net::Egress::from_env())
            .map_err(|error| anyhow!("`serviceAccountKey` token_uri is refused: {error}"))?;
        Ok(key)
    }

    fn token_uri(&self) -> String {
        self.token_uri
            .clone()
            .filter(|uri| !uri.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_TOKEN_URI.to_owned())
    }

    /// Exchange a signed assertion for an access token.
    async fn access_token(&self) -> Result<String> {
        let token_uri = net::validate_address(&self.token_uri(), net::Egress::from_env())?;
        let now = chrono::Utc::now().timestamp();
        let claims = json!({
            "iss": self.client_email,
            "scope": SCOPE,
            "aud": token_uri.as_str(),
            "iat": now,
            "exp": now + 3600,
        });
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(self.private_key.as_bytes())
            .map_err(|_| anyhow!("the service-account key has no usable private key"))?;
        let assertion = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &claims,
            &key,
        )
        .map_err(|_| anyhow!("signing the service-account assertion failed"))?;
        let http = net::guarded_client(&token_uri, net::Egress::from_env()).await?;
        let response = http
            .post(token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .context("Google token exchange")?;
        if !response.status().is_success() {
            return Err(status_error("Google token exchange", response.status()));
        }
        let body = net::read_json(response).await?;
        body["access_token"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("Google token exchange returned no access token"))
    }
}

/// Whether Secret Manager accepts `id` as a secret id.
pub fn is_valid_secret_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SECRET_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

struct Client<'a> {
    base: url::Url,
    http: reqwest::Client,
    token: String,
    project: &'a str,
}

impl<'a> Client<'a> {
    async fn open(store: &'a StoreRecord, credentials: &StoreCredentials) -> Result<Self> {
        let token = match store.auth_method {
            AuthMethod::ServiceAccount => {
                ServiceAccountKey::parse(
                    credentials
                        .service_account_key
                        .as_deref()
                        .unwrap_or_default(),
                )?
                .access_token()
                .await?
            }
            _ => super::token(credentials)?.to_owned(),
        };
        let (base, http) = connect(store).await?;
        Ok(Self {
            base,
            http,
            token,
            project: &store.project_id,
        })
    }

    fn url(&self, tail: &[&str]) -> Result<url::Url> {
        let mut segments = vec!["v1", "projects", self.project, "secrets"];
        segments.extend_from_slice(tail);
        endpoint(&self.base, &segments)
    }

    /// The latest value of `id`, or `None` when the secret (or a version)
    /// does not exist.
    async fn latest(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let url = self.url(&[id, "versions", "latest:access"])?;
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .context("Secret Manager read")?;
        // Missing, or not readable by this key: unknown, so the push adds a
        // version rather than skipping it.
        if matches!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN
        ) {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(status_error("Secret Manager read", response.status()));
        }
        let body = net::read_json(response).await?;
        base64::engine::general_purpose::STANDARD
            .decode(body["payload"]["data"].as_str().unwrap_or_default())
            .map(Some)
            .map_err(|_| anyhow!("Secret Manager returned an unreadable payload"))
    }

    async fn post(&self, url: url::Url, body: &serde_json::Value) -> Result<reqwest::StatusCode> {
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .context("Secret Manager write")?;
        Ok(response.status())
    }

    async fn add_version(&self, id: &str, value: &str) -> Result<()> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        let payload = json!({ "payload": { "data": encoded } });
        let add = |s: &Self| s.url(&[&format!("{id}:addVersion")]);
        let mut status = self.post(add(self)?, &payload).await?;
        if status == reqwest::StatusCode::NOT_FOUND {
            let mut create = self.url(&[])?;
            create.query_pairs_mut().append_pair("secretId", id);
            let created = self
                .post(create, &json!({ "replication": { "automatic": {} } }))
                .await?;
            if !created.is_success() && created != reqwest::StatusCode::CONFLICT {
                return Err(status_error("Secret Manager create", created));
            }
            status = self.post(add(self)?, &payload).await?;
        }
        if !status.is_success() {
            return Err(status_error("Secret Manager add version", status));
        }
        Ok(())
    }
}

/// List one secret (proves the token and project) without reading values.
pub async fn check(store: &StoreRecord, credentials: &StoreCredentials) -> Result<()> {
    let client = Client::open(store, credentials).await?;
    let mut url = client.url(&[])?;
    url.query_pairs_mut().append_pair("pageSize", "1");
    let response = client
        .http
        .get(url)
        .bearer_auth(&client.token)
        .send()
        .await
        .context("Secret Manager list")?;
    if !response.status().is_success() {
        return Err(status_error("Secret Manager list", response.status()));
    }
    Ok(())
}

pub async fn push(
    store: &StoreRecord,
    credentials: &StoreCredentials,
    values: &BTreeMap<String, String>,
) -> Result<usize> {
    for (id, value) in values {
        if !is_valid_secret_id(id) {
            bail!("`{id}` is not a valid Secret Manager id; push aborted");
        }
        if value.len() > MAX_VALUE_BYTES {
            bail!("`{id}` is larger than Secret Manager allows; push aborted");
        }
    }
    if values.is_empty() {
        return Ok(0);
    }
    let client = Client::open(store, credentials).await?;
    for (id, value) in values {
        if client.latest(id).await?.as_deref() == Some(value.as_bytes()) {
            continue;
        }
        client.add_version(id, value).await?;
    }
    Ok(values.len())
}
