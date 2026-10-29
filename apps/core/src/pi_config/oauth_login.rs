//! Subscription OAuth login for the managed Pi (ChatGPT / Claude / Copilot …).
//!
//! The "Login" buttons on the provider cards used to run the agent-advertised ACP
//! method, which for pi-acp is `pi_terminal_login` — a *hint* ("go start pi in a
//! terminal") that answers the RPC in about a second having logged nobody in. The
//! app had no way to complete an interactive login at all: nothing carried a URL,
//! a device code, or a prompt back to the user.
//!
//! This module is that missing channel. It drives pi-ai's OWN flow modules
//! (`@earendil-works/pi-ai/dist/auth/oauth/*`) through a small Node bridge
//! ([`pi_oauth_login.mjs`], embedded below), turning each flow into a stream of
//! events the desktop can render — an authorization URL, a device code, a prompt
//! awaiting an answer — and feeding the user's answers back in.
//!
//! Reusing pi-ai's flows rather than reimplementing OAuth in Rust is deliberate:
//! - the client ids and endpoints stay out of Ryu entirely, including refresh;
//! - Copilot works. Its credential is a bespoke GitHub-device → Copilot-token
//!   exchange that Core refuses to guess at; pi-ai implements both login and
//!   refresh, so bridging gets both;
//! - the credential comes back in exactly the shape Pi stores, so
//!   [`super::provider_configured`] flips to `true` with no translation.
//!
//! The bridge never writes `auth.json` — Core merges the credential itself, so
//! the file keeps the single 0600-owning writer it already had.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::broadcast;

use crate::win_process::NoWindow;

/// The Node bridge, embedded so a built-in Core carries it without the repo.
/// Written into the managed Pi prefix at login time so its
/// `@earendil-works/pi-ai` import resolves from that tree's `node_modules`.
const BRIDGE_SOURCE: &str = include_str!("pi_oauth_login.mjs");

/// Bridge filename inside the managed Pi prefix (`~/.ryu/pi`).
const BRIDGE_FILE: &str = "ryu-oauth-login.mjs";

/// The bridge's provider-route `fetch`, written beside it (the bridge imports it
/// by this name).
const BRIDGE_PROXY_SOURCE: &str = include_str!("pi_oauth_proxy.mjs");
const BRIDGE_PROXY_FILE: &str = "ryu-oauth-proxy.mjs";
static BRIDGE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Ceiling on one login attempt. Generous — a user may need to find a password
/// manager, switch devices, or complete an MFA challenge — but not unbounded, so
/// an abandoned attempt cannot hold its callback port (see [`start`]) forever.
const LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// How many of the bridge's stderr lines to keep for the failure message. A Node
/// crash prints a handful of frames; twenty covers the throw and its stack
/// without letting a chatty flow grow the buffer without bound.
const STDERR_TAIL_LINES: usize = 20;

/// Ceiling on how much of that tail goes into the message the user reads. Past
/// this it stops being a diagnosis and becomes a wall of text in a dialog.
const STDERR_TAIL_CHARS: usize = 1000;

/// How long to wait for the exit status of a bridge that already closed stdout.
/// It has EOF'd, so it is either gone or microseconds from it; this only exists
/// so a wedged child cannot hold the error event hostage.
const EXIT_STATUS_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// One in-flight login: the child process, its event history, and a live feed.
pub struct LoginSession {
    /// Live events for subscribers attached now.
    tx: broadcast::Sender<Value>,
    /// Everything emitted so far. A client subscribes AFTER `start` returns, by
    /// which point the flow has usually already emitted its URL or first prompt —
    /// replaying the history is what stops that opening event from being lost.
    history: Mutex<Vec<Value>>,
    /// Write half of the bridge's stdin, for answering prompts.
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    /// Kept so the flow can be killed. Dropping a `tokio` `Child` does NOT reap
    /// it by default, and an orphaned flow keeps its OAuth callback port bound —
    /// `openai-codex` in particular listens on a fixed `localhost:1455` that its
    /// registered redirect URI depends on, so one leaked child makes every later
    /// ChatGPT login fail with `EADDRINUSE`. Every exit path kills.
    child: Mutex<Option<Child>>,
    /// Native OAuth owns an async callback listener instead of a child process.
    native_abort: Mutex<Option<tokio::task::AbortHandle>>,
    /// Set once the flow reached a terminal event, so late subscribers do not
    /// wait on a stream that will never speak again.
    finished: AtomicBool,
    /// pi-ai provider id this login is for, so a second attempt at the same
    /// provider can retire the first before it re-binds the callback port.
    provider: String,
    /// The bridge's most recent stderr lines, bounded to [`STDERR_TAIL_LINES`].
    /// This stays in process memory and is reduced to fixed diagnostics before
    /// it reaches a client; vendor error text may contain credentials.
    stderr_tail: Mutex<VecDeque<String>>,
}

impl LoginSession {
    /// Append to the replay log and push to live subscribers.
    fn emit(&self, event: Value) {
        if let Ok(mut history) = self.history.lock() {
            history.push(event.clone());
        }
        // `send` errs only when nobody is subscribed; the history still has it.
        let _ = self.tx.send(event);
    }

    /// Events already emitted, for a client that just attached.
    pub fn replay(&self) -> Vec<Value> {
        self.history.lock().map(|h| h.clone()).unwrap_or_default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.tx.subscribe()
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// Record one stderr line from the bridge, dropping the oldest past the cap.
    fn push_stderr(&self, line: String) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            while tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    /// The recorded stderr, oldest line first, trimmed to [`STDERR_TAIL_CHARS`].
    ///
    /// Trimming keeps the END, not the start: Node prints the failing specifier
    /// and the `code:` field after the stack, so the tail is where the answer is.
    fn recent_stderr(&self) -> String {
        let joined = self
            .stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        let chars = joined.chars().count();
        if chars <= STDERR_TAIL_CHARS {
            return joined;
        }
        let start = joined
            .char_indices()
            .nth(chars - STDERR_TAIL_CHARS)
            .map_or(0, |(index, _)| index);
        format!("…{}", &joined[start..])
    }

    /// Answer the prompt with the given id. The value is forwarded verbatim: a
    /// `select` prompt (Copilot asks one) expects the chosen option's **id**, not
    /// its index or label.
    pub async fn answer(&self, id: &str, value: &str) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| anyhow!("this login is no longer accepting input"))?;
        let line = format!("{}\n", json!({ "id": id, "value": value }));
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Kill the flow and release its callback port. Idempotent.
    ///
    /// `finished` is set FIRST, before the kill, and the order is load-bearing.
    /// It used to be set last, which left a window in which the reader task saw
    /// the killed child's stdout EOF while `finished` was still `false` and
    /// reported "the login flow exited before completing" for a flow the app had
    /// deliberately cancelled. That made the message ambiguous between "the
    /// bridge died" and "we killed it" — the two cases with opposite fixes.
    pub fn cancel(&self) {
        self.finished.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.native_abort.lock() {
            if let Some(task) = guard.take() {
                task.abort();
            }
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
            *guard = None;
        }
        if let Ok(mut guard) = self.stdin.try_lock() {
            *guard = None;
        }
    }
}

/// The message for a bridge whose stdout closed without a terminal event.
/// Only fixed classifications of vendor stderr may reach a client.
fn exit_message(status: Option<std::process::ExitStatus>, stderr: &str) -> String {
    let mut message = String::from("the login flow exited before completing");
    if let Some(status) = status {
        message.push_str(&format!(" ({status})"));
    }
    // Vendor stderr is uncontrolled and can contain OAuth codes or credentials.
    // Return only known, fixed diagnostics to clients.
    let diagnostic =
        if stderr.contains("Cannot find package") || stderr.contains("ERR_MODULE_NOT_FOUND") {
            Some("the managed Pi package could not be loaded")
        } else if stderr.contains("EADDRINUSE") {
            Some("the sign-in callback port is already in use")
        } else {
            None
        };
    if let Some(diagnostic) = diagnostic {
        message.push_str(&format!(" — {diagnostic}"));
    }
    message
}

/// Wait up to `wait` for the exit status of a child whose stdout already EOF'd,
/// **killing it** if that wait does not reap it.
///
/// The kill is load-bearing, not belt-and-braces. By the time this runs the
/// child has been taken out of [`LoginSession::child`], so `cancel()` and the
/// 15-minute backstop can no longer reach it, and `tokio` does not kill a
/// `Child` on drop unless `kill_on_drop` is set. Both non-status paths —
/// the `wait` elapsing, and `wait()` itself returning `Err` — would otherwise
/// drop a live child, which is precisely the leak [`LoginSession::child`]
/// documents: an orphan holding the fixed OAuth callback port, so every later
/// login for that provider fails with `EADDRINUSE`.
async fn reap_or_kill(
    child: &mut Child,
    wait: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    // A bridge can close stdout and exit before this function is reached. Reap
    // that common terminal path synchronously so a busy Tokio runtime cannot
    // spend the whole status ceiling waiting for an exit notification that is
    // already available from the OS.
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    match tokio::time::timeout(wait, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        _ => {
            let _ = child.start_kill();
            None
        }
    }
}

type Registry = Mutex<HashMap<String, Arc<LoginSession>>>;

fn sessions() -> &'static Registry {
    static SESSIONS: OnceLock<Registry> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get(session_id: &str) -> Option<Arc<LoginSession>> {
    sessions()
        .lock()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

/// Drop a session from the registry, killing its child first.
pub fn cancel(session_id: &str) -> bool {
    let removed = sessions()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(session_id));
    match removed {
        Some(session) => {
            session.cancel();
            true
        }
        None => false,
    }
}

/// Write the Node bridge into the managed Pi prefix, refreshing it whenever the
/// embedded copy differs (a Core upgrade must not leave a stale bridge behind).
fn ensure_bridge() -> Result<std::path::PathBuf> {
    let _write_guard = BRIDGE_WRITE_LOCK.lock().expect("OAuth bridge write lock");
    let dir = crate::sidecar::adapters::acp::managed_pi_dir();
    if !dir.join("node_modules").is_dir() {
        return Err(anyhow!(
            "the managed Pi engine is not installed yet, so there is no OAuth flow to run — install it from Settings first"
        ));
    }
    // The module the bridge imports goes first, so a new bridge never runs
    // beside a missing or stale one.
    for (name, source) in [
        (BRIDGE_PROXY_FILE, BRIDGE_PROXY_SOURCE),
        (BRIDGE_FILE, BRIDGE_SOURCE),
    ] {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).unwrap_or_default() != source {
            std::fs::write(&path, source)?;
        }
    }
    Ok(dir.join(BRIDGE_FILE))
}

/// The runtimes that can host the bridge, in priority order. Node first,
/// deliberately: the flow modules reach `node:http` / `node:crypto` through an
/// indirection that exists to defeat bundlers, and Node is what pi-ai targets.
const JS_RUNTIMES: [&str; 2] = ["node", "bun"];

/// Resolve a JavaScript runtime for the bridge, as an **absolute path**.
///
/// A bare `PATH` scan for the literal name is not enough, and got this wrong in
/// both directions:
/// - on Windows the interpreter is `node.exe` / `bun.exe`, so probing
///   `<dir>/node` matched nothing on every Windows host — a user with Node
///   installed was told to install Node, and the login 400'd before it started.
///   [`crate::sidecar::manifest_sidecar::which_on_path`] already knows the
///   extension rule (and why `Command::new` cannot spawn a bare `.cmd`), so this
///   reuses it rather than keeping a third, subtly-different copy;
/// - a macOS app launched from Finder inherits a minimal
///   `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that contains no Node install, so
///   the GUI case fails where a terminal launch works. The common install
///   prefixes are probed explicitly, mirroring
///   `skills_catalog::from_source::install_from_source`.
///
/// PATH still wins over the well-known prefixes — a user who put a specific
/// runtime on their PATH meant it.
fn js_runtime() -> Option<std::path::PathBuf> {
    for candidate in JS_RUNTIMES {
        if let Some(found) = crate::sidecar::manifest_sidecar::which_on_path(candidate) {
            return Some(found);
        }
    }
    for candidate in JS_RUNTIMES {
        if let Some(found) = well_known_runtime(candidate) {
            return Some(found);
        }
    }
    None
}

/// Install prefixes a process that did not inherit a login shell's `PATH` still
/// has to look in.
#[cfg(windows)]
fn well_known_runtime(binary: &str) -> Option<std::path::PathBuf> {
    let exe = format!("{binary}.exe");
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(
            std::path::PathBuf::from(program_files)
                .join("nodejs")
                .join(&exe),
        );
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = std::path::PathBuf::from(local);
        roots.push(local.join("Programs").join("nodejs").join(&exe));
        // winget shims every package it installs into this one directory.
        roots.push(
            local
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(&exe),
        );
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".bun").join("bin").join(&exe));
    }
    roots.into_iter().find(|p| p.is_file())
}

#[cfg(not(windows))]
fn well_known_runtime(binary: &str) -> Option<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from("/opt/homebrew/bin").join(binary),
        std::path::PathBuf::from("/usr/local/bin").join(binary),
        std::path::PathBuf::from("/usr/bin").join(binary),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".bun").join("bin").join(binary));
        roots.push(home.join(".volta").join("bin").join(binary));
        roots.push(home.join(".local").join("bin").join(binary));
        // nvm keeps one bin dir per installed Node version.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            for entry in entries.flatten() {
                roots.push(entry.path().join("bin").join(binary));
            }
        }
    }
    roots.into_iter().find(|p| p.is_file())
}

/// The pi-ai OAuth provider id backing a Ryu provider id. Most Ryu ids coincide
/// with the key Pi writes into `auth.json`; the native ChatGPT provider is the
/// intentional exception: it uses the same maintained OpenAI login flow as Pi's
/// Codex provider, but stores the resulting session under its own Ryu account
/// scope.
pub fn oauth_provider_id(ryu_provider_id: &str) -> Option<&'static str> {
    if ryu_provider_id == super::CHATGPT_PLAN_PROVIDER_ID {
        return Some(super::CHATGPT_PLAN_PROVIDER_ID);
    }
    let meta = super::provider_meta(ryu_provider_id)?;
    let supports_login =
        meta.auth_kind == "subscription" || matches!(ryu_provider_id, "openrouter" | "xai");
    if !supports_login || meta.auth_key.is_empty() {
        return None;
    }
    if ryu_provider_id == super::CHATGPT_PROVIDER_ID {
        Some("openai-codex")
    } else {
        Some(meta.auth_key)
    }
}

/// Whether a Ryu provider is a subscription-plan OAuth integration rather
/// than an OAuth-capable BYOK provider such as OpenRouter or xAI.
pub fn is_subscription_oauth_provider(ryu_provider_id: &str) -> bool {
    super::provider_meta(ryu_provider_id).is_some_and(|meta| {
        meta.auth_kind == "subscription" && oauth_provider_id(ryu_provider_id).is_some()
    })
}

fn oauth_auth_key(ryu_provider_id: &str) -> Option<&'static str> {
    oauth_provider_id(ryu_provider_id)?;
    Some(super::provider_meta(ryu_provider_id)?.auth_key)
}

/// When the sealed account vault is available, save there before updating the
/// managed Pi's `auth.json`. A failed vault write must not report a successful
/// login whose requests still select an older sealed account. A node that
/// started without the vault retains the legacy single-account file fallback.
fn store_credential(auth_key: &str, credential: &Value) -> Result<()> {
    store_credential_with_vault(auth_key, credential, super::accounts::global())
}

fn store_credential_with_vault(
    auth_key: &str,
    credential: &Value,
    vault: Option<&super::accounts::AccountVault>,
) -> Result<()> {
    let _selection_guard = super::ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    super::ensure_dir()?;
    if let Some(vault) = vault {
        let scope = super::accounts::provider_scope(auth_key);
        let label = super::vault_account_label(vault, &scope, auth_key);
        vault.upsert(
            &scope,
            &super::new_account_id(),
            &label,
            super::accounts::KIND_OAUTH,
            Some(credential.clone()),
        )?;
    }
    let mut auth = super::read_auth();
    auth.insert(auth_key.to_owned(), credential.clone());
    let body = serde_json::to_string_pretty(&auth)?;
    super::write_secret_file(&super::auth_path(), &body)?;
    Ok(())
}

enum PlanLoginTarget {
    New,
    Existing {
        account_id: String,
        registration: super::chatgpt_plan::StoredAccount,
    },
}

fn store_plan_registration(
    vault: &super::accounts::AccountVault,
    target: &PlanLoginTarget,
    registration: &super::chatgpt_plan::StoredAccount,
) -> Result<String> {
    let _guard = super::ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    let scope = super::accounts::provider_scope(super::CHATGPT_PLAN_AUTH_KEY);
    let updated = serde_json::to_value(registration)?;
    match target {
        PlanLoginTarget::Existing {
            account_id,
            registration: original,
        } => {
            if !original.matches_registration(registration) {
                anyhow::bail!("ChatGPT returned another account registration; the saved account was not changed");
            }
            let current = vault
                .credential(&scope, account_id)?
                .ok_or_else(|| anyhow!("The saved ChatGPT account was removed during sign-in"))?;
            let current_registration = super::chatgpt_plan::StoredAccount::from_value(&current)?;
            if !current_registration.matches_registration(registration)
                || !vault.replace_credential(&scope, account_id, &current, updated)?
            {
                anyhow::bail!("The saved ChatGPT registration changed during sign-in; retry");
            }
            // Reconnection renews this registration without changing a selection
            // the user made while the browser was open.
            Ok(account_id.clone())
        }
        PlanLoginTarget::New => {
            for account in vault.list(&scope)? {
                let Some(current) = vault.credential(&scope, &account.account_id)? else {
                    continue;
                };
                let Ok(saved) = super::chatgpt_plan::StoredAccount::from_value(&current) else {
                    continue;
                };
                if saved.matches_registration(registration) {
                    if !vault.replace_credential(&scope, &account.account_id, &current, updated)? {
                        anyhow::bail!(
                            "The saved ChatGPT registration changed during sign-in; retry"
                        );
                    }
                    vault.set_active(&scope, &account.account_id)?;
                    return Ok(account.account_id);
                }
            }
            let account_id = super::new_account_id();
            let identity = registration.registration();
            let label = super::vault_account_label(
                vault,
                &scope,
                identity.email.as_deref().unwrap_or("ChatGPT plan"),
            );
            vault.upsert(
                &scope,
                &account_id,
                &label,
                super::accounts::KIND_OAUTH,
                Some(updated),
            )?;
            Ok(account_id)
        }
    }
}

async fn start_chatgpt_plan(account_id: Option<&str>, enable_plan_use: bool) -> Result<String> {
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start_guard = START_LOCK.lock().await;
    let vault = super::accounts::global().ok_or_else(|| {
        anyhow!("The sealed account vault must be available before ChatGPT sign-in")
    })?;
    let scope = super::accounts::provider_scope(super::CHATGPT_PLAN_AUTH_KEY);
    let target = match account_id {
        Some(id) if !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) => {
            let value = vault
                .credential(&scope, id)?
                .ok_or_else(|| anyhow!("This ChatGPT account registration is not saved"))?;
            PlanLoginTarget::Existing {
                account_id: id.to_owned(),
                registration: super::chatgpt_plan::StoredAccount::from_value(&value)?,
            }
        }
        Some(_) => anyhow::bail!("Choose a valid saved ChatGPT account"),
        None => PlanLoginTarget::New,
    };
    let stale: Vec<_> = sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .iter()
        .filter(|(_, session)| session.provider == super::CHATGPT_PLAN_PROVIDER_ID)
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        cancel(&id);
    }
    let existing = match &target {
        PlanLoginTarget::New => None,
        PlanLoginTarget::Existing { registration, .. } => Some(registration.clone()),
    };
    let attempt = super::chatgpt_plan::LoginAttempt::begin(existing, enable_plan_use).await?;
    let url = attempt.authorization_url()?;
    let (tx, _) = broadcast::channel(64);
    let session = Arc::new(LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: super::CHATGPT_PLAN_PROVIDER_ID.to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    });
    session.emit(json!({ "type": "auth_url", "url": url,
        "instructions": "Review identity and ChatGPT plan permissions in the browser. Complete sign-in on the host running Core." }));
    let session_id = format!("login_{}", uuid::Uuid::new_v4().simple());
    sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .insert(session_id.clone(), session.clone());
    let task_session = session.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let mut attempt = attempt;
            let mut retried = false;
            let registration = loop {
                match attempt.complete().await {
                    Ok(registration) => break registration,
                    Err(error) if !retried && super::chatgpt_plan::retry_registration(&error).is_some() => {
                        retried = true;
                        if task_session.is_finished() { anyhow::bail!("Sign-in was cancelled"); }
                        attempt = match &target {
                            PlanLoginTarget::New => super::chatgpt_plan::LoginAttempt::retry(
                                super::chatgpt_plan::retry_registration(&error).expect("retry registration")).await?,
                            PlanLoginTarget::Existing { registration, .. } =>
                                super::chatgpt_plan::LoginAttempt::begin(Some(registration.clone()), enable_plan_use).await?,
                        };
                        task_session.emit(json!({ "type": "info", "message": "The code expired. Continue authorization again; your issued registration is retained." }));
                        task_session.emit(json!({ "type": "auth_url", "url": attempt.authorization_url()?,
                            "instructions": "Complete the fresh authorization attempt in your browser." }));
                    }
                    Err(error) => return Err(error),
                }
            };
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let _refresh_guard = super::OAUTH_REFRESH_LOCK.lock().await;
            let account_id = store_plan_registration(vault, &target, &registration)?;
            Ok::<_, anyhow::Error>((account_id, registration.plan_authorized()))
        }
        .await;
        if !task_session.is_finished() {
            match result {
                Ok((account_id, authorized)) => task_session.emit(json!({ "type": "success",
                    "provider": super::CHATGPT_PLAN_AUTH_KEY, "accountId": account_id,
                    "planUseAuthorized": authorized })),
                Err(error) => {
                    task_session.emit(json!({ "type": "error", "message": error.to_string() }))
                }
            }
        }
        task_session.finished.store(true, Ordering::SeqCst);
        if let Ok(mut abort) = task_session.native_abort.lock() {
            *abort = None;
        }
    });
    *session
        .native_abort
        .lock()
        .map_err(|_| anyhow!("Login cancellation is unavailable"))? = Some(task.abort_handle());
    let timeout_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LOGIN_TIMEOUT).await;
        cancel(&timeout_id);
    });
    Ok(session_id)
}

async fn start_kiro(account_id: Option<&str>) -> Result<String> {
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start_guard = START_LOCK.lock().await;
    let vault = super::accounts::global()
        .ok_or_else(|| anyhow!("The sealed account vault is required for Kiro sign-in"))?;
    let scope = super::accounts::provider_scope("kiro");
    let original = match account_id {
        Some(id) => Some((
            id.to_owned(),
            vault
                .credential_revision(&scope, id)?
                .ok_or_else(|| anyhow!("The saved Kiro account is unavailable"))?,
            vault
                .credential(&scope, id)?
                .ok_or_else(|| anyhow!("The saved Kiro account is unavailable"))?,
        )),
        None => None,
    };
    let stale: Vec<_> = sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .iter()
        .filter(|(_, session)| session.provider == "kiro")
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        cancel(&id);
    }
    let attempt = super::kiro_oauth::begin().await?;
    let (tx, _) = broadcast::channel(64);
    let session = Arc::new(LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: "kiro".to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    });
    session.emit(json!({"type":"auth_url", "url":attempt.auth_url, "instructions":format!("Sign in with AWS Builder ID. Enter code {} if requested.", attempt.device_code)}));
    let session_id = format!("login_{}", uuid::Uuid::new_v4().simple());
    sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .insert(session_id.clone(), session.clone());
    let task_session = session.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let credential = attempt.complete().await?;
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let _guard = super::OAUTH_REFRESH_LOCK.lock().await;
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let id = if let Some((id, revision, previous)) = original {
                if previous
                    .get("profileArn")
                    .and_then(Value::as_str)
                    .zip(credential.get("profileArn").and_then(Value::as_str))
                    .is_some_and(|(before, after)| before != after)
                {
                    anyhow::bail!(
                        "Kiro returned another profile; the saved account was not changed"
                    );
                }
                if !vault.finish_refresh(&scope, &id, &previous, &revision, credential)? {
                    anyhow::bail!("The saved Kiro login changed during sign-in; retry");
                }
                id
            } else {
                let id = super::new_account_id();
                let label = super::vault_account_label(vault, &scope, "kiro");
                vault.upsert(
                    &scope,
                    &id,
                    &label,
                    super::accounts::KIND_OAUTH,
                    Some(credential),
                )?;
                id
            };
            super::ensure_kiro_models_json(None)?;
            Ok::<_, anyhow::Error>(id)
        }
        .await;
        if !task_session.is_finished() {
            match result {
                Ok(id) => task_session.emit(json!({"type":"success", "provider":"kiro", "accountId":id})),
                Err(_) => task_session.emit(json!({"type":"error", "message":"Kiro sign-in could not be saved. Try signing in again."})),
            }
        }
        task_session.finished.store(true, Ordering::SeqCst);
    });
    *session
        .native_abort
        .lock()
        .map_err(|_| anyhow!("Login cancellation is unavailable"))? = Some(task.abort_handle());
    let timeout_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LOGIN_TIMEOUT).await;
        cancel(&timeout_id);
    });
    Ok(session_id)
}

/// Read the installed Pi provider's own model table without a network request.
/// Discovery remains usable when models.dev is offline or has no cached entry.
/// A missing managed Pi installation is normal during setup, so callers can
/// continue to the remote registry and free-text model input.
pub(super) fn builtin_catalog_provider_id(ryu_provider_id: &str) -> Option<&str> {
    oauth_provider_id(ryu_provider_id).or_else(|| {
        super::provider_meta(ryu_provider_id)
            .filter(|meta| meta.auth_kind == "api-key" && !meta.auth_key.is_empty())
            .map(|meta| meta.auth_key)
    })
}

pub async fn builtin_models(ryu_provider_id: &str) -> Vec<Value> {
    if ryu_provider_id == super::CHATGPT_PLAN_PROVIDER_ID {
        return Vec::new();
    }
    let Some(provider) = builtin_catalog_provider_id(ryu_provider_id) else {
        return Vec::new();
    };
    let pi_dir = crate::sidecar::adapters::acp::managed_pi_dir();
    if !pi_dir
        .join("node_modules/@earendil-works/pi-ai/package.json")
        .is_file()
    {
        return Vec::new();
    }
    let Some(runtime) = js_runtime() else {
        return Vec::new();
    };
    if ensure_bridge().is_err() {
        return Vec::new();
    }

    let mut command = tokio::process::Command::new(runtime);
    command
        .arg(BRIDGE_FILE)
        .arg(provider)
        .arg("models")
        .current_dir(pi_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_window();
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return Vec::new();
    };
    // Cold SDK imports can exceed five seconds on Windows under build/disk load.
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut lines = BufReader::new(stdout).lines();
        let Some(line) = lines.next_line().await.ok().flatten() else {
            return Vec::new();
        };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            return Vec::new();
        };
        if event.get("type").and_then(Value::as_str) != Some("models") {
            return Vec::new();
        }
        event
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    result.unwrap_or_default()
}

/// Ask Pi's own OAuth implementation to rotate an account credential. The
/// credential travels over the child's stdin/stdout pipes, never in argv, env,
/// stderr, or a log line. Each provider owns its token exchange contract.
pub async fn refresh_credential(auth_key: &str, credential: &Value) -> Result<Option<Value>> {
    if auth_key == "kiro" {
        return super::kiro_oauth::refresh(credential.clone())
            .await
            .map(Some)
            .map_err(Into::into);
    }
    if auth_key == super::CHATGPT_PLAN_AUTH_KEY {
        let saved = super::chatgpt_plan::StoredAccount::from_value(credential)?;
        let rotated = super::chatgpt_plan::refresh(saved.credential()?.clone()).await?;
        return Ok(Some(serde_json::to_value(rotated)?));
    }
    let provider = match auth_key {
        super::CHATGPT_AUTH_KEY | "openai" => "openai-codex",
        "anthropic" | "openai-codex" | "github-copilot" | "kimi-coding" | "radius"
        | "openrouter" | "xai" => auth_key,
        _ => return Ok(None),
    };
    // These preparation failures occur before any credential is dispatched.
    let runtime = js_runtime().ok_or(super::accounts::RefreshFailure::Transient)?;
    crate::sidecar::adapters::acp::ensure_managed_pi()
        .await
        .map_err(|_| super::accounts::RefreshFailure::Transient)?;
    ensure_bridge().map_err(|_| super::accounts::RefreshFailure::Transient)?;

    let mut child = tokio::process::Command::new(runtime);
    child
        .arg(BRIDGE_FILE)
        .arg(provider)
        .arg("refresh")
        .current_dir(crate::sidecar::adapters::acp::managed_pi_dir())
        .env("PI_CODING_AGENT_DIR", super::config_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_window();
    if provider == "anthropic" {
        // A Claude route through the owner's desktop covers token refresh too.
        // A route that applies but cannot run refuses the refresh rather than
        // sending it from the cloud.
        child.envs(
            crate::local_egress::providers::bridge_proxy_env(
                crate::local_egress::providers::ProviderRoute::Claude,
            )
            .map_err(|_| super::accounts::RefreshFailure::Transient)?,
        );
    }
    let mut child = child
        .spawn()
        .map_err(|_| super::accounts::RefreshFailure::Transient)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(super::accounts::RefreshFailure::Transient)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(super::accounts::RefreshFailure::Transient)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let input = format!(
            "{}\n",
            json!({ "type": "refresh", "credential": credential })
        );
        stdin.write_all(input.as_bytes()).await?;
        stdin.flush().await?;
        drop(stdin);
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let event: Value = serde_json::from_str(&line)
                .context("OAuth refresh helper returned invalid JSON")?;
            match event.get("type").and_then(Value::as_str) {
                Some("done") => {
                    let refreshed = event.get("credential").cloned().unwrap_or(Value::Null);
                    if refreshed.get("type").and_then(Value::as_str) != Some("oauth")
                        || refreshed.get("access").and_then(Value::as_str).is_none()
                    {
                        anyhow::bail!("OAuth refresh helper returned an invalid credential");
                    }
                    return Ok(refreshed);
                }
                Some("error") => {
                    let failure = match event.get("refreshFailure").and_then(Value::as_str) {
                        Some("revoked") => super::accounts::RefreshFailure::Revoked,
                        Some("transient") => super::accounts::RefreshFailure::Transient,
                        _ => super::accounts::RefreshFailure::Uncertain,
                    };
                    return Err(failure.into());
                }
                _ => {}
            }
        }
        anyhow::bail!("OAuth refresh helper exited without a result")
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    Ok(Some(result.context("OAuth refresh helper timed out")??))
}

/// Begin a subscription login. Returns the session id the client streams from.
///
/// One login at a time per provider: a second attempt cancels the first rather
/// than racing it for the callback port.
pub async fn start(ryu_provider_id: &str) -> Result<String> {
    start_for_account(ryu_provider_id, None).await
}

pub async fn start_for_account(ryu_provider_id: &str, account_id: Option<&str>) -> Result<String> {
    start_with_options(ryu_provider_id, account_id, false).await
}

pub async fn start_with_options(
    ryu_provider_id: &str,
    account_id: Option<&str>,
    enable_plan_use: bool,
) -> Result<String> {
    if ryu_provider_id == "kiro" {
        return start_kiro(account_id).await;
    }
    if ryu_provider_id == super::CHATGPT_PLAN_PROVIDER_ID {
        return start_chatgpt_plan(account_id, enable_plan_use).await;
    }
    if account_id.is_some() || enable_plan_use {
        anyhow::bail!("This provider does not support reconnecting a selected registration");
    }
    let provider = oauth_provider_id(ryu_provider_id)
        .ok_or_else(|| anyhow!("\"{ryu_provider_id}\" is not a subscription login provider"))?;
    let auth_key = oauth_auth_key(ryu_provider_id)
        .ok_or_else(|| anyhow!("\"{ryu_provider_id}\" has no OAuth account scope"))?;
    let runtime = js_runtime().ok_or_else(|| {
        anyhow!(
            "no JavaScript runtime found — Ryu looked on PATH and in the usual Node/Bun install \
             locations. Install Node, then try signing in again"
        )
    })?;

    crate::sidecar::adapters::acp::ensure_managed_pi().await?;
    ensure_bridge()?;

    // Retire any earlier attempt for this provider before binding its port again.
    let stale: Vec<String> = sessions()
        .lock()
        .ok()
        .map(|m| {
            m.iter()
                .filter(|(_, s)| s.provider == provider)
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in stale {
        cancel(&id);
    }

    let mut command = tokio::process::Command::new(runtime);
    command
        // The process already runs in the managed Pi prefix. Passing its
        // filename keeps a Windows drive path out of Node's script argument.
        .arg(BRIDGE_FILE)
        .arg(provider)
        .current_dir(crate::sidecar::adapters::acp::managed_pi_dir())
        // The flow writes nothing itself, but Pi's own dir is the right context
        // for anything that reads configuration alongside it.
        .env("PI_CODING_AGENT_DIR", super::config_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window();
    if provider == "anthropic" {
        // The login's code exchange runs here too, so it takes the route.
        command.envs(
            crate::local_egress::providers::bridge_proxy_env(
                crate::local_egress::providers::ProviderRoute::Claude,
            )
            .map_err(|reason| anyhow::anyhow!(reason))?,
        );
    }

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("login bridge produced no stdout"))?;
    let stderr = child.stderr.take();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("login bridge accepted no stdin"))?;

    let (tx, _rx) = broadcast::channel(64);
    let session = Arc::new(LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(Some(stdin)),
        child: Mutex::new(Some(child)),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: provider.to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    });

    let session_id = format!("login_{}", uuid::Uuid::new_v4().simple());
    if let Ok(mut map) = sessions().lock() {
        map.insert(session_id.clone(), Arc::clone(&session));
    }

    // Reader: turn the bridge's JSONL into session events, and land the
    // credential when the flow completes.
    let auth_key = auth_key.to_owned();
    let reader_session = Arc::clone(&session);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
                tracing::debug!("pi oauth bridge: unparsable line");
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("done") => {
                    let credential = event.get("credential").cloned().unwrap_or(Value::Null);
                    match store_credential(&auth_key, &credential) {
                        Ok(()) => reader_session.emit(json!({
                            "type": "success",
                            "provider": auth_key,
                        })),
                        Err(e) => reader_session.emit(json!({
                            "type": "error",
                            "message": format!("signed in, but the credential could not be saved: {e}"),
                        })),
                    }
                    reader_session.finished.store(true, Ordering::SeqCst);
                }
                Some("error") => {
                    reader_session.emit(event);
                    reader_session.finished.store(true, Ordering::SeqCst);
                }
                // The credential must never reach a client; every other event is
                // UI-facing and forwarded as-is.
                _ => reader_session.emit(event),
            }
        }
        // Stream closed. If the child died without a terminal event, say so —
        // and say WHY. `cancel()` marks `finished` before it kills, so reaching
        // here means the bridge died on its own, and the only evidence of that
        // is its exit status plus whatever it managed to print on stderr.
        if !reader_session.is_finished() {
            // Take the child OUT of the session before waiting on it: `child` is
            // a std `Mutex`, and holding its guard across an `.await` would make
            // this future non-`Send` and refuse to spawn. Taking it also means
            // `cancel()` below — and the 15-minute backstop — can no longer
            // reach this child, so [`reap_or_kill`] has to leave it dead on
            // every path out.
            let orphan = reader_session
                .child
                .lock()
                .ok()
                .and_then(|mut guard| guard.take());
            let status = match orphan {
                Some(mut child) => reap_or_kill(&mut child, EXIT_STATUS_WAIT).await,
                None => None,
            };
            // Reading stderr after the wait is a best-effort ordering, NOT a
            // barrier: nothing synchronizes this task with the stderr task, and
            // `wait()` on a child that has already exited returns immediately.
            // What it buys is an await point, which is usually enough for the
            // stderr readiness already queued behind Node's own "print the
            // stack, then exit" to be polled first. When it is not, the tail is
            // empty and `exit_message` degrades to the bare sentence.
            reader_session.emit(json!({
                "type": "error",
                "message": exit_message(status, &reader_session.recent_stderr()),
            }));
            reader_session.finished.store(true, Ordering::SeqCst);
        }
        reader_session.cancel();
    });

    if let Some(stderr) = stderr {
        let stderr_session = Arc::clone(&session);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_session.push_stderr(line);
            }
        });
    }

    // Backstop: never let an abandoned attempt hold its callback port.
    let timeout_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LOGIN_TIMEOUT).await;
        if let Some(session) = get(&timeout_id) {
            if !session.is_finished() {
                session.emit(json!({
                    "type": "error",
                    "message": "the login timed out — start it again",
                }));
            }
        }
        cancel(&timeout_id);
    });

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_registration(client: &str, access: &str) -> super::super::chatgpt_plan::StoredAccount {
        super::super::chatgpt_plan::StoredAccount::from_value(&json!({
            "state": "connected", "type": "oauth", "flow": "chatgpt-plan",
            "access": access, "refresh": "synthetic-refresh", "expires": 1_900_000_000_000_u64,
            "clientId": client, "hostId": format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            "issuer": "https://auth.openai.com", "subject": "same-subject",
            "idToken": "synthetic-id-token", "email": "same@example.com",
            "scopes": ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]
        }))
        .unwrap()
    }

    #[test]
    fn native_registrations_are_sealed_and_reconnect_preserves_another_active_account() {
        crate::pi_config::tests::with_temp_dir(|| {
            let vault = super::super::accounts::AccountVault::in_memory().unwrap();
            let scope = super::super::accounts::provider_scope(super::super::CHATGPT_PLAN_AUTH_KEY);
            let first = plan_registration("oaiapp_first", "first-access");
            let second = plan_registration("oaiapp_second", "second-access");
            let first_id = store_plan_registration(&vault, &PlanLoginTarget::New, &first).unwrap();
            let second_id =
                store_plan_registration(&vault, &PlanLoginTarget::New, &second).unwrap();
            assert_eq!(vault.count(&scope).unwrap(), 2);
            assert!(!super::super::read_auth().contains_key(super::super::CHATGPT_PLAN_AUTH_KEY));
            let target = PlanLoginTarget::Existing {
                account_id: first_id.clone(),
                registration: first,
            };
            let renewed = plan_registration("oaiapp_first", "renewed-access");
            assert_eq!(
                store_plan_registration(&vault, &target, &renewed).unwrap(),
                first_id
            );
            assert_eq!(
                vault.active_info(&scope).unwrap().unwrap().account_id,
                second_id
            );
            assert_eq!(
                vault.credential(&scope, &first_id).unwrap().unwrap()["access"],
                "renewed-access"
            );
            assert_eq!(
                vault.credential(&scope, &second_id).unwrap().unwrap()["access"],
                "second-access"
            );
            assert!(store_plan_registration(&vault, &target, &second).is_err());
            vault.remove(&scope, &first_id).unwrap();
            assert!(store_plan_registration(&vault, &target, &renewed).is_err());
            assert_eq!(vault.count(&scope).unwrap(), 1);
        });
    }

    #[test]
    fn completed_oauth_login_is_sealed_and_materialized_as_the_same_account() {
        crate::pi_config::tests::with_temp_dir(|| {
            let vault = super::super::accounts::AccountVault::in_memory().expect("vault");
            let credential = json!({
                "type": "oauth",
                "access": "test-access",
                "refresh": "test-refresh",
                "expires": 1_900_000_000_000_u64
            });
            store_credential_with_vault("anthropic", &credential, Some(&vault))
                .expect("store completed login");
            let scope = super::super::accounts::provider_scope("anthropic");
            assert_eq!(
                vault
                    .active_credential(&scope)
                    .expect("sealed account")
                    .map(|(_, value)| value),
                Some(credential.clone())
            );
            assert_eq!(super::super::read_auth()["anthropic"], credential);

            let another =
                json!({"type":"oauth","access":"second-access","refresh":"second-refresh"});
            store_credential_with_vault("anthropic", &another, Some(&vault))
                .expect("add another login");
            assert_eq!(vault.count(&scope).expect("account count"), 2);
            assert_eq!(
                vault
                    .active_credential(&scope)
                    .expect("active account")
                    .map(|(_, value)| value),
                Some(another.clone())
            );
            assert_eq!(super::super::read_auth()["anthropic"], another);
        });
    }

    /// A session with no child, for the bookkeeping the flow does around one.
    fn bare_session() -> LoginSession {
        let (tx, _rx) = broadcast::channel(8);
        LoginSession {
            tx,
            history: Mutex::new(Vec::new()),
            stdin: tokio::sync::Mutex::new(None),
            child: Mutex::new(None),
            native_abort: Mutex::new(None),
            finished: AtomicBool::new(false),
            provider: "anthropic".to_owned(),
            stderr_tail: Mutex::new(VecDeque::new()),
        }
    }

    /// The stderr tail is what turns "exited before completing" from a dead end
    /// into a diagnosis, so it has to keep the LAST lines (a Node crash prints
    /// the useful `code:`/specifier after the stack) and stay bounded.
    #[test]
    fn the_stderr_tail_keeps_the_last_lines_in_order() {
        let session = bare_session();
        for i in 0..(STDERR_TAIL_LINES + 5) {
            session.push_stderr(format!("line {i}"));
        }
        let tail = session.recent_stderr();
        let lines: Vec<&str> = tail.lines().collect();
        assert_eq!(lines.len(), STDERR_TAIL_LINES, "the tail is bounded");
        assert_eq!(lines.first().copied(), Some("line 5"), "oldest dropped");
        assert_eq!(
            lines.last().copied(),
            Some(format!("line {}", STDERR_TAIL_LINES + 4).as_str()),
            "newest kept, in order"
        );
    }

    /// A cancelled session is finished the instant `cancel` returns, and saying
    /// so twice changes nothing (the reader task calls `cancel` after the
    /// registry already has).
    ///
    /// This is the POSTCONDITION only, and it held under the old buggy ordering
    /// too. The ordering itself is guarded by
    /// [`cancelling_publishes_finished_before_it_touches_the_child`].
    #[test]
    fn cancelling_marks_the_session_finished() {
        let session = bare_session();
        assert!(!session.is_finished());
        session.cancel();
        assert!(session.is_finished());
        // Idempotent: the reader task calls this after the registry already has.
        session.cancel();
        assert!(session.is_finished());
    }

    /// `cancel` must publish `finished` BEFORE it reaches for the child, so the
    /// reader task cannot see the killed child's stdout EOF while `finished` is
    /// still `false` and report a deliberate cancellation as "the login flow
    /// exited before completing" — the message that is supposed to mean the
    /// bridge died on its own.
    ///
    /// Asserting that ordering by racing the real reader task would be useless:
    /// the buggy window is a couple of instructions wide against an OS signal
    /// delivery, so it would pass under the bug almost every run. This uses the
    /// `child` mutex as a deterministic interposition point instead. While the
    /// test holds that lock, `cancel` is parked on it, and under the buggy order
    /// the store is downstream of the park and therefore CANNOT have happened.
    /// So a `false` reading here is proof of the bug, not of bad luck; the sleep
    /// only bounds the other direction (giving the thread time to enter
    /// `cancel`), and 200 ms is orders of magnitude more than an atomic store.
    #[test]
    fn cancelling_publishes_finished_before_it_touches_the_child() {
        let session = Arc::new(bare_session());
        let guard = session.child.lock().expect("take the child lock first");

        let canceller = Arc::clone(&session);
        let handle = std::thread::spawn(move || canceller.cancel());

        std::thread::sleep(std::time::Duration::from_millis(200));
        // Read before releasing: the whole point is what is observable WHILE
        // `cancel` is parked. Assert after the join so a failure cannot panic
        // with the lock held and poison it on the way out.
        let observed = session.is_finished();
        drop(guard);
        handle.join().expect("the cancelling thread must not panic");

        assert!(
            observed,
            "`cancel` reached the child before publishing `finished`; move \
             `self.finished.store(…)` back to the top of `cancel()`"
        );
        assert!(session.is_finished(), "and it stays finished afterwards");
    }

    /// A sleeper long enough to outlive any wait these tests use.
    fn long_sleeper() -> tokio::process::Command {
        #[cfg(unix)]
        let mut command = {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg("sleep 30");
            c
        };
        // `timeout` refuses to run with redirected stdin ("input redirection is
        // not supported"), so it would exit instantly and false-pass; `ping`
        // sleeps without needing a console.
        #[cfg(windows)]
        let mut command = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/c", "ping", "-n", "31", "127.0.0.1"]);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    /// A child that outlives the exit-status wait must be KILLED, not dropped.
    /// By that point it has been taken out of the session, so `cancel()` and the
    /// 15-minute backstop can no longer reach it, and tokio does not kill on
    /// drop — a survivor keeps the fixed OAuth callback port bound for the rest
    /// of the machine's uptime and every later login 400s with `EADDRINUSE`.
    #[tokio::test]
    async fn a_child_that_outlives_the_status_wait_is_killed_not_dropped() {
        let mut child = long_sleeper().spawn().expect("spawn the sleeper");
        let status = reap_or_kill(&mut child, std::time::Duration::from_millis(50)).await;
        assert!(
            status.is_none(),
            "a child still running at the ceiling has no exit status to report"
        );
        // If the kill did not land this hangs for the sleeper's full 30 s.
        let reaped = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("the kill must land, so the child is immediately reapable")
            .expect("wait on the killed child");
        assert!(
            !reaped.success(),
            "the child was killed, not left to finish on its own"
        );
    }

    /// The normal path is unchanged: a child that has already exited yields its
    /// status, and nothing is killed.
    #[tokio::test]
    async fn a_child_that_already_exited_reports_its_status() {
        #[cfg(unix)]
        let mut command = tokio::process::Command::new("sh");
        #[cfg(unix)]
        command.arg("-c").arg("exit 3");
        #[cfg(windows)]
        let mut command = tokio::process::Command::new("cmd");
        #[cfg(windows)]
        command.args(["/c", "exit", "3"]);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        // Establish the fixture's already-exited state before exercising the
        // reap deadline, which must not include cold process startup.
        let exited = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("the fixture must exit before exercising reaping")
            .expect("wait on the exited fixture");
        assert_eq!(exited.code(), Some(3));
        let status = reap_or_kill(&mut child, EXIT_STATUS_WAIT)
            .await
            .expect("an exited child reports a status");
        assert_eq!(
            status.code(),
            Some(3),
            "the real exit code reaches the user"
        );
    }

    /// Vendor stderr can include a token. Preserve useful fixed diagnostics
    /// without reflecting arbitrary helper output to the UI.
    #[test]
    fn the_exit_message_classifies_stderr_without_reflecting_secrets() {
        assert_eq!(
            exit_message(None, ""),
            "the login flow exited before completing"
        );
        assert_eq!(
            exit_message(None, "  Cannot find package '@earendil-works/pi-ai'  "),
            "the login flow exited before completing — the managed Pi package could not be loaded"
        );
        assert_eq!(
            exit_message(None, "request failed; access_token=secret-value"),
            "the login flow exited before completing"
        );
    }

    /// The pi-ai OAuth provider id for a Ryu provider is its `auth.json` key.
    /// These coincide by construction, and the login writes the credential under
    /// exactly the key `provider_configured` reads — so if this mapping ever
    /// drifts, a completed login would leave the card saying "Not connected".
    #[test]
    fn subscription_providers_map_to_their_auth_keys() {
        assert_eq!(oauth_provider_id("claude-pro-max"), Some("anthropic"));
        assert_eq!(oauth_provider_id("openai-codex"), Some("openai-codex"));
        assert_eq!(oauth_provider_id("chatgpt"), Some("openai-codex"));
        assert_eq!(oauth_provider_id("github-copilot"), Some("github-copilot"));
        assert_eq!(oauth_provider_id("kimi-coding"), Some("kimi-coding"));
        assert_eq!(oauth_provider_id("radius"), Some("radius"));
        assert_eq!(oauth_provider_id("openrouter"), Some("openrouter"));
        assert_eq!(oauth_provider_id("xai"), Some("xai"));
        // Not a login provider: an api-key provider has nothing to log into.
        assert_eq!(oauth_provider_id("openai"), None);
        assert_eq!(oauth_provider_id("nope"), None);
    }

    #[test]
    fn every_login_account_has_a_pre_turn_refresh_lane() {
        for provider in super::super::PROVIDERS {
            if oauth_provider_id(provider.id).is_some() {
                assert!(
                    super::super::OAUTH_REFRESH_KEYS.contains(&provider.auth_key),
                    "{} has login but no refresh lane for {}",
                    provider.id,
                    provider.auth_key
                );
            }
        }
    }

    #[test]
    fn subscription_oauth_classifier_excludes_oauth_capable_byok_providers() {
        for provider in [
            "openai-codex",
            "chatgpt",
            "claude-pro-max",
            "github-copilot",
            "kimi-coding",
            "radius",
        ] {
            assert!(is_subscription_oauth_provider(provider), "{provider}");
        }
        for provider in ["openrouter", "xai", "openai", "unknown"] {
            assert!(!is_subscription_oauth_provider(provider), "{provider}");
        }
    }

    /// The runtime probe must find an interpreter by its PLATFORM file name, not
    /// by the bare literal. Probing `<dir>/node` is what made every Windows host
    /// (where it is `node.exe`) answer "no JavaScript runtime found" and fail the
    /// login with a 400 before the flow ever started. `sh`/`cmd` stand in for the
    /// interpreters here because they are the only executables guaranteed to be
    /// present on a CI box — the lookup is the same one.
    #[test]
    fn the_runtime_probe_resolves_by_platform_file_name() {
        #[cfg(unix)]
        let known = "sh";
        #[cfg(windows)]
        let known = "cmd";
        assert!(
            crate::sidecar::manifest_sidecar::which_on_path(known).is_some(),
            "the probe backing js_runtime cannot find {known}"
        );
        let missing =
            crate::sidecar::manifest_sidecar::which_on_path("definitely-not-a-real-runtime-xyz");
        assert!(missing.is_none());
    }

    /// A completed login must land in `auth.json` WITHOUT disturbing any other
    /// provider's entry, and must be visible to the same check the provider card
    /// renders from.
    #[test]
    fn storing_a_credential_connects_that_provider_and_preserves_others() {
        crate::pi_config::tests::with_temp_dir(|| {
            // A legacy plaintext entry (as an older build or Pi itself wrote it).
            super::super::ensure_dir().expect("config dir");
            super::super::write_secret_file(
                &super::super::auth_path(),
                r#"{"openai":{"type":"api_key","key":"sk-existing"}}"#,
            )
            .expect("seed api key");
            assert_eq!(
                super::super::subscription_login_present("claude-pro-max"),
                Some(false),
                "not connected before the login"
            );

            store_credential(
                "anthropic",
                &json!({ "type": "oauth", "access": "tok", "refresh": "ref" }),
            )
            .expect("store credential");

            assert_eq!(
                super::super::subscription_login_present("claude-pro-max"),
                Some(true),
                "the card flips to Connected off the stored credential"
            );
            // The unrelated api-key entry survives the merge.
            let auth = super::super::read_auth();
            assert_eq!(
                auth.get("openai")
                    .and_then(|v| v.get("key"))
                    .and_then(|v| v.as_str()),
                Some("sk-existing")
            );
        });
    }

    #[test]
    fn claude_login_and_anthropic_api_key_report_separate_connection_states() {
        crate::pi_config::tests::with_temp_dir(|| {
            super::super::ensure_dir().expect("config dir");
            super::super::write_secret_file(
                &super::super::auth_path(),
                r#"{"anthropic":{"type":"api_key","key":"sk-test"}}"#,
            )
            .expect("seed API key");
            assert_eq!(
                super::super::subscription_login_present("claude-pro-max"),
                Some(false),
                "an Anthropic API key must not claim a Claude subscription login"
            );

            store_credential(
                "anthropic",
                &json!({ "type": "oauth", "access": "tok", "refresh": "ref" }),
            )
            .expect("store OAuth login");
            assert_eq!(
                super::super::subscription_login_present("claude-pro-max"),
                Some(true)
            );
            assert!(
                !super::super::provider_configured(
                    super::super::provider_meta("anthropic").expect("API-key row")
                ),
                "an OAuth login must not claim an Anthropic API key"
            );
        });
    }

    #[test]
    fn refreshed_claude_expiry_is_written_in_both_core_and_pi_units() {
        crate::pi_config::tests::with_temp_dir(|| {
            store_credential(
                "anthropic",
                &json!({ "type": "oauth", "access": "old", "refresh": "old-refresh", "expires": 1 }),
            )
            .expect("seed OAuth login");
            super::super::persist_oauth_refresh(
                "anthropic",
                &super::super::read_auth()["anthropic"],
                None,
                "new",
                Some("new-refresh"),
                Some(1_900_000_000),
            )
            .expect("persist refresh");
            let credential = super::super::read_auth()
                .remove("anthropic")
                .expect("stored credential");
            assert_eq!(credential["expires_at"], json!(1_900_000_000));
            assert_eq!(credential["expires"], json!(1_900_000_000_000_u64));
            assert_eq!(credential["refresh"], json!("new-refresh"));
        });
    }

    #[test]
    fn refreshed_claude_token_replaces_only_the_active_sealed_account() {
        crate::pi_config::tests::with_temp_dir(|| {
            let vault = super::super::accounts::AccountVault::in_memory().expect("vault");
            let scope = super::super::accounts::provider_scope("anthropic");
            let first = json!({ "type": "oauth", "access": "first", "refresh": "first-refresh" });
            let second =
                json!({ "type": "oauth", "access": "second", "refresh": "second-refresh" });
            vault
                .upsert(
                    &scope,
                    "account-a",
                    "First",
                    super::super::accounts::KIND_OAUTH,
                    Some(first.clone()),
                )
                .expect("first account");
            vault
                .upsert(
                    &scope,
                    "account-b",
                    "Second",
                    super::super::accounts::KIND_OAUTH,
                    Some(second.clone()),
                )
                .expect("second account");
            store_credential("anthropic", &second).expect("materialized active account");

            super::super::persist_oauth_refresh_with_vault(
                "anthropic",
                &second,
                Some("account-b"),
                "rotated",
                Some("rotated-refresh"),
                Some(1_900_000_000),
                Some(&vault),
            )
            .expect("persist rotated credential");

            assert_eq!(vault.credential(&scope, "account-a").unwrap(), Some(first));
            let rotated = vault
                .credential(&scope, "account-b")
                .unwrap()
                .expect("active account credential");
            assert_eq!(rotated["access"], json!("rotated"));
            assert_eq!(rotated["refresh"], json!("rotated-refresh"));
            assert_eq!(rotated["expires"], json!(1_900_000_000_000_u64));
            assert_eq!(super::super::read_auth()["anthropic"], rotated);
        });
    }
}
#[test]
fn builtin_catalog_maps_api_keys_without_advertising_oauth() {
    for id in [
        "baseten",
        "ant-ling",
        "minimax-cn",
        "moonshotai-cn",
        "opencode",
        "opencode-go",
        "qwen-token-plan",
        "qwen-token-plan-cn",
        "qwen-token-plan-individual",
        "vercel-ai-gateway",
        "xiaomi",
        "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn",
        "xiaomi-token-plan-sgp",
        "zai-coding-cn",
    ] {
        assert_eq!(builtin_catalog_provider_id(id), Some(id));
        assert_eq!(oauth_provider_id(id), None);
    }
    assert_eq!(
        builtin_catalog_provider_id("claude-pro-max"),
        Some("anthropic")
    );
    assert_eq!(builtin_catalog_provider_id("custom-unknown"), None);
    assert_eq!(
        builtin_catalog_provider_id(crate::pi_config::GATEWAY_PROVIDER_ID),
        None
    );
}
