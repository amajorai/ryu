//! Agent-resource-authorized native account lifecycle and retained device login.

use super::ServerState;
use crate::pi_config::native_accounts::{NativeAccountError, NativeAccounts};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Mutex},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    operation_id: String,
    account_id: String,
    state: String,
    instructions: String,
    /// English text of the failure; `errorCode` and `errorI18n` carry it as a
    /// coded Core message for the reader's language.
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_i18n: Option<serde_json::Value>,
}
impl Progress {
    fn fail(&mut self, error: NativeAccountError) {
        let message = error.message();
        self.error = Some(message.render("en"));
        self.error_code = Some(error.code());
        self.error_i18n = Some(message.to_wire());
    }
}
struct Operation {
    agent_id: String,
    owner: Option<(String, Option<String>)>,
    created: std::time::Instant,
    progress: Progress,
    cancel: watch::Sender<bool>,
}
fn owner(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Option<(String, Option<String>)> {
    caller
        .as_ref()
        .map(|caller| (caller.user_id.clone(), caller.org_id.clone()))
}
fn visible(
    operation: &Operation,
    agent_id: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    operation.agent_id == agent_id && operation.owner == owner(caller)
}

pub(super) async fn cancel_account(agent_id: &str, account_id: &str) {
    {
        let store = operations().lock().await;
        for operation in store.values().filter(|operation| {
            operation.agent_id == agent_id
                && operation.progress.account_id == account_id
                && operation.progress.state == "running"
        }) {
            let _ = operation.cancel.send(true);
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        let running = operations().lock().await.values().any(|operation| {
            operation.agent_id == agent_id
                && operation.progress.account_id == account_id
                && operation.progress.state == "running"
        });
        if !running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
type Operations = Arc<Mutex<HashMap<String, Operation>>>;
fn operations() -> &'static Operations {
    static OPERATIONS: OnceLock<Operations> = OnceLock::new();
    OPERATIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}
#[derive(Deserialize)]
pub struct CreateAccount {
    label: String,
}

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/agents/:id/native-accounts", get(list).post(create))
        .route(
            "/api/agents/:id/native-accounts/:account_id/login",
            post(login),
        )
        .route(
            "/api/agents/:id/native-accounts/:account_id/disconnect",
            post(disconnect),
        )
        .route(
            "/api/agents/:id/native-accounts/:account_id/logout",
            post(logout),
        )
        .route(
            "/api/agents/:id/native-accounts/operations/:operation_id",
            get(progress).delete(cancel),
        )
}

async fn authorized(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent: &str,
    edit: bool,
) -> Result<NativeAccounts, Response> {
    let permission = if edit {
        crate::identity_verify::permissions::AGENT_EDIT
    } else {
        crate::identity_verify::permissions::AGENT_VIEW
    };
    let spawn = super::resolve_acp_spawn_cmd_authorized(state, caller, permission, agent).await?;
    let Some(spawn) = spawn else {
        return Err(refusal(NativeAccountError::Unsupported));
    };
    crate::pi_config::native_accounts::for_spawn(&spawn)
        .map_err(|error| failure(&error))?
        .ok_or_else(|| refusal(NativeAccountError::Unsupported))
}
/// `400 { error, code, i18n }` for a coded failure.
fn refusal(error: NativeAccountError) -> Response {
    (StatusCode::BAD_REQUEST, Json(error.body())).into_response()
}
/// A failed operation: its coded sentence, or the generic one (detail logged).
fn failure(error: &anyhow::Error) -> Response {
    refusal(NativeAccountError::of(error))
}

#[utoipa::path(get, path="/api/agents/{id}/native-accounts", tag="Agents", params(("id"=String, Path)), responses((status=200, body=serde_json::Value)))]
pub async fn list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent): Path<String>,
) -> Response {
    let accounts = match authorized(&state, &caller, &agent, false).await {
        Ok(accounts) => accounts,
        Err(error) => return error,
    };
    match accounts.list() {
        Ok(list) => Json(json!({"accounts":list,"nativeAccounts":true})).into_response(),
        Err(error) => failure(&error),
    }
}
#[utoipa::path(post, path="/api/agents/{id}/native-accounts", tag="Agents", params(("id"=String, Path)), request_body=serde_json::Value, responses((status=200, body=serde_json::Value)))]
pub async fn create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent): Path<String>,
    Json(body): Json<CreateAccount>,
) -> Response {
    let accounts = match authorized(&state, &caller, &agent, true).await {
        Ok(accounts) => accounts,
        Err(error) => return error,
    };
    match accounts.create(&body.label) {
        Ok(account) => Json(json!({"account":account})).into_response(),
        Err(error) => failure(&error),
    }
}
#[utoipa::path(post, path="/api/agents/{id}/native-accounts/{account_id}/login", tag="Agents", params(("id"=String, Path),("account_id"=String, Path)), responses((status=202, body=serde_json::Value)))]
pub async fn login(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent, account_id)): Path<(String, String)>,
) -> Response {
    let accounts = match authorized(&state, &caller, &agent, true).await {
        Ok(accounts) => accounts,
        Err(error) => return error,
    };
    let (attempt, mut command) = match accounts.begin_login(&account_id) {
        Ok(attempt) => attempt,
        Err(error) => return failure(&error),
    };
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return refusal(NativeAccountError::LoginStartFailed),
    };
    let stdout = child.stdout.take().expect("piped native login stdout");
    let stderr = child.stderr.take().expect("piped native login stderr");
    let operation_id = uuid::Uuid::new_v4().to_string();
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut store = operations().lock().await;
        // Completed login instructions contain short-lived authorization codes;
        // discard them immediately and bound the operation history.
        store.retain(|_, operation| {
            operation.progress.state == "running"
                || operation.created.elapsed() < Duration::from_secs(600)
        });
        if store.len() >= 64 {
            let _ = child.kill().await;
            return refusal(NativeAccountError::TooManyOperations);
        }
        store.insert(
            operation_id.clone(),
            Operation {
                agent_id: agent,
                owner: owner(&caller),
                created: std::time::Instant::now(),
                progress: Progress {
                    operation_id: operation_id.clone(),
                    account_id: account_id.clone(),
                    state: "running".into(),
                    instructions: String::new(),
                    error: None,
                    error_code: None,
                    error_i18n: None,
                },
                cancel,
            },
        );
    }
    let id = operation_id.clone();
    let login_account_id = account_id.clone();
    tokio::spawn(async move {
        let read_id = id.clone();
        let read_out = collect_instructions(stdout, read_id.clone());
        let read_err = collect_instructions(stderr, read_id);
        let work = async {
            let (_, _, status) = tokio::try_join!(read_out, read_err, async {
                child.wait().await.map_err(anyhow::Error::from)
            })?;
            if !status.success() {
                return Err(NativeAccountError::LoginIncomplete.into());
            }
            accounts.finish_login(attempt).await
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(600), work) => result.unwrap_or_else(|_| Err(NativeAccountError::LoginTimedOut.into())),
            _ = cancelled.changed() => Err(NativeAccountError::LoginCancelled.into()),
        };
        let _ = child.kill().await;
        if result.is_err() {
            let _ = accounts.disconnect(&login_account_id);
        }
        if let Some(operation) = operations().lock().await.get_mut(&id) {
            operation.progress.state = if result.is_ok() {
                "completed"
            } else {
                "failed"
            }
            .into();
            operation.progress.instructions.clear();
            if let Err(error) = &result {
                operation.progress.fail(NativeAccountError::of(error));
            }
        }
    });
    (StatusCode::ACCEPTED, Json(json!({"operationId":operation_id,"accountId":account_id,"state":"running","verified":false}))).into_response()
}

async fn collect_instructions(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    id: String,
) -> anyhow::Result<()> {
    let mut buffer = [0u8; 2048];
    let mut total = 0usize;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        total += count;
        if total > 16 * 1024 {
            anyhow::bail!("Native login output exceeded its limit");
        }
        if let Some(operation) = operations().lock().await.get_mut(&id) {
            operation
                .progress
                .instructions
                .push_str(&String::from_utf8_lossy(&buffer[..count]));
        }
    }
}

#[utoipa::path(get, path="/api/agents/{id}/native-accounts/operations/{operation_id}", tag="Agents", params(("id"=String, Path),("operation_id"=String, Path)), responses((status=200, body=serde_json::Value),(status=404)))]
pub async fn progress(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    if let Err(error) = authorized(&state, &caller, &agent, true).await {
        return error;
    }
    match operations()
        .lock()
        .await
        .get(&id)
        .filter(|operation| visible(operation, &agent, &caller))
    {
        Some(operation) => Json(json!({"operation":operation.progress})).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
#[utoipa::path(delete, path="/api/agents/{id}/native-accounts/operations/{operation_id}", tag="Agents", params(("id"=String, Path),("operation_id"=String, Path)), responses((status=200, body=serde_json::Value),(status=404)))]
pub async fn cancel(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    if let Err(error) = authorized(&state, &caller, &agent, true).await {
        return error;
    }
    match operations()
        .lock()
        .await
        .get(&id)
        .filter(|operation| visible(operation, &agent, &caller))
    {
        Some(operation) => {
            let _ = operation.cancel.send(true);
            Json(json!({"cancelled":true})).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
#[utoipa::path(post, path="/api/agents/{id}/native-accounts/{account_id}/disconnect", tag="Agents", params(("id"=String, Path),("account_id"=String, Path)), responses((status=200, body=serde_json::Value)))]
pub async fn disconnect(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    let accounts = match authorized(&state, &caller, &agent, true).await {
        Ok(accounts) => accounts,
        Err(error) => return error,
    };
    cancel_account(&agent, &id).await;
    match accounts.disconnect(&id) {
        Ok(()) => Json(json!({"disconnected":true})).into_response(),
        Err(error) => failure(&error),
    }
}
#[utoipa::path(post, path="/api/agents/{id}/native-accounts/{account_id}/logout", tag="Agents", params(("id"=String, Path),("account_id"=String, Path)), responses((status=200, body=serde_json::Value)))]
pub async fn logout(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    let accounts = match authorized(&state, &caller, &agent, true).await {
        Ok(accounts) => accounts,
        Err(error) => return error,
    };
    cancel_account(&agent, &id).await;
    match accounts.logout(&id).await {
        Ok(()) => Json(json!({"loggedOut":true})).into_response(),
        Err(error) => failure(&error),
    }
}

#[cfg(test)]
#[path = "native_accounts_tests.rs"]
mod tests;
