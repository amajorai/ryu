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

/// The default system prompt used when no `meeting-notes-prompt` preference is
/// set. Asks for a single strict-JSON object so the parse is reliable.
pub const DEFAULT_NOTES_PROMPT: &str = "You are an expert meeting-notes assistant. \
You are given a raw, possibly imperfect speech-to-text transcript of a meeting. \
Write concise, useful notes. Respond with ONLY a single JSON object, no prose, no \
markdown fences, with exactly these keys: \
\"summary\" (a short paragraph), \
\"key_points\" (array of strings), \
\"action_items\" (array of strings, each ideally naming an owner if one is clear), \
\"decisions\" (array of strings). \
Use empty arrays when a section has nothing. Do not invent content that is not \
supported by the transcript.";

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
/// gateway, applying `system_prompt`. Returns the parsed notes, or an error
/// string the caller can surface.
pub async fn generate_notes(
    client: &reqwest::Client,
    model: &str,
    effort: &str,
    system_prompt: &str,
    transcript: &str,
) -> Result<MeetingNotes, String> {
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut payload = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": format!("Transcript:\n\n{transcript}") },
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
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default();

    let mut notes = parse_notes(text);
    notes.generated_at = chrono::Utc::now().to_rfc3339();
    notes.model = model.to_string();
    Ok(notes)
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
}
