//! Built-in system App definitions for the App-store.
//!
//! Ghost and Shadow are Ryu's first-party desktop-automation and screen-capture
//! tools. Their lifecycle is **sidecar-based** (install → `POST /api/setup/:name/install`,
//! start/stop → `POST /api/sidecar/:name/start|stop`) rather than the App
//! lifecycle store (PluginStore), so they never appear in the SQLite apps table.
//!
//! This module owns:
//!
//! 1. The [`SystemPlugin`] descriptor struct — the source of truth for which
//!    manifests are "system" and what sidecar name, badge flags, and platform
//!    notes apply to each.
//! 2. The [`SYSTEM_PLUGINS`] constant — the canonical list consulted by the
//!    `list_apps` handler to inject `built_in`, `sidecar_name`, `windows_first`,
//!    and `local_only` into the JSON response.
//! 3. [`is_builtin`] and [`find_system_plugin`] helpers consumed by
//!    `server/mod.rs`.
//!
//! # Core-vs-Gateway boundary
//!
//! Sidecar install/start/stop is "what runs" — it belongs in Core. Policy
//! decisions (grant enforcement, security checks) belong in the Gateway.
//! Nothing in this module enforces policy.

/// Metadata describing a built-in system App whose lifecycle is sidecar-based.
#[derive(Debug, Clone)]
pub struct SystemPlugin {
    /// Reverse-domain manifest id, must match the fixture JSON.
    pub manifest_id: &'static str,

    /// The sidecar `:name` used in `/api/setup/:name/install` and
    /// `/api/sidecar/:name/start|stop`.
    pub sidecar_name: &'static str,

    /// True when the sidecar binary only ships for Windows. The frontend
    /// renders a "Windows-first" badge and shows a graceful unavailable state
    /// on other platforms.
    pub windows_first: bool,

    /// True when the sidecar runs locally only (no cloud/remote fallback).
    /// The frontend renders a "Local only" badge.
    pub local_only: bool,
}

/// The canonical list of built-in system Apps.
///
/// Order is stable and determines display order in the App-store.
pub const SYSTEM_PLUGINS: &[SystemPlugin] = &[
    SystemPlugin {
        manifest_id: "io.ryu.ghost",
        sidecar_name: "ghost",
        windows_first: true,
        local_only: true,
    },
    SystemPlugin {
        manifest_id: "io.ryu.shadow",
        sidecar_name: "shadow",
        windows_first: true,
        local_only: true,
    },
];

/// The set of **Core-tier** built-in plugin ids (#444).
///
/// Core-tier plugins are first-party and shipped with Ryu; they are seeded
/// enabled at startup (a one-time seed that respects a user's later disable) and
/// render in the "Core" section of the App-store. Every other plugin — including
/// user-installed ones and built-in fixtures NOT in this list — is
/// [`PluginTier::Community`] (install-then-enable opt-in).
///
/// Tier is derived from *membership here*, never from a manifest field, so a
/// plugin cannot promote itself to Core.
///
/// Defaults policy:
/// - `engines` (local llama.cpp) ships enabled (zero-setup chat on install).
/// - `durable` (the in-process durable workflow engine) ships enabled — it runs
///   on every platform with no extra sidecar, so it is a zero-setup default-on
///   dogfood (#448) declared as an `engine` runnable.
/// - `ghost`/`shadow` are sidecar-managed (their own lifecycle), Core-tier so
///   the store groups them with the first-party set.
/// - `firewall`/`routing`/`sandbox` are Core-tier but **opt-in** (they change
///   gateway/sandbox behaviour), so they are NOT in [`CORE_DEFAULT_ON`].
/// - `headroom` (egress compression) is deliberately **Community-tier**: the
///   compression *service* is the plugin and Core only hosts the gateway
///   transform, so it is install-then-enable from the marketplace exactly like a
///   third-party compression plugin would be. The bundled fixture is our
///   reference; nothing about the service is hardcoded.
pub const CORE_PLUGINS: &[&str] = &[
    "io.ryu.ghost",
    "io.ryu.shadow",
    "io.ryu.firewall",
    "io.ryu.routing",
    "io.ryu.sandbox",
    "io.ryu.engines",
    "io.ryu.durable",
    "io.ryu.goal",
    "io.ryu.proof",
    "io.ryu.double-check",
];

/// The subset of [`CORE_PLUGINS`] that should be **enabled by default** on a
/// fresh install (seeded at startup when the install has no prior record). The
/// opt-in Core plugins (firewall/routing/sandbox/headroom) are deliberately
/// excluded — they only activate when the user enables them.
///
/// The chat turn-hook plugins (`goal`/`proof`/`double-check`) ship default-on so
/// their features (persistent goals, proof-of-work verification, answer review)
/// work on **every surface** with zero setup, exactly like the built-in chat
/// commands they replaced. This is only affordable because each declares a cheap
/// `match` pre-gate (see [`crate::plugin_manifest::HookMatch`]): an idle hook
/// costs a flag/prefix check or one KV read, never a sandbox spawn. They stay
/// real, swappable plugins — a user can disable any of them, and the fixture is
/// the reference a third party can fork.
pub const CORE_DEFAULT_ON: &[&str] = &[
    "io.ryu.engines",
    "io.ryu.durable",
    "io.ryu.goal",
    "io.ryu.proof",
    "io.ryu.double-check",
];

/// The [`crate::plugin_manifest::PluginTier`] of a plugin, derived from
/// membership in [`CORE_PLUGINS`]. Anything not listed is Community.
pub fn tier_for(manifest_id: &str) -> crate::plugin_manifest::PluginTier {
    if CORE_PLUGINS.contains(&manifest_id) {
        crate::plugin_manifest::PluginTier::Core
    } else {
        crate::plugin_manifest::PluginTier::Community
    }
}

/// Whether a Core-tier plugin should be seeded enabled on first run.
pub fn is_default_on(manifest_id: &str) -> bool {
    CORE_DEFAULT_ON.contains(&manifest_id)
}

/// Returns `true` if `manifest_id` is one of the built-in system apps.
pub fn is_builtin(manifest_id: &str) -> bool {
    SYSTEM_PLUGINS.iter().any(|s| s.manifest_id == manifest_id)
}

/// Finds the [`SystemPlugin`] descriptor for `manifest_id`, if it is a system app.
pub fn find_system_plugin(manifest_id: &str) -> Option<&'static SystemPlugin> {
    SYSTEM_PLUGINS.iter().find(|s| s.manifest_id == manifest_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_apps_contains_ghost_and_shadow() {
        assert!(
            SYSTEM_PLUGINS
                .iter()
                .any(|s| s.manifest_id == "io.ryu.ghost"),
            "ghost must be in SYSTEM_PLUGINS"
        );
        assert!(
            SYSTEM_PLUGINS
                .iter()
                .any(|s| s.manifest_id == "io.ryu.shadow"),
            "shadow must be in SYSTEM_PLUGINS"
        );
    }

    #[test]
    fn is_builtin_returns_true_for_known_ids() {
        assert!(is_builtin("io.ryu.ghost"));
        assert!(is_builtin("io.ryu.shadow"));
    }

    #[test]
    fn is_builtin_returns_false_for_unknown_ids() {
        assert!(!is_builtin("io.ryu.spider"));
        assert!(!is_builtin("com.example.research-assistant"));
        assert!(!is_builtin("does.not.exist"));
    }

    #[test]
    fn find_system_plugin_returns_correct_metadata() {
        let ghost = find_system_plugin("io.ryu.ghost").expect("ghost must be found");
        assert_eq!(ghost.sidecar_name, "ghost");
        assert!(ghost.windows_first);
        assert!(ghost.local_only);

        let shadow = find_system_plugin("io.ryu.shadow").expect("shadow must be found");
        assert_eq!(shadow.sidecar_name, "shadow");
        assert!(shadow.windows_first);
        assert!(shadow.local_only);
    }

    #[test]
    fn find_system_plugin_returns_none_for_unknown_id() {
        assert!(find_system_plugin("io.ryu.spider").is_none());
        assert!(find_system_plugin("does.not.exist").is_none());
    }

    // ── Two-tier registry (#444) ──────────────────────────────────────────────

    #[test]
    fn tier_for_core_plugins_is_core() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(tier_for("io.ryu.engines"), PluginTier::Core);
        assert_eq!(tier_for("io.ryu.ghost"), PluginTier::Core);
        assert_eq!(tier_for("io.ryu.firewall"), PluginTier::Core);
        assert_eq!(tier_for("io.ryu.sandbox"), PluginTier::Core);
        // #448 dogfood: the durable workflow engine plugin is Core-tier.
        assert_eq!(tier_for("io.ryu.durable"), PluginTier::Core);
        assert!(is_default_on("io.ryu.durable"));
    }

    #[test]
    fn tier_for_unknown_is_community() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(
            tier_for("com.example.research-assistant"),
            PluginTier::Community
        );
        assert_eq!(tier_for("io.ryu.spider"), PluginTier::Community);
        assert_eq!(tier_for("does.not.exist"), PluginTier::Community);
    }

    /// #444 Community-tier gate: a non-Core plugin is Community, is therefore NOT
    /// in `CORE_DEFAULT_ON`, and so is never auto-seeded — it must be
    /// install-then-enable opt-in. This asserts the tier gate end-to-end at the
    /// membership layer (the lifecycle store enforces the install-disabled default
    /// that `install_app` tests cover).
    #[test]
    fn community_plugin_is_opt_in_never_default_on() {
        use crate::plugin_manifest::PluginTier;
        let community_id = "com.example.research-assistant";
        // Tier is Community (not a manifest-asserted field — derived from membership).
        assert_eq!(tier_for(community_id), PluginTier::Community);
        // A Community plugin can never be Core-tier...
        assert!(!CORE_PLUGINS.contains(&community_id));
        // ...and therefore can never be default-on (auto-seeded). The startup
        // seeder iterates CORE_DEFAULT_ON only, so a Community plugin is never
        // touched until the user explicitly installs+enables it.
        assert!(!CORE_DEFAULT_ON.contains(&community_id));
        assert!(!is_default_on(community_id));
    }

    #[test]
    fn default_on_is_a_subset_of_core_and_opt_in_excluded() {
        // Every default-on plugin must be Core-tier.
        for id in CORE_DEFAULT_ON {
            assert!(
                CORE_PLUGINS.contains(id),
                "default-on plugin '{id}' must be Core-tier"
            );
            assert!(is_default_on(id));
        }
        // Gateway/sandbox policy plugins are Core-tier but NOT default-on
        // (they change gateway/sandbox behaviour, so they stay opt-in).
        assert!(!is_default_on("io.ryu.firewall"));
        assert!(!is_default_on("io.ryu.routing"));
        assert!(!is_default_on("io.ryu.sandbox"));
        assert!(!is_default_on("io.ryu.headroom"));
    }
}
