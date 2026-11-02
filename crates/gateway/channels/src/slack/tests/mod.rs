use super::*;

use crate::{CommonChannelConfig, GroupReplyMode};

mod part1;
mod part2;

fn make_cfg(app_token: &str, bot_token: &str) -> SlackChannelConfig {
    SlackChannelConfig {
        app_token: app_token.to_string(),
        bot_token: bot_token.to_string(),
        common: CommonChannelConfig {
            model: "gpt-4o".to_string(),
            ..Default::default()
        },
        options: SlackChannelOptions::default(),
    }
}

fn build(cfg: SlackChannelConfig) -> anyhow::Result<SlackChannel> {
    SlackChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
}

// ─── Group-reply gate (group_reply_mode was previously dropped on the floor:
// the adapter answered EVERY channel message regardless of the admin's
// choice in the setup form) ────────────────────────────────────────────────

fn inbound(text: &str, is_dm: bool) -> SlackInbound {
    SlackInbound {
        channel: if is_dm { "D1".into() } else { "C1".into() },
        text: text.to_string(),
        is_dm,
        sender_id: Some("U1".to_string()),
        message_id: Some("1.0".to_string()),
        attachments: Vec::new(),
        force_reply: false,
        is_bot: false,
    }
}

fn channel_msg(text: &str) -> SlackInbound {
    inbound(text, false)
}

fn dm(text: &str) -> SlackInbound {
    inbound(text, true)
}
