//! Job-based media generation: video (text, image, video and audio inputs)
//! and generated audio (music, sound effects).
//!
//! Callers describe reference media with canonical, provider-neutral fields:
//!
//! - `input_images`: `[first, last?]` frames,
//! - `input_video`: a source clip (video-to-video, lip-sync),
//! - `input_audio`: an audio track (lip-sync, talking avatars, melody input),
//! - `provider_input`: a JSON object merged into the cloud body, for the
//!   model-specific fields a queue-based provider expects.
//!
//! Each target maps them explicitly or refuses them; nothing is dropped
//! silently, so a request never quietly degrades into plain text-to-video.
//!
//! - **Runway** takes one first frame as `promptImage`; it has no last-frame,
//!   video or audio input.
//! - **Fal / Replicate** model inputs differ per model, so the caller names
//!   the field in `provider_input` with a reference such as
//!   `{"video_url": "$input_video"}` (also `$input_audio`, `$input_images.0`,
//!   `$input_images.1` and `$duration_s`). Each canonical input is referenced
//!   exactly once: a canonical input with no reference is refused rather than
//!   guessed, and a repeated reference is refused rather than duplicated.
//! - **OpenRouter** has no Gateway video-job implementation, so a video
//!   request naming it is refused up front instead of failing upstream.
//! - **Local** sd-server takes `init_image` / `end_image` only when the host
//!   reports that the model it actually launches is an image-to-video or
//!   first/last-frame model with every encoder it needs loaded; the default
//!   text-to-video model refuses every reference input.

use crate::{ImageHost, MediaResponse};
use serde_json::{json, Map, Value};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Cloud providers that can run a video job through the Gateway.
pub const VIDEO_CLOUD_PROVIDERS: [&str; 3] = ["replicate", "fal", "runway"];
/// Cloud providers that route images but have no Gateway video-job
/// implementation; a video request naming one is refused with this reason.
const VIDEO_UNSUPPORTED_CLOUD_PROVIDERS: [&str; 1] = ["openrouter"];
/// Cloud providers whose queue accepts an audio-generation (music, SFX) job.
/// Runway, Topaz and BFL have fixed video schemas and refuse audio.
pub const AUDIO_CLOUD_PROVIDERS: [&str; 2] = ["fal", "replicate"];
/// At most two reference frames: the first and, optionally, the last.
pub const MAX_INPUT_IMAGES: usize = 2;
/// Keys `provider_input` may never set: they select the route, carry the
/// prompt, correlate the request, or are the canonical inputs themselves.
pub const RESERVED_PROVIDER_INPUT_KEYS: [&str; 12] = [
    "model",
    "provider",
    "prompt",
    "request_id",
    "n",
    "project_id",
    "input_images",
    "input_video",
    "input_audio",
    "provider_input",
    "duration_s",
    "kind",
];

/// What the active local video model accepts besides the prompt. The default
/// (all `false`) is a text-to-video model. The host decides it from the model
/// it actually launches and the companion encoders it loads with it, so a
/// frame model whose encoders are not provisioned reports the default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalVideoInputs {
    /// Image-to-video: the model takes a start frame (`init_image`).
    pub first_frame: bool,
    /// First/last-frame-to-video: the model also takes an end frame
    /// (`end_image`).
    pub last_frame: bool,
}

/// Host seam for the local video engine's input support. Separate from
/// [`ImageHost`] so the image path keeps its narrow contract; Core implements
/// both on the same host.
pub trait LocalVideoHost {
    /// What the currently active local video model accepts.
    fn local_video_inputs(&self) -> Pin<Box<dyn Future<Output = LocalVideoInputs> + Send + '_>>;
}

/// Where a media request will run, which decides how canonical inputs map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaTarget<'a> {
    /// A Gateway-routed cloud provider (normalized lowercase id).
    Cloud(&'a str),
    /// The local sd-server engine with its active model's input support.
    Local(LocalVideoInputs),
}

/// Normalized provider id when the body selects one from `allowed`.
fn selected_provider(body: &Value, allowed: &[&str]) -> Option<String> {
    body.get("provider")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| allowed.contains(&s.as_str()))
}

/// The cloud provider a video request selects, if any.
pub fn video_cloud_provider(body: &Value) -> Option<String> {
    selected_provider(body, &VIDEO_CLOUD_PROVIDERS)
}

/// Reject an explicit unknown video provider instead of routing it locally.
pub fn validate_video_provider(body: &Value) -> Result<(), &'static str> {
    let provider = match body.get("provider") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::String(value)) => value.trim().to_lowercase(),
        _ => return Err("media provider must be a string"),
    };
    if VIDEO_UNSUPPORTED_CLOUD_PROVIDERS.contains(&provider.as_str()) {
        return Err(
            "openrouter does not run video jobs; choose local, sdcpp, replicate, fal, or runway",
        );
    }
    if provider.is_empty()
        || ["local", "sdcpp", "sd-server", "stable-diffusion.cpp"].contains(&provider.as_str())
        || VIDEO_CLOUD_PROVIDERS.contains(&provider.as_str())
    {
        return Ok(());
    }
    Err("unsupported video provider; choose local, sdcpp, replicate, fal, or runway")
}

fn is_base64_payload(payload: &str) -> bool {
    !payload.is_empty()
        && payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

/// Validate one reference media value: an inline base64 `data:` URI of the
/// expected media family, or (cloud only) an `https` URL the provider fetches.
fn validate_media_value(
    value: &Value,
    field: &str,
    family: &str,
    allowed_subtypes: Option<&[&str]>,
    allow_remote: bool,
) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err(format!("`{field}` must be a string"));
    };
    if let Some(rest) = text.strip_prefix("data:") {
        let Some((metadata, payload)) = rest.split_once(',') else {
            return Err(format!("`{field}` is not a valid data URI"));
        };
        let Some(mime) = metadata.strip_suffix(";base64") else {
            return Err(format!("`{field}` must be base64-encoded"));
        };
        let mime = mime.to_ascii_lowercase();
        let Some(subtype) = mime.strip_prefix(&format!("{family}/")) else {
            return Err(format!("`{field}` must be {family} media"));
        };
        if allowed_subtypes.is_some_and(|allowed| !allowed.contains(&subtype)) {
            return Err(format!("`{field}` has an unsupported {family} type"));
        }
        if !is_base64_payload(payload) {
            return Err(format!("`{field}` has an empty or invalid base64 payload"));
        }
        // Providers accept only the registered media type, so the common
        // non-standard `image/jpg` alias is normalized to `image/jpeg`, and
        // the type is lowercased, before the URI leaves Core.
        let subtype = if family == "image" && subtype == "jpg" {
            "jpeg"
        } else {
            subtype
        };
        return Ok(format!("data:{family}/{subtype};base64,{payload}"));
    }
    if allow_remote && text.starts_with("https://") && text.len() <= 4096 {
        return Ok(text.to_owned());
    }
    if allow_remote {
        Err(format!(
            "`{field}` must be a base64 data URI or an https URL"
        ))
    } else {
        Err(format!(
            "`{field}` must be an inline base64 data URI for the local engine"
        ))
    }
}

/// The canonical inputs removed from a request body, validated.
#[derive(Debug, Default)]
struct CanonicalInputs {
    images: Vec<String>,
    video: Option<String>,
    audio: Option<String>,
    duration_s: Option<Value>,
    provider_input: Option<Map<String, Value>>,
}

fn take_canonical_inputs(body: &mut Value, remote_ok: bool) -> Result<CanonicalInputs, String> {
    let Some(object) = body.as_object_mut() else {
        return Err("media request must be a JSON object".into());
    };
    let mut inputs = CanonicalInputs::default();
    match object.remove("input_images") {
        None | Some(Value::Null) => {}
        Some(Value::Array(images)) => {
            if images.len() > MAX_INPUT_IMAGES {
                return Err("`input_images` takes at most two frames: [first, last]".into());
            }
            for (index, image) in images.iter().enumerate() {
                inputs.images.push(validate_media_value(
                    image,
                    &format!("input_images[{index}]"),
                    "image",
                    Some(&["png", "jpeg", "jpg", "webp"]),
                    remote_ok,
                )?);
            }
        }
        Some(_) => return Err("`input_images` must be an array of frames".into()),
    }
    if let Some(video) = object.remove("input_video").filter(|v| !v.is_null()) {
        inputs.video = Some(validate_media_value(
            &video,
            "input_video",
            "video",
            None,
            remote_ok,
        )?);
    }
    if let Some(audio) = object.remove("input_audio").filter(|v| !v.is_null()) {
        inputs.audio = Some(validate_media_value(
            &audio,
            "input_audio",
            "audio",
            None,
            remote_ok,
        )?);
    }
    if let Some(duration) = object.remove("duration_s").filter(|v| !v.is_null()) {
        if !duration
            .as_f64()
            .is_some_and(|seconds| seconds.is_finite() && seconds > 0.0 && seconds <= 600.0)
        {
            return Err("`duration_s` must be a number of seconds from 0 to 600".into());
        }
        inputs.duration_s = Some(duration);
    }
    match object.remove("provider_input") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            if let Some(key) = map
                .keys()
                .find(|key| RESERVED_PROVIDER_INPUT_KEYS.contains(&key.as_str()))
            {
                return Err(format!(
                    "`provider_input` cannot set `{key}`; routing, prompt and canonical input fields are not overridable"
                ));
            }
            inputs.provider_input = Some(map);
        }
        Some(_) => return Err("`provider_input` must be a JSON object".into()),
    }
    Ok(inputs)
}

/// Replace `$input_*` / `$duration_s` references inside `provider_input` with
/// the canonical values, recording which canonical inputs were used.
///
/// Each canonical input may be referenced once. Repeating a reference would
/// copy the (possibly tens of MiB) value again for every occurrence, letting
/// a body under the route limit expand without bound in memory and producing
/// a forwarded body the Gateway would refuse.
fn resolve_references(
    value: &mut Value,
    inputs: &CanonicalInputs,
    used: &mut [bool; 5],
) -> Result<(), String> {
    match value {
        Value::String(text) if text.starts_with('$') => {
            let (slot, resolved) = match text.as_str() {
                "$input_images.0" => (0, inputs.images.first().cloned().map(Value::String)),
                "$input_images.1" => (1, inputs.images.get(1).cloned().map(Value::String)),
                "$input_video" => (2, inputs.video.clone().map(Value::String)),
                "$input_audio" => (3, inputs.audio.clone().map(Value::String)),
                "$duration_s" => (4, inputs.duration_s.clone()),
                other if other.starts_with("$input_") || other == "$duration" => {
                    return Err(format!(
                        "`provider_input` has an unknown reference `{other}`"
                    ));
                }
                _ => return Ok(()),
            };
            if used[slot] {
                return Err(format!(
                    "`provider_input` references `{text}` more than once; map each input to a single model field"
                ));
            }
            let Some(resolved) = resolved else {
                return Err(format!(
                    "`provider_input` references `{text}`, but the request has no such input"
                ));
            };
            used[slot] = true;
            *value = resolved;
        }
        Value::Array(items) => {
            for item in items {
                resolve_references(item, inputs, used)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                resolve_references(item, inputs, used)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Map canonical reference inputs onto `body` for `target`, or refuse.
///
/// On success the canonical fields are gone from the body and every supplied
/// input is represented in the target's own fields. On refusal the message
/// names what the target cannot do.
pub fn prepare_media_inputs(body: &mut Value, target: MediaTarget<'_>) -> Result<(), String> {
    let remote_ok = matches!(target, MediaTarget::Cloud(_));
    let inputs = take_canonical_inputs(body, remote_ok)?;
    match target {
        MediaTarget::Local(support) => map_local_inputs(body, &inputs, support),
        MediaTarget::Cloud(provider) => map_cloud_inputs(body, inputs, provider),
    }
}

fn map_local_inputs(
    body: &mut Value,
    inputs: &CanonicalInputs,
    support: LocalVideoInputs,
) -> Result<(), String> {
    if inputs.provider_input.is_some() {
        return Err(
            "`provider_input` applies to cloud providers only; the local engine has no model-specific fields"
                .into(),
        );
    }
    if inputs.video.is_some() {
        return Err(
            "this model cannot edit video: the local engine has no video-to-video model; choose a cloud provider such as fal or replicate"
                .into(),
        );
    }
    if inputs.audio.is_some() {
        return Err(
            "this model cannot use an audio track: lip-sync and talking avatars need a cloud provider such as fal or replicate"
                .into(),
        );
    }
    if inputs.duration_s.is_some() {
        return Err("`duration_s` is not a local video field; set `video_frames` and `fps`".into());
    }
    let object = body
        .as_object_mut()
        .ok_or("media request must be a JSON object")?;
    if let Some(first) = inputs.images.first() {
        if !support.first_frame {
            return Err(
                "the active local video model is text-to-video only and cannot start from an image; install a Wan image-to-video or first/last-frame model and select it as the local diffusion model, or choose a cloud provider such as runway, fal or replicate"
                    .into(),
            );
        }
        object.insert("init_image".into(), Value::String(first.clone()));
    }
    if let Some(last) = inputs.images.get(1) {
        if !support.last_frame {
            return Err(
                "the active local video model cannot end on a last frame; install a Wan first/last-frame model (Wan2.1 FLF2V, or the Wan2.2 I2V A14B pair) and select it as the local diffusion model, or choose a cloud provider such as fal or replicate"
                    .into(),
            );
        }
        object.insert("end_image".into(), Value::String(last.clone()));
    }
    Ok(())
}

fn map_cloud_inputs(
    body: &mut Value,
    mut inputs: CanonicalInputs,
    provider: &str,
) -> Result<(), String> {
    let mut provider_input = inputs.provider_input.take().unwrap_or_default();
    let mut used = [false; 5];
    let mut wrapped = Value::Object(std::mem::take(&mut provider_input));
    resolve_references(&mut wrapped, &inputs, &mut used)?;
    let Value::Object(provider_input) = wrapped else {
        unreachable!("provider_input stays an object");
    };

    let object = body
        .as_object_mut()
        .ok_or("media request must be a JSON object")?;
    if provider == "runway" {
        if inputs.video.is_some() || inputs.audio.is_some() {
            return Err(
                "runway accepts only a first-frame image; it cannot take a source video or an audio track"
                    .into(),
            );
        }
        if inputs.images.len() > 1 && !used[1] {
            return Err("runway accepts only a first frame; a last frame is not supported".into());
        }
        if let Some(first) = inputs.images.first().filter(|_| !used[0]) {
            if object.contains_key("promptImage") || provider_input.contains_key("promptImage") {
                return Err("choose `input_images` or `promptImage`, not both".into());
            }
            object.insert(
                "promptImage".into(),
                json!([{ "uri": first, "position": "first" }]),
            );
            used[0] = true;
        }
    }

    let unused = [
        (
            !inputs.images.is_empty() && !used[0],
            "input_images[0]",
            "$input_images.0",
        ),
        (
            inputs.images.len() > 1 && !used[1],
            "input_images[1]",
            "$input_images.1",
        ),
        (
            inputs.video.is_some() && !used[2],
            "input_video",
            "$input_video",
        ),
        (
            inputs.audio.is_some() && !used[3],
            "input_audio",
            "$input_audio",
        ),
        (
            inputs.duration_s.is_some() && !used[4],
            "duration_s",
            "$duration_s",
        ),
    ];
    if let Some((_, field, reference)) = unused.iter().find(|(unused, _, _)| *unused) {
        return Err(format!(
            "{provider} models name their own input fields: map `{field}` in `provider_input`, for example {{\"<model field>\": \"{reference}\"}}"
        ));
    }

    for (key, value) in provider_input {
        if object.contains_key(&key) {
            return Err(format!(
                "`provider_input.{key}` conflicts with a field already in the request"
            ));
        }
        object.insert(key, value);
    }
    Ok(())
}

/// Video dispatch: validate the prompt and provider, map reference inputs for
/// the selected target, then submit a Gateway job (cloud) or run the local
/// engine.
pub async fn generate_video<H: ImageHost + LocalVideoHost>(
    host: &H,
    mut body: Value,
) -> MediaResponse {
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
    if let Err(error) = validate_video_provider(&body) {
        return (400, json!({ "error": error }));
    }
    if let Some(provider) = video_cloud_provider(&body) {
        if let Err(error) = prepare_media_inputs(&mut body, MediaTarget::Cloud(&provider)) {
            return (400, json!({ "error": error }));
        }
        return crate::forward_to_gateway(host, "video", "/v1/videos/generations", &provider, body)
            .await;
    }
    let support = host.local_video_inputs().await;
    if let Err(error) = prepare_media_inputs(&mut body, MediaTarget::Local(support)) {
        return (400, json!({ "error": error }));
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("provider");
    }
    generate_local_video(host, body).await
}

/// Audio-generation dispatch (music, sound effects): validate the prompt, the
/// optional `kind` and the provider, map reference inputs, then submit a
/// Gateway audio job. There is no local music engine, so a request without a
/// supported cloud provider is refused instead of being faked.
pub async fn generate_audio(host: &impl ImageHost, mut body: Value) -> MediaResponse {
    if body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return (
            400,
            json!({ "error": "missing `prompt` (the sound to generate)" }),
        );
    }
    match body.get("kind") {
        None | Some(Value::Null) => {}
        Some(Value::String(kind)) if matches!(kind.as_str(), "music" | "sfx") => {}
        Some(_) => {
            return (
                400,
                json!({ "error": "`kind` must be \"music\" or \"sfx\"" }),
            )
        }
    }
    let Some(provider) = selected_provider(&body, &AUDIO_CLOUD_PROVIDERS) else {
        return (
            400,
            json!({
                "error": "audio generation needs a cloud provider (fal or replicate); there is no local music or sound-effect engine"
            }),
        );
    };
    if body
        .get("model")
        .and_then(Value::as_str)
        .is_none_or(|m| m.trim().is_empty())
    {
        return (
            400,
            json!({ "error": "missing `model` (the audio model id)" }),
        );
    }
    if let Err(error) = prepare_media_inputs(&mut body, MediaTarget::Cloud(&provider)) {
        return (400, json!({ "error": error }));
    }
    if let Some(object) = body.as_object_mut() {
        // `kind` is the caller's own label (provenance), not a provider field.
        object.remove("kind");
    }
    crate::forward_to_gateway(host, "audio", "/v1/audio/generations", &provider, body).await
}

fn job_id(value: &Value) -> Result<Option<String>, &'static str> {
    if value.get("status").is_none() {
        return Ok(None);
    }
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("invalid local video job identifier");
    }
    Ok(Some(id.to_owned()))
}

fn completed(value: &mut Value) -> Result<Option<Value>, String> {
    match value.get("status").and_then(Value::as_str) {
        Some("failed" | "cancelled" | "canceled") => {
            let error = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .unwrap_or("local video generation did not complete");
            Err(error.chars().take(1000).collect())
        }
        Some("completed" | "succeeded") => {
            let result = value
                .get_mut("result")
                .map(Value::take)
                .ok_or("local video job has no result")?;
            let mime = result
                .get("mime_type")
                .and_then(Value::as_str)
                .ok_or("local video result has no media type")?;
            if !["video/webm", "video/mp4", "video/webp", "video/x-msvideo"].contains(&mime) {
                return Err("unsupported local video container".into());
            }
            let data = result
                .get("b64_json")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or("local video job returned no media")?;
            Ok(Some(
                json!({"data":[{"url":format!("data:{mime};base64,{data}"),"mediaType":mime}]}),
            ))
        }
        _ => Ok(None),
    }
}

/// How long a text-to-video local job may run before Core cancels it.
pub const LOCAL_TEXT_VIDEO_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a frame-conditioned local job may run before Core cancels it. Only
/// the 5B/14B Wan image-to-video and first/last-frame models take frames, and
/// they launch with CPU offload (often on the CPU-only engine build), so they
/// get far longer than the 1.3B text-to-video default.
pub const LOCAL_FRAME_VIDEO_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// The wait budget for a mapped local `vid_gen` body.
pub fn local_video_timeout(body: &Value) -> Duration {
    let frames = ["init_image", "end_image"]
        .iter()
        .any(|field| body.get(field).is_some());
    if frames {
        LOCAL_FRAME_VIDEO_TIMEOUT
    } else {
        LOCAL_TEXT_VIDEO_TIMEOUT
    }
}

/// Bridge native async jobs without exposing their engine-local identifiers.
pub async fn generate_local_video(host: &impl ImageHost, mut body: Value) -> MediaResponse {
    crate::take_request_id(&mut body);
    crate::take_project_id(&mut body);
    if let Some(object) = body.as_object_mut() {
        object.entry("video_frames").or_insert(json!(33));
        object.entry("fps").or_insert(json!(16));
        object.entry("output_format").or_insert(json!("webm"));
    }
    let base = host.sd_base_url();
    let client = crate::media_client();
    let mut active_job: Option<String> = None;
    let budget = local_video_timeout(&body);
    let result = tokio::time::timeout(budget, async {
        if let Err(error) = host.start_local_engine().await {
            tracing::debug!(%error, "local video lazy start unavailable");
        }
        let (code, mut value) = crate::proxy(&base, "/sdcpp/v1/vid_gen", body).await;
        if code != 200 {
            return (code, value);
        }
        if let Ok(Some(media)) = completed(&mut value) {
            return (200, media);
        }
        let id = match job_id(&value) {
            Ok(Some(id)) => id,
            Ok(None) => {
                return (
                    502,
                    json!({"error": "local video engine returned no job identifier"}),
                );
            }
            Err(error) => return (502, json!({"error": error})),
        };
        active_job = Some(id.clone());
        loop {
            match completed(&mut value) {
                Ok(Some(media)) => return (200, media),
                Err(error) => return (502, json!({"error": error})),
                Ok(None) => {}
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            let response = match client
                .get(format!("{base}/sdcpp/v1/jobs/{id}"))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    return (
                        502,
                        json!({"error": format!("local video job unavailable ({})", response.status())}),
                    );
                }
                Err(error) => {
                    return (
                        502,
                        json!({"error": format!("local video job poll failed: {error}")}),
                    );
                }
            };
            value = match response.json::<Value>().await {
                Ok(value) => value,
                Err(_) => return (502, json!({"error": "invalid local video job response"})),
            };
            if value.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                return (
                    502,
                    json!({"error": "local video job identity changed"}),
                );
            }
        }
    })
    .await;
    let response = match result {
        Ok(response) => response,
        Err(_) => (
            504,
            json!({"error": format!(
                "local video generation timed out after {} minutes and was cancelled",
                budget.as_secs() / 60
            )}),
        ),
    };
    if response.0 >= 400 {
        if let Some(id) = active_job {
            let _ = client
                .post(format!("{base}/sdcpp/v1/jobs/{id}/cancel"))
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const PNG_A: &str = "data:image/png;base64,aGVsbG8=";
    const PNG_B: &str = "data:image/webp;base64,d29ybGQ=";
    const CLIP: &str = "data:video/mp4;base64,AAAAIGZ0eXA=";
    const VOICE: &str = "data:audio/wav;base64,UklGRg==";

    struct CaptureHost {
        gateway: String,
        local: LocalVideoInputs,
    }

    impl ImageHost for CaptureHost {
        fn sd_base_url(&self) -> String {
            self.gateway.clone()
        }
        fn gateway_url(&self) -> String {
            self.gateway.clone()
        }
        fn gateway_token(&self) -> Option<String> {
            Some("core-token".into())
        }
        fn start_local_engine(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
    }

    impl LocalVideoHost for CaptureHost {
        fn local_video_inputs(
            &self,
        ) -> Pin<Box<dyn Future<Output = LocalVideoInputs> + Send + '_>> {
            let local = self.local;
            Box::pin(async move { local })
        }
    }

    /// Accept one HTTP request, answer `response`, and return the request line,
    /// lowercased header block and JSON body.
    fn capture_one(
        response: &'static str,
    ) -> (String, thread::JoinHandle<(String, String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 8192];
            let (header_end, content_length) = loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "client closed before sending the request");
                request.extend_from_slice(&chunk[..read]);
                let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                    continue;
                };
                let headers = std::str::from_utf8(&request[..end])
                    .unwrap()
                    .to_ascii_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .map(|value| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break (end, length);
                }
            };
            let head = std::str::from_utf8(&request[..header_end])
                .unwrap()
                .to_owned();
            let request_line = head.lines().next().unwrap().to_owned();
            let body =
                serde_json::from_slice(&request[header_end + 4..header_end + 4 + content_length])
                    .unwrap_or(Value::Null);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
            (request_line, head.to_ascii_lowercase(), body)
        });
        (address, handle)
    }

    #[test]
    fn runway_maps_the_first_frame_and_refuses_what_it_cannot_take() {
        let mut body = json!({"prompt":"pan left","input_images":[PNG_A],"ratio":"1280:720"});
        prepare_media_inputs(&mut body, MediaTarget::Cloud("runway")).unwrap();
        assert_eq!(
            body["promptImage"],
            json!([{ "uri": PNG_A, "position": "first" }])
        );
        assert!(body.get("input_images").is_none());

        let mut two = json!({"prompt":"p","input_images":[PNG_A, PNG_B]});
        let error = prepare_media_inputs(&mut two, MediaTarget::Cloud("runway")).unwrap_err();
        assert!(error.contains("last frame is not supported"), "{error}");

        for field in ["input_video", "input_audio"] {
            let value = if field == "input_video" { CLIP } else { VOICE };
            let mut body = json!({"prompt":"p", field: value});
            let error = prepare_media_inputs(&mut body, MediaTarget::Cloud("runway")).unwrap_err();
            assert!(error.contains("only a first-frame image"), "{error}");
        }
    }

    #[test]
    fn queue_providers_receive_inputs_only_through_provider_input_references() {
        let mut body = json!({
            "prompt": "lip-sync the presenter",
            "input_video": CLIP,
            "input_audio": VOICE,
            "input_images": [PNG_A, PNG_B],
            "duration_s": 6,
            "provider_input": {
                "video_url": "$input_video",
                "audio_url": "$input_audio",
                "image_url": "$input_images.0",
                "tail_image_url": "$input_images.1",
                "options": {"seconds": "$duration_s", "sync_mode": "cut_off"},
                "note": "$5 budget is not a reference"
            }
        });
        prepare_media_inputs(&mut body, MediaTarget::Cloud("fal")).unwrap();
        assert_eq!(body["video_url"], CLIP);
        assert_eq!(body["audio_url"], VOICE);
        assert_eq!(body["image_url"], PNG_A);
        assert_eq!(body["tail_image_url"], PNG_B);
        assert_eq!(body["options"]["seconds"], 6);
        assert_eq!(body["note"], "$5 budget is not a reference");
        for canonical in [
            "input_video",
            "input_audio",
            "input_images",
            "duration_s",
            "provider_input",
        ] {
            assert!(
                body.get(canonical).is_none(),
                "{canonical} must not reach the provider"
            );
        }

        // Plain provider_input with remote URLs merges as-is.
        let mut plain = json!({
            "prompt": "restyle",
            "provider_input": {"video_url": "https://media.example.test/in.mp4", "strength": 0.6}
        });
        prepare_media_inputs(&mut plain, MediaTarget::Cloud("replicate")).unwrap();
        assert_eq!(plain["video_url"], "https://media.example.test/in.mp4");
        assert_eq!(plain["strength"], 0.6);
    }

    #[test]
    fn unmapped_or_dangling_inputs_are_refused_not_dropped() {
        let mut unmapped = json!({"prompt":"p","input_video": CLIP});
        let error = prepare_media_inputs(&mut unmapped, MediaTarget::Cloud("fal")).unwrap_err();
        assert!(error.contains("map `input_video`"), "{error}");
        assert!(error.contains("$input_video"), "{error}");

        let mut dangling = json!({"prompt":"p","provider_input":{"audio_url":"$input_audio"}});
        let error = prepare_media_inputs(&mut dangling, MediaTarget::Cloud("fal")).unwrap_err();
        assert!(error.contains("no such input"), "{error}");

        let mut unknown = json!({"prompt":"p","provider_input":{"x":"$input_mask"}});
        let error = prepare_media_inputs(&mut unknown, MediaTarget::Cloud("fal")).unwrap_err();
        assert!(error.contains("unknown reference"), "{error}");
    }

    #[test]
    fn a_canonical_input_cannot_be_referenced_more_than_once() {
        // Repeating a reference would clone the full media value per
        // occurrence; it is refused before any copy is made.
        let repeated: Vec<Value> = (0..2000).map(|_| json!("$input_video")).collect();
        let mut fan_out = json!({
            "prompt": "p",
            "input_video": CLIP,
            "provider_input": {"a": repeated}
        });
        let error = prepare_media_inputs(&mut fan_out, MediaTarget::Cloud("fal")).unwrap_err();
        assert!(error.contains("more than once"), "{error}");

        let mut nested = json!({
            "prompt": "p",
            "input_video": CLIP,
            "provider_input": {"video_url": "$input_video", "options": {"src": "$input_video"}}
        });
        let error = prepare_media_inputs(&mut nested, MediaTarget::Cloud("replicate")).unwrap_err();
        assert!(error.contains("`$input_video` more than once"), "{error}");

        let mut duration = json!({
            "prompt": "p",
            "duration_s": 4,
            "provider_input": {"duration": "$duration_s", "seconds": "$duration_s"}
        });
        assert!(prepare_media_inputs(&mut duration, MediaTarget::Cloud("fal")).is_err());

        // Distinct inputs, each referenced once, still map.
        let mut distinct = json!({
            "prompt": "p",
            "input_images": [PNG_A, PNG_B],
            "provider_input": {"first": "$input_images.0", "last": "$input_images.1"}
        });
        prepare_media_inputs(&mut distinct, MediaTarget::Cloud("fal")).unwrap();
        assert_eq!(distinct["first"], PNG_A);
        assert_eq!(distinct["last"], PNG_B);
    }

    #[test]
    fn jpg_alias_frames_are_normalized_to_the_registered_jpeg_type() {
        let mut body = json!({"prompt":"p","input_images":["data:IMAGE/JPG;base64,/9j/4AAQ"]});
        prepare_media_inputs(&mut body, MediaTarget::Cloud("runway")).unwrap();
        assert_eq!(
            body["promptImage"][0]["uri"],
            "data:image/jpeg;base64,/9j/4AAQ"
        );
        let mut local = json!({"prompt":"p","input_images":["data:image/jpg;base64,/9j/4AAQ"]});
        prepare_media_inputs(
            &mut local,
            MediaTarget::Local(LocalVideoInputs {
                first_frame: true,
                last_frame: false,
            }),
        )
        .unwrap();
        assert_eq!(local["init_image"], "data:image/jpeg;base64,/9j/4AAQ");
    }

    #[test]
    fn openrouter_is_refused_for_video_with_a_clear_reason() {
        let error = validate_video_provider(&json!({"provider":"OpenRouter"})).unwrap_err();
        assert!(error.contains("does not run video jobs"), "{error}");
        assert_eq!(
            video_cloud_provider(&json!({"provider":"openrouter"})),
            None
        );
    }

    #[test]
    fn provider_input_cannot_override_routing_or_existing_fields() {
        for key in [
            "model",
            "provider",
            "prompt",
            "request_id",
            "n",
            "project_id",
            "input_video",
        ] {
            let mut body = json!({"prompt":"p","provider_input":{ key: "x" }});
            let error = prepare_media_inputs(&mut body, MediaTarget::Cloud("fal")).unwrap_err();
            assert!(
                error.contains(&format!("cannot set `{key}`")),
                "{key}: {error}"
            );
        }
        let mut collision = json!({"prompt":"p","ratio":"16:9","provider_input":{"ratio":"9:16"}});
        let error = prepare_media_inputs(&mut collision, MediaTarget::Cloud("fal")).unwrap_err();
        assert!(error.contains("conflicts"), "{error}");
        let mut not_object = json!({"prompt":"p","provider_input":["video_url"]});
        assert!(prepare_media_inputs(&mut not_object, MediaTarget::Cloud("fal")).is_err());
    }

    #[test]
    fn invalid_reference_media_is_refused() {
        let cases = [
            json!({"prompt":"p","input_images":[PNG_A, PNG_B, PNG_A]}),
            json!({"prompt":"p","input_images":["data:image/svg+xml;base64,PHN2Zz4="]}),
            json!({"prompt":"p","input_images":["data:image/png;base64,"]}),
            json!({"prompt":"p","input_images":["http://insecure.example/a.png"]}),
            json!({"prompt":"p","input_video": VOICE}),
            json!({"prompt":"p","input_audio": CLIP}),
            json!({"prompt":"p","input_audio": "data:audio/wav,raw"}),
            json!({"prompt":"p","duration_s": -1}),
        ];
        for mut body in cases {
            let snapshot = body.clone();
            assert!(
                prepare_media_inputs(&mut body, MediaTarget::Cloud("fal")).is_err(),
                "{snapshot}"
            );
        }
    }

    #[test]
    fn local_engine_maps_frames_only_for_capable_models_and_refuses_the_rest() {
        let t2v = LocalVideoInputs::default();
        let i2v = LocalVideoInputs {
            first_frame: true,
            last_frame: false,
        };
        let flf2v = LocalVideoInputs {
            first_frame: true,
            last_frame: true,
        };

        let mut body = json!({"prompt":"p","input_images":[PNG_A]});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(t2v)).unwrap_err();
        assert!(error.contains("text-to-video only"), "{error}");

        let mut body = json!({"prompt":"p","input_images":[PNG_A]});
        prepare_media_inputs(&mut body, MediaTarget::Local(i2v)).unwrap();
        assert_eq!(body["init_image"], PNG_A);
        assert!(body.get("end_image").is_none());

        let mut body = json!({"prompt":"p","input_images":[PNG_A, PNG_B]});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(i2v)).unwrap_err();
        assert!(error.contains("last frame"), "{error}");

        let mut body = json!({"prompt":"p","input_images":[PNG_A, PNG_B]});
        prepare_media_inputs(&mut body, MediaTarget::Local(flf2v)).unwrap();
        assert_eq!(body["init_image"], PNG_A);
        assert_eq!(body["end_image"], PNG_B);

        let mut body = json!({"prompt":"p","input_video": CLIP});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(flf2v)).unwrap_err();
        assert!(error.contains("this model cannot edit video"), "{error}");

        let mut body = json!({"prompt":"p","input_audio": VOICE});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(flf2v)).unwrap_err();
        assert!(error.contains("cannot use an audio track"), "{error}");

        let mut body = json!({"prompt":"p","provider_input":{"strength":1}});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(flf2v)).unwrap_err();
        assert!(error.contains("cloud providers only"), "{error}");

        // The local engine never fetches a caller-controlled URL.
        let mut body = json!({"prompt":"p","input_images":["https://media.example.test/a.png"]});
        let error = prepare_media_inputs(&mut body, MediaTarget::Local(flf2v)).unwrap_err();
        assert!(error.contains("inline base64"), "{error}");
    }

    #[tokio::test]
    async fn cloud_video_reaches_the_gateway_with_mapped_inputs_and_slot_header() {
        let (gateway, server) = capture_one(r#"{"id":"job-1","status":"queued"}"#);
        let host = CaptureHost {
            gateway,
            local: LocalVideoInputs::default(),
        };
        let (status, response) = generate_video(
            &host,
            json!({
                "prompt": "make it rain",
                "provider": "Fal",
                "model": "fal-ai/wan-vace",
                "request_id": "gen-7",
                "input_video": CLIP,
                "provider_input": {"video_url": "$input_video"}
            }),
        )
        .await;
        let (line, headers, body) = server.join().unwrap();
        assert_eq!(status, 200);
        assert_eq!(response["id"], "job-1");
        assert!(line.starts_with("POST /v1/videos/generations "), "{line}");
        assert!(
            headers.contains("x-ryu-slot-video-provider: fal"),
            "{headers}"
        );
        assert!(headers.contains("x-ryu-request-id: gen-7"), "{headers}");
        assert_eq!(body["video_url"], CLIP);
        assert_eq!(body["model"], "fal-ai/wan-vace");
        assert!(body.get("input_video").is_none());
        assert!(body.get("request_id").is_none());
    }

    #[test]
    fn frame_conditioned_local_jobs_get_the_longer_wait_budget() {
        assert_eq!(
            local_video_timeout(&json!({"prompt": "p"})),
            LOCAL_TEXT_VIDEO_TIMEOUT
        );
        for body in [
            json!({"prompt": "p", "init_image": PNG_A}),
            json!({"prompt": "p", "init_image": PNG_A, "end_image": PNG_B}),
        ] {
            assert_eq!(local_video_timeout(&body), LOCAL_FRAME_VIDEO_TIMEOUT);
        }
        assert_eq!(LOCAL_TEXT_VIDEO_TIMEOUT.as_secs(), 600);
        assert_eq!(LOCAL_FRAME_VIDEO_TIMEOUT.as_secs(), 3600);
    }

    #[tokio::test]
    async fn local_video_refusals_happen_before_any_engine_call() {
        // No listener: a refusal must not depend on reaching the engine.
        let host = CaptureHost {
            gateway: "http://127.0.0.1:1".into(),
            local: LocalVideoInputs::default(),
        };
        let (status, body) = generate_video(&host, json!({"prompt":"p","input_video": CLIP})).await;
        assert_eq!(status, 400);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("this model cannot edit video"));
        let (status, body) =
            generate_video(&host, json!({"prompt":"p","provider":"midjourney"})).await;
        assert_eq!(status, 400);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("unsupported video provider"));
    }

    #[tokio::test]
    async fn local_first_last_frame_request_reaches_vid_gen_as_init_and_end_images() {
        let (engine, server) = capture_one(
            r#"{"id":"job_1","status":"completed","result":{"mime_type":"video/webm","b64_json":"YWJj"}}"#,
        );
        let host = CaptureHost {
            gateway: engine,
            local: LocalVideoInputs {
                first_frame: true,
                last_frame: true,
            },
        };
        let (status, response) = generate_video(
            &host,
            json!({
                "prompt": "glass flower blossom",
                "provider": "local",
                "request_id": "gen-9",
                "project_id": "project-1",
                "input_images": [PNG_A, PNG_B]
            }),
        )
        .await;
        let (line, _headers, body) = server.join().unwrap();
        assert_eq!(status, 200, "{response}");
        assert_eq!(response["data"][0]["url"], "data:video/webm;base64,YWJj");
        assert!(line.starts_with("POST /sdcpp/v1/vid_gen "), "{line}");
        assert_eq!(body["init_image"], PNG_A);
        assert_eq!(body["end_image"], PNG_B);
        assert_eq!(body["prompt"], "glass flower blossom");
        assert_eq!(body["video_frames"], 33);
        assert_eq!(body["fps"], 16);
        for routed in ["input_images", "provider", "request_id", "project_id"] {
            assert!(body.get(routed).is_none(), "{routed} leaked: {body}");
        }
    }

    #[tokio::test]
    async fn audio_jobs_go_to_the_audio_route_and_need_a_cloud_provider() {
        let (gateway, server) = capture_one(r#"{"id":"job-a","status":"queued"}"#);
        let host = CaptureHost {
            gateway,
            local: LocalVideoInputs::default(),
        };
        let (status, response) = generate_audio(
            &host,
            json!({
                "prompt": "rain on a tin roof",
                "provider": "replicate",
                "model": "meta/musicgen",
                "kind": "sfx",
                "duration_s": 8,
                "provider_input": {"duration": "$duration_s"}
            }),
        )
        .await;
        let (line, headers, body) = server.join().unwrap();
        assert_eq!(status, 200);
        assert_eq!(response["id"], "job-a");
        assert!(line.starts_with("POST /v1/audio/generations "), "{line}");
        assert!(
            headers.contains("x-ryu-slot-audio-provider: replicate"),
            "{headers}"
        );
        assert_eq!(body["duration"], 8);
        assert!(body.get("kind").is_none());
        assert!(body.get("duration_s").is_none());

        let refusals = [
            (json!({"prompt":"p","model":"m"}), "needs a cloud provider"),
            (
                json!({"prompt":"p","model":"m","provider":"local"}),
                "needs a cloud provider",
            ),
            (
                json!({"prompt":"p","model":"m","provider":"runway"}),
                "needs a cloud provider",
            ),
            (json!({"prompt":"p","provider":"fal"}), "missing `model`"),
            (
                json!({"prompt":" ","provider":"fal","model":"m"}),
                "missing `prompt`",
            ),
            (
                json!({"prompt":"p","provider":"fal","model":"m","kind":"speech"}),
                "`kind`",
            ),
            (
                json!({"prompt":"p","provider":"fal","model":"m","duration_s":5}),
                "map `duration_s`",
            ),
        ];
        for (body, needle) in refusals {
            let (status, response) = generate_audio(&host, body.clone()).await;
            assert_eq!(status, 400, "{body}");
            assert!(
                response["error"].as_str().unwrap().contains(needle),
                "{body}: {response}"
            );
        }
    }
    #[test]
    fn local_job_contract_preserves_container_type_and_rejects_path_ids() {
        assert!(job_id(&json!({"id":"../../other","status":"queued"})).is_err());
        assert_eq!(
            job_id(&json!({"id":"job_123","status":"queued"})).unwrap(),
            Some("job_123".into())
        );
        let result = completed(&mut json!({
            "status": "completed",
            "result": {"mime_type": "video/webm", "b64_json": "YWJj"}
        }))
        .unwrap()
        .unwrap();
        assert_eq!(result["data"][0]["url"], "data:video/webm;base64,YWJj");
        assert!(result.get("id").is_none());
        assert!(
            completed(&mut json!({"status":"cancelled","error":{"message":"Stopped"}})).is_err()
        );
        assert!(completed(
            &mut json!({"status":"completed","result":{"mime_type":"text/html","b64_json":"YWJj"}})
        )
        .is_err());
        assert!(completed(
            &mut json!({"status":"completed","result":{"mime_type":"video/webp","b64_json":"YWJj"}})
        )
        .is_ok());
    }
}
