use super::*;

/// Stable failed-turn information carried from the ACP boundary to Core's
/// stream and persistence layers. Keeping the code, title, and recovery copy
/// together prevents the live error frame and reloaded transcript from
/// disagreeing about what failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpFailure {
    pub code: String,
    pub title: String,
    pub message: String,
}

/// Lets a start-up step attach its classified failure as `anyhow` context, so
/// [`instance_start_failure`] can recover it from the error that ended the
/// instance.
impl std::fmt::Display for AcpFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} ({}): {}",
            self.title, self.code, self.message
        )
    }
}

fn has_payment_required_marker(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("provider_payment_required")
        || lower.contains("insufficient_credits")
        || lower.contains("payment required")
        || lower.contains("http 402")
        || lower.contains("error 402")
        || lower.contains("no credits")
        || lower.contains("insufficient credit")
        || lower.contains("credit balance exhausted")
}

/// Turn an opaque pi-acp JSON-RPC failure into the recovery the selected
/// provider actually needs. ACP does not expose the upstream HTTP status as a
/// typed field, so the managed Pi's Core-owned active provider supplies the
/// missing context while stable Gateway markers confirm this is a 402.
pub(super) fn classify_prompt_failure(active_provider: Option<&str>, detail: &str) -> AcpFailure {
    let payment_required = has_payment_required_marker(detail);
    let lower_detail = detail.to_ascii_lowercase();
    if active_provider == Some("anthropic")
        && lower_detail.contains("third-party apps")
        && lower_detail.contains("extra usage")
    {
        return AcpFailure {
            code: "provider_usage_unavailable".to_owned(),
            title: "Claude usage unavailable".to_owned(),
            message: "Your Claude account is connected, but Anthropic rejected this third-party request. Check your Claude Usage settings and any required usage credits, or choose another connected provider."
                .to_owned(),
        };
    }
    if active_provider == Some(crate::pi_config::MANAGED_OPENROUTER_ID) && payment_required {
        return AcpFailure {
            code: "insufficient_credits".to_owned(),
            title: "Ryu credits exhausted".to_owned(),
            message: "Your organization's Ryu credits are exhausted. Open Settings > Credits to top up, or choose a BYOK or local model, then retry."
                .to_owned(),
        };
    }
    if active_provider == Some("openrouter") && payment_required {
        return AcpFailure {
            code: "provider_payment_required".to_owned(),
            title: "OpenRouter credits exhausted".to_owned(),
            message: "The OpenRouter API key on this node has no prepaid credits left. Add credits to your OpenRouter account or choose another provider, then retry."
                .to_owned(),
        };
    }
    AcpFailure {
        code: "agent_error".to_owned(),
        title: "Request failed".to_owned(),
        message: format!(
            "The agent could not complete the turn because its model provider is unavailable or misconfigured. Check Settings > Engines, then retry. (details: {detail})"
        ),
    }
}

/// A snapshot of ACP's `PromptResponse.usage` counters for ONE turn (feature
/// `unstable_end_turn_token_usage`, called `unstable_session_usage` before 3.x).
///
/// The schema contradicts itself: `PromptResponse.usage` is documented as
/// "token usage for this turn" while the `Usage` struct's fields say "across
/// session". The agents that actually send it report the turn:
/// claude-agent-acp resets its tally when each turn starts, and codex-acp
/// reports the prompt's end total minus its start total. Core used to diff
/// consecutive responses as if they were cumulative, which dropped every first
/// turn (no baseline) and turned turn N into `N − (N−1)`.
///
/// Fields are `Option` because all but the first three are optional in the
/// schema and end-of-turn usage support is sparse and per-agent — an
/// absent counter must stay absent all the way to the UI, never become a zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AcpUsageSnapshot {
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

impl AcpUsageSnapshot {
    /// Read a serialized ACP `Usage` (camelCase, see the schema crate).
    pub(crate) fn from_value(v: &serde_json::Value) -> Self {
        let get = |k: &str| v.get(k).and_then(serde_json::Value::as_u64);
        Self {
            cached_read_tokens: get("cachedReadTokens"),
            cached_write_tokens: get("cachedWriteTokens"),
            input_tokens: get("inputTokens"),
            output_tokens: get("outputTokens"),
            thought_tokens: get("thoughtTokens"),
            total_tokens: get("totalTokens"),
        }
    }

    /// Total input with cache reads and writes included — what the desktop's
    /// hit rate and cache-miss rows divide by. claude-agent-acp and codex-acp
    /// both report `inputTokens` WITHOUT cache tokens (their `totalTokens` is
    /// input + output + reads + writes); an agent whose input already counts
    /// the cache shows it as `totalTokens == inputTokens + outputTokens`.
    pub(crate) fn prompt_tokens_with_cache(&self) -> Option<u64> {
        let input = self.input_tokens?;
        let cache = self
            .cached_read_tokens
            .unwrap_or(0)
            .saturating_add(self.cached_write_tokens.unwrap_or(0));
        if cache == 0 {
            return Some(input);
        }
        let already_included = matches!(
            (self.total_tokens, self.output_tokens),
            (Some(total), Some(output)) if total == input.saturating_add(output)
        );
        Some(if already_included {
            input
        } else {
            input.saturating_add(cache)
        })
    }
}

/// Usage a managed Pi reports for its own assistant messages, through the ACP
/// tool broker's `report_usage` action (sent by the `ryu-mcp` Pi extension).
/// pi-acp forwards only context occupancy, so this side channel is how the
/// flagship agent's token and cache counts reach the turn's stats. Summed per
/// conversation + agent while the turn runs and taken when it ends.
fn reported_usage() -> &'static Mutex<BTreeMap<String, AcpUsageSnapshot>> {
    static REPORTED: OnceLock<Mutex<BTreeMap<String, AcpUsageSnapshot>>> = OnceLock::new();
    REPORTED.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Bound on concurrently tracked conversations; reports past it are dropped
/// rather than letting a misbehaving caller grow Core's memory.
const MAX_REPORTED_USAGE_KEYS: usize = 512;

fn reported_usage_key(conversation_id: &str, agent_id: &str) -> String {
    format!("{conversation_id}\u{1f}{agent_id}")
}

/// Add one assistant message's usage (Pi's `Usage`: `input`, `output`,
/// `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`). Returns `false`
/// when the body carries no token counts.
pub(crate) fn record_reported_usage(
    conversation_id: &str,
    agent_id: &str,
    usage: &serde_json::Value,
) -> bool {
    let get = |key: &str| usage.get(key).and_then(serde_json::Value::as_u64);
    let message = AcpUsageSnapshot {
        input_tokens: get("input"),
        output_tokens: get("output"),
        cached_read_tokens: get("cacheRead"),
        cached_write_tokens: get("cacheWrite"),
        thought_tokens: get("reasoning").filter(|tokens| *tokens > 0),
        total_tokens: get("totalTokens"),
    };
    if message.input_tokens.is_none() && message.output_tokens.is_none() {
        return false;
    }
    let Ok(mut map) = reported_usage().lock() else {
        return false;
    };
    let key = reported_usage_key(conversation_id, agent_id);
    if !map.contains_key(&key) && map.len() >= MAX_REPORTED_USAGE_KEYS {
        return false;
    }
    let sum = map.entry(key).or_default();
    let add = |total: Option<u64>, value: Option<u64>| match (total, value) {
        (None, None) => None,
        (total, value) => Some(total.unwrap_or(0).saturating_add(value.unwrap_or(0))),
    };
    *sum = AcpUsageSnapshot {
        input_tokens: add(sum.input_tokens, message.input_tokens),
        output_tokens: add(sum.output_tokens, message.output_tokens),
        cached_read_tokens: add(sum.cached_read_tokens, message.cached_read_tokens),
        cached_write_tokens: add(sum.cached_write_tokens, message.cached_write_tokens),
        thought_tokens: add(sum.thought_tokens, message.thought_tokens),
        total_tokens: add(sum.total_tokens, message.total_tokens),
    };
    true
}

/// Take (and clear) the usage reported for this conversation's current turn.
pub(crate) fn take_reported_usage(
    conversation_id: &str,
    agent_id: &str,
) -> Option<AcpUsageSnapshot> {
    reported_usage()
        .lock()
        .ok()?
        .remove(&reported_usage_key(conversation_id, agent_id))
}

/// Fill a turn-end usage frame from the side channel when the agent's own
/// response carried no token counts. Always clears the turn's report.
pub(crate) fn merge_reported_usage(
    conversation_id: &str,
    agent_id: &str,
    frame: &mut serde_json::Value,
) {
    let Some(turn) = take_reported_usage(conversation_id, agent_id) else {
        return;
    };
    let Some(obj) = frame.as_object_mut() else {
        return;
    };
    if obj.contains_key("promptTokens") || obj.contains_key("completionTokens") {
        return;
    }
    let total = turn
        .total_tokens
        .or_else(|| total_usage_tokens(turn.prompt_tokens_with_cache()?, turn.output_tokens?));
    for (key, value) in [
        ("promptTokens", turn.prompt_tokens_with_cache()),
        ("completionTokens", turn.output_tokens),
        ("totalTokens", total),
        ("thoughtTokens", turn.thought_tokens),
        ("cachedReadTokens", turn.cached_read_tokens),
        ("cachedWriteTokens", turn.cached_write_tokens),
    ] {
        if let Some(value) = value {
            obj.insert(key.to_owned(), value.into());
        }
    }
}

/// Usage carried in a prompt response's `_meta.quota.token_count` — the only
/// place gemini-cli reports tokens (snake_case `input_tokens`/`output_tokens`),
/// and a mirror of `usage` on claude-agent-acp and codex-acp. Returned as a
/// camelCase ACP `Usage` object so it flows through the same path.
pub(crate) fn usage_from_quota_meta(meta: &serde_json::Value) -> Option<serde_json::Value> {
    let count = meta.get("quota")?.get("token_count")?;
    let read = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| count.get(*key).and_then(serde_json::Value::as_u64))
    };
    let mut usage = serde_json::Map::new();
    for (target, keys) in [
        ("inputTokens", &["inputTokens", "input_tokens"][..]),
        ("outputTokens", &["outputTokens", "output_tokens"][..]),
        ("totalTokens", &["totalTokens", "total_tokens"][..]),
        (
            "cachedReadTokens",
            &["cachedInputTokens", "cached_input_tokens"][..],
        ),
        (
            "cachedWriteTokens",
            &["cachedWriteTokens", "cached_write_tokens"][..],
        ),
    ] {
        if let Some(value) = read(keys) {
            usage.insert(target.to_owned(), value.into());
        }
    }
    // Claude always reports 0 reasoning here; only a real count is a reading.
    if let Some(reasoning) =
        read(&["reasoningOutputTokens", "reasoning_output_tokens"]).filter(|tokens| *tokens > 0)
    {
        usage.insert("thoughtTokens".to_owned(), reasoning.into());
    }
    (usage.contains_key("inputTokens") || usage.contains_key("outputTokens"))
        .then_some(serde_json::Value::Object(usage))
}

pub(crate) fn total_usage_tokens(input: u64, output: u64) -> Option<u64> {
    input.checked_add(output)
}
