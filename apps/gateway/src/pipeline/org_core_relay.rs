//! Per-organization Core relay keys on the hosted Gateway.
//!
//! A managed node's Core authenticates with `gwcore_org_<mac>_<org>`, derived
//! by the control plane from `GATEWAY_CORE_RELAY_MASTER_KEY`. The Gateway
//! re-derives it for the org the key names and, when it matches, treats the
//! caller as a trusted Core forwarder bound to that org: it can relay its own
//! org's identities, but never act as an unscoped, fleet-wide forwarder. The
//! key is never a configured `local-core` entry, so it signs no `gws1`/`gwb1`
//! credential either. A key derived at a retired node-root epoch is refused
//! ([`check_relay_key_epoch`]).

use crate::config::{ApiKeyConfig, ApiKeyOperation};

/// Env holding the master the per-org Core relay keys derive from.
pub(crate) const ENV_CORE_RELAY_MASTER_KEY: &str = "GATEWAY_CORE_RELAY_MASTER_KEY";
/// Name of the synthetic key entry an org relay key authenticates as.
pub(crate) const ORG_CORE_RELAY_NAME: &str = "org-core";

/// The org-bound forwarder entry `key` authenticates as, when it is a
/// per-org relay key valid under the configured master.
pub(crate) fn org_core_relay_entry(key: &str) -> Option<ApiKeyConfig> {
    if !key.starts_with(ryu_gw_credentials::ORG_CORE_RELAY_PREFIX) {
        return None;
    }
    let master = std::env::var(ENV_CORE_RELAY_MASTER_KEY).ok()?;
    org_core_relay_entry_from(Some(&master), key)
}

/// The pure half of [`org_core_relay_entry`].
pub(crate) fn org_core_relay_entry_from(master: Option<&str>, key: &str) -> Option<ApiKeyConfig> {
    let (org_id, _epoch) = ryu_gw_credentials::verify_org_core_relay_key(master?, key)?;
    Some(ApiKeyConfig {
        key: key.to_owned(),
        name: ORG_CORE_RELAY_NAME.to_owned(),
        allowed_operations: vec![ApiKeyOperation::Inference],
        org_id: Some(org_id),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: true,
    })
}

/// The org a per-org Core relay caller is bound to, if the request came in on
/// one. Such a caller may speak only for that org: it may not name another
/// org, and it may not use routes that act outside any org. Statically
/// configured keys keep the authority their operator gave them.
pub(crate) fn bound_forwarder_org(ctx: &crate::pipeline::RequestContext) -> Option<&str> {
    ctx.key_config
        .as_ref()
        .filter(|key| {
            key.trusted_forwarder
                && key.name == ORG_CORE_RELAY_NAME
                && key
                    .key
                    .starts_with(ryu_gw_credentials::ORG_CORE_RELAY_PREFIX)
        })
        .and_then(|key| key.org_id.as_deref())
}

/// The master key or a trusted forwarder that is not a per-org Core relay.
pub(crate) fn is_unscoped_trusted(ctx: &crate::pipeline::RequestContext) -> bool {
    ctx.is_master_key
        || (ctx
            .key_config
            .as_ref()
            .is_some_and(|key| key.trusted_forwarder)
            && bound_forwarder_org(ctx).is_none())
}

/// Refuse provider-spending inference on a per-org Core relay key.
///
/// The key exists for Core's control routes (budget charges, sandbox ticks,
/// exec audit, managed provider calls). It is a static, org-bound forwarder
/// that never passes the control-plane admission a tenant's `rgw_` token does
/// (standing, the credit pre-flight and reservation, plan limits, fail-closed
/// debits), so it must never dispatch a model request on the fleet's
/// provider credentials. A managed node's Core sends inference with its
/// org's `rgw_` token instead.
pub(crate) fn refuse_inference(
    ctx: &crate::pipeline::RequestContext,
) -> Result<(), crate::error::GatewayError> {
    if bound_forwarder_org(ctx).is_some() {
        return Err(crate::error::GatewayError::Unauthorized(
            "The Core relay credential does not authorize inference".to_owned(),
        ));
    }
    Ok(())
}

/// Refuse a request in which an org-bound forwarder names another org.
pub(crate) fn require_forwarder_org(
    ctx: &crate::pipeline::RequestContext,
    named: Option<&str>,
) -> Result<(), crate::error::GatewayError> {
    match (
        bound_forwarder_org(ctx),
        named.filter(|org| !org.is_empty()),
    ) {
        (Some(bound), Some(named)) if bound != named => {
            Err(crate::error::GatewayError::Unauthorized(
                "The Core relay credential is bound to another organization".to_owned(),
            ))
        }
        _ => Ok(()),
    }
}

#[path = "org_core_relay_epoch.rs"]
mod epoch;
pub(crate) use epoch::check_relay_key_epoch;

#[cfg(test)]
#[path = "org_core_relay_tests.rs"]
mod tests;
