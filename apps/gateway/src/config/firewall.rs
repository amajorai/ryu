//! Firewall config, overlays, custom patterns and policies.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct FirewallConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    #[serde(default = "default_true")]
    pub scan_inbound: bool,

    #[serde(default = "default_true")]
    pub scan_outbound: bool,

    /// Action when a violation is detected
    #[serde(default)]
    pub policy: FirewallPolicy,

    #[serde(default = "default_true")]
    pub log_detections: bool,

    /// Whether PII patterns (email, phone, SSN, credit card, etc.) are redacted
    /// when policy = Sanitize. Defaults to true; set to false to suppress PII
    /// redaction while still redacting secrets.
    #[serde(default = "default_true")]
    pub redact_pii: bool,

    /// Whether secret patterns (API keys, tokens, PEM keys, connection strings)
    /// are redacted when policy = Sanitize. Defaults to true.
    #[serde(default = "default_true")]
    pub redact_secrets: bool,

    /// Whether external tool RESULTS re-entering the model on the openai-compat
    /// tool loop are wrapped in untrusted-content boundary markers and stripped
    /// of LLM chat-template control tokens (injection defense). Defaults to true;
    /// it only affects untrusted tool output (never user text), so it is safe to
    /// keep on. Set to false to disable the wrapping.
    #[serde(default = "default_true")]
    pub wrap_untrusted_tool_results: bool,

    /// User-defined firewall patterns, merged on top of the curated built-in
    /// PII/secret/injection sets when the scanner is (re)built. Each entry is a
    /// regex tagged with the category it belongs to; invalid regexes are skipped
    /// with a warning rather than failing the whole config (fail-open on the
    /// *pattern*, never on the firewall). Empty by default so existing configs
    /// keep the built-in-only behaviour.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPattern>,

    /// Notification fan-out tier when the firewall matches inbound content
    /// (orthogonal to `policy`, which is the enforcement action). Old configs →
    /// `Silent`, so a firewall with no `alert` set fires no policy alert.
    #[serde(default)]
    pub alert: AlertTier,

    /// Optional cheap-LLM traffic inspector (a detection *method*, orthogonal to
    /// `policy`, which is the *action*). Disabled by default, so existing configs
    /// deserialize unchanged. Carried on the node base so the hierarchical
    /// resolver (`firewall/resolve.rs`) has a uniform shape to merge overlays into.
    #[serde(default)]
    pub inspector: InspectorConfig,

    /// Field names this scope freezes so a narrower scope (org → agent) can only
    /// *tighten* them, never *loosen* them. On the node base this is the box
    /// admin's baseline lock set; the resolver unions locks upward and, for a
    /// locked field, keeps the stricter value. Canonical names are the serde
    /// field names: `enabled`, `scan_inbound`, `scan_outbound`, `policy`,
    /// `log_detections`, `redact_pii`, `redact_secrets`,
    /// `wrap_untrusted_tool_results`, `inspector`, `alert` (locking that one means a
    /// narrower scope may only RAISE the tier, never go quieter). Defaults to locking
    /// `enabled`, `policy`, `scan_inbound`, `scan_outbound`, `redact_pii`, and
    /// `redact_secrets`, so an org/agent overlay cannot disable inherited
    /// inbound or egress protections. A node admin opts out with an
    /// explicit `locked_fields = []`.
    #[serde(default = "default_firewall_locked_fields")]
    pub locked_fields: Vec<String>,

    /// Per-agent evaluator enablement (the unified-evaluator P1 dial). Each entry
    /// overrides one catalog evaluator; the hierarchical resolver merges them by
    /// `id` node → org → agent with the same union + per-binding lock semantics
    /// that govern the firewall dials (`firewall/resolve.rs::merge_evaluator_bindings`).
    /// Empty by default so existing configs deserialize unchanged. Nothing here
    /// executes yet (inline scanning is P3, offline scoring is P2); this phase is
    /// config plumbing + cascade + persistence only.
    #[serde(default)]
    pub evaluators: Vec<crate::evaluators::EvaluatorBinding>,
}

/// A partial [`FirewallConfig`] applied over a broader scope in the node → org →
/// agent cascade (`firewall/resolve.rs`). Every scalar is `Option`: `Some`
/// overrides the inherited value, `None` inherits it. `custom_patterns` are
/// *appended* (union, never replace); `locked_fields` freeze a field so a
/// narrower scope can only tighten it.
///
/// Wire keys are **snake_case** even though this object nests inside the
/// camelCase control-plane resolve response — serde applies `rename_all` per
/// struct, so the TS mirror and the resolve-response emitter must use snake_case
/// here. Empty overlays resolve to a byte-identical config to today's global
/// firewall.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct FirewallOverlay {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub scan_inbound: Option<bool>,
    #[serde(default)]
    pub scan_outbound: Option<bool>,
    #[serde(default)]
    pub policy: Option<FirewallPolicy>,
    #[serde(default)]
    pub log_detections: Option<bool>,
    #[serde(default)]
    pub redact_pii: Option<bool>,
    #[serde(default)]
    pub redact_secrets: Option<bool>,
    #[serde(default)]
    pub wrap_untrusted_tool_results: Option<bool>,
    /// Notification fan-out tier for this scope (see [`FirewallConfig::alert`]).
    /// `None` inherits the broader scope's tier.
    ///
    /// This is the org/agent half of alert delivery. Until it existed, `AlertTier` was
    /// `#[default] Silent` on the node base and *no* scope could raise it, so the whole
    /// fan-out — `firewall_policy_alert` (`pipeline/mod.rs`) gates on
    /// `cfg.alert >= AlertTier::Warn`, Core's webhook/Telegram/push/SMTP sinks behind
    /// it — could never fire.
    ///
    /// It is NOT node-only, and that was verified rather than assumed, because the
    /// `wrap_untrusted_tool_results` footgun (a per-scope override of a
    /// process-global, hence a silent no-op — see
    /// [`crate::firewall::resolve::normalize_overlay`]) is exactly what an unread
    /// assumption produces here. The resolved value does reach delivery:
    /// `FirewallScanner::new_scoped` stores the whole resolved [`FirewallConfig`]
    /// (`firewall/mod.rs::build`) and `config()` hands it back, so every
    /// `firewall_policy_alert(scanner.config(), …)` site is scope-aware.
    ///
    /// # Coverage is partial — three alert sites read the NODE BASE
    ///
    /// An earlier revision of this doc said flatly that "the pipeline reads
    /// `state.resolved_scanner(ctx).config()` before calling `firewall_policy_alert`",
    /// which is true of most sites but not all. Enumerated from the call sites in
    /// the `pipeline/` module rather than inferred from one of them:
    ///
    /// * **Scope-aware** (`state.resolved_scanner(ctx)`) — `pre_process` (inbound text),
    ///   `apply_inline_input_evaluators`, and `apply_inline_output_evaluators`.
    /// * **Node base only** (`state.with_firewall`, which reads the boot/hot-swap global
    ///   and ignores every overlay) — `run`'s stage-9 outbound response scan,
    ///   `run_multimodal`'s inbound scan, and `submit_video_job`'s inbound scan.
    ///
    /// So the split is NOT inbound-vs-outbound, and describing it that way is wrong in
    /// both directions: an org/agent tier *does* govern an outbound block raised by an
    /// output-target inline evaluator, and it *does not* govern the image and video
    /// handlers' inbound scans. Those three sites fire the node-base tier instead.
    /// Widening them means routing `with_firewall` through `resolved_scanner`, which is
    /// a `pipeline/` change, not a config one.
    ///
    /// Lock semantics are the shared ones: with `alert` in a broader scope's
    /// `locked_fields`, a narrower scope may only raise the tier — the `alert` arm of
    /// `resolve.rs::apply_overlay`, via `resolve.rs::louder_alert`.
    #[serde(default)]
    pub alert: Option<AlertTier>,
    #[serde(default)]
    pub inspector: Option<InspectorConfig>,
    /// Appended to the inherited pattern set (union), never replacing it.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPattern>,
    /// Field names this scope locks (see [`FirewallConfig::locked_fields`]).
    #[serde(default)]
    pub locked_fields: Vec<String>,
    /// Evaluator bindings this scope contributes to the node → org → agent
    /// cascade. `None` inherits the broader scope's set; `Some` merges by `id`
    /// (union + per-binding lock) via
    /// `firewall/resolve.rs::merge_evaluator_bindings`. Unlike
    /// `wrap_untrusted_tool_results`, this is **not** node-only — org and agent
    /// overlays may set it, so `normalize_overlay` leaves it untouched.
    #[serde(default)]
    pub evaluators: Option<Vec<crate::evaluators::EvaluatorBinding>>,
}

/// The category a [`CustomPattern`] belongs to. Determines which built-in
/// pattern set it is merged into, and therefore which toggles govern it:
/// `Pii`/`Secret` follow `redact_pii`/`redact_secrets` under the Sanitize
/// policy, and `PromptInjection` participates in inbound injection scanning.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomPatternKind {
    #[default]
    Pii,
    Secret,
    PromptInjection,
    /// Merged into the `code_injection` evaluator's pattern set (Input scanning).
    CodeInjection,
    /// Merged into the `toxicity` evaluator's lexical pattern set (Output).
    Toxicity,
    /// Merged into the `bias_fairness` evaluator's lexical pattern set (Output).
    Bias,
}

/// A single user-defined firewall pattern.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CustomPattern {
    /// Human-readable label; also used as the placeholder marker on redaction
    /// (e.g. a `name` of `internal_id` redacts to `[REDACTED:INTERNAL_ID]`).
    pub name: String,
    /// The regular expression, in the `regex` crate's syntax. The crate is
    /// backtracking-free, so caller-supplied patterns cannot cause catastrophic
    /// (ReDoS) blow-up.
    pub regex: String,
    /// Which built-in category this pattern is merged into.
    #[serde(default)]
    pub kind: CustomPatternKind,
}

impl Default for FirewallConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scan_inbound: true,
            scan_outbound: true,
            policy: FirewallPolicy::default(),
            log_detections: true,
            redact_pii: true,
            redact_secrets: true,
            wrap_untrusted_tool_results: true,
            custom_patterns: Vec::new(),
            alert: AlertTier::default(),
            inspector: InspectorConfig::default(),
            locked_fields: default_firewall_locked_fields(),
            evaluators: Vec::new(),
        }
    }
}

/// The node-base lock set applied when `locked_fields` is omitted. Inbound and
/// egress protection settings cannot be loosened by narrower overlays.
/// Kept in sorted order so a resolve of the bare node
/// base is byte-identical to the resolver's sorted lock union (stable
/// scanner-cache keys).
pub(super) fn default_firewall_locked_fields() -> Vec<String> {
    vec![
        "enabled".to_string(),
        "policy".to_string(),
        "redact_pii".to_string(),
        "redact_secrets".to_string(),
        "scan_inbound".to_string(),
        "scan_outbound".to_string(),
    ]
}

pub(super) fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FirewallPolicy {
    /// Reject the request with a 403. This is the **default**: prompt-injection
    /// matches are not meaningfully redactable, so blocking is the only action
    /// that actually stops a detected injection from reaching the model.
    /// Redact-and-continue is opt-in via `Sanitize`.
    #[default]
    Block,
    /// Log the detection but allow the request through
    WarnAndContinue,
    /// Replace detected patterns with placeholder text: a detected secret/PII is
    /// redacted before egress (the leak is closed) while the request still
    /// succeeds (local-first UX preserved). Prompt-injection matches are not
    /// meaningfully redactable, so under Sanitize they proceed with any
    /// co-located PII/secrets scrubbed and the injection text left intact —
    /// which is why Sanitize is opt-in rather than the default.
    Sanitize,
}

impl FirewallPolicy {
    /// Parse a firewall policy from an environment-variable value. Accepts the
    /// snake_case names plus a couple of friendly aliases. Returns `None` for
    /// an unrecognised value so the caller can keep the existing config.
    pub(super) fn from_env(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "block" => Some(Self::Block),
            "warn_and_continue" | "warn" | "warn-and-continue" => Some(Self::WarnAndContinue),
            "sanitize" | "redact" => Some(Self::Sanitize),
            _ => None,
        }
    }
}
