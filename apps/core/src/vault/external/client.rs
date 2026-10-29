//! HTTP clients for OpenBao / HashiCorp Vault KV and Infisical.
//!
//! One remote "folder" is a map of key to string value:
//!
//! * Vault/OpenBao KV v2: `GET /v1/<mount>/data/<path>` (`data.data`, version
//!   in `data.metadata.version`), written with `POST /v1/<mount>/data/<path>`
//!   `{data}`; KV v1: `GET`/`POST /v1/<mount>/<path>`. Login is a token, an
//!   AppRole (`POST /v1/auth/<mount>/login {role_id, secret_id}`), or a
//!   Kubernetes service-account JWT (`POST /v1/auth/<mount>/login {role, jwt}`).
//!   `X-Vault-Namespace` is sent when the store has a namespace.
//! * Infisical: universal-auth login (`POST /api/v1/auth/universal-auth/login`)
//!   or a raw access token, then `GET /api/v3/secrets/raw` for one project,
//!   environment, and secret path; pushes `PATCH` (or, for a new key, `POST`)
//!   `/api/v3/secrets/raw/<key>`.
//!
//! Every call goes through [`super::net`]; no credential or value is logged.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use super::net;
use super::{AuthMethod, StoreCredentials, StoreKind, StoreRecord};

const VAULT_NAMESPACE_HEADER: &str = "X-Vault-Namespace";
const VAULT_TOKEN_HEADER: &str = "X-Vault-Token";
/// Default Kubernetes service-account token location.
pub const DEFAULT_K8S_JWT_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
/// Operator override for the Kubernetes token location. The location is never
/// taken from the store API: a request-chosen file would be read and POSTed
/// to a request-chosen address.
pub const ENV_K8S_JWT_PATH: &str = "RYU_VAULT_EXTERNAL_K8S_JWT_PATH";
/// Largest service-account token Core reads.
const MAX_K8S_JWT_BYTES: u64 = 16 * 1024;

/// The Kubernetes token location: the operator override or the default.
fn k8s_jwt_path() -> String {
    std::env::var(ENV_K8S_JWT_PATH)
        .ok()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| DEFAULT_K8S_JWT_PATH.to_owned())
}

/// Whether `token` has the shape of a compact JWS (three base64url segments).
fn is_jwt_shaped(token: &str) -> bool {
    let segments: Vec<&str> = token.split('.').collect();
    segments.len() == 3
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'='))
        })
}

/// Read the service-account token. Errors never name the path or echo content.
async fn read_k8s_jwt(path: &str) -> Result<String> {
    let unreadable = || anyhow!("the Kubernetes service-account token is unreadable");
    let metadata = tokio::fs::metadata(path).await.map_err(|_| unreadable())?;
    if !metadata.is_file() || metadata.len() > MAX_K8S_JWT_BYTES {
        return Err(unreadable());
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| unreadable())?;
    let token = text.trim();
    if !is_jwt_shaped(token) {
        bail!("the Kubernetes service-account token is not a JWT");
    }
    Ok(token.to_owned())
}

/// What one remote read returned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteFolder {
    /// Key to value.
    pub values: BTreeMap<String, String>,
    /// Remote version when the store reports one (KV v2 secret version).
    pub version: Option<i64>,
}

/// A connected client: the guarded HTTP client plus the request token.
pub struct Session<'a> {
    store: &'a StoreRecord,
    base: url::Url,
    http: reqwest::Client,
    token: String,
}

/// Join and validate remote path segments (`[A-Za-z0-9._-]`, no `.`/`..`).
pub fn join_remote_path(parts: &[&str]) -> Result<Vec<String>> {
    let mut segments = Vec::new();
    for part in parts {
        for segment in part.split('/').filter(|s| !s.is_empty()) {
            let valid = segment.len() <= 128
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
            if !valid {
                bail!("invalid remote path segment `{segment}`");
            }
            segments.push(segment.to_owned());
        }
    }
    Ok(segments)
}

fn url_with(base: &url::Url, segments: &[&str]) -> Result<url::Url> {
    let mut url = base.clone();
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|()| anyhow!("store address cannot carry a path"))?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}

fn status_error(what: &str, status: reqwest::StatusCode) -> anyhow::Error {
    anyhow!("{what} failed with HTTP {}", status.as_u16())
}

/// Convert a JSON object of values into strings; nested objects are refused.
fn string_map(data: &Value) -> Result<BTreeMap<String, String>> {
    let Some(object) = data.as_object() else {
        bail!("store data is not an object");
    };
    let mut out = BTreeMap::new();
    for (key, value) in object {
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            Value::Null => continue,
            _ => bail!("store key `{key}` holds a nested value"),
        };
        out.insert(key.clone(), text);
    }
    Ok(out)
}

impl StoreRecord {
    fn base_url(&self) -> Result<url::Url> {
        net::validate_address(&self.address, net::Egress::from_env())
    }
}

impl<'a> Session<'a> {
    /// Log in to `store` with its sealed credentials.
    pub async fn connect(store: &'a StoreRecord, credentials: &StoreCredentials) -> Result<Self> {
        let base = store.base_url()?;
        let http = net::guarded_client(&base, net::Egress::from_env()).await?;
        let mut session = Self {
            store,
            base,
            http,
            token: String::new(),
        };
        session.token = session.login(credentials).await?;
        Ok(session)
    }

    fn vault_request(&self, method: reqwest::Method, url: url::Url) -> reqwest::RequestBuilder {
        let mut request = self.http.request(method, url);
        if let Some(namespace) = self.store.namespace.as_deref().filter(|n| !n.is_empty()) {
            request = request.header(VAULT_NAMESPACE_HEADER, namespace);
        }
        request
    }

    async fn login(&self, credentials: &StoreCredentials) -> Result<String> {
        match (self.store.kind, self.store.auth_method) {
            (_, AuthMethod::Token) => credentials
                .token
                .clone()
                .filter(|token| !token.is_empty())
                .ok_or_else(|| anyhow!("the store has no token")),
            (StoreKind::Infisical, AuthMethod::UniversalAuth) => {
                let url = url_with(
                    &self.base,
                    &["api", "v1", "auth", "universal-auth", "login"],
                )?;
                let response = self
                    .http
                    .post(url)
                    .json(&json!({
                        "clientId": credentials.client_id,
                        "clientSecret": credentials.client_secret,
                    }))
                    .send()
                    .await
                    .context("Infisical login")?;
                if !response.status().is_success() {
                    return Err(status_error("Infisical login", response.status()));
                }
                let body = net::read_json(response).await?;
                body["accessToken"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("Infisical login returned no access token"))
            }
            (StoreKind::Infisical, _) => bail!("Infisical supports token or universal-auth"),
            (_, AuthMethod::Approle | AuthMethod::Kubernetes) => {
                let (default_mount, payload) = if self.store.auth_method == AuthMethod::Approle {
                    (
                        "approle",
                        json!({ "role_id": credentials.role_id, "secret_id": credentials.secret_id }),
                    )
                } else {
                    let jwt = read_k8s_jwt(&k8s_jwt_path()).await?;
                    ("kubernetes", json!({ "role": self.store.role, "jwt": jwt }))
                };
                let mount = self
                    .store
                    .auth_mount
                    .clone()
                    .unwrap_or_else(|| default_mount.to_owned());
                let mut segments = vec!["v1", "auth"];
                let mount_segments = join_remote_path(&[&mount])?;
                segments.extend(mount_segments.iter().map(String::as_str));
                segments.push("login");
                let url = url_with(&self.base, &segments)?;
                let response = self
                    .vault_request(reqwest::Method::POST, url)
                    .json(&payload)
                    .send()
                    .await
                    .context("store login")?;
                if !response.status().is_success() {
                    return Err(status_error("store login", response.status()));
                }
                let body = net::read_json(response).await?;
                body["auth"]["client_token"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("store login returned no client token"))
            }
            (_, AuthMethod::UniversalAuth) => bail!("universal-auth is only for Infisical"),
        }
    }

    fn kv_url(&self, remote_path: &str) -> Result<url::Url> {
        let mount = join_remote_path(&[&self.store.mount])?;
        if mount.is_empty() {
            bail!("the store has no mount");
        }
        let path = join_remote_path(&[&self.store.path_prefix, remote_path])?;
        if path.is_empty() {
            bail!("a KV path is required");
        }
        let mut segments: Vec<&str> = vec!["v1"];
        segments.extend(mount.iter().map(String::as_str));
        if self.store.kv_version == 2 {
            segments.push("data");
        }
        segments.extend(path.iter().map(String::as_str));
        url_with(&self.base, &segments)
    }

    fn infisical_secret_path(&self, remote_path: &str) -> Result<String> {
        let segments = join_remote_path(&[&self.store.secret_path, remote_path])?;
        Ok(format!("/{}", segments.join("/")))
    }

    /// Prove the session works without reading a value: Vault/OpenBao look
    /// the token up; Infisical lists the configured secret path.
    pub async fn check(&self) -> Result<()> {
        match self.store.kind {
            StoreKind::Infisical => self.infisical_read("").await.map(|_| ()),
            StoreKind::Openbao | StoreKind::HashicorpVault => {
                let url = url_with(&self.base, &["v1", "auth", "token", "lookup-self"])?;
                let response = self
                    .vault_request(reqwest::Method::GET, url)
                    .header(VAULT_TOKEN_HEADER, &self.token)
                    .send()
                    .await
                    .context("store token lookup")?;
                if !response.status().is_success() {
                    return Err(status_error("store token lookup", response.status()));
                }
                Ok(())
            }
        }
    }

    /// Read one remote folder. A missing remote path is an empty folder.
    pub async fn read(&self, remote_path: &str) -> Result<RemoteFolder> {
        match self.store.kind {
            StoreKind::Infisical => self.infisical_read(remote_path).await,
            StoreKind::Openbao | StoreKind::HashicorpVault => self.kv_read(remote_path).await,
        }
    }

    /// Push `values` one-way. A KV path is replaced as a whole (keys missing
    /// locally disappear remotely); Infisical is upsert-only, so a key deleted
    /// in Ryu stays in Infisical until removed there.
    pub async fn write(&self, remote_path: &str, values: &BTreeMap<String, String>) -> Result<()> {
        match self.store.kind {
            StoreKind::Infisical => self.infisical_write(remote_path, values).await,
            StoreKind::Openbao | StoreKind::HashicorpVault => {
                self.kv_write(remote_path, values).await
            }
        }
    }

    async fn kv_read(&self, remote_path: &str) -> Result<RemoteFolder> {
        let response = self
            .vault_request(reqwest::Method::GET, self.kv_url(remote_path)?)
            .header(VAULT_TOKEN_HEADER, &self.token)
            .send()
            .await
            .context("store read")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(RemoteFolder::default());
        }
        if !response.status().is_success() {
            return Err(status_error("store read", response.status()));
        }
        let body = net::read_json(response).await?;
        if self.store.kv_version == 2 {
            // A soft-deleted v2 secret answers `data: null`.
            if body["data"]["data"].is_null() {
                return Ok(RemoteFolder::default());
            }
            Ok(RemoteFolder {
                values: string_map(&body["data"]["data"])?,
                version: body["data"]["metadata"]["version"].as_i64(),
            })
        } else {
            Ok(RemoteFolder {
                values: string_map(&body["data"])?,
                version: None,
            })
        }
    }

    async fn kv_write(&self, remote_path: &str, values: &BTreeMap<String, String>) -> Result<()> {
        let payload = if self.store.kv_version == 2 {
            json!({ "data": values })
        } else {
            json!(values)
        };
        let response = self
            .vault_request(reqwest::Method::POST, self.kv_url(remote_path)?)
            .header(VAULT_TOKEN_HEADER, &self.token)
            .json(&payload)
            .send()
            .await
            .context("store write")?;
        if !response.status().is_success() {
            return Err(status_error("store write", response.status()));
        }
        Ok(())
    }

    async fn infisical_read(&self, remote_path: &str) -> Result<RemoteFolder> {
        let mut url = url_with(&self.base, &["api", "v3", "secrets", "raw"])?;
        url.query_pairs_mut()
            .append_pair("workspaceId", &self.store.project_id)
            .append_pair("environment", &self.store.infisical_environment)
            .append_pair("secretPath", &self.infisical_secret_path(remote_path)?)
            .append_pair("include_imports", "false");
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .context("Infisical read")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(RemoteFolder::default());
        }
        if !response.status().is_success() {
            return Err(status_error("Infisical read", response.status()));
        }
        let body = net::read_json(response).await?;
        let secrets = body["secrets"]
            .as_array()
            .ok_or_else(|| anyhow!("Infisical response has no secrets list"))?;
        let mut folder = RemoteFolder::default();
        for secret in secrets {
            let key = secret["secretKey"]
                .as_str()
                .ok_or_else(|| anyhow!("Infisical secret has no key"))?;
            let value = secret["secretValue"].as_str().unwrap_or_default();
            folder.values.insert(key.to_owned(), value.to_owned());
            if let Some(version) = secret["version"].as_i64() {
                folder.version = Some(folder.version.unwrap_or(0).max(version));
            }
        }
        Ok(folder)
    }

    async fn infisical_write(
        &self,
        remote_path: &str,
        values: &BTreeMap<String, String>,
    ) -> Result<()> {
        let secret_path = self.infisical_secret_path(remote_path)?;
        for (key, value) in values {
            let url = url_with(&self.base, &["api", "v3", "secrets", "raw", key])?;
            let payload = json!({
                "workspaceId": self.store.project_id,
                "environment": self.store.infisical_environment,
                "secretPath": secret_path,
                "secretValue": value,
                "type": "shared",
            });
            let response = self
                .http
                .patch(url.clone())
                .bearer_auth(&self.token)
                .json(&payload)
                .send()
                .await
                .context("Infisical update")?;
            let status = response.status();
            if status.is_success() {
                continue;
            }
            if status != reqwest::StatusCode::NOT_FOUND {
                return Err(status_error("Infisical update", status));
            }
            let response = self
                .http
                .post(url)
                .bearer_auth(&self.token)
                .json(&payload)
                .send()
                .await
                .context("Infisical create")?;
            if !response.status().is_success() {
                return Err(status_error("Infisical create", response.status()));
            }
        }
        Ok(())
    }
}
