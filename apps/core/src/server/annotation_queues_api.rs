//! HTTP handlers for human annotation queues (`/api/annotation-queues/*`).
//!
//! Queues are scoped to an agent, so every handler runs the same per-agent ACL
//! as Prompt Studio suites (`agent.view` to read, `agent.edit` to change or
//! review) on top of the route-level `AgentsRead`/`AgentsManage` capability.
//! Adding items from runs re-checks conversation read access per run and
//! refuses runs that belong to a different agent. Export appends reviewed
//! items to a Prompt Studio suite of the same agent and snapshots a version.

use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::annotation_queues::{
    item_to_suite_case, AnnotationQueue, AnnotationQueueStore, ItemFilter, NewItem, QueueInput,
    SourceKind, Submission, MAX_ITEM_TEXT_CHARS,
};
use crate::identity_verify::{permissions, VerifiedCaller};
use crate::server::conversations::ConversationDetail;
use crate::server::ServerState;

use super::{enforce_permission_on, json_error, require_conversation_access_if_known};

const MAX_ITEMS_PER_REQUEST: usize = 200;
/// Reviewer id recorded when the node owner (no verified user) reviews.
const LOCAL_REVIEWER: &str = "local";

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/annotation-queues",
            get(list_annotation_queues).post(create_annotation_queue),
        )
        .route(
            "/api/annotation-queues/:id",
            get(get_annotation_queue)
                .put(update_annotation_queue)
                .delete(delete_annotation_queue),
        )
        .route(
            "/api/annotation-queues/:id/items",
            get(list_annotation_items).post(add_annotation_items),
        )
        .route(
            "/api/annotation-queues/:id/items/:item_id",
            get(get_annotation_item)
                .patch(assign_annotation_item)
                .delete(delete_annotation_item),
        )
        .route(
            "/api/annotation-queues/:id/items/:item_id/submit",
            post(submit_annotation_item),
        )
        .route(
            "/api/annotation-queues/:id/next",
            post(next_annotation_item),
        )
        .route(
            "/api/annotation-queues/:id/export",
            post(export_annotation_queue),
        )
}

fn reviewer_of(caller: &Option<VerifiedCaller>) -> String {
    caller.as_ref().map_or_else(
        || LOCAL_REVIEWER.to_owned(),
        |caller| caller.user_id.clone(),
    )
}

fn store_or_error() -> Result<&'static AnnotationQueueStore, Response> {
    AnnotationQueueStore::global().ok_or_else(|| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "annotation queue store is not initialized".to_owned(),
        )
    })
}

fn internal(error: impl std::fmt::Display) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn queue_not_found() -> Response {
    json_error(
        StatusCode::NOT_FOUND,
        "annotation queue not found".to_owned(),
    )
}

fn item_not_found() -> Response {
    json_error(
        StatusCode::NOT_FOUND,
        "annotation item not found".to_owned(),
    )
}

async fn require_agent_permission(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    agent_id: &str,
    permission: &str,
) -> Result<(), Response> {
    enforce_permission_on(state, caller, permission, crate::acl::KIND_AGENT, agent_id)
        .await
        .map_err(|status| json_error(status, format!("insufficient permissions: {permission}")))
}

/// Load a queue and check the caller's permission on its agent.
async fn queue_for_access(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    queue_id: &str,
    permission: &str,
) -> Result<(&'static AnnotationQueueStore, AnnotationQueue), Response> {
    let store = store_or_error()?;
    let queue = match store.get_queue(queue_id).await {
        Ok(Some(queue)) => queue,
        Ok(None) => return Err(queue_not_found()),
        Err(error) => return Err(internal(error)),
    };
    require_agent_permission(state, caller, &queue.agent_id, permission).await?;
    Ok((store, queue))
}

/// Runs among the queue's items that `caller` may not read. An item is a copy
/// of its conversation's content, so `agent.view` on the agent is not enough to
/// read it: the caller must also pass the conversation's own ACL.
async fn unreadable_runs(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    store: &AnnotationQueueStore,
    queue_id: &str,
) -> Result<Vec<String>, Response> {
    let run_ids = store.run_ids(queue_id).await.map_err(internal)?;
    let mut unreadable = Vec::new();
    for run_id in run_ids {
        if require_conversation_access_if_known(state, caller, &run_id, false)
            .await
            .is_err()
        {
            unreadable.push(run_id);
        }
    }
    Ok(unreadable)
}

/// Whether `caller` may not read the conversation an item was copied from. An
/// item whose source conversation the caller cannot read is indistinguishable
/// from a missing one on every route that returns or changes its content.
async fn item_run_unreadable(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    store: &AnnotationQueueStore,
    queue_id: &str,
    item_id: &str,
) -> Result<bool, Response> {
    let Some(item) = store.get_item(queue_id, item_id).await.map_err(internal)? else {
        return Ok(false);
    };
    let Some(run_id) = item.run_id.as_deref() else {
        return Ok(false);
    };
    Ok(
        require_conversation_access_if_known(state, caller, run_id, false)
            .await
            .is_err(),
    )
}

#[derive(Debug, Deserialize)]
struct ListQueuesQuery {
    agent_id: String,
}

#[utoipa::path(
    get,
    path = "/api/annotation-queues",
    tag = "Annotation Queues",
    summary = "List annotation queues for an agent",
    params(("agent_id" = String, Query)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_annotation_queues(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(query): Query<ListQueuesQuery>,
) -> Response {
    if let Err(response) =
        require_agent_permission(&state, &caller, &query.agent_id, permissions::AGENT_VIEW).await
    {
        return response;
    }
    let store = match store_or_error() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list_queues(&query.agent_id).await {
        Ok(queues) => Json(json!({ "queues": queues })).into_response(),
        Err(error) => internal(error),
    }
}

#[derive(Debug, Deserialize)]
struct CreateQueueBody {
    agent_id: String,
    #[serde(flatten)]
    queue: QueueInput,
}

#[utoipa::path(
    post,
    path = "/api/annotation-queues",
    tag = "Annotation Queues",
    summary = "Create an annotation queue (rubric, labels, score range)",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub async fn create_annotation_queue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<CreateQueueBody>,
) -> Response {
    if let Err(response) =
        require_agent_permission(&state, &caller, &body.agent_id, permissions::AGENT_EDIT).await
    {
        return response;
    }
    match state.agent_store.get(&body.agent_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "agent not found".to_owned()),
        Err(error) => return internal(error),
    }
    let store = match store_or_error() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let created_by = caller.as_ref().map(|caller| caller.user_id.as_str());
    match store
        .create_queue(&body.agent_id, &body.queue, created_by)
        .await
    {
        Ok(queue) => (StatusCode::CREATED, Json(json!({ "queue": queue }))).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/annotation-queues/{id}",
    tag = "Annotation Queues",
    summary = "Get an annotation queue with item counts",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_annotation_queue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_VIEW).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match store.queue_summary(&id).await {
        Ok(Some(summary)) => Json(json!({ "queue": summary })).into_response(),
        Ok(None) => queue_not_found(),
        Err(error) => internal(error),
    }
}

#[utoipa::path(
    put,
    path = "/api/annotation-queues/{id}",
    tag = "Annotation Queues",
    summary = "Update an annotation queue",
    params(("id" = String, Path)), request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn update_annotation_queue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<QueueInput>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match store.update_queue(&id, &body).await {
        Ok(Some(queue)) => Json(json!({ "queue": queue })).into_response(),
        Ok(None) => queue_not_found(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

#[utoipa::path(
    delete,
    path = "/api/annotation-queues/{id}",
    tag = "Annotation Queues",
    summary = "Delete an annotation queue and its items",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_annotation_queue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match store.delete_queue(&id).await {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => queue_not_found(),
        Err(error) => internal(error),
    }
}

#[utoipa::path(
    get,
    path = "/api/annotation-queues/{id}/items",
    tag = "Annotation Queues",
    summary = "List annotation items (filter by status/assignee)",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_annotation_items(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Query(mut filter): Query<ItemFilter>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_VIEW).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    filter.exclude_run_ids = match unreadable_runs(&state, &caller, store, &id).await {
        Ok(runs) => runs,
        Err(response) => return response,
    };
    match store.list_items(&id, &filter).await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(error) => internal(error),
    }
}

/// One item to add: a run (optionally narrowed to one assistant message) or
/// an external trace with its captured input/output.
#[derive(Debug, Deserialize)]
struct AddItemRequest {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    trace_id: Option<String>,
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    assignee: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AddItemsBody {
    items: Vec<AddItemRequest>,
}

fn clip(value: &str) -> String {
    value.chars().take(MAX_ITEM_TEXT_CHARS).collect()
}

/// Resolve the user prompt + assistant answer an item points at. With a
/// `message_id`, that assistant message and the closest user message before
/// it; otherwise the run's last complete user→assistant exchange.
pub(crate) fn exchange_from_run(
    detail: &ConversationDetail,
    message_id: Option<&str>,
) -> Result<(String, String), String> {
    let answer_index = match message_id {
        Some(message_id) => {
            let index = detail
                .messages
                .iter()
                .position(|message| message.id == message_id)
                .ok_or_else(|| format!("message '{message_id}' not found in run"))?;
            if detail.messages[index].role != "assistant" {
                return Err("only assistant messages can be annotated".to_owned());
            }
            index
        }
        None => detail
            .messages
            .iter()
            .rposition(|message| message.role == "assistant" && !message.content.trim().is_empty())
            .ok_or_else(|| "run has no non-empty assistant response".to_owned())?,
    };
    let prompt = detail.messages[..answer_index]
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .ok_or_else(|| "run has no user message before the response".to_owned())?;
    Ok((
        clip(&prompt.content),
        clip(&detail.messages[answer_index].content),
    ))
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn resolve_item(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    queue: &AnnotationQueue,
    request: AddItemRequest,
) -> Result<NewItem, Response> {
    let metadata = request.metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "item metadata must be a JSON object".to_owned(),
        ));
    }
    let trace_id = trimmed(request.trace_id.as_deref());
    let assignee = trimmed(request.assignee.as_deref());
    let Some(run_id) = trimmed(request.run_id.as_deref()) else {
        // External trace: the caller supplies the captured exchange.
        let (Some(trace_id), Some(input), Some(output)) = (trace_id, request.input, request.output)
        else {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "each item needs a run_id, or a trace_id with input and output".to_owned(),
            ));
        };
        return Ok(NewItem {
            source_kind: SourceKind::Trace,
            run_id: None,
            message_id: None,
            trace_id: Some(trace_id),
            input: clip(&input),
            output: clip(&output),
            metadata,
            assignee,
        });
    };
    require_conversation_access_if_known(state, caller, &run_id, false).await?;
    let detail = match state.conversations.get_conversation_detail(&run_id).await {
        Ok(Some(detail)) => detail,
        Ok(None) => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                format!("run '{run_id}' not found"),
            ))
        }
        Err(error) => return Err(internal(error)),
    };
    let belongs = detail.agent_id.as_deref() == Some(queue.agent_id.as_str())
        || detail
            .participants
            .iter()
            .any(|agent| agent == &queue.agent_id);
    if !belongs {
        return Err(json_error(
            StatusCode::CONFLICT,
            format!("run '{run_id}' belongs to a different agent"),
        ));
    }
    let message_id = trimmed(request.message_id.as_deref());
    let (input, output) = exchange_from_run(&detail, message_id.as_deref())
        .map_err(|reason| json_error(StatusCode::BAD_REQUEST, reason))?;
    Ok(NewItem {
        source_kind: if message_id.is_some() {
            SourceKind::Message
        } else {
            SourceKind::Run
        },
        run_id: Some(run_id),
        message_id,
        trace_id,
        input,
        output,
        metadata,
        assignee,
    })
}

#[utoipa::path(
    post,
    path = "/api/annotation-queues/{id}/items",
    tag = "Annotation Queues",
    summary = "Add runs, messages, or traces to an annotation queue",
    params(("id" = String, Path)), request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn add_annotation_items(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<AddItemsBody>,
) -> Response {
    let (store, queue) = match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if body.items.is_empty() || body.items.len() > MAX_ITEMS_PER_REQUEST {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("send between 1 and {MAX_ITEMS_PER_REQUEST} items"),
        );
    }
    let mut resolved = Vec::with_capacity(body.items.len());
    for request in body.items {
        match resolve_item(&state, &caller, &queue, request).await {
            Ok(item) => resolved.push(item),
            Err(response) => return response,
        }
    }
    match store.add_items(&id, resolved).await {
        Ok(Some((added, skipped))) => {
            Json(json!({ "added": added, "skipped": skipped })).into_response()
        }
        Ok(None) => queue_not_found(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/annotation-queues/{id}/items/{item_id}",
    tag = "Annotation Queues",
    summary = "Get one annotation item",
    params(("id" = String, Path), ("item_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_annotation_item(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((id, item_id)): Path<(String, String)>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_VIEW).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match item_run_unreadable(&state, &caller, store, &id, &item_id).await {
        Ok(false) => {}
        Ok(true) => return item_not_found(),
        Err(response) => return response,
    }
    match store.get_item(&id, &item_id).await {
        Ok(Some(item)) => Json(json!({ "item": item })).into_response(),
        Ok(None) => item_not_found(),
        Err(error) => internal(error),
    }
}

#[derive(Debug, Deserialize)]
struct AssignBody {
    /// New assignee; `null` releases the item.
    assignee: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/api/annotation-queues/{id}/items/{item_id}",
    tag = "Annotation Queues",
    summary = "Assign or release an annotation item",
    params(("id" = String, Path), ("item_id" = String, Path)), request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn assign_annotation_item(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((id, item_id)): Path<(String, String)>,
    Json(body): Json<AssignBody>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match item_run_unreadable(&state, &caller, store, &id, &item_id).await {
        Ok(false) => {}
        Ok(true) => return item_not_found(),
        Err(response) => return response,
    }
    let assignee = trimmed(body.assignee.as_deref());
    match store.assign_item(&id, &item_id, assignee.as_deref()).await {
        Ok(Some(item)) => Json(json!({ "item": item })).into_response(),
        Ok(None) => item_not_found(),
        Err(error) => internal(error),
    }
}

#[utoipa::path(
    delete,
    path = "/api/annotation-queues/{id}/items/{item_id}",
    tag = "Annotation Queues",
    summary = "Remove an annotation item",
    params(("id" = String, Path), ("item_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_annotation_item(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((id, item_id)): Path<(String, String)>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match store.delete_item(&id, &item_id).await {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => item_not_found(),
        Err(error) => internal(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/annotation-queues/{id}/items/{item_id}/submit",
    tag = "Annotation Queues",
    summary = "Submit a human score, labels, and comment",
    params(("id" = String, Path), ("item_id" = String, Path)), request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn submit_annotation_item(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path((id, item_id)): Path<(String, String)>,
    Json(body): Json<Submission>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    match item_run_unreadable(&state, &caller, store, &id, &item_id).await {
        Ok(false) => {}
        Ok(true) => return item_not_found(),
        Err(response) => return response,
    }
    let reviewer = reviewer_of(&caller);
    match store.submit(&id, &item_id, &body, Some(&reviewer)).await {
        Ok(Some(item)) => Json(json!({ "item": item })).into_response(),
        Ok(None) => item_not_found(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/annotation-queues/{id}/next",
    tag = "Annotation Queues",
    summary = "Claim the next item to review",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn next_annotation_item(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    let (store, _queue) =
        match queue_for_access(&state, &caller, &id, permissions::AGENT_EDIT).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    let reviewer = reviewer_of(&caller);
    let unreadable = match unreadable_runs(&state, &caller, store, &id).await {
        Ok(runs) => runs,
        Err(response) => return response,
    };
    match store.next_item_excluding(&id, &reviewer, &unreadable).await {
        Ok(item) => Json(json!({ "item": item })).into_response(),
        Err(error) => internal(error),
    }
}

#[derive(Debug, Deserialize)]
struct ExportBody {
    suite_id: String,
    #[serde(default)]
    min_score: Option<f64>,
    #[serde(default)]
    labels: Vec<String>,
}

#[utoipa::path(
    post,
    path = "/api/annotation-queues/{id}/export",
    tag = "Annotation Queues",
    summary = "Export reviewed items to a prompt suite",
    params(("id" = String, Path)), request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn export_annotation_queue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<ExportBody>,
) -> Response {
    let (store, queue) = match queue_for_access(&state, &caller, &id, permissions::AGENT_VIEW).await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(suites) = crate::prompt_evals::PromptEvalStore::global() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "prompt eval store is not initialized".to_owned(),
        );
    };
    let suite = match suites.get_suite(&body.suite_id).await {
        Ok(Some(suite)) => suite,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => return internal(error),
    };
    if let Err(response) =
        require_agent_permission(&state, &caller, &suite.agent_id, permissions::AGENT_EDIT).await
    {
        return response;
    }
    if suite.agent_id != queue.agent_id {
        return json_error(
            StatusCode::CONFLICT,
            "prompt suite belongs to a different agent".to_owned(),
        );
    }
    let items = match store
        .exportable_items(&id, body.min_score, &body.labels)
        .await
    {
        Ok(items) => items,
        Err(error) => return internal(error),
    };
    // Exporting copies content into the suite, so it honours the same
    // per-conversation read check as listing.
    let unreadable = match unreadable_runs(&state, &caller, store, &id).await {
        Ok(runs) => runs,
        Err(response) => return response,
    };
    let items: Vec<_> = items
        .into_iter()
        .filter(|item| {
            item.run_id
                .as_ref()
                .is_none_or(|run_id| !unreadable.contains(run_id))
        })
        .collect();
    let mut added = 0usize;
    let mut skipped = 0usize;
    for item in &items {
        match suites
            .append_case_if_absent(&suite.id, &item_to_suite_case(&queue, item))
            .await
        {
            Ok(Some((_suite, true))) => added += 1,
            Ok(Some((_suite, false))) => skipped += 1,
            Ok(None) => {
                return json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned())
            }
            Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
        }
    }
    let version = if added > 0 {
        let label = format!("Annotation export: {}", queue.name);
        match suites.snapshot_suite(&suite.id, Some(&label)).await {
            Ok(version) => version,
            Err(error) => return internal(error),
        }
    } else {
        None
    };
    Json(json!({
        "added": added,
        "skipped": skipped,
        "suite_id": suite.id,
        "version": version,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::conversations::StoredMessage;

    fn message(id: &str, role: &str, content: &str) -> StoredMessage {
        serde_json::from_value(
            json!({ "id": id, "role": role, "content": content, "created_at": 0 }),
        )
        .expect("stored message")
    }

    fn detail(messages: Vec<StoredMessage>) -> ConversationDetail {
        serde_json::from_value(json!({
            "id": "run-1",
            "title": null,
            "agent_id": "agent-1",
            "created_at": 0,
            "updated_at": 0,
            "messages": messages,
        }))
        .expect("conversation detail")
    }

    #[test]
    fn exchange_uses_last_pair_or_named_message() {
        let run = detail(vec![
            message("u1", "user", "first question"),
            message("a1", "assistant", "first answer"),
            message("u2", "user", "second question"),
            message("a2", "assistant", "second answer"),
        ]);
        assert_eq!(
            exchange_from_run(&run, None).unwrap(),
            ("second question".to_owned(), "second answer".to_owned())
        );
        assert_eq!(
            exchange_from_run(&run, Some("a1")).unwrap(),
            ("first question".to_owned(), "first answer".to_owned())
        );
        assert!(exchange_from_run(&run, Some("u2")).is_err());
        assert!(exchange_from_run(&run, Some("missing")).is_err());
        assert!(exchange_from_run(&detail(vec![message("u", "user", "q")]), None).is_err());
    }
}

#[cfg(test)]
#[path = "annotation_queues_api_tests.rs"]
mod route_tests;
