//! Host API contract — the single, versioned source of truth for the host↔plugin
//! RPC vocabulary: the semver [`HOST_API_VERSION`] plus [`HOST_API_METHODS`], the
//! canonical `method → capability → grant` table shared by every surface.
//!
//! Two independent surfaces used to hand-maintain this vocabulary and drift:
//!
//! - the TS app host (`packages/app-host/src/rpc.ts`) — `METHOD_CAPABILITY`,
//!   `GRANT_CAPABILITY`, `STREAMING_METHODS`, and
//! - Core's Rust plugin bridge (`apps/core/src/server/plugin_bridge_api.rs`
//!   `required_grant_for`).
//!
//! Both now DERIVE from this one table. The blessed-file test emits
//! `schemas/host-api.json` (same `RYU_REGEN_SCHEMAS=1` pattern as the manifest
//! schema); the TS host imports that JSON and derives its maps from it, and the
//! Rust bridge reads [`grant_for`]. A lockstep test on each side pins the derived
//! shapes to the old hand-written tables so nothing silently widens.
//!
//! # Surface coverage (documented divergence)
//!
//! The two surfaces cover DIFFERENT method subsets and agree only where they
//! overlap — this is by design, encoded in the [`HostApiMethod::ts_host`] flag:
//!
//! - Most methods are TS-app-host methods (`ts_host = true`). The bridge-backed
//!   families (`model.complete`, `agent.run`, `storage.*`, `spaces.*`,
//!   `finetune.*`) are dispatched by BOTH the TS host AND the Rust bridge and
//!   agree on their grant.
//! - `view.action` is a Rust-bridge-only relay (`ts_host = false`): it is NOT in
//!   `rpc.ts` `METHOD_CAPABILITY` (the task's ground-truth note was inaccurate on
//!   this point — it lives only in `plugin_bridge_api.rs` + the `capability_label`
//!   in `schema.rs`). The TS derivation skips `ts_host = false` entries, so it
//!   never leaks into the TS `Capability` union.
//!
//! This crate stays pure data (serde/schemars only, no I/O — the runtime charter);
//! the JSON file lives its lifecycle in the integration test, which is allowed I/O.

use serde::Serialize;

/// The version of the host↔plugin contract defined by this crate.
///
/// # Compatibility policy
///
/// Semver, **additive-only within a major**:
///
/// - **Patch/minor** bumps may only *add* — new optional manifest fields, new
///   enum variants behind `#[serde(other)]`-style tolerance, new constants, new
///   [`HOST_API_METHODS`] rows.
///   Nothing that exists may be removed, renamed, retyped, or made required.
/// - **Major** bumps are the only place a breaking change (removal, rename,
///   semantic change of an existing field) is allowed.
///
/// A plugin authored against host API `1.x` must therefore load on every later
/// `1.y` (y ≥ x) kernel unchanged. The `ryu-plugin-ready` handshake carries this
/// value as `hostApiVersion`; the host accepts a missing value (legacy) this
/// major and only annotates it (no rejection).
pub const HOST_API_VERSION: &str = "1.0.0";

/// One method in the host↔plugin RPC surface — the row type of the single-sourced
/// `method → capability → grant` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApiMethod {
    /// The RPC method key (e.g. `"model.complete"`).
    pub method: &'static str,
    /// The host capability the method requires (dotted, e.g. `"model.complete"`) —
    /// a member of the TS app host's `Capability` union.
    pub capability: &'static str,
    /// The manifest grant string that unlocks the capability (colon-form, e.g.
    /// `"hook:side-model"`). `None` for LOCAL host caps (`widget.state`,
    /// `ui.displayMode`) granted on mount and NEVER Gateway-sourced.
    pub grant: Option<&'static str>,
    /// Dispatched by the streaming path (many chunks + a terminal result) rather
    /// than the unary dispatch.
    pub streaming: bool,
    /// Exposed by the TS app-host RPC layer (`dispatchRpc` / streaming dispatch).
    /// `false` marks a Rust-bridge-only method (`view.action`) the TS host never
    /// dispatches; the TS derivation skips these.
    pub ts_host: bool,
}

/// Terse const constructor so the table reads as a dense grid.
const fn m(
    method: &'static str,
    capability: &'static str,
    grant: Option<&'static str>,
    streaming: bool,
    ts_host: bool,
) -> HostApiMethod {
    HostApiMethod {
        method,
        capability,
        grant,
        streaming,
        ts_host,
    }
}

/// The canonical host-API method table. The union of the TS app host's
/// `METHOD_CAPABILITY` (137 methods) and the Rust bridge's `view.action`
/// (Rust-only). Serialised to `schemas/host-api.json` for the TS host to consume.
pub const HOST_API_METHODS: &[HostApiMethod] = &[
    m("core.listAgents", "core.listAgents", Some("core:list_agents"), false, true),
    m("ui.registerRoute", "ui.render", Some("ui:render"), false, true),
    m("tool.call", "tool.call", Some("tool:call"), false, true),
    m("ui.sendMessage", "ui.sendMessage", Some("ui:send_message"), false, true),
    m("widget.setState", "widget.state", None, false, true),
    m("widget.getGlobals", "widget.state", None, false, true),
    m("ui.requestDisplayMode", "ui.displayMode", None, false, true),
    m("ui.requestModal", "ui.displayMode", None, false, true),
    m("ui.notifyHeight", "ui.displayMode", None, false, true),
    m("ui.requestClose", "ui.displayMode", None, false, true),
    m("ui.openExternal", "ui.displayMode", None, false, true),
    m("ui.uploadFile", "ui.displayMode", None, false, true),
    m("ui.selectFiles", "ui.displayMode", None, false, true),
    m("ui.getFileDownloadUrl", "ui.displayMode", None, false, true),
    m("ui.setOpenInAppUrl", "ui.displayMode", None, false, true),
    m("model.complete", "model.complete", Some("hook:side-model"), false, true),
    m("agent.run", "agent.run", Some("hook:run-agent"), false, true),
    m("storage.get", "storage.kv", Some("storage:kv"), false, true),
    m("storage.set", "storage.kv", Some("storage:kv"), false, true),
    m("storage.delete", "storage.kv", Some("storage:kv"), false, true),
    m("storage.keys", "storage.kv", Some("storage:kv"), false, true),
    m("agent.run.stream", "agent.run", Some("hook:run-agent"), true, true),
    m("agent.cancel", "agent.run", Some("hook:run-agent"), false, true),
    m("spaces.createDoc", "spaces.docs", Some("spaces:docs"), false, true),
    m("spaces.getDoc", "spaces.docs", Some("spaces:docs"), false, true),
    m("spaces.updateDoc", "spaces.docs", Some("spaces:docs"), false, true),
    m("spaces.listDocs", "spaces.docs", Some("spaces:docs"), false, true),
    m("spaces.deleteDoc", "spaces.docs", Some("spaces:docs"), false, true),
    m("media.image", "media.generate", Some("media:generate"), false, true),
    m("media.video", "media.generate", Some("media:generate"), false, true),
    m("media.tts", "media.generate", Some("media:generate"), false, true),
    m("media.transcribe", "media.transcribe", Some("media:transcribe"), false, true),
    m("registry.engineModels", "core.listAgents", Some("core:list_agents"), false, true),
    m("registry.ttsEngines", "core.listAgents", Some("core:list_agents"), false, true),
    m("registry.agents", "core.listAgents", Some("core:list_agents"), false, true),
    m("assets.searchGifs", "core.listAgents", Some("core:list_agents"), false, true),
    m("finetune.capability", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.start", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.list", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.get", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.cancel", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.adapters", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.merge", "finetune.runs", Some("finetune:runs"), false, true),
    m("finetune.stream", "finetune.runs", Some("finetune:runs"), true, true),
    m("monitors.list", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.get", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.create", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.update", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.delete", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.run", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.snapshots", "monitors.crud", Some("monitors:crud"), false, true),
    m("monitors.alerts", "monitors.crud", Some("monitors:crud"), false, true),
    m("workflows.list", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.get", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.save", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.delete", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.versionsList", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.versionGet", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.versionCreate", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.versionRestore", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.templatesList", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.templateGet", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.templateInstall", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.webhook", "workflows.crud", Some("workflows:crud"), false, true),
    m("workflows.run", "workflows.runstate", Some("workflows:runstate"), false, true),
    m("workflows.runGet", "workflows.runstate", Some("workflows:runstate"), false, true),
    m("workflows.resume", "workflows.runstate", Some("workflows:runstate"), false, true),
    m("workflows.agents", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("workflows.apps", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("workflows.mcp", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("workflows.skills", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("workflows.schedules", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("workflows.composio", "workflows.catalogs", Some("workflows:catalogs"), false, true),
    m("ghost.recordStart", "ghost.record", Some("ghost:record"), false, true),
    m("ghost.recordStatus", "ghost.record", Some("ghost:record"), false, true),
    m("ghost.recordStop", "ghost.record", Some("ghost:record"), false, true),
    m("ghost.recipes", "ghost.record", Some("ghost:record"), false, true),
    m("webhooks.list", "webhooks.crud", Some("webhooks:crud"), false, true),
    m("webhooks.ingressStatus", "webhooks.crud", Some("webhooks:crud"), false, true),
    m("quests.list", "quests.crud", Some("quests:crud"), false, true),
    m("quests.create", "quests.crud", Some("quests:crud"), false, true),
    m("quests.update", "quests.crud", Some("quests:crud"), false, true),
    m("quests.delete", "quests.crud", Some("quests:crud"), false, true),
    m("quests.complete", "quests.crud", Some("quests:crud"), false, true),
    m("quests.dismiss", "quests.crud", Some("quests:crud"), false, true),
    m("quests.acceptSuggestion", "quests.crud", Some("quests:crud"), false, true),
    m("quests.dismissSuggestion", "quests.crud", Some("quests:crud"), false, true),
    m("quests.judge", "quests.crud", Some("quests:crud"), false, true),
    m("quests.openDetectionSettings", "quests.crud", Some("quests:crud"), false, true),
    m("activity.list", "activity.read", Some("activity:read"), false, true),
    m("activity.openSession", "activity.read", Some("activity:read"), false, true),
    m("timeline.list", "timeline.read", Some("timeline:read"), false, true),
    m("timeline.journal", "timeline.read", Some("timeline:read"), false, true),
    m("timeline.frame", "timeline.read", Some("timeline:read"), false, true),
    m("timeline.openReview", "timeline.read", Some("timeline:read"), false, true),
    m("timeline.openSettings", "timeline.read", Some("timeline:read"), false, true),
    m("mail.list", "mail.crud", Some("mail:crud"), false, true),
    m("mail.messages", "mail.crud", Some("mail:crud"), false, true),
    m("mail.create", "mail.crud", Some("mail:crud"), false, true),
    m("mail.delete", "mail.crud", Some("mail:crud"), false, true),
    m("mail.rotateSecret", "mail.crud", Some("mail:crud"), false, true),
    m("mail.send", "mail.crud", Some("mail:crud"), false, true),
    m("mail.inboundUrl", "mail.crud", Some("mail:crud"), false, true),
    m("calendar.jobs", "calendar.crud", Some("calendar:crud"), false, true),
    m("calendar.workflows", "calendar.crud", Some("calendar:crud"), false, true),
    m("calendar.agents", "calendar.crud", Some("calendar:crud"), false, true),
    m("calendar.createAutomation", "calendar.crud", Some("calendar:crud"), false, true),
    m("learning.config", "learning.crud", Some("learning:crud"), false, true),
    m("learning.experience", "learning.crud", Some("learning:crud"), false, true),
    m("learning.healing", "learning.crud", Some("learning:crud"), false, true),
    m("approvals.list", "approvals.crud", Some("approvals:crud"), false, true),
    m("approvals.approve", "approvals.crud", Some("approvals:crud"), false, true),
    m("approvals.reject", "approvals.crud", Some("approvals:crud"), false, true),
    m("notifications.list", "approvals.crud", Some("approvals:crud"), false, true),
    m("notifications.markRead", "approvals.crud", Some("approvals:crud"), false, true),
    m("notifications.ack", "approvals.crud", Some("approvals:crud"), false, true),
    m("suggestions.list", "approvals.crud", Some("approvals:crud"), false, true),
    m("suggestions.feedback", "approvals.crud", Some("approvals:crud"), false, true),
    m("suggestions.openInChat", "approvals.crud", Some("approvals:crud"), false, true),
    m("meetings.list", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.transcript", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.start", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.finalize", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.delete", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.rename", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.import", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.open", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.openNotes", "meetings.crud", Some("meetings:crud"), false, true),
    m("meetings.openList", "meetings.crud", Some("meetings:crud"), false, true),
    m("skills.getSource", "skills.crud", Some("skills:crud"), false, true),
    m("skills.create", "skills.crud", Some("skills:crud"), false, true),
    m("skills.update", "skills.crud", Some("skills:crud"), false, true),
    m("skills.listVersions", "skills.crud", Some("skills:crud"), false, true),
    m("skills.versionSource", "skills.crud", Some("skills:crud"), false, true),
    m("skills.snapshot", "skills.crud", Some("skills:crud"), false, true),
    m("skills.restore", "skills.crud", Some("skills:crud"), false, true),
    m("skills.setTitle", "skills.crud", Some("skills:crud"), false, true),
    // Shell primitives (grant `shell:integrate`) — the generic `window.ryu.shell.*`
    // lane that gives a DECOUPLED companion the shell-integration privileges a
    // compiled-in first-party panel has: open an allowlisted shell tab, subscribe to
    // the live theme, contribute Cmd+K palette commands, and subscribe to the node
    // event stream. One capability (`shell.integrate`) gates the whole family; the
    // three subscribe/register verbs are STREAMING (host→frame push over the existing
    // chunk path), `openTab` is unary. Host-direct: the desktop host owns the tabs /
    // theme / palette / event-stream seams, so there is no Core bridge fetch (the
    // shell verbs are `ts_host = true` but have no `plugin_bridge_api.rs` branch — like
    // the existing `activity.openSession`/`meetings.open` nav verbs they resolve
    // entirely in the trusted webview). See `docs/renderer-host-slice-1.md`.
    m("shell.openTab", "shell.integrate", Some("shell:integrate"), false, true),
    m("shell.themeSubscribe", "shell.integrate", Some("shell:integrate"), true, true),
    m("shell.registerCommand", "shell.integrate", Some("shell:integrate"), true, true),
    m("shell.eventsSubscribe", "shell.integrate", Some("shell:integrate"), true, true),
    // Rust-bridge-only: a declarative-view action relayed to the owning app (the
    // shell's `view.action` intent). Grant-gated (`views:actions`) but NOT a TS
    // app-host method — `ts_host = false` keeps it out of the derived TS tables.
    m("view.action", "view.action", Some("views:actions"), false, false),
];

/// The grant a host method requires, or `None` for an unknown method or a local
/// host cap (`widget.state` / `ui.displayMode`). Core's `required_grant_for`
/// reads this so the Rust bridge and the TS host share one grant vocabulary.
#[must_use]
pub fn grant_for(method: &str) -> Option<&'static str> {
    HOST_API_METHODS
        .iter()
        .find(|e| e.method == method)
        .and_then(|e| e.grant)
}

#[cfg(test)]
mod tests {
    use super::{grant_for, HOST_API_METHODS, HOST_API_VERSION};

    #[test]
    fn host_api_version_is_valid_semver() {
        let v = semver::Version::parse(HOST_API_VERSION)
            .expect("HOST_API_VERSION must parse as strict semver");
        assert!(v.major >= 1, "host API starts at major 1");
    }

    #[test]
    fn methods_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in HOST_API_METHODS {
            assert!(seen.insert(e.method), "duplicate method '{}'", e.method);
        }
    }

    #[test]
    fn capability_grant_relationship_is_consistent() {
        // Every capability maps to at most ONE grant (the bijection the TS
        // GRANT_CAPABILITY derivation relies on): all methods sharing a capability
        // must share the same grant.
        use std::collections::HashMap;
        let mut cap_grant: HashMap<&str, Option<&str>> = HashMap::new();
        for e in HOST_API_METHODS {
            let prev = cap_grant.entry(e.capability).or_insert(e.grant);
            assert_eq!(
                *prev, e.grant,
                "capability '{}' has two grants: {:?} and {:?}",
                e.capability, *prev, e.grant
            );
        }
    }

    #[test]
    fn grant_for_reads_the_table() {
        assert_eq!(grant_for("model.complete"), Some("hook:side-model"));
        assert_eq!(grant_for("agent.run"), Some("hook:run-agent"));
        assert_eq!(grant_for("storage.get"), Some("storage:kv"));
        assert_eq!(grant_for("spaces.createDoc"), Some("spaces:docs"));
        assert_eq!(grant_for("finetune.stream"), Some("finetune:runs"));
        assert_eq!(grant_for("view.action"), Some("views:actions"));
        // Local host caps carry no Gateway grant.
        assert_eq!(grant_for("widget.setState"), None);
        assert_eq!(grant_for("ui.requestClose"), None);
        // Unknown method → None.
        assert_eq!(grant_for("nope"), None);
    }

    #[test]
    fn view_action_is_rust_only() {
        let e = HOST_API_METHODS
            .iter()
            .find(|e| e.method == "view.action")
            .expect("view.action present");
        assert!(!e.ts_host, "view.action must be Rust-bridge-only");
    }
}
