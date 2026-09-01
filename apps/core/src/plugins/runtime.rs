//! Runtime coordination for manifest-backed plugins.
//!
//! The lifecycle store answers whether a plugin is enabled. This module answers
//! whether its in-memory runtime generation may still do work. A generation is
//! activated under an exclusive write lease; hook/tool work takes a read lease.
//! Deactivation therefore waits for already-running work, blocks new work while
//! registrations are removed, and leaves the plugin inactive before the next
//! activation gets a fresh generation.
//!
//! This is deliberately a coordination primitive, not another plugin registry.
//! It does not make mandatory Core invariants unloadable and it does not replace
//! the existing per-subsystem unregister functions.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

#[derive(Debug, Clone, Copy)]
struct RuntimeState {
    active: bool,
    generation: u64,
}

struct PluginSlot {
    next_generation: AtomicU64,
    state: Arc<RwLock<RuntimeState>>,
}

/// A monotonic identity for one activation of one plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeGeneration {
    plugin_id: String,
    number: u64,
}

impl RuntimeGeneration {
    /// The manifest id that owns this generation.
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// The generation number. Numbers never repeat for one plugin runtime.
    pub fn number(&self) -> u64 {
        self.number
    }
}

/// A cloneable reference used by asynchronous plugin-owned callbacks. The
/// callback can acquire a read lease for exactly the generation that created
/// it; after disable/re-enable, the old generation is refused.
#[derive(Clone)]
pub struct RuntimeGenerationBinding {
    runtime: PluginRuntime,
    generation: RuntimeGeneration,
}

impl RuntimeGenerationBinding {
    /// Bind a generation to the coordinator that owns it.
    pub fn new(runtime: PluginRuntime, generation: RuntimeGeneration) -> Self {
        Self {
            runtime,
            generation,
        }
    }

    /// The generation represented by this binding.
    pub fn generation(&self) -> &RuntimeGeneration {
        &self.generation
    }

    /// Acquire work permission only if this exact generation is still active.
    pub async fn acquire(&self) -> Option<PluginWorkLease> {
        self.runtime.acquire_generation(&self.generation).await
    }
}

/// Exclusive activation lease. Registrations are invisible to new work until
/// [`Self::commit`] is called, so an early return cannot publish a half-built
/// plugin generation.
pub struct PluginActivation {
    generation: RuntimeGeneration,
    guard: OwnedRwLockWriteGuard<RuntimeState>,
}

impl PluginActivation {
    /// The generation being assembled.
    pub fn generation(&self) -> &RuntimeGeneration {
        &self.generation
    }

    /// Publish the generation after all of its registrations succeeded or after
    /// the caller has intentionally accepted the existing partial-failure
    /// semantics. Dropping without committing leaves the plugin inactive.
    pub fn commit(mut self) {
        self.guard.active = true;
    }
}

/// Exclusive deactivation lease. It marks the plugin inactive immediately and
/// holds the write lock until the caller has removed all runtime registrations.
pub struct PluginDeactivation {
    generation: RuntimeGeneration,
    #[allow(dead_code)]
    guard: OwnedRwLockWriteGuard<RuntimeState>,
}

impl PluginDeactivation {
    /// The generation that was retired, if the plugin had been activated.
    pub fn generation(&self) -> &RuntimeGeneration {
        &self.generation
    }
}

/// Read lease for work running against one active plugin generation.
pub struct PluginWorkLease {
    generation: RuntimeGeneration,
    #[allow(dead_code)]
    guard: OwnedRwLockReadGuard<RuntimeState>,
}

impl PluginWorkLease {
    /// The generation that remains protected by this lease.
    pub fn generation(&self) -> &RuntimeGeneration {
        &self.generation
    }
}

/// Per-plugin generation and drain coordinator.
#[derive(Clone, Default)]
pub struct PluginRuntime {
    slots: Arc<Mutex<HashMap<String, Arc<PluginSlot>>>>,
}

impl PluginRuntime {
    /// Create an empty coordinator.
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self, plugin_id: &str) -> Arc<PluginSlot> {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slots
            .entry(plugin_id.to_owned())
            .or_insert_with(|| {
                Arc::new(PluginSlot {
                    next_generation: AtomicU64::new(1),
                    state: Arc::new(RwLock::new(RuntimeState {
                        active: false,
                        generation: 0,
                    })),
                })
            })
            .clone()
    }

    fn existing_slot(&self, plugin_id: &str) -> Option<Arc<PluginSlot>> {
        self.slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(plugin_id)
            .cloned()
    }

    fn next_generation(slot: &PluginSlot, plugin_id: &str) -> RuntimeGeneration {
        RuntimeGeneration {
            plugin_id: plugin_id.to_owned(),
            number: slot.next_generation.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// Begin activating a plugin. The returned write lease blocks work until
    /// [`PluginActivation::commit`] publishes the generation.
    pub async fn begin_activation(&self, plugin_id: &str) -> PluginActivation {
        let slot = self.slot(plugin_id);
        let mut guard = Arc::clone(&slot.state).write_owned().await;
        let generation = Self::next_generation(&slot, plugin_id);
        guard.active = false;
        guard.generation = generation.number;
        PluginActivation { generation, guard }
    }

    /// Begin activation only when the plugin is currently inactive. This is used
    /// by lazy activation events so an already-running eager plugin is not
    /// needlessly torn down and re-registered on every event.
    pub async fn begin_activation_if_inactive(&self, plugin_id: &str) -> Option<PluginActivation> {
        let slot = self.slot(plugin_id);
        let mut guard = Arc::clone(&slot.state).write_owned().await;
        if guard.active {
            return None;
        }
        let generation = Self::next_generation(&slot, plugin_id);
        guard.generation = generation.number;
        Some(PluginActivation { generation, guard })
    }

    /// Begin deactivation. Existing work drains before this returns; the caller
    /// then owns the write lease while removing registrations and stopping
    /// sidecars. Dropping the lease leaves the plugin inactive.
    pub async fn begin_deactivation(&self, plugin_id: &str) -> PluginDeactivation {
        let slot = self.slot(plugin_id);
        let mut guard = Arc::clone(&slot.state).write_owned().await;
        guard.active = false;
        let generation = RuntimeGeneration {
            plugin_id: plugin_id.to_owned(),
            number: guard.generation,
        };
        PluginDeactivation { generation, guard }
    }

    /// Acquire a read lease for work belonging to an active plugin. A disabled,
    /// unknown, or currently activating/deactivating plugin returns `None`.
    pub async fn acquire(&self, plugin_id: &str) -> Option<PluginWorkLease> {
        let slot = self.existing_slot(plugin_id)?;
        let guard = Arc::clone(&slot.state).read_owned().await;
        if !guard.active {
            return None;
        }
        Some(PluginWorkLease {
            generation: RuntimeGeneration {
                plugin_id: plugin_id.to_owned(),
                number: guard.generation,
            },
            guard,
        })
    }

    /// Acquire a work lease only for `generation`, rejecting a newer or retired
    /// generation even when the same plugin id has since been re-enabled.
    pub async fn acquire_generation(
        &self,
        generation: &RuntimeGeneration,
    ) -> Option<PluginWorkLease> {
        let lease = self.acquire(&generation.plugin_id).await?;
        (lease.generation() == generation).then_some(lease)
    }

    /// Whether a generation is still the active generation for its plugin.
    /// Useful for asynchronous completion callbacks that do not hold a work
    /// lease for their entire lifetime.
    pub async fn is_current(&self, generation: &RuntimeGeneration) -> bool {
        let Some(slot) = self.existing_slot(&generation.plugin_id) else {
            return false;
        };
        let state = slot.state.read().await;
        state.active && state.generation == generation.number
    }

    /// Whether a plugin currently has a published active generation.
    pub async fn is_active(&self, plugin_id: &str) -> bool {
        let Some(slot) = self.existing_slot(plugin_id) else {
            return false;
        };
        let active = slot.state.read().await.active;
        active
    }

    /// Snapshot the currently published generation for a plugin. The returned
    /// binding re-checks that generation when asynchronous work starts.
    pub async fn active_binding(&self, plugin_id: &str) -> Option<RuntimeGenerationBinding> {
        let slot = self.existing_slot(plugin_id)?;
        let state = slot.state.read().await;
        if !state.active {
            return None;
        }
        Some(RuntimeGenerationBinding::new(
            self.clone(),
            RuntimeGeneration {
                plugin_id: plugin_id.to_owned(),
                number: state.generation,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::sync::Notify;

    use super::*;

    #[tokio::test]
    async fn deactivation_drains_work_and_reactivation_gets_a_new_generation() {
        let runtime = PluginRuntime::new();
        let activation = runtime.begin_activation("com.example.test").await;
        let first = activation.generation().clone();
        activation.commit();
        let stale_binding = RuntimeGenerationBinding::new(runtime.clone(), first.clone());

        assert!(runtime.is_current(&first).await);
        let work = runtime
            .acquire("com.example.test")
            .await
            .expect("published generation should accept work");

        let started = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(Notify::new());
        let task_runtime = runtime.clone();
        let task_started = Arc::clone(&started);
        let task_finished = Arc::clone(&finished);
        let deactivation = tokio::spawn(async move {
            let lease = task_runtime.begin_deactivation("com.example.test").await;
            task_started.store(true, Ordering::Release);
            task_finished.notify_one();
            lease
        });

        tokio::task::yield_now().await;
        assert!(!started.load(Ordering::Acquire));

        drop(work);
        tokio::time::timeout(std::time::Duration::from_secs(1), finished.notified())
            .await
            .expect("deactivation should proceed after work is released");
        drop(deactivation.await.expect("deactivation task should finish"));
        assert!(!runtime.is_current(&first).await);
        assert!(runtime.acquire("com.example.test").await.is_none());

        let second_activation = runtime.begin_activation("com.example.test").await;
        let second = second_activation.generation().clone();
        assert!(second.number() > first.number());
        second_activation.commit();
        assert!(!runtime.is_current(&first).await);
        assert!(runtime.is_current(&second).await);
        assert!(stale_binding.acquire().await.is_none());
    }

    #[tokio::test]
    async fn uncommitted_activation_cannot_publish_stale_runtime_work() {
        let runtime = PluginRuntime::new();
        let activation = runtime.begin_activation("com.example.stale").await;
        let generation = activation.generation().clone();

        let attempt_runtime = runtime.clone();
        let attempt =
            tokio::spawn(
                async move { attempt_runtime.acquire("com.example.stale").await.is_some() },
            );
        tokio::task::yield_now().await;
        assert!(!attempt.is_finished());

        drop(activation);
        assert!(!attempt.await.expect("work probe should finish"));
        assert!(!runtime.is_current(&generation).await);
        assert!(!runtime.is_active("com.example.stale").await);
    }
}
