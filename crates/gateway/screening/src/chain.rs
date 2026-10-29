//! The screener chain: which backends answer for each role, and how their
//! answers compose (screener addendum section 3.4).
//!
//! - Local and private-network backends in a role run concurrently on cache
//!   misses. The score for each code is the maximum across the backends that
//!   answered and cover it.
//! - Remote processors are fallback-only by default ([`RemoteMode::Fallback`]):
//!   they see only the items whose wanted codes the local backends left
//!   undecided, one processor at a time in role order, so a third party never
//!   sees traffic a local backend already decided.
//! - A code is decided when a backend that covers it answered inside the
//!   deadline. On floor-tier traffic a hard code (S4 always, plus the policy's
//!   `hard_codes`) also needs a qualification record matching that backend's
//!   id, model, weights and template, checked at compose time against the
//!   current policy, so a cached score from a backend that lost its
//!   qualification cannot decide a hard code. Node-tier traffic (a self-hosted
//!   or BYOK node's own opt-in classifiers) is never bound by Ryu's floor, so
//!   qualification does not gate it.
//! - A backend that does not permit the request tier (a remote processor
//!   without its permit) is absent: it is skipped before the segment cache, so
//!   scores cached under another tier's permit never decide this tier.
//! - Every call is bounded by `min(hard_timeout_ms, deadline remaining)` and by
//!   a per-backend concurrency gate; a call that cannot start before the
//!   deadline fails fast as `Timeout`. A caller that names a fair-share key
//!   ([`ScreenerChain::screen_for`]) also holds at most half of a backend's
//!   permits at once, taken before the shared gate, so one tenant's fan-out
//!   queues on its own gate and cannot starve the others.
//! - An item is never sent past its backend's `max_item_tokens`: the context
//!   is cut from the front to make room, and an item whose text alone is over
//!   the limit is left undecided instead of being truncated or failed by the
//!   engine (which would count against the breaker).
//!
//! The chain only reports scores and what is undecided. The fail rules
//! (section 6) and the floor matrix belong to the gateway glue.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use tokio::sync::Semaphore;

use crate::backend::{
    elapsed_ms, BackendDescriptor, BackendError, BackendRef, BackendVerdict, CodeSet, ItemVerdict,
    ModelSignal, ScreenItem, ScreenRequest, ScreenTier, ScreenerBackend, TaxonomyId,
};
use crate::cache::{CacheKey, CachedScores, SegmentCache, SegmentKey};

/// Opaque key one caller's work shares a fair-share gate under, such as a keyed
/// hash of the org. It never reaches a backend.
pub type FairShareKey = [u8; 32];

/// Fair-share gates kept before idle ones are pruned.
const FAIR_GATES_PRUNE_AT: usize = 1024;

/// The four screening roles a floor assigns backends to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    /// T2 text hazards.
    TextHazard,
    /// T1 prompt attacks.
    PromptAttack,
    Vision,
    /// Stream windows and final output.
    Output,
}

/// When remote processors are called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteMode {
    /// Only for items the local backends left undecided (the default).
    #[default]
    Fallback,
    /// Alongside the local backends. A loosening floor change (section 5.4).
    Parallel,
}

/// A qualification (section 12.3): this exact backend build may source these
/// hard codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualificationRecord {
    pub backend_id: String,
    pub model: String,
    pub weights_sha256: Option<String>,
    pub template_version: u32,
    pub codes: CodeSet,
}

impl QualificationRecord {
    pub fn matches(&self, backend: &BackendRef) -> bool {
        self.backend_id == backend.id
            && self.model == backend.model
            && self.weights_sha256 == backend.weights_sha256
            && self.template_version == backend.template_version
    }
}

/// The policy the chain composes under, taken from the floor (or the node
/// operator) by the gateway.
#[derive(Debug, Clone)]
pub struct ChainPolicy {
    /// Hard codes beyond S4, which is always hard.
    pub hard_codes: CodeSet,
    pub qualifications: Vec<QualificationRecord>,
    pub remote_mode: RemoteMode,
}

impl Default for ChainPolicy {
    fn default() -> Self {
        Self {
            hard_codes: CodeSet::from([TaxonomyId::S4, TaxonomyId::S9]),
            qualifications: Vec::new(),
            remote_mode: RemoteMode::Fallback,
        }
    }
}

impl ChainPolicy {
    /// S4 is hard whatever the policy says.
    pub fn is_hard(&self, code: TaxonomyId) -> bool {
        code == TaxonomyId::S4 || self.hard_codes.contains(code)
    }

    /// Every hard code, S4 included.
    pub fn hard_set(&self) -> CodeSet {
        let mut set = self.hard_codes.clone();
        set.insert(TaxonomyId::S4);
        set
    }

    pub fn qualified(&self, backend: &BackendRef, code: TaxonomyId) -> bool {
        self.qualifications
            .iter()
            .any(|q| q.matches(backend) && q.codes.contains(code))
    }

    /// Whether `backend` may decide `code` under this policy for `tier`.
    /// Qualification is a floor rule: on node-tier traffic the node's own
    /// classifier decides every code it covers.
    pub fn may_decide(&self, backend: &BackendRef, code: TaxonomyId, tier: ScreenTier) -> bool {
        tier == ScreenTier::Node || !self.is_hard(code) || self.qualified(backend, code)
    }
}

/// Why a chain cannot source every hard code from its text-hazard role.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("hard codes without a source: uncovered {uncovered:?}, unqualified {unqualified:?}")]
pub struct CoverageError {
    /// No text-hazard backend covers these codes at all.
    pub uncovered: CodeSet,
    /// Covered, but by no backend holding a matching qualification.
    pub unqualified: CodeSet,
}

/// One backend's contribution to one item.
#[derive(Debug, Clone, PartialEq)]
pub struct Contribution {
    pub backend_id: String,
    pub code: TaxonomyId,
    pub score: f32,
    pub from_cache: bool,
}

/// The composed answer for one item.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposedItem {
    pub key: SegmentKey,
    /// Per-code maximum across backends allowed to decide that code.
    pub scores: BTreeMap<TaxonomyId, f32>,
    /// The backend id that gave the maximum for each code.
    pub sources: BTreeMap<TaxonomyId, String>,
    /// Codes some backend allowed to decide them answered for.
    pub decided: CodeSet,
    /// Wanted codes nobody decided. Hard ones follow the section 6 fail rules.
    pub undecided: CodeSet,
    /// Floor-tier hard-code scores from backends without a matching
    /// qualification. Audit only: they never decide a hard code.
    pub unqualified_scores: BTreeMap<TaxonomyId, f32>,
    /// Every score that counted, per backend, for one event per detector.
    pub contributions: Vec<Contribution>,
    /// Each backend's own allow, flag or block answer. Audit only.
    pub model_signals: Vec<(String, ModelSignal)>,
}

impl ComposedItem {
    fn new(key: SegmentKey) -> Self {
        Self {
            key,
            scores: BTreeMap::new(),
            sources: BTreeMap::new(),
            decided: CodeSet::new(),
            undecided: CodeSet::new(),
            unqualified_scores: BTreeMap::new(),
            contributions: Vec::new(),
            model_signals: Vec::new(),
        }
    }

    pub fn score(&self, code: TaxonomyId) -> Option<f32> {
        self.scores.get(&code).copied()
    }

    fn absorb(
        &mut self,
        backend: &BackendRef,
        verdict: &ItemVerdict,
        from_cache: bool,
        policy: &ChainPolicy,
        tier: ScreenTier,
    ) {
        for &(code, score) in &verdict.scores {
            if !policy.may_decide(backend, code, tier) {
                let slot = self.unqualified_scores.entry(code).or_insert(score);
                *slot = slot.max(score);
                continue;
            }
            self.contributions.push(Contribution {
                backend_id: backend.id.clone(),
                code,
                score,
                from_cache,
            });
            let better = self
                .scores
                .get(&code)
                .is_none_or(|current| score > *current);
            if better {
                self.scores.insert(code, score);
                self.sources.insert(code, backend.id.clone());
            }
        }
        for code in verdict.covered.iter() {
            if policy.may_decide(backend, code, tier) {
                self.decided.insert(code);
            }
        }
        self.model_signals
            .push((backend.id.clone(), verdict.model_signal));
    }

    fn undecided_of(&self, wanted: &CodeSet) -> CodeSet {
        wanted.difference(&self.decided)
    }
}

/// What happened when the chain called one backend.
#[derive(Debug, Clone, PartialEq)]
pub struct BackendOutcome {
    pub backend: BackendRef,
    pub processor_id: Option<String>,
    /// Calls that reached the backend's `screen`.
    pub calls: u32,
    pub cache_hits: u32,
    /// Items content was sent for (counts toward a remote processor's exposure).
    pub items_sent: u32,
    /// The first failure, when any chunk failed.
    pub error: Option<BackendError>,
    pub latency_ms: u32,
}

/// The chain's answer for one role and one request.
#[derive(Debug, Clone)]
pub struct ChainVerdict {
    pub role: Role,
    pub items: Vec<ComposedItem>,
    pub outcomes: Vec<BackendOutcome>,
    /// Remote processors that received content for this request.
    pub processors: Vec<String>,
}

impl ChainVerdict {
    /// The maximum composed score for `code` across all items.
    pub fn max_score(&self, code: TaxonomyId) -> Option<f32> {
        self.items
            .iter()
            .filter_map(|item| item.score(code))
            .reduce(f32::max)
    }

    /// Wanted codes left undecided on any item.
    pub fn undecided(&self) -> CodeSet {
        self.items
            .iter()
            .fold(CodeSet::new(), |acc, item| acc.union(&item.undecided))
    }

    /// Undecided hard codes under `policy`.
    pub fn undecided_hard(&self, policy: &ChainPolicy) -> CodeSet {
        self.undecided().intersection(&policy.hard_set())
    }
}

type Backend = Arc<dyn ScreenerBackend>;

struct BackendRun {
    results: Vec<(usize, ItemVerdict, bool)>,
    outcome: BackendOutcome,
}

/// Backends per role plus the composition policy.
pub struct ScreenerChain {
    text_hazard: Vec<Backend>,
    prompt_attack: Vec<Backend>,
    vision: Vec<Backend>,
    output: Vec<Backend>,
    policy: ChainPolicy,
    cache: Option<Arc<SegmentCache>>,
    gates: HashMap<String, Arc<Semaphore>>,
    /// Per backend and fair-share key: how many of the backend's permits one
    /// caller may hold at once.
    fair_gates: Mutex<HashMap<(String, FairShareKey), Arc<Semaphore>>>,
}

impl ScreenerChain {
    pub fn new(policy: ChainPolicy) -> Self {
        Self {
            text_hazard: Vec::new(),
            prompt_attack: Vec::new(),
            vision: Vec::new(),
            output: Vec::new(),
            policy,
            cache: None,
            gates: HashMap::new(),
            fair_gates: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_cache(mut self, cache: Arc<SegmentCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Assign backends to a role, in order.
    pub fn with_role(mut self, role: Role, backends: Vec<Backend>) -> Self {
        for backend in &backends {
            let d = backend.descriptor();
            self.gates
                .entry(d.id().to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(d.max_concurrency.max(1))));
        }
        *self.role_mut(role) = backends;
        self
    }

    pub fn backends(&self, role: Role) -> &[Backend] {
        match role {
            Role::TextHazard => &self.text_hazard,
            Role::PromptAttack => &self.prompt_attack,
            Role::Vision => &self.vision,
            Role::Output => &self.output,
        }
    }

    fn role_mut(&mut self, role: Role) -> &mut Vec<Backend> {
        match role {
            Role::TextHazard => &mut self.text_hazard,
            Role::PromptAttack => &mut self.prompt_attack,
            Role::Vision => &mut self.vision,
            Role::Output => &mut self.output,
        }
    }

    pub fn policy(&self) -> &ChainPolicy {
        &self.policy
    }

    /// Replace the policy (a new floor version). Cached scores stay valid,
    /// because qualification is checked when composing.
    pub fn set_policy(&mut self, policy: ChainPolicy) {
        self.policy = policy;
    }

    pub fn cache(&self) -> Option<&Arc<SegmentCache>> {
        self.cache.as_ref()
    }

    /// Whether every hard code has a qualified text-hazard source. A chain
    /// whose only text-hazard backend is the Qwen3Guard dialect fails here,
    /// because that dialect never covers S4 (SB-4).
    pub fn validate_coverage(&self) -> Result<(), CoverageError> {
        let mut uncovered = CodeSet::new();
        let mut unqualified = CodeSet::new();
        for code in self.policy.hard_set().iter() {
            let covering: Vec<&BackendDescriptor> = self
                .text_hazard
                .iter()
                .map(|b| b.descriptor())
                .filter(|d| d.covers.contains(code))
                .collect();
            if covering.is_empty() {
                uncovered.insert(code);
            } else if !covering
                .iter()
                .any(|d| self.policy.qualified(&d.reference, code))
            {
                unqualified.insert(code);
            }
        }
        if uncovered.is_empty() && unqualified.is_empty() {
            Ok(())
        } else {
            Err(CoverageError {
                uncovered,
                unqualified,
            })
        }
    }

    /// The gate capping how many permits of `backend` one fair-share key may
    /// hold: half of its concurrency, and at least one. A gate nobody holds is
    /// full again, so idle ones are dropped once the map grows.
    fn fair_gate(&self, d: &BackendDescriptor, share: FairShareKey) -> Arc<Semaphore> {
        let mut gates = self.fair_gates.lock().unwrap_or_else(|e| e.into_inner());
        if gates.len() >= FAIR_GATES_PRUNE_AT {
            gates.retain(|_, gate| Arc::strong_count(gate) > 1);
        }
        let permits = (d.max_concurrency / 2).max(1);
        Arc::clone(
            gates
                .entry((d.id().to_string(), share))
                .or_insert_with(|| Arc::new(Semaphore::new(permits))),
        )
    }

    /// Screen every item of `req` with the backends of `role`.
    pub async fn screen(&self, role: Role, req: &ScreenRequest<'_>) -> ChainVerdict {
        self.screen_for(role, req, None).await
    }

    /// [`Self::screen`] under a fair-share key: the request's calls also queue
    /// on the key's own gate before the shared one, so a request with many
    /// items cannot fill the shared queue ahead of everyone else's.
    pub async fn screen_for(
        &self,
        role: Role,
        req: &ScreenRequest<'_>,
        share: Option<FairShareKey>,
    ) -> ChainVerdict {
        let backends = self.backends(role);
        let mut items: Vec<ComposedItem> = req
            .items
            .iter()
            .map(|item| ComposedItem::new(item.key))
            .collect();
        let mut outcomes = Vec::new();
        let all: Vec<usize> = (0..req.items.len()).collect();

        let (local, remote): (Vec<&Backend>, Vec<&Backend>) = backends
            .iter()
            .partition(|b| !b.descriptor().locality.is_remote());

        let first_wave: Vec<&Backend> = match self.policy.remote_mode {
            RemoteMode::Parallel => backends.iter().collect(),
            RemoteMode::Fallback => local,
        };
        let runs = join_all(
            first_wave
                .iter()
                .map(|b| self.run_backend(b, &all, req, share)),
        )
        .await;
        for run in runs {
            self.absorb_run(&mut items, run, &mut outcomes, req.tier);
        }

        if self.policy.remote_mode == RemoteMode::Fallback {
            for backend in remote {
                let covers = &backend.descriptor().covers;
                let needed: Vec<usize> = items
                    .iter()
                    .enumerate()
                    .filter(|(_, item)| {
                        !item
                            .undecided_of(req.wanted)
                            .intersection(covers)
                            .is_empty()
                    })
                    .map(|(i, _)| i)
                    .collect();
                if needed.is_empty() {
                    continue;
                }
                let run = self.run_backend(backend, &needed, req, share).await;
                self.absorb_run(&mut items, run, &mut outcomes, req.tier);
            }
        }

        for item in &mut items {
            item.undecided = item.undecided_of(req.wanted);
        }
        let mut processors: Vec<String> = outcomes
            .iter()
            .filter(|o| o.items_sent > 0)
            .filter_map(|o| o.processor_id.clone())
            .collect();
        processors.dedup();
        ChainVerdict {
            role,
            items,
            outcomes,
            processors,
        }
    }

    fn absorb_run(
        &self,
        items: &mut [ComposedItem],
        run: BackendRun,
        outcomes: &mut Vec<BackendOutcome>,
        tier: ScreenTier,
    ) {
        for (index, verdict, from_cache) in &run.results {
            items[*index].absorb(
                &run.outcome.backend,
                verdict,
                *from_cache,
                &self.policy,
                tier,
            );
        }
        outcomes.push(run.outcome);
    }

    async fn run_backend(
        &self,
        backend: &Backend,
        indices: &[usize],
        req: &ScreenRequest<'_>,
        share: Option<FairShareKey>,
    ) -> BackendRun {
        let d = backend.descriptor();
        let scope: Arc<str> = d.reference.cache_scope().into();
        let mut outcome = BackendOutcome {
            backend: d.reference.clone(),
            processor_id: d.locality.processor_id().map(str::to_string),
            calls: 0,
            cache_hits: 0,
            items_sent: 0,
            error: None,
            latency_ms: 0,
        };
        let mut results = Vec::new();
        if !backend.permits(req.tier) {
            // Absent for this tier, cache included (section 6): nothing is
            // sent and nothing cached under another tier's permit is served.
            outcome.error = Some(BackendError::NotPermitted);
            return BackendRun { results, outcome };
        }
        let mut misses = Vec::new();
        for &index in indices {
            let item = &req.items[index];
            if !supports(d, item) {
                continue;
            }
            // Over the backend's token limit: never sent, so the engine can
            // neither truncate the item silently nor fail and open the breaker.
            // The item stays undecided and follows the section 6 fail rules.
            if item.fitted_to(d.max_item_tokens).is_none() {
                continue;
            }
            let cached = self
                .cache
                .as_ref()
                .and_then(|cache| cache.get(&CacheKey::new(item.key, scope.clone())));
            match cached {
                Some(scores) => {
                    outcome.cache_hits += 1;
                    results.push((index, scores.into_verdict(item.key), true));
                }
                None => misses.push(index),
            }
        }
        if misses.is_empty() {
            return BackendRun { results, outcome };
        }

        let started = Instant::now();
        let chunks: Vec<&[usize]> = misses.chunks(d.max_batch.max(1)).collect();
        let calls = join_all(
            chunks
                .iter()
                .map(|chunk| self.call_chunk(backend, chunk, req, share)),
        )
        .await;
        outcome.latency_ms = elapsed_ms(started);
        for (chunk, (result, sent)) in chunks.iter().zip(calls) {
            if sent {
                outcome.calls += 1;
                outcome.items_sent += chunk.len() as u32;
            }
            match result {
                Ok(verdicts) => {
                    for (&index, verdict) in chunk.iter().zip(verdicts) {
                        if let Some(cache) = &self.cache {
                            cache.insert(
                                CacheKey::new(req.items[index].key, scope.clone()),
                                CachedScores::from_verdict(&verdict),
                            );
                        }
                        results.push((index, verdict, false));
                    }
                }
                Err(error) => {
                    if outcome.error.is_none() {
                        outcome.error = Some(error);
                    }
                }
            }
        }
        BackendRun { results, outcome }
    }

    /// One bounded call. Returns the validated verdicts and whether content
    /// reached the backend.
    async fn call_chunk(
        &self,
        backend: &Backend,
        chunk: &[usize],
        req: &ScreenRequest<'_>,
        share: Option<FairShareKey>,
    ) -> (Result<Vec<ItemVerdict>, BackendError>, bool) {
        let d = backend.descriptor();
        let budget = Duration::from_millis(u64::from(d.hard_timeout_ms))
            .min(req.deadline.saturating_duration_since(Instant::now()));
        if budget.is_zero() {
            return (Err(BackendError::Timeout), false);
        }
        let start = Instant::now();
        let call_deadline = start + budget;
        // The caller's own gate first, then the shared one, so a caller's
        // queued items wait here and not in the shared queue.
        let _fair_permit = match share {
            Some(share) => {
                match tokio::time::timeout(budget, self.fair_gate(d, share).acquire_owned()).await {
                    Ok(Ok(permit)) => Some(permit),
                    Ok(Err(_)) => return (Err(BackendError::Unavailable("gate_closed")), false),
                    Err(_) => return (Err(BackendError::Timeout), false),
                }
            }
            None => None,
        };
        let gate = self.gates.get(d.id()).cloned();
        let _permit = match gate {
            Some(gate) => match tokio::time::timeout(
                call_deadline.saturating_duration_since(Instant::now()),
                gate.acquire_owned(),
            )
            .await
            {
                Ok(Ok(permit)) => Some(permit),
                Ok(Err(_)) => return (Err(BackendError::Unavailable("gate_closed")), false),
                Err(_) => return (Err(BackendError::Timeout), false),
            },
            None => None,
        };
        let left = call_deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return (Err(BackendError::Timeout), false);
        }
        // Only items that fit reach here (run_backend skips the rest); the
        // context is cut to leave the text its room.
        let sub_items: Vec<ScreenItem> = chunk
            .iter()
            .filter_map(|&i| req.items[i].fitted_to(d.max_item_tokens))
            .collect();
        if sub_items.len() != chunk.len() {
            return (Err(BackendError::Malformed), false);
        }
        let sub = ScreenRequest {
            items: &sub_items,
            deadline: call_deadline.min(req.deadline),
            ..*req
        };
        let result = match tokio::time::timeout(left, backend.screen(&sub)).await {
            Ok(result) => result,
            Err(_) => Err(BackendError::Timeout),
        };
        let sent = !matches!(result, Err(BackendError::NotPermitted));
        let validated = result.and_then(|verdict| validate(d, &sub_items, verdict));
        (validated, sent)
    }
}

fn supports(d: &BackendDescriptor, item: &ScreenItem) -> bool {
    let has_text = item.text.is_some();
    let has_image = item.image.is_some();
    (has_text || has_image) && (!has_text || d.text) && (!has_image || d.images)
}

/// A backend answer must line up with the request, stay inside the backend's
/// declared coverage and give a finite score for every covered code.
fn validate(
    d: &BackendDescriptor,
    sent: &[ScreenItem],
    verdict: BackendVerdict,
) -> Result<Vec<ItemVerdict>, BackendError> {
    if verdict.items.len() != sent.len() {
        return Err(BackendError::Malformed);
    }
    for (item, answer) in sent.iter().zip(&verdict.items) {
        if item.key != answer.key || !answer.covered.is_subset(&d.covers) {
            return Err(BackendError::Malformed);
        }
        for &(code, score) in &answer.scores {
            if !answer.covered.contains(code) || !score.is_finite() || !(0.0..=1.0).contains(&score)
            {
                return Err(BackendError::Malformed);
            }
        }
        for code in answer.covered.iter() {
            if answer.score(code).is_none() {
                return Err(BackendError::Malformed);
            }
        }
    }
    Ok(verdict.items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Direction, LeafClass, Locality, ScreenTier};
    use crate::backends::test::{
        TestBackend, SENTINEL_HAZARD_S1, SENTINEL_HAZARD_S9, SENTINEL_PROMPT_ATTACK,
    };

    fn item(text: &str) -> ScreenItem {
        ScreenItem::text(
            SegmentKey::for_text(b"org", LeafClass::User, text),
            LeafClass::User,
            text.to_string(),
        )
    }

    fn request<'a>(
        items: &'a [ScreenItem],
        wanted: &'a CodeSet,
        budget_ms: u64,
    ) -> ScreenRequest<'a> {
        ScreenRequest {
            correlation_id: "corr-1",
            direction: Direction::Inbound,
            tier: ScreenTier::Floor,
            items,
            wanted,
            deadline: Instant::now() + Duration::from_millis(budget_ms),
        }
    }

    fn qualify(backend: &TestBackend, codes: CodeSet) -> QualificationRecord {
        let r = &backend.descriptor().reference;
        QualificationRecord {
            backend_id: r.id.clone(),
            model: r.model.clone(),
            weights_sha256: r.weights_sha256.clone(),
            template_version: r.template_version,
            codes,
        }
    }

    fn policy_qualifying(backends: &[&TestBackend]) -> ChainPolicy {
        ChainPolicy {
            qualifications: backends
                .iter()
                .map(|b| qualify(b, CodeSet::from([TaxonomyId::S4, TaxonomyId::S9])))
                .collect(),
            ..ChainPolicy::default()
        }
    }

    #[tokio::test]
    async fn per_code_score_is_the_max_across_backends() {
        let a = Arc::new(TestBackend::new("a").fixed_score(TaxonomyId::S1, 0.3));
        let b = Arc::new(TestBackend::new("b").fixed_score(TaxonomyId::S1, 0.8));
        let chain = ScreenerChain::new(policy_qualifying(&[&a, &b]))
            .with_role(Role::TextHazard, vec![a.clone(), b.clone()]);
        let items = [item("benign text")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::S1), Some(0.8));
        assert_eq!(v.items[0].sources[&TaxonomyId::S1], "b");
        assert_eq!(
            v.items[0]
                .contributions
                .iter()
                .filter(|c| c.code == TaxonomyId::S1)
                .count(),
            2
        );
        assert!(v.undecided().is_empty());
        assert_eq!((a.calls(), b.calls()), (1, 1));
    }

    #[tokio::test]
    async fn sentinel_scores_reach_the_composed_item() {
        let a = Arc::new(TestBackend::new("a"));
        let chain = ScreenerChain::new(policy_qualifying(&[&a]))
            .with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item(&format!("x {SENTINEL_HAZARD_S9} y")), item("plain")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::S9), Some(1.0));
        assert_eq!(v.items[1].score(TaxonomyId::S9), Some(0.0));
        assert_eq!(v.max_score(TaxonomyId::S9), Some(1.0));
    }

    #[tokio::test]
    async fn unqualified_backend_never_decides_a_hard_code() {
        let a = Arc::new(TestBackend::new("a"));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item(SENTINEL_HAZARD_S9)];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        let it = &v.items[0];
        assert_eq!(it.score(TaxonomyId::S9), None);
        assert_eq!(it.unqualified_scores.get(&TaxonomyId::S9), Some(&1.0));
        assert!(
            it.decided.contains(TaxonomyId::S1),
            "soft codes still decided"
        );
        assert_eq!(
            v.undecided_hard(chain.policy()),
            CodeSet::from([TaxonomyId::S4, TaxonomyId::S9])
        );
    }

    #[tokio::test]
    async fn node_tier_is_never_bound_by_floor_qualification() {
        let a = Arc::new(TestBackend::new("node_guard"));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item(SENTINEL_HAZARD_S9)];
        let wanted = CodeSet::hazards();
        let node = ScreenRequest {
            tier: ScreenTier::Node,
            ..request(&items, &wanted, 500)
        };
        let v = chain.screen(Role::TextHazard, &node).await;
        assert_eq!(v.items[0].score(TaxonomyId::S9), Some(1.0));
        assert!(v.items[0].unqualified_scores.is_empty());
        assert!(v.undecided().is_empty());
        // The same backend and policy on floor traffic still needs a record.
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::S9), None);
        assert!(v.undecided_hard(chain.policy()).contains(TaxonomyId::S9));
    }

    #[tokio::test]
    async fn qualification_must_match_model_weights_and_template() {
        let a = TestBackend::new("a");
        let mut q = qualify(&a, CodeSet::from([TaxonomyId::S9]));
        let r = a.descriptor().reference.clone();
        let policy = ChainPolicy {
            qualifications: vec![q.clone()],
            ..ChainPolicy::default()
        };
        assert!(policy.qualified(&r, TaxonomyId::S9));
        assert!(!policy.qualified(&r, TaxonomyId::S4));
        q.template_version += 1;
        assert!(!ChainPolicy {
            qualifications: vec![q.clone()],
            ..ChainPolicy::default()
        }
        .qualified(&r, TaxonomyId::S9));
        q.template_version -= 1;
        q.weights_sha256 = Some("other".into());
        assert!(!ChainPolicy {
            qualifications: vec![q],
            ..ChainPolicy::default()
        }
        .qualified(&r, TaxonomyId::S9));
    }

    #[tokio::test]
    async fn s4_is_hard_even_when_the_policy_omits_it() {
        let policy = ChainPolicy {
            hard_codes: CodeSet::new(),
            ..ChainPolicy::default()
        };
        assert!(policy.is_hard(TaxonomyId::S4));
        assert!(!policy.is_hard(TaxonomyId::S9));
        assert!(policy.hard_set().contains(TaxonomyId::S4));
    }

    #[tokio::test]
    async fn remote_is_not_called_when_locals_decide() {
        let local = Arc::new(TestBackend::new("guard_text"));
        let remote = Arc::new(TestBackend::new("jev").locality(Locality::RemoteProcessor {
            processor_id: "typesafe".into(),
        }));
        let chain = ScreenerChain::new(policy_qualifying(&[&local, &remote]))
            .with_role(Role::TextHazard, vec![remote.clone(), local.clone()]);
        let items = [item("plain")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(remote.calls(), 0);
        assert!(v.processors.is_empty());
        assert!(v.undecided().is_empty());
    }

    #[tokio::test]
    async fn remote_sees_only_undecided_items_in_fallback_order() {
        // Local covers S9 for item 0 only: it fails item 1 by timing out on it.
        let local = Arc::new(
            TestBackend::new("guard_text")
                .covers(CodeSet::from([TaxonomyId::S9]))
                .fail_on("slow", BackendError::Unavailable("busy")),
        );
        let remote_a = Arc::new(
            TestBackend::new("jev")
                .covers(CodeSet::from([TaxonomyId::S9]))
                .locality(Locality::RemoteProcessor {
                    processor_id: "typesafe".into(),
                }),
        );
        let remote_b = Arc::new(
            TestBackend::new("other_remote")
                .covers(CodeSet::from([TaxonomyId::S9]))
                .locality(Locality::RemoteProcessor {
                    processor_id: "other".into(),
                }),
        );
        let chain = ScreenerChain::new(policy_qualifying(&[&local, &remote_a, &remote_b]))
            .with_role(
                Role::TextHazard,
                vec![local.clone(), remote_a.clone(), remote_b.clone()],
            );
        let items = [item("plain"), item("slow one")];
        let wanted = CodeSet::from([TaxonomyId::S9]);
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(remote_a.seen(), vec!["slow one".to_string()]);
        assert_eq!(
            remote_b.calls(),
            0,
            "second remote not needed once the first decided"
        );
        assert_eq!(v.processors, vec!["typesafe".to_string()]);
        assert!(v.undecided().is_empty());
        assert_eq!(v.items[1].sources[&TaxonomyId::S9], "jev");
    }

    #[tokio::test]
    async fn remote_failure_falls_through_to_the_next_remote() {
        let remote_a = Arc::new(
            TestBackend::new("jev")
                .covers(CodeSet::from([TaxonomyId::S9]))
                .locality(Locality::RemoteProcessor {
                    processor_id: "typesafe".into(),
                })
                .fail_always(BackendError::NotPermitted),
        );
        let remote_b = Arc::new(
            TestBackend::new("other_remote")
                .covers(CodeSet::from([TaxonomyId::S9]))
                .locality(Locality::RemoteProcessor {
                    processor_id: "other".into(),
                }),
        );
        let chain = ScreenerChain::new(policy_qualifying(&[&remote_a, &remote_b]))
            .with_role(Role::TextHazard, vec![remote_a.clone(), remote_b.clone()]);
        let items = [item("plain")];
        let wanted = CodeSet::from([TaxonomyId::S9]);
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.outcomes[0].error, Some(BackendError::NotPermitted));
        assert_eq!(v.outcomes[0].items_sent, 0, "NotPermitted sends nothing");
        assert_eq!(v.processors, vec!["other".to_string()]);
        assert!(v.undecided().is_empty());
    }

    #[tokio::test]
    async fn parallel_mode_calls_remote_alongside_locals() {
        let local = Arc::new(TestBackend::new("guard_text"));
        let remote = Arc::new(TestBackend::new("jev").locality(Locality::RemoteProcessor {
            processor_id: "typesafe".into(),
        }));
        let mut policy = policy_qualifying(&[&local, &remote]);
        policy.remote_mode = RemoteMode::Parallel;
        let chain = ScreenerChain::new(policy)
            .with_role(Role::TextHazard, vec![local.clone(), remote.clone()]);
        let items = [item("plain")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(remote.calls(), 1);
        assert_eq!(v.processors, vec!["typesafe".to_string()]);
    }

    #[tokio::test]
    async fn slow_backend_times_out_inside_the_deadline() {
        let slow = Arc::new(TestBackend::new("slow").delay(Duration::from_millis(2_000)));
        let chain = ScreenerChain::new(policy_qualifying(&[&slow]))
            .with_role(Role::TextHazard, vec![slow.clone()]);
        let items = [item(SENTINEL_HAZARD_S9)];
        let wanted = CodeSet::hazards();
        let started = Instant::now();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 100))
            .await;
        assert!(
            started.elapsed() < Duration::from_millis(1_000),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
        assert_eq!(v.undecided(), CodeSet::hazards());
        assert!(v.items[0].scores.is_empty());
    }

    #[tokio::test]
    async fn hard_timeout_bounds_the_call_below_the_deadline() {
        let slow = Arc::new(
            TestBackend::new("slow")
                .delay(Duration::from_millis(2_000))
                .hard_timeout_ms(50),
        );
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![slow]);
        let items = [item("x")];
        let wanted = CodeSet::hazards();
        let started = Instant::now();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 5_000))
            .await;
        assert!(started.elapsed() < Duration::from_millis(1_000));
        assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
    }

    #[tokio::test]
    async fn expired_deadline_never_calls_the_backend() {
        let a = Arc::new(TestBackend::new("a"));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item("x")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 0))
            .await;
        assert_eq!(a.calls(), 0);
        assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
    }

    #[tokio::test]
    async fn queued_call_fails_fast_when_the_gate_is_full() {
        let a = Arc::new(
            TestBackend::new("a")
                .delay(Duration::from_millis(300))
                .concurrency(1),
        );
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item("one"), item("two")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 150))
            .await;
        // Both chunks wait or run past 150 ms; neither may extend the deadline.
        assert_eq!(v.outcomes[0].error, Some(BackendError::Timeout));
        assert!(a.calls() <= 1, "the queued chunk never started");
    }

    #[tokio::test]
    async fn an_item_over_the_token_limit_is_left_undecided_and_never_sent() {
        let a = Arc::new(TestBackend::new("a").max_item_tokens(1024));
        let chain = ScreenerChain::new(policy_qualifying(&[&a]))
            .with_role(Role::TextHazard, vec![a.clone()]);
        // Dense text: about one token per character, far past 1,024.
        let dense = "\u{754c}".repeat(3000);
        let items = [item(&dense), item("short")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(a.calls(), 1, "only the item that fits is sent");
        assert_eq!(a.seen(), vec!["short".to_string()]);
        assert_eq!(
            v.items[0].undecided, wanted,
            "the oversize item is undecided"
        );
        assert!(v.items[1].undecided.is_empty());
        // Not a backend failure, so it can never open the breaker.
        assert_eq!(v.outcomes[0].error, None);
    }

    #[tokio::test]
    async fn one_fair_share_key_holds_at_most_half_the_backend_permits() {
        let a = Arc::new(
            TestBackend::new("a")
                .delay(Duration::from_millis(100))
                .concurrency(4),
        );
        let chain = ScreenerChain::new(policy_qualifying(&[&a]))
            .with_role(Role::TextHazard, vec![a.clone()]);
        let items: Vec<ScreenItem> = (0..6).map(|n| item(&format!("segment {n}"))).collect();
        let wanted = CodeSet::hazards();
        let started = Instant::now();
        let v = chain
            .screen_for(
                Role::TextHazard,
                &request(&items, &wanted, 5_000),
                Some([1; 32]),
            )
            .await;
        // Six calls through two permits are three waves; four permits would be two.
        assert!(started.elapsed() >= Duration::from_millis(295));
        assert!(v.undecided().is_empty());
    }

    #[tokio::test]
    async fn a_fan_out_does_not_queue_ahead_of_another_callers_request() {
        let a = Arc::new(
            TestBackend::new("a")
                .delay(Duration::from_millis(200))
                .concurrency(4),
        );
        let chain = Arc::new(
            ScreenerChain::new(policy_qualifying(&[&a]))
                .with_role(Role::TextHazard, vec![a.clone()]),
        );
        let wanted = CodeSet::hazards();
        let flood: Vec<ScreenItem> = (0..16).map(|n| item(&format!("flood {n}"))).collect();
        let victim = [item("victim")];
        let flood_request = request(&flood, &wanted, 5_000);
        let attacker = chain.screen_for(Role::TextHazard, &flood_request, Some([1; 32]));
        let bystander = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let started = Instant::now();
            let victim_request = request(&victim, &wanted, 5_000);
            let v = chain
                .screen_for(Role::TextHazard, &victim_request, Some([2; 32]))
                .await;
            (started.elapsed(), v)
        };
        let (_, (waited, v)) = tokio::join!(attacker, bystander);
        // The flood holds two of four permits, so the victim starts at once
        // (one 200 ms call). Behind a flood on the shared gate alone it would
        // wait a full wave first.
        assert!(waited < Duration::from_millis(350), "{waited:?}");
        assert!(v.undecided().is_empty());
    }

    #[tokio::test]
    async fn malformed_and_out_of_coverage_answers_are_rejected() {
        let bad = Arc::new(TestBackend::new("bad").report_outside_coverage());
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::TextHazard, vec![bad]);
        let items = [item("x")];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.outcomes[0].error, Some(BackendError::Malformed));
        assert_eq!(v.undecided(), CodeSet::hazards());
    }

    #[tokio::test]
    async fn one_failed_backend_leaves_the_other_deciding() {
        let down = Arc::new(TestBackend::new("down").fail_always(BackendError::Malformed));
        let up = Arc::new(TestBackend::new("up"));
        let chain = ScreenerChain::new(policy_qualifying(&[&down, &up]))
            .with_role(Role::TextHazard, vec![down, up]);
        let items = [item(SENTINEL_HAZARD_S1)];
        let wanted = CodeSet::hazards();
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert!(v.undecided().is_empty());
        assert_eq!(v.items[0].score(TaxonomyId::S1), Some(1.0));
        assert_eq!(v.outcomes.iter().filter(|o| o.error.is_some()).count(), 1);
    }

    #[tokio::test]
    async fn cache_hits_skip_the_backend_and_template_bumps_miss() {
        let cache = Arc::new(SegmentCache::default());
        let a = Arc::new(TestBackend::new("a"));
        let chain = ScreenerChain::new(policy_qualifying(&[&a]))
            .with_cache(cache.clone())
            .with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item(SENTINEL_HAZARD_S9)];
        let wanted = CodeSet::hazards();
        chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(a.calls(), 1);
        assert_eq!(v.outcomes[0].cache_hits, 1);
        assert!(v.items[0].contributions.iter().all(|c| c.from_cache));
        assert_eq!(v.items[0].score(TaxonomyId::S9), Some(1.0));

        // Same id, new template: a different cache scope, so a fresh call.
        let bumped = Arc::new(TestBackend::new("a").template_version(2));
        let chain = ScreenerChain::new(ChainPolicy::default())
            .with_cache(cache.clone())
            .with_role(Role::TextHazard, vec![bumped.clone()]);
        let misses_before = cache.stats().misses;
        chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(bumped.calls(), 1);
        assert!(cache.stats().misses > misses_before);
    }

    #[tokio::test]
    async fn failures_are_never_cached() {
        let cache = Arc::new(SegmentCache::default());
        let a = Arc::new(TestBackend::new("a").fail_always(BackendError::Unavailable("down")));
        let chain = ScreenerChain::new(ChainPolicy::default())
            .with_cache(cache.clone())
            .with_role(Role::TextHazard, vec![a]);
        let items = [item("x")];
        let wanted = CodeSet::hazards();
        chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(cache.stats().entries, 0);
    }

    #[tokio::test]
    async fn cached_score_loses_hard_authority_when_qualification_is_removed() {
        let cache = Arc::new(SegmentCache::default());
        let a = Arc::new(TestBackend::new("a"));
        let mut chain = ScreenerChain::new(policy_qualifying(&[&a]))
            .with_cache(cache)
            .with_role(Role::TextHazard, vec![a.clone()]);
        let items = [item(SENTINEL_HAZARD_S9)];
        let wanted = CodeSet::hazards();
        chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        chain.set_policy(ChainPolicy::default());
        let v = chain
            .screen(Role::TextHazard, &request(&items, &wanted, 500))
            .await;
        assert_eq!(a.calls(), 1, "served from cache");
        assert_eq!(v.items[0].score(TaxonomyId::S9), None);
        assert!(v.undecided_hard(chain.policy()).contains(TaxonomyId::S9));
    }

    #[tokio::test]
    async fn empty_role_leaves_everything_undecided() {
        let chain = ScreenerChain::new(ChainPolicy::default());
        let items = [item("x")];
        let wanted = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
        let v = chain
            .screen(Role::PromptAttack, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.undecided(), wanted);
        assert!(v.outcomes.is_empty());
    }

    #[tokio::test]
    async fn text_only_backend_skips_image_items() {
        let a = Arc::new(TestBackend::new("a"));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::Vision, vec![a.clone()]);
        let image = crate::backend::ScreenImage::new(vec![1u8, 2, 3], "image/png");
        let items = [ScreenItem::image(
            SegmentKey::for_image(b"org", LeafClass::User, &image.sha256),
            LeafClass::User,
            image,
        )];
        let wanted = CodeSet::from([TaxonomyId::S4]);
        let v = chain
            .screen(Role::Vision, &request(&items, &wanted, 500))
            .await;
        assert_eq!(a.calls(), 0);
        assert_eq!(v.undecided(), wanted);
    }

    #[tokio::test]
    async fn prompt_attack_role_scores_the_sentinel() {
        let a = Arc::new(TestBackend::new("a"));
        let chain =
            ScreenerChain::new(ChainPolicy::default()).with_role(Role::PromptAttack, vec![a]);
        let items = [item(SENTINEL_PROMPT_ATTACK)];
        let wanted = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
        let v = chain
            .screen(Role::PromptAttack, &request(&items, &wanted, 500))
            .await;
        assert_eq!(v.items[0].score(TaxonomyId::PROMPT_INJECTION), Some(1.0));
        assert!(v.undecided().is_empty());
    }

    #[test]
    fn coverage_requires_a_qualified_source_for_every_hard_code() {
        let qwen_like = Arc::new(
            TestBackend::new("qwen").covers(CodeSet::from([TaxonomyId::S1, TaxonomyId::S9])),
        );
        let chain = ScreenerChain::new(policy_qualifying(&[&qwen_like]))
            .with_role(Role::TextHazard, vec![qwen_like.clone()]);
        let err = chain.validate_coverage().unwrap_err();
        assert_eq!(err.uncovered, CodeSet::from([TaxonomyId::S4]));

        let full = Arc::new(TestBackend::new("guard"));
        let chain = ScreenerChain::new(ChainPolicy::default())
            .with_role(Role::TextHazard, vec![full.clone()]);
        let err = chain.validate_coverage().unwrap_err();
        assert_eq!(
            err.unqualified,
            CodeSet::from([TaxonomyId::S4, TaxonomyId::S9])
        );

        let chain =
            ScreenerChain::new(policy_qualifying(&[&full])).with_role(Role::TextHazard, vec![full]);
        assert!(chain.validate_coverage().is_ok());
    }
}
