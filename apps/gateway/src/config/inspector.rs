//! The LLM traffic inspector config and the classify-tier model id.

use super::*;

/// The swappable cheap-LLM traffic inspector — a detection *method* that runs
/// alongside the regex scanner. It calls a model directly (never the tool loop,
/// so it cannot recurse). A judge that gives no usable verdict (a refusal, a
/// filtered, cut-off, empty or unparseable reply, an outage or a timeout)
/// follows [`Self::fail_mode`]: closed by default under Block, open otherwise.
/// See `firewall/inspector.rs`.
///
/// Wire keys are **snake_case** (see [`FirewallOverlay`]).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct InspectorConfig {
    /// Master switch. Default: false (opt-in — it adds a model round-trip).
    #[serde(default)]
    pub enabled: bool,
    /// Model id used for inspection, resolved through the normal
    /// [`crate::router::ModelRouter`] so it stays swappable (local, hosted, or an
    /// `openrouter/…` slug).
    ///
    /// Defaults to [`classify_model_id`] — the classify-tier classifier, resolved
    /// from the id Core published for the sidecar it actually runs — and an
    /// **empty value is resolved to that default at deserialization** (see
    /// [`de_inspector_model`]), so this field is never empty in practice.
    ///
    /// It used to default to `""` with a doc comment claiming "empty ⇒ the
    /// gateway's default model". That was false and load-bearing: `route("")`
    /// matches no map and no prefix, so it fell through to `default_provider`,
    /// which then stamped `"model": ""` on the payload and got a 400 from any
    /// real upstream. The inspector failed open then, so turning the guardrail on
    /// without *also* remembering to pick a model produced a guardrail that
    /// silently never fired while `action` still read `Block`. Resolving the
    /// empty case here — at the one construction seam every reader flows through
    /// — is what makes "enabled" mean "working".
    #[serde(
        default = "default_inspector_model",
        deserialize_with = "de_inspector_model"
    )]
    pub model: String,
    /// What the inspector looks for. Default: [`InspectorMode::Both`].
    #[serde(default)]
    pub mode: InspectorMode,
    /// Skip inspection for turns shorter than this many characters (trivial
    /// prompts rarely carry an attack and every call costs a round-trip).
    #[serde(default = "default_inspector_min_chars")]
    pub min_chars: usize,
    /// Per-inspection timeout in milliseconds. A timeout is a missing verdict,
    /// handled by [`Self::fail_mode`]. Default: 1500.
    #[serde(default = "default_inspector_timeout_ms")]
    pub timeout_ms: u64,
    /// The action taken when the inspector flags a turn, reusing the firewall's
    /// [`FirewallPolicy`] (Block / Sanitize / WarnAndContinue). Default: block
    /// (the shared [`FirewallPolicy`] default).
    #[serde(default)]
    pub action: FirewallPolicy,
    /// What a missing verdict does: `closed` turns it into a flag carrying the
    /// `inspector_unavailable` category, which [`Self::action`] then applies;
    /// `open` lets the turn through with a warning. Unset (the default) means
    /// closed when `action` is block and open otherwise; read the resolved
    /// value through [`Self::effective_fail_mode`]. Wire values are lowercase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_mode: Option<InspectorFailMode>,
    /// The judge's window budget per turn: windows of about 4,000 characters,
    /// judged newest first. A turn longer than the budget is never judged in
    /// part and passed: its oldest content is unjudged, which is a missing
    /// verdict ([`Self::fail_mode`]). Raise it to judge longer conversations,
    /// lower it to bound the judge's cost per turn. Read through
    /// [`Self::effective_max_windows`], which keeps it within
    /// 1..=[`MAX_INSPECTOR_WINDOWS`]. Default: 16 (about 60,000 characters).
    #[serde(
        default = "default_inspector_max_windows",
        skip_serializing_if = "is_default_inspector_max_windows"
    )]
    pub max_windows: usize,
}

/// The default judge window budget per turn (about 60,000 characters).
pub const DEFAULT_INSPECTOR_WINDOWS: usize = 16;
/// The largest window budget a config may set (about 240,000 characters).
pub const MAX_INSPECTOR_WINDOWS: usize = 64;

pub(super) fn default_inspector_max_windows() -> usize {
    DEFAULT_INSPECTOR_WINDOWS
}

fn is_default_inspector_max_windows(windows: &usize) -> bool {
    *windows == DEFAULT_INSPECTOR_WINDOWS
}

/// How the inspector treats a turn it could not judge. Wire values are
/// `"open"` and `"closed"`.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InspectorFailMode {
    /// Allow the turn with a warning.
    Open,
    /// Flag the turn so the configured action applies to it.
    Closed,
}

impl InspectorFailMode {
    /// The mode an unset `fail_mode` takes: closed under Block, open otherwise.
    pub fn default_for(action: &FirewallPolicy) -> Self {
        if *action == FirewallPolicy::Block {
            Self::Closed
        } else {
            Self::Open
        }
    }
}

impl InspectorConfig {
    /// The window budget in force: [`Self::max_windows`] within
    /// 1..=[`MAX_INSPECTOR_WINDOWS`].
    pub fn effective_max_windows(&self) -> usize {
        self.max_windows.clamp(1, MAX_INSPECTOR_WINDOWS)
    }

    /// The fail mode in force: the explicit `fail_mode`, else the default for
    /// `action` ([`InspectorFailMode::default_for`]).
    pub fn effective_fail_mode(&self) -> InspectorFailMode {
        self.fail_mode
            .unwrap_or_else(|| InspectorFailMode::default_for(&self.action))
    }

    /// The `fail_mode` a locked inspector keeps when `incoming` is merged into
    /// it: closed if either side is effectively closed (a narrower scope can
    /// close a locked inspector but never open it), unset if both are unset,
    /// open otherwise.
    pub fn stricter_fail_mode(&self, incoming: &Self) -> Option<InspectorFailMode> {
        let closed = InspectorFailMode::Closed;
        if self.effective_fail_mode() == closed || incoming.effective_fail_mode() == closed {
            Some(closed)
        } else if self.fail_mode.is_none() && incoming.fail_mode.is_none() {
            None
        } else {
            Some(InspectorFailMode::Open)
        }
    }
}

/// What the LLM inspector scans for. Shapes the inspection prompt.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectorMode {
    /// Prompt-injection / jailbreak attempts only.
    Injection,
    /// PII / secret data-leak detection only.
    Dlp,
    /// Both injection and DLP. The default.
    #[default]
    Both,
}

/// Env var Core publishes alongside `RYU_CLASSIFY_LLM_URL`: the **resolved
/// registry id** of the model the classify sidecar actually serves
/// (`ModelRegistry::local_classifier_model.id`, itself
/// overridable via `RYU_LOCAL_CLASSIFIER_MODEL_ID`). Set in
/// `apps/core/src/sidecar/gateway.rs::gateway_spawn_env`.
///
/// This closes the seam `sidecar/providers/llamacpp/classify.rs` documents as
/// "swappable registry defaults, never hardcoded": before it existed the gateway
/// knew the classify tier's **URL** but not its **id**, so
/// [`DEFAULT_INSPECTOR_MODEL`] was an independent literal and an operator who
/// swapped the registry id got an inspector default that no longer named the model
/// on the other end of the URL.
pub(super) const ENV_CLASSIFY_MODEL_ID: &str = "RYU_CLASSIFY_MODEL_ID";

/// Compile-time fallback classify-tier model id, used only when Core has not
/// published [`ENV_CLASSIFY_MODEL_ID`] (a standalone gateway). Kept in lockstep
/// with Core's `registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID`; it is the id the
/// `"gemma-3-270m"` built-in prefix routes to the `classify` provider (see
/// `ryu_gw_router::builtin_prefixes`). Cheap enough to sit in front of every turn,
/// and local — so the default guardrail never leaks traffic to a hosted provider
/// or spends a cent.
///
/// Prefer [`classify_model_id`] over this constant: on a Core-spawned gateway the
/// published id is authoritative and may differ from this literal.
pub const DEFAULT_INSPECTOR_MODEL: &str = "gemma-3-270m-it-qat-Q4_0";

/// The classify tier's resolved model id: Core's published
/// [`ENV_CLASSIFY_MODEL_ID`] when present, else [`DEFAULT_INSPECTOR_MODEL`].
///
/// The single reader of that env var, so "which id is the classifier" has one
/// answer for the inspector default, the LLM-judge default, and the seeded
/// `model_map` route ([`seed_classify_route`]).
pub fn classify_model_id() -> String {
    resolve_classify_model_id(std::env::var(ENV_CLASSIFY_MODEL_ID).ok().as_deref())
}

/// Pure core of [`classify_model_id`] — split out so the precedence is testable
/// without mutating the process environment (the gateway has no env test lock).
/// A blank published value is treated as absent: Core pushes the var
/// unconditionally, so an empty string must never become "the classifier is
/// named nothing" (that is the exact failure `de_inspector_model` exists to stop).
pub(super) fn resolve_classify_model_id(published: Option<&str>) -> String {
    published
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_INSPECTOR_MODEL)
        .to_owned()
}

pub(super) fn default_inspector_model() -> String {
    classify_model_id()
}

/// Resolve a blank `inspector.model` to [`classify_model_id`] as the value is
/// read off the wire.
///
/// This is the **single** choke point: `#[serde(default = …)]` alone only covers
/// an *absent* field, but the UI and the `PUT /v1/config` overlay path both send
/// an explicit `""` when an operator clears the box, and `firewall/resolve.rs`
/// clones deserialized overlays wholesale into the resolved config. Normalizing
/// here means every consumer that reads the plain `model` field — the inspector
/// (`firewall/inspector.rs`) *and* the `EvaluatorImpl::LlmJudge` arm in
/// `pipeline/inline_flags.rs`, which reads `scanner.config().inspector.model` regardless
/// of `inspector.enabled` — gets a working id without either of them needing a
/// resolution call of its own.
pub(super) fn de_inspector_model<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(if raw.trim().is_empty() {
        default_inspector_model()
    } else {
        raw
    })
}

pub(super) fn default_inspector_min_chars() -> usize {
    40
}

pub(super) fn default_inspector_timeout_ms() -> u64 {
    1500
}

impl Default for InspectorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // Non-empty by default so `..InspectorConfig::default()` — how every
            // struct-literal construction in the codebase fills this field — can
            // never reintroduce the empty-model trap documented on `model`.
            model: default_inspector_model(),
            mode: InspectorMode::default(),
            min_chars: default_inspector_min_chars(),
            timeout_ms: default_inspector_timeout_ms(),
            action: FirewallPolicy::default(),
            fail_mode: None,
            max_windows: DEFAULT_INSPECTOR_WINDOWS,
        }
    }
}

#[cfg(test)]
#[path = "tests/inspector_fail_mode_tests.rs"]
mod inspector_fail_mode_tests;
