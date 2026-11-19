//! One-time share links and inbound secret-request links.
//!
//! A **share link** hands someone a secret once, in their browser, without an
//! account: Core encrypts the value with a fresh key, uploads only the
//! ciphertext to Ryu Cloud, and returns `https://…/secret/<token>#<key>`. The
//! key never leaves the link. Opening the link consumes it; a second open is
//! reported as reuse. Sharing a vault value needs `read` on it, and a value
//! behind a control group cannot be shared. A wrapping token
//! ([`super::wrapping`]) can be turned into a share link too: it is unwrapped
//! (consuming it) and its response becomes the shared secret.
//!
//! A **request link** asks someone for a secret: Core makes a P-256 key pair,
//! uploads the public half, and keeps the secret half sealed here. The
//! recipient's browser encrypts the answer to it, so Ryu Cloud only relays
//! ciphertext. Claiming the answer writes it to the vault key named when the
//! request was made, through the normal write path (policies, parameter
//! constraints, and change requests for protected environments).

pub mod client;
pub mod credential;
pub mod crypto;
pub mod store;

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::elliptic_curve::zeroize::Zeroizing;
use serde::Serialize;
use serde_json::{json, Value};

use self::client::ControlPlane;
use self::store::{LinkSecrets, NewShareLink};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::VaultError;

pub use store::ShareLinkInfo;

/// Default link lifetime (one day) and the largest allowed (seven days).
pub const DEFAULT_TTL_SECS: i64 = 24 * 3600;
pub const MAX_TTL_SECS: i64 = 7 * 24 * 3600;
const MIN_TTL_SECS: i64 = 60;
const MAX_LABEL_CHARS: usize = 200;

/// A link just created. `url` is returned once and never stored: for a share
/// it carries the decryption key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedLink {
    pub id: String,
    pub url: String,
    pub expires_at: String,
}

fn check_ttl(ttl_secs: Option<i64>) -> Result<i64> {
    let ttl = ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
    if !(MIN_TTL_SECS..=MAX_TTL_SECS).contains(&ttl) {
        return Err(
            VaultError::Invalid("ttlSecs must be between 60 seconds and 7 days".into()).into(),
        );
    }
    Ok(ttl)
}

fn check_label(label: Option<&str>) -> Result<Option<String>> {
    let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) else {
        return Ok(None);
    };
    if label.chars().count() > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
        return Err(
            VaultError::Invalid("label must be at most 200 printable characters".into()).into(),
        );
    }
    Ok(Some(label.to_owned()))
}

fn expires_millis(link: &client::CreatedLink) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&link.expires_at)
        .map(|at| at.timestamp_millis())
        .unwrap_or_default()
}

/// Share `secret` (a JSON value; `name` when it came from a vault key).
pub async fn share(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    (name, secret): (Option<&str>, Value),
    (label, ttl_secs): (Option<&str>, Option<i64>),
    actor: &AuditActor,
) -> Result<CreatedLink> {
    let ttl = check_ttl(ttl_secs)?;
    let label = check_label(label)?;
    let mut plaintext = json!({ "value": secret });
    if let Some(name) = name {
        plaintext["name"] = json!(name);
    }
    let sealed = crypto::seal_share(&Zeroizing::new(serde_json::to_vec(&plaintext)?))?;
    let mut body = json!({ "kind": "share", "ciphertext": sealed.blob, "ttlSecs": ttl });
    if let Some(label) = &label {
        body["label"] = json!(label);
    }
    let link = client::create(cloud, body).await?;
    store
        .share_link_record(
            NewShareLink {
                id: &link.id,
                kind: "share",
                label: label.as_deref(),
                target: name.map(|name| json!({ "name": name })),
                expires_at: expires_millis(&link),
            },
            &LinkSecrets::default(),
            actor,
        )
        .await?;
    Ok(CreatedLink {
        url: format!("{}#{}", link.url, sealed.fragment_key.as_str()),
        id: link.id,
        expires_at: link.expires_at,
    })
}

/// Ask for a secret to be written to `target` (vault coordinates as JSON).
pub async fn request(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    target: Value,
    (label, ttl_secs): (&str, Option<i64>),
    actor: &AuditActor,
) -> Result<CreatedLink> {
    request_with_form(store, cloud, (target, None), (label, ttl_secs), actor).await
}

/// [`request`] with the `form` the recipient's page renders (`None`: one
/// secret; see [`credential`] for a site sign-in).
pub(crate) async fn request_with_form(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    (target, form): (Value, Option<Value>),
    (label, ttl_secs): (&str, Option<i64>),
    actor: &AuditActor,
) -> Result<CreatedLink> {
    let ttl = check_ttl(ttl_secs)?;
    let label = check_label(Some(label))?
        .ok_or_else(|| VaultError::Invalid("a request needs a label the recipient sees".into()))?;
    let (secret, public_key) = crypto::new_request_key()?;
    let mut body =
        json!({ "kind": "request", "publicKey": public_key, "label": label, "ttlSecs": ttl });
    if let Some(form) = form {
        body["form"] = form;
    }
    let link = client::create(cloud, body).await?;
    store
        .share_link_record(
            NewShareLink {
                id: &link.id,
                kind: "request",
                label: Some(&label),
                target: Some(target),
                expires_at: expires_millis(&link),
            },
            &LinkSecrets {
                request_key: Some(URL_SAFE_NO_PAD.encode(secret.as_slice())),
                pending_answer: None,
            },
            actor,
        )
        .await?;
    Ok(CreatedLink {
        id: link.id,
        url: link.url,
        expires_at: link.expires_at,
    })
}

/// The answer to request `id`, collected from Ryu Cloud (once) or from a
/// claim that collected it but failed to write. `None` while unanswered.
pub async fn collect_answer(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    id: &str,
    actor: &AuditActor,
) -> Result<Option<(ShareLinkInfo, Zeroizing<String>)>> {
    let (info, mut secrets) = store.share_link_get(id).await?;
    if info.kind != "request" {
        return Err(VaultError::Invalid("only request links have answers".into()).into());
    }
    if info.status != "open" {
        return Err(
            VaultError::Conflict(format!("this request is already {}", info.status)).into(),
        );
    }
    if let Some(pending) = secrets.pending_answer.clone() {
        return Ok(Some((info, Zeroizing::new(pending))));
    }
    let Some(answer) = client::collect(cloud, id).await? else {
        return Ok(None);
    };
    let key = secrets
        .request_key
        .as_deref()
        .ok_or_else(|| anyhow!("the request key is missing"))?;
    let key = Zeroizing::new(URL_SAFE_NO_PAD.decode(key)?);
    let plain = crypto::open_answer(&key, &answer)?;
    let text = Zeroizing::new(
        String::from_utf8(plain.to_vec()).map_err(|_| anyhow!("the answer is not UTF-8 text"))?,
    );
    if text.is_empty() {
        bail!("the answer is empty");
    }
    secrets.pending_answer = Some(text.to_string());
    store.share_link_update(id, "open", &secrets, actor).await?;
    Ok(Some((info, text)))
}

/// Mark a request claimed and drop its key and answer.
pub async fn finish_claim(store: &PluginSecretStore, id: &str, actor: &AuditActor) -> Result<()> {
    store
        .share_link_update(id, "claimed", &LinkSecrets::default(), actor)
        .await
}

/// Revoke a link at Ryu Cloud and locally.
pub async fn revoke(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    id: &str,
    actor: &AuditActor,
) -> Result<bool> {
    let (info, _) = store.share_link_get(id).await?;
    if info.status != "open" {
        return Ok(false);
    }
    let revoked = client::revoke(cloud, id).await?;
    store
        .share_link_update(id, "revoked", &LinkSecrets::default(), actor)
        .await?;
    Ok(revoked)
}

#[cfg(test)]
pub(crate) mod tests;
