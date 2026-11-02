//! The user-facing outcome of an update apply, worded through Core's i18n
//! catalog (`i18n/messages/update.rs`) in the node's locale.

use std::collections::BTreeMap;

use super::ApplyResult;
use crate::i18n::{messages, Message};

/// What the apply did and what the user still has to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Core and the Gateway were swapped; restart to run them.
    InstalledWithGateway,
    /// Core was swapped (no Gateway asset for this platform); restart to run it.
    Installed,
    /// Core was swapped but the Gateway could not be. `detail` is the raw error.
    GatewayLeftBehind { detail: String },
    /// An OS installer was staged; the user runs it.
    RunInstaller { kind: String },
    /// A binary or archive was staged; the user replaces the binary.
    ReplaceBinary,
}

impl ApplyOutcome {
    /// Stable wire id of the outcome's sentence.
    pub fn id(&self) -> &'static str {
        match self {
            Self::InstalledWithGateway => "update.installed_with_gateway",
            Self::Installed => "update.installed",
            Self::GatewayLeftBehind { .. } => "update.gateway_left_behind",
            Self::RunInstaller { .. } => "update.run_installer",
            Self::ReplaceBinary => "update.replace_binary",
        }
    }

    /// The raw values the sentence interpolates.
    pub fn values(&self) -> BTreeMap<&'static str, String> {
        match self {
            Self::GatewayLeftBehind { detail } => BTreeMap::from([("detail", detail.clone())]),
            Self::RunInstaller { kind } => BTreeMap::from([("kind", kind.clone())]),
            _ => BTreeMap::new(),
        }
    }

    /// The sentence as a catalog [`Message`].
    pub fn message(&self) -> Message {
        match self {
            Self::InstalledWithGateway => {
                Message::new(messages::UPDATE_INSTALLED_WITH_GATEWAY_MESSAGE)
            }
            Self::Installed => Message::new(messages::UPDATE_INSTALLED_MESSAGE),
            Self::GatewayLeftBehind { detail } => {
                Message::new(messages::UPDATE_GATEWAY_LEFT_BEHIND_MESSAGE)
                    .text("detail", detail.as_str())
            }
            Self::RunInstaller { kind } => {
                Message::new(messages::UPDATE_RUN_INSTALLER_MESSAGE).text("kind", kind.as_str())
            }
            Self::ReplaceBinary => Message::new(messages::UPDATE_REPLACE_BINARY_MESSAGE),
        }
    }
}

impl ApplyResult {
    /// A result whose `message` is rendered in the node's locale.
    pub(super) async fn new(
        applied: bool,
        staged_path: String,
        outcome: ApplyOutcome,
        gateway_left_behind: bool,
    ) -> Self {
        let locale = crate::i18n::locale::node_locale().await;
        Self::rendered(applied, staged_path, &outcome, gateway_left_behind, locale)
    }

    /// A result whose `message` is rendered in `locale`.
    pub(super) fn rendered(
        applied: bool,
        staged_path: String,
        outcome: &ApplyOutcome,
        gateway_left_behind: bool,
        locale: &str,
    ) -> Self {
        Self {
            applied,
            restart_required: true,
            staged_path,
            message: outcome.message().render(locale),
            message_id: outcome.id(),
            message_values: outcome.values(),
            gateway_left_behind,
        }
    }
}
