//! Slack Web API response shapes (only the fields the adapter reads) and the
//! reaction-name mapping.

use super::*;

// ─── Slack Web API response types (only the fields we use) ─────────────────────

/// The `{ok, error}` envelope every Slack Web API method answers with.
#[derive(Debug, Deserialize)]
pub(super) struct ApiAck {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) error: Option<String>,
}

impl ApiAck {
    /// Turn `ok:false` into an error naming the method, which is what an operator
    /// needs to see (`missing_scope`, `channel_not_found`, …).
    pub(super) fn into_result(self, method: &str) -> anyhow::Result<()> {
        if self.ok {
            return Ok(());
        }
        anyhow::bail!(
            "slack {method} returned ok=false: {}",
            self.error.unwrap_or_default()
        )
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ConnectionsOpenResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) url: Option<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AuthTestResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) user_id: Option<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct UploadUrlResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) upload_url: Option<String>,
    #[serde(default)]
    pub(super) file_id: Option<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
}

/// The Slack reaction name for `emoji`. A `:shortcode:` (or bare shortcode)
/// passes through; a Unicode emoji is translated for the common reactions,
/// since Slack's `reactions.*` methods accept names only.
pub(super) fn slack_reaction_name(emoji: &str) -> Option<String> {
    let trimmed = emoji.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed
        .trim_matches(':')
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
    {
        return Some(trimmed.trim_matches(':').to_owned());
    }
    let bare: String = trimmed.chars().filter(|c| *c != '\u{fe0f}').collect();
    let name = match bare.as_str() {
        "👀" => "eyes",
        "✅" => "white_check_mark",
        "❌" => "x",
        "👍" => "+1",
        "👎" => "-1",
        "👌" => "ok_hand",
        "🙏" => "pray",
        "❤" => "heart",
        "🔥" => "fire",
        "🎉" => "tada",
        "😂" => "joy",
        "🤣" => "rolling_on_the_floor_laughing",
        "😁" => "grin",
        "😄" => "smile",
        "😮" => "open_mouth",
        "😱" => "scream",
        "😢" => "cry",
        "😭" => "sob",
        "🤔" => "thinking_face",
        "👏" => "clap",
        "🙌" => "raised_hands",
        "💯" => "100",
        "🚀" => "rocket",
        "💪" => "muscle",
        "🤝" => "handshake",
        "🫡" => "saluting_face",
        "✍" => "writing_hand",
        "🥳" => "partying_face",
        "😅" => "sweat_smile",
        "😎" => "sunglasses",
        "🤯" => "exploding_head",
        "👋" => "wave",
        "⚡" => "zap",
        "🏆" => "trophy",
        _ => return None,
    };
    Some(name.to_owned())
}
