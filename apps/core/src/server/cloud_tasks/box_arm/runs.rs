//! Managed agent prompt runs in the task's Box and their poller.

use super::git::{prompt_text, redact, relative_cwd, tail};
use super::*;

/// Variables that make the Codex CLI bill an OpenAI API key instead of a ChatGPT plan.
pub(super) const OPENAI_KEY_VARIABLES: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/// A Codex run in a Box with no OpenAI key bound would use the ChatGPT plan the user
/// signed in to inside the Box. That is a hosted app using a ChatGPT plan, which OpenAI
/// must approve first, so it waits for `cloud_tasks.subscription_backends_hosted_openai`
/// (docs/subscription-cloud-sessions.md §0c). Claude Code in a Box with the user's own
/// sign-in to the unmodified binary is allowed, and a Codex run with a bound key is
/// ordinary API use.
pub(super) fn chatgpt_plan_refusal(
    executor: &str,
    box_env: &[(String, String)],
    allowed: bool,
) -> Option<ApiError> {
    let has_key = box_env
        .iter()
        .any(|(key, value)| OPENAI_KEY_VARIABLES.contains(&key.as_str()) && !value.is_empty());
    (executor == "codex" && !has_key && !allowed).then(|| {
        api_error_code(
            StatusCode::FORBIDDEN,
            "chatgpt_plan_in_box_unavailable",
            "Codex in a Ryu Box needs an OpenAI API key bound to this environment. Using your ChatGPT plan inside a Ryu Box is not available yet.",
        )
    })
}

pub(super) fn managed_env(
    box_env: &[(String, String)],
    git_env_keys: &[String],
) -> Vec<(String, String)> {
    box_env
        .iter()
        .filter(|(key, _)| !git_env_keys.contains(key))
        .cloned()
        .collect()
}

pub(super) fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Start a managed prompt in the task's Box and spawn its poller. The busy
/// check and the run reservation happen under the slot lock.
pub(in crate::server::cloud_tasks) async fn start_managed_run(
    slot: TaskSlot,
    conversations: ConversationStore,
    tenancy: Tenancy,
    executor: String,
    text: &str,
    chatgpt_plan_allowed: bool,
) -> Result<(String, String), ApiError> {
    let routing = crate::local_egress::entry::routing_active().await;
    let mut state = slot.lock().await;
    let TaskState::Ready(task) = &mut *state else {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_not_ready",
            "The cloud task is not ready.",
        ));
    };
    if task.active_run.is_some() || task.finishing {
        return Err(busy());
    }
    let mismatch = || {
        api_error_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_task_executor_mismatch",
            "This cloud environment runs Ryu. Send prompts from chat.",
        )
    };
    let TaskWorkspace::Box(workspace) = &task.workspace else {
        return Err(mismatch());
    };
    if let Some(refusal) = desktop_routing_refusal(task.profile.network, routing) {
        return Err(refusal);
    }
    let provider = ManagedProvider::from_executor(&task.context.executor).ok_or_else(mismatch)?;
    if let Some(refusal) = chatgpt_plan_refusal(
        &task.context.executor,
        &task.profile.box_env,
        chatgpt_plan_allowed,
    ) {
        return Err(refusal);
    }
    let remaining = task.expires_at.saturating_sub(now().unwrap_or(u64::MAX));
    let timeout_secs = remaining
        .saturating_sub(60)
        .min(MAX_MANAGED_TIMEOUT_SECONDS);
    if timeout_secs < MIN_MANAGED_TIMEOUT_SECONDS {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_not_ready",
            "The cloud task expires too soon to start another run.",
        ));
    }
    let spec = ManagedPromptSpec {
        provider,
        text: prompt_text(&task.context.start_instructions, text),
        cwd: relative_cwd(&task.context.working_directory),
        env: managed_env(&task.profile.box_env, &task.profile.git_env_keys),
        timeout_secs,
    };
    let unavailable = || {
        api_error_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_backend_unavailable",
            "The cloud box could not start the agent. Try again.",
        )
    };
    let client = session_box::box_client().await.map_err(|_| unavailable())?;
    let view = client
        .start_prompt(workspace, &spec)
        .await
        .map_err(|_| unavailable())?;
    let status = if view.status == "running" {
        "running"
    } else {
        "queued"
    };
    task.active_run = Some(ActiveRun {
        id: view.id.clone(),
        status: status.to_owned(),
        process_id: view.process_id.clone(),
        started_at: rfc3339_now(),
        output_tail: String::new(),
        next_seq: 0,
    });
    drop(state);
    tokio::spawn(poll_run(
        slot,
        conversations,
        tenancy,
        executor,
        view.id.clone(),
    ));
    Ok((view.id, status.to_owned()))
}

/// Box traffic cannot go through the user's desktop route (only Docker task
/// containers can reach it), so a networked Box action refuses while "Route
/// traffic through this computer" is on, failing closed like `LiveTask::run`.
pub(in crate::server::cloud_tasks) fn desktop_routing_refusal(
    network: bool,
    routing: bool,
) -> Option<ApiError> {
    (network && routing).then(|| {
        api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_desktop_routing",
            "This cloud box cannot route through your desktop. Turn off \"Route traffic through this computer\" to run it from the cloud.",
        )
    })
}

pub(in crate::server::cloud_tasks) fn busy() -> ApiError {
    api_error_code(
        StatusCode::CONFLICT,
        "cloud_task_busy",
        "The cloud task is busy. Wait for the current run to finish.",
    )
}

pub(super) struct PollTarget {
    workspace: WorkspaceId,
    process_id: Option<String>,
    next_seq: u64,
    redactions: Vec<String>,
    conversation_id: String,
}

pub(super) fn poll_target(state: &TaskState, run_id: &str) -> Option<PollTarget> {
    let TaskState::Ready(task) = state else {
        return None;
    };
    let (TaskWorkspace::Box(workspace), Some(run)) = (&task.workspace, &task.active_run) else {
        return None;
    };
    (run.id == run_id).then(|| PollTarget {
        workspace: workspace.clone(),
        process_id: run.process_id.clone(),
        next_seq: run.next_seq,
        redactions: task.profile.task_redactions.clone(),
        conversation_id: task.conversation_id.clone(),
    })
}

/// Poll a run every two seconds without holding the slot lock across the
/// sleep or the Box calls. Stops when the task is stopped or destroyed.
pub(super) async fn poll_run(
    slot: TaskSlot,
    conversations: ConversationStore,
    tenancy: Tenancy,
    executor: String,
    run_id: String,
) {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let Some(target) = poll_target(&*slot.lock().await, &run_id) else {
            return;
        };
        let Ok(client) = session_box::box_client().await else {
            continue;
        };
        let Ok(view) = client.prompt_run(&target.workspace, &run_id).await else {
            continue;
        };
        let process_id = view.process_id.clone().or(target.process_id);
        let page = match &process_id {
            Some(process_id) => client
                .process_output_after(&target.workspace, process_id, target.next_seq)
                .await
                .ok(),
            None => None,
        };
        let message = {
            let mut state = slot.lock().await;
            let TaskState::Ready(task) = &mut *state else {
                return;
            };
            let Some(run) = task.active_run.as_mut().filter(|run| run.id == run_id) else {
                return;
            };
            run.process_id = process_id;
            if view.status == "running" {
                run.status = "running".into();
            }
            if let Some(page) = page {
                let mut output = std::mem::take(&mut run.output_tail);
                for chunk in page.chunks {
                    run.next_seq = run.next_seq.max(chunk.seq);
                    output.push_str(&chunk.data);
                }
                // Redact the whole tail so a secret split across chunks is caught.
                run.output_tail = tail(redact(&output, &target.redactions), OUTPUT_TAIL_CHARS);
            }
            if view.is_terminal() {
                task.active_run = None;
                let last = last_run(view, &target.redactions);
                let message = run_event(
                    last.summary.as_deref(),
                    last.exit_code,
                    last.reason.as_deref(),
                );
                task.last_run = Some(last);
                Some(message)
            } else {
                None
            }
        };
        if let Some(event) = message {
            if event
                .append(
                    &conversations,
                    &target.conversation_id,
                    Some(&format!("cloud:{executor}")),
                    tenancy,
                )
                .await
                .is_err()
            {
                tracing::warn!("Cloud task run summary could not be saved to the conversation");
            }
            return;
        }
    }
}

pub(super) fn last_run(view: PromptRunView, redactions: &[String]) -> LastRun {
    LastRun {
        status: if view.status == "completed" {
            "completed".into()
        } else {
            "failed".into()
        },
        id: view.id,
        exit_code: view.exit_code,
        summary: view.summary.map(|summary| {
            redact(&summary, redactions)
                .chars()
                .take(MAX_SUMMARY_CHARS)
                .collect()
        }),
        reason: view.reason,
        completed_at: view.completed_at,
    }
}
