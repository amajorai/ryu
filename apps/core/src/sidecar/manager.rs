use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::sidecar::active_engine::{is_local_engine, ActiveEngineStore};
use crate::sidecar::resources::{self, ResourceSample};
use crate::sidecar::{onboarding::SetupManager, HealthStatus, Sidecar, SidecarStatus};

const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const MAX_REQUIRED_RETRIES: u32 = 3;
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
        })
    }

    /// Create an empty manager with no sidecars for use in unit tests.
    #[cfg(test)]
    pub fn new_noop() -> Arc<Self> {
        Arc::new(Self {
            sidecars: HashMap::new(),
            dynamic: RwLock::new(HashMap::new()),
            port_claims: Mutex::new(HashMap::new()),
            startup_order: Vec::new(),
            health_monitors: Mutex::new(HashMap::new()),
            setup: Arc::new(crate::sidecar::onboarding::SetupManager::new()),
            active_engine: tokio::sync::Mutex::new(None),
            resources: Mutex::new(HashMap::new()),
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
        // Idempotency: already registered and running → no-op (its port claim, if
        // any, is already held from the first start).
        if let Some(existing) = self.dynamic.read().unwrap().get(&name) {
            if existing.is_running() {
                return Ok(());
            }
        }
        // Port registry: claim the declared port BEFORE starting, so a collision
        // with a built-in (already bound) or another plugin fails fast with a clear
        // error instead of a confusing bind failure inside the child.
        if let Some(port) = sidecar.port() {
            self.claim_port(port, &name)?;
        }
        // Insert (replacing any dead prior instance), then start + monitor.
        self.dynamic
            .write()
            .unwrap()
            .insert(name.clone(), Arc::clone(&sidecar));
        if let Err(e) = sidecar.start().await {
            // Start failed: release the port claim so a later retry / different
            // plugin can use it. Leave it registered so `statuses` shows it as
            // not-running rather than vanishing; the caller logs the error.
            self.release_port(&name);
            return Err(e);
        }
        self.spawn_health_monitor(&name);
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

    pub fn statuses(&self) -> Vec<SidecarStatus> {
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
                    let sidecar = manager.sidecars.get(&name).map(Arc::clone).or_else(|| {
                        manager.dynamic.read().unwrap().get(&name).map(Arc::clone)
                    });
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
        assert!(!sc.is_running(), "sidecar should be stopped after deregister");
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
}
