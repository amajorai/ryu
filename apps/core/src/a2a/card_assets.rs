//! Agent Card companions: the card's icon and the JWKS that verifies its
//! signature.
//!
//! Both are public, unauthenticated GETs next to `/.well-known/agent-card.json`
//! and are addressed by absolute URLs built from the same public base URL the
//! card uses for its `/a2a` interfaces.

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use ed25519_dalek::SigningKey;
use ryu_a2a::{card_signing::ed25519_jwks, protocol::AgentCard, sign_agent_card};

use super::runtime::runtime;

/// Path of the Agent Card icon (`AgentCard.iconUrl`).
pub(super) const CARD_ICON_PATH: &str = "/a2a-card/icon.svg";
/// Path of the JWKS named by the card signature's `jku`.
pub(super) const CARD_JWKS_PATH: &str = "/a2a-card/jwks.json";

/// The Ryu brand mark already shipped with Desktop, served as the card icon.
const RYU_ICON_SVG: &str = include_str!("../../../desktop/public/assets/logos/ryu_light.svg");

/// Public routes for the card icon and signing keys.
pub(super) fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route(CARD_ICON_PATH, get(card_icon))
        .route(CARD_JWKS_PATH, get(card_jwks))
}

/// Absolute URL of a card companion under the card's public base URL.
pub(super) fn card_asset_url(base_url: &str, path: &str) -> String {
    format!("{}{path}", base_url.trim_end_matches('/'))
}

/// The node identity key the card is signed with, when the node is enrolled.
fn card_signing_key() -> Option<SigningKey> {
    crate::fleet::node_identity_signing_key()
}

/// Attach this node's JWS signature to a fully built card. A node without an
/// identity key serves the card unsigned.
pub(super) fn sign_card(card: &mut AgentCard, base_url: &str) {
    card.signatures = None;
    let Some(key) = card_signing_key() else {
        return;
    };
    sign_card_with(card, &key, base_url);
}

fn sign_card_with(card: &mut AgentCard, key: &SigningKey, base_url: &str) {
    let jku = card_asset_url(base_url, CARD_JWKS_PATH);
    match sign_agent_card(card, key, Some(&jku)) {
        Ok(signature) => card.signatures = Some(vec![signature]),
        Err(error) => tracing::warn!(%error, "serving an unsigned A2A Agent Card"),
    }
}

async fn card_icon() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("image/svg+xml"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            // The icon is a static vector mark; refuse script and remote loads
            // if a browser renders it as a document.
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
            ),
        ],
        RYU_ICON_SVG,
    )
        .into_response()
}

async fn card_jwks() -> Response {
    let enabled = runtime()
        .ok()
        .and_then(|runtime| runtime.store.server_config("default").ok())
        .is_some_and(|config| config.enabled);
    if !enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let keys = card_signing_key()
        .map(|key| vec![key.verifying_key()])
        .unwrap_or_default();
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/jwk-set+json"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=300"),
            ),
        ],
        ed25519_jwks(&keys).to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use ryu_a2a::{
        protocol::{AgentCapabilities, AgentInterface},
        verify_agent_card_signatures, CardSignatureStatus,
    };
    use tower::ServiceExt;

    use super::*;

    fn card(base_url: &str) -> AgentCard {
        AgentCard {
            name: "Ryu".to_owned(),
            description: "A Ryu agent endpoint".to_owned(),
            version: "1.0.0".to_owned(),
            supported_interfaces: vec![AgentInterface::new(
                card_asset_url(base_url, "/a2a"),
                "JSONRPC",
            )],
            capabilities: AgentCapabilities {
                streaming: Some(true),
                push_notifications: Some(true),
                extensions: None,
                extended_agent_card: Some(false),
            },
            default_input_modes: vec!["text/plain".to_owned()],
            default_output_modes: vec!["text/plain".to_owned()],
            skills: Vec::new(),
            provider: None,
            documentation_url: None,
            icon_url: Some(card_asset_url(base_url, CARD_ICON_PATH)),
            security_schemes: None,
            security_requirements: None,
            signatures: None,
        }
    }

    #[tokio::test]
    async fn card_icon_url_resolves_to_the_served_brand_icon() {
        let base_url = "https://agent.example.com/";
        let icon_url = card(base_url).icon_url.expect("icon URL");
        assert_eq!(icon_url, "https://agent.example.com/a2a-card/icon.svg");
        let parsed = url::Url::parse(&icon_url).expect("absolute icon URL");
        let response = routes::<()>()
            .oneshot(
                Request::get(parsed.path())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("icon response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("image/svg+xml"))
        );
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("icon body");
        assert!(body.starts_with(b"<svg"));
        assert_eq!(body.as_ref(), RYU_ICON_SVG.as_bytes());
    }

    #[test]
    fn signed_card_names_the_jwks_on_the_card_base_url_and_verifies() {
        let base_url = "https://agent.example.com";
        let key = SigningKey::from_bytes(&[3; 32]);
        let mut signed = card(base_url);
        sign_card_with(&mut signed, &key, base_url);
        let value = serde_json::to_value(&signed).expect("serialize card");
        let status = verify_agent_card_signatures(&value, |header| {
            assert_eq!(
                header.jku.as_deref(),
                Some("https://agent.example.com/a2a-card/jwks.json")
            );
            ryu_a2a::card_signing::KeyResolution::Found(key.verifying_key())
        });
        assert!(
            matches!(status, CardSignatureStatus::Verified { .. }),
            "{status:?}"
        );
        // Re-signing replaces, rather than accumulates, signatures.
        sign_card_with(&mut signed, &key, base_url);
        assert_eq!(signed.signatures.as_ref().map(Vec::len), Some(1));
    }
}
