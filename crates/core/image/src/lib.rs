//! Image-generation modality primitive: `generate(prompt) -> image` behind a
//! swappable engine seam.
//!
//! One dispatch ([`generate`]) over two engines:
//! - **local stable-diffusion.cpp** (default): forwarded to the resident
//!   sd-server's OpenAI-compatible `/v1/images/generations` (a thin HTTP proxy),
//!   lazily started via the host's [`ImageHost::start_local_engine`].
//! - **cloud** (`openrouter` / `replicate` / `fal`, selected by a `"provider"`
//!   field in the body): routed through the Gateway's `/v1/images/generations`
//!   with the per-attribute `x-ryu-slot-image-provider` header, so the full
//!   firewall/budget/metering pipeline governs the call.
//!
//! Per the Core-vs-Gateway rule the *dispatch* is a Core concern (it decides
//! *what runs* — which media engine renders the pixels); this crate owns the
//! reusable image-gen abstraction + routing, while the host couplings it cannot
//! own — the local sd-server base-url, the Gateway url/token, and lazy-starting
//! the sd.cpp sidecar — are injected via the narrow [`ImageHost`] trait. The
//! crate has ZERO dependency on `apps/core` (mirrors the `ryu-stt` seam).
//!
//! The generic media proxy/gateway-forward helpers ([`proxy`],
//! [`forward_to_gateway`], [`cloud_provider`], [`media_client`]) are `pub` so the
//! sibling *video* data path (which stays in Core, out of this crate's image
//! scope) reuses the same routing mechanics rather than duplicating them.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};

/// A media data-path response: the HTTP status code and the JSON body. Core maps
/// the `u16` back to an `axum` `StatusCode` and wraps the body in `Json`, so the
/// wire behavior is byte-identical to the pre-extraction handlers.
pub type MediaResponse = (u16, Value);

/// Narrow host seam for image generation: the couplings the crate cannot own
/// because they read Core config/sidecar state (the local sd-server base-url, the
/// Gateway url + token, and lazy-starting the off-by-default sd.cpp sidecar). Core
/// implements this in `apps/core/src/image_host.rs`.
pub trait ImageHost: Send + Sync {
    /// Base URL the local sd-server media engine serves on (`{base}/v1/...`).
    fn sd_base_url(&self) -> String;
    /// Base URL of the Gateway (`{base}/v1/images/generations`).
    fn gateway_url(&self) -> String;
    /// The Gateway bearer token slot (never a raw provider API key). `None` when
    /// unset — the request is still sent, unauthenticated.
    fn gateway_token(&self) -> Option<String>;
    /// Lazily start the (off-by-default) local media engine so text-to-image works
    /// out of the box once the sd-server binary + model are installed. Best-effort:
    /// on failure the subsequent [`proxy`] returns a clear "install from the Store
    /// first" error. Returns a boxed `Send` future so the crate's dispatch future
    /// stays `Send` for the axum handler.
    fn start_local_engine(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
}

/// Cloud media providers routed through the Gateway (governed, metered) rather
/// than the local stable-diffusion.cpp engine. A request selects one via a
/// `"provider"` field in the body; anything else (or absent) uses the local
/// engine, so the default local path is unchanged.
pub const CLOUD_PROVIDERS: [&str; 3] = ["openrouter", "replicate", "fal"];

/// Returns the normalized cloud provider id when the body selects one, else
/// `None` (⇒ the local sd-server path).
pub fn cloud_provider(body: &Value) -> Option<String> {
    body.get("provider")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| CLOUD_PROVIDERS.contains(&s.as_str()))
}

/// Diffusion on CPU can take minutes; use a generous client timeout independent
/// of the short-lived shared `ServerState` client.
pub fn media_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .timeout(Duration::from_secs(600))
        .build()
        .expect("reqwest client")
}

/// Forward a media request to the Gateway, routing to `provider` via the
/// per-request slot header for `modality` (image/video). The Gateway runs the
/// full firewall/budget/metering pipeline and returns a normalized body.
pub async fn forward_to_gateway(
    host: &impl ImageHost,
    modality: &str,
    endpoint: &str,
    provider: &str,
    body: Value,
) -> MediaResponse {
    let base = host.gateway_url();
    let url = format!("{}{endpoint}", base.trim_end_matches('/'));
    let slot_header = format!("x-ryu-slot-{modality}-provider");

    let mut req = media_client()
        .post(&url)
        .header(slot_header, provider)
        .json(&body);
    if let Some(t) = host.gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                502,
                json!({
                    "error": format!("cloud media gateway not reachable at {url}: {e}")
                }),
            );
        }
    };
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        // Preserve 202 Accepted (video job submitted) as success; treat other
        // non-2xx as an error with the upstream detail.
        return (
            502,
            json!({ "error": format!("cloud media provider returned {status}"), "detail": value }),
        );
    }
    (200, value)
}

/// Forward a JSON body to a media-engine endpoint (`{base_url}{endpoint}`) and
/// pass the response through. `base_url` is the local sd-server base
/// ([`ImageHost::sd_base_url`]).
pub async fn proxy(base_url: &str, endpoint: &str, body: Value) -> MediaResponse {
    let url = format!("{base_url}{endpoint}");
    let resp = match media_client().post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                502,
                json!({
                    "error": format!(
                        "stable-diffusion.cpp media engine not reachable at {url}: {e}. \
                         Install + start `sdcpp` from the Store first."
                    )
                }),
            );
        }
    };

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    // Pass the upstream body through verbatim when it is JSON; otherwise wrap it.
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));

    if !status.is_success() {
        return (
            502,
            json!({ "error": format!("media engine returned {status}"), "detail": value }),
        );
    }
    (200, value)
}

/// Text-to-image dispatch: validate `prompt`, default a single-image count, then
/// route to the Gateway (cloud provider selected) or the local sd-server engine.
/// This is the reusable image-gen entry; Core's `POST /api/images/generate`
/// handler is a thin wrapper over it, injecting [`ImageHost`].
pub async fn generate(host: &impl ImageHost, mut body: Value) -> MediaResponse {
    if body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return (
            400,
            json!({ "error": "missing `prompt` (the text to render)" }),
        );
    }
    // Default to a single image when the caller doesn't specify a count.
    if let Some(obj) = body.as_object_mut() {
        obj.entry("n").or_insert(json!(1));
    }
    // Cloud provider selected → route through the Gateway; else the local engine.
    if let Some(provider) = cloud_provider(&body) {
        return forward_to_gateway(host, "image", "/v1/images/generations", &provider, body).await;
    }
    // Lazily start the (off-by-default) image engine so text-to-image works
    // out of the box once onboarding has installed the sd-server binary + model.
    // `start_local_engine` adopts an already-running server (fast) or spawns it
    // and waits for the port; on failure we fall through and `proxy` returns a
    // clear "install from the Store first" error.
    if let Err(e) = host.start_local_engine().await {
        tracing::debug!("sdcpp lazy start skipped: {e:#}");
    }
    proxy(&host.sd_base_url(), "/v1/images/generations", body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHost;
    impl ImageHost for FakeHost {
        fn sd_base_url(&self) -> String {
            "http://127.0.0.1:8083".into()
        }
        fn gateway_url(&self) -> String {
            "http://127.0.0.1:7981".into()
        }
        fn gateway_token(&self) -> Option<String> {
            None
        }
        fn start_local_engine(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[test]
    fn cloud_provider_selects_known_and_normalizes() {
        assert_eq!(
            cloud_provider(&json!({ "provider": " Replicate " })),
            Some("replicate".into())
        );
        assert_eq!(
            cloud_provider(&json!({ "provider": "fal" })),
            Some("fal".into())
        );
    }

    #[test]
    fn cloud_provider_rejects_unknown_or_absent() {
        assert_eq!(cloud_provider(&json!({ "provider": "midjourney" })), None);
        assert_eq!(cloud_provider(&json!({ "prompt": "a cat" })), None);
    }

    #[tokio::test]
    async fn generate_rejects_empty_prompt() {
        let (code, body) = generate(&FakeHost, json!({ "prompt": "   " })).await;
        assert_eq!(code, 400);
        assert!(body.get("error").is_some());
    }

    #[tokio::test]
    async fn generate_local_unreachable_engine_is_bad_gateway() {
        // No sd-server on :8083 in tests → proxy surfaces a 502 with the
        // "install from the Store first" hint (and lazy-start is a no-op here).
        let (code, body) = generate(&FakeHost, json!({ "prompt": "a corgi" })).await;
        assert_eq!(code, 502);
        assert!(body["error"]
            .as_str()
            .unwrap_or("")
            .contains("not reachable"));
    }
}
