//! Persistent Agent-UI template records.
//!
//! Templates are data over Core's closed Agent-UI vocabulary. They are never
//! evaluated as code. The HTTP layer owns the resource ACL; this store only
//! persists validated records and their tenancy metadata.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;

const MAX_TEMPLATES: u32 = 500;
const TEMPLATE_ID_PREFIX: &str = "ui_";
const COMPONENTS: &[&str] = &[
    "Stack",
    "Grid",
    "Card",
    "Separator",
    "Heading",
    "Text",
    "Link",
    "Image",
    "Avatar",
    "Badge",
    "Alert",
    "Table",
    "Progress",
    "Skeleton",
    "Button",
    "Input",
    "Textarea",
    "Checkbox",
    "Switch",
    "Select",
    "OptionList",
    "Slider",
    "ApprovalCard",
    "LinkPreview",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUiTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub spec: Value,
    pub params: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_spec: Option<Value>,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct StoredAgentUiTemplate {
    pub template: AgentUiTemplate,
    pub owner_user_id: Option<String>,
    pub org_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUiTemplateInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub spec: Value,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub preview_spec: Option<Value>,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "user".to_owned()
}

impl AgentUiTemplateInput {
    pub fn validate(self) -> Result<Self, String> {
        let name = self.name.trim().to_owned();
        if name.is_empty() || name.len() > 120 {
            return Err("name must contain 1-120 characters".to_owned());
        }
        if self.description.trim().len() > 500 {
            return Err("description must contain at most 500 characters".to_owned());
        }
        if self.tags.len() > 20
            || self
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || tag.trim().len() > 40)
        {
            return Err(
                "tags must contain at most 20 non-empty values of 40 characters".to_owned(),
            );
        }
        if self.params.len() > 32 {
            return Err("params must contain at most 32 values".to_owned());
        }
        if !matches!(self.source.as_str(), "user" | "agent") {
            return Err("source must be user or agent".to_owned());
        }
        validate_spec(&self.spec)?;
        if let Some(preview) = &self.preview_spec {
            validate_spec(preview)?;
        }
        validate_params(&self.params)?;
        Ok(Self {
            name,
            description: self.description.trim().to_owned(),
            tags: self
                .tags
                .into_iter()
                .map(|tag| tag.trim().to_owned())
                .collect(),
            ..self
        })
    }
}

fn validate_params(params: &[Value]) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    for param in params {
        let object = param.as_object().ok_or("each param must be an object")?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or("param name is required")?;
        if !regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_]*$")
            .unwrap()
            .is_match(name)
            || !names.insert(name)
        {
            return Err("param names must be unique and use [a-zA-Z][a-zA-Z0-9_]*".to_owned());
        }
        if !matches!(
            object.get("type").and_then(Value::as_str),
            Some("string" | "number" | "boolean" | "object" | "array")
        ) {
            return Err("param type is invalid".to_owned());
        }
    }
    Ok(())
}

fn validate_spec(spec: &Value) -> Result<(), String> {
    let object = spec.as_object().ok_or("spec must be an object")?;
    let root = object
        .get("root")
        .and_then(Value::as_str)
        .ok_or("spec.root is required")?;
    let elements = object
        .get("elements")
        .and_then(Value::as_object)
        .ok_or("spec.elements is required")?;
    if elements.is_empty() || elements.len() > 100 || !elements.contains_key(root) {
        return Err("spec root must reference one of at most 100 elements".to_owned());
    }
    for (id, element) in elements {
        let element = element
            .as_object()
            .ok_or("each element must be an object")?;
        let kind = element
            .get("type")
            .and_then(Value::as_str)
            .ok_or("element.type is required")?;
        if !COMPONENTS.contains(&kind) {
            return Err(format!("unknown Agent-UI component: {kind}"));
        }
        if !element.get("props").map_or(true, Value::is_object) {
            return Err(format!("element {id} props must be an object"));
        }
        let children = element
            .get("children")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if children.len() > 100 {
            return Err(format!("element {id} has too many children"));
        }
        for child in children {
            let child = child.as_str().ok_or("element children must be strings")?;
            if !elements.contains_key(child) {
                return Err(format!("element {id} references missing child {child}"));
            }
        }
    }
    let mut visiting = std::collections::HashSet::new();
    let mut visited = std::collections::HashSet::new();
    visit_spec(root, elements, &mut visiting, &mut visited)
}

fn visit_spec(
    id: &str,
    elements: &Map<String, Value>,
    visiting: &mut std::collections::HashSet<String>,
    visited: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    if visiting.contains(id) {
        return Err("Agent-UI element children may not contain cycles".to_owned());
    }
    if !visited.insert(id.to_owned()) {
        return Ok(());
    }
    visiting.insert(id.to_owned());
    if let Some(children) = elements[id].get("children").and_then(Value::as_array) {
        for child in children.iter().filter_map(Value::as_str) {
            visit_spec(child, elements, visiting, visited)?;
        }
    }
    visiting.remove(id);
    Ok(())
}

#[derive(Clone)]
pub struct AgentUiTemplateStore {
    conn: Arc<Mutex<Connection>>,
}

impl AgentUiTemplateStore {
    pub fn open_default() -> Result<Self> {
        Self::open(crate::paths::db_path("agent-ui-templates.db"))
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        Self::open_connection(Connection::open_in_memory()?)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        Self::open_connection(Connection::open(path)?)
    }

    fn open_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS agent_ui_templates (
                 id TEXT PRIMARY KEY,
                 json TEXT NOT NULL,
                 owner_user_id TEXT,
                 org_id TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_agent_ui_templates_org ON agent_ui_templates(org_id);",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn list(&self) -> Result<Vec<StoredAgentUiTemplate>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare("SELECT json, owner_user_id, org_id FROM agent_ui_templates ORDER BY updated_at DESC LIMIT ?1")?;
        let rows = statement.query_map([MAX_TEMPLATES], |row| {
            let json: String = row.get(0)?;
            let template = serde_json::from_str(&json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            Ok(StoredAgentUiTemplate {
                template,
                owner_user_id: row.get(1)?,
                org_id: row.get(2)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading Agent-UI templates")
    }

    pub async fn get(&self, id: &str) -> Result<Option<StoredAgentUiTemplate>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT json, owner_user_id, org_id FROM agent_ui_templates WHERE id = ?1",
            [id],
            |row| {
                let json: String = row.get(0)?;
                let template = serde_json::from_str(&json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
                Ok(StoredAgentUiTemplate {
                    template,
                    owner_user_id: row.get(1)?,
                    org_id: row.get(2)?,
                })
            },
        )
        .optional()
        .context("reading Agent-UI template")
    }

    pub async fn insert(&self, record: &StoredAgentUiTemplate) -> Result<()> {
        self.write(record, false).await
    }

    pub async fn update(&self, record: &StoredAgentUiTemplate) -> Result<bool> {
        self.write(record, true).await.map(|_| true)
    }

    async fn write(&self, record: &StoredAgentUiTemplate, update: bool) -> Result<()> {
        let conn = self.conn.lock().await;
        let json = serde_json::to_string(&record.template)?;
        let sql = if update {
            "UPDATE agent_ui_templates SET json = ?2, updated_at = ?3 WHERE id = ?1"
        } else {
            "INSERT INTO agent_ui_templates (id, json, owner_user_id, org_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
        };
        if update {
            conn.execute(
                sql,
                params![record.template.id, json, record.template.updated_at],
            )?;
        } else {
            conn.execute(
                sql,
                params![
                    record.template.id,
                    json,
                    record.owner_user_id,
                    record.org_id,
                    record.template.created_at
                ],
            )?;
        }
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        Ok(conn.execute("DELETE FROM agent_ui_templates WHERE id = ?1", [id])? == 1)
    }
}

pub fn new_template(input: AgentUiTemplateInput, now: String) -> Result<AgentUiTemplate, String> {
    let input = input.validate()?;
    Ok(AgentUiTemplate {
        id: format!("{TEMPLATE_ID_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        name: input.name,
        description: input.description,
        tags: input.tags,
        spec: input.spec,
        params: input.params,
        preview_spec: input.preview_spec,
        source: input.source,
        created_at: now.clone(),
        updated_at: now,
    })
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn accessible(
    record: &StoredAgentUiTemplate,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
) -> crate::identity_verify::Access {
    use crate::identity_verify::{Access, OrgRole};
    if record.template.source == "builtin" {
        return Access::Read;
    }
    if let Some(caller) = caller {
        if record.owner_user_id.as_deref() == Some(caller.user_id.as_str()) {
            return Access::Write;
        }
        if node_org.is_some() && record.org_id.as_deref() == node_org {
            return if caller.role.satisfies(OrgRole::Member) {
                Access::Write
            } else {
                Access::Read
            };
        }
    }
    if node_org.is_none() {
        Access::Write
    } else {
        Access::None
    }
}

async fn permission(
    state: &super::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), Response> {
    super::enforce_permission(state, caller, permission)
        .await
        .map_err(|status| error(status, "forbidden"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// GET /api/agent-ui/templates — list only templates visible to this caller.
pub async fn list(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    let node_org = super::node_org_id();
    match state.agent_ui_templates.list().await {
        Ok(records) => Json(json!({
            "templates": records
                .into_iter()
                .filter(|record| accessible(record, caller.as_ref(), node_org.as_deref())
                    != crate::identity_verify::Access::None)
                .map(|record| record.template)
                .collect::<Vec<_>>()
        }))
        .into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// POST /api/agent-ui/templates — create a user/agent-authored template.
pub async fn create(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(input): Json<AgentUiTemplateInput>,
) -> Response {
    if let Err(response) = permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let node_org = super::node_org_id();
    if node_org.is_some()
        && caller.as_ref().and_then(|value| value.org_id.as_deref()) != node_org.as_deref()
    {
        return error(
            StatusCode::FORBIDDEN,
            "a verified member of this node's organization is required",
        );
    }
    let template = match new_template(input, now()) {
        Ok(template) => template,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let owner_user_id = caller.as_ref().map(|value| value.user_id.clone());
    let record = StoredAgentUiTemplate {
        template: template.clone(),
        owner_user_id,
        org_id: caller.as_ref().and_then(|value| value.org_id.clone()),
    };
    match state.agent_ui_templates.insert(&record).await {
        Ok(()) => (StatusCode::CREATED, Json(template)).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// GET /api/agent-ui/templates/:id — fetch one visible template.
pub async fn get(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        return response;
    }
    match state.agent_ui_templates.get(&id).await {
        Ok(Some(record))
            if accessible(&record, caller.as_ref(), super::node_org_id().as_deref())
                != crate::identity_verify::Access::None =>
        {
            Json(record.template).into_response()
        }
        Ok(Some(_)) => error(StatusCode::FORBIDDEN, "forbidden"),
        Ok(None) => error(StatusCode::NOT_FOUND, "template not found"),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// PATCH /api/agent-ui/templates/:id — replace validated template content.
pub async fn update(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(input): Json<AgentUiTemplateInput>,
) -> Response {
    if let Err(response) = permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(mut record) = (match state.agent_ui_templates.get(&id).await {
        Ok(value) => value,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }) else {
        return error(StatusCode::NOT_FOUND, "template not found");
    };
    if record.template.source == "builtin"
        || accessible(&record, caller.as_ref(), super::node_org_id().as_deref())
            != crate::identity_verify::Access::Write
    {
        return error(StatusCode::FORBIDDEN, "template is not writable");
    }
    let mut replacement = match new_template(input, now()) {
        Ok(value) => value,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    replacement.id = record.template.id.clone();
    replacement.created_at = record.template.created_at.clone();
    record.template = replacement.clone();
    match state.agent_ui_templates.update(&record).await {
        Ok(_) => Json(replacement).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// DELETE /api/agent-ui/templates/:id — delete a user/agent-authored template.
pub async fn delete(
    State(state): State<super::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        return response;
    }
    let Some(record) = (match state.agent_ui_templates.get(&id).await {
        Ok(value) => value,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }) else {
        return error(StatusCode::NOT_FOUND, "template not found");
    };
    if record.template.source == "builtin"
        || accessible(&record, caller.as_ref(), super::node_org_id().as_deref())
            != crate::identity_verify::Access::Write
    {
        return error(StatusCode::FORBIDDEN, "template is not writable");
    }
    match state.agent_ui_templates.delete(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "template not found"),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(spec: Value) -> AgentUiTemplateInput {
        AgentUiTemplateInput {
            name: "Approval".into(),
            description: "".into(),
            tags: vec![],
            spec,
            params: vec![],
            preview_spec: None,
            source: "user".into(),
        }
    }

    fn spec(children: &[&str]) -> Value {
        json!({"root":"root","elements":{"root":{"type":"Card","props":{},"children":children}}})
    }

    #[tokio::test]
    async fn persists_and_updates_a_valid_template() {
        let store = AgentUiTemplateStore::open_in_memory().unwrap();
        let template = new_template(input(spec(&[])), "2026-08-16T00:00:00Z".into()).unwrap();
        let record = StoredAgentUiTemplate {
            template: template.clone(),
            owner_user_id: Some("u1".into()),
            org_id: Some("o1".into()),
        };
        store.insert(&record).await.unwrap();
        assert_eq!(
            store
                .get(&template.id)
                .await
                .unwrap()
                .unwrap()
                .template
                .name,
            "Approval"
        );
        let mut changed = record;
        changed.template.name = "Updated".into();
        changed.template.updated_at = "2026-08-16T00:01:00Z".into();
        store.update(&changed).await.unwrap();
        assert_eq!(
            store
                .get(&template.id)
                .await
                .unwrap()
                .unwrap()
                .template
                .name,
            "Updated"
        );
        assert!(store.delete(&template.id).await.unwrap());
        assert!(store.get(&template.id).await.unwrap().is_none());
    }

    #[test]
    fn rejects_unknown_components_dangling_children_and_cycles() {
        assert!(
            input(json!({"root":"root","elements":{"root":{"type":"NotAComponent"}}}))
                .validate()
                .is_err()
        );
        assert!(input(spec(&["missing"])).validate().is_err());
        assert!(input(json!({"root":"a","elements":{"a":{"type":"Card","children":["b"]},"b":{"type":"Card","children":["a"]}}})).validate().is_err());
    }

    #[test]
    fn accepts_every_frontend_gallery_component() {
        for component in ["OptionList", "Slider", "ApprovalCard", "LinkPreview"] {
            assert!(
                input(json!({"root":"root","elements":{"root":{"type":component,"props":{}}}}))
                    .validate()
                    .is_ok(),
                "Rust allowlist must track frontend component {component}"
            );
        }
    }

    #[test]
    fn rejects_duplicate_or_invalid_parameter_names() {
        let mut value = input(spec(&[]));
        value.params = vec![
            json!({"name":"x","type":"string"}),
            json!({"name":"x","type":"number"}),
        ];
        assert!(value.clone().validate().is_err());
        value.params = vec![json!({"name":"1x","type":"string"})];
        assert!(value.validate().is_err());
    }
}
