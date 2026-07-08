//! AI note generation for a finished meeting.
//!
//! Turning a raw transcript into structured notes (summary / key points /
//! action items / decisions) is a model call, so it routes through the **local
//! gateway** (`/v1/chat/completions`) — the same place every other Core "side
//! model" call goes (`call_side_model`). This keeps meeting transcripts on the
//! governed egress path where DLP/budgets attach.
//!
//! Nothing is hardcoded: the *model* and the *prompt template* are resolved by
//! the caller (from prefs → env → default) and passed in; this module only owns
//! the request shape and the defensive JSON parse.

use serde::{Deserialize, Serialize};

use crate::sidecar::gateway::{gateway_token, gateway_url};

/// The default system prompt (base contract + the `default` template's guidance),
/// used when no `meeting-notes-prompt` / template preference is set.
pub fn default_notes_prompt() -> String {
    super::templates::prompt_for("default")
}

/// Above this many characters a transcript is summarized with a map-reduce pass
/// instead of a single call, so a long meeting can't overflow the model's context
/// window. ~12k chars ≈ 4k tokens — conservative for even a small local default
/// like Gemma. Overridable via `RYU_MEETING_NOTES_MAX_CHARS`.
const DEFAULT_MAX_CHARS: usize = 12_000;
/// Characters of overlap between map chunks so a point split across a boundary
/// isn't lost.
const CHUNK_OVERLAP_CHARS: usize = 500;

/// Structured notes derived from a transcript.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MeetingNotes {
    pub summary: String,
    #[serde(default)]
    pub key_points: Vec<String>,
    #[serde(default)]
    pub action_items: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    /// When the notes were generated (RFC3339).
    #[serde(default)]
    pub generated_at: String,
    /// The model that produced them (for provenance / display).
    #[serde(default)]
    pub model: String,
}

/// Generate notes from `transcript` using `model` (and optional `effort`) via the
/// gateway, applying `system_prompt`. For long transcripts this runs a map-reduce
/// pass (condense each chunk, then summarize the condensations) so the meeting
/// can't overflow the model's context. Returns the parsed notes, or an error
/// string the caller can surface.
pub async fn generate_notes(
    client: &reqwest::Client,
    model: &str,
    effort: &str,
    system_prompt: &str,
    transcript: &str,
) -> Result<MeetingNotes, String> {
    let max_chars = std::env::var("RYU_MEETING_NOTES_MAX_CHARS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 1000)
        .unwrap_or(DEFAULT_MAX_CHARS);

    let reduce_input;
    let input: &str = if transcript.chars().count() <= max_chars {
        transcript
    } else {
        // MAP: condense each overlapping chunk to compact plain-text notes.
        let chunks = chunk_transcript(transcript, max_chars, CHUNK_OVERLAP_CHARS);
        let total = chunks.len();
        let mut partials = Vec::with_capacity(total);
        for (i, chunk) in chunks.iter().enumerate() {
            let partial = summarize_chunk(client, model, effort, i + 1, total, chunk).await?;
            partials.push(format!("[Part {}/{}]\n{}", i + 1, total, partial.trim()));
        }
        // REDUCE: the final structured pass runs over the ordered condensations,
        // which re-derives action items/decisions across the whole meeting.
        reduce_input = format!(
            "The following are ordered partial notes from consecutive segments of \
one long meeting. Synthesize them into a single coherent set of notes, merging \
duplicates and consolidating action items and decisions across all parts:\n\n{}",
            partials.join("\n\n")
        );
        &reduce_input
    };

    let text = complete(client, model, effort, system_prompt, input).await?;
    let mut notes = parse_notes(&text);
    notes.generated_at = chrono::Utc::now().to_rfc3339();
    notes.model = model.to_string();
    Ok(notes)
}

/// One gateway chat completion: `system_prompt` + the given user content. Returns
/// the assistant's raw text.
async fn complete(
    client: &reqwest::Client,
    model: &str,
    effort: &str,
    system_prompt: &str,
    user_content: &str,
) -> Result<String, String> {
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut payload = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": format!("Transcript:\n\n{user_content}") },
        ],
    });
    let effort = effort.trim();
    if !effort.is_empty() {
        payload["reasoning_effort"] = serde_json::json!(effort);
    }

    let mut req = client
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(120))
        .json(&payload);
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gateway returned HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("response was not valid JSON: {e}"))?;
    Ok(body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string())
}

/// The MAP step: condense one transcript chunk to compact plain-text notes,
/// preserving specifics (names, numbers, dates, owners) for the reduce step.
async fn summarize_chunk(
    client: &reqwest::Client,
    model: &str,
    effort: &str,
    part: usize,
    total: usize,
    chunk: &str,
) -> Result<String, String> {
    let system = format!(
        "You are condensing part {part} of {total} of a long meeting transcript. \
Write compact plain-text notes (bullet points, no preamble, no JSON) capturing \
what was discussed, every decision, and every action item with its owner. Keep \
all specifics — names, numbers, dates, commitments. Do not add a heading."
    );
    complete(client, model, effort, &system, chunk).await
}

/// Split `transcript` into chunks of about `max_chars`, each overlapping the
/// previous by `overlap` characters. Splits on a character boundary; a later pass
/// could snap to sentence ends, but overlap already guards against mid-sentence
/// cuts losing content.
fn chunk_transcript(transcript: &str, max_chars: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = transcript.chars().collect();
    if chars.len() <= max_chars {
        return vec![transcript.to_string()];
    }
    let step = max_chars.saturating_sub(overlap).max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        chunks.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start += step;
    }
    chunks
}

/// Parse the model's reply into structured notes. The model is asked for a bare
/// JSON object; we parse defensively — pulling the first `{...}` block (so a
/// stray ```json fence or preamble doesn't break it), and falling back to using
/// the whole reply as the summary if no JSON is found.
fn parse_notes(text: &str) -> MeetingNotes {
    let trimmed = text.trim();
    if let Some(json_slice) = extract_json_object(trimmed) {
        if let Ok(parsed) = serde_json::from_str::<MeetingNotes>(json_slice) {
            return parsed;
        }
    }
    // Fail-soft: no parseable JSON — keep the raw reply as the summary rather
    // than losing the model's work.
    MeetingNotes {
        summary: trimmed.to_string(),
        ..Default::default()
    }
}

/// Return the substring spanning the first balanced top-level `{...}` object, or
/// `None` if there isn't one. Brace-counting (not a full parser) is enough to
/// peel a JSON object out of an optionally-fenced reply.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in s[start..].char_indices() {
        match ch {
            '"' if !escaped => in_string = !in_string,
            '\\' if in_string => {
                escaped = !escaped;
                continue;
            }
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=start + i]);
                }
            }
            _ => {}
        }
        escaped = false;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let notes = parse_notes(
            r#"{"summary":"We synced.","key_points":["a","b"],"action_items":["x"],"decisions":[]}"#,
        );
        assert_eq!(notes.summary, "We synced.");
        assert_eq!(notes.key_points, vec!["a", "b"]);
        assert_eq!(notes.action_items, vec!["x"]);
        assert!(notes.decisions.is_empty());
    }

    #[test]
    fn parses_fenced_json_with_preamble() {
        let reply = "Here are your notes:\n```json\n{\"summary\":\"Done.\",\"key_points\":[]}\n```";
        let notes = parse_notes(reply);
        assert_eq!(notes.summary, "Done.");
    }

    #[test]
    fn falls_back_to_summary_when_no_json() {
        let notes = parse_notes("Sorry, I could not produce JSON.");
        assert_eq!(notes.summary, "Sorry, I could not produce JSON.");
        assert!(notes.key_points.is_empty());
    }

    #[test]
    fn ignores_braces_inside_strings() {
        let notes = parse_notes(r#"{"summary":"use a } brace","key_points":[]}"#);
        assert_eq!(notes.summary, "use a } brace");
    }

    #[test]
    fn short_transcript_is_one_chunk() {
        let chunks = chunk_transcript("hello world", 100, 10);
        assert_eq!(chunks, vec!["hello world".to_string()]);
    }

    #[test]
    fn long_transcript_chunks_with_overlap() {
        let text: String = "a".repeat(250);
        let chunks = chunk_transcript(&text, 100, 20);
        // step = 80 → windows [0,100), [80,180), [160,250) → 3 chunks; the third
        // already reaches the end, so the loop stops.
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].chars().count(), 100);
        assert_eq!(chunks[1].chars().count(), 100);
        assert_eq!(chunks[2].chars().count(), 90); // 160..250
        // Consecutive windows overlap (step 80 < window 100 → 20 char overlap).
        assert!(chunks[0].chars().count() + chunks[1].chars().count() > 180);
    }

    #[test]
    fn default_prompt_comes_from_template() {
        assert!(default_notes_prompt().starts_with("You are an expert"));
    }
}
