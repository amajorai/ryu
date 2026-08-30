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
pub const HOST_API_VERSION: &str = "1.10.0";

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
/// `METHOD_CAPABILITY` (138 methods) and the Rust bridge's `view.action`
/// (Rust-only). Serialised to `schemas/host-api.json` for the TS host to consume.
pub const HOST_API_METHODS: &[HostApiMethod] = &[
    // Local browser/native host capabilities. These rows are intentionally
    // grant-free; the host decides whether the concrete surface can provide
    // them, while the contract still keeps the method vocabulary closed.
    m("host.capabilities", "host.capabilities", None, false, true),
    // Secret-free active-node origins for apps that need to create a link to
    // the node. The host filters loopback/wildcard addresses and never returns
    // node credentials, user JWTs, or cookies.
    m("node.shareOrigins", "node.shareOrigins", None, false, true),
    m(
        "native.haptics",
        "native.haptics",
        Some("native:haptics"),
        false,
        true,
    ),
    m(
        "native.notifications.create",
        "native.notifications",
        Some("native:notifications"),
        false,
        true,
    ),
    m(
        "native.liveActivities.update",
        "native.liveActivities",
        Some("native:live_activities"),
        false,
        true,
    ),
    m(
        "core.listAgents",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    // Read-only runtime catalog for Companion apps. The projection contains
    // provider/model/agent metadata plus enabled app and hook declarations;
    // credentials, hook code, grants, and provider endpoints never cross the
    // host boundary. It intentionally shares core:list_agents with the older
    // agent catalog family so existing approval semantics stay simple.
    m(
        "catalog.snapshot",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    // Server-side model discovery for a selected provider. The request carries
    // only a provider id; Core resolves any BYOK/subscription credential and
    // returns ids/labels, never the upstream key or endpoint.
    m(
        "catalog.models",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    // Cross-chat broadcast for an installed companion. The list is a redacted
    // projection of the caller's visible conversations; sending reuses the
    // reviewed `chat.sendFollowUp` grant and the host's authenticated chat path.
    m(
        "chat.list",
        "chat.broadcast",
        Some("chat.sendFollowUp"),
        false,
        true,
    ),
    m(
        "chat.send",
        "chat.broadcast",
        Some("chat.sendFollowUp"),
        false,
        true,
    ),
    m(
        "ui.registerRoute",
        "ui.render",
        Some("ui:render"),
        false,
        true,
    ),
    m("tool.call", "tool.call", Some("tool:call"), false, true),
    m(
        "ui.sendMessage",
        "ui.sendMessage",
        Some("ui:send_message"),
        false,
        true,
    ),
    // Ephemeral, host-rendered notifications. The wire surface deliberately
    // carries only bounded strings, a closed variant set, duration and an opaque
    // caller-local id. It never exposes the renderer library, React nodes,
    // actions, styles, placement, or a global clear operation. The trusted host
    // namespaces ids per plugin before it reaches the renderer.
    m("ui.toast.show", "ui.toast", Some("ui:toast"), false, true),
    m("ui.toast.update", "ui.toast", Some("ui:toast"), false, true),
    m(
        "ui.toast.dismiss",
        "ui.toast",
        Some("ui:toast"),
        false,
        true,
    ),
    m("widget.setState", "widget.state", None, false, true),
    m("widget.getGlobals", "widget.state", None, false, true),
    // Generic companion → own-sidecar HTTP. The trusted host derives the target
    // from the owning plugin id and Core's ext-proxy still enforces the manifest
    // route allowlist, so the frame supplies only a relative path/method/body.
    m("app.request", "app.http", Some("app:http"), false, true),
    // Generic application-room realtime. The trusted host owns the node token
    // and WebSocket URL; the companion receives only an opaque room connection.
    m(
        "realtime.connect",
        "app.realtime",
        Some("app:realtime"),
        false,
        true,
    ),
    m(
        "realtime.publish",
        "app.realtime",
        Some("app:realtime"),
        false,
        true,
    ),
    m(
        "realtime.presence",
        "app.realtime",
        Some("app:realtime"),
        false,
        true,
    ),
    m(
        "realtime.subscribe",
        "app.realtime",
        Some("app:realtime"),
        true,
        true,
    ),
    m(
        "realtime.close",
        "app.realtime",
        Some("app:realtime"),
        false,
        true,
    ),
    m("ui.requestDisplayMode", "ui.displayMode", None, false, true),
    m("ui.requestModal", "ui.displayMode", None, false, true),
    m("ui.notifyHeight", "ui.displayMode", None, false, true),
    m("ui.requestClose", "ui.displayMode", None, false, true),
    m("ui.openExternal", "ui.displayMode", None, false, true),
    m("ui.uploadFile", "ui.displayMode", None, false, true),
    m("ui.selectFiles", "ui.displayMode", None, false, true),
    m("ui.getFileDownloadUrl", "ui.displayMode", None, false, true),
    m("ui.setOpenInAppUrl", "ui.displayMode", None, false, true),
    // Assistant bridge (grant `assistant:context`) — an app tells the ONE global
    // "Ask Ryu" surface what the user is looking at on ITS page, and what the
    // assistant may do about it. Before this, page context was an in-process React
    // hook, so only first-party desktop pages could publish and a sandboxed app had
    // no way to be asked about. One capability gates the whole family: publishing
    // context, taking the surface over with its own instructions, and opening the
    // panel. All three are the same trust decision — "this app may steer the
    // assistant while its page is open" — so splitting them would be false
    // precision. Nothing here reads: an app can only ever describe itself.
    m(
        "assistant.publishContext",
        "assistant.context",
        Some("assistant:context"),
        false,
        true,
    ),
    m(
        "assistant.clearContext",
        "assistant.context",
        Some("assistant:context"),
        false,
        true,
    ),
    m(
        "assistant.registerSurface",
        "assistant.context",
        Some("assistant:context"),
        false,
        true,
    ),
    m(
        "assistant.clearSurface",
        "assistant.context",
        Some("assistant:context"),
        false,
        true,
    ),
    m(
        "assistant.open",
        "assistant.context",
        Some("assistant:context"),
        false,
        true,
    ),
    m(
        "model.complete",
        "model.complete",
        Some("hook:side-model"),
        false,
        true,
    ),
    m(
        "agent.run",
        "agent.run",
        Some("hook:run-agent"),
        false,
        true,
    ),
    m(
        "agent.runFanout",
        "agent.run",
        Some("hook:run-agent"),
        false,
        false,
    ),
    m("storage.get", "storage.kv", Some("storage:kv"), false, true),
    m("storage.set", "storage.kv", Some("storage:kv"), false, true),
    m(
        "storage.delete",
        "storage.kv",
        Some("storage:kv"),
        false,
        true,
    ),
    m(
        "storage.keys",
        "storage.kv",
        Some("storage:kv"),
        false,
        true,
    ),
    m(
        "storage.compareAndSet",
        "storage.kv",
        Some("storage:kv"),
        false,
        true,
    ),
    // The **sealing primitive**: a plugin encrypts and decrypts its own data
    // WITHOUT ever holding a key. Core derives a per-plugin subkey from the
    // at-rest master key (`ryu_crypto::plugin_cipher`) using the bridge's
    // path-bound plugin id, so the key never crosses the sandbox boundary and one
    // app's ciphertext is unreadable by another (AEAD tag failure, enforced by the
    // KDF rather than by a check a caller could skip).
    //
    // Named for the OPERATION (`crypto.seal`), not for a guarantee: today the key
    // custody is at-rest (env → OS keychain → file fallback), which defends
    // against disk/backup theft, NOT against a compromised running host. The
    // zero-access/passcode custody in `docs/encryption-at-rest.md` §4.2 is not
    // built; when it lands it slots in behind this same seal/open surface, so no
    // plugin author should read `crypto.*` as an end-to-end promise.
    //
    // NOTE the asymmetry with the storage rows: sealing a value the plugin ALREADY
    // owns is not new authority, so `storage.set { secure: true }` needs only
    // `storage:kv`. `crypto:seal` gates sealing/opening ARBITRARY blobs the plugin
    // stores outside Core (its own sidecar files, a remote it syncs to).
    m(
        "crypto.seal",
        "crypto.seal",
        Some("crypto:seal"),
        false,
        true,
    ),
    m(
        "crypto.open",
        "crypto.seal",
        Some("crypto:seal"),
        false,
        true,
    ),
    // Non-secret custody description (`ryu_crypto::key_custody`) so an app can
    // tell the user WHICH guarantee is live before it stores anything — a file
    // fallback key sits next to the data it protects and is materially weaker
    // than the keychain. Carries no key material, so it rides the same grant
    // rather than minting a second one.
    m(
        "crypto.status",
        "crypto.seal",
        Some("crypto:seal"),
        false,
        true,
    ),
    // Conversation title write for turn-hook plugins (chat-title auto-rename).
    // `mode: "auto"` respects `title_custom`; `mode: "custom"` locks the title.
    // Rust-bridge-only (`ts_host = false`): Deno turn hooks reach it via
    // `PluginHookBridge`; it is not a TS app-host RPC.
    m(
        "conversation.setTitle",
        "conversation.title",
        Some("conversation:set-title"),
        false,
        false,
    ),
    // Read a node preference by key (plugin settings fields → `/api/preferences/:key`).
    // Rust-bridge-only — same rationale as `conversation.setTitle`.
    m(
        "preferences.get",
        "preferences.read",
        Some("preferences:read"),
        false,
        false,
    ),
    // Read a normalized, credential-free subscription usage snapshot for an
    // agent. Rust-bridge-only: it is consumed by turn-policy plugins before a
    // model session is opened, not by sandboxed companion UIs.
    m(
        "usage.snapshot",
        "usage.read",
        Some("usage:read"),
        false,
        false,
    ),
    // Record a thumbs vote on an assistant turn — the `message_actions` seam's
    // dispatch verb for the Learning app's rating toggle. Wraps Core's
    // `apply_message_feedback` (learning reward + RAG-memory sinks). Rust-bridge-only.
    m(
        "learning.recordFeedback",
        "learning.recordFeedback",
        Some("learning:crud"),
        false,
        false,
    ),
    // Distill a skill from a conversation (the "make a skill from this chat"
    // context-menu row). Wraps `synthesize_skill`. Rust-bridge-only.
    m(
        "learning.synthesizeSkill",
        "learning.synthesizeSkill",
        Some("learning:crud"),
        false,
        false,
    ),
    // Run one of the CALLING plugin's own declared turn hooks on demand, outside
    // the turn loop — the seam behind a "do it now" menu row (e.g. chat-title's
    // "Rename chat"). A plugin's menu row can only dispatch a HOST capability, so
    // without this an app whose whole behaviour lives in a hook had no way to be
    // triggered by the user at all. Scoped to the caller's own hooks by the bridge,
    // which takes the plugin id from the path, never the body. Rust-bridge-only.
    m(
        "hooks.run",
        "hooks.run",
        Some("hook:run-self"),
        false,
        false,
    ),
    m(
        "agent.run.stream",
        "agent.run",
        Some("hook:run-agent"),
        true,
        true,
    ),
    m(
        "agent.cancel",
        "agent.run",
        Some("hook:run-agent"),
        false,
        true,
    ),
    // Get-or-create a user-owned Space by NAME. Companion hosts implement this
    // host-directly with the authenticated Spaces API; headless hooks still use the
    // Rust bridge path. Keeping one method name lets both surfaces share the contract.
    m(
        "spaces.ensureSpace",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.createDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.getDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.updateDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.listDocs",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.deleteDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    // Direct semantic retrieval through the authenticated Spaces/RAG endpoint. The
    // companion host owns the token and forwards only the bounded query; Core still
    // enforces Space visibility and tenancy on the underlying route.
    m(
        "spaces.search",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "media.image",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.video",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.tts",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.transcribe",
        "media.transcribe",
        Some("media:transcribe"),
        false,
        true,
    ),
    m(
        "registry.engineModels",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "registry.ttsEngines",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "registry.agents",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "assets.searchGifs",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "finetune.capability",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.start",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.list",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.get",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.cancel",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.adapters",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.merge",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.stream",
        "finetune.runs",
        Some("finetune:runs"),
        true,
        true,
    ),
    m(
        "monitors.list",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.get",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.create",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.update",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.delete",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.run",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.snapshots",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "monitors.alerts",
        "monitors.crud",
        Some("monitors:crud"),
        false,
        true,
    ),
    m(
        "workflows.list",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.get",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.save",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.delete",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.versionsList",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.versionGet",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.versionCreate",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.versionRestore",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.templatesList",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.templateGet",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.templateInstall",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.webhook",
        "workflows.crud",
        Some("workflows:crud"),
        false,
        true,
    ),
    m(
        "workflows.run",
        "workflows.runstate",
        Some("workflows:runstate"),
        false,
        true,
    ),
    m(
        "workflows.runGet",
        "workflows.runstate",
        Some("workflows:runstate"),
        false,
        true,
    ),
    m(
        "workflows.resume",
        "workflows.runstate",
        Some("workflows:runstate"),
        false,
        true,
    ),
    m(
        "workflows.agents",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "workflows.apps",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "workflows.mcp",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "workflows.skills",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "workflows.schedules",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    // The scoped organization roster behind the NotifyUser workflow recipient
    // picker. It is read-only and carries the same workflows:catalogs grant as
    // the other node-config pickers; Core still authorizes and re-validates the
    // final member set when the workflow runs.
    m(
        "workflows.notifyTargets",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "workflows.composio",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    // The app-event catalog behind the `event` workflow trigger's picker: every
    // event any ENABLED app declares in its `contributes.hook_events`. Another
    // read-only node-config picker, so it joins the existing `workflows.catalogs`
    // capability rather than minting a new one — the canvas already holds it, and a
    // separate grant would gate a strictly-less-sensitive read than the ones it
    // already makes.
    m(
        "workflows.hookEvents",
        "workflows.catalogs",
        Some("workflows:catalogs"),
        false,
        true,
    ),
    m(
        "ghost.recordStart",
        "ghost.record",
        Some("ghost:record"),
        false,
        true,
    ),
    m(
        "ghost.recordStatus",
        "ghost.record",
        Some("ghost:record"),
        false,
        true,
    ),
    m(
        "ghost.recordStop",
        "ghost.record",
        Some("ghost:record"),
        false,
        true,
    ),
    m(
        "ghost.recipes",
        "ghost.record",
        Some("ghost:record"),
        false,
        true,
    ),
    m(
        "webhooks.list",
        "webhooks.crud",
        Some("webhooks:crud"),
        false,
        true,
    ),
    m(
        "webhooks.ingressStatus",
        "webhooks.crud",
        Some("webhooks:crud"),
        false,
        true,
    ),
    m(
        "webhooks.secretGet",
        "webhooks.crud",
        Some("webhooks:crud"),
        false,
        true,
    ),
    m(
        "webhooks.secretSet",
        "webhooks.crud",
        Some("webhooks:crud"),
        false,
        true,
    ),
    m(
        "quests.list",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.create",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.update",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.delete",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.complete",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.dismiss",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.acceptSuggestion",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.dismissSuggestion",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.judge",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.openDetectionSettings",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    // Capture is split out of `quests.crud` on purpose: writing a todo is not the
    // same reach as keeping text the user selected in ANOTHER app, which is what a
    // capture carries. An app that only needs the board holds `quests:crud` and
    // cannot capture.
    m(
        "quests.capture",
        "quests.capture",
        Some("quests:capture"),
        false,
        true,
    ),
    m(
        "quests.use",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.pin",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.scratchpad",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "quests.setScratchpad",
        "quests.crud",
        Some("quests:crud"),
        false,
        true,
    ),
    m(
        "activity.list",
        "activity.read",
        Some("activity:read"),
        false,
        true,
    ),
    m(
        "activity.openSession",
        "activity.read",
        Some("activity:read"),
        false,
        true,
    ),
    m(
        "background.list",
        "background.control",
        Some("background:control"),
        false,
        true,
    ),
    m(
        "background.stop",
        "background.control",
        Some("background:control"),
        false,
        true,
    ),
    m(
        "timeline.list",
        "timeline.read",
        Some("timeline:read"),
        false,
        true,
    ),
    m(
        "timeline.journal",
        "timeline.read",
        Some("timeline:read"),
        false,
        true,
    ),
    m(
        "timeline.frame",
        "timeline.read",
        Some("timeline:read"),
        false,
        true,
    ),
    m(
        "timeline.openReview",
        "timeline.read",
        Some("timeline:read"),
        false,
        true,
    ),
    m(
        "timeline.openSettings",
        "timeline.read",
        Some("timeline:read"),
        false,
        true,
    ),
    m("mail.list", "mail.crud", Some("mail:crud"), false, true),
    m("mail.messages", "mail.crud", Some("mail:crud"), false, true),
    m("mail.create", "mail.crud", Some("mail:crud"), false, true),
    m("mail.delete", "mail.crud", Some("mail:crud"), false, true),
    m(
        "mail.rotateSecret",
        "mail.crud",
        Some("mail:crud"),
        false,
        true,
    ),
    m("mail.send", "mail.crud", Some("mail:crud"), false, true),
    m(
        "mail.inboundUrl",
        "mail.crud",
        Some("mail:crud"),
        false,
        true,
    ),
    m(
        "calendar.jobs",
        "calendar.crud",
        Some("calendar:crud"),
        false,
        true,
    ),
    m(
        "calendar.workflows",
        "calendar.crud",
        Some("calendar:crud"),
        false,
        true,
    ),
    m(
        "calendar.agents",
        "calendar.crud",
        Some("calendar:crud"),
        false,
        true,
    ),
    m(
        "calendar.createAutomation",
        "calendar.crud",
        Some("calendar:crud"),
        false,
        true,
    ),
    // Warmup — the `@ryu/warmup` companion schedules a keep-alive ping to each
    // subscription agent so its rolling usage window is already open. `detect`
    // reads agents + their usage windows + advertised models; `list`/`apply`
    // read and replace the app's own scheduler jobs; `runNow` fires one ping
    // outside the schedule.
    m(
        "warmup.detect",
        "warmup.crud",
        Some("warmup:crud"),
        false,
        true,
    ),
    m(
        "warmup.list",
        "warmup.crud",
        Some("warmup:crud"),
        false,
        true,
    ),
    m(
        "warmup.apply",
        "warmup.crud",
        Some("warmup:crud"),
        false,
        true,
    ),
    m(
        "warmup.runNow",
        "warmup.crud",
        Some("warmup:crud"),
        false,
        true,
    ),
    m(
        "learning.config",
        "learning.crud",
        Some("learning:crud"),
        false,
        true,
    ),
    m(
        "learning.experience",
        "learning.crud",
        Some("learning:crud"),
        false,
        true,
    ),
    m(
        "learning.healing",
        "learning.crud",
        Some("learning:crud"),
        false,
        true,
    ),
    m(
        "approvals.list",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "approvals.approve",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "approvals.reject",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "notifications.list",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "notifications.markRead",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "notifications.ack",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "notifications.send",
        "notifications.send",
        Some("notifications:send-to-user"),
        false,
        true,
    ),
    m(
        "suggestions.list",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "suggestions.feedback",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "suggestions.openInChat",
        "approvals.crud",
        Some("approvals:crud"),
        false,
        true,
    ),
    m(
        "meetings.list",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.transcript",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.start",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.finalize",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.delete",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.rename",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.import",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.open",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.openNotes",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    m(
        "meetings.openList",
        "meetings.crud",
        Some("meetings:crud"),
        false,
        true,
    ),
    // Outpost (`@ryu/social`). THREE rows, not one per endpoint: `social.request` is a
    // generic forwarder the host re-issues against Core's `/api/social<path>` public
    // mount, so the sidecar's 33 routes cost one row here instead of 33 six-file
    // changes. It grants no authority that did not exist — that mount already answers
    // any client holding the node token, which is exactly what the host holds — and the
    // real gates stay put: `social:crud` on the verb, and Core's ext-proxy route
    // allowlist on the paths. The two navigation verbs cannot be forwarded (opening a
    // shell tab is the one thing a sandboxed frame genuinely cannot do), so they stay
    // named.
    m(
        "social.request",
        "social.crud",
        Some("social:crud"),
        false,
        true,
    ),
    m(
        "social.open",
        "social.crud",
        Some("social:crud"),
        false,
        true,
    ),
    m(
        "social.openList",
        "social.crud",
        Some("social:crud"),
        false,
        true,
    ),
    // Subtitles (`@ryu/subtitles`). ONE row, the Outpost shape without the navigation
    // verbs: every call the companion makes arrives as `subtitles.request` and the host
    // re-issues it against Core's `/api/subtitles<path>` public mount. It grants no
    // authority that did not exist — that mount already answers any client holding the
    // node token, which is what the host holds — and the gates stay `subtitles:crud` on
    // the verb plus Core's ext-proxy route allowlist on the paths. The companion is the
    // whole surface, so it never needs to open a shell tab.
    m(
        "subtitles.request",
        "subtitles.crud",
        Some("subtitles:crud"),
        false,
        true,
    ),
    // Automated Reasoning (`@ryu/reasoning`). ONE row, the Outpost shape: the
    // companion's calls all arrive as `reasoning.request` and the host re-issues them
    // against Core's `/api/reasoning<path>` public mount. A verb per endpoint would
    // cost seven rows for a surface that is CRUD plus two verbs, and every future
    // route would be a six-file change. It grants nothing new — that mount already
    // answers any client holding the node token, which is what the host holds — and
    // the gates stay `reasoning:check` on the verb plus Core's ext-proxy route
    // allowlist on the paths. There is no navigation verb: the companion is the whole
    // surface, so it never needs to open a shell tab.
    m(
        "reasoning.request",
        "reasoning.check",
        Some("reasoning:check"),
        false,
        true,
    ),
    // Safe Actions is a Core-owned protected surface. The sandboxed Companion can
    // supply only a relative sub-path and a closed HTTP verb; the trusted desktop
    // host fixes the mount at `/api/tools/plans` and keeps the node token.
    m(
        "safeActions.request",
        "safe-actions.manage",
        Some("safe-actions:manage"),
        false,
        true,
    ),
    // Deep Read (`@ryu/rlm`). The same ONE-row forwarder as Reasoning directly above:
    // the companion's calls all arrive as `rlm.request` and the host re-issues them
    // against Core's `/api/rlm<path>` public mount. Ten sidecar routes for one verb,
    // and a route added later costs none. It grants nothing new — that mount already
    // answers any client holding the node token, which is what the host holds — and
    // the gates stay `rlm:query` on the verb plus Core's ext-proxy route allowlist on
    // the paths. No navigation verb: the companion is the whole surface.
    m("rlm.request", "rlm.query", Some("rlm:query"), false, true),
    // Tuition (`@ryu/tuition`) and Wire (`@ryu/news`). The same ONE-row forwarder as
    // Reasoning directly above: every call each companion makes arrives as
    // `<app>.request` and the host re-issues it against that app's `public_mount`.
    // Twenty-four and nineteen sidecar routes respectively would otherwise be
    // forty-three rows across six files, and both surfaces are still growing.
    //
    // Neither grants anything new. The mount already answers any client holding the
    // node token, which is what the host holds; the gates stay the verb's own grant
    // plus Core's ext-proxy route allowlist, which 404s any sub-path the manifest did
    // not declare. Neither has a navigation verb: the companion is the whole surface,
    // so it never needs to open a shell tab.
    m(
        "tuition.request",
        "tuition.crud",
        Some("tuition:crud"),
        false,
        true,
    ),
    m("news.request", "news.crud", Some("news:crud"), false, true),
    // Blueprint (`@ryu/blueprint`). Same ONE-row forwarder as Reasoning directly
    // above and Outpost above that: every call the plan-review companion makes
    // arrives as `blueprint.request` and the host re-issues it against Core's
    // `/api/blueprint<path>` public mount. Eleven sidecar routes — plans, revisions,
    // the revision diff, annotations, the verdict, per-step status, the rendered
    // feedback — would otherwise be eleven rows across six files, and the surface is
    // still growing (revision diff and artifact review are round-two).
    //
    // It grants nothing new: that mount already answers any client holding the node
    // token, which is what the host holds. The gates stay `blueprint:review` on the
    // verb plus Core's ext-proxy route allowlist on the paths — which is the reason
    // the manifest must enumerate every route it wants reachable, not a wildcard.
    // No navigation verb: the companion IS the whole review surface, so it never
    // opens a shell tab.
    m(
        "blueprint.request",
        "blueprint.review",
        Some("blueprint:review"),
        false,
        true,
    ),
    m(
        "skills.getSource",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.create",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.update",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.listVersions",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.versionSource",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.snapshot",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.restore",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    m(
        "skills.setTitle",
        "skills.crud",
        Some("skills:crud"),
        false,
        true,
    ),
    // Shell primitives (grant `shell:integrate`) — the generic `window.ryu.shell.*`
    // lane that gives a DECOUPLED companion the shell-integration privileges a
    // compiled-in first-party panel has: open an allowlisted shell tab, subscribe to
    // the live theme, contribute Cmd+K palette commands, and subscribe to the node
    // event stream. One capability (`shell.integrate`) gates the whole family; the
    // three subscribe/register verbs are STREAMING (host→frame push over the existing
    // chunk path), `openTab` is unary. Host-direct: the desktop host owns the tabs /
    // theme / palette / tab-icon / event-stream seams, so there is no Core bridge fetch (the
    // shell verbs are `ts_host = true` but have no `plugin_bridge_api.rs` branch — like
    // the existing `activity.openSession`/`meetings.open` nav verbs they resolve
    // entirely in the trusted webview). See `docs/renderer-host-slice-1.md`.
    m(
        "shell.openTab",
        "shell.integrate",
        Some("shell:integrate"),
        false,
        true,
    ),
    m(
        "shell.themeSubscribe",
        "shell.integrate",
        Some("shell:integrate"),
        true,
        true,
    ),
    // The host's DISPLAY PREFERENCES, streamed the same way and under the same
    // grant as the theme. Today it carries one field, `friendly` — the app-wide
    // "Friendly names" toggle (Settings → Appearance) that decides whether a
    // surface shows plain language ("Connected search") or the technical term
    // ("Graph"). A sandboxed frame is null-origin and so cannot read the host's
    // `localStorage`, which is where that preference lives; being told is the only
    // way a plugin can match the vocabulary of the app it is embedded in.
    //
    // Named for the CATEGORY, not the field. A verb per preference would mean a
    // contract row, a capability lookup, a dispatch branch and a bridge method
    // every time the shell gains one; `prefsSubscribe` emits a JSON object, so the
    // next preference is one more key that old plugins simply ignore.
    m(
        "shell.prefsSubscribe",
        "shell.integrate",
        Some("shell:integrate"),
        true,
        true,
    ),
    m(
        "shell.registerCommand",
        "shell.integrate",
        Some("shell:integrate"),
        true,
        true,
    ),
    m(
        "shell.registerTabIcon",
        "shell.integrate",
        Some("shell:integrate"),
        true,
        true,
    ),
    m(
        "shell.eventsSubscribe",
        "shell.integrate",
        Some("shell:integrate"),
        true,
        true,
    ),
    // Rust-bridge-only: a declarative-view action relayed to the owning app (the
    // shell's `view.action` intent). Grant-gated (`views:actions`) but NOT a TS
    // app-host method — `ts_host = false` keeps it out of the derived TS tables.
    m(
        "view.action",
        "view.action",
        Some("views:actions"),
        false,
        false,
    ),
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
        assert_eq!(grant_for("agent.runFanout"), Some("hook:run-agent"));
        assert_eq!(grant_for("storage.get"), Some("storage:kv"));
        assert_eq!(grant_for("crypto.seal"), Some("crypto:seal"));
        assert_eq!(grant_for("crypto.open"), Some("crypto:seal"));
        assert_eq!(grant_for("crypto.status"), Some("crypto:seal"));
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
