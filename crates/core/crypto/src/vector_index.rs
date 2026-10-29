//! In-memory vector index for sealed embeddings.
//!
//! Embeddings are content: they are stored sealed (`RYU-CB01`) in ordinary
//! tables and exist in plaintext only here, in memory. Vectors are held as
//! **f16** (cosine scores accumulate in f32, so ranking changes are negligible)
//! in **partitions** (a Space, the message index, one retrieval collection).
//!
//! One process-wide budget ([`VectorBudget::global`], `RYU_VECTOR_CACHE_MB`,
//! default 256 MiB in total) is shared by every index. When a hydration does not
//! fit, the least-recently-used partitions of any index are evicted. A search on
//! a partition that is not hydrated returns `None`: the caller falls back to its
//! blind term index and rehydrates in the background. [`VectorIndex::coverage`]
//! reports `{hydrated, total, evicted_partitions}` so degraded semantic recall is
//! visible in the recall API and health, never silent.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use half::f16;

/// Env var holding the process-wide vector cache budget in MiB.
pub const VECTOR_CACHE_ENV: &str = "RYU_VECTOR_CACHE_MB";
/// Default process-wide vector cache budget in MiB.
pub const DEFAULT_VECTOR_CACHE_MB: u64 = 256;
/// Approximate fixed overhead per stored vector (id, norm, map entry).
const PER_VECTOR_OVERHEAD: usize = 64;

/// Coverage of one index, for the recall API and health.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct VectorCoverage {
    /// Vectors currently held in memory.
    pub hydrated: u64,
    /// Vectors the index knows exist (hydrated or not).
    pub total: u64,
    /// Partitions that were evicted (or refused) and are not hydrated now.
    pub evicted_partitions: u64,
}

struct StoredVector {
    id: String,
    values: Vec<f16>,
    norm: f32,
}

struct Partition {
    vectors: Vec<StoredVector>,
    positions: HashMap<String, usize>,
    bytes: usize,
    last_used: AtomicU64,
}

impl Partition {
    fn new() -> Self {
        Self {
            vectors: Vec::new(),
            positions: HashMap::new(),
            bytes: 0,
            last_used: AtomicU64::new(0),
        }
    }

    fn upsert(&mut self, id: &str, vector: &[f32]) -> isize {
        let stored = encode(id, vector);
        let size = vector_bytes(id, vector.len());
        if let Some(&position) = self.positions.get(id) {
            let old = vector_bytes(id, self.vectors[position].values.len());
            self.vectors[position] = stored;
            self.bytes = self.bytes + size - old;
            return size as isize - old as isize;
        }
        self.positions.insert(id.to_owned(), self.vectors.len());
        self.vectors.push(stored);
        self.bytes += size;
        size as isize
    }

    fn remove(&mut self, id: &str) -> usize {
        let Some(position) = self.positions.remove(id) else {
            return 0;
        };
        let removed = self.vectors.swap_remove(position);
        if position < self.vectors.len() {
            let moved = self.vectors[position].id.clone();
            self.positions.insert(moved, position);
        }
        let size = vector_bytes(&removed.id, removed.values.len());
        self.bytes -= size;
        size
    }
}

fn vector_bytes(id: &str, dims: usize) -> usize {
    dims * 2 + id.len() * 2 + PER_VECTOR_OVERHEAD
}

fn encode(id: &str, vector: &[f32]) -> StoredVector {
    let values: Vec<f16> = vector.iter().map(|v| f16::from_f32(*v)).collect();
    let norm = values
        .iter()
        .map(|v| {
            let v = v.to_f32();
            v * v
        })
        .sum::<f32>()
        .sqrt();
    StoredVector {
        id: id.to_owned(),
        values,
        norm,
    }
}

#[derive(Default)]
struct IndexMeta {
    totals: HashMap<String, u64>,
    evicted: HashSet<String>,
}

#[derive(Default)]
struct BudgetState {
    partitions: HashMap<(u64, String), Partition>,
    meta: HashMap<u64, IndexMeta>,
    used: usize,
}

/// A memory budget shared by vector indexes (one process-wide instance by
/// default; tests make their own).
pub struct VectorBudget {
    limit: usize,
    state: RwLock<BudgetState>,
    clock: AtomicU64,
    next_index: AtomicU64,
}

impl std::fmt::Debug for VectorBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VectorBudget")
            .field("limit", &self.limit)
            .field("used", &self.used_bytes())
            .finish()
    }
}

impl VectorBudget {
    /// A budget of `limit_bytes`.
    pub fn new(limit_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            limit: limit_bytes,
            state: RwLock::new(BudgetState::default()),
            clock: AtomicU64::new(1),
            next_index: AtomicU64::new(1),
        })
    }

    /// The process-wide budget: `RYU_VECTOR_CACHE_MB` MiB (default 256), read once.
    pub fn global() -> Arc<Self> {
        static GLOBAL: OnceLock<Arc<VectorBudget>> = OnceLock::new();
        GLOBAL
            .get_or_init(|| {
                let mb = std::env::var(VECTOR_CACHE_ENV)
                    .ok()
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .unwrap_or(DEFAULT_VECTOR_CACHE_MB);
                Self::new(usize::try_from(mb.saturating_mul(1024 * 1024)).unwrap_or(usize::MAX))
            })
            .clone()
    }

    /// The budget in bytes.
    pub fn limit_bytes(&self) -> usize {
        self.limit
    }

    /// Bytes currently held by every index sharing this budget.
    pub fn used_bytes(&self) -> usize {
        self.state.read().map(|state| state.used).unwrap_or(0)
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    /// Evict least-recently-used partitions (never `keep`) until `extra` more
    /// bytes fit. Returns whether they fit.
    fn make_room(&self, state: &mut BudgetState, extra: usize, keep: &(u64, String)) -> bool {
        while state.used + extra > self.limit {
            let victim = state
                .partitions
                .iter()
                .filter(|(key, _)| *key != keep)
                .min_by_key(|(_, partition)| partition.last_used.load(Ordering::Relaxed))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else {
                return false;
            };
            if let Some(partition) = state.partitions.remove(&victim) {
                state.used -= partition.bytes;
                state
                    .meta
                    .entry(victim.0)
                    .or_default()
                    .evicted
                    .insert(victim.1.clone());
                tracing::info!(
                    partition = %victim.1,
                    bytes = partition.bytes,
                    "vector cache: evicted a partition (it is served by the term index until rehydrated)"
                );
            }
        }
        true
    }
}

/// One named vector index (a store) over a shared [`VectorBudget`].
#[derive(Clone)]
pub struct VectorIndex {
    name: Arc<str>,
    id: u64,
    budget: Arc<VectorBudget>,
}

impl std::fmt::Debug for VectorIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VectorIndex")
            .field("name", &self.name)
            .field("coverage", &self.coverage())
            .finish()
    }
}

/// Why a hydration did not happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HydrateError {
    /// The partition alone is larger than the whole budget.
    LargerThanBudget {
        /// Bytes the partition needs.
        needed: usize,
        /// The budget in bytes.
        limit: usize,
    },
}

impl std::fmt::Display for HydrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LargerThanBudget { needed, limit } => write!(
                f,
                "vector partition needs {needed} bytes, more than the whole cache budget \
                 ({limit} bytes; raise {VECTOR_CACHE_ENV})"
            ),
        }
    }
}

impl std::error::Error for HydrateError {}

impl VectorIndex {
    /// A new index on the process-wide budget.
    pub fn new(name: &str) -> Self {
        Self::with_budget(name, VectorBudget::global())
    }

    /// A new index on an explicit budget.
    pub fn with_budget(name: &str, budget: Arc<VectorBudget>) -> Self {
        let id = budget.next_index.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut state) = budget.state.write() {
            state.meta.entry(id).or_default();
        }
        Self {
            name: name.into(),
            id,
            budget,
        }
    }

    /// The index name.
    pub fn name(&self) -> &str {
        &self.name
    }

    fn key(&self, partition: &str) -> (u64, String) {
        (self.id, partition.to_owned())
    }

    /// Replace a partition with `vectors` (opened from the sealed store),
    /// evicting least-recently-used partitions of any index if needed. `total`
    /// is how many vectors the partition really has (rows that did not open are
    /// not in `vectors`).
    pub fn hydrate_partition(
        &self,
        partition: &str,
        vectors: impl IntoIterator<Item = (String, Vec<f32>)>,
    ) -> Result<(), HydrateError> {
        let mut built = Partition::new();
        for (id, vector) in vectors {
            built.upsert(&id, &vector);
        }
        let count = built.vectors.len() as u64;
        built.last_used.store(self.budget.tick(), Ordering::Relaxed);
        let key = self.key(partition);
        let mut state = self.budget.state.write().expect("vector budget poisoned");
        if let Some(old) = state.partitions.remove(&key) {
            state.used -= old.bytes;
        }
        let meta = state.meta.entry(self.id).or_default();
        let total = meta.totals.entry(partition.to_owned()).or_insert(0);
        *total = (*total).max(count);
        if built.bytes > self.budget.limit {
            meta.evicted.insert(partition.to_owned());
            return Err(HydrateError::LargerThanBudget {
                needed: built.bytes,
                limit: self.budget.limit,
            });
        }
        let needed = built.bytes;
        self.budget.make_room(&mut state, needed, &key);
        state.used += needed;
        state.partitions.insert(key, built);
        state
            .meta
            .entry(self.id)
            .or_default()
            .evicted
            .remove(partition);
        Ok(())
    }

    /// Record how many vectors a partition has without hydrating it (so
    /// coverage reports what is missing).
    pub fn set_partition_total(&self, partition: &str, total: u64) {
        if let Ok(mut state) = self.budget.state.write() {
            state
                .meta
                .entry(self.id)
                .or_default()
                .totals
                .insert(partition.to_owned(), total);
        }
    }

    /// Whether `partition` is in memory.
    pub fn is_hydrated(&self, partition: &str) -> bool {
        self.budget
            .state
            .read()
            .map(|state| state.partitions.contains_key(&self.key(partition)))
            .unwrap_or(false)
    }

    /// Insert or replace one vector in a hydrated partition (a no-op returning
    /// `false` when the partition is not hydrated; it is read from the sealed
    /// store on the next hydration).
    pub fn upsert(&self, partition: &str, id: &str, vector: &[f32]) -> bool {
        let key = self.key(partition);
        let mut state = self.budget.state.write().expect("vector budget poisoned");
        let Some(target) = state.partitions.get_mut(&key) else {
            return false;
        };
        let existed = target.positions.contains_key(id);
        let delta = target.upsert(id, vector);
        target
            .last_used
            .store(self.budget.tick(), Ordering::Relaxed);
        state.used = (state.used as isize + delta) as usize;
        if !existed {
            let meta = state.meta.entry(self.id).or_default();
            *meta.totals.entry(partition.to_owned()).or_insert(0) += 1;
        }
        if state.used > self.budget.limit {
            self.budget.make_room(&mut state, 0, &key);
        }
        true
    }

    /// Remove one vector (from memory and from the partition's total).
    pub fn remove(&self, partition: &str, id: &str) {
        let key = self.key(partition);
        if let Ok(mut state) = self.budget.state.write() {
            let removed = state
                .partitions
                .get_mut(&key)
                .map(|target| target.remove(id))
                .unwrap_or(0);
            state.used -= removed;
            if removed > 0 {
                let meta = state.meta.entry(self.id).or_default();
                if let Some(total) = meta.totals.get_mut(partition) {
                    *total = total.saturating_sub(1);
                }
            }
        }
    }

    /// Drop a partition entirely (for example a deleted Space).
    pub fn drop_partition(&self, partition: &str) {
        let key = self.key(partition);
        if let Ok(mut state) = self.budget.state.write() {
            if let Some(old) = state.partitions.remove(&key) {
                state.used -= old.bytes;
            }
            let meta = state.meta.entry(self.id).or_default();
            meta.totals.remove(partition);
            meta.evicted.remove(partition);
        }
    }

    /// Cosine top-`k` over one partition, or `None` when it is not hydrated
    /// (the caller serves the query from its term index and rehydrates).
    pub fn search(&self, partition: &str, query: &[f32], k: usize) -> Option<Vec<(String, f32)>> {
        let state = self.budget.state.read().ok()?;
        let target = state.partitions.get(&self.key(partition))?;
        target
            .last_used
            .store(self.budget.tick(), Ordering::Relaxed);
        Some(top_k(target, query, k, &|_| true))
    }

    /// [`Self::search`] over only the vectors whose id `keep` accepts (a
    /// scoped search), still returning at most `k`: candidates outside the
    /// scope are skipped before ranking, so no id is cloned for them.
    pub fn search_filtered(
        &self,
        partition: &str,
        query: &[f32],
        k: usize,
        keep: &dyn Fn(&str) -> bool,
    ) -> Option<Vec<(String, f32)>> {
        let state = self.budget.state.read().ok()?;
        let target = state.partitions.get(&self.key(partition))?;
        target
            .last_used
            .store(self.budget.tick(), Ordering::Relaxed);
        Some(top_k(target, query, k, keep))
    }

    /// This index's coverage across its partitions.
    pub fn coverage(&self) -> VectorCoverage {
        let Ok(state) = self.budget.state.read() else {
            return VectorCoverage::default();
        };
        let hydrated = state
            .partitions
            .iter()
            .filter(|((index, _), _)| *index == self.id)
            .map(|(_, partition)| partition.vectors.len() as u64)
            .sum();
        let (total, evicted) = state
            .meta
            .get(&self.id)
            .map(|meta| (meta.totals.values().sum(), meta.evicted.len() as u64))
            .unwrap_or((0, 0));
        VectorCoverage {
            hydrated,
            total: u64::max(total, hydrated),
            evicted_partitions: evicted,
        }
    }
}

fn top_k(
    partition: &Partition,
    query: &[f32],
    k: usize,
    keep: &dyn Fn(&str) -> bool,
) -> Vec<(String, f32)> {
    if k == 0 {
        return Vec::new();
    }
    let query_norm = query.iter().map(|v| v * v).sum::<f32>().sqrt();
    let mut scored: Vec<(f32, usize)> = partition
        .vectors
        .iter()
        .enumerate()
        .filter(|(_, stored)| stored.values.len() == query.len() && keep(&stored.id))
        .map(|(position, stored)| {
            let dot: f32 = stored
                .values
                .iter()
                .zip(query)
                .map(|(v, q)| v.to_f32() * q)
                .sum();
            let denominator = stored.norm * query_norm;
            let score = if denominator > 0.0 {
                dot / denominator
            } else {
                0.0
            };
            (score, position)
        })
        .collect();
    let k = k.min(scored.len());
    if k == 0 {
        return Vec::new();
    }
    scored.select_nth_unstable_by(k - 1, |a, b| b.0.total_cmp(&a.0));
    scored.truncate(k);
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored
        .into_iter()
        .map(|(score, position)| (partition.vectors[position].id.clone(), score))
        .collect()
}

/// A bounded best-`k` collector for scoring vectors that are streamed (for
/// example opened row by row from a sealed store too large for the cache):
/// memory stays `O(k)` whatever the number of candidates.
pub struct TopK {
    k: usize,
    heap: std::collections::BinaryHeap<std::cmp::Reverse<Scored>>,
}

struct Scored(f32, String);

impl PartialEq for Scored {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_cmp(&other.0).is_eq()
    }
}
impl Eq for Scored {}
impl PartialOrd for Scored {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Scored {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl TopK {
    /// A collector keeping the `k` highest scores.
    pub fn new(k: usize) -> Self {
        Self {
            k,
            heap: std::collections::BinaryHeap::with_capacity(k.min(4096) + 1),
        }
    }

    /// Whether a candidate with `score` would be kept (check before building
    /// its id).
    pub fn accepts(&self, score: f32) -> bool {
        if self.k == 0 {
            return false;
        }
        self.heap.len() < self.k
            || self
                .heap
                .peek()
                .is_some_and(|lowest| score.total_cmp(&lowest.0 .0).is_gt())
    }

    /// Offer one candidate.
    pub fn push(&mut self, id: String, score: f32) {
        if !self.accepts(score) {
            return;
        }
        if self.heap.len() == self.k {
            self.heap.pop();
        }
        self.heap.push(std::cmp::Reverse(Scored(score, id)));
    }

    /// The kept candidates, best first.
    pub fn into_sorted(self) -> Vec<(String, f32)> {
        let mut out: Vec<(String, f32)> = self
            .heap
            .into_iter()
            .map(|std::cmp::Reverse(Scored(score, id))| (id, score))
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_k_keeps_the_best_scores_in_bounded_memory() {
        let mut top = TopK::new(3);
        for (i, score) in [0.1, 0.9, 0.5, 0.7, 0.2, 0.95].into_iter().enumerate() {
            top.push(format!("v{i}"), score);
        }
        assert!(!top.accepts(0.6));
        let kept = top.into_sorted();
        assert_eq!(
            kept.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            ["v5", "v1", "v3"]
        );
        assert!(TopK::new(0).into_sorted().is_empty());
    }

    #[test]
    fn filtered_search_ranks_only_the_scope() {
        let index = VectorIndex::with_budget("t", VectorBudget::new(1 << 20));
        index
            .hydrate_partition("p", (0..8).map(|i| (format!("v{i}"), unit(8, i))))
            .unwrap();
        let hits = index
            .search_filtered("p", &unit(8, 3), 2, &|id| id != "v3" && id != "v4")
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|(id, _)| id != "v3" && id != "v4"));
    }

    fn unit(dims: usize, hot: usize) -> Vec<f32> {
        let mut v = vec![0.01; dims];
        v[hot] = 1.0;
        v
    }

    #[test]
    fn search_ranks_by_cosine_with_f16_storage() {
        let index = VectorIndex::with_budget("t", VectorBudget::new(1 << 20));
        index
            .hydrate_partition("p", (0..8).map(|i| (format!("v{i}"), unit(8, i))))
            .unwrap();
        let hits = index.search("p", &unit(8, 3), 3).unwrap();
        assert_eq!(hits[0].0, "v3");
        assert!(hits[0].1 > 0.99);
        assert_eq!(hits.len(), 3);
        assert!(index.search("missing", &unit(8, 3), 3).is_none());
    }

    #[test]
    fn the_shared_budget_evicts_least_recently_used_partitions_across_indexes() {
        let per_partition = 10 * vector_bytes("v0", 64);
        let budget = VectorBudget::new(per_partition * 2 + per_partition / 2);
        let a = VectorIndex::with_budget("a", budget.clone());
        let b = VectorIndex::with_budget("b", budget.clone());
        let fill = |index: &VectorIndex, partition: &str| {
            index
                .hydrate_partition(partition, (0..10).map(|i| (format!("v{i}"), unit(64, i))))
                .unwrap();
        };
        fill(&a, "one");
        fill(&b, "two");
        // Touch "one" so "two" is the least recently used.
        assert!(a.search("one", &unit(64, 1), 1).is_some());
        fill(&a, "three");
        assert!(a.is_hydrated("one"));
        assert!(!b.is_hydrated("two"));
        assert!(a.is_hydrated("three"));
        assert!(budget.used_bytes() <= budget.limit_bytes());
        assert_eq!(
            b.coverage(),
            VectorCoverage {
                hydrated: 0,
                total: 10,
                evicted_partitions: 1
            }
        );
        assert_eq!(a.coverage().hydrated, 20);
        // Rehydrating clears the eviction mark.
        fill(&b, "two");
        assert_eq!(b.coverage().evicted_partitions, 0);
    }

    #[test]
    fn a_partition_larger_than_the_budget_is_refused_and_reported() {
        let index = VectorIndex::with_budget("t", VectorBudget::new(100));
        let error = index
            .hydrate_partition("big", (0..10).map(|i| (format!("v{i}"), unit(64, i))))
            .unwrap_err();
        assert!(matches!(error, HydrateError::LargerThanBudget { .. }));
        assert_eq!(index.coverage().evicted_partitions, 1);
        assert_eq!(index.coverage().total, 10);
    }

    #[test]
    fn upsert_and_remove_keep_accounting_consistent() {
        let budget = VectorBudget::new(1 << 20);
        let index = VectorIndex::with_budget("t", budget.clone());
        index.hydrate_partition("p", Vec::new()).unwrap();
        assert!(index.upsert("p", "a", &unit(4, 0)));
        assert!(index.upsert("p", "b", &unit(4, 1)));
        assert!(index.upsert("p", "a", &unit(4, 2)));
        assert_eq!(index.coverage().hydrated, 2);
        assert_eq!(index.coverage().total, 2);
        assert_eq!(index.search("p", &unit(4, 2), 1).unwrap()[0].0, "a");
        index.remove("p", "a");
        assert_eq!(index.coverage().hydrated, 1);
        index.drop_partition("p");
        assert_eq!(budget.used_bytes(), 0);
        assert!(!index.upsert("p", "c", &unit(4, 0)));
    }
}
