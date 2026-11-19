//! Hosted credential collection links.
//!
//! A credential request is a request link whose page asks a person for a
//! site sign-in (username, password, and optionally an authenticator seed)
//! instead of one secret. The answer is encrypted in their browser to this
//! node like any other answer, and claiming it saves an agent account
//! ([`crate::vault::agent_accounts::create_collected`]) for the agent named
//! when the link was made. The agent fills the account into that site through
//! its browser but never reads the password or seed, and neither does the
//! caller that claims it: the claim answers with account metadata only.

use anyhow::Result;
use p256::elliptic_curve::zeroize::Zeroizing;
use serde::Deserialize;
use serde_json::{json, Value};

use super::client::ControlPlane;
use super::{request_with_form, CreatedLink};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::agent_accounts::{fill_target, parse_site, CollectedInput};
use crate::vault::audit::AuditActor;
use crate::vault::VaultError;

const MAX_USERNAME_CHARS: usize = 256;

/// What to ask for.
#[derive(Debug, Default)]
pub struct CredentialRequest<'a> {
    pub agent_id: Option<&'a str>,
    /// The site's URL or bare host.
    pub site: &'a str,
    /// A username to prefill (the person can change it).
    pub username: Option<&'a str>,
    /// Also offer a field for an authenticator setup key.
    pub totp: bool,
    pub submit_urls: Vec<String>,
    pub label: &'a str,
    pub ttl_secs: Option<i64>,
}

/// Where a claimed credential goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialTarget {
    pub agent_id: Option<String>,
    pub site: String,
    pub submit_urls: Vec<String>,
}

fn invalid(message: &str) -> anyhow::Error {
    VaultError::Invalid(message.to_owned()).into()
}

/// Create a credential request link for `request.agent_id` on `request.site`.
pub async fn request_credential(
    store: &PluginSecretStore,
    cloud: &ControlPlane,
    request: CredentialRequest<'_>,
    actor: &AuditActor,
) -> Result<CreatedLink> {
    let (site, host) = parse_site(request.site)?;
    let submit_urls = fill_target::validate_submit_urls(&host, &request.submit_urls)?;
    let username = request.username.map(str::trim).filter(|u| !u.is_empty());
    if username
        .is_some_and(|u| u.chars().count() > MAX_USERNAME_CHARS || u.contains(char::is_control))
    {
        return Err(invalid(
            "username must be one line of at most 256 characters",
        ));
    }
    let agent_id = request.agent_id.map(str::trim).filter(|id| !id.is_empty());
    let target = json!({
        "credential": { "agentId": agent_id, "site": site, "submitUrls": submit_urls },
    });
    let mut form = json!({ "type": "credential", "site": site, "totp": request.totp });
    if let Some(username) = username {
        form["username"] = json!(username);
    }
    request_with_form(
        store,
        cloud,
        (target, Some(form)),
        (request.label, request.ttl_secs),
        actor,
    )
    .await
}

/// The credential target of a request link, or `None` for a plain request.
pub fn target_of(target: Option<&Value>) -> Option<CredentialTarget> {
    let credential = target?.get("credential")?;
    Some(CredentialTarget {
        agent_id: credential
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        site: credential.get("site")?.as_str()?.to_owned(),
        submit_urls: credential
            .get("submitUrls")
            .and_then(Value::as_array)
            .map(|urls| {
                urls.iter()
                    .filter_map(|url| url.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    username: Option<String>,
    password: String,
    #[serde(default)]
    totp: Option<String>,
}

/// Read the recipient's answer (`credentialAnswer` in the web app) into the
/// account to save. The label becomes the account's description.
pub fn collected_input(
    target: &CredentialTarget,
    answer: &str,
    label: Option<&str>,
) -> Result<CollectedInput> {
    let answer: Answer = serde_json::from_str(answer)
        .map_err(|_| invalid("the answer is not a sign-in for this request"))?;
    if answer.kind != "credential" {
        return Err(invalid("the answer is not a sign-in for this request"));
    }
    Ok(CollectedInput {
        site: target.site.clone(),
        username: answer.username,
        password: Zeroizing::new(answer.password),
        totp: answer.totp.map(Zeroizing::new),
        label: label.map(str::to_owned),
        submit_urls: target.submit_urls.clone(),
    })
}

#[cfg(test)]
#[path = "credential_tests.rs"]
mod tests;
