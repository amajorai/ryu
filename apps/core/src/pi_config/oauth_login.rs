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

mod bridge;
mod login_text;
mod models;
mod native_flows;
mod session;
#[cfg(test)]
mod tests;

use bridge::{ensure_bridge, js_runtime};
pub(super) use models::builtin_catalog_provider_id;
pub use models::{builtin_models, refresh_credential};
use native_flows::{start_chatgpt_plan, start_kiro};
#[cfg(test)]
use native_flows::{store_plan_registration, PlanLoginTarget};
pub use session::{cancel, get, LoginSession};
use session::{exit_message, reap_or_kill, sessions};

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
