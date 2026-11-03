//! Per-platform channel environment overrides.

use super::*;

/// Read a channel's group-reply mode from `<PLATFORM>_GROUP_REPLY_MODE`
/// (e.g. `TELEGRAM_GROUP_REPLY_MODE=all`). `None` when unset or unrecognised, so
/// the caller falls back to the config file and ultimately to the safe default
/// (mentions-only) — an env bot never gets talkative in groups by accident.
pub(super) fn group_reply_mode_from_env(platform: &str) -> Option<GroupReplyMode> {
    match std::env::var(format!("{platform}_GROUP_REPLY_MODE")) {
        Ok(v) if v.trim().eq_ignore_ascii_case("all") => Some(GroupReplyMode::All),
        Ok(v) if v.trim().eq_ignore_ascii_case("mentions") => Some(GroupReplyMode::Mentions),
        _ => None,
    }
}

// ─── Channel env loading ─────────────────────────────────────────────────────
//
// Every channel reads the same shared knobs from `<PLATFORM>_<KNOB>`, so the
// reading is written once here and each transport block below only handles its
// own secrets. Precedence is env → the value already loaded from `gateway.toml`
// → the documented default, which is the precedence the per-channel blocks
// already implemented by hand.

/// A `<PLATFORM>_<SUFFIX>` env var, or `None` when unset or blank.
///
/// Blank is treated as unset throughout: an exported-but-empty variable is how a
/// shell script says "I have no value for this", and letting `MODEL=""` through
/// would route the bot at a model named "".
pub(super) fn channel_env(platform: &str, suffix: &str) -> Option<String> {
    std::env::var(format!("{platform}_{suffix}"))
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// A boolean `<PLATFORM>_<SUFFIX>` knob. Unrecognised values are ignored (→
/// `None`) rather than guessed at, so a typo falls back to the configured value
/// instead of silently flipping behaviour.
pub(super) fn channel_env_bool(platform: &str, suffix: &str) -> Option<bool> {
    channel_env(platform, suffix).and_then(|v| parse_bool_env(&v))
}

/// `<PLATFORM>_DM_POLICY` → [`DmPolicy`]. `None` when unset or unrecognised,
/// which leaves the legacy env allowlist in charge.
pub(super) fn dm_policy_from_env(platform: &str) -> Option<DmPolicy> {
    match channel_env(platform, "DM_POLICY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "pairing" => Some(DmPolicy::Pairing),
        "allowlist" => Some(DmPolicy::Allowlist),
        "open" => Some(DmPolicy::Open),
        "disabled" | "off" => Some(DmPolicy::Disabled),
        _ => None,
    }
}

/// `<PLATFORM>_GROUP_POLICY` → [`GroupPolicy`]. There is deliberately no
/// `pairing` variant: a room is admitted by the operator or not at all.
pub(super) fn group_policy_from_env(platform: &str) -> Option<GroupPolicy> {
    match channel_env(platform, "GROUP_POLICY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "allowlist" => Some(GroupPolicy::Allowlist),
        "open" => Some(GroupPolicy::Open),
        "disabled" | "off" => Some(GroupPolicy::Disabled),
        _ => None,
    }
}

/// `<PLATFORM>_VOICE_REPLY` → [`VoiceReplyMode`].
pub(super) fn voice_reply_from_env(platform: &str) -> Option<VoiceReplyMode> {
    match channel_env(platform, "VOICE_REPLY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "never" | "off" => Some(VoiceReplyMode::Never),
        "mirror" => Some(VoiceReplyMode::Mirror),
        "always" => Some(VoiceReplyMode::Always),
        _ => None,
    }
}

/// A comma-separated `<PLATFORM>_<SUFFIX>` id list (allowlists, channel ids).
pub(super) fn channel_env_list(platform: &str, suffix: &str) -> Option<Vec<String>> {
    let list: Vec<String> = channel_env(platform, suffix)?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!list.is_empty()).then_some(list)
}

/// Build the shared per-channel config from `<PLATFORM>_*` env vars, layered over
/// whatever `gateway.toml` already supplied for this channel (`existing`).
///
/// `core_url` is the one knob read from a GLOBAL var (`RYU_CORE_URL`): every
/// channel on a node talks to the same Core, and that is how the existing
/// deployments spell it.
pub(super) fn common_channel_from_env(
    platform: &str,
    existing: Option<&CommonChannelFileConfig>,
) -> CommonChannelFileConfig {
    let base = existing.cloned().unwrap_or_default();
    CommonChannelFileConfig {
        model: channel_env(platform, "MODEL").unwrap_or(base.model),
        system_prompt: channel_env(platform, "SYSTEM_PROMPT").or(base.system_prompt),
        agent_id: channel_env(platform, "AGENT_ID").or(base.agent_id),
        team_id: channel_env(platform, "TEAM_ID").or(base.team_id),
        channel_id: base.channel_id,
        group_reply_mode: group_reply_mode_from_env(platform).unwrap_or(base.group_reply_mode),
        core_url: std::env::var("RYU_CORE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(base.core_url),
        reaction_learning: base.reaction_learning,
        dm_policy: dm_policy_from_env(platform).or(base.dm_policy),
        group_policy: group_policy_from_env(platform).or(base.group_policy),
        dm_allowlist: channel_env_list(platform, "DM_ALLOWLIST").unwrap_or(base.dm_allowlist),
        group_allowlist: channel_env_list(platform, "GROUP_ALLOWLIST")
            .unwrap_or(base.group_allowlist),
        group_user_allowlist: channel_env_list(platform, "GROUP_USER_ALLOWLIST")
            .unwrap_or(base.group_user_allowlist),
        typing_indicator: channel_env_bool(platform, "TYPING_INDICATOR")
            .unwrap_or(base.typing_indicator),
        publish_commands: channel_env_bool(platform, "PUBLISH_COMMANDS")
            .unwrap_or(base.publish_commands),
        rich_text: channel_env_bool(platform, "RICH_TEXT").unwrap_or(base.rich_text),
        streaming: channel_env_bool(platform, "STREAMING").unwrap_or(base.streaming),
        lifecycle_reactions: channel_env_bool(platform, "LIFECYCLE_REACTIONS")
            .unwrap_or(base.lifecycle_reactions),
        voice_reply: voice_reply_from_env(platform).unwrap_or(base.voice_reply),
        proactive_opening: channel_env_bool(platform, "PROACTIVE_OPENING")
            .unwrap_or(base.proactive_opening),
        proactive_target: channel_env(platform, "PROACTIVE_TARGET").or(base.proactive_target),
        profile_name: channel_env(platform, "BOT_NAME").or(base.profile_name),
        profile_short_bio: channel_env(platform, "BOT_SHORT_BIO").or(base.profile_short_bio),
        profile_description: channel_env(platform, "BOT_DESCRIPTION").or(base.profile_description),
    }
}
