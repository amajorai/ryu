use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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
                let named_pids: Vec<(String, u32)> = manager
                    .sidecars
                    .iter()
                    .filter_map(|(name, sc)| sc.pid().map(|pid| (name.clone(), pid)))
                    .collect();
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
                    let Some(sidecar) = manager.sidecars.get(&name) else {
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
