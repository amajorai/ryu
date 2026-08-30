use std::{collections::BTreeSet, convert::Infallible, sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{SecondsFormat, Utc};
use ryu_a2a::{
    discover_agent_card, outbound_task_record_id,
    protocol::{
        errors::error_code as codes, methods, AgentCapabilities, AgentCard, AgentInterface,
        AgentSkill, Artifact, AuthenticationInfo, CancelTaskRequest,
        DeleteTaskPushNotificationConfigRequest, GetExtendedAgentCardRequest,
        GetTaskPushNotificationConfigRequest, GetTaskRequest, HttpAuthSecurityScheme, JsonRpcError,
        JsonRpcId, JsonRpcRequest, JsonRpcResponse, ListTaskPushNotificationConfigsRequest,
        ListTaskPushNotificationConfigsResponse, ListTasksRequest, ListTasksResponse, Message,
        Part, Role, SecurityScheme, SendMessageRequest, SendMessageResponse, StreamResponse,
        SubscribeToTaskRequest, Task, TaskArtifactUpdateEvent, TaskPushNotificationConfig,
        TaskState as ProtocolTaskState, TaskStatusUpdateEvent, TRANSPORT_PROTOCOL_HTTP_JSON,
        TRANSPORT_PROTOCOL_JSONRPC, VERSION,
    },
    select_endpoint, validate_endpoint, validate_push_authentication, A2aClient, A2aPeer,
    A2aPrincipal, A2aScope, A2aServerConfig, ClientLimits, EndpointPolicy, IssuedPrincipalToken,
    PeerCredential, PeerTrust, PeerUpsert, PublishedAgent, PublishedAgentUpsert, PushConfigInput,
    StoreError, TaskCreate, TaskDirection, TaskState,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::runtime::{message_to_untrusted_prompt, runtime, A2aRuntime, AgentRunEvent};
use crate::server::ServerState;

const DEFAULT_TENANT: &str = "default";
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_A2A_HOPS: u64 = 5;

pub fn public_routes() -> Router<ServerState> {
    Router::new()
        .route("/.well-known/agent-card.json", get(agent_card))
        .route("/a2a", post(json_rpc))
        // A2A uses literal colon operation suffixes (`message:send`,
        // `{id}:cancel`). Axum 0.7's matcher treats every colon as the start of a
        // parameter, even in the middle of a segment, so registering those paths
        // directly conflicts. A nested fallback dispatches the official paths
        // exactly as received and keeps the workaround local to `/a2a`.
        .nest("/a2a", Router::new().fallback(rest_dispatch))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

async fn rest_dispatch(State(state): State<ServerState>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    if let Err(error) = ensure_protocol_version(&parts.headers) {
        return error.into_response();
    }
    let path = parts
        .uri
        .path()
        .strip_prefix("/a2a")
        .unwrap_or_else(|| parts.uri.path())
        .trim_start_matches('/');
    let segments = path.split('/').collect::<Vec<_>>();
    match (parts.method, segments.as_slice()) {
        (Method::POST, ["message:send"]) => {
            match decode_rest_body::<SendMessageRequest>(body).await {
                Ok(request) => rest_send_message(State(state), parts.headers, Json(request)).await,
                Err(response) => response,
            }
        }
        (Method::POST, ["message:stream"]) => {
            match decode_rest_body::<SendMessageRequest>(body).await {
                Ok(request) => {
                    rest_send_streaming_message(State(state), parts.headers, Json(request)).await
                }
                Err(response) => response,
            }
        }
        (Method::GET, ["tasks"]) => match decode_rest_query::<ListTasksRequest>(&parts.uri) {
            Ok(request) => rest_list_tasks(parts.headers, Query(request)).await,
            Err(response) => response,
        },
        (Method::GET, ["tasks", task_id]) => {
            let Some(task_id) = decode_path_value(task_id) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<RestGetTaskQuery>(&parts.uri) {
                Ok(query) => rest_get_task(parts.headers, Path(task_id), Query(query)).await,
                Err(response) => response,
            }
        }
        (Method::POST, ["tasks", operation]) if operation.ends_with(":cancel") => {
            let Some(task_id) = operation
                .strip_suffix(":cancel")
                .and_then(decode_path_value)
            else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<TenantQuery>(&parts.uri) {
                Ok(query) => rest_cancel_task(parts.headers, Path(task_id), Query(query)).await,
                Err(response) => response,
            }
        }
        (Method::POST, ["tasks", operation]) if operation.ends_with(":subscribe") => {
            let Some(task_id) = operation
                .strip_suffix(":subscribe")
                .and_then(decode_path_value)
            else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<TenantQuery>(&parts.uri) {
                Ok(query) => rest_subscribe_task(parts.headers, Path(task_id), Query(query)).await,
                Err(response) => response,
            }
        }
        (Method::POST, ["tasks", task_id, "pushNotificationConfigs"]) => {
            let Some(task_id) = decode_path_value(task_id) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_body::<TaskPushNotificationConfig>(body).await {
                Ok(config) => {
                    rest_create_push_config(parts.headers, Path(task_id), Json(config)).await
                }
                Err(response) => response,
            }
        }
        (Method::GET, ["tasks", task_id, "pushNotificationConfigs"]) => {
            let Some(task_id) = decode_path_value(task_id) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<RestListPushQuery>(&parts.uri) {
                Ok(query) => {
                    rest_list_push_configs(parts.headers, Path(task_id), Query(query)).await
                }
                Err(response) => response,
            }
        }
        (Method::GET, ["tasks", task_id, "pushNotificationConfigs", config_id]) => {
            let (Some(task_id), Some(config_id)) =
                (decode_path_value(task_id), decode_path_value(config_id))
            else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<TenantQuery>(&parts.uri) {
                Ok(query) => {
                    rest_get_push_config(parts.headers, Path((task_id, config_id)), Query(query))
                        .await
                }
                Err(response) => response,
            }
        }
        (Method::DELETE, ["tasks", task_id, "pushNotificationConfigs", config_id]) => {
            let (Some(task_id), Some(config_id)) =
                (decode_path_value(task_id), decode_path_value(config_id))
            else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match decode_rest_query::<TenantQuery>(&parts.uri) {
                Ok(query) => {
                    rest_delete_push_config(parts.headers, Path((task_id, config_id)), Query(query))
                        .await
                }
                Err(response) => response,
            }
        }
        (Method::GET, ["extendedAgentCard"]) => {
            match decode_rest_query::<TenantQuery>(&parts.uri) {
                Ok(query) => rest_extended_agent_card(parts.headers, Query(query)).await,
                Err(response) => response,
            }
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn decode_rest_body<T: DeserializeOwned>(body: Body) -> Result<T, Response> {
    let bytes = to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE.into_response())?;
    serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST.into_response())
}

fn decode_rest_query<T: DeserializeOwned>(uri: &Uri) -> Result<T, Response> {
    Query::<T>::try_from_uri(uri)
        .map(|Query(query)| query)
        .map_err(|_| StatusCode::BAD_REQUEST.into_response())
}

fn decode_path_value(value: &str) -> Option<String> {
    urlencoding::decode(value)
        .ok()
        .map(|value| value.into_owned())
}

pub fn management_routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/a2a/settings",
            get(management_get_settings).put(management_put_settings),
        )
        .route(
            "/api/a2a/peers",
            get(management_list_peers).post(management_upsert_peer),
        )
        .route(
            "/api/a2a/peers/:id",
            put(management_update_peer).delete(management_delete_peer),
        )
        .route("/api/a2a/peers/:id/trust", put(management_set_peer_trust))
        .route("/api/a2a/discover", post(management_discover_peer))
        .route("/api/a2a/call", post(management_call_peer))
        .route(
            "/api/a2a/principals",
            get(management_list_principals).post(management_issue_principal),
        )
        .route(
            "/api/a2a/principals/:id",
            delete(management_revoke_principal),
        )
        .route(
            "/api/a2a/published-agents",
            get(management_list_published_agents).post(management_upsert_published_agent),
        )
        .route(
            "/api/a2a/published-agents/:id",
            delete(management_delete_published_agent),
        )
        .route("/api/a2a/tasks", get(management_list_tasks))
        .route("/api/a2a/tasks/:id", get(management_get_task))
        .route("/api/a2a/tasks/:id/cancel", post(management_cancel_task))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

async fn agent_card() -> Response {
    match build_agent_card(false).await {
        Ok(card) => ([(header::CACHE_CONTROL, "no-store")], Json(card)).into_response(),
        Err(ApiError::Disabled) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => error.into_response(),
    }
}

async fn build_agent_card(extended: bool) -> Result<AgentCard, ApiError> {
    let runtime = runtime().map_err(ApiError::internal)?;
    let config = runtime.store.server_config(DEFAULT_TENANT)?;
    if !config.enabled {
        return Err(ApiError::Disabled);
    }
    if extended && !config.expose_extended_card {
        return Err(ApiError::Protocol {
            code: codes::EXTENDED_CARD_NOT_CONFIGURED,
            message: "Extended Agent Card is not configured".to_owned(),
            status: StatusCode::NOT_FOUND,
        });
    }
    let published = runtime.store.list_published_agents(DEFAULT_TENANT, true)?;
    let mut skills = published
        .iter()
        .flat_map(|agent| agent.skills.clone())
        .collect::<Vec<_>>();
    // SDK Actions are published as A2A skills for discovery. A2A still hands
    // natural-language work to the published agent; it does not become a second
    // direct Action executor. The descriptor source is the same activated
    // manifest/tool registry used by `/api/actions/*` and MCP discovery.
    if let Some(state) = crate::learning::global_state() {
        skills.extend(
            state
                .mcp
                .action_descriptors()
                .await
                .into_iter()
                .map(|action| AgentSkill {
                    id: format!("{}/{}", action.plugin_id, action.action_id),
                    name: action.name,
                    description: action.description,
                    tags: vec![
                        "ryu".to_owned(),
                        "action".to_owned(),
                        action.effect.to_owned(),
                    ],
                    examples: None,
                    input_modes: Some(vec!["application/json".to_owned()]),
                    output_modes: Some(vec!["application/json".to_owned()]),
                    security_requirements: None,
                }),
        );
    }
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    skills.dedup_by(|left, right| left.id == right.id);
    let base_url = config
        .public_base_url
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(7980)));
    let endpoint = format!("{}/a2a", base_url.trim_end_matches('/'));
    let interfaces = vec![
        AgentInterface {
            url: endpoint.clone(),
            protocol_binding: TRANSPORT_PROTOCOL_JSONRPC.to_owned(),
            protocol_version: VERSION.to_owned(),
            tenant: Some(DEFAULT_TENANT.to_owned()),
        },
        AgentInterface {
            url: endpoint,
            protocol_binding: TRANSPORT_PROTOCOL_HTTP_JSON.to_owned(),
            protocol_version: VERSION.to_owned(),
            tenant: Some(DEFAULT_TENANT.to_owned()),
        },
    ];
    Ok(AgentCard {
        name: config.display_name,
        description: config.description,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        supported_interfaces: interfaces,
        capabilities: AgentCapabilities {
            streaming: Some(true),
            push_notifications: Some(true),
            extensions: None,
            extended_agent_card: Some(config.expose_extended_card),
        },
        default_input_modes: vec!["text/plain".to_owned(), "application/json".to_owned()],
        default_output_modes: vec!["text/plain".to_owned(), "application/json".to_owned()],
        skills,
        provider: None,
        documentation_url: Some("https://docs.ryuhq.com/docs/extend/integrate/a2a".to_owned()),
        icon_url: None,
        security_schemes: Some(std::collections::HashMap::from([(
            "bearer".to_owned(),
            SecurityScheme::HttpAuth(HttpAuthSecurityScheme {
                scheme: "bearer".to_owned(),
                description: Some("Per-peer Ryu A2A token".to_owned()),
                bearer_format: Some("opaque".to_owned()),
            }),
        )])),
        security_requirements: Some(vec![std::collections::HashMap::from([(
            "bearer".to_owned(),
            Vec::new(),
        )])]),
        signatures: None,
    })
}

async fn json_rpc(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<JsonRpcRequest>,
) -> Response {
    if let Err(error) = ensure_protocol_version(&headers) {
        return rpc_error_response(request.id, error);
    }
    if request.jsonrpc != "2.0" {
        return rpc_error_response(
            request.id,
            ApiError::rpc(codes::INVALID_REQUEST, "JSON-RPC version must be 2.0"),
        );
    }
    match request.method.as_str() {
        methods::SEND_STREAMING_MESSAGE => {
            let params = match rpc_params::<SendMessageRequest>(&request) {
                Ok(params) => params,
                Err(error) => return rpc_error_response(request.id, error),
            };
            match start_inbound_task(&state, &headers, params, A2aScope::Send).await {
                Ok(prepared) => stream_response(prepared, Some(request.id)),
                Err(error) => rpc_error_response(request.id, error),
            }
        }
        methods::SUBSCRIBE_TO_TASK => {
            let params = match rpc_params::<SubscribeToTaskRequest>(&request) {
                Ok(params) => params,
                Err(error) => return rpc_error_response(request.id, error),
            };
            match subscribe_inbound(&headers, &params).await {
                Ok(prepared) => stream_response(prepared, Some(request.id)),
                Err(error) => rpc_error_response(request.id, error),
            }
        }
        method => {
            let result = dispatch_rpc_non_stream(&state, &headers, method, request.params).await;
            match result {
                Ok(value) => Json(JsonRpcResponse::success(request.id, value)).into_response(),
                Err(error) => rpc_error_response(request.id, error),
            }
        }
    }
}

fn ensure_protocol_version(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(version) = headers.get("a2a-version") else {
        return Ok(());
    };
    if version.to_str().ok() == Some(VERSION) {
        return Ok(());
    }
    Err(ApiError::Protocol {
        code: codes::VERSION_NOT_SUPPORTED,
        message: format!("Only A2A protocol version {VERSION} is supported"),
        status: StatusCode::BAD_REQUEST,
    })
}

async fn dispatch_rpc_non_stream(
    state: &ServerState,
    headers: &HeaderMap,
    method: &str,
    params: Option<Value>,
) -> Result<Value, ApiError> {
    match method {
        methods::SEND_MESSAGE => {
            let request: SendMessageRequest = decode_params(params)?;
            let return_immediately = request
                .configuration
                .as_ref()
                .and_then(|configuration| configuration.return_immediately)
                .unwrap_or(false);
            let prepared = start_inbound_task(state, headers, request, A2aScope::Send).await?;
            let task = if return_immediately {
                load_protocol_task(
                    &prepared.runtime,
                    &prepared.tenant_id,
                    &prepared.owner_id,
                    &prepared.task_id,
                )?
            } else {
                await_terminal(prepared).await?
            };
            serde_json::to_value(SendMessageResponse::Task(task)).map_err(ApiError::internal)
        }
        methods::GET_TASK => {
            let request: GetTaskRequest = decode_params(params)?;
            serde_json::to_value(get_task_for(headers, &request, A2aScope::Read)?)
                .map_err(ApiError::internal)
        }
        methods::LIST_TASKS => {
            let request: ListTasksRequest = decode_params(params)?;
            serde_json::to_value(list_tasks_for(headers, &request)?).map_err(ApiError::internal)
        }
        methods::CANCEL_TASK => {
            let request: CancelTaskRequest = decode_params(params)?;
            serde_json::to_value(cancel_task_for(headers, &request)?).map_err(ApiError::internal)
        }
        methods::CREATE_PUSH_CONFIG => {
            let request: TaskPushNotificationConfig = decode_params(params)?;
            serde_json::to_value(create_push_config_for(headers, request)?)
                .map_err(ApiError::internal)
        }
        methods::GET_PUSH_CONFIG => {
            let request: GetTaskPushNotificationConfigRequest = decode_params(params)?;
            serde_json::to_value(get_push_config_for(headers, &request)?)
                .map_err(ApiError::internal)
        }
        methods::LIST_PUSH_CONFIGS => {
            let request: ListTaskPushNotificationConfigsRequest = decode_params(params)?;
            serde_json::to_value(list_push_configs_for(headers, &request)?)
                .map_err(ApiError::internal)
        }
        methods::DELETE_PUSH_CONFIG => {
            let request: DeleteTaskPushNotificationConfigRequest = decode_params(params)?;
            delete_push_config_for(headers, &request)?;
            Ok(json!({}))
        }
        methods::GET_EXTENDED_AGENT_CARD => {
            let request: GetExtendedAgentCardRequest = decode_params(params)?;
            let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
            authenticate(headers, tenant, A2aScope::ExtendedCard)?;
            serde_json::to_value(build_agent_card(true).await?).map_err(ApiError::internal)
        }
        _ => Err(ApiError::rpc(
            codes::METHOD_NOT_FOUND,
            "A2A method not found",
        )),
    }
}

fn rpc_params<T: DeserializeOwned>(request: &JsonRpcRequest) -> Result<T, ApiError> {
    decode_params(request.params.clone())
}

fn decode_params<T: DeserializeOwned>(params: Option<Value>) -> Result<T, ApiError> {
    serde_json::from_value(params.unwrap_or_else(|| json!({})))
        .map_err(|_| ApiError::rpc(codes::INVALID_PARAMS, "Invalid A2A method parameters"))
}

fn rpc_error_response(id: JsonRpcId, error: ApiError) -> Response {
    let rpc = error.rpc_error();
    (error.status(), Json(JsonRpcResponse::error(id, rpc))).into_response()
}

struct PreparedTask {
    runtime: Arc<A2aRuntime>,
    tenant_id: String,
    owner_id: String,
    task_id: String,
    context_id: String,
    events: broadcast::Receiver<AgentRunEvent>,
}

async fn start_inbound_task(
    state: &ServerState,
    headers: &HeaderMap,
    mut request: SendMessageRequest,
    scope: A2aScope,
) -> Result<PreparedTask, ApiError> {
    let tenant_id = request
        .tenant
        .as_deref()
        .unwrap_or(DEFAULT_TENANT)
        .to_owned();
    let runtime = runtime().map_err(ApiError::internal)?;
    ensure_enabled(&runtime, &tenant_id)?;
    let configured_limit = runtime.store.server_config(&tenant_id)?.max_payload_bytes;
    let request_size = serde_json::to_vec(&request)
        .map_err(ApiError::internal)?
        .len() as u64;
    if request_size > configured_limit {
        return Err(ApiError::bad_request(
            "A2A request exceeds the configured payload limit",
        ));
    }
    if let Some(push) = request
        .configuration
        .as_ref()
        .and_then(|configuration| configuration.task_push_notification_config.as_ref())
    {
        validate_push_config_input(push)?;
    }
    let principal = authenticate_with(&runtime, headers, &tenant_id, scope)?;
    runtime
        .check_rate_limit(&principal.id)
        .map_err(|_| ApiError::rate_limited())?;
    let hop_count = request
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("ryuHopCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if hop_count >= MAX_A2A_HOPS {
        return Err(ApiError::bad_request("A2A hop limit exceeded"));
    }
    let prompt = message_to_untrusted_prompt(&request.message, &principal.name)
        .map_err(|_| ApiError::bad_request("A2A message is not accepted"))?;
    let requested_task_id = request
        .message
        .task_id
        .clone()
        .filter(|value| !value.is_empty());
    let (task_id, context_id, published) = if let Some(task_id) = requested_task_id {
        let existing = runtime
            .store
            .get_task_owned(&tenant_id, &principal.id, &task_id)?;
        if !matches!(
            existing.state,
            TaskState::InputRequired | TaskState::AuthRequired
        ) {
            return Err(ApiError::conflict(
                "Only a task waiting for input or authentication can be continued",
            ));
        }
        if request
            .message
            .context_id
            .as_deref()
            .is_some_and(|context| context != existing.context_id)
        {
            return Err(ApiError::bad_request(
                "The continuation context does not match the task",
            ));
        }
        let agent_id = existing
            .local_agent_id
            .as_deref()
            .ok_or_else(|| ApiError::conflict("The task has no published local agent"))?;
        let published = runtime
            .store
            .list_published_agents(&tenant_id, true)?
            .into_iter()
            .find(|published| published.agent_id == agent_id)
            .ok_or_else(|| ApiError::conflict("The task's published agent is unavailable"))?;
        let mut task: Task =
            serde_json::from_value(existing.protocol_task).map_err(ApiError::internal)?;
        request.message.context_id = Some(existing.context_id.clone());
        request.message.task_id = Some(task_id.clone());
        task.history
            .get_or_insert_with(Vec::new)
            .push(request.message.clone());
        task.status = ryu_a2a::protocol::TaskStatus {
            state: ProtocolTaskState::Working,
            message: None,
            timestamp: Some(Utc::now()),
        };
        let task_value = serde_json::to_value(&task).map_err(ApiError::internal)?;
        runtime.store.transition_task(
            &tenant_id,
            &principal.id,
            &task_id,
            TaskState::Working,
            &task_value,
        )?;
        (task_id, existing.context_id, published)
    } else {
        let published = select_published_agent(&runtime, &tenant_id, request.metadata.as_ref())?;
        let context_id = request
            .message
            .context_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let task_id = Uuid::new_v4().to_string();
        request.message.context_id = Some(context_id.clone());
        request.message.task_id = Some(task_id.clone());
        let task = Task {
            id: task_id.clone(),
            context_id: context_id.clone(),
            status: ryu_a2a::protocol::TaskStatus {
                state: ProtocolTaskState::Submitted,
                message: None,
                timestamp: Some(Utc::now()),
            },
            artifacts: None,
            history: Some(vec![request.message.clone()]),
            metadata: Some(std::collections::HashMap::from([
                (
                    "ryuAgentId".to_owned(),
                    Value::String(published.agent_id.clone()),
                ),
                ("ryuHopCount".to_owned(), Value::from(hop_count + 1)),
            ])),
        };
        runtime.store.create_task(TaskCreate {
            id: task_id.clone(),
            context_id: context_id.clone(),
            tenant_id: tenant_id.clone(),
            owner_id: principal.id.clone(),
            peer_id: None,
            local_agent_id: Some(published.agent_id.clone()),
            direction: TaskDirection::Inbound,
            state: TaskState::Submitted,
            protocol_task: serde_json::to_value(&task).map_err(ApiError::internal)?,
        })?;
        (task_id, context_id, published)
    };
    runtime.store.append_task_item(
        &tenant_id,
        &principal.id,
        &task_id,
        &request.message.message_id,
        ryu_a2a::TaskItemKind::Message,
        &serde_json::to_value(&request.message).map_err(ApiError::internal)?,
    )?;

    if let Some(configuration) = request.configuration {
        if let Some(mut push) = configuration.task_push_notification_config {
            push.task_id = task_id.clone();
            create_push_config_owned(&runtime, &tenant_id, &principal.id, push)?;
        }
    }
    let conversation_id = conversation_key(&tenant_id, &principal.id, &context_id);
    let events = runtime
        .start_agent_task(
            state.clone(),
            task_id.clone(),
            tenant_id.clone(),
            principal.id.clone(),
            conversation_id,
            published.agent_id,
            principal.name,
            prompt,
        )
        .map_err(ApiError::internal)?;
    Ok(PreparedTask {
        runtime,
        tenant_id,
        owner_id: principal.id,
        task_id,
        context_id,
        events,
    })
}

async fn subscribe_inbound(
    headers: &HeaderMap,
    request: &SubscribeToTaskRequest,
) -> Result<PreparedTask, ApiError> {
    let tenant_id = request
        .tenant
        .as_deref()
        .unwrap_or(DEFAULT_TENANT)
        .to_owned();
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, &tenant_id, A2aScope::Subscribe)?;
    let record = runtime
        .store
        .get_task_owned(&tenant_id, &principal.id, &request.id)?;
    if record.state.is_terminal() {
        return Err(ApiError::conflict("Terminal tasks cannot be subscribed"));
    }
    let events = runtime
        .subscribe(&request.id)
        .ok_or_else(|| ApiError::conflict("Task is not actively running"))?;
    Ok(PreparedTask {
        runtime,
        tenant_id,
        owner_id: principal.id,
        task_id: request.id.clone(),
        context_id: record.context_id,
        events,
    })
}

async fn await_terminal(mut prepared: PreparedTask) -> Result<Task, ApiError> {
    let wait = async {
        loop {
            match prepared.events.recv().await {
                Ok(AgentRunEvent::Completed | AgentRunEvent::Canceled | AgentRunEvent::Failed) => {
                    break;
                }
                Ok(AgentRunEvent::Started | AgentRunEvent::TextDelta(_)) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(300), wait)
        .await
        .map_err(|_| ApiError::gateway_timeout())?;
    load_protocol_task(
        &prepared.runtime,
        &prepared.tenant_id,
        &prepared.owner_id,
        &prepared.task_id,
    )
}

fn stream_response(prepared: PreparedTask, rpc_id: Option<JsonRpcId>) -> Response {
    let stream = async_stream::stream! {
        let mut prepared = prepared;
        let initial = load_protocol_task(
            &prepared.runtime,
            &prepared.tenant_id,
            &prepared.owner_id,
            &prepared.task_id,
        );
        let initial_terminal = initial
            .as_ref()
            .is_ok_and(|task| task.status.state.is_terminal());
        let value = stream_envelope(initial.map(StreamResponse::Task), rpc_id.clone());
        yield Ok::<Bytes, Infallible>(Bytes::from(format!("data: {value}\n\n")));
        if initial_terminal {
            return;
        }
        loop {
            let event = match prepared.events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let terminal = matches!(
                &event,
                AgentRunEvent::Completed | AgentRunEvent::Canceled | AgentRunEvent::Failed
            );
            if matches!(event, AgentRunEvent::Started) {
                continue;
            }
            let response = match event {
                AgentRunEvent::TextDelta(delta) => Ok(StreamResponse::ArtifactUpdate(
                    TaskArtifactUpdateEvent {
                        task_id: prepared.task_id.clone(),
                        context_id: prepared.context_id.clone(),
                        artifact: Artifact {
                            artifact_id: format!("{}-reply", prepared.task_id),
                            name: Some("Agent reply".to_owned()),
                            description: None,
                            parts: vec![Part::text(delta)],
                            metadata: None,
                            extensions: None,
                        },
                        append: Some(true),
                        last_chunk: Some(false),
                        metadata: None,
                    },
                )),
                AgentRunEvent::Completed | AgentRunEvent::Canceled | AgentRunEvent::Failed => {
                    load_protocol_task(
                        &prepared.runtime,
                        &prepared.tenant_id,
                        &prepared.owner_id,
                        &prepared.task_id,
                    ).map(|task| StreamResponse::StatusUpdate(TaskStatusUpdateEvent {
                        task_id: task.id,
                        context_id: task.context_id,
                        status: task.status,
                        metadata: None,
                    }))
                }
                AgentRunEvent::Started => unreachable!("started events are skipped"),
            };
            let value = stream_envelope(response, rpc_id.clone());
            yield Ok::<Bytes, Infallible>(Bytes::from(format!("data: {value}\n\n")));
            if terminal {
                break;
            }
        }
    };
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn stream_envelope(response: Result<StreamResponse, ApiError>, rpc_id: Option<JsonRpcId>) -> Value {
    let value =
        response.and_then(|response| serde_json::to_value(response).map_err(ApiError::internal));
    match (value, rpc_id) {
        (Ok(value), Some(id)) => serde_json::to_value(JsonRpcResponse::success(id, value))
            .unwrap_or_else(|_| json!({"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}})),
        (Ok(value), None) => value,
        (Err(error), Some(id)) => serde_json::to_value(JsonRpcResponse::error(id, error.rpc_error()))
            .unwrap_or_else(|_| json!({"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}})),
        (Err(error), None) => json!({"error": error.public_message()}),
    }
}

async fn rest_send_message(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<SendMessageRequest>,
) -> Response {
    let return_immediately = request
        .configuration
        .as_ref()
        .and_then(|configuration| configuration.return_immediately)
        .unwrap_or(false);
    match start_inbound_task(&state, &headers, request, A2aScope::Send).await {
        Ok(prepared) if return_immediately => match load_protocol_task(
            &prepared.runtime,
            &prepared.tenant_id,
            &prepared.owner_id,
            &prepared.task_id,
        ) {
            Ok(task) => Json(SendMessageResponse::Task(task)).into_response(),
            Err(error) => error.into_response(),
        },
        Ok(prepared) => match await_terminal(prepared).await {
            Ok(task) => Json(SendMessageResponse::Task(task)).into_response(),
            Err(error) => error.into_response(),
        },
        Err(error) => error.into_response(),
    }
}

async fn rest_send_streaming_message(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<SendMessageRequest>,
) -> Response {
    match start_inbound_task(&state, &headers, request, A2aScope::Send).await {
        Ok(prepared) => stream_response(prepared, None),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestGetTaskQuery {
    history_length: Option<i32>,
    tenant: Option<String>,
}

async fn rest_get_task(
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<RestGetTaskQuery>,
) -> Response {
    let request = GetTaskRequest {
        id,
        history_length: query.history_length,
        tenant: query.tenant,
    };
    match get_task_for(&headers, &request, A2aScope::Read) {
        Ok(task) => Json(task).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn rest_list_tasks(headers: HeaderMap, Query(request): Query<ListTasksRequest>) -> Response {
    match list_tasks_for(&headers, &request) {
        Ok(tasks) => Json(tasks).into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
struct TenantQuery {
    tenant: Option<String>,
}

async fn rest_cancel_task(
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<TenantQuery>,
) -> Response {
    let request = CancelTaskRequest {
        id,
        metadata: None,
        tenant: query.tenant,
    };
    match cancel_task_for(&headers, &request) {
        Ok(task) => Json(task).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn rest_subscribe_task(
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<TenantQuery>,
) -> Response {
    let request = SubscribeToTaskRequest {
        id,
        tenant: query.tenant,
    };
    match subscribe_inbound(&headers, &request).await {
        Ok(prepared) => stream_response(prepared, None),
        Err(error) => error.into_response(),
    }
}

async fn rest_create_push_config(
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(mut request): Json<TaskPushNotificationConfig>,
) -> Response {
    request.task_id = id;
    match create_push_config_for(&headers, request) {
        Ok(config) => (StatusCode::CREATED, Json(config)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn rest_get_push_config(
    headers: HeaderMap,
    Path((id, config_id)): Path<(String, String)>,
    Query(query): Query<TenantQuery>,
) -> Response {
    let request = GetTaskPushNotificationConfigRequest {
        task_id: id,
        id: config_id,
        tenant: query.tenant,
    };
    match get_push_config_for(&headers, &request) {
        Ok(config) => Json(config).into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestListPushQuery {
    page_size: Option<i32>,
    page_token: Option<String>,
    tenant: Option<String>,
}

async fn rest_list_push_configs(
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<RestListPushQuery>,
) -> Response {
    let request = ListTaskPushNotificationConfigsRequest {
        task_id: id,
        page_size: query.page_size,
        page_token: query.page_token,
        tenant: query.tenant,
    };
    match list_push_configs_for(&headers, &request) {
        Ok(configs) => Json(configs).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn rest_delete_push_config(
    headers: HeaderMap,
    Path((id, config_id)): Path<(String, String)>,
    Query(query): Query<TenantQuery>,
) -> Response {
    let request = DeleteTaskPushNotificationConfigRequest {
        task_id: id,
        id: config_id,
        tenant: query.tenant,
    };
    match delete_push_config_for(&headers, &request) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}

async fn rest_extended_agent_card(
    headers: HeaderMap,
    Query(query): Query<TenantQuery>,
) -> Response {
    let tenant = query.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    if let Err(error) = authenticate(&headers, tenant, A2aScope::ExtendedCard) {
        return error.into_response();
    }
    match build_agent_card(true).await {
        Ok(card) => Json(card).into_response(),
        Err(error) => error.into_response(),
    }
}

fn get_task_for(
    headers: &HeaderMap,
    request: &GetTaskRequest,
    scope: A2aScope,
) -> Result<Task, ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, scope)?;
    let mut task = load_protocol_task(&runtime, tenant, &principal.id, &request.id)?;
    apply_history_length(&mut task, request.history_length);
    Ok(task)
}

fn list_tasks_for(
    headers: &HeaderMap,
    request: &ListTasksRequest,
) -> Result<ListTasksResponse, ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, A2aScope::Read)?;
    let page_size = request.page_size.unwrap_or(50).clamp(1, 200) as u32;
    let offset = decode_page_token(request.page_token.as_deref())?;
    let state = request.status.as_ref().map(protocol_state_to_store);
    let updated_after = request
        .status_timestamp_after
        .as_ref()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true));
    let total_size = runtime.store.count_tasks_owned(
        tenant,
        &principal.id,
        request.context_id.as_deref(),
        state,
        updated_after.as_deref(),
    )?;
    let records = runtime.store.list_tasks_owned(
        tenant,
        &principal.id,
        request.context_id.as_deref(),
        state,
        updated_after.as_deref(),
        page_size,
        offset,
    )?;
    let mut tasks = records
        .into_iter()
        .map(|record| {
            serde_json::from_value::<Task>(record.protocol_task).map_err(ApiError::internal)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for task in &mut tasks {
        apply_history_length(task, request.history_length);
        if request.include_artifacts == Some(false) {
            task.artifacts = None;
        }
    }
    let next_offset = offset.saturating_add(tasks.len() as u32);
    let next_page_token = if next_offset < total_size {
        next_offset.to_string()
    } else {
        String::new()
    };
    Ok(ListTasksResponse {
        total_size: i32::try_from(total_size).unwrap_or(i32::MAX),
        page_size: i32::try_from(tasks.len()).unwrap_or(i32::MAX),
        next_page_token,
        tasks,
    })
}

fn cancel_task_for(headers: &HeaderMap, request: &CancelTaskRequest) -> Result<Task, ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, A2aScope::Cancel)?;
    let current = runtime
        .store
        .get_task_owned(tenant, &principal.id, &request.id)?;
    if current.state.is_terminal() {
        return serde_json::from_value(current.protocol_task).map_err(ApiError::internal);
    }
    if !runtime.cancel(&request.id) {
        return Err(ApiError::Protocol {
            code: codes::TASK_NOT_CANCELABLE,
            message: "Task is not cancelable".to_owned(),
            status: StatusCode::CONFLICT,
        });
    }
    let mut task: Task =
        serde_json::from_value(current.protocol_task).map_err(ApiError::internal)?;
    task.status = ryu_a2a::protocol::TaskStatus {
        state: ProtocolTaskState::Canceled,
        message: None,
        timestamp: Some(Utc::now()),
    };
    runtime.store.transition_task(
        tenant,
        &principal.id,
        &request.id,
        TaskState::Canceled,
        &serde_json::to_value(&task).map_err(ApiError::internal)?,
    )?;
    Ok(task)
}

fn create_push_config_for(
    headers: &HeaderMap,
    config: TaskPushNotificationConfig,
) -> Result<TaskPushNotificationConfig, ApiError> {
    let tenant = config
        .tenant
        .clone()
        .unwrap_or_else(|| DEFAULT_TENANT.to_owned());
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, &tenant, A2aScope::PushConfig)?;
    create_push_config_owned(&runtime, &tenant, &principal.id, config)
}

fn create_push_config_owned(
    runtime: &A2aRuntime,
    tenant: &str,
    owner_id: &str,
    mut config: TaskPushNotificationConfig,
) -> Result<TaskPushNotificationConfig, ApiError> {
    validate_push_config_input(&config)?;
    let id = config
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let authentication = config
        .authentication
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(ApiError::internal)?;
    runtime.store.upsert_push_config(
        tenant,
        owner_id,
        &config.task_id,
        PushConfigInput {
            id: id.clone(),
            callback_url: config.url.clone(),
            token: config.token.take(),
            authentication,
        },
        outbound_policy(),
    )?;
    config.id = Some(id);
    config.token = None;
    if let Some(authentication) = config.authentication.as_mut() {
        authentication.credentials = None;
    }
    Ok(config)
}

fn validate_push_config_input(config: &TaskPushNotificationConfig) -> Result<(), ApiError> {
    validate_endpoint(&config.url, outbound_policy())
        .map_err(|_| ApiError::bad_request("Push callback URL is invalid"))?;
    validate_push_authentication(config.authentication.as_ref())
        .map_err(|_| ApiError::bad_request("Push authentication is invalid"))?;
    if config
        .id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256)
    {
        return Err(ApiError::bad_request(
            "Push configuration ID must contain 1 to 256 bytes",
        ));
    }
    if config
        .token
        .as_ref()
        .is_some_and(|token| token.len() > 4_096)
    {
        return Err(ApiError::bad_request(
            "Push notification token exceeds 4096 bytes",
        ));
    }
    Ok(())
}

fn get_push_config_for(
    headers: &HeaderMap,
    request: &GetTaskPushNotificationConfigRequest,
) -> Result<TaskPushNotificationConfig, ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, A2aScope::PushConfig)?;
    let summary = runtime
        .store
        .list_push_configs(tenant, &principal.id, &request.task_id)?
        .into_iter()
        .find(|config| config.id == request.id)
        .ok_or(ApiError::not_found())?;
    Ok(push_summary_to_protocol(summary, tenant))
}

fn list_push_configs_for(
    headers: &HeaderMap,
    request: &ListTaskPushNotificationConfigsRequest,
) -> Result<ListTaskPushNotificationConfigsResponse, ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, A2aScope::PushConfig)?;
    let mut configs = runtime
        .store
        .list_push_configs(tenant, &principal.id, &request.task_id)?;
    let offset = decode_page_token(request.page_token.as_deref())? as usize;
    let page_size = request.page_size.unwrap_or(50).clamp(1, 200) as usize;
    let next = offset.saturating_add(page_size);
    let has_more = configs.len() > next;
    let configs = configs
        .drain(offset.min(configs.len())..configs.len().min(next))
        .map(|summary| push_summary_to_protocol(summary, tenant))
        .collect();
    Ok(ListTaskPushNotificationConfigsResponse {
        configs,
        next_page_token: has_more.then(|| next.to_string()),
    })
}

fn delete_push_config_for(
    headers: &HeaderMap,
    request: &DeleteTaskPushNotificationConfigRequest,
) -> Result<(), ApiError> {
    let tenant = request.tenant.as_deref().unwrap_or(DEFAULT_TENANT);
    let runtime = runtime().map_err(ApiError::internal)?;
    let principal = authenticate_with(&runtime, headers, tenant, A2aScope::PushConfig)?;
    runtime
        .store
        .delete_push_config(tenant, &principal.id, &request.task_id, &request.id)?;
    Ok(())
}

async fn management_get_settings() -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.server_config(DEFAULT_TENANT)?)
    })())
}

async fn management_put_settings(Json(config): Json<A2aServerConfig>) -> Response {
    management_result((|| {
        if config.tenant_id != DEFAULT_TENANT {
            return Err(ApiError::bad_request(
                "Only the default tenant is configurable",
            ));
        }
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.save_server_config(config, local_policy())?)
    })())
}

async fn management_list_peers() -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.list_peers(DEFAULT_TENANT)?)
    })())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerBody {
    id: Option<String>,
    name: String,
    agent_card_url: String,
    agent_card: Option<Value>,
    credential: Option<PeerCredential>,
    #[serde(default = "default_true")]
    enabled: bool,
}

async fn management_upsert_peer(Json(body): Json<PeerBody>) -> Response {
    management_result(save_peer(body, None))
}

async fn management_update_peer(Path(id): Path<String>, Json(body): Json<PeerBody>) -> Response {
    management_result(save_peer(body, Some(id)))
}

fn save_peer(body: PeerBody, path_id: Option<String>) -> Result<A2aPeer, ApiError> {
    if let (Some(body_id), Some(path_id)) = (&body.id, &path_id) {
        if body_id != path_id {
            return Err(ApiError::bad_request("Peer ID does not match route"));
        }
    }
    let runtime = runtime().map_err(ApiError::internal)?;
    Ok(runtime.store.upsert_peer(
        PeerUpsert {
            id: path_id.or(body.id),
            tenant_id: DEFAULT_TENANT.to_owned(),
            name: body.name,
            agent_card_url: body.agent_card_url,
            agent_card: body.agent_card,
            credential: body.credential,
            enabled: body.enabled,
        },
        local_policy(),
    )?)
}

async fn management_delete_peer(Path(id): Path<String>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        runtime.store.delete_peer(DEFAULT_TENANT, &id)?;
        Ok(json!({"deleted": true}))
    })())
}

#[derive(Deserialize)]
struct TrustBody {
    trust: PeerTrust,
}

async fn management_set_peer_trust(
    Path(id): Path<String>,
    Json(body): Json<TrustBody>,
) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime
            .store
            .set_peer_trust(DEFAULT_TENANT, &id, body.trust)?)
    })())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverBody {
    url: String,
    name: Option<String>,
    credential: Option<PeerCredential>,
}

async fn management_discover_peer(Json(body): Json<DiscoverBody>) -> Response {
    let result = async {
        let card = discover_agent_card(&body.url, local_policy(), ClientLimits::default())
            .await
            .map_err(ApiError::bad_gateway)?;
        let runtime = runtime().map_err(ApiError::internal)?;
        let peer = runtime.store.upsert_peer(
            PeerUpsert {
                id: None,
                tenant_id: DEFAULT_TENANT.to_owned(),
                name: body.name.unwrap_or_else(|| card.name.clone()),
                agent_card_url: body.url,
                agent_card: Some(serde_json::to_value(card).map_err(ApiError::internal)?),
                credential: body.credential,
                enabled: true,
            },
            local_policy(),
        )?;
        Ok(peer)
    }
    .await;
    management_result(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboundCallBody {
    peer_id: String,
    message: String,
    context_id: Option<String>,
}

async fn management_call_peer(Json(body): Json<OutboundCallBody>) -> Response {
    let result = async {
        if body.message.trim().is_empty() || body.message.len() > 1024 * 1024 {
            return Err(ApiError::bad_request(
                "Message must contain 1 byte to 1 MiB",
            ));
        }
        let runtime = runtime().map_err(ApiError::internal)?;
        let resolved = runtime
            .store
            .resolve_peer_for_transport(DEFAULT_TENANT, &body.peer_id)?;
        let card_value = resolved
            .peer
            .agent_card
            .ok_or_else(|| ApiError::conflict("Discover the peer before calling it"))?;
        let card: AgentCard = serde_json::from_value(card_value).map_err(ApiError::internal)?;
        let endpoint =
            select_endpoint(&card, local_policy(), &[]).map_err(ApiError::bad_gateway)?;
        let client = A2aClient::new(
            endpoint,
            resolved.credential,
            local_policy(),
            ClientLimits::default(),
        );
        let mut message = Message::new(Role::User, vec![Part::text(body.message)]);
        message.context_id = body.context_id;
        let response = client
            .send_message(&SendMessageRequest {
                message,
                configuration: None,
                metadata: Some(std::collections::HashMap::from([(
                    "ryuHopCount".to_owned(),
                    Value::from(1),
                )])),
                tenant: None,
            })
            .await
            .map_err(ApiError::bad_gateway)?;
        persist_outbound_response(&runtime, &body.peer_id, &response)?;
        Ok(response)
    }
    .await;
    management_result(result)
}

fn persist_outbound_response(
    runtime: &A2aRuntime,
    peer_id: &str,
    response: &SendMessageResponse,
) -> Result<(), ApiError> {
    let SendMessageResponse::Task(task) = response else {
        return Ok(());
    };
    let state = protocol_state_to_store(&task.status.state);
    let value = serde_json::to_value(task).map_err(ApiError::internal)?;
    let record_id = outbound_task_record_id(peer_id, &task.id);
    match runtime.store.create_task(TaskCreate {
        id: record_id.clone(),
        context_id: task.context_id.clone(),
        tenant_id: DEFAULT_TENANT.to_owned(),
        owner_id: "local".to_owned(),
        peer_id: Some(peer_id.to_owned()),
        local_agent_id: None,
        direction: TaskDirection::Outbound,
        state,
        protocol_task: value.clone(),
    }) {
        Ok(_) => Ok(()),
        Err(StoreError::Conflict(_)) => {
            runtime
                .store
                .transition_task(DEFAULT_TENANT, "local", &record_id, state, &value)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

async fn management_list_principals() -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.list_principals(DEFAULT_TENANT)?)
    })())
}

#[derive(Deserialize)]
struct PrincipalBody {
    name: String,
    scopes: BTreeSet<A2aScope>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssuedTokenResponse {
    principal: A2aPrincipal,
    token: String,
}

async fn management_issue_principal(Json(body): Json<PrincipalBody>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        let IssuedPrincipalToken { principal, token } =
            runtime
                .store
                .issue_principal_token(DEFAULT_TENANT, &body.name, body.scopes)?;
        Ok(IssuedTokenResponse { principal, token })
    })())
}

async fn management_revoke_principal(Path(id): Path<String>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        runtime.store.revoke_principal(DEFAULT_TENANT, &id)?;
        Ok(json!({"revoked": true}))
    })())
}

async fn management_list_published_agents() -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.list_published_agents(DEFAULT_TENANT, false)?)
    })())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedAgentBody {
    id: Option<String>,
    agent_id: String,
    name: String,
    description: String,
    #[serde(default)]
    skills: Vec<ryu_a2a::protocol::AgentSkill>,
    #[serde(default = "default_true")]
    enabled: bool,
}

async fn management_upsert_published_agent(Json(body): Json<PublishedAgentBody>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.upsert_published_agent(PublishedAgentUpsert {
            id: body.id,
            tenant_id: DEFAULT_TENANT.to_owned(),
            agent_id: body.agent_id,
            name: body.name,
            description: body.description,
            skills: body.skills,
            enabled: body.enabled,
        })?)
    })())
}

async fn management_delete_published_agent(Path(id): Path<String>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        runtime.store.delete_published_agent(DEFAULT_TENANT, &id)?;
        Ok(json!({"deleted": true}))
    })())
}

async fn management_list_tasks() -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime
            .store
            .list_tasks_for_tenant(DEFAULT_TENANT, 200, 0)?)
    })())
}

async fn management_get_task(Path(id): Path<String>) -> Response {
    management_result((|| {
        let runtime = runtime().map_err(ApiError::internal)?;
        Ok(runtime.store.get_task_for_tenant(DEFAULT_TENANT, &id)?)
    })())
}

async fn management_cancel_task(Path(id): Path<String>) -> Response {
    let result = async {
        let runtime = runtime().map_err(ApiError::internal)?;
        let record = runtime.store.get_task_for_tenant(DEFAULT_TENANT, &id)?;
        if record.state.is_terminal() {
            return Ok(json!({
                "cancelRequested": false,
                "state": record.state,
            }));
        }
        match record.direction {
            TaskDirection::Inbound => {
                if !runtime.cancel(&record.id) {
                    return Err(ApiError::conflict("Task is not actively running"));
                }
            }
            TaskDirection::Outbound => {
                let peer_id = record
                    .peer_id
                    .as_deref()
                    .ok_or_else(|| ApiError::conflict("Outbound task has no peer"))?;
                let remote_task_id = record
                    .protocol_task
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::conflict("Outbound task has no remote task ID"))?;
                let resolved = runtime
                    .store
                    .resolve_peer_for_transport(DEFAULT_TENANT, peer_id)?;
                let card: AgentCard =
                    serde_json::from_value(resolved.peer.agent_card.ok_or_else(|| {
                        ApiError::conflict("Discover the peer before calling it")
                    })?)
                    .map_err(ApiError::internal)?;
                let endpoint = select_endpoint(&card, outbound_policy(), &[])
                    .map_err(ApiError::bad_gateway)?;
                let tenant = endpoint.tenant.clone();
                let client = A2aClient::new(
                    endpoint,
                    resolved.credential,
                    outbound_policy(),
                    ClientLimits::default(),
                );
                let task = client
                    .cancel_task(&CancelTaskRequest {
                        id: remote_task_id.to_owned(),
                        metadata: None,
                        tenant,
                    })
                    .await
                    .map_err(ApiError::bad_gateway)?;
                persist_outbound_response(&runtime, peer_id, &SendMessageResponse::Task(task))?;
            }
        }
        Ok(json!({"cancelRequested": true}))
    }
    .await;
    management_result(result)
}

fn authenticate(
    headers: &HeaderMap,
    tenant: &str,
    scope: A2aScope,
) -> Result<A2aPrincipal, ApiError> {
    let runtime = runtime().map_err(ApiError::internal)?;
    authenticate_with(&runtime, headers, tenant, scope)
}

fn authenticate_with(
    runtime: &A2aRuntime,
    headers: &HeaderMap,
    tenant: &str,
    scope: A2aScope,
) -> Result<A2aPrincipal, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    runtime
        .store
        .authenticate_principal(tenant, token, scope)
        .map_err(|_| ApiError::unauthorized())
}

fn ensure_enabled(runtime: &A2aRuntime, tenant: &str) -> Result<(), ApiError> {
    if runtime.store.server_config(tenant)?.enabled {
        Ok(())
    } else {
        Err(ApiError::Disabled)
    }
}

fn select_published_agent(
    runtime: &A2aRuntime,
    tenant: &str,
    metadata: Option<&std::collections::HashMap<String, Value>>,
) -> Result<PublishedAgent, ApiError> {
    let published = runtime.store.list_published_agents(tenant, true)?;
    if published.is_empty() {
        return Err(ApiError::conflict("No local agents are published over A2A"));
    }
    let requested = metadata
        .and_then(|metadata| metadata.get("ryuAgentId"))
        .and_then(Value::as_str);
    match requested {
        Some(requested) => published
            .into_iter()
            .find(|agent| agent.id == requested || agent.agent_id == requested)
            .ok_or_else(|| ApiError::bad_request("Requested published agent was not found")),
        None if published.len() == 1 => published
            .into_iter()
            .next()
            .ok_or_else(|| ApiError::internal("published agent disappeared")),
        None => Err(ApiError::bad_request(
            "Multiple agents are published; set metadata.ryuAgentId",
        )),
    }
}

fn load_protocol_task(
    runtime: &A2aRuntime,
    tenant: &str,
    owner_id: &str,
    task_id: &str,
) -> Result<Task, ApiError> {
    let record = runtime.store.get_task_owned(tenant, owner_id, task_id)?;
    serde_json::from_value(record.protocol_task).map_err(ApiError::internal)
}

fn apply_history_length(task: &mut Task, history_length: Option<i32>) {
    let Some(length) = history_length else { return };
    let length = usize::try_from(length.max(0)).unwrap_or_default();
    if let Some(history) = task.history.as_mut() {
        if history.len() > length {
            history.drain(..history.len() - length);
        }
    }
}

fn protocol_state_to_store(state: &ProtocolTaskState) -> TaskState {
    match state {
        ProtocolTaskState::Submitted => TaskState::Submitted,
        ProtocolTaskState::Working => TaskState::Working,
        ProtocolTaskState::InputRequired => TaskState::InputRequired,
        ProtocolTaskState::AuthRequired => TaskState::AuthRequired,
        ProtocolTaskState::Completed => TaskState::Completed,
        ProtocolTaskState::Canceled => TaskState::Canceled,
        ProtocolTaskState::Failed => TaskState::Failed,
        ProtocolTaskState::Rejected => TaskState::Rejected,
        ProtocolTaskState::Unspecified => TaskState::Unknown,
    }
}

fn push_summary_to_protocol(
    summary: ryu_a2a::PushConfigSummary,
    tenant: &str,
) -> TaskPushNotificationConfig {
    TaskPushNotificationConfig {
        url: summary.callback_url,
        id: Some(summary.id),
        task_id: summary.task_id,
        token: None,
        authentication: summary
            .authentication_configured
            .then(|| AuthenticationInfo {
                scheme: "configured".to_owned(),
                credentials: None,
            }),
        tenant: Some(tenant.to_owned()),
    }
}

fn decode_page_token(token: Option<&str>) -> Result<u32, ApiError> {
    match token.filter(|value| !value.is_empty()) {
        Some(value) => value
            .parse::<u32>()
            .map_err(|_| ApiError::bad_request("Page token is invalid")),
        None => Ok(0),
    }
}

fn conversation_key(tenant: &str, principal: &str, context: &str) -> String {
    let digest = Sha256::digest(format!("{tenant}\0{principal}\0{context}").as_bytes());
    format!("a2a-{}", hex::encode(&digest[..16]))
}

fn local_policy() -> EndpointPolicy {
    EndpointPolicy {
        allow_loopback_http: cfg!(debug_assertions)
            || std::env::var("RYU_A2A_ALLOW_LOOPBACK_HTTP").as_deref() == Ok("1"),
    }
}

fn outbound_policy() -> EndpointPolicy {
    EndpointPolicy {
        allow_loopback_http: cfg!(debug_assertions)
            && std::env::var("RYU_A2A_ALLOW_LOOPBACK_HTTP").as_deref() == Ok("1"),
    }
}

fn default_true() -> bool {
    true
}

fn management_result<T: Serialize>(result: Result<T, ApiError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Debug)]
enum ApiError {
    Disabled,
    Protocol {
        code: i32,
        message: String,
        status: StatusCode,
    },
}

impl ApiError {
    fn rpc(code: i32, message: impl Into<String>) -> Self {
        Self::Protocol {
            code,
            message: message.into(),
            status: StatusCode::BAD_REQUEST,
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::Protocol {
            code: codes::INVALID_PARAMS,
            message: message.into(),
            status: StatusCode::BAD_REQUEST,
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::Protocol {
            code: codes::TASK_NOT_CANCELABLE,
            message: message.into(),
            status: StatusCode::CONFLICT,
        }
    }

    fn unauthorized() -> Self {
        Self::Protocol {
            code: codes::INVALID_REQUEST,
            message: "A2A authentication failed".to_owned(),
            status: StatusCode::UNAUTHORIZED,
        }
    }

    fn not_found() -> Self {
        Self::Protocol {
            code: codes::TASK_NOT_FOUND,
            message: "A2A record was not found".to_owned(),
            status: StatusCode::NOT_FOUND,
        }
    }

    fn rate_limited() -> Self {
        Self::Protocol {
            code: codes::INVALID_REQUEST,
            message: "A2A rate limit exceeded".to_owned(),
            status: StatusCode::TOO_MANY_REQUESTS,
        }
    }

    fn gateway_timeout() -> Self {
        Self::Protocol {
            code: codes::INTERNAL_ERROR,
            message: "A2A task timed out".to_owned(),
            status: StatusCode::GATEWAY_TIMEOUT,
        }
    }

    fn bad_gateway(_error: impl std::fmt::Display) -> Self {
        Self::Protocol {
            code: codes::INVALID_AGENT_RESPONSE,
            message: "A2A peer request failed".to_owned(),
            status: StatusCode::BAD_GATEWAY,
        }
    }

    fn internal(_error: impl std::fmt::Display) -> Self {
        Self::Protocol {
            code: codes::INTERNAL_ERROR,
            message: "Internal A2A error".to_owned(),
            status: StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Disabled => StatusCode::NOT_FOUND,
            Self::Protocol { status, .. } => *status,
        }
    }

    fn public_message(&self) -> &str {
        match self {
            Self::Disabled => "A2A is disabled",
            Self::Protocol { message, .. } => message,
        }
    }

    fn rpc_error(&self) -> JsonRpcError {
        match self {
            Self::Disabled => JsonRpcError {
                code: codes::UNSUPPORTED_OPERATION,
                message: "A2A is disabled".to_owned(),
                data: None,
            },
            Self::Protocol { code, message, .. } => JsonRpcError {
                code: *code,
                message: message.clone(),
                data: None,
            },
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound => Self::not_found(),
            StoreError::AuthenticationFailed => Self::unauthorized(),
            StoreError::InvalidInput(_) | StoreError::InvalidEndpoint(_) => {
                Self::bad_request("Invalid A2A input")
            }
            StoreError::InvalidTransition(_) | StoreError::Conflict(_) => {
                Self::conflict("A2A state conflict")
            }
            internal @ (StoreError::Unavailable
            | StoreError::Corrupt(_)
            | StoreError::Crypto
            | StoreError::Database(_)
            | StoreError::Json(_)) => Self::internal(internal),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = json!({
            "type": "https://ryu.dev/problems/a2a",
            "title": self.public_message(),
            "status": status.as_u16(),
        });
        let mut response = (status, Json(body)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_tokens_are_bounded_integers() {
        assert_eq!(decode_page_token(None).expect("empty token"), 0);
        assert_eq!(decode_page_token(Some("42")).expect("valid token"), 42);
        assert!(decode_page_token(Some("../../etc/passwd")).is_err());
    }

    #[test]
    fn conversation_keys_do_not_embed_peer_control_characters() {
        let key = conversation_key("default", "peer", "context/../\nsecret");
        assert!(key.starts_with("a2a-"));
        assert_eq!(key.len(), 36);
        assert!(!key.contains("secret"));
    }

    #[test]
    fn protocol_state_mapping_is_exhaustive() {
        assert_eq!(
            protocol_state_to_store(&ProtocolTaskState::AuthRequired),
            TaskState::AuthRequired
        );
        assert_eq!(
            protocol_state_to_store(&ProtocolTaskState::Unspecified),
            TaskState::Unknown
        );
    }

    #[test]
    fn protocol_version_header_rejects_non_v1_requests() {
        let mut headers = HeaderMap::new();
        headers.insert("a2a-version", HeaderValue::from_static("0.3"));
        assert!(matches!(
            ensure_protocol_version(&headers),
            Err(ApiError::Protocol {
                code: codes::VERSION_NOT_SUPPORTED,
                ..
            })
        ));
        headers.insert("a2a-version", HeaderValue::from_static(VERSION));
        assert!(ensure_protocol_version(&headers).is_ok());
    }
}
