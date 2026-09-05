use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;

use crate::sidecar::active_engine::{is_local_engine, ActiveEngineStore};
use crate::sidecar::resources::{self, ResourceSample};
use crate::sidecar::{onboarding::SetupManager, HealthStatus, Sidecar, SidecarStatus};

const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const MAX_REQUIRED_RETRIES: u32 = 3;
/// How often the idle reaper (`spawn_idle_reaper`) checks whether an
/// idle-configured sidecar is due to be scaled to zero. Coarse on purpose: a
/// stopped-a-few-seconds-late sidecar costs nothing, and a slow tick keeps the
/// task's wakeups negligible.
const IDLE_REAP_INTERVAL: Duration = Duration::from_secs(30);

/// The name of the env var seeding [`SidecarManager::idle_config`]: a
/// comma-separated `name=seconds` list (e.g. `llamacpp-rerank=900,research=1800`).
/// Unset/empty ⇒ idle-stop is OFF for every sidecar (behaviour unchanged). This is
/// the Rivet-style scale-to-zero seam — opt-in, per-sidecar, default-off.
const IDLE_ENV: &str = "RYU_SIDECAR_IDLE_SECS";

/// Per-sidecar activity bookkeeping the idle reaper reads: when a request last
/// touched the sidecar and how many are in-flight right now. Updated on the proxy
/// path via [`SidecarManager::touch_activity`] / [`SidecarManager::enter_request`].
#[derive(Debug)]
struct ActivityState {
    /// When a request last hit this sidecar (or when it was last woken). The idle
    /// clock is `now - last_activity`.
    last_activity: Instant,
    /// Requests currently in flight against this sidecar. Non-zero pins the
    /// sidecar alive so the reaper can never stop it mid-request (the conservative
    /// guard for held-open streams that can outlive the idle timeout).
    in_flight: u32,
}

impl Default for ActivityState {
    fn default() -> Self {
        Self {
            last_activity: Instant::now(),
            in_flight: 0,
        }
    }
}

/// Parse the [`IDLE_ENV`] value — a comma-separated `name=seconds` list — into the
/// per-sidecar idle-stop map. Blank/unparseable/zero entries are skipped (off for
/// that sidecar) rather than treated as instant-stop, so a typo can never make a
/// sidecar vanish the moment it starts. An empty result means the feature is off.
fn parse_idle_config(raw: &str) -> HashMap<String, Duration> {
    let mut out = HashMap::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((name, secs)) = entry.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let Ok(secs) = secs.trim().parse::<u64>() else {
            continue;
        };
        if name.is_empty() || secs == 0 {
            continue;
        }
        out.insert(name.to_string(), Duration::from_secs(secs));
    }
    out
}
/// How often the resource sampler refreshes per-engine memory/CPU. CPU% is a
/// delta since the previous refresh of each PID, so the cadence is also the CPU
/// averaging window.
const RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// Outcome of a local-engine swap, surfaced to clients so they can show what
/// actually happened (load/unload status).
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineSwap {
    /// The engine that is now the active local engine.
    pub active: String,
    /// The engine that was unloaded to make room, if any.
    pub stopped: Option<String>,
    /// Whether the active engine is now running.
    pub running: bool,
    /// True when the request was a no-op (the engine was already active and
    /// running) — the swap is idempotent.
    pub unchanged: bool,
}

/// A **proof of ownership** for one loopback port: this manager registered the named
/// sidecar, still holds the port claim for it, and the child it spawned was alive as of
/// the `waitpid` this lookup performed.
///
/// Note the exact scope of that last clause — it is checked, not assumed (the flag it
/// used to read was set at spawn and cleared only by `stop`, so a crashed sidecar
/// carried this proof forever), but it is a point-in-time answer about *our own child*.
/// It says nothing about a process that outlived a previous Core: no `Child` handle
/// survives the boot, so such a process is indistinguishable from any other stranger on
/// the port and Core never dials it. `claim_port` refuses, the sidecar stays
/// unregistered, and its routes 503 with a reason naming the port to free.
///
/// The type exists to make a class of bug unrepresentable. Before it, "which port do I
/// dial for this sidecar" had TWO independent answers — the manifest's declared
/// `spec.port` (via `profile::port`) and the manager's `port_claims` registry — and they
/// silently disagree in exactly the dangerous case: a sidecar whose `claim_port` was
/// refused because another process on the host already holds that port. Core would then
/// refuse to start the real sidecar and still forward Core-authenticated requests — full
/// bodies, cookies, and the plugin's minted `RYU_EXT_TOKEN` — to the foreign process
/// squatting there. Collapsing the two facts into one checked lookup is the fix, and the
/// missing public constructor is what keeps it collapsed: no present or future caller can
/// hand `forward_to_sidecar` a manifest-derived port by accident, because the only way to
/// obtain one of these outside tests is [`SidecarManager::forward_target`].
#[derive(Debug, Clone, Copy)]
pub struct ForwardTarget {
    port: u16,
}

impl ForwardTarget {
    /// The loopback port to dial. Always the port the manager CLAIMED for the sidecar
    /// (already profile-shifted — `ManifestSidecar::port()` returns
    /// `profile::port(spec.port)`, which is the value both the child binds and the claim
    /// registry stores), never a value re-derived from the manifest at the hop.
    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// Test-only escape hatch for the stub-server hop tests, which bind an ephemeral
    /// port with no manager behind it. Deliberately `#[cfg(test)]`: a production
    /// constructor would reopen the exact hole this type closes.
    #[cfg(test)]
    pub fn for_test(port: u16) -> Self {
        Self { port }
    }
}

/// Why a sidecar has no dialable port right now. The two arms are distinguished
/// because they mean very different things to the caller — and to the user reading
/// the failure.
#[derive(Debug, Clone)]
pub enum ForwardDenied {
    /// The name never entered the runtime registry: its `claim_port` was refused (some
    /// other process on this host holds the declared port), or the app was never
    /// enabled. There is nothing to wake — `wake_sidecar` would fail with "unknown
    /// sidecar" — and forwarding to the declared port is precisely the vulnerability.
    ///
    /// This arm is TERMINAL until a human intervenes, by design. Core does not try to
    /// reclaim the port, because it has no way to prove the process holding it is one of
    /// ours, and acting on a guess would mean signalling an unrelated program.
    NotRegistered {
        name: String,
        /// The port the manifest declared, echoed so the failure is diagnosable
        /// (the manifests publish these already; there is nothing to redact).
        declared_port: Option<u16>,
    },
    /// Registered and the claim is ours, but the process is not up. Legitimate and
    /// routine for a lazy / idle-stopped sidecar (which the caller then wakes); a real
    /// failure for an eager one (mid-download, crash-looping).
    NotRunning { name: String, port: u16 },
}

impl ForwardDenied {
    /// The manager key, for the failure body / log line.
    pub(crate) fn name(&self) -> &str {
        match self {
            Self::NotRegistered { name, .. } | Self::NotRunning { name, .. } => name,
        }
    }

    /// The port involved, when one is known.
    pub(crate) fn port(&self) -> Option<u16> {
        match self {
            Self::NotRegistered { declared_port, .. } => *declared_port,
            Self::NotRunning { port, .. } => Some(*port),
        }
    }

    /// Human-readable cause, rendered verbatim into the 503 body so the condition is
    /// diagnosable from the response alone (the durable half lives on
    /// `/api/sidecar/status` as `failure_reason`).
    ///
    /// The `NotRegistered` wording says the whole truth, because there is no recovery
    /// path behind it and pretending otherwise wastes the reader's time: Core refused to
    /// claim the port, it will not evict whoever holds it — a probe cannot tell an
    /// orphan of ours from an unrelated program, and guessing wrong means Core killing
    /// something else on the user's machine — so a human has to free the port. The
    /// likeliest holder is named (a sidecar left running by an unclean Core exit)
    /// because that is the one the user can act on.
    ///
    /// # Where the port number comes from
    ///
    /// NOT from `declared_port`, which is `None` on exactly the path that matters: a
    /// refused `claim_port` leaves no claim entry behind, and `forward_target` builds
    /// this arm from the claim registry. The durable reason recorded at the refusal is
    /// what carries the number (it embeds `claim_port`'s own error text), so it is
    /// preferred whenever one exists — the 503 body and the `/api/sidecar/status`
    /// `failure_reason` then say the same thing, which is the point.
    pub(crate) fn reason(&self) -> String {
        match self {
            Self::NotRegistered {
                name,
                declared_port,
            } => {
                if let Some(recorded) =
                    crate::sidecar::manifest_sidecar::registration_failure_reason(name)
                {
                    return format!("not registered: {recorded}");
                }
                let port = declared_port.map_or_else(
                    || "the declared port".to_owned(),
                    |port| format!("port {port}"),
                );
                format!(
                    "not registered: {port} is held by another process on this host, or the \
                     app is not enabled. Core will not kill a process it cannot prove it \
                     spawned; free {port} — most often a sidecar left behind by an unclean \
                     shutdown — then disable and re-enable this app"
                )
            }
            Self::NotRunning { port, .. } => {
                format!("registered on port {port} but not running (start failed or crashed)")
            }
        }
    }
}

pub struct SidecarManager {
    sidecars: HashMap<String, Arc<dyn Sidecar>>,
    /// Sidecars registered at RUNTIME (not at construction) — the manifest-declared
    /// managed sidecars a plugin brings, added on enable and removed on disable (the
    /// app ⇄ sidecar bridge). Kept in a *separate* map from the built-in `sidecars`
    /// so the boot-critical construction + `start_all` paths stay lock-free and
    /// untouched; only the additive read sites (health monitor, `statuses`, resource
    /// sampler, `stop_all`) consult it. The keyspaces are disjoint — built-ins use
    /// bare names, manifest sidecars use `<plugin_id>/<name>` — so a name lives in
    /// exactly one map and there is no cross-map invariant to maintain.
    ///
    /// Lock order: whenever both this and `resources` are needed, acquire `dynamic`
    /// FIRST and drop it before taking `resources` (snapshot the Arcs/pids out).
    /// `statuses` and the resource sampler both follow that order, so there is no
    /// AB-BA deadlock (which the compiler would NOT catch for two sync locks).
    dynamic: RwLock<HashMap<String, Arc<dyn Sidecar>>>,
    /// Port registry for manifest-declared sidecars: `port → owning sidecar name`.
    /// A declared port is claimed on `register_and_start` after two checks — it is
    /// not already claimed by a *different* dynamic sidecar, and a bind-probe
    /// (`TcpListener::bind(127.0.0.1:port)`) shows the OS port is currently free
    /// (which catches a built-in that already bound it, or any other host process).
    /// Released on `stop_and_deregister`. Built-ins do not participate (their
    /// `port()` is `None`); the bind-probe is how a plugin/built-in collision is
    /// caught. There is a TOCTOU window (free at probe, taken before the child
    /// binds) — acceptable for v1 and far better than no registry.
    port_claims: Mutex<HashMap<u16, String>>,
    startup_order: Vec<String>,
    health_monitors: Mutex<HashMap<String, JoinHandle<()>>>,
    setup: Arc<SetupManager>,
    /// Serializes local-engine swaps so two concurrent callers can never leave
    /// two engines resident. Holds the currently selected engine name.
    active_engine: tokio::sync::Mutex<Option<String>>,
    /// Latest per-sidecar resource sample (memory/CPU), refreshed by the
    /// background sampler ([`Self::spawn_resource_sampler`]). Read in `statuses`
    /// so the numbers ride the existing `/api/sidecar/status` poll. Keyed by
    /// sidecar name; absent until the first sample lands.
    resources: Mutex<HashMap<String, ResourceSample>>,
    /// Per-sidecar idle-stop timeout — the Rivet-style scale-to-zero config. Empty
    /// by default (feature OFF: nothing is ever idle-stopped and the reaper task is
    /// not even spawned); seeded from [`IDLE_ENV`] at construction. Keyed by the
    /// same names as the two sidecar maps (built-in bare name, or manifest
    /// `<plugin>/<name>` key). A configured sidecar that has served no request for
    /// its timeout (and has none in flight) is stopped by [`Self::spawn_idle_reaper`];
    /// the next request wakes it on demand via the existing lazy-start path.
    idle_config: HashMap<String, Duration>,
    /// Per-sidecar last-activity + in-flight bookkeeping the idle reaper reads.
    /// Populated lazily (on the first `touch_activity`/`enter_request`/`wake`), so a
    /// sidecar with no recorded activity is never a reaper target — the entry's
    /// existence is proof the idle path is actually wired for it.
    activity: Mutex<HashMap<String, ActivityState>>,
    /// Per-name idle-stop overrides declared at runtime (a manifest sidecar's
    /// `idle_stop_secs`, applied on enable via [`Self::set_idle_override`]). Merged
    /// OVER the construction-time [`Self::idle_config`] env seed, so a per-app
    /// declaration extends idle-stop beyond the operator env without a restart. Keyed
    /// by the same names as the sidecar maps (manifest `<plugin>/<name>`).
    idle_overrides: Mutex<HashMap<String, Duration>>,
    /// Per-name **start serialization** locks (async). Every process start of a
    /// dynamic sidecar — the eager [`Self::register_and_start`] and the on-demand
    /// [`Self::wake_sidecar`] — takes the name's lock across its `is_running` check +
    /// `start`, so two concurrent first requests (or an enable racing a first proxy
    /// hit) can never double-start the same child. The outer `Mutex` only guards the
    /// map (get-or-insert the per-name `Arc`); it is never held across an `.await`.
    start_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Names registered **register-only** for lazy (spawn-on-first-use) activation:
    /// they appear in [`Self::dynamic`] and `statuses` but their process is not
    /// started until a proxy/broker hit wakes them. Read by `statuses` so a
    /// scaled-to-zero lazy sidecar reads as "will wake on demand" rather than
    /// "crashed", and by [`Self::is_wake_eligible`] so the proxy only wakes sidecars
    /// that opted into on-demand start.
    lazy_registered: RwLock<HashSet<String>>,
}

impl SidecarManager {
    pub fn new(
        sidecars: Vec<Arc<dyn Sidecar>>,
        startup_order: Vec<String>,
        setup: Arc<SetupManager>,
    ) -> Arc<Self> {
        let map = sidecars
            .into_iter()
            .map(|s| (s.name().to_string(), s))
            .collect();
        // Hydrate the selected local engine from disk so the choice survives
        // Core restarts.
        let active = ActiveEngineStore::load().active;
        Arc::new(Self {
            sidecars: map,
            dynamic: RwLock::new(HashMap::new()),
            port_claims: Mutex::new(HashMap::new()),
            startup_order,
            health_monitors: Mutex::new(HashMap::new()),
            setup,
            active_engine: tokio::sync::Mutex::new(active),
            resources: Mutex::new(HashMap::new()),
            idle_config: parse_idle_config(&std::env::var(IDLE_ENV).unwrap_or_default()),
            activity: Mutex::new(HashMap::new()),
            idle_overrides: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            lazy_registered: RwLock::new(HashSet::new()),
        })
    }

    /// Create an empty manager with no sidecars for use in unit tests.
    #[cfg(test)]
    pub fn new_noop() -> Arc<Self> {
        Self::new_noop_with_idle(HashMap::new())
    }

    /// Like [`Self::new_noop`] but with an explicit idle-stop config, so tests can
    /// exercise the reaper's decision logic without touching process env.
    #[cfg(test)]
    pub fn new_noop_with_idle(idle_config: HashMap<String, Duration>) -> Arc<Self> {
        Arc::new(Self {
            sidecars: HashMap::new(),
            dynamic: RwLock::new(HashMap::new()),
            port_claims: Mutex::new(HashMap::new()),
            startup_order: Vec::new(),
            health_monitors: Mutex::new(HashMap::new()),
            setup: Arc::new(crate::sidecar::onboarding::SetupManager::new()),
            active_engine: tokio::sync::Mutex::new(None),
            resources: Mutex::new(HashMap::new()),
            idle_config,
            activity: Mutex::new(HashMap::new()),
            idle_overrides: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            lazy_registered: RwLock::new(HashSet::new()),
        })
    }

    /// Start all installed sidecars in dependency order.
    /// Returns Err if a required sidecar fails after all retries.
    /// Skips sidecars that haven't been installed.
    pub async fn start_all(self: &Arc<Self>) -> anyhow::Result<()> {
        // Resolve which local engine should be resident this session. At most one
        // local engine is ever started by `start_all` so we never end up with two
        // resident. Prefer the persisted selection; otherwise default to the first
        // installed local engine (in startup order) so chat works out of the box.
        let resident_engine = self.resolve_resident_engine().await;
        if let Some(engine) = &resident_engine {
            *self.active_engine.lock().await = Some(engine.clone());
            // Persist the resolved resident so `local_engine_gateway_url()` (which
            // reads the on-disk store) can register it as the gateway's `local`
            // provider. Without this, a fresh install that never performed an
            // explicit engine swap left the gateway with NO local provider — the
            // zero-key default model (routed `gemma* → Local`) then failed with
            // "all_providers_unavailable" even though llama-server was healthy
            // (QA finding B1's last leg). The gateway sidecar computes its spawn
            // env after this point in `start_all`, so ordering is safe.
            if ActiveEngineStore::load().active.as_deref() != Some(engine.as_str()) {
                if let Err(e) = ActiveEngineStore::save_active(Some(engine)) {
                    tracing::warn!(error = %e, engine, "could not persist resident local engine");
                }
            }
        }

        for name in &self.startup_order {
            let sidecar = match self.sidecars.get(name) {
                Some(s) => Arc::clone(s),
                None => continue,
            };

            // Check if sidecar is installed
            if !self.setup.is_installed(name).await {
                tracing::info!("Skipping {} - not installed", name);
                continue;
            }

            // Local engines are mutually exclusive: only start the resident one.
            if is_local_engine(name) && resident_engine.as_deref() != Some(name.as_str()) {
                tracing::info!("Skipping local engine {name} - not the active local engine");
                continue;
            }

            let result = self.start_with_retries(&sidecar).await;
            match result {
                Ok(()) => self.spawn_health_monitor(name),
                Err(e) if sidecar.is_required() => {
                    tracing::error!("required sidecar {name} failed: {e}");
                    return Err(e);
                }
                Err(e) => {
                    tracing::warn!("optional sidecar {name} failed to start: {e}");
                }
            }
        }
        Ok(())
    }

    // ── Active local engine (swap-on-demand) ──────────────────────────────────

    /// The currently selected local engine, if any.
    pub async fn active_local_engine(&self) -> Option<String> {
        self.active_engine.lock().await.clone()
    }

    /// Installed local engines, in startup order. Used to report what can be
    /// swapped to.
    pub async fn available_local_engines(&self) -> Vec<String> {
        let mut available = Vec::new();
        for name in &self.startup_order {
            if is_local_engine(name)
                && self.sidecars.contains_key(name)
                && self.setup.is_installed(name).await
            {
                available.push(name.clone());
            }
        }
        available
    }

    /// Make `name` the resident local engine, unloading whatever local engine is
    /// currently resident first. Mutual exclusion is guaranteed by holding the
    /// `active_engine` async mutex across the whole stop-then-start, so two
    /// concurrent callers can never leave two engines running. Idempotent: if
    /// `name` is already active and running this is a no-op. The selection is
    /// persisted so it survives Core restarts.
    pub async fn set_active_local_engine(
        self: &Arc<Self>,
        name: &str,
    ) -> anyhow::Result<EngineSwap> {
        if !is_local_engine(name) {
            return Err(anyhow::anyhow!("'{name}' is not a local engine"));
        }
        if !self.sidecars.contains_key(name) {
            return Err(anyhow::anyhow!("unknown sidecar: {name}"));
        }
        if !self.setup.is_installed(name).await {
            return Err(anyhow::anyhow!(
                "'{name}' is not installed — run `ryu setup` first"
            ));
        }

        let mut guard = self.active_engine.lock().await;
        let current = guard.clone();
        let already_running = self.sidecars.get(name).is_some_and(|s| s.is_running());

        // Idempotent fast path: already the active, running engine.
        if current.as_deref() == Some(name) && already_running {
            return Ok(EngineSwap {
                active: name.to_string(),
                stopped: None,
                running: true,
                unchanged: true,
            });
        }

        // Unload the engine that currently holds the slot (if different and not
        // the one we're about to start).
        let mut stopped = None;
        if let Some(prev) = &current {
            if prev != name {
                if let Err(e) = self.stop_sidecar(prev).await {
                    tracing::warn!("error unloading local engine {prev}: {e}");
                } else {
                    stopped = Some(prev.clone());
                }
            }
        }

        // Load the requested engine.
        let start_result = self.start_sidecar(name).await;
        let running = start_result.is_ok();

        // Persist + record the selection regardless of start success: the user's
        // intent is durable, and a failed start surfaces via `running: false`.
        *guard = Some(name.to_string());
        if let Err(e) = ActiveEngineStore::save_active(Some(name)) {
            tracing::warn!("could not persist active engine selection: {e}");
        }

        start_result?;

        Ok(EngineSwap {
            active: name.to_string(),
            stopped,
            running,
            unchanged: false,
        })
    }

    /// Decide which local engine should be resident at startup: the persisted
    /// selection if it is still installed, else the first installed local engine
    /// in startup order, else none.
    async fn resolve_resident_engine(&self) -> Option<String> {
        if let Some(persisted) = ActiveEngineStore::load().active {
            if is_local_engine(&persisted)
                && self.sidecars.contains_key(&persisted)
                && self.setup.is_installed(&persisted).await
            {
                return Some(persisted);
            }
        }
        for name in &self.startup_order {
            if is_local_engine(name)
                && self.sidecars.contains_key(name)
                && self.setup.is_installed(name).await
            {
                return Some(name.clone());
            }
        }
        None
    }

    /// Stop all sidecars in reverse startup order. Cancels health monitors first.
    pub async fn stop_all(&self) {
        {
            let mut monitors = self.health_monitors.lock().unwrap();
            for handle in monitors.values() {
                handle.abort();
            }
            monitors.clear();
        }

        for name in self.startup_order.iter().rev() {
            if let Some(sidecar) = self.sidecars.get(name) {
                if let Err(e) = sidecar.stop().await {
                    tracing::warn!("error stopping {name}: {e}");
                }
            }
        }

        // Also sweep the runtime-registered (manifest) sidecars — they are not in
        // `startup_order`. Snapshot the Arcs out (drop the read guard) before the
        // awaits so we never hold the lock across `.stop()`.
        let dynamic: Vec<(String, Arc<dyn Sidecar>)> = self
            .dynamic
            .read()
            .unwrap()
            .iter()
            .map(|(n, s)| (n.clone(), Arc::clone(s)))
            .collect();
        for (name, sidecar) in dynamic {
            let lock = self.start_lock_for(&name);
            let _guard = lock.lock().await;
            if let Err(e) = sidecar.stop().await {
                tracing::warn!("error stopping manifest sidecar {name}: {e}");
            }
        }
    }

    /// Register a manifest-declared managed sidecar (the app ⇄ sidecar bridge) and
    /// start it, spawning its health monitor — the runtime counterpart of the
    /// construction-time `sidecars` map. Called on plugin-enable and on the boot
    /// reconciliation pass. The caller MUST have already applied the tier + grant
    /// gate ([`crate::sidecar::manifest_sidecar::may_run_sidecar`]).
    ///
    /// Unlike [`start_sidecar`], this does NOT consult `SetupManager::is_installed`
    /// — a manifest sidecar self-installs on `start()` (it downloads its binary /
    /// provisions its venv). Idempotent: if the same name is already registered, the
    /// callers converge on that lifecycle owner (so the boot pass and a later enable
    /// don't replace an in-flight sidecar or double-spawn).
    pub async fn register_and_start(
        self: &Arc<Self>,
        sidecar: Arc<dyn Sidecar>,
    ) -> anyhow::Result<()> {
        let name = sidecar.name().to_string();
        // Hold the per-name lock across registration AND start. Registering before
        // taking it left a small but real enable/reconcile window in which two
        // callers could each observe a not-yet-running name and then start their
        // own process. The lock is now the complete lifecycle admission boundary.
        let lock = self.start_lock_for(&name);
        let _guard = lock.lock().await;
        self.register_inner(&sidecar, false)?;
        self.start_dynamic_unlocked(&name).await
    }

    /// **Register-only** (the lazy / spawn-on-first-use half): claim the port and
    /// insert the sidecar into the runtime registry so it appears in
    /// `/api/sidecar/status`, but do NOT start its process or spawn a health monitor.
    /// The first proxy/broker hit wakes it on demand ([`Self::wake_sidecar`]). Marks
    /// the name lazy so `statuses` reports scale-to-zero as "will wake" rather than
    /// "crashed", and so the proxy only wakes opted-in sidecars. The grant gate STILL
    /// runs at the (enable-time) call site — wake never re-runs construction, so
    /// there is no gate bypass. Idempotent: a re-register of a running sidecar is a
    /// no-op; of a stopped-but-registered one re-affirms the lazy mark.
    pub fn register(self: &Arc<Self>, sidecar: Arc<dyn Sidecar>) -> anyhow::Result<()> {
        self.register_inner(&sidecar, true)?;
        Ok(())
    }

    /// Shared register step for [`register_and_start`] (eager) and [`register`]
    /// (lazy). Claims the port, inserts into `dynamic`, and records/clears the lazy
    /// mark. Returns `Ok(true)` when the name was already registered, regardless of
    /// whether its first start is still in flight. Never starts the process.
    fn register_inner(&self, sidecar: &Arc<dyn Sidecar>, lazy: bool) -> anyhow::Result<bool> {
        let name = sidecar.name().to_string();
        // Idempotency: a name is the lifecycle identity. Do not replace an existing
        // sidecar while its first start is in flight: the start lock below serializes
        // the process transition, but replacing the value in `dynamic` would let the
        // first caller start the old object and the next caller start the replacement,
        // leaving two children bound to the same declared port.
        let already_registered = self.dynamic.read().unwrap().contains_key(&name);
        if already_registered {
            let mut set = self.lazy_registered.write().unwrap();
            if lazy {
                set.insert(name.clone());
            } else {
                set.remove(&name);
            }
            return Ok(true);
        }
        // Port registry: claim the declared port BEFORE inserting, so a collision
        // with a built-in (already bound) or another plugin fails fast. Idempotent
        // for the same owner, so a re-register keeps the claim.
        //
        // A refusal here is the failure the whole ext-proxy registration gate exists
        // for, and it is otherwise INVISIBLE: the name never enters `dynamic`, so it is
        // absent from `statuses()` rather than reported as failed. Record it (with
        // `claim_port`'s own wording, which names the port and the OS error) so
        // `/api/sidecar/status` can explain why the app is dead. Recorded HERE and not
        // at the enable-time call sites deliberately — those wrap `register_and_start`,
        // whose error may equally come from `start()`, which would mislabel a crashed
        // process as a registration failure.
        if let Some(port) = sidecar.port() {
            if let Err(e) = self.claim_port(port, &name) {
                // `claim_port`'s wording verbatim (it names the port and the OS error),
                // plus the remedy — and the remedy is a HUMAN one. Core does not kill
                // whatever holds the port: a bind-probe cannot tell a sidecar our own
                // predecessor left running from an unrelated program, and evicting on a
                // guess would mean destroying something else on the user's machine. So
                // the reason names the likeliest cause the user can actually act on.
                // Deliberately says **re-enable**, not "restart this sidecar": a refused
                // claim means the name never entered `dynamic`, so there is nothing for
                // the restart endpoint to find. Re-enabling the app re-enters the
                // register path and is the way out.
                let reason = format!(
                    "{e}. Core will not kill a process it cannot prove it spawned — free \
                     port {port} (most often a sidecar left behind by an unclean \
                     shutdown), then disable and re-enable this app"
                );
                crate::sidecar::manifest_sidecar::record_registration_failure(&name, &reason);
                return Err(e);
            }
        }
        crate::sidecar::manifest_sidecar::clear_registration_failure(&name);
        self.dynamic
            .write()
            .unwrap()
            .insert(name.clone(), Arc::clone(sidecar));
        {
            let mut set = self.lazy_registered.write().unwrap();
            if lazy {
                set.insert(name);
            } else {
                set.remove(&name);
            }
        }
        Ok(false)
    }

    /// Get-or-create the per-name async start lock. The map `Mutex` is held only for
    /// the get-or-insert and is never held across an `.await`; callers hold the
    /// returned per-name lock across `start().await`.
    fn start_lock_for(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.start_locks
                .lock()
                .unwrap()
                .entry(name.to_string())
                .or_default(),
        )
    }

    /// Resolve a sidecar Arc from whichever map owns it (built-in `sidecars` or the
    /// runtime `dynamic` registry), cloning it out so no lock guard is held by the
    /// caller. The single lookup helper the wake / reaper / health paths share.
    fn resolve_sidecar(&self, name: &str) -> Option<Arc<dyn Sidecar>> {
        self.sidecars
            .get(name)
            .map(Arc::clone)
            .or_else(|| self.dynamic.read().unwrap().get(name).map(Arc::clone))
    }

    /// Start an already-registered dynamic sidecar under its per-name start lock,
    /// then spawn its health monitor. A no-op (Ok) if it is already running or gone
    /// from the registry. Shared by the eager [`register_and_start`] path.
    async fn start_dynamic_locked(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        let lock = self.start_lock_for(name);
        let _guard = lock.lock().await;
        self.start_dynamic_unlocked(name).await
    }

    /// Start the already-registered dynamic sidecar while its per-name start lock
    /// is held by the caller. Keeping this as a separate helper lets
    /// [`Self::register_and_start`] cover registration and start with one lock
    /// acquisition, so no duplicate child can be admitted between the two steps.
    async fn start_dynamic_unlocked(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        let Some(sidecar) = self.dynamic.read().unwrap().get(name).map(Arc::clone) else {
            return Ok(());
        };
        if sidecar.is_running() {
            return Ok(());
        }
        sidecar.start().await?;
        self.spawn_health_monitor(name);
        self.touch_activity(name);
        Ok(())
    }

    /// Claim `port` for `name` in the port registry. Fails if a *different* dynamic
    /// sidecar already claimed it, or if a bind-probe shows the OS port is in use
    /// (a running built-in or any other host process). Idempotent for the same
    /// owner. Holds `port_claims` only for the map check + insert; the bind-probe
    /// listener is opened and dropped inside the guard (freeing the port again)
    /// which is safe because no `.await` happens while the guard is held.
    fn claim_port(&self, port: u16, name: &str) -> anyhow::Result<()> {
        let mut claims = self.port_claims.lock().unwrap();
        if let Some(owner) = claims.get(&port) {
            if owner != name {
                return Err(anyhow::anyhow!(
                    "port {port} is already claimed by sidecar '{owner}'"
                ));
            }
            return Ok(()); // same owner re-claiming — idempotent.
        }
        // Bind-probe: if the OS refuses the bind, something (a built-in that already
        // started, or an external process) holds the port. Drop the listener
        // immediately so the child can bind it right after.
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => drop(listener),
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "port {port} is already in use on the host (bind probe failed: {e})"
                ));
            }
        }
        claims.insert(port, name.to_string());
        Ok(())
    }

    /// Release every port claimed by `name` (a sidecar owns at most one, but the
    /// scan keeps this correct regardless).
    fn release_port(&self, name: &str) {
        self.port_claims
            .lock()
            .unwrap()
            .retain(|_, owner| owner != name);
    }

    /// Stop a manifest-declared managed sidecar and remove it from the runtime
    /// registry — the counterpart of [`register_and_start`], called on
    /// plugin-disable. Cancels its health monitor first. A no-op for an unknown name.
    pub async fn stop_and_deregister(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        // Keep the lifecycle lock for the complete removal + stop transition. A
        // concurrent wake/restart must not observe a half-removed entry, create a
        // new lock, and re-register the old sidecar while its process is still
        // stopping. The lock entry is intentionally retained after deregistration:
        // deleting it while another caller can obtain the old Arc would recreate
        // the exact race this guard closes.
        let lock = self.start_lock_for(name);
        let _guard = lock.lock().await;
        if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
            handle.abort();
        }
        let sidecar = self.dynamic.write().unwrap().remove(name);
        // Release the port claim so the port frees for a re-enable or another plugin.
        self.release_port(name);
        // A disabled app must not keep a "failed to register" reason on the status
        // plane forever — the condition is no longer true of anything we own.
        crate::sidecar::manifest_sidecar::clear_registration_failure(name);
        // Same for a recorded crash: the process it described is gone along with the
        // registration, so keeping the reason would make a disabled app read as a
        // failing one forever (and `start()` — the other clear — never runs again).
        crate::sidecar::manifest_sidecar::clear_crash_reason(name);
        // Drop idle/lazy/activity bookkeeping so a re-enable starts clean and a
        // stale idle clock can't fire against a name that no longer exists. Keep
        // the per-name lifecycle lock permanently: it is the identity boundary
        // that prevents a later re-enable from racing with this stop transition.
        self.lazy_registered.write().unwrap().remove(name);
        self.idle_overrides.lock().unwrap().remove(name);
        self.activity.lock().unwrap().remove(name);
        if let Some(sc) = sidecar {
            sc.stop().await?;
        }
        Ok(())
    }

    /// Stop and restart a single sidecar by name — built-in or manifest-declared.
    ///
    /// # The dynamic arm was missing entirely
    ///
    /// This only ever consulted `self.sidecars`, the construction-time built-in map. For
    /// every manifest sidecar — i.e. every app — `POST /api/sidecar/{name}/restart`
    /// therefore returned `{"success": true}` having done precisely nothing. That is an
    /// independent bug, and it is also the cheapest affordance available for the sidecar
    /// that CRASHED: its claim is kept (see [`Self::note_crash_if_exited`]) and its name
    /// is still in `dynamic`, so one existing button brings it back with no new endpoint
    /// and no new UI contract.
    ///
    /// # What it is NOT a way out of
    ///
    /// It does not recover the port-squatted case. A refused `claim_port` means the name
    /// never entered `dynamic`, so there is nothing here to find and this returns `Ok(())`
    /// having touched nothing — the same shape as an unknown name. The way out of that one
    /// is for a human to free the port and then disable/re-enable the app, which re-enters
    /// the register path. Core does not free it for them: it cannot prove the process
    /// holding the port is one it spawned, and killing on a guess is worse than the 503.
    /// The refusal reason on the status plane says exactly that; do not restate it here
    /// as "restart".
    pub async fn restart_sidecar(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        if let Some(sidecar) = self.sidecars.get(name) {
            if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
                handle.abort();
            }
            sidecar.stop().await?;
            sidecar.start().await?;
            self.spawn_health_monitor(name);
            return Ok(());
        }
        let lock = self.start_lock_for(name);
        let _guard = lock.lock().await;
        let Some(sidecar) = self.dynamic.read().unwrap().get(name).map(Arc::clone) else {
            return Ok(());
        };
        // Read the lazy mark into a local FIRST: `register_inner` takes the same lock for
        // writing, and holding the read guard across the call would deadlock.
        let was_lazy = self.lazy_registered.read().unwrap().contains(name);
        if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
            handle.abort();
        }
        // Stop BEFORE the re-register: `register_inner` short-circuits on an
        // already-registered-and-running name, so a restart that skipped the stop would
        // be a silent no-op.
        sidecar.stop().await?;
        self.register_inner(&sidecar, was_lazy)?;
        self.start_dynamic_unlocked(name).await
    }

    /// Mark a sidecar as installed so `start_sidecar` / `start_all` will run it.
    ///
    /// PATH-adopted sidecars (e.g. the mesh's `tailscale`, which Ryu never
    /// downloads and so never records in `versions.json`) are not covered by
    /// `seed_installed_from_disk`; callers that make one eligible must mark it
    /// explicitly (Core does at boot when the mesh pref is on, and the
    /// `POST /api/mesh/config` enable route does at runtime).
    pub async fn mark_installed(&self, name: &str) {
        self.setup.mark_installed(name).await;
    }

    /// Mark a sidecar as NOT installed, so `start_all` stops auto-starting it.
    ///
    /// The mirror of [`Self::mark_installed`]: `POST /api/mesh/config` unmarks
    /// `tailscale` when the mesh is disabled so a mesh-off install doesn't try
    /// to start (and warn about) a daemon that must not run.
    pub async fn unmark_installed(&self, name: &str) {
        self.setup.uninstall(name).await;
    }

    /// Start a single installed sidecar by name and spawn its health monitor.
    pub async fn start_sidecar(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        if !self.setup.is_installed(name).await {
            return Err(anyhow::anyhow!(
                "'{name}' is not installed — run `ryu setup` first"
            ));
        }
        let sidecar = self
            .sidecars
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("unknown sidecar: {name}"))?;
        let sidecar = Arc::clone(sidecar);
        sidecar.start().await?;
        self.spawn_health_monitor(name);
        // Every lazy-start call site is also a request touchpoint: recording
        // activity here means the fire-and-forget `start_sidecar` spawns that wake
        // an idle-stopped built-in (rerank per search, research per data request)
        // reset its idle clock with zero extra wiring at the call site.
        self.touch_activity(name);
        Ok(())
    }

    /// Stop a single sidecar by name and cancel its health monitor.
    pub async fn stop_sidecar(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
            handle.abort();
        }
        let sidecar = self
            .sidecars
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("unknown sidecar: {name}"))?;
        sidecar.stop().await?;
        Ok(())
    }

    /// Stop, uninstall, and optionally delete the data for a sidecar by name.
    pub async fn uninstall_sidecar(&self, name: &str, delete_data: bool) -> anyhow::Result<()> {
        // Cancel the health monitor first so it doesn't interfere.
        if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
            handle.abort();
        }
        let sidecar = self
            .sidecars
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("unknown sidecar: {name}"))?;
        // Stop the running process (best-effort).
        if let Err(e) = sidecar.stop().await {
            tracing::warn!("could not stop {name} before uninstall: {e}");
        }
        sidecar.uninstall(delete_data).await
    }

    /// The declared runtime **permission posture** of every native manifest
    /// sidecar (unified permission grammar). Additive companion to [`Self::statuses`]:
    /// where `statuses` reports liveness/resources, this reports what each native
    /// (unsandboxed) sidecar *declared* it needs and that the declaration is
    /// recorded-but-not-OS-enforced this wave (see `ManifestSidecar`). Sourced from
    /// the process-global record `ManifestSidecar::start` writes.
    ///
    /// Followup (files outside this change's set): fold `declared`/`enforced` onto
    /// [`SidecarStatus`] (`sidecar/mod.rs`) + the `/api/sidecar/status` handler
    /// (`server/mod.rs`) so a single poll carries both. This method is the seam.
    pub fn native_sidecar_permissions(
        &self,
    ) -> Vec<crate::sidecar::manifest_sidecar::NativeSidecarPermissions> {
        crate::sidecar::manifest_sidecar::native_sidecar_permission_reports()
    }

    pub fn statuses(&self) -> Vec<SidecarStatus> {
        // Snapshot the lazy set first (its own lock, taken before the others so it
        // never nests inside dynamic/resources) so a scaled-to-zero lazy sidecar can
        // be reported as "will wake on demand" rather than misread as crashed.
        let lazy = self.lazy_registered.read().unwrap().clone();
        // Snapshot the dynamic (manifest) sidecars FIRST, before taking `resources`,
        // to keep the single lock order (dynamic → resources) the resource sampler
        // also follows — avoiding an AB-BA deadlock the compiler cannot catch.
        let dynamic: Vec<(String, Arc<dyn Sidecar>)> = self
            .dynamic
            .read()
            .unwrap()
            .iter()
            .map(|(n, s)| (n.clone(), Arc::clone(s)))
            .collect();
        let resources = self.resources.lock().unwrap();
        let status_for = |name: &str, sidecar: &Arc<dyn Sidecar>| {
            let sample = resources.get(name);
            SidecarStatus {
                name: name.to_string(),
                running: sidecar.is_running(),
                lazy: lazy.contains(name),
                pid: sidecar.pid(),
                memory_bytes: sample.map(|s| s.memory_bytes),
                cpu_percent: sample.map(|s| s.cpu_percent),
                // Registration failure first, crash second: a sidecar that never
                // registered cannot have crashed, so the more fundamental condition
                // wins when (impossibly) both are set. The crash link is what stops a
                // died-on-its-own sidecar from rendering as an ordinary scaled-to-zero
                // one — before it existed this row read `running: true,
                // failure_reason: None` for a process that no longer existed.
                failure_reason: crate::sidecar::manifest_sidecar::registration_failure_reason(name)
                    .or_else(|| crate::sidecar::manifest_sidecar::crash_reason(name)),
            }
        };
        let mut out: Vec<SidecarStatus> = self
            .startup_order
            .iter()
            .filter_map(|name| self.sidecars.get(name).map(|s| status_for(name, s)))
            .collect();
        // Include registered sidecars that aren't in `startup_order` — e.g. opt-in
        // voice engines (whisper.cpp) that are started on demand, never at boot.
        // Without this their running state is missing from `/api/sidecar/status`
        // and the Store's Voice toggle would never reflect a successful start.
        for (name, sidecar) in &self.sidecars {
            if !self.startup_order.iter().any(|n| n == name) {
                out.push(status_for(name, sidecar));
            }
        }
        // Manifest-declared managed sidecars ride the same status surface for free.
        for (name, sidecar) in &dynamic {
            out.push(status_for(name, sidecar));
        }
        // Sidecars that failed to REGISTER own no `Arc<dyn Sidecar>`, so they cannot go
        // through `status_for` — synthesize a row each. This is the only way they appear
        // on the status plane at all: a refused `claim_port` used to leave them silently
        // ABSENT (not "failed"), which is why "port squatted by another process" showed
        // up to the user as an app that simply did not work, with no reason anywhere.
        for (name, reason) in crate::sidecar::manifest_sidecar::registration_failures() {
            if out.iter().any(|s| s.name == name) {
                continue;
            }
            out.push(SidecarStatus {
                name,
                running: false,
                // Not `lazy`: a lazy sidecar is registered-and-scaled-to-zero and WILL
                // wake. This one will not — nothing owns its port.
                lazy: false,
                pid: None,
                memory_bytes: None,
                cpu_percent: None,
                failure_reason: Some(reason),
            });
        }
        out
    }

    /// Spawn the background resource sampler: every [`RESOURCE_SAMPLE_INTERVAL`]
    /// it collects the live `(name, pid)` set from the sidecars that own a
    /// resident child and refreshes their memory/CPU into `self.resources`, which
    /// [`Self::statuses`] reads. One long-lived `sysinfo::System` is reused so CPU
    /// deltas are meaningful (a fresh `System` per tick would always read 0%).
    pub fn spawn_resource_sampler(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            // One `sysinfo::System` lives for the whole task so CPU deltas carry
            // across ticks. Refreshing only a handful of known PIDs is cheap, so
            // the synchronous sample between awaits won't stall the runtime.
            let mut sys = sysinfo::System::new();
            let mut ticker = tokio::time::interval(RESOURCE_SAMPLE_INTERVAL);
            loop {
                ticker.tick().await;
                let mut named_pids: Vec<(String, u32)> = manager
                    .sidecars
                    .iter()
                    .filter_map(|(name, sc)| sc.pid().map(|pid| (name.clone(), pid)))
                    .collect();
                // Include manifest sidecars' PIDs. Take `dynamic` and drop it BEFORE
                // touching `resources` (lock order: dynamic → resources), matching
                // `statuses`, so the two sync locks never nest the other way.
                {
                    let dynamic = manager.dynamic.read().unwrap();
                    for (name, sc) in dynamic.iter() {
                        if let Some(pid) = sc.pid() {
                            named_pids.push((name.clone(), pid));
                        }
                    }
                }
                let samples = resources::sample(&mut sys, &named_pids);
                *manager.resources.lock().unwrap() = samples;
            }
        });
    }

    // ── Idle-stop (Rivet-style scale-to-zero) ─────────────────────────────────

    /// Record that a request just hit `name` — refreshes its idle clock so the
    /// reaper won't scale it to zero. Cheap (one mutex + `Instant::now`); safe to
    /// call for any sidecar (an entry for a non-idle-configured sidecar is inert).
    /// Called on the proxy path of the idle-eligible sidecars.
    pub fn touch_activity(&self, name: &str) {
        self.activity
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .last_activity = Instant::now();
    }

    /// Begin an in-flight request against `name`, returning a guard that pins the
    /// sidecar alive (in-flight > 0) for the request's whole duration and refreshes
    /// its idle clock on drop. Use for Core-side requests that can outlive the idle
    /// timeout (held-open streams); short request/response calls only need
    /// [`Self::touch_activity`].
    pub fn enter_request(self: &Arc<Self>, name: &str) -> ActivityGuard {
        {
            let mut activity = self.activity.lock().unwrap();
            let st = activity.entry(name.to_string()).or_default();
            st.in_flight += 1;
            st.last_activity = Instant::now();
        }
        ActivityGuard {
            manager: Arc::clone(self),
            name: name.to_string(),
        }
    }

    /// Wake a sidecar on demand — the scale-from-zero half of idle-stop. If it
    /// exists (built-in or manifest) and isn't running, start its process and
    /// re-spawn its health monitor (which the reaper cancels on stop). Seeds/refreshes
    /// the activity entry so the idle clock restarts. Idempotent when already
    /// running (a plain touch). Built-in idle-eligible sidecars already wake via
    /// their per-request `start_sidecar` calls; this is for manifest sidecars whose
    /// wake path is not `start_sidecar`.
    pub async fn wake_sidecar(self: &Arc<Self>, name: &str) -> anyhow::Result<bool> {
        let sidecar = self
            .resolve_sidecar(name)
            .ok_or_else(|| anyhow::anyhow!("unknown sidecar: {name}"))?;
        self.touch_activity(name);
        if sidecar.is_running() {
            return Ok(false);
        }
        // Serialize concurrent wakes of the SAME name so two racing first requests
        // (or an enable racing a first proxy hit) start the child exactly once. The
        // is_running re-check under the lock is what closes the previous race where
        // `wake` read is_running then started outside any lock.
        let lock = self.start_lock_for(name);
        let _guard = lock.lock().await;
        if sidecar.is_running() {
            return Ok(false); // a racing waker already started it.
        }
        sidecar.start().await?;
        self.spawn_health_monitor(name);
        self.touch_activity(name);
        Ok(true)
    }

    /// Wake `name` on demand and (if it had to be started) block until it reports
    /// healthy — the proxy/broker warm-up gate. The WHOLE operation (start + health
    /// poll) is bounded by `timeout` so a first `start()` that includes a binary
    /// download can never stall the caller past its budget; a timeout is surfaced as
    /// an error the proxy turns into a 503 "warming" (a resumable `.part` download
    /// means a later request warms it). Returns `Ok(true)` when it cold-started the
    /// process (the "first hit" moment the caller fires an activation event on),
    /// `Ok(false)` when it was already warm (no health wait needed).
    pub async fn wake_and_await_healthy(
        self: &Arc<Self>,
        name: &str,
        timeout: Duration,
    ) -> anyhow::Result<bool> {
        let this = Arc::clone(self);
        let name_owned = name.to_string();
        tokio::time::timeout(timeout, async move {
            let woke = this.wake_sidecar(&name_owned).await?;
            if woke {
                this.await_healthy(&name_owned).await?;
            }
            Ok::<bool, anyhow::Error>(woke)
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "sidecar '{name}' did not warm within {}s",
                timeout.as_secs()
            )
        })?
    }

    /// Poll a sidecar's health check until it is [`HealthStatus::Healthy`], sleeping
    /// briefly between attempts. Unbounded on its own — always called inside the
    /// `wake_and_await_healthy` timeout that bounds it.
    async fn await_healthy(&self, name: &str) -> anyhow::Result<()> {
        let sidecar = self
            .resolve_sidecar(name)
            .ok_or_else(|| anyhow::anyhow!("unknown sidecar: {name}"))?;
        loop {
            if matches!(sidecar.health_check().await, HealthStatus::Healthy) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// The port THIS manager holds a claim on for `name` — the raw read behind
    /// [`Self::forward_target`], without the liveness check. Exposed for status/
    /// diagnostics; a caller about to DIAL must use `forward_target`, never this.
    pub fn claimed_port(&self, name: &str) -> Option<u16> {
        self.port_claims
            .lock()
            .unwrap()
            .iter()
            .find(|(_, owner)| owner.as_str() == name)
            .map(|(port, _)| *port)
    }

    /// Resolve a live manifest sidecar owned by `plugin_id` to its loopback base URL.
    ///
    /// This deliberately goes through [`Self::forward_target`] rather than reading a
    /// manifest or the declared port. The manager's claim is the proof that Core owns
    /// the port, and the liveness check prevents returning a URL after the child has
    /// exited. Requiring the local sidecar name keeps the result unambiguous when a
    /// plugin declares more than one sidecar.
    pub fn sidecar_base_url(
        &self,
        plugin_id: &str,
        sidecar_name: &str,
    ) -> Result<String, ForwardDenied> {
        let name = crate::sidecar::manifest_sidecar::namespaced_name(plugin_id, sidecar_name);
        self.forward_target(&name)
            .map(|target| format!("http://127.0.0.1:{}", target.port()))
    }

    /// **The only way to obtain a dialable port for a sidecar.** Returns the port this
    /// manager CLAIMED for `name`, and only when the child we spawned for it is still
    /// alive as of this call.
    ///
    /// Reads three facts in order — is it registered, do we hold its claim, is it up —
    /// and never consults the manifest. That ordering is the security argument, and the
    /// three facts prove three *different* things, which is worth stating separately
    /// because conflating them is what the original hole was made of:
    ///
    /// - A manifest-declared port is an **aspiration** — text a plugin author wrote.
    ///   Never dial it.
    /// - The **claim** proves *reservation*: no other sidecar in this process took the
    ///   port, and the bind-probe at claim time saw it free. It proves nothing about
    ///   who is listening there now.
    /// - The **liveness check** proves *occupancy by our child*, and only at the instant
    ///   it runs: it is a `waitpid(WNOHANG)` on the `Child` this manager holds
    ///   ([`crate::sidecar::process::ProcessHandle::is_running`]), not the spawn-time
    ///   flag it used to be. That flag was the bug — it survived the process it
    ///   described, so a crashed sidecar's vacated port stayed dialable and the ext
    ///   proxy would stamp `RYU_EXT_TOKEN` onto a request aimed at whatever bound it
    ///   next.
    ///
    /// Neither fact says anything about a process that outlived a **previous** Core: no
    /// `Child` handle survives the boot, so nothing here can distinguish our own orphan
    /// from a stranger — and because it cannot, Core treats both the same way and dials
    /// neither. There is no reclaim step; the port stays unclaimed until a human frees
    /// it.
    ///
    /// When `claim_port` was refused (an unrelated
    /// host process, or another sidecar, already holds the port) the name never enters
    /// `dynamic`, so this returns [`ForwardDenied::NotRegistered`] and the caller must
    /// refuse rather than hand a foreign listener Core-authenticated traffic and the
    /// plugin's minted `RYU_EXT_TOKEN`.
    ///
    /// [`ForwardDenied::NotRunning`] is deliberately a SEPARATE arm rather than a flat
    /// error: it is the normal resting state of a lazy / idle-stopped sidecar
    /// ([`Self::register`] claims the port and inserts into `dynamic` WITHOUT starting
    /// the process), so callers translate it into a wake, not a refusal. Only the
    /// not-wake-eligible case is a genuine failure.
    pub fn forward_target(&self, name: &str) -> Result<ForwardTarget, ForwardDenied> {
        let Some(sidecar) = self.dynamic.read().unwrap().get(name).map(Arc::clone) else {
            return Err(ForwardDenied::NotRegistered {
                name: name.to_owned(),
                // A refused claim leaves no claim entry, so this is usually `None`;
                // it is `Some` only in the odd case of a claim outliving its entry.
                declared_port: self.claimed_port(name),
            });
        };
        // The claim registry, not `sidecar.port()`: the claim is what proves no other
        // owner took the port out from under us between registration and this hop.
        let Some(port) = self.claimed_port(name) else {
            return Err(ForwardDenied::NotRegistered {
                name: name.to_owned(),
                declared_port: sidecar.port(),
            });
        };
        if !sidecar.is_running() {
            return Err(ForwardDenied::NotRunning {
                name: name.to_owned(),
                port,
            });
        }
        Ok(ForwardTarget { port })
    }

    /// Whether `name` opted into on-demand start — it was registered lazy, or it
    /// carries an idle-stop timeout (env-seeded or per-app override) and so can be
    /// scaled to zero and must re-wake. The proxy consults this so it only warms
    /// sidecars that asked for it (a plain eager sidecar mid-download is untouched).
    pub fn is_wake_eligible(&self, name: &str) -> bool {
        self.lazy_registered.read().unwrap().contains(name)
            || self.idle_config.contains_key(name)
            || self.idle_overrides.lock().unwrap().contains_key(name)
    }

    /// Record a per-name idle-stop timeout declared at runtime (a manifest sidecar's
    /// `idle_stop_secs`, applied on enable) — extends idle-stop beyond the
    /// construction-time [`IDLE_ENV`] seed without a restart. A zero is ignored (the
    /// validator already rejects sub-30s, but guard anyway so a stray 0 can't make a
    /// sidecar vanish the instant it wakes).
    pub fn set_idle_override(&self, name: &str, secs: u64) {
        if secs == 0 {
            return;
        }
        self.idle_overrides
            .lock()
            .unwrap()
            .insert(name.to_string(), Duration::from_secs(secs));
    }

    /// Names of idle-configured sidecars whose idle clock has expired AND that have
    /// no request in flight. Pure decision over the `activity` map (no sidecar-map
    /// locks, no I/O) so the reaper's policy is unit-testable and there is no
    /// nested-lock ordering to reason about. Only sidecars with a recorded activity
    /// entry are eligible — the entry's existence is proof the idle path is wired,
    /// so a configured-but-never-touched sidecar is never stopped out from under an
    /// unwired caller.
    fn idle_stop_due(&self, now: Instant) -> Vec<String> {
        // Snapshot the per-name overrides FIRST, before locking `activity`, so the
        // two locks are only ever acquired in the order overrides → activity (no
        // AB-BA). `idle_config` is immutable post-construction, so it needs no lock.
        let overrides = self.idle_overrides.lock().unwrap().clone();
        if self.idle_config.is_empty() && overrides.is_empty() {
            return Vec::new();
        }
        let activity = self.activity.lock().unwrap();
        activity
            .iter()
            .filter_map(|(name, st)| {
                let timeout = overrides
                    .get(name)
                    .or_else(|| self.idle_config.get(name))
                    .copied()?;
                if st.in_flight == 0 && now.saturating_duration_since(st.last_activity) >= timeout {
                    Some(name.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Spawn the background idle reaper: every [`IDLE_REAP_INTERVAL`] it stops each
    /// idle-configured sidecar whose idle clock has expired (scale-to-zero). A no-op
    /// when [`Self::idle_config`] is empty — the task is not even spawned, so the
    /// default-off path adds nothing. The reaper stops the PROCESS only (via
    /// `Sidecar::stop`) and, for a manifest sidecar, leaves it REGISTERED in
    /// `dynamic` so the app⇄sidecar bridge survives and the next request can wake
    /// it. It cancels the sidecar's health monitor first so it doesn't spam
    /// "unhealthy" against a deliberately-stopped process; wake re-spawns it.
    pub fn spawn_idle_reaper(self: &Arc<Self>) {
        // The reaper is ALWAYS spawned (not gated on the env seed) because per-name
        // idle overrides — a manifest sidecar's `idle_stop_secs` — land *after*
        // construction, on plugin-enable. The per-tick decision ([`idle_stop_due`])
        // is a no-op while both the env seed and the overrides are empty, so the
        // default-off cost is one empty 30s tick.
        if !self.idle_config.is_empty() {
            tracing::info!(
                "sidecar idle-stop enabled for: {:?}",
                self.idle_config.keys().collect::<Vec<_>>()
            );
        }
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(IDLE_REAP_INTERVAL);
            ticker.tick().await; // skip the immediate first tick
            loop {
                ticker.tick().await;
                for name in manager.idle_stop_due(Instant::now()) {
                    // Resolve the Arc from whichever map owns it (same pattern as
                    // the health monitor). Snapshot it out before any await so no
                    // lock guard is held across `.stop()`.
                    let sidecar = manager
                        .sidecars
                        .get(&name)
                        .map(Arc::clone)
                        .or_else(|| manager.dynamic.read().unwrap().get(&name).map(Arc::clone));
                    let Some(sidecar) = sidecar else {
                        continue;
                    };
                    if !sidecar.is_running() {
                        continue;
                    }
                    // Re-check under the activity lock right before stopping to
                    // shrink the wake/stop race: a request that landed since
                    // `idle_stop_due` ran (bumping in-flight or last_activity) must
                    // spare the sidecar.
                    if !manager.still_idle(&name, Instant::now()) {
                        continue;
                    }
                    if let Some(handle) = manager.health_monitors.lock().unwrap().remove(&name) {
                        handle.abort();
                    }
                    match sidecar.stop().await {
                        Ok(()) => {
                            tracing::info!("idle-stopped sidecar '{name}' (scale-to-zero)");
                        }
                        Err(e) => tracing::warn!("idle-stop of '{name}' failed: {e}"),
                    }
                    // Drop the activity entry so the next wake starts a fresh idle
                    // clock (and a stale timestamp can't immediately re-fire).
                    manager.activity.lock().unwrap().remove(&name);
                }
            }
        });
    }

    /// Whether `name` is still idle (no in-flight request and idle clock still
    /// expired) at `now`, re-read under the activity lock. Used by the reaper to
    /// confirm nothing woke the sidecar between the decision and the stop.
    fn still_idle(&self, name: &str, now: Instant) -> bool {
        // Resolve the timeout (override wins over env seed) and DROP the overrides
        // lock before touching `activity` — same overrides → activity order as
        // `idle_stop_due`, never nested the other way.
        let timeout = {
            let overrides = self.idle_overrides.lock().unwrap();
            overrides
                .get(name)
                .or_else(|| self.idle_config.get(name))
                .copied()
        };
        let Some(timeout) = timeout else {
            return false;
        };
        self.activity.lock().unwrap().get(name).is_some_and(|st| {
            st.in_flight == 0 && now.saturating_duration_since(st.last_activity) >= timeout
        })
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async fn start_with_retries(&self, sidecar: &Arc<dyn Sidecar>) -> anyhow::Result<()> {
        let retries = if sidecar.is_required() {
            MAX_REQUIRED_RETRIES
        } else {
            1
        };
        let mut last_err = None;
        for attempt in 1..=retries {
            match sidecar.start().await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    tracing::warn!(
                        "{} start attempt {attempt}/{retries} failed: {e}",
                        sidecar.name()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap())
    }

    /// The health monitor's per-tick crash check, factored out so the decision is
    /// testable without waiting a [`HEALTH_INTERVAL`]. Returns `true` when the sidecar's
    /// process died on its own — the monitor then records the reason and self-cancels.
    ///
    /// # Why this runs BEFORE the probe
    ///
    /// The probe it precedes is `health_check`, and `ManifestSidecar::health_check`
    /// presents the plugin's minted `RYU_EXT_TOKEN` via `.bearer_auth`. Against a
    /// sidecar whose process died, the OS port is free and may already be bound by an
    /// unrelated local process — so probing first would *deliver the credential* to that
    /// process every 30 seconds, with no request from anyone and nothing for an attacker
    /// to do but wait. Detecting the exit first and cancelling the monitor is what closes
    /// that lane; the truthful `is_running` behind [`Self::forward_target`] closes the
    /// request-driven one.
    ///
    /// # Why `has_exited()` and not `!is_running()`
    ///
    /// [`crate::sidecar::process::ProcessHandle::stop`] *takes* the child, so after a
    /// deliberate stop — plugin disable, idle scale-to-zero — `has_exited()` is false
    /// while `is_running()` is also false. Only the first distinguishes a crash from a
    /// routine scale-to-zero, and recording the latter as a failure would put a
    /// permanent "crashed" reason on every idle-stopped app.
    ///
    /// # Why the port claim is deliberately NOT released here
    ///
    /// The instinct is "reap ⇒ release", and it is wrong: [`Self::forward_target`] reads
    /// the claim *before* liveness, so dropping the claim downgrades `NotRunning` ("wake
    /// me") to `NotRegistered` ("hard 503, nothing owns this port"). That would
    /// manufacture the unrecoverable dead end on every single crash, and would also
    /// leave the port genuinely free for a squatter. A claim is Core's *reservation*;
    /// nothing about a dead child makes the reservation wrong. Keeping it is also what
    /// preserves recovery: a crashed wake-eligible sidecar gets `NotRunning` → wake →
    /// restart on the next request.
    ///
    /// Nothing here restarts the process directly: an unbounded auto-restart of a
    /// crash-looping child is its own hazard, and the request-driven wake already covers
    /// the case where anyone still wants it.
    ///
    /// # Why the crash teardown hook fires here and nowhere else
    ///
    /// This is the only place in Core that learns a sidecar's child died on its own.
    /// [`Sidecar::stop`] is what releases a live process's state, and a crash never
    /// calls it — so anything `stop` would have dropped stays valid-looking until the
    /// next boot unless it is dropped from here. That is exactly what happened to a
    /// [`crate::sidecar::manifest_sidecar::ManifestSidecar`]'s registered provider: a
    /// `models.json` row holding a loopback `baseUrl` and the plugin's ext token as its
    /// `apiKey`, pointed at the port the crash just freed, and dialed by Pi directly —
    /// past the ext proxy, past the refusal `forward_target` returns for the same
    /// sidecar. [`Sidecar::on_crash_detected`] is the seam that closes it.
    fn note_crash_if_exited(&self, name: &str, sidecar: &Arc<dyn Sidecar>) -> bool {
        if !sidecar.has_exited() {
            return false;
        }
        crate::sidecar::manifest_sidecar::record_crash_reason(
            name,
            "process exited unexpectedly (no stop was requested); the port claim is still \
             held for it, so a wake-eligible sidecar restarts on the next request and any \
             other can be restarted from the sidecar status surface",
        );
        // Give the sidecar the teardown its own `stop()` would have run. A crash runs
        // NOTHING — that is the whole hazard — so any state whose validity ended with
        // the process has to be dropped from here or it survives to the next boot. For
        // a manifest sidecar that state is its registered model provider: a live row in
        // `models.json` carrying `http://127.0.0.1:<port>/v1` plus the plugin's minted
        // ext token as `apiKey`, aimed at a port the dead child has just released. Pi
        // dials that baseUrl DIRECTLY, so nothing else in this file guards it: not the
        // ext proxy's registration gate, not `forward_target`'s refusal below — the
        // credential simply goes to whoever binds the port next. See
        // `ManifestSidecar::on_crash_detected`.
        //
        // Sync and unconditional. The default impl is empty (built-ins register no
        // provider), the manifest impl short-circuits on an atomic for the sidecars
        // that never registered one, and the only work left in the remaining case is a
        // small `models.json` rewrite that logs its own failures — so this cannot
        // meaningfully stall the monitor, and the monitor breaks on the very next line
        // anyway. It is deliberately NOT spawned: a detached task could still be
        // pending while the vacated port is being handed out.
        sidecar.on_crash_detected();
        true
    }

    /// Start (or replace) the background `/health` poll loop for `name`.
    ///
    /// Called by every path that brings a sidecar up — `start_all`, [`Self::start_sidecar`],
    /// [`Self::restart_sidecar`], [`Self::start_dynamic_locked`], [`Self::wake_sidecar`] —
    /// and therefore called **repeatedly for the same name** in normal operation: the
    /// gateway config-push path fires a lazy `start_sidecar` for the classify tier on
    /// every push that selects it, and `server/mod.rs` fires one for `llamacpp-rerank`
    /// on every search. Those repeat starts are otherwise cheap (the sidecar adopts its
    /// own already-running server), so the monitor is the only thing that accumulates.
    ///
    /// # Replacing a monitor must abort the one it displaces
    ///
    /// `HashMap::insert` returns the displaced [`JoinHandle`], and **dropping a tokio
    /// `JoinHandle` does not cancel its task** — it only detaches it. So before this
    /// abort existed, every repeat start leaked one monitor loop that kept polling the
    /// same sidecar's `/health` on [`HEALTH_INTERVAL`] for the life of the process: N
    /// config pushes ⇒ N pollers on one port, N log lines per interval when it is
    /// unhealthy, and no way to ever cancel the extras (the map only held the newest).
    ///
    /// Aborting the displaced handle is safe because no caller wants a name's *previous*
    /// monitor to outlive its replacement, and nothing anywhere reads a monitor handle
    /// for anything but cancellation: the map is only ever `insert`ed here,
    /// `remove`d-and-aborted (stop / restart / uninstall / deregister / idle-reap), or
    /// aborted wholesale in [`Self::stop_all`] — no path awaits a monitor's completion or
    /// inspects its result. [`Self::restart_sidecar`] and the reaper remove-and-abort
    /// before their next start, so they displace nothing and are unaffected either way.
    /// (The task also exits on its own once the name is gone from both sidecar maps —
    /// which is why a leaked monitor for a *deregistered* sidecar self-healed, and one
    /// for a still-registered sidecar never did.)
    fn spawn_health_monitor(self: &Arc<Self>, name: &str) {
        let manager = Arc::clone(self);
        let name = name.to_string();
        let handle = tokio::spawn({
            let name = name.clone();
            async move {
                let mut ticker = tokio::time::interval(HEALTH_INTERVAL);
                ticker.tick().await; // skip immediate first tick
                loop {
                    ticker.tick().await;
                    // A monitored sidecar is either a built-in (in `sidecars`) or a
                    // manifest one (in `dynamic`). Clone the Arc out so no lock guard
                    // is held across the `.await`. Gone from both → stop monitoring.
                    let sidecar = manager
                        .sidecars
                        .get(&name)
                        .map(Arc::clone)
                        .or_else(|| manager.dynamic.read().unwrap().get(&name).map(Arc::clone));
                    let Some(sidecar) = sidecar else {
                        break;
                    };
                    // Crash detection runs BEFORE the probe — see `note_crash_if_exited`
                    // for why that ordering is the security property, not a style choice.
                    if manager.note_crash_if_exited(&name, &sidecar) {
                        break;
                    }
                    match sidecar.health_check().await {
                        HealthStatus::Healthy => {}
                        HealthStatus::Degraded(msg) => {
                            tracing::warn!("{name} health degraded: {msg}");
                        }
                        HealthStatus::Unhealthy(msg) => {
                            tracing::error!("{name} unhealthy: {msg}");
                        }
                    }
                }
            }
        });
        // Take the displaced handle out from under the lock, then abort it (a cheap
        // sync signal that takes no lock of ours, so the order is not load-bearing —
        // but keeping the guard's scope to the map mutation matches every other
        // access here).
        let displaced = self.health_monitors.lock().unwrap().insert(name, handle);
        if let Some(previous) = displaced {
            previous.abort();
        }
    }
}

/// RAII guard from [`SidecarManager::enter_request`]. While it is alive the
/// sidecar's in-flight count is non-zero, so the idle reaper can never scale it to
/// zero mid-request; on drop it decrements the count and refreshes the idle clock.
/// Drop is sync (a mutex, no `.await`), so it is safe to hold across a streaming
/// response's whole lifetime.
pub struct ActivityGuard {
    manager: Arc<SidecarManager>,
    name: String,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut activity = self.manager.activity.lock().unwrap();
        if let Some(st) = activity.get_mut(&self.name) {
            st.in_flight = st.in_flight.saturating_sub(1);
            st.last_activity = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::BoxFuture;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A minimal in-memory [`Sidecar`] for exercising the runtime-registration
    /// (dynamic) path without a real process, download, or network.
    struct FakeSidecar {
        name: String,
        port: Option<u16>,
        running: Arc<AtomicBool>,
        start_calls: Arc<std::sync::atomic::AtomicU32>,
    }

    impl FakeSidecar {
        fn new(name: &str) -> Arc<Self> {
            Arc::new(Self {
                name: name.to_string(),
                port: None,
                running: Arc::new(AtomicBool::new(false)),
                start_calls: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            })
        }

        fn with_port(name: &str, port: u16) -> Arc<Self> {
            Arc::new(Self {
                name: name.to_string(),
                port: Some(port),
                running: Arc::new(AtomicBool::new(false)),
                start_calls: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            })
        }
    }

    impl Sidecar for FakeSidecar {
        fn name(&self) -> &str {
            &self.name
        }
        fn is_required(&self) -> bool {
            false
        }
        fn start(&self) -> BoxFuture<anyhow::Result<()>> {
            let running = self.running.clone();
            let calls = self.start_calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                running.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
        fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
            let running = self.running.clone();
            Box::pin(async move {
                running.store(false, Ordering::SeqCst);
                Ok(())
            })
        }
        fn health_check(&self) -> BoxFuture<HealthStatus> {
            Box::pin(async move { HealthStatus::Healthy })
        }
        fn is_running(&self) -> bool {
            self.running.load(Ordering::SeqCst)
        }
        fn port(&self) -> Option<u16> {
            self.port
        }
    }

    /// register_and_start inserts a manifest sidecar into the dynamic registry,
    /// starts it, and surfaces it in `statuses`; stop_and_deregister tears it down
    /// and removes it — the app ⇄ sidecar bridge lifecycle end to end.
    #[tokio::test]
    async fn dynamic_register_start_status_and_deregister() {
        let mgr = SidecarManager::new_noop();
        let sc = FakeSidecar::new("com.acme.tool/engine");

        mgr.register_and_start(sc.clone()).await.unwrap();
        assert!(sc.is_running(), "sidecar should be running after start");
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 1);

        // It shows up on the shared status surface (`/api/sidecar/status`).
        let statuses = mgr.statuses();
        let entry = statuses
            .iter()
            .find(|s| s.name == "com.acme.tool/engine")
            .expect("dynamic sidecar should appear in statuses");
        assert!(entry.running);

        // Idempotent: re-registering a running sidecar does not restart it.
        mgr.register_and_start(sc.clone()).await.unwrap();
        assert_eq!(
            sc.start_calls.load(Ordering::SeqCst),
            1,
            "already-running sidecar must not be started twice"
        );

        // Teardown removes it from the registry and stops the process.
        mgr.stop_and_deregister("com.acme.tool/engine")
            .await
            .unwrap();
        assert!(
            !sc.is_running(),
            "sidecar should be stopped after deregister"
        );
        assert!(
            mgr.statuses()
                .iter()
                .all(|s| s.name != "com.acme.tool/engine"),
            "deregistered sidecar must be gone from statuses"
        );
    }

    /// A register-only sidecar remains the lifecycle owner while its first start is
    /// pending. A later eager registration for the same name must start that original
    /// object, not replace it and leave two callers able to spawn children for one
    /// declared port (the boot-reconcile versus enable race).
    #[tokio::test]
    async fn eager_registration_does_not_replace_a_registered_sidecar() {
        let mgr = SidecarManager::new_noop();
        let first = FakeSidecar::new("com.acme.race/engine");
        let replacement = FakeSidecar::new("com.acme.race/engine");

        mgr.register(first.clone()).unwrap();
        mgr.register_and_start(replacement.clone()).await.unwrap();

        assert!(
            first.is_running(),
            "the original registration must be started"
        );
        assert!(
            !replacement.is_running(),
            "a duplicate registration must not replace the lifecycle owner"
        );
        assert_eq!(first.start_calls.load(Ordering::SeqCst), 1);
        assert_eq!(replacement.start_calls.load(Ordering::SeqCst), 0);

        mgr.stop_and_deregister("com.acme.race/engine")
            .await
            .unwrap();
    }

    /// A [`Sidecar`] backed by a REAL [`crate::sidecar::process::ProcessHandle`].
    ///
    /// `FakeSidecar` above backs `is_running` with a plain `AtomicBool` and inherits
    /// the trait's `has_exited() == false`, so a defect-1 test written against it
    /// passes identically before and after the liveness fix — it never touches the
    /// layer that changed. Everything below therefore runs a real child.
    struct ChildBackedSidecar {
        name: String,
        port: Option<u16>,
        handle: crate::sidecar::process::ProcessHandle,
    }

    impl ChildBackedSidecar {
        fn new(name: &str, port: Option<u16>) -> Arc<Self> {
            Arc::new(Self {
                name: name.to_string(),
                port,
                handle: crate::sidecar::process::ProcessHandle::new(),
            })
        }
    }

    impl Sidecar for ChildBackedSidecar {
        fn name(&self) -> &str {
            &self.name
        }
        fn is_required(&self) -> bool {
            false
        }
        fn start(&self) -> BoxFuture<anyhow::Result<()>> {
            let handle = self.handle.clone();
            Box::pin(async move {
                // Long-lived on purpose: the tests below choose when it dies.
                handle
                    .start_path_with_args("/bin/sh", &["-c".to_owned(), "sleep 300".to_owned()])
                    .await
            })
        }
        fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
            let handle = self.handle.clone();
            Box::pin(async move { handle.stop().await })
        }
        fn health_check(&self) -> BoxFuture<HealthStatus> {
            Box::pin(async move { HealthStatus::Healthy })
        }
        fn is_running(&self) -> bool {
            self.handle.is_running()
        }
        fn has_exited(&self) -> bool {
            self.handle.has_exited()
        }
        fn pid(&self) -> Option<u32> {
            self.handle.pid()
        }
        fn port(&self) -> Option<u16> {
            self.port
        }
    }

    /// **Defect 1, at the manager layer.** A registered sidecar whose process dies on
    /// its own must stop being dialable and must say so on the status plane.
    ///
    /// Before the fix: `is_running()` read a spawn-time `AtomicBool` that only `stop()`
    /// ever cleared, so `forward_target` returned `Ok(ForwardTarget)` for a process
    /// that no longer existed and the ext proxy stamped `RYU_EXT_TOKEN` onto a request
    /// aimed at whatever local process had since bound the vacated port. The status row
    /// said `running: true, failure_reason: None`.
    ///
    /// The `NotRunning` (not `NotRegistered`) assertion is load-bearing: it pins the
    /// decision to KEEP the port claim on a crash. Releasing it would turn every crash
    /// into the unrecoverable `NotRegistered` hard 503 — the one shape no wake and no
    /// restart can undo, because the name is not in `dynamic` for either to find.
    #[cfg(unix)]
    #[tokio::test]
    async fn crashed_sidecar_is_denied_and_reported() {
        let mgr = SidecarManager::new_noop();
        let port = free_port();
        let name = "com.acme.crash/engine";
        let sc = ChildBackedSidecar::new(name, Some(port));
        mgr.register_and_start(sc.clone()).await.unwrap();

        // Baseline: alive, dialable, no failure reason.
        assert!(sc.is_running());
        assert!(mgr.forward_target(name).is_ok(), "live sidecar is dialable");
        let pid = sc.pid().expect("a spawned child has a pid");

        // Kill it out from under Core — the OOM / `kill -9` case.
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGKILL,
        )
        .expect("SIGKILL the test child");
        eventually("child is reaped", || sc.has_exited()).await;

        // The forwarding gate now refuses, and refuses with the arm that keeps the
        // claim (and therefore keeps the sidecar wake-eligible).
        match mgr.forward_target(name) {
            Err(ForwardDenied::NotRunning { port: p, .. }) => assert_eq!(p, port),
            other => panic!("crashed sidecar must be denied as NotRunning, got {other:?}"),
        }
        assert_eq!(
            mgr.claimed_port(name),
            Some(port),
            "the port claim must survive a crash — releasing it would downgrade \
             NotRunning (wake me) to NotRegistered (hard 503)"
        );

        // The health monitor's per-tick decision records the reason and self-cancels.
        let sidecar: Arc<dyn Sidecar> = sc.clone();
        assert!(
            mgr.note_crash_if_exited(name, &sidecar),
            "the monitor must detect the exit before its next probe — the probe is what \
             presents RYU_EXT_TOKEN to whoever holds the port"
        );

        // …and the status plane says so, instead of `running: true, reason: None`.
        let statuses = mgr.statuses();
        let row = statuses
            .iter()
            .find(|s| s.name == name)
            .expect("status row");
        assert!(!row.running, "a crashed sidecar must not report running");
        assert!(
            row.failure_reason
                .as_deref()
                .is_some_and(|r| r.contains("exited unexpectedly")),
            "crashed sidecar needs a failure_reason, got {:?}",
            row.failure_reason
        );

        mgr.stop_and_deregister(name).await.unwrap();
    }

    /// A deliberate stop is not a crash: `stop()` takes the child, so `has_exited()`
    /// stays false and no failure reason is recorded. This is why the monitor keys on
    /// `has_exited()` rather than `!is_running()` — otherwise every idle scale-to-zero
    /// would brand a healthy app as crashed.
    #[cfg(unix)]
    #[tokio::test]
    async fn idle_stopped_sidecar_is_not_reported_as_crashed() {
        let mgr = SidecarManager::new_noop();
        let name = "com.acme.idle/engine";
        let sc = ChildBackedSidecar::new(name, Some(free_port()));
        mgr.register_and_start(sc.clone()).await.unwrap();
        sc.stop().await.unwrap();

        assert!(!sc.is_running());
        let sidecar: Arc<dyn Sidecar> = sc.clone();
        assert!(
            !mgr.note_crash_if_exited(name, &sidecar),
            "a stopped sidecar must never be recorded as crashed"
        );
        let statuses = mgr.statuses();
        let row = statuses
            .iter()
            .find(|s| s.name == name)
            .expect("status row");
        assert!(row.failure_reason.is_none());

        mgr.stop_and_deregister(name).await.unwrap();
    }

    /// A sidecar whose exit status is ours to set, and that counts the crash-teardown
    /// callbacks it receives. No real child: the property under test is which callback
    /// the monitor's decision fires, and a spawned-then-SIGKILLed process would only
    /// add a race to it.
    struct CrashTeardownSidecar {
        name: String,
        exited: Arc<AtomicBool>,
        teardowns: Arc<std::sync::atomic::AtomicU32>,
    }

    impl CrashTeardownSidecar {
        fn new(name: &str) -> Arc<Self> {
            Arc::new(Self {
                name: name.to_string(),
                exited: Arc::new(AtomicBool::new(false)),
                teardowns: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            })
        }
    }

    impl Sidecar for CrashTeardownSidecar {
        fn name(&self) -> &str {
            &self.name
        }
        fn is_required(&self) -> bool {
            false
        }
        fn start(&self) -> BoxFuture<anyhow::Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn health_check(&self) -> BoxFuture<HealthStatus> {
            Box::pin(async { HealthStatus::Healthy })
        }
        fn is_running(&self) -> bool {
            !self.exited.load(Ordering::SeqCst)
        }
        fn has_exited(&self) -> bool {
            self.exited.load(Ordering::SeqCst)
        }
        fn on_crash_detected(&self) {
            self.teardowns.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// **The credential lane a crash leaves open.** Detecting the exit and writing a
    /// reason is not enough: whatever `stop()` would have released has to be released
    /// here too, because a crash calls `stop()` never. For a
    /// [`crate::sidecar::manifest_sidecar::ManifestSidecar`] that is its registered
    /// model provider — a `models.json` row holding the plugin's minted ext token as
    /// `apiKey` and the loopback port the dead child has just freed as `baseUrl`, which
    /// Pi dials DIRECTLY (never through the ext proxy, so no gate in this file covers
    /// it). Before this hook the row survived until the next Core boot's
    /// `purge_sidecar_providers`, i.e. potentially forever on a long-running node.
    ///
    /// This pins the manager half — that the crash decision invokes the teardown, once,
    /// and only for an actual crash. `manifest_sidecar`'s
    /// `crash_teardown_drops_the_provider_row_and_its_credential` pins the other half:
    /// that the teardown really removes the credential-bearing row.
    #[tokio::test]
    async fn crash_detection_runs_the_sidecars_crash_teardown() {
        let mgr = SidecarManager::new_noop();
        let name = "com.acme.teardown/engine";
        let sc = CrashTeardownSidecar::new(name);
        mgr.register_and_start(sc.clone()).await.unwrap();
        let sidecar: Arc<dyn Sidecar> = sc.clone();

        // A live sidecar releases nothing — its provider row is the truth.
        assert!(!mgr.note_crash_if_exited(name, &sidecar));
        assert_eq!(
            sc.teardowns.load(Ordering::SeqCst),
            0,
            "a running sidecar must keep its registrations"
        );

        // The child dies on its own.
        sc.exited.store(true, Ordering::SeqCst);
        assert!(mgr.note_crash_if_exited(name, &sidecar));
        assert_eq!(
            sc.teardowns.load(Ordering::SeqCst),
            1,
            "the crash decision must run the sidecar's own teardown — recording a reason \
             leaves the dead sidecar's provider row (and the ext token in it) pointed at \
             a port anything on the box may now bind"
        );

        mgr.stop_and_deregister(name).await.unwrap();
    }

    /// `restart_sidecar` only ever consulted the built-in `sidecars` map, so
    /// `POST /api/sidecar/{name}/restart` reported success while doing nothing for every
    /// manifest sidecar — i.e. for every app. It is also the affordance the crashed-but-
    /// registered sidecar from defect 1 recovers through.
    #[tokio::test]
    async fn restart_sidecar_reaches_dynamic_sidecars() {
        let mgr = SidecarManager::new_noop();
        let name = "com.acme.restart/engine";
        let sc = FakeSidecar::new(name);
        mgr.register_and_start(sc.clone()).await.unwrap();
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 1);

        mgr.restart_sidecar(name).await.unwrap();
        assert_eq!(
            sc.start_calls.load(Ordering::SeqCst),
            2,
            "restart must actually restart a manifest sidecar, not silently succeed"
        );
        assert!(sc.is_running());

        // An unknown name stays a harmless no-op, as before.
        mgr.restart_sidecar("nope/missing").await.unwrap();
        mgr.stop_and_deregister(name).await.unwrap();
    }

    /// stop_and_deregister on an unknown name is a harmless no-op (not an error).
    #[tokio::test]
    async fn deregister_unknown_is_noop() {
        let mgr = SidecarManager::new_noop();
        mgr.stop_and_deregister("nope/missing").await.unwrap();
    }

    /// A port no other test in this binary will be handed, and that nothing on the
    /// host currently holds.
    ///
    /// # Why not `bind(("127.0.0.1", 0))` and return the port
    ///
    /// That is what this used to do, and it is a TOCTOU: the listener is dropped
    /// before the caller ever claims the port, so between the two the OS is free to
    /// hand the very same number to a concurrently running test — the squatters in
    /// this module all bind port 0 — which then holds it for the rest of its run. The
    /// caller's `claim_port` bind probe then fails with "already in use", from a test
    /// that never mentions ports. `port_registry_rejects_collision_and_frees_on_deregister`
    /// failed 2 of 6 clean runs that way, and the odds only got worse as callers here
    /// went from 2 to 11.
    ///
    /// The fix has three parts, and each one closes a hole the previous attempt left
    /// open — the intermediate versions are recorded because each looked sufficient:
    ///
    /// * **Allocate below the ephemeral range.** `21000..25000` sits under every
    ///   platform's ephemeral band (49152+ on this machine — `sysctl
    ///   net.inet.ip.portrange.first` — 32768+ on Linux), so the OS never hands one of
    ///   these out to a `bind(…, 0)` elsewhere in the suite, and the squatters stop
    ///   being able to steal a number this handed out.
    /// * **Never bind the port we are about to hand out.** Not obvious, and it was
    ///   worth ~2 failures in 20 runs on its own. Instrumenting a bind-probing version
    ///   to immediately re-bind its own probe port showed the second bind failing with
    ///   `EADDRINUSE` — same process, microseconds later, with no listener anywhere
    ///   (`lsof -iTCP:21000-25000` stayed empty across 2000 samples). This suite forks
    ///   children (`ChildBackedSidecar` spawns `/bin/sh -c "sleep 300"`), and a fork
    ///   that lands while a probe listener is open copies that descriptor into the
    ///   child, which holds the port until its `exec` closes it: invisible to `lsof`,
    ///   sub-millisecond, and on the exact port just promised to the caller — whose
    ///   `claim_port` bind then fails. A standalone bind/rebind loop with no forks
    ///   never reproduced it, which is what pointed at the fork. So the "is anything
    ///   really there" check is a **connect**: it never occupies the port, and a
    ///   refused connection is the pass condition.
    /// * **Reserve through a shadow port, so the exclusion is kernel-enforced across
    ///   PROCESSES.** Several agent jobs share this working tree, so two `cargo test`
    ///   runs at once are routine, and two processes are two independent counters over
    ///   one host's ports. Per-process lanes only made a tie less likely (still ~2 in
    ///   40 runs, because same-lane processes run the identical suite in near
    ///   lockstep). Instead, handing out `P` requires first binding `P + 20000` and
    ///   holding it for the life of the process: every test process follows the same
    ///   protocol, so the kernel's own "one binder per port" rule becomes the
    ///   allocator's mutual exclusion, for threads and processes alike. Binding the
    ///   *shadow* is safe where binding `P` was not — nobody ever claims a shadow port,
    ///   so a descriptor leaked into a forked child is harmless.
    ///
    /// Tests that want a port to *stay* taken must keep binding port 0 themselves and
    /// hold the listener — see `port_registry_bind_probe_rejects_bound_port`, which is
    /// the pattern this helper deliberately does NOT try to provide.
    fn free_port() -> u16 {
        const BASE: u16 = 21_000;
        const SPAN: u16 = 4_000;
        /// Reservations live one band above the ports themselves: `21000..25000` is
        /// handed out, `41000..45000` is only ever bound by this helper. Still under
        /// the ephemeral floor.
        const SHADOW_OFFSET: u16 = 20_000;
        static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
        static START: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
        // The reservations, held open until the process exits. Never read — the
        // listeners exist so the kernel keeps refusing the shadow port to anyone else.
        static HELD: Mutex<Vec<std::net::TcpListener>> = Mutex::new(Vec::new());

        // Start somewhere unpredictable so concurrent runs do not walk the band in
        // lockstep and spend their first draws losing races. Mixed with the clock
        // because pids are handed out sequentially: two processes started seconds apart
        // get adjacent pids, i.e. adjacent starts, which is worse than random.
        let start = *START.get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| u64::from(d.subsec_nanos()))
                .unwrap_or_default();
            let mixed = u64::from(std::process::id()) ^ (nanos << 13);
            ((mixed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 47) as u16) % SPAN
        });

        for _ in 0..SPAN {
            let step = NEXT.fetch_add(1, Ordering::SeqCst);
            let port = BASE + (start.wrapping_add(step) % SPAN);
            // Lost the reservation to another test process (or another thread here):
            // that port belongs to whoever holds the shadow, so move on.
            let Ok(reservation) = std::net::TcpListener::bind(("127.0.0.1", port + SHADOW_OFFSET))
            else {
                continue;
            };
            HELD.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(reservation);
            // Reserved — but something outside the suite (a stray dev server) could
            // still be serving on the real port. Ask by connecting, never by binding.
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(50)).is_err() {
                return port;
            }
        }
        panic!("no free port in {BASE}..{} for this test", BASE + SPAN);
    }

    /// The port registry rejects a second sidecar declaring a port already claimed
    /// by a live one, and frees it again on deregister.
    #[tokio::test]
    async fn port_registry_rejects_collision_and_frees_on_deregister() {
        let mgr = SidecarManager::new_noop();
        let port = free_port();

        let a = FakeSidecar::with_port("plug.a/svc", port);
        mgr.register_and_start(a.clone()).await.unwrap();
        assert!(a.is_running());

        // A different sidecar claiming the same port is refused.
        let b = FakeSidecar::with_port("plug.b/svc", port);
        let err = mgr.register_and_start(b.clone()).await.unwrap_err();
        assert!(
            err.to_string().contains("already claimed"),
            "unexpected error: {err}"
        );
        assert!(!b.is_running(), "collided sidecar must not have started");

        // Freeing the first releases the claim so the port is reusable.
        mgr.stop_and_deregister("plug.a/svc").await.unwrap();
        let c = FakeSidecar::with_port("plug.c/svc", port);
        mgr.register_and_start(c.clone()).await.unwrap();
        assert!(c.is_running(), "port should be reusable after deregister");
    }

    /// The bind-probe rejects a port currently bound by another (non-sidecar)
    /// process — the mechanism that catches a plugin colliding with a built-in.
    #[tokio::test]
    async fn port_registry_bind_probe_rejects_bound_port() {
        let mgr = SidecarManager::new_noop();
        // Hold a real listener so the port is genuinely bound on the host.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        let sc = FakeSidecar::with_port("plug.x/svc", port);
        let err = mgr.register_and_start(sc.clone()).await.unwrap_err();
        assert!(
            err.to_string().contains("already in use"),
            "unexpected error: {err}"
        );
        assert!(!sc.is_running());
    }

    // ── The ext-proxy registration gate (forward_target) ───────────────────────

    /// The precondition the whole gate rests on, pinned — including the
    /// counter-intuitive lazy half. A sidecar whose `claim_port` was refused is absent
    /// from `dynamic`, absent from `lazy_registered`, and therefore **not**
    /// wake-eligible: `lazy_registered` is populated only AFTER a successful claim, so
    /// a LAZY sidecar that lost its port reads exactly like an eager one and used to
    /// fall through the proxy's `is_wake_eligible` check into a blind forward. That is
    /// why `is_wake_eligible` could never have been the gate.
    #[tokio::test]
    async fn failed_port_claim_leaves_the_sidecar_unregistered_and_not_wake_eligible() {
        let mgr = SidecarManager::new_noop();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = squatter.local_addr().unwrap().port();

        // Eager and lazy alike.
        let eager = FakeSidecar::with_port("gate.claimfail.eager/svc", port);
        assert!(mgr.register_and_start(eager).await.is_err());
        let lazy = FakeSidecar::with_port("gate.claimfail.lazy/svc", port);
        assert!(mgr.register(lazy).is_err());

        for name in ["gate.claimfail.eager/svc", "gate.claimfail.lazy/svc"] {
            assert!(
                mgr.dynamic.read().unwrap().get(name).is_none(),
                "{name} must not be in the dynamic registry"
            );
            assert!(
                !mgr.lazy_registered.read().unwrap().contains(name),
                "{name} must not be marked lazy-registered"
            );
            assert!(
                !mgr.is_wake_eligible(name),
                "{name}: a failed claim is NOT wake-eligible, even when lazy"
            );
            assert!(matches!(
                mgr.forward_target(name),
                Err(ForwardDenied::NotRegistered { .. })
            ));
        }
    }

    /// The security assertion, stated as "the port is never dialed": a squatted port
    /// belongs to somebody else, and the manager must hand out no way to reach it.
    /// Asserted by counting ACCEPTS on the squatting listener — a test that only
    /// checked the error would still pass if the request were forwarded and the
    /// response discarded.
    #[tokio::test]
    async fn unregistered_sidecar_is_refused_and_the_port_is_never_dialed() {
        use std::sync::atomic::AtomicU32;

        let mgr = SidecarManager::new_noop();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = squatter.local_addr().unwrap().port();
        let accepts = Arc::new(AtomicU32::new(0));
        {
            let accepts = Arc::clone(&accepts);
            std::thread::spawn(move || {
                for stream in squatter.incoming() {
                    if stream.is_err() {
                        break;
                    }
                    accepts.fetch_add(1, Ordering::SeqCst);
                }
            });
        }

        let sc = FakeSidecar::with_port("gate.squatted/svc", port);
        assert!(mgr.register_and_start(sc).await.is_err());

        // No ForwardTarget can be minted, so `forward_to_sidecar` cannot be called at
        // all: the type is the gate, not a runtime check a caller might forget.
        let denied = mgr.forward_target("gate.squatted/svc").unwrap_err();
        assert!(matches!(denied, ForwardDenied::NotRegistered { .. }));
        // The refusal is TERMINAL — Core does not reclaim the port, because it cannot
        // prove whoever holds it is a process it spawned — so the body has to carry
        // everything a human needs to act. `declared_port` is `None` on this path (a
        // refused claim leaves no claim entry), which is why the port has to come from
        // the reason recorded at the refusal rather than from the variant.
        let reason = denied.reason();
        assert!(reason.contains("not registered"), "{reason}");
        assert!(
            reason.contains(&port.to_string()),
            "the refusal must name the port to free: {reason}"
        );
        assert!(
            reason.contains("free port") && reason.contains("re-enable"),
            "the refusal must state the remedy, which is a human freeing the port: {reason}"
        );
        // …and the durable half on `/api/sidecar/status` says the same thing.
        assert!(
            mgr.statuses().iter().any(|s| s.name == "gate.squatted/svc"
                && !s.running
                && s.failure_reason
                    .as_deref()
                    .is_some_and(|r| r.contains(&port.to_string()))),
            "the status row must carry the same port-naming reason"
        );

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "the squatting process must never receive a connection"
        );
    }

    /// A lazy sidecar's legitimate resting state — registered, claim held, process
    /// down — is the ADMIT-then-wake arm, not a refusal. This is the regression guard
    /// for the gate: if a future tightening collapses `NotRunning` into `NotRegistered`,
    /// lazy wake dies silently and every lazy app 503s forever.
    #[tokio::test]
    async fn lazy_registered_sidecar_is_not_running_but_admitted_and_wakes() {
        let mgr = SidecarManager::new_noop();
        let port = free_port();
        let sc = FakeSidecar::with_port("gate.lazywake/svc", port);
        mgr.register(sc.clone()).unwrap();

        assert!(!sc.is_running(), "register() must not start the process");
        assert!(mgr.is_wake_eligible("gate.lazywake/svc"));
        match mgr.forward_target("gate.lazywake/svc") {
            Err(ForwardDenied::NotRunning { name, port: p }) => {
                assert_eq!(name, "gate.lazywake/svc");
                assert_eq!(p, port, "the CLAIMED port is reported, not a manifest one");
            }
            other => {
                panic!("a registered, not-yet-woken lazy sidecar must be NotRunning: {other:?}")
            }
        }

        // Waking it makes it dialable, at the same claimed port.
        mgr.wake_sidecar("gate.lazywake/svc").await.unwrap();
        assert!(sc.is_running(), "wake must start the lazy sidecar");
        assert_eq!(
            mgr.forward_target("gate.lazywake/svc").unwrap().port(),
            port
        );
    }

    /// An EAGER sidecar that registered (claim held) but whose process is down must be
    /// refused, not forwarded. Today's behaviour before the gate was to dial the
    /// declared port regardless of who was listening on it.
    #[tokio::test]
    async fn registered_but_dead_sidecar_is_refused_not_forwarded() {
        let mgr = SidecarManager::new_noop();
        let port = free_port();
        let sc = FakeSidecar::with_port("gate.dead/svc", port);
        mgr.register_and_start(sc.clone()).await.unwrap();
        assert!(mgr.forward_target("gate.dead/svc").is_ok());

        sc.stop().await.unwrap();
        let denied = mgr.forward_target("gate.dead/svc").unwrap_err();
        assert!(matches!(denied, ForwardDenied::NotRunning { .. }));
        assert!(
            !mgr.is_wake_eligible("gate.dead/svc"),
            "an eager sidecar is not wake-eligible, so the proxy 503s rather than waking"
        );
    }

    /// **The scale-from-zero regression guard.** An idle-stopped sidecar is stopped by
    /// the reaper via a bare `sidecar.stop()` — it stays in `dynamic` and KEEPS its port
    /// claim (only `stop_and_deregister` calls `release_port`). That is precisely what
    /// makes the gate compatible with idle-stop: the claim is what reserves the port
    /// across the sleep, so the sidecar reads as `NotRunning` (admit-then-wake) rather
    /// than `NotRegistered` (refuse). If a future change ever released the claim on
    /// idle-stop, every scaled-to-zero app would 503 forever with no wake attempt — a
    /// silent failure this test is here to make loud.
    #[tokio::test]
    async fn idle_stopped_sidecar_keeps_its_claim_and_still_wakes() {
        let mut cfg = HashMap::new();
        cfg.insert("gate.idle/svc".to_string(), Duration::from_secs(60));
        let mgr = SidecarManager::new_noop_with_idle(cfg);
        let port = free_port();
        let sc = FakeSidecar::with_port("gate.idle/svc", port);
        mgr.register_and_start(sc.clone()).await.unwrap();
        assert_eq!(mgr.forward_target("gate.idle/svc").unwrap().port(), port);

        // Exactly what the idle reaper does: stop the process, touch nothing else.
        sc.stop().await.unwrap();

        assert!(
            mgr.is_wake_eligible("gate.idle/svc"),
            "idle-configured ⇒ wake-eligible, so the proxy takes the wake arm"
        );
        match mgr.forward_target("gate.idle/svc") {
            Err(ForwardDenied::NotRunning { port: p, .. }) => assert_eq!(p, port),
            other => panic!("a scaled-to-zero sidecar must stay registered: {other:?}"),
        }
        assert_eq!(
            mgr.claimed_port("gate.idle/svc"),
            Some(port),
            "the claim must survive the sleep — it is what reserves the port for the wake"
        );

        mgr.wake_sidecar("gate.idle/svc").await.unwrap();
        assert_eq!(mgr.forward_target("gate.idle/svc").unwrap().port(), port);
    }

    /// The collapse of the two facts, pinned: `forward_target` returns the port the
    /// manager CLAIMED, which is the only port a live child of ours can be on. This is
    /// the test that fails if someone reintroduces `profile::port(spec.port)` at a hop.
    #[tokio::test]
    async fn forward_target_yields_the_claimed_port() {
        let mgr = SidecarManager::new_noop();
        let claimed = free_port();
        let sc = FakeSidecar::with_port("gate.claimed/svc", claimed);
        mgr.register_and_start(sc).await.unwrap();

        assert_eq!(mgr.claimed_port("gate.claimed/svc"), Some(claimed));
        assert_eq!(
            mgr.forward_target("gate.claimed/svc").unwrap().port(),
            claimed
        );
        // And an unknown name yields nothing at all — no port to dial, by construction.
        assert!(mgr.claimed_port("plug.nobody/svc").is_none());
        assert!(mgr.forward_target("plug.nobody/svc").is_err());
    }

    #[tokio::test]
    async fn sidecar_base_url_resolves_by_plugin_and_local_name() {
        let mgr = SidecarManager::new_noop();
        let port = free_port();
        let sc = FakeSidecar::with_port("com.acme.bridge/backend", port);
        mgr.register_and_start(sc).await.unwrap();

        assert_eq!(
            mgr.sidecar_base_url("com.acme.bridge", "backend").unwrap(),
            format!("http://127.0.0.1:{port}")
        );
        assert!(mgr.sidecar_base_url("com.acme.bridge", "missing").is_err());

        mgr.stop_and_deregister("com.acme.bridge/backend")
            .await
            .unwrap();
        assert!(mgr.sidecar_base_url("com.acme.bridge", "backend").is_err());
    }

    /// The diagnosability half. A refused claim used to leave the sidecar ABSENT from
    /// `statuses()` — not "failed", missing — so the app looked broken with no reason
    /// on any surface. It must now appear with the bind-probe error verbatim, and the
    /// record must clear when the app is disabled.
    #[tokio::test]
    async fn failed_registration_surfaces_in_sidecar_status_with_the_port() {
        let mgr = SidecarManager::new_noop();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = squatter.local_addr().unwrap().port();
        let name = format!("plug.diag{port}/svc");

        let sc = FakeSidecar::with_port(&name, port);
        assert!(mgr.register_and_start(sc).await.is_err());

        let statuses = mgr.statuses();
        let entry = statuses
            .iter()
            .find(|s| s.name == name)
            .expect("a failed-to-register sidecar must still appear in statuses");
        assert!(!entry.running);
        assert!(!entry.lazy, "a failed claim will never wake — not 'lazy'");
        let reason = entry
            .failure_reason
            .as_deref()
            .expect("failure_reason explains why it is not running");
        assert!(
            reason.contains(&port.to_string()) && reason.contains("already in use"),
            "the reason must name the port and the bind probe: {reason}"
        );

        // Disabling the app clears the record rather than leaving a stale reason.
        mgr.stop_and_deregister(&name).await.unwrap();
        assert!(mgr.statuses().iter().all(|s| s.name != name));
    }

    // ── Idle-stop (scale-to-zero) ─────────────────────────────────────────────

    /// The `name=seconds` config parser: valid pairs land; blanks, zero, missing
    /// value, unparseable seconds, and empty names are all skipped (never
    /// instant-stop). An empty/garbage string ⇒ feature off (empty map).
    #[test]
    fn parse_idle_config_keeps_valid_skips_junk() {
        let cfg = parse_idle_config("llamacpp-rerank=900, research=1800 ,bad,zero=0,x=abc,=5, ");
        assert_eq!(cfg.len(), 2, "only the two valid entries survive: {cfg:?}");
        assert_eq!(cfg["llamacpp-rerank"], Duration::from_secs(900));
        assert_eq!(cfg["research"], Duration::from_secs(1800));
        assert!(parse_idle_config("").is_empty(), "empty ⇒ feature off");
        assert!(parse_idle_config("   ").is_empty());
    }

    /// Default-off: with no idle config nothing is ever a reaper target, even for a
    /// sidecar whose activity clock is ancient. This is the invariant that keeps
    /// behaviour unchanged unless the operator opts in.
    #[test]
    fn idle_stop_default_off_is_noop() {
        let mgr = SidecarManager::new_noop(); // empty idle_config
        mgr.activity.lock().unwrap().insert(
            "anything".to_string(),
            ActivityState {
                last_activity: Instant::now() - Duration::from_secs(9999),
                in_flight: 0,
            },
        );
        assert!(mgr.idle_stop_due(Instant::now()).is_empty());
    }

    /// The reaper's decision: not due when never touched, not due when fresh, due
    /// when the idle clock expires, and pinned alive whenever a request is in
    /// flight (the never-stop-mid-request guarantee).
    #[test]
    fn idle_stop_due_respects_clock_and_in_flight() {
        let mut cfg = HashMap::new();
        cfg.insert("rerank".to_string(), Duration::from_secs(60));
        let mgr = SidecarManager::new_noop_with_idle(cfg);

        // Never touched → no activity entry → not eligible.
        assert!(mgr.idle_stop_due(Instant::now()).is_empty());

        // Fresh touch → not due.
        mgr.touch_activity("rerank");
        assert!(mgr.idle_stop_due(Instant::now()).is_empty());

        // Force-expire the idle clock → due.
        mgr.activity
            .lock()
            .unwrap()
            .get_mut("rerank")
            .unwrap()
            .last_activity = Instant::now() - Duration::from_secs(120);
        assert_eq!(
            mgr.idle_stop_due(Instant::now()),
            vec!["rerank".to_string()]
        );

        // An in-flight request pins it alive even with an expired clock.
        let guard = mgr.enter_request("rerank");
        mgr.activity
            .lock()
            .unwrap()
            .get_mut("rerank")
            .unwrap()
            .last_activity = Instant::now() - Duration::from_secs(120);
        assert!(
            mgr.idle_stop_due(Instant::now()).is_empty(),
            "an in-flight request must never be idle-stopped"
        );

        // Dropping the guard clears in-flight and refreshes the clock → not due.
        drop(guard);
        assert!(mgr.idle_stop_due(Instant::now()).is_empty());
    }

    /// Wake-on-demand restarts a stopped (but still-registered) manifest sidecar —
    /// the scale-from-zero half — and seeds its activity clock. Idempotent when the
    /// sidecar is already running (a plain touch, no second start).
    #[tokio::test]
    async fn wake_sidecar_restarts_stopped_and_is_idempotent() {
        let mut cfg = HashMap::new();
        cfg.insert("com.acme.tool/engine".to_string(), Duration::from_secs(60));
        let mgr = SidecarManager::new_noop_with_idle(cfg);
        let sc = FakeSidecar::new("com.acme.tool/engine");
        mgr.register_and_start(sc.clone()).await.unwrap();
        assert!(sc.is_running());
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 1);

        // Simulate an idle-stop: process stopped, still registered in `dynamic`.
        sc.stop().await.unwrap();
        assert!(!sc.is_running());

        // Wake restarts the process (returns true = it cold-started) and seeds the
        // activity clock.
        assert!(
            mgr.wake_sidecar("com.acme.tool/engine").await.unwrap(),
            "wake of a stopped sidecar reports it cold-started"
        );
        assert!(sc.is_running());
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 2);
        assert!(mgr
            .activity
            .lock()
            .unwrap()
            .contains_key("com.acme.tool/engine"));

        // Already running → no extra start, just a touch (returns false).
        assert!(
            !mgr.wake_sidecar("com.acme.tool/engine").await.unwrap(),
            "wake of a running sidecar reports it was already warm"
        );
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 2);

        // Unknown sidecar → error, not a panic.
        assert!(mgr.wake_sidecar("nope").await.is_err());
    }

    /// register (register-only) claims the port + surfaces the sidecar in `statuses`
    /// as NOT running and flagged lazy, without starting the process; a subsequent
    /// wake starts it exactly once. This is the lazy-activation split.
    #[tokio::test]
    async fn register_only_then_wake_starts_once() {
        let mgr = SidecarManager::new_noop();
        let sc = FakeSidecar::new("com.acme.tool/engine");

        // Register-only: no start.
        mgr.register(sc.clone()).unwrap();
        assert!(!sc.is_running(), "register must not start the process");
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 0);

        // It appears in status as stopped + lazy (scale-to-zero, not crashed).
        let entry = mgr
            .statuses()
            .into_iter()
            .find(|s| s.name == "com.acme.tool/engine")
            .expect("lazy sidecar appears in statuses");
        assert!(!entry.running);
        assert!(entry.lazy, "register-only sidecar is flagged lazy");

        // It is wake-eligible purely by being lazy-registered.
        assert!(mgr.is_wake_eligible("com.acme.tool/engine"));

        // First wake starts it exactly once; a second wake is a no-op.
        assert!(mgr.wake_sidecar("com.acme.tool/engine").await.unwrap());
        assert!(sc.is_running());
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 1);
        assert!(!mgr.wake_sidecar("com.acme.tool/engine").await.unwrap());
        assert_eq!(sc.start_calls.load(Ordering::SeqCst), 1);

        // Still flagged lazy while running (so a later reap reads correctly).
        let entry = mgr
            .statuses()
            .into_iter()
            .find(|s| s.name == "com.acme.tool/engine")
            .unwrap();
        assert!(entry.running && entry.lazy);
    }

    /// Two tasks racing `wake_sidecar` on the same stopped sidecar must start it
    /// EXACTLY once — the per-name start lock closes the is_running/start race.
    #[tokio::test]
    async fn concurrent_wake_starts_exactly_once() {
        let mgr = SidecarManager::new_noop();
        let sc = FakeSidecar::new("com.acme.tool/engine");
        mgr.register(sc.clone()).unwrap();

        // Fire many concurrent wakes; exactly one should observe !is_running and start.
        let mut handles = Vec::new();
        for _ in 0..16 {
            let mgr = Arc::clone(&mgr);
            handles.push(tokio::spawn(async move {
                mgr.wake_sidecar("com.acme.tool/engine").await.unwrap()
            }));
        }
        let mut cold_starts = 0;
        for h in handles {
            if h.await.unwrap() {
                cold_starts += 1;
            }
        }
        assert_eq!(cold_starts, 1, "exactly one waker cold-started the sidecar");
        assert_eq!(
            sc.start_calls.load(Ordering::SeqCst),
            1,
            "the child process was started exactly once"
        );
    }

    /// Poll `cond` on the runtime until it holds, so an aborted task's cancellation
    /// has a chance to be processed. Bounded, and it panics with `what` on timeout so a
    /// regression reads as a failed assertion instead of a hung test.
    async fn eventually(what: &str, cond: impl Fn() -> bool) {
        for _ in 0..500 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("timed out waiting for: {what}");
    }

    /// A repeat start must not leave a second health monitor behind.
    ///
    /// Every start path funnels into the same `spawn_health_monitor`, so this asserts
    /// the shared helper rather than one caller: `start_sidecar` (the path the gateway
    /// config-push and the per-search rerank wake use) needs an entry in the built-in
    /// `sidecars` map plus `setup.is_installed`, neither of which a `new_noop` manager
    /// can have, while `wake_sidecar` reaches the same helper with a `FakeSidecar`.
    /// Before the abort-on-displace fix, the second start silently detached the first
    /// monitor: it kept polling `/health` forever and the map had no handle for it.
    #[tokio::test]
    async fn a_repeat_start_replaces_the_health_monitor_instead_of_leaking_it() {
        let mgr = SidecarManager::new_noop();
        let sc = FakeSidecar::new("com.acme.tool/engine");
        mgr.register(sc.clone()).unwrap();

        assert!(mgr.wake_sidecar("com.acme.tool/engine").await.unwrap());
        // Take an abort handle (not the JoinHandle — removing it would defeat the
        // displacement this test is about) so the first monitor's fate is observable.
        let first = mgr
            .health_monitors
            .lock()
            .unwrap()
            .get("com.acme.tool/engine")
            .expect("a started sidecar has a health monitor")
            .abort_handle();
        assert!(
            !first.is_finished(),
            "the first monitor must be live before the repeat start"
        );

        // A repeat start: exactly what a second config push / second search does.
        sc.stop().await.unwrap();
        assert!(mgr.wake_sidecar("com.acme.tool/engine").await.unwrap());

        assert_eq!(
            mgr.health_monitors.lock().unwrap().len(),
            1,
            "one monitor per name — the map is keyed by name, so a leak is invisible here"
        );
        eventually("the displaced health monitor to be cancelled", || {
            first.is_finished()
        })
        .await;

        // And the monitor that survived is the new one, still cancellable through the
        // normal teardown path.
        mgr.stop_and_deregister("com.acme.tool/engine")
            .await
            .unwrap();
        assert!(mgr.health_monitors.lock().unwrap().is_empty());
    }

    /// A per-name idle override (a manifest sidecar's `idle_stop_secs`, applied at
    /// enable) drives the reaper even when the env seed is empty — the reaper is no
    /// longer gated on construction-time config.
    #[test]
    fn idle_override_makes_a_sidecar_reapable_without_env_seed() {
        let mgr = SidecarManager::new_noop(); // empty env idle_config
                                              // No override yet + no env config ⇒ nothing is ever due.
        mgr.touch_activity("com.acme.tool/engine");
        mgr.activity
            .lock()
            .unwrap()
            .get_mut("com.acme.tool/engine")
            .unwrap()
            .last_activity = Instant::now() - Duration::from_secs(120);
        assert!(
            mgr.idle_stop_due(Instant::now()).is_empty(),
            "no idle config anywhere ⇒ not reapable"
        );

        // Apply a 60s override; now the expired sidecar is due.
        mgr.set_idle_override("com.acme.tool/engine", 60);
        assert!(mgr.is_wake_eligible("com.acme.tool/engine"));
        assert_eq!(
            mgr.idle_stop_due(Instant::now()),
            vec!["com.acme.tool/engine".to_string()]
        );

        // A zero override is ignored (never instant-stop).
        let mgr2 = SidecarManager::new_noop();
        mgr2.set_idle_override("x", 0);
        assert!(!mgr2.is_wake_eligible("x"));
    }
}
