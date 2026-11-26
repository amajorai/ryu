//! The Core conversation id of a channel chat.
//!
//! Core accepts a conversation id only when it is 1 to 128 bytes of ASCII
//! letters, digits, `.`, `_` and `-` (`is_safe_host_conversation_id` in
//! `apps/core/src/sidecar/adapters/acp/child_env.rs`), and `POST
//! /api/channels/run` answers 400 for anything else. Platform targets carry
//! other bytes: a packed thread is `<chat>:<thread>`, a phone number starts
//! with `+`, an iMessage chat guid has `;`. This module maps every (bot, target)
//! pair to an id inside Core's grammar and never maps two different pairs to
//! the same id.
//!
//! With `E(x)` keeping `[A-Za-z0-9.-]` and writing every other byte, `_`
//! included, as `_HH` in upper-case hex, the id is one of three shapes.
//!
//! - A bot without a store id sends `E(target)`.
//! - A store-backed bot sends `channel__E(channel_id)__E(target)`.
//! - An id that would be empty or longer than 128 bytes keeps its head and
//!   ends in `_h` plus the SHA-256 of the full id of the first two shapes.
//!
//! `E` never writes `__` or `_h`, so the shapes cannot be confused and the
//! first two decode back to the pair. A target made of letters, digits, `.`
//! and `-` (a Telegram chat id, a Discord snowflake) is its own id, which keeps
//! the stored history of bots without a store id.
//!
//! `apps/cloud-bot/src/conversation-id.ts` is the same mapping. Both, and
//! Core's handler, are held to
//! `crates/gateway/contracts/fixtures/channel-conversation-id-cases-v1.json`.

use sha2::{Digest, Sha256};

/// The longest conversation id Core accepts, in bytes.
pub const MAX_CORE_CONVERSATION_ID_LEN: usize = 128;

const STORE_PREFIX: &str = "channel__";
const SEPARATOR: &str = "__";
const HASH_MARK: &str = "_h";
const UPPER_HEX: &[u8; 16] = b"0123456789ABCDEF";

/// Core's rule for a conversation id, mirrored so the Gateway's own tests and
/// mock Cores refuse what Core refuses. The shared fixture keeps this copy
/// equal to Core's predicate.
pub fn is_core_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CORE_CONVERSATION_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Append `E(value)` to `out`.
fn escape_into(out: &mut String, value: &str) {
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.') {
            out.push(char::from(byte));
        } else {
            out.push('_');
            out.push(char::from(UPPER_HEX[usize::from(byte >> 4)]));
            out.push(char::from(UPPER_HEX[usize::from(byte & 0x0f)]));
        }
    }
}

/// The Core conversation id for `platform_target` on the bot with store id
/// `channel_id` (`None` for a bot configured without the store).
///
/// The result always passes [`is_core_conversation_id`], is stable across
/// restarts and releases, and differs for any two different inputs.
pub fn core_conversation_id(channel_id: Option<&str>, platform_target: &str) -> String {
    let mut id = String::with_capacity(platform_target.len() + 16);
    let mut bot_len = 0;
    if let Some(channel_id) = channel_id {
        id.push_str(STORE_PREFIX);
        escape_into(&mut id, channel_id);
        bot_len = id.len();
        id.push_str(SEPARATOR);
    }
    escape_into(&mut id, platform_target);
    if !id.is_empty() && id.len() <= MAX_CORE_CONVERSATION_ID_LEN {
        return id;
    }

    let digest = hex::encode(Sha256::digest(id.as_bytes()));
    let hashed_len = bot_len + HASH_MARK.len() + digest.len();
    let head = match channel_id {
        None => "target",
        // Keep the bot visible in the id while there is room for it.
        Some(_) if hashed_len <= MAX_CORE_CONVERSATION_ID_LEN => &id[..bot_len],
        Some(_) => "channel",
    };
    format!("{head}{HASH_MARK}{digest}")
}

#[cfg(test)]
mod tests;
