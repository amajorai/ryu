//! Running one machine verb on a conversation's session Box: the routing
//! decision, the schema check, and the direct Box service call.

use super::*;

// ── Routing ──────────────────────────────────────────────────────────────────

/// Run a machine verb of a conversation on its session Box.
///
/// `None` means "not a Box call": not a machine verb, no conversation, no
/// resolvable owner, or a caller who keeps the node (see the module docs). The
/// facade then resolves the node's provider as before.
pub(crate) async fn route(
    store: Option<&ConversationStore>,
    host_conversation_id: Option<&str>,
    tool_id: &str,
    arguments: &Value,
) -> Option<Result<Value>> {
    if !capability_tools::is_machine_verb(tool_id) {
        return None;
    }
    let conversation_id = host_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let resolved = match conversation_id {
        Some(conversation_id) => resolve(store, conversation_id).await,
        None => None,
    };
    let (Some(conversation_id), Some(resolved)) = (conversation_id, resolved) else {
        return unattributed(store, conversation_id).await.map(Err);
    };
    // Refuse arguments outside the canonical schema before any Box is acquired.
    if let Err(error) = plan(tool_id, arguments) {
        return Some(Err(error));
    }
    let target = match target_for(&resolved, conversation_id).await {
        Ok(Some(target)) => target,
        Ok(None) => return None,
        Err(error) => return Some(Err(error)),
    };
    let result = call(&target, tool_id, arguments.clone()).await;
    session_box::touch(&resolved.key).await;
    Some(result)
}

/// A machine verb with no Box key: no conversation, or one whose owner Core
/// cannot derive (an org-bound node's system call, an untenanted
/// conversation). On an unbound node a call without a conversation is the
/// local owner's and keeps the node (design §7.4). Otherwise there is no
/// verified caller to start a Box, so on a node that puts computer use on
/// session Boxes the call fails closed rather than driving the node display.
pub(in crate::sidecar::mcp::box_desktop) async fn unattributed(
    store: Option<&ConversationStore>,
    conversation_id: Option<&str>,
) -> Option<anyhow::Error> {
    let principal = ToolPrincipal::resolve_optional(store, conversation_id).await;
    if conversation_id.is_none() && principal == ToolPrincipal::Unrestricted {
        return None;
    }
    session_box::computer_use_goes_to_boxes()
        .await
        .then(|| anyhow!(NO_TURN_AUTHORITY_REFUSAL))
}

/// The Box a resolved conversation's verb runs on, acquiring one when the
/// caller may. `Ok(None)` keeps the call on the node.
pub(in crate::sidecar::mcp::box_desktop) async fn target_for(
    resolved: &Resolved,
    conversation_id: &str,
) -> Result<Option<BoxTarget>> {
    let key = &resolved.key;
    if let Some(authority) = authority_for_conversation(key, conversation_id) {
        return match session_box::desktop_target(&authority, key, Some(resolved.reason)).await {
            Ok(Some(target)) => Ok(Some(target)),
            Ok(None) if conversation_is_bound(conversation_id).await => Err(anyhow!(
                "This cloud conversation's Box is not available; stop and resume the session"
            )),
            // A conversation that has a Box (its own, its parent's, or this
            // child's) never falls back to the node's display: the caller
            // may not acquire one right now (an expired turn token, a failed
            // Box credential), which a new message fixes.
            Ok(None)
                if session_box::routes_to_box(key).await
                    && session_box::computer_target_is_auto().await =>
            {
                Err(anyhow!(
                    "This conversation's session Box is not available for this turn; send the message again from the conversation"
                ))
            }
            Ok(None) => Ok(None),
            Err(refusal) => Err(refusal_error(&refusal)),
        };
    }
    // Without the turn's verified caller only an existing cloud task Box may be
    // used: its owner is server-derived, and nothing is created.
    if key.child.is_none() {
        if let Some(target) =
            crate::server::cloud_tasks::bound_box(&key.owner, &key.conversation_id).await
        {
            return Ok(Some(target));
        }
    }
    if session_box::routes_to_box(key).await || conversation_is_bound(conversation_id).await {
        return Err(anyhow!(
            "This conversation's session Box needs the verified caller of the turn; send the message again from the conversation"
        ));
    }
    // No chat turn of the owner is remembered: a scheduled, automation,
    // agent-to-agent, voice, plugin-bridge or bot run on a stored
    // conversation. It may not start a Box, and on a node that puts computer
    // use on Boxes it never falls back to the node's display.
    if session_box::computer_use_goes_to_boxes().await {
        return Err(anyhow!(NO_TURN_AUTHORITY_REFUSAL));
    }
    Ok(None)
}

/// A session Box route refusal (`(status, {error:{code,message}})`) as a
/// model-facing error.
pub(in crate::sidecar::mcp::box_desktop) fn refusal_error(
    refusal: &session_box::ApiError,
) -> anyhow::Error {
    let error = &refusal.1 .0["error"];
    let code = error["code"].as_str().unwrap_or("session_box_unavailable");
    let message = error["message"]
        .as_str()
        .unwrap_or("The session Box could not be used.");
    match error["retryAfter"].as_u64() {
        Some(seconds) => anyhow!("{message} ({code}; retry after {seconds}s)"),
        None => anyhow!("{message} ({code})"),
    }
}

/// One machine verb, checked against its canonical schema.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::sidecar::mcp::box_desktop) enum Planned {
    /// A canonical desktop action for `/desktop/actions`.
    Desktop(Value),
    /// A browser verb and its body for `/browser/:verb`.
    Browser { verb: &'static str, body: Value },
}

/// Check `arguments` against the verb's canonical schema and build the Box
/// request. Fields the schema does not declare are refused: a model cannot
/// name a Box, URL or session.
pub(in crate::sidecar::mcp::box_desktop) fn plan(
    tool_id: &str,
    arguments: &Value,
) -> Result<Planned> {
    let verb = capability_tools::verb_by_id(tool_id)
        .filter(|verb| verb.capability == CAP_COMPUTER || verb.capability == CAP_BROWSER)
        .ok_or_else(|| anyhow!("'{tool_id}' is not a computer or browser verb"))?;
    let arguments = match arguments {
        Value::Null => Map::new(),
        Value::Object(map) => map.clone(),
        _ => bail!("{} arguments must be an object", verb.id),
    };
    check_against_schema(verb.id, &(verb.schema)(), &arguments)?;
    if verb.capability == CAP_BROWSER {
        return Ok(Planned::Browser {
            verb: verb.name,
            body: Value::Object(arguments),
        });
    }
    let action = match verb.name {
        "capture" => "screenshot",
        other => other,
    };
    let mut body = Map::with_capacity(arguments.len() + 1);
    body.insert("action".to_owned(), Value::String(action.to_owned()));
    body.extend(arguments);
    Ok(Planned::Desktop(Value::Object(body)))
}

/// The top-level checks of a canonical verb schema: declared fields only,
/// required fields present, JSON types and enums respected.
pub(in crate::sidecar::mcp::box_desktop) fn check_against_schema(
    verb_id: &str,
    schema: &Value,
    arguments: &Map<String, Value>,
) -> Result<()> {
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    for (name, value) in arguments {
        let Some(property) = properties.get(name) else {
            bail!("{verb_id} does not accept '{name}'; the target comes from the conversation");
        };
        if value.is_null() {
            continue;
        }
        if !matches_type(property, value) {
            bail!("{verb_id}: '{name}' has the wrong type");
        }
        if let Some(allowed) = property["enum"].as_array() {
            if !allowed.contains(value) {
                bail!("{verb_id}: '{name}' is not one of the allowed values");
            }
        }
    }
    for required in schema["required"].as_array().into_iter().flatten() {
        let Some(name) = required.as_str() else {
            continue;
        };
        if arguments.get(name).is_none_or(Value::is_null) {
            bail!("{verb_id} requires '{name}'");
        }
    }
    Ok(())
}

pub(in crate::sidecar::mcp::box_desktop) fn matches_type(property: &Value, value: &Value) -> bool {
    match property["type"].as_str() {
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_number(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("object") => value.is_object(),
        Some("array") => value.as_array().is_some_and(|items| {
            property["items"]["type"].as_str() != Some("string")
                || items.iter().all(Value::is_string)
        }),
        _ => true,
    }
}

/// Run one machine verb on the Box of `target` (design §7.4 table). Calls the
/// Box service directly, never the registry.
pub(crate) async fn call(target: &BoxTarget, verb: &str, args: Value) -> Result<Value> {
    let planned = plan(verb, &args)?;
    let client = session_box::box_client()
        .await
        .map_err(|error| anyhow!("Ryu Box is not configured on this node: {error}"))?;
    execute(&client, target, &planned).await
}

pub(in crate::sidecar::mcp::box_desktop) async fn execute(
    client: &BoxSessionClient,
    target: &BoxTarget,
    planned: &Planned,
) -> Result<Value> {
    match planned {
        Planned::Desktop(action) => {
            let raw = client
                .desktop_action(&target.box_id, action)
                .await
                .map_err(|error| box_error("desktop action", &error))?;
            Ok(desktop_result(raw))
        }
        Planned::Browser { verb, body } => {
            let raw = client
                .browser_call(&target.box_id, verb, body)
                .await
                .map_err(|error| box_error("browser", &error))?;
            Ok(json!({
                "provider": PROVIDER_ID,
                "target": "remote-desktop",
                "verb": verb,
                "result": raw.get("result").cloned().unwrap_or(Value::Null),
            }))
        }
    }
}

/// The Box's desktop action answer without its envelope: the screenshot
/// fields (`image`, `encoding`, `mime`, `width`, `height`, …) or nothing.
pub(in crate::sidecar::mcp::box_desktop) fn desktop_result(raw: Value) -> Value {
    let mut fields = match raw {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    fields.remove("ok");
    fields.remove("type");
    fields.insert("provider".to_owned(), Value::String(PROVIDER_ID.to_owned()));
    fields.insert(
        "target".to_owned(),
        Value::String("remote-desktop".to_owned()),
    );
    Value::Object(fields)
}

pub(in crate::sidecar::mcp::box_desktop) fn box_error(
    what: &str,
    error: &BoxApiError,
) -> anyhow::Error {
    match error {
        BoxApiError::Http {
            status,
            code,
            message,
        } => anyhow!("The session Box {what} failed ({status} {code}): {message}"),
        other => refusal_error(&session_box::box_api_error(other)),
    }
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
