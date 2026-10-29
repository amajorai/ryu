//! `TestBackend`: a deterministic backend driven by the spec 00.9 sentinels
//! (screener addendum section 4.5). Compiled only for tests and the
//! `test-backends` feature, so release builds carry no `RYU_TEST` string.
//!
//! Each classifier-layer sentinel found in an item's text scores its code 1.0;
//! every other covered code scores 0.0 unless a fixed score is configured. The
//! lexicon sentinel belongs to the regex floor and is ignored here.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::backend::{
    elapsed_ms, BackendDescriptor, BackendError, BackendHealth, BackendKind, BackendRef,
    BackendVerdict, CodeSet, ConfidenceSource, ItemVerdict, Locality, ModelSignal, ScreenRequest,
    ScreenerBackend, TaxonomyId,
};

pub const SENTINELS_JSON: &str = include_str!("../../testdata/sentinels.json");

pub const SENTINEL_LEXICON: &str = "RYU_TEST_LEXICON";
pub const SENTINEL_HAZARD_S4: &str = "RYU_TEST_HAZARD_S4";
pub const SENTINEL_HAZARD_S9: &str = "RYU_TEST_HAZARD_S9";
pub const SENTINEL_HAZARD_S1: &str = "RYU_TEST_HAZARD_S1";
pub const SENTINEL_PROMPT_ATTACK: &str = "RYU_TEST_PROMPT_ATTACK";

/// One sentinel row of `testdata/sentinels.json`.
#[derive(Debug, Clone)]
pub struct Sentinel {
    pub text: String,
    /// `lexicon` (regex floor) or `classifier`.
    pub layer: String,
    pub code: TaxonomyId,
}

#[derive(Deserialize)]
struct RawSentinels {
    sentinels: Vec<RawSentinel>,
}

#[derive(Deserialize)]
struct RawSentinel {
    text: String,
    layer: String,
    code: String,
}

/// The sentinel set, parsed once.
pub fn sentinels() -> &'static [Sentinel] {
    static SENTINELS: OnceLock<Vec<Sentinel>> = OnceLock::new();
    SENTINELS.get_or_init(|| {
        let raw: RawSentinels =
            serde_json::from_str(SENTINELS_JSON).expect("sentinels.json parses");
        raw.sentinels
            .into_iter()
            .map(|s| Sentinel {
                code: TaxonomyId::parse(&s.code).expect("sentinel code is in the taxonomy"),
                text: s.text,
                layer: s.layer,
            })
            .collect()
    })
}

/// Codes the classifier-layer sentinels in `text` map to.
pub fn sentinel_codes(text: &str) -> CodeSet {
    sentinels()
        .iter()
        .filter(|s| s.layer == "classifier" && text.contains(&s.text))
        .map(|s| s.code)
        .collect()
}

#[derive(Debug, Clone, Default)]
struct Behaviour {
    delay: Option<Duration>,
    fail_always: Option<BackendError>,
    fail_on: Option<(String, BackendError)>,
    fixed: Vec<(TaxonomyId, f32)>,
    outside_coverage: bool,
    image_codes: Vec<([u8; 32], TaxonomyId)>,
}

/// A deterministic backend for chain and gateway tests.
pub struct TestBackend {
    descriptor: BackendDescriptor,
    behaviour: Behaviour,
    calls: AtomicUsize,
    seen: Mutex<Vec<String>>,
}

impl TestBackend {
    pub fn new(id: &str) -> Self {
        let mut covers = CodeSet::hazards();
        covers.insert(TaxonomyId::PROMPT_INJECTION);
        Self {
            descriptor: BackendDescriptor {
                reference: BackendRef {
                    id: id.to_string(),
                    kind: BackendKind::Test,
                    model: "test-model".into(),
                    weights_sha256: Some("0000000000000000".into()),
                    template_version: 1,
                },
                locality: Locality::Loopback,
                text: true,
                images: false,
                covers,
                max_batch: 1,
                max_item_tokens: 4096,
                hard_timeout_ms: 800,
                max_concurrency: 8,
            },
            behaviour: Behaviour::default(),
            calls: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
        }
    }

    pub fn covers(mut self, covers: CodeSet) -> Self {
        self.descriptor.covers = covers;
        self
    }

    pub fn locality(mut self, locality: Locality) -> Self {
        if locality.is_remote() {
            self.descriptor.reference.kind = BackendKind::DecisionRemote;
        }
        self.descriptor.locality = locality;
        self
    }

    pub fn template_version(mut self, version: u32) -> Self {
        self.descriptor.reference.template_version = version;
        self
    }

    pub fn hard_timeout_ms(mut self, ms: u32) -> Self {
        self.descriptor.hard_timeout_ms = ms;
        self
    }

    pub fn concurrency(mut self, n: usize) -> Self {
        self.descriptor.max_concurrency = n;
        self
    }

    pub fn max_item_tokens(mut self, n: u32) -> Self {
        self.descriptor.max_item_tokens = n;
        self
    }

    pub fn max_batch(mut self, n: usize) -> Self {
        self.descriptor.max_batch = n;
        self
    }

    pub fn delay(mut self, delay: Duration) -> Self {
        self.behaviour.delay = Some(delay);
        self
    }

    /// Score `code` at `score` on every item (unless a sentinel scores it 1.0).
    pub fn fixed_score(mut self, code: TaxonomyId, score: f32) -> Self {
        self.behaviour.fixed.push((code, score));
        self
    }

    pub fn fail_always(mut self, error: BackendError) -> Self {
        self.behaviour.fail_always = Some(error);
        self
    }

    /// Fail any call whose items contain `needle`.
    pub fn fail_on(mut self, needle: &str, error: BackendError) -> Self {
        self.behaviour.fail_on = Some((needle.to_string(), error));
        self
    }

    /// Report a code outside the declared coverage (exercises validation).
    pub fn report_outside_coverage(mut self) -> Self {
        self.descriptor.covers = CodeSet::from([TaxonomyId::S1]);
        self.behaviour.outside_coverage = true;
        self
    }

    /// Accept images, scoring `code` 1.0 for an image with this sha256.
    pub fn flag_image(mut self, sha256: [u8; 32], code: TaxonomyId) -> Self {
        self.descriptor.images = true;
        self.behaviour.image_codes.push((sha256, code));
        self
    }

    /// Calls that reached `screen`.
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// Item texts this backend received, in order.
    pub fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[async_trait::async_trait]
impl ScreenerBackend for TestBackend {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.descriptor
    }

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError> {
        let started = Instant::now();
        if let Some(error) = &self.behaviour.fail_always {
            // NotPermitted means nothing was sent, so it is not a call.
            if *error != BackendError::NotPermitted {
                self.calls.fetch_add(1, Ordering::SeqCst);
            }
            return Err(error.clone());
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        {
            let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            seen.extend(
                req.items
                    .iter()
                    .filter_map(|i| i.text.as_deref().map(str::to_string)),
            );
        }
        if let Some(delay) = self.behaviour.delay {
            tokio::time::sleep(delay).await;
        }
        if let Some((needle, error)) = &self.behaviour.fail_on {
            if req.items.iter().any(|i| {
                i.text
                    .as_deref()
                    .is_some_and(|t| t.contains(needle.as_str()))
            }) {
                return Err(error.clone());
            }
        }
        let covers = &self.descriptor.covers;
        let items = req
            .items
            .iter()
            .map(|item| {
                let mut hits = item.text.as_deref().map(sentinel_codes).unwrap_or_default();
                if let Some(image) = &item.image {
                    for (sha, code) in &self.behaviour.image_codes {
                        if *sha == image.sha256 {
                            hits.insert(*code);
                        }
                    }
                }
                let mut scores: Vec<(TaxonomyId, f32)> = covers
                    .iter()
                    .map(|code| {
                        let fixed = self
                            .behaviour
                            .fixed
                            .iter()
                            .find_map(|(c, s)| (*c == code).then_some(*s))
                            .unwrap_or(0.0);
                        (code, if hits.contains(code) { 1.0 } else { fixed })
                    })
                    .collect();
                let mut covered = covers.clone();
                if self.behaviour.outside_coverage {
                    scores.push((TaxonomyId::S9, 0.5));
                    covered.insert(TaxonomyId::S9);
                }
                let signal = if hits.intersection(covers).is_empty() {
                    ModelSignal::Allow
                } else {
                    ModelSignal::Block
                };
                ItemVerdict {
                    key: item.key,
                    scores,
                    covered,
                    model_signal: signal,
                    confidence: ConfidenceSource::Fixed,
                }
            })
            .collect();
        Ok(BackendVerdict {
            backend: self.descriptor.reference.clone(),
            items,
            latency_ms: elapsed_ms(started),
        })
    }

    async fn probe(&self) -> BackendHealth {
        match &self.behaviour.fail_always {
            Some(BackendError::NotPermitted) => BackendHealth::NotPermitted,
            Some(_) => BackendHealth::Down("test_failure"),
            None => BackendHealth::Ready,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_file_matches_the_constants() {
        let texts: Vec<&str> = sentinels().iter().map(|s| s.text.as_str()).collect();
        for c in [
            SENTINEL_LEXICON,
            SENTINEL_HAZARD_S4,
            SENTINEL_HAZARD_S9,
            SENTINEL_HAZARD_S1,
            SENTINEL_PROMPT_ATTACK,
        ] {
            assert!(texts.contains(&c), "{c}");
        }
    }

    #[test]
    fn sentinels_map_to_codes_and_lexicon_is_not_a_classifier_hit() {
        assert_eq!(
            sentinel_codes(SENTINEL_HAZARD_S4),
            CodeSet::from([TaxonomyId::S4])
        );
        assert_eq!(
            sentinel_codes(&format!(
                "{SENTINEL_HAZARD_S9} and {SENTINEL_PROMPT_ATTACK}"
            )),
            CodeSet::from([TaxonomyId::S9, TaxonomyId::PROMPT_INJECTION])
        );
        assert!(sentinel_codes(SENTINEL_LEXICON).is_empty());
        assert!(sentinel_codes("plain text").is_empty());
    }
}
