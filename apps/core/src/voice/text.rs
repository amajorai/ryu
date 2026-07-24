//! Sentence segmentation shared by the voice + hardware turn paths.
//!
//! [`sentence_chunks`] splits a complete reply into sentence-ish pieces (the
//! hardware `chat_delta` framing). [`SentenceAccumulator`] is the streaming
//! counterpart: token deltas are pushed in as they arrive from the LLM and it
//! yields complete sentences as terminators land, so voice mode can synthesize +
//! stream TTS sentence-by-sentence instead of waiting for the whole reply.

/// Sentence terminators. A chunk boundary falls right after one of these.
const TERMINATORS: [char; 4] = ['.', '!', '?', '\n'];

/// Split a reply into sentence-ish chunks for incremental framing. Keeps the
/// terminator with its sentence; never returns empty chunks. A reply with no
/// sentence boundary returns as a single chunk.
pub fn sentence_chunks(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if TERMINATORS.contains(&ch) {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                chunks.push(trimmed.to_string());
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        chunks.push(tail.to_string());
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

/// Streaming sentence segmenter. Feed it LLM token deltas via [`push`]; each call
/// returns any sentences that just completed (usually zero or one). Call [`flush`]
/// once the stream ends to drain the trailing partial sentence.
///
/// [`push`]: SentenceAccumulator::push
/// [`flush`]: SentenceAccumulator::flush
#[derive(Default)]
pub struct SentenceAccumulator {
    buf: String,
}

impl SentenceAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a token delta; return any sentences completed by it. A delta can
    /// carry more than one terminator (or none), so this returns a `Vec`.
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            self.buf.push(ch);
            if TERMINATORS.contains(&ch) {
                let trimmed = self.buf.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                self.buf.clear();
            }
        }
        out
    }

    /// Drain the trailing partial sentence (no terminator seen). Returns `None`
    /// when the buffer is empty/whitespace. Leaves the accumulator empty.
    pub fn flush(&mut self) -> Option<String> {
        let tail = self.buf.trim();
        let result = if tail.is_empty() {
            None
        } else {
            Some(tail.to_string())
        };
        self.buf.clear();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentence_chunks_split_on_terminators() {
        let chunks = sentence_chunks("Hello there. How are you? Good!");
        assert_eq!(chunks, vec!["Hello there.", "How are you?", "Good!"]);
    }

    #[test]
    fn sentence_chunks_single_when_no_boundary() {
        assert_eq!(sentence_chunks("just one clause"), vec!["just one clause"]);
        assert!(sentence_chunks("   ").is_empty());
    }

    #[test]
    fn accumulator_yields_sentence_on_terminator() {
        let mut acc = SentenceAccumulator::new();
        assert!(acc.push("Hello").is_empty());
        assert!(acc.push(" there").is_empty());
        assert_eq!(acc.push(". "), vec!["Hello there."]);
        assert!(acc.flush().is_none());
    }

    #[test]
    fn accumulator_flush_returns_trailing_partial() {
        let mut acc = SentenceAccumulator::new();
        assert!(acc.push("no terminator here").is_empty());
        assert_eq!(acc.flush(), Some("no terminator here".to_string()));
        assert!(acc.flush().is_none());
    }

    #[test]
    fn accumulator_handles_multiple_terminators_in_one_delta() {
        let mut acc = SentenceAccumulator::new();
        assert_eq!(acc.push("One. Two! Three?"), vec!["One.", "Two!", "Three?"]);
    }

    #[test]
    fn accumulator_treats_newline_as_a_terminator() {
        let mut acc = SentenceAccumulator::new();
        assert_eq!(acc.push("bullet one\n"), vec!["bullet one"]);
        // A whitespace-only delta yields nothing and leaves the buffer drainable-empty.
        assert!(acc.push("   ").is_empty());
        assert!(acc.flush().is_none());
    }

    #[test]
    fn accumulator_preserves_multibyte_across_delta_boundaries() {
        let mut acc = SentenceAccumulator::new();
        // A multibyte char split across two pushes must not corrupt the sentence.
        assert!(acc.push("café ").is_empty());
        assert_eq!(acc.push("☃ done."), vec!["café ☃ done."]);
    }

    #[test]
    fn sentence_chunks_splits_on_newline() {
        assert_eq!(
            sentence_chunks("a\nb\nc"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }
}
