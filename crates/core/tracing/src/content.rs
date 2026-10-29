//! Consent-gated span inputs/outputs.
//!
//! The store's default posture is unchanged from v1: no prompt, completion, or
//! tool payload is persisted. A host opts a store into capture with
//! [`ContentPolicy::capture`] only when the user's privacy settings allow it
//! (Core ties this to `diagnostics-otlp-content-mode = content` plus export
//! consent, resolved in `apps/core/src/privacy.rs`). With capture off, every
//! `input`/`output` handed to the store is dropped before it reaches SQLite.
//! Captured payloads are sealed at rest through a host-supplied
//! [`ContentSealer`]; a store without one persists none. Turning capture off
//! also clears the payloads already stored.

use anyhow::Result;
use serde_json::Value;

/// Seals captured span payloads before they reach SQLite. The host supplies the
/// cipher (Core binds it to the `traces.db` content key), so this crate stays
/// free of any key management. `purpose` names the column (`spans.input`,
/// `spans.output`) and `id` is the span row id; implementations must bind both
/// into the sealed value so it cannot be moved between rows or columns.
///
/// A store with no sealer persists NO payloads, whatever the policy says.
pub trait ContentSealer: Send + Sync {
    /// Seal `plaintext` for storage.
    fn seal(&self, plaintext: &str, purpose: &str, id: &str) -> Result<String>;
    /// Open a stored value. Legacy plaintext (never sealed) is returned as is.
    fn open(&self, stored: &str, purpose: &str, id: &str) -> Result<String>;
    /// Whether `stored` is already sealed.
    fn is_sealed(&self, stored: &str) -> bool;
}

/// Default per-span content cap (matches Core's OTLP content cap).
pub const DEFAULT_MAX_CONTENT_BYTES: usize = 750_000;

/// Whether span payloads may be persisted, and how large each may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentPolicy {
    /// Persist span inputs/outputs. `false` (the default) drops them.
    pub capture: bool,
    /// Serialized byte cap for one input or output.
    pub max_bytes: usize,
}

impl Default for ContentPolicy {
    fn default() -> Self {
        Self::metadata_only()
    }
}

impl ContentPolicy {
    /// No payloads: ordering, timing, attributes, and errors only.
    pub const fn metadata_only() -> Self {
        Self {
            capture: false,
            max_bytes: DEFAULT_MAX_CONTENT_BYTES,
        }
    }

    /// Capture payloads up to `max_bytes` each (a zero cap uses the default).
    pub const fn capture(max_bytes: usize) -> Self {
        Self {
            capture: true,
            max_bytes: if max_bytes == 0 {
                DEFAULT_MAX_CONTENT_BYTES
            } else {
                max_bytes
            },
        }
    }

    /// Apply the policy to one payload: `None` when capture is off, the value
    /// itself when it fits, or a truncation envelope when it does not.
    pub fn apply(&self, value: Option<Value>) -> Option<Value> {
        if !self.capture {
            return None;
        }
        let value = value?;
        let serialized = serde_json::to_string(&value).ok()?;
        if serialized.len() <= self.max_bytes {
            return Some(value);
        }
        Some(serde_json::json!({
            "truncated": true,
            "original_bytes": serialized.len(),
            "preview": truncate_on_char_boundary(&serialized, self.max_bytes),
        }))
    }
}

/// Cut `text` to at most `max_bytes` without splitting a UTF-8 character.
pub fn truncate_on_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn metadata_only_drops_every_payload() {
        let policy = ContentPolicy::default();
        assert!(!policy.capture);
        assert_eq!(policy.apply(Some(json!({"prompt": "secret"}))), None);
    }

    #[test]
    fn capture_keeps_small_payloads_and_truncates_large_ones() {
        let policy = ContentPolicy::capture(16);
        assert_eq!(policy.apply(Some(json!("short"))), Some(json!("short")));
        assert_eq!(policy.apply(None), None);
        let capped = policy
            .apply(Some(json!("a much longer payload than allowed")))
            .unwrap();
        assert_eq!(capped["truncated"], json!(true));
        assert_eq!(capped["preview"].as_str().unwrap().len(), 16);
        assert_eq!(
            ContentPolicy::capture(0).max_bytes,
            DEFAULT_MAX_CONTENT_BYTES
        );
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        assert_eq!(truncate_on_char_boundary("héllo", 2), "h");
        assert_eq!(truncate_on_char_boundary("abc", 10), "abc");
    }
}
