//! Goals, context-window management, `/btw` side questions and multi-agent participants: `FTS_RECALL_ENABLED_PREF` through `BTW_TRANSCRIPT_LIMIT`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Preference key for the FTS (full-text, lexical) session-search recall layer:
/// the keyword complement to the semantic auto-recall half. DEFAULT OFF — an unset
/// pref means disabled; only an explicit enable token (`true`/`1`/`on`/`yes`, any
/// case) turns it on. This is a *sub-source* of auto-recall: it contributes only
/// when auto-recall is enabled (default on) AND this pref is enabled (default off),
/// so no session text is full-text-recalled unless the user opts in. Env fallback
/// `RYU_FTS_RECALL_ENABLED`.
pub(in crate::server) const FTS_RECALL_ENABLED_PREF: &str = "fts-recall-enabled";

/// Parse the FTS-recall enabled flag from a raw pref/env string. PURE so it is
/// unit-testable without a store. Default OFF: `None` or any unrecognised value is
/// disabled; only an explicit enable token (`true`/`1`/`on`/`yes`, any case) turns
/// it on. Mirrors [`parse_auto_recall_enabled`] but with the opposite default.
pub(in crate::server) fn parse_fts_recall_enabled(raw: Option<&str>) -> bool {
    match raw {
        None => false,
        Some(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "on" | "yes"
        ),
    }
}

/// Resolve whether the FTS recall layer is enabled: pref → env
/// (`RYU_FTS_RECALL_ENABLED`) → default OFF.
pub(in crate::server) async fn resolve_fts_recall_enabled(state: &ServerState) -> bool {
    if let Ok(Some(pref)) = state.preferences.get(FTS_RECALL_ENABLED_PREF).await {
        return parse_fts_recall_enabled(Some(&pref));
    }
    match std::env::var("RYU_FTS_RECALL_ENABLED") {
        Ok(v) => parse_fts_recall_enabled(Some(&v)),
        Err(_) => false,
    }
}

/// Resolve the global skills disclosure mode from the `skills-disclosure` pref and
/// apply it to the process-global flag the ACP chat path reads. Progressive
/// disclosure injects only an L1 skill index up front and loads full bodies on
/// demand; `full` injects every enabled skill body (today's behavior). When the
/// pref is unset the current flag (env-seeded, default progressive) is left as-is.
pub(in crate::server) async fn apply_skills_disclosure(state: &ServerState) {
    if let Ok(Some(v)) = state
        .preferences
        .get(ryu_skills::SKILLS_DISCLOSURE_PREF)
        .await
    {
        ryu_skills::set_progressive_disclosure(ryu_skills::disclosure_value_is_progressive(&v));
    }
}

/// Resolve the auto-recall top-k: pref → env (`RYU_AUTO_RECALL_TOP_K`) → default.
/// A non-parseable or zero value falls back to the default.
pub(in crate::server) async fn resolve_auto_recall_top_k(state: &ServerState) -> usize {
    let from_str = |s: &str| s.trim().parse::<usize>().ok().filter(|n| *n > 0);
    if let Ok(Some(pref)) = state.preferences.get(AUTO_RECALL_TOP_K_PREF).await {
        if let Some(n) = from_str(&pref) {
            return n;
        }
    }
    if let Ok(v) = std::env::var("RYU_AUTO_RECALL_TOP_K") {
        if let Some(n) = from_str(&v) {
            return n;
        }
    }
    AUTO_RECALL_DEFAULT_TOP_K
}

// ── Context-window management (opt-in / off by default) ───────────────────────
//
// Local models run with small context windows. When a budget is set, Core trims
// the outbound history to fit (always keeping the system block) and optionally
// summarizes the dropped turns, instead of relying solely on the engine's blunt
// context-shift (which can evict the system prompt since Ryu never sets n_keep).
// All keys are off/unset by default so behavior is unchanged until configured.

/// `context.max-tokens`: `""`/`0`/`off` = disabled (default); `auto` = size to
/// the loaded model's launch `ctx_size`; a positive integer = explicit total
/// token budget (input + output). Env fallback `RYU_CONTEXT_MAX_TOKENS`.
pub(in crate::server) const CONTEXT_MAX_TOKENS_PREF: &str = "context.max-tokens";
/// `context.max-tokens.local`: same values as `context.max-tokens`, applied only
/// to turns bound to a local engine (llama.cpp, Ollama, vLLM, MLX, ...). Lets a
/// node trim history for small local context windows while leaving cloud
/// providers untouched. Overrides the global key for local turns when set.
pub(in crate::server) const CONTEXT_MAX_TOKENS_LOCAL_PREF: &str = "context.max-tokens.local";
/// `context.max-tokens.engine.{engine}`: per-engine override (any engine id,
/// local or not). Most specific; wins over `.local` and the global key.
pub(in crate::server) const CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX: &str =
    "context.max-tokens.engine.";
/// `context.auto-compact`: summarize dropped turns via a side model instead of
/// dropping them. DEFAULT off. Adds one summarization round-trip per over-budget
/// turn (cached by the dropped-message set).
pub(in crate::server) const CONTEXT_AUTO_COMPACT_PREF: &str = "context.auto-compact";
/// `context.compact-on-cache-expire`: with auto-compact on, compact the history
/// harder on the turn after the thread's provider prompt cache expired, when the
/// whole prefix is re-sent at full price anyway. ACP agents restart from the
/// compacted history. DEFAULT off.
pub(in crate::server) const CONTEXT_COMPACT_ON_CACHE_EXPIRE_PREF: &str =
    "context.compact-on-cache-expire";
/// `context.max-output-tokens`: tokens reserved for the reply. DEFAULT 1024.
pub(in crate::server) const CONTEXT_MAX_OUTPUT_PREF: &str = "context.max-output-tokens";
/// `context.compact-model`: model id used to summarize dropped turns. DEFAULT =
/// the turn's own chat model.
pub(crate) const CONTEXT_COMPACT_MODEL_PREF: &str = "context.compact-model";
/// `context.compact-effort`: reasoning effort for the summarizer. DEFAULT empty.
pub(crate) const CONTEXT_COMPACT_EFFORT_PREF: &str = "context.compact-effort";
/// Reply reserve used when `context.max-output-tokens` is unset.
pub(in crate::server) const CONTEXT_DEFAULT_OUTPUT_RESERVE: usize = 1024;

/// Parse the `context.max-tokens` value into a concrete token budget. PURE so
/// the off/auto/numeric contract is unit-testable without a store. Returns
/// `None` (feature off) for `""`/`0`/`off` and for unparseable values, for
/// `auto` when `ctx_size` is unknown/0, else the resolved positive budget.
pub(in crate::server) fn parse_context_budget(raw: &str, ctx_size: Option<u32>) -> Option<usize> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off") {
        return None;
    }
    if raw.eq_ignore_ascii_case("auto") {
        return match ctx_size {
            Some(n) if n > 0 => Some(n as usize),
            _ => None,
        };
    }
    match raw.parse::<usize>() {
        Ok(n) if n > 0 => Some(n),
        _ => None,
    }
}

/// Pick the effective `context.max-tokens` value for a turn. PURE. Scoped
/// values win in order engine → local (only when the engine is local) → global
/// → env; an unset or blank scoped value falls through, while an explicit
/// `off`/`0` in a scope disables trimming for that scope. The global key keeps
/// its historical contract: once set (even blank) it shadows the env fallback.
pub(in crate::server) fn pick_context_budget_raw(
    engine_raw: Option<&str>,
    local_raw: Option<&str>,
    is_local: bool,
    global_raw: Option<&str>,
    env_raw: Option<&str>,
) -> String {
    fn set(v: Option<&str>) -> Option<&str> {
        v.map(str::trim).filter(|v| !v.is_empty())
    }
    set(engine_raw)
        .or_else(|| if is_local { set(local_raw) } else { None })
        .or_else(|| global_raw.map(str::trim))
        .or_else(|| env_raw.map(str::trim))
        .unwrap_or_default()
        .to_string()
}

/// Resolve app-level context-window config from prefs/env. Returns `None` (the
/// feature is off, full history is sent) unless `context.max-tokens` is `auto`
/// or a positive integer. `auto` sizes the budget to the loaded model's launch
/// `ctx_size` and is the recommended no-guess value; it yields `None` when the
/// model's `ctx_size` is unknown/0. Mirrors the `resolve_auto_recall_*` shape so
/// the per-turn cost is a few cheap pref reads.
pub(in crate::server) async fn resolve_context_window(
    state: &ServerState,
    req: &crate::sidecar::adapters::ChatStreamRequest,
) -> Option<crate::sidecar::adapters::context_window::ContextWindowConfig> {
    // The chat engine + model for this turn (mirrors route_chat_stream's
    // effective-agent resolution): the engine scopes the budget (per-engine /
    // local-only keys), the model sizes an `auto` budget and is the default
    // summarizer.
    let effective_agent = req.target_agent_id.clone().or_else(|| req.agent_id.clone());
    // Per-agent compaction overrides (`MemorySlot.compaction`). Each present field
    // beats the matching node-wide `context.*` preference for this agent's turns.
    let agent_compaction = match effective_agent.as_deref() {
        Some(id) => match state.agent_store.get(id).await {
            Ok(Some(record)) => record.memory.and_then(|slot| slot.compaction),
            _ => None,
        },
        None => None,
    };
    let (engine, model) = match effective_agent {
        Some(id) => {
            crate::sidecar::adapters::resolve_agent_engine_model(&id, &state.agent_store).await
        }
        None => (None, None),
    };
    let is_local = engine
        .as_deref()
        .is_some_and(crate::sidecar::active_engine::is_local_engine);

    let pref = |key: String| async move { state.preferences.get(&key).await.ok().flatten() };
    let engine_raw = match engine.as_deref() {
        Some(e) => pref(format!("{CONTEXT_MAX_TOKENS_ENGINE_PREF_PREFIX}{e}")).await,
        None => None,
    };
    let local_raw = if is_local {
        pref(CONTEXT_MAX_TOKENS_LOCAL_PREF.to_string()).await
    } else {
        None
    };
    let global_raw = pref(CONTEXT_MAX_TOKENS_PREF.to_string()).await;
    let env_raw = std::env::var("RYU_CONTEXT_MAX_TOKENS").ok();
    let node_raw = pick_context_budget_raw(
        engine_raw.as_deref(),
        local_raw.as_deref(),
        is_local,
        global_raw.as_deref(),
        env_raw.as_deref(),
    );
    let raw = agent_compaction_budget_raw(agent_compaction.as_ref()).unwrap_or(node_raw);
    if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off") {
        return None;
    }

    // For `auto`, the budget is the loaded model's launch `ctx_size`, merged from
    // engine-wide defaults and per-model overrides (the same resolution the
    // engine is spawned with); for a numeric value, `ctx_size` is ignored.
    let ctx_size = if raw.eq_ignore_ascii_case("auto") {
        match (model.as_deref(), engine.as_deref()) {
            (Some(m), Some(e)) if is_local => {
                state.preferences.resolve_launch_config(m, e).await.ctx_size
            }
            (Some(m), _) => state.preferences.get_launch_config(m).await.ctx_size,
            _ => None,
        }
    } else {
        None
    };
    let max_tokens = parse_context_budget(&raw, ctx_size)?;

    let reserve_output = match state.preferences.get(CONTEXT_MAX_OUTPUT_PREF).await {
        Ok(Some(v)) => v.trim().parse::<usize>().ok(),
        _ => None,
    }
    .unwrap_or(CONTEXT_DEFAULT_OUTPUT_RESERVE);

    let pref_on = |value: Option<String>| {
        value.is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "on" | "yes"
            )
        })
    };
    let auto_compact = match agent_compaction.as_ref().and_then(|c| c.enabled) {
        Some(enabled) => enabled,
        None => pref_on(
            state
                .preferences
                .get(CONTEXT_AUTO_COMPACT_PREF)
                .await
                .ok()
                .flatten(),
        ),
    };
    let compact_on_cache_expire = auto_compact
        && pref_on(
            state
                .preferences
                .get(CONTEXT_COMPACT_ON_CACHE_EXPIRE_PREF)
                .await
                .ok()
                .flatten(),
        );

    // `context.compact-model` → the node-wide default selection → this turn's own
    // chat model (the historical fallback, kept so an unconfigured node summarizes
    // with the same model it is talking to).
    let compacted = crate::agent_selection::resolve_side_model(
        &state.preferences,
        CONTEXT_COMPACT_MODEL_PREF,
        Some(CONTEXT_COMPACT_EFFORT_PREF),
    )
    .await;
    let (compact_model, compact_effort) = match compacted {
        Some(resolved) => (resolved.model, resolved.effort),
        None => (
            model.unwrap_or_else(|| crate::registry::DEFAULT_LLM_MODEL.to_string()),
            match state.preferences.get(CONTEXT_COMPACT_EFFORT_PREF).await {
                Ok(Some(v)) => v.trim().to_string(),
                _ => String::new(),
            },
        ),
    };
    let (compact_model, compact_effort) =
        apply_agent_compaction_model(agent_compaction.as_ref(), compact_model, compact_effort);

    Some(
        crate::sidecar::adapters::context_window::ContextWindowConfig {
            max_tokens,
            reserve_output,
            auto_compact,
            compact_model,
            compact_effort,
            compact_on_cache_expire,
        },
    )
}

/// The agent's compaction threshold in `context.max-tokens` form, when it sets
/// one. `None` keeps the node-wide budget resolution.
pub(in crate::server) fn agent_compaction_budget_raw(
    compaction: Option<&crate::agents::CompactionSettings>,
) -> Option<String> {
    compaction
        .and_then(|c| c.threshold.as_ref())
        .map(crate::agents::CompactionThreshold::as_pref_value)
        .filter(|raw| !raw.is_empty())
}

/// Apply an agent's summarizer model / effort overrides on top of the node's.
pub(in crate::server) fn apply_agent_compaction_model(
    compaction: Option<&crate::agents::CompactionSettings>,
    model: String,
    effort: String,
) -> (String, String) {
    let Some(compaction) = compaction else {
        return (model, effort);
    };
    let non_empty = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    (
        non_empty(&compaction.model).unwrap_or(model),
        non_empty(&compaction.effort).unwrap_or(effort),
    )
}

/// Recent-message window a `/btw` side question sees. Both stored-conversation
/// reads and client-supplied transcripts are bounded here so a plugin client
/// cannot accidentally turn a side question into an unbounded context request.
pub(in crate::server) const BTW_TRANSCRIPT_LIMIT: usize = 30;
