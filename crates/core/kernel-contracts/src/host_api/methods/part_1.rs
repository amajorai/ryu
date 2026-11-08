//! Host API method rows, part 1 of 5: `files.read` through `crypto.open`.
//!
//! [`super::ALL`] joins the parts in order, and that order is the order of
//! `schemas/host-api.json`, so a new row goes where it belongs in the
//! sequence, not at the end of whichever part has room.

use super::super::{m, HostApiMethod};

pub(in crate::host_api) const ROWS: &[HostApiMethod] = &[
    m("files.read", "file.access", None, false, true),
    m("files.write", "file.access", None, false, true),
    m(
        "authorization.issue",
        "authorization.defer",
        Some("authorization:defer"),
        false,
        false,
    ),
    m(
        "authorization.check",
        "authorization.defer",
        Some("authorization:defer"),
        false,
        false,
    ),
    // Verified current caller only; no caller-chosen identity or roster lookup.
    m(
        "identity.current",
        "identity.read",
        Some("identity:read"),
        false,
        false,
    ),
    m(
        "security.check",
        "security.check",
        Some("security:check"),
        false,
        false,
    ),
    m(
        "backups.destinations",
        "backups.app",
        Some("backups:app"),
        false,
        true,
    ),
    m(
        "backups.create",
        "backups.app",
        Some("backups:app"),
        false,
        true,
    ),
    m(
        "backups.list",
        "backups.app",
        Some("backups:app"),
        false,
        true,
    ),
    m(
        "backups.get",
        "backups.app",
        Some("backups:app"),
        false,
        true,
    ),
    m(
        "backups.restore",
        "backups.app",
        Some("backups:app"),
        false,
        true,
    ),
    // Local browser/native host capabilities. These rows are intentionally
    // grant-free; the host decides whether the concrete surface can provide
    // them, while the contract still keeps the method vocabulary closed.
    m("host.capabilities", "host.capabilities", None, false, true),
    // Read-only locale and translation primitives. These are local host
    // capabilities: a plugin can ask how the shell is speaking, translate its
    // own namespaced messages with an explicit English fallback, and subscribe
    // to locale changes. No user data, network, or manifest grant is involved.
    m("i18n.get", "i18n", None, false, true),
    m("i18n.translate", "i18n", None, false, true),
    m("i18n.subscribe", "i18n", None, true, true),
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
    // Generic companion → sidecar HTTP. The trusted host derives the target from
    // the owning plugin id and Core's ext-proxy still enforces the manifest route
    // allowlist, so the frame supplies only a relative path/method/body.
    //
    // 1.18 (additive): an optional `app` names ANOTHER app's sidecar. The host
    // then requires the reviewed per-target grant `app:http:<app id>` (a concrete
    // scoped id, each one on the Gateway allowlist) from the approved set instead
    // of `app:http`, which keeps covering only the caller's own sidecar. Holding a
    // per-target grant unlocks this verb's capability; the host's target check is
    // what confines it to that one app, and the path stays inside that app's
    // `/api/ext/<app id>` mount.
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
        "ui.updateModelContext",
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
];
