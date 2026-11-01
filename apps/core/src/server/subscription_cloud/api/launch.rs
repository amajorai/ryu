//! Starting a new run on a plan, and how a failed start falls back.

use super::super::cli::{self, CliFailure, FailureClass};
use super::super::local_run::{self, BeginFailure};
use super::super::routing::Notice;
use super::super::store::{self, EnvironmentLink, RunRecord};
use super::super::{runner, unix_now, CloudTaskBackend, Provider};
use super::availability::AccountChoice;
use super::follow_up::{codex_task_ids, refresh_codex};
use super::start::RouteRequest;

pub(super) enum StartFailure {
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

pub(super) async fn start(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn work_account() -> AccountChoice {
        AccountChoice {
            id: "work".into(),
            label: "Work".into(),
        }
    }

    #[test]
    fn a_rejected_start_never_falls_back_to_a_billed_box() {
        let failure = failure_notice(
            CloudTaskBackend::AnthropicSubscriptionCli,
            &work_account(),
            &FailureClass::Rejected,
            "unknown repository",
        );
        match failure {
            StartFailure::Rejected(reason) => assert_eq!(reason, "unknown repository"),
            StartFailure::Fallback(notice) => panic!("fell back: {}", notice.code),
        }
    }

    #[test]
    fn a_signed_out_start_falls_back_with_a_notice_about_that_account() {
        let failure = failure_notice(
            CloudTaskBackend::AnthropicSubscriptionCli,
            &work_account(),
            &FailureClass::SignedOut,
            "",
        );
        let StartFailure::Fallback(notice) = failure else {
            panic!("expected a fallback");
        };
        assert_eq!(notice.code, "subscription_signed_out");
        assert_eq!(notice.account_id.as_deref(), Some("work"));
        assert!(notice.message.contains("(Work)"), "{}", notice.message);
    }

    #[test]
    fn an_unavailable_cli_falls_back_with_its_reason() {
        let failure = failure_notice(
            CloudTaskBackend::OpenaiSubscriptionCli,
            &work_account(),
            &FailureClass::Unavailable,
            "network down",
        );
        let StartFailure::Fallback(notice) = failure else {
            panic!("expected a fallback");
        };
        assert_eq!(notice.code, "subscription_unavailable");
        assert_eq!(notice.account_id, None);
        assert_eq!(
            notice.message,
            "Codex CLI could not start the task: network down"
        );
    }
}
