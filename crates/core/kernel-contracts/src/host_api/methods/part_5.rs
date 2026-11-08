//! Host API method rows, part 5 of 5: `notifications.send` through `view.action`.
//!
//! [`super::ALL`] joins the parts in order, and that order is the order of
//! `schemas/host-api.json`, so a new row goes where it belongs in the
//! sequence, not at the end of whichever part has room.

use super::super::{m, HostApiMethod};

pub(in crate::host_api) const ROWS: &[HostApiMethod] = &[
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
    // supply only a relative sub-path and a closed HTTP verb. Core's app host
    // bridge dispatches it (user-aware and bridge-only, never a kernel-capability
    // row): Core re-validates the path under the fixed `/api/tools/plans` mount and
    // runs it with the verified signed-in user, whose Safe Actions role is checked
    // on top of this grant and who is recorded as the reviewer.
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
        "skills.distribute",
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
    // Install (or update) a companion-only app bundle that the calling app built,
    // e.g. App Studio's drag-and-drop output. Host-direct: the desktop host
    // validates the bundle (companion runnables only, no sidecar/backend/MCP/hooks,
    // id namespaced `com.local.<caller-segment>.*`) and posts it to Core's generic
    // install-bundle sink, which leaves the app installed but DISABLED, so the
    // user still reviews its grants when they enable it. Same grant the sidecar
    // `plugins.installBundle` kernel capability uses.
    m(
        "apps.installBundle",
        "plugins.install",
        Some("plugins:install"),
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
