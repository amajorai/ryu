//! User-facing controls over how long-term memory behaves in chat — the
//! Hermes/Honcho-style knobs (`recall_mode`, `recall_budget`,
//! `recall_min_relevance`, `write_frequency`) surfaced as plugin settings on
//! `@ryu/memory`.
//!
//! ## Why this is a policy object and not three scattered reads
//!
//! Memory touches the chat path in three separate places — the recency block
//! (`assemble_long_term_system_message`), the semantic auto-recall
//! (`run_auto_recall`), and the per-turn write (`record_turn_memory`) — all inside
//! `sidecar::adapters::route_chat_stream`. Reading three preferences at three call
//! sites is how the three drift apart: "recall is off" must mean BOTH recall paths,
//! not whichever one the reader remembered. So the policy is resolved ONCE per turn
//! and passed down.
//!
//! ## Relationship to the existing `enable_long_term` request flag
//!
//! `enable_long_term` is the per-REQUEST opt-in (privacy-by-default: a request that
//! does not ask for memory gets none). This policy is the per-NODE preference that
//! applies when a request DID ask. The two compose as an AND — the policy can only
//! ever narrow what the request enabled, never widen it. That ordering is what keeps
//! privacy-by-default intact: no preference can turn memory on for a caller that did
//! not request it.
//!
//! ## Defaults preserve existing behaviour exactly
//!
//! Every default here reproduces the pre-policy behaviour byte-for-byte
//! ([`RecallMode::Auto`], [`DEFAULT_LONG_TERM_LIMIT`], [`RecallMinRelevance::Off`],
//! [`WriteFrequency::PerTurn`]), so a node that never opens the settings sees no change.

use ryu_memory::DEFAULT_LONG_TERM_LIMIT;

/// Preference key: how memory is recalled into a chat turn.
pub const RECALL_MODE_KEY: &str = "memory.recall-mode";
/// Preference key: how much memory a turn may recall.
pub const RECALL_BUDGET_KEY: &str = "memory.recall-budget";
/// Preference key: how relevant a fact must be before auto-recall injects it.
pub const RECALL_MIN_RELEVANCE_KEY: &str = "memory.recall-min-relevance";
/// Preference key: when durable facts are written.
pub const WRITE_FREQUENCY_KEY: &str = "memory.write-frequency";
/// Preference key: echo built-in writes to the selected external provider.
pub const MIRROR_BUILTIN_KEY: &str = "memory.mirror-builtin";
/// Preference key: hand raw turns to the external provider for its own extraction.
pub const SYNC_TURNS_KEY: &str = "memory.sync-turns";
/// Preference key: inject the external provider's standing summary each turn.
pub const PROVIDER_CONTEXT_KEY: &str = "memory.provider-context";
/// Per-turn composer flag that opts a temporary chat into read-only
/// personalized context. The temporary-chat privacy boundary still prevents
/// conversation and memory writes; this only permits reading existing context.
pub const TEMPORARY_CONTEXT_FLAG: &str = "@ryu/memory/temporary-context";

/// How memory enters a chat turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RecallMode {
    /// Nothing is recalled automatically and nothing is injected. The model can
    /// still deliberately call `memory.search`, which is the point of keeping this
    /// distinct from disabling the memory layer outright.
    Off,
    /// No automatic injection, but the memory tools stay available — recall becomes
    /// something the model decides to do, not something that happens to every turn.
    Manual,
    /// Both the recency block and semantic auto-recall run. The default, and what
    /// every node did before this preference existed.
    #[default]
    Auto,
}

impl RecallMode {
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            "off" => Self::Off,
            "manual" => Self::Manual,
            _ => Self::Auto,
        }
    }

    /// Whether memory should be assembled into the prompt without being asked.
    pub fn injects_automatically(self) -> bool {
        matches!(self, Self::Auto)
    }
}

/// How much memory a single turn may pull in. A budget rather than a raw count so
/// the tuning stays meaningful if the retrieval strategy changes underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RecallBudget {
    /// Few facts — cheapest, least context spent.
    Low,
    /// The pre-existing default.
    #[default]
    Mid,
    /// More facts, at the cost of prompt space.
    High,
}

impl RecallBudget {
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            "low" => Self::Low,
            "high" => Self::High,
            _ => Self::Mid,
        }
    }

    /// Long-term entries recalled per turn. `Mid` is exactly
    /// [`DEFAULT_LONG_TERM_LIMIT`], so an unconfigured node is unchanged.
    pub fn long_term_limit(self) -> usize {
        match self {
            Self::Low => 2,
            Self::Mid => DEFAULT_LONG_TERM_LIMIT,
            Self::High => DEFAULT_LONG_TERM_LIMIT * 3,
        }
    }

    /// Characters the injected recency block may spend on rendered notes per
    /// turn. Recall stops adding notes once the next one would exceed it, so
    /// long captured turns cannot crowd the prompt however many fit the count.
    pub fn char_budget(self) -> usize {
        match self {
            Self::Low => 1_000,
            Self::Mid => 2_500,
            Self::High => 6_000,
        }
    }
}

/// How relevant a long-term fact must be before semantic auto-recall injects it.
///
/// Without a floor the retrieval path returns the `top_k` nearest facts however
/// far they are, so a turn with nothing relevant still spends prompt space on
/// unrelated memories. Retrieval scores are cosine similarity under the
/// configured embedder, plus a small importance nudge (see
/// `ryu_rag::RetrievalOptions::min_score`), and their scale depends on that
/// embedder: the built-in hashing embedder scores unrelated text near zero,
/// while many hosted models score it well above that. So each level is a share
/// of the range ABOVE the embedder's own unrelated-text baseline
/// ([`Self::min_score_above`], measured by
/// `RetrievalStore::unrelated_similarity_baseline`), not one raw cut for every
/// embedder. The default stays `Off`: filtering is something the user opts into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RecallMinRelevance {
    /// Inject the nearest facts regardless of score. The pre-existing behaviour.
    #[default]
    Off,
    /// Drop only clearly unrelated facts.
    Low,
    /// Keep facts with a moderate match.
    Medium,
    /// Keep only close matches; recall more often injects nothing.
    High,
}

impl RecallMinRelevance {
    /// Parse a stored preference. Absent or unrecognised values keep `Off`, so a
    /// garbled preference can never silently hide memories.
    pub fn from_pref(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("low") => Self::Low,
            Some("medium") => Self::Medium,
            Some("high") => Self::High,
            _ => Self::Off,
        }
    }

    /// The floor for an embedder that scores unrelated text at zero, which is
    /// also the level's share of the range above any other embedder's baseline.
    /// `Off` is exactly `0.0`, the retrieval default, so an unconfigured node is
    /// unchanged.
    pub fn min_score(self) -> f32 {
        match self {
            Self::Off => 0.0,
            Self::Low => 0.2,
            Self::Medium => 0.35,
            Self::High => 0.5,
        }
    }

    /// The floor for an embedder whose unrelated text scores up to `baseline`:
    /// the baseline plus this level's share of the range above it. `Off` stays
    /// `0.0` whatever the baseline; an unusable baseline counts as zero.
    pub fn min_score_above(self, baseline: f32) -> f32 {
        let share = self.min_score();
        if share == 0.0 {
            return 0.0;
        }
        let baseline = if baseline.is_finite() {
            baseline.clamp(0.0, MAX_RECALL_BASELINE)
        } else {
            0.0
        };
        baseline + share * (1.0 - baseline)
    }

    /// The floor auto-recall passes to retrieval for `retrieval`'s current
    /// embedder. `Off` never measures anything. If the baseline cannot be
    /// measured (the embedder is unreachable), the floor is `0.0`: a measurement
    /// failure must never silently hide memories.
    pub async fn calibrated_min_score(self, retrieval: &ryu_rag::RetrievalStore) -> f32 {
        if self == Self::Off {
            return 0.0;
        }
        match retrieval.unrelated_similarity_baseline().await {
            Ok(baseline) => self.min_score_above(baseline),
            Err(error) => {
                tracing::warn!(%error, "could not measure the embedder's recall baseline; recall is unfiltered this turn");
                0.0
            }
        }
    }
}

/// The highest baseline [`RecallMinRelevance::min_score_above`] accepts, so
/// every level keeps some range between matches and noise.
const MAX_RECALL_BASELINE: f32 = 0.9;

/// When durable facts are captured from a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WriteFrequency {
    /// Never capture. Read-only memory: existing facts still recall, but the session
    /// adds nothing. Distinct from `recall_mode = off`, and the two are independent —
    /// "remember nothing new but use what you know" is a real preference.
    Never,
    /// Capture from each turn, as before.
    #[default]
    PerTurn,
    /// Judgment-based writing: raw turns are not stored. Dream reads the saved
    /// transcripts instead and proposes durable facts for the user to accept, so
    /// this captures nothing unless Remember chats and Dream are both on.
    Reviewed,
}

impl WriteFrequency {
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            "never" => Self::Never,
            "reviewed" => Self::Reviewed,
            _ => Self::PerTurn,
        }
    }

    /// Whether this turn should write.
    pub fn writes_this_turn(self) -> bool {
        matches!(self, Self::PerTurn)
    }
}

/// The resolved per-node memory policy for one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryPolicy {
    pub recall_mode: RecallMode,
    pub recall_budget: RecallBudget,
    /// Minimum relevance for semantically auto-recalled facts.
    pub recall_min_relevance: RecallMinRelevance,
    pub write_frequency: WriteFrequency,
    /// Echo each fact the built-in store records to the selected external provider,
    /// so the two do not drift. Inert while the built-in is the selected provider.
    pub mirror_builtin: bool,
    /// Hand raw turns to the external provider and let IT extract. Distinct from
    /// mirroring a fact this node already curated — a user may want either, both, or
    /// neither, which is why they are separate knobs.
    pub sync_turns: bool,
    /// Inject the external provider's own standing summary of the user each turn.
    /// Off by default: it costs prompt space every single turn, and only providers
    /// that model a user over time have anything to say.
    pub provider_context: bool,
    /// Server-resolved per-user consent for special-category memory. This is not
    /// loaded from the node-global preference table; the chat caller overlays it
    /// from `MemoryStore` after resolving the verified user.
    pub include_sensitive_topics: bool,
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            recall_mode: RecallMode::default(),
            recall_budget: RecallBudget::default(),
            recall_min_relevance: RecallMinRelevance::default(),
            write_frequency: WriteFrequency::default(),
            // Mirroring ON: once a user has deliberately selected an external
            // provider, a built-in write that never reaches it is the surprising
            // outcome — the two stores would silently diverge.
            mirror_builtin: true,
            // Sync and context OFF: both send or spend more than the user asked for
            // (raw turns leaving the node; prompt space on every turn), so they are
            // opt-in.
            sync_turns: false,
            provider_context: false,
            include_sensitive_topics: false,
        }
    }
}

impl MemoryPolicy {
    /// Overlay the server-resolved per-user sensitive-topic consent onto the
    /// otherwise node-level turn policy.
    #[must_use]
    pub fn with_sensitive_topics(mut self, enabled: bool) -> Self {
        self.include_sensitive_topics = enabled;
        self
    }

    /// Resolve from the three preference values. Any unrecognised or absent value
    /// falls back to the default, which reproduces pre-policy behaviour — a garbled
    /// preference must never silently disable a user's memory.
    pub fn from_raw(
        recall_mode: Option<&str>,
        recall_budget: Option<&str>,
        write_frequency: Option<&str>,
    ) -> Self {
        Self {
            recall_mode: recall_mode.map(RecallMode::parse).unwrap_or_default(),
            recall_budget: recall_budget.map(RecallBudget::parse).unwrap_or_default(),
            write_frequency: write_frequency
                .map(WriteFrequency::parse)
                .unwrap_or_default(),
            ..Self::default()
        }
    }

    /// Parse a stored toggle, falling back to `default` for absent or garbled values
    /// so a typo never flips a bridge the user did not ask to flip.
    fn parse_flag(raw: Option<&str>, default: bool) -> bool {
        match raw.map(str::trim) {
            Some("true") => true,
            Some("false") => false,
            _ => default,
        }
    }

    /// Load from the preferences store. Never fails: an unreadable store yields the
    /// defaults, so a preferences outage degrades to "behave as before" rather than
    /// to "memory silently stops working".
    pub async fn load(prefs: &crate::server::preferences::PreferencesStore) -> Self {
        let recall_mode = prefs.get(RECALL_MODE_KEY).await.ok().flatten();
        let recall_budget = prefs.get(RECALL_BUDGET_KEY).await.ok().flatten();
        let min_relevance = prefs.get(RECALL_MIN_RELEVANCE_KEY).await.ok().flatten();
        let write_frequency = prefs.get(WRITE_FREQUENCY_KEY).await.ok().flatten();
        let mirror = prefs.get(MIRROR_BUILTIN_KEY).await.ok().flatten();
        let sync = prefs.get(SYNC_TURNS_KEY).await.ok().flatten();
        let provider_context = prefs.get(PROVIDER_CONTEXT_KEY).await.ok().flatten();
        let defaults = Self::default();
        Self {
            recall_min_relevance: RecallMinRelevance::from_pref(min_relevance.as_deref()),
            mirror_builtin: Self::parse_flag(mirror.as_deref(), defaults.mirror_builtin),
            sync_turns: Self::parse_flag(sync.as_deref(), defaults.sync_turns),
            provider_context: Self::parse_flag(
                provider_context.as_deref(),
                defaults.provider_context,
            ),
            ..Self::from_raw(
                recall_mode.as_deref(),
                recall_budget.as_deref(),
                write_frequency.as_deref(),
            )
        }
    }

    /// Whether automatic recall should run for a request that asked for memory.
    ///
    /// Takes `request_enabled` so the AND with the per-request opt-in is expressed
    /// in ONE place rather than re-derived at each call site — the drift this module
    /// exists to prevent.
    pub fn should_auto_recall(self, request_enabled: bool) -> bool {
        request_enabled && self.recall_mode.injects_automatically()
    }

    /// Whether this turn should capture a durable fact.
    pub fn should_write(self, request_enabled: bool) -> bool {
        request_enabled && self.write_frequency.writes_this_turn()
    }

    /// Whether a temporary request explicitly opted into personalized context.
    /// A false `persist` value is the server-side temporary-chat boundary; the
    /// client flag alone must never broaden a normal saved turn's policy.
    pub fn temporary_context_enabled(persist: bool, flag_enabled: bool) -> bool {
        !persist && flag_enabled
    }

    /// Resolve the personalized context allowed for one request. Saved chats
    /// use their ordinary request opt-in; temporary chats need the explicit
    /// composer opt-in and never inherit `enable_long_term` into a read/write
    /// exception by accident.
    pub fn context_enabled(
        request_enabled: bool,
        persist: bool,
        temporary_flag_enabled: bool,
    ) -> bool {
        (persist && request_enabled)
            || Self::temporary_context_enabled(persist, temporary_flag_enabled)
    }
}

#[cfg(test)]
#[path = "memory_policy_tests.rs"]
mod tests;
