//! MCP App metadata projects into the existing native host contributions.
use super::ServerState;
use crate::sidecar::mcp::{
    ui_extensions::{entrypoints, Entrypoint},
    RegistryTool, WIDGET_RENDER_GRANT,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const MAX_ACTIVATION_RECEIPTS: usize = 32;
const MAX_ACTIVATION_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIVATION_CACHE_BYTES: usize = 32 * 1024 * 1024;
const ACTIVATION_RECEIPT_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
struct ActivationReply {
    status: StatusCode,
    bytes: axum::body::Bytes,
}

impl ActivationReply {
    fn error(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            bytes: axum::body::Bytes::from(json!({"error":message}).to_string()),
        }
    }
    fn to_response(&self) -> Response {
        (
            self.status,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            self.bytes.clone(),
        )
            .into_response()
    }
}

struct ActivationReceipt {
    fingerprint: [u8; 32],
    completed_at: Option<Instant>,
    result: watch::Sender<ActivationState>,
}

#[derive(Clone)]
enum ActivationState {
    Pending(Option<String>),
    Complete(Arc<ActivationReply>),
}

#[derive(Default)]
struct ActivationCache {
    receipts: BTreeMap<String, ActivationReceipt>,
}

enum ActivationClaim {
    Start(watch::Receiver<ActivationState>),
    Replay(watch::Receiver<ActivationState>),
}

impl ActivationCache {
    fn claim(
        &mut self,
        key: &str,
        fingerprint: [u8; 32],
        now: Instant,
    ) -> Result<ActivationClaim, ActivationReply> {
        self.receipts.retain(|_, receipt| {
            receipt.completed_at.is_none_or(|completed| {
                now.saturating_duration_since(completed) < ACTIVATION_RECEIPT_TTL
            })
        });
        if let Some(receipt) = self.receipts.get(key) {
            if receipt.fingerprint != fingerprint {
                return Err(ActivationReply::error(
                    StatusCode::CONFLICT,
                    "idempotencyKey is already bound to a different app activation",
                ));
            }
            return Ok(ActivationClaim::Replay(receipt.result.subscribe()));
        }
        let mut reserved_bytes = MAX_ACTIVATION_RESPONSE_BYTES;
        for receipt in self.receipts.values() {
            reserved_bytes += match &*receipt.result.borrow() {
                ActivationState::Pending(_) => MAX_ACTIVATION_RESPONSE_BYTES,
                ActivationState::Complete(reply) => reply.bytes.len(),
            };
        }
        if self.receipts.len() >= MAX_ACTIVATION_RECEIPTS
            || reserved_bytes > MAX_ACTIVATION_CACHE_BYTES
        {
            return Err(ActivationReply::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "App activation recovery cache is full; retry later",
            ));
        }
        let (result, receiver) = watch::channel(ActivationState::Pending(None));
        self.receipts.insert(
            key.to_owned(),
            ActivationReceipt {
                fingerprint,
                completed_at: None,
                result,
            },
        );
        Ok(ActivationClaim::Start(receiver))
    }

    fn complete(&mut self, key: &str, reply: ActivationReply, now: Instant) {
        if let Some(receipt) = self.receipts.get_mut(key) {
            receipt.completed_at = Some(now);
            receipt
                .result
                .send_replace(ActivationState::Complete(Arc::new(reply)));
        }
    }

    fn publish_scope(&mut self, key: &str, conversation_id: Option<String>) {
        if let Some(receipt) = self
            .receipts
            .get_mut(key)
            .filter(|receipt| receipt.completed_at.is_none())
        {
            receipt
                .result
                .send_replace(ActivationState::Pending(conversation_id));
        }
    }
}

fn activation_cache() -> &'static Mutex<ActivationCache> {
    static CACHE: OnceLock<Mutex<ActivationCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ActivationCache::default()))
}

fn activation_key(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    key: uuid::Uuid,
) -> String {
    let principal = caller.map(|caller| (caller.user_id.as_str(), caller.org_id.as_deref()));
    json!([principal, key.to_string()]).to_string()
}

fn canonical_arguments(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let ordered: BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_arguments(value)))
                .collect();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical_arguments).collect()),
        _ => value.clone(),
    }
}

fn activation_fingerprint(body: &OpenAppBody, arguments: &Value) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(
        json!([
            body.tool_id,
            body.agent_id,
            body.conversation_id,
            canonical_arguments(arguments)
        ])
        .to_string()
        .as_bytes(),
    )
    .into()
}

pub fn companion_id(tool_id: &str) -> String {
    format!("mcp__{tool_id}")
}

pub fn projection_owner_ids(
    manifests: &[crate::plugin_manifest::PluginManifest],
    surface: Option<crate::plugin_manifest::Surface>,
) -> HashSet<String> {
    manifests
        .iter()
        .filter(|manifest| surface.is_none_or(|surface| manifest.supports_surface(surface)))
        .map(|manifest| manifest.id.clone())
        .collect()
}

pub async fn append_contributions(
    state: &ServerState,
    projection_owners: &HashSet<String>,
    companions: &mut Vec<Value>,
    sidebar_buttons: &mut Vec<Value>,
    dock_panels: &mut Vec<Value>,
    file_handlers: &mut Vec<Value>,
    settings_tabs: &mut Vec<Value>,
) {
    let records = state.app_store.list().await.unwrap_or_default();
    let tools = state.mcp.list_all_tools().await;
    let mut settings_servers = std::collections::HashSet::new();
    for tool in &tools {
        let owner_id = state
            .mcp
            .plugin_server_owner(&tool.server)
            .unwrap_or_else(|| tool.server.clone());
        if !projection_owners.contains(&owner_id) {
            continue;
        }
        let Some(record) = records
            .iter()
            .find(|record| record.id == owner_id && record.enabled)
        else {
            continue;
        };
        if settings_servers.insert(tool.server.clone()) {
            let settings = tool
                .meta
                .as_ref()
                .and_then(|meta| meta.get("ryu/serverExtensions"))
                .and_then(|capabilities| {
                    capabilities
                        .get("extensions")
                        .and_then(|v| v.get("openai/settings"))
                        .or_else(|| {
                            capabilities
                                .get("experimental")
                                .and_then(|v| v.get("openai/settings"))
                        })
                });
            if let Some(settings) = settings {
                if let (Some(read), Some(update)) = (
                    settings.get("readTool").and_then(Value::as_str),
                    settings.get("updateTool").and_then(Value::as_str),
                ) {
                    let read_id = format!("{}.{}", tool.server, read);
                    let update_id = format!("{}.{}", tool.server, update);
                    if tools
                        .iter()
                        .any(|peer| peer.id == read_id && peer.server == tool.server)
                        && tools
                            .iter()
                            .any(|peer| peer.id == update_id && peer.server == tool.server)
                    {
                        settings_tabs.push(json!({"id":"mcp-settings","title":"Settings","scope":"user","plugin":owner_id,"mcpSettings":{"serverId":tool.server,"readTool":read_id,"updateTool":update_id}}));
                    }
                }
            }
        }
        let points = entrypoints(tool.meta.as_ref());
        if points.is_empty() {
            continue;
        }
        if !record
            .approved_grants
            .iter()
            .any(|grant| grant == WIDGET_RENDER_GRANT)
        {
            continue;
        }
        if !matches!(
            state.mcp.resolve_widget_promotion(&tool.id).await,
            crate::sidecar::mcp::WidgetPromotion::Allow(_)
        ) {
            continue;
        }
        project(
            tool,
            &owner_id,
            &record.approved_grants,
            &points,
            companions,
            sidebar_buttons,
            dock_panels,
            file_handlers,
        );
    }
}

fn project(
    tool: &RegistryTool,
    owner_id: &str,
    grants: &[String],
    points: &[Entrypoint],
    companions: &mut Vec<Value>,
    buttons: &mut Vec<Value>,
    panels: &mut Vec<Value>,
    files: &mut Vec<Value>,
) {
    let id = companion_id(&tool.id);
    let title = tool
        .annotations
        .as_ref()
        .and_then(|a| a.get("title"))
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&tool.name);
    companions.push(json!({"id":id,"name":title,"label":title,"plugin_id":owner_id,"approved_grants":grants,"has_ui":true,"navigationVisible":points.contains(&Entrypoint::Global),"default_csp_enforced":true,"mcpToolId":tool.id}));
    for point in points {
        match point {
            Entrypoint::Global => buttons.push(json!({"id":id,"title":title,"plugin":owner_id,"target":format!("/plugin/{}", url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>())})),
            Entrypoint::Thread => panels.push(json!({"id":id,"title":title,"plugin":owner_id,"placement":"right","panel":"companion","spec":{"companion":id}})),
            Entrypoint::File { extensions } => files.push(json!({"id":id,"title":title,"plugin":owner_id,"extensions":extensions,"companion":id,"editable":true,"priority":0})),
        }
    }
}

#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenAppBody {
    tool_id: String,
    agent_id: String,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    arguments: Option<Value>,
    /// UUID identifying this activation attempt. Matching retries recover the
    /// same response for 30 minutes while this Core process remains running.
    idempotency_key: String,
}

#[utoipa::path(post, path="/api/widgets/open", tag="Widgets", request_body=inline(OpenAppBody),
    responses((status=200, description="Opened app and minted host instance", body=Value),
              (status=202, description="Activation pending; retry the identical body and UUID to recover its state",body=Value),
              (status=403, description="App, agent, or conversation access denied"),
              (status=400, description="Invalid entrypoint, UUID, or arguments"),
              (status=409, description="Conflicting activation retry"),
              (status=503, description="Bounded activation recovery cache full")))]
pub async fn open_app(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(resolved): Extension<super::ResolvedAuthorization>,
    Json(mut body): Json<OpenAppBody>,
) -> Response {
    if !super::signed_agent_binding_allows(resolved.bindings.agent_id.as_deref(), &body.agent_id) {
        return super::json_error(
            StatusCode::FORBIDDEN,
            "agent differs from signed binding".to_owned(),
        );
    }
    if body.tool_id.is_empty()
        || body.tool_id.len() > 512
        || body.agent_id.is_empty()
        || body.agent_id.len() > 256
    {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "toolId and agentId are required".into(),
        );
    }
    let idempotency_key = match uuid::Uuid::parse_str(&body.idempotency_key) {
        Ok(key) if !key.is_nil() => key,
        _ => {
            return super::json_error(
                StatusCode::BAD_REQUEST,
                "idempotencyKey must be a non-nil UUID".into(),
            );
        }
    };
    let tools = state.mcp.list_all_tools().await;
    let Some(tool) = tools.iter().find(|tool| tool.id == body.tool_id) else {
        return super::json_error(StatusCode::NOT_FOUND, "MCP App is unavailable".into());
    };
    if crate::sidecar::mcp::ui_extensions::resource_uri(tool.meta.as_ref()).is_none() {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "Tool has no registered MCP App entrypoint".into(),
        );
    }
    let records = state.app_store.list().await.unwrap_or_default();
    let owner_id = state
        .mcp
        .plugin_server_owner(&tool.server)
        .unwrap_or_else(|| tool.server.clone());
    if !records.iter().any(|record| {
        record.id == owner_id
            && record.enabled
            && record
                .approved_grants
                .iter()
                .any(|grant| grant == WIDGET_RENDER_GRANT)
    }) || !matches!(
        state.mcp.resolve_widget_promotion(&tool.id).await,
        crate::sidecar::mcp::WidgetPromotion::Allow(_)
    ) {
        return super::json_error(
            StatusCode::FORBIDDEN,
            "MCP App requires an enabled plugin with approved widget rendering".into(),
        );
    }
    let arguments = body.arguments.clone().unwrap_or_else(|| json!({}));
    if !arguments.is_object()
        || serde_json::to_vec(&arguments).map_or(true, |bytes| bytes.len() > 65536)
    {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "App arguments must be a bounded object".into(),
        );
    }
    if let Err(response) = super::enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
        &body.agent_id,
    )
    .await
    {
        return response;
    }
    if !crate::fleet::is_agent_available(&body.agent_id) {
        return super::json_error(
            StatusCode::FORBIDDEN,
            "Agent is unavailable under organization policy".into(),
        );
    }
    let agent_record = match state.agent_store.get(&body.agent_id).await {
        Ok(record) => record,
        Err(_) => {
            return super::json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Agent lookup unavailable".into(),
            );
        }
    };
    if !super::mcp_principal_resolves(
        &body.agent_id,
        agent_record.is_some(),
        state.agents.entries.iter().map(|entry| entry.id.as_str()),
    ) {
        return super::json_error(StatusCode::FORBIDDEN, "Unknown agent".into());
    }
    body.conversation_id = body.conversation_id.filter(|id| !id.trim().is_empty());
    body.conversation_id = match super::authorize_tool_host_conversation(
        &state,
        caller.as_ref(),
        body.conversation_id.as_deref(),
        None,
    )
    .await
    {
        Ok(scope) => scope,
        Err((status, message)) => return super::json_error(status, message),
    };
    let create_conversation =
        body.conversation_id.is_none() && !entrypoints(tool.meta.as_ref()).is_empty();
    let title = tool
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(&tool.name)
        .chars()
        .take(256)
        .collect::<String>();
    let fingerprint = activation_fingerprint(&body, &arguments);
    let key = activation_key(caller.as_ref(), idempotency_key);
    let claim = match activation_cache().lock() {
        Ok(mut cache) => cache.claim(&key, fingerprint, Instant::now()),
        Err(_) => Err(ActivationReply::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "App activation recovery is unavailable",
        )),
    };
    let receiver = match claim {
        Err(reply) => return reply.to_response(),
        Ok(ActivationClaim::Replay(receiver)) => receiver,
        Ok(ActivationClaim::Start(receiver)) => {
            // The operation owns its task. Losing the initiating HTTP response
            // cannot cancel it and cause a retry to mint a second thread/call.
            tokio::spawn(async move {
                let operation_key = key.clone();
                let mut operation = tokio::spawn(async move {
                    activate_app(
                        state,
                        caller,
                        resolved.bindings.agent_id,
                        body,
                        arguments,
                        create_conversation,
                        title,
                        operation_key,
                    )
                    .await
                });
                let reply = match tokio::time::timeout(Duration::from_secs(15 * 60), &mut operation)
                    .await
                {
                    Ok(Ok(response)) => {
                        let status = response.status();
                        match axum::body::to_bytes(
                            response.into_body(),
                            MAX_ACTIVATION_RESPONSE_BYTES,
                        )
                        .await
                        {
                            Ok(bytes) => ActivationReply { status, bytes },
                            Err(_) => ActivationReply::error(
                                StatusCode::BAD_GATEWAY,
                                "App activation response exceeds the recovery limit",
                            ),
                        }
                    }
                    Ok(Err(_)) => ActivationReply::error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "App activation was interrupted",
                    ),
                    Err(_) => {
                        operation.abort();
                        ActivationReply::error(
                            StatusCode::GATEWAY_TIMEOUT,
                            "App activation timed out; its outcome may be unknown",
                        )
                    }
                };
                if let Ok(mut cache) = activation_cache().lock() {
                    cache.complete(&key, reply, Instant::now());
                }
            });
            receiver
        }
    };
    let state = receiver.borrow().clone();
    match state {
        ActivationState::Complete(reply) => reply.to_response(),
        ActivationState::Pending(conversation_id) => {
            let mut pending =
                json!({"status":"pending","idempotencyKey":idempotency_key.to_string()});
            if let Some(conversation_id) = conversation_id {
                pending["conversationId"] = json!(conversation_id);
            }
            (StatusCode::ACCEPTED, Json(pending)).into_response()
        }
    }
}

async fn ensure_app_conversation(
    store: &super::conversations::ConversationStore,
    conversation_id: &str,
    agent_id: &str,
    title: &str,
    tenancy: super::conversations::Tenancy,
) -> anyhow::Result<()> {
    store
        .ensure_conversation(conversation_id, Some(agent_id), Some(title), tenancy)
        .await
}

async fn activate_app(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    bound_agent_id: Option<String>,
    mut body: OpenAppBody,
    arguments: Value,
    create_conversation: bool,
    title: String,
    activation_key: String,
) -> Response {
    if create_conversation {
        let id = uuid::Uuid::new_v4().to_string();
        if let Err(error) = ensure_app_conversation(
            &state.conversations,
            &id,
            &body.agent_id,
            &title,
            super::caller_tenancy(&caller),
        )
        .await
        {
            tracing::error!(error = %error,"MCP App conversation creation failed");
            return super::json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to create the app conversation".into(),
            );
        }
        body.conversation_id = Some(id);
    }
    let conversation_id = body.conversation_id.clone();
    if let Ok(mut cache) = activation_cache().lock() {
        cache.publish_scope(&activation_key, conversation_id.clone());
    }
    let agent_id = body.agent_id.clone();
    let response = super::call_mcp_tool_inner(
        state.clone(),
        caller,
        bound_agent_id,
        super::CallToolBody {
            tool: body.tool_id.clone(),
            arguments: arguments.clone(),
            agent_id: Some(body.agent_id),
            user_id: None,
            host_conversation_id: body.conversation_id,
            host_conversation_proof: None,
            profile_composio_connection_scope: None,
            profile_conversation_scope: None,
            mcp_allowlist: None,
            identity_profile_ids: None,
            mcp_policy_snapshot: false,
            untrusted_caller: false,
        },
    )
    .await;
    if !response.status().is_success() {
        return response;
    }
    let bytes = match axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return super::json_error(
                StatusCode::BAD_GATEWAY,
                "App result exceeds the host limit".into(),
            );
        }
    };
    let envelope: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return super::json_error(StatusCode::BAD_GATEWAY, "Invalid app tool result".into());
        }
    };
    let Some(result) = envelope.get("output") else {
        return super::json_error(
            StatusCode::BAD_GATEWAY,
            "App tool returned no result".into(),
        );
    };
    if result.get("__ryu_elicitation__").is_some() {
        return super::json_error(
            StatusCode::CONFLICT,
            "Connect the plugin account or resolve its pending approval before opening this app"
                .into(),
        );
    }
    let Some(event) = crate::sidecar::adapters::mcp_bridge::build_widget_event(
        &state.mcp,
        &body.tool_id,
        &arguments,
        result,
        None,
        conversation_id.clone(),
        agent_id,
    )
    .await
    else {
        return super::json_error(
            StatusCode::CONFLICT,
            "App UI is unavailable or too many app instances are open".into(),
        );
    };
    Json(json!({"type":"data-tool-widget-available","data":{
        "toolCallId":event.tool_call_id,"toolName":event.tool_name,"instanceId":event.instance_id,"serverId":event.server_id,"templateUri":event.template_uri,
        "widget":{"html":event.widget_html,"mimeType":event.widget_mime,"csp":{"resource_domains":event.resource_domains}},
        "toolInput":event.tool_input,"toolOutput":event.tool_output,"toolResponseMetadata":event.tool_response_metadata,
        "widgetAccessible":event.widget_accessible,"approvedGrants":event.approved_grants,"initialWidgetState":event.initial_widget_state,"displayMode":"inline","conversationId":conversation_id
    }})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_owners_follow_the_native_surface_contract() {
        use crate::plugin_manifest::{PluginManifest, Surface};
        let parse = |id: &str, declaration: Value| {
            let mut value = json!({"id":id,"name":"Example","version":"1.0.0","runnables":[]});
            value
                .as_object_mut()
                .unwrap()
                .extend(declaration.as_object().unwrap().clone());
            PluginManifest::parse_and_validate(&value.to_string()).unwrap()
        };
        let manifests = vec![
            parse("com.example.cli", json!({"targets":["cli"]})),
            parse("com.example.desktop", json!({"targets":["desktop"]})),
            parse("com.example.legacy", json!({"targets":[]})),
            parse(
                "com.example.modern",
                json!({"targets":["desktop"],"surfaces":{"cli":{"support":"full"}}}),
            ),
        ];
        assert_eq!(
            projection_owner_ids(&manifests, Some(Surface::Desktop)),
            HashSet::from([
                "com.example.desktop".to_owned(),
                "com.example.legacy".to_owned()
            ])
        );
        assert_eq!(
            projection_owner_ids(&manifests, Some(Surface::Cli)),
            HashSet::from([
                "com.example.cli".to_owned(),
                "com.example.legacy".to_owned(),
                "com.example.modern".to_owned()
            ])
        );
        assert_eq!(
            projection_owner_ids(&manifests, None).len(),
            manifests.len()
        );
    }
    #[test]
    fn projects_each_entrypoint_to_the_existing_host_contract() {
        let mut tool = RegistryTool::candidate("demo.open", "demo", "open");
        tool.annotations = Some(json!({"title":"Parts"}));
        let (mut companions, mut buttons, mut panels, mut files) = (vec![], vec![], vec![], vec![]);
        project(
            &tool,
            "demo",
            &[WIDGET_RENDER_GRANT.into()],
            &[
                Entrypoint::Global,
                Entrypoint::Thread,
                Entrypoint::File {
                    extensions: vec!["stl".into()],
                },
            ],
            &mut companions,
            &mut buttons,
            &mut panels,
            &mut files,
        );
        assert_eq!(companions[0]["mcpToolId"], "demo.open");
        assert_eq!(companions[0]["navigationVisible"], true);
        assert_eq!(buttons[0]["target"], "/plugin/mcp__demo.open");
        assert_eq!(panels[0]["spec"]["companion"], companions[0]["id"]);
        assert_eq!(files[0]["extensions"], json!(["stl"]));
    }
    #[test]
    fn contextual_entrypoints_keep_routes_without_global_navigation() {
        let tool = RegistryTool::candidate("demo.editor", "demo", "editor");
        let (mut companions, mut buttons, mut panels, mut files) = (vec![], vec![], vec![], vec![]);
        project(
            &tool,
            "demo",
            &[WIDGET_RENDER_GRANT.into()],
            &[
                Entrypoint::Thread,
                Entrypoint::File {
                    extensions: vec!["stl".into()],
                },
            ],
            &mut companions,
            &mut buttons,
            &mut panels,
            &mut files,
        );
        assert_eq!(companions.len(), 1);
        assert_eq!(companions[0]["navigationVisible"], false);
        assert!(buttons.is_empty());
        assert_eq!(panels[0]["spec"]["companion"], companions[0]["id"]);
        assert_eq!(files[0]["companion"], companions[0]["id"]);
    }
    #[tokio::test]
    async fn concurrent_retries_share_one_activation_and_survive_lost_response() {
        let mut cache = ActivationCache::default();
        let now = Instant::now();
        let first = cache
            .claim("principal:key", [1; 32], now)
            .unwrap_or_else(|_| panic!("initial claim"));
        let second = cache
            .claim("principal:key", [1; 32], now)
            .unwrap_or_else(|_| panic!("same request retry"));
        let ActivationClaim::Start(first) = first else {
            panic!("first claim must start");
        };
        let ActivationClaim::Replay(mut second) = second else {
            panic!("concurrent retry must wait");
        };
        drop(first); // HTTP initiator disconnected; the operation still owns its receipt.
        cache.complete(
            "principal:key",
            ActivationReply::error(StatusCode::OK, "completed"),
            now,
        );
        second.changed().await.unwrap();
        let ActivationState::Complete(reply) = second.borrow().clone() else {
            panic!("completed receipt");
        };
        assert_eq!(reply.status, StatusCode::OK);
        assert!(matches!(
            cache.claim("principal:key", [1; 32], now),
            Ok(ActivationClaim::Replay(_))
        ));
        assert_eq!(cache.receipts.len(), 1);
    }
    #[tokio::test]
    async fn simultaneous_claims_start_exactly_one_operation() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Arc::new(Mutex::new(ActivationCache::default()));
        let starts = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let cache = cache.clone();
            let starts = starts.clone();
            tasks.push(tokio::spawn(async move {
                let claim = cache
                    .lock()
                    .unwrap()
                    .claim("same-activation", [1; 32], Instant::now())
                    .unwrap_or_else(|_| panic!("claim"));
                let mut receiver = match claim {
                    ActivationClaim::Start(receiver) => {
                        starts.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        cache.lock().unwrap().complete(
                            "same-activation",
                            ActivationReply::error(StatusCode::OK, "done"),
                            Instant::now(),
                        );
                        receiver
                    }
                    ActivationClaim::Replay(receiver) => receiver,
                };
                loop {
                    if matches!(&*receiver.borrow(), ActivationState::Complete(_)) {
                        break;
                    }
                    receiver.changed().await.unwrap();
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(cache.lock().unwrap().receipts.len(), 1);
    }
    #[test]
    fn conflicting_requests_and_capacity_limits_fail_before_start() {
        let now = Instant::now();
        let mut cache = ActivationCache::default();
        assert!(matches!(
            cache.claim("same", [1; 32], now),
            Ok(ActivationClaim::Start(_))
        ));
        assert!(
            matches!(cache.claim("same",[2;32],now),Err(reply) if reply.status==StatusCode::CONFLICT)
        );
        for index in 1..(MAX_ACTIVATION_CACHE_BYTES / MAX_ACTIVATION_RESPONSE_BYTES) {
            assert!(cache
                .claim(&format!("pending-{index}"), [1; 32], now)
                .is_ok());
        }
        assert!(
            matches!(cache.claim("over-budget",[1;32],now),Err(reply) if reply.status==StatusCode::SERVICE_UNAVAILABLE)
        );
        cache.complete("same", ActivationReply::error(StatusCode::OK, "done"), now);
        // A completed receipt retains its nonempty replay response. Releasing
        // one maximum reservation therefore does not fit another full one.
        assert!(
            matches!(cache.claim("still-over-budget",[1;32],now),Err(reply) if reply.status==StatusCode::SERVICE_UNAVAILABLE)
        );
        cache.complete(
            "pending-1",
            ActivationReply::error(StatusCode::OK, "done"),
            now,
        );
        assert!(cache.claim("room-after-completion", [1; 32], now).is_ok());
    }
    #[test]
    fn expiry_never_evicts_a_running_operation_and_principals_are_distinct() {
        let now = Instant::now();
        let mut cache = ActivationCache::default();
        cache
            .claim("pending", [1; 32], now)
            .unwrap_or_else(|_| panic!("claim"));
        cache
            .claim("done", [1; 32], now)
            .unwrap_or_else(|_| panic!("claim"));
        cache.complete("done", ActivationReply::error(StatusCode::OK, "done"), now);
        cache
            .claim(
                "new",
                [1; 32],
                now + ACTIVATION_RECEIPT_TTL + Duration::from_secs(1),
            )
            .unwrap_or_else(|_| panic!("claim"));
        assert!(cache.receipts.contains_key("pending"));
        assert!(!cache.receipts.contains_key("done"));
        let key = uuid::Uuid::new_v4();
        let caller = crate::identity_verify::VerifiedCaller {
            user_id: "alice".into(),
            org_id: Some("org".into()),
            email: None,
            email_verified: false,
            role: crate::identity_verify::OrgRole::Admin,
            teams: Vec::new(),
        };
        assert_ne!(
            activation_key(Some(&caller), key),
            activation_key(None, key)
        );
    }
    #[test]
    fn pending_thread_scope_is_recovered_before_tool_completion() {
        let mut cache = ActivationCache::default();
        let now = Instant::now();
        cache
            .claim("activation", [1; 32], now)
            .unwrap_or_else(|_| panic!("claim"));
        cache.publish_scope("activation", Some("owned-thread".into()));
        let ActivationClaim::Replay(receiver) = cache
            .claim("activation", [1; 32], now)
            .unwrap_or_else(|_| panic!("claim"))
        else {
            panic!("retry");
        };
        assert!(
            matches!(&*receiver.borrow(),ActivationState::Pending(Some(conversation)) if conversation=="owned-thread")
        );
        assert!(cache.receipts["activation"].completed_at.is_none());
    }
    #[test]
    fn activation_fingerprint_ignores_object_order_but_binds_request_scope() {
        let body = OpenAppBody {
            tool_id: "demo.open".into(),
            agent_id: "agent-one".into(),
            conversation_id: None,
            arguments: None,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
        };
        assert_eq!(
            activation_fingerprint(&body, &json!({"nested":{"b":2,"a":1}})),
            activation_fingerprint(&body, &json!({"nested":{"a":1,"b":2}}))
        );
        let mut changed = body.clone();
        changed.conversation_id = Some("different-thread".into());
        assert_ne!(
            activation_fingerprint(&body, &json!({})),
            activation_fingerprint(&changed, &json!({}))
        );
    }
    #[tokio::test]
    async fn static_activation_creates_an_empty_owned_thread_with_the_selected_agent() {
        use super::super::conversations::{ConversationStore, Tenancy};
        let store = ConversationStore::open_in_memory().unwrap();
        ensure_app_conversation(
            &store,
            "app-thread",
            "agent-one",
            "Parts",
            Tenancy::Owned {
                user_id: "alice".into(),
                org_id: Some("org".into()),
            },
        )
        .await
        .unwrap();
        let summary = store.get_summary("app-thread").await.unwrap().unwrap();
        assert_eq!(summary.agent_id.as_deref(), Some("agent-one"));
        assert!(store.get_messages("app-thread").await.unwrap().is_empty());
        let scope = store.get_access_meta("app-thread").await.unwrap().unwrap();
        assert_eq!(scope.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(scope.org_id.as_deref(), Some("org"));
    }
}
