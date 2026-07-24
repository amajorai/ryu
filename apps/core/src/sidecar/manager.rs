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
    /// provisions its venv). Idempotent: if the same name is already registered and
    /// running, it is a no-op (so the boot pass and a later enable don't double-spawn).
    pub async fn register_and_start(
        self: &Arc<Self>,
        sidecar: Arc<dyn Sidecar>,
    ) -> anyhow::Result<()> {
        let name = sidecar.name().to_string();
        // Register (claim port + insert). Idempotent: already-running → no-op.
        if self.register_inner(&sidecar, false)? {
            return Ok(());
        }
        // Start + monitor, serialized by the per-name start lock so a concurrent
        // enable / first-proxy-wake of the same name cannot double-start the child.
        self.start_dynamic_locked(&name).await
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
    /// mark. Returns `Ok(true)` when the sidecar was already registered AND running
    /// (the caller short-circuits — nothing to start). Never starts the process.
    fn register_inner(&self, sidecar: &Arc<dyn Sidecar>, lazy: bool) -> anyhow::Result<bool> {
        let name = sidecar.name().to_string();
        // Idempotency: already registered and running → no-op (port claim already held).
        if let Some(existing) = self.dynamic.read().unwrap().get(&name) {
            if existing.is_running() {
                return Ok(true);
            }
        }
        // Port registry: claim the declared port BEFORE inserting, so a collision
        // with a built-in (already bound) or another plugin fails fast. Idempotent
        // for the same owner, so a re-register keeps the claim.
        if let Some(port) = sidecar.port() {
            self.claim_port(port, &name)?;
        }
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
        if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
            handle.abort();
        }
        let sidecar = self.dynamic.write().unwrap().remove(name);
        // Release the port claim so the port frees for a re-enable or another plugin.
        self.release_port(name);
        // Drop the idle/lazy/start-lock bookkeeping so a re-enable starts clean and
        // a stale idle clock can't fire against a name that no longer exists.
        self.lazy_registered.write().unwrap().remove(name);
        self.idle_overrides.lock().unwrap().remove(name);
        self.start_locks.lock().unwrap().remove(name);
        self.activity.lock().unwrap().remove(name);
        if let Some(sc) = sidecar {
            sc.stop().await?;
        }
        Ok(())
    }

    /// Stop and restart a single sidecar by name.
    pub async fn restart_sidecar(self: &Arc<Self>, name: &str) -> anyhow::Result<()> {
        if let Some(sidecar) = self.sidecars.get(name) {
            if let Some(handle) = self.health_monitors.lock().unwrap().remove(name) {
                handle.abort();
            }
            sidecar.stop().await?;
            sidecar.start().await?;
            self.spawn_health_monitor(name);
        }
        Ok(())
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
        self.health_monitors.lock().unwrap().insert(name, handle);
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

    /// stop_and_deregister on an unknown name is a harmless no-op (not an error).
    #[tokio::test]
    async fn deregister_unknown_is_noop() {
        let mgr = SidecarManager::new_noop();
        mgr.stop_and_deregister("nope/missing").await.unwrap();
    }

    /// Bind a free ephemeral port, then reserve it back for a deterministic
    /// "already in use" target the OS won't hand out concurrently.
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
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
