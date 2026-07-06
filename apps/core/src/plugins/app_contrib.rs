//! In-memory registry of runtime contributions from enabled plugins that Core
//! otherwise has no home for: **engine bindings**, **channel adapters**, and
//! **companion surfaces**.
//!
//! ## Why this exists
//!
//! The plugin enable path activates each `RunnableEntry` by dispatching it to a
//! per-kind handler in [`crate::server::build_runnable_registry`]:
//! Agent → `AgentStore`, Workflow → the workflow store, Tool →
//! [`crate::sidecar::mcp::McpRegistry`]'s in-memory `app_tools` bag. But
//! **Engine**, **Channel**, and **Companion** runnables had no store to register
//! into, so a plugin declaring them did nothing (the "inert kinds" bug).
//!
//! This registry is the missing home. It mirrors `McpRegistry::register_app_tool`
//! exactly: a set of `Arc<RwLock<Vec<_>>>` bags, an idempotent `register_*`
//! (retain-by-id then push, so re-enable is a no-op) and a symmetric
//! `unregister_*` (retain-out by id, called from the disable path). Entries are
//! keyed by the `app__<id>` convention every other app contribution uses.
//!
//! ## Core-vs-Gateway boundary
//!
//! These are *what Core exposes as selectable* (an engine appears in the engine
//! picker, a channel appears as an available adapter, a companion appears for the
//! desktop to render). The Gateway still governs every model call an engine
//! ultimately makes; registering an engine binding here does not bypass routing.
//!
//! ## Persistence
//!
//! In-memory only, exactly like `app_tools`. It survives a restart because
//! `main.rs` fires the `onStartup` activation event, which re-runs every enabled
//! plugin through `register_active` — re-populating these bags from the manifests
//! on disk.

use std::sync::{Arc, RwLock};

use serde::Serialize;

/// An engine/inference-backend binding contributed by an enabled plugin
/// (`RunnableKind::Engine`). Surfaced in `GET /api/engines` so it is selectable
/// like a built-in engine runtime.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppEngine {
    /// `app__<runnable id>` — the app-namespaced id.
    pub id: String,
    /// Human-readable display name (the runnable's `name`).
    pub name: String,
    /// Engine type from `EngineConfig.engine_type` (e.g. `"llamacpp"`, `"ollama"`,
    /// `"openai_compat"`).
    pub engine_type: String,
    /// Base URL for OpenAI-compatible engines, when the plugin declared one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// A messaging-channel adapter binding contributed by an enabled plugin
/// (`RunnableKind::Channel`). Surfaced via `GET /api/plugins/contributions` so a
/// client can see which platforms an enabled plugin makes available.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppChannel {
    /// `app__<runnable id>` — the app-namespaced id.
    pub id: String,
    /// Human-readable display name (the runnable's `name`).
    pub name: String,
    /// Platform from `ChannelConfig.platform` (e.g. `"telegram"`, `"slack"`,
    /// `"whatsapp"`, `"discord"`).
    pub platform: String,
}

/// A companion-surface descriptor contributed by an enabled plugin
/// (`RunnableKind::Companion`). Surfaced via `GET /api/plugins/contributions` so
/// the desktop can render the overlay/sidebar panel it describes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppCompanion {
    /// `app__<runnable id>` — the app-namespaced id.
    pub id: String,
    /// Human-readable display name (the runnable's `name`).
    pub name: String,
    /// Display label from `CompanionConfig.label`.
    pub label: String,
    /// Icon identifier resolved by the desktop shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

/// The in-memory registry of app-contributed engines, channels, and companions.
///
/// Cheap to clone (three `Arc`s), so it is stored directly in `ServerState` and
/// cloned into each request handler like the other subsystem handles.
#[derive(Clone, Default)]
pub struct AppContribRegistry {
    engines: Arc<RwLock<Vec<AppEngine>>>,
    channels: Arc<RwLock<Vec<AppChannel>>>,
    companions: Arc<RwLock<Vec<AppCompanion>>>,
}

impl AppContribRegistry {
    /// Build an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    // ── Engines ───────────────────────────────────────────────────────────────

    /// Register (or replace) an app-contributed engine binding. Idempotent.
    pub fn register_engine(&self, engine: AppEngine) {
        if let Ok(mut v) = self.engines.write() {
            v.retain(|e| e.id != engine.id);
            v.push(engine);
        }
    }

    /// Remove an app-contributed engine binding by id. Idempotent.
    pub fn unregister_engine(&self, id: &str) {
        if let Ok(mut v) = self.engines.write() {
            v.retain(|e| e.id != id);
        }
    }

    /// Snapshot of all app-contributed engines.
    pub fn engines(&self) -> Vec<AppEngine> {
        self.engines.read().map(|v| v.clone()).unwrap_or_default()
    }

    // ── Channels ──────────────────────────────────────────────────────────────

    /// Register (or replace) an app-contributed channel adapter. Idempotent.
    pub fn register_channel(&self, channel: AppChannel) {
        if let Ok(mut v) = self.channels.write() {
            v.retain(|c| c.id != channel.id);
            v.push(channel);
        }
    }

    /// Remove an app-contributed channel adapter by id. Idempotent.
    pub fn unregister_channel(&self, id: &str) {
        if let Ok(mut v) = self.channels.write() {
            v.retain(|c| c.id != id);
        }
    }

    /// Snapshot of all app-contributed channels.
    pub fn channels(&self) -> Vec<AppChannel> {
        self.channels.read().map(|v| v.clone()).unwrap_or_default()
    }

    // ── Companions ────────────────────────────────────────────────────────────

    /// Register (or replace) an app-contributed companion surface. Idempotent.
    pub fn register_companion(&self, companion: AppCompanion) {
        if let Ok(mut v) = self.companions.write() {
            v.retain(|c| c.id != companion.id);
            v.push(companion);
        }
    }

    /// Remove an app-contributed companion surface by id. Idempotent.
    pub fn unregister_companion(&self, id: &str) {
        if let Ok(mut v) = self.companions.write() {
            v.retain(|c| c.id != id);
        }
    }

    /// Snapshot of all app-contributed companions.
    pub fn companions(&self) -> Vec<AppCompanion> {
        self.companions
            .read()
            .map(|v| v.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: &str) -> AppEngine {
        AppEngine {
            id: id.to_owned(),
            name: format!("Engine {id}"),
            engine_type: "llamacpp".to_owned(),
            base_url: None,
        }
    }

    #[test]
    fn register_then_unregister_engine_is_symmetric() {
        let reg = AppContribRegistry::new();
        reg.register_engine(engine("app__e1"));
        assert_eq!(reg.engines().len(), 1);
        reg.unregister_engine("app__e1");
        assert!(reg.engines().is_empty());
    }

    #[test]
    fn register_engine_is_idempotent() {
        let reg = AppContribRegistry::new();
        reg.register_engine(engine("app__e1"));
        reg.register_engine(engine("app__e1"));
        assert_eq!(
            reg.engines().len(),
            1,
            "re-register replaces, not duplicates"
        );
    }

    #[test]
    fn unregister_missing_id_is_noop() {
        let reg = AppContribRegistry::new();
        reg.unregister_engine("app__nope");
        reg.unregister_channel("app__nope");
        reg.unregister_companion("app__nope");
        assert!(reg.engines().is_empty());
    }

    #[test]
    fn channel_and_companion_round_trip() {
        let reg = AppContribRegistry::new();
        reg.register_channel(AppChannel {
            id: "app__c1".to_owned(),
            name: "Telegram bot".to_owned(),
            platform: "telegram".to_owned(),
        });
        reg.register_companion(AppCompanion {
            id: "app__co1".to_owned(),
            name: "Research panel".to_owned(),
            label: "Research".to_owned(),
            icon: Some("magnifying-glass".to_owned()),
            shortcut: None,
        });
        assert_eq!(reg.channels().len(), 1);
        assert_eq!(reg.companions().len(), 1);
        assert_eq!(reg.channels()[0].platform, "telegram");
        assert_eq!(reg.companions()[0].label, "Research");

        reg.unregister_channel("app__c1");
        reg.unregister_companion("app__co1");
        assert!(reg.channels().is_empty());
        assert!(reg.companions().is_empty());
    }
}
