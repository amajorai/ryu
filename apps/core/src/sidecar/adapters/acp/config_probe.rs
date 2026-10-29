use super::*;

/// Ceiling on a single ACP config probe (`initialize` + `session/new`). Long
/// enough for a cold `npx` spawn of a large agent binary plus a first backend
/// round-trip, short enough that a wedged `session/new` (e.g. Codex against an
/// unreachable provider) fails fast and stays retryable rather than hanging the
/// desktop's picker request forever.
pub(super) const ACP_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

// ── Core-synthesized session config options ──────────────────────────────────
//
// Everything above this line is agent-reported: Ryu asks, the agent answers, and
// the desktop renders whatever came back. This one option is the exception, and
// it is deliberately narrow.
//
// Plan mode on the flagship is entered by an in-band token in the prompt text
// (`crate::pi_config::plan_mode_sentinel`) — the only per-turn channel pi-acp
// leaves open. A typed token is a poor affordance, so Core advertises the toggle
// as if the agent had reported it. The desktop already renders every advertised
// config option generically (`use-composer-acp-sections.ts`), so the pill costs
// ZERO client change; the turn path turns the chosen value back into the token.
//
// Two consequences of "synthesized, not reported" follow, and both are handled
// below rather than left to a reader: the agent has never heard of this id, so it
// must never be sent to `session/set_config_option` (`apply_turn_config` filters
// it), and Core has no per-session plan state to report as `currentValue`.

/// The id of the Core-synthesized plan-mode option. Dotted and `ryu`-prefixed so
/// it cannot collide with an agent-reported id: ACP ids are opaque strings and an
/// agent is free to invent `plan`, but `ryu.` is ours by construction.
///
/// Shared with [`super::route_acp_stream`], which reads the turn's chosen value
/// back out of the request. One const, so the producer and the consumer of this
/// id cannot drift.
pub const PLAN_MODE_CONFIG_ID: &str = "ryu.plan";

/// The option value that means "plan mode on for this turn".
pub const PLAN_MODE_ON: &str = "on";

/// The option value that means "plan mode off", and the advertised default.
pub(super) const PLAN_MODE_OFF: &str = "off";

/// Is `config_id` one Core made up rather than one the agent advertised?
///
/// Sending a synthesized id to `session/set_config_option` is not merely useless,
/// it is an error the agent rejects: pi-acp accepts exactly `model` and
/// `thought_level` and throws `Unknown configId` on anything else. The rejection
/// is logged and skipped, so the visible symptom would be a warn line per turn
/// forever — noise that trains people to ignore the log. Filter instead.
pub(super) fn is_core_synthesized_config_id(config_id: &str) -> bool {
    config_id == PLAN_MODE_CONFIG_ID
}

/// The synthesized plan-mode selector, as an agent would have advertised it.
///
/// `category: "mode"` is the honest classification (it selects how the turn
/// behaves, not which model runs it) and is what gives the desktop its icon and
/// placement. One caveat worth knowing before changing it: the composer hides the
/// agent's own `modes` picker as soon as ANY config option carries
/// `category: "mode"`. That costs nothing today only because the flagship's modes
/// picker is *already* hidden for an unrelated reason — pi-acp advertises its
/// thinking levels twice, once as `modes` and once as the `thought_level` config
/// option over the identical value set, which trips the composer's
/// duplicate-detection. If pi-acp ever stops duplicating them, this category
/// becomes load-bearing and must be revisited.
///
/// `name` must also stay clear of "thought"/"reason"/"think"/"effort": the
/// composer treats any option whose category, id or name contains one of those as
/// a reasoning control and hides it outright when the agent reports no reasoning
/// capability. "Plan mode" is safe; "Planning effort" would silently vanish.
///
/// `currentValue` is always `off`, even while plan mode is on. Core has no
/// per-session plan state to read — the flag lives inside the Pi process, and this
/// probe is cached per spawn command and shared by every conversation. The
/// desktop overlays the user's own pick (`acpOptionValues[opt.id] ?? currentValue`)
/// so the pill still shows what they chose; `off` is only the cold-start default.
pub(super) fn plan_mode_config_option() -> SessionConfigOption {
    SessionConfigOption::select(
        PLAN_MODE_CONFIG_ID,
        "Plan mode",
        PLAN_MODE_OFF,
        vec![
            SessionConfigSelectOption::new(PLAN_MODE_OFF, "Off")
                .description("Act on the request directly.".to_owned()),
            SessionConfigSelectOption::new(PLAN_MODE_ON, "On").description(
                "Investigate and propose a plan first; file edits are withheld until you approve it."
                    .to_owned(),
            ),
        ],
    )
    .category(SessionConfigOptionCategory::Mode)
    .description("Research and write a plan before changing anything.".to_owned())
}

/// Append the synthesized plan-mode option to what an agent advertised — for the
/// flagship only.
///
/// Gated on [`RyuToolAccess::PiExtension`] rather than on an agent id: that is the
/// SAME spawn-command predicate `run_acp_instance` uses to recognise the managed
/// Pi, and it is true exactly when `ryu-plan.ts` has been shipped into the config
/// dir the process will read. Offering the pill to an agent that cannot honour the
/// sentinel would be a control that does nothing — and the user's `/plan` would
/// reach that agent's model as literal text.
///
/// `None` (the agent advertised no config options at all) becomes a one-element
/// list rather than staying `None`, so the pill does not depend on the agent
/// happening to advertise something else first.
pub(super) fn with_plan_mode_option(
    spawn_cmd: &str,
    advertised: Option<Vec<SessionConfigOption>>,
) -> Option<Vec<SessionConfigOption>> {
    if ryu_tool_access(spawn_cmd) != RyuToolAccess::PiExtension {
        return advertised;
    }
    let mut options = advertised.unwrap_or_default();
    // Appended, never inserted: the agent's own options keep the order it chose,
    // and the model selector in particular stays first where pi-acp put it.
    options.push(plan_mode_config_option());
    Some(options)
}

/// Probe an ACP agent for its advertised session config — `{ modes, models,
/// configOptions }`, each `null` when unsupported. Fully agent-reported apart
/// from the one Core-synthesized option documented above; Ryu hardcodes nothing
/// else. Cached per `spawn_cmd`.
pub async fn probe_acp_config(
    spawn_cmd: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    probe_acp_config_with(spawn_cmd, cwd, SessionSelections::new()).await
}

/// Config-option values to apply to the probe session before reading what the
/// agent advertises — `{ config_id → value_id }`, sorted so the same selections
/// always produce the same cache key.
pub type SessionSelections = std::collections::BTreeMap<String, String>;

/// Probe an ACP agent with `selections` already applied to the throwaway session.
///
/// The advertised option SET is not always a constant of the binary: an agent may
/// only offer an option while some OTHER option holds a particular value. ACP
/// exposes that directly — `session/set_config_option` answers with the whole
/// refreshed `configOptions` list rather than an ack — and this is the client
/// half of that contract: apply what the user has picked, then report what the
/// agent says it offers *given those picks*.
///
/// Verified against opencode 1.18.5, which advertises `{ id: "effort",
/// category: "thought_level" }` only while the session's model has effort levels:
/// `session/new` on its default model returns `[model, mode]`, and the same
/// session answers `[model, effort, mode]` once a model with effort levels is
/// applied. Nothing here names that agent — any agent whose options depend on
/// another option's value gets the same treatment.
///
/// Cached per (`spawn_cmd`, `selections`), so switching model re-probes once and
/// is then instant, and the two answers cannot overwrite each other.
pub async fn probe_acp_config_with(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
) -> anyhow::Result<serde_json::Value> {
    let (native_key, native_environment) = native_probe_context(&spawn_cmd)?;
    let secrets_key = managed_pi_probe_context(&spawn_cmd);
    let key = probe_cache::cache_key(
        &format!(
            "{}{native_key}{secrets_key}",
            without_scoped_bearers(&spawn_cmd)
        ),
        &selections,
    );
    // Cached answer (success OR failure) — see [`probe_cache`] for why failures
    // count and why a stale entry is served rather than awaited. The only probe
    // a user can block on is the first one for an agent never opened before.
    if let Some(hit) = probe_cache::lookup(&key) {
        if hit.stale {
            refresh_acp_config_in_background(
                spawn_cmd.clone(),
                cwd,
                selections,
                key.clone(),
                native_environment,
            );
        }
        return hit.outcome.map_err(|e| anyhow::anyhow!(e));
    }

    // Single-flight: opening a window mounts several pickers for the same agent
    // at once, and without this each one spawns its own subprocess. The waiter
    // re-reads the cache, because the holder ahead of it has just written the
    // answer it was about to spend up to 30s computing.
    let lock = probe_cache::probe_lock(&key);
    let _guard = lock.lock().await;
    if let Some(hit) = probe_cache::lookup(&key) {
        return hit.outcome.map_err(|e| anyhow::anyhow!(e));
    }

    let result = probe_acp_config_uncached_with_environment(
        spawn_cmd.clone(),
        cwd,
        selections,
        native_environment,
    )
    .await;
    store_probe_result(&key, &result);
    result
}

/// Record a probe outcome, flattening `anyhow`'s error into the message the
/// cache stores (and the desktop eventually shows).
pub(super) fn store_probe_result(key: &str, result: &anyhow::Result<serde_json::Value>) {
    match result {
        Ok(value) => probe_cache::store(key, Ok(value)),
        // Startup is transient, not an agent failure. Keep prior metadata and
        // allow the next probe to retry immediately after verified readiness.
        Err(err) if err.downcast_ref::<GatewayStartupPending>().is_some() => {}
        Err(err) => probe_cache::store(key, Err(&err.to_string())),
    }
}

/// Re-probe `spawn_cmd` behind the user and refresh its cache entry.
///
/// Detached on purpose: this is the "revalidate" half of stale-while-revalidate,
/// so the read that noticed the staleness has already returned. Deduped through
/// [`probe_cache::begin_refresh`] so a burst of stale reads (several pickers
/// mounting at once) schedules one re-probe, not one each.
fn refresh_acp_config_in_background(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
    key: String,
    native_environment: Option<std::collections::HashMap<String, String>>,
) {
    // Keyed by the same (spawn command, selections) pair the entry is: refreshing
    // one model's answer must not dedupe out the refresh of another's.
    let Some(slot) = probe_cache::begin_refresh(&key) else {
        return;
    };
    tokio::spawn(async move {
        let lock = probe_cache::probe_lock(&key);
        let _guard = lock.lock().await;
        let result = probe_acp_config_uncached_with_environment(
            spawn_cmd,
            cwd,
            selections,
            native_environment,
        )
        .await;
        store_probe_result(&key, &result);
        drop(slot);
    });
}

pub(super) fn native_probe_context(
    spawn_cmd: &str,
) -> anyhow::Result<(String, Option<std::collections::HashMap<String, String>>)> {
    let Some(native) = crate::pi_config::native_accounts::for_spawn(spawn_cmd)? else {
        return Ok((String::new(), None));
    };
    native_probe_context_for_accounts(&native)
}

pub(super) fn native_probe_context_for_accounts(
    native: &crate::pi_config::native_accounts::NativeAccounts,
) -> anyhow::Result<(String, Option<std::collections::HashMap<String, String>>)> {
    use sha2::{Digest, Sha256};
    let (identity, profile) = match native.capture_for_discovery()? {
        Some(launch) => (launch.affinity.process_identity(), launch.env),
        None => ("signed-out".into(), native.signed_out_discovery_env()?),
    };
    let environment = crate::pi_config::native_accounts::isolated_env(profile);
    let sorted = environment.iter().collect::<BTreeMap<_, _>>();
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&(identity, sorted))?));
    Ok((format!("\u{2}native:{fingerprint}"), Some(environment)))
}
