//! English sources for the outcome of a node self-update (`POST /api/update/apply`).
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! `update/apply.rs` renders them in the node's locale into `ApplyResult.message`
//! and also sends a stable `message_id` plus the raw values. `{kind}` is an
//! installer kind (`msi`, `dmg`, `deb`, `appimage`) and `{detail}` a raw local
//! error chain; neither is translated.
#![allow(clippy::useless_format)]

use super::Template;

pub const UPDATE_INSTALLED_WITH_GATEWAY_MESSAGE: Template = |_| {
    format!(
        "Update installed for Ryu Core and the Gateway. Restart Ryu Core to run the new version."
    )
};
pub const UPDATE_INSTALLED_MESSAGE: Template =
    |_| format!("Update installed. Restart Ryu Core to run the new version.");
pub const UPDATE_GATEWAY_LEFT_BEHIND_MESSAGE: Template = |arg| {
    format!(
        "Ryu Core updated, but the Gateway could not be updated ({detail}). Update the Gateway binary to the same version before restarting.",
        detail = arg("detail")
    )
};
pub const UPDATE_RUN_INSTALLER_MESSAGE: Template = |arg| {
    format!(
        "Update downloaded. Run the {kind} installer to complete the update.",
        kind = arg("kind")
    )
};
pub const UPDATE_REPLACE_BINARY_MESSAGE: Template =
    |_| format!("Update downloaded. Extract and replace the binary to complete the update.");
