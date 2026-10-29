//! Public Responses protocol for authorized self-hosted ChatGPT registrations.
use anyhow::{bail, Context, Result};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const PUBLIC_API: &str = "https://api.openai.com/v1";

struct SessionBinding {
    account_id: String,
    last_used: Instant,
}
#[derive(Default)]
struct AccountRouting {
    bindings: HashMap<String, SessionBinding>,
    cursor: super::oauth_pool_usage::PoolCursor,
}

impl AccountRouting {
    fn select(
        &mut self,
        session: Option<&str>,
        eligible: &[String],
        active: &str,
        policy: &super::oauth_pool_policy::Policy,
    ) -> Option<String> {
        self.bindings
            .retain(|_, binding| binding.last_used.elapsed() < Duration::from_secs(3600));
        if let Some(binding) = session.and_then(|id| self.bindings.get_mut(id)) {
            if policy.allowed(&binding.account_id) && eligible.contains(&binding.account_id) {
                binding.last_used = Instant::now();
                return Some(binding.account_id.clone());
            }
        }
        let candidates: Vec<_> = eligible
            .iter()
            .map(|id| super::oauth_pool_usage::Candidate {
                account_id: id,
                revision: &[],
            })
            .collect();
        let index = self.cursor.select(
            crate::pi_config::CHATGPT_PLAN_PROVIDER_ID,
            &candidates,
            active,
            policy,
        )?;
        let selected = eligible[index].clone();
        if let Some(session) = session {
            if self.bindings.len() >= 10_000 && !self.bindings.contains_key(session) {
                if let Some(oldest) = self
                    .bindings
                    .iter()
                    .min_by_key(|(_, binding)| binding.last_used)
                    .map(|(id, _)| id.clone())
                {
                    self.bindings.remove(&oldest);
                }
            }
            self.bindings.insert(
                session.to_owned(),
                SessionBinding {
                    account_id: selected.clone(),
                    last_used: Instant::now(),
                },
            );
        }
        Some(selected)
    }
}
static BINDINGS: OnceLock<Mutex<AccountRouting>> = OnceLock::new();

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

fn selected_account(headers: &HeaderMap) -> Result<String, Response> {
    selected_account_with_policy(headers, &super::oauth_pool_policy::Policy::default())
}

fn selected_account_with_policy(
    headers: &HeaderMap,
    policy: &super::oauth_pool_policy::Policy,
) -> Result<String, Response> {
    use crate::pi_config::{accounts, chatgpt_plan::StoredAccount, CHATGPT_PLAN_AUTH_KEY};
    let vault = accounts::global().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "chatgpt_plan_vault_unavailable",
            "The sealed ChatGPT account store is unavailable",
        )
    })?;
    let scope = accounts::provider_scope(CHATGPT_PLAN_AUTH_KEY);
    let session = headers
        .get("x-ryu-session-id")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_session",
                "Session ID is invalid",
            )
        })?
        .filter(|value| !value.is_empty() && !value.starts_with('$'));
    if session.is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control)) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_session",
            "Session ID is invalid",
        ));
    }
    let bindings = BINDINGS.get_or_init(|| Mutex::new(AccountRouting::default()));
    if policy.strategy != super::oauth_pool_policy::Strategy::Manual {
        let read_failure = || {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "chatgpt_plan_account_unavailable",
                "The saved ChatGPT accounts could not be read",
            )
        };
        let active = vault
            .active_info(&scope)
            .map_err(|_| read_failure())?
            .map(|account| account.account_id)
            .unwrap_or_default();
        let mut eligible = Vec::new();
        for account in vault.list(&scope).map_err(|_| read_failure())? {
            if account.kind != accounts::KIND_OAUTH || !policy.allowed(&account.account_id) {
                continue;
            }
            if let Some(saved) = vault
                .credential(&scope, &account.account_id)
                .map_err(|_| read_failure())?
            {
                if crate::pi_config::chatgpt_plan::connection_state(&saved) == "authorized" {
                    eligible.push(account.account_id);
                }
            }
        }
        return bindings
            .lock()
            .map_err(|_| read_failure())?
            .select(session, &eligible, &active, policy)
            .ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "chatgpt_plan_accounts_unavailable",
                    "No enabled ChatGPT account has plan-use permission",
                )
            });
    }
    let bound = if let Some(session) = session {
        let mut bindings = bindings.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "chatgpt_plan_session_unavailable",
                "ChatGPT session binding is unavailable",
            )
        })?;
        bindings
            .bindings
            .retain(|_, binding| binding.last_used.elapsed() < Duration::from_secs(3600));
        bindings
            .bindings
            .get_mut(session)
            .filter(|binding| policy.allowed(&binding.account_id))
            .map(|binding| {
                binding.last_used = Instant::now();
                binding.account_id.clone()
            })
    } else {
        None
    };
    let bound = match bound {
        Some(id) => match vault.credential(&scope, &id) {
            Ok(Some(_)) => Some(id),
            Ok(None) => None,
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "chatgpt_plan_account_unavailable",
                    "The bound ChatGPT account could not be read",
                ));
            }
        },
        None => None,
    };
    let account_id = match bound {
        Some(id) => id,
        None => vault
            .active_info(&scope)
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "chatgpt_plan_account_unavailable",
                    "The saved ChatGPT account could not be read",
                )
            })?
            .filter(|account| account.kind == accounts::KIND_OAUTH)
            .map(|account| account.account_id)
            .ok_or_else(|| {
                error(
                    StatusCode::UNAUTHORIZED,
                    "chatgpt_plan_not_connected",
                    "Continue with ChatGPT to connect an account",
                )
            })?,
    };
    if !policy.allowed(&account_id) {
        return Err(error(
            StatusCode::CONFLICT,
            "chatgpt_plan_account_disabled",
            "The selected ChatGPT account is disabled in account routing",
        ));
    }
    let saved = vault
        .credential(&scope, &account_id)
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "chatgpt_plan_account_unavailable",
                "The saved ChatGPT account could not be read",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "chatgpt_plan_not_connected",
                "Reconnect this saved ChatGPT account",
            )
        })?;
    let registration = StoredAccount::from_value(&saved).map_err(|_| {
        error(
            StatusCode::UNAUTHORIZED,
            "chatgpt_plan_reconnect_required",
            "Reconnect this saved ChatGPT registration",
        )
    })?;
    match registration {
        StoredAccount::Connected(credential) if credential.plan_authorized() => {}
        StoredAccount::IdentityOnly(_) => {
            return Err(error(
                StatusCode::FORBIDDEN,
                "chatgpt_plan_not_authorized",
                "Identity sign-in is saved. Enable ChatGPT plan use before running models",
            ));
        }
        _ => {
            return Err(error(
                StatusCode::UNAUTHORIZED,
                "chatgpt_plan_reconnect_required",
                "Reconnect this saved ChatGPT registration",
            ));
        }
    }
    if let Some(session) = session {
        let mut bindings = bindings.lock().map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "chatgpt_plan_session_unavailable",
                "ChatGPT session binding is unavailable",
            )
        })?;
        if !bindings.bindings.contains_key(session) && bindings.bindings.len() >= 10_000 {
            if let Some(oldest) = bindings
                .bindings
                .iter()
                .min_by_key(|(_, binding)| binding.last_used)
                .map(|(id, _)| id.clone())
            {
                bindings.bindings.remove(&oldest);
            }
        }
        bindings.bindings.insert(
            session.to_owned(),
            SessionBinding {
                account_id: account_id.clone(),
                last_used: Instant::now(),
            },
        );
    }
    Ok(account_id)
}

async fn credential(
    account_id: &str,
) -> Result<crate::pi_config::chatgpt_plan::Credential, Response> {
    let saved = crate::pi_config::subscription_request_credential_for_account(
        crate::pi_config::CHATGPT_PLAN_PROVIDER_ID,
        account_id,
    )
    .await
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "chatgpt_plan_refresh_unavailable",
            "ChatGPT credentials could not be renewed. Reconnect after a terminal renewal failure",
        )
    })?;
    let saved =
        crate::pi_config::chatgpt_plan::StoredAccount::from_value(&saved).map_err(|_| {
            error(
                StatusCode::UNAUTHORIZED,
                "chatgpt_plan_reconnect_required",
                "Reconnect this saved ChatGPT registration",
            )
        })?;
    saved.credential().cloned().map_err(|_| {
        error(
            StatusCode::FORBIDDEN,
            "chatgpt_plan_not_authorized",
            "Enable ChatGPT plan use for this registration",
        )
    })
}

async fn bounded_body(response: reqwest::Response) -> Result<Bytes> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            bail!("OpenAI response is too large");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

async fn rejected(response: reqwest::Response) -> Response {
    let status = response.status();
    let headers = response.headers().clone();
    match bounded_body(response).await {
        Ok(body) => {
            let mut result = (status, body).into_response();
            for name in [
                "content-type",
                "openai-request-id",
                "x-request-id",
                "retry-after",
            ] {
                if let Some(value) = headers.get(name) {
                    result.headers_mut().insert(name, value.clone());
                }
            }
            result
        }
        Err(_) => error(
            StatusCode::BAD_GATEWAY,
            "chatgpt_plan_response_invalid",
            "OpenAI's error response could not be read",
        ),
    }
}

pub(crate) async fn discover_models() -> Result<Vec<Value>, Response> {
    let account_id = selected_account(&HeaderMap::new())?;
    let credential = credential(&account_id).await?;
    let client = client().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "chatgpt_plan_transport_unavailable",
            "ChatGPT transport is unavailable",
        )
    })?;
    let response = client
        .get(format!("{PUBLIC_API}/models"))
        .bearer_auth(&credential.access)
        .send()
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "chatgpt_plan_models_unreachable",
                "ChatGPT models could not be reached",
            )
        })?;
    if !response.status().is_success() {
        return Err(rejected(response).await);
    }
    let body = bounded_body(response).await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "chatgpt_plan_models_invalid",
            "ChatGPT model catalog could not be read",
        )
    })?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "chatgpt_plan_models_invalid",
            "ChatGPT returned an invalid model catalog",
        )
    })?;
    visible_models(&value).map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "chatgpt_plan_models_invalid",
            "ChatGPT returned an invalid model catalog",
        )
    })
}

pub async fn models() -> Response {
    match discover_models().await {
        Ok(models) => Json(json!({ "object": "list", "data": models })).into_response(),
        Err(response) => response,
    }
}

fn interrupted(code: &str, message: &str) -> Bytes {
    Bytes::from(format!(
        "event: response.failed\ndata: {}\n\n",
        json!({ "type": "response.failed",
        "response": { "id": "ryu_stream_failure", "object": "response", "status": "failed", "output": [],
            "error": { "code": code, "message": message } } })
    ))
}

pub async fn responses(
    State(state): State<super::ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let bytes = match to_bytes(body, 8 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "Responses request is too large",
            );
        }
    };
    let body = match serde_json::from_slice(&bytes)
        .map_err(anyhow::Error::from)
        .and_then(prepare_request)
    {
        Ok(body) => body,
        Err(error_message) => {
            return error(
                StatusCode::BAD_REQUEST,
                "chatgpt_plan_request_invalid",
                &error_message.to_string(),
            );
        }
    };
    let policy = super::oauth_pool_policy::load(
        &state.preferences,
        crate::pi_config::CHATGPT_PLAN_PROVIDER_ID,
    )
    .await;
    let account_id = match selected_account_with_policy(&headers, &policy) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let credential = match credential(&account_id).await {
        Ok(credential) => credential,
        Err(response) => return response,
    };
    let client = match client() {
        Ok(client) => client,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "chatgpt_plan_transport_unavailable",
                "ChatGPT transport is unavailable",
            );
        }
    };
    submit_response(
        client,
        format!("{PUBLIC_API}/responses"),
        credential,
        body,
        account_id,
    )
    .await
}

async fn submit_response(
    client: reqwest::Client,
    endpoint: String,
    credential: crate::pi_config::chatgpt_plan::Credential,
    body: Value,
    account_id: String,
) -> Response {
    let response = match client
        .post(endpoint)
        .bearer_auth(&credential.access)
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "chatgpt_plan_upstream_unreachable",
                "ChatGPT could not be reached; the request was not replayed",
            );
        }
    };
    if !response.status().is_success() {
        return rejected(response).await;
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| !kind.starts_with("text/event-stream"))
    {
        tracing::warn!(
            content_type = ?response.headers().get("content-type"),
            request_id = ?response.headers().get("x-request-id"),
            "ChatGPT plan upstream response did not declare an event stream"
        );
        return error(
            StatusCode::BAD_GATEWAY,
            "chatgpt_plan_stream_required",
            "OpenAI did not return the required Responses stream",
        );
    }
    let request_id = response
        .headers()
        .get("openai-request-id")
        .or_else(|| response.headers().get("x-request-id"))
        .cloned();
    let stream_request_id = request_id.clone();
    let stream = async_stream::stream! {
        let mut upstream = response.bytes_stream();
        let mut events = TerminalEvents::default();
        while let Some(chunk) = upstream.next().await {
            match chunk {
                Ok(chunk) => {
                    if events.push(&chunk).is_err() {
                        yield Ok::<Bytes, std::io::Error>(interrupted("chatgpt_plan_stream_invalid", "ChatGPT returned an invalid stream event"));
                        return;
                    }
                    yield Ok::<Bytes, std::io::Error>(chunk);
                }
                Err(_) => {
                    yield Ok::<Bytes, std::io::Error>(interrupted("chatgpt_plan_stream_interrupted", "ChatGPT stream was interrupted before completion"));
                    return;
                }
            }
        }
        if !events.terminal {
            yield Ok::<Bytes, std::io::Error>(interrupted("chatgpt_plan_stream_interrupted", "ChatGPT stream ended before a terminal response event"));
        } else if events.completed {
            tracing::info!(account_id = %account_id, request_id = ?stream_request_id, "ChatGPT plan response completed");
        }
    };
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        "content-type",
        "text/event-stream".parse().expect("static content type"),
    );
    response.headers_mut().insert(
        "cache-control",
        "no-store".parse().expect("static cache policy"),
    );
    if let Some(id) = request_id {
        response.headers_mut().insert("x-request-id", id);
    }
    response
}

const OMITTED_FIELDS: &[&str] = &[
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
];

fn local_tool(tool: &Value) -> bool {
    matches!(
        tool.get("type").and_then(Value::as_str),
        Some("function" | "custom")
    ) && tool.get("defer_loading").and_then(Value::as_bool) != Some(true)
}

fn prepare_request(mut value: Value) -> Result<Value> {
    let body = value
        .as_object_mut()
        .context("Responses request must be an object")?;
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        .context("Choose a ChatGPT model available to this account")?;
    if model.trim() != model {
        bail!("ChatGPT model ID is invalid");
    }
    if body.get("stream").and_then(Value::as_bool) == Some(false) {
        bail!("ChatGPT plan requests require stream: true");
    }
    if body.contains_key("previous_response_id") {
        bail!("ChatGPT plan HTTP requests require explicit history in input");
    }
    let input = body
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .context(
            "ChatGPT plan requests require an input array containing the conversation history",
        )?;
    for item in input {
        if item.get("role").and_then(Value::as_str) == Some("system") {
            item["role"] = json!("developer");
        }
    }
    for field in OMITTED_FIELDS {
        body.remove(*field);
    }
    let mut grouped_names = std::collections::HashSet::new();
    if let Some(tools) = body.get_mut("tools") {
        let tools = tools
            .as_array_mut()
            .context("Responses tools must be an array")?;
        let mut functions = Vec::new();
        let mut grouped = Vec::new();
        for tool in std::mem::take(tools) {
            match tool.get("type").and_then(Value::as_str) {
                Some("function" | "custom") if local_tool(&tool) => {
                    let name = tool
                        .get("name")
                        .and_then(Value::as_str)
                        .context("Local tool has no name")?;
                    grouped_names.insert(name.to_owned());
                    functions.push(tool);
                }
                Some("namespace")
                    if tool
                        .get("tools")
                        .and_then(Value::as_array)
                        .is_some_and(|members| {
                            !members.is_empty() && members.iter().all(local_tool)
                        }) =>
                {
                    grouped.push(tool)
                }
                Some("web_search" | "web_search_preview") => grouped.push(tool),
                _ => bail!(
                    "This hosted or deferred tool is unsupported by ChatGPT plan usage; use local function tools"
                ),
            }
        }
        if !functions.is_empty() {
            if grouped
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some("ryu"))
            {
                bail!("The ryu tool namespace is already declared; group local tools explicitly");
            }
            grouped.push(json!({ "type": "namespace", "name": "ryu",
                "description": "Tools executed by Ryu on the user's host.", "tools": functions }));
        }
        *tools = grouped;
    }
    if !grouped_names.is_empty() {
        for item in body
            .get_mut("input")
            .and_then(Value::as_array_mut)
            .expect("validated input array")
        {
            if matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call")
            ) && item
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| grouped_names.contains(name))
                && item.get("namespace").is_none()
            {
                item["namespace"] = json!("ryu");
            }
        }
        if let Some(choice) = body.get_mut("tool_choice") {
            if choice
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| grouped_names.contains(name))
                && choice.get("namespace").is_none()
            {
                choice["namespace"] = json!("ryu");
            }
        }
    }
    body.insert("store".to_owned(), json!(false));
    body.insert("stream".to_owned(), json!(true));
    Ok(value)
}

fn visible_models(value: &Value) -> Result<Vec<Value>> {
    let rows = value
        .get("models")
        .and_then(Value::as_array)
        .context("ChatGPT returned an invalid account model catalog")?;
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for row in rows {
        if row.get("visibility").and_then(Value::as_str) != Some("list") {
            continue;
        }
        let Some(id) = row.get("slug").and_then(Value::as_str).filter(|id| {
            !id.is_empty()
                && id.trim() == *id
                && id.len() <= 256
                && !id.chars().any(char::is_control)
        }) else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        let name = row
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|name| {
                !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
            })
            .unwrap_or(id);
        models
            .push(json!({ "id": id, "name": name, "object": "model", "owned_by": "chatgpt-plan" }));
        if models.len() >= 1024 {
            break;
        }
    }
    Ok(models)
}

/// SSE transport success requires a terminal Responses event, never just EOF.
#[derive(Default)]
struct TerminalEvents {
    pending: Vec<u8>,
    terminal: bool,
    completed: bool,
    failed: bool,
}

impl TerminalEvents {
    fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if self.pending.len().saturating_add(bytes.len()) > 1024 * 1024 {
            bail!("ChatGPT emitted an oversized stream event");
        }
        self.pending.extend_from_slice(bytes);
        loop {
            let lf = self
                .pending
                .windows(2)
                .position(|part| part == b"\n\n")
                .map(|index| (index, 2));
            let crlf = {
                self.pending
                    .windows(4)
                    .position(|part| part == b"\r\n\r\n")
                    .map(|index| (index, 4))
            };
            let delimiter = [lf, crlf]
                .into_iter()
                .flatten()
                .min_by_key(|(index, _)| *index);
            let Some((end, delimiter_len)) = delimiter else {
                return Ok(());
            };
            let frame: Vec<_> = self.pending.drain(..end + delimiter_len).collect();
            let frame = std::str::from_utf8(&frame).context("ChatGPT stream event is not UTF-8")?;
            let data = frame
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("data:")
                        .map(|line| line.strip_prefix(' ').unwrap_or(line))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if data == "[DONE]" || data.is_empty() {
                continue;
            }
            let event: Value =
                serde_json::from_str(&data).context("ChatGPT stream event is invalid")?;
            match event.get("type").and_then(Value::as_str) {
                Some("response.completed") if event["response"]["status"] == "completed" => {
                    self.terminal = true;
                    self.completed = !self.failed;
                }
                Some("response.failed" | "response.incomplete" | "error") => {
                    self.terminal = true;
                    self.failed = true;
                    self.completed = false;
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_robin_rotates_new_sessions_and_preserves_healthy_affinity() {
        use super::super::oauth_pool_policy::{Policy, Strategy};
        let mut routing = AccountRouting::default();
        let accounts = vec!["first".to_owned(), "second".to_owned()];
        let policy = Policy {
            strategy: Strategy::RoundRobin,
            ..Default::default()
        };
        assert_eq!(
            routing
                .select(Some("chat-a"), &accounts, "first", &policy)
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            routing
                .select(Some("chat-b"), &accounts, "first", &policy)
                .as_deref(),
            Some("second")
        );
        assert_eq!(
            routing
                .select(Some("chat-a"), &accounts, "second", &policy)
                .as_deref(),
            Some("first")
        );
    }

    #[test]
    fn account_rules_release_disabled_bindings_and_prefer_best_priority() {
        use super::super::oauth_pool_policy::{AccountRule, Policy, Strategy};
        let mut routing = AccountRouting::default();
        let accounts = vec!["first".to_owned(), "second".to_owned()];
        let mut policy = Policy {
            strategy: Strategy::RoundRobin,
            ..Default::default()
        };
        assert_eq!(
            routing
                .select(Some("chat"), &accounts, "first", &policy)
                .as_deref(),
            Some("first")
        );
        policy.accounts.insert(
            "first".to_owned(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        assert_eq!(
            routing
                .select(Some("chat"), &accounts, "first", &policy)
                .as_deref(),
            Some("second")
        );
        policy.accounts.insert(
            "first".to_owned(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: true,
                priority: 10,
            },
        );
        assert_eq!(
            routing
                .select(Some("new-chat"), &accounts, "first", &policy)
                .as_deref(),
            Some("second")
        );
        policy.accounts.insert(
            "second".to_owned(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        policy.accounts.get_mut("first").unwrap().enabled = false;
        assert!(routing
            .select(Some("chat"), &accounts, "first", &policy)
            .is_none());
    }

    #[test]
    fn native_pi_request_is_stateless_streaming_and_groups_local_functions() {
        let request = prepare_request(json!({ "model": "account-model", "input": [{"role":"system", "content":"context"}],
            "store": true, "stream": true, "max_output_tokens": 200, "temperature": 0.5,
            "prompt_cache_key": "stable-session", "tools": [{"type":"function", "name":"read", "parameters":{}}] })).unwrap();
        assert_eq!(request["store"], false);
        assert_eq!(request["stream"], true);
        assert!(request.get("max_output_tokens").is_none());
        assert!(request.get("temperature").is_none());
        assert_eq!(request["prompt_cache_key"], "stable-session");
        assert_eq!(request["input"][0]["role"], "developer");
        assert_eq!(request["tools"][0]["type"], "namespace");
        assert_eq!(request["tools"][0]["tools"][0]["name"], "read");
        for tool in [
            "tool_search",
            "mcp",
            "computer_use",
            "image_generation",
            "code_interpreter",
            "file_search",
            "programmatic_tool_calling",
        ] {
            assert!(prepare_request(
                json!({ "model":"account-model", "input":[], "tools":[{"type":tool}] })
            )
            .is_err());
        }
    }

    #[test]
    fn account_catalog_keeps_visible_server_order_and_names() {
        let models = visible_models(&json!({"models":[
            {"slug":"b", "display_name":"Second", "visibility":"list"},
            {"slug":"hidden", "visibility":"hidden"},
            {"slug":"a", "display_name":"First", "visibility":"list"},
            {"slug":"b", "visibility":"list"}, {"slug":"bad\nmodel", "visibility":"list"}
        ]}))
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(models[0]["name"], "Second");
    }

    #[test]
    fn token_deltas_and_done_marker_do_not_prove_completion() {
        let mut events = TerminalEvents::default();
        events
            .push(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
            .unwrap();
        events.push(b"data: [DONE]\n\n").unwrap();
        assert!(!events.terminal);
        events.push(b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n").unwrap();
        assert!(events.terminal);
        assert!(!events.completed);
    }

    #[test]
    fn terminal_event_can_cross_chunk_boundaries() {
        let event = b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n";
        let mut events = TerminalEvents::default();
        for byte in event {
            events.push(&[*byte]).unwrap();
        }
        assert!(events.completed);
    }

    #[tokio::test]
    async fn public_response_transport_preserves_bearer_request_id_and_partial_failure() {
        use axum::{routing::post, Router};
        use std::future::IntoFuture;
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let capture = requests.clone();
        let app = Router::new().route(
            "/v1/responses",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let capture = capture.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer synthetic-plan-access");
                    assert_eq!(headers["accept"], "text/event-stream");
                    assert_eq!(body["store"], false);
                    assert_eq!(body["stream"], true);
                    capture.lock().unwrap().push(body);
                    // The live plan endpoint can omit Content-Type. Stream
                    // events, including a terminal event, remain authoritative.
                    Response::builder()
                        .header("openai-request-id", "fixture-request")
                        .body(Body::from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let credential = crate::pi_config::chatgpt_plan::Credential::from_value(&json!({
            "type":"oauth", "flow":"chatgpt-plan", "access":"synthetic-plan-access", "refresh":"synthetic-refresh",
            "expires":1900000000000_u64, "clientId":"oaiapp_fixture", "hostId":format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            "issuer":"https://auth.openai.com", "subject":"fixture-subject", "idToken":"synthetic-id",
            "email":null, "scopes":["resource.invoke", "chatgpt.tokens.use.direct"]
        })).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body =
            prepare_request(json!({"model":"fixture-model", "input":[], "stream":true})).unwrap();
        let response = submit_response(
            client,
            endpoint,
            credential,
            body,
            "fixture-account".to_owned(),
        )
        .await;
        assert_eq!(response.headers()["x-request-id"], "fixture-request");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains("response.output_text.delta"));
        assert!(text.contains("chatgpt_plan_stream_interrupted"));
        assert!(!text.contains("synthetic-plan-access"));
        assert_eq!(requests.lock().unwrap().len(), 1);
        server.abort();
    }
}
