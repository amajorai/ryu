//! Agent accounts made from sign-in details a person entered for the agent
//! (a hosted credential request link, [`crate::vault::shared::links::credential`]).
//! The password and authenticator seed go straight into the vault item; only
//! metadata comes back, so the agent fills them but never reads them.

use std::collections::BTreeMap;

use anyhow::Result;
use p256::elliptic_curve::zeroize::Zeroizing;

use super::enroll::normalize_enrollment_secret;
use super::fill_target::{self, FIELD_SUBMIT_URLS};
use super::{
    clean_text, insert, invalid, parse_site, AccountView, FIELD_EMAIL, FIELD_PASSWORD, FIELD_SITE,
    FIELD_TOTP, FIELD_USERNAME,
};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;

/// Longest password a person may hand over.
pub const MAX_COLLECTED_PASSWORD: usize = 1024;

/// Sign-in details for one site.
#[derive(Default)]
pub struct CollectedInput {
    pub site: String,
    /// A username, or an email address (saved as both, so either field fills).
    pub username: Option<String>,
    pub password: Zeroizing<String>,
    /// An `otpauth://totp/` URI or a Base32 seed.
    pub totp: Option<Zeroizing<String>>,
    pub label: Option<String>,
    pub submit_urls: Vec<String>,
}

fn check_password(password: &str) -> Result<()> {
    if password.is_empty() {
        return Err(invalid("the password is empty"));
    }
    if password.chars().count() > MAX_COLLECTED_PASSWORD || password.chars().any(char::is_control) {
        return Err(invalid(format!(
            "the password must be at most {MAX_COLLECTED_PASSWORD} printable characters"
        )));
    }
    Ok(())
}

fn looks_like_email(value: &str) -> bool {
    value
        .split_once('@')
        .is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.'))
        && !value.contains(char::is_whitespace)
}

/// Save an account for `agent_id` with the given password and seed.
pub async fn create_collected(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    input: CollectedInput,
    actor: &AuditActor,
) -> Result<AccountView> {
    let (site, host) = parse_site(&input.site)?;
    let username = clean_text("username", input.username.as_deref())?;
    let label = clean_text("label", input.label.as_deref())?;
    let submit_urls = fill_target::validate_submit_urls(&host, &input.submit_urls)?;
    check_password(&input.password)?;
    let seed = match input.totp.as_deref().map(|s| s.trim()) {
        Some(seed) if !seed.is_empty() => Some(normalize_enrollment_secret(seed)?),
        _ => None,
    };
    let mut values = BTreeMap::new();
    values.insert(FIELD_SITE.to_owned(), site);
    values.insert(FIELD_PASSWORD.to_owned(), input.password.to_string());
    if let Some(username) = username {
        if looks_like_email(&username) {
            values.insert(FIELD_EMAIL.to_owned(), username.clone());
        }
        values.insert(FIELD_USERNAME.to_owned(), username);
    }
    if let Some(seed) = seed {
        values.insert(FIELD_TOTP.to_owned(), seed);
    }
    if !submit_urls.is_empty() {
        values.insert(FIELD_SUBMIT_URLS.to_owned(), submit_urls.join(" "));
    }
    insert(store, agent_id, &host, (values, label), actor).await
}

#[cfg(test)]
#[path = "collected_tests.rs"]
mod tests;
