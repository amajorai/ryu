//! Remote execution handoff to the independently running Connect service.
//! The verified Core user selects an operator-configured tenant credential.
//! Neither tool arguments nor the selected account can change that tenant.
//!
//! An agent's own account lives inside its owner's tenant: the `*_as` calls
//! take the owner as `user_id` (which still selects the credential) and the
//! agent id as `agent`, sent as Connect's `agentId`. Connect derives the
//! agent's Composio user from the tenant's, so an agent id can never reach
//! another tenant or the tenant's own account. An agent entity string
//! (`agent:<owner>:<agent_id>`) is never accepted as a Connect user.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn is_configured() -> bool {
    std::env::var_os("RYU_CONNECT_URL").is_some()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTrigger {
    pub id: String,
    pub trigger_id: Option<String>,
    pub trigger_slug: String,
    pub connected_account_id: String,
    pub user_id: String,
    pub auth_config_id: String,
    pub status: String,
}

fn managed_trigger(value: Value) -> Result<ManagedTrigger> {
    let record: ManagedTrigger = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("Invalid Connect trigger metadata"))?;
    uuid::Uuid::parse_str(&record.id).context("Invalid Connect trigger ID")?;
    for field in [
        &record.trigger_slug,
        &record.connected_account_id,
        &record.user_id,
        &record.auth_config_id,
    ] {
        if field.is_empty()
            || field.len() > 256
            || field.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            bail!("Invalid Connect trigger identity");
        }
    }
    if !matches!(
        record.status.as_str(),
        "pending" | "active" | "deleting" | "deleted"
    ) || record.trigger_id.as_ref().is_some_and(|id| {
        id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_whitespace() || c.is_control())
    }) || (record.status == "active" && record.trigger_id.is_none())
    {
        bail!("Invalid Connect trigger state");
    }
    Ok(record)
}

async fn trigger_request(
    method: reqwest::Method,
    id: Option<&str>,
    body: Option<Value>,
    user_id: Option<&str>,
) -> Result<Value> {
    let (base, token) = configuration_from(user_id, "RYU_CONNECT_USER_MANAGEMENT_TOKENS")?;
    let mut endpoint = origin(&base)?;
    endpoint.set_path("/v1/composio/triggers");
    if let Some(id) = id {
        uuid::Uuid::parse_str(id).context("Invalid Connect trigger ID")?;
        endpoint
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid Connect endpoint"))?
            .push(id);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(95))
        .build()?;
    let mut request = client.request(method, endpoint).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Connect trigger management unavailable"))?;
    response_json(response).await
}

pub async fn create_trigger(
    slug: &str,
    account_id: &str,
    config: &Value,
    user_id: Option<&str>,
) -> Option<Result<ManagedTrigger>> {
    if !is_configured() {
        return None;
    }
    Some(async {
        if slug.is_empty() || slug.len() > 128 || account_id.is_empty() || account_id.len() > 256 || !config.is_object() || serde_json::to_vec(config)?.len() > 16_384 { bail!("Invalid Connect trigger request"); }
        let record = managed_trigger(trigger_request(reqwest::Method::POST, None, Some(json!({"triggerSlug":slug,"triggerConfig":config,"expectedAccountId":account_id})), user_id).await?)?;
        if record.trigger_slug != slug || record.connected_account_id != account_id {
            bail!("Connect returned a different trigger binding");
        }
        Ok(record)
    }.await)
}

pub async fn list_triggers(user_id: Option<&str>) -> Option<Result<Vec<ManagedTrigger>>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let value = trigger_request(reqwest::Method::GET, None, None, user_id).await?;
            let rows = value
                .get("triggers")
                .and_then(Value::as_array)
                .filter(|rows| rows.len() <= 256)
                .context("Invalid Connect trigger list")?;
            rows.iter().cloned().map(managed_trigger).collect()
        }
        .await,
    )
}

pub async fn delete_trigger(id: &str, user_id: Option<&str>) -> Option<Result<ManagedTrigger>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let record = managed_trigger(
                trigger_request(reqwest::Method::DELETE, Some(id), None, user_id).await?,
            )?;
            if record.id != id || record.status != "deleted" {
                bail!("Connect did not confirm trigger deletion");
            }
            Ok(record)
        }
        .await,
    )
}

/// Configuration metadata only: do not expose the service origin or credentials.
/// This is not a readiness probe or proof of an active provider account.
pub fn configuration_status(user_id: Option<&str>) -> Option<Value> {
    if !is_configured() {
        return None;
    }
    let configured = configuration(user_id)
        .and_then(|(base, _)| origin(&base))
        .is_ok();
    Some(json!({ "configured": configured, "base_url": "", "execution_owner": "connect" }))
}

fn configuration(user_id: Option<&str>) -> Result<(String, String)> {
    configuration_from(user_id, "RYU_CONNECT_USER_TOKENS")
}

/// The lease token stays private to the transport. Never put it in an agent
/// prompt or derive Debug for this type; payloads are untrusted event data.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLease {
    pub delivery_id: String,
    lease_token: String,
    pub payload: Value,
}

async fn event_request(path: &str, body: Value, user_id: Option<&str>) -> Result<Value> {
    let (base, token) = configuration(user_id)?;
    let mut endpoint = origin(&base)?;
    endpoint.set_path(path);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Connect event inbox unavailable"))?;
    response_json(response).await
}

/// Claim one event so its bounded payload fits the adapter response budget.
/// None means remote mode is not configured; an empty inbox is Ok(None).
pub async fn claim_event(user_id: Option<&str>) -> Option<Result<Option<EventLease>>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let value = event_request("/v1/events/claim", json!({"limit":1}), user_id).await?;
            let events = value
                .get("events")
                .and_then(Value::as_array)
                .context("Invalid Connect event claim")?;
            if events.len() > 1 {
                bail!("Connect returned too many event leases");
            }
            let Some(value) = events.first() else {
                return Ok(None);
            };
            let lease: EventLease = serde_json::from_value(value.clone())
                .map_err(|_| anyhow::anyhow!("Invalid Connect event lease"))?;
            if lease.delivery_id.is_empty()
                || lease.delivery_id.len() > 256
                || lease.delivery_id.chars().any(char::is_whitespace)
                || uuid::Uuid::parse_str(&lease.lease_token)
                    .map(|token| token.to_string() != lease.lease_token)
                    .unwrap_or(true)
            {
                bail!("Invalid Connect event lease identity");
            }
            Ok(Some(lease))
        }
        .await,
    )
}

/// Renew before expiry while handling an event. Failure must not be treated as
/// continued ownership; an expired lease cannot be revived by this request.
pub async fn renew_event(lease: &EventLease, user_id: Option<&str>) -> Option<Result<bool>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let value = event_request(
                "/v1/events/renew",
                json!({"deliveryId":lease.delivery_id,"leaseToken":lease.lease_token}),
                user_id,
            )
            .await?;
            value
                .get("renewed")
                .and_then(Value::as_bool)
                .context("Invalid Connect event renewal")
        }
        .await,
    )
}

/// Call only after successful durable processing. A stale or foreign lease
/// returns false; it must not be treated as a successful acknowledgment.
pub async fn acknowledge_event(lease: &EventLease, user_id: Option<&str>) -> Option<Result<bool>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let value = event_request(
                "/v1/events/ack",
                json!({"deliveryId":lease.delivery_id,"leaseToken":lease.lease_token}),
                user_id,
            )
            .await?;
            value
                .get("acknowledged")
                .and_then(Value::as_bool)
                .context("Invalid Connect event acknowledgment")
        }
        .await,
    )
}

/// Whether `agent_id` is an id Connect accepts for an agent's own account:
/// an ASCII letter or digit, then up to 127 letters, digits, `_` or `-`. It
/// has no `:`, so it can never be confused with a tenant's own user.
pub fn valid_agent_subject(agent_id: &str) -> bool {
    let mut chars = agent_id.chars();
    agent_id.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Refuse an invalid agent id before any request is sent.
fn checked_agent(agent: Option<&str>) -> Result<Option<&str>> {
    match agent {
        Some(agent) if !valid_agent_subject(agent) => bail!("Invalid agent account id"),
        agent => Ok(agent),
    }
}

/// Connect answered with an HTTP error. `Display` is the same message every
/// caller has always received; [`is_subject_unsupported`] reads the code.
#[derive(Debug)]
pub struct ConnectRejected {
    pub status: u16,
    pub code: Option<String>,
}

impl std::fmt::Display for ConnectRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Connect execution rejected with HTTP {}",
            self.status
        )
    }
}

impl std::error::Error for ConnectRejected {}

/// Whether Connect refused an agent's own account because the tenant's
/// binding does not enable agent accounts.
pub fn is_subject_unsupported(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ConnectRejected>()
        .is_some_and(|rejected| rejected.code.as_deref() == Some("subject_unsupported"))
}

fn configuration_from(user_id: Option<&str>, token_env: &str) -> Result<(String, String)> {
    if user_id.is_some_and(|user| user.starts_with("agent:")) {
        // An agent's own entity is never a tenant: its account is reached
        // through its owner's credential and an explicit `agentId`.
        bail!("An agent entity is not a Connect user");
    }
    let base = std::env::var("RYU_CONNECT_URL").context("Invalid Connect URL configuration")?;
    let raw = std::env::var(token_env).context("Connect user credentials are not configured")?;
    let tokens: HashMap<String, String> = serde_json::from_str(&raw)
        .map_err(|_| anyhow::anyhow!("Invalid Connect user credential configuration"))?;
    let token = tokens
        .get(user_id.unwrap_or("local"))
        .filter(|token| !token.trim().is_empty() && token.trim() == token.as_str())
        .context("No Connect credential for the calling user")?;
    Ok((base, token.clone()))
}

/// User-authorized login creation uses a separate tenant management credential.
pub async fn initiate(toolkit: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    initiate_as(toolkit, user_id, None).await
}

/// [`initiate`] for the tenant's own account, or for `agent`'s own account
/// inside it.
pub async fn initiate_as(
    toolkit: &str,
    user_id: Option<&str>,
    agent: Option<&str>,
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let agent = checked_agent(agent)?;
            let mut body = json!({"expectedToolkit":toolkit.trim()});
            if let Some(agent) = agent {
                body["agentId"] = json!(agent);
            }
            let (base, token) = configuration_from(user_id, "RYU_CONNECT_USER_MANAGEMENT_TOKENS")?;
            let mut endpoint = origin(&base)?;
            endpoint.set_path("/v1/composio/link");
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(35))
                .build()?;
            let response = client
                .post(endpoint)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Connect login initiation unavailable"))?;
            let value = response_json(response).await?;
            let id = value
                .get("connectedAccountId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .context("Invalid Connect login account")?;
            let redirect = value
                .get("redirectUrl")
                .and_then(Value::as_str)
                .context("Invalid Connect login URL")?;
            let parsed = url::Url::parse(redirect)
                .map_err(|_| anyhow::anyhow!("Invalid Connect login URL"))?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                bail!("Invalid Connect login URL");
            }
            if value.get("status").and_then(Value::as_str) != Some("pending") {
                bail!("Invalid Connect login state");
            }
            Ok(json!({"connection_id":id, "redirect_url":redirect, "status":"INITIATED"}))
        }
        .await,
    )
}

/// Complete a pending login without accepting a caller-selected account or user.
pub async fn complete(session_uri: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    complete_as(session_uri, user_id, None).await
}

/// [`complete`] for the tenant's own pending login, or for `agent`'s.
pub async fn complete_as(
    session_uri: &str,
    user_id: Option<&str>,
    agent: Option<&str>,
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(async {
        if session_uri.is_empty() || session_uri.len() > 4096 { bail!("Invalid callback session URI"); }
        let agent = checked_agent(agent)?;
        let mut body = json!({"sessionUri":session_uri});
        if let Some(agent) = agent {
            body["agentId"] = json!(agent);
        }
        let (base, token) = configuration_from(user_id, "RYU_CONNECT_USER_MANAGEMENT_TOKENS")?;
        let mut endpoint = origin(&base)?;
        endpoint.set_path("/v1/composio/complete");
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(35)).build()?;
        let response = client.post(endpoint).bearer_auth(token).json(&body)
            .send().await.map_err(|_| anyhow::anyhow!("Connect login completion unavailable"))?;
        let value = response_json(response).await?;
        let id = value.get("connectedAccountId").and_then(Value::as_str).filter(|id| !id.is_empty()).context("Invalid completed account")?;
        if value.get("active").and_then(Value::as_bool) != Some(true) || value.get("status").and_then(Value::as_str) != Some("ACTIVE") {
            bail!("Connect did not confirm an active account");
        }
        Ok(json!({"id":id,"active":true,"status":"ACTIVE", "toolkit":value.get("toolkit").and_then(Value::as_str).unwrap_or("")}))
    }.await)
}

/// Tenant-filtered native catalog. The dedicated route never proxies to Core.
pub async fn catalog(user_id: Option<&str>) -> Option<Result<Value>> {
    read_catalog("/v1/composio/tools", user_id, &[]).await
}

pub async fn toolkits(user_id: Option<&str>) -> Option<Result<Value>> {
    read_catalog("/v1/composio/toolkits", user_id, &[]).await
}

pub async fn trigger_types(toolkit: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    read_catalog(
        "/v1/composio/trigger-types",
        user_id,
        &[("toolkit", toolkit)],
    )
    .await
}

pub async fn actions(
    toolkit: &str,
    query: &str,
    limit: usize,
    tags: &[&str],
    user_id: Option<&str>,
) -> Option<Result<Value>> {
    let limit = limit.clamp(1, 100).to_string();
    let mut filters = vec![
        ("toolkit", toolkit),
        ("q", query),
        ("limit", limit.as_str()),
    ];
    filters.extend(tags.iter().map(|tag| ("tags", *tag)));
    read_catalog("/v1/composio/actions", user_id, &filters).await
}

pub async fn describe(tool: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(async {
        let (base, token) = configuration(user_id)?;
        let mut endpoint = origin(&base)?;
        endpoint.path_segments_mut().map_err(|_| anyhow::anyhow!("Invalid Connect endpoint"))?.clear().extend(["v1", "composio", "actions", tool]);
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(35)).build()?;
        let response = client.get(endpoint).bearer_auth(token).send().await
            .map_err(|_| anyhow::anyhow!("Connect schema lookup unavailable"))?;
        let value = response_json(response).await?;
        let schema = value.get("input_schema").filter(|schema| schema.is_object() && schema.get("type").and_then(Value::as_str) == Some("object")).context("Invalid Connect tool schema")?;
        if value.get("name").and_then(Value::as_str) != Some(tool) { bail!("Connect tool does not match the requested action"); }
        Ok(json!({"name":tool,"description":value.get("description").and_then(Value::as_str).unwrap_or(""),"input_schema":schema}))
    }.await)
}

async fn read_catalog(
    path: &str,
    user_id: Option<&str>,
    query: &[(&str, &str)],
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let (base, token) = configuration(user_id)?;
            let mut endpoint = origin(&base)?;
            endpoint.set_path(path);
            endpoint
                .query_pairs_mut()
                .extend_pairs(query.iter().copied());
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(35))
                .build()?;
            let response = client
                .get(endpoint)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Connect catalog unavailable"))?;
            let value = response_json(response).await?;
            if !value.get("data").is_some_and(Value::is_array) {
                bail!("Invalid Connect catalog envelope");
            }
            Ok(value)
        }
        .await,
    )
}

/// None is returned only in embedded mode. Configuration, transport, and remote
/// failures must never cause an execution using Core's old provider credential.
pub async fn dispatch(
    tool: &str,
    arguments: &Value,
    user_id: Option<&str>,
    expected_account: Option<&str>,
) -> Option<Result<Value>> {
    dispatch_as(tool, arguments, user_id, None, expected_account).await
}

/// [`dispatch`] on the tenant's own account, or on `agent`'s own account
/// inside it. Connect bills either to the tenant.
pub async fn dispatch_as(
    tool: &str,
    arguments: &Value,
    user_id: Option<&str>,
    agent: Option<&str>,
    expected_account: Option<&str>,
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let agent = checked_agent(agent)?;
            let (base, token) = configuration(user_id)?;
            execute(&base, &token, tool, arguments, agent, expected_account).await
        }
        .await,
    )
}

/// List only Connect's bound account metadata, optionally filtered by toolkit.
pub async fn list_connections(toolkit: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    list_connections_as(toolkit, user_id, None).await
}

/// [`list_connections`] for the tenant's own account, or for `agent`'s.
pub async fn list_connections_as(
    toolkit: &str,
    user_id: Option<&str>,
    agent: Option<&str>,
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(async {
        let agent = checked_agent(agent)?;
        let (base, token) = configuration(user_id)?;
        let mut endpoint = origin(&base)?;
        endpoint.set_path("/v1/composio/accounts");
        if !toolkit.trim().is_empty() { endpoint.query_pairs_mut().append_pair("toolkit", toolkit.trim()); }
        if let Some(agent) = agent { endpoint.query_pairs_mut().append_pair("agentId", agent); }
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(35)).build()?;
        let response = client.get(endpoint).bearer_auth(token).send().await
            .map_err(|_| anyhow::anyhow!("Connect account list unavailable"))?;
        let value = response_json(response).await?;
        let records = value.get("data").and_then(Value::as_array).context("Invalid Connect account list")?;
        let mut data = Vec::new();
        for record in records {
            let id = record.get("id").and_then(Value::as_str).context("Invalid Connect account id")?;
            let toolkit = record.get("toolkit").and_then(Value::as_str).context("Invalid Connect toolkit")?;
            let status = record.get("status").and_then(Value::as_str).context("Invalid Connect account status")?;
            let active = record.get("active").and_then(Value::as_bool).context("Invalid Connect account status")?;
            data.push(json!({"id":id, "toolkit":toolkit, "status":status, "active":active}));
        }
        Ok(json!({"object":"list", "data":data, "configured":value.get("configured").and_then(Value::as_bool).unwrap_or(true)}))
    }.await)
}

/// Metadata-only polling for exactly the account selected by the caller's tenant.
pub async fn connection_status(id: &str, user_id: Option<&str>) -> Option<Result<Value>> {
    connection_status_as(id, user_id, None).await
}

/// [`connection_status`] for the tenant's own account, or for `agent`'s.
pub async fn connection_status_as(
    id: &str,
    user_id: Option<&str>,
    agent: Option<&str>,
) -> Option<Result<Value>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            if id.trim().is_empty() {
                bail!("Connection id is required");
            }
            let agent = checked_agent(agent)?;
            let (base, token) = configuration(user_id)?;
            let mut endpoint = origin(&base)?;
            endpoint.set_path("/v1/composio/connection");
            endpoint
                .query_pairs_mut()
                .append_pair("expectedAccountId", id);
            if let Some(agent) = agent {
                endpoint.query_pairs_mut().append_pair("agentId", agent);
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(35))
                .build()?;
            let response = client
                .get(endpoint)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Connect account lookup unavailable"))?;
            let value = response_json(response).await?;
            if value.get("connectedAccountId").and_then(Value::as_str) != Some(id) {
                bail!("Connect account does not match requested connection");
            }
            let status = value
                .get("status")
                .and_then(Value::as_str)
                .context("Invalid Connect account status")?;
            let active = value
                .get("active")
                .and_then(Value::as_bool)
                .context("Invalid Connect account status")?;
            Ok(json!({ "id": id, "status": status, "active": active, "toolkit": "" }))
        }
        .await,
    )
}

/// Revoke `agent`'s own account in the owner's tenant. Returns the revoked
/// account's id. The tenant's own account is never revoked from Core.
pub async fn revoke_agent(agent: &str, user_id: Option<&str>) -> Option<Result<String>> {
    if !is_configured() {
        return None;
    }
    Some(
        async {
            let agent = checked_agent(Some(agent))?.unwrap_or_default();
            let (base, token) = configuration_from(user_id, "RYU_CONNECT_USER_MANAGEMENT_TOKENS")?;
            let mut endpoint = origin(&base)?;
            endpoint.set_path("/v1/composio/revoke");
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(35))
                .build()?;
            let response = client
                .post(endpoint)
                .bearer_auth(token)
                .json(&json!({ "agentId": agent }))
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Connect account revocation unavailable"))?;
            let value = response_json(response).await?;
            if value.get("status").and_then(Value::as_str) != Some("revoked")
                || value.get("active").and_then(Value::as_bool) != Some(false)
            {
                bail!("Connect did not confirm the account was revoked");
            }
            value
                .get("connectedAccountId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .context("Invalid revoked account")
        }
        .await,
    )
}

fn origin(base: &str) -> Result<url::Url> {
    let url = url::Url::parse(base).map_err(|_| anyhow::anyhow!("Invalid Connect origin"))?;
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" && url.has_host() || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        bail!("Connect URL must be an HTTPS origin or loopback HTTP origin");
    }
    Ok(url)
}

const EXECUTION_FAILED: &str = "Connect tool execution failed";

/// What Connect needs before a refused call can run (Treg parity A10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreconditionKind {
    /// No account is linked for the toolkit yet.
    Connection,
    /// The linked account expired or was revoked and must be linked again.
    Authorization,
}

/// Connect refused a call before running it (`403 precondition_required`):
/// the calling user must link, or link again, the toolkit's account. Nothing
/// ran and nothing is owed. Core turns it into the same `__ryu_elicitation__`
/// connect prompt the embedded Composio path returns, through
/// [`connection_outcome`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreconditionRequired {
    pub kind: PreconditionKind,
    /// The toolkit slug Connect named, such as `github`.
    pub toolkit: String,
}

impl PreconditionRequired {
    /// Read Connect's typed refusal body. Anything else, including a body
    /// whose toolkit is not a plain slug, is not a precondition.
    fn from_body(status: reqwest::StatusCode, body: &Value) -> Option<Self> {
        if status != reqwest::StatusCode::FORBIDDEN
            || body.get("code").and_then(Value::as_str) != Some("precondition_required")
        {
            return None;
        }
        let precondition = body.get("precondition")?;
        let kind = match precondition.get("kind").and_then(Value::as_str)? {
            "connection" => PreconditionKind::Connection,
            "authorization" => PreconditionKind::Authorization,
            _ => return None,
        };
        let toolkit = precondition.get("toolkit").and_then(Value::as_str)?;
        let slug = !toolkit.is_empty()
            && toolkit.len() <= 64
            && toolkit.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
            });
        slug.then(|| Self {
            kind,
            toolkit: toolkit.to_owned(),
        })
    }

    /// The prompt shown to the user. Core writes it; Connect's own text is
    /// not passed through.
    pub fn message(&self) -> String {
        match self.kind {
            PreconditionKind::Connection => format!(
                "This action needs a connected {} account. Connect it in Integrations, then retry.",
                self.toolkit
            ),
            PreconditionKind::Authorization => format!(
                "Your {} connection is no longer authorized. Connect it again in Integrations, then retry.",
                self.toolkit
            ),
        }
    }
}

impl std::fmt::Display for PreconditionRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for PreconditionRequired {}

/// The connect prompt for a Connect execution refused for a missing or
/// expired account; None for every other error. Connect links accounts with
/// the tenant's management credential, so there is no URL to open here: the
/// user connects from Integrations, which runs the normal linking flow.
pub fn connection_outcome(error: &anyhow::Error) -> Option<crate::execute::ExecOutcome> {
    error
        .downcast_ref::<PreconditionRequired>()
        .map(
            |precondition| crate::execute::ExecOutcome::NeedsConnection {
                message: precondition.message(),
                url: None,
            },
        )
}

/// Composio ran the action and logged it, but the tool reported a failure.
/// Composio bills that execution, so Connect returns its verified receipt.
/// `Display` is the same failure every caller already receives; only billing
/// reads the receipt, through [`failed_execution_receipt`].
#[derive(Debug)]
pub struct FailedExecution {
    pub receipt: crate::receipt::ComposioReceipt,
}

impl std::fmt::Display for FailedExecution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(EXECUTION_FAILED)
    }
}

impl std::error::Error for FailedExecution {}

/// The verified receipt carried by a failed execution Composio still bills.
/// None for every other error, including a failure without a valid receipt.
pub fn failed_execution_receipt(error: &anyhow::Error) -> Option<&crate::receipt::ComposioReceipt> {
    error
        .downcast_ref::<FailedExecution>()
        .map(|failed| &failed.receipt)
}

async fn execute(
    base: &str,
    token: &str,
    tool: &str,
    arguments: &Value,
    agent: Option<&str>,
    expected_account: Option<&str>,
) -> Result<Value> {
    let mut endpoint = origin(base)?;
    endpoint.set_path("/v1/composio/execute");
    let mut body = json!({ "operation": "execute", "toolId": tool, "body": arguments });
    if let Some(agent) = agent {
        body["agentId"] = Value::String(agent.to_owned());
    }
    if let Some(account) = expected_account {
        body["expectedAccountId"] = Value::String(account.to_owned());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(35))
        .build()?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Connect execution unavailable"))?;
    let status = response.status();
    if !status.is_success() {
        // A typed precondition refusal becomes the connect prompt; every
        // other refusal keeps the same message and carries only Connect's
        // machine code, which `is_subject_unsupported` reads.
        let body = read_json(response).await.ok();
        if let Some(precondition) = body
            .as_ref()
            .and_then(|body| PreconditionRequired::from_body(status, body))
        {
            return Err(precondition.into());
        }
        let code = body
            .as_ref()
            .and_then(|body| body.get("code"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        return Err(ConnectRejected {
            status: status.as_u16(),
            code,
        }
        .into());
    }
    let value = read_json(response).await?;
    // A receipt is charged only when it names the connected account this call
    // was constrained to; an unbound call has no identity to verify against.
    let bound_to_expected = |receipt: &crate::receipt::ComposioReceipt| {
        expected_account.is_some() && receipt.connected_account_id.as_deref() == expected_account
    };
    if value.get("successful").and_then(Value::as_bool) != Some(true) {
        // Connect records a receipt whenever Composio's execution log verifies,
        // whatever `successful` says, and hosted settlement charges it. Keep it
        // on the unchanged failure so Core charges the same transaction ID.
        let receipt = value
            .get("billingReceipt")
            .and_then(|receipt| {
                serde_json::from_value::<crate::receipt::ComposioReceipt>(receipt.clone()).ok()
            })
            .filter(|receipt| crate::receipt::identifier(&receipt.transaction_id).is_ok())
            .filter(|receipt| {
                let bound = bound_to_expected(receipt);
                if !bound {
                    tracing::warn!(
                        "Connect returned failure billing evidence for a different or unbound account"
                    );
                }
                bound
            });
        return Err(match receipt {
            Some(receipt) => FailedExecution { receipt }.into(),
            None => anyhow::Error::msg(EXECUTION_FAILED),
        });
    }
    if let Some(receipt) = value.get("billingReceipt") {
        let receipt: Option<crate::receipt::ComposioReceipt> =
            serde_json::from_value(receipt.clone()).context("Invalid Connect billing receipt")?;
        if receipt.as_ref().is_some_and(bound_to_expected) {
            return Ok(
                json!({"__ryu_composio_billing":receipt,"output":value.get("data").cloned().unwrap_or(Value::Null)}),
            );
        }
        tracing::warn!("Connect returned billing evidence for a different or unbound account");
    }
    value
        .get("data")
        .cloned()
        .context("Invalid Connect execution envelope")
}

async fn response_json(mut response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // Only the machine code is read, from a bounded body.
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len() + chunk.len() > 16 * 1024 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let code = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| body.get("code").and_then(Value::as_str).map(str::to_owned));
        return Err(ConnectRejected { status, code }.into());
    }
    read_json(response).await
}

/// A bounded JSON body, whatever the status.
async fn read_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Connect response interrupted"))?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            bail!("Connect response exceeded size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("Invalid Connect response"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configured_errors_never_select_embedded_execution() {
        std::env::set_var("RYU_CONNECT_URL", "http://remote.example.com");
        std::env::set_var("RYU_CONNECT_USER_TOKENS", r#"{"user-a":"tenant-token"}"#);
        assert_eq!(
            configuration_status(Some("user-a")).unwrap()["configured"],
            false
        );
        assert!(dispatch("TOOL", &json!({}), Some("user-a"), None)
            .await
            .unwrap()
            .is_err());
        assert!(dispatch("TOOL", &json!({}), Some("user-b"), None)
            .await
            .unwrap()
            .is_err());
        assert!(dispatch("TOOL", &json!({}), None, None)
            .await
            .unwrap()
            .is_err());
        std::env::set_var("RYU_CONNECT_URL", "http://127.0.0.1:8094");
        assert_eq!(
            configuration_status(Some("user-a")).unwrap(),
            json!({"configured":true,"base_url":"","execution_owner":"connect"})
        );
        assert_eq!(
            configuration_status(Some("user-b")).unwrap()["configured"],
            false
        );
        assert_eq!(configuration_status(None).unwrap()["configured"], false);
        // An agent entity is never a tenant, even with a token under its name,
        // and a bad agent id is refused before any request is sent.
        std::env::set_var(
            "RYU_CONNECT_USER_TOKENS",
            r#"{"user-a":"tenant-token","agent:user-a:a1":"forged"}"#,
        );
        let error = dispatch("TOOL", &json!({}), Some("agent:user-a:a1"), None)
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("not a Connect user"), "{error}");
        for agent in ["a:b", "", " a"] {
            let error = dispatch_as("TOOL", &json!({}), Some("user-a"), Some(agent), None)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.to_string(), "Invalid agent account id");
            let error = list_connections_as("", Some("user-a"), Some(agent))
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.to_string(), "Invalid agent account id");
            let error = revoke_agent(agent, Some("user-a"))
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.to_string(), "Invalid agent account id");
        }
        std::env::remove_var("RYU_CONNECT_USER_TOKENS");
        assert!(dispatch("TOOL", &json!({}), Some("user-a"), None)
            .await
            .unwrap()
            .is_err());
        std::env::remove_var("RYU_CONNECT_URL");
        assert!(configuration_status(Some("user-a")).is_none());
        assert!(dispatch("TOOL", &json!({}), Some("user-a"), None)
            .await
            .is_none());
    }
    #[test]
    fn rejects_credential_bearing_and_nonlocal_cleartext_origins() {
        for value in [
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/path",
            "https://example.com?q=1",
            "https://example.com#x",
        ] {
            assert!(origin(value).is_err());
        }
        for value in [
            "https://connect.example.com",
            "http://127.0.0.1:8094",
            "http://[::1]:8094",
        ] {
            assert!(origin(value).is_ok());
        }
    }

    #[tokio::test]
    async fn forwards_only_tenant_token_and_account_constraint() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() < end + 4 + length {
                        continue;
                    }
                    assert!(headers.starts_with("post /v1/composio/execute "));
                    assert!(headers.contains("authorization: bearer tenant-token"));
                    assert!(!headers.contains("x-api-key"));
                    let body: Value = serde_json::from_slice(&bytes[end + 4..]).unwrap();
                    assert_eq!(
                        body,
                        json!({"operation":"execute", "toolId":"GMAIL_GET_PROFILE", "body":{}, "expectedAccountId":"ca-a"})
                    );
                    break;
                }
            }
            let body = r#"{"successful":true,"data":{"ok":true}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let result = execute(
            &base,
            "tenant-token",
            "GMAIL_GET_PROFILE",
            &json!({}),
            None,
            Some("ca-a"),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"ok":true}));
        server.join().unwrap();
    }

    /// Answer one Connect execution with `body`, after reading the request.
    fn respond_once(body: String) -> (String, std::thread::JoinHandle<()>) {
        respond_once_with("200 OK", body)
    }

    /// Answer one Connect execution with `status` and `body`.
    fn respond_once_with(
        status: &'static str,
        body: String,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        (base, server)
    }

    #[tokio::test]
    async fn precondition_refusal_becomes_the_connect_prompt() {
        let refusal = |kind: &str, toolkit: &str| {
            json!({
                "code": "precondition_required",
                "error": "Link a github account before calling this tool",
                "ok": false,
                "precondition": {"kind": kind, "linkPath": "/v1/composio/link", "toolkit": toolkit},
            })
            .to_string()
        };
        for (kind, expected, message) in [
            (
                "connection",
                PreconditionKind::Connection,
                "This action needs a connected github account. Connect it in Integrations, then retry.",
            ),
            (
                "authorization",
                PreconditionKind::Authorization,
                "Your github connection is no longer authorized. Connect it again in Integrations, then retry.",
            ),
        ] {
            let (base, server) = respond_once_with("403 Forbidden", refusal(kind, "github"));
            let error = execute(
                &base,
                "tenant-token",
                "GITHUB_GET_AN_ISSUE",
                &json!({}),
                None,
                None,
            )
            .await
                .unwrap_err();
            server.join().unwrap();
            let precondition = error.downcast_ref::<PreconditionRequired>().unwrap();
            assert_eq!(precondition.kind, expected);
            assert_eq!(precondition.toolkit, "github");
            assert_eq!(
                connection_outcome(&error),
                Some(crate::execute::ExecOutcome::NeedsConnection {
                    message: message.to_owned(),
                    url: None,
                })
            );
            // Nothing ran, so nothing is charged.
            assert!(failed_execution_receipt(&error).is_none());
        }
        // Other refusals, a precondition on the wrong status, and a toolkit
        // that is not a plain slug stay the plain rejection.
        for (status, body) in [
            (
                "403 Forbidden",
                json!({"code":"tool_denied","ok":false}).to_string(),
            ),
            ("409 Conflict", refusal("connection", "github")),
            ("403 Forbidden", refusal("connection", "Git Hub")),
            ("403 Forbidden", refusal("payment", "github")),
            ("403 Forbidden", "not json".to_owned()),
        ] {
            let (base, server) = respond_once_with(status, body);
            let error = execute(
                &base,
                "tenant-token",
                "GITHUB_GET_AN_ISSUE",
                &json!({}),
                None,
                None,
            )
            .await
            .unwrap_err();
            server.join().unwrap();
            assert!(connection_outcome(&error).is_none(), "{status}");
            assert!(error
                .to_string()
                .starts_with("Connect execution rejected with HTTP"));
        }
    }

    fn receipt_for(transaction_id: &str, account: &str) -> Value {
        json!({"authConfigId":"ac_managed","connectedAccountId":account,"transactionId":transaction_id,"usage":{"kind":"toolCall","authSource":"managedApp","directExecution":true,"premiumChargeMicroUsd":null}})
    }

    fn receipt(transaction_id: &str) -> Value {
        receipt_for(transaction_id, "ca-a")
    }

    #[tokio::test]
    async fn failed_execution_still_fails_and_carries_only_a_verified_receipt() {
        let cases = [
            // Composio logged and bills this failure; Connect verified the log.
            (
                json!({"successful":false,"data":{"error":"rate limited"},"billingReceipt":receipt("log_failed-1")}),
                Some("log_failed-1"),
            ),
            // No log, or a log Connect could not verify: nothing to charge.
            (json!({"successful":false,"data":null}), None),
            (
                json!({"successful":false,"data":null,"billingReceipt":null}),
                None,
            ),
            // A receipt Core cannot trust as a transaction ID is not charged.
            (
                json!({"successful":false,"billingReceipt":receipt("../other")}),
                None,
            ),
            (
                json!({"successful":false,"billingReceipt":{"transactionId":"log_x"}}),
                None,
            ),
            (
                json!({"data":{},"billingReceipt":receipt("log_missing-flag")}),
                Some("log_missing-flag"),
            ),
            // A receipt naming another connected account, or none, is not
            // charged to this call's tenant.
            (
                json!({"successful":false,"billingReceipt":receipt_for("log_other-account", "ca-b")}),
                None,
            ),
            (
                json!({"successful":false,"billingReceipt":{"transactionId":"log_unbound","usage":{"kind":"toolCall","authSource":"managedApp","directExecution":true,"premiumChargeMicroUsd":null}}}),
                None,
            ),
        ];
        for (body, expected) in cases {
            let (base, server) = respond_once(body.to_string());
            let error = execute(
                &base,
                "tenant-token",
                "GMAIL_SEND_EMAIL",
                &json!({}),
                None,
                Some("ca-a"),
            )
            .await
            .unwrap_err();
            server.join().unwrap();
            // The caller-visible failure is exactly what it was before receipts.
            assert_eq!(error.to_string(), "Connect tool execution failed");
            assert_eq!(format!("{error:#}"), "Connect tool execution failed");
            assert_eq!(
                failed_execution_receipt(&error).map(|receipt| receipt.transaction_id.as_str()),
                expected,
                "{body}"
            );
        }
        assert!(
            failed_execution_receipt(&anyhow::anyhow!("Connect execution unavailable")).is_none()
        );
    }

    #[tokio::test]
    async fn successful_execution_receipt_is_unchanged_by_failure_handling() {
        let (base, server) = respond_once(
            json!({"successful":true,"data":{"ok":true},"billingReceipt":receipt("log_ok-1")})
                .to_string(),
        );
        let result = execute(
            &base,
            "tenant-token",
            "GMAIL_GET_PROFILE",
            &json!({}),
            None,
            Some("ca-a"),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(result["output"], json!({"ok":true}));
        assert_eq!(
            result["__ryu_composio_billing"]["transactionId"],
            "log_ok-1"
        );
    }

    #[test]
    fn agent_subjects_match_connects_id_rule() {
        for valid in ["a", "agent_0b1c-2d", &"x".repeat(128)] {
            assert!(valid_agent_subject(valid), "{valid}");
        }
        for invalid in [
            "",
            "-a",
            "_a",
            "a:b",
            "a b",
            "a/b",
            "\u{e9}",
            &"x".repeat(129),
        ] {
            assert!(!valid_agent_subject(invalid), "{invalid}");
        }
    }

    #[tokio::test]
    async fn agent_executions_name_the_agent_and_map_unsupported_tenants() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for reply in [
                (200, r#"{"successful":true,"data":{"ok":true}}"#),
                (400, r#"{"code":"subject_unsupported","ok":false}"#),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let body = loop {
                    let read = stream.read(&mut buffer).unwrap();
                    bytes.extend_from_slice(&buffer[..read]);
                    let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..]).unwrap();
                    }
                };
                assert_eq!(body["agentId"], "agent_1");
                write!(stream, "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.0, reply.1.len(), reply.1).unwrap();
            }
        });
        let result = execute(
            &base,
            "t",
            "GMAIL_GET_PROFILE",
            &json!({}),
            Some("agent_1"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"ok":true}));
        let error = execute(
            &base,
            "t",
            "GMAIL_GET_PROFILE",
            &json!({}),
            Some("agent_1"),
            None,
        )
        .await
        .unwrap_err();
        assert!(is_subject_unsupported(&error));
        assert_eq!(
            error.to_string(),
            "Connect execution rejected with HTTP 400"
        );
        assert!(!is_subject_unsupported(&anyhow::anyhow!("other")));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn successful_execution_drops_a_receipt_for_another_account() {
        for (body, expected_account) in [
            (
                json!({"successful":true,"data":{"ok":true},"billingReceipt":receipt_for("log_ok-2", "ca-b")}),
                Some("ca-a"),
            ),
            (
                json!({"successful":true,"data":{"ok":true},"billingReceipt":receipt("log_ok-3")}),
                None,
            ),
        ] {
            let (base, server) = respond_once(body.to_string());
            let result = execute(
                &base,
                "tenant-token",
                "GMAIL_GET_PROFILE",
                &json!({}),
                None,
                expected_account,
            )
            .await
            .unwrap();
            server.join().unwrap();
            // The tool result is preserved; no charge travels with it.
            assert_eq!(result, json!({"ok":true}));
        }
    }
}
