//! Per-agent subscription usage (the "usage bar" feature, à la CodexBar /
//! openusage). When an ACP agent that runs on its own subscription is active in
//! chat (Claude Code, Codex), the desktop shows that agent's rolling rate-limit
//! windows — the 5h "session" window and the weekly window — so the user can see
//! how close they are to their plan's cap.
//!
//! ## How the data is sourced
//!
//! These agents bypass Ryu's Gateway (they talk to the vendor directly with the
//! user's own subscription OAuth token), so Ryu can't observe their token spend.
//! Instead — exactly like CodexBar/openusage — we read the OAuth token the CLI
//! already stored on this machine and call the *same* usage endpoint the vendor's
//! own tool calls:
//!
//! - **Codex**: `~/.codex/auth.json` → `GET chatgpt.com/backend-api/wham/usage`
//!   (`rate_limit.primary_window` = 5h, `secondary_window` = weekly).
//! - **Claude**: `~/.claude/.credentials.json` → `GET api.anthropic.com/api/oauth/usage`
//!   (`five_hour`, `seven_day`, `seven_day_sonnet`, `extra_usage`).
//!
//! ## Why we never refresh the token
//!
//! These OAuth refresh tokens are single-use (they rotate on every refresh). If
//! Ryu refreshed, it would consume the refresh token the *real* CLI still has
//! stored — the CLI's next refresh would then fail with `refresh_token_reused`
//! and **log the user out of their coding agent**. So we only ever *read* the
//! access token and check its expiry locally (Claude carries `expiresAt`; Codex's
//! access token is a JWT with an `exp` claim). If it's still fresh we call the
//! usage API; if it's expired we return a structured "expired" snapshot and let
//! the real CLI refresh on its own next use. Because the feature targets the
//! *active* agent — which just used (and so just refreshed) its own token — a
//! fresh token is the common case.
//!
//! Tokens NEVER appear in logs or in the response body. The endpoint returns
//! normalized snapshots only.
//!
//! ## Known gaps (scoped, not silent)
//!
//! - **macOS**: Claude Code / Codex store credentials in the Keychain there, so
//!   the on-disk file is stale or absent and a Mac user would read empty. v1
//!   reads the file path (correct on Windows/Linux); Keychain is deferred.
//! - **Remote node**: Core reads *its own* machine's `~/.codex`/`~/.claude`. For
//!   local Core (the common case) that's where the agents run, so it's correct;
//!   a remote node would report its own creds, not the user's laptop's.
//! - **Gemini / Pi / claw / ryu**: no subscription usage window → `unsupported`,
//!   which makes the desktop bar hide rather than error.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

/// One rolling rate-limit window, normalized across vendors. `used_percent` is
/// 0–100; `resets_at` is RFC3339 when known.
#[derive(Debug, Clone, Serialize)]
pub struct UsageWindow {
    /// Human label: "Session" (5h), "Weekly", "Sonnet weekly", …
    pub label: String,
    /// Percent of the window's cap consumed (0–100).
    pub used_percent: f64,
    /// When this window resets, RFC3339, if the vendor told us.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// Why a snapshot has no live windows. Drives the desktop's decision to hide
/// (unsupported) vs. show a hint (the rest).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageUnavailable {
    /// The active agent has no subscription usage window we can read.
    Unsupported,
    /// No credential file / token on disk — the user hasn't logged into the CLI.
    NotLoggedIn,
    /// The stored access token is expired; the real CLI will refresh it on next
    /// use. We deliberately don't refresh (single-use refresh tokens).
    TokenExpired,
    /// The stored token can authenticate for inference but lacks the scope the
    /// usage endpoint needs (e.g. a `claude setup-token` token without
    /// `user:profile`).
    MissingScope,
    /// The vendor's usage endpoint rate-limited us. Back off; try later.
    RateLimited,
    /// The usage call failed (network / non-2xx / unparseable). Transient.
    Error,
}

/// A normalized usage snapshot for one agent. Always 200 from the endpoint;
/// refusals carry `available=false` + a `reason` rather than an HTTP error, so
/// the desktop never branches on status codes.
#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    /// The agent id this snapshot is for (echoed back).
    pub agent_id: String,
    /// The engine we resolved it to ("claude" | "codex"), or "" if unsupported.
    pub engine: String,
    /// Whether `windows` carry live data.
    pub available: bool,
    /// Plan label when known ("Max 20x", "Pro", …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Set when `available=false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<UsageUnavailable>,
    /// The rolling windows (Session / Weekly / …). Empty when unavailable.
    pub windows: Vec<UsageWindow>,
    /// Pay-as-you-go "extra usage" dollars spent this month, when the plan has it
    /// enabled (Claude only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_usage_usd: Option<f64>,
}

impl UsageSnapshot {
    fn unavailable(agent_id: &str, engine: &str, reason: UsageUnavailable) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            engine: engine.to_string(),
            available: false,
            plan: None,
            reason: Some(reason),
            windows: Vec::new(),
            extra_usage_usd: None,
        }
    }
}

/// The subscription engines we can read usage for. Derived from the agent id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    Claude,
    Codex,
}

/// Map an agent id to the subscription engine whose usage we can read, or `None`
/// for agents with no readable subscription window. v1 keys off the curated ACP
/// ids; a substring check also catches engine-direct / custom ids built on the
/// same CLI ("claude", "acp:codex", …).
fn engine_for_agent(agent_id: &str) -> Option<Engine> {
    let id = agent_id.to_ascii_lowercase();
    if id == "acp:claude" || id.contains("claude") {
        return Some(Engine::Claude);
    }
    if id == "acp:codex" || id.contains("codex") {
        return Some(Engine::Codex);
    }
    None
}

/// Public entry point used by the HTTP handler. Never errors — always returns a
/// snapshot (refusals carry a `reason`).
pub async fn fetch_usage(agent_id: &str) -> UsageSnapshot {
    let Some(engine) = engine_for_agent(agent_id) else {
        return UsageSnapshot::unavailable(agent_id, "", UsageUnavailable::Unsupported);
    };
    match engine {
        Engine::Claude => claude::fetch(agent_id).await,
        Engine::Codex => codex::fetch(agent_id).await,
    }
}

/// Shared HTTP client for the vendor usage calls. Short timeout — this backs a
/// polled widget, never a hot path.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

/// Unix-seconds expiry from a JWT's `exp` claim, read WITHOUT verifying the
/// signature (we only need the claim, never trust it). Returns `None` when the
/// token isn't a 3-part JWT or has no numeric `exp`.
fn jwt_exp_unix(token: &str) -> Option<i64> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("exp").and_then(serde_json::Value::as_i64)
}

/// Read a small credential file as text, or `None` if it's missing/unreadable.
fn read_file(path: &PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Map a reqwest status to the unavailable reason a non-2xx implies.
fn reason_for_status(status: reqwest::StatusCode) -> UsageUnavailable {
    match status.as_u16() {
        401 | 403 => UsageUnavailable::TokenExpired,
        429 => UsageUnavailable::RateLimited,
        _ => UsageUnavailable::Error,
    }
}

mod claude;
mod codex;

#[cfg(test)]
mod tests;
