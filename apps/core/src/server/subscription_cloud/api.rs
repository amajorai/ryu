//! Routes and the start-or-fall-back decision.

use super::accounts::{self, ProviderId};
use super::cli::{self, CliFailure, FailureClass, SignIn};
use super::local_run::{self, BeginFailure};
use super::routing::{self, Availability, Notice, SessionPin};
use super::store::{self, EnvironmentLink, RoutingSettings, RunRecord};
use super::{
    caller_is_node_owner, openai_plan_allowed, plan_owner, rollout_allows, runner, unix_now,
    CloudTaskBackend, Provider,
};
use crate::server::cloud_environments as environments;
use crate::server::ResolvedAuthorization;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub(crate) type ApiError = (StatusCode, Json<Value>);

pub(super) fn api_error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({"error":{"code":code,"message":message}})),
    )
}

fn owner_only() -> ApiError {
    api_error(
        StatusCode::FORBIDDEN,
        "subscription_backend_owner_only",
        "Only this node's owner can use the Claude or ChatGPT plan signed in on it.",
    )
}

// ── What each backend can do (docs/subscription-cloud-sessions.md §5) ────────

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Features {
    pub(crate) follow_up: bool,
    pub(crate) live_status: bool,
    pub(crate) run_log: bool,
    pub(crate) diff_in_ryu: bool,
    pub(crate) pull_request_in_ryu: bool,
    pub(crate) live_screen: bool,
    pub(crate) stop_from_ryu: bool,
    /// Charged in Ryu credits.
    pub(crate) ryu_credits: bool,
}

pub(crate) fn features(backend: CloudTaskBackend) -> Features {
    match backend {
        CloudTaskBackend::RyuBox => Features {
            follow_up: true,
            live_status: true,
            run_log: true,
            diff_in_ryu: true,
            pull_request_in_ryu: true,
            live_screen: true,
            stop_from_ryu: true,
            ryu_credits: true,
        },
        CloudTaskBackend::AnthropicSubscriptionCli => Features {
            follow_up: true,
            live_status: false,
            run_log: false,
            diff_in_ryu: false,
            pull_request_in_ryu: false,
            live_screen: false,
            stop_from_ryu: false,
            ryu_credits: false,
        },
        CloudTaskBackend::AnthropicSubscriptionSdk | CloudTaskBackend::OpenaiSubscriptionSdk => {
            Features {
                follow_up: true,
                live_status: true,
                run_log: true,
                diff_in_ryu: true,
                pull_request_in_ryu: false,
                live_screen: false,
                stop_from_ryu: true,
                ryu_credits: false,
            }
        }
        CloudTaskBackend::OpenaiSubscriptionCli => Features {
            follow_up: false,
            live_status: true,
            run_log: false,
            diff_in_ryu: false,
            pull_request_in_ryu: false,
            live_screen: false,
            stop_from_ryu: false,
            ryu_credits: false,
        },
    }
}

// ── Availability ─────────────────────────────────────────────────────────────

/// The CLI's sign-in for `account`, or `None` when the CLI is not installed.
pub(super) async fn sign_in(provider: Provider, account: &str) -> Option<SignIn> {
    let runner = runner();
    if !runner.installed(provider) {
        return None;
    }
    match runner
        .run(cli::status_invocation(provider).as_account(account))
        .await
    {
        Ok(output) => Some(cli::parse_sign_in(provider, &output)),
        Err(_) => Some(SignIn::SignedOut),
    }
}

/// Sign-in answers for one routing pass, so each account's CLI is asked once.
#[derive(Default)]
struct SignIns(BTreeMap<String, Option<SignIn>>);

impl SignIns {
    async fn get(&mut self, provider: Provider, account: &str) -> Option<SignIn> {
        let key = accounts::account_key(provider, account);
        if let Some(known) = self.0.get(&key) {
            return *known;
        }
        let answer = sign_in(provider, account).await;
        self.0.insert(key, answer);
        answer
    }
}

/// An account a task may run on, with the name the owner gave it.
#[derive(Clone, Debug)]
pub(crate) struct AccountChoice {
    pub(crate) id: String,
    pub(crate) label: String,
}

impl AccountChoice {
    pub(crate) fn key(&self, provider: Provider) -> String {
        accounts::account_key(provider, &self.id)
    }
}

pub(crate) fn account_label(owner: &str, provider: Provider, id: &str) -> String {
    if id == accounts::DEFAULT_ACCOUNT {
        return "this node's sign-in".into();
    }
    store::account(owner, provider.into(), id)
        .map_or_else(|| "a removed account".into(), |account| account.label)
}

/// The account a provider's task starts on: the session's pin, then the agent's
/// account, then the owner's default, then the CLI's own sign-in.
fn chosen_account(
    owner: &str,
    settings: &RoutingSettings,
    provider: Provider,
    agent_id: Option<&str>,
    pin: Option<(ProviderId, &str)>,
) -> AccountChoice {
    let provider_id = ProviderId::from(provider);
    let id = pin
        .filter(|(pinned, _)| *pinned == provider_id)
        .map(|(_, id)| id.to_owned())
        .or_else(|| {
            agent_id
                .and_then(|agent| settings.agent_accounts.get(agent))
                .and_then(|choice| choice.get(&provider_id))
                .cloned()
        })
        .or_else(|| settings.default_accounts.get(&provider_id).cloned())
        .filter(|id| linked(owner, provider_id, id))
        .unwrap_or_else(|| accounts::DEFAULT_ACCOUNT.to_owned());
    AccountChoice {
        label: account_label(owner, provider, &id),
        id,
    }
}

/// Whether `id` is the default sign-in or one of the owner's linked accounts.
pub(crate) fn linked(owner: &str, provider: ProviderId, id: &str) -> bool {
    id == accounts::DEFAULT_ACCOUNT || store::account(owner, provider, id).is_some()
}

/// The owner's explicit fallback accounts for `provider`, after `primary`. Ryu tries
/// them only after a usage or rate limit, and only because the owner listed them.
fn fallback_accounts(
    owner: &str,
    settings: &RoutingSettings,
    provider: Provider,
    primary: &str,
) -> Vec<AccountChoice> {
    let provider_id = ProviderId::from(provider);
    let mut seen = vec![primary.to_owned()];
    let mut out = Vec::new();
    for id in settings
        .account_fallbacks
        .get(&provider_id)
        .into_iter()
        .flatten()
    {
        if seen.contains(id) || !linked(owner, provider_id, id) {
            continue;
        }
        seen.push(id.clone());
        out.push(AccountChoice {
            id: id.clone(),
            label: account_label(owner, provider, id),
        });
    }
    out
}

fn configured(backend: CloudTaskBackend, link: Option<&EnvironmentLink>) -> bool {
    match backend {
        CloudTaskBackend::RyuBox => true,
        // Runs on this node use a worktree of the environment's local checkout.
        CloudTaskBackend::AnthropicSubscriptionCli
        | CloudTaskBackend::AnthropicSubscriptionSdk
        | CloudTaskBackend::OpenaiSubscriptionSdk => link
            .and_then(|link| link.claude_checkout.as_deref())
            .is_some_and(checkout_is_usable),
        CloudTaskBackend::OpenaiSubscriptionCli => link
            .and_then(|link| link.codex_environment_id.as_deref())
            .is_some_and(codex_environment_id_ok),
    }
}

fn checkout_is_usable(path: &str) -> bool {
    let path = std::path::Path::new(path);
    path.is_absolute() && path.join(".git").exists()
}

fn codex_environment_id_ok(id: &str) -> bool {
    id.len() <= 128
        && id
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
}

async fn availability(
    backend: CloudTaskBackend,
    account: &AccountChoice,
    link: Option<&EnvironmentLink>,
    now: u64,
    sign_ins: &mut SignIns,
) -> Availability {
    let Some(provider) = backend.provider() else {
        return Availability::Ready;
    };
    if store::cooldown_remaining(&account.key(provider), now).is_some() {
        return Availability::CoolingDown;
    }
    if !configured(backend, link) {
        return Availability::NotConfigured;
    }
    match sign_ins.get(provider, &account.id).await {
        None => Availability::NotInstalled,
        Some(SignIn::Subscription) => Availability::Ready,
        Some(SignIn::OtherMethod) => Availability::WrongSignIn,
        Some(SignIn::SignedOut) => Availability::SignedOut,
    }
}

// ── Start or fall back ───────────────────────────────────────────────────────

/// A prompt for a cloud task whose executor is a provider agent.
pub(crate) struct RouteRequest<'a> {
    pub(crate) owner: &'a str,
    pub(crate) conversation_id: &'a str,
    pub(crate) environment_id: &'a str,
    pub(crate) executor: &'a str,
    pub(crate) agent_id: Option<&'a str>,
    pub(crate) pin: SessionPin,
    /// The session's account pin, `(provider, account id)`.
    pub(crate) account: Option<(ProviderId, &'a str)>,
    pub(crate) text: &'a str,
}

#[derive(Debug)]
pub(crate) enum RouteOutcome {
    /// The task runs on the user's plan. No Box exists and none is billed.
    Started {
        record: RunRecord,
        notices: Vec<Notice>,
    },
    /// Run it on the Ryu Box (the existing path, with its admission, caps and cost
    /// notice). `notices` says why a preferred plan was skipped.
    UseBox { notices: Vec<Notice> },
}

/// Decide where a prompt runs, and start it there when that is the user's plan.
pub(crate) async fn start_or_fall_back(
    auth: &ResolvedAuthorization,
    request: RouteRequest<'_>,
) -> Result<RouteOutcome, ApiError> {
    // The plan store keys the node owner by one stable identity, signed in or not.
    let owner = plan_owner(auth, request.owner);
    let request = RouteRequest {
        owner: &owner,
        ..request
    };
    // A conversation already on a plan stays on it: follow up there.
    if let Some(record) = store::run(request.conversation_id) {
        if record.owner != request.owner {
            return Err(api_error(
                StatusCode::CONFLICT,
                "cloud_task_on_subscription",
                "This conversation runs on another account's plan.",
            ));
        }
        // A session belongs to the account that started it: it cannot move.
        if let Some((provider, id)) = request.account {
            let same_provider = record
                .backend
                .provider()
                .is_some_and(|own| ProviderId::from(own) == provider);
            if !same_provider || id != record.account() {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "cloud_task_account_locked",
                    "This conversation runs on another of your accounts. Start a new conversation to use a different account.",
                ));
            }
        }
        return follow_up(record, request.text).await;
    }
    let settings = store::settings(request.owner);
    if let Some((provider, id)) = request.account {
        if !linked(request.owner, provider, id) {
            return Err(api_error(
                StatusCode::NOT_FOUND,
                "subscription_account_not_found",
                "That account is not linked on this node.",
            ));
        }
    }
    let may_use_plan = settings.enabled && caller_is_node_owner(auth) && rollout_allows(auth).await;
    let pinned_plan = request
        .pin
        .backend
        .is_some_and(|backend| backend != CloudTaskBackend::RyuBox);
    if pinned_plan && !caller_is_node_owner(auth) {
        return Err(owner_only());
    }
    if !may_use_plan && !pinned_plan {
        return Ok(RouteOutcome::UseBox {
            notices: Vec::new(),
        });
    }
    let link = settings.environments.get(request.environment_id).cloned();
    let now = unix_now();
    let mut known = BTreeMap::new();
    let mut sign_ins = SignIns::default();
    let mut primary = BTreeMap::new();
    for provider in [Provider::Anthropic, Provider::Openai] {
        let account = chosen_account(
            request.owner,
            &settings,
            provider,
            request.agent_id,
            request.account,
        );
        primary.insert(ProviderId::from(provider), account);
    }
    let account_for = |backend: CloudTaskBackend| {
        backend
            .provider()
            .and_then(|provider| primary.get(&ProviderId::from(provider)))
            .cloned()
    };
    let openai_allowed = openai_plan_allowed(auth).await;
    let mut early_notices: Vec<Notice> = Vec::new();
    for backend in CloudTaskBackend::PLANS {
        let state = if !backend.serves(request.executor) {
            Availability::Disabled
        } else if !may_use_plan {
            // A pin to a plan that is switched off for this caller.
            Availability::Disabled
        } else if backend.provider() == Some(Provider::Openai) && !openai_allowed {
            // A ChatGPT plan on a Ryu-hosted node waits for OpenAI's approval.
            Availability::Disabled
        } else if let Some(account) = account_for(backend) {
            let state = availability(backend, &account, link.as_ref(), now, &mut sign_ins).await;
            let provider = backend.provider().unwrap_or(Provider::Anthropic);
            let stand_in = fallback_accounts(request.owner, &settings, provider, &account.id)
                .iter()
                .any(|other| store::cooldown_remaining(&other.key(provider), now).is_none());
            if state == Availability::CoolingDown && stand_in {
                // The owner listed another account to use while this one is limited.
                let notice = Notice::new(
                    "subscription_cooling_down",
                    backend,
                    format!(
                        "Your {} plan ({}) hit its usage limit recently, so Ryu uses the next account you listed.",
                        backend.plan_name(),
                        account.label
                    ),
                )
                .for_account(&account.id);
                let said = early_notices.iter().any(|known| {
                    known.code == notice.code && known.account_id == notice.account_id
                });
                if !said {
                    early_notices.push(notice);
                }
                Availability::Ready
            } else {
                state
            }
        } else {
            Availability::Disabled
        };
        known.insert(backend, state);
    }
    let agent_order = request
        .agent_id
        .and_then(|agent| settings.agent_overrides.get(agent))
        .map(Vec::as_slice);
    let plan = routing::resolve(
        request.executor,
        request.pin,
        agent_order,
        &settings.default_order,
        |backend| known.get(&backend).copied().unwrap_or(Availability::Ready),
    );
    let mut notices = early_notices;
    notices.extend(plan.notices);
    let candidates = plan.candidates;
    for backend in candidates {
        if backend == CloudTaskBackend::RyuBox {
            return Ok(RouteOutcome::UseBox { notices });
        }
        let (Some(provider), Some(first)) = (backend.provider(), account_for(backend)) else {
            continue;
        };
        // The chosen account first. The owner's listed fallback accounts come next,
        // and only once an account has reached its usage or rate limit (§0b).
        let mut queue = vec![first.clone()];
        queue.extend(fallback_accounts(
            request.owner,
            &settings,
            provider,
            &first.id,
        ));
        for (index, account) in queue.iter().enumerate() {
            let limited = store::cooldown_remaining(&account.key(provider), unix_now()).is_some();
            if index > 0 {
                let state =
                    availability(backend, account, link.as_ref(), unix_now(), &mut sign_ins).await;
                if state != Availability::Ready {
                    if state == Availability::CoolingDown {
                        continue;
                    }
                    break;
                }
            } else if limited {
                // Skipped by routing (or just hit by an earlier backend); its notice
                // is out already. Only a listed fallback account may stand in.
                continue;
            }
            match start(backend, &request, link.as_ref(), account).await {
                Ok(record) => {
                    // A run on this node saved itself and keeps its record current.
                    if !backend.runs_on_node() {
                        store::save_run(record.clone());
                    }
                    return Ok(RouteOutcome::Started { record, notices });
                }
                Err(StartFailure::Fallback(notice)) => {
                    let quota = notice.code == "subscription_quota_fallback";
                    if !notices.iter().any(|known: &Notice| known == &notice) {
                        notices.push(notice);
                    }
                    if !quota {
                        break;
                    }
                }
                Err(StartFailure::Rejected(reason)) => {
                    return Err((
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({"error":{
                            "code":"subscription_run_rejected",
                            "message":format!("{} refused the task: {reason}", backend.cli_name()),
                            "backend":backend,
                        }})),
                    ));
                }
            }
        }
    }
    Err((
        StatusCode::CONFLICT,
        Json(json!({"error":{
            "code":"subscription_backend_unavailable",
            "message":"The backend this task is pinned to cannot run it now.",
            "notices":notices,
        }})),
    ))
}

enum StartFailure {
    /// Try the next backend; tell the user why.
    Fallback(Notice),
    /// The request is wrong; do not fall back to a billed Box.
    Rejected(String),
}

fn failure_notice(
    backend: CloudTaskBackend,
    account: &AccountChoice,
    class: &FailureClass,
    reason: &str,
) -> StartFailure {
    let provider = backend.provider().unwrap_or(Provider::Anthropic);
    match class {
        FailureClass::Quota => {
            store::start_cooldown(&account.key(provider), unix_now());
            StartFailure::Fallback(
                Notice::new(
                    "subscription_quota_fallback",
                    backend,
                    format!(
                        "Your {} plan ({}) reached its usage or rate limit. Ryu tries the next option: another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits.",
                        backend.plan_name(),
                        account.label
                    ),
                )
                .for_account(&account.id),
            )
        }
        FailureClass::SignedOut => StartFailure::Fallback(
            Notice::new(
                "subscription_signed_out",
                backend,
                format!(
                    "{} is not signed in to your {} plan ({}) on this node.",
                    backend.cli_name(),
                    backend.plan_name(),
                    account.label
                ),
            )
            .for_account(&account.id),
        ),
        FailureClass::Unavailable => StartFailure::Fallback(Notice::new(
            "subscription_unavailable",
            backend,
            format!("{} could not start the task: {reason}", backend.cli_name()),
        )),
        FailureClass::Rejected => StartFailure::Rejected(reason.to_owned()),
    }
}

fn cli_failure(backend: CloudTaskBackend, failure: &CliFailure) -> StartFailure {
    let reason = match failure {
        CliFailure::NotInstalled => "it is not installed on this node",
        // The provider may have started the run before the CLI went quiet; a Box
        // fallback could run the task twice, so the user decides.
        CliFailure::TimedOut => {
            return StartFailure::Rejected(format!(
                "it did not answer in time. Check your {} runs before trying again",
                backend.plan_name()
            ))
        }
        CliFailure::Io(_) => "it could not be run",
    };
    StartFailure::Fallback(Notice::new(
        "subscription_unavailable",
        backend,
        format!("{} could not start the task: {reason}.", backend.cli_name()),
    ))
}

fn begin_failure(
    backend: CloudTaskBackend,
    account: &AccountChoice,
    failure: BeginFailure,
    text: &str,
) -> StartFailure {
    match failure {
        BeginFailure::Exited { output } => {
            let reason = cli::failure_reason(&output);
            failure_notice(backend, account, &cli::classify(&output, text), &reason)
        }
        BeginFailure::Cli(failure) => cli_failure(backend, &failure),
        // It may have started; a Box fallback could run the task twice.
        BeginFailure::TimedOut => {
            StartFailure::Rejected("it did not report its session in time".into())
        }
    }
}

/// Start a run on this node (`claude -p` or `codex exec`), in a worktree of the
/// environment's checkout.
async fn start_local(
    backend: CloudTaskBackend,
    request: &RouteRequest<'_>,
    link: Option<&EnvironmentLink>,
    account: &AccountChoice,
) -> Result<RunRecord, StartFailure> {
    let checkout = link
        .and_then(|link| link.claude_checkout.clone())
        .ok_or_else(|| StartFailure::Rejected("no local checkout is set".into()))?;
    let (workspace, branch) =
        local_run::ensure_worktree(std::path::Path::new(&checkout), request.conversation_id)
            .await
            // A checkout Ryu cannot branch is a setup problem on this node, like a
            // missing checkout: try the next backend and say why.
            .map_err(|reason| {
                StartFailure::Fallback(Notice::new(
                    "subscription_not_configured",
                    backend,
                    format!(
                        "Ryu could not make a worktree of this environment's checkout: {reason}"
                    ),
                ))
            })?;
    let now = unix_now();
    let record = RunRecord {
        conversation_id: request.conversation_id.to_owned(),
        owner: request.owner.to_owned(),
        backend,
        environment_id: request.environment_id.to_owned(),
        executor: request.executor.to_owned(),
        account_id: Some(account.id.clone()),
        external_id: None,
        url: None,
        status: "starting".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: Some(workspace.to_string_lossy().into_owned()),
        branch: Some(branch),
        created_at: now,
        updated_at: now,
        result_posted: false,
    };
    local_run::begin(record, request.text)
        .await
        .map_err(|failure| begin_failure(backend, account, failure, request.text))
}

async fn start(
    backend: CloudTaskBackend,
    request: &RouteRequest<'_>,
    link: Option<&EnvironmentLink>,
    account: &AccountChoice,
) -> Result<RunRecord, StartFailure> {
    if backend.runs_on_node() {
        return start_local(backend, request, link, account).await;
    }
    let invocation = match backend {
        CloudTaskBackend::AnthropicSubscriptionCli => {
            let checkout = link
                .and_then(|link| link.claude_checkout.clone())
                .ok_or_else(|| StartFailure::Rejected("no local checkout is set".into()))?;
            cli::claude_start_invocation(checkout.into(), request.text)
        }
        CloudTaskBackend::OpenaiSubscriptionCli => {
            let environment = link
                .and_then(|link| link.codex_environment_id.clone())
                .ok_or_else(|| StartFailure::Rejected("no Codex environment ID is set".into()))?;
            cli::codex_start_invocation(&environment, request.text)
        }
        CloudTaskBackend::RyuBox
        | CloudTaskBackend::AnthropicSubscriptionSdk
        | CloudTaskBackend::OpenaiSubscriptionSdk => {
            return Err(StartFailure::Rejected("not a subscription backend".into()))
        }
    };
    // Codex may not print the new task's id; remember which tasks existed before.
    let before = if backend == CloudTaskBackend::OpenaiSubscriptionCli {
        codex_task_ids(link, &account.id).await
    } else {
        None
    };
    let output = runner()
        .run(invocation.as_account(&account.id))
        .await
        .map_err(|failure| cli_failure(backend, &failure))?;
    let started = match backend {
        CloudTaskBackend::AnthropicSubscriptionCli => cli::parse_claude_started(&output),
        _ if output.succeeded() => Some(cli::parse_codex_started(&output)),
        _ => None,
    };
    let Some(started) = started else {
        let reason = cli::failure_reason(&output);
        return Err(failure_notice(
            backend,
            account,
            &cli::classify(&output, request.text),
            &reason,
        ));
    };
    let now = unix_now();
    let mut record = RunRecord {
        conversation_id: request.conversation_id.to_owned(),
        owner: request.owner.to_owned(),
        backend,
        environment_id: request.environment_id.to_owned(),
        executor: request.executor.to_owned(),
        account_id: Some(account.id.clone()),
        external_id: started.external_id,
        url: started.url,
        status: "submitted".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: None,
        branch: None,
        created_at: now,
        updated_at: now,
        result_posted: false,
    };
    if backend == CloudTaskBackend::OpenaiSubscriptionCli && record.external_id.is_none() {
        refresh_codex(&mut record, link, before.as_ref()).await;
    }
    Ok(record)
}

/// A later prompt in a conversation that already runs on a plan. It never falls back
/// to a Box: the conversation is fenced, and its context lives on the provider.
async fn follow_up(mut record: RunRecord, text: &str) -> Result<RouteOutcome, ApiError> {
    let backend = record.backend;
    // The run's own account, always. A removed account's sessions cannot continue.
    let account = record.account().to_owned();
    if let Some(provider) = backend.provider() {
        if !linked(&record.owner, provider.into(), &account) {
            return Err(api_error(
                StatusCode::CONFLICT,
                "subscription_account_removed",
                "The account this conversation ran on was removed from this node. Start a new conversation.",
            ));
        }
    }
    match backend {
        CloudTaskBackend::AnthropicSubscriptionSdk | CloudTaskBackend::OpenaiSubscriptionSdk => {
            return follow_up_local(record, text).await
        }
        CloudTaskBackend::AnthropicSubscriptionCli => {
            let Some(session) = record.external_id.clone() else {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "subscription_run_unknown",
                    "Ryu did not get this Claude session's ID. Continue it on claude.ai.",
                ));
            };
            let output = runner()
                .run(cli::claude_follow_up_invocation(&session, text).as_account(&account))
                .await
                .map_err(|_| {
                    api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "subscription_unavailable",
                        "Claude Code could not send the follow-up. Try again or continue on claude.ai.",
                    )
                })?;
            if let Err(reason) = cli::parse_claude_follow_up(&output) {
                record.last_error = Some(reason.clone());
                record.updated_at = unix_now();
                store::save_run(record);
                return Err(follow_up_error(backend, &account, &output, text, &reason));
            }
        }
        CloudTaskBackend::OpenaiSubscriptionCli => {
            // Codex has no documented follow-up command; each prompt is a new cloud task
            // in the same Codex environment, tracked as this conversation's latest run.
            let settings = store::settings(&record.owner);
            let link = settings.environments.get(&record.environment_id);
            let environment = link
                .and_then(|link| link.codex_environment_id.clone())
                .ok_or_else(|| {
                    api_error(
                        StatusCode::CONFLICT,
                        "subscription_not_configured",
                        "This environment no longer has a Codex environment ID.",
                    )
                })?;
            let before = codex_task_ids(link, &account).await;
            let output = runner()
                .run(cli::codex_start_invocation(&environment, text).as_account(&account))
                .await
                .map_err(|_| {
                    api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "subscription_unavailable",
                        "Codex could not submit the task. Try again.",
                    )
                })?;
            if !output.succeeded() {
                let reason = cli::failure_reason(&output);
                return Err(follow_up_error(backend, &account, &output, text, &reason));
            }
            let started = cli::parse_codex_started(&output);
            record.external_id = started.external_id;
            record.url = started.url;
            record.status = "submitted".into();
            record.summary = None;
            // A new run on this conversation has a result of its own to post.
            record.result_posted = false;
            if record.external_id.is_none() {
                refresh_codex(&mut record, link, before.as_ref()).await;
            }
        }
        CloudTaskBackend::RyuBox => {}
    }
    record.last_error = None;
    record.updated_at = unix_now();
    store::save_run(record.clone());
    Ok(RouteOutcome::Started {
        record,
        notices: Vec::new(),
    })
}

/// A later message to a run on this node resumes its Claude Code or Codex session in the
/// same worktree, once the last message is done.
async fn follow_up_local(record: RunRecord, text: &str) -> Result<RouteOutcome, ApiError> {
    let backend = record.backend;
    let provider = backend.provider().unwrap_or(Provider::Anthropic);
    let agent = provider.agent_name();
    if local_run::is_running(&record.conversation_id) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "cloud_task_busy",
            &format!(
                "{agent} is still working on the last message. Wait for it to finish, or stop it."
            ),
        ));
    }
    if record.external_id.is_none() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "subscription_run_unknown",
            &format!(
                "Ryu did not get this {agent} session's ID, so it cannot continue it. Start a new conversation."
            ),
        ));
    }
    if !linked(&record.owner, provider.into(), record.account()) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "subscription_account_removed",
            "The account this conversation ran on was removed from this node. Start a new conversation.",
        ));
    }
    let record_account = record.account().to_owned();
    let record_account = record_account.as_str();
    let record = local_run::begin(record, text)
        .await
        .map_err(|failure| match failure {
            BeginFailure::Exited { output } => {
                let reason = cli::failure_reason(&output);
                follow_up_error(backend, record_account, &output, text, &reason)
            }
            BeginFailure::Cli(_) => api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "subscription_unavailable",
                &format!("{agent} could not be run on this node."),
            ),
            BeginFailure::TimedOut => api_error(
                StatusCode::GATEWAY_TIMEOUT,
                "subscription_unavailable",
                &format!(
                    "{agent} did not report its session in time. Check the run before sending again."
                ),
            ),
        })?;
    Ok(RouteOutcome::Started {
        record,
        notices: Vec::new(),
    })
}

fn follow_up_error(
    backend: CloudTaskBackend,
    account: &str,
    output: &cli::CliOutput,
    text: &str,
    reason: &str,
) -> ApiError {
    if cli::classify(output, text) == FailureClass::Quota {
        if let Some(provider) = backend.provider() {
            store::start_cooldown(&accounts::account_key(provider, account), unix_now());
        }
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "subscription_quota",
            &format!(
                "Your {} plan reached its usage or rate limit. This conversation stays on your plan; try again after the limit resets, or start a new conversation to use a Ryu Box.",
                backend.plan_name()
            ),
        );
    }
    api_error(
        StatusCode::BAD_GATEWAY,
        "subscription_follow_up_failed",
        &format!("{} did not take the message: {reason}", backend.cli_name()),
    )
}

/// The ids of the Codex environment's recent tasks for `account`, or `None` when they
/// cannot be read.
async fn codex_task_ids(link: Option<&EnvironmentLink>, account: &str) -> Option<HashSet<String>> {
    let environment = link.and_then(|link| link.codex_environment_id.as_deref())?;
    let output = runner()
        .run(cli::codex_list_invocation(Some(environment)).as_account(account))
        .await
        .ok()?;
    cli::parse_codex_list(&output).map(|tasks| tasks.into_iter().map(|task| task.id).collect())
}

/// Fill a Codex run's id, link, status and summary from `codex cloud list --json`.
///
/// A run without an id adopts a task only when `before` (the ids listed just before the
/// submit) is known and exactly one task is new since then. Otherwise the run keeps no id,
/// so it never claims a task the user started elsewhere.
async fn refresh_codex(
    record: &mut RunRecord,
    link: Option<&EnvironmentLink>,
    before: Option<&HashSet<String>>,
) {
    let Some(environment) = link.and_then(|link| link.codex_environment_id.as_deref()) else {
        return;
    };
    let invocation = cli::codex_list_invocation(Some(environment)).as_account(record.account());
    let Ok(output) = runner().run(invocation).await else {
        return;
    };
    let Some(tasks) = cli::parse_codex_list(&output) else {
        return;
    };
    let task = match (&record.external_id, before) {
        (Some(id), _) => tasks.into_iter().find(|task| &task.id == id),
        (None, Some(before)) => {
            let mut new: Vec<_> = tasks
                .into_iter()
                .filter(|task| !before.contains(&task.id))
                .collect();
            if new.len() == 1 {
                new.pop()
            } else {
                None
            }
        }
        (None, None) => None,
    };
    if let Some(task) = task {
        record.external_id = Some(task.id);
        record.url = task.url.or_else(|| record.url.clone());
        if let Some(status) = task.status {
            record.status = super::redact::scrub(&status);
        }
        record.summary = task.summary.map(|summary| super::redact::scrub(&summary));
        record.updated_at = unix_now();
    }
}

// ── Views ────────────────────────────────────────────────────────────────────

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunView {
    #[serde(flatten)]
    pub(crate) record: RunRecord,
    pub(crate) features: Features,
}

pub(crate) fn run_view(record: RunRecord) -> RunView {
    let features = features(record.backend);
    RunView { record, features }
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendView {
    backend: CloudTaskBackend,
    /// `ryu-credits` or `user-plan`.
    billing: &'static str,
    /// The CLI is on this node's PATH.
    installed: bool,
    sign_in: Option<SignIn>,
    cooldown_seconds_remaining: Option<u64>,
    features: Features,
    /// The command the owner can run on the node to sign in.
    sign_in_command: Option<&'static str>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendsView {
    /// Whether this caller may use the plans signed in on this node.
    owner: bool,
    rollout: bool,
    settings: Option<RoutingSettings>,
    backends: Vec<BackendView>,
}

async fn backend_view(backend: CloudTaskBackend, probe: bool, now: u64) -> BackendView {
    let provider = backend.provider();
    let (installed, sign_in_state) = match provider {
        Some(provider) if probe => {
            match sign_in(provider, super::accounts::DEFAULT_ACCOUNT).await {
                Some(state) => (true, Some(state)),
                None => (false, None),
            }
        }
        Some(_) => (false, None),
        None => (true, None),
    };
    BackendView {
        backend,
        billing: if provider.is_some() {
            "user-plan"
        } else {
            "ryu-credits"
        },
        installed,
        sign_in: sign_in_state,
        cooldown_seconds_remaining: provider.and_then(|provider| {
            store::cooldown_remaining(
                &accounts::account_key(provider, accounts::DEFAULT_ACCOUNT),
                now,
            )
        }),
        features: features(backend),
        sign_in_command: match provider {
            Some(Provider::Anthropic) => Some("claude auth login"),
            Some(Provider::Openai) => Some("codex login"),
            None => None,
        },
    }
}

// ── Routes ───────────────────────────────────────────────────────────────────

pub(crate) fn routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route("/api/cloud-task-backends", get(list_backends))
        .route(
            "/api/cloud-task-backends/routing",
            get(get_routing).put(put_routing),
        )
        .route(
            "/api/cloud-task-backends/:backend/sign-in",
            post(sign_in_backend),
        )
        .route(
            "/api/cloud-task-backends/:backend/cooldown",
            delete(clear_cooldown),
        )
        .merge(super::accounts_api::routes())
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run",
            get(run_status),
        )
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run/stop",
            post(stop_run),
        )
        .route(
            "/api/cloud-tasks/:conversation_id/subscription-run/diff",
            get(run_diff),
        )
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        list_backends,
        get_routing,
        put_routing,
        sign_in_backend,
        clear_cooldown,
        run_status,
        stop_run,
        run_diff
    ),
    components(schemas(
        BackendsView,
        BackendView,
        Features,
        RunView,
        RunRecord,
        RoutingSettings,
        EnvironmentLink,
        CloudTaskBackend,
        SignIn,
        Notice,
        local_run::LocalDiff
    ))
)]
struct SubscriptionCloudApiDoc;

pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    let mut doc = SubscriptionCloudApiDoc::openapi();
    doc.merge(super::accounts_api::AccountsApiDoc::openapi());
    doc
}

pub(super) fn respond<T: Serialize>(result: Result<T, ApiError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(get,path="/api/cloud-task-backends",operation_id="list_cloud_task_backends",tag="Cloud environments",security(("bearerAuth"=[])),description="The backends a cloud task can run on: the Ryu Box (Ryu credits) and, for this node's owner, the Claude Code and Codex CLIs signed in on this node with the owner's own plan. Reports whether each CLI is installed and how it is signed in (read from the CLI's own status command; Ryu never holds the plan's credentials), any usage-limit cooldown, and which session features each backend supports. Other callers get the Ryu Box only.",responses((status=200,body=BackendsView),(status=403,description="Not a personal identity")))]
pub(crate) async fn list_backends(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = plan_owner(&auth, &environments::owner(&auth)?);
            let node_owner = caller_is_node_owner(&auth);
            let rollout = rollout_allows(&auth).await;
            let probe = node_owner && rollout;
            let now = unix_now();
            let mut backends = Vec::new();
            for backend in CloudTaskBackend::ALL {
                if backend != CloudTaskBackend::RyuBox && !probe {
                    continue;
                }
                backends.push(backend_view(backend, probe, now).await);
            }
            Ok(BackendsView {
                owner: node_owner,
                rollout,
                settings: probe.then(|| store::settings(&owner)),
                backends,
            })
        }
        .await,
    )
}

/// The owner key, for a route only the node owner may use with the rollout on.
pub(super) async fn owner_with_plans(auth: &ResolvedAuthorization) -> Result<String, ApiError> {
    let owner = plan_owner(auth, &environments::owner(auth)?);
    if !caller_is_node_owner(auth) {
        return Err(owner_only());
    }
    if !rollout_allows(auth).await {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable",
            "Running cloud tasks on your own plan is not enabled for this account yet.",
        ));
    }
    Ok(owner)
}

#[utoipa::path(get,path="/api/cloud-task-backends/routing",operation_id="get_cloud_task_routing",tag="Cloud environments",security(("bearerAuth"=[])),description="The node owner's cloud task routing: whether their own plans are used, the default backend order, per-agent orders, and each environment's local checkout (Claude) or Codex environment ID. Node owner only.",responses((status=200,body=RoutingSettings),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn get_routing(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            Ok(store::settings(&owner))
        }
        .await,
    )
}

const MAX_AGENT_OVERRIDES: usize = 64;
const MAX_ENVIRONMENT_LINKS: usize = 256;

fn validate_order(order: &[CloudTaskBackend]) -> Result<(), ApiError> {
    let mut seen = Vec::new();
    for backend in order {
        if seen.contains(backend) {
            return Err(bad_request("A backend order lists a backend twice."));
        }
        seen.push(*backend);
    }
    if order.is_empty() {
        return Err(bad_request("A backend order needs at least one backend."));
    }
    Ok(())
}

pub(super) fn bad_request(message: &str) -> ApiError {
    api_error(StatusCode::BAD_REQUEST, "invalid_request", message)
}

/// Every account a routing choice names must be the default sign-in or linked, and
/// the explicit fallback lists stay short and free of repeats.
fn validate_accounts(owner: &str, settings: &RoutingSettings) -> Result<(), ApiError> {
    let unknown =
        || bad_request("A routing choice names an account that is not linked on this node.");
    for (provider, id) in &settings.default_accounts {
        if !linked(owner, *provider, id) {
            return Err(unknown());
        }
    }
    if settings.agent_accounts.len() > MAX_AGENT_OVERRIDES {
        return Err(bad_request("Too many per-agent accounts."));
    }
    for (agent, choice) in &settings.agent_accounts {
        if agent.is_empty() || agent.len() > 128 {
            return Err(bad_request("An agent ID must be 1-128 characters."));
        }
        if choice
            .iter()
            .any(|(provider, id)| !linked(owner, *provider, id))
        {
            return Err(unknown());
        }
    }
    for (provider, order) in &settings.account_fallbacks {
        if order.len() > accounts::MAX_ACCOUNTS_PER_PROVIDER + 1 {
            return Err(bad_request("A fallback list is too long."));
        }
        let mut seen = Vec::new();
        for id in order {
            if seen.contains(&id) {
                return Err(bad_request("A fallback list names an account twice."));
            }
            seen.push(id);
            if !linked(owner, *provider, id) {
                return Err(unknown());
            }
        }
    }
    Ok(())
}

fn validate_settings(settings: &RoutingSettings) -> Result<(), ApiError> {
    validate_order(&settings.default_order)?;
    if settings.agent_overrides.len() > MAX_AGENT_OVERRIDES
        || settings.environments.len() > MAX_ENVIRONMENT_LINKS
    {
        return Err(bad_request("Too many agent overrides or environments."));
    }
    for (agent, order) in &settings.agent_overrides {
        if agent.is_empty() || agent.len() > 128 {
            return Err(bad_request("An agent ID must be 1-128 characters."));
        }
        validate_order(order)?;
    }
    for (environment, link) in &settings.environments {
        if environment.is_empty() || environment.len() > 128 {
            return Err(bad_request("An environment ID must be 1-128 characters."));
        }
        if let Some(checkout) = &link.claude_checkout {
            if checkout.len() > 4096 || !checkout_is_usable(checkout) {
                return Err(bad_request(
                    "A Claude checkout must be the absolute path of a git checkout on this node.",
                ));
            }
        }
        if let Some(id) = &link.codex_environment_id {
            if !codex_environment_id_ok(id) {
                return Err(bad_request(
                    "A Codex environment ID is 1-128 letters, digits, '-' or '_'.",
                ));
            }
        }
    }
    Ok(())
}

#[utoipa::path(put,path="/api/cloud-task-backends/routing",operation_id="put_cloud_task_routing",tag="Cloud environments",security(("bearerAuth"=[])),request_body=RoutingSettings,description="Replace the node owner's cloud task routing. Orders may not repeat a backend; the Ryu Box is always the last fallback unless a session pins a backend strictly. A Claude checkout must be an absolute path to a git checkout on this node. Node owner only.",responses((status=200,body=RoutingSettings),(status=400,description="invalid_request"),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable")))]
pub(crate) async fn put_routing(
    Extension(auth): Extension<ResolvedAuthorization>,
    body: axum::body::Bytes,
) -> Response {
    respond(
        async {
            let owner = owner_with_plans(&auth).await?;
            let settings: RoutingSettings = serde_json::from_slice(&body)
                .map_err(|_| bad_request("The routing settings are invalid."))?;
            validate_settings(&settings)?;
            validate_accounts(&owner, &settings)?;
            store::save_settings(&owner, settings.clone());
            Ok(settings)
        }
        .await,
    )
}

fn subscription_backend(raw: &str) -> Result<(CloudTaskBackend, Provider), ApiError> {
    CloudTaskBackend::parse(raw)
        .and_then(|backend| backend.provider().map(|provider| (backend, provider)))
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "subscription_backend_not_found",
                "Unknown subscription backend.",
            )
        })
}

/// One CLI sign-in per account per minute, so repeated clicks do not pile up login
/// processes on the node.
pub(super) fn sign_in_slot_free(key: &str) -> bool {
    static LAST: std::sync::LazyLock<std::sync::Mutex<BTreeMap<String, std::time::Instant>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = std::time::Instant::now();
    last.retain(|_, started| now.duration_since(*started) < std::time::Duration::from_secs(60));
    if last.contains_key(key) {
        return false;
    }
    last.insert(key.to_owned(), now);
    true
}

#[utoipa::path(post,path="/api/cloud-task-backends/{backend}/sign-in",operation_id="sign_in_cloud_task_backend",tag="Cloud environments",security(("bearerAuth"=[])),params(("backend"=String,Path,description="anthropic-subscription-cli or openai-subscription-cli")),description="Start the provider CLI's own sign-in (`claude auth login` or `codex login`) on this node. The CLI opens the provider's sign-in page in the browser; Ryu captures none of its input or output and never receives the credential. Poll `GET /api/cloud-task-backends` for the result. Node owner only.",responses((status=202,description="The CLI's sign-in started"),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable"),(status=404,description="subscription_backend_not_found"),(status=503,description="subscription_cli_missing: the CLI is not installed")))]
pub(crate) async fn sign_in_backend(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(raw): Path<String>,
) -> Response {
    let started: Result<Value, ApiError> = async {
        owner_with_plans(&auth).await?;
        let (backend, provider) = subscription_backend(&raw)?;
        if !sign_in_slot_free(&accounts::account_key(provider, accounts::DEFAULT_ACCOUNT)) {
            return Err(api_error(
                StatusCode::TOO_MANY_REQUESTS,
                "subscription_sign_in_pending",
                "A sign-in for this CLI just started. Finish it in your browser, or wait a minute and try again.",
            ));
        }
        runner()
            .spawn_detached(cli::sign_in_invocation(provider))
            .map_err(|_| {
                api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "subscription_cli_missing",
                    &format!("{} is not installed on this node.", backend.cli_name()),
                )
            })?;
        Ok(json!({"backend":backend,"started":true}))
    }
    .await;
    match started {
        Ok(body) => (StatusCode::ACCEPTED, Json(body)).into_response(),
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(delete,path="/api/cloud-task-backends/{backend}/cooldown",operation_id="clear_cloud_task_backend_cooldown",tag="Cloud environments",security(("bearerAuth"=[])),params(("backend"=String,Path,description="anthropic-subscription-cli or openai-subscription-cli")),description="Clear the usage-limit cooldown of this node's default sign-in for the backend's provider, so the next task tries it again. Linked accounts clear theirs at `DELETE /api/cloud-task-backends/accounts/{provider}/{id}/cooldown`. Node owner only.",responses((status=200,body=Value),(status=403,description="subscription_backend_owner_only or cloud_environment_feature_unavailable"),(status=404,description="subscription_backend_not_found")))]
pub(crate) async fn clear_cooldown(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(raw): Path<String>,
) -> Response {
    respond(
        async {
            owner_with_plans(&auth).await?;
            let (backend, provider) = subscription_backend(&raw)?;
            store::clear_cooldown(&accounts::account_key(provider, accounts::DEFAULT_ACCOUNT));
            Ok(json!({"backend":backend,"cooldown":null}))
        }
        .await,
    )
}

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}/subscription-run",operation_id="get_cloud_task_subscription_run",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose cloud task runs on the caller's own plan")),description="The caller's cloud task that runs on their own Claude or ChatGPT plan: backend, the provider's session or task ID and link, status (Codex reports it; a Claude cloud session is tracked on claude.ai and stays `submitted`), Codex's summary, the last error (redacted), and which session features the backend supports. A run owned by another caller reads as not found.",responses((status=200,body=RunView),(status=400,description="Invalid conversation ID"),(status=403,description="Not a personal identity"),(status=404,description="subscription_run_not_found")))]
pub(crate) async fn run_status(
    axum::extract::State(state): axum::extract::State<crate::server::ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (owner, mut record) = owned_run(&auth, &conversation_id)?;
            if record.backend == CloudTaskBackend::OpenaiSubscriptionCli {
                let settings = store::settings(&owner);
                let link = settings.environments.get(&record.environment_id).cloned();
                refresh_codex(&mut record, link.as_ref(), None).await;
                store::save_run(record.clone());
            }
            post_result_once(&state, &auth, &mut record).await;
            Ok(run_view(record))
        }
        .await,
    )
}

/// Statuses after which a run has a result to show.
fn finished(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "stopped" | "ready" | "done" | "succeeded" | "error"
    )
}

/// Post a finished run's result into its conversation once, as an assistant message,
/// so everyone who can read the conversation (teammates included) sees it. Only the
/// account's owner can continue the run.
async fn post_result_once(
    state: &crate::server::ServerState,
    auth: &ResolvedAuthorization,
    record: &mut RunRecord,
) {
    if record.result_posted || !finished(&record.status) {
        return;
    }
    let tag = record
        .backend
        .provider()
        .map_or_else(String::new, |provider| {
            format!(
                "{} · {}",
                ProviderId::from(provider).product(),
                account_label(&record.owner, provider, record.account())
            )
        });
    let body = record
        .summary
        .clone()
        .or_else(|| record.last_error.clone())
        .unwrap_or_else(|| format!("The task {}.", record.status));
    let text = format!("{tag}: {body}");
    // Only the node owner reads a plan run (§0.3), so the message carries the tenancy
    // the start message did: the owner's own, signed in or not.
    let tenancy = crate::server::caller_tenancy(&auth.caller);
    if state
        .conversations
        .append_message_as(
            &record.conversation_id,
            "assistant",
            &text,
            None,
            None,
            None,
            tenancy,
        )
        .await
        .is_ok()
    {
        record.result_posted = true;
        store::save_run(record.clone());
    }
}

/// The caller's run for this conversation; another caller's run reads as not found.
fn owned_run(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<(String, RunRecord), ApiError> {
    let owner = plan_owner(auth, &environments::owner(auth)?);
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        return Err(bad_request("A valid conversation ID is required."));
    }
    let not_found = || {
        api_error(
            StatusCode::NOT_FOUND,
            "subscription_run_not_found",
            "This conversation has no cloud task on your plan.",
        )
    };
    let record = store::run(conversation_id).ok_or_else(not_found)?;
    if record.owner != owner {
        return Err(not_found());
    }
    Ok((owner, record))
}

fn local_only(record: &RunRecord) -> Result<(), ApiError> {
    if record.backend.runs_on_node() {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::CONFLICT,
            "subscription_run_remote",
            "This task runs in the provider's cloud. Review or stop it on the provider's site.",
        ))
    }
}

#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/subscription-run/stop",operation_id="stop_cloud_task_subscription_run",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose task runs on this node on the caller's own Claude or ChatGPT plan")),description="Stop the Claude Code or Codex run on this node for this conversation. Its worktree and branch are kept. Runs in the provider's cloud are stopped on the provider's site.",responses((status=200,body=Value),(status=404,description="subscription_run_not_found"),(status=409,description="subscription_run_remote")))]
pub(crate) async fn stop_run(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (_, record) = owned_run(&auth, &conversation_id)?;
            local_only(&record)?;
            Ok(json!({"stopped": local_run::stop(&conversation_id)}))
        }
        .await,
    )
}

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}/subscription-run/diff",operation_id="get_cloud_task_subscription_run_diff",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose task runs on this node on the caller's own Claude or ChatGPT plan")),description="The changes the Claude Code or Codex run on this node made in its worktree: the branch, `git status --porcelain` lines, and the patch against the commit it started from (new files included, cut at 512 KiB).",responses((status=200,body=local_run::LocalDiff),(status=404,description="subscription_run_not_found"),(status=409,description="subscription_run_remote"),(status=502,description="subscription_diff_failed")))]
pub(crate) async fn run_diff(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (_, record) = owned_run(&auth, &conversation_id)?;
            local_only(&record)?;
            local_run::diff(&record).await.map_err(|reason| {
                api_error(StatusCode::BAD_GATEWAY, "subscription_diff_failed", &reason)
            })
        }
        .await,
    )
}

/// Whether a prompt could run on the node owner's plan at all, without asking any CLI:
/// the executor is a provider agent, the caller is the node owner with the rollout on,
/// and the owner turned plans on (or the session pins one).
pub(crate) async fn may_try_plan(
    auth: &ResolvedAuthorization,
    owner: &str,
    conversation_id: &str,
    executor: &str,
    pin: Option<CloudTaskBackend>,
) -> bool {
    let owner = plan_owner(auth, owner);
    let owner = owner.as_str();
    // A conversation already on a plan always continues there (it is fenced from Boxes).
    if store::run(conversation_id).is_some_and(|record| record.owner == owner) {
        return true;
    }
    let served = CloudTaskBackend::PLANS
        .into_iter()
        .any(|backend| backend.serves(executor));
    let pinned_plan = pin.is_some_and(|backend| backend != CloudTaskBackend::RyuBox);
    served
        && (store::settings(owner).enabled || pinned_plan)
        && caller_is_node_owner(auth)
        && rollout_allows(auth).await
}
