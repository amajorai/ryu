//! The kernel capability table.

/// One **kernel capability** — a host primitive Core itself implements, invoked over
/// the SAME `POST /api/host/capability/<cap>` seam an app-provided capability uses.
///
/// # Why these are not `provides` entries
///
/// The broker's provider path resolves a capability to another *app*'s sidecar route
/// through [`crate::plugins::binding`]. A kernel capability has no provider app: the
/// implementation is Core's own MCP registry / notify store / Spaces store /
/// recorder subprocess, so there is nothing to bind, nothing to wake, and no hop to
/// forward. It is dispatched IN-PROCESS from [`KERNEL_CAPABILITIES`] *before* the
/// binding registry is consulted.
///
/// Symmetrically, a sidecar must **not** name one in `requires.capabilities`: that
/// field lowers to a concrete app-id graph edge ([`crate::plugins::binding::lower_manifests`])
/// and an unbindable entry fails enable with `Unprovided`. A sidecar declares what it
/// needs through its `sidecars[].host_api.grants` instead — the same declaration
/// `/api/host/model/complete` and `/api/host/rpc` already read.
pub(super) struct KernelCapability {
    /// The capability name the sidecar POSTs to (`/api/host/capability/<cap>`).
    /// Named for the **host primitive**, never for the calling app — that is the
    /// whole point of retiring the per-app `/api/host/<app>/*` rows.
    pub(super) cap: &'static str,
    /// The grant the caller must hold: DECLARED in its `sidecars[].host_api.grants`
    /// **and** Gateway-approved (the [`authorize_host_call`] intersection — never the
    /// manifest claim alone).
    ///
    /// `None` means "no reviewed grant is required for this row", NOT "unguarded".
    /// Every kernel capability is still authenticated by the caller's minted
    /// [`ext_token`] (each handler re-runs [`authenticate_sidecar`]), and a `None` row
    /// carries its own tighter gate instead: ownership (`events.emit`), the active
    /// user's own inbox, or `notifications:send-to-user` for any other recipient
    /// (`notify.deliver`, checked in the handler), Core-derived tenancy
    /// (`billing.recordToolCharge` takes the organization from the registered node,
    /// never the body), or an app pin (`notify.fanout`).
    ///
    /// A `Some(grant)` row is not proof that the grant covers the handler's whole
    /// operation. Some handlers ALSO pin their calling app because the grant is
    /// necessary but not sufficient: `mcp.callTool` (`@ryu/monitors`),
    /// `spaces.fileNotes` (`@ryu/meetings`), `email.*` (`@ryu/mail`) and `ghost.*`
    /// (`@ryu/recipes`). A pin keeps its row single-app, so it is never looser than
    /// the retired per-app route it replaced. The pins are inventoried by
    /// `app_boundary_guard::no_new_kernel_handler_app_pins` and tracked in
    /// `docs/app-boundary-extraction-plan.md`. Replacing one needs reviewed
    /// vocabulary that fits the handler exactly (a Gateway governance change:
    /// `reserved_namespaces` + `default_grant_allowlist` + consent labels), not a Core
    /// one.
    pub(super) grant: Option<&'static str>,
}

/// The kernel-capability table — the Core-implemented half of the broker.
///
/// Every row here replaces one retired `/api/host/<app>/*` route. The handlers live
/// beside the kernel code they expose (`server::app_*`, `recipes_host`), and some
/// still pin their calling app, so the *routing* is generic today and the *tenancy*
/// of a pinned row stays single-app until the Gateway vocabulary has a reviewed
/// grant for it; nothing in this table names an app.
pub(super) const KERNEL_CAPABILITIES: &[KernelCapability] = &[
    // Run one MCP tool through Core's shared `McpRegistry`, which no sidecar can host
    // (it owns the stdio child processes). Body `{ tool, args }` → `{ result }`.
    // `tools.invoke` is the reviewed MCP tool-plane scope in the Gateway allowlist;
    // the `tools` namespace is reserved, so it can never be self-granted by name.
    //
    // `tools.invoke` is necessary but NOT sufficient here. The handler runs the tool
    // with no user, agent, agent allowlist or org policy (`call_tool(.., None)`),
    // unlike `tools.call` below, which requires a verified caller and that user's
    // agent permission. The `@ryu/monitors` pin plus the fixed tool allowlist in
    // `server::app_mcp_call` is the remaining gate; see that module's doc for why no
    // existing grant replaces it.
    KernelCapability {
        cap: "mcp.callTool",
        grant: Some("tools.invoke"),
    },
    // Fan a fired alert out through the kernel notify store (the caller-chosen
    // webhook / Telegram / Expo / email targets + node-wide mobile push +
    // `notification` plugin hooks), copy it into the app inbox, and record it on the
    // unified activity feed as a "monitors" item. Body `{ alert, targets }`.
    //
    // `grant: None` + the handler's `@ryu/monitors` pin. The Gateway's reviewed
    // notification grants each cover a narrower, single-recipient, in-product
    // delivery: `notifications:send` (one bounded notification for the active user,
    // no recipient or channel choice), `notifications:send-to-user` (one member of
    // the resolved org/team, for a verified org caller) and `native:notifications`
    // (a bounded native host effect). None covers caller-chosen external channels,
    // node-wide push, notification hooks and an attributed activity row, and riding
    // an ill-fitting grant would hand that reach to every app that holds it. So the
    // gate stays exactly what the retired `/api/host/monitors/alert` had: minted
    // token + the app pin (`server::app_notify::host_notify_fanout`).
    KernelCapability {
        cap: "notify.fanout",
        grant: None,
    },
    // Deliver a user-targeted notification into the app-inbox feed on behalf of
    // the calling app. Body `{ title, body?, level?, target_user_id? }`. Unlike
    // `notify.fanout` (monitors' EXTERNAL channel fan-out), this writes the row
    // the desktop's Inbox renders, so the app's icon/name shows there. The
    // `source_app_id` stamped on the row is the AUTHENTICATED caller, never a body
    // field. `grant: None` because the row-level gate depends on the recipient:
    // writing to the node's own active user needs only the minted token + the
    // enabled-app check, while naming any OTHER member requires the approved
    // `notifications:send-to-user` grant (checked in `app_notify::deliver_for_app_localized`,
    // which the `events.emit` notify hint shares) plus org-roster membership on a
    // managed node.
    KernelCapability {
        cap: "notify.deliver",
        grant: None,
    },
    // Send through the node-owned email transport. The app supplies message facts;
    // Core owns SMTP preferences, secret custody, timeout, and relay execution.
    KernelCapability {
        cap: "email.send",
        grant: Some("mail:crud"),
    },
    KernelCapability {
        cap: "email.status",
        grant: Some("mail:crud"),
    },
    // Shared DNS-pinned outbound HTTP. App protocols retain their own
    // origin/payment semantics; Core owns URL screening and network safety.
    KernelCapability {
        cap: "egress.fetch",
        grant: Some("egress:http"),
    },
    // Record a provider-neutral external-tool charge. The handler derives the
    // organization from the registered node and forwards the report to Gateway;
    // a sidecar may describe work, but it cannot choose a wallet.
    KernelCapability {
        cap: "billing.recordToolCharge",
        grant: None,
    },
    // Route an app's provider-neutral operation through Core's managed Gateway.
    // The sidecar supplies no provider credential; Gateway resolves it from the
    // provider vault and owns the organization-wallet debit.
    KernelCapability {
        cap: "providers.status",
        grant: Some("tools.invoke"),
    },
    KernelCapability {
        cap: "providers.call",
        grant: Some("tools.invoke"),
    },
    // Ask whether the agent a grant names may use a provider, for an app that
    // reaches it with credentials it holds itself instead of `providers.call`.
    // Same account-access rules; nothing is called.
    KernelCapability {
        cap: "providers.authorize",
        grant: Some("tools.invoke"),
    },
    // Generic visitor-authenticated app tool dispatch. Never an owner/node fallback.
    KernelCapability {
        cap: "tools.call",
        grant: Some("tools.invoke"),
    },
    KernelCapability {
        cap: "plugins.installBundle",
        grant: Some("plugins:install"),
    },
    // File a notes document into a Core-owned system Space under the background
    // owner. Core owns the `SpaceStore` + its tenancy, so a sidecar cannot do this
    // itself. Body `{ title, markdown }` → `{ space_id, doc_id }`.
    //
    // `spaces:docs` is necessary but NOT sufficient: it covers an app's OWN
    // documents (`kind = "app:<plugin_id>"`) under the caller's Space ACL, not a
    // document no app owns, filed into the shared "Meetings" system Space under
    // `background_owner()` with no per-user Space access check. So the handler's
    // `@ryu/meetings` pin stays (`server::app_file_notes`).
    KernelCapability {
        cap: "spaces.fileNotes",
        grant: Some("spaces:docs"),
    },
    // Post a turn on the user's behalf into a REAL conversation. Core owns the chat
    // path + the conversation store, and a sidecar holds no node token, so this is
    // the only way an out-of-process app can send at all. Body
    // `{ text, agent_id?, conversation_id?, model? }` → `{ status, conversation_id }`
    // or `202 { status: "pending_approval", approval_id }`.
    //
    // `chat.sendFollowUp` is the EXISTING reserved sigil for exactly this power (the
    // Gateway's governance defines it as "post a chat turn on the user's behalf"),
    // so it is reused rather than duplicated under a second name. Being reserved is
    // what stops `com.evil.chat` from owner-scoping its way in.
    //
    // The grant is NOT the whole gate: `server::host_chat` additionally scans the
    // prompt through the exec firewall and, by default, routes the send through the
    // Approvals inbox. Spending a subscription unattended should cost more than one
    // approved grant.
    KernelCapability {
        cap: "chat.startTurn",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    // Projects › Bots/Groups › Sessions placement for an app's own turns: find or
    // create a project/bot/group main thread, put a conversation in a project, and
    // write project-scoped model defaults. They only shape where `chat.startTurn`
    // turns land and which model they use, so they reuse its grant
    // (`server::host_hierarchy`).
    KernelCapability {
        cap: "threads.ensureMainThread",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "threads.placeInProject",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "scopeDefaults.set",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "scopeGuidance.set",
        grant: Some(crate::server::host_hierarchy::GRANT_PROJECT_GUIDANCE),
    },
    // The live facts an app needs to decide whether now is a good time to send: the
    // COUNT of active agent runs, and how full each named agent's usage windows
    // are. Core owns both (the conversation store; the vendor usage readers), and a
    // sidecar can reach neither on its own. Body `{ agent_ids: [] }` →
    // `{ running, usage: [{ agent_id, used_percent }] }`.
    //
    // Counts, never contents — see the handler for why that distinction is what
    // makes this safe without a per-user caller identity to ACL-filter by.
    KernelCapability {
        cap: "node.readings",
        grant: Some(crate::server::host_chat::GRANT_NODE_READINGS),
    },
    // Ghost capture/replay — the live native-desktop engine. Replay needs the shared
    // MCP registry; the recording session holds a dedicated recorder subprocess
    // (`McpSession`) in Core's process-global slot ACROSS separate HTTP calls, which
    // is precisely why it cannot live in a stateless sidecar. All four share
    // `ghost:record`, the Gateway's reviewed capture/replay scope.
    KernelCapability {
        cap: "ghost.replay",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStart",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStatus",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStop",
        grant: Some("ghost:record"),
    },
    // Raise an **app event** the calling plugin declared in its manifest
    // `contributes.hook_events`, fanning it out to every plugin hook and workflow
    // that subscribes to it. Body `{ event, payload? }` → `{ event, hooks, workflows }`.
    //
    // A `grant: None` row, for a stronger reason than `notify.fanout`'s: this
    // capability is authorized by **ownership**, which is tighter than any grant
    // could be. `may_emit_event` requires the authenticated caller to be the plugin
    // the event id is namespaced to AND to have declared that exact event in its own
    // manifest, so the widest possible abuse of a stolen grant is "an app emits its
    // own events" — which is the entire intended use. A coarse grant would only
    // blur that, since holding it could never let an app emit someone else's event
    // and lacking it would break the app's only way to emit its own.
    KernelCapability {
        cap: "events.emit",
        grant: None,
    },
    // Publish a bounded named event into the caller's own generic application
    // room. The room key is constructed from the authenticated plugin id, never
    // from the request body, so a sidecar cannot publish into another app's room.
    KernelCapability {
        cap: "realtime.publish",
        grant: Some("app:realtime"),
    },
    // Read Core's inbound-webhook registry and ingress status (Composio receiver +
    // workflow `Webhook` triggers, with resolved public URLs). Metadata only: the
    // signing-secret read/write stays on its per-user ACL-checked route. Gated by
    // the existing `webhooks:crud` grant (`server::app_webhooks`); the same
    // operations answer a Companion's `window.ryu.webhooks.*` through the app
    // host bridge.
    KernelCapability {
        cap: "webhooks.list",
        grant: Some(crate::server::app_webhooks::GRANT_WEBHOOKS),
    },
    KernelCapability {
        cap: "webhooks.ingressStatus",
        grant: Some(crate::server::app_webhooks::GRANT_WEBHOOKS),
    },
    // Warmup over Core's heartbeat scheduler (`server::app_warmup`): detect
    // subscription agents, and list / replace / run-now the CALLER's own jobs
    // (owner = the authenticated plugin id). Gated by the existing `warmup:crud`
    // grant; the scheduler's own `agent.view` / `agent.edit` checks still run, with
    // no user (so they pass only on an unbound single-operator node). The same
    // operations answer a Companion's `window.ryu.warmup.*` through the app host
    // bridge, with the signed-in user.
    KernelCapability {
        cap: "warmup.detect",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.list",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.apply",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.runNow",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    // Run recovery (`server::app_runs`): what a `core#run.failed` subscriber (the
    // Self-Healing sidecar) acts through. Each rides its own reviewed grant:
    // queue a heal approval (closed set of kinds, deduped on the source); re-run a
    // failed agent run under a Core-minted `healrun_` id; re-run a FAILED workflow
    // run (the existing `workflows:runstate`, which `workflows.run` already rides).
    KernelCapability {
        cap: "approvals.request",
        grant: Some(crate::server::app_runs::GRANT_APPROVALS_REQUEST),
    },
    KernelCapability {
        cap: "runs.rerunAgent",
        grant: Some(crate::server::app_runs::GRANT_RERUN_AGENT),
    },
    KernelCapability {
        cap: "workflows.rerun",
        grant: Some(crate::server::app_runs::GRANT_WORKFLOW_RUNSTATE),
    },
    // Agent accounts (`crate::vault::agent_accounts`): release one field of an
    // agent's website account to the sidecar that types it into a page, or store
    // a 2FA seed the sidecar read off a setup page. Both bind to the page origin
    // the sidecar reports and are named for the vault primitive, not the app
    // that fills. The reviewed `vault:fill` grant (a reserved namespace) is the
    // gate; the node bearer never reaches these, so no tool result carries a
    // secret.
    KernelCapability {
        cap: "vault.credentialFill",
        grant: Some(crate::server::vault_agent_accounts_api::GRANT_VAULT_FILL),
    },
    KernelCapability {
        cap: "vault.totpEnroll",
        grant: Some(crate::server::vault_agent_accounts_api::GRANT_VAULT_FILL),
    },
    // Relay a page's WebAuthn ceremony to the owner's desktop security key
    // (`server::security_key_relay`); held until answered, `200` + outcome.
    KernelCapability {
        cap: ryu_webauthn_relay::HOST_CAPABILITY,
        grant: Some(ryu_webauthn_relay::GRANT),
    },
];

/// The [`KernelCapability`] row for `cap`, or `None` when the name belongs to the
/// app-provided (binding-registry) half of the broker.
pub(super) fn kernel_capability(cap: &str) -> Option<&'static KernelCapability> {
    KERNEL_CAPABILITIES.iter().find(|k| k.cap == cap)
}
