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
        manifest_id: "ghost",
        sidecar_name: "ghost",
        windows_first: true,
        local_only: true,
    },
    SystemPlugin {
        manifest_id: "shadow",
        sidecar_name: "shadow",
        windows_first: true,
        local_only: true,
    },
    // Spider is the default web-crawl tool: a cross-platform Rust sidecar
    // (`spider-rs/spider`), so not Windows-first. Local-only (runs the crawler
    // process on the node).
    SystemPlugin {
        manifest_id: "spider",
        sidecar_name: "spider",
        windows_first: false,
        local_only: true,
    },
    // Agent Browser is the default web-browsing tool: an npx-launched MCP server
    // (npm `agentbrowser`), registered in `sidecar/mcp/mod.rs::builtin_servers`.
    // Cross-platform (Node) and reaches the web, so neither Windows-first nor
    // local-only.
    SystemPlugin {
        manifest_id: "agentbrowser",
        sidecar_name: "agentbrowser",
        windows_first: false,
        local_only: false,
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
/// - `ghost`/`shadow`/`spider`/`agentbrowser` are the sidecar-backed default
///   tool apps. They are Core-tier AND default-on: on a fresh install their app
///   record is auto-seeded enabled (so they appear installed exactly like the
///   auto-downloaded default models), while the tool process still runs through
///   its own sidecar/MCP lifecycle. Their fixtures declare no runnables (the
///   tools come from the dedicated MCP provider); the record is the governance
///   shell (see `crate::plugin_manifest` `BUILTIN_MANIFESTS` doc).
/// - `firewall`/`routing`/`sandbox` are Core-tier but **opt-in** (they change
///   gateway/sandbox behaviour), so they are NOT in [`CORE_DEFAULT_ON`].
/// - `headroom` (egress compression) is deliberately **Community-tier**: the
///   compression *service* is the plugin and Core only hosts the gateway
///   transform, so it is install-then-enable from the marketplace exactly like a
///   third-party compression plugin would be. The bundled fixture is our
///   reference; nothing about the service is hardcoded.
pub const CORE_PLUGINS: &[&str] = &[
    "ghost",
    "shadow",
    "spider",
    "agentbrowser",
    "firewall",
    "routing",
    "sandbox",
    // System-wide predictive typing. Core-tier but opt-in (NOT in CORE_DEFAULT_ON):
    // enabling it is the single on/off switch for the /api/predict/* brain, and it
    // sends text from arbitrary apps to a model, so it ships disabled.
    "predict",
    "engines",
    "durable",
    "goal",
    "proof",
    "double-check",
    // Pre-turn prompt-improver: rewrites the outgoing message via a configurable
    // model before it is sent. Reverse-DNS id (matches its manifest + composer flag).
    "com.ryuhq.auto-expand",
    // Ryu Apps (widget-rendering in-process apps). All ship default-on so their
    // widgets render on install; widget-initiated writes are call-time
    // Gateway-gated (governed round-trip), so default-on is safe.
    "checklist",
    "smart-intake-form",
    "data-grid-explorer",
    "chart-studio",
    "decision-wizard",
    "quest-board",
    "worktree-diff-review",
    "gateway-budget-dial",
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`) that owns its
    // Space documents via `spaces:docs`. Default-on with a dedicated seed block in
    // main.rs (it needs approved grants + a `ui_code` HTML blob the generic seed
    // loop does not set). Replaces the built-in whiteboard editor.
    "com.ryu.whiteboard",
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
    "engines",
    "durable",
    "goal",
    "proof",
    "double-check",
    // The default tool apps — auto-installed (record seeded enabled) on a fresh
    // install so they show up like the auto-downloaded default models. The actual
    // process runs through its own sidecar/MCP lifecycle; enabling the record just
    // makes it a first-class, governed, disable-able App. Their fixtures declare no
    // runnables, so seeding never double-lists their tools.
    "ghost",
    "shadow",
    "spider",
    "agentbrowser",
    // Auto-expand ships default-on so its composer toggle + `/expand` command are
    // available with zero setup; the flag/command `match` gate makes it free when
    // the toggle is off and no `/expand` is used (no sandbox spawn on idle turns).
    "com.ryuhq.auto-expand",
    // Ryu Apps — default-on so widgets render on install (see CORE_PLUGINS).
    "checklist",
    "smart-intake-form",
    "data-grid-explorer",
    "chart-studio",
    "decision-wizard",
    "quest-board",
    "worktree-diff-review",
    "gateway-budget-dial",
    // Whiteboard — default-on so opening a whiteboard Space document just works. Its
    // record is established with grants + `ui_code` by the dedicated seed block in
    // main.rs BEFORE the generic loop, which then skips it (record present wins).
    "com.ryu.whiteboard",
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
    fn system_apps_contains_default_tool_apps() {
        for id in ["ghost", "shadow", "spider", "agentbrowser"] {
            assert!(
                SYSTEM_PLUGINS.iter().any(|s| s.manifest_id == id),
                "{id} must be in SYSTEM_PLUGINS"
            );
        }
    }

    #[test]
    fn is_builtin_returns_true_for_known_ids() {
        assert!(is_builtin("ghost"));
        assert!(is_builtin("shadow"));
        assert!(is_builtin("spider"));
        assert!(is_builtin("agentbrowser"));
    }

    #[test]
    fn is_builtin_returns_false_for_unknown_ids() {
        assert!(!is_builtin("com.example.research-assistant"));
        assert!(!is_builtin("does.not.exist"));
    }

    #[test]
    fn find_system_plugin_returns_correct_metadata() {
        let ghost = find_system_plugin("ghost").expect("ghost must be found");
        assert_eq!(ghost.sidecar_name, "ghost");
        assert!(ghost.windows_first);
        assert!(ghost.local_only);

        let shadow = find_system_plugin("shadow").expect("shadow must be found");
        assert_eq!(shadow.sidecar_name, "shadow");
        assert!(shadow.windows_first);
        assert!(shadow.local_only);
    }

    #[test]
    fn find_system_plugin_returns_metadata_for_default_tool_apps() {
        let spider = find_system_plugin("spider").expect("spider must be found");
        assert_eq!(spider.sidecar_name, "spider");
        assert!(!spider.windows_first, "spider is cross-platform");

        let ab = find_system_plugin("agentbrowser").expect("agentbrowser must be found");
        assert_eq!(ab.sidecar_name, "agentbrowser");
        assert!(!ab.windows_first, "agentbrowser is cross-platform");
        assert!(!ab.local_only, "agentbrowser reaches the web");
    }

    #[test]
    fn find_system_plugin_returns_none_for_unknown_id() {
        assert!(find_system_plugin("does.not.exist").is_none());
    }

    // ── Two-tier registry (#444) ──────────────────────────────────────────────

    #[test]
    fn tier_for_core_plugins_is_core() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(tier_for("engines"), PluginTier::Core);
        assert_eq!(tier_for("ghost"), PluginTier::Core);
        assert_eq!(tier_for("firewall"), PluginTier::Core);
        assert_eq!(tier_for("sandbox"), PluginTier::Core);
        // #448 dogfood: the durable workflow engine plugin is Core-tier.
        assert_eq!(tier_for("durable"), PluginTier::Core);
        assert!(is_default_on("durable"));
    }

    /// The four sidecar-backed default tool apps are Core-tier AND default-on, so
    /// a fresh install auto-seeds their app record enabled (parity with the
    /// auto-downloaded default models). They are also system plugins (sidecar
    /// lifecycle) — the two facts coexist: the record is the governance shell, the
    /// sidecar/MCP provider is the run path.
    #[test]
    fn default_tool_apps_are_core_and_default_on_and_system() {
        use crate::plugin_manifest::PluginTier;
        for id in ["ghost", "shadow", "spider", "agentbrowser"] {
            assert_eq!(tier_for(id), PluginTier::Core, "{id} must be Core-tier");
            assert!(is_default_on(id), "{id} must be default-on (auto-seeded)");
            assert!(is_builtin(id), "{id} must be a system plugin");
        }
    }

    #[test]
    fn tier_for_unknown_is_community() {
        use crate::plugin_manifest::PluginTier;
        assert_eq!(
            tier_for("com.example.research-assistant"),
            PluginTier::Community
        );
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
        assert!(!is_default_on("firewall"));
        assert!(!is_default_on("routing"));
        assert!(!is_default_on("sandbox"));
        assert!(!is_default_on("headroom"));
        // Predictive typing is Core-tier but opt-in (sends text to a model).
        assert!(CORE_PLUGINS.contains(&"predict"));
        assert!(!is_default_on("predict"));
    }
}
