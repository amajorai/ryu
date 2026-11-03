//! Channel (bot) registrations from the environment, applied by `GatewayConfig::load`.

use super::*;

/// Telegram, Slack, Discord, WhatsApp and BlueBubbles env registrations.
pub(super) fn load_channel_env(config: &mut GatewayConfig) {
    // Telegram channel — env token registers the bot at startup.
    if let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") {
        if !token.trim().is_empty() {
            let existing = config.channels.telegram.take();
            config.channels.telegram = Some(TelegramChannelConfig {
                token,
                common: common_channel_from_env("TELEGRAM", existing.as_ref().map(|c| &c.common)),
                options: existing
                    .as_ref()
                    .map(|c| c.options.clone())
                    .unwrap_or_default(),
            });
        }
    }

    // Slack channel — env tokens register the bot at startup. Both an
    // app-level token (Socket Mode) and a bot token (replies) are required.
    if let Ok(app_token) = std::env::var("SLACK_APP_TOKEN") {
        let bot_token = std::env::var("SLACK_BOT_TOKEN").unwrap_or_default();
        if !app_token.trim().is_empty() && !bot_token.trim().is_empty() {
            let existing = config.channels.slack.take();
            config.channels.slack = Some(SlackChannelConfig {
                app_token,
                bot_token,
                common: common_channel_from_env("SLACK", existing.as_ref().map(|c| &c.common)),
                options: existing
                    .as_ref()
                    .map(|c| c.options.clone())
                    .unwrap_or_default(),
            });
        }
    }

    // Discord channel — env token registers the bot at startup.
    if let Ok(token) = std::env::var("DISCORD_BOT_TOKEN") {
        if !token.trim().is_empty() {
            let existing = config.channels.discord.take();
            let channel_ids = channel_env_list("DISCORD", "CHANNEL_IDS")
                .or_else(|| existing.as_ref().map(|c| c.channel_ids.clone()))
                .unwrap_or_default();
            let thread_replies = channel_env_bool("DISCORD", "THREAD_REPLIES")
                .or_else(|| existing.as_ref().map(|c| c.thread_replies))
                .unwrap_or(false);
            let history_backfill = channel_env_bool("DISCORD", "HISTORY_BACKFILL")
                .or_else(|| existing.as_ref().map(|c| c.history_backfill))
                .unwrap_or(false);
            config.channels.discord = Some(DiscordChannelConfig {
                token,
                channel_ids,
                thread_replies,
                history_backfill,
                free_response_channels: existing
                    .as_ref()
                    .map(|c| c.free_response_channels.clone())
                    .unwrap_or_default(),
                allowed_channels: existing
                    .as_ref()
                    .map(|c| c.allowed_channels.clone())
                    .unwrap_or_default(),
                allowed_roles: existing
                    .as_ref()
                    .map(|c| c.allowed_roles.clone())
                    .unwrap_or_default(),
                thread_require_mention: existing
                    .as_ref()
                    .map(|c| c.thread_require_mention)
                    .unwrap_or(false),
                mention_patterns: existing
                    .as_ref()
                    .map(|c| c.mention_patterns.clone())
                    .unwrap_or_default(),
                ignored_channels: existing
                    .as_ref()
                    .map(|c| c.ignored_channels.clone())
                    .unwrap_or_default(),
                no_thread_channels: existing
                    .as_ref()
                    .map(|c| c.no_thread_channels.clone())
                    .unwrap_or_default(),
                allow_bots: existing.as_ref().map(|c| c.allow_bots).unwrap_or(false),
                home_channel: existing.as_ref().and_then(|c| c.home_channel.clone()),
                common: common_channel_from_env("DISCORD", existing.as_ref().map(|c| &c.common)),
            });
        }
    }

    // WhatsApp channel — env credentials register the adapter at startup.
    if let Ok(access_token) = std::env::var("WHATSAPP_ACCESS_TOKEN") {
        if !access_token.trim().is_empty() {
            let existing = config.channels.whatsapp.take();
            let phone_number_id = std::env::var("WHATSAPP_PHONE_NUMBER_ID")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.phone_number_id.clone()))
                .unwrap_or_default();
            let verify_token = std::env::var("WHATSAPP_VERIFY_TOKEN")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.verify_token.clone()))
                .unwrap_or_default();
            let app_secret = std::env::var("WHATSAPP_APP_SECRET")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.app_secret.clone()))
                .unwrap_or_default();
            let webhook_bind = std::env::var("WHATSAPP_WEBHOOK_BIND")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.webhook_bind.clone()))
                .unwrap_or_else(default_whatsapp_bind);
            let webhook_path = std::env::var("WHATSAPP_WEBHOOK_PATH")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.webhook_path.clone()))
                .unwrap_or_else(default_whatsapp_path);
            let graph_version = std::env::var("WHATSAPP_GRAPH_VERSION")
                .ok()
                .or_else(|| existing.as_ref().map(|c| c.graph_version.clone()))
                .unwrap_or_else(default_whatsapp_graph_version);
            let send_read_receipts = channel_env_bool("WHATSAPP", "SEND_READ_RECEIPTS")
                .or_else(|| existing.as_ref().map(|c| c.send_read_receipts))
                .unwrap_or(true);
            config.channels.whatsapp = Some(WhatsAppChannelConfig {
                access_token,
                phone_number_id,
                verify_token,
                app_secret,
                webhook_bind,
                webhook_path,
                graph_version,
                send_read_receipts,
                common: common_channel_from_env("WHATSAPP", existing.as_ref().map(|c| &c.common)),
            });
        }
    }

    // BlueBubbles (iMessage) channel — the bridge's URL + password register
    // the adapter at startup. Unlike the other channels there is no vendor
    // cloud: `server_url` points at a Mac the operator runs, and the webhook
    // receiver below is what that Mac POSTs into.
    if let Ok(server_url) = std::env::var("BLUEBUBBLES_SERVER_URL") {
        if !server_url.trim().is_empty() {
            let existing = config.channels.bluebubbles.take();
            let password = channel_env("BLUEBUBBLES", "PASSWORD")
                .or_else(|| existing.as_ref().map(|c| c.password.clone()))
                .unwrap_or_default();
            let webhook_bind = channel_env("BLUEBUBBLES", "WEBHOOK_BIND")
                .or_else(|| existing.as_ref().map(|c| c.webhook_bind.clone()))
                .unwrap_or_else(default_bluebubbles_bind);
            let webhook_path = channel_env("BLUEBUBBLES", "WEBHOOK_PATH")
                .or_else(|| existing.as_ref().map(|c| c.webhook_path.clone()))
                .unwrap_or_else(default_bluebubbles_path);
            let private_api = channel_env_bool("BLUEBUBBLES", "PRIVATE_API")
                .or_else(|| existing.as_ref().map(|c| c.private_api))
                .unwrap_or(false);
            let send_read_receipts = channel_env_bool("BLUEBUBBLES", "SEND_READ_RECEIPTS")
                .or_else(|| existing.as_ref().map(|c| c.send_read_receipts))
                .unwrap_or(false);
            config.channels.bluebubbles = Some(BlueBubblesChannelConfig {
                server_url,
                password,
                webhook_bind,
                webhook_path,
                private_api,
                send_read_receipts,
                mention_patterns: existing
                    .as_ref()
                    .map(|c| c.mention_patterns.clone())
                    .unwrap_or_default(),
                home_channel: existing.as_ref().and_then(|c| c.home_channel.clone()),
                common: common_channel_from_env(
                    "BLUEBUBBLES",
                    existing.as_ref().map(|c| &c.common),
                ),
            });
        }
    }
}
