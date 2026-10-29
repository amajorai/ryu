//! Conversation-scoped human input for MCP elicitation and multi-round requests.
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

tokio::task_local! { static FORM_SCOPE: (String, String); }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingForm {
    pub id: String,
    pub conversation_id: String,
    pub server: String,
    pub message: String,
    pub requested_schema: Value,
}

type Waiters = Mutex<BTreeMap<String, (PendingForm, oneshot::Sender<Value>)>>;
fn waiters() -> &'static Waiters {
    static WAITERS: OnceLock<Waiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

struct PendingGuard(String);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = waiters().lock() {
            pending.remove(&self.0);
        }
    }
}

pub fn list(conversation_id: &str) -> Vec<PendingForm> {
    waiters()
        .lock()
        .map(|pending| {
            pending
                .values()
                .filter(|(form, _)| form.conversation_id == conversation_id)
                .map(|(form, _)| form.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub fn available() -> bool {
    FORM_SCOPE.try_with(|_| ()).is_ok()
}

/// Bounded primitive schemas are the MCP form contract. Credentials belong in
/// URL-mode authentication, never in an elicitation form.
pub fn validate_schema(schema: &Value) -> Result<()> {
    if schema.to_string().len() > 64 * 1024 || schema["type"] != "object" {
        bail!("Unsupported MCP form schema");
    }
    let properties = schema["properties"]
        .as_object()
        .ok_or_else(|| anyhow!("MCP form needs properties"))?;
    if properties.len() > 32 {
        bail!("MCP form exceeds 32 fields");
    }
    if schema.as_object().is_some_and(|schema| {
        schema.keys().any(|key| {
            !matches!(
                key.as_str(),
                "type"
                    | "properties"
                    | "required"
                    | "title"
                    | "description"
                    | "$schema"
                    | "additionalProperties"
            )
        })
    }) {
        bail!("Unsupported MCP form constraint");
    }
    if let Some(required) = schema.get("required") {
        if !required.as_array().is_some_and(|names| {
            names.iter().all(|name| {
                name.as_str()
                    .is_some_and(|name| properties.contains_key(name))
            })
        }) {
            bail!("Invalid required form fields");
        }
    }
    for (name, field) in properties {
        if matches!(name.as_str(), "__proto__" | "constructor" | "prototype") {
            bail!("Unsafe form field name");
        }
        if !matches!(
            field["type"].as_str(),
            Some("string" | "boolean" | "number" | "integer" | "array")
        ) {
            bail!("Unsupported MCP form field type");
        }
        if !field.as_object().is_some_and(|field| {
            field.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "type"
                        | "title"
                        | "description"
                        | "default"
                        | "minimum"
                        | "maximum"
                        | "minLength"
                        | "maxLength"
                        | "format"
                        | "enum"
                        | "enumNames"
                        | "oneOf"
                        | "anyOf"
                        | "items"
                        | "minItems"
                        | "maxItems"
                        | "uniqueItems"
                        | "pattern"
                        | "x-openai-suggestions"
                        | "x-openai-input"
                )
            })
        }) {
            bail!("Unsupported MCP form constraint");
        }
        if field["type"] == "array" {
            if field["items"]["type"] != "string" {
                bail!("MCP form arrays require string items");
            }
            validate_schema(&json!({"type":"object", "properties":{"item":field["items"]}}))?;
        }
        if let Some(pattern) = field.get("pattern") {
            let pattern = pattern
                .as_str()
                .filter(|pattern| pattern.len() <= 4096)
                .ok_or_else(|| anyhow!("Invalid form pattern"))?;
            regex::Regex::new(pattern).map_err(|_| anyhow!("Unsupported form pattern"))?;
        }
        if let Some(input) = field.get("x-openai-input") {
            if !matches!(input["type"].as_str(), Some("resource" | "file"))
                || input.get("userOptions").is_some()
                || input["selection"] == "implicit"
            {
                bail!("Resource uploads are unavailable for MCP forms");
            }
            if field["type"] == "string" && input.get("selection").is_some() {
                bail!("Single resource inputs cannot specify selection mode");
            }
            if !matches!(field["type"].as_str(), Some("string" | "array"))
                || input
                    .get("selection")
                    .is_some_and(|selection| selection != "explicit")
            {
                bail!("Invalid resource input");
            }
            let options = input["options"]
                .as_array()
                .filter(|options| options.len() <= 64)
                .ok_or_else(|| anyhow!("Invalid resource options"))?;
            if options
                .iter()
                .any(|option| !option["uri"].is_string() || !option["name"].is_string())
            {
                bail!("Invalid resource option");
            }
        }
        for key in ["anyOf", "x-openai-suggestions"] {
            if let Some(choices) = field.get(key) {
                if !choices.as_array().is_some_and(|choices| {
                    !choices.is_empty()
                        && choices.len() <= 64
                        && choices.iter().all(|choice| choice["const"].is_string())
                }) {
                    bail!("Invalid form choices");
                }
            }
        }
        for key in ["minLength", "maxLength", "minItems", "maxItems"] {
            if field.get(key).is_some_and(|value| value.as_u64().is_none()) {
                bail!("Invalid form bound");
            }
        }
        for key in ["minimum", "maximum"] {
            if field.get(key).is_some_and(|value| value.as_f64().is_none()) {
                bail!("Invalid form bound");
            }
        }
        if field.get("format").is_some()
            && !matches!(
                field["format"].as_str(),
                Some("email" | "uri" | "date" | "date-time")
            )
        {
            bail!("Unsupported MCP form format");
        }
        if let Some(choices) = field.get("oneOf") {
            let choices = choices
                .as_array()
                .filter(|choices| !choices.is_empty() && choices.len() <= 64)
                .ok_or_else(|| anyhow!("Invalid form choices"))?;
            if choices.iter().any(|choice| !choice["const"].is_string()) {
                bail!("MCP choices require string const values");
            }
        }
        if let Some(values) = field.get("enum") {
            if !values.as_array().is_some_and(|values| {
                !values.is_empty() && values.len() <= 64 && values.iter().all(Value::is_string)
            }) {
                bail!("Invalid form enum");
            }
        }
    }
    Ok(())
}

fn validate_content(schema: &Value, content: &Value) -> Result<()> {
    let values = content
        .as_object()
        .ok_or_else(|| anyhow!("Form content must be an object"))?;
    let properties = schema["properties"]
        .as_object()
        .ok_or_else(|| anyhow!("Missing form properties"))?;
    if content.to_string().len() > 64 * 1024
        || values.keys().any(|key| !properties.contains_key(key))
    {
        bail!("Invalid form fields");
    }
    if let Some(required) = schema["required"].as_array() {
        for name in required {
            if !name.as_str().is_some_and(|key| values.contains_key(key)) {
                bail!("Missing required field");
            }
        }
    }
    for (name, value) in values {
        let field = &properties[name];
        if field["type"] == "array" {
            let entries = value
                .as_array()
                .filter(|entries| entries.len() <= 128)
                .ok_or_else(|| anyhow!("Invalid array for {name}"))?;
            if field["minItems"]
                .as_u64()
                .is_some_and(|minimum| entries.len() < minimum as usize)
                || field["maxItems"]
                    .as_u64()
                    .is_some_and(|maximum| entries.len() > maximum as usize)
            {
                bail!("Invalid selection count for {name}");
            }
            if field["uniqueItems"] == true
                && entries
                    .iter()
                    .enumerate()
                    .any(|(index, entry)| entries[..index].contains(entry))
            {
                bail!("Duplicate selection for {name}");
            }
            for entry in entries {
                validate_content(
                    &json!({"type":"object","properties":{"item":field["items"]}}),
                    &json!({"item":entry}),
                )?;
            }
            if let Some(input) = field.get("x-openai-input") {
                if entries.iter().any(|entry| {
                    !input["options"].as_array().is_some_and(|options| {
                        options
                            .iter()
                            .any(|option| option.get("uri") == Some(entry))
                    })
                }) {
                    bail!("Unknown resource selection for {name}");
                }
            }
            continue;
        }
        let valid = match field["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("number") => value.is_number(),
            Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
            _ => false,
        };
        if !valid {
            bail!("Invalid value for {name}");
        }
        if let Some(text) = value.as_str() {
            let length = text.chars().count() as u64;
            if field["minLength"].as_u64().is_some_and(|min| length < min)
                || field["maxLength"].as_u64().is_some_and(|max| length > max)
            {
                bail!("Invalid length for {name}");
            }
            let format_valid = match field["format"].as_str() {
                Some("email") => text.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty()
                        && domain.contains('.')
                        && !text.chars().any(char::is_whitespace)
                }),
                Some("uri") => url::Url::parse(text).is_ok(),
                Some("date") => chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok(),
                Some("date-time") => chrono::DateTime::parse_from_rfc3339(text).is_ok(),
                _ => true,
            };
            if !format_valid {
                bail!("Invalid format for {name}");
            }
            if let Some(pattern) = field["pattern"].as_str() {
                if !regex::Regex::new(pattern)?.is_match(text) {
                    bail!("Invalid pattern for {name}");
                }
            }
        }
        if let Some(number) = value.as_f64() {
            if field["minimum"].as_f64().is_some_and(|min| number < min)
                || field["maximum"].as_f64().is_some_and(|max| number > max)
            {
                bail!("Invalid range for {name}");
            }
        }
        if field["enum"]
            .as_array()
            .is_some_and(|choices| !choices.contains(value))
            || field["oneOf"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .filter(|choice| choice.get("const") == Some(value))
                    .count()
                    != 1
            })
        {
            bail!("Invalid choice for {name}");
        }
        if field["anyOf"].as_array().is_some_and(|choices| {
            !choices
                .iter()
                .any(|choice| choice.get("const") == Some(value))
        }) {
            bail!("Invalid choice for {name}");
        }
        if let Some(input) = field.get("x-openai-input") {
            if !input["options"].as_array().is_some_and(|options| {
                options
                    .iter()
                    .any(|option| option.get("uri") == Some(value))
            }) {
                bail!("Unknown resource selection for {name}");
            }
        }
    }
    Ok(())
}

pub fn resolve(
    conversation_id: &str,
    id: &str,
    action: &str,
    content: Option<Value>,
) -> Result<bool> {
    if !matches!(action, "accept" | "decline" | "cancel") {
        bail!("Invalid form action");
    }
    let mut pending = waiters()
        .lock()
        .map_err(|_| anyhow!("Form registry unavailable"))?;
    let Some((form, _)) = pending
        .get(id)
        .filter(|(form, _)| form.conversation_id == conversation_id)
    else {
        return Ok(false);
    };
    let response = if action == "accept" {
        let content = content.ok_or_else(|| anyhow!("Accepted form needs content"))?;
        validate_content(&form.requested_schema, &content)?;
        json!({ "action": action, "content": content })
    } else {
        json!({ "action": action })
    };
    Ok(pending
        .remove(id)
        .is_some_and(|(_, sender)| sender.send(response).is_ok()))
}

pub async fn elicit(request: Value) -> Result<Value> {
    if request.get("mode").is_some_and(|mode| mode != "form") {
        bail!("Unsupported elicitation mode");
    }
    let (conversation_id, server) = FORM_SCOPE
        .try_with(Clone::clone)
        .map_err(|_| anyhow!("MCP form requires an interactive conversation"))?;
    let schema = request
        .get("requestedSchema")
        .cloned()
        .ok_or_else(|| anyhow!("MCP form missing requestedSchema"))?;
    validate_schema(&schema)?;
    let id = uuid::Uuid::new_v4().to_string();
    let form = PendingForm {
        id: id.clone(),
        conversation_id,
        server,
        message: request["message"]
            .as_str()
            .unwrap_or("Provide the requested information")
            .chars()
            .take(4096)
            .collect(),
        requested_schema: schema,
    };
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = waiters()
            .lock()
            .map_err(|_| anyhow!("Form registry unavailable"))?;
        if pending.len() >= 128 {
            bail!("Too many pending MCP forms");
        }
        pending.insert(id.clone(), (form, sender));
    }
    let _guard = PendingGuard(id);
    match tokio::time::timeout(Duration::from_secs(300), receiver).await {
        Ok(Ok(response)) => Ok(response),
        _ => Ok(json!({ "action": "cancel" })),
    }
}

pub async fn call_tool(
    target: &super::client::McpTarget,
    server: &str,
    tool: &str,
    arguments: Value,
    conversation_id: Option<&str>,
) -> Result<Value> {
    let Some(conversation_id) = conversation_id.filter(|id| !id.is_empty()) else {
        return super::client::call_tool(target, tool, arguments).await;
    };
    FORM_SCOPE
        .scope((conversation_id.to_owned(), server.to_owned()), async {
            super::client::call_tool_full_with_mrtr(
                target,
                tool,
                arguments,
                capabilities(),
                |requests| async move {
                    let mut responses = serde_json::Map::new();
                    for (id, request) in requests
                        .as_object()
                        .ok_or_else(|| anyhow!("Invalid MCP input requests"))?
                    {
                        responses
                            .insert(id.clone(), elicit(form_request_parameters(request)?).await?);
                    }
                    Ok(Value::Object(responses))
                },
            )
            .await
            .map(|result| result.raw)
        })
        .await
}

fn form_request_parameters(request: &Value) -> Result<Value> {
    let supported = match request.get("method") {
        Some(method) => matches!(
            method.as_str(),
            Some("elicitation/create" | "openai/elicitation/create")
        ),
        None => matches!(
            request["type"].as_str(),
            Some("elicitation" | "openai/elicitation")
        ),
    };
    if !supported {
        bail!("Unsupported MCP input request");
    }
    Ok(request.get("params").unwrap_or(request).clone())
}

pub fn capabilities() -> Value {
    json!({ "elicitation": { "form": {} }, "extensions": { "openai/elicitation": { "form": {} } } })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn schema() -> Value {
        json!({ "type": "object", "properties": { "style": { "type": "string", "oneOf": [{"const":"blue", "title":"Blue", "x-openai-thumbnail":"https://example.com/blue.png"}, {"const":"green"}] }, "count": {"type":"integer", "minimum":1, "maximum":3} }, "required":["style"] })
    }
    #[test]
    fn choices_and_constraints_are_validated() {
        validate_schema(&schema()).unwrap();
        validate_content(&schema(), &json!({"style":"blue", "count":2})).unwrap();
        assert!(validate_content(&schema(), &json!({"style":"red"})).is_err());
        assert!(validate_content(&schema(), &json!({"style":"blue", "count":4})).is_err());
        assert!(validate_content(&schema(), &json!({})).is_err());
    }
    #[test]
    fn rich_arrays_suggestions_patterns_and_resource_constraints() {
        let schema = json!({"type":"object", "properties": {
            "parts":{"type":"array", "minItems":1, "maxItems":2, "items":{"type":"string", "minLength":1, "x-openai-suggestions":[{"const":"washer", "title":"Washer"}]}},
            "resource":{"type":"string", "format":"uri", "pattern":"^cad:", "x-openai-input":{"type":"resource", "options":[{"uri":"cad://parts/bolt", "name":"Bolt"}]}}
        }});
        validate_schema(&schema).unwrap();
        validate_content(
            &schema,
            &json!({"parts":["washer","custom"], "resource":"cad://parts/bolt"}),
        )
        .unwrap();
        assert!(validate_content(&schema, &json!({"parts":[]})).is_err());
        assert!(validate_content(&schema, &json!({"parts":["washer", "", "too-many"]})).is_err());
        assert!(validate_content(&schema, &json!({"resource":"cad://parts/other"})).is_err());
        let unsupported = json!({"type":"object", "properties":{"resource":{"type":"string", "x-openai-input":{"type":"resource", "options":[], "userOptions":{}}}}});
        assert!(validate_schema(&unsupported).is_err());
    }
    #[test]
    fn mrtr_uses_standard_request_method_and_params() {
        let parameters = json!({"mode":"form","requestedSchema":schema()});
        assert_eq!(
            form_request_parameters(&json!({"method":"elicitation/create","params":parameters}))
                .unwrap(),
            parameters
        );
        assert_eq!(
            form_request_parameters(
                &json!({"method":"openai/elicitation/create","params":parameters})
            )
            .unwrap(),
            parameters
        );
        assert!(form_request_parameters(
            &json!({"method":"sampling/createMessage", "type":"elicitation", "params":parameters})
        )
        .is_err());
    }
    #[tokio::test]
    async fn form_is_scoped_and_resolution_resumes_waiter() {
        let conversation = uuid::Uuid::new_v4().to_string();
        let task_conversation = conversation.clone();
        let task = tokio::spawn(async move {
            FORM_SCOPE
                .scope(
                    (task_conversation, "test".to_owned()),
                    elicit(json!({"requestedSchema":schema(), "message":"Choose"})),
                )
                .await
        });
        tokio::task::yield_now().await;
        let pending = list(&conversation);
        assert_eq!(pending.len(), 1);
        assert!(!resolve("other", &pending[0].id, "cancel", None).unwrap());
        assert!(resolve(
            &conversation,
            &pending[0].id,
            "accept",
            Some(json!({"style":"red"}))
        )
        .is_err());
        assert!(resolve(
            &conversation,
            &pending[0].id,
            "accept",
            Some(json!({"style":"blue"}))
        )
        .unwrap());
        assert_eq!(
            task.await.unwrap().unwrap(),
            json!({"action":"accept", "content":{"style":"blue"}})
        );
        assert!(list(&conversation).is_empty());
    }
    #[tokio::test]
    async fn cancellation_returns_without_content() {
        let conversation = uuid::Uuid::new_v4().to_string();
        let scope = conversation.clone();
        let task = tokio::spawn(async move {
            FORM_SCOPE
                .scope(
                    (scope, "test".to_owned()),
                    elicit(json!({"requestedSchema":schema()})),
                )
                .await
        });
        tokio::task::yield_now().await;
        let form = list(&conversation).remove(0);
        assert!(resolve(&conversation, &form.id, "cancel", None).unwrap());
        assert_eq!(task.await.unwrap().unwrap(), json!({"action":"cancel"}));
    }
}
