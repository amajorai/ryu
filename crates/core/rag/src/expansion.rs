//! Query expansion: multi-query rewriting and HyDE.
//!
//! Both techniques ask a language model to produce extra search text before
//! retrieval, then search with every variant and fuse the rankings by
//! reciprocal rank ([`crate::fuse_ranked_lists`]):
//!
//! - **Multi-query** asks for `n` alternative phrasings of the question, which
//!   recovers chunks that use different vocabulary from the user.
//! - **HyDE** (hypothetical document embeddings) asks for a short passage that
//!   would answer the question and searches with that passage; an answer-shaped
//!   text tends to sit closer to answer chunks in embedding space than the
//!   question does.
//!
//! The model call is behind [`QueryRewriter`], so this crate never talks to a
//! model provider itself: Core implements it over its governed Gateway side-model
//! call. Expansion fails open: when the rewriter errors or returns nothing usable,
//! the original query is still searched and the error is reported in
//! [`ExpandedQuery::warning`].

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Maximum number of alternative phrasings a caller may request.
pub const MAX_QUERY_VARIANTS: usize = 5;

/// Longest hypothetical document kept for HyDE, in characters.
pub const MAX_HYDE_CHARS: usize = 2_000;

/// A one-shot text completion used to rewrite queries.
#[async_trait::async_trait]
pub trait QueryRewriter: Send + Sync {
    /// Complete `user` under `system` and return the assistant text.
    async fn complete(&self, system: &str, user: &str) -> Result<String>;
}

/// Which expansions to run. Both are off by default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpansionOptions {
    /// Number of alternative phrasings to generate (`0` disables multi-query).
    #[serde(default)]
    pub multi_query: usize,
    /// Generate a hypothetical answer passage and search with it too.
    #[serde(default)]
    pub hyde: bool,
}

impl ExpansionOptions {
    /// `true` when no expansion is requested (no model call is made).
    pub fn is_noop(&self) -> bool {
        self.multi_query == 0 && !self.hyde
    }

    /// Reject a variant count above [`MAX_QUERY_VARIANTS`].
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.multi_query <= MAX_QUERY_VARIANTS,
            "multi_query must be at most {MAX_QUERY_VARIANTS}"
        );
        Ok(())
    }
}

/// The search texts an expansion produced.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpandedQuery {
    /// The original query first, then each distinct rewrite.
    pub queries: Vec<String>,
    /// The HyDE passage, when requested and produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hypothetical_document: Option<String>,
    /// Why an expansion was skipped (rewriter error or unusable output).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl ExpandedQuery {
    /// Every text to search with: the queries, then the HyDE passage.
    pub fn search_texts(&self) -> Vec<String> {
        let mut texts = self.queries.clone();
        if let Some(doc) = &self.hypothetical_document {
            texts.push(doc.clone());
        }
        texts
    }
}

/// The `(system, user)` prompt for `n` alternative phrasings.
pub fn multi_query_prompt(query: &str, n: usize) -> (String, String) {
    let system = format!(
        "You rewrite search queries for a document retrieval system. Produce {n} alternative \
         phrasings of the user's question that keep its meaning but vary the vocabulary, so a \
         keyword or embedding search finds relevant passages the original wording would miss. \
         Output exactly one query per line with no numbering, quotes, or commentary."
    );
    (system, query.trim().to_owned())
}

/// The `(system, user)` prompt for a HyDE passage.
pub fn hyde_prompt(query: &str) -> (String, String) {
    let system = "Write a short, factual-sounding passage (at most 120 words) that directly \
                  answers the question, as it might appear in a reference document. Do not \
                  mention the question, hedge, or add commentary; output only the passage."
        .to_owned();
    (system, query.trim().to_owned())
}

/// Parse a rewriter's reply into at most `n` distinct queries: one per line,
/// list markers and surrounding quotes stripped, blanks, duplicates and copies
/// of `original` dropped (case-insensitively), each capped at 500 characters.
pub fn parse_query_variants(raw: &str, original: &str, n: usize) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(normalize(original));
    let mut out = Vec::new();
    for line in raw.lines() {
        if out.len() >= n {
            break;
        }
        let cleaned = strip_list_marker(line.trim())
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '`')
            .trim();
        if cleaned.is_empty() {
            continue;
        }
        let cleaned: String = cleaned.chars().take(500).collect();
        if seen.insert(normalize(&cleaned)) {
            out.push(cleaned);
        }
    }
    out
}

fn normalize(text: &str) -> String {
    text.trim()
        .trim_end_matches(['?', '.', '!'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Strip `-`, `*`, `•`, `1.`, `1)` style list markers.
fn strip_list_marker(line: &str) -> &str {
    let without_bullet = line.trim_start_matches(['-', '*', '•']).trim_start();
    if without_bullet.len() != line.len() {
        return without_bullet;
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        if let Some(stripped) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
            return stripped.trim_start();
        }
    }
    line
}

/// Run the requested expansions for `query`. Never fails: a rewriter error
/// leaves only the original query and records the reason in `warning`.
pub async fn expand_query(
    rewriter: &dyn QueryRewriter,
    query: &str,
    opts: &ExpansionOptions,
) -> ExpandedQuery {
    let mut expanded = ExpandedQuery {
        queries: vec![query.to_owned()],
        ..Default::default()
    };
    let mut warnings = Vec::new();
    let n = opts.multi_query.min(MAX_QUERY_VARIANTS);
    if n > 0 {
        let (system, user) = multi_query_prompt(query, n);
        match rewriter.complete(&system, &user).await {
            Ok(raw) => {
                let variants = parse_query_variants(&raw, query, n);
                if variants.is_empty() {
                    warnings.push("multi-query expansion returned no usable rewrites".to_owned());
                }
                expanded.queries.extend(variants);
            }
            Err(error) => warnings.push(format!("multi-query expansion failed: {error:#}")),
        }
    }
    if opts.hyde {
        let (system, user) = hyde_prompt(query);
        match rewriter.complete(&system, &user).await {
            Ok(raw) => {
                let passage: String = raw.trim().chars().take(MAX_HYDE_CHARS).collect();
                if passage.is_empty() {
                    warnings.push("HyDE returned an empty passage".to_owned());
                } else {
                    expanded.hypothetical_document = Some(passage);
                }
            }
            Err(error) => warnings.push(format!("HyDE expansion failed: {error:#}")),
        }
    }
    if !warnings.is_empty() {
        expanded.warning = Some(warnings.join("; "));
    }
    expanded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Scripted {
        replies: Mutex<Vec<Result<String>>>,
        prompts: Mutex<Vec<String>>,
    }

    impl Scripted {
        fn new(replies: Vec<Result<String>>) -> Self {
            Self {
                replies: Mutex::new(replies),
                prompts: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl QueryRewriter for Scripted {
        async fn complete(&self, system: &str, _user: &str) -> Result<String> {
            self.prompts.lock().unwrap().push(system.to_owned());
            self.replies.lock().unwrap().remove(0)
        }
    }

    #[test]
    fn variants_are_cleaned_deduplicated_and_capped() {
        let raw = "1. How do I install Ryu?\n- \"Ryu setup steps\"\n* ryu setup steps\n\ninstall ryu\n2) Getting started with Ryu\nextra line";
        assert_eq!(
            parse_query_variants(raw, "Install Ryu?", 3),
            vec![
                "How do I install Ryu?",
                "Ryu setup steps",
                "Getting started with Ryu"
            ]
        );
    }

    #[tokio::test]
    async fn noop_options_make_no_model_call() {
        let rewriter = Scripted::new(Vec::new());
        let expanded = expand_query(&rewriter, "q", &ExpansionOptions::default()).await;
        assert_eq!(expanded.search_texts(), vec!["q"]);
        assert!(rewriter.prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn multi_query_and_hyde_both_contribute_search_texts() {
        let rewriter = Scripted::new(vec![
            Ok("alpha phrasing\nbeta phrasing".to_owned()),
            Ok("  A passage that answers.  ".to_owned()),
        ]);
        let expanded = expand_query(
            &rewriter,
            "original",
            &ExpansionOptions {
                multi_query: 2,
                hyde: true,
            },
        )
        .await;
        assert_eq!(
            expanded.search_texts(),
            vec![
                "original",
                "alpha phrasing",
                "beta phrasing",
                "A passage that answers."
            ]
        );
        assert!(expanded.warning.is_none());
        let prompts = rewriter.prompts.lock().unwrap();
        assert!(prompts[0].contains("2 alternative"));
        assert!(prompts[1].contains("passage"));
    }

    #[tokio::test]
    async fn rewriter_failure_fails_open_with_a_warning() {
        let rewriter = Scripted::new(vec![
            Err(anyhow::anyhow!("gateway unreachable")),
            Ok(String::new()),
        ]);
        let expanded = expand_query(
            &rewriter,
            "original",
            &ExpansionOptions {
                multi_query: 3,
                hyde: true,
            },
        )
        .await;
        assert_eq!(expanded.search_texts(), vec!["original"]);
        let warning = expanded.warning.unwrap();
        assert!(warning.contains("gateway unreachable"));
        assert!(warning.contains("HyDE"));
    }

    #[test]
    fn variant_count_is_bounded() {
        assert!(ExpansionOptions {
            multi_query: MAX_QUERY_VARIANTS + 1,
            hyde: false
        }
        .validate()
        .is_err());
    }
}
