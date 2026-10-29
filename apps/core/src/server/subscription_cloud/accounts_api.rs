//! Routes for linked plan accounts and the combined session list. Node owner only.

use super::accounts::{self, PlanAccount, ProviderId, DEFAULT_ACCOUNT};
use super::api::{
    account_label, api_error, bad_request, owner_with_plans, respond, sign_in, sign_in_slot_free,
    ApiError,
};
use super::cli::{self, SignIn};
use super::{local_run, runner, store, unix_now, Provider};
use crate::server::ResolvedAuthorization;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) fn routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route(
            "/api/cloud-task-backends/accounts",
            get(list_accounts).post(add_account),
        )
        .route(
            "/api/cloud-task-backends/accounts/:provider/:id",
            delete(remove_account),
        )
        .route(
            "/api/cloud-task-backends/accounts/:provider/:id/sign-in",
            post(sign_in_account),
        )
        .route(
            "/api/cloud-task-backends/accounts/:provider/:id/cooldown",
            delete(clear_account_cooldown),
        )
        .route("/api/cloud-task-backends/sessions", get(list_sessions))
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        list_accounts,
        add_account,
        remove_account,
        sign_in_account,
        clear_account_cooldown,
        list_sessions
    ),
    components(schemas(
        AccountView,
        AccountsView,
        NewAccount,
        RemoveAccount,
        SessionItem,
        SessionsView,
        PlanAccount,
        ProviderId
    ))
)]
pub(super) struct AccountsApiDoc;

/// One account a task can run on: the CLI's own default sign-in, or a linked account.
#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountView {
    /// `default` for the CLI's own sign-in, or the linked account's id.
    id: String,
    provider: ProviderId,
    label: String,
    /// "Claude · work", "Codex · personal".
    tag: String,
    /// This is the CLI's own default sign-in, which Ryu cannot remove.
    builtin: bool,
    /// The owner's default account for this provider.
    is_default: bool,
    /// The CLI is on this node's PATH.
    installed: bool,
    /// From the CLI's own status command, run with this account's folder.
    sign_in: Option<SignIn>,
    cooldown_seconds_remaining: Option<u64>,
    created_at: Option<u64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountsView {
    accounts: Vec<AccountView>,
}

fn tag(provider: ProviderId, label: &str) -> String {
    format!("{} · {label}", provider.product())
}

fn parse_provider(raw: &str) -> Result<ProviderId, ApiError> {
    match raw {
        "anthropic" => Ok(ProviderId::Anthropic),
        "openai" => Ok(ProviderId::Openai),
        _ => Err(api_error(
            StatusCode::NOT_FOUND,
            "subscription_account_not_found",
            "Unknown provider.",
        )),
    }
}

/// The owner's linked account, or 404.
fn linked_account(owner: &str, provider: &str, id: &str) -> Result<PlanAccount, ApiError> {
    let provider = parse_provider(provider)?;
    store::account(owner, provider, id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "subscription_account_not_found",
            "That account is not linked on this node.",
        )
    })
}

/// Every account a task could use, in order: per provider, the CLI's default sign-in
/// first, then the linked accounts.
fn all_accounts(owner: &str) -> Vec<(ProviderId, String, String, Option<u64>)> {
    let linked = store::accounts(owner);
    let mut out = Vec::new();
    for provider in [ProviderId::Anthropic, ProviderId::Openai] {
        out.push((
            provider,
            DEFAULT_ACCOUNT.to_owned(),
            account_label(owner, provider.provider(), DEFAULT_ACCOUNT),
            None,
        ));
        for account in linked.iter().filter(|account| account.provider == provider) {
            out.push((
                provider,
                account.id.clone(),
                account.label.clone(),
                Some(account.created_at),
            ));
        }
    }
    out
}

#[utoipa::path(get,path="/api/cloud-task-backends/accounts",operation_id="list_cloud_task_plan_accounts",tag="Cloud environments",security(("bearerAuth"=[])),description="The node owner's plan accounts: per provider, the CLI's own default sign-in and every linked account (each its own CLI config folder). Sign-in state comes from the CLI's status command run with that account's folder; Ryu never reads the credential. Node owner only.",responses((status=200,body=AccountsView),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn list_accounts(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let settings = store::settings(&owner);
            let now = unix_now();
            let mut views = Vec::new();
            for (provider, id, label, created_at) in all_accounts(&owner) {
                let state = sign_in(provider.provider(), &id).await;
                let default_id = settings
                    .default_accounts
                    .get(&provider)
                    .map_or(DEFAULT_ACCOUNT, String::as_str);
                views.push(AccountView {
                    tag: tag(provider, &label),
                    builtin: id == DEFAULT_ACCOUNT,
                    is_default: default_id == id,
                    installed: state.is_some(),
                    sign_in: state,
                    cooldown_seconds_remaining: store::cooldown_remaining(
                        &accounts::account_key(provider.provider(), &id),
                        now,
                    ),
                    created_at,
                    id,
                    provider,
                    label,
                });
            }
            Ok(AccountsView { accounts: views })
        }
        .await,
    )
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NewAccount {
    provider: ProviderId,
    /// 1-40 characters, for example "work" or "personal".
    label: String,
}

fn start_sign_in(provider: Provider, id: &str) -> Result<(), ApiError> {
    if !sign_in_slot_free(&accounts::account_key(provider, id)) {
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "subscription_sign_in_pending",
            "A sign-in for this account just started. Finish it in your browser, or wait a minute and try again.",
        ));
    }
    runner()
        .spawn_detached(cli::sign_in_invocation(provider).as_account(id))
        .map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "subscription_cli_missing",
                &format!("{} is not installed on this node.", provider.program()),
            )
        })
}

#[utoipa::path(post,path="/api/cloud-task-backends/accounts",operation_id="add_cloud_task_plan_account",tag="Cloud environments",security(("bearerAuth"=[])),request_body=NewAccount,description="Link another Claude or ChatGPT account on this node. Ryu makes a new, owner-only CLI config folder for it and starts the CLI's own sign-in with that folder (`claude auth login` with `CLAUDE_CONFIG_DIR`, `codex login` with `CODEX_HOME`), which opens the provider's page in the browser. The CLI writes its sign-in into the folder itself; Ryu never reads, copies or stores it. Poll `GET /api/cloud-task-backends/accounts` for the result. Up to 8 accounts per provider. Node owner only.",responses((status=202,body=PlanAccount),(status=400,description="invalid_request"),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable"),(status=409,description="subscription_account_limit"),(status=503,description="subscription_cli_missing")))]
pub(crate) async fn add_account(
    Extension(auth): Extension<ResolvedAuthorization>,
    body: axum::body::Bytes,
) -> Response {
    let created: Result<PlanAccount, ApiError> = async {
        let owner = owner_with_plans(&auth).await?;
        let input: NewAccount =
            serde_json::from_slice(&body).map_err(|_| bad_request("Send {provider, label}."))?;
        let label = accounts::clean_label(&input.label)
            .ok_or_else(|| bad_request("A label is 1-40 characters with no control characters."))?;
        let provider = input.provider.provider();
        if !runner().installed(provider) {
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "subscription_cli_missing",
                &format!("{} is not installed on this node.", provider.program()),
            ));
        }
        let account = PlanAccount {
            id: accounts::new_id(),
            provider: input.provider,
            label,
            created_at: unix_now(),
        };
        accounts::create_dir(provider, &account.id).map_err(|_| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "subscription_account_folder",
                "Ryu could not make the account's folder.",
            )
        })?;
        if store::add_account(&owner, account.clone()).is_err() {
            let _ = accounts::remove_dir(provider, &account.id);
            return Err(api_error(
                StatusCode::CONFLICT,
                "subscription_account_limit",
                "This node already has the most accounts allowed for this provider (8).",
            ));
        }
        start_sign_in(provider, &account.id)?;
        Ok(account)
    }
    .await;
    match created {
        Ok(account) => (StatusCode::ACCEPTED, Json(account)).into_response(),
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(post,path="/api/cloud-task-backends/accounts/{provider}/{id}/sign-in",operation_id="sign_in_cloud_task_plan_account",tag="Cloud environments",security(("bearerAuth"=[])),params(("provider"=String,Path,description="anthropic or openai"),("id"=String,Path,description="`default` or a linked account id")),description="Start the CLI's own sign-in again for one account, with that account's folder. Ryu captures none of it. Node owner only.",responses((status=202,body=Value),(status=404,description="subscription_account_not_found"),(status=429,description="subscription_sign_in_pending"),(status=503,description="subscription_cli_missing")))]
pub(crate) async fn sign_in_account(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path((provider, id)): Path<(String, String)>,
) -> Response {
    let started: Result<Value, ApiError> = async {
        let owner = owner_with_plans(&auth).await?;
        let provider_id = parse_provider(&provider)?;
        if id != DEFAULT_ACCOUNT {
            linked_account(&owner, &provider, &id)?;
        }
        start_sign_in(provider_id.provider(), &id)?;
        Ok(json!({"provider":provider_id,"id":id,"started":true}))
    }
    .await;
    match started {
        Ok(body) => (StatusCode::ACCEPTED, Json(body)).into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoveAccount {
    /// Must be `true`: removing deletes the account's folder and the CLI's sign-in in it.
    confirm: bool,
}

#[utoipa::path(delete,path="/api/cloud-task-backends/accounts/{provider}/{id}",operation_id="remove_cloud_task_plan_account",tag="Cloud environments",security(("bearerAuth"=[])),params(("provider"=String,Path,description="anthropic or openai"),("id"=String,Path,description="Linked account id")),request_body=RemoveAccount,description="Unlink an account: delete its CLI config folder (and so the CLI's sign-in for it) and every routing choice that named it. The body must be `{\"confirm\": true}`. Conversations that ran on it keep their history but cannot continue. Refused while a task on this node is running on it. The CLI's own default sign-in cannot be removed here. Node owner only.",responses((status=200,body=Value),(status=400,description="invalid_request"),(status=404,description="subscription_account_not_found"),(status=409,description="subscription_account_busy")))]
pub(crate) async fn remove_account(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path((provider, id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let confirmed =
                serde_json::from_slice::<RemoveAccount>(&body).is_ok_and(|input| input.confirm);
            if !confirmed {
                return Err(bad_request(
                    "Confirm with {\"confirm\": true}: this deletes the account's sign-in folder.",
                ));
            }
            if id == DEFAULT_ACCOUNT {
                return Err(bad_request(
                    "This is the CLI's own sign-in. Sign out of it in the CLI instead.",
                ));
            }
            let account = linked_account(&owner, &provider, &id)?;
            let busy = store::runs_for(&owner).iter().any(|record| {
                record.account() == account.id
                    && record.backend.provider() == Some(account.provider.provider())
                    && local_run::is_running(&record.conversation_id)
            });
            if busy {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "subscription_account_busy",
                    "A task on this node is running on this account. Stop it first.",
                ));
            }
            accounts::remove_dir(account.provider.provider(), &account.id).map_err(|_| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "subscription_account_folder",
                    "Ryu could not delete the account's folder.",
                )
            })?;
            store::remove_account(&owner, account.provider, &account.id);
            Ok(json!({"provider":account.provider,"id":account.id,"removed":true}))
        }
        .await,
    )
}

#[utoipa::path(delete,path="/api/cloud-task-backends/accounts/{provider}/{id}/cooldown",operation_id="clear_cloud_task_plan_account_cooldown",tag="Cloud environments",security(("bearerAuth"=[])),params(("provider"=String,Path,description="anthropic or openai"),("id"=String,Path,description="`default` or a linked account id")),description="Clear one account's usage-limit cooldown so the next task tries it again. Node owner only.",responses((status=200,body=Value),(status=404,description="subscription_account_not_found")))]
pub(crate) async fn clear_account_cooldown(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path((provider, id)): Path<(String, String)>,
) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let provider_id = parse_provider(&provider)?;
            if id != DEFAULT_ACCOUNT {
                linked_account(&owner, &provider, &id)?;
            }
            store::clear_cooldown(&accounts::account_key(provider_id.provider(), &id));
            Ok(json!({"provider":provider_id,"id":id,"cooldown":null}))
        }
        .await,
    )
}

/// One session in the combined list.
#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionItem {
    provider: ProviderId,
    account_id: String,
    /// "Claude · work", "Codex · personal".
    tag: String,
    /// The Ryu conversation, when Ryu started it.
    conversation_id: Option<String>,
    /// The provider's session or task id.
    external_id: Option<String>,
    title: Option<String>,
    status: Option<String>,
    url: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionsView {
    sessions: Vec<SessionItem>,
    /// Accounts whose list could not be read just now, as tags.
    unavailable: Vec<String>,
}

#[utoipa::path(get,path="/api/cloud-task-backends/sessions",operation_id="list_cloud_task_plan_sessions",tag="Cloud environments",security(("bearerAuth"=[])),description="Every plan session across the owner's accounts, each tagged with its account (\"Claude · work\"). It holds the tasks Ryu started, plus each Codex account's recent cloud tasks, read separately per account with `codex cloud list --json` and that account's `CODEX_HOME`. Claude Code has no command that lists cloud sessions, so Claude accounts show the sessions Ryu started. Node owner only.",responses((status=200,body=SessionsView),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn list_sessions(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let runs = store::runs_for(&owner);
            let mut sessions = Vec::new();
            let mut unavailable = Vec::new();
            for (provider, id, label, _) in all_accounts(&owner) {
                let account_tag = tag(provider, &label);
                let mine: Vec<_> = runs
                    .iter()
                    .filter(|record| {
                        record.account() == id
                            && record.backend.provider().map(ProviderId::from) == Some(provider)
                    })
                    .collect();
                for record in &mine {
                    sessions.push(SessionItem {
                        provider,
                        account_id: id.clone(),
                        tag: account_tag.clone(),
                        conversation_id: Some(record.conversation_id.clone()),
                        external_id: record.external_id.clone(),
                        title: None,
                        status: Some(record.status.clone()),
                        url: record.url.clone(),
                        updated_at: Some(record.updated_at),
                    });
                }
                if provider != ProviderId::Openai || !runner().installed(Provider::Openai) {
                    continue;
                }
                let listed = runner()
                    .run(cli::codex_list_invocation(None).as_account(&id))
                    .await
                    .ok()
                    .and_then(|output| cli::parse_codex_list(&output));
                let Some(tasks) = listed else {
                    unavailable.push(account_tag);
                    continue;
                };
                for task in tasks {
                    if mine
                        .iter()
                        .any(|record| record.external_id.as_deref() == Some(task.id.as_str()))
                    {
                        continue;
                    }
                    sessions.push(SessionItem {
                        provider,
                        account_id: id.clone(),
                        tag: account_tag.clone(),
                        conversation_id: None,
                        external_id: Some(task.id),
                        title: task.title,
                        status: task.status.map(|status| super::redact::scrub(&status)),
                        url: task.url,
                        updated_at: None,
                    });
                }
            }
            Ok(SessionsView {
                sessions,
                unavailable,
            })
        }
        .await,
    )
}
