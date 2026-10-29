//! At-rest sealing and client redaction of the credentials a workflow
//! definition carries.
//!
//! A [`Workflow`] holds three kinds of credential inline:
//!
//! - the inbound HMAC signing secret of a [`WorkflowTrigger::Webhook`];
//! - the Telegram `bot_token` and the Slack/Discord/HTTP `webhook_url` of a
//!   [`NodeKind::ChannelSend`] node (an incoming-webhook URL is itself the
//!   bearer secret);
//! - the target `url` of a [`NodeKind::Webhook`] node, which can carry a token in
//!   its path or query.
//!
//! The in-memory struct always holds plaintext, so the executor, the webhook
//! verifier and the builders need no change. The store seals these fields with
//! the master key (`enc:v1:`) every time a definition is written (the live
//! `state/workflows/<id>.json`, the `files/source-history` Git projection and its
//! named versions, and ad-hoc `state/workflow-scripts/`), and opens them on every
//! read. Reads accept legacy plaintext; [`reseal_stored_workflows`] seals what is
//! still plaintext once at boot.
//!
//! HTTP surfaces that return a definition call [`redact_for_client`], which
//! replaces the ChannelSend credentials with [`ryu_crypto::redact::REDACTED`]; a
//! save that sends that placeholder back keeps the stored value
//! ([`restore_redacted`]). The trigger signing secret is NOT redacted by
//! [`redact_for_client`]: the workflow owner must read it to configure the
//! external sender (the editor's reveal/copy control, and
//! `GET /api/webhooks/:id/secret`), so only the single-workflow GET and the
//! editor's own save/conflict responses carry it, to callers holding the
//! workflow's view permission. Bulk and read-only views (`GET /workflows`, a
//! stored version, a restore preview) use [`redact_for_listing`], which also
//! masks the trigger secret, so a list consumer (a dashboard widget that caches
//! the list, say) never copies every signing key.

use std::collections::HashMap;

use ryu_crypto::{looks_sealed, redact, FieldCipher, SecretSealer};

use super::{NodeKind, Workflow, WorkflowTrigger};

/// Every credential slot of a definition, mutably, with a stable label for
/// error messages (never the value).
fn for_each_secret(
    workflow: &mut Workflow,
    mut visit: impl FnMut(&'static str, &mut String) -> std::io::Result<()>,
) -> std::io::Result<()> {
    for trigger in &mut workflow.triggers {
        if let WorkflowTrigger::Webhook {
            secret: Some(secret),
        } = trigger
        {
            visit("webhook trigger secret", secret)?;
        }
    }
    for node in &mut workflow.nodes {
        match &mut node.kind {
            NodeKind::ChannelSend {
                bot_token,
                webhook_url,
                ..
            } => {
                if let Some(token) = bot_token {
                    visit("channel bot token", token)?;
                }
                if let Some(url) = webhook_url {
                    visit("channel webhook URL", url)?;
                }
            }
            NodeKind::Webhook { url, .. } => visit("webhook node URL", url)?,
            _ => {}
        }
    }
    Ok(())
}

fn has_secret(workflow: &Workflow) -> bool {
    let mut probe = workflow.clone();
    let mut found = false;
    let _ = for_each_secret(&mut probe, |_, value| {
        found |= !value.is_empty();
        Ok(())
    });
    found
}

fn master_cipher() -> std::io::Result<FieldCipher> {
    // Idempotent; lets tests and embedders seal without running Core's boot.
    crate::crypto_host::install();
    ryu_crypto::global_cipher().map_err(|error| {
        std::io::Error::other(format!(
            "refusing to store workflow credentials unsealed: {error}"
        ))
    })
}

fn invalid_data(message: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

/// The storage form of `workflow`: every non-empty credential sealed with the
/// master key. Fails closed when a credential is present and no key is
/// available; a definition without credentials needs no key.
///
/// `previous` is the definition as it is currently stored (still sealed). A
/// credential whose plaintext is unchanged keeps its existing ciphertext, so
/// re-saving a definition does not churn every sealed value (and the Git
/// projection records only real changes).
pub(crate) fn sealed_for_storage(
    workflow: &Workflow,
    previous: Option<&Workflow>,
) -> std::io::Result<Workflow> {
    let mut sealed = workflow.clone();
    if !has_secret(workflow) {
        return Ok(sealed);
    }
    let cipher = master_cipher()?;
    let mut reuse: HashMap<String, String> = HashMap::new();
    if let Some(previous) = previous {
        let mut previous = previous.clone();
        for_each_secret(&mut previous, |_, stored| {
            if FieldCipher::is_sealed(stored) {
                if let Ok(plaintext) = SecretSealer::open(&cipher, stored) {
                    reuse.insert(plaintext, stored.clone());
                }
            }
            Ok(())
        })?;
    }
    for_each_secret(&mut sealed, |label, value| {
        if value.is_empty() {
            return Ok(());
        }
        if looks_sealed(value) {
            // Already sealed (a definition copied from disk): keep it only when
            // this node's key opens it, never double-wrap a foreign envelope.
            SecretSealer::open(&cipher, value)
                .map_err(|error| invalid_data(format!("{label} cannot be opened: {error}")))?;
            return Ok(());
        }
        *value = match reuse.get(value.as_str()) {
            Some(existing) => existing.clone(),
            None => SecretSealer::seal(&cipher, value)
                .map_err(|error| std::io::Error::other(format!("sealing {label}: {error}")))?,
        };
        Ok(())
    })?;
    Ok(sealed)
}

/// Open every sealed credential of a definition read from storage, in place.
/// Legacy plaintext passes through without a key. Returns whether any value was
/// still plaintext (the caller may write the definition back sealed). A sealed
/// value that cannot be opened is an error, never an empty credential.
pub(crate) fn open_from_storage(workflow: &mut Workflow) -> std::io::Result<bool> {
    let mut needs_reseal = false;
    let mut cipher: Option<FieldCipher> = None;
    for_each_secret(workflow, |label, value| {
        if value.is_empty() {
            return Ok(());
        }
        if !looks_sealed(value) {
            needs_reseal = true;
            return Ok(());
        }
        let cipher = match &cipher {
            Some(cipher) => cipher,
            None => {
                crate::crypto_host::install();
                let resolved = ryu_crypto::global_cipher().map_err(|error| {
                    std::io::Error::other(format!("opening the sealed {label}: {error}"))
                })?;
                cipher.insert(resolved)
            }
        };
        *value = SecretSealer::open(cipher, value)
            .map_err(|error| invalid_data(format!("opening the sealed {label}: {error}")))?;
        Ok(())
    })?;
    Ok(needs_reseal)
}

/// The view of a definition an HTTP client may see: the ChannelSend bot token
/// and webhook URL are replaced by [`redact::REDACTED`]. See the module docs for
/// why the trigger signing secret and the Webhook node URL stay visible.
pub fn redact_for_client(mut workflow: Workflow) -> Workflow {
    for node in &mut workflow.nodes {
        if let NodeKind::ChannelSend {
            bot_token,
            webhook_url,
            ..
        } = &mut node.kind
        {
            for value in [bot_token, webhook_url].into_iter().flatten() {
                if !value.is_empty() {
                    *value = redact::REDACTED.to_owned();
                }
            }
        }
    }
    workflow
}

/// The view of a definition for bulk and read-only surfaces: everything
/// [`redact_for_client`] masks, plus the webhook trigger signing secret. A save
/// that echoes the placeholder keeps the stored secret ([`restore_redacted`]
/// clears it and the save path reuses the stored one).
pub fn redact_for_listing(workflow: Workflow) -> Workflow {
    let mut workflow = redact_for_client(workflow);
    for trigger in &mut workflow.triggers {
        if let WorkflowTrigger::Webhook {
            secret: Some(secret),
        } = trigger
        {
            if !secret.is_empty() {
                *secret = redact::REDACTED.to_owned();
            }
        }
    }
    workflow
}

/// Swap the placeholders a client echoed back from [`redact_for_client`] for
/// the stored credentials of the same node (matched by node id). A placeholder
/// with no stored counterpart is refused rather than saved as the credential.
/// A placeholder trigger secret is cleared, so the save path reuses the stored
/// secret exactly as it does for an empty one.
pub fn restore_redacted(workflow: &mut Workflow, stored: Option<&Workflow>) -> Result<(), String> {
    for trigger in &mut workflow.triggers {
        if let WorkflowTrigger::Webhook { secret } = trigger {
            if secret.as_deref().is_some_and(redact::is_placeholder) {
                *secret = None;
            }
        }
    }
    let stored_node = |node_id: &str| {
        stored.and_then(|stored| stored.nodes.iter().find(|node| node.id == node_id))
    };
    for node in &mut workflow.nodes {
        let node_id = node.id.clone();
        match &mut node.kind {
            NodeKind::ChannelSend {
                bot_token,
                webhook_url,
                ..
            } => {
                let (stored_token, stored_url) = match stored_node(&node_id).map(|n| &n.kind) {
                    Some(NodeKind::ChannelSend {
                        bot_token,
                        webhook_url,
                        ..
                    }) => (bot_token.clone(), webhook_url.clone()),
                    _ => (None, None),
                };
                restore_one(bot_token, stored_token, &node_id, "bot token")?;
                restore_one(webhook_url, stored_url, &node_id, "webhook URL")?;
            }
            NodeKind::Webhook { url, .. } if redact::is_placeholder(url) => {
                match stored_node(&node_id).map(|n| &n.kind) {
                    Some(NodeKind::Webhook { url: stored, .. }) if !stored.is_empty() => {
                        url.clone_from(stored);
                    }
                    _ => return Err(missing_stored(&node_id, "webhook URL")),
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn restore_one(
    incoming: &mut Option<String>,
    stored: Option<String>,
    node_id: &str,
    what: &str,
) -> Result<(), String> {
    if !incoming.as_deref().is_some_and(redact::is_placeholder) {
        return Ok(());
    }
    match stored.filter(|value| !value.is_empty()) {
        Some(value) => {
            *incoming = Some(value);
            Ok(())
        }
        None => Err(missing_stored(node_id, what)),
    }
}

fn missing_stored(node_id: &str, what: &str) -> String {
    format!(
        "node '{node_id}' sent a redacted {what} but no stored value exists for it; enter the {what} again"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{ChannelPlatform, WorkflowNode};

    fn credential_workflow() -> Workflow {
        Workflow {
            id: "wf_secrets".into(),
            name: "secrets".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "send".into(),
                    kind: NodeKind::ChannelSend {
                        platform: ChannelPlatform::Telegram,
                        recipient: "@ops".into(),
                        text: "hi".into(),
                        bot_token: Some("123456:telegram-bot-token-secret".into()),
                        webhook_url: Some(
                            "https://hooks.slack.test/services/T0/B0/xyzsecret".into(),
                        ),
                    },
                    retry: None,
                    timeout_ms: None,
                    repeat: None,
                },
                WorkflowNode {
                    id: "post".into(),
                    kind: NodeKind::Webhook {
                        url: "https://api.example.test/hook?token=node-url-secret".into(),
                        method: "POST".into(),
                    },
                    retry: None,
                    timeout_ms: None,
                    repeat: None,
                },
            ],
            edges: vec![],
            triggers: vec![WorkflowTrigger::Webhook {
                secret: Some("trigger-hmac-secret-value".into()),
            }],
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn channel(workflow: &Workflow) -> (Option<String>, Option<String>) {
        match &workflow.nodes[0].kind {
            NodeKind::ChannelSend {
                bot_token,
                webhook_url,
                ..
            } => (bot_token.clone(), webhook_url.clone()),
            _ => unreachable!(),
        }
    }

    #[test]
    fn seal_then_open_round_trips_and_hides_every_credential() {
        let workflow = credential_workflow();
        let sealed = sealed_for_storage(&workflow, None).unwrap();
        let json = serde_json::to_string(&sealed).unwrap();
        for secret in [
            "telegram-bot-token-secret",
            "xyzsecret",
            "node-url-secret",
            "trigger-hmac-secret-value",
        ] {
            assert!(!json.contains(secret), "{secret} leaked into storage form");
        }
        assert_eq!(json.matches("enc:v1:").count(), 4);
        let mut opened: Workflow = serde_json::from_str(&json).unwrap();
        assert!(!open_from_storage(&mut opened).unwrap());
        assert_eq!(
            serde_json::to_value(&opened).unwrap(),
            serde_json::to_value(&workflow).unwrap()
        );
    }

    #[test]
    fn legacy_plaintext_opens_and_reports_reseal() {
        let mut legacy = credential_workflow();
        assert!(open_from_storage(&mut legacy).unwrap());
        assert_eq!(
            channel(&legacy).0.as_deref(),
            Some("123456:telegram-bot-token-secret")
        );
    }

    #[test]
    fn unchanged_credentials_keep_their_ciphertext() {
        let workflow = credential_workflow();
        let first = sealed_for_storage(&workflow, None).unwrap();
        let second = sealed_for_storage(&workflow, Some(&first)).unwrap();
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
    }

    #[test]
    fn foreign_envelope_is_refused_not_wrapped() {
        let mut workflow = credential_workflow();
        if let NodeKind::ChannelSend { bot_token, .. } = &mut workflow.nodes[0].kind {
            *bot_token = Some(FieldCipher::new(&[9; 32]).seal("other-node").unwrap());
        }
        assert!(sealed_for_storage(&workflow, None).is_err());
    }

    #[test]
    fn client_view_redacts_channel_credentials_and_save_restores_them() {
        let stored = credential_workflow();
        let view = redact_for_client(stored.clone());
        assert_eq!(
            channel(&view),
            (
                Some(redact::REDACTED.to_owned()),
                Some(redact::REDACTED.to_owned())
            )
        );
        let mut echoed = view;
        restore_redacted(&mut echoed, Some(&stored)).unwrap();
        assert_eq!(channel(&echoed), channel(&stored));

        // A new value replaces the stored one.
        let mut edited = redact_for_client(stored.clone());
        if let NodeKind::ChannelSend { bot_token, .. } = &mut edited.nodes[0].kind {
            *bot_token = Some("999:new-token".into());
        }
        restore_redacted(&mut edited, Some(&stored)).unwrap();
        assert_eq!(channel(&edited).0.as_deref(), Some("999:new-token"));

        // A placeholder with nothing stored is refused.
        let mut orphan = redact_for_client(stored);
        assert!(restore_redacted(&mut orphan, None).is_err());
    }

    #[test]
    fn placeholder_trigger_secret_is_cleared_for_backfill() {
        let mut workflow = credential_workflow();
        workflow.triggers = vec![WorkflowTrigger::Webhook {
            secret: Some(redact::REDACTED.into()),
        }];
        let stored = credential_workflow();
        restore_redacted(&mut workflow, Some(&stored)).unwrap();
        assert!(matches!(
            &workflow.triggers[0],
            WorkflowTrigger::Webhook { secret: None }
        ));
    }

    #[test]
    fn listing_view_also_masks_the_trigger_secret() {
        let view = redact_for_listing(credential_workflow());
        let text = serde_json::to_string(&view).unwrap();
        assert!(!text.contains("trigger-hmac-secret-value"));
        assert!(!text.contains("telegram-bot-token-secret"));
        assert!(!text.contains("xyzsecret"));
        assert!(matches!(
            &view.triggers[0],
            WorkflowTrigger::Webhook { secret: Some(s) } if s == redact::REDACTED
        ));
        // The editor view keeps it so the owner can copy it.
        let editor = serde_json::to_string(&redact_for_client(credential_workflow())).unwrap();
        assert!(editor.contains("trigger-hmac-secret-value"));
    }
}
