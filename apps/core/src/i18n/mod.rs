//! Server-rendered copy for the notifications Core delivers outside its own UI.
//!
//! A phone lock screen, a Telegram chat, a webhook and an alert email show the
//! text Core sends as-is: no catalog or DOM localizer runs on the receiving
//! side. So the producers (approvals, finished-run pushes, policy alerts, and
//! apps over `notify.fanout` and `notify.deliver`) describe their copy as a
//! [`Message`]: the English ICU source plus named arguments. Core renders it
//! per recipient from the small catalog `catalog.generated.rs`, which
//! `tools/generate-core-i18n.mjs` builds from `packages/i18n/locales`.
//!
//! - Push: the locale the device registered with its token, else the node's.
//! - Webhook, Telegram, email and the desktop toast: the node's `ui-language`
//!   preference ([`locale::node_locale`]).
//!
//! The English sources are the `*_MESSAGE` templates in [`messages`] (and in
//! each app backend's `fanout_messages.rs`); the i18n extractor catalogs them
//! from there, so they reach the translators like any other server copy.

pub mod bidi;
#[path = "catalog.generated.rs"]
#[rustfmt::skip]
mod catalog;
mod date;
pub mod locale;
pub mod messages;
mod number;
mod relayed;
mod render;
pub mod reply_language;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub use render::Arg;
pub use render::{AlertText, Join, Message, Template};
