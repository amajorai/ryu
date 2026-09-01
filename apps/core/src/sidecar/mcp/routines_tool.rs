//! Built-in routine/schedule tools for agents.
//!
//! A routine is a persisted scheduler job. The tool surface deliberately uses
//! the user's word "routine" while the on-disk/runtime type remains
//! `ScheduledJob`. Mutations pass through the same scheduler validation and
//! ownership rules as the HTTP surface, and the normal MCP approval gate wraps
//! the call before this module is reached.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};
use crate::agents::AgentStore;
use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};

/// Reserved registry server for recurring agent routines.
pub const SERVER_NAME: &str = "routines";

const MUTATING_ANNOTATIONS: &str = r#"{"readOnlyHint":false,"destructiveHint":true}"#;
const READ_ANNOTATIONS: &str = r#"{"readOnlyHint":true,"destructiveHint":false}"#;

fn schedule_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "cron" },
                    "expr": { "type": "string", "description": "Five-field cron expression." },
                    "tz": { "type": ["string", "null"], "description": "Optional IANA time zone; absent means UTC." }
                },
                "required": ["kind", "expr"]
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "every" },
                    "interval": { "type": "string", "description": "Fixed interval such as 15m, 1h, or 1d." }
                },
                "required": ["kind", "interval"]
            }
        ]
    })
}

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "agent_id": { "type": "string", "description": "Optional agent id to filter by." }
        }
    })
}

fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "agent_id": { "type": "string", "description": "Agent to run; defaults to the calling agent." },
            "name": { "type": "string", "description": "Human name for this routine." },
            "prompt": { "type": "string", "description": "Instructions sent to the agent on each firing." },
            "schedule": schedule_schema(),
            "enabled": { "type": "boolean", "description": "Whether the routine is active. Defaults to true." },
            "require_approval": { "type": "boolean", "description": "Queue each firing in the user's approval inbox instead of running it directly." },
            "conversation_id": { "type": "string", "description": "Append each run to this existing chat. Omit in an existing chat to use that current chat." },
            "new_chat": { "type": "boolean", "description": "Start a new persistent chat for every firing, ignoring the current chat. Defaults to false when called from a chat." },
            "model": { "type": "string", "description": "Optional model id to pin for each firing." }
        },
        "required": ["name", "prompt", "schedule"]
    })
}

fn update_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "job_id": { "type": "string", "description": "Routine id returned by routines.list or routines.create." },
            "name": { "type": "string" },
            "prompt": { "type": "string" },
            "schedule": schedule_schema(),
            "enabled": { "type": "boolean" },
            "require_approval": { "type": "boolean" },
            "conversation_id": { "type": "string", "description": "Existing chat to append to." },
            "new_chat": { "type": "boolean", "description": "Set true to make each future firing start a new persistent chat." },
            "model": { "type": "string", "description": "Optional model id to pin for each firing." }
        },
        "required": ["job_id"]
    })
}

fn job_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "job_id": { "type": "string", "description": "Routine id returned by routines.list or routines.create." }
        },
        "required": ["job_id"]
    })
}

fn annotations(raw: &str) -> Value {
    serde_json::from_str(raw).expect("built-in routine annotations are valid JSON")
}

/// Agent-visible routine tools.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}.list"),
            server: SERVER_NAME.to_owned(),
            name: "list".to_owned(),
            description: Some(
                "List the scheduled routines owned by the current user, including their \
                 cron/interval, target agent, persistent chat destination, last outcome, and \
                 bounded execution history."
                    .to_owned(),
            ),
            input_schema: Some(list_schema()),
            annotations: Some(annotations(READ_ANNOTATIONS)),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.create"),
            server: SERVER_NAME.to_owned(),
            name: "create".to_owned(),
            description: Some(
                "Create a recurring agent routine. In an existing chat, omit conversation_id \
                 to keep every firing in that same persistent chat; pass a conversation_id to \
                 use another existing chat; set new_chat=true to create a new persistent chat \
                 for each firing. New routines are approval-gated by the normal agent policy."
                    .to_owned(),
            ),
            input_schema: Some(create_schema()),
            annotations: Some(annotations(MUTATING_ANNOTATIONS)),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.update"),
            server: SERVER_NAME.to_owned(),
            name: "update".to_owned(),
            description: Some(
                "Edit an existing agent routine's name, prompt, cron/interval, enabled state, \
                 approval requirement, or persistent chat destination."
                    .to_owned(),
            ),
            input_schema: Some(update_schema()),
            annotations: Some(annotations(MUTATING_ANNOTATIONS)),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.delete"),
            server: SERVER_NAME.to_owned(),
            name: "delete".to_owned(),
            description: Some("Delete one scheduled agent routine by id.".to_owned()),
            input_schema: Some(job_schema()),
            annotations: Some(annotations(MUTATING_ANNOTATIONS)),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.run_now"),
            server: SERVER_NAME.to_owned(),
            name: "run_now".to_owned(),
            description: Some(
                "Run one saved agent routine immediately and record the outcome in its history. \
                 This uses the same target and persistent-chat destination as the next scheduled \
                 firing."
                    .to_owned(),
            ),
            input_schema: Some(job_schema()),
            annotations: Some(annotations(MUTATING_ANNOTATIONS)),
            ..Default::default()
        },
    ]
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("routines action requires a non-empty '{name}'"))
}

fn optional_bool(arguments: &Value, name: &str, default: bool) -> Result<bool> {
    match arguments.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(anyhow!("'{name}' must be a boolean")),
    }
}

fn optional_string(arguments: &Value, name: &str) -> Result<Option<String>> {
    match arguments.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            Ok((!value.trim().is_empty()).then(|| value.trim().to_owned()))
        }
        Some(_) => Err(anyhow!("'{name}' must be a string")),
    }
}

fn parse_schedule(arguments: &Value) -> Result<Schedule> {
    let value = arguments
        .get("schedule")
        .ok_or_else(|| anyhow!("routine requires a 'schedule' object"))?;
    serde_json::from_value(value.clone()).map_err(|error| anyhow!("invalid schedule: {error}"))
}

fn validate_schedule(schedule: &Schedule) -> Result<()> {
    crate::scheduler::validate_schedule(schedule).map_err(|error| anyhow!(error))
}

fn principal_owner(principal: &ToolPrincipal) -> Result<(Option<String>, Option<String>)> {
    match principal {
        ToolPrincipal::Unrestricted => Ok((None, None)),
        ToolPrincipal::Owned { user_id, org_id } => Ok((Some(user_id.clone()), org_id.clone())),
        ToolPrincipal::Unresolved => Err(anyhow!(
            "routines are unavailable: this shared-node agent turn has no identifiable owner"
        )),
    }
}

fn owns_job(principal: &ToolPrincipal, job: &ScheduledJob) -> bool {
    match principal {
        ToolPrincipal::Unrestricted => true,
        ToolPrincipal::Owned { user_id, org_id } => {
            job.owner_user_id.as_deref() == Some(user_id.as_str())
                && job.org_id.as_deref() == org_id.as_deref()
        }
        ToolPrincipal::Unresolved => false,
    }
}

fn is_agent_job(job: &ScheduledJob) -> bool {
    matches!(job.target, JobTarget::Agent { .. })
}

async fn validate_agent(
    agent_store: Option<&AgentStore>,
    agent_id: &str,
    enabled: bool,
) -> Result<()> {
    let Some(store) = agent_store else {
        return Ok(());
    };
    match store.get(agent_id).await? {
        Some(agent)
            if !enabled
                || agent.lifecycle_status == crate::agents::AgentLifecycleStatus::Active =>
        {
            Ok(())
        }
        Some(agent) => Err(anyhow!(
            "agent '{}' is in {} mode and cannot have an enabled routine",
            agent.name,
            agent.lifecycle_status.as_str()
        )),
        None => Err(anyhow!("agent '{agent_id}' not found")),
    }
}

async fn validate_conversation(
    principal: &ToolPrincipal,
    conversations: Option<&crate::server::conversations::ConversationStore>,
    conversation_id: Option<&str>,
) -> Result<()> {
    let Some(conversation_id) = conversation_id else {
        return Ok(());
    };
    let Some(store) = conversations else {
        return Err(anyhow!("conversation store is unavailable"));
    };
    let allowed = match principal {
        ToolPrincipal::Unrestricted => true,
        ToolPrincipal::Unresolved => false,
        ToolPrincipal::Owned { user_id, org_id } => matches!(
            store.get_access_meta(conversation_id).await,
            Ok(Some(meta))
                if meta.owner_user_id.as_deref() == Some(user_id.as_str())
                    && meta.org_id.as_deref() == org_id.as_deref()
        ),
    };
    if !allowed {
        return Err(anyhow!(
            "routine conversation '{conversation_id}' is not owned by this agent's user"
        ));
    }
    Ok(())
}

fn selected_conversation(
    arguments: &Value,
    host_conversation_id: Option<&str>,
) -> Result<Option<String>> {
    if optional_bool(arguments, "new_chat", false)? {
        return Ok(None);
    }
    if let Some(id) = optional_string(arguments, "conversation_id")? {
        return Ok(Some(id));
    }
    Ok(host_conversation_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned))
}

fn target_agent_id(arguments: &Value, calling_agent_id: Option<&str>) -> Result<String> {
    optional_string(arguments, "agent_id")?
        .or_else(|| calling_agent_id.map(str::to_owned))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("routine needs an 'agent_id' or a calling agent"))
}

async fn create(
    arguments: Value,
    principal: &ToolPrincipal,
    agent_store: Option<&AgentStore>,
    conversations: Option<&crate::server::conversations::ConversationStore>,
    calling_agent_id: Option<&str>,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    let (owner_user_id, org_id) = principal_owner(principal)?;
    let agent_id = target_agent_id(&arguments, calling_agent_id)?;
    let enabled = optional_bool(&arguments, "enabled", true)?;
    let schedule = parse_schedule(&arguments)?;
    validate_schedule(&schedule)?;
    validate_agent(agent_store, &agent_id, enabled).await?;
    let conversation_id = selected_conversation(&arguments, host_conversation_id)?;
    validate_conversation(principal, conversations, conversation_id.as_deref()).await?;
    let name = required_string(&arguments, "name")?;
    let prompt = required_string(&arguments, "prompt")?;
    let now = chrono::Utc::now().to_rfc3339();
    let job = ScheduledJob {
        id: format!("job_{}", uuid::Uuid::new_v4().simple()),
        name: name.to_owned(),
        schedule,
        target: JobTarget::Agent {
            agent_id,
            prompt: prompt.to_owned(),
            model: optional_string(&arguments, "model")?,
            conversation_id,
        },
        enabled,
        require_approval: optional_bool(&arguments, "require_approval", false)?,
        owner_app: None,
        owner_user_id,
        org_id,
        created_at: now.clone(),
        updated_at: now,
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };
    crate::scheduler::store::save_job(&job).map_err(|error| anyhow!("saving routine: {error}"))?;
    Ok(json!({ "ok": true, "routine": job }))
}

async fn update(
    arguments: Value,
    principal: &ToolPrincipal,
    agent_store: Option<&AgentStore>,
    conversations: Option<&crate::server::conversations::ConversationStore>,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    let job_id = required_string(&arguments, "job_id")?;
    let mut job = crate::scheduler::store::load_job(job_id)
        .map_err(|_| anyhow!("routine '{job_id}' not found"))?;
    if !owns_job(principal, &job) {
        return Err(anyhow!(
            "routine '{job_id}' is not owned by this agent's user"
        ));
    }
    if !is_agent_job(&job) {
        return Err(anyhow!("routine '{job_id}' is not an agent routine"));
    }
    let current_target = match &job.target {
        JobTarget::Agent {
            agent_id,
            prompt,
            model,
            conversation_id,
        } => (
            agent_id.clone(),
            prompt.clone(),
            model.clone(),
            conversation_id.clone(),
        ),
        _ => unreachable!("is_agent_job checked above"),
    };
    let enabled = match arguments.get("enabled") {
        None => job.enabled,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(anyhow!("'enabled' must be a boolean")),
    };
    if let Some(name) = optional_string(&arguments, "name")? {
        job.name = name;
    }
    let prompt = optional_string(&arguments, "prompt")?.unwrap_or(current_target.1);
    let model = optional_string(&arguments, "model")?.or(current_target.2);
    let conversation_id = match arguments.get("new_chat") {
        Some(Value::Bool(true)) => None,
        Some(Value::Bool(false)) if arguments.get("conversation_id").is_none() => current_target.3,
        Some(_) | None if arguments.get("conversation_id").is_some() => {
            selected_conversation(&arguments, host_conversation_id)?
        }
        Some(Value::Bool(false)) => current_target.3,
        Some(_) => return Err(anyhow!("'new_chat' must be a boolean")),
        None => current_target.3,
    };
    validate_conversation(principal, conversations, conversation_id.as_deref()).await?;
    let schedule = match arguments.get("schedule") {
        Some(_) => parse_schedule(&arguments)?,
        None => job.schedule.clone(),
    };
    validate_schedule(&schedule)?;
    let require_approval = match arguments.get("require_approval") {
        None => job.require_approval,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(anyhow!("'require_approval' must be a boolean")),
    };
    validate_agent(agent_store, &current_target.0, enabled).await?;
    job.enabled = enabled;
    job.schedule = schedule;
    job.require_approval = require_approval;
    job.target = JobTarget::Agent {
        agent_id: current_target.0,
        prompt,
        model,
        conversation_id,
    };
    job.updated_at = chrono::Utc::now().to_rfc3339();
    crate::scheduler::store::save_job(&job).map_err(|error| anyhow!("saving routine: {error}"))?;
    Ok(json!({ "ok": true, "routine": job }))
}

fn list(arguments: Value, principal: &ToolPrincipal) -> Result<Value> {
    let agent_filter = optional_string(&arguments, "agent_id")?;
    let jobs = crate::scheduler::store::list_jobs()
        .into_iter()
        .filter(|job| owns_job(principal, job))
        .filter(|job| is_agent_job(job))
        .filter(|job| {
            agent_filter.as_deref().is_none_or(
                |id| matches!(&job.target, JobTarget::Agent { agent_id, .. } if agent_id == id),
            )
        })
        .collect::<Vec<_>>();
    Ok(json!({ "routines": jobs }))
}

fn delete(arguments: Value, principal: &ToolPrincipal) -> Result<Value> {
    let job_id = required_string(&arguments, "job_id")?;
    let job = crate::scheduler::store::load_job(job_id)
        .map_err(|_| anyhow!("routine '{job_id}' not found"))?;
    if !owns_job(principal, &job) {
        return Err(anyhow!(
            "routine '{job_id}' is not owned by this agent's user"
        ));
    }
    if !is_agent_job(&job) {
        return Err(anyhow!("routine '{job_id}' is not an agent routine"));
    }
    let deleted = crate::scheduler::store::delete_job(job_id)
        .map_err(|error| anyhow!("deleting routine: {error}"))?;
    Ok(json!({ "ok": deleted, "deleted": deleted, "job_id": job_id }))
}

async fn run_now(arguments: Value, principal: &ToolPrincipal) -> Result<Value> {
    let job_id = required_string(&arguments, "job_id")?;
    let mut job = crate::scheduler::store::load_job(job_id)
        .map_err(|_| anyhow!("routine '{job_id}' not found"))?;
    if !owns_job(principal, &job) {
        return Err(anyhow!(
            "routine '{job_id}' is not owned by this agent's user"
        ));
    }
    if !is_agent_job(&job) {
        return Err(anyhow!("routine '{job_id}' is not an agent routine"));
    }
    let started_at = chrono::Utc::now().to_rfc3339();
    let result = Box::pin(crate::scheduler::run_target_for_job(&job)).await;
    let finished_at = chrono::Utc::now().to_rfc3339();
    let (success, run_id, error) = match result {
        Ok(id) => (true, id, None),
        Err(error) => (false, None, Some(error)),
    };
    job.record_execution(crate::scheduler::store::ExecRecord {
        started_at,
        finished_at,
        outcome: if success {
            crate::scheduler::store::ExecOutcome::Success
        } else {
            crate::scheduler::store::ExecOutcome::Failure
        },
        run_id: run_id.clone(),
        error: error.clone(),
    });
    crate::scheduler::store::save_job(&job)
        .map_err(|save_error| anyhow!("saving routine history: {save_error}"))?;
    Ok(json!({
        "ok": success,
        "success": success,
        "job_id": job_id,
        "run_id": run_id,
        "error": error,
        "routine": job
    }))
}

/// Dispatch a routine tool with the caller's server-derived identity and chat
/// scope. `host_conversation_id` is never read from model arguments; it is the
/// conversation that Core already knows owns this turn.
#[allow(clippy::too_many_arguments)]
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    principal: &ToolPrincipal,
    agent_store: Option<&AgentStore>,
    conversations: Option<&crate::server::conversations::ConversationStore>,
    calling_agent_id: Option<&str>,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    match tool {
        "list" => list(arguments, principal),
        "create" => {
            create(
                arguments,
                principal,
                agent_store,
                conversations,
                calling_agent_id,
                host_conversation_id,
            )
            .await
        }
        "update" => {
            update(
                arguments,
                principal,
                agent_store,
                conversations,
                host_conversation_id,
            )
            .await
        }
        "delete" => delete(arguments, principal),
        "run_now" => run_now(arguments, principal).await,
        other => Err(anyhow!("unknown routines tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_conversation_prefers_explicit_or_current_chat() {
        assert_eq!(
            selected_conversation(&json!({ "new_chat": true }), Some("current"))
                .expect("new chat parses"),
            None
        );
        assert_eq!(
            selected_conversation(&json!({ "conversation_id": "other" }), Some("current"))
                .expect("explicit conversation parses"),
            Some("other".to_owned())
        );
        assert_eq!(
            selected_conversation(&json!({}), Some("current"))
                .expect("current conversation parses"),
            Some("current".to_owned())
        );
        assert_eq!(
            selected_conversation(&json!({}), None).expect("no conversation parses"),
            None
        );
    }

    #[test]
    fn routine_schemas_expose_persistent_chat_controls() {
        let create = create_schema();
        let properties = create["properties"]
            .as_object()
            .expect("create schema properties");
        assert!(properties.contains_key("conversation_id"));
        assert!(properties.contains_key("new_chat"));
        assert!(properties.contains_key("model"));
        let update = update_schema();
        let update_properties = update["properties"]
            .as_object()
            .expect("update schema properties");
        assert!(update_properties.contains_key("conversation_id"));
        assert!(update_properties.contains_key("new_chat"));
    }

    #[test]
    fn update_explicit_false_does_not_switch_to_the_invoking_chat() {
        let arguments = json!({ "new_chat": false });
        let current = Some("selected-chat");
        let selected = match arguments.get("new_chat") {
            Some(Value::Bool(true)) => None,
            Some(Value::Bool(false)) if arguments.get("conversation_id").is_none() => {
                Some("existing-routine-chat".to_owned())
            }
            _ => selected_conversation(&arguments, current).expect("selection parses"),
        };
        assert_eq!(selected, Some("existing-routine-chat".to_owned()));
        assert_ne!(selected, current.map(str::to_owned));
    }
}
