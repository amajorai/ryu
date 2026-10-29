//! Hybrid lexical + vector retrieval helpers.
//!
//! Hybrid search runs a BM25 keyword search (SQLite FTS5) and a vector search
//! over the same corpus and fuses the two rankings. A BM25 score and a vector
//! distance live on unrelated scales, so the fusion is by rank, not by score:
//! weighted reciprocal rank fusion,
//!
//! ```text
//! score(d) = alpha / (K + rank_vector(d)) + (1 - alpha) / (K + rank_keyword(d))
//! ```
//!
//! with the same `K = 60` as [`crate::fuse_ranked_lists`]. `alpha = 1` is pure
//! vector order, `alpha = 0` pure keyword order, and the default `0.5` weights
//! both lists equally. A list whose weight is zero contributes nothing, so its
//! hits cannot leak into the result.

use serde::{Deserialize, Serialize};

/// Reciprocal-rank-fusion constant shared with [`crate::fuse_ranked_lists`].
pub const RRF_K: f32 = 60.0;

/// Default vector weight of a hybrid search.
pub const DEFAULT_HYBRID_ALPHA: f32 = 0.5;

fn default_alpha() -> f32 {
    DEFAULT_HYBRID_ALPHA
}

/// Hybrid search knobs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HybridOptions {
    /// Weight of the vector ranking in `[0, 1]`; the keyword ranking gets
    /// `1 - alpha`.
    #[serde(default = "default_alpha")]
    pub alpha: f32,
}

impl Default for HybridOptions {
    fn default() -> Self {
        Self {
            alpha: DEFAULT_HYBRID_ALPHA,
        }
    }
}

impl HybridOptions {
    /// Reject a non-finite or out-of-range alpha.
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.alpha.is_finite() && (0.0..=1.0).contains(&self.alpha),
            "alpha must be between 0 and 1"
        );
        Ok(())
    }
}

/// Turn arbitrary text into a safe FTS5 `MATCH` expression, or `None` when no
/// usable term remains. Splitting on every non-alphanumeric character strips all
/// FTS5 syntax (column filters, prefixes, quotes, `NEAR`) and matches how the
/// default `unicode61` tokenizer split the stored text; each term is quoted so it
/// is a literal, and the terms are OR-ed so BM25 ranks by how many (and how rare)
/// terms a chunk contains. At most 64 terms are kept.
pub fn fts5_match_expression(raw: &str) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let terms: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .filter(|t| seen.insert(t.clone()))
        .take(64)
        .map(|t| format!("\"{t}\""))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(" OR "))
}

/// Map an FTS5 `bm25()` value (more negative is better) to a relevance in
/// `[0, 1)`, higher is better. Monotonic, so it preserves BM25 order.
pub fn bm25_to_relevance(bm25: f64) -> f32 {
    let strength = (-bm25).max(0.0) as f32;
    strength / (1.0 + strength)
}

/// Weighted reciprocal rank fusion. Each list is best-first and paired with its
/// weight; `key` identifies an item across lists. Returns at most `top_k` items
/// with their fused score, best first. Ties break by the best (list, rank) the
/// item reached, then by key, so the output is deterministic.
pub fn weighted_rrf<T>(
    lists: Vec<(f32, Vec<T>)>,
    key: impl Fn(&T) -> String,
    top_k: usize,
) -> Vec<(T, f32)> {
    struct Row<T> {
        item: T,
        key: String,
        score: f32,
        best: (usize, usize),
    }
    let mut rows: Vec<Row<T>> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (list_idx, (weight, list)) in lists.into_iter().enumerate() {
        if weight <= 0.0 {
            continue;
        }
        for (rank, item) in list.into_iter().enumerate() {
            let contribution = weight / (RRF_K + rank as f32);
            let id = key(&item);
            match index.get(&id) {
                Some(&at) => {
                    let row = &mut rows[at];
                    row.score += contribution;
                    row.best = row.best.min((list_idx, rank));
                }
                None => {
                    index.insert(id.clone(), rows.len());
                    rows.push(Row {
                        item,
                        key: id,
                        score: contribution,
                        best: (list_idx, rank),
                    });
                }
            }
        }
    }
    rows.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.best.cmp(&b.best))
            .then_with(|| a.key.cmp(&b.key))
    });
    rows.truncate(top_k);
    rows.into_iter().map(|row| (row.item, row.score)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(fused: &[(&str, f32)]) -> Vec<String> {
        fused.iter().map(|(id, _)| (*id).to_owned()).collect()
    }

    #[test]
    fn match_expression_is_quoted_deduplicated_and_safe() {
        assert_eq!(
            fts5_match_expression("Rust: \"NEAR\"(rust) col:x*").as_deref(),
            Some("\"rust\" OR \"near\" OR \"col\" OR \"x\"")
        );
        assert_eq!(fts5_match_expression("  !!  "), None);
    }

    #[test]
    fn alpha_extremes_reproduce_a_single_ranking() {
        let vector = vec!["a", "b", "c"];
        let keyword = vec!["c", "d"];
        let only_vector = weighted_rrf(
            vec![(1.0, vector.clone()), (0.0, keyword.clone())],
            |s| (*s).to_owned(),
            10,
        );
        assert_eq!(ids(&only_vector), vec!["a", "b", "c"]);
        let only_keyword =
            weighted_rrf(vec![(0.0, vector), (1.0, keyword)], |s| (*s).to_owned(), 10);
        assert_eq!(ids(&only_keyword), vec!["c", "d"]);
    }

    #[test]
    fn a_hit_in_both_lists_outranks_single_list_hits() {
        let fused = weighted_rrf(
            vec![(0.5, vec!["a", "shared"]), (0.5, vec!["k", "shared"])],
            |s| (*s).to_owned(),
            3,
        );
        assert_eq!(fused[0].0, "shared");
        assert_eq!(ids(&fused), vec!["shared", "a", "k"]);
    }

    #[test]
    fn alpha_tilts_toward_the_heavier_list() {
        let fused = weighted_rrf(
            vec![(0.8, vec!["v1", "v2"]), (0.2, vec!["k1", "k2"])],
            |s| (*s).to_owned(),
            4,
        );
        assert_eq!(ids(&fused), vec!["v1", "v2", "k1", "k2"]);
    }

    #[test]
    fn bm25_relevance_is_monotonic() {
        assert!(bm25_to_relevance(-5.0) > bm25_to_relevance(-1.0));
        assert_eq!(bm25_to_relevance(2.0), 0.0);
    }

    #[test]
    fn alpha_validation() {
        assert!(HybridOptions { alpha: 0.3 }.validate().is_ok());
        assert!(HybridOptions { alpha: 1.5 }.validate().is_err());
        assert!(HybridOptions { alpha: f32::NAN }.validate().is_err());
    }
}
