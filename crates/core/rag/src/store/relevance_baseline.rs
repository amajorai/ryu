//! How similar clearly unrelated text looks to the current embedder.
//!
//! A similarity floor only means something on its embedder's own scale: the
//! built-in hashing embedder scores unrelated text near zero, while many hosted
//! models score it well above that. Callers that filter by relevance place their
//! floor above this baseline instead of using one raw cut for every embedder.
//! The baseline is measured once per embedder model from fixed probe pairs and
//! cached for the process; a failed measurement is not cached.

use super::*;

/// Pairs of sentences on unrelated topics. The two sides of a pair share no
/// word, so the hashing embedder's baseline is exactly zero.
pub(crate) const UNRELATED_PROBES: [(&str, &str); 8] = [
    (
        "Preheat the oven before baking sourdough bread",
        "Kubernetes pods restart after exceeding memory limits",
    ),
    (
        "Migratory geese fly south when autumn arrives",
        "Quarterly invoices require finance approval",
    ),
    (
        "The violinist rehearsed a Bach partita",
        "Replace worn brake pads on your bicycle",
    ),
    (
        "Volcanic eruptions release sulfur dioxide gas",
        "My nephew collects vintage baseball cards",
    ),
    (
        "Tax deductions for home office expenses",
        "Coral reefs bleach under warming oceans",
    ),
    (
        "Knit a wool scarf using circular needles",
        "Compilers translate source code into machine instructions",
    ),
    (
        "Marathon runners hydrate at regular intervals",
        "Medieval castles had moats and drawbridges",
    ),
    (
        "Tomato seedlings need plenty of sunlight",
        "Interest rates affect mortgage repayments",
    ),
];

/// A baseline is never placed above this, so every relevance level keeps some
/// range to separate matches from noise.
pub(crate) const MAX_UNRELATED_BASELINE: f32 = 0.9;

fn baselines() -> &'static StdMutex<HashMap<String, f32>> {
    static BASELINES: std::sync::OnceLock<StdMutex<HashMap<String, f32>>> =
        std::sync::OnceLock::new();
    BASELINES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn baseline_key(embedder: &Embedder) -> String {
    format!("{}:{}", embedder.model_id(), embedder.dims())
}

/// The highest similarity among the probe pairs, clamped to
/// `0.0..=MAX_UNRELATED_BASELINE`. Vectors come in pair order.
pub(crate) fn baseline_from_pairs(vectors: &[Vec<f32>]) -> f32 {
    let highest = vectors
        .chunks_exact(2)
        .map(|pair| cosine_similarity(&pair[0], &pair[1]))
        .filter(|score| score.is_finite())
        .fold(0.0_f32, f32::max);
    highest.clamp(0.0, MAX_UNRELATED_BASELINE)
}

/// Embed the probe pairs (one batch request for a remote embedder) and return
/// their baseline.
pub(crate) async fn measure_unrelated_baseline(embedder: &Embedder) -> Result<f32> {
    let texts: Vec<String> = UNRELATED_PROBES
        .iter()
        .flat_map(|(left, right)| [(*left).to_owned(), (*right).to_owned()])
        .collect();
    let vectors = embedder.embed_batch(&texts).await?;
    anyhow::ensure!(
        vectors.len() == texts.len(),
        "embedder returned {} vectors for {} probes",
        vectors.len(),
        texts.len()
    );
    Ok(baseline_from_pairs(&vectors))
}

impl RetrievalStore {
    /// The similarity this store's current embedder gives clearly unrelated
    /// text. Measured on first use per embedder model and then cached.
    pub async fn unrelated_similarity_baseline(&self) -> Result<f32> {
        let embedder = self.embedder_snapshot();
        let key = baseline_key(&embedder);
        if let Some(baseline) = baselines()
            .lock()
            .ok()
            .and_then(|cached| cached.get(&key).copied())
        {
            return Ok(baseline);
        }
        let baseline = measure_unrelated_baseline(&embedder).await?;
        if let Ok(mut cached) = baselines().lock() {
            cached.insert(key, baseline);
        }
        Ok(baseline)
    }
}

#[cfg(test)]
#[path = "relevance_baseline_tests.rs"]
mod tests;
