//! Cloud tasks run on the node owner's own node, signed in with their own plan:
//! - `anthropic-subscription-sdk`: Claude Code's headless runtime (`claude -p`, the
//!   runtime the Claude Agent SDK drives), on their Claude plan;
//! - `openai-subscription-sdk`: Codex's headless runtime (`codex exec`, the runtime the
//!   Codex SDK drives), on their ChatGPT plan.
//!
//! Compliance (docs/subscription-cloud-sessions.md §2.1a): the support article updated
//! on October 7, 2026 says the Agent SDK, `claude -p` and third-party apps can still run
//! against the subscriber's plan limits. The Claude Code legal page still allows "an end
//! user ... signing in to the unmodified Claude Code binary with their own Claude
//! subscription". So Ryu runs that unmodified binary, with the sign-in the owner made
//! in it, through the same allowlisted environment as the cloud backends
//! ([`super::cli::child_env`]). Ryu never reads, stores or forwards the credential.
//!
//! For Codex (§0d): OpenAI's non-interactive docs say "`codex exec` reuses saved CLI
//! authentication by default", and a ChatGPT plan is allowed for open-source and locally
//! hosted apps. So the same rule holds: the unmodified `codex` binary, signed in by the
//! owner through `codex login`, with the account's own `CODEX_HOME`. Ryu never opens
//! `auth.json`. On a Ryu-managed node it is hosted use and stays behind
//! `cloud_tasks.subscription_backends_hosted_openai` ([`super::openai_plan_allowed`]).
//!
//! Each conversation works in its own git worktree, on a `ryu/task-…` branch of the
//! owner's checkout, so the agent never edits the checkout the owner works in. Nobody
//! is there to approve anything, so each runtime runs with its narrowest headless mode:
//! - Claude Code accepts edits without asking (`--permission-mode acceptEdits`); every
//!   other tool that needs permission (shell commands, web fetches) is refused.
//! - Codex runs in its `workspace-write` sandbox with approvals set to `never`: it may
//!   write in the worktree (and its temp folder) and run commands there, but those
//!   commands get no network. Codex's own calls to OpenAI are not sandboxed.
//!
//! Billing: none in Ryu. The run counts toward the owner's Claude or ChatGPT plan limits.

use super::cli::{self, CliFailure, CliOutput, Invocation, Streaming};
use super::redact;
use super::store::{self, RunRecord};
use super::{runner, unix_now, Provider};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// How much of the run's own words (assistant text and tool names) Ryu keeps.
const OUTPUT_TAIL_BYTES: usize = 8 * 1024;
const SUMMARY_BYTES: usize = 4 * 1024;
/// A run that does not report its session within this long is stopped.
const INIT_WAIT: Duration = Duration::from_secs(60);
/// How long a run that has reported its session is watched for a turn that fails before
/// it does anything: a usage limit only shows once the turn reaches the model, after the
/// session is reported.
const FIRST_TURN_WAIT: Duration = Duration::from_secs(10);
/// The longest one prompt may run.
const RUN_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
/// How often a running task's record is written while it prints.
const SAVE_EVERY: Duration = Duration::from_secs(2);
const MAX_DIFF_BYTES: usize = 512 * 1024;

static SESSION_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_\-]{8,64}$").expect("static pattern"));

/// The runs in progress, by conversation, so Ryu can stop them.
static RUNNING: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(Default::default);

fn running() -> std::sync::MutexGuard<'static, HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn is_running(conversation_id: &str) -> bool {
    running().contains_key(conversation_id)
}

/// Stop the conversation's run, if one is in progress. Returns whether one was.
pub(crate) fn stop(conversation_id: &str) -> bool {
    running()
        .remove(conversation_id)
        .is_some_and(|kill| kill.send(()).is_ok())
}

/// The headless run for `provider`, in the task's worktree.
pub(crate) fn invocation(
    provider: Provider,
    workspace: &Path,
    resume: Option<&str>,
    text: &str,
) -> Invocation {
    match provider {
        Provider::Anthropic => claude_invocation(workspace, resume, text),
        Provider::Openai => codex_invocation(workspace, resume, text),
    }
}

/// `claude -p --output-format stream-json --verbose --permission-mode acceptEdits
/// [--resume <session>] -- "<text>"`.
fn claude_invocation(workspace: &Path, resume: Option<&str>, text: &str) -> Invocation {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if let Some(session) = resume {
        args.push("--resume".into());
        args.push(session.into());
    }
    args.push("--".into());
    args.push(cli::as_text_argument(text));
    Invocation {
        provider: Provider::Anthropic,
        args,
        cwd: Some(workspace.to_path_buf()),
        timeout: RUN_TIMEOUT,
        stop_when: None,
        account_dir: None,
    }
}

/// `codex exec --json --ignore-user-config --ignore-rules --sandbox workspace-write
/// -c approval_policy="never" -c sandbox_workspace_write.network_access=false
/// -c web_search="disabled" --skip-git-repo-check [resume <session>] -- "<text>"`.
///
/// Checked against the Codex CLI source (`codex-rs/exec/src/cli.rs`,
/// `codex-rs/core/src/config/mod.rs`, October 2026), not a live binary: `--json` prints
/// JSONL events; `resume <SESSION_ID> [PROMPT]` is a subcommand of `exec`. `--sandbox` is
/// not a global flag, so every option goes before `resume`, and the resumed session
/// inherits it. Headless `exec` already defaults approvals to `never` and
/// `workspace-write` to no network; Ryu says both anyway.
///
/// The account's `config.toml` is not loaded (`--ignore-user-config`; sign-in still comes
/// from `CODEX_HOME`): `-c` overrides merge into its tables rather than replace them, so
/// that is the only way to keep its `[mcp_servers]`, plugins and other tools out of an
/// unattended run. MCP servers run outside the shell sandbox, with their own network
/// and tokens, and `never` would let them act unasked. `--ignore-rules` drops execpolicy
/// rules that could let a command past the sandbox, and web search is switched off. A
/// repository's own `.codex/config.toml` is only read for a project the user config marks
/// trusted, which no longer applies (from the source, not verified against a binary).
/// Older releases printed another JSON shape for `--json`; their runs never report a
/// session and fail to start.
fn codex_invocation(workspace: &Path, resume: Option<&str>, text: &str) -> Invocation {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "workspace-write",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "web_search=\"disabled\"",
        // Ryu always runs in its own git worktree, so the trusted-repository check adds
        // nothing; skipping it keeps a worktree's `.git` file from ever being a refusal.
        "--skip-git-repo-check",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if let Some(session) = resume {
        args.push("resume".into());
        args.push(session.into());
    }
    args.push("--".into());
    args.push(cli::as_text_argument(text));
    Invocation {
        provider: Provider::Openai,
        args,
        cwd: Some(workspace.to_path_buf()),
        timeout: RUN_TIMEOUT,
        stop_when: None,
        account_dir: None,
    }
}

// ── The stream ───────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Init {
        session_id: String,
    },
    /// Words for the run log: assistant text, or `→ Tool` for a tool call.
    Log(String),
    /// An agent message that is also the run's answer so far (Codex reports no result
    /// text, so its last message is the summary).
    Reply(String),
    Result {
        is_error: bool,
        text: Option<String>,
    },
    /// An error the CLI may still recover from (Codex retries a dropped stream). Only a
    /// failed turn or a failed exit makes it the run's error.
    StreamError(Option<String>),
    Other,
}

/// One line of the run's output. Anything Ryu does not recognize is ignored, so a newer
/// CLI that adds event types keeps working.
pub(crate) fn parse_event(provider: Provider, line: &str) -> Event {
    match provider {
        Provider::Anthropic => parse_claude_event(line),
        Provider::Openai => parse_codex_event(line),
    }
}

/// One line of `claude -p --output-format stream-json`.
fn parse_claude_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Event::Other;
    };
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("system") if value.get("subtype").and_then(|kind| kind.as_str()) == Some("init") => {
            match value.get("session_id").and_then(|id| id.as_str()) {
                Some(id) if SESSION_ID.is_match(id) => Event::Init {
                    session_id: id.to_owned(),
                },
                _ => Event::Other,
            }
        }
        Some("assistant") => {
            let mut words = Vec::new();
            let content = value
                .pointer("/message/content")
                .and_then(|content| content.as_array());
            for block in content.into_iter().flatten() {
                match block.get("type").and_then(|kind| kind.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
                            words.push(text.trim().to_owned());
                        }
                    }
                    Some("tool_use") => {
                        if let Some(name) = block.get("name").and_then(|name| name.as_str()) {
                            words.push(format!("→ {name}"));
                        }
                    }
                    _ => {}
                }
            }
            if words.is_empty() {
                Event::Other
            } else {
                Event::Log(words.join("\n"))
            }
        }
        Some("result") => Event::Result {
            is_error: value
                .get("is_error")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            text: value
                .get("result")
                .and_then(|text| text.as_str())
                .map(str::to_owned),
        },
        _ => Event::Other,
    }
}

/// One line of `codex exec --json` (`codex-rs/exec/src/exec_events.rs`):
/// `thread.started {thread_id}`, `item.completed {item: {type, …}}`,
/// `turn.completed`, `turn.failed {error: {message}}` and `error {message}`.
fn parse_codex_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Event::Other;
    };
    let text_at = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(|text| text.as_str())
            .map(|text| text.trim().to_owned())
    };
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("thread.started") => match value.get("thread_id").and_then(|id| id.as_str()) {
            Some(id) if SESSION_ID.is_match(id) => Event::Init {
                session_id: id.to_owned(),
            },
            _ => Event::Other,
        },
        Some("item.completed") => {
            let Some(item) = value.get("item") else {
                return Event::Other;
            };
            // Only the item kind and the agent's own words: never a command line, its
            // output or a file's contents.
            match item.get("type").and_then(|kind| kind.as_str()) {
                Some("agent_message") => text_at("/item/text")
                    .filter(|text| !text.is_empty())
                    .map_or(Event::Other, Event::Reply),
                Some("command_execution") => Event::Log("→ shell".into()),
                Some("file_change") => Event::Log("→ edit".into()),
                Some("web_search") => Event::Log("→ web search".into()),
                Some("mcp_tool_call") => {
                    let tool = text_at("/item/tool").filter(|tool| {
                        !tool.is_empty()
                            && tool.len() <= 64
                            && tool
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
                    });
                    Event::Log(format!("→ {}", tool.as_deref().unwrap_or("tool")))
                }
                Some("error") => text_at("/item/message")
                    .filter(|text| !text.is_empty())
                    .map_or(Event::Other, |text| Event::Log(format!("! {text}"))),
                _ => Event::Other,
            }
        }
        Some("turn.completed") => Event::Result {
            is_error: false,
            text: None,
        },
        Some("turn.failed") => Event::Result {
            is_error: true,
            text: text_at("/error/message"),
        },
        // Not the end of the turn: `turn.failed` repeats a fatal one.
        Some("error") => Event::StreamError(text_at("/message")),
        _ => Event::Other,
    }
}

fn keep_tail(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let start = (text.len() - limit..text.len())
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(text.len());
    text[start..].to_owned()
}

fn keep_head(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let end = (0..=limit)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    format!("{}…", &text[..end])
}

fn append_log(record: &mut RunRecord, words: &str) {
    let mut tail = record.output_tail.take().unwrap_or_default();
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail.push_str(&redact::scrub(words));
    record.output_tail = Some(keep_tail(&tail, OUTPUT_TAIL_BYTES));
}

// ── Starting and following a run ─────────────────────────────────────────────

/// Why a run did not get going.
#[derive(Debug)]
pub(crate) enum BeginFailure {
    /// The CLI exited before it reported a session. Classify `output` to decide on a
    /// fallback.
    Exited {
        output: CliOutput,
    },
    Cli(CliFailure),
    /// It never reported a session in time and was stopped; it may have started.
    TimedOut,
}

/// Start (or resume) the run in `record.workspace` and return once the CLI reports its
/// session. The rest of the run is read in the background into the record.
pub(crate) async fn begin(mut record: RunRecord, text: &str) -> Result<RunRecord, BeginFailure> {
    let provider = record
        .backend
        .provider()
        .filter(|_| record.backend.runs_on_node())
        .ok_or_else(|| BeginFailure::Cli(CliFailure::Io("not a run on this node".into())))?;
    let workspace = PathBuf::from(record.workspace.clone().unwrap_or_default());
    let resume = record.external_id.clone();
    let Streaming {
        mut lines,
        exit,
        kill,
    } = runner()
        .spawn_stream(
            invocation(provider, &workspace, resume.as_deref(), text).as_account(record.account()),
        )
        .map_err(BeginFailure::Cli)?;
    let mut early = String::new();
    let session = tokio::time::timeout(INIT_WAIT, async {
        while let Some(line) = lines.recv().await {
            match parse_event(provider, &line) {
                Event::Init { session_id } => return Some(session_id),
                Event::Log(words) | Event::Reply(words) => append_log(&mut record, &words),
                _ => {
                    early.push_str(&line);
                    early.push('\n');
                }
            }
        }
        None
    })
    .await;
    let session_id = match session {
        Ok(Some(id)) => id,
        Ok(None) => {
            let mut output = exit.await.unwrap_or_default();
            output.stdout = early;
            return Err(BeginFailure::Exited { output });
        }
        Err(_) => {
            let _ = kill.send(());
            return Err(BeginFailure::TimedOut);
        }
    };
    let mut seen = Vec::new();
    if let FirstTurn::Failed(message) = first_turn(provider, &mut lines, &mut seen).await {
        // Nothing was done yet, so the caller can classify it and fall back (a usage
        // limit goes to the owner's listed accounts, then the next backend).
        let drained =
            tokio::time::timeout(INIT_WAIT, async { while lines.recv().await.is_some() {} }).await;
        if drained.is_err() {
            let _ = kill.send(());
        }
        let mut output = exit.await.unwrap_or_default();
        output.exit_code = Some(output.exit_code.filter(|code| *code != 0).unwrap_or(1));
        output.stdout = message.unwrap_or_else(|| "The turn failed.".into());
        return Err(BeginFailure::Exited { output });
    }
    record.external_id = Some(session_id);
    record.status = "running".into();
    record.summary = None;
    record.last_error = None;
    // A follow-up run has a result of its own to post into the conversation.
    record.result_posted = false;
    record.updated_at = unix_now();
    store::save_run(record.clone());
    running().insert(record.conversation_id.clone(), kill);
    let follow = record.clone();
    tokio::spawn(follow_run(
        provider,
        follow,
        seen,
        lines,
        exit,
        text.to_owned(),
    ));
    Ok(record)
}

enum FirstTurn {
    UnderWay,
    Failed(Option<String>),
}

/// Read the first moments after the session: a turn that fails before any item or reply
/// has done nothing. Every line read is kept in `seen` for the follower.
async fn first_turn(
    provider: Provider,
    lines: &mut tokio::sync::mpsc::Receiver<String>,
    seen: &mut Vec<String>,
) -> FirstTurn {
    let watched = tokio::time::timeout(FIRST_TURN_WAIT, async {
        while let Some(line) = lines.recv().await {
            match parse_event(provider, &line) {
                Event::Result {
                    is_error: true,
                    text,
                } => return FirstTurn::Failed(text),
                Event::Other | Event::StreamError(_) => seen.push(line),
                _ => {
                    seen.push(line);
                    return FirstTurn::UnderWay;
                }
            }
        }
        FirstTurn::UnderWay
    })
    .await;
    watched.unwrap_or(FirstTurn::UnderWay)
}

/// Read the rest of a run into its record, then settle its status.
async fn follow_run(
    provider: Provider,
    mut record: RunRecord,
    seen: Vec<String>,
    mut lines: tokio::sync::mpsc::Receiver<String>,
    exit: tokio::sync::oneshot::Receiver<CliOutput>,
    text: String,
) {
    let mut last_save = tokio::time::Instant::now();
    let mut result: Option<(bool, Option<String>)> = None;
    let mut last_reply: Option<String> = None;
    let mut stream_error: Option<String> = None;
    let mut seen = seen.into_iter();
    loop {
        let line = match seen.next() {
            Some(line) => line,
            None => match lines.recv().await {
                Some(line) => line,
                None => break,
            },
        };
        match parse_event(provider, &line) {
            Event::Log(words) => append_log(&mut record, &words),
            Event::Reply(words) => {
                append_log(&mut record, &words);
                last_reply = Some(words);
            }
            Event::Result { is_error, text } => result = Some((is_error, text)),
            Event::StreamError(words) => {
                stream_error = words;
                continue;
            }
            _ => continue,
        }
        if last_save.elapsed() >= SAVE_EVERY {
            record.updated_at = unix_now();
            save_if_present(&record);
            last_save = tokio::time::Instant::now();
        }
    }
    let output = exit.await.unwrap_or_default();
    running().remove(&record.conversation_id);
    let cool_down_on_quota = |failed: &CliOutput, record: &RunRecord| {
        if cli::classify(failed, &text) == cli::FailureClass::Quota {
            let key = super::accounts::account_key(provider, record.account());
            store::start_cooldown(&key, unix_now());
        }
    };
    match (result, output.exit_code) {
        (Some((false, text)), _) => {
            record.status = "completed".into();
            record.summary = text
                .or(last_reply)
                .map(|text| keep_head(&redact::scrub(text.trim()), SUMMARY_BYTES));
        }
        (Some((true, text)), _) => {
            record.status = "failed".into();
            // A usage or rate limit reported in the stream (Codex reports it there, not
            // on stderr) cools the account down like one reported before the start.
            let reported = CliOutput {
                exit_code: Some(1),
                stdout: text.clone().unwrap_or_default(),
                stderr: output.stderr.clone(),
            };
            cool_down_on_quota(&reported, &record);
            record.last_error =
                text.map(|text| keep_head(&redact::scrub(text.trim()), SUMMARY_BYTES));
        }
        (None, None) => record.status = "stopped".into(),
        (None, Some(_)) => {
            record.status = "failed".into();
            // A stream error the CLI did not recover from explains the exit best.
            let output = match stream_error {
                Some(words) => CliOutput {
                    stdout: words,
                    stderr: String::new(),
                    ..output
                },
                None => output,
            };
            let reason = cli::failure_reason(&output);
            cool_down_on_quota(&output, &record);
            record.last_error = Some(if reason.is_empty() {
                format!("{} stopped without a result.", provider.agent_name())
            } else {
                keep_head(&reason, SUMMARY_BYTES)
            });
        }
    }
    record.updated_at = unix_now();
    save_if_present(&record);
}

/// Write the record unless its conversation was deleted meanwhile.
fn save_if_present(record: &RunRecord) {
    if store::run(&record.conversation_id).is_some() {
        store::save_run(record.clone());
    }
}

// ── The worktree ─────────────────────────────────────────────────────────────

#[cfg(test)]
static WORKTREE_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_worktree_root_for_test(root: Option<PathBuf>) {
    *WORKTREE_ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = root;
}

fn task_key(conversation_id: &str) -> String {
    let digest = Sha256::digest(conversation_id.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn worktree_dir(conversation_id: &str) -> PathBuf {
    let name = format!("cloud-task-worktrees/{}", task_key(conversation_id));
    #[cfg(test)]
    if let Some(root) = WORKTREE_ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return root.join(name);
    }
    crate::paths::files_path(&name)
}

async fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(cli::child_env(std::env::vars()))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| "git could not be run".to_owned())
}

/// The conversation's worktree and branch, created from the checkout's current `HEAD`
/// the first time.
pub(crate) async fn ensure_worktree(
    checkout: &Path,
    conversation_id: &str,
) -> Result<(PathBuf, String), String> {
    let dir = worktree_dir(conversation_id);
    let branch = format!("ryu/task-{}", task_key(conversation_id));
    if dir.join(".git").exists() {
        return Ok((dir, branch));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "the task folder could not be made".to_owned())?;
    }
    let target = dir.to_string_lossy().into_owned();
    let created = git(
        checkout,
        &["worktree", "add", "-b", &branch, &target, "HEAD"],
    )
    .await?;
    if created.status.success() {
        return Ok((dir, branch));
    }
    // The branch survives a removed worktree: reuse it.
    let reused = git(checkout, &["worktree", "add", &target, &branch]).await?;
    if reused.status.success() {
        Ok((dir, branch))
    } else {
        Err(redact::scrub(
            String::from_utf8_lossy(&created.stderr).trim(),
        ))
    }
}

/// What changed in the task's worktree since it started: the status and the patch
/// against the commit it started from, new files included.
#[derive(serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDiff {
    pub(crate) branch: Option<String>,
    /// `git status --porcelain` lines.
    pub(crate) files: Vec<String>,
    pub(crate) patch: String,
    /// The patch was cut at 512 KiB.
    pub(crate) truncated: bool,
}

pub(crate) async fn diff(record: &RunRecord) -> Result<LocalDiff, String> {
    let workspace = PathBuf::from(
        record
            .workspace
            .clone()
            .ok_or_else(|| "this run has no worktree".to_owned())?,
    );
    // Mark new files so they show in the patch; this touches only the task's own index.
    git(&workspace, &["add", "--intent-to-add", "--all"]).await?;
    let status = git(&workspace, &["status", "--porcelain"]).await?;
    let patch = git(&workspace, &["diff", "HEAD"]).await?;
    if !patch.status.success() {
        return Err("git could not read the changes".into());
    }
    let patch = String::from_utf8_lossy(&patch.stdout);
    let truncated = patch.len() > MAX_DIFF_BYTES;
    Ok(LocalDiff {
        branch: record.branch.clone(),
        files: String::from_utf8_lossy(&status.stdout)
            .lines()
            .take(2000)
            .map(str::to_owned)
            .collect(),
        patch: if truncated {
            keep_head(&patch, MAX_DIFF_BYTES)
        } else {
            patch.into_owned()
        },
        truncated,
    })
}
