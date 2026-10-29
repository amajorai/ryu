//! The provider CLIs, driven as unmodified subprocesses.
//!
//! Compliance rules this file enforces (docs/subscription-cloud-sessions.md §6):
//! - Ryu runs the official `claude` / `codex` binary as published and never reads its
//!   credential store. Ryu only asks the CLI for its *status*.
//! - The child environment is an allowlist. API keys, OAuth tokens, base URLs and every
//!   `RYU_*` variable are dropped, so the CLI can only use the sign-in the user made in
//!   it. Ryu's Gateway is never put in the path.
//! - Raw output is parsed in memory and dropped. Only an id, a URL, a status and a
//!   scrubbed summary leave this file.

use super::redact;
use super::Provider;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

/// Parent variables a provider CLI needs to find its own install, config and login.
/// Everything else is dropped.
const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    // Where the user keeps each CLI's own config (and so its own sign-in).
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    // Corporate proxies and CA bundles the user configured for these tools.
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    // `claude --cloud` bundles the local repository with git.
    "SSH_AUTH_SOCK",
    "GIT_SSH_COMMAND",
    // Windows.
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PATHEXT",
    "ComSpec",
];

/// Variables that must never reach a provider CLI, even if a future edit widens the
/// allowlist. They would bill an API key, inject a token, or route the CLI through Ryu.
pub(super) const ENV_DENYLIST: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
];

/// The child environment for a provider CLI: the allowlisted part of `parent`, never a
/// denylisted or `RYU_*` name.
pub(super) fn child_env<I>(parent: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    parent
        .into_iter()
        .filter(|(name, _)| {
            ENV_ALLOWLIST.contains(&name.as_str())
                && !ENV_DENYLIST.contains(&name.as_str())
                && !name.starts_with("RYU_")
        })
        .collect()
}

/// One CLI call.
#[derive(Clone, Debug)]
pub(crate) struct Invocation {
    pub(crate) provider: Provider,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) timeout: Duration,
    /// Return as soon as a line of output satisfies this, and stop the child. The
    /// interactive `claude --cloud` start keeps a provisioning checklist open, but the
    /// session exists once its id is printed.
    pub(crate) stop_when: Option<fn(&str) -> bool>,
    /// A linked account's config folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). `None`
    /// uses the CLI's own default sign-in.
    pub(crate) account_dir: Option<PathBuf>,
}

impl Invocation {
    /// Run this call as `account_id` (a linked account's folder, or the CLI's default).
    pub(crate) fn as_account(mut self, account_id: &str) -> Self {
        self.account_dir = super::accounts::config_dir(self.provider, account_id);
        self
    }
}

/// What a finished (or stopped-early) call printed. Callers parse it and drop it.
#[derive(Clone, Debug, Default)]
pub(crate) struct CliOutput {
    /// `None` when the call was stopped early or killed by a signal.
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl CliOutput {
    pub(crate) fn succeeded(&self) -> bool {
        self.exit_code == Some(0)
    }
    pub(super) fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

/// A started call whose stdout is read line by line while it runs (Claude Code's
/// headless `stream-json` output). `exit` resolves once the child has exited, with its
/// code (`None` when it was stopped) and the tail of its stderr; `stdout` there is empty.
pub(crate) struct Streaming {
    pub(crate) lines: tokio::sync::mpsc::Receiver<String>,
    pub(crate) exit: tokio::sync::oneshot::Receiver<CliOutput>,
    /// Send to stop the child.
    pub(crate) kill: tokio::sync::oneshot::Sender<()>,
}

/// How much stderr a streaming call keeps (the end, where the error is).
const STREAM_STDERR_TAIL: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CliFailure {
    NotInstalled,
    TimedOut,
    Io(String),
}

/// Runs provider CLIs. [`RealCli`] in production; tests install a fake.
#[async_trait::async_trait]
pub(crate) trait CliRunner: Send + Sync {
    /// Whether the provider's CLI is on this node's `PATH`.
    fn installed(&self, provider: Provider) -> bool;
    async fn run(&self, invocation: Invocation) -> Result<CliOutput, CliFailure>;
    /// Start a call with no captured output and do not wait for it (the CLI's own
    /// sign-in, which opens the provider's page in the user's browser).
    fn spawn_detached(&self, invocation: Invocation) -> Result<(), CliFailure>;
    /// Start a long call and hand back its output as it is printed. The child is stopped
    /// after `invocation.timeout`.
    fn spawn_stream(&self, invocation: Invocation) -> Result<Streaming, CliFailure>;
}

pub(crate) struct RealCli;

impl RealCli {
    fn command(invocation: &Invocation) -> Result<tokio::process::Command, CliFailure> {
        let program =
            crate::sidecar::manifest_sidecar::which_on_path(invocation.provider.program())
                .ok_or(CliFailure::NotInstalled)?;
        Ok(Self::command_for(program, invocation))
    }

    /// The child command for `program`: the allowlisted environment, then the account's
    /// own config folder.
    pub(super) fn command_for(
        program: PathBuf,
        invocation: &Invocation,
    ) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(program);
        command
            .args(&invocation.args)
            .env_clear()
            .envs(child_env(std::env::vars()))
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        // Last, so a linked account's folder replaces any inherited default.
        if let Some(dir) = &invocation.account_dir {
            let name = super::accounts::ProviderId::from(invocation.provider).config_env();
            command.env(name, dir);
        }
        if let Some(cwd) = &invocation.cwd {
            command.current_dir(cwd);
        }
        command
    }
}

#[async_trait::async_trait]
impl CliRunner for RealCli {
    fn installed(&self, provider: Provider) -> bool {
        crate::sidecar::manifest_sidecar::which_on_path(provider.program()).is_some()
    }

    async fn run(&self, invocation: Invocation) -> Result<CliOutput, CliFailure> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = Self::command(&invocation)?
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        let stdout = child.stdout.take().ok_or(CliFailure::Io("stdout".into()))?;
        let stderr = child.stderr.take().ok_or(CliFailure::Io("stderr".into()))?;
        let mut out_lines = BufReader::new(stdout).lines();
        let mut err_lines = BufReader::new(stderr).lines();
        let mut output = CliOutput::default();
        let collect = async {
            let (mut out_open, mut err_open) = (true, true);
            while out_open || err_open {
                tokio::select! {
                    line = out_lines.next_line(), if out_open => match line {
                        Ok(Some(line)) => {
                            let stop = invocation.stop_when.is_some_and(|stop| stop(&line));
                            output.stdout.push_str(&line);
                            output.stdout.push('\n');
                            if stop {
                                return true;
                            }
                        }
                        _ => out_open = false,
                    },
                    line = err_lines.next_line(), if err_open => match line {
                        Ok(Some(line)) => {
                            output.stderr.push_str(&line);
                            output.stderr.push('\n');
                        }
                        _ => err_open = false,
                    },
                }
            }
            false
        };
        match tokio::time::timeout(invocation.timeout, collect).await {
            Ok(true) => {
                // The id is out; the session exists. Leave the provisioning checklist.
                let _ = child.start_kill();
                Ok(output)
            }
            Ok(false) => {
                let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
                    .await
                    .map_err(|_| CliFailure::TimedOut)?
                    .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
                output.exit_code = status.code();
                Ok(output)
            }
            Err(_) => {
                let _ = child.start_kill();
                Err(CliFailure::TimedOut)
            }
        }
    }

    fn spawn_detached(&self, invocation: Invocation) -> Result<(), CliFailure> {
        let mut command = Self::command(&invocation)?;
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(false);
        let mut child = command
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        // Reap it whenever the user finishes (or abandons) the provider's sign-in page.
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(15 * 60), child.wait()).await;
            let _ = child.start_kill();
        });
        Ok(())
    }

    fn spawn_stream(&self, invocation: Invocation) -> Result<Streaming, CliFailure> {
        Self::spawn_stream_inner(&invocation)
    }
}

impl RealCli {
    fn spawn_stream_inner(invocation: &Invocation) -> Result<Streaming, CliFailure> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = Self::command(invocation)?
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| CliFailure::Io(error.kind().to_string()))?;
        let stdout = child.stdout.take().ok_or(CliFailure::Io("stdout".into()))?;
        let stderr = child.stderr.take().ok_or(CliFailure::Io("stderr".into()))?;
        let (line_tx, lines) = tokio::sync::mpsc::channel(256);
        let (exit_tx, exit) = tokio::sync::oneshot::channel();
        let (kill, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
        let timeout = invocation.timeout;
        tokio::spawn(async move {
            // Drain stderr to the end so the child never blocks on a full pipe; keep the tail.
            let stderr_tail = tokio::spawn(async move {
                let mut tail = String::new();
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > STREAM_STDERR_TAIL * 2 {
                        let cut = tail.len() - STREAM_STDERR_TAIL;
                        let cut = (cut..tail.len())
                            .find(|index| tail.is_char_boundary(*index))
                            .unwrap_or(tail.len());
                        tail.drain(..cut);
                    }
                }
                tail
            });
            let mut out = BufReader::new(stdout).lines();
            let pump = async {
                while let Ok(Some(line)) = out.next_line().await {
                    if line_tx.send(line).await.is_err() {
                        break;
                    }
                }
            };
            let stopped = tokio::select! {
                () = pump => false,
                Ok(()) = &mut kill_rx => true,
                () = tokio::time::sleep(timeout) => true,
            };
            if stopped {
                let _ = child.start_kill();
            }
            let code = child.wait().await.ok().and_then(|status| status.code());
            let stderr = stderr_tail.await.unwrap_or_default();
            let _ = exit_tx.send(CliOutput {
                exit_code: if stopped { None } else { code },
                stdout: String::new(),
                stderr,
            });
        });
        Ok(Streaming { lines, exit, kill })
    }
}

// ── Sign-in status ───────────────────────────────────────────────────────────

/// How the CLI is signed in, as far as its status command says. Ryu reads only this.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SignIn {
    /// Signed in with the user's Claude or ChatGPT subscription.
    Subscription,
    /// Signed in, but with an API key or a third-party provider. Cloud runs need the
    /// subscription sign-in.
    OtherMethod,
    SignedOut,
}

pub(crate) fn status_invocation(provider: Provider) -> Invocation {
    let args = match provider {
        Provider::Anthropic => vec!["auth".into(), "status".into()],
        Provider::Openai => vec!["login".into(), "status".into()],
    };
    Invocation {
        provider,
        args,
        cwd: None,
        timeout: Duration::from_secs(20),
        stop_when: None,
        account_dir: None,
    }
}

pub(crate) fn sign_in_invocation(provider: Provider) -> Invocation {
    let args = match provider {
        Provider::Anthropic => vec!["auth".into(), "login".into()],
        Provider::Openai => vec!["login".into()],
    };
    Invocation {
        provider,
        args,
        cwd: None,
        timeout: Duration::from_secs(15 * 60),
        stop_when: None,
        account_dir: None,
    }
}

/// `claude auth status` prints JSON whose `authMethod` names how it is signed in; it
/// exits 1 when signed out. Only `claude.ai` is a subscription sign-in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAuthStatus {
    #[serde(default)]
    auth_method: Option<String>,
}

pub(crate) fn parse_sign_in(provider: Provider, output: &CliOutput) -> SignIn {
    if !output.succeeded() {
        return SignIn::SignedOut;
    }
    match provider {
        Provider::Anthropic => {
            let method = serde_json::from_str::<ClaudeAuthStatus>(output.stdout.trim())
                .ok()
                .and_then(|status| status.auth_method);
            match method.as_deref() {
                Some("claude.ai") => SignIn::Subscription,
                Some("none") | None => SignIn::SignedOut,
                Some(_) => SignIn::OtherMethod,
            }
        }
        Provider::Openai => {
            // `codex login status` names the active mode in prose ("Logged in using
            // ChatGPT" / "... an API key"); the wording is not a contract, so anything
            // that is not clearly an API key counts as the ChatGPT sign-in, and a
            // wrong guess surfaces as a signed-out failure at start.
            let text = output.combined().to_ascii_lowercase();
            if text.contains("api key") || text.contains("api_key") {
                SignIn::OtherMethod
            } else if text.contains("not logged in") {
                SignIn::SignedOut
            } else {
                SignIn::Subscription
            }
        }
    }
}

// ── Starting and steering a run ──────────────────────────────────────────────

static CLAUDE_SESSION_ID: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"\b((?:session|cse)_[A-Za-z0-9]{8,64})\b").expect("static pattern")
});
static CLAUDE_SESSION_URL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"https://claude\.ai/code/((?:session|cse)_[A-Za-z0-9]{8,64})")
        .expect("static pattern")
});
static CODEX_TASK_URL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"https://chatgpt\.com/codex/tasks/([A-Za-z0-9_\-]{6,96})")
        .expect("static pattern")
});
static CODEX_TASK_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(task_[A-Za-z0-9_]{6,96})\b").expect("static pattern"));

fn claude_line_has_session(line: &str) -> bool {
    CLAUDE_SESSION_ID.is_match(line)
}

/// Task text as one argv entry that no option parser reads as a flag. Text that starts with
/// `-` (for example `--settings=…` or `--help`) gets a leading space: the provider still
/// receives the same words, but the CLI cannot take it as one of its own options.
pub(super) fn as_text_argument(text: &str) -> String {
    if text.starts_with('-') {
        format!(" {text}")
    } else {
        text.to_owned()
    }
}

/// `claude --cloud "<task>"`, run in the user's checkout, starts a cloud session that
/// clones that checkout's GitHub remote at its current branch. The task is the value of
/// `--cloud`, so it cannot follow a `--`; [`as_text_argument`] keeps it from being parsed
/// as a flag.
pub(crate) fn claude_start_invocation(checkout: PathBuf, task: &str) -> Invocation {
    Invocation {
        provider: Provider::Anthropic,
        args: vec!["--cloud".into(), as_text_argument(task)],
        cwd: Some(checkout),
        timeout: Duration::from_secs(180),
        stop_when: Some(claude_line_has_session),
        account_dir: None,
    }
}

/// `claude -p --cloud <id> --output-format json -- "<message>"` queues a follow-up. Every
/// option comes before `--`, so the message is only ever the prompt.
pub(crate) fn claude_follow_up_invocation(session_id: &str, message: &str) -> Invocation {
    Invocation {
        provider: Provider::Anthropic,
        args: vec![
            "-p".into(),
            "--cloud".into(),
            session_id.into(),
            "--output-format".into(),
            "json".into(),
            "--".into(),
            as_text_argument(message),
        ],
        cwd: None,
        timeout: Duration::from_secs(60),
        stop_when: None,
        account_dir: None,
    }
}

/// `codex cloud exec --env <id> -- "<task>"` submits a Codex cloud task.
pub(crate) fn codex_start_invocation(environment_id: &str, task: &str) -> Invocation {
    Invocation {
        provider: Provider::Openai,
        args: vec![
            "cloud".into(),
            "exec".into(),
            "--env".into(),
            environment_id.into(),
            "--".into(),
            as_text_argument(task),
        ],
        cwd: None,
        timeout: Duration::from_secs(180),
        stop_when: None,
        account_dir: None,
    }
}

/// `codex cloud list --json [--env <id>] --limit 20`. Without an environment it lists the
/// account's recent tasks across its environments.
pub(crate) fn codex_list_invocation(environment_id: Option<&str>) -> Invocation {
    let mut args: Vec<String> = vec!["cloud".into(), "list".into(), "--json".into()];
    if let Some(environment_id) = environment_id {
        args.push("--env".into());
        args.push(environment_id.into());
    }
    args.push("--limit".into());
    args.push("20".into());
    Invocation {
        provider: Provider::Openai,
        args,
        cwd: None,
        timeout: Duration::from_secs(30),
        stop_when: None,
        account_dir: None,
    }
}

/// The provider's handle for a run Ryu started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Started {
    pub(crate) external_id: Option<String>,
    pub(crate) url: Option<String>,
}

pub(crate) fn parse_claude_started(output: &CliOutput) -> Option<Started> {
    let text = output.combined();
    if let Some(captures) = CLAUDE_SESSION_URL.captures(&text) {
        let id = captures[1].to_owned();
        return Some(Started {
            url: Some(format!("https://claude.ai/code/{id}")),
            external_id: Some(id),
        });
    }
    CLAUDE_SESSION_ID.captures(&text).map(|captures| {
        let id = captures[1].to_owned();
        Started {
            url: Some(format!("https://claude.ai/code/{id}")),
            external_id: Some(id),
        }
    })
}

#[derive(Deserialize)]
struct ClaudeFollowUp {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

/// The follow-up's `{ok, session_id, url}` / `{ok: false, error}` result. `Err` carries a
/// scrubbed reason.
pub(crate) fn parse_claude_follow_up(output: &CliOutput) -> Result<(), String> {
    let parsed = output
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<ClaudeFollowUp>(line.trim()).ok());
    match parsed {
        Some(result) if result.ok && output.exit_code.unwrap_or(0) == 0 => Ok(()),
        Some(result) => Err(redact::scrub(
            result
                .error
                .as_deref()
                .unwrap_or("The follow-up was not delivered."),
        )),
        None => Err(redact::scrub(&output.combined())),
    }
}

pub(crate) fn parse_codex_started(output: &CliOutput) -> Started {
    let text = output.combined();
    let url = CODEX_TASK_URL
        .captures(&text)
        .map(|captures| captures[0].to_owned());
    let external_id = CODEX_TASK_URL
        .captures(&text)
        .map(|captures| captures[1].to_owned())
        .or_else(|| {
            CODEX_TASK_ID
                .captures(&text)
                .map(|captures| captures[1].to_owned())
        });
    Started { external_id, url }
}

/// One row of `codex cloud list --json`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct CodexTask {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) summary: Option<String>,
}

#[derive(Deserialize)]
struct CodexTaskList {
    #[serde(default)]
    tasks: Vec<CodexTask>,
}

static CODEX_TASK_ID_EXACT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_\-]{6,96}$").expect("static pattern"));

/// Rows of `codex cloud list --json` with a well-formed id. A row's link is kept only when
/// it is a chatgpt.com Codex task link for that same id.
pub(crate) fn parse_codex_list(output: &CliOutput) -> Option<Vec<CodexTask>> {
    if !output.succeeded() {
        return None;
    }
    let list = serde_json::from_str::<CodexTaskList>(output.stdout.trim()).ok()?;
    Some(
        list.tasks
            .into_iter()
            .filter(|task| CODEX_TASK_ID_EXACT.is_match(&task.id))
            .map(|mut task| {
                let expected = format!("https://chatgpt.com/codex/tasks/{}", task.id);
                if task.url.as_deref() != Some(expected.as_str()) {
                    task.url = None;
                }
                task.title = task.title.map(|title| redact::scrub(&title));
                task
            })
            .collect(),
    )
}

// ── Failures ─────────────────────────────────────────────────────────────────

/// Why a provider call failed, which decides whether Ryu may fall back to a Box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FailureClass {
    /// Usage limit or rate limit on the user's plan: fall back and cool down.
    Quota,
    /// The CLI is not signed in with the subscription: fall back.
    SignedOut,
    /// Missing CLI, disabled org policy, timeout: fall back.
    Unavailable,
    /// The request itself is wrong (repository, environment id): never fall back, so a
    /// bad request does not turn into a billed Box.
    Rejected,
}

static QUOTA_SIGNALS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(usage limit|rate[ _-]?limit(ed|s)?|limit reached|too many requests|out of credits|weekly limit|quota (exceeded|reached))\b|\b(http|status|error|code)[ :=]*429\b",
    )
    .expect("static pattern")
});
static SIGNED_OUT_SIGNALS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(not logged in|not signed in|run `?claude auth login|run `?codex login|unable to get organization uuid|need a claude\.ai sign-in|requires signing in with chatgpt)|\b(http|status|error|code)[ :=]*401\b",
    )
    .expect("static pattern")
});
static UNAVAILABLE_SIGNALS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(disabled by your organization|couldn't verify your organization|cloud sessions aren't available|session creation failed|\boverloaded\b)|\b(http|status|error|code)[ :=]*(502|503|529)\b",
    )
    .expect("static pattern")
});

/// Classify a failed provider call. Only a call that exited non-zero is classified for
/// fallback: a zero exit, or a call stopped early, may already have started the run, so it
/// is [`FailureClass::Rejected`] (no fallback, no second run). The task text is removed
/// first so a task about "the rate limit bug" that the CLI echoes is not a quota error.
pub(crate) fn classify(output: &CliOutput, task: &str) -> FailureClass {
    if !matches!(output.exit_code, Some(code) if code != 0) {
        return FailureClass::Rejected;
    }
    let mut text = output.combined();
    if !task.trim().is_empty() {
        text = text.replace(task.trim(), " ");
    }
    if QUOTA_SIGNALS.is_match(&text) {
        FailureClass::Quota
    } else if SIGNED_OUT_SIGNALS.is_match(&text) {
        FailureClass::SignedOut
    } else if UNAVAILABLE_SIGNALS.is_match(&text) {
        FailureClass::Unavailable
    } else {
        FailureClass::Rejected
    }
}

/// A scrubbed, user-facing reason for a failed call.
pub(crate) fn failure_reason(output: &CliOutput) -> String {
    let reason = redact::scrub(output.stderr.trim());
    if reason.is_empty() {
        redact::scrub(output.stdout.trim())
    } else {
        reason
    }
}
