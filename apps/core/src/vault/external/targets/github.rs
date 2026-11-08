//! GitHub Actions secrets: `PUT /repos/{owner}/{repo}[/environments/{env}]/secrets/{name}`
//! with the value sealed (libsodium `crypto_box_seal`) to the scope's public key.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde_json::json;

use super::{connect, endpoint, status_error, token, StoreCredentials, StoreRecord};
use crate::vault::external::net;

const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "ryu-vault-secret-sync";
/// GitHub refuses larger secret values.
const MAX_VALUE_BYTES: usize = 48 * 1024;

/// Seal `plaintext` to a repository public key (base64 in, base64 out).
pub fn seal(public_key_b64: &str, plaintext: &[u8]) -> Result<String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes: [u8; 32] = engine
        .decode(public_key_b64.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| anyhow!("GitHub returned an invalid public key"))?;
    let key = crypto_box::PublicKey::from(bytes);
    let sealed = key
        .seal(&mut crypto_box::aead::OsRng, plaintext)
        .map_err(|_| anyhow!("sealing a value for GitHub failed"))?;
    Ok(engine.encode(sealed))
}

/// Whether GitHub accepts `name` as a secret name.
pub fn is_valid_secret_name(name: &str) -> bool {
    !name.is_empty()
        && !name.as_bytes()[0].is_ascii_digit()
        && !name.to_ascii_uppercase().starts_with("GITHUB_")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

struct Scope {
    base: url::Url,
    http: reqwest::Client,
    token: String,
    segments: Vec<String>,
}

impl Scope {
    async fn open(store: &StoreRecord, credentials: &StoreCredentials) -> Result<Self> {
        let repository = store
            .options
            .repository
            .as_deref()
            .ok_or_else(|| anyhow!("the GitHub store has no repository"))?;
        let (owner, repo) = repository
            .split_once('/')
            .ok_or_else(|| anyhow!("the GitHub store's repository is invalid"))?;
        let mut segments = vec!["repos".to_owned(), owner.to_owned(), repo.to_owned()];
        if let Some(environment) = store.options.github_environment.as_deref() {
            segments.extend(["environments".to_owned(), environment.to_owned()]);
        }
        segments.push("secrets".to_owned());
        let (base, http) = connect(store).await?;
        Ok(Self {
            base,
            http,
            token: token(credentials)?.to_owned(),
            segments,
        })
    }

    fn request(&self, method: reqwest::Method, tail: &str) -> Result<reqwest::RequestBuilder> {
        let mut segments: Vec<&str> = self.segments.iter().map(String::as_str).collect();
        segments.push(tail);
        Ok(self
            .http
            .request(method, endpoint(&self.base, &segments)?)
            .bearer_auth(&self.token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header("X-GitHub-Api-Version", API_VERSION))
    }

    /// `(key_id, key)` of the scope's sealing key.
    async fn public_key(&self) -> Result<(String, String)> {
        let response = self
            .request(reqwest::Method::GET, "public-key")?
            .send()
            .await
            .context("GitHub public key")?;
        if !response.status().is_success() {
            return Err(status_error("GitHub public key", response.status()));
        }
        let body = net::read_json(response).await?;
        match (body["key_id"].as_str(), body["key"].as_str()) {
            (Some(id), Some(key)) => Ok((id.to_owned(), key.to_owned())),
            _ => bail!("GitHub returned no public key"),
        }
    }
}

pub async fn check(store: &StoreRecord, credentials: &StoreCredentials) -> Result<()> {
    Scope::open(store, credentials)
        .await?
        .public_key()
        .await
        .map(|_| ())
}

pub async fn push(
    store: &StoreRecord,
    credentials: &StoreCredentials,
    values: &BTreeMap<String, String>,
) -> Result<usize> {
    for (name, value) in values {
        if !is_valid_secret_name(name) {
            bail!("`{name}` is not a valid GitHub secret name; push aborted");
        }
        if value.len() > MAX_VALUE_BYTES {
            bail!("`{name}` is larger than GitHub allows; push aborted");
        }
    }
    if values.is_empty() {
        return Ok(0);
    }
    let scope = Scope::open(store, credentials).await?;
    let (key_id, key) = scope.public_key().await?;
    for (name, value) in values {
        let payload = json!({
            "encrypted_value": seal(&key, value.as_bytes())?,
            "key_id": key_id,
        });
        let response = scope
            .request(reqwest::Method::PUT, name)?
            .json(&payload)
            .send()
            .await
            .context("GitHub secret write")?;
        if !response.status().is_success() {
            return Err(status_error("GitHub secret write", response.status()));
        }
    }
    Ok(values.len())
}
