use sha2::{Digest, Sha256};

use crate::error::GatewayError;

/// A Composio user namespace derived only from Gateway-authenticated org state.
/// The hash keeps raw organization ids out of the provider's user-id namespace.
pub struct ComposioTenantScope {
    prefix: String,
}

impl ComposioTenantScope {
    pub fn new(org_id: &str) -> Result<Self, GatewayError> {
        if org_id.trim().is_empty() {
            return Err(GatewayError::Unauthorized(
                "Composio requires an authenticated organization".to_owned(),
            ));
        }
        Ok(Self {
            prefix: format!(
                "ryu_org_v1_{}_",
                hex::encode(Sha256::digest(org_id.as_bytes()))
            ),
        })
    }

    pub fn default_user_id(&self) -> String {
        format!("{}default", self.prefix)
    }

    pub fn user_id(&self, user_id: &str) -> String {
        format!(
            "{}user_{}",
            self.prefix,
            hex::encode(Sha256::digest(user_id.as_bytes()))
        )
    }

    pub fn account_user_id(&self, account_id: &str) -> Result<String, GatewayError> {
        if account_id.trim().is_empty() || account_id.len() > 256 {
            return Err(GatewayError::BadRequest(
                "invalid Composio account identity".to_owned(),
            ));
        }
        Ok(format!(
            "{}account_{}",
            self.prefix,
            hex::encode(Sha256::digest(account_id.as_bytes()))
        ))
    }

    pub fn entity_for_user(&self, user_id: Option<&str>) -> String {
        user_id
            .filter(|value| !value.trim().is_empty())
            .map_or_else(|| self.default_user_id(), |value| self.user_id(value))
    }

    /// Whether `user_id` is a Composio entity this caller may act through.
    ///
    /// The org-shared entity and app-account entities (`account_`) belong to
    /// the organization. A member's personal entity (`user_`) belongs to that
    /// member alone: it is accepted only when it is the authenticated caller's
    /// own entity, so naming another member's connected-account id never lets
    /// an org-level caller act through that member's account.
    pub(super) fn owns_user_id(&self, user_id: &str, caller_user_id: Option<&str>) -> bool {
        if user_id == self.default_user_id() {
            return true;
        }
        if let Some(caller) = caller_user_id.filter(|value| !value.trim().is_empty()) {
            if user_id == self.user_id(caller) {
                return true;
            }
        }
        user_id
            .strip_prefix(&format!("{}account_", self.prefix))
            .is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    }
}

pub(super) fn valid_connection_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A Composio action slug is the last segment of the key-bearing
/// `/tools/execute/{slug}` URL. Only ASCII alphanumerics, `_` and `-` may reach
/// it: a `/`, `..`, `%`, `?` or `#` could move the request to another action or
/// API path than the one the caller named.
pub(super) fn valid_action_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 256
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
