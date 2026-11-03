//! One request to the hosted agent-mail routes and the shaping of its
//! answers into tool data.

use super::*;

/// One hosted answer: status, JSON body, and any `Retry-After` seconds.
pub(super) struct Reply {
    pub(super) status: StatusCode,
    pub(super) body: Value,
    pub(super) retry_after_s: Option<u64>,
}

/// One request to the hosted service. An unreachable service is a 503
/// `unavailable` answer, never an `Err`.
pub(super) async fn request(
    http: &Client,
    target: &AgentInboxTarget,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Reply {
    let url = format!("{}/api/mail{path}", target.base_url);
    let mut builder = http
        .request(method, &url)
        .header("x-gateway-key", &target.gateway_key)
        .timeout(REQUEST_TIMEOUT);
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            return Reply {
                status: StatusCode::SERVICE_UNAVAILABLE,
                body: json!({
                    "code": "unavailable",
                    "message": format!("Ryu agent mail could not be reached: {error}"),
                }),
                retry_after_s: None,
            }
        }
    };
    let status = response.status();
    let retry_after_s = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok());
    let text = response.text().await.unwrap_or_default();
    let body = serde_json::from_str::<Value>(&text)
        .unwrap_or_else(|_| json!({ "error": text.chars().take(500).collect::<String>() }));
    Reply {
        status,
        body,
        retry_after_s,
    }
}

/// A non-2xx answer as tool data: `{ ok: false, status, code, message,
/// suggestions?, retry_after_s? }`.
pub(super) fn refusal(reply: &Reply) -> Value {
    let body = &reply.body;
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let mut out = json!({
        "ok": false,
        "status": reply.status.as_u16(),
        "code": text("code").unwrap_or("request_failed"),
        "message": text("message")
            .or_else(|| text("error"))
            .map_or_else(|| format!("Ryu agent mail answered HTTP {}", reply.status.as_u16()), str::to_owned),
    });
    if let Some(suggestions) = body.get("suggestions").filter(|value| value.is_array()) {
        out["suggestions"] = suggestions.clone();
    }
    if let Some(seconds) = body
        .get("retryAfterSeconds")
        .and_then(Value::as_u64)
        .or(reply.retry_after_s)
    {
        out["retry_after_s"] = json!(seconds);
    }
    out
}

pub(super) fn camel_to_snake(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for (index, c) in key.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The hosted camelCase JSON with snake_case keys, at every depth. Values are
/// untouched.
pub(super) fn snake_case_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, child)| (camel_to_snake(&key), snake_case_keys(child)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(snake_case_keys).collect()),
        other => other,
    }
}

/// A hosted read result for the model: snake_case keys, outside-sender text
/// neutralized.
pub(super) fn untrusted_view(value: Value) -> Value {
    let mut value = snake_case_keys(value);
    wrap_untrusted_fields(&mut value);
    value
}

pub(super) fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// One hosted verification code as the agent sees it: the code, link, and
/// sender came out of an outside sender's mail, so they sit under
/// `untrusted` and are neutralized like every other sender-written field.
pub(super) fn verification_entry(entry: &Value) -> Value {
    json!({
        "untrusted": {
            "code": field(entry, "code"),
            "link": field(entry, "link"),
            "from": field(entry, "from"),
        },
        "received_at": field(entry, "received_at"),
        "message_id": field(entry, "message_id"),
    })
}

/// The agent-facing slice of a hosted `AliasView`.
pub(super) fn alias_summary(alias: &Value, with_kind: bool) -> Value {
    let mut out = json!({
        "address": field(alias, "address"),
        "local_part": field(alias, "localPart"),
        "host": field(alias, "host"),
        "status": field(alias, "status"),
        "display_name": field(alias, "displayName"),
    });
    if with_kind {
        out["kind"] = field(alias, "kind");
    }
    out
}

pub(super) fn mailbox_summary(mailbox: &Value) -> Value {
    json!({ "address": field(mailbox, "address") })
}

pub(super) fn claim_message(status: &str, address: &str) -> String {
    match status {
        "pending_approval" => format!(
            "{address} is waiting for an organization admin to approve it. It is not your address until they do."
        ),
        "existing" => format!(
            "You already have {address}. Agent addresses are permanent, so it cannot be renamed."
        ),
        _ => format!("{address} is now your permanent address. It is never reissued."),
    }
}

/// A send or reply answer: 200 sent, or 202 held for an admin.
pub(super) fn send_result(reply: &Reply) -> Value {
    if reply.status == StatusCode::ACCEPTED
        || reply.body.get("status").and_then(Value::as_str) == Some("pending_approval")
    {
        return json!({
            "ok": true,
            "status": "pending_approval",
            "draft_id": field(&reply.body, "draftId"),
            "reasons": reply.body.get("reasons").cloned().unwrap_or_else(|| json!([])),
        });
    }
    json!({ "ok": true, "status": "sent", "message_id": field(&reply.body, "messageId") })
}

pub(super) fn agent_path(target: &AgentInboxTarget, rest: &str) -> String {
    format!("/agents/{}{rest}", urlencoding::encode(&target.agent_key))
}

pub(super) fn query_string(pairs: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_ref()
                .map(|value| format!("{key}={}", urlencoding::encode(value)))
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}
