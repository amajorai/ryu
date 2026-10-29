// apps/core/src/sidecar/adapters/acp_probe_cache.rs
//
// The cache behind [`super::acp::probe_acp_config`] — the one place in Core that
// spawns an agent subprocess just to ask what it advertises (`initialize` +
// `session/new`). Every surface that renders an agent picker funnels through
// that probe: the composer's Agent · Model · Thinking dropdown
// (`use-composer-acp-sections.ts`), `GET /api/agents/:id/capabilities`, the
// agent-selection field, Settings → Agent models, the Warmup app. So this is the
// only place worth caching, and caching here fixes all of them at once.
//
// What was wrong before: the cache was an in-process `HashMap<String, Value>`
// with no expiry, populated ONLY on success. Two consequences, both user-visible:
//
//   1. A failing probe was never recorded, so every single read re-spawned the
//      agent and re-waited the full 30s ceiling. An agent whose `session/new`
//      hangs (Codex against an unreachable/unauthenticated backend, a signed-out
//      subscription agent) therefore cost 30s per mount — and the desktop's
//      `useAcpConfig` retries twice, so opening one new chat could spend 90s
//      spawning subprocesses before showing an empty picker. That is the
//      "it keeps detecting every time I start a new chat" report.
//   2. The map died with the process, so every Core restart re-probed from cold.
//
// So the cache is now: persisted across restarts, TTL'd in both directions,
// single-flighted, and refreshed in the background rather than in the user's
// face. The four properties, and why each one is load-bearing:
//
//   - **Failures are cached too**, on a much shorter TTL than successes. Long
//     enough that a broken agent stops costing 30s per chat; short enough that a
//     user who fixes the cause (starts their backend, connects to the network)
//     doesn't sit in a stale error. The auth transitions that can fix it
//     *deterministically* — `authenticate_acp` / `logout_acp` — call
//     [`invalidate`] and don't wait for the TTL at all.
//   - **Stale-while-revalidate.** A TTL that blocks on refresh just moves the
//     spinner. Past the TTL the cached answer is returned immediately and the
//     re-probe runs detached, so the ONLY blocking probe a user can ever hit is
//     the very first one for an agent they have never opened.
//   - **Single-flight per spawn command.** Opening a window mounts several
//     pickers at once; without this each mount spawns its own subprocess of the
//     same agent.
//   - **Only successes are persisted.** A failure written to disk would survive
//     the restart that most plausibly fixes it (Core relaunched with a reachable
//     backend), so failures stay in memory and die with the process.
//
// The freshness stamp is what makes persistence safe. A probe result pinned to
// disk with no validity signal is worse than re-probing: upgrade `claude`, it
// gains a mode, and the picker shows the old set forever. For an agent spawned
// from a real binary on PATH we fingerprint that binary (resolved real path +
// mtime + size, via `acp::resolve_in_path`), so an upgrade invalidates the entry
// the moment it lands. Agents spawned through a package runner (`npx -y …`) have
// no such signal — the `npx` shim is unchanged when the package updates — so they
// fall back to the TTL alone, which the background refresh keeps cheap.
//
// ── Why a key is not just the spawn command ──────────────────────────────────
//
// An agent's advertised option SET can depend on the values already selected in
// the session — the ACP `session/set_config_option` response returns the whole
// refreshed list precisely so a client can observe that. opencode is the live
// example: it advertises an `effort` (reasoning) option only while the session's
// model has effort levels, so the same binary answers differently depending on
// which model was applied first. The probe therefore takes the selections it
// applied, and they are part of the cache key — otherwise the first model probed
// would pin the option set for every other model.
//
// [`invalidate`] consequently drops EVERY key for a spawn command, not one. An
// auth transition invalidates what the agent advertises for all selections, and
// clearing only the no-selection entry would leave the picker the user actually
// has open serving a stale pre-login answer.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a successful probe is served before a background re-probe is
/// scheduled. Generous because an agent's advertised set (modes / models /
/// config options) only changes when the agent itself is upgraded, and the
/// binary fingerprint already catches that case exactly for agents that have one.
/// Nothing waits on this expiring — it is a refresh cadence, not a stall.
const SUCCESS_TTL: Duration = Duration::hours(6);

/// How long a failed probe is served before a background re-probe is scheduled.
/// Short, because the causes are transient and user-fixable (backend down, not
/// signed in, cold npx fetch that overran the 30s ceiling). Serving the stale
/// failure in the meantime is still strictly better than the old behaviour: the
/// user gets an instant empty picker instead of a 30s hang, and the refresh that
/// fills it runs behind them.
const FAILURE_TTL: Duration = Duration::minutes(5);

/// Program names that are package runners rather than the agent itself. Their
/// on-disk identity says nothing about the version of the agent they fetch, so
/// fingerprinting them would produce a stamp that never changes across agent
/// upgrades — worse than no stamp, because it would look like a validity check.
const PACKAGE_RUNNERS: &[&str] = &[
    "npx", "npm", "pnpm", "yarn", "bunx", "bun", "uvx", "uv", "pipx", "node", "deno", "python",
    "python3", "cmd", "sh", "bash", "env",
];

/// One cached probe outcome.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Entry {
    cached_at: DateTime<Utc>,
    /// Identity of the agent binary when this was recorded, when it has one.
    /// `None` for package-runner spawns (TTL is then the only validity signal).
    #[serde(default)]
    fingerprint: Option<String>,
    /// The probe's error message, for a cached failure.
    #[serde(default)]
    error: Option<String>,
    /// The agent's advertised config, for a cached success.
    #[serde(default)]
    value: Option<Value>,
}

impl Entry {
    fn outcome(&self) -> Result<Value, String> {
        match (&self.value, &self.error) {
            (Some(v), _) => Ok(v.clone()),
            (None, Some(e)) => Err(e.clone()),
            // Neither field set — a hand-edited or truncated cache file. Treat it
            // as a failure rather than as an empty success, so the caller
            // re-probes instead of rendering an agent with no pickers as if that
            // were the agent's own answer.
            (None, None) => Err("cached ACP probe entry is empty".to_owned()),
        }
    }

    fn is_success(&self) -> bool {
        self.value.is_some()
    }

    fn ttl(&self) -> Duration {
        if self.is_success() {
            SUCCESS_TTL
        } else {
            FAILURE_TTL
        }
    }

    /// Has this entry outlived its TTL as of `now`? A stale entry is still
    /// served — it only means a background refresh should be kicked off.
    fn is_stale(&self, now: DateTime<Utc>) -> bool {
        now - self.cached_at >= self.ttl()
    }
}

/// A cached probe answer, plus whether the caller should refresh it behind the user.
pub struct Hit {
    /// What the probe returned when it was recorded.
    pub outcome: Result<Value, String>,
    /// The entry outlived its TTL: serve it, then re-probe in the background.
    pub stale: bool,
}

/// Separates the spawn command from the applied selections inside a cache key.
/// A control character so it cannot occur in a shell spawn command, a config
/// option id or a value — the three things a key is built from.
const KEY_SEP: char = '\u{1}';

/// The cache key for probing `spawn_cmd` with `selections` already applied.
///
/// No selections ⇒ the bare spawn command, so entries written by every existing
/// caller (and every entry already on disk) keep their identity.
#[must_use]
pub fn cache_key(spawn_cmd: &str, selections: &BTreeMap<String, String>) -> String {
    if selections.is_empty() {
        return spawn_cmd.to_owned();
    }
    // `BTreeMap` ⇒ the ordering is the ids' sort order, so the same selections
    // always produce the same key regardless of how the client sent them.
    let applied = selections
        .iter()
        .map(|(id, value)| format!("{id}={value}"))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    format!("{spawn_cmd}{KEY_SEP}{applied}")
}

/// Whether a key's spawn part belongs to `spawn_cmd`: the command itself, or
/// the command plus a `\u{2}`-separated context the caller appended (a native
/// account or managed-Pi secret digest), so invalidation clears every
/// context's answer for that agent.
fn probes_spawn_cmd(key_spawn: &str, spawn_cmd: &str) -> bool {
    key_spawn
        .strip_prefix(spawn_cmd)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(CONTEXT_SEP))
}

/// Separator between a spawn command and the context a caller appends to it.
const CONTEXT_SEP: char = '\u{2}';

/// The spawn command a cache key was built from — the part every
/// binary-fingerprint and invalidation decision is about.
fn spawn_cmd_of(key: &str) -> &str {
    key.split(KEY_SEP).next().unwrap_or(key)
}

/// The in-memory cache: every entry, successes and failures alike.
fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(load_from_disk()))
}

/// Per-spawn-command locks, so concurrent mounts of the same agent's pickers
/// share one subprocess instead of spawning one each. A `tokio` mutex because
/// the probe it guards is `.await`ed while held.
fn inflight() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawn commands with a background refresh already running, so a burst of stale
/// reads schedules one re-probe rather than one per read.
fn refreshing() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// The lock guarding probes of `key` (a [`cache_key`]). Hold it across the
/// probe; re-check [`lookup`] after acquiring it, because the holder ahead of
/// you has just written the answer you were about to spend 30s computing.
pub fn probe_lock(spawn_cmd: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = match inflight().lock() {
        Ok(m) => m,
        // A poisoned lock must not turn into "no probing at all"; hand back a
        // throwaway lock so the caller degrades to un-deduped probing.
        Err(_) => return Arc::new(tokio::sync::Mutex::new(())),
    };
    map.entry(spawn_cmd.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// A held background-refresh slot, released when dropped.
///
/// RAII rather than a paired `end_refresh` call because the failure mode of a
/// missed release is silent and permanent: the slot stays claimed, every later
/// stale read is deduped against a refresh that is no longer running, and that
/// agent's entry never refreshes again for the life of the process. A drop guard
/// survives the `?`, panic and early-return paths a paired call would not.
pub struct RefreshSlot(String);

impl Drop for RefreshSlot {
    fn drop(&mut self) {
        if let Ok(mut s) = refreshing().lock() {
            s.remove(&self.0);
        }
    }
}

/// Claim the background refresh slot for `spawn_cmd`. `None` means one is
/// already running and the caller should do nothing.
pub fn begin_refresh(spawn_cmd: &str) -> Option<RefreshSlot> {
    let claimed = refreshing()
        .lock()
        .map(|mut s| s.insert(spawn_cmd.to_owned()))
        .unwrap_or(false);
    claimed.then(|| RefreshSlot(spawn_cmd.to_owned()))
}

/// The cached outcome for `key` (a [`cache_key`]), or `None` when there is
/// nothing usable.
///
/// An entry whose binary fingerprint no longer matches the agent on disk is
/// dropped rather than returned: the agent was upgraded, so what it advertises
/// may have changed and the cached answer is not merely old but wrong.
pub fn lookup(key: &str) -> Option<Hit> {
    let current = fingerprint(spawn_cmd_of(key));
    let mut map = entries().lock().ok()?;
    let entry = map.get(key)?;
    if entry.fingerprint != current {
        map.remove(key);
        return None;
    }
    Some(Hit {
        outcome: entry.outcome(),
        stale: entry.is_stale(Utc::now()),
    })
}

/// Record a probe outcome. Successes are also written to disk so the next Core
/// start serves them without re-spawning the agent; failures stay in memory.
pub fn store(key: &str, outcome: Result<&Value, &str>) {
    let entry = Entry {
        cached_at: Utc::now(),
        fingerprint: fingerprint(spawn_cmd_of(key)),
        error: outcome.err().map(str::to_owned),
        value: outcome.ok().cloned(),
    };
    let persist = entry.is_success();
    let snapshot = {
        let Ok(mut map) = entries().lock() else {
            return;
        };
        map.insert(key.to_owned(), entry);
        if !persist {
            return;
        }
        successes(&map)
    };
    save_to_disk(&snapshot);
}

/// Drop EVERY cached outcome for `spawn_cmd` — used when an auth transition
/// makes them definitively wrong (a login unlocks `session/new`; a logout
/// re-locks it).
///
/// Every key, not just the bare one: an agent is probed once per applied
/// selection set (see the module header), and an auth transition invalidates all
/// of them. Dropping only the no-selection entry would leave the composer — which
/// reads a per-model key — serving its stale pre-login answer.
pub fn invalidate(spawn_cmd: &str) {
    let snapshot = {
        let Ok(mut map) = entries().lock() else {
            return;
        };
        let stale: Vec<String> = map
            .keys()
            .filter(|k| probes_spawn_cmd(spawn_cmd_of(k), spawn_cmd))
            .cloned()
            .collect();
        if stale.is_empty() {
            return;
        }
        for key in stale {
            map.remove(&key);
        }
        successes(&map)
    };
    save_to_disk(&snapshot);
}

/// The persistable subset: successes only (see the module header).
fn successes(map: &HashMap<String, Entry>) -> HashMap<String, Entry> {
    map.iter()
        .filter(|(_, e)| e.is_success())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

// ── Binary fingerprinting ────────────────────────────────────────────────────

/// The agent binary's identity for `spawn_cmd`, or `None` when the spawn goes
/// through a package runner (whose own identity tracks nothing about the agent).
fn fingerprint(spawn_cmd: &str) -> Option<String> {
    let program = spawn_program(spawn_cmd)?;
    let path = super::acp::resolve_in_path(&program)?;
    let meta = std::fs::metadata(&path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(format!("{}:{}:{}", path.display(), mtime, meta.len()))
}

/// The agent program a spawn command actually runs, when it is a real binary.
///
/// Returns `None` for package runners and for anything we can't confidently
/// parse — an unfingerprintable agent falls back to the TTL, which is correct
/// but conservative, whereas a *wrong* fingerprint would either pin a stale
/// entry forever or invalidate on every read.
fn spawn_program(spawn_cmd: &str) -> Option<String> {
    let token = spawn_cmd
        .split_whitespace()
        // `VAR=value prog …` — skip leading environment assignments.
        .find(|t| !t.contains('='))?;
    let name = std::path::Path::new(token)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(token)
        .to_ascii_lowercase();
    if PACKAGE_RUNNERS.contains(&name.as_str()) {
        return None;
    }
    Some(token.to_owned())
}

// ── Persistence ──────────────────────────────────────────────────────────────

fn cache_path() -> std::path::PathBuf {
    crate::paths::cache_path("acp-probe-cache.json")
}

fn load_from_disk() -> HashMap<String, Entry> {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, Entry>>(&s).ok())
        .unwrap_or_default()
}

fn save_to_disk(map: &HashMap<String, Entry>) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(&path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(value: Option<Value>, error: Option<&str>, age: Duration) -> Entry {
        Entry {
            cached_at: Utc::now() - age,
            fingerprint: None,
            error: error.map(str::to_owned),
            value,
        }
    }

    #[test]
    fn success_entry_returns_its_value() {
        let e = entry(
            Some(serde_json::json!({"modes": null})),
            None,
            Duration::zero(),
        );
        assert_eq!(e.outcome().unwrap(), serde_json::json!({"modes": null}));
    }

    #[test]
    fn failure_entry_returns_its_error() {
        let e = entry(None, Some("probe timed out"), Duration::zero());
        assert_eq!(e.outcome().unwrap_err(), "probe timed out");
    }

    #[test]
    fn empty_entry_is_treated_as_a_failure_not_an_empty_success() {
        // A truncated/hand-edited cache file must make the caller re-probe, not
        // render an agent with no pickers as if the agent had said so.
        assert!(entry(None, None, Duration::zero()).outcome().is_err());
    }

    #[test]
    fn no_selections_keeps_the_bare_spawn_command_as_the_key() {
        // Every existing caller — and every entry already on disk — keys on the
        // spawn command alone, so the empty case must not change identity.
        assert_eq!(cache_key("claude --acp", &BTreeMap::new()), "claude --acp");
    }

    #[test]
    fn selections_key_is_by_value_and_order_independent() {
        let mut a = BTreeMap::new();
        a.insert("model".to_owned(), "xai/grok-4.6".to_owned());
        a.insert("effort".to_owned(), "high".to_owned());
        let mut b = BTreeMap::new();
        b.insert("effort".to_owned(), "high".to_owned());
        b.insert("model".to_owned(), "xai/grok-4.6".to_owned());
        assert_eq!(cache_key("opencode acp", &a), cache_key("opencode acp", &b));

        let mut other = BTreeMap::new();
        other.insert("model".to_owned(), "opencode/big-pickle".to_owned());
        assert_ne!(
            cache_key("opencode acp", &a),
            cache_key("opencode acp", &other),
            "two models must not share one entry — the option SET differs"
        );
    }

    #[test]
    fn a_key_still_reports_the_spawn_command_it_was_built_from() {
        let mut sel = BTreeMap::new();
        sel.insert("model".to_owned(), "xai/grok-4.6".to_owned());
        assert_eq!(
            spawn_cmd_of(&cache_key("opencode acp", &sel)),
            "opencode acp"
        );
        assert_eq!(spawn_cmd_of("opencode acp"), "opencode acp");
    }

    #[test]
    fn invalidate_drops_every_selection_of_that_spawn_command() {
        // An auth transition invalidates what the agent advertises for ALL
        // selections. Clearing only the bare key would leave the composer — which
        // reads a per-model key — serving its stale pre-login answer.
        let mut sel = BTreeMap::new();
        sel.insert("model".to_owned(), "xai/grok-4.6".to_owned());
        let bare = "invalidate-test-agent --acp";
        let keyed = cache_key(bare, &sel);
        // The managed Pi and native agents key on a context after the command.
        let with_context = cache_key(&format!("{bare}\u{2}pi-secrets:abc"), &sel);
        let other = "other-agent --acp";
        let longer = "invalidate-test-agent --acp-v2";
        store(bare, Ok(&Value::Null));
        store(&keyed, Ok(&Value::Null));
        store(&with_context, Ok(&Value::Null));
        store(other, Ok(&Value::Null));
        store(longer, Ok(&Value::Null));

        invalidate(bare);

        let map = entries().lock().expect("cache lock");
        assert!(!map.contains_key(bare));
        assert!(!map.contains_key(&keyed));
        assert!(!map.contains_key(&with_context));
        assert!(map.contains_key(other), "another agent must be untouched");
        assert!(
            map.contains_key(longer),
            "a command that merely shares a prefix is untouched"
        );
    }

    #[test]
    fn failures_expire_far_sooner_than_successes() {
        // The whole point of the split: a broken agent stops costing a 30s probe
        // per chat, but recovers on its own within minutes rather than hours.
        let now = Utc::now();
        let old = Duration::minutes(30);
        assert!(entry(None, Some("boom"), old).is_stale(now));
        assert!(!entry(Some(Value::Null), None, old).is_stale(now));
    }

    #[test]
    fn a_fresh_success_is_not_stale_and_an_aged_one_is() {
        let now = Utc::now();
        let fresh = entry(Some(Value::Null), None, Duration::minutes(1));
        let aged = entry(Some(Value::Null), None, SUCCESS_TTL + Duration::minutes(1));
        assert!(!fresh.is_stale(now));
        assert!(aged.is_stale(now));
    }

    #[test]
    fn only_successes_are_persisted() {
        let mut map = HashMap::new();
        map.insert(
            "ok".to_owned(),
            entry(Some(Value::Null), None, Duration::zero()),
        );
        map.insert(
            "bad".to_owned(),
            entry(None, Some("boom"), Duration::zero()),
        );
        let kept = successes(&map);
        assert!(kept.contains_key("ok"));
        assert!(
            !kept.contains_key("bad"),
            "a failure written to disk would survive the restart that most \
             plausibly fixes it"
        );
    }

    #[test]
    fn package_runner_spawns_are_not_fingerprinted() {
        // `npx`'s own mtime is unchanged when the package it fetches updates, so
        // a fingerprint here would look like a validity check while checking
        // nothing.
        assert_eq!(spawn_program("npx -y pi-acp"), None);
        assert_eq!(spawn_program("cmd /c npx -y pi-acp"), None);
        assert_eq!(spawn_program("bunx some-agent"), None);
        assert_eq!(spawn_program("uvx some-agent"), None);
    }

    #[test]
    fn leading_env_assignments_are_skipped() {
        assert_eq!(
            spawn_program("FOO=bar claude-code-acp --stdio"),
            Some("claude-code-acp".to_owned())
        );
    }

    #[test]
    fn a_real_binary_spawn_is_fingerprintable() {
        assert_eq!(
            spawn_program("claude-code-acp --stdio"),
            Some("claude-code-acp".to_owned())
        );
        assert_eq!(
            spawn_program("/opt/bin/goose acp"),
            Some("/opt/bin/goose".to_owned())
        );
    }

    #[test]
    fn entries_round_trip_through_json() {
        // The persisted shape must survive a restart; a serde break here would
        // silently reinstate cold-probing on every boot.
        let e = entry(
            Some(serde_json::json!({"models": []})),
            None,
            Duration::zero(),
        );
        let back: Entry = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(back.outcome().unwrap(), serde_json::json!({"models": []}));
        assert!(back.is_success());
    }

    #[test]
    fn a_cache_file_from_an_older_shape_does_not_poison_the_cache() {
        // Missing optional fields must deserialize, not fail the whole file.
        let raw = format!(r#"{{"cached_at":"{}"}}"#, Utc::now().to_rfc3339());
        let e: Entry = serde_json::from_str(&raw).unwrap();
        assert!(!e.is_success());
        assert!(e.outcome().is_err());
    }

    #[tokio::test]
    async fn probe_lock_is_shared_per_spawn_command() {
        let a = probe_lock("agent-one");
        let b = probe_lock("agent-one");
        let c = probe_lock("agent-two");
        assert!(Arc::ptr_eq(&a, &b), "same command must share one lock");
        assert!(!Arc::ptr_eq(&a, &c));
    }

    #[test]
    fn refresh_slot_admits_one_claimant_at_a_time() {
        let held = begin_refresh("refresh-slot-test");
        assert!(held.is_some());
        assert!(
            begin_refresh("refresh-slot-test").is_none(),
            "a burst of stale reads must schedule one re-probe, not one each"
        );
        drop(held);
        assert!(
            begin_refresh("refresh-slot-test").is_some(),
            "dropping the slot must free it for the next refresh"
        );
    }

    #[test]
    fn a_refresh_slot_is_released_even_when_its_task_unwinds() {
        // The failure mode this guards is silent and permanent: a leaked slot
        // dedupes every later stale read against a refresh that is not running.
        let _ = std::panic::catch_unwind(|| {
            let _slot = begin_refresh("refresh-slot-panic");
            panic!("probe blew up");
        });
        assert!(
            begin_refresh("refresh-slot-panic").is_some(),
            "an unwinding refresh must not strand the slot"
        );
    }
}
