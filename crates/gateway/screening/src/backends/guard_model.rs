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
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::backend::{
    checked_score, elapsed_ms, BackendDescriptor, BackendError, BackendHealth, BackendKind,
    BackendRef, BackendVerdict, CodeSet, ConfidenceSource, Direction, ItemVerdict, Locality,
    ModelSignal, ScreenItem, ScreenRequest, ScreenerBackend, TaxonomyId,
};
use crate::safety_client::{Endpoint, EndpointError, SafetyClient};
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

fn llama_guard_grammar() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(safe|unsafe)\n?(S([1-9]|1[0-4])(,\s?S([1-9]|1[0-4]))*)?\s*$")
            .expect("valid regex")
    })
}

/// The first non-blank generated token, from an OpenAI-style
/// `choices[0].logprobs` object, with its top alternatives (the generated
/// token included when it carries a logprob).
struct FirstToken {
    generated: String,
    alternatives: Vec<(String, f64)>,
}

fn first_token(logprobs: Option<&Value>) -> Option<FirstToken> {
    let content = logprobs?.get("content")?.as_array()?;
    let entry = content.iter().find(|e| {
        e.get("token")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty())
    })?;
    let generated = entry
        .get("token")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    let mut out = Vec::new();
    if let Some(lp) = entry.get("logprob").and_then(Value::as_f64) {
        out.push((generated.clone(), lp));
    }
    for alt in entry
        .get("top_logprobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let (Some(token), Some(lp)) = (
            alt.get("token").and_then(Value::as_str),
            alt.get("logprob").and_then(Value::as_f64),
        ) {
            out.push((token.trim().to_string(), lp));
        }
    }
    Some(FirstToken {
        generated,
        alternatives: out,
    })
}

/// A token on the `unsafe` branch: `unsafe` or a proper prefix of it that is
/// not also a prefix of `safe` (such as `un`).
fn is_unsafe_token(token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    !t.is_empty() && "unsafe".starts_with(&t) && !"safe".starts_with(&t)
}

/// A token on the `safe` branch: `safe` or a prefix of it.
fn is_safe_token(token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    !t.is_empty() && "safe".starts_with(&t)
}

/// `p_unsafe` from the first token: the probability of an unsafe-branch
/// token (see [`is_unsafe_token`]), else `1 - p(safe)`.
///
/// - `Ok(None)` makes the caller fall back to `Fixed` confidence: there are no
///   logprobs, or the generated token is on neither branch.
/// - `Err(Malformed)` when the generated token is on the opposite branch from
///   the reply (an `unsafe` reply whose first token is `safe`, or the
///   reverse). The engine contradicts itself, so it is treated as down (spec
///   02.9) and hard codes stay undecided. Trusting either side would let a
///   broken engine read as a confident allow: `unsafe` plus `S9` scoring S9 at
///   0, or a `safe` reply falling back to a fixed 0 on every code.
fn p_unsafe(logprobs: Option<&Value>, reply_unsafe: bool) -> Result<Option<f64>, BackendError> {
    let Some(first) = first_token(logprobs) else {
        return Ok(None);
    };
    let opposite = if reply_unsafe {
        is_safe_token(&first.generated)
    } else {
        is_unsafe_token(&first.generated)
    };
    if opposite {
        return Err(BackendError::Malformed);
    }
    let on_branch = if reply_unsafe {
        is_unsafe_token(&first.generated)
    } else {
        is_safe_token(&first.generated)
    };
    if !on_branch {
        return Ok(None);
    }
    let prob = |lp: f64| lp.exp().clamp(0.0, 1.0);
    let unsafe_branch = first
        .alternatives
        .iter()
        .filter(|(t, _)| is_unsafe_token(t))
        .map(|(_, lp)| prob(*lp))
        .reduce(f64::max);
    if let Some(p) = unsafe_branch {
        return Ok(p.is_finite().then_some(p));
    }
    Ok(first
        .alternatives
        .iter()
        .filter(|(t, _)| is_safe_token(t))
        .map(|(_, lp)| 1.0 - prob(*lp))
        .reduce(f64::min)
        .filter(|p| p.is_finite()))
}

/// Parse a Llama Guard reply (SB-1, SB-2).
///
/// Scores are hazard probabilities:
/// - `safe`: every covered code scores `p_unsafe` (0 with `Fixed` confidence);
/// - `unsafe`: each listed code scores `p_unsafe` (0.95 with `Fixed`), and every
///   unlisted code scores 0.
///
/// Anything outside the grammar, an `unsafe` with no codes, a code outside S1
/// to S14, codes after `safe`, or logprobs whose first generated token is on
/// the opposite branch from the reply is `Malformed`.
pub fn parse_llama_guard(
    content: &str,
    logprobs: Option<&Value>,
) -> Result<GuardAnswer, BackendError> {
    let trimmed = content.trim();
    let caps = llama_guard_grammar()
        .captures(trimmed)
        .ok_or(BackendError::Malformed)?;
    let is_unsafe = &caps[1] == "unsafe";
    let listed: CodeSet = match caps.get(2) {
        Some(list) => list
            .as_str()
            .split(',')
            .map(|c| TaxonomyId::from_short(c.trim()).ok_or(BackendError::Malformed))
            .collect::<Result<_, _>>()?,
        None => CodeSet::new(),
    };
    if is_unsafe == listed.is_empty() {
        // `unsafe` needs codes; `safe` must not carry any.
        return Err(BackendError::Malformed);
    }
    let covered = CodeSet::hazards();
    let p = p_unsafe(logprobs, is_unsafe)?;
    let confidence = if p.is_some() {
        ConfidenceSource::Logprob
    } else {
        ConfidenceSource::Fixed
    };
    let mut scores = Vec::with_capacity(covered.len());
    for code in covered.iter() {
        let score = match (is_unsafe, listed.contains(code), p) {
            (false, _, Some(p)) => checked_score(p)?,
            (false, _, None) => 0.0,
            (true, true, Some(p)) => checked_score(p)?,
            (true, true, None) => FIXED_UNSAFE,
            (true, false, _) => 0.0,
        };
        scores.push((code, score));
    }
    Ok(GuardAnswer {
        scores,
        covered,
        model_signal: if is_unsafe {
            ModelSignal::Block
        } else {
            ModelSignal::Allow
        },
        confidence,
    })
}

fn qwen_safety_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*Safety:\s*(Safe|Unsafe|Controversial)\s*$").expect("valid regex")
    })
}

fn qwen_categories_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*Categories:\s*(.*?)\s*$").expect("valid regex"))
}

fn qwen_refusal_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*Refusal:\s*(.*?)\s*$").expect("valid regex"))
}

/// Fold a Qwen3Guard label for comparison: case, `&` versus `and`, and spacing.
fn fold_label(label: &str) -> String {
    label
        .to_ascii_lowercase()
        .replace('&', " and ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The taxonomy codes for one Qwen3Guard label. `Ok(None)` for `None`.
fn qwen_label_codes(label: &str) -> Result<Option<&'static [TaxonomyId]>, BackendError> {
    let folded = fold_label(label);
    if folded == "none" {
        return Ok(None);
    }
    let mapping = taxonomy()
        .vendor_mapping("qwen3guard")
        .ok_or(BackendError::Malformed)?;
    mapping
        .into_iter()
        .find(|(known, _)| fold_label(known) == folded)
        .map(|(_, codes)| Some(codes))
        .ok_or(BackendError::Malformed)
}

/// The value of a line that may appear at most once. A second match means the
/// reply holds two answers, which is outside the closed grammar.
fn single_line(re: &Regex, content: &str) -> Result<Option<String>, BackendError> {
    let mut matches = re.captures_iter(content);
    let first = matches.next().map(|c| c[1].to_string());
    if matches.next().is_some() {
        return Err(BackendError::Malformed);
    }
    Ok(first)
}

/// Probability of the generated safety label, when logprobs are present: the
/// first non-blank token after the first token containing `:`.
fn qwen_label_probability(logprobs: Option<&Value>, label: &str) -> Option<f64> {
    let content = logprobs?.get("content")?.as_array()?;
    let mut after_colon = false;
    for entry in content {
        let token = entry.get("token").and_then(Value::as_str)?;
        if !after_colon {
            after_colon = token.contains(':');
            continue;
        }
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        if !label.starts_with(t) {
            return None;
        }
        let lp = entry.get("logprob").and_then(Value::as_f64)?;
        let p = lp.exp();
        return (p.is_finite() && (0.0..=1.0).contains(&p)).then_some(p);
    }
    None
}

/// Parse a Qwen3Guard-Gen reply (SB-3).
///
/// - `Unsafe`: each mapped code of the listed labels scores 0.95, or the
///   probability of the `Unsafe` label token when logprobs are present.
/// - `Controversial`: listed codes score 0.6, the controversial band.
/// - `Safe`: every covered code scores 0, or `1 - p(Safe)` with logprobs.
///
/// An unknown label, a missing `Safety:` line, more than one `Safety:`,
/// `Categories:` or `Refusal:` line, an `Unsafe` or `Controversial` with no
/// category, a `Safe` that names a category, or a `Refusal:` line other than
/// `Yes` or `No` is `Malformed`.
pub fn parse_qwen3guard(
    content: &str,
    logprobs: Option<&Value>,
) -> Result<GuardAnswer, BackendError> {
    let safety = single_line(qwen_safety_line(), content)?.ok_or(BackendError::Malformed)?;
    if let Some(refusal) = single_line(qwen_refusal_line(), content)? {
        if !matches!(refusal.as_str(), "Yes" | "No") {
            return Err(BackendError::Malformed);
        }
    }
    let mut listed = CodeSet::new();
    if let Some(categories) = single_line(qwen_categories_line(), content)? {
        for label in categories
            .split(',')
            .map(str::trim)
            .filter(|l| !l.is_empty())
        {
            if let Some(codes) = qwen_label_codes(label)? {
                for code in codes {
                    listed.insert(*code);
                }
            }
        }
    }
    let covered = GuardDialect::Qwen3Guard.covers();
    let p_label = qwen_label_probability(logprobs, &safety);
    let (signal, listed_score, other_score) = match safety.as_str() {
        "Unsafe" | "Controversial" if listed.is_empty() => return Err(BackendError::Malformed),
        // A category on a safe verdict contradicts it, as codes after `safe`
        // do for Llama Guard.
        "Safe" if !listed.is_empty() => return Err(BackendError::Malformed),
        "Unsafe" => (
            ModelSignal::Block,
            p_label.map_or(Ok(FIXED_UNSAFE), checked_score)?,
            0.0,
        ),
        "Controversial" => (ModelSignal::Flag, CONTROVERSIAL, 0.0),
        _ => {
            let other = p_label.map_or(Ok(0.0), |p| checked_score(1.0 - p))?;
            (ModelSignal::Allow, other, other)
        }
    };
    let scores = covered
        .iter()
        .map(|code| {
            let score = if listed.contains(code) {
                listed_score
            } else {
                other_score
            };
            (code, score)
        })
        .collect();
    let confidence = if p_label.is_some() && safety != "Controversial" {
        ConfidenceSource::Logprob
    } else {
        ConfidenceSource::Fixed
    };
    Ok(GuardAnswer {
        scores,
        covered,
        model_signal: signal,
        confidence,
    })
}

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

    fn body(&self, direction: Direction, item: &ScreenItem) -> Value {
        let text = item.text.as_deref().unwrap_or("");
        let messages = if direction.is_output() {
            // Response classification: the prior user turn, then the window.
            // A generated image (section 9 rule 3) rides in the assistant
            // turn, so the guard sees the exact bytes that would be returned.
            json!([
                {"role": "user", "content": item.context.as_deref().unwrap_or("")},
                {"role": "assistant", "content": Self::content(item, text.to_string())},
            ])
        } else {
            let joined = match item.context.as_deref() {
                Some(context) if !context.is_empty() => format!("{context}\n\n{text}"),
                _ => text.to_string(),
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
mod tests {
    use super::*;

    /// `(token, logprob, top alternatives)` per generated token.
    type TokenRow<'a> = (&'a str, f64, &'a [(&'a str, f64)]);

    fn lp(entries: &[TokenRow<'_>]) -> Value {
        json!({
            "content": entries.iter().map(|(token, logprob, top)| json!({
                "token": token,
                "logprob": logprob,
                "top_logprobs": top.iter().map(|(t, l)| json!({"token": t, "logprob": l})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>()
        })
    }

    fn score(a: &GuardAnswer, code: TaxonomyId) -> f32 {
        a.scores.iter().find(|(c, _)| *c == code).unwrap().1
    }

    // SB-1
    #[test]
    fn llama_guard_safe_with_logprobs_scores_low() {
        let logprobs = lp(&[
            ("\n\n", -0.01, &[]),
            (
                "safe",
                (0.98f64).ln(),
                &[("safe", (0.98f64).ln()), ("unsafe", (0.02f64).ln())],
            ),
        ]);
        let a = parse_llama_guard("\n\nsafe", Some(&logprobs)).unwrap();
        assert_eq!(a.confidence, ConfidenceSource::Logprob);
        assert_eq!(a.model_signal, ModelSignal::Allow);
        assert_eq!(a.covered, CodeSet::hazards());
        for (_, s) in &a.scores {
            assert!(
                (*s - 0.02).abs() < 1e-4,
                "confident safe stays below any flag threshold: {s}"
            );
        }
    }

    #[test]
    fn llama_guard_unsafe_s9_with_logprobs() {
        let logprobs = lp(&[(
            "unsafe",
            (0.9f64).ln(),
            &[("unsafe", (0.9f64).ln()), ("safe", (0.1f64).ln())],
        )]);
        let a = parse_llama_guard("unsafe\nS9", Some(&logprobs)).unwrap();
        assert_eq!(a.confidence, ConfidenceSource::Logprob);
        assert_eq!(a.model_signal, ModelSignal::Block);
        assert!((score(&a, TaxonomyId::S9) - 0.9).abs() < 1e-4);
        assert_eq!(score(&a, TaxonomyId::S1), 0.0);
        assert_eq!(score(&a, TaxonomyId::S4), 0.0);
    }

    #[test]
    fn llama_guard_multi_code_and_fixed_confidence() {
        let a = parse_llama_guard("unsafe\nS1,S10", None).unwrap();
        assert_eq!(a.confidence, ConfidenceSource::Fixed);
        assert_eq!(score(&a, TaxonomyId::S1), FIXED_UNSAFE);
        assert_eq!(score(&a, TaxonomyId::S10), FIXED_UNSAFE);
        assert_eq!(score(&a, TaxonomyId::S9), 0.0);
        let spaced = parse_llama_guard("unsafe\nS1, S14\n", None).unwrap();
        assert_eq!(score(&spaced, TaxonomyId::S14), FIXED_UNSAFE);
        let safe = parse_llama_guard("safe", None).unwrap();
        assert!(safe.scores.iter().all(|(_, s)| *s == 0.0));
    }

    #[test]
    fn llama_guard_prefix_token_counts_as_unsafe_branch() {
        // A tokenizer that splits `unsafe` emits `un` first.
        let logprobs = lp(&[
            (" ", -0.0, &[]),
            (
                "un",
                (0.7f64).ln(),
                &[("un", (0.7f64).ln()), ("safe", (0.3f64).ln())],
            ),
        ]);
        let a = parse_llama_guard("unsafe\nS2", Some(&logprobs)).unwrap();
        assert!((score(&a, TaxonomyId::S2) - 0.7).abs() < 1e-4);
        // Only `safe` among the alternatives: p_unsafe = 1 - p(safe).
        let logprobs = lp(&[("safe", (0.95f64).ln(), &[])]);
        let a = parse_llama_guard("safe", Some(&logprobs)).unwrap();
        assert!((score(&a, TaxonomyId::S1) - 0.05).abs() < 1e-4);
        // Logprobs with neither branch fall back to Fixed, not Malformed.
        let logprobs = lp(&[("hello", -0.1, &[])]);
        let a = parse_llama_guard("unsafe\nS3", Some(&logprobs)).unwrap();
        assert_eq!(a.confidence, ConfidenceSource::Fixed);
    }

    // SB-2
    #[test]
    fn llama_guard_out_of_grammar_is_malformed() {
        for bad in [
            "unsafe",
            "unsafe\n",
            "unsafe\nS15",
            "unsafe\nS0",
            "The answer is safe",
            "Sure! safe",
            "",
            "   ",
            "safe\nS1",
            "SAFE",
            "unsafe\nS1,",
            "unsafe\nS1,S99",
        ] {
            assert_eq!(
                parse_llama_guard(bad, None),
                Err(BackendError::Malformed),
                "{bad:?}"
            );
        }
    }

    // SB-3
    #[test]
    fn qwen3guard_controversial_mapped_and_unmapped() {
        let a = parse_qwen3guard("Safety: Controversial\nCategories: Violent", None).unwrap();
        assert_eq!(a.model_signal, ModelSignal::Flag);
        assert_eq!(score(&a, TaxonomyId::S1), CONTROVERSIAL);
        assert_eq!(score(&a, TaxonomyId::S2), 0.0);
        assert_eq!(
            parse_qwen3guard("Safety: Controversial\nCategories: Weather", None),
            Err(BackendError::Malformed)
        );
    }

    #[test]
    fn qwen3guard_unsafe_maps_every_label() {
        let a = parse_qwen3guard(
            "Safety: Unsafe\nCategories: PII, Suicide and Self-Harm, Jailbreak",
            None,
        )
        .unwrap();
        assert_eq!(a.model_signal, ModelSignal::Block);
        for code in [
            TaxonomyId::S7,
            TaxonomyId::PII,
            TaxonomyId::S11,
            TaxonomyId::PROMPT_INJECTION,
        ] {
            assert_eq!(score(&a, code), FIXED_UNSAFE, "{code}");
        }
        assert_eq!(score(&a, TaxonomyId::S12), 0.0);
        // Labels exactly as the model card spells them.
        for label in [
            "Violent",
            "Non-violent Illegal Acts",
            "Sexual Content or Sexual Acts",
            "PII",
            "Suicide & Self-Harm",
            "Unethical Acts",
            "Politically Sensitive Topics",
            "Copyright Violation",
            "Jailbreak",
        ] {
            assert!(
                parse_qwen3guard(&format!("Safety: Unsafe\nCategories: {label}"), None).is_ok(),
                "{label}"
            );
        }
    }

    #[test]
    fn qwen3guard_never_covers_s4_or_s9() {
        let covers = GuardDialect::Qwen3Guard.covers();
        assert!(!covers.contains(TaxonomyId::S4));
        assert!(!covers.contains(TaxonomyId::S9));
        assert!(covers.contains(TaxonomyId::S1));
    }

    #[test]
    fn qwen3guard_safe_and_response_mode() {
        let a = parse_qwen3guard("Safety: Safe\nCategories: None\nRefusal: Yes", None).unwrap();
        assert_eq!(a.model_signal, ModelSignal::Allow);
        assert!(a.scores.iter().all(|(_, s)| *s == 0.0));
        assert_eq!(
            parse_qwen3guard("Safety: Safe\nCategories: None\nRefusal: Maybe", None),
            Err(BackendError::Malformed)
        );
        assert_eq!(
            parse_qwen3guard("Categories: None", None),
            Err(BackendError::Malformed)
        );
        assert_eq!(
            parse_qwen3guard("Safety: Unsafe\nCategories: None", None),
            Err(BackendError::Malformed)
        );
        assert_eq!(
            parse_qwen3guard("Safety: Unsafe", None),
            Err(BackendError::Malformed)
        );
        assert_eq!(
            parse_qwen3guard("Safety: Unknown", None),
            Err(BackendError::Malformed)
        );
    }

    #[test]
    fn qwen3guard_label_logprob() {
        let logprobs = lp(&[
            ("Safety", -0.0, &[]),
            (":", -0.0, &[]),
            (" Unsafe", (0.8f64).ln(), &[]),
        ]);
        let a = parse_qwen3guard("Safety: Unsafe\nCategories: Violent", Some(&logprobs)).unwrap();
        assert_eq!(a.confidence, ConfidenceSource::Logprob);
        assert!((score(&a, TaxonomyId::S1) - 0.8).abs() < 1e-4);
        let logprobs = lp(&[("Safety:", -0.0, &[]), (" Safe", (0.9f64).ln(), &[])]);
        let a = parse_qwen3guard("Safety: Safe\nCategories: None", Some(&logprobs)).unwrap();
        assert!((score(&a, TaxonomyId::S1) - 0.1).abs() < 1e-4);
    }

    #[test]
    fn guard_body_uses_the_engine_template_and_response_form() {
        let backend = GuardModelBackend::new(GuardModelConfig {
            id: "guard_text".into(),
            base_url: "http://127.0.0.1:8092/v1".into(),
            locality: Locality::Loopback,
            model: "llama-guard-3-8b".into(),
            weights_sha256: None,
            template_version: 1,
            dialect: GuardDialect::LlamaGuard,
            images: false,
            bearer: None,
            hard_timeout_ms: 800,
            max_concurrency: 2,
        })
        .unwrap();
        let item = ScreenItem::text(
            crate::cache::SegmentKey([1; 32]),
            crate::backend::LeafClass::User,
            "segment",
        )
        .with_context("prior");
        let inbound = backend.body(Direction::Inbound, &item);
        assert_eq!(
            inbound["messages"].as_array().unwrap().len(),
            1,
            "no Ryu system prompt"
        );
        assert_eq!(inbound["messages"][0]["content"], "prior\n\nsegment");
        assert_eq!(inbound["logprobs"], true);
        assert_eq!(inbound["max_tokens"], 24);
        let outbound = backend.body(Direction::Outbound, &item);
        assert_eq!(outbound["messages"][0]["role"], "user");
        assert_eq!(outbound["messages"][0]["content"], "prior");
        assert_eq!(outbound["messages"][1]["role"], "assistant");
        assert_eq!(outbound["messages"][1]["content"], "segment");

        let image = crate::backend::ScreenImage::new(vec![7u8, 8, 9], "image/png");
        let generated = ScreenItem::image(
            crate::cache::SegmentKey([2; 32]),
            crate::backend::LeafClass::Assistant,
            image,
        )
        .with_context("prompt");
        let media_out = backend.body(Direction::MediaOutput, &generated);
        assert_eq!(media_out["messages"][0]["content"], "prompt");
        let parts = media_out["messages"][1]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1, "no empty text part");
        assert_eq!(parts[0]["image_url"]["url"], "data:image/png;base64,BwgJ");
    }

    #[test]
    fn llama_guard_logprobs_that_contradict_the_reply_are_malformed() {
        // `unsafe` reply, certain `safe` token: never a 0 on the listed code.
        let logprobs = lp(&[("safe", 0.0, &[("safe", 0.0)])]);
        assert_eq!(
            parse_llama_guard("unsafe\nS9", Some(&logprobs)),
            Err(BackendError::Malformed)
        );
        // `safe` reply, certain `unsafe` token: never a fixed 0 on S4 or S9.
        let logprobs = lp(&[("unsafe", 0.0, &[("unsafe", 0.0)])]);
        assert_eq!(
            parse_llama_guard("safe", Some(&logprobs)),
            Err(BackendError::Malformed)
        );
        let logprobs = lp(&[("un", 0.0, &[])]);
        assert_eq!(
            parse_llama_guard("safe", Some(&logprobs)),
            Err(BackendError::Malformed)
        );
    }

    #[test]
    fn qwen3guard_repeated_or_contradictory_lines_are_malformed() {
        for bad in [
            "Safety: Safe\nCategories: None\nSafety: Unsafe\nCategories: Violent",
            "Safety: Unsafe\nSafety: Unsafe\nCategories: Violent",
            "Safety: Unsafe\nCategories: Violent\nCategories: PII",
            "Safety: Safe\nCategories: None\nRefusal: No\nRefusal: Yes",
            "Safety: Safe\nCategories: Violent",
        ] {
            assert_eq!(
                parse_qwen3guard(bad, None),
                Err(BackendError::Malformed),
                "{bad:?}"
            );
        }
    }
}
