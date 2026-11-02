//! Guard model on a local engine (`kind = "guard_model"`, screener addendum
//! section 4.1).
//!
//! Speaks OpenAI-compatible `POST {base_url}/chat/completions` to llama-server
//! or vLLM. Ryu never injects its own policy text: the engine applies the
//! guard GGUF's own chat template, which carries the category list, and
//! `template_version` records the pinned template. Two output dialects:
//!
//! - **Llama Guard** (3 and 4, MLCommons numbering): `safe`, or `unsafe` and a
//!   comma list of `S1` to `S14`.
//! - **Qwen3Guard-Gen**: `Safety: Safe|Unsafe|Controversial`, `Categories: ...`,
//!   and on responses `Refusal: Yes|No`. Labels map through
//!   `taxonomy.json` `vendorMappings.qwen3guard`; it never covers S4.
//!
//! Scores are hazard probabilities. With logprobs, `p_unsafe` is the
//! probability of the first non-blank generated token being the unsafe
//! branch; without them, confidence is `Fixed`.

use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::backend::{
    elapsed_ms, BackendDescriptor, BackendError, BackendHealth, BackendKind, BackendRef,
    BackendVerdict, CodeSet, ConfidenceSource, Direction, ItemVerdict, Locality, ModelSignal,
    ScreenItem, ScreenRequest, ScreenerBackend, TaxonomyId,
};
use crate::safety_client::{Endpoint, EndpointError, SafetyClient};
use crate::template_tokens::neutralize_template_tokens;
use ryu_gw_firewall::taxonomy::taxonomy;

/// Score for a listed code when the engine returns no logprobs.
pub const FIXED_UNSAFE: f32 = 0.95;
/// Qwen3Guard's controversial band (spec 02.6.1 sends it to T3).
pub const CONTROVERSIAL: f32 = 0.6;

/// Which output grammar the guard model speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardDialect {
    LlamaGuard,
    Qwen3Guard,
}

impl GuardDialect {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "llama_guard" => Some(Self::LlamaGuard),
            "qwen3guard" => Some(Self::Qwen3Guard),
            _ => None,
        }
    }

    /// Codes the dialect can positively detect.
    pub fn covers(self) -> CodeSet {
        match self {
            GuardDialect::LlamaGuard => CodeSet::hazards(),
            GuardDialect::Qwen3Guard => taxonomy()
                .vendor_mapping("qwen3guard")
                .map(|labels| {
                    labels
                        .flat_map(|(_, codes)| codes.iter().copied())
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn max_tokens(self) -> u32 {
        match self {
            GuardDialect::LlamaGuard => 24,
            GuardDialect::Qwen3Guard => 64,
        }
    }
}

/// A parsed guard answer for one item.
#[derive(Debug, Clone, PartialEq)]
pub struct GuardAnswer {
    pub scores: Vec<(TaxonomyId, f32)>,
    pub covered: CodeSet,
    pub model_signal: ModelSignal,
    pub confidence: ConfidenceSource,
}

mod parse;
pub use parse::{parse_llama_guard, parse_qwen3guard};

/// Configuration for one guard backend (section 5.2 `[screening.backends.*]`).
#[derive(Debug, Clone)]
pub struct GuardModelConfig {
    pub id: String,
    /// OpenAI-compatible base, for example `http://screener:8092/v1`.
    pub base_url: String,
    pub locality: Locality,
    pub model: String,
    pub weights_sha256: Option<String>,
    pub template_version: u32,
    pub dialect: GuardDialect,
    pub images: bool,
    /// A static bearer, private network only.
    pub bearer: Option<String>,
    pub hard_timeout_ms: u32,
    pub max_concurrency: usize,
}

/// A guard model reached through its own `SafetyClient`.
pub struct GuardModelBackend {
    descriptor: BackendDescriptor,
    client: SafetyClient,
    dialect: GuardDialect,
}

impl GuardModelBackend {
    pub fn new(config: GuardModelConfig) -> Result<Self, EndpointError> {
        let endpoint = Endpoint::local(&config.base_url, config.locality.clone())?;
        let client = SafetyClient::new(endpoint, config.bearer)?;
        Ok(Self {
            descriptor: BackendDescriptor {
                reference: BackendRef {
                    id: config.id,
                    kind: BackendKind::GuardModel,
                    model: config.model,
                    weights_sha256: config.weights_sha256,
                    template_version: config.template_version,
                },
                locality: config.locality,
                text: true,
                images: config.images,
                covers: config.dialect.covers(),
                max_batch: 1,
                max_item_tokens: 2048,
                hard_timeout_ms: config.hard_timeout_ms,
                max_concurrency: config.max_concurrency.max(1),
            },
            client,
            dialect: config.dialect,
        })
    }

    pub fn dialect(&self) -> GuardDialect {
        self.dialect
    }

    /// Message content: a plain string for text, or an image part (the exact
    /// bytes as a data URL) followed by the text when there is any.
    fn content(item: &ScreenItem, text: String) -> Value {
        match &item.image {
            Some(image) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
                let mut parts = vec![json!({
                    "type": "image_url",
                    "image_url": {"url": format!("data:{};base64,{data}", image.mime)},
                })];
                if !text.is_empty() {
                    parts.push(json!({"type": "text", "text": text}));
                }
                Value::Array(parts)
            }
            None => Value::String(text),
        }
    }

    /// The chat body. The text and context are attacker-controlled, so their
    /// chat-template control tokens are neutralised first: the engine renders
    /// the guard's own template and parses special tokens out of it, and a
    /// literal `<|im_end|><|im_start|>assistant` would otherwise forge a
    /// finished turn with a fake `safe` verdict.
    pub(crate) fn body(&self, direction: Direction, item: &ScreenItem) -> Value {
        let text = neutralize_template_tokens(item.text.as_deref().unwrap_or(""));
        let context = neutralize_template_tokens(item.context.as_deref().unwrap_or(""));
        let messages = if direction.is_output() {
            // Response classification: the prior user turn, then the window.
            // A generated image (section 9 rule 3) rides in the assistant
            // turn, so the guard sees the exact bytes that would be returned.
            json!([
                {"role": "user", "content": context.as_ref()},
                {"role": "assistant", "content": Self::content(item, text.into_owned())},
            ])
        } else {
            let joined = if context.is_empty() {
                text.into_owned()
            } else {
                format!("{context}\n\n{text}")
            };
            json!([{"role": "user", "content": Self::content(item, joined)}])
        };
        json!({
            "model": self.descriptor.reference.model,
            "temperature": 0,
            "max_tokens": self.dialect.max_tokens(),
            "stream": false,
            "logprobs": true,
            "top_logprobs": 5,
            "messages": messages,
        })
    }

    fn parse(&self, response: &Value) -> Result<GuardAnswer, BackendError> {
        let choice = response
            .get("choices")
            .and_then(|c| c.get(0))
            .ok_or(BackendError::Malformed)?;
        let content = choice
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .ok_or(BackendError::Malformed)?;
        let logprobs = choice.get("logprobs").filter(|l| !l.is_null());
        match self.dialect {
            GuardDialect::LlamaGuard => parse_llama_guard(content, logprobs),
            GuardDialect::Qwen3Guard => parse_qwen3guard(content, logprobs),
        }
    }

    async fn screen_one(
        &self,
        req: &ScreenRequest<'_>,
        item: &ScreenItem,
        timeout: Duration,
    ) -> Result<ItemVerdict, BackendError> {
        if item.image.is_some() && !self.descriptor.images {
            return Err(BackendError::Unavailable("images_unsupported"));
        }
        let response = self
            .client
            .post_json(
                "chat/completions",
                &self.body(req.direction, item),
                Some(req.correlation_id),
                timeout,
            )
            .await?;
        let answer = self.parse(&response)?;
        Ok(ItemVerdict {
            key: item.key,
            scores: answer.scores,
            covered: answer.covered,
            model_signal: answer.model_signal,
            confidence: answer.confidence,
        })
    }
}

#[async_trait::async_trait]
impl ScreenerBackend for GuardModelBackend {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.descriptor
    }

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError> {
        let started = Instant::now();
        let timeout = Duration::from_millis(u64::from(self.descriptor.hard_timeout_ms))
            .min(req.deadline.saturating_duration_since(started));
        let mut items = Vec::with_capacity(req.items.len());
        for item in req.items {
            items.push(self.screen_one(req, item, timeout).await?);
        }
        Ok(BackendVerdict {
            backend: self.descriptor.reference.clone(),
            items,
            latency_ms: elapsed_ms(started),
        })
    }

    /// `GET {base}/models` must serve the configured id, then a fixed
    /// sentinel-free canary must parse.
    async fn probe(&self) -> BackendHealth {
        let timeout = Duration::from_millis(u64::from(self.descriptor.hard_timeout_ms).max(1_000));
        let models = match self.client.get_json("models", timeout).await {
            Ok(models) => models,
            Err(_) => return BackendHealth::Down("models_unreachable"),
        };
        let served = models
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|m| {
                m.get("id").and_then(Value::as_str)
                    == Some(self.descriptor.reference.model.as_str())
            });
        if !served {
            return BackendHealth::Down("model_not_served");
        }
        let canary = ScreenItem::text(
            crate::cache::SegmentKey([0; 32]),
            crate::backend::LeafClass::User,
            "Hello. What is the capital of France?",
        );
        let wanted = CodeSet::new();
        let items = [canary];
        let req = ScreenRequest {
            correlation_id: "probe",
            direction: Direction::Inbound,
            tier: crate::backend::ScreenTier::Node,
            items: &items,
            wanted: &wanted,
            deadline: Instant::now() + timeout,
        };
        match self.screen(&req).await {
            Ok(_) => BackendHealth::Ready,
            Err(BackendError::Malformed) => BackendHealth::Down("canary_malformed"),
            Err(_) => BackendHealth::Down("canary_failed"),
        }
    }
}

#[cfg(test)]
mod tests;
