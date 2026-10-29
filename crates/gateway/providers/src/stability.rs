//! Direct Stability image generation using its multipart v2beta API.
use crate::{
    account_pool::AccountPool, egress::send_with_egress, error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, EgressClientPool, Provider, ProviderError, ProviderQuotas,
};
use axum::body::Body;
use base64::Engine;
use serde_json::{json, Value};
use std::{pin::Pin, sync::Arc};

pub const MODELS: &[&str] = &[
    "stable-image-ultra",
    "stable-image-core",
    "sd3.5-large",
    "sd3.5-large-turbo",
    "sd3.5-medium",
    "sd3.5-flash",
];
const ASPECTS: &[&str] = &[
    "16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21",
];
const STYLES: &[&str] = &[
    "3d-model",
    "analog-film",
    "anime",
    "cinematic",
    "comic-book",
    "digital-art",
    "enhance",
    "fantasy-art",
    "isometric",
    "line-art",
    "low-poly",
    "modeling-compound",
    "neon-punk",
    "origami",
    "photographic",
    "pixel-art",
    "tile-texture",
];

pub struct StabilityProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}
impl StabilityProvider {
    pub fn new(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            quota,
        }
    }
    fn request_fields(
        model: &str,
        body: &Value,
    ) -> Result<(String, String, Vec<(String, String)>), ProviderError> {
        let invalid = |message: &str| ProviderError::Provider(format!("Stability: {message}"));
        let endpoint = match model {
            "stable-image-ultra" => "ultra",
            "stable-image-core" => "core",
            model if MODELS.contains(&model) => "sd3",
            _ => return Err(invalid("unsupported image model")),
        };
        let prompt = body["prompt"]
            .as_str()
            .filter(|p| !p.trim().is_empty() && p.chars().count() <= 10000)
            .ok_or_else(|| invalid("prompt must contain 1–10000 characters"))?;
        if body
            .get("n")
            .is_some_and(|n| !n.is_null() && n.as_u64() != Some(1))
        {
            return Err(invalid("this endpoint produces one image; n must be 1"));
        }
        if body
            .get("response_format")
            .is_some_and(|f| !f.is_null() && f.as_str() != Some("b64_json"))
        {
            return Err(invalid(
                "Stability generation returns b64_json through Gateway",
            ));
        }
        if ["image", "image_url", "mask", "mask_url", "strength"]
            .iter()
            .any(|key| body.get(*key).is_some())
            || body
                .get("mode")
                .is_some_and(|m| m.as_str() != Some("text-to-image"))
        {
            return Err(invalid("this adapter accepts text-to-image generation"));
        }
        let output = body
            .get("output_format")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| invalid("output_format must be text"))
            })
            .transpose()?
            .unwrap_or("png");
        let mime = match output {
            "png" => "image/png",
            "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => return Err(invalid("output_format must be png, jpeg or webp")),
        };
        let mut fields = vec![
            ("prompt".to_owned(), prompt.to_owned()),
            ("output_format".to_owned(), output.to_owned()),
        ];
        if endpoint == "sd3" {
            fields.push(("model".into(), model.into()));
            fields.push(("mode".into(), "text-to-image".into()));
        }
        let size_aspect = match body.get("size").filter(|v| !v.is_null()) {
            None => None,
            Some(Value::String(size)) => Some(match size.as_str() {
                "1024x1024" => "1:1",
                "1536x1024" => "3:2",
                "1024x1536" => "2:3",
                _ => {
                    return Err(invalid(
                        "use a supported aspect_ratio or size 1024x1024, 1536x1024, 1024x1536",
                    ))
                }
            }),
            Some(_) => return Err(invalid("size must be text")),
        };
        let aspect = body
            .get("aspect_ratio")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| invalid("aspect_ratio must be text"))
            })
            .transpose()?
            .or(size_aspect)
            .unwrap_or("1:1");
        if !ASPECTS.contains(&aspect) || size_aspect.is_some_and(|size| size != aspect) {
            return Err(invalid(
                "aspect_ratio is unsupported or conflicts with size",
            ));
        }
        fields.push(("aspect_ratio".into(), aspect.into()));
        if let Some(value) = body.get("negative_prompt").filter(|v| !v.is_null()) {
            let text = value
                .as_str()
                .filter(|v| v.chars().count() <= 10000)
                .ok_or_else(|| invalid("negative_prompt must contain at most 10000 characters"))?;
            fields.push(("negative_prompt".into(), text.into()));
        }
        if let Some(value) = body.get("seed").filter(|v| !v.is_null()) {
            let seed = value
                .as_u64()
                .filter(|seed| *seed <= 4294967294)
                .ok_or_else(|| invalid("seed must be an integer from 0 to 4294967294"))?;
            fields.push(("seed".into(), seed.to_string()));
        }
        if let Some(value) = body.get("style_preset").filter(|v| !v.is_null()) {
            let style = value
                .as_str()
                .filter(|s| STYLES.contains(s))
                .ok_or_else(|| invalid("unsupported style_preset"))?;
            if endpoint == "ultra" {
                return Err(invalid("style_preset is supported by Core and SD3.5"));
            }
            fields.push(("style_preset".into(), style.into()));
        }
        if let Some(value) = body.get("cfg_scale").filter(|v| !v.is_null()) {
            let scale = value
                .as_f64()
                .filter(|v| (1.0..=10.0).contains(v))
                .ok_or_else(|| invalid("cfg_scale must be between 1 and 10"))?;
            if endpoint != "sd3" {
                return Err(invalid("cfg_scale is supported by SD3.5"));
            }
            fields.push(("cfg_scale".into(), scale.to_string()));
        }
        Ok((endpoint.into(), mime.into(), fields))
    }
    async fn generate(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let (endpoint, mime, fields) = Self::request_fields(model, body)?;
        let url = format!(
            "{}/stable-image/generate/{endpoint}",
            self.base_url.trim_end_matches('/')
        );
        let mut last_error = None;
        for index in self.accounts.candidates(None) {
            let mut response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "stability",
                0,
                |client| {
                    let mut form = reqwest::multipart::Form::new();
                    for (name, value) in &fields {
                        form = form.text(name.clone(), value.clone());
                    }
                    client
                        .post(&url)
                        .bearer_auth(&self.keys[index])
                        .header("accept", "image/*")
                        .multipart(form)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|l| l.retry_after);
                let reset_at = limits.as_ref().and_then(|l| l.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                last_error = Some(ProviderError::RateLimited {
                    provider: "stability".into(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last_error = Some(ProviderError::PaymentRequired {
                    provider: "stability".into(),
                    message: "Stability account credits are required".into(),
                });
                continue;
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("Stability image request returned HTTP {}", status.as_u16()),
                ));
            }
            let uncertain = |message: &str| {
                ProviderError::DeliveryUncertain(format!(
                    "Stability accepted image generation: {message}"
                ))
            };
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                .unwrap_or("");
            if content_type != mime {
                return Err(uncertain("unexpected image content type"));
            }
            if response
                .headers()
                .get("finish-reason")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|reason| reason != "SUCCESS")
            {
                return Err(uncertain("generation did not return a successful image"));
            }
            let mut bytes = Vec::new();
            const MAX_IMAGE: usize = 32 * 1024 * 1024;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| uncertain("image response could not be read"))?
            {
                if chunk.len() > MAX_IMAGE.saturating_sub(bytes.len()) {
                    return Err(uncertain("image exceeds the Gateway limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let valid = match mime.as_str() {
                "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
                "image/webp" => {
                    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
                }
                _ => false,
            };
            if !valid {
                return Err(uncertain("response has an invalid image signature"));
            }
            self.accounts.record_success(None, index);
            if let Some(limits) = limits.as_ref() {
                self.quota.record_success("stability", limits);
            }
            return Ok(
                json!({"created":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|v|v.as_secs()).unwrap_or(0),"data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(bytes)}]}),
            );
        }
        if let Some(ProviderError::RateLimited {
            retry_after,
            reset_at,
            ..
        }) = &last_error
        {
            self.quota
                .record_rate_limited("stability", *retry_after, *reset_at);
        }
        Err(last_error
            .unwrap_or_else(|| ProviderError::Provider("No eligible Stability accounts".into())))
    }
}
impl Provider for StabilityProvider {
    fn name(&self) -> &'static str {
        "stability"
    }
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }
    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|p| p.len() > 1)
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async {
            Some(MODELS.iter().map(|m|json!({"id":m,"object":"model","owned_by":"stability","modality":"image"})).collect())
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Stability is an image provider".into(),
            ))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Stability does not stream chat".into(),
            ))
        })
    }
    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.generate(model, body))
    }
}

#[cfg(test)]
#[path = "stability_test.rs"]
mod tests;
