//! Thread packing, the legacy env access policy, the typing keepalive and the
//! proactive opening message.

use super::*;

mod opening_request;
use opening_request::opening_request_body;

// ─── Thread packing ─────────────────────────────────────────────────────────
//
// Threaded platforms need two ids to answer (the room and the thread within it)
// but Core takes ONE opaque `conversation_id`. Slack solved this by packing
// `"<channel>:<thread_ts>"`; the same trick generalises, so Telegram topics and
// Discord threads reuse it rather than inventing a third convention. Packing is
// also what gives each thread its own conversation history, which is the point.

/// Pack a room id and an optional thread id into one conversation key.
pub fn pack_thread(chat_id: &str, thread_id: Option<&str>) -> String {
    match thread_id.filter(|t| !t.is_empty()) {
        Some(thread) => format!("{chat_id}:{thread}"),
        None => chat_id.to_string(),
    }
}

/// Split a packed conversation key back into `(chat_id, thread_id)`.
///
/// Splits on the LAST separator so a chat id that itself contains a colon
/// survives the round trip.
pub fn unpack_thread(packed: &str) -> (&str, Option<&str>) {
    match packed.rsplit_once(':') {
        Some((chat, thread)) if !thread.is_empty() && !chat.is_empty() => (chat, Some(thread)),
        _ => (packed, None),
    }
}

/// Percent-encode one Core path segment without adding another dependency to
/// the channel crate. Conversation keys contain `:` and provider ids may carry
/// other reserved bytes, so interpolation without this guard would address a
/// different route than the one Core authorized.
pub(super) fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

// ─── Access policy from the legacy env vars ─────────────────────────────────

/// Env var opting a deployment into accepting ALL inbound chats when no
/// allowlist is configured. A bot token grants LLM completions billed to the
/// operator, so this is the explicit escape hatch (`1`/`true`/`yes`/`on`,
/// case-insensitive).
pub(super) const ENV_CHANNEL_ALLOW_ALL: &str = "RYU_CHANNEL_ALLOW_ALL";

/// Per-platform / global allowed-chat list for inbound channel traffic.
///
/// Env: `RYU_CHANNEL_ALLOWED_USERS` (global, all platforms) and
/// `RYU_CHANNEL_ALLOWED_USERS_<PLATFORM>` (e.g. `_TELEGRAM`). Comma-separated
/// chat ids; the per-platform key overrides the global one.
pub(super) fn channel_allowlist(platform: &str) -> Option<Vec<String>> {
    let per_platform_key = format!(
        "RYU_CHANNEL_ALLOWED_USERS_{}",
        platform.to_ascii_uppercase()
    );
    let raw = std::env::var(&per_platform_key)
        .ok()
        .or_else(|| std::env::var("RYU_CHANNEL_ALLOWED_USERS").ok())?;
    let list: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Pure: does this env value opt into open mode? Only an explicit enable token
/// counts — absent or anything else stays closed. Unit-testable without env.
pub(super) fn channel_allow_all_from(val: Option<&str>) -> bool {
    matches!(
        val.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Runtime wrapper: read [`ENV_CHANNEL_ALLOW_ALL`] and classify.
pub(super) fn channel_allow_all() -> bool {
    channel_allow_all_from(std::env::var(ENV_CHANNEL_ALLOW_ALL).ok().as_deref())
}

/// Pure core of [`policy_from_env`], so the mapping is testable without env.
///
/// The three legacy states map onto the richer policy as follows:
///
/// | env                     | DMs        | groups     |
/// |-------------------------|------------|------------|
/// | allowlist set           | allowlist  | allowlist  |
/// | none + `ALLOW_ALL=1`    | open       | open       |
/// | none                    | **pairing**| allowlist (empty ⇒ closed) |
///
/// The last row is the one behaviour change: a bot with no configuration used to
/// refuse every message with only a log line to explain it. It now answers a
/// stranger with a pairing code they can get approved. Groups stay closed —
/// nobody is admitted without a human acting, which is the property that
/// mattered.
pub fn policy_from(allowlist: Option<Vec<String>>, allow_all: bool) -> AccessPolicy {
    match (allowlist, allow_all) {
        (Some(list), _) => AccessPolicy {
            dm: DmPolicy::Allowlist,
            group: GroupPolicy::Allowlist,
            dm_allowlist: list.clone(),
            group_allowlist: list,
            group_sender_allowlist: Vec::new(),
        },
        (None, true) => AccessPolicy {
            dm: DmPolicy::Open,
            group: GroupPolicy::Open,
            ..Default::default()
        },
        (None, false) => AccessPolicy {
            dm: DmPolicy::Pairing,
            group: GroupPolicy::Allowlist,
            ..Default::default()
        },
    }
}

/// Derive a channel's [`AccessPolicy`] from the legacy env vars.
pub fn policy_from_env(platform: &str) -> AccessPolicy {
    policy_from(channel_allowlist(platform), channel_allow_all())
}

// ─── Typing indicator keepalive ─────────────────────────────────────────────

/// A live typing indicator. Dropping it stops the indicator.
///
/// Platforms expire a typing status after a few seconds so a bot that shows it
/// once appears to stop working immediately. This re-asserts it on a ticker and
/// aborts on drop, which makes the correct usage — hold it across the agent call
/// — the same as the easy usage.
pub struct TypingGuard {
    pub(super) handle: tokio::task::JoinHandle<()>,
}

impl Drop for TypingGuard {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Show a typing indicator in `chat_id` until the returned guard is dropped.
pub fn keep_typing<C: Channel + 'static>(channel: Arc<C>, chat_id: String) -> TypingGuard {
    let interval = channel.typing_interval();
    let handle = tokio::spawn(async move {
        loop {
            if let Err(err) = channel.send_typing(&chat_id).await {
                // A platform that refuses the indicator (missing scope, closed
                // chat) must not spin: log once and stop trying for this turn.
                warn!(
                    channel = channel.name(),
                    %err,
                    "typing indicator failed; not retrying for this turn"
                );
                return;
            }
            tokio::time::sleep(interval).await;
        }
    });
    TypingGuard { handle }
}

pub(super) const PROACTIVE_OPENING_RETRY: Duration = Duration::from_secs(5);

/// Ask Core for the first Ryu welcome and deliver it through the same platform
/// verb used for every other outbound message.
///
/// The loop is deliberately owned by the shared channel layer rather than by
/// Telegram, WhatsApp, or a desktop-only path. A local model may still be
/// starting when the gateway comes up; Core answers `202`/`503` until it can
/// produce the message, so the gateway keeps trying without creating duplicate
/// assistant messages. Core's idempotency key is stable across adapter restarts.
pub(super) async fn run_proactive_opening<C: Channel + 'static>(channel: Arc<C>) {
    let runtime = channel.runtime();
    if !runtime.cfg.proactive_opening {
        return;
    }
    let Some(target) = runtime
        .cfg
        .proactive_target
        .clone()
        .filter(|target| !target.trim().is_empty())
    else {
        warn!(
            channel = channel.name(),
            "proactive opening enabled without a target"
        );
        return;
    };

    // Never use an outbound opening to enrol a new sender. The target must be
    // open, allowlisted, or already paired exactly like an inbound DM.
    let admission = InboundMessage {
        chat_id: target.clone(),
        sender_id: Some(target.clone()),
        ..Default::default()
    };
    if !runtime.already_admitted(channel.name(), &admission).await {
        warn!(
            channel = channel.name(),
            "proactive opening target is not admitted; no message sent"
        );
        return;
    }

    let url = format!(
        "{}/api/proactive/opening",
        runtime.cfg.core_url.trim_end_matches('/')
    );
    let agent_id = runtime
        .cfg
        .agent_id
        .clone()
        .unwrap_or_else(|| "ryu".to_string());
    let idempotency_key = format!("ryu-opening:v1:{}:{}", channel.name(), target);

    loop {
        let body = opening_request_body(runtime, &target, &agent_id, &idempotency_key).await;
        let result = runtime.http.post(&url).json(&body).send().await;

        let response = match result {
            Ok(response) => response,
            Err(err) => {
                warn!(channel = channel.name(), %err, "proactive opening could not reach Core; retrying");
                tokio::time::sleep(PROACTIVE_OPENING_RETRY).await;
                continue;
            }
        };

        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or_default();
        if status == reqwest::StatusCode::ACCEPTED
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        {
            info!(channel = channel.name(), %status, "proactive opening is waiting for the model");
            tokio::time::sleep(PROACTIVE_OPENING_RETRY).await;
            continue;
        }
        if !status.is_success() {
            warn!(channel = channel.name(), %status, "proactive opening was refused; no message sent");
            return;
        }
        if body["status"].as_str() != Some("completed") {
            info!(
                channel = channel.name(),
                "proactive opening was already delivered; no duplicate sent"
            );
            return;
        }

        let Some(reply) = body["reply"]
            .as_str()
            .filter(|reply| !reply.trim().is_empty())
        else {
            warn!(
                channel = channel.name(),
                "proactive opening completed without a reply"
            );
            return;
        };
        if let Err(err) = channel.send_message(&target, reply).await {
            warn!(channel = channel.name(), %err, "proactive opening was generated but could not be delivered");
        } else {
            info!(channel = channel.name(), "proactive opening delivered");
        }
        return;
    }
}
