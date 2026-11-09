//! Notifications for broker proposals waiting on a human.
//!
//! A proposal is filed by an agent on the agent route (`broker.proposal.create`)
//! or by the first use of a password-manager reference (`pm.resolve` with
//! outcome `pending`). Both are audited, so [`observe`] watches appended audit
//! rows (called from [`crate::vault::events::publish_row`]) instead of adding a
//! call to every filing path. The task [`spawn`] starts loads each new proposal
//! and delivers one notification per proposal: to the inbox, desktop toast, and
//! mobile push of the person behind it (the user who minted the agent's broker
//! session, the user a credential-use subject names, or the node's signed-in
//! owner), or as a desktop toast to every connected surface when there is none.
//! A tap opens [`approval_link`].
//!
//! The text is built from structured fields only: the environment, service
//! names and hosts, credential reference names, and for a credential use the
//! account and reference. The agent's free-text message is never sent (a push
//! leaves the device), and no value is ever part of a proposal. The text is a
//! localizable [`AlertText`]: each surface renders it in its own language.

use std::collections::{HashSet, VecDeque};
use std::sync::OnceLock;

use serde_json::Value;
use tokio::sync::broadcast;

use super::proposals::{self, CredentialUse, Proposal, ProposalStatus};
use super::sessions::{self, BrokerSession};
use crate::i18n::{messages, AlertText, Join, Message, Template};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditRow;
use crate::vault::password_managers::ConsumerSubject;

/// Proposal ids remembered so a repeated pending use notifies once.
const REMEMBERED: usize = 512;
/// Hosts or references named in one notification before "+N".
const LISTED: usize = 3;
/// Longest host or reference shown.
const MAX_ITEM_LEN: usize = 80;

/// A notification ready to deliver.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub text: AlertText,
    pub link: String,
}

fn channel() -> &'static broadcast::Sender<String> {
    static CHANNEL: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    CHANNEL.get_or_init(|| broadcast::channel(64).0)
}

/// The proposal an audit row reports as newly waiting, if any.
pub fn filed_proposal(row: &AuditRow) -> Option<String> {
    let key = match (row.action.as_str(), row.outcome.as_str()) {
        ("broker.proposal.create", "ok") => "proposal",
        ("pm.resolve", "pending") => "approval",
        _ => return None,
    };
    row.details
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// Hand a filed proposal to the notifier. Never blocks: the row is appended
/// under the store lock, and with no notifier running the id is dropped.
pub fn observe(row: &AuditRow) {
    if let Some(id) = filed_proposal(row) {
        let _ = channel().send(id);
    }
}

/// The desktop route that opens the Broker tab on `proposal`.
pub fn approval_link(proposal: &str) -> String {
    format!("/vault?tab=broker&proposal={proposal}")
}

fn clip(text: &str) -> String {
    let mut clipped: String = text.chars().take(MAX_ITEM_LEN).collect();
    if text.chars().count() > MAX_ITEM_LEN {
        clipped.push('…');
    }
    clipped
}

fn listing(items: &[String]) -> String {
    let mut shown: Vec<String> = items.iter().take(LISTED).map(|item| clip(item)).collect();
    if items.len() > LISTED {
        shown.push(format!("+{}", items.len() - LISTED));
    }
    shown.join(", ")
}

/// `one` for a count of 1, else `many`, with `{count}` set.
fn counted(count: usize, one: Template, many: Template) -> Message {
    Message::new(if count == 1 { one } else { many }).number("count", count as f64, 0, 0)
}

/// The sentence for a credential use, worded for the consumer's channel.
fn credential_use_body(credential_use: &CredentialUse) -> Message {
    let message = match ConsumerSubject::parse(&credential_use.subject) {
        ConsumerSubject::BrokerSession { minter } => {
            Message::new(messages::VAULT_BROKER_USE_BY_BROKER_SESSION_MESSAGE)
                .text("minter", minter)
        }
        ConsumerSubject::ExplicitRead { principal } => {
            Message::new(messages::VAULT_BROKER_USE_BY_EXPLICIT_READ_MESSAGE)
                .text("principal", principal)
        }
        ConsumerSubject::Runtime { mcp, owner } => {
            Message::new(messages::VAULT_BROKER_USE_BY_RUNTIME_MESSAGE)
                .text("mcp", mcp)
                .text("owner", owner)
        }
        ConsumerSubject::Other(subject) => {
            Message::new(messages::VAULT_BROKER_USE_BY_SUBJECT_MESSAGE).text("subject", subject)
        }
    };
    message
        .text("reference", clip(&credential_use.reference))
        .text("account", clip(&credential_use.account))
}

/// The sentences for an agent proposal: the services, then the credentials
/// (`It also asks…` after services), or the broker change when it names none.
fn proposal_body(proposal: &Proposal) -> Vec<Message> {
    let environment = proposal.environment.as_str();
    let hosts: Vec<String> = proposal
        .services
        .iter()
        .map(|service| service.host.clone())
        .collect();
    let references: Vec<String> = proposal
        .credentials
        .iter()
        .map(|credential| credential.reference.clone())
        .collect();
    let mut body = Vec::new();
    if !hosts.is_empty() {
        body.push(
            counted(
                hosts.len(),
                messages::VAULT_BROKER_SERVICES_ONE_MESSAGE,
                messages::VAULT_BROKER_SERVICES_MESSAGE,
            )
            .text("environment", environment)
            .text("hosts", listing(&hosts)),
        );
    }
    if !references.is_empty() {
        let sentence = if hosts.is_empty() {
            counted(
                references.len(),
                messages::VAULT_BROKER_CREDENTIALS_ONE_MESSAGE,
                messages::VAULT_BROKER_CREDENTIALS_MESSAGE,
            )
            .text("environment", environment)
        } else {
            counted(
                references.len(),
                messages::VAULT_BROKER_ALSO_CREDENTIALS_ONE_MESSAGE,
                messages::VAULT_BROKER_ALSO_CREDENTIALS_MESSAGE,
            )
        };
        body.push(sentence.text("references", listing(&references)));
    }
    if body.is_empty() {
        body.push(
            Message::new(messages::VAULT_BROKER_BROKER_CHANGE_MESSAGE)
                .text("environment", environment),
        );
    }
    body
}

/// The notification for one pending proposal.
pub fn notice(proposal: &Proposal) -> Notice {
    let text = match &proposal.credential_use {
        Some(credential_use) => AlertText::new(
            Message::new(messages::VAULT_BROKER_CREDENTIAL_USE_TITLE_MESSAGE),
            vec![credential_use_body(credential_use)],
            Join::Sentences,
        ),
        None => AlertText::new(
            Message::new(messages::VAULT_BROKER_PROPOSAL_TITLE_MESSAGE),
            proposal_body(proposal),
            Join::Sentences,
        ),
    };
    Notice {
        text,
        link: approval_link(&proposal.id),
    }
}

/// The user a subject or minter names (`user:<id>`, possibly inside a
/// channel subject such as `broker:user:<id>` or `runtime:<mcp>:user:<id>`).
fn named_user(subject: &str) -> Option<String> {
    let (_, id) = subject.split_once("user:")?;
    let id = id.trim();
    (!id.is_empty() && !id.contains(':')).then(|| id.to_owned())
}

/// Who should hear about `proposal`: the user a credential-use subject names,
/// else the user who minted the filing broker session. `None` leaves it to
/// the node owner (or a broadcast).
pub fn recipient(proposal: &Proposal, session: Option<&BrokerSession>) -> Option<String> {
    if let Some(user) = proposal
        .credential_use
        .as_ref()
        .and_then(|credential_use| named_user(&credential_use.subject))
    {
        return Some(user);
    }
    session.and_then(|session| session.user_id().map(str::to_owned))
}

/// Ids already notified, oldest first.
#[derive(Default)]
struct Remembered {
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl Remembered {
    /// Record `id`; `false` when it was already recorded.
    fn first_time(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > REMEMBERED {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

/// Load a pending proposal and the session that filed it.
async fn load(
    store: &PluginSecretStore,
    id: &str,
) -> anyhow::Result<Option<(Proposal, Option<BrokerSession>)>> {
    let conn = store.conn.lock().await;
    let Some(proposal) = proposals::get(&conn, id)? else {
        return Ok(None);
    };
    if proposal.status != ProposalStatus::Pending {
        return Ok(None);
    }
    let session = match proposal.requested_by.strip_prefix("broker_session:") {
        Some(session_id) => sessions::get(&conn, session_id)?,
        None => None,
    };
    Ok(Some((proposal, session)))
}

/// Deliver `notice` to `user` (inbox, toast, push), or broadcast a toast in
/// the node's language.
async fn deliver(notice: &Notice, user: Option<String>) {
    let user = user.or_else(|| crate::auth::load_accounts().active_user_id);
    if let (Some(user), Some(store)) = (user.as_deref(), crate::notify::global_store()) {
        match crate::notify::deliver_linked_notification(
            &store,
            user,
            &notice.text,
            "warning",
            &notice.link,
        )
        .await
        {
            Ok(_) => return,
            Err(error) => tracing::warn!("broker proposal notification failed: {error}"),
        }
    }
    let locale = crate::i18n::locale::node_locale().await;
    let (title, body) = notice.text.render(locale);
    crate::events::publish(crate::events::DesktopNotification {
        title,
        body: Some(crate::i18n::bidi::rtl_body(body, locale)),
        level: "warning".to_owned(),
        target_user_id: user,
        notification_id: None,
        source_app_id: None,
        link: Some(notice.link.clone()),
    });
}

/// Start the notifier for `store`.
pub fn spawn(store: &'static PluginSecretStore) {
    let mut receiver = channel().subscribe();
    tokio::spawn(async move {
        let mut remembered = Remembered::default();
        loop {
            let id = match receiver.recv().await {
                Ok(id) => id,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "broker proposal notifier fell behind");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            };
            if !remembered.first_time(&id) {
                continue;
            }
            match load(store, &id).await {
                Ok(Some((proposal, session))) => {
                    let user = recipient(&proposal, session.as_ref());
                    deliver(&notice(&proposal), user).await;
                }
                Ok(None) => {}
                Err(error) => tracing::warn!("loading a broker proposal failed: {error:#}"),
            }
        }
    });
}

#[cfg(test)]
#[path = "proposal_notify_tests.rs"]
mod tests;
