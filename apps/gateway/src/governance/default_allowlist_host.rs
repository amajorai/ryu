//! Second half of the built-in default grant allowlist: the host capabilities a
//! plugin or a Companion app reaches across its own namespace.
//!
//! Moved out of `default_grant_allowlist()` in `mod.rs`, which went over the file
//! size limits. `mod.rs` joins `default_allowlist_tools` and this half, in this
//! order, and its doc comment is the review rule for both. A row here is approved
//! for every app id, so a grant that opens another app's data to its holder
//! belongs in `OWNER_EXCLUSIVE_GRANTS` instead.

/// The scopes of this half, in their reviewed order.
pub(super) fn host_capability_scopes() -> Vec<String> {
    [
        // Cross-plugin host capabilities used by seeded UX and usage bridges.
        "app:http",
        // Companion apps use these generic host bridges to reach their own
        // transport surfaces. `app` is reserved, so the owner-scoped rule cannot
        // approve either grant even when the manifest id is `@ryu/<app>`.
        "app:realtime",
        // Cross-app Companion requests (`app.request({ app })`, Host API 1.18):
        // `app:http:<target app id>` lets a Companion call ONE other app's sidecar
        // through the host's ext-proxy forwarder, confined to that app's mount and
        // declared routes. The form is checked in `validate_grants_for` (concrete
        // scoped id, no wildcard) and the owner-scoped rule never approves one.
        // No target is on this list, because a row here is approved for EVERY app
        // id: the one reviewed target, `app:http:@ryu/recipes`, is owner-exclusive
        // for the Workflows Companion (see `mounted_app_grants`).
        // `mail:crud` / `social:crud` are owner-exclusive for cross-app holders
        // (see `crossapp_grants`); Mail and Outpost keep them as protected owners.
        // `warmup:crud` is owner-exclusive (see `OWNER_EXCLUSIVE_GRANTS`): it
        // schedules unattended agent turns, so only the reviewed Warmup app.
        // Owner-tier subscription accounts and cached usage. Core still requires
        // a verified node owner/admin caller. `subscriptions:pin` is reserved
        // and deliberately NOT allowlisted.
        "subscriptions:read",
        "preferences:write",
        "usage:read",
        // Only the verified current caller projection, never credentials or a user roster.
        "identity:read",
        "authorization:defer",
        // Read-only scan of caller-supplied text through the existing firewall.
        "security:check",
        // Widget-render consent: a plugin (built-in Ryu App or third-party MCP
        // server) that declares a `contributes.widgets[]` binding must hold this
        // grant for its tool to auto-promote a sandboxed widget into chat. Gated
        // in Core at the single widget-emit choke point; on the allowlist here so
        // the lifecycle enable path (`/v1/grants/validate`) approves it instead of
        // denying a widget-bearing plugin at enable.
        "widget:render",
        // Host primitives a companion app reaches ACROSS its own namespace:
        // Space documents (whiteboard / canvas / meetings all author them), Core's
        // agent listing, the media engines, and the two turn-hook phases. Every one
        // of these is in a `reserved_namespaces()` family, so the owner-scoped rule
        // never approves them — this reviewed list is the only way to hold them.
        // A fresh install seeds the grant directly, but the runtime
        // disable→re-enable path re-runs `/v1/grants/validate`, so a missing entry
        // shows up as GrantsDenied on re-enable. Swappable via the env override.
        "spaces:docs",
        "spaces:database",
        // Read-only node-config catalogs. `workflows:crud` / `workflows:runstate`
        // are owner-exclusive (see `OWNER_EXCLUSIVE_GRANTS`).
        "workflows:catalogs",
        // `blueprint:review` is owner-exclusive (see `mounted_app_grants`).
        "core:list_agents",
        "media:generate",
        "media:transcribe",
        // Native host effects. These are narrow, bounded actions: haptics,
        // user-visible notifications, and Live Activity / ongoing-status
        // updates. The app-host RPC still checks the per-call input bounds and
        // the receiving surface may report the action as unavailable.
        "native:haptics",
        "native:notifications",
        "native:live_activities",
        // Turn hooks use this grant for the Core-owned in-app/desktop
        // notification feed. It is separate from the native effects above so
        // a plugin can be allowed to notify in-app without receiving phone or
        // browser notification authority.
        "notifications:send",
        // Approvals sends a user-targeted notification through the Core host
        // bridge; it is distinct from the in-app feed grant above.
        "notifications:send-to-user",
        // `rlm:query` is owner-exclusive (see `mounted_app_grants`): Research
        // queries the RLM host plane as a cross-app dependency, and the same grant
        // opens every route of the Deep Read mount to a Companion frame.
        // The two host primitives the seeded `chat-title` plugin needs to do its
        // one job: rename the conversation it just summarised, and read the
        // preferences that say whether (and how often) it should. They gate
        // `host.setConversationTitle` and `host.getPreference` respectively — see
        // `GRANT_SET_TITLE` / `GRANT_PREFERENCES_READ` in
        // `apps/core/src/plugin_host/bridge.rs`.
        //
        // Both are cross-namespace by construction: the declaring app's namespace
        // is `chat-title`, while a conversation and the preference store are
        // Core-owned, so the owner-scoped rule cannot reach them however the app is
        // named — which is the point. `preferences:read` is READ-only and
        // `conversation:set-title` can only rewrite a title on a conversation the
        // caller is already in, so neither widens reach beyond the app's own chat.
        "conversation:set-title",
        // Agent reaction replies use the current conversation binding and the
        // existing Core message-reactions store; the agent cannot choose a
        // different conversation or actor at the host bridge.
        "conversation:reactions",
        "preferences:read",
        // Read-only node activity + subscription usage for the `node.readings` kernel
        // capability. Counts and percentages only — no run titles, ids or folder
        // paths cross it, which is what lets it answer without a per-user caller.
        "core:readings",
        // Post a turn on the user's behalf, into a real conversation. Gates the
        // `chat.startTurn` kernel capability (`apps/core/src/server/host_chat.rs`)
        // — the only way an out-of-process app can send at all, since a manifest
        // sidecar holds no node token.
        //
        // This is the widest grant on this list, and it is here for one reason: the
        // grant is NOT the gate. Core additionally scans the prompt through the exec
        // firewall and, by default (`apps-ask-before-send`), queues the send in the
        // Approvals inbox so the user confirms before a single token is spent. An
        // app that holds this and nothing else can still only ASK to send.
        //
        // `chat` stays a RESERVED namespace, so this exact entry — not an
        // owner-scoped name match — is what allows it; `com.evil.chat` gets nothing
        // from being called that.
        "chat.sendFollowUp",
        // Read-only sub-agents only: Core's bridge refuses a mutating preset
        // (`code_write`) unless the app ALSO holds `hook:run-agent:write`, which is
        // deliberately absent from this list (see `RUN_AGENT_WRITE_OWNERS`).
        "hook:run-agent",
        "hook:side-model",
        // `host.runHook` is restricted to the seeded `@ryu/chat-title` plugin;
        // it is intentionally not part of the marketplace-wide allowlist.
        // Ghost record→replay: the `@ryu/workflows` RecordToWorkflow flow captures
        // a native-desktop action sequence into a recipe. Cross-namespace (the
        // `ghost` capture plane is a host primitive, not the Workflows app's own
        // surface), and split from `workflows:*` so a workflow app that does not use
        // ghost capture need not hold it.
        "ghost:record",
        // Core's `/api/quests/*` auto-detecting-todo orchestration. On the list
        // because `@ryu/approvals` holds it **cross-app** for the quest-task
        // section of the unified inbox — quests are a Core-owned domain, so the
        // reserved-namespace rule sends every holder (including `@ryu/quests`)
        // through this reviewed entry rather than the owner-scoped rule.
        "quests:crud",
        // Keeping text the user selected in ANOTHER app. Split from `quests:crud`
        // and reviewed separately because the reach is different in kind: board
        // CRUD touches the app's own records, a capture carries arbitrary content
        // out of whatever the user was looking at. `@ryu/approvals` holds
        // `quests:crud` for the inbox's task check-off and deliberately does NOT
        // hold this.
        "quests:capture",
        // Run recovery, the Self-Healing extraction (`@ryu/healing`).
        //
        // `runs:failures` is owner-exclusive (see `OWNER_EXCLUSIVE_GRANTS`): the
        // `core#run.failed` event carries the instruction and output of EVERY
        // member's failed runs node-wide, including private ones.
        // `approvals:request` queues a proposed fix into the Approvals inbox
        // through the `approvals.request` kernel capability. Distinct from the
        // owner-scoped `approvals:crud` (list/approve/reject the inbox): a holder
        // can only ASK, a human still decides, and Core builds the request (kind,
        // deferred action) from a closed set, never from free-form input. The
        // `approvals` namespace is protected, so only this exact entry allows it
        // for any app other than `@ryu/approvals`.
        "approvals:request",
        // `runs:rerun-agent` is owner-exclusive (see `OWNER_EXCLUSIVE_GRANTS`).
        // Workflow re-runs reuse the reviewed `workflows:runstate` above.
        // Shell integration: a companion app that contributes a sidebar section /
        // navigation entry to the host shell declares this. Reaching into the host
        // shell is by definition outside the app's own namespace, so it stays a
        // reviewed host primitive. Seeded by four built-in fixtures (`activity`,
        // `approvals`, `skill-editor`, `timeline`). This is what
        // `every_builtin_fixture_grant_is_allowlisted` caught.
        "shell:integrate",
        // A durable key/value store scope declared by the seeded chat-hook
        // plugins (`goal`, `proof`) so they can persist run state. Same re-enable
        // rationale as the companion scopes above. Swappable via the env override.
        "storage:kv",
        // App/tenant-scoped encrypted snapshots to operator-approved destinations.
        // No node backups, other apps, filesystem paths, or credential access.
        "backups:app",
        // The sealing primitive: an app seals/opens its OWN data under a per-plugin
        // subkey Core derives and the app never holds (`host.crypto_*`). On the
        // allowlist rather than owner-scoped because `crypto` is a RESERVED
        // namespace — without an entry here no app could hold it without a Gateway
        // Rust edit, which is the per-app-string anti-pattern this list warns about.
        //
        // Reviewed as SAFE to hand out broadly, which is unusual for this list and
        // worth stating: it grants no reach outside the app's own data and no way to
        // read a key. It strictly REDUCES what a stolen disk yields, so gating it
        // tightly would push apps toward the plaintext path instead — the opposite
        // of the intent. Swappable via the env override.
        "crypto:seal",
        // The follow-up-message scope declared by the seeded widget companion
        // plugins (`checklist`, `chart-studio`, `data-grid-explorer`,
        // `decision-wizard`, `worktree-diff-review`), which post a follow-up chat
        // turn from their sandboxed frame. On the allowlist so a runtime
        // disable→re-enable of a widget companion is approved, not denied with
        // GrantsDenied. Swappable via the env override.
        "chat.sendFollowUp",
        // The assistant-bridge scope: an app describes its own page to the global
        // Ask Ryu panel (context, its own instructions while that page is open,
        // opening/asking). Allowlisted rather than owner-scoped because
        // `assistant` is a RESERVED namespace — without an entry here NO app could
        // ever hold it without a Gateway Rust edit, which is the per-app-string
        // anti-pattern this list's doc warns about. The power is bounded: an app
        // only ever writes into its OWN context slice, the write is capped and
        // cleared when its surface unmounts, and nothing reads the conversation
        // back. Swappable via the env override.
        "assistant:context",
        // The Browser app (`@ryu/browser`) exposes a real-Chromium Electron
        // sidecar as the grant-gated `browser.control` capability (list/open/
        // navigate tabs, screenshot, read titles, evaluate JS), which the desktop
        // Browser panel drives through the ext-proxy. The `browser` namespace is
        // RESERVED (it also carries the identity-vault `browser.connect` flow above),
        // so this one is not owner-scoped even though the declaring app is
        // `@ryu/browser` — driving a real browser is too close to the credential
        // plane to hand out on a name match. Swappable via the env override.
        "browser:control",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}
