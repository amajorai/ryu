//! Per-thread, per-provider prompt-cache warmth.
//!
//! Hosted providers keep a request's prompt prefix cached for a while after it
//! was last read or written, and every cache hit refreshes that lifetime. Ryu
//! cannot observe a provider's cache directly, so warmth is a countdown from the
//! last turn that reported cache reads or writes, using the provider family's
//! published default TTL. The policy table mirrors the desktop's
//! `prompt-cache.ts` (composer hover card and model-switch warning); keep the
//! two in step when a provider changes its caching. The `Core parity` block in
//! `packages/blocks/src/desktop/agent-elements/prompt-cache.test.ts` parses this
//! file's `CacheFamily` variants, its `default_ttl` arms, and every `family(..)` /
//! `cache_family(..)` assert in `families_follow_the_model_then_the_provider_hint`,
//! then checks the desktop policy against them, so drift in either fails CI. Add
//! classification cases to that Rust test; the desktop suite picks them up.
//!
//! Entries are keyed by `(conversation, provider family)`, so a thread that
//! talked to Claude and then to GPT keeps one countdown per provider. They are
//! process memory only: a Core restart forgets them, and an untracked thread is
//! never reported as expired, so nothing acts on a guess.
//!
//! The consumer is cache-expiry compaction (`context.compact-on-cache-expire`):
//! once the cache a thread's agent would hit has gone cold, the next turn
//! re-sends its whole prefix at full input price anyway, so that is the cheapest
//! moment to compact the history (see `context_window::budgeted_short_term_replay`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

const MINUTE: Duration = Duration::from_secs(60);

/// Most `(conversation, family)` entries kept. Past this the oldest is
/// forgotten: losing an entry only means one thread reads as untracked.
const MAX_ENTRIES: usize = 2048;

/// A provider family whose prompt cache behaves the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheFamily {
    Anthropic,
    OpenAi,
    Google,
    DeepSeek,
    Xai,
}

impl CacheFamily {
    /// Default lifetime after the last cache read or write, or `None` when the
    /// provider publishes no expiry (implicit or disk caches).
    pub fn default_ttl(self) -> Option<Duration> {
        match self {
            // 5 min default, refreshed on every hit (1 h only when a request opts in).
            Self::Anthropic => Some(5 * MINUTE),
            // At least 30 min after last use on current models.
            Self::OpenAi => Some(30 * MINUTE),
            Self::Google | Self::DeepSeek | Self::Xai => None,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Google => "google",
            Self::DeepSeek => "deepseek",
            Self::Xai => "xai",
        }
    }
}

/// Lowercase alphanumeric runs of `value`, the word boundaries the family
/// patterns match on (`anthropic/claude-sonnet-4-5` → `anthropic`, `claude`, …).
fn words(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
}

fn match_family(value: &str) -> Option<CacheFamily> {
    let lower = value.to_ascii_lowercase();
    if lower.contains("claude")
        || lower.contains("anthropic")
        || words(&lower).any(|word| matches!(word, "opus" | "sonnet" | "haiku"))
    {
        return Some(CacheFamily::Anthropic);
    }
    if lower.contains("gemini") || words(&lower).any(|word| word == "google") {
        return Some(CacheFamily::Google);
    }
    if lower.contains("deepseek") {
        return Some(CacheFamily::DeepSeek);
    }
    if lower.contains("grok") || words(&lower).any(|word| word == "xai") {
        return Some(CacheFamily::Xai);
    }
    // Open-weight `gpt-oss` is usually served by another host or locally.
    if lower.contains("gpt-oss") {
        return None;
    }
    let openai_word = words(&lower).any(|word| {
        ["gpt", "openai", "codex", "chatgpt"]
            .iter()
            .any(|prefix| word.starts_with(prefix))
    });
    // Reasoning ids (`o3`, `openai/o4-mini`): the model name itself starts `o<digit>`.
    let model_name = lower.rsplit(['/', ':']).next().unwrap_or(&lower);
    let reasoning_id =
        model_name.starts_with('o') && model_name[1..].starts_with(|c: char| c.is_ascii_digit());
    (openai_word || reasoning_id).then_some(CacheFamily::OpenAi)
}

/// The cache family for a turn. The model id decides; `provider` (a provider id
/// such as `anthropic`, or an agent id such as `claude-code`) is the fallback for
/// ACP agents that report `default` as their model.
pub fn cache_family(model: Option<&str>, provider: Option<&str>) -> Option<CacheFamily> {
    model
        .and_then(match_family)
        .or_else(|| provider.and_then(match_family))
}

/// Where a thread's cache stands for one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheWarmth {
    /// Within the default TTL of the last cache read or write.
    Warm { remaining: Duration },
    /// Past the default TTL: the next turn most likely re-writes the cache.
    Expired { since: Duration },
    /// The last turn reported zero cache reads and writes.
    Unused,
    /// Cache tokens were reported but the provider publishes no expiry.
    NoPublishedExpiry,
}

#[derive(Debug, Clone)]
struct Entry {
    agent_id: String,
    family: Option<CacheFamily>,
    last_turn_at: Instant,
    cache_tokens: u64,
}

impl Entry {
    fn warmth(&self, now: Instant) -> CacheWarmth {
        if self.cache_tokens == 0 {
            return CacheWarmth::Unused;
        }
        let Some(ttl) = self.family.and_then(CacheFamily::default_ttl) else {
            return CacheWarmth::NoPublishedExpiry;
        };
        let age = now.saturating_duration_since(self.last_turn_at);
        match ttl.checked_sub(age) {
            Some(remaining) if !remaining.is_zero() => CacheWarmth::Warm { remaining },
            _ => CacheWarmth::Expired { since: age - ttl },
        }
    }
}

#[derive(Default)]
struct Tracker {
    entries: HashMap<(String, String), Entry>,
}

impl Tracker {
    #[allow(clippy::too_many_arguments)]
    fn observe(
        &mut self,
        conversation_id: &str,
        agent_id: &str,
        provider: Option<&str>,
        model: Option<&str>,
        read: Option<u64>,
        write: Option<u64>,
        now: Instant,
    ) {
        // No cache counters at all: nothing honest to record, and recording a
        // zero would hide a warm entry from an earlier turn that did report them.
        if read.is_none() && write.is_none() {
            return;
        }
        let family = cache_family(model, provider);
        let family_key = family.map_or_else(
            || {
                provider
                    .or(model)
                    .map_or_else(|| "unknown".to_owned(), |id| id.to_ascii_lowercase())
            },
            |family| family.key().to_owned(),
        );
        let key = (conversation_id.to_owned(), family_key);
        if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_turn_at)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            Entry {
                agent_id: agent_id.to_owned(),
                family,
                last_turn_at: now,
                cache_tokens: read.unwrap_or(0).saturating_add(write.unwrap_or(0)),
            },
        );
    }

    /// Warmth of the cache `agent_id` most recently used in this conversation:
    /// the one its live session would hit on the next turn.
    fn latest_for_agent(
        &self,
        conversation_id: &str,
        agent_id: &str,
        now: Instant,
    ) -> Option<CacheWarmth> {
        self.entries
            .iter()
            .filter(|((conversation, _), entry)| {
                conversation == conversation_id && entry.agent_id == agent_id
            })
            .max_by_key(|(_, entry)| entry.last_turn_at)
            .map(|(_, entry)| entry.warmth(now))
    }
}

fn tracker() -> &'static Mutex<Tracker> {
    static TRACKER: OnceLock<Mutex<Tracker>> = OnceLock::new();
    TRACKER.get_or_init(Mutex::default)
}

/// Record a finished turn's cache counters for `(conversation, provider)`.
pub fn observe_turn(
    conversation_id: &str,
    agent_id: &str,
    provider: Option<&str>,
    model: Option<&str>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
) {
    if conversation_id.is_empty() {
        return;
    }
    if let Ok(mut tracker) = tracker().lock() {
        tracker.observe(
            conversation_id,
            agent_id,
            provider,
            model,
            cache_read_tokens,
            cache_write_tokens,
            Instant::now(),
        );
    }
}

/// [`observe_turn`] from an OpenAI- or Anthropic-shaped `usage` object.
pub fn observe_usage(
    conversation_id: &str,
    agent_id: &str,
    provider: Option<&str>,
    model: Option<&str>,
    usage: &Value,
) {
    let top = |key: &str| usage.get(key).and_then(Value::as_u64);
    let nested = |outer: &str, inner: &str| {
        usage
            .get(outer)
            .and_then(|details| details.get(inner))
            .and_then(Value::as_u64)
    };
    let read = nested("prompt_tokens_details", "cached_tokens")
        .or_else(|| nested("input_tokens_details", "cached_tokens"))
        .or_else(|| top("cached_tokens"))
        .or_else(|| top("cache_read_input_tokens"));
    let write = nested("prompt_tokens_details", "cache_write_tokens")
        .or_else(|| nested("prompt_tokens_details", "cache_creation_input_tokens"))
        .or_else(|| nested("input_tokens_details", "cache_write_tokens"))
        .or_else(|| top("cache_write_tokens"))
        .or_else(|| top("cache_creation_input_tokens"));
    observe_turn(conversation_id, agent_id, provider, model, read, write);
}

/// Whether the cache `agent_id` last used in this conversation has expired.
/// `false` when the thread is untracked, unused, or its provider publishes no
/// expiry: only a countdown that actually ran out counts.
pub fn expired_for_agent(conversation_id: &str, agent_id: &str) -> bool {
    tracker().lock().is_ok_and(|tracker| {
        matches!(
            tracker.latest_for_agent(conversation_id, agent_id, Instant::now()),
            Some(CacheWarmth::Expired { .. })
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_follow_the_model_then_the_provider_hint() {
        let family = |model: &str| cache_family(Some(model), None);
        assert_eq!(
            family("anthropic/claude-sonnet-4-5"),
            Some(CacheFamily::Anthropic)
        );
        assert_eq!(family("opus"), Some(CacheFamily::Anthropic));
        assert_eq!(family("gpt-5.1"), Some(CacheFamily::OpenAi));
        assert_eq!(family("openai/o4-mini"), Some(CacheFamily::OpenAi));
        assert_eq!(family("o3"), Some(CacheFamily::OpenAi));
        assert_eq!(family("gemini-2.5-pro"), Some(CacheFamily::Google));
        assert_eq!(family("google/gemma-3"), Some(CacheFamily::Google));
        assert_eq!(family("deepseek-chat"), Some(CacheFamily::DeepSeek));
        assert_eq!(family("x-ai/grok-4"), Some(CacheFamily::Xai));
        assert_eq!(family("gpt-oss-120b"), None);
        assert_eq!(family("qwen3-8b"), None);
        assert_eq!(family("ollama"), None);
        // Words split only on non-alphanumerics, so a trailing or leading digit
        // is part of the word, and `o<digit>` must start the final path segment.
        assert_eq!(family("google2"), None);
        assert_eq!(family("opus4"), None);
        assert_eq!(family("xai2"), None);
        assert_eq!(family("4gpt"), None);
        assert_eq!(family("o3/custom"), None);
        // ACP agents often report `default`; the agent or provider id decides.
        assert_eq!(
            cache_family(Some("default"), Some("claude-code")),
            Some(CacheFamily::Anthropic)
        );
        assert_eq!(
            cache_family(Some("default"), Some("codex")),
            Some(CacheFamily::OpenAi)
        );
        assert_eq!(cache_family(None, None), None);
    }

    #[test]
    fn warmth_counts_down_from_the_last_cached_turn() {
        let start = Instant::now();
        let mut tracker = Tracker::default();
        tracker.observe(
            "c",
            "claude",
            Some("anthropic"),
            Some("claude-sonnet-4-5"),
            Some(900),
            Some(100),
            start,
        );
        assert_eq!(
            tracker.latest_for_agent("c", "claude", start + MINUTE),
            Some(CacheWarmth::Warm {
                remaining: 4 * MINUTE
            })
        );
        assert_eq!(
            tracker.latest_for_agent("c", "claude", start + 6 * MINUTE),
            Some(CacheWarmth::Expired { since: MINUTE })
        );
        // A cache hit refreshes the lifetime.
        tracker.observe(
            "c",
            "claude",
            Some("anthropic"),
            None,
            Some(1000),
            Some(0),
            start + 4 * MINUTE,
        );
        assert!(matches!(
            tracker.latest_for_agent("c", "claude", start + 6 * MINUTE),
            Some(CacheWarmth::Warm { .. })
        ));
    }

    #[test]
    fn each_provider_in_each_thread_keeps_its_own_countdown() {
        let start = Instant::now();
        let mut tracker = Tracker::default();
        tracker.observe(
            "a",
            "ryu",
            None,
            Some("claude-opus-4"),
            Some(10),
            None,
            start,
        );
        tracker.observe(
            "a",
            "ryu",
            None,
            Some("gpt-5.1"),
            Some(10),
            None,
            start + MINUTE,
        );
        tracker.observe(
            "b",
            "ryu",
            None,
            Some("claude-opus-4"),
            Some(10),
            None,
            start,
        );
        assert_eq!(tracker.entries.len(), 3);
        // Seven minutes on: Anthropic's 5 min cache is cold, OpenAI's 30 min is
        // not, and the agent's latest turn (GPT) is what its session would hit.
        let later = start + 7 * MINUTE;
        assert!(matches!(
            tracker.latest_for_agent("a", "ryu", later),
            Some(CacheWarmth::Warm { .. })
        ));
        assert!(matches!(
            tracker.latest_for_agent("b", "ryu", later),
            Some(CacheWarmth::Expired { .. })
        ));
        assert_eq!(tracker.latest_for_agent("a", "codex", later), None);
        assert_eq!(tracker.latest_for_agent("c", "ryu", later), None);
    }

    #[test]
    fn only_a_countdown_that_ran_out_reads_as_expired() {
        let start = Instant::now();
        let later = start + 120 * MINUTE;
        let mut tracker = Tracker::default();
        // Turn reported no cache counters: not recorded at all.
        tracker.observe("c", "ryu", None, Some("claude-opus-4"), None, None, start);
        assert_eq!(tracker.latest_for_agent("c", "ryu", later), None);
        // Zero reads and writes: the cache was never warm.
        tracker.observe(
            "c",
            "ryu",
            None,
            Some("claude-opus-4"),
            Some(0),
            Some(0),
            start,
        );
        assert_eq!(
            tracker.latest_for_agent("c", "ryu", later),
            Some(CacheWarmth::Unused)
        );
        // Implicit caches publish no expiry.
        tracker.observe(
            "g",
            "ryu",
            None,
            Some("gemini-2.5-pro"),
            Some(64),
            None,
            start,
        );
        assert_eq!(
            tracker.latest_for_agent("g", "ryu", later),
            Some(CacheWarmth::NoPublishedExpiry)
        );
    }

    #[test]
    fn usage_shapes_feed_the_tracker() {
        let conversation = "prompt-cache-warmth-usage-shapes";
        observe_usage(
            conversation,
            "agent",
            None,
            Some("claude-sonnet-4-5"),
            &serde_json::json!({ "prompt_tokens": 10, "cache_read_input_tokens": 0 }),
        );
        let warmth =
            tracker()
                .lock()
                .unwrap()
                .latest_for_agent(conversation, "agent", Instant::now());
        assert_eq!(warmth, Some(CacheWarmth::Unused));
        observe_usage(
            conversation,
            "agent",
            None,
            Some("claude-sonnet-4-5"),
            &serde_json::json!({ "prompt_tokens_details": { "cached_tokens": 512 } }),
        );
        let warmth =
            tracker()
                .lock()
                .unwrap()
                .latest_for_agent(conversation, "agent", Instant::now());
        assert!(matches!(warmth, Some(CacheWarmth::Warm { .. })));
        assert!(!expired_for_agent(conversation, "agent"));
    }

    #[test]
    fn the_oldest_entry_is_forgotten_at_capacity() {
        let start = Instant::now();
        let mut tracker = Tracker::default();
        for index in 0..=MAX_ENTRIES {
            tracker.observe(
                &format!("c{index}"),
                "ryu",
                None,
                Some("gpt-5"),
                Some(1),
                None,
                start + Duration::from_secs(index as u64),
            );
        }
        assert_eq!(tracker.entries.len(), MAX_ENTRIES);
        assert_eq!(tracker.latest_for_agent("c0", "ryu", start), None);
    }
}
