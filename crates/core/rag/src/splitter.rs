//! Text splitters: turn a document into retrievable chunks.
//!
//! Five strategies share one [`ChunkingStrategy`] contract so a Space (or any
//! other corpus) can choose how its documents are cut without the ingest path
//! knowing which one is active:
//!
//! - [`ChunkingStrategy::Default`] — the historical behaviour: paragraphs packed
//!   word-by-word up to [`DEFAULT_CHUNK_CHARS`] characters with no overlap, and
//!   any single word longer than that cut on character boundaries. Every corpus
//!   that has not opted into another strategy keeps producing byte-identical
//!   chunks.
//! - [`ChunkingStrategy::Recursive`] — the recursive character splitter: try the
//!   coarsest separator first (`"\n\n"`, then `"\n"`, `". "`, `" "`, then single
//!   characters), recurse into any piece that is still too long, and pack the
//!   pieces into windows of `chunk_size` characters that overlap by
//!   `chunk_overlap`.
//! - [`ChunkingStrategy::Markdown`] — header-aware: the document is first cut at
//!   ATX headers (`#` … `######`, ignoring `#` lines inside fenced code), each
//!   section is split recursively, and every chunk carries the header path it sits
//!   under in [`ChunkMetadata::header_path`].
//! - [`ChunkingStrategy::Token`] — the recursive splitter measured in tokens
//!   instead of characters. No BPE tokenizer is linked into Core, so the count is
//!   [`approx_token_count`], a deterministic approximation of a GPT-style BPE
//!   (about four characters per token for words, one token per punctuation mark).
//!   It is meant to keep chunks inside a model's window, not to match a specific
//!   tokenizer exactly.
//! - [`ChunkingStrategy::Semantic`] — embedding-distance breakpoints: sentences are
//!   embedded (with `buffer_size` neighbours on each side for context) through the
//!   corpus's own [`Embedder`], and a chunk boundary is placed wherever the cosine
//!   distance between consecutive sentences exceeds the `breakpoint_percentile`
//!   of all such distances. Oversized groups are then split recursively so no
//!   chunk exceeds `max_chunk_size`.
//!
//! The synchronous strategies are pure functions ([`split_text`]); only the
//! semantic strategy needs an embedder ([`split_text_with_embedder`]).

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::Embedder;

/// Chunk size of the historical (default) splitter, in characters.
pub const DEFAULT_CHUNK_CHARS: usize = 1_000;

/// Upper bound on any configured chunk size (characters or tokens). Large enough
/// for long-context embedders, small enough that a mistyped value cannot produce a
/// single multi-megabyte chunk.
pub const MAX_CHUNK_SIZE: usize = 32_000;

/// Separators the recursive splitter tries, coarsest first. The empty string is
/// the final fallback and means "split between characters".
pub const DEFAULT_SEPARATORS: &[&str] = &["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];

/// Separators the markdown splitter uses inside a section: code fences and
/// horizontal rules before the generic hierarchy.
const MARKDOWN_SEPARATORS: &[&str] = &[
    "\n```", "\n~~~", "\n---\n", "\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", "",
];

/// Maximum number of sentences the semantic splitter embeds for one document.
/// Above this the document is split recursively instead, so one huge upload
/// cannot turn into thousands of embedding calls.
pub const MAX_SEMANTIC_SENTENCES: usize = 2_048;

fn default_chunk_size() -> usize {
    DEFAULT_CHUNK_CHARS
}

fn default_chunk_overlap() -> usize {
    200
}

fn default_token_chunk_size() -> usize {
    256
}

fn default_token_chunk_overlap() -> usize {
    32
}

fn default_true() -> bool {
    true
}

fn default_breakpoint_percentile() -> f32 {
    95.0
}

fn default_buffer_size() -> usize {
    1
}

fn default_semantic_max_chunk_size() -> usize {
    2_000
}

/// How a corpus cuts documents into chunks. Serialized with a `strategy` tag:
/// `{"strategy":"recursive","chunk_size":800,"chunk_overlap":100}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum ChunkingStrategy {
    /// Historical behaviour: word packing at [`DEFAULT_CHUNK_CHARS`] characters,
    /// no overlap.
    #[default]
    Default,
    /// Recursive character splitting over a separator hierarchy.
    Recursive {
        #[serde(default = "default_chunk_size")]
        chunk_size: usize,
        #[serde(default = "default_chunk_overlap")]
        chunk_overlap: usize,
        /// Custom separator hierarchy, coarsest first. `None` uses
        /// [`DEFAULT_SEPARATORS`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        separators: Option<Vec<String>>,
    },
    /// Markdown-header-aware splitting; chunks carry their header path.
    Markdown {
        #[serde(default = "default_chunk_size")]
        chunk_size: usize,
        #[serde(default = "default_chunk_overlap")]
        chunk_overlap: usize,
        /// Prefix each chunk with its header breadcrumb (`Guide > Install`) so the
        /// chunk is self-describing for the embedder. Defaults to `true`.
        #[serde(default = "default_true")]
        include_header_path: bool,
    },
    /// Recursive splitting measured in (approximate) tokens.
    Token {
        #[serde(default = "default_token_chunk_size")]
        chunk_size: usize,
        #[serde(default = "default_token_chunk_overlap")]
        chunk_overlap: usize,
    },
    /// Embedding-distance breakpoints between sentences.
    Semantic {
        /// Distances above this percentile (0–100) of all consecutive-sentence
        /// distances start a new chunk.
        #[serde(default = "default_breakpoint_percentile")]
        breakpoint_percentile: f32,
        /// Neighbouring sentences on each side joined in when embedding a
        /// sentence, which smooths single-sentence noise.
        #[serde(default = "default_buffer_size")]
        buffer_size: usize,
        /// Hard ceiling on a chunk's length in characters.
        #[serde(default = "default_semantic_max_chunk_size")]
        max_chunk_size: usize,
    },
}

impl ChunkingStrategy {
    /// Reject configurations that cannot produce sensible chunks: a zero or
    /// absurd size, an overlap that is not smaller than the chunk, or an
    /// out-of-range percentile.
    pub fn validate(&self) -> Result<()> {
        let check_size = |size: usize, overlap: usize| -> Result<()> {
            anyhow::ensure!(
                (1..=MAX_CHUNK_SIZE).contains(&size),
                "chunk_size must be between 1 and {MAX_CHUNK_SIZE}"
            );
            anyhow::ensure!(
                overlap < size,
                "chunk_overlap ({overlap}) must be smaller than chunk_size ({size})"
            );
            Ok(())
        };
        match self {
            Self::Default => Ok(()),
            Self::Recursive {
                chunk_size,
                chunk_overlap,
                separators,
            } => {
                check_size(*chunk_size, *chunk_overlap)?;
                if let Some(separators) = separators {
                    anyhow::ensure!(
                        !separators.is_empty() && separators.len() <= 32,
                        "separators must list between 1 and 32 entries"
                    );
                }
                Ok(())
            }
            Self::Markdown {
                chunk_size,
                chunk_overlap,
                ..
            }
            | Self::Token {
                chunk_size,
                chunk_overlap,
            } => check_size(*chunk_size, *chunk_overlap),
            Self::Semantic {
                breakpoint_percentile,
                buffer_size,
                max_chunk_size,
            } => {
                anyhow::ensure!(
                    breakpoint_percentile.is_finite()
                        && (0.0..=100.0).contains(breakpoint_percentile),
                    "breakpoint_percentile must be between 0 and 100"
                );
                anyhow::ensure!(*buffer_size <= 8, "buffer_size must be at most 8");
                check_size(*max_chunk_size, 0)
            }
        }
    }

    /// `true` for the one strategy that needs an embedder.
    pub fn needs_embedder(&self) -> bool {
        matches!(self, Self::Semantic { .. })
    }
}

/// Metadata the splitter attaches to one chunk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkMetadata {
    /// Position of the chunk in its document, 0-based.
    pub index: usize,
    /// Markdown headers above this chunk, outermost first. Empty for
    /// non-markdown strategies and for text before the first header.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_path: Vec<String>,
    /// Approximate token count of the chunk ([`approx_token_count`]).
    pub token_count: usize,
}

impl ChunkMetadata {
    /// The metadata as a JSON object for storage alongside the chunk.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

/// One chunk produced by a splitter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextChunk {
    pub content: String,
    pub metadata: ChunkMetadata,
}

/// Split `text` with a synchronous strategy. The semantic strategy needs an
/// embedder; given here it degrades to recursive splitting at its
/// `max_chunk_size` (use [`split_text_with_embedder`] for real breakpoints).
///
/// Every strategy returns at least one chunk: blank input yields a single empty
/// chunk, matching the historical splitter so a document always has a row.
pub fn split_text(text: &str, strategy: &ChunkingStrategy) -> Vec<TextChunk> {
    let pieces: Vec<(String, Vec<String>)> = match strategy {
        ChunkingStrategy::Default => legacy_word_chunks(text, DEFAULT_CHUNK_CHARS)
            .into_iter()
            .map(|chunk| (chunk, Vec::new()))
            .collect(),
        ChunkingStrategy::Recursive {
            chunk_size,
            chunk_overlap,
            separators,
        } => {
            let owned: Vec<&str> = match separators {
                Some(list) => list.iter().map(String::as_str).collect(),
                None => DEFAULT_SEPARATORS.to_vec(),
            };
            split_recursive(text, &owned, *chunk_size, *chunk_overlap, &char_len)
                .into_iter()
                .map(|chunk| (chunk, Vec::new()))
                .collect()
        }
        ChunkingStrategy::Markdown {
            chunk_size,
            chunk_overlap,
            include_header_path,
        } => split_markdown(text, *chunk_size, *chunk_overlap, *include_header_path),
        ChunkingStrategy::Token {
            chunk_size,
            chunk_overlap,
        } => split_recursive(
            text,
            DEFAULT_SEPARATORS,
            *chunk_size,
            *chunk_overlap,
            &approx_token_count,
        )
        .into_iter()
        .map(|chunk| (chunk, Vec::new()))
        .collect(),
        ChunkingStrategy::Semantic { max_chunk_size, .. } => {
            split_recursive(text, DEFAULT_SEPARATORS, *max_chunk_size, 0, &char_len)
                .into_iter()
                .map(|chunk| (chunk, Vec::new()))
                .collect()
        }
    };
    finish(pieces)
}

/// Split `text` with any strategy, embedding sentences through `embedder` when
/// the strategy is [`ChunkingStrategy::Semantic`]. Non-semantic strategies never
/// touch the embedder.
pub async fn split_text_with_embedder(
    text: &str,
    strategy: &ChunkingStrategy,
    embedder: &Embedder,
) -> Result<Vec<TextChunk>> {
    let ChunkingStrategy::Semantic {
        breakpoint_percentile,
        buffer_size,
        max_chunk_size,
    } = strategy
    else {
        return Ok(split_text(text, strategy));
    };
    let sentences = split_sentences(text);
    if sentences.len() <= 1 || sentences.len() > MAX_SEMANTIC_SENTENCES {
        return Ok(split_text(text, strategy));
    }
    let windows: Vec<String> = (0..sentences.len())
        .map(|i| {
            let start = i.saturating_sub(*buffer_size);
            let end = (i + buffer_size + 1).min(sentences.len());
            sentences[start..end].join(" ")
        })
        .collect();
    let mut vectors = Vec::with_capacity(windows.len());
    for batch in windows.chunks(256) {
        vectors.extend(embedder.embed_batch(batch).await?);
    }
    anyhow::ensure!(
        vectors.len() == sentences.len(),
        "embedder returned {} vectors for {} sentences",
        vectors.len(),
        sentences.len()
    );
    let distances: Vec<f32> = vectors
        .windows(2)
        .map(|pair| 1.0 - crate::cosine_similarity(&pair[0], &pair[1]))
        .collect();
    let threshold = percentile(&distances, *breakpoint_percentile);

    let mut groups: Vec<String> = Vec::new();
    let mut current: Vec<&str> = vec![sentences[0].as_str()];
    for (i, distance) in distances.iter().enumerate() {
        if *distance > threshold {
            groups.push(current.join(" "));
            current.clear();
        }
        current.push(sentences[i + 1].as_str());
    }
    if !current.is_empty() {
        groups.push(current.join(" "));
    }

    let mut pieces = Vec::new();
    for group in groups {
        if char_len(&group) <= *max_chunk_size {
            pieces.push((group, Vec::new()));
        } else {
            for piece in split_recursive(&group, DEFAULT_SEPARATORS, *max_chunk_size, 0, &char_len)
            {
                pieces.push((piece, Vec::new()));
            }
        }
    }
    Ok(finish(pieces))
}

/// Number the chunks, count their tokens, and guarantee at least one chunk.
fn finish(pieces: Vec<(String, Vec<String>)>) -> Vec<TextChunk> {
    let mut chunks: Vec<TextChunk> = pieces
        .into_iter()
        .filter(|(content, _)| !content.trim().is_empty())
        .enumerate()
        .map(|(index, (content, header_path))| TextChunk {
            metadata: ChunkMetadata {
                index,
                header_path,
                token_count: approx_token_count(&content),
            },
            content,
        })
        .collect();
    if chunks.is_empty() {
        chunks.push(TextChunk {
            content: String::new(),
            metadata: ChunkMetadata::default(),
        });
    }
    chunks
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// Deterministic approximation of a GPT-style BPE token count: each run of
/// letters/digits costs `ceil(chars / 4)` tokens (at least one), every other
/// non-whitespace character costs one token, and whitespace is free (BPE merges a
/// leading space into the following word).
pub fn approx_token_count(text: &str) -> usize {
    let mut tokens = 0usize;
    let mut run = 0usize;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            run += 1;
            continue;
        }
        if run > 0 {
            tokens += run.div_ceil(4);
            run = 0;
        }
        if !ch.is_whitespace() {
            tokens += 1;
        }
    }
    if run > 0 {
        tokens += run.div_ceil(4);
    }
    tokens
}

/// The historical splitter, unchanged: paragraphs (`"\n\n"`) packed word by word
/// up to `size` characters, words longer than `size` cut on character
/// boundaries. Blank input yields one empty chunk.
pub fn legacy_word_chunks(content: &str, size: usize) -> Vec<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in trimmed.split("\n\n") {
        for word in paragraph.split_whitespace() {
            let word_characters = word.chars().count();
            if word_characters > size {
                if !current.is_empty() {
                    chunks.push(std::mem::take(&mut current));
                }
                let mut piece = String::new();
                let mut piece_characters = 0usize;
                for character in word.chars() {
                    piece.push(character);
                    piece_characters += 1;
                    if piece_characters == size {
                        chunks.push(std::mem::take(&mut piece));
                        piece_characters = 0;
                    }
                }
                if !piece.is_empty() {
                    current = piece;
                }
                continue;
            }
            if current.chars().count() + word_characters + 1 > size && !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if chunks.is_empty() {
        chunks.push(trimmed.to_owned());
    }
    chunks
}

/// Recursive splitter: cut on the first separator present in `text`, recurse
/// into pieces that are still longer than `chunk_size` with the remaining
/// separators, and pack the rest into overlapping windows. `len` measures a piece
/// (characters or approximate tokens).
///
/// Separators stay attached to the end of the piece they terminate, so
/// concatenating a document's pieces reproduces it exactly; chunks are trimmed
/// only when emitted.
pub fn split_recursive(
    text: &str,
    separators: &[&str],
    chunk_size: usize,
    chunk_overlap: usize,
    len: &dyn Fn(&str) -> usize,
) -> Vec<String> {
    let chunk_size = chunk_size.max(1);
    let chunk_overlap = chunk_overlap.min(chunk_size.saturating_sub(1));
    let mut out = Vec::new();
    split_recursive_into(text, separators, chunk_size, chunk_overlap, len, &mut out);
    out
}

fn split_recursive_into(
    text: &str,
    separators: &[&str],
    chunk_size: usize,
    chunk_overlap: usize,
    len: &dyn Fn(&str) -> usize,
    out: &mut Vec<String>,
) {
    if text.trim().is_empty() {
        return;
    }
    // The first separator that actually occurs; `""` (or running out) means
    // character-level splitting.
    let mut separator = "";
    let mut rest: &[&str] = &[];
    for (i, candidate) in separators.iter().enumerate() {
        if candidate.is_empty() {
            separator = "";
            rest = &[];
            break;
        }
        if text.contains(candidate) {
            separator = candidate;
            rest = &separators[i + 1..];
            break;
        }
    }
    let splits = split_keep_separator(text, separator);

    let mut good: Vec<&str> = Vec::new();
    for piece in splits {
        if len(piece) <= chunk_size {
            good.push(piece);
            continue;
        }
        if !good.is_empty() {
            merge_splits(&good, chunk_size, chunk_overlap, len, out);
            good.clear();
        }
        if separator.is_empty() || rest.is_empty() {
            // Nothing finer to try: a single "character" (or a separator-less
            // piece) longer than the budget is emitted whole rather than lost.
            if separator.is_empty() {
                let trimmed = piece.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_owned());
                }
            } else {
                split_recursive_into(piece, &[""], chunk_size, chunk_overlap, len, out);
            }
        } else {
            split_recursive_into(piece, rest, chunk_size, chunk_overlap, len, out);
        }
    }
    if !good.is_empty() {
        merge_splits(&good, chunk_size, chunk_overlap, len, out);
    }
}

/// Split on `separator`, keeping it attached to the end of each piece. An empty
/// separator splits into single characters.
fn split_keep_separator<'a>(text: &'a str, separator: &str) -> Vec<&'a str> {
    if separator.is_empty() {
        return text
            .char_indices()
            .map(|(i, ch)| &text[i..i + ch.len_utf8()])
            .collect();
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    for (index, matched) in text.match_indices(separator) {
        let end = index + matched.len();
        pieces.push(&text[start..end]);
        start = end;
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// Pack small pieces into chunks of at most `chunk_size`, carrying the trailing
/// `chunk_overlap` worth of pieces into the next chunk.
fn merge_splits(
    pieces: &[&str],
    chunk_size: usize,
    chunk_overlap: usize,
    len: &dyn Fn(&str) -> usize,
    out: &mut Vec<String>,
) {
    let mut window: std::collections::VecDeque<&str> = std::collections::VecDeque::new();
    let mut total = 0usize;
    let emit = |window: &std::collections::VecDeque<&str>, out: &mut Vec<String>| {
        let joined: String = window.iter().copied().collect();
        let trimmed = joined.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_owned());
        }
    };
    for piece in pieces {
        let piece_len = len(piece);
        if total + piece_len > chunk_size && !window.is_empty() {
            emit(&window, out);
            // Drop from the front until what remains fits the overlap budget and
            // leaves room for the incoming piece.
            while let Some(front) = window.front() {
                if total > chunk_overlap || (total + piece_len > chunk_size && total > 0) {
                    total -= len(front);
                    window.pop_front();
                } else {
                    break;
                }
            }
        }
        window.push_back(piece);
        total += piece_len;
    }
    if !window.is_empty() {
        emit(&window, out);
    }
}

/// Header-aware markdown splitting. Returns `(content, header_path)` pairs.
fn split_markdown(
    text: &str,
    chunk_size: usize,
    chunk_overlap: usize,
    include_header_path: bool,
) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for section in markdown_sections(text) {
        let prefix = if include_header_path && !section.header_path.is_empty() {
            format!("{}\n\n", section.header_path.join(" > "))
        } else {
            String::new()
        };
        let prefix_len = char_len(&prefix);
        // Reserve room for the breadcrumb so a prefixed chunk still fits.
        let budget = chunk_size
            .saturating_sub(prefix_len)
            .max(chunk_size / 2)
            .max(1);
        let overlap = chunk_overlap.min(budget.saturating_sub(1));
        for piece in split_recursive(
            &section.body,
            MARKDOWN_SEPARATORS,
            budget,
            overlap,
            &char_len,
        ) {
            out.push((format!("{prefix}{piece}"), section.header_path.clone()));
        }
    }
    out
}

struct MarkdownSection {
    header_path: Vec<String>,
    body: String,
}

/// Cut a markdown document at ATX headers. Lines inside fenced code blocks are
/// never headers. A header with no body before the next header contributes only
/// to the path.
fn markdown_sections(text: &str) -> Vec<MarkdownSection> {
    let mut sections = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut body = String::new();
    let mut fence: Option<&str> = None;
    let flush =
        |stack: &[(usize, String)], body: &mut String, sections: &mut Vec<MarkdownSection>| {
            if !body.trim().is_empty() {
                sections.push(MarkdownSection {
                    header_path: stack.iter().map(|(_, title)| title.clone()).collect(),
                    body: std::mem::take(body),
                });
            } else {
                body.clear();
            }
        };
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            body.push_str(line);
            body.push('\n');
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
        } else if trimmed.starts_with("~~~") {
            fence = Some("~~~");
        } else if let Some((level, title)) = parse_atx_header(line) {
            flush(&stack, &mut body, &mut sections);
            while stack.last().is_some_and(|(depth, _)| *depth >= level) {
                stack.pop();
            }
            stack.push((level, title));
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    flush(&stack, &mut body, &mut sections);
    sections
}

/// Parse an ATX header line (`## Title ##`) into `(level, title)`. At most three
/// leading spaces, one to six `#`, then whitespace or end of line.
fn parse_atx_header(line: &str) -> Option<(usize, String)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let level = rest.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !after.is_empty() && !after.starts_with([' ', '\t']) {
        return None;
    }
    let title = after.trim().trim_end_matches('#').trim().to_owned();
    if title.is_empty() {
        return None;
    }
    Some((level, title))
}

/// Split prose into sentences on `.`, `!`, `?` followed by whitespace, and on
/// blank lines. Sentences are trimmed; empty ones are dropped.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    for paragraph in text.split("\n\n") {
        let mut current = String::new();
        let mut chars = paragraph.chars().peekable();
        while let Some(ch) = chars.next() {
            current.push(ch);
            if matches!(ch, '.' | '!' | '?') && chars.peek().is_none_or(|next| next.is_whitespace())
            {
                let sentence = current.trim();
                if !sentence.is_empty() {
                    sentences.push(sentence.split_whitespace().collect::<Vec<_>>().join(" "));
                }
                current.clear();
            }
        }
        let sentence = current.trim();
        if !sentence.is_empty() {
            sentences.push(sentence.split_whitespace().collect::<Vec<_>>().join(" "));
        }
    }
    sentences
}

/// Linear-interpolated percentile (0–100) of `values`. Empty input yields
/// `f32::INFINITY` (no breakpoints).
fn percentile(values: &[f32], pct: f32) -> f32 {
    if values.is_empty() {
        return f32::INFINITY;
    }
    let mut sorted: Vec<f32> = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    let rank = (pct.clamp(0.0, 100.0) / 100.0) * (sorted.len() - 1) as f32;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    let weight = rank - lower as f32;
    sorted[lower] + (sorted[upper] - sorted[lower]) * weight
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents(chunks: &[TextChunk]) -> Vec<&str> {
        chunks.iter().map(|chunk| chunk.content.as_str()).collect()
    }

    #[test]
    fn default_strategy_matches_the_historical_splitter() {
        let text = format!("{}\n\nshort tail", "word ".repeat(400));
        let chunks = split_text(&text, &ChunkingStrategy::Default);
        let legacy = legacy_word_chunks(&text, DEFAULT_CHUNK_CHARS);
        assert_eq!(
            contents(&chunks),
            legacy.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert!(chunks
            .iter()
            .all(|c| c.content.chars().count() <= DEFAULT_CHUNK_CHARS));
    }

    #[test]
    fn blank_input_still_yields_one_chunk() {
        for strategy in [
            ChunkingStrategy::Default,
            ChunkingStrategy::Recursive {
                chunk_size: 10,
                chunk_overlap: 2,
                separators: None,
            },
            ChunkingStrategy::Markdown {
                chunk_size: 10,
                chunk_overlap: 2,
                include_header_path: true,
            },
        ] {
            let chunks = split_text("   \n", &strategy);
            assert_eq!(chunks.len(), 1);
            assert_eq!(chunks[0].content, "");
        }
    }

    #[test]
    fn recursive_prefers_paragraph_boundaries_and_respects_size() {
        let text = "Alpha paragraph one.\n\nBeta paragraph two.\n\nGamma paragraph three.";
        let chunks = split_text(
            text,
            &ChunkingStrategy::Recursive {
                chunk_size: 25,
                chunk_overlap: 0,
                separators: None,
            },
        );
        assert_eq!(
            contents(&chunks),
            vec![
                "Alpha paragraph one.",
                "Beta paragraph two.",
                "Gamma paragraph three."
            ]
        );
    }

    #[test]
    fn recursive_overlap_repeats_trailing_context() {
        let text = "one two three four five six seven eight nine ten";
        let chunks = split_recursive(text, DEFAULT_SEPARATORS, 20, 10, &char_len);
        assert!(chunks.len() > 2);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= 20, "{chunk:?} exceeds the budget");
        }
        // Consecutive chunks share at least one word.
        for pair in chunks.windows(2) {
            let last_word = pair[0].split_whitespace().last().unwrap();
            assert!(
                pair[1].contains(last_word),
                "{:?} does not overlap {:?}",
                pair[1],
                pair[0]
            );
        }
    }

    #[test]
    fn recursive_falls_back_to_characters_for_unbroken_text() {
        let text = "x".repeat(25);
        let chunks = split_recursive(&text, DEFAULT_SEPARATORS, 10, 0, &char_len);
        assert_eq!(chunks, vec!["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    }

    #[test]
    fn custom_separators_are_honoured() {
        let text = "a|b|c|d";
        let chunks = split_text(
            text,
            &ChunkingStrategy::Recursive {
                chunk_size: 2,
                chunk_overlap: 0,
                separators: Some(vec!["|".to_owned()]),
            },
        );
        assert_eq!(contents(&chunks), vec!["a|", "b|", "c|", "d"]);
    }

    #[test]
    fn markdown_chunks_carry_their_header_path() {
        let text = "Intro text.\n\n# Guide\n\nGuide body.\n\n## Install\n\nRun the installer.\n\n```sh\n# not a header\nmake\n```\n\n## Usage\n\nUse it.\n\n# Reference\n\nAPI list.";
        let chunks = split_text(
            text,
            &ChunkingStrategy::Markdown {
                chunk_size: 500,
                chunk_overlap: 0,
                include_header_path: false,
            },
        );
        let paths: Vec<Vec<String>> = chunks
            .iter()
            .map(|c| c.metadata.header_path.clone())
            .collect();
        assert_eq!(
            paths,
            vec![
                vec![],
                vec!["Guide".to_owned()],
                vec!["Guide".to_owned(), "Install".to_owned()],
                vec!["Guide".to_owned(), "Usage".to_owned()],
                vec!["Reference".to_owned()],
            ]
        );
        assert!(chunks[2].content.contains("# not a header"));
        assert_eq!(chunks[3].content, "Use it.");
        assert_eq!(
            chunks.iter().map(|c| c.metadata.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn markdown_breadcrumb_prefix_is_optional_and_fits_the_budget() {
        let text = format!("# Top\n## Sub\n\n{}", "lorem ipsum ".repeat(30));
        let chunks = split_text(
            &text,
            &ChunkingStrategy::Markdown {
                chunk_size: 80,
                chunk_overlap: 0,
                include_header_path: true,
            },
        );
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.content.starts_with("Top > Sub\n\n"));
            assert!(chunk.content.chars().count() <= 80);
        }
    }

    #[test]
    fn token_strategy_bounds_chunks_by_approximate_tokens() {
        let text = "The quick brown fox jumps over the lazy dog. ".repeat(40);
        let chunks = split_text(
            &text,
            &ChunkingStrategy::Token {
                chunk_size: 30,
                chunk_overlap: 5,
            },
        );
        assert!(chunks.len() > 5);
        for chunk in &chunks {
            assert!(chunk.metadata.token_count <= 30, "{chunk:?}");
        }
    }

    #[test]
    fn approx_token_count_is_deterministic_and_sensible() {
        assert_eq!(approx_token_count(""), 0);
        assert_eq!(approx_token_count("hello"), 2);
        assert_eq!(approx_token_count("a, b!"), 4);
        assert_eq!(approx_token_count("internationalization"), 5);
    }

    #[test]
    fn validation_rejects_bad_configs() {
        assert!(ChunkingStrategy::Recursive {
            chunk_size: 100,
            chunk_overlap: 100,
            separators: None
        }
        .validate()
        .is_err());
        assert!(ChunkingStrategy::Token {
            chunk_size: 0,
            chunk_overlap: 0
        }
        .validate()
        .is_err());
        assert!(ChunkingStrategy::Semantic {
            breakpoint_percentile: 120.0,
            buffer_size: 1,
            max_chunk_size: 100
        }
        .validate()
        .is_err());
        assert!(ChunkingStrategy::default().validate().is_ok());
    }

    #[test]
    fn strategy_serializes_with_a_strategy_tag_and_defaults() {
        let parsed: ChunkingStrategy =
            serde_json::from_str(r#"{"strategy":"recursive","chunk_size":300}"#).unwrap();
        assert_eq!(
            parsed,
            ChunkingStrategy::Recursive {
                chunk_size: 300,
                chunk_overlap: 200,
                separators: None
            }
        );
        let default: ChunkingStrategy = serde_json::from_str(r#"{"strategy":"default"}"#).unwrap();
        assert_eq!(default, ChunkingStrategy::Default);
    }

    #[test]
    fn sentences_split_on_terminal_punctuation() {
        assert_eq!(
            split_sentences("One. Two!  Three?\n\nFour 3.5 five"),
            vec!["One.", "Two!", "Three?", "Four 3.5 five"]
        );
    }

    #[tokio::test]
    async fn semantic_strategy_breaks_where_the_topic_changes() {
        let text = "Rust ownership borrow checker. Rust ownership lifetimes borrow. Rust borrow checker ownership rules. \
                    Baking bread flour yeast. Bread dough flour yeast oven. Yeast bread flour baking oven.";
        let embedder = Embedder::Local { dims: 256 };
        let chunks = split_text_with_embedder(
            text,
            &ChunkingStrategy::Semantic {
                breakpoint_percentile: 80.0,
                buffer_size: 0,
                max_chunk_size: 2_000,
            },
            &embedder,
        )
        .await
        .unwrap();
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        assert!(chunks[0].content.contains("Rust") && !chunks[0].content.contains("bread"));
        assert!(chunks[1].content.contains("bread") && !chunks[1].content.contains("Rust"));
    }

    #[tokio::test]
    async fn semantic_strategy_enforces_the_size_ceiling() {
        let text = "alpha beta gamma delta. ".repeat(50);
        let chunks = split_text_with_embedder(
            &text,
            &ChunkingStrategy::Semantic {
                breakpoint_percentile: 95.0,
                buffer_size: 1,
                max_chunk_size: 120,
            },
            &Embedder::Local { dims: 64 },
        )
        .await
        .unwrap();
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.content.chars().count() <= 120));
    }
}
