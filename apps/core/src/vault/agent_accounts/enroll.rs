//! Authenticator (TOTP) enrollment for an agent account: a seed the sidecar
//! read off the account site's setup page.

use anyhow::Result;
use serde_json::json;

use super::{denied, invalid, load, page_matches_host, AccountView, FIELD_TOTP};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::items::{FieldType, ItemPatch};
use crate::vault::totp::{OtpauthKey, TotpParams};

/// Normalize a captured 2FA secret (`otpauth://totp/` URI or Base32 seed) to a
/// Base32 seed. Keys with non-default parameters are refused, because the
/// account stores only the seed and codes use SHA-1, 6 digits, 30 seconds.
pub fn normalize_enrollment_secret(secret: &str) -> Result<String> {
    let secret = secret.trim();
    if secret
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"))
    {
        let key = OtpauthKey::parse(secret)?;
        if key.params != TotpParams::default() {
            return Err(invalid(
                "only SHA-1, 6-digit, 30-second authenticator keys are supported",
            ));
        }
    }
    crate::vault::items::normalize_totp_seed(secret)
        .ok_or_else(|| invalid("the secret is not an otpauth URI or a Base32 authenticator key"))
}

/// Store a 2FA seed captured from a setup page at `page_url`, which must
/// belong to the account's site.
pub async fn enroll_totp(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
    secret: &str,
    page_url: &str,
    actor: &AuditActor,
) -> Result<AccountView> {
    let (coords, view, account) = load(store, agent_id, id).await?;
    if !page_matches_host(page_url, &account.host) {
        return Err(denied(format!(
            "account `{id}` enrolls an authenticator only from https pages of {}",
            account.host
        )));
    }
    debug_assert!(view
        .fields
        .iter()
        .any(|f| f.def.name == FIELD_TOTP && f.def.field_type == FieldType::Totp));
    let seed = normalize_enrollment_secret(secret)?;
    let patch: ItemPatch = serde_json::from_value(json!({
        "environment": coords.environment,
        "path": coords.path,
        "expectedVersion": view.version,
        "expectedId": view.id,
        "values": { FIELD_TOTP: seed },
    }))?;
    store.item_patch(&coords.key, patch, actor).await?;
    load(store, agent_id, id)
        .await
        .map(|(_, _, account)| account)
}
