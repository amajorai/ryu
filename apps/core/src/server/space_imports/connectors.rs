//! Native connector imports: Notion, Google Drive, Confluence, GitHub, and web URLs.
//!
//! Each provider is read through its documented REST API and turned into the same
//! [`ImportSource`] values a file upload produces (`.md` pages, `.csv` databases,
//! or the original file for formats `document.parse` handles), so everything after
//! the fetch — page/database creation, chunking, embedding, import history — is the
//! existing Space import pipeline.
//!
//! ## Credentials
//!
//! A request names a credential by vault reference (`secret:NOTION_TOKEN`), never
//! by value. It is resolved with the caller's own secret-resolution context (their
//! user scope, then node, team, and org), the same store and precedence MCP tool
//! dispatch uses. A stored value is either the bare token or a JSON object
//! (`{"token": "...", "base_url": "...", "email": "..."}`); a Confluence Data
//! Center URL must come from the stored object, so a request cannot send a node's
//! token to a host of its choosing.
//!
//! ## Egress
//!
//! Every request goes through Core's guarded fetch (https only, resolved addresses
//! screened and pinned, private ranges refused). Redirects are followed here hop by
//! hop, so each hop is screened again, and `Authorization` is dropped when a
//! redirect leaves the original origin.

use std::{future::Future, pin::Pin};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{html_markdown, import_kind, mime_for_name, ImportSource};

/// Most items one connector import may create.
pub(super) const MAX_CONNECTOR_ITEMS: usize = 200;
const DEFAULT_CONNECTOR_ITEMS: usize = 50;
const MAX_REDIRECTS: usize = 5;
const MAX_NOTION_BLOCKS: usize = 2_000;
const MAX_NOTION_DEPTH: usize = 4;
const NOTION_VERSION: &str = "2022-06-28";
const NOTION_API: &str = "https://api.notion.com/v1";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const GITHUB_API: &str = "https://api.github.com";
const MAX_GITHUB_FILE_BYTES: u64 = 10 * 1024 * 1024;
const DRIVE_FILE_FIELDS: &str = "id,name,mimeType,modifiedTime,webViewLink";

/// A connector the Space importer can read natively.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Provider {
    Notion,
    GoogleDrive,
    Confluence,
    GitHub,
    Web,
}

impl Provider {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "notion" => Some(Self::Notion),
            "google_drive" | "gdrive" | "drive" => Some(Self::GoogleDrive),
            "confluence" => Some(Self::Confluence),
            "github" => Some(Self::GitHub),
            "web" | "url" => Some(Self::Web),
            _ => None,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Notion => "notion",
            Self::GoogleDrive => "google_drive",
            Self::Confluence => "confluence",
            Self::GitHub => "github",
            Self::Web => "web",
        }
    }

    fn requires_credential(self) -> bool {
        matches!(self, Self::Notion | Self::GoogleDrive | Self::Confluence)
    }
}

/// `POST /api/spaces/:id/imports/connector` body. Which fields apply depends on
/// `provider`; [`validate`] rejects a request that mixes them up.
#[derive(Debug, Default, Deserialize)]
pub(super) struct ConnectorImportBody {
    provider: String,
    /// Vault reference, e.g. `secret:NOTION_TOKEN`.
    #[serde(default)]
    credential: Option<String>,
    /// `web`: the pages to import.
    #[serde(default)]
    urls: Vec<String>,
    /// `confluence`: `https://<site>.atlassian.net/wiki` (Data Center URLs must be
    /// stored with the credential).
    #[serde(default)]
    base_url: Option<String>,
    /// `confluence`: account email for Cloud Basic auth.
    #[serde(default)]
    email: Option<String>,
    /// `notion` / `confluence`: page ids or URLs.
    #[serde(default)]
    page_ids: Vec<String>,
    /// `notion`: database ids or URLs; each becomes a Space database.
    #[serde(default)]
    database_ids: Vec<String>,
    /// `google_drive`: file ids or URLs.
    #[serde(default)]
    file_ids: Vec<String>,
    /// `google_drive`: folder ids or URLs (direct children are imported).
    #[serde(default)]
    folder_ids: Vec<String>,
    /// `confluence`: import every current page in this space.
    #[serde(default)]
    space_key: Option<String>,
    /// `github`: `owner/name`.
    #[serde(default)]
    repo: Option<String>,
    /// `github`: branch, tag, or commit (default branch when omitted).
    #[serde(default, rename = "ref")]
    git_ref: Option<String>,
    /// `github`: only files under this directory.
    #[serde(default)]
    path: Option<String>,
    /// Import-history label.
    #[serde(default)]
    pub(super) title: Option<String>,
    /// Most items imported (default 50, at most [`MAX_CONNECTOR_ITEMS`]).
    #[serde(default)]
    max_items: Option<usize>,
}

/// What to read, validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ConnectorTarget {
    Web {
        urls: Vec<String>,
    },
    Notion {
        pages: Vec<String>,
        databases: Vec<String>,
    },
    GoogleDrive {
        files: Vec<String>,
        folders: Vec<String>,
    },
    Confluence {
        base_url: Option<String>,
        pages: Vec<String>,
        space_key: Option<String>,
    },
    GitHub {
        owner: String,
        repo: String,
        git_ref: Option<String>,
        path: Option<String>,
    },
}

/// A validated connector import.
#[derive(Clone, Debug)]
pub(super) struct ConnectorRequest {
    pub(super) provider: Provider,
    pub(super) target: ConnectorTarget,
    pub(super) credential_ref: Option<String>,
    pub(super) email: Option<String>,
    pub(super) max_items: usize,
    pub(super) label: String,
}

fn is_plain_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && value != "."
        && value != ".."
}

/// Normalize a Notion id or page URL to the dashed UUID form.
pub(super) fn notion_id(value: &str) -> Result<String, String> {
    let without_query = value.trim().split(['?', '#']).next().unwrap_or_default();
    let compact: String = without_query.chars().filter(|ch| *ch != '-').collect();
    let tail: String = compact
        .chars()
        .rev()
        .take_while(char::is_ascii_hexdigit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail.len() < 32 {
        return Err(format!("not a Notion id or URL: {value}"));
    }
    let hex = tail[tail.len() - 32..].to_ascii_lowercase();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// Extract a Drive id from an id or a Docs/Drive URL.
pub(super) fn drive_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let valid = |id: &str| {
        id.len() >= 10
            && id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    };
    if valid(trimmed) {
        return Ok(trimmed.to_owned());
    }
    let parsed =
        url::Url::parse(trimmed).map_err(|_| format!("not a Google Drive id or URL: {value}"))?;
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(Iterator::collect)
        .unwrap_or_default();
    let from_path = segments
        .windows(2)
        .find(|pair| pair[0] == "d" || pair[0] == "folders")
        .map(|pair| pair[1].to_owned());
    let from_query = parsed
        .query_pairs()
        .find(|(key, _)| key == "id")
        .map(|(_, id)| id.into_owned());
    from_path
        .or(from_query)
        .filter(|id| valid(id))
        .ok_or_else(|| format!("not a Google Drive id or URL: {value}"))
}

fn require_https(value: &str, what: &str) -> Result<url::Url, String> {
    let parsed =
        url::Url::parse(value.trim()).map_err(|error| format!("invalid {what}: {error}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("{what} must use https"));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{what} has no host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{what} must not embed credentials"));
    }
    Ok(parsed)
}

fn non_empty(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

/// Check a request body and normalize ids. Errors are user-facing 400 messages.
pub(super) fn validate(body: ConnectorImportBody) -> Result<ConnectorRequest, String> {
    let provider = Provider::parse(&body.provider).ok_or_else(|| {
        "provider must be notion, google_drive, confluence, github, or web".to_owned()
    })?;
    let credential_ref = body
        .credential
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Some(reference) = &credential_ref {
        let name = reference.strip_prefix("secret:").ok_or_else(|| {
            "credential must be a vault reference such as secret:NOTION_TOKEN".to_owned()
        })?;
        if crate::vault::SecretRef::parse(name).is_none() {
            return Err(format!("invalid vault reference {reference}"));
        }
    }
    if provider.requires_credential() && credential_ref.is_none() {
        return Err(format!(
            "{} imports need a credential (a vault reference such as secret:TOKEN_NAME)",
            provider.as_str()
        ));
    }
    if provider == Provider::Web && credential_ref.is_some() {
        return Err("web imports do not take a credential".to_owned());
    }
    let max_items = body
        .max_items
        .unwrap_or(DEFAULT_CONNECTOR_ITEMS)
        .clamp(1, MAX_CONNECTOR_ITEMS);
    let (target, default_label) = match provider {
        Provider::Web => {
            let urls = non_empty(body.urls);
            if urls.is_empty() {
                return Err("web imports need at least one URL in urls".to_owned());
            }
            if urls.len() > MAX_CONNECTOR_ITEMS {
                return Err(format!("at most {MAX_CONNECTOR_ITEMS} URLs per import"));
            }
            let mut normalized = Vec::with_capacity(urls.len());
            for url in &urls {
                normalized.push(require_https(url, "URL")?.to_string());
            }
            let label = url::Url::parse(&normalized[0])
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| "Web pages".to_owned());
            (ConnectorTarget::Web { urls: normalized }, label)
        }
        Provider::Notion => {
            let pages = non_empty(body.page_ids)
                .iter()
                .map(|id| notion_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            let databases = non_empty(body.database_ids)
                .iter()
                .map(|id| notion_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            if pages.is_empty() && databases.is_empty() {
                return Err("notion imports need page_ids or database_ids".to_owned());
            }
            (
                ConnectorTarget::Notion { pages, databases },
                "Notion".to_owned(),
            )
        }
        Provider::GoogleDrive => {
            let files = non_empty(body.file_ids)
                .iter()
                .map(|id| drive_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            let folders = non_empty(body.folder_ids)
                .iter()
                .map(|id| drive_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            if files.is_empty() && folders.is_empty() {
                return Err("google_drive imports need file_ids or folder_ids".to_owned());
            }
            (
                ConnectorTarget::GoogleDrive { files, folders },
                "Google Drive".to_owned(),
            )
        }
        Provider::Confluence => {
            let pages = non_empty(body.page_ids);
            if let Some(bad) = pages
                .iter()
                .find(|id| !id.chars().all(|ch| ch.is_ascii_digit()))
            {
                return Err(format!("Confluence page ids are numeric: {bad}"));
            }
            let space_key = body
                .space_key
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty());
            if let Some(key) = &space_key {
                if !key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '~' | '_' | '-'))
                {
                    return Err("space_key must be a plain Confluence space key".to_owned());
                }
            }
            if pages.is_empty() && space_key.is_none() {
                return Err("confluence imports need page_ids or space_key".to_owned());
            }
            let base_url = match body.base_url.as_deref().map(str::trim) {
                Some(value) if !value.is_empty() => Some(
                    require_https(value, "base_url")?
                        .as_str()
                        .trim_end_matches('/')
                        .to_owned(),
                ),
                _ => None,
            };
            let label = space_key.clone().map_or_else(
                || "Confluence".to_owned(),
                |key| format!("Confluence {key}"),
            );
            (
                ConnectorTarget::Confluence {
                    base_url,
                    pages,
                    space_key,
                },
                label,
            )
        }
        Provider::GitHub => {
            let repo = body.repo.unwrap_or_default();
            let (owner, name) = repo
                .trim()
                .split_once('/')
                .ok_or_else(|| "github imports need repo as owner/name".to_owned())?;
            if !(is_plain_name(owner) && is_plain_name(name)) {
                return Err("github repo must be owner/name".to_owned());
            }
            let git_ref = body
                .git_ref
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            if let Some(value) = &git_ref {
                if value.contains("..")
                    || value
                        .chars()
                        .any(|ch| ch.is_whitespace() || ch.is_control())
                {
                    return Err("invalid git ref".to_owned());
                }
            }
            let path = body
                .path
                .map(|value| value.trim().trim_matches('/').to_owned())
                .filter(|value| !value.is_empty());
            if path
                .as_deref()
                .is_some_and(|value| value.split('/').any(|part| part == ".."))
            {
                return Err("path must not contain ..".to_owned());
            }
            (
                ConnectorTarget::GitHub {
                    owner: owner.to_owned(),
                    repo: name.to_owned(),
                    git_ref,
                    path,
                },
                format!("{owner}/{name}"),
            )
        }
    };
    let label = body
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or(default_label, str::to_owned);
    Ok(ConnectorRequest {
        provider,
        target,
        credential_ref,
        email: body
            .email
            .map(|email| email.trim().to_owned())
            .filter(|email| !email.is_empty()),
        max_items,
        label,
    })
}

// ── Credentials ──────────────────────────────────────────────────────────────

/// A resolved connector credential. `Debug` never prints the token.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct ConnectorCredential {
    pub(super) token: String,
    pub(super) base_url: Option<String>,
    pub(super) email: Option<String>,
}

impl std::fmt::Debug for ConnectorCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectorCredential")
            .field("token", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("email", &self.email)
            .finish()
    }
}

/// Interpret a stored vault value: a bare token, or a JSON object with `token`
/// (or `api_token` / `access_token`) plus optional `base_url` and `email`.
pub(super) fn parse_credential_value(value: &str) -> Result<ConnectorCredential, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("the credential is empty".to_owned());
    }
    if !trimmed.starts_with('{') {
        return Ok(ConnectorCredential {
            token: trimmed.to_owned(),
            base_url: None,
            email: None,
        });
    }
    let object: serde_json::Map<String, Value> =
        serde_json::from_str(trimmed).map_err(|_| "the credential is not valid JSON".to_owned())?;
    let field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let token = field("token")
        .or_else(|| field("api_token"))
        .or_else(|| field("access_token"))
        .ok_or_else(|| "the credential object has no token".to_owned())?;
    let base_url = match field("base_url") {
        Some(url) => Some(
            require_https(&url, "credential base_url")?
                .as_str()
                .trim_end_matches('/')
                .to_owned(),
        ),
        None => None,
    };
    Ok(ConnectorCredential {
        token,
        base_url,
        email: field("email"),
    })
}

/// Resolve a `secret:` reference for `caller` through the node's vault.
pub(super) async fn resolve_credential(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    reference: &str,
) -> Result<ConnectorCredential, String> {
    let body = reference
        .strip_prefix("secret:")
        .ok_or_else(|| "credential must be a vault reference".to_owned())?;
    let store = crate::plugin_secrets::global()
        .ok_or_else(|| "the vault is not available on this node".to_owned())?;
    let node = crate::sidecar::control_plane::registered_node();
    let user_id = match (caller, &node) {
        (Some(caller), _) => Some(caller.user_id.clone()),
        // A personal, unbound node has one trusted local operator.
        (None, None) => Some("local".to_owned()),
        (None, Some(_)) => None,
    };
    let context = crate::plugin_secrets::SecretResolutionContext {
        user_id,
        org_id: node.as_ref().map(|registered| registered.org.id.clone()),
        team_id: node
            .as_ref()
            .and_then(|registered| registered.team_id.clone()),
        team_authority: caller
            .and_then(crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller),
        node_id: node
            .as_ref()
            .map_or_else(crate::server::agent_sync::local_node_id, |registered| {
                registered.node_id.clone()
            }),
        mcp_ids: Vec::new(),
        environment: None,
        conversation_id: None,
        roles: caller
            .iter()
            .map(|caller| caller.role.label().to_owned())
            .collect(),
        ..Default::default()
    };
    let value = store
        .resolve_vault_secret(body, &context)
        .await
        .map_err(|_| format!("cannot read {reference} from the vault"))?
        .ok_or_else(|| format!("{reference} is not set or not readable by you"))?;
    parse_credential_value(&value)
}

// ── Transport ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum HttpMethod {
    Get,
    Post,
}

/// One outbound request.
#[derive(Clone, Debug)]
pub(super) struct HttpRequest {
    pub(super) method: HttpMethod,
    pub(super) url: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Option<String>,
}

impl HttpRequest {
    fn get(url: impl Into<String>, headers: &[(String, String)]) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            headers: headers.to_vec(),
            body: None,
        }
    }

    fn post_json(url: impl Into<String>, headers: &[(String, String)], body: &Value) -> Self {
        let mut headers = headers.to_vec();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            headers,
            body: Some(body.to_string()),
        }
    }
}

/// One response, body already read (and capped).
#[derive(Clone, Debug, Default)]
pub(super) struct HttpReply {
    pub(super) status: u16,
    pub(super) content_type: String,
    pub(super) location: Option<String>,
    pub(super) body: Vec<u8>,
}

/// The outbound seam. Production uses [`GuardedHttp`]; tests use a mock.
#[async_trait::async_trait]
pub(super) trait ImportHttp: Send + Sync {
    async fn send(&self, request: &HttpRequest) -> Result<HttpReply, String>;
}

/// Core's SSRF-guarded client (https only, screened and pinned addresses, no
/// automatic redirects).
pub(super) struct GuardedHttp;

fn header_value(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

#[async_trait::async_trait]
impl ImportHttp for GuardedHttp {
    async fn send(&self, request: &HttpRequest) -> Result<HttpReply, String> {
        let cap = crate::server::uploads::MAX_UPLOAD_BYTES as u64;
        match request.method {
            HttpMethod::Get => {
                let mut response =
                    crate::server::guarded_get_with_headers(&request.url, &request.headers)
                        .await
                        .map_err(|error| error.to_string())?;
                let headers = response.headers().clone();
                let mut reply = HttpReply {
                    status: response.status().as_u16(),
                    content_type: header_value(&headers, reqwest::header::CONTENT_TYPE)
                        .unwrap_or_default(),
                    location: header_value(&headers, reqwest::header::LOCATION),
                    body: Vec::new(),
                };
                if response.content_length().is_some_and(|length| length > cap) {
                    return Err(format!("the response is larger than {cap} bytes"));
                }
                while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                    if reply.body.len() as u64 + chunk.len() as u64 > cap {
                        return Err(format!("the response is larger than {cap} bytes"));
                    }
                    reply.body.extend_from_slice(&chunk);
                }
                Ok(reply)
            }
            HttpMethod::Post => {
                let (status, headers, body) = crate::server::guarded_post_json(
                    &request.url,
                    &request.headers,
                    request.body.clone().unwrap_or_default(),
                    cap,
                )
                .await
                .map_err(|error| error.to_string())?;
                Ok(HttpReply {
                    status: status.as_u16(),
                    content_type: header_value(&headers, reqwest::header::CONTENT_TYPE)
                        .unwrap_or_default(),
                    location: header_value(&headers, reqwest::header::LOCATION),
                    body: body.into_bytes(),
                })
            }
        }
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the server".to_owned())
}

/// Send `request`, following redirects by hand. Returns the final reply (2xx
/// only) and the final URL.
pub(super) async fn send_following(
    http: &dyn ImportHttp,
    mut request: HttpRequest,
) -> Result<(HttpReply, String), String> {
    let origin = url::Url::parse(&request.url)
        .map_err(|error| format!("invalid URL: {error}"))?
        .origin();
    for _ in 0..=MAX_REDIRECTS {
        let reply = http.send(&request).await?;
        let redirect = matches!(reply.status, 301 | 302 | 303 | 307 | 308);
        if let (true, Some(location)) = (redirect, reply.location.as_deref()) {
            let next = url::Url::parse(&request.url)
                .and_then(|base| base.join(location))
                .map_err(|error| format!("invalid redirect: {error}"))?;
            if next.origin() != origin {
                request.headers.retain(|(name, _)| {
                    !(name.eq_ignore_ascii_case("authorization")
                        || name.eq_ignore_ascii_case("cookie"))
                });
            }
            if reply.status == 303
                || (request.method == HttpMethod::Post && !matches!(reply.status, 307 | 308))
            {
                request.method = HttpMethod::Get;
                request.body = None;
            }
            request.url = next.into();
            continue;
        }
        if !(200..300).contains(&reply.status) {
            let detail: String = String::from_utf8_lossy(&reply.body)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(200)
                .collect();
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            return Err(format!(
                "{} returned HTTP {}{suffix}",
                host_of(&request.url),
                reply.status
            ));
        }
        return Ok((reply, request.url));
    }
    Err(format!("too many redirects from {}", host_of(&request.url)))
}

async fn send_json(http: &dyn ImportHttp, request: HttpRequest) -> Result<Value, String> {
    let host = host_of(&request.url);
    let (reply, _) = send_following(http, request).await?;
    serde_json::from_slice(&reply.body).map_err(|_| format!("{host} returned invalid JSON"))
}

fn url_with(base: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base).expect("connector API URLs are valid");
    if !pairs.is_empty() {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.into()
}

// ── Shared output helpers ────────────────────────────────────────────────────

/// What a connector fetch produced: importable sources, plus per-item failures.
#[derive(Default)]
pub(super) struct Fetched {
    pub(super) sources: Vec<ImportSource>,
    pub(super) failures: Vec<String>,
}

/// A file-name-safe title (no separators or control characters, bounded).
fn safe_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded: String = collapsed.chars().take(120).collect();
    let trimmed = bounded.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if trimmed.is_empty() {
        "Untitled".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn markdown_source(title: &str, markdown: String) -> ImportSource {
    ImportSource {
        name: format!("{}.md", safe_title(title)),
        mime: "text/markdown".to_owned(),
        bytes: markdown.into_bytes(),
    }
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn csv_source(title: &str, rows: &[Vec<String>]) -> ImportSource {
    let text = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| csv_escape(cell))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n");
    ImportSource {
        name: format!("{}.csv", safe_title(title)),
        mime: "text/csv".to_owned(),
        bytes: text.into_bytes(),
    }
}

/// Read what `request` describes and return Space import sources.
pub(super) async fn fetch_sources(
    http: &dyn ImportHttp,
    request: &ConnectorRequest,
    credential: Option<&ConnectorCredential>,
) -> Result<Fetched, String> {
    let need = || {
        credential.ok_or_else(|| format!("{} imports need a credential", request.provider.as_str()))
    };
    match &request.target {
        ConnectorTarget::Web { urls } => Ok(fetch_web(http, urls, request.max_items).await),
        ConnectorTarget::Notion { pages, databases } => {
            fetch_notion(http, need()?, pages, databases, request.max_items).await
        }
        ConnectorTarget::GoogleDrive { files, folders } => {
            fetch_drive(http, need()?, files, folders, request.max_items).await
        }
        ConnectorTarget::Confluence {
            base_url,
            pages,
            space_key,
        } => {
            let site = confluence_site(base_url.as_deref(), request.email.as_deref(), need()?)?;
            fetch_confluence(http, &site, pages, space_key.as_deref(), request.max_items).await
        }
        ConnectorTarget::GitHub {
            owner,
            repo,
            git_ref,
            path,
        } => {
            let repository = GitHubRepository {
                owner,
                repo,
                git_ref: git_ref.as_deref(),
                path: path.as_deref(),
            };
            fetch_github(http, credential, &repository, request.max_items).await
        }
    }
}

// ── Web ──────────────────────────────────────────────────────────────────────

fn mime_of(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn url_title(url: &str) -> String {
    url::Url::parse(url).map_or_else(
        |_| url.to_owned(),
        |parsed| {
            let path = parsed.path().trim_matches('/');
            let host = parsed.host_str().unwrap_or_default();
            if path.is_empty() {
                host.to_owned()
            } else {
                format!("{host} {path}")
            }
        },
    )
}

/// Fetch one web page and turn it into an import source.
pub(super) async fn fetch_web_page(
    http: &dyn ImportHttp,
    url: &str,
) -> Result<ImportSource, String> {
    let headers = vec![(
        "accept".to_owned(),
        "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5".to_owned(),
    )];
    let (reply, final_url) = send_following(http, HttpRequest::get(url, &headers)).await?;
    let mime = mime_of(&reply.content_type);
    let title = url_title(&final_url);
    // A downloaded document is named after its file, not the whole URL.
    let file_title = url::Url::parse(&final_url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
                .map(|segment| {
                    let decoded = urlencoding::decode(segment)
                        .map_or_else(|_| segment.to_owned(), |text| text.into_owned());
                    std::path::Path::new(&decoded)
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or(&decoded)
                        .to_owned()
                })
        })
        .unwrap_or_else(|| title.clone());
    let extension = match mime.as_str() {
        "" | "text/html" | "application/xhtml+xml" => {
            let html = String::from_utf8_lossy(&reply.body);
            let page_title = html_markdown::html_title(&html).unwrap_or(title);
            let markdown = html_markdown::html_to_markdown(&html, Some(&final_url));
            if markdown.is_empty() {
                return Err("the page has no readable content".to_owned());
            }
            let body = format!("{markdown}\n\nSource: <{final_url}>");
            return Ok(markdown_source(&page_title, body));
        }
        "text/plain" => "txt",
        "text/markdown" | "text/x-markdown" => "md",
        "text/csv" => "csv",
        "text/tab-separated-values" => "tsv",
        "application/pdf" => "pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/epub+zip" => "epub",
        other => return Err(format!("{other} is not an importable page")),
    };
    let name = format!("{}.{extension}", safe_title(&file_title));
    Ok(ImportSource {
        mime: mime_for_name(&name).to_owned(),
        name,
        bytes: reply.body,
    })
}

async fn fetch_web(http: &dyn ImportHttp, urls: &[String], max_items: usize) -> Fetched {
    let mut fetched = Fetched::default();
    for url in urls.iter().take(max_items) {
        match fetch_web_page(http, url).await {
            Ok(source) => fetched.sources.push(source),
            Err(error) => fetched.failures.push(format!("{url}: {error}")),
        }
    }
    fetched
}

// ── Notion ───────────────────────────────────────────────────────────────────

/// A Notion block plus its loaded children.
#[derive(Clone, Debug)]
pub(super) struct NotionNode {
    block: Value,
    children: Vec<NotionNode>,
}

fn notion_headers(credential: &ConnectorCredential) -> Vec<(String, String)> {
    vec![
        (
            "authorization".to_owned(),
            format!("Bearer {}", credential.token),
        ),
        ("notion-version".to_owned(), NOTION_VERSION.to_owned()),
    ]
}

/// Render a Notion rich-text array as Markdown.
pub(super) fn notion_rich_text(value: &Value) -> String {
    let mut out = String::new();
    for part in value.as_array().into_iter().flatten() {
        let raw = part["plain_text"].as_str().unwrap_or_default();
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            out.push_str(raw);
            continue;
        }
        let annotations = &part["annotations"];
        let mut text = trimmed.to_owned();
        if annotations["code"] == true {
            text = format!("`{text}`");
        }
        if annotations["bold"] == true {
            text = format!("**{text}**");
        }
        if annotations["italic"] == true {
            text = format!("*{text}*");
        }
        if annotations["strikethrough"] == true {
            text = format!("~~{text}~~");
        }
        if let Some(href) = part["href"].as_str() {
            text = format!("[{text}]({href})");
        }
        let lead = &raw[..raw.len() - raw.trim_start().len()];
        let tail = &raw[raw.trim_end().len()..];
        out.push_str(lead);
        out.push_str(&text);
        out.push_str(tail);
    }
    out
}

fn notion_file_url(value: &Value) -> Option<&str> {
    value["external"]["url"]
        .as_str()
        .or_else(|| value["file"]["url"].as_str())
        .or_else(|| value["url"].as_str())
}

fn indent_lines(text: &str, prefix: &str) -> String {
    text.lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn notion_table(node: &NotionNode) -> String {
    let rows: Vec<Vec<String>> = node
        .children
        .iter()
        .filter(|child| child.block["type"] == "table_row")
        .map(|child| {
            child.block["table_row"]["cells"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|cell| {
                    notion_rich_text(cell)
                        .replace('|', "\\|")
                        .replace('\n', " ")
                })
                .collect()
        })
        .collect();
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let line = |cells: &[String]| {
        let mut padded = cells.to_vec();
        padded.resize(width, String::new());
        format!("| {} |", padded.join(" | "))
    };
    let mut lines = vec![line(&rows[0]), line(&vec!["---".to_owned(); width])];
    lines.extend(rows[1..].iter().map(|row| line(row)));
    lines.join("\n")
}

fn notion_block(node: &NotionNode, number: usize) -> String {
    let kind = node.block["type"].as_str().unwrap_or_default();
    let data = &node.block[kind];
    let text = notion_rich_text(&data["rich_text"]);
    let children = notion_markdown(&node.children);
    let nested = if children.is_empty() {
        String::new()
    } else {
        format!("\n{}", indent_lines(&children, "  "))
    };
    let with_children = |head: String| {
        if children.is_empty() {
            head
        } else {
            format!("{head}\n\n{children}")
        }
    };
    match kind {
        "paragraph" => with_children(text),
        "heading_1" => with_children(format!("# {text}")),
        "heading_2" => with_children(format!("## {text}")),
        "heading_3" => with_children(format!("### {text}")),
        "bulleted_list_item" | "toggle" => format!("- {text}{nested}"),
        "numbered_list_item" => format!("{number}. {text}{nested}"),
        "to_do" => format!(
            "- [{}] {text}{nested}",
            if data["checked"] == true { "x" } else { " " }
        ),
        "quote" | "callout" => indent_lines(&with_children(text), "> "),
        "code" => {
            let language = data["language"].as_str().unwrap_or_default();
            let language = if language == "plain text" {
                ""
            } else {
                language
            };
            format!(
                "```{language}\n{}\n```",
                notion_rich_text(&data["rich_text"])
            )
        }
        "equation" => format!(
            "$$\n{}\n$$",
            data["expression"].as_str().unwrap_or_default()
        ),
        "divider" => "---".to_owned(),
        "image" => notion_file_url(data)
            .map(|url| format!("![{}]({url})", notion_rich_text(&data["caption"])))
            .unwrap_or_default(),
        "file" | "pdf" | "video" | "audio" | "bookmark" | "embed" | "link_preview" => {
            notion_file_url(data)
                .map(|url| {
                    let caption = notion_rich_text(&data["caption"]);
                    let label = if caption.is_empty() {
                        url.to_owned()
                    } else {
                        caption
                    };
                    format!("[{label}]({url})")
                })
                .unwrap_or_default()
        }
        "child_page" | "child_database" => {
            format!("**{}**", data["title"].as_str().unwrap_or("Untitled"))
        }
        "table" => notion_table(node),
        _ => [text, children]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

/// Render a loaded Notion block tree as Markdown.
pub(super) fn notion_markdown(nodes: &[NotionNode]) -> String {
    let list_like =
        |kind: &str| matches!(kind, "bulleted_list_item" | "numbered_list_item" | "to_do");
    let mut out = String::new();
    let mut number = 0;
    let mut previous = String::new();
    for node in nodes {
        let kind = node.block["type"].as_str().unwrap_or_default().to_owned();
        number = if kind == "numbered_list_item" {
            number + 1
        } else {
            0
        };
        let rendered = notion_block(node, number);
        let rendered = rendered.trim_end();
        if !rendered.is_empty() {
            if !out.is_empty() {
                out.push_str(if list_like(&kind) && list_like(&previous) {
                    "\n"
                } else {
                    "\n\n"
                });
            }
            out.push_str(rendered);
        }
        previous = kind;
    }
    out
}

fn notion_tree<'a, 'b>(
    http: &'a dyn ImportHttp,
    headers: &'a [(String, String)],
    block_id: String,
    budget: &'b mut usize,
    depth: usize,
) -> Pin<Box<dyn Future<Output = Result<Vec<NotionNode>, String>> + Send + 'b>>
where
    'a: 'b,
{
    Box::pin(async move {
        let mut nodes = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut pairs = vec![("page_size", "100")];
            if let Some(cursor) = cursor.as_deref() {
                pairs.push(("start_cursor", cursor));
            }
            let base = format!(
                "{NOTION_API}/blocks/{}/children",
                urlencoding::encode(&block_id)
            );
            let page = send_json(http, HttpRequest::get(url_with(&base, &pairs), headers)).await?;
            for block in page["results"].as_array().into_iter().flatten() {
                if *budget == 0 {
                    break;
                }
                *budget -= 1;
                let kind = block["type"].as_str().unwrap_or_default();
                let recurse = block["has_children"] == true
                    && depth + 1 < MAX_NOTION_DEPTH
                    && !matches!(kind, "child_page" | "child_database");
                let children = match (recurse, block["id"].as_str()) {
                    (true, Some(id)) => {
                        notion_tree(http, headers, id.to_owned(), &mut *budget, depth + 1).await?
                    }
                    _ => Vec::new(),
                };
                nodes.push(NotionNode {
                    block: block.clone(),
                    children,
                });
            }
            cursor = page["next_cursor"].as_str().map(str::to_owned);
            if page["has_more"] != true || cursor.is_none() || *budget == 0 {
                break;
            }
        }
        Ok(nodes)
    })
}

/// Flatten a Notion property value into one database cell.
pub(super) fn notion_property_text(property: &Value) -> String {
    let kind = property["type"].as_str().unwrap_or_default();
    let value = &property[kind];
    let names = |items: &Value, key: &str| {
        items
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item[key].as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    match kind {
        "title" | "rich_text" => names(value, "plain_text"),
        "select" | "status" => value["name"].as_str().unwrap_or_default().to_owned(),
        "multi_select" => names(value, "name"),
        "people" => names(value, "name"),
        "relation" => names(value, "id"),
        "date" => match (value["start"].as_str(), value["end"].as_str()) {
            (Some(start), Some(end)) => format!("{start}/{end}"),
            (Some(start), None) => start.to_owned(),
            _ => String::new(),
        },
        "formula" | "rollup" => notion_property_text(value),
        "unique_id" => match (value["prefix"].as_str(), value["number"].as_i64()) {
            (Some(prefix), Some(number)) => format!("{prefix}-{number}"),
            (None, Some(number)) => number.to_string(),
            _ => String::new(),
        },
        "created_by" | "last_edited_by" => value["name"]
            .as_str()
            .or_else(|| value["id"].as_str())
            .unwrap_or_default()
            .to_owned(),
        "files" => value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(notion_file_url)
            .collect::<Vec<_>>()
            .join(", "),
        _ => match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => String::new(),
        },
    }
}

fn notion_page_title(page: &Value) -> String {
    page["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .find(|(_, property)| property["type"] == "title")
        .map(|(_, property)| notion_property_text(property))
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_owned())
}

async fn notion_database(
    http: &dyn ImportHttp,
    headers: &[(String, String)],
    database_id: &str,
    max_rows: usize,
) -> Result<ImportSource, String> {
    let encoded = urlencoding::encode(database_id);
    let database = send_json(
        http,
        HttpRequest::get(format!("{NOTION_API}/databases/{encoded}"), headers),
    )
    .await?;
    let title = notion_rich_text(&database["title"]);
    let mut rows: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut body = json!({ "page_size": (max_rows - rows.len()).min(100) });
        if let Some(cursor) = &cursor {
            body["start_cursor"] = json!(cursor);
        }
        let page = send_json(
            http,
            HttpRequest::post_json(
                format!("{NOTION_API}/databases/{encoded}/query"),
                headers,
                &body,
            ),
        )
        .await?;
        rows.extend(page["results"].as_array().into_iter().flatten().cloned());
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if page["has_more"] != true || cursor.is_none() || rows.len() >= max_rows {
            break;
        }
    }
    rows.truncate(max_rows);
    // Column order: the title property first, then the schema's other
    // properties by name, so the grid is stable across imports.
    let schema = database["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut columns: Vec<&String> = schema.keys().collect();
    columns.sort_by_key(|name| {
        (
            schema[name.as_str()]["type"] != "title",
            name.to_lowercase(),
        )
    });
    let mut table = vec![columns
        .iter()
        .map(|name| (*name).clone())
        .collect::<Vec<_>>()];
    for row in &rows {
        table.push(
            columns
                .iter()
                .map(|name| notion_property_text(&row["properties"][name.as_str()]))
                .collect(),
        );
    }
    if columns.is_empty() {
        return Err("the database has no properties".to_owned());
    }
    let title = if title.trim().is_empty() {
        "Notion database".to_owned()
    } else {
        title
    };
    Ok(csv_source(&title, &table))
}

async fn fetch_notion(
    http: &dyn ImportHttp,
    credential: &ConnectorCredential,
    pages: &[String],
    databases: &[String],
    max_items: usize,
) -> Result<Fetched, String> {
    let headers = notion_headers(credential);
    let mut fetched = Fetched::default();
    for page_id in pages.iter().take(max_items) {
        let result = async {
            let encoded = urlencoding::encode(page_id);
            let page = send_json(
                http,
                HttpRequest::get(format!("{NOTION_API}/pages/{encoded}"), &headers),
            )
            .await?;
            let mut budget = MAX_NOTION_BLOCKS;
            let tree = notion_tree(http, &headers, page_id.clone(), &mut budget, 0).await?;
            let mut markdown = notion_markdown(&tree);
            if let Some(url) = page["url"].as_str() {
                markdown.push_str(&format!("\n\nSource: <{url}>"));
            }
            Ok::<_, String>(markdown_source(&notion_page_title(&page), markdown))
        }
        .await;
        match result {
            Ok(source) => fetched.sources.push(source),
            Err(error) => fetched
                .failures
                .push(format!("Notion page {page_id}: {error}")),
        }
    }
    // Each database is one item; together with the pages they stay within
    // `max_items`, so a request cannot widen the import by listing more ids.
    let remaining = max_items.saturating_sub(pages.len().min(max_items));
    if databases.len() > remaining {
        fetched.failures.push(format!(
            "{} Notion database(s) skipped: the import is limited to {max_items} items",
            databases.len() - remaining
        ));
    }
    for database_id in databases.iter().take(remaining) {
        match notion_database(http, &headers, database_id, max_items).await {
            Ok(source) => fetched.sources.push(source),
            Err(error) => fetched
                .failures
                .push(format!("Notion database {database_id}: {error}")),
        }
    }
    Ok(fetched)
}

// ── Google Drive ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct DriveFile {
    id: String,
    name: String,
    mime: String,
}

fn drive_file(value: &Value) -> Option<DriveFile> {
    Some(DriveFile {
        id: value["id"].as_str()?.to_owned(),
        name: value["name"].as_str()?.to_owned(),
        mime: value["mimeType"].as_str()?.to_owned(),
    })
}

async fn drive_download(
    http: &dyn ImportHttp,
    headers: &[(String, String)],
    file: &DriveFile,
) -> Result<ImportSource, String> {
    let encoded = urlencoding::encode(&file.id);
    let export = match file.mime.as_str() {
        "application/vnd.google-apps.document" => Some(("text/markdown", "md")),
        "application/vnd.google-apps.spreadsheet" => Some(("text/csv", "csv")),
        "application/vnd.google-apps.presentation" => Some(("text/plain", "txt")),
        _ => None,
    };
    if let Some((mime, extension)) = export {
        let url = url_with(
            &format!("{DRIVE_API}/files/{encoded}/export"),
            &[("mimeType", mime)],
        );
        let (reply, _) = send_following(http, HttpRequest::get(url, headers)).await?;
        return Ok(ImportSource {
            name: format!("{}.{extension}", safe_title(&file.name)),
            mime: mime.to_owned(),
            bytes: reply.body,
        });
    }
    if file.mime.starts_with("application/vnd.google-apps.") {
        return Err(format!("{} files cannot be imported", file.mime));
    }
    if import_kind(&file.name).is_none() {
        return Err("unsupported format".to_owned());
    }
    let url = url_with(
        &format!("{DRIVE_API}/files/{encoded}"),
        &[("alt", "media"), ("supportsAllDrives", "true")],
    );
    let (reply, _) = send_following(http, HttpRequest::get(url, headers)).await?;
    Ok(ImportSource {
        name: file.name.replace(['/', '\\'], " "),
        mime: file.mime.clone(),
        bytes: reply.body,
    })
}

async fn fetch_drive(
    http: &dyn ImportHttp,
    credential: &ConnectorCredential,
    files: &[String],
    folders: &[String],
    max_items: usize,
) -> Result<Fetched, String> {
    let headers = vec![(
        "authorization".to_owned(),
        format!("Bearer {}", credential.token),
    )];
    let mut fetched = Fetched::default();
    let mut queue: Vec<DriveFile> = Vec::new();
    for id in files {
        let url = url_with(
            &format!("{DRIVE_API}/files/{}", urlencoding::encode(id)),
            &[("fields", DRIVE_FILE_FIELDS), ("supportsAllDrives", "true")],
        );
        match send_json(http, HttpRequest::get(url, &headers)).await {
            Ok(value) => match drive_file(&value) {
                Some(file) => queue.push(file),
                None => fetched
                    .failures
                    .push(format!("Drive file {id}: no metadata")),
            },
            Err(error) => fetched.failures.push(format!("Drive file {id}: {error}")),
        }
    }
    for folder in folders {
        let query = format!("'{folder}' in parents and trashed = false");
        let fields = format!("nextPageToken,files({DRIVE_FILE_FIELDS})");
        let mut token: Option<String> = None;
        loop {
            let mut pairs = vec![
                ("q", query.as_str()),
                ("fields", fields.as_str()),
                ("pageSize", "100"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ];
            if let Some(token) = token.as_deref() {
                pairs.push(("pageToken", token));
            }
            let page = match send_json(
                http,
                HttpRequest::get(url_with(&format!("{DRIVE_API}/files"), &pairs), &headers),
            )
            .await
            {
                Ok(page) => page,
                // One unreadable folder is a per-item failure, like an unreadable
                // file, not the end of the whole import.
                Err(error) => {
                    fetched
                        .failures
                        .push(format!("Drive folder {folder}: {error}"));
                    break;
                }
            };
            queue.extend(
                page["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(drive_file)
                    .filter(|file| file.mime != "application/vnd.google-apps.folder"),
            );
            token = page["nextPageToken"].as_str().map(str::to_owned);
            if token.is_none() || queue.len() >= max_items {
                break;
            }
        }
    }
    for file in queue.iter().take(max_items) {
        match drive_download(http, &headers, file).await {
            Ok(source) => fetched.sources.push(source),
            Err(error) => fetched.failures.push(format!("{}: {error}", file.name)),
        }
    }
    Ok(fetched)
}

// ── Confluence ───────────────────────────────────────────────────────────────

/// Where and how to reach a Confluence site.
#[derive(Debug)]
pub(super) struct ConfluenceSite {
    base_url: String,
    authorization: String,
}

/// Bind the credential to a site. A stored `base_url` wins (and must match any
/// requested one); otherwise only Atlassian Cloud sites are accepted, so a
/// request cannot point a node's token at an arbitrary host.
pub(super) fn confluence_site(
    requested: Option<&str>,
    email: Option<&str>,
    credential: &ConnectorCredential,
) -> Result<ConfluenceSite, String> {
    let base_url = match (&credential.base_url, requested) {
        (Some(stored), Some(requested))
            if stored.trim_end_matches('/') != requested.trim_end_matches('/') =>
        {
            return Err("base_url does not match the credential's base_url".to_owned());
        }
        (Some(stored), _) => stored.clone(),
        (None, Some(requested)) => {
            let host = host_of(requested).to_ascii_lowercase();
            if !host.ends_with(".atlassian.net") {
                return Err(
                    "a Confluence Data Center base_url must be stored with the credential \
                     ({\"base_url\": ..., \"token\": ...})"
                        .to_owned(),
                );
            }
            requested.trim_end_matches('/').to_owned()
        }
        (None, None) => return Err("confluence imports need base_url".to_owned()),
    };
    let authorization = match credential.email.as_deref().or(email) {
        Some(email) => format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("{email}:{}", credential.token))
        ),
        None => format!("Bearer {}", credential.token),
    };
    Ok(ConfluenceSite {
        base_url,
        authorization,
    })
}

const CONFLUENCE_EXPAND: &str = "body.export_view,body.storage,version,space";

fn confluence_html(page: &Value) -> &str {
    ["export_view", "view", "storage"]
        .iter()
        .find_map(|key| page["body"][key]["value"].as_str())
        .unwrap_or_default()
}

async fn fetch_confluence(
    http: &dyn ImportHttp,
    site: &ConfluenceSite,
    pages: &[String],
    space_key: Option<&str>,
    max_items: usize,
) -> Result<Fetched, String> {
    let headers = vec![
        ("authorization".to_owned(), site.authorization.clone()),
        ("accept".to_owned(), "application/json".to_owned()),
    ];
    let api = format!("{}/rest/api/content", site.base_url);
    let mut fetched = Fetched::default();
    let mut found: Vec<Value> = Vec::new();
    for id in pages.iter().take(max_items) {
        let url = url_with(&format!("{api}/{id}"), &[("expand", CONFLUENCE_EXPAND)]);
        match send_json(http, HttpRequest::get(url, &headers)).await {
            Ok(page) => found.push(page),
            Err(error) => fetched
                .failures
                .push(format!("Confluence page {id}: {error}")),
        }
    }
    if let Some(key) = space_key {
        let mut start = 0_usize;
        while found.len() < max_items {
            let limit = (max_items - found.len()).min(50).to_string();
            let start_text = start.to_string();
            let url = url_with(
                &api,
                &[
                    ("spaceKey", key),
                    ("type", "page"),
                    ("status", "current"),
                    ("expand", CONFLUENCE_EXPAND),
                    ("start", &start_text),
                    ("limit", &limit),
                ],
            );
            let page = send_json(http, HttpRequest::get(url, &headers)).await?;
            let results = page["results"].as_array().cloned().unwrap_or_default();
            let count = results.len();
            found.extend(results);
            if count == 0 || !page["_links"]["next"].is_string() {
                break;
            }
            start += count;
        }
        found.truncate(max_items);
    }
    for page in &found {
        let title = page["title"].as_str().unwrap_or("Untitled");
        let markdown = html_markdown::html_to_markdown(
            confluence_html(page),
            Some(&format!("{}/", site.base_url)),
        );
        let link = page["_links"]["webui"]
            .as_str()
            .map(|path| format!("\n\nSource: <{}{path}>", site.base_url))
            .unwrap_or_default();
        fetched
            .sources
            .push(markdown_source(title, format!("{markdown}{link}")));
    }
    Ok(fetched)
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/// A repository and the part of it to import.
pub(super) struct GitHubRepository<'a> {
    owner: &'a str,
    repo: &'a str,
    git_ref: Option<&'a str>,
    path: Option<&'a str>,
}

async fn fetch_github(
    http: &dyn ImportHttp,
    credential: Option<&ConnectorCredential>,
    repository: &GitHubRepository<'_>,
    max_items: usize,
) -> Result<Fetched, String> {
    let mut headers = vec![
        (
            "accept".to_owned(),
            "application/vnd.github+json".to_owned(),
        ),
        ("x-github-api-version".to_owned(), "2022-11-28".to_owned()),
    ];
    if let Some(credential) = credential {
        headers.push((
            "authorization".to_owned(),
            format!("Bearer {}", credential.token),
        ));
    }
    let api = format!(
        "{GITHUB_API}/repos/{}/{}",
        repository.owner, repository.repo
    );
    let git_ref = match repository.git_ref {
        Some(value) => value.to_owned(),
        None => send_json(http, HttpRequest::get(api.clone(), &headers)).await?["default_branch"]
            .as_str()
            .ok_or_else(|| "GitHub returned no default branch".to_owned())?
            .to_owned(),
    };
    let tree_url = url_with(
        &format!("{api}/git/trees/{}", urlencoding::encode(&git_ref)),
        &[("recursive", "1")],
    );
    let tree = send_json(http, HttpRequest::get(tree_url, &headers)).await?;
    let prefix = repository.path.map(|path| format!("{path}/"));
    let paths: Vec<String> = tree["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["type"] == "blob")
        .filter(|entry| entry["size"].as_u64().unwrap_or(0) <= MAX_GITHUB_FILE_BYTES)
        .filter_map(|entry| entry["path"].as_str())
        .filter(|path| {
            prefix
                .as_deref()
                .is_none_or(|prefix| path.starts_with(prefix))
        })
        .filter(|path| import_kind(path).is_some_and(|kind| kind != super::ImportKind::Archive))
        .take(max_items)
        .map(str::to_owned)
        .collect();
    let mut fetched = Fetched::default();
    if paths.is_empty() {
        fetched.failures.push(
            "no importable files (Markdown, text, HTML, PDF, Office, CSV) matched".to_owned(),
        );
    }
    let mut raw_headers = headers.clone();
    raw_headers[0].1 = "application/vnd.github.raw".to_owned();
    for path in paths {
        let encoded_path = path
            .split('/')
            .map(|part| urlencoding::encode(part).into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let url = url_with(
            &format!("{api}/contents/{encoded_path}"),
            &[("ref", &git_ref)],
        );
        match send_following(http, HttpRequest::get(url, &raw_headers)).await {
            Ok((reply, _)) => fetched.sources.push(ImportSource {
                name: path.replace('/', " - "),
                mime: mime_for_name(&path).to_owned(),
                bytes: reply.body,
            }),
            Err(error) => fetched.failures.push(format!("{path}: {error}")),
        }
    }
    Ok(fetched)
}

#[cfg(test)]
mod tests;
