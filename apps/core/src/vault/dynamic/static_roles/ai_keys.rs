//! AI provider key rotators: OpenAI project service accounts and Anthropic
//! staged API keys, both driven by an organization Admin API key.
//!
//! Upstream error messages are reduced to the HTTP status and the vendor's
//! error `type`/`code`, so no response body (which could echo a key) reaches
//! `lastError` or the audit log.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

const OPENAI_BASE: &str = "https://api.openai.com";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_SERVICE_ACCOUNT_NAME: &str = "ryu-rotated";
/// Pages of 100 keys read while looking for a staged Anthropic key.
const ANTHROPIC_MAX_PAGES: usize = 50;

pub(super) fn default_service_account_name() -> String {
    DEFAULT_SERVICE_ACCOUNT_NAME.to_owned()
}

#[cfg(test)]
thread_local! {
    /// Test-only base URL for both vendors (a local fake).
    pub(super) static AI_ENDPOINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn base_url(production: &str) -> String {
    #[cfg(test)]
    if let Some(endpoint) = AI_ENDPOINT.with(|cell| cell.borrow().clone()) {
        return endpoint;
    }
    production.to_owned()
}

fn is_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(super) fn validate_openai(
    admin_api_key: &str,
    project_id: &str,
    service_account_name: &str,
    current_service_account_id: Option<&str>,
) -> Result<()> {
    if admin_api_key.trim().is_empty() {
        bail!("adminApiKey is required");
    }
    if !project_id.starts_with("proj_") || !is_id(project_id, 128) {
        bail!("projectId must be an OpenAI project id (proj_…)");
    }
    if !is_id(service_account_name, 40) {
        bail!("serviceAccountName must be 1-40 letters, digits, _ or -");
    }
    if current_service_account_id.is_some_and(|id| !is_id(id, 128)) {
        bail!("currentServiceAccountId is not a service account id");
    }
    Ok(())
}

pub(super) fn validate_anthropic(
    admin_api_key: &str,
    workspace_id: Option<&str>,
    replacement_api_key: Option<&str>,
    current_api_key_id: Option<&str>,
) -> Result<()> {
    if !admin_api_key.starts_with("sk-ant-admin") {
        bail!("adminApiKey must be an Anthropic Admin API key (sk-ant-admin…)");
    }
    if workspace_id.is_some_and(|id| !is_id(id, 128)) {
        bail!("workspaceId is not a workspace id");
    }
    if let Some(key) = replacement_api_key {
        if !key.starts_with("sk-ant-") || key.starts_with("sk-ant-admin") {
            bail!("replacementApiKey must be an Anthropic API key (sk-ant-…), not an admin key");
        }
        if key.len() > 512 || key.bytes().any(|b| b.is_ascii_whitespace()) {
            bail!("replacementApiKey is not an API key");
        }
    }
    if current_api_key_id.is_some_and(|id| !is_id(id, 128)) {
        bail!("currentApiKeyId is not an API key id");
    }
    Ok(())
}

/// A minted (or adopted) key: its upstream id and the value to store.
pub(super) struct MintedKey {
    pub id: String,
    pub value: String,
}

impl MintedKey {
    /// The sealed pending form.
    pub(super) fn to_pending(&self) -> String {
        json!({ "id": self.id, "value": self.value }).to_string()
    }

    pub(super) fn from_pending(pending: &str) -> Result<Self> {
        let parsed: Value = serde_json::from_str(pending).context("reading the pending key")?;
        let field = |name: &str| {
            parsed
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("the pending key has no {name}"))
        };
        Ok(Self {
            id: field("id")?,
            value: field("value")?,
        })
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// `"<vendor> returned <status> (<type or code>)"`, never the body text.
async fn upstream_error(vendor: &str, response: reqwest::Response) -> anyhow::Error {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let error = body.get("error").unwrap_or(&Value::Null);
    let code = ["type", "code"]
        .iter()
        .filter_map(|field| error.get(*field).and_then(Value::as_str))
        .find(|code| is_id(code, 64))
        .unwrap_or("unknown");
    anyhow!("{vendor} returned {status} ({code})")
}

// ── OpenAI ────────────────────────────────────────────────────────────────

/// Create a project service account; its API key is the new value.
pub(super) async fn openai_mint(
    admin_api_key: &str,
    project_id: &str,
    service_account_name: &str,
) -> Result<MintedKey> {
    let name = format!(
        "{service_account_name}-{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S")
    );
    let response = client()
        .post(format!(
            "{}/v1/organization/projects/{project_id}/service_accounts",
            base_url(OPENAI_BASE)
        ))
        .bearer_auth(admin_api_key)
        .json(&json!({ "name": name }))
        .send()
        .await
        .context("calling the OpenAI Admin API")?;
    if !response.status().is_success() {
        return Err(upstream_error("OpenAI", response).await);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("OpenAI returned an unreadable service account"))?;
    let id = body.get("id").and_then(Value::as_str);
    let value = body.pointer("/api_key/value").and_then(Value::as_str);
    match (id, value) {
        (Some(id), Some(value)) if is_id(id, 128) && !value.trim().is_empty() => Ok(MintedKey {
            id: id.to_owned(),
            value: value.to_owned(),
        }),
        _ => bail!("OpenAI returned no service account id or API key"),
    }
}

/// Delete service accounts. A service account OpenAI no longer knows counts
/// as deleted. Returns the ids still live and a warning.
pub(super) async fn openai_retire(
    admin_api_key: &str,
    project_id: &str,
    ids: Vec<String>,
) -> (Vec<String>, Option<String>) {
    let mut kept = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        if kept.contains(&id) {
            continue;
        }
        let result = client()
            .delete(format!(
                "{}/v1/organization/projects/{project_id}/service_accounts/{id}",
                base_url(OPENAI_BASE)
            ))
            .bearer_auth(admin_api_key)
            .send()
            .await;
        let error = match result {
            Ok(response) if response.status().is_success() => continue,
            Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => continue,
            Ok(response) => upstream_error("OpenAI", response).await,
            Err(_) => anyhow!("OpenAI could not be reached"),
        };
        errors.push(format!("{id}: {error}"));
        kept.push(id);
    }
    let warning = (!errors.is_empty()).then(|| {
        format!(
            "previous service account(s) not deleted yet; retried on the next rotation: {}",
            errors.join("; ")
        )
    });
    (kept, warning)
}

// ── Anthropic ─────────────────────────────────────────────────────────────

/// Whether `key` matches a `partial_key_hint` such as `sk-ant-api03-R2D...igAA`.
pub(super) fn hint_matches(hint: &str, key: &str) -> bool {
    match hint.split_once("...") {
        Some((prefix, suffix)) => {
            prefix.len() >= 8
                && !suffix.is_empty()
                && key.len() >= prefix.len() + suffix.len()
                && key.starts_with(prefix)
                && key.ends_with(suffix)
        }
        None => false,
    }
}

fn anthropic_request(
    builder: reqwest::RequestBuilder,
    admin_api_key: &str,
) -> reqwest::RequestBuilder {
    builder
        .header("x-api-key", admin_api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
}

/// Prove the staged key authenticates (`GET /v1/models` with it). A hint
/// match alone accepts a key mistyped in the middle, and adopting one would
/// deactivate the working key with nothing usable in its place. Errors carry
/// only the status and error type.
pub(super) async fn anthropic_probe(replacement_api_key: &str) -> Result<()> {
    let response = anthropic_request(
        client()
            .get(format!("{}/v1/models", base_url(ANTHROPIC_BASE)))
            .query(&[("limit", "1")]),
        replacement_api_key,
    )
    .send()
    .await
    .map_err(|_| anyhow!("Anthropic could not be reached to check the staged key"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let error = upstream_error("Anthropic", response).await;
    bail!("the staged replacement key does not authenticate: {error}")
}

/// Find the staged key's id among the organization's active keys. Refuses a
/// key the Admin API cannot see (so its successor could never be
/// deactivated) and an ambiguous hint. The caller then proves the key
/// authenticates with [`anthropic_probe`].
pub(super) async fn anthropic_adopt(
    admin_api_key: &str,
    workspace_id: Option<&str>,
    replacement_api_key: &str,
) -> Result<MintedKey> {
    let mut matches: Vec<String> = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..ANTHROPIC_MAX_PAGES {
        let mut query: Vec<(&str, String)> =
            vec![("limit", "100".into()), ("status", "active".into())];
        if let Some(workspace) = workspace_id {
            query.push(("workspace_id", workspace.to_owned()));
        }
        if let Some(after) = &after {
            query.push(("after_id", after.clone()));
        }
        let response = anthropic_request(
            client()
                .get(format!(
                    "{}/v1/organizations/api_keys",
                    base_url(ANTHROPIC_BASE)
                ))
                .query(&query),
            admin_api_key,
        )
        .send()
        .await
        .context("calling the Anthropic Admin API")?;
        if !response.status().is_success() {
            return Err(upstream_error("Anthropic", response).await);
        }
        let page: Value = response
            .json()
            .await
            .map_err(|_| anyhow!("Anthropic returned an unreadable key list"))?;
        for key in page
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let hint = key
                .get("partial_key_hint")
                .and_then(Value::as_str)
                .unwrap_or("");
            let active = key.get("status").and_then(Value::as_str) == Some("active");
            if let (true, Some(id)) = (active, key.get("id").and_then(Value::as_str)) {
                if hint_matches(hint, replacement_api_key) && is_id(id, 128) {
                    matches.push(id.to_owned());
                }
            }
        }
        let more = page
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        after = page
            .get("last_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if !more || after.is_none() {
            break;
        }
    }
    match matches.as_slice() {
        [id] => Ok(MintedKey {
            id: id.clone(),
            value: replacement_api_key.to_owned(),
        }),
        [] => {
            bail!("the staged replacement key is not an active key this Admin API key can manage")
        }
        _ => bail!("the staged replacement key matches several keys; create another one"),
    }
}

/// Deactivate API keys (`status: inactive`). A key Anthropic no longer
/// knows counts as retired. Returns the ids still active and a warning.
pub(super) async fn anthropic_retire(
    admin_api_key: &str,
    ids: Vec<String>,
) -> (Vec<String>, Option<String>) {
    let mut kept = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        if kept.contains(&id) {
            continue;
        }
        let result = anthropic_request(
            client()
                .post(format!(
                    "{}/v1/organizations/api_keys/{id}",
                    base_url(ANTHROPIC_BASE)
                ))
                .json(&json!({ "status": "inactive" })),
            admin_api_key,
        )
        .send()
        .await;
        let error = match result {
            Ok(response) if response.status().is_success() => continue,
            Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => continue,
            Ok(response) => upstream_error("Anthropic", response).await,
            Err(_) => anyhow!("Anthropic could not be reached"),
        };
        errors.push(format!("{id}: {error}"));
        kept.push(id);
    }
    let warning = (!errors.is_empty()).then(|| {
        format!(
            "previous API key(s) not deactivated yet; retried on the next rotation: {}",
            errors.join("; ")
        )
    });
    (kept, warning)
}
