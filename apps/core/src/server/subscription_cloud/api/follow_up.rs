//! Later prompts in a conversation that already runs on a plan, and Codex task refresh.

use super::super::accounts;
use super::super::cli::{self, FailureClass};
use super::super::local_run::{self, BeginFailure};
use super::super::store::{self, EnvironmentLink, RunRecord};
use super::super::{runner, unix_now, CloudTaskBackend, Provider};
use super::availability::linked;
use super::start::RouteOutcome;
use super::{api_error, ApiError};
use axum::http::StatusCode;
use std::collections::HashSet;

/// A later prompt in a conversation that already runs on a plan. It never falls back
/// to a Box: the conversation is fenced, and its context lives on the provider.
pub(super) async fn follow_up(mut record: RunRecord, text: &str) -> Result<RouteOutcome, ApiError> {
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
pub(super) async fn codex_task_ids(
    link: Option<&EnvironmentLink>,
    account: &str,
) -> Option<HashSet<String>> {
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
pub(super) async fn refresh_codex(
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
            record.status = super::super::redact::scrub(&status);
        }
        record.summary = task
            .summary
            .map(|summary| super::super::redact::scrub(&summary));
        record.updated_at = unix_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_follow_up_that_is_not_a_usage_limit_reports_the_cli_reason() {
        let output = cli::CliOutput {
            exit_code: Some(1),
            stdout: "boom".into(),
            stderr: String::new(),
        };
        let (status, body) = follow_up_error(
            CloudTaskBackend::AnthropicSubscriptionCli,
            "default",
            &output,
            "fix the tests",
            "boom",
        );
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body.0["error"]["code"], "subscription_follow_up_failed");
        assert_eq!(
            body.0["error"]["message"],
            "Claude Code did not take the message: boom"
        );
    }
}
