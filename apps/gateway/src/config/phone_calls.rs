//! Channel layer root config and phone-call lines.

use super::*;

/// Configuration for the channel layer: external messaging surfaces (Telegram,
/// Slack, etc.) that register once at the gateway. Inbound messages become
/// gateway pipeline requests; outbound responses route back to the channel.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ChannelsConfig {
    /// Telegram bot adapter. Set `token` (or env `TELEGRAM_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub telegram: Option<TelegramChannelConfig>,
    /// Slack bot adapter (Socket Mode). Set `app_token` + `bot_token` (or env
    /// `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub slack: Option<SlackChannelConfig>,

    /// Discord bot adapter. Set `token` (or env `DISCORD_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub discord: Option<DiscordChannelConfig>,

    /// WhatsApp Business (Meta Cloud API) adapter. Set credentials (or the
    /// `WHATSAPP_*` env vars) to enable.
    #[serde(default)]
    pub whatsapp: Option<WhatsAppChannelConfig>,

    /// BlueBubbles (iMessage bridge running on a Mac) adapter. Set `server_url`
    /// + `password` (or the `BLUEBUBBLES_*` env vars) to enable.
    #[serde(default)]
    pub bluebubbles: Option<BlueBubblesChannelConfig>,

    /// PSTN phone-assistant lines. Twilio credentials stay in the Gateway
    /// deployment secret boundary; this section contains line policy, the
    /// line's own numbers, and the callers and hand-off number (sealed on disk).
    #[serde(default, skip_serializing_if = "PhoneCallsConfig::is_empty")]
    pub phone_calls: PhoneCallsConfig,
}

/// Operator-owned phone-assistant policy. A line binds a Twilio-routed number
/// to the user's verified caller ID, Core agent, and handoff destination.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
pub struct PhoneCallsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub lines: Vec<PhoneCallLineConfig>,
}

impl PhoneCallsConfig {
    pub(super) fn is_empty(&self) -> bool {
        !self.enabled && self.lines.is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.lines.len() > 10 {
            return Err("phone assistant supports at most 10 lines".to_owned());
        }
        if self.enabled && self.lines.is_empty() {
            return Err("phone assistant requires at least one configured line".to_owned());
        }
        let mut ids = std::collections::HashSet::with_capacity(self.lines.len());
        let mut twilio_numbers = std::collections::HashSet::with_capacity(self.lines.len());
        for line in &self.lines {
            if !valid_phone_line_id(&line.id) || !ids.insert(line.id.as_str()) {
                return Err(
                    "phone line ids must be unique, non-empty, and use letters, digits, '-' or '_'"
                        .to_owned(),
                );
            }
            if line.label.trim().is_empty() || line.label.chars().count() > 64 {
                return Err(format!(
                    "phone line '{}' needs a label of 1 to 64 characters",
                    line.id
                ));
            }
            if !valid_e164(&line.twilio_number)
                || !twilio_numbers.insert(line.twilio_number.as_str())
            {
                return Err(format!(
                    "phone line '{}' needs a unique Twilio number in E.164 format",
                    line.id
                ));
            }
            if !line.caller_id.is_empty() && !valid_e164(&line.caller_id) {
                return Err(format!(
                    "phone line '{}' caller ID must be empty or an E.164 phone number",
                    line.id
                ));
            }
            if line
                .transfer_to
                .as_deref()
                .is_some_and(|value| !valid_e164(value))
            {
                return Err(format!(
                    "phone line '{}' transfer number must use E.164 format",
                    line.id
                ));
            }
            if line.agent_id.as_deref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || !value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')
                    })
            }) {
                return Err(format!("phone line '{}' has an invalid agent id", line.id));
            }
            if line
                .tts_engine
                .as_deref()
                .is_some_and(|value| value.len() > 128)
                || line
                    .tts_voice
                    .as_deref()
                    .is_some_and(|value| value.len() > 256)
            {
                return Err(format!(
                    "phone line '{}' voice selection is too long",
                    line.id
                ));
            }
            if line.greeting.chars().count() > 1_000 || line.greeting.contains('\0') {
                return Err(format!(
                    "phone line '{}' greeting is too long or invalid",
                    line.id
                ));
            }
            if line.allowed_callers.len() > MAX_PHONE_LINE_ALLOWED_CALLERS
                || line
                    .allowed_callers
                    .iter()
                    .any(|caller| !valid_e164(caller))
            {
                return Err(format!(
                    "phone line '{}' allowed callers must be at most {MAX_PHONE_LINE_ALLOWED_CALLERS} E.164 phone numbers",
                    line.id
                ));
            }
            if line
                .max_concurrent_calls
                .is_some_and(|limit| !(1..=MAX_PHONE_LINE_CONCURRENT_CALLS).contains(&limit))
            {
                return Err(format!(
                    "phone line '{}' concurrent-call limit must be between 1 and {MAX_PHONE_LINE_CONCURRENT_CALLS}",
                    line.id
                ));
            }
        }
        Ok(())
    }
}

/// Configuration for one PSTN line. `twilio_number` receives forwarded calls;
/// `caller_id` is the user's verified number for outbound calls. Incoming and
/// outbound phone numbers are deliberately separate. `allowed_callers` and
/// `transfer_to` are other people's phone numbers: `gateway.toml` stores them
/// as `encc:v1:` leaves (see `ryu_gw_credentials::sealed_config`), opened
/// before this struct is parsed, so every reader here sees plaintext.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
pub struct PhoneCallLineConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub twilio_number: String,
    #[serde(default)]
    pub caller_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub tts_engine: Option<String>,
    #[serde(default)]
    pub tts_voice: Option<String>,
    #[serde(default)]
    pub transfer_to: Option<String>,
    #[serde(default)]
    pub greeting: String,
    /// Inbound callers (E.164) allowed to reach the assistant on this line.
    /// Empty accepts any caller. A listed caller is trusted; anyone else is an
    /// unverified outside caller, whose Core voice session is opened with
    /// `caller_trusted: false` so Core restricts that call's tools.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_callers: Vec<String>,
    /// Maximum simultaneous calls (inbound and outbound) on this line. `None`
    /// uses [`DEFAULT_PHONE_LINE_MAX_CONCURRENT_CALLS`]. Further inbound calls
    /// are rejected as busy before any speech, model or voice work starts, and
    /// further outbound calls are refused before Twilio is asked to place them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_calls: Option<u32>,
}

/// Simultaneous-call cap for a phone line that does not set one.
pub const DEFAULT_PHONE_LINE_MAX_CONCURRENT_CALLS: u32 = 2;

/// Upper bound for a configured per-line simultaneous-call cap.
pub(super) const MAX_PHONE_LINE_CONCURRENT_CALLS: u32 = 20;

/// Upper bound on a line's inbound caller allowlist.
pub(super) const MAX_PHONE_LINE_ALLOWED_CALLERS: usize = 100;

impl PhoneCallLineConfig {
    /// The simultaneous-call cap in effect for this line.
    pub fn concurrent_call_limit(&self) -> usize {
        self.max_concurrent_calls
            .unwrap_or(DEFAULT_PHONE_LINE_MAX_CONCURRENT_CALLS) as usize
    }

    /// Whether an inbound caller may reach the assistant on this line.
    pub fn accepts_caller(&self, caller: &str) -> bool {
        self.allowed_callers.is_empty() || self.lists_caller(caller)
    }

    /// Whether the caller is explicitly listed (and so trusted) on this line.
    pub fn lists_caller(&self, caller: &str) -> bool {
        self.allowed_callers.iter().any(|allowed| allowed == caller)
    }
}

pub(super) fn valid_phone_line_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(super) fn valid_e164(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('+') else {
        return false;
    };
    (8..=15).contains(&digits.len())
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !digits.starts_with('0')
}
