//! Channel layer: external messaging surfaces (Telegram, Slack, WhatsApp,
//! Discord, BlueBubbles/iMessage) that register once at the gateway. Inbound
//! messages become Core session turns; outbound responses route back to the
//! originating chat.
//!
//! # Shape
//!
//! An adapter owns exactly two things: its **transport** (long-poll loop, webhook
//! receiver, socket) and its **platform verbs** (how to send text, show a typing
//! indicator, attach a file). Everything between those two — the access gate, the
//! media round trip, the Core call, the reply delivery — is shared and lives in
//! [`handle_turn`]. Adding a channel therefore means implementing [`Channel`] and
//! nothing else; it does not mean re-deriving how pairing works or how a voice
//! note is transcribed.
//!
//! That split is the reason for [`ChannelRuntime`]: the per-bot state every
//! adapter needs (Core route, access policy, pairing store, voice mode, published
//! command menu) lives in one struct the adapter embeds and exposes via
//! [`Channel::runtime`], instead of being copy-pasted field-by-field into five
//! adapters as it previously was.
//!
//! # Capabilities
//!
//! Platforms differ enormously in what they can express — Telegram has forum
//! topics, rich-text documents and streaming drafts; WhatsApp has none of those.
//! Rather than lowest-common-denominator everything, each adapter declares a
//! [`ChannelCaps`] and the shared path uses the best available verb, falling back
//! to plain text. Every capability method on [`Channel`] has a default
//! implementation, so an adapter only overrides what its platform actually does.
//!
//! # Access
//!
//! Inbound is closed to strangers by default. The gate is [`pairing`]: an unknown
//! DM sender is answered with a one-time code that an operator must approve, and
//! groups are allowlisted. The legacy flat env allowlist
//! (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`, `RYU_CHANNEL_ALLOW_ALL`) still
//! configures that policy — see [`policy_from_env`].

pub mod bluebubbles;
pub mod commands;
pub mod discord;
pub mod i18n;
pub mod media;
pub mod openwa;
pub mod pairing;
pub mod slack;
pub mod status;
pub mod telegram;
pub mod turn_error;
pub mod voice_call;
pub mod whatsapp;
pub mod whatsapp_format;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tracing::{debug, info, warn};

use crate::commands::ChannelCommand;
use crate::media::{Attachment, VoiceDelivery, VoiceReplyMode};
use crate::pairing::{AccessPolicy, Decision, DeliveryClaim, DmPolicy, GroupPolicy, PairingStore};
use crate::status::StatusReporter;
pub use ryu_channel_contracts::{
    ChannelActionEvent, InteractiveAction, InteractiveButton, InteractiveLayout, InteractiveMarkup,
};

mod channel;
mod config;
mod runtime;
mod transport;
mod turn;

pub use channel::*;
pub use config::*;
pub use runtime::*;
pub use transport::*;
pub use turn::*;

/// What a channel adapter can do beyond sending plain text.
///
/// Declared per adapter and consulted by [`handle_turn`], so a platform gets its
/// best available verb without the shared path branching on channel names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChannelCaps {
    /// A typing / "is composing" indicator can be shown.
    pub typing: bool,
    /// Replies can carry platform rich text (headings, lists, tables).
    pub rich_text: bool,
    /// Partial output can be streamed before the reply is final.
    pub streaming: bool,
    /// Conversations can be threaded (forum topics, Discord threads, Slack
    /// thread_ts).
    pub threads: bool,
    /// The platform has a native command menu that can be registered.
    pub command_menu: bool,
    /// Audio can be sent back as a voice note or audio attachment.
    pub voice: bool,
    /// Arbitrary files can be attached to a reply.
    pub attachments: bool,
    /// Emoji reactions can be placed on a message.
    pub reactions: bool,
    /// The platform can display normal-message quick replies.
    pub reply_keyboards: bool,
    /// The platform can display attached callback or URL buttons.
    pub inline_buttons: bool,
}

/// An inbound message received from a channel, normalised across providers.
#[derive(Debug, Clone, Default)]
pub struct InboundMessage {
    /// Opaque identifier of the conversation to reply to, and the Core
    /// `conversation_id`. Threaded platforms pack the thread into it — see
    /// [`pack_thread`] — so each thread keeps its own history.
    pub chat_id: String,
    /// Stable room id used for group authorization when `chat_id` contains a
    /// provider-specific thread/conversation key. Reply verbs continue to use
    /// `chat_id`.
    pub access_chat_id: Option<String>,
    /// The user's message text (a transcript, for a voice note).
    pub text: String,
    /// Display name of the speaker, for multi-party chats. Connector-supplied and
    /// UNVERIFIED: recorded on the turn so the agent can attribute who spoke,
    /// never used for authorization.
    pub author_name: Option<String>,
    /// Stable per-user id on the platform, used by the pairing gate. Falls back to
    /// the chat id on platforms where a DM chat *is* the user.
    pub sender_id: Option<String>,
    /// Platform message id, needed to react, mark read, or open a thread.
    pub message_id: Option<String>,
    /// True when the message came from a group / multi-user conversation.
    pub is_group: bool,
    /// Media the user attached.
    pub attachments: Vec<Attachment>,
    /// A typed button action; quick replies remain ordinary text messages.
    pub channel_action: Option<ChannelActionEvent>,
    /// The sender's language as the platform reports it (Telegram
    /// `from.language_code`, a Discord interaction's `locale`). `None` means
    /// the bridge's own replies use the Gateway owner's UI language.
    pub locale: Option<String>,
}

impl InboundMessage {
    /// A plain text message with no media — the common case, and what the older
    /// two-field struct literal used to express.
    pub fn text(chat_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    /// The pairing identity for this sender: the platform user id when known,
    /// otherwise the chat id.
    pub fn identity(&self) -> &str {
        self.sender_id.as_deref().unwrap_or(&self.chat_id)
    }

    /// Return the room id the shared access gate should evaluate.
    pub fn access_chat(&self) -> &str {
        self.access_chat_id.as_deref().unwrap_or(&self.chat_id)
    }

    /// Did the user speak rather than type?
    pub fn is_voice(&self) -> bool {
        self.attachments
            .iter()
            .any(|a| a.resolved_kind().is_speech())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod finish_reaction_tests;

#[cfg(test)]
mod reply_locale_tests;
