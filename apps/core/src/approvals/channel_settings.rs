//! Who may decide an approval from a chat app, per channel connection.
//!
//! Deciding from Telegram, Slack or Discord is off until someone who may
//! decide approvals on this node turns it on for one channel connection and
//! names the chat accounts that may press the buttons. Each named account is
//! linked to the Ryu user who added it, and that user's own permission is
//! checked again on every press (see [`super::channel_decisions`]). A chat
//! account therefore never holds more than the person who linked it.
//!
//! The settings live in the preferences store under
//! [`CHANNEL_DECIDERS_PREF`], written only through the dedicated approvals
//! route (the generic preference routes refuse the key). Preference values are
//! listed and streamed to clients, so the chat account id is never stored: the
//! entry keeps a SHA-256 of it, bound to the connection and the platform.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::LazyLock;

use super::ApprovalEngine;

/// Preference key holding every connection's settings as one JSON object.
pub const CHANNEL_DECIDERS_PREF: &str = "channel-approval-deciders";

/// Chat platforms whose adapters can show approval buttons.
pub const DECIDER_PLATFORMS: &[&str] = &["telegram", "slack", "discord"];

/// Most chat accounts one connection can name.
pub const MAX_DECIDERS: usize = 16;

const MAX_CONNECTION_LEN: usize = 128;
const MAX_SENDER_LEN: usize = 64;

/// Serializes read-modify-write of the settings preference.
static EDITS: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// One chat account allowed to decide, and the Ryu user it acts for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDecider {
    pub platform: String,
    /// [`sender_key`] of the chat account. The raw id is not kept.
    pub sender_key: String,
    /// The signed-in Ryu user who linked this account.
    pub user_id: String,
    pub linked_at: String,
}

/// One channel connection's setting. The default is off with nobody named.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelApprovalSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub deciders: Vec<ChannelDecider>,
}

impl ChannelApprovalSettings {
    /// Buttons are offered only when the setting is on and someone is named.
    pub fn offers_buttons(&self) -> bool {
        self.enabled && !self.deciders.is_empty()
    }

    /// The link for this chat account, when it is named on the connection.
    pub fn decider(
        &self,
        connection: &str,
        platform: &str,
        sender_id: &str,
    ) -> Option<&ChannelDecider> {
        let key = sender_key(connection, platform, sender_id);
        self.deciders
            .iter()
            .find(|decider| decider.platform == platform && decider.sender_key == key)
    }
}

/// The stored form of a chat account id: a SHA-256 bound to the connection and
/// the platform, so the same account on another connection is a different key.
pub fn sender_key(connection: &str, platform: &str, sender_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-channel-decider:v1\n");
    hasher.update(connection.as_bytes());
    hasher.update(b"\n");
    hasher.update(platform.as_bytes());
    hasher.update(b"\n");
    hasher.update(sender_id.trim().as_bytes());
    hex::encode(hasher.finalize())
}

/// Whether `connection` is a usable connection id: the channel config id the
/// Gateway sends with every turn of a store-backed bot.
pub fn valid_connection(connection: &str) -> bool {
    !connection.is_empty()
        && connection.len() <= MAX_CONNECTION_LEN
        && connection
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn valid_sender(sender_id: &str) -> bool {
    let sender = sender_id.trim();
    !sender.is_empty()
        && sender.len() <= MAX_SENDER_LEN
        && sender
            .chars()
            .all(|ch| !ch.is_whitespace() && !ch.is_control())
}

/// Build the new deciders list from `(platform, sender id)` pairs. An account
/// that is already named keeps its link; a new one is linked to `user_id`.
/// An error is a stable code for the API caller (`too_many_deciders`,
/// `unknown_platform`, `invalid_sender_id`), not a sentence.
pub fn link_deciders(
    connection: &str,
    current: &[ChannelDecider],
    wanted: &[(String, String)],
    user_id: &str,
    now: &str,
) -> Result<Vec<ChannelDecider>, String> {
    if wanted.len() > MAX_DECIDERS {
        return Err("too_many_deciders".to_owned());
    }
    let mut deciders: Vec<ChannelDecider> = Vec::with_capacity(wanted.len());
    for (platform, sender_id) in wanted {
        let platform = platform.trim().to_ascii_lowercase();
        if !DECIDER_PLATFORMS.contains(&platform.as_str()) {
            return Err("unknown_platform".to_owned());
        }
        if !valid_sender(sender_id) {
            return Err("invalid_sender_id".to_owned());
        }
        let key = sender_key(connection, &platform, sender_id);
        if deciders
            .iter()
            .any(|decider| decider.platform == platform && decider.sender_key == key)
        {
            continue;
        }
        let existing = current
            .iter()
            .find(|decider| decider.platform == platform && decider.sender_key == key);
        deciders.push(existing.cloned().unwrap_or_else(|| ChannelDecider {
            platform,
            sender_key: key,
            user_id: user_id.to_owned(),
            linked_at: now.to_owned(),
        }));
    }
    Ok(deciders)
}

fn parse_all(raw: Option<String>) -> BTreeMap<String, ChannelApprovalSettings> {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

impl ApprovalEngine {
    /// The setting of one channel connection. Off when nothing is stored, when
    /// the stored value does not parse, or when no preferences store is attached.
    pub async fn channel_approval_settings(&self, connection: &str) -> ChannelApprovalSettings {
        let Some(preferences) = self.preferences.as_ref() else {
            return ChannelApprovalSettings::default();
        };
        let raw = preferences.get(CHANNEL_DECIDERS_PREF).await.ok().flatten();
        parse_all(raw).remove(connection).unwrap_or_default()
    }

    /// Replace one connection's setting. `wanted` is the full list of
    /// `(platform, sender id)` pairs; new ones are linked to `user_id`, the
    /// signed-in caller. Turning the setting off keeps the links.
    pub async fn save_channel_approval_settings(
        &self,
        connection: &str,
        enabled: bool,
        wanted: &[(String, String)],
        user_id: &str,
    ) -> Result<ChannelApprovalSettings, String> {
        if !valid_connection(connection) {
            return Err("invalid_connection".to_owned());
        }
        if user_id.trim().is_empty() {
            return Err("signed_in_user_required".to_owned());
        }
        let Some(preferences) = self.preferences.as_ref() else {
            return Err("preferences_unavailable".to_owned());
        };
        let _edit = EDITS.lock().await;
        let raw = preferences
            .get(CHANNEL_DECIDERS_PREF)
            .await
            .map_err(|error| error.to_string())?;
        let mut all = parse_all(raw);
        let current = all.remove(connection).unwrap_or_default();
        let now = chrono::Utc::now().to_rfc3339();
        let deciders = link_deciders(connection, &current.deciders, wanted, user_id, &now)?;
        let settings = ChannelApprovalSettings { enabled, deciders };
        if settings.enabled || !settings.deciders.is_empty() {
            all.insert(connection.to_owned(), settings.clone());
        }
        let value = serde_json::to_string(&all).map_err(|error| error.to_string())?;
        preferences
            .set(CHANNEL_DECIDERS_PREF, &value)
            .await
            .map_err(|error| error.to_string())?;
        Ok(settings)
    }
}

#[cfg(test)]
#[path = "channel_settings_tests.rs"]
mod tests;
