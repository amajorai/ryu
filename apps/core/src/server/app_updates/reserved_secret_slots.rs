//! Secret-store slots that Core-internal flows own, which the generic per-plugin
//! BYOK routes must never write or clear.
//!
//! The Composio project webhook signing secret lives in the plugin secret store
//! under `(@ryu/webhooks, COMPOSIO_WEBHOOK_SECRET)`: trigger reconciliation writes
//! the provider's value there and boot loads it into the Composio verifier. The
//! dedicated `/api/webhooks/composio/secret` route needs `gateway.configure` and
//! refuses manual writes outright, so the `app.update`-gated BYOK routes must
//! refuse that slot too, or they become a way around both checks.

use crate::server::*;

/// `true` when `(plugin_id, key)` is a slot Core manages itself.
pub(in crate::server) fn is_core_reserved_secret_slot(plugin_id: &str, key: &str) -> bool {
    plugin_id == ryu_composio::triggers::WEBHOOK_SECRET_STORE_OWNER
        && key == ryu_composio::triggers::WEBHOOK_SECRET_STORE_KEY
}

/// The 409 the BYOK PUT/DELETE routes return for a Core-reserved slot, or `None`
/// when the slot is an ordinary plugin credential. Matches the refusal of
/// `webhook_secret_set` for `id == "composio"`.
pub(in crate::server) fn reserved_secret_slot_refusal(
    plugin_id: &str,
    key: &str,
) -> Option<axum::response::Response> {
    is_core_reserved_secret_slot(plugin_id, key).then(|| {
        json_error(
            StatusCode::CONFLICT,
            "Composio manages the project webhook secret; save a Composio trigger to sync it"
                .to_owned(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = ryu_composio::triggers::WEBHOOK_SECRET_STORE_OWNER;
    const KEY: &str = ryu_composio::triggers::WEBHOOK_SECRET_STORE_KEY;

    #[test]
    fn composio_webhook_secret_slot_is_refused_with_409() {
        assert_eq!(OWNER, "@ryu/webhooks");
        assert_eq!(KEY, "COMPOSIO_WEBHOOK_SECRET");
        let response = reserved_secret_slot_refusal(OWNER, KEY).expect("reserved slot refused");
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn ordinary_plugin_credentials_are_not_reserved() {
        assert!(reserved_secret_slot_refusal(OWNER, "RYU_WEBHOOKS_TEST_KEY").is_none());
        assert!(reserved_secret_slot_refusal("@ryu/browser", KEY).is_none());
        assert!(reserved_secret_slot_refusal("@ryu/tavily", "RYU_TAVILY_API_KEY").is_none());
    }

    /// Both BYOK mutation handlers must consult the guard before they touch the
    /// store; a refactor that drops the call reopens the bypass.
    #[test]
    fn byok_put_and_delete_check_the_reserved_slot_before_the_store() {
        let source = include_str!("per_plugin_byok.rs");
        for handler in [
            "fn put_plugin_secret_handler(",
            "fn delete_plugin_secret_handler(",
        ] {
            let start = source.find(handler).expect("handler present");
            let body = &source[start..];
            let end = body[1..]
                .find("pub(in crate::server) async fn")
                .map_or(body.len(), |i| i + 1);
            let body = &body[..end];
            let guard = body
                .find("reserved_secret_slot_refusal(&id, &key)")
                .unwrap_or_else(|| panic!("{handler} must refuse Core-reserved slots"));
            let store = body.find("plugin_secret_store()").expect("store access");
            assert!(
                guard < store,
                "{handler} must refuse before opening the store"
            );
        }
    }
}
