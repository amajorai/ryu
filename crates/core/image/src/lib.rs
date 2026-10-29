//! Image-generation modality primitive: `generate(prompt) -> image` behind a
//! swappable engine seam.
//!
//! One dispatch ([`generate`]) over two engines:
//! - **local stable-diffusion.cpp** (default): forwarded to the resident
//!   sd-server's OpenAI-compatible `/v1/images/generations`, or its local
//!   img2img endpoint for masked image edits, lazily started via the host's
//!   [`ImageHost::start_local_engine`].
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
//! sibling video data path reuses the same routing mechanics and the native
//! async-job adapter in [`video`] rather than duplicating them.

pub mod video;

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
/// `"provider"` field in the body. Absent or recognized local provider IDs use
/// the local engine; dispatch rejects unsupported explicit IDs.
pub const CLOUD_PROVIDERS: [&str; 3] = ["openrouter", "replicate", "fal"];
const MAX_LOCAL_EDIT_SIDE: u32 = 4096;

/// Reject an explicit unknown provider instead of silently routing it locally.
pub fn validate_media_provider(body: &Value) -> Result<(), &'static str> {
    let provider = match body.get("provider") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::String(value)) => value.trim().to_lowercase(),
        _ => return Err("media provider must be a string"),
    };
    if provider.is_empty()
        || ["local", "sdcpp", "sd-server", "stable-diffusion.cpp"].contains(&provider.as_str())
        || CLOUD_PROVIDERS.contains(&provider.as_str())
    {
        return Ok(());
    }
    Err("unsupported media provider; choose local, sdcpp, openrouter, replicate, or fal")
}

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

fn take_request_id(body: &mut Value) -> Option<String> {
    body.as_object_mut()
        .and_then(|object| object.remove("request_id"))
        .and_then(|value| value.as_str().map(str::to_owned))
}

fn take_project_id(body: &mut Value) -> Option<String> {
    body.as_object_mut()
        .and_then(|object| object.remove("project_id"))
        .and_then(|value| value.as_str().map(str::to_owned))
}

/// Forward a media request to the Gateway, routing to `provider` via the
/// per-request slot header for `modality` (image/video). The Gateway runs the
/// full firewall/budget/metering pipeline and returns a normalized body.
pub async fn forward_to_gateway(
    host: &impl ImageHost,
    modality: &str,
    endpoint: &str,
    provider: &str,
    mut body: Value,
) -> MediaResponse {
    let base = host.gateway_url();
    let url = format!("{}{endpoint}", base.trim_end_matches('/'));
    let slot_header = format!("x-ryu-slot-{modality}-provider");

    let request_id = take_request_id(&mut body);
    let project_id = take_project_id(&mut body);
    let mut req = media_client()
        .post(&url)
        .header(slot_header, provider)
        .json(&body);
    if let Some(request_id) = request_id {
        req = req.header("x-ryu-request-id", request_id);
    }
    if let Some(project_id) = project_id {
        req = req.header("x-ryu-project-id", project_id);
    }
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

fn is_inline_raster_image(value: &Value) -> bool {
    let Some(data_url) = value.as_str() else {
        return false;
    };
    let Some((metadata, payload)) = data_url.split_once(',') else {
        return false;
    };
    metadata.starts_with("data:image/")
        && metadata.ends_with(";base64")
        && !metadata.eq_ignore_ascii_case("data:image/svg+xml;base64")
        && !payload.is_empty()
}

fn parse_local_edit_size(value: &Value) -> Result<(u32, u32), &'static str> {
    let Some(size) = value.as_str() else {
        return Err("local image edit size must be WIDTHxHEIGHT");
    };
    let Some((width, height)) = size.split_once('x') else {
        return Err("local image edit size must be WIDTHxHEIGHT");
    };
    if height.contains('x') {
        return Err("local image edit size must be WIDTHxHEIGHT");
    }
    let width = width
        .parse::<u32>()
        .map_err(|_| "local image edit dimensions are invalid")?;
    let height = height
        .parse::<u32>()
        .map_err(|_| "local image edit dimensions are invalid")?;
    let valid_dimension =
        |dimension: u32| (64..=MAX_LOCAL_EDIT_SIDE).contains(&dimension) && dimension % 64 == 0;
    if !valid_dimension(width) || !valid_dimension(height) {
        return Err("local image edit dimensions must be multiples of 64 from 64 to 4096");
    }
    Ok((width, height))
}

/// Adapt Ryu's JSON image-edit fields to stable-diffusion.cpp's JSON img2img
/// contract. Image data must be inline so the local engine never fetches a
/// caller-controlled URL. Returns `false` when this is text-to-image instead.
fn prepare_local_image_edit(body: &mut Value) -> Result<bool, &'static str> {
    let input_mask = body.get("input_mask").cloned();
    let Some(input_images_value) = body.get("input_images") else {
        if input_mask.is_some() {
            return Err("a local image-edit mask requires an input image");
        }
        if let Some(object) = body.as_object_mut() {
            object.remove("provider");
        }
        return Ok(false);
    };
    let Some(input_images) = input_images_value.as_array() else {
        return Err("local image edits need an array of input images");
    };
    if input_images.is_empty() {
        if input_mask.is_some() {
            return Err("a local image-edit mask requires an input image");
        }
        if let Some(object) = body.as_object_mut() {
            object.remove("provider");
        }
        return Ok(false);
    }
    if input_images.len() != 1 || !is_inline_raster_image(&input_images[0]) {
        return Err("local image edits need one inline raster image");
    }
    let input_images = input_images.clone();
    if input_mask
        .as_ref()
        .is_some_and(|mask| !is_inline_raster_image(mask))
    {
        return Err("local image-edit masks must be inline raster images");
    }

    let size = body.get("size").map(parse_local_edit_size).transpose()?;
    let batch_size = match body.get("n") {
        None => 1,
        Some(value) => {
            let count = value
                .as_u64()
                .filter(|count| (1..=4).contains(count))
                .ok_or("local image edit count must be from 1 to 4")?;
            u32::try_from(count).map_err(|_| "local image edit count must be from 1 to 4")?
        }
    };
    let denoising_strength = match body.get("denoising_strength") {
        None if input_mask.is_some() => 0.9,
        None => 0.3,
        Some(value) => {
            let Some(strength) = value.as_f64() else {
                return Err("local image-edit denoising strength must be between 0 and 1");
            };
            if !(0.0..=1.0).contains(&strength) {
                return Err("local image-edit denoising strength must be between 0 and 1");
            }
            strength
        }
    };

    let Some(object) = body.as_object_mut() else {
        return Err("local image edit request must be an object");
    };
    object.remove("provider");
    object.remove("input_images");
    object.remove("input_mask");
    object.remove("n");
    object.insert("init_images".to_owned(), Value::Array(input_images));
    object.insert("batch_size".to_owned(), json!(batch_size));
    object.insert("denoising_strength".to_owned(), json!(denoising_strength));
    if let Some(mask) = input_mask {
        object.insert("mask".to_owned(), mask);
        object.insert("inpainting_mask_invert".to_owned(), json!(false));
    }
    if let Some((width, height)) = size {
        object.remove("size");
        object.insert("width".to_owned(), json!(width));
        object.insert("height".to_owned(), json!(height));
    }
    Ok(true)
}

fn normalize_local_image_edit_response(mut response: Value) -> Value {
    let Some(images) = response.get("images").and_then(Value::as_array) else {
        return response;
    };
    let data = images
        .iter()
        .filter_map(Value::as_str)
        .map(|image| {
            json!({
                "b64_json": image.strip_prefix("data:image/png;base64,").unwrap_or(image)
            })
        })
        .collect::<Vec<_>>();
    if let Some(object) = response.as_object_mut() {
        object.remove("images");
        object.insert("data".to_owned(), Value::Array(data));
    }
    response
}

/// Image-generation dispatch: validate `prompt`, default a single-image count,
/// then route to the Gateway (cloud provider selected) or local sd-server engine.
/// This is the reusable image-gen entry; Core's `POST /api/images/generate`
/// handler is a thin wrapper over it, injecting [`ImageHost`].
pub async fn generate(host: &impl ImageHost, mut body: Value) -> MediaResponse {
    if let Err(error) = validate_media_provider(&body) {
        return (400, json!({"error": error}));
    }
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
    let provider = cloud_provider(&body);
    let provider_input = match take_image_provider_input(&mut body, provider.is_some()) {
        Ok(fields) => fields,
        Err(error) => return (400, json!({ "error": error })),
    };
    if let Some(provider) = provider {
        if provider == "openrouter" {
            body = openrouter_image_body(body);
        }
        if let Err(error) = merge_provider_fields(&mut body, provider_input) {
            return (400, json!({ "error": error }));
        }
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
    let local_edit = match prepare_local_image_edit(&mut body) {
        Ok(is_edit) => is_edit,
        Err(error) => return (400, json!({ "error": error })),
    };
    take_request_id(&mut body);
    take_project_id(&mut body);
    let endpoint = if local_edit {
        "/sdapi/v1/img2img"
    } else {
        "/v1/images/generations"
    };
    let (status, response) = proxy(&host.sd_base_url(), endpoint, body).await;
    if local_edit && status == 200 {
        (status, normalize_local_image_edit_response(response))
    } else {
        (status, response)
    }
}

/// Keys an image request's `provider_input` may never set: the video set
/// (routing, prompt, correlation and canonical inputs) plus the local edit mask.
const RESERVED_IMAGE_PROVIDER_INPUT_KEYS: [&str; 1] = ["input_mask"];

/// Remove and validate an image request's `provider_input`: a JSON object of
/// model-specific fields for a cloud provider. The local engine has no such
/// fields, so supplying one without a cloud provider is refused rather than
/// ignored. Routing, prompt and canonical input keys are refused.
fn take_image_provider_input(
    body: &mut Value,
    cloud: bool,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(object) = body.as_object_mut() else {
        return Ok(serde_json::Map::new());
    };
    let fields = match object.remove("provider_input") {
        None | Some(Value::Null) => return Ok(serde_json::Map::new()),
        Some(Value::Object(fields)) => fields,
        Some(_) => return Err("`provider_input` must be a JSON object".into()),
    };
    if !cloud {
        return Err(
            "`provider_input` applies to cloud providers only; the local engine has no model-specific fields"
                .into(),
        );
    }
    if let Some(key) = fields.keys().find(|key| {
        video::RESERVED_PROVIDER_INPUT_KEYS.contains(&key.as_str())
            || RESERVED_IMAGE_PROVIDER_INPUT_KEYS.contains(&key.as_str())
    }) {
        return Err(format!(
            "`provider_input` cannot set `{key}`; routing, prompt and canonical input fields are not overridable"
        ));
    }
    Ok(fields)
}

/// Merge validated `provider_input` fields into the provider body. A field the
/// request already carries is never replaced.
fn merge_provider_fields(
    body: &mut Value,
    fields: serde_json::Map<String, Value>,
) -> Result<(), String> {
    if fields.is_empty() {
        return Ok(());
    }
    let object = body
        .as_object_mut()
        .ok_or("media request must be a JSON object")?;
    if let Some(key) = fields.keys().find(|key| object.contains_key(*key)) {
        return Err(format!(
            "`provider_input.{key}` conflicts with a field already in the request"
        ));
    }
    object.extend(fields);
    Ok(())
}

/// Convert the app-host image-edit field into OpenRouter's multimodal chat
/// shape. OpenRouter generates images through `chat/completions`, so a plain
/// `{ prompt, input_images }` request would otherwise lose the source images at
/// the provider boundary. Other providers keep the original body because their
/// model-specific input schemas differ and are intentionally not guessed here.
fn openrouter_image_body(mut body: Value) -> Value {
    let Some(images) = body
        .get("input_images")
        .and_then(Value::as_array)
        .filter(|images| !images.is_empty())
        .cloned()
    else {
        return body;
    };
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for image in images {
        if let Some(url) = image.as_str() {
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("input_images");
        object.insert(
            "messages".to_owned(),
            json!([{ "role": "user", "content": content }]),
        );
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    struct FakeHost;
    impl ImageHost for FakeHost {
        fn sd_base_url(&self) -> String {
            "http://127.0.0.1:8101".into()
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

    struct LocalTestHost {
        image_url: String,
    }

    impl ImageHost for LocalTestHost {
        fn sd_base_url(&self) -> String {
            self.image_url.clone()
        }
        fn gateway_url(&self) -> String {
            "http://127.0.0.1:1".into()
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

    #[test]
    fn request_id_is_removed_from_media_body_and_returned_for_gateway_headers() {
        let mut body = json!({
            "prompt": "a cat",
            "request_id": "generation-42"
        });
        assert_eq!(take_request_id(&mut body).as_deref(), Some("generation-42"));
        assert!(body.get("request_id").is_none());
    }

    #[test]
    fn image_provider_input_is_cloud_only_bounded_and_never_overrides() {
        let mut body = json!({
            "prompt": "a cat",
            "size": "1024x1024",
            "provider_input": { "seed": 7, "image_size": "square_hd" }
        });
        let fields = take_image_provider_input(&mut body, true).unwrap();
        assert!(body.get("provider_input").is_none());
        merge_provider_fields(&mut body, fields).unwrap();
        assert_eq!(body["seed"], json!(7));
        assert_eq!(body["image_size"], json!("square_hd"));
        assert_eq!(body["size"], json!("1024x1024"));

        // Absent or null: nothing to merge, on either target.
        let mut plain = json!({ "prompt": "a cat", "provider_input": null });
        assert!(take_image_provider_input(&mut plain, false)
            .unwrap()
            .is_empty());

        let local = take_image_provider_input(
            &mut json!({ "prompt": "a cat", "provider_input": { "seed": 7 } }),
            false,
        )
        .unwrap_err();
        assert!(local.contains("cloud providers only"), "{local}");

        for key in [
            "model",
            "provider",
            "prompt",
            "request_id",
            "n",
            "input_images",
            "input_mask",
        ] {
            let error = take_image_provider_input(
                &mut json!({ "prompt": "a cat", "provider_input": { key: "x" } }),
                true,
            )
            .unwrap_err();
            assert!(error.contains(&format!("cannot set `{key}`")), "{error}");
        }
        assert!(take_image_provider_input(
            &mut json!({ "prompt": "a cat", "provider_input": ["seed"] }),
            true,
        )
        .is_err());

        let mut sized = json!({ "prompt": "a cat", "size": "512x512" });
        let mut replace = serde_json::Map::new();
        replace.insert("size".into(), json!("2048x2048"));
        let conflict = merge_provider_fields(&mut sized, replace).unwrap_err();
        assert!(conflict.contains("provider_input.size"), "{conflict}");
        assert_eq!(sized["size"], json!("512x512"));
    }

    #[tokio::test]
    async fn local_image_request_with_provider_input_is_refused_before_the_engine() {
        let (code, body) = generate(
            &FakeHost,
            json!({ "prompt": "a cat", "provider_input": { "seed": 7 } }),
        )
        .await;
        assert_eq!(code, 400);
        assert!(body["error"]
            .as_str()
            .is_some_and(|e| e.contains("cloud providers only")));
    }

    #[tokio::test]
    async fn explicit_unknown_provider_is_not_routed_to_local_generation() {
        let (code, body) = generate(
            &FakeHost,
            json!({"prompt":"a bicycle","provider":"unknown-vendor"}),
        )
        .await;
        assert_eq!(code, 400);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("unsupported media provider"));
        assert!(validate_media_provider(&json!({"provider":42})).is_err());
        for provider in [
            "",
            "local",
            "sdcpp",
            "sd-server",
            "stable-diffusion.cpp",
            " Fal ",
            "replicate",
            "openrouter",
        ] {
            assert!(validate_media_provider(&json!({"provider":provider})).is_ok());
        }
    }

    #[test]
    fn project_id_is_removed_from_media_body_for_gateway_headers() {
        let mut body = json!({
            "prompt": "a test",
            "project_id": "project-42"
        });
        assert_eq!(take_project_id(&mut body).as_deref(), Some("project-42"));
        assert!(body.get("project_id").is_none());
    }

    #[test]
    fn local_image_edit_maps_inline_input_mask_and_size_to_img2img() {
        let mut body = json!({
            "denoising_strength": 0.88,
            "input_images": ["data:image/png;base64,aGVsbG8="],
            "input_mask": "data:image/png;base64,bWFzaw==",
            "n": 1,
            "prompt": "extend the scene",
            "provider": "local",
            "size": "1024x576"
        });

        assert!(prepare_local_image_edit(&mut body).unwrap());
        assert_eq!(body["init_images"][0], "data:image/png;base64,aGVsbG8=");
        assert_eq!(body["mask"], "data:image/png;base64,bWFzaw==");
        assert_eq!(body["inpainting_mask_invert"], false);
        assert_eq!(body["width"], 1024);
        assert_eq!(body["height"], 576);
        assert_eq!(body["batch_size"], 1);
        assert_eq!(body["denoising_strength"], 0.88);
        assert!(body.get("input_images").is_none());
        assert!(body.get("input_mask").is_none());
        assert!(body.get("provider").is_none());
        assert!(body.get("size").is_none());
        assert!(body.get("n").is_none());
    }

    #[test]
    fn local_image_edit_defaults_strength_and_keeps_unmasked_resize_local() {
        let mut body = json!({
            "input_images": ["data:image/png;base64,aGVsbG8="],
            "prompt": "preserve the image",
            "provider": "local",
            "size": "1536x1152"
        });

        assert!(prepare_local_image_edit(&mut body).unwrap());
        assert_eq!(body["denoising_strength"], 0.3);
        assert_eq!(body["width"], 1536);
        assert_eq!(body["height"], 1152);
        assert!(body.get("mask").is_none());
    }

    #[test]
    fn local_image_edit_rejects_remote_images_and_unsafe_dimensions() {
        let mut remote = json!({
            "input_images": ["https://example.com/image.png"],
            "prompt": "edit",
        });
        assert_eq!(
            prepare_local_image_edit(&mut remote),
            Err("local image edits need one inline raster image")
        );

        let mut unsafe_size = json!({
            "input_images": ["data:image/png;base64,aGVsbG8="],
            "prompt": "edit",
            "size": "8192x8192",
        });
        assert_eq!(
            prepare_local_image_edit(&mut unsafe_size),
            Err("local image edit dimensions must be multiples of 64 from 64 to 4096")
        );
    }

    #[test]
    fn local_img2img_response_is_normalized_for_the_desktop_client() {
        let response = normalize_local_image_edit_response(json!({
            "images": ["data:image/png;base64,aGVsbG8="],
            "info": "",
        }));
        assert!(response.get("images").is_none());
        assert_eq!(response["data"][0]["b64_json"], "aGVsbG8=");
    }

    #[tokio::test]
    async fn generate_rejects_empty_prompt() {
        let (code, body) = generate(&FakeHost, json!({ "prompt": "   " })).await;
        assert_eq!(code, 400);
        assert!(body.get("error").is_some());
    }

    #[tokio::test]
    async fn generate_local_unreachable_engine_is_bad_gateway() {
        // No sd-server on :8101 in tests → proxy surfaces a 502 with the
        // "install from the Store first" hint (and lazy-start is a no-op here).
        let (code, body) = generate(&FakeHost, json!({ "prompt": "a corgi" })).await;
        assert_eq!(code, 502);
        assert!(body["error"]
            .as_str()
            .unwrap_or("")
            .contains("not reachable"));
    }

    #[tokio::test]
    async fn local_image_edit_reaches_img2img_and_returns_a_shared_image_result() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, content_length) = loop {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    panic!("client closed before sending the request body");
                }
                request.extend_from_slice(&chunk[..read]);
                let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break (header_end, content_length);
                }
            };
            let request_line = std::str::from_utf8(&request)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_owned();
            let body_start = header_end + 4;
            let body_end = body_start + content_length;
            let body: Value = serde_json::from_slice(&request[body_start..body_end]).unwrap();
            let response = r#"{"images":["aGVsbG8="],"info":""}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
            (request_line, body)
        });

        let host = LocalTestHost {
            image_url: format!("http://{address}"),
        };
        let (status, response) = generate(
            &host,
            json!({
                "input_images": ["data:image/png;base64,aGVsbG8="],
                "input_mask": "data:image/png;base64,bWFzaw==",
                "prompt": "extend the scene",
                "provider": "local",
                "size": "1024x576"
            }),
        )
        .await;
        let (request_line, request_body) = server.join().unwrap();

        assert_eq!(status, 200);
        assert!(request_line.starts_with("POST /sdapi/v1/img2img "));
        assert_eq!(
            request_body["init_images"][0],
            "data:image/png;base64,aGVsbG8="
        );
        assert_eq!(request_body["mask"], "data:image/png;base64,bWFzaw==");
        assert_eq!(request_body["width"], 1024);
        assert_eq!(request_body["height"], 576);
        assert_eq!(response["data"][0]["b64_json"], "aGVsbG8=");
    }

    #[test]
    fn openrouter_image_body_preserves_prompt_and_source_images() {
        let body = openrouter_image_body(json!({
            "prompt": "make it neon",
            "input_images": ["data:image/png;base64,abc"]
        }));
        assert!(body.get("input_images").is_none());
        assert_eq!(
            body["messages"][0]["content"][0],
            json!({ "type": "text", "text": "make it neon" })
        );
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({
                "type": "image_url",
                "image_url": { "url": "data:image/png;base64,abc" }
            })
        );
    }
}
