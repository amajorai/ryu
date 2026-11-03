//! Declarative match gates, single-hook execution and hook logs.

use super::*;

/// Evaluate a hook's declarative `match` gate in Rust, before any sandbox spawn.
/// No `match` (or an all-empty one) → always run. Otherwise the present
/// conditions are OR-ed: a matching composer flag, a matching slash-command
/// prefix on the last user turn, or existing per-conversation plugin state each
/// wake the hook. Fail-open: any lookup error resolves to "run" so a gate glitch
/// never silently disables a feature.
pub(super) async fn hook_should_run(
    state: &ServerState,
    hook: &HookPlugin,
    ctx: &HookContext,
) -> bool {
    let Some(m) = &hook.run_when else {
        return true;
    };
    // Decide everything that does not need a storage read first (pure + tested).
    match gate_without_storage(m, ctx) {
        GateVerdict::Run => true,
        GateVerdict::Skip => false,
        GateVerdict::CheckStateful => {
            if let Some(cadence) = &m.reply_cadence {
                if reply_cadence_due(&state.preferences, cadence, ctx, &hook.grants).await {
                    return true;
                }
            }
            if !m.stateful {
                return false;
            }
            let Some(conv) = ctx.conversation_id.as_deref().filter(|c| !c.is_empty()) else {
                return false;
            };
            let Some(store) = crate::plugin_storage::global() else {
                return false;
            };
            let namespace = storage_namespace_for_tenant(ctx.caller_user_id.as_deref(), "default");
            match store.get(&hook.plugin_id, &namespace, conv).await {
                Ok(Some(_)) => true,
                Ok(None) => false,
                // Fail-open on a storage error: run rather than silently drop.
                Err(_) => true,
            }
        }
    }
}

/// The pure (storage-free) part of the gate. Separated so the flag/command logic
/// is unit-testable without a [`ServerState`].
#[derive(Debug, PartialEq)]
pub(super) enum GateVerdict {
    /// A flag/command condition matched (or no condition was declared): run now.
    Run,
    /// Conditions were declared, none matched, and no stateful check applies: skip.
    Skip,
    /// Nothing matched yet but a condition needs a read — the plugin's KV state
    /// or the preferences behind a reply cadence — so the caller decides.
    CheckStateful,
}

pub(super) fn gate_without_storage(
    m: &crate::plugin_manifest::HookMatch,
    ctx: &HookContext,
) -> GateVerdict {
    let mut declared = false;

    if let Some(flag) = m.flag.as_deref().filter(|f| !f.is_empty()) {
        declared = true;
        if ctx.flags.get(flag).copied().unwrap_or(false) {
            return GateVerdict::Run;
        }
    }

    if !m.commands.is_empty() {
        declared = true;
        if let Some(last_user) = ctx.transcript.iter().rev().find(|msg| msg.role == "user") {
            let text = last_user.content.trim();
            if m.commands.iter().any(|c| text.starts_with(c.as_str())) {
                return GateVerdict::Run;
            }
        }
    }

    if !m.tools.is_empty() {
        declared = true;
        if let Some(name) = ctx.tool_name.as_deref() {
            if m.tools.iter().any(|pat| glob_match(pat, name)) {
                return GateVerdict::Run;
            }
        }
    }

    if m.stateful || m.reply_cadence.is_some() {
        return GateVerdict::CheckStateful;
    }

    // A match block with no recognised condition means "always run".
    if declared {
        GateVerdict::Skip
    } else {
        GateVerdict::Run
    }
}

/// Read the preferences behind a [`ReplyCadence`] and decide whether this turn
/// is due. A preference that cannot be read counts as unset; a credential key is
/// never read and makes the gate run the hook (fail-open, like the KV gate).
pub(super) async fn reply_cadence_due(
    preferences: &crate::server::preferences::PreferencesStore,
    cadence: &crate::plugin_manifest::ReplyCadence,
    ctx: &HookContext,
    grants: &HashSet<String>,
) -> bool {
    // Match the bridge's preference capability before observing node state.
    if !grants.contains("preferences:read") {
        return reply_cadence_matches(
            cadence,
            ctx.transcript
                .iter()
                .filter(|m| m.role == "assistant")
                .count(),
            None,
            None,
            None,
        );
    }
    async fn read(
        preferences: &crate::server::preferences::PreferencesStore,
        key: Option<&str>,
    ) -> Result<Option<String>, ()> {
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            return Ok(None);
        };
        if crate::server::preferences::is_secret_preference_key(key) {
            return Err(());
        }
        Ok(preferences.get(key).await.ok().flatten())
    }
    let (Ok(enabled), Ok(every), Ok(first)) = (
        read(preferences, cadence.enabled_pref.as_deref()).await,
        read(preferences, cadence.every_pref.as_deref()).await,
        read(preferences, cadence.first_pref.as_deref()).await,
    ) else {
        return true;
    };
    let replies = ctx
        .transcript
        .iter()
        .filter(|message| message.role == "assistant")
        .count();
    reply_cadence_matches(
        cadence,
        replies,
        enabled.as_deref(),
        every.as_deref(),
        first.as_deref(),
    )
}

/// The pure cadence rule, written to agree with a hook body that reads the same
/// preferences with JavaScript's `parseInt`: leading integer, below 1 or
/// unreadable falls back to the default, above 100 clamps to 100.
pub(super) fn reply_cadence_matches(
    cadence: &crate::plugin_manifest::ReplyCadence,
    replies: usize,
    enabled: Option<&str>,
    every: Option<&str>,
    first: Option<&str>,
) -> bool {
    if enabled == Some("false") || replies == 0 {
        return false;
    }
    let fallback = cadence.every_default.clamp(1, 100) as usize;
    let every = every
        .filter(|value| !value.is_empty())
        .and_then(leading_integer)
        .filter(|n| *n >= 1)
        .map_or(fallback, |n| n.min(100) as usize);
    let first_on = cadence.first_reply && first != Some("false");
    (replies == 1 && first_on) || replies % every == 0
}

/// `parseInt`-style: optional whitespace and sign, then the leading digits.
pub(super) fn leading_integer(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse::<i64>().ok().map(|n| sign * n)
}

/// A minimal glob for tool-name gates: supports a single leading and/or trailing
/// `*`. `"*"` matches everything, `"bash*"` a prefix, `"*write"` a suffix,
/// `"*edit*"` a substring, anything else an exact match. Deliberately tiny — this
/// is a spawn-avoidance gate, not a full matcher.
pub(super) fn glob_match(pattern: &str, name: &str) -> bool {
    match (pattern.strip_prefix('*'), pattern.strip_suffix('*')) {
        _ if pattern == "*" => true,
        (Some(rest), Some(_)) => {
            // both ends starred: substring (rest still has trailing '*')
            let inner = rest.strip_suffix('*').unwrap_or(rest);
            name.contains(inner)
        }
        (Some(suffix), None) => name.ends_with(suffix),
        (None, Some(prefix)) => name.starts_with(prefix),
        (None, None) => pattern == name,
    }
}

/// Run one hook in the sandbox and parse its directive. Any failure (sandbox
/// unavailable, hook threw, unparseable result, a Pause we don't support) degrades to
/// [`HookDirective::None`].
pub async fn run_hook(state: &ServerState, hook: &HookPlugin, ctx: &HookContext) -> HookDirective {
    if hook.mode == crate::plugin_manifest::HookMode::Middleware {
        let next: MiddlewareNext = Arc::new(|_ctx| Box::pin(async { HookDirective::None }));
        return match run_middleware_hook(state, hook, ctx, next).await {
            MiddlewareRun::Returned(directive) => directive,
            MiddlewareRun::Failed => HookDirective::None,
        };
    }

    // Hold the plugin's read lease across the sandbox call. A concurrent disable
    // waits for this work before unregistering the plugin's contributions; a
    // hook collected before disable but not started yet is refused instead of
    // running against a stale generation.
    let Some(_runtime_lease) = state.plugin_runtime.acquire(&hook.plugin_id).await else {
        return HookDirective::None;
    };
    let Some(grants) = current_hook_grants(state, hook).await else {
        return HookDirective::None;
    };
    let Some(breaker_permit) = breaker::allow(&hook.plugin_id, &hook.hook_id) else {
        return HookDirective::None;
    };
    let locale = crate::i18n::locale::node_locale().await;
    let program = build_hook_program_in(ctx, &hook.code, locale);
    let bridge = Arc::new(
        PluginHookBridge::new_for_request(
            hook.plugin_id.clone(),
            grants,
            state.clone(),
            ctx.verified_caller.clone(),
            ctx.conversation_id.clone(),
        )
        .with_calling_agent(ctx.agent_id.clone()),
    );
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    let agent_id = ctx
        .agent_id
        .clone()
        .unwrap_or_else(|| "plugin-host".to_string());

    match tool_exec::run_sandboxed_warm(program, invoker, &agent_id, &hook.plugin_id).await {
        ExecOutcome::Completed {
            result,
            logs,
            is_error,
            error,
        } => {
            emit_hook_logs(hook, &logs);
            if is_error {
                let error = error.unwrap_or_default();
                tracing::warn!(
                    "plugin_host: hook {}::{} errored: {}",
                    hook.plugin_id,
                    hook.hook_id,
                    error
                );
                breaker_permit.record_failure(&error);
                return HookDirective::None;
            }
            breaker_permit.record_success();
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => {
            tracing::warn!(
                "plugin_host: hook {}::{} paused (unsupported for hooks); ignoring",
                hook.plugin_id,
                hook.hook_id
            );
            breaker_permit.record_failure("paused (unsupported)");
            HookDirective::None
        }
    }
}

/// Most `host.log` lines surfaced per hook run.
pub(super) const MAX_HOOK_LOG_LINES: usize = 20;
/// Longest `host.log` line surfaced (in chars); longer lines are truncated.
pub(super) const MAX_HOOK_LOG_LINE_CHARS: usize = 1024;

/// Bounded view of a hook run's captured `host.log` output: at most
/// [`MAX_HOOK_LOG_LINES`] lines of at most [`MAX_HOOK_LOG_LINE_CHARS`] chars,
/// control characters (other than tab) stripped so a hook cannot forge log
/// lines. Returns the kept lines and how many were dropped.
pub(super) fn bounded_hook_logs(logs: &[String]) -> (Vec<String>, usize) {
    let kept = logs
        .iter()
        .take(MAX_HOOK_LOG_LINES)
        .map(|line| {
            let mut out: String = line
                .chars()
                .filter(|c| *c == '\t' || !c.is_control())
                .take(MAX_HOOK_LOG_LINE_CHARS)
                .collect();
            if line.chars().count() > MAX_HOOK_LOG_LINE_CHARS {
                out.push('…');
            }
            out
        })
        .collect();
    (kept, logs.len().saturating_sub(MAX_HOOK_LOG_LINES))
}

/// Surface a hook's captured `host.log` lines through tracing, tagged with the
/// plugin and hook id, so hook authors can debug from the Core log.
pub(super) fn emit_hook_logs(hook: &HookPlugin, logs: &[String]) {
    if logs.is_empty() {
        return;
    }
    let (lines, dropped) = bounded_hook_logs(logs);
    for line in lines {
        tracing::info!(
            target: "ryu_core::plugin_hook_log",
            plugin = %hook.plugin_id,
            hook = %hook.hook_id,
            "{line}"
        );
    }
    if dropped > 0 {
        tracing::info!(
            target: "ryu_core::plugin_hook_log",
            plugin = %hook.plugin_id,
            hook = %hook.hook_id,
            dropped,
            "host.log output truncated"
        );
    }
}

/// Parse the hook's returned value into a directive. A missing/`null`/unparseable
/// value (or an explicit `{kind:"none"}`) → [`HookDirective::None`].
pub(super) fn parse_directive(value: Option<&serde_json::Value>) -> HookDirective {
    let Some(v) = value else {
        return HookDirective::None;
    };
    serde_json::from_value::<HookDirective>(v.clone()).unwrap_or(HookDirective::None)
}
