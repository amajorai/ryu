//! The body of the Gateway's proactive-opening request to Core.
//!
//! The opening is the first message a channel sends the owner, so it is written
//! in the owner's locale, the same language the channel bridge's own replies
//! fall back to ([`ChannelRuntime::owner_locale`]). Core writes it in its node
//! language when no locale is sent.

use super::*;

/// `POST /api/proactive/opening` body for `target`, carrying the owner's locale.
pub(super) async fn opening_request_body(
    runtime: &ChannelRuntime,
    target: &str,
    agent_id: &str,
    idempotency_key: &str,
) -> Value {
    json!({
        "conversation_id": target,
        "agent_id": agent_id,
        "idempotency_key": idempotency_key,
        "locale": runtime.owner_locale().await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(owner: &str) -> ChannelRuntime {
        let mut runtime = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig::default(),
            PairingStore::ephemeral(),
            None,
        );
        runtime.owner_locale = i18n::OwnerLocale::fixed(owner);
        runtime
    }

    #[tokio::test]
    async fn forwards_the_owner_locale() {
        let body = opening_request_body(&runtime("ja-JP"), "42", "ryu", "key-1").await;
        assert_eq!(
            body,
            json!({
                "conversation_id": "42",
                "agent_id": "ryu",
                "idempotency_key": "key-1",
                "locale": "ja",
            })
        );
    }

    #[tokio::test]
    async fn english_owner_sends_english() {
        let body = opening_request_body(&runtime("en"), "42", "ryu", "key-1").await;
        assert_eq!(body["locale"], "en");
    }
}
