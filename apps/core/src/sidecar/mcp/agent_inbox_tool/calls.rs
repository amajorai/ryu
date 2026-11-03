//! Running one `agent_inbox.*` tool against a resolved target.

use super::*;

/// Run one tool against a resolved target. `agent_name` seeds the default
/// alias for the check and the claim.
pub(crate) async fn call(
    http: &Client,
    target: &AgentInboxTarget,
    tool: &str,
    arguments: &Value,
    agent_name: Option<&str>,
) -> Result<Value> {
    let agent_name = agent_name.map(str::trim).filter(|name| !name.is_empty());
    match tool {
        "get" => {
            let reply = request(
                http,
                target,
                Method::GET,
                &agent_path(target, "/alias"),
                None,
            )
            .await;
            if reply.status == StatusCode::NOT_FOUND {
                return Ok(json!({ "ok": true, "has_alias": false }));
            }
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let alias = reply.body.get("alias").filter(|alias| alias.is_object());
            let mut out = json!({ "ok": true, "has_alias": alias.is_some() });
            if let Some(alias) = alias {
                out["alias"] = alias_summary(alias, true);
            }
            if let Some(mailbox) = reply.body.get("mailbox").filter(|value| value.is_object()) {
                out["mailbox"] = mailbox_summary(mailbox);
            }
            Ok(out)
        }
        "check_email_alias" | "check_address" => {
            let local_part = match requested_local_part(arguments, agent_name)? {
                Ok(local_part) => local_part,
                Err(error) => return Ok(alias_invalid(error)),
            };
            // The agent's name also goes along, so a service that derives the
            // default itself slugs the same name the claim would.
            let path = agent_path(target, "/alias/check")
                + &query_string(&[
                    ("localPart", local_part),
                    ("displayName", agent_name.map(str::to_owned)),
                ]);
            let reply = request(http, target, Method::GET, &path, None).await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let body = &reply.body;
            let mut out = json!({
                "ok": true,
                "address": field(body, "address"),
                "available": body.get("available").and_then(Value::as_bool).unwrap_or(false),
                "suggestions": body.get("suggestions").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([])),
            });
            for key in ["reason", "message"] {
                if let Some(value) = body.get(key).filter(|value| !value.is_null()) {
                    out[key] = value.clone();
                }
            }
            Ok(out)
        }
        "claim_email_alias" | "create" => {
            let display_name = if tool == "create" {
                None
            } else {
                optional_string(arguments, "display_name")?
            };
            let base_name = display_name.as_deref().or(agent_name);
            let local_part = match requested_local_part(arguments, base_name)? {
                Ok(local_part) => local_part,
                Err(error) => return Ok(alias_invalid(error)),
            };
            let mut payload = Map::new();
            if let Some(local_part) = local_part {
                payload.insert("localPart".to_owned(), Value::String(local_part));
            }
            if let Some(name) = base_name {
                payload.insert("displayName".to_owned(), Value::String(name.to_owned()));
            }
            let reply = request(
                http,
                target,
                Method::POST,
                &agent_path(target, "/alias"),
                Some(Value::Object(payload)),
            )
            .await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let alias = field(&reply.body, "alias");
            let status = reply
                .body
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("active")
                .to_owned();
            let address = alias
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or("this address");
            Ok(json!({
                "ok": true,
                "status": status,
                "alias": alias_summary(&alias, false),
                "mailbox": mailbox_summary(&field(&reply.body, "mailbox")),
                "message": claim_message(&status, address),
            }))
        }
        "list_messages" => {
            let limit = optional_bounded(arguments, "limit", MESSAGE_LIMIT_MAX)?;
            let cursor = optional_string(arguments, "cursor")?;
            let unread = optional_bool(arguments, "unread_only")?.unwrap_or(false);
            let path = agent_path(target, "/messages")
                + &query_string(&[
                    ("limit", limit.map(|limit| limit.to_string())),
                    ("cursor", cursor),
                    ("unread", unread.then(|| "1".to_owned())),
                ]);
            let reply = request(http, target, Method::GET, &path, None).await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let body = untrusted_view(reply.body);
            Ok(json!({
                "ok": true,
                "messages": body.get("messages").cloned().unwrap_or_else(|| json!([])),
                "next_cursor": field(&body, "next_cursor"),
            }))
        }
        "read_message" => {
            let message_id = required_string(arguments, "message_id")?;
            let path = agent_path(
                target,
                &format!("/messages/{}", urlencoding::encode(&message_id)),
            );
            let reply = request(http, target, Method::GET, &path, None).await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let body = untrusted_view(reply.body);
            Ok(json!({ "ok": true, "message": field(&body, "message") }))
        }
        "send" => {
            let mut payload = Map::new();
            let to = address_list(arguments, "to", true)?.unwrap_or_default();
            payload.insert("to".to_owned(), json!(to));
            if let Some(cc) = address_list(arguments, "cc", false)? {
                payload.insert("cc".to_owned(), json!(cc));
            }
            payload.insert(
                "subject".to_owned(),
                json!(required_text(arguments, "subject")?),
            );
            payload.insert("text".to_owned(), json!(required_text(arguments, "text")?));
            if let Some(reply_to) = optional_string(arguments, "reply_to")? {
                payload.insert("replyTo".to_owned(), json!(reply_to));
            }
            let reply = request(
                http,
                target,
                Method::POST,
                &agent_path(target, "/send"),
                Some(Value::Object(payload)),
            )
            .await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            Ok(send_result(&reply))
        }
        "reply" => {
            let message_id = required_string(arguments, "message_id")?;
            let mut payload = Map::new();
            payload.insert("text".to_owned(), json!(required_text(arguments, "text")?));
            if let Some(reply_all) = optional_bool(arguments, "reply_all")? {
                payload.insert("replyAll".to_owned(), json!(reply_all));
            }
            let path = agent_path(
                target,
                &format!("/messages/{}/reply", urlencoding::encode(&message_id)),
            );
            let reply = request(
                http,
                target,
                Method::POST,
                &path,
                Some(Value::Object(payload)),
            )
            .await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            Ok(send_result(&reply))
        }
        "get_verification_code" => {
            let since = optional_bounded(arguments, "since_minutes", SINCE_MINUTES_MAX)?;
            let from_domain = optional_string(arguments, "from_domain")?
                .map(|domain| domain.to_ascii_lowercase());
            let path = agent_path(target, "/verification-codes")
                + &query_string(&[
                    ("sinceMinutes", since.map(|since| since.to_string())),
                    ("fromDomain", from_domain),
                ]);
            let reply = request(http, target, Method::GET, &path, None).await;
            if !reply.status.is_success() {
                return Ok(refusal(&reply));
            }
            let body = snake_case_keys(reply.body);
            let mut codes = Value::Array(
                body.get("codes")
                    .and_then(Value::as_array)
                    .map(|codes| codes.iter().map(verification_entry).collect())
                    .unwrap_or_default(),
            );
            wrap_untrusted_fields(&mut codes);
            Ok(json!({ "ok": true, "codes": codes }))
        }
        "set_address" => Ok(address_permanent()),
        other => Err(anyhow!("unknown agent_inbox tool '{other}'")),
    }
}

fn address_permanent() -> Value {
    LocalRefusal::new(409, "address_permanent", ADDRESS_PERMANENT).into_value()
}

/// Dispatch an `agent_inbox.*` call for the calling agent. A call this node
/// cannot make answers a local refusal as data.
pub async fn dispatch(
    http: &Client,
    tool: &str,
    arguments: Value,
    agent_id: Option<&str>,
    agent_store: Option<&crate::agents::AgentStore>,
) -> Result<Value> {
    if !tools().iter().any(|candidate| candidate.name == tool) {
        return Err(anyhow!("unknown agent_inbox tool '{tool}'"));
    }
    if tool == "set_address" {
        return Ok(address_permanent());
    }
    let node = crate::sidecar::control_plane::registered_node();
    let target = match resolve_target(
        node.as_ref(),
        crate::sidecar::control_plane::gateway_key(),
        &crate::sidecar::control_plane::control_plane_url(),
        agent_id,
    ) {
        Ok(target) => target,
        Err(refusal) => return Ok(refusal.into_value()),
    };
    let agent_name = match (agent_id, agent_store) {
        (Some(id), Some(store)) => store.get(id).await.ok().flatten().map(|record| record.name),
        _ => None,
    };
    call(http, &target, tool, &arguments, agent_name.as_deref()).await
}
