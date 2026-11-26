//! Managed-bot pairing — how a Telegram child bot's token reaches THIS node
//! without the user ever opening @BotFather.
//!
//! Telegram Bot API 9.6 ("managed bots") lets a *manager* bot create bots owned by
//! a user. Every 9.6 surface — `can_manage_bots`, `request_managed_bot`,
//! `Update.managed_bot`, `getManagedBotToken` — lands on the MANAGER, which for Ryu
//! is the hosted `apps/cloud-bot` service, not this node and not the child bot. The
//! child bot is served by the EXISTING, untouched Rust adapter
//! (`crates/gateway/channels/src/telegram.rs`), which only ever wants one thing:
//! `StoredBotConfig.secrets["bot_token"]`. So the only new mechanism is **how the
//! token arrives**, and this module is the node's half of it:
//!
//! 1. `POST {manager}/managed-bot/pair` mints a `(nonce, claim_secret)` pair.
//!    The nonce is PUBLIC — it rides a deep link and a QR the user may put on
//!    screen. The claim_secret NEVER leaves the node and is required to claim, so a
//!    shoulder-surfed nonce alone yields nothing.
//! 2. The user opens the deep link, presses Start, taps the `request_managed_bot`
//!    button; the manager fetches the new bot's token via `getManagedBotToken`.
//! 3. The node polls `GET {manager}/managed-bot/claim/{nonce}` with the
//!    claim_secret as a bearer until it answers `ready`, then writes the token into
//!    the SAME place a hand-pasted token goes.
//!
//! **Placement.** Core owns no channel-config storage — the channel bot config
//! lives in the control plane (`packages/api` → Mongo `channelConfig`, secrets
//! sealed per value). This module therefore *drives* the existing write path
//! (`POST /api/channels`, `PATCH /api/channels/:id`) as an HTTP client with the
//! device account's bearer, exactly like [`crate::server::sync::SyncClient`] does
//! for conversations. There is deliberately no second store: the token, the
//! claim_secret and the nonce all end up in the one `secrets` map the gateway
//! already reads, so the existing reload spawns the child adapter with zero
//! adapter changes.
//!
//! **Secret hygiene.** A bot token is a full credential and the claim_secret is the
//! only thing standing between a public nonce and that credential. Both are wrapped
//! in [`Secret`], which has a redacting `Debug` and — on purpose — no `Serialize`
//! and no `Display`: a secret cannot reach a response body, a log line or the
//! OpenAPI schema by accident, only through an explicit [`Secret::expose`] at the
//! two call sites that must send it. Manager responses are never echoed into an
//! error, because a manager response body *is* the token.

use std::{
    collections::HashMap,
    fmt,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::sync::backend::BackendError;

/// Base URL of the manager service (`apps/cloud-bot`). Overridable so a dev node
/// can point at a locally-run manager; the default is the hosted one.
pub const MANAGER_URL_ENV: &str = "RYU_MANAGED_BOT_URL";
/// Hosted manager. Resolution order is explicit arg → env → this, matching the
/// `RyuMarketplaceSource` convention for Core → Ryu-hosted-service clients.
pub const DEFAULT_MANAGER_BASE: &str = "https://bot.ryuhq.com";

/// Every manager call is a short control-plane round trip; a hung manager must not
/// wedge a desktop poll.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Hard local ceiling on a pairing's lifetime, applied on top of the manager's own
/// `expires_at`. The contract says the manager expires a pairing after 10 minutes;
/// this ceiling means a manager that returns an absurd (or unparseable) expiry
/// still cannot leave a claim_secret resident forever. Mirrors the
/// `SUPPORT_ACCESS_MAX_DURATION_MS` "hard ceiling re-checked on every read" idiom.
const PAIRING_MAX_TTL_MS: i64 = 15 * 60 * 1000;

/// Minimum spacing between upstream claim polls for one nonce. The desktop drives
/// this route on a timer, so without a floor a render loop would turn into an
/// unbounded poll of the manager. Below the floor the node answers `waiting` from
/// its own state and makes no network call.
const MIN_POLL_INTERVAL_MS: i64 = 1_500;

/// A nonce is interpolated into a URL PATH, and on the poll route it arrives from a
/// client. Accepting only base32url/hex-safe characters is what keeps
/// `claim/{nonce}` from being walked out of its path segment. The contract mints
/// 32+ characters; the floor here is lower because the security property is the
/// charset, and refusing a shorter-but-well-formed manager nonce would break
/// pairing for a cosmetic reason.
const NONCE_MIN_LEN: usize = 16;
const NONCE_MAX_LEN: usize = 128;

// ── Secret wrapper ───────────────────────────────────────────────────────────

/// A live credential (a bot token or a claim_secret).
///
/// Deliberately NOT `Serialize` and NOT `Display`: those are the two ways a secret
/// escapes into a JSON response, a `format!`, or a utoipa schema, and their absence
/// makes the escape a compile error rather than a review question. `Debug` prints a
/// placeholder so a `?struct` in a `tracing` call stays safe.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wrap a value that is already a secret.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The raw value. Every call site is a place where the secret leaves the
    /// process on purpose (an `Authorization` header, or the `secrets` map written
    /// to the control plane) — there should never be a third kind.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> std::result::Result<Self, D::Error> {
        Ok(Self(String::deserialize(de)?))
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────

/// What the node asks the manager for when it starts a pairing.
///
/// `suggested_name` / `suggested_username` are forwarded verbatim into the
/// manager's `KeyboardButtonRequestManagedBot`, where Telegram treats them as
/// suggestions the user may edit. Both are optional; a manager that ignores them
/// still pairs.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PairRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_username: Option<String>,
}

/// A minted pairing. `nonce`, `deep_link` and `expires_at` are safe to hand to a
/// client; `claim_secret` is not, which is why it is a [`Secret`].
#[derive(Debug, Clone, Deserialize)]
pub struct PairSession {
    pub nonce: String,
    pub claim_secret: Secret,
    pub deep_link: String,
    /// RFC3339, echoed to the client verbatim so the UI can render a countdown
    /// without inventing its own clock.
    pub expires_at: String,
}

/// A managed bot the manager is holding a token for. `bot_id` / `bot_username` are
/// public identifiers and are logged; `token` is not.
#[derive(Debug, Clone, Deserialize)]
pub struct ManagedBot {
    pub token: Secret,
    pub bot_id: i64,
    #[serde(default)]
    pub bot_username: String,
    #[serde(default)]
    pub owner_telegram_user_id: Option<i64>,
}

/// What the desktop shows a human before a managed token becomes their bot.
///
/// Public identifiers only — the token never leaves the node, so this is the whole
/// basis for the decision. `owner_telegram_user_id` is the load-bearing field: the
/// manager binds a pairing to whoever opens the deep link first, so an owner that is
/// not the account the person at this desktop just used means the pairing was taken
/// by someone else and the bot is theirs, not the user's.
#[derive(Debug, Clone)]
pub struct ConfirmationView {
    pub bot_id: i64,
    pub bot_username: String,
    pub owner_telegram_user_id: Option<i64>,
}

impl ConfirmationView {
    fn of(bot: &ManagedBot) -> Self {
        Self {
            bot_id: bot.bot_id,
            bot_username: bot.bot_username.clone(),
            owner_telegram_user_id: bot.owner_telegram_user_id,
        }
    }
}

/// The answers `GET /managed-bot/claim/{nonce}` can give.
#[derive(Debug)]
pub enum ClaimStatus {
    /// The user has not created the bot yet. Keep polling.
    Pending,
    /// The token is ready — returned exactly ONCE by the manager.
    Ready(Box<ManagedBot>),
    /// The one-shot claim was already spent. NOT an expiry: the managed-bot record
    /// survives a claim, so the token is still reachable through `refresh` — which
    /// is the only way to recover a claim whose HTTP response was lost in flight.
    AlreadyClaimed,
    /// Unknown or expired nonce (HTTP 404). Terminal: stop polling.
    Gone,
}

/// The manager is not serving managed bots at all.
///
/// A distinct error type rather than a message, because it is the ONE failure the
/// desktop must not retry: it means a human has to flip Bot Management Mode on in
/// @BotFather (or set the manager's encryption key), so the UI falls back to the
/// paste-a-token form instead of showing a "try again" button that never will.
/// Raised for the manager's own 501 and for a 404 on `pair` (routes not mounted).
#[derive(Debug, Clone, Copy)]
pub struct ManagerUnavailable {
    /// What the manager answered, for the operator-facing detail line.
    pub status: u16,
}

impl fmt::Display for ManagerUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the managed-bot manager is not serving managed bots (HTTP {}) — Bot Management Mode is off for Ryu's bot, or the manager cannot encrypt tokens at rest",
            self.status
        )
    }
}

impl std::error::Error for ManagerUnavailable {}

/// True when `err` (or anything it wraps) is a [`ManagerUnavailable`].
pub fn is_manager_unavailable(err: &anyhow::Error) -> bool {
    err.downcast_ref::<ManagerUnavailable>().is_some()
}

mod landing;
mod manager;
mod pending_store;
mod urls;

pub use landing::*;
pub use manager::*;
pub use pending_store::*;
pub use urls::*;

#[cfg(test)]
mod tests;
