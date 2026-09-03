//! Marketplace governance: grant validation + manifest signing (#468, ties #450).
//!
//! CLAUDE.md §1 places "what is allowed/shared/measured/paid for" in the
//! Gateway. Publishing an App to the Ryu Marketplace is a *governed* action, so
//! the two governance primitives it needs live here, reached over HTTP by the
//! control-plane server (publish) and by Core (verify-on-install):
//!
//!   - **Grant validation** (`validate_grants_for`): the manifest declares the
//!     permission grants it wants (tool/capability scopes). The Gateway checks
//!     them against its grant policy and returns `{ approved, denied }`. A
//!     non-empty `denied` blocks publish. This fills the seam Core's plugin
//!     lifecycle already calls (`POST /v1/grants/validate`,
//!     `apps/core/src/plugins/lifecycle.rs`), which until now only had a
//!     `RYU_STUB_GRANT_VALIDATION` allow-all stub on the Core side.
//!
//! **The capability grammar (replaces the per-app allowlist).** Grant policy
//! used to be a single hand-maintained list of every capability string any
//! first-party app declared — `monitors:crud`, `workflows:crud`,
//! `simulator:control`, … — matched by exact string. That list grew by one entry
//! per shipped app, and a **third-party** app declaring its own capability could
//! be installed but never enabled (Core aborts enable with `GrantsDenied`)
//! without an operator setting `RYU_MARKETPLACE_GRANT_ALLOWLIST`. Every new app
//! meant a Gateway Rust edit, which is exactly what `AGENTS.md` forbids.
//!
//! The policy is now two rules, evaluated per scope (see
//! [`ryu_gw_governance::validate_grants_for`]):
//!
//!   1. **Reviewed allowlist** — [`default_grant_allowlist`], or the
//!      `RYU_MARKETPLACE_GRANT_ALLOWLIST` operator override. This is now
//!      *host-primitive vocabulary* (`model.*`, `memory.*`, `mcp:*`,
//!      `tool:command:*`, `hook:*`, `widget:render`, …), not per-app strings, so
//!      it does not grow when an app ships.
//!   2. **Owner-scoped self-grant** — a plugin declaring a capability in its own
//!      namespace (the last dot-segment of its manifest id: `@ryu/monitors` ⇒
//!      `monitors:*`) is approved with no policy entry at all. This is what
//!      unblocks a third-party marketplace.
//!
//! [`reserved_namespaces`] is the fence between them: a namespace naming a host
//! primitive can never be claimed by rule 2, so `com.evil.memory` cannot
//! self-approve `memory.read` and `sidecar:process` (arbitrary code execution)
//! stays unapprovable by any rule. Nothing in the privileged set got more
//! permissive; only app-owned namespaces did.
//!
//!   - **Manifest signing** (`sign_manifest` / `verify_manifest`): the Gateway
//!     owns the signing key (ed25519). On publish it signs the manifest; on
//!     install Core asks the Gateway to verify the signature, so a manifest
//!     tampered with anywhere along TS -> Mongo -> Core is rejected.
//!
//! Both sign and verify canonicalize the manifest (recursively sorted object
//! keys) before hashing, so re-serialization across the stack (Mongo, JSON
//! round-trips) never changes the signed bytes. Doing both here keeps one
//! canonicalization code path.
//!
//! **Decomposition (W6): the pure crypto moved out.** The grant-allowlist
//! *matching*, the ed25519 sign / verify over the canonicalized encoding, the
//! canonicalization itself, and the seed / public-key parsers were extracted to
//! the [`ryu_gw_governance`] crate — everything that operates over caller data
//! and *explicit* keys / allowlists. What stays here is the **key custody + the
//! allowlist policy** (the marketplace trust root, kept where the secret lives):
//! the `RYU_MARKETPLACE_SIGNING_KEY` env source-of-truth, the dev-persisted
//! on-disk key, the process `OnceLock`, and the built-in default grant
//! allowlist. The `sign_manifest` / `verify_manifest` / `validate_grants` /
//! `public_key_b64` functions below are thin wrappers that resolve the
//! key/allowlist and delegate to the crate, so `crate::governance::…` call
//! sites are byte-unchanged. `GrantDecision` and `SIGNING_ALGORITHM` are
//! re-exported from the crate.

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::SigningKey;
use serde_json::Value;

use ryu_gw_governance::{signing_key_from_seed, verifying_key_from_b64, GrantPolicy};
pub use ryu_gw_governance::{GrantDecision, SIGNING_ALGORITHM};

/// Env var holding the ed25519 signing seed (32-byte secret), base64-encoded.
/// The production source of truth: set it and every gateway replica signs with
/// the same key, so signatures survive restarts and horizontal scale. When
/// unset the Gateway falls back to a **dev-persisted** key on disk (see
/// [`signing_key`]) so signatures still survive a local restart. No secret is
/// ever in code.
const ENV_SIGNING_KEY: &str = "RYU_MARKETPLACE_SIGNING_KEY";

/// Optional override for the on-disk dev-persisted signing key path. When unset
/// the key lives at `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the
/// audit db location in `config.rs`). Only consulted when `ENV_SIGNING_KEY` is
/// unset. No secret is ever in code.
const ENV_SIGNING_KEY_PATH: &str = "RYU_MARKETPLACE_SIGNING_KEY_PATH";

/// Env var holding a comma/whitespace-separated allowlist of permission grants
/// the marketplace will approve. When unset a sensible built-in default
/// allowlist is used (see [`default_grant_allowlist`]). A grant that is neither
/// on the allowlist nor an owner-scoped self-grant is denied, which blocks
/// publish (and, on Core's side, enable).
const ENV_GRANT_ALLOWLIST: &str = "RYU_MARKETPLACE_GRANT_ALLOWLIST";

/// Escape hatch back to the pre-grammar posture: set to `0`/`false`/`no` and the
/// owner-scoped self-grant rule is switched off entirely, so ONLY the allowlist
/// (built-in or `RYU_MARKETPLACE_GRANT_ALLOWLIST`) approves anything. For an
/// operator who wants a hand-curated, closed capability set on a locked-down
/// deployment. Default on.
const ENV_OWNER_SCOPED_GRANTS: &str = "RYU_MARKETPLACE_OWNER_SCOPED_GRANTS";

/// Namespaces that name a **host primitive** — something Core or the Gateway
/// itself implements — rather than an app's own surface. A reserved namespace is
/// never claimable by the owner-scoped self-grant rule, whatever a manifest
/// calls itself: `com.evil.memory` cannot self-approve `memory.read`, and
/// `com.evil.sidecar` cannot self-approve `sidecar:process`. Scopes in these
/// namespaces are approvable **only** through [`default_grant_allowlist`] or the
/// `RYU_MARKETPLACE_GRANT_ALLOWLIST` override — exactly as gated as before the
/// grammar existed.
///
/// This is *vocabulary*, not a per-app registry: it enumerates the host's own
/// capability families, so it does not grow when an app ships. Adding an app
/// never touches this list; adding a new **host primitive family** does.
///
/// Matching is on the namespace token only (the part before the first `:` or
/// `.`) and is separator-agnostic on purpose: `browser.connect` (identity-vault
/// primitive) and `browser:control` (the Browser app's sidecar capability) share
/// the `browser` token, and reserving the token gates both rather than letting a
/// squatter pick the sigil that happens to be unreserved.
fn reserved_namespaces() -> Vec<String> {
    [
        // Arbitrary code execution: an unsandboxed managed process from a
        // manifest. Deliberately on NO default allowlist — reserved here so the
        // grammar cannot ever make it self-approvable.
        "sidecar",
        // `sidecar`'s code-execution sibling: `runtime:external` is what Core's
        // `sidecar/external_runtime.rs::may_provision` checks before a
        // Community-tier plugin may create a venv, `pip install` from its
        // manifest, and fetch declared assets. Same arbitrary-code-execution
        // class as `sidecar:process` and, like it, on NO default allowlist — so
        // reserving the namespace is what keeps `com.evil.runtime` from naming
        // its way into it.
        "runtime",
        // Agent-scaffolding write scope (`self_build:write`, checked by Core's
        // `runnable/self_build.rs`). Privileged, on no default allowlist.
        "self_build",
        // Model / data / egress primitives the Gateway governs.
        "model",
        "memory",
        "spaces",
        "files",
        "identity",
        "network",
        // Core-owned DNS-pinned HTTP for app protocols. The app may still own
        // origin/payment semantics, but it cannot self-approve the network seam.
        "egress",
        // Tool-plane primitives: `tool:command:<bin>` is local process exec and
        // `tool:http-egress:<host>` is network egress, so neither may ever be
        // owner-scoped; `tools.*` / `mcp:*` / `mcp.*` are the MCP tool plane.
        "tool",
        "tools",
        "mcp",
        // `pi:extension` ships a .ts file into the managed Pi agent's extension
        // directory, where Pi loads it IN-PROCESS with full host privilege — the
        // same arbitrary-execution class as `mcp:server`, and the reason Core
        // gates it on tier (`may_ship_pi_extensions`). Reserving the namespace is
        // the half that makes that gate real: without it, Rule 2's owner-scoped
        // self-grant approves `pi:extension` with no allowlist entry for any
        // plugin whose id's last segment is `pi` (`@evil/pi`, `com.evil.pi`,
        // bare `pi`), so a Community plugin could grant itself the capability and
        // Core would then honour it. `mcp` is on this list for exactly this
        // reason; `pi` was omitted, which made the "operator-only" claim in
        // pi_config/app_extensions.rs false until now.
        "pi",
        // The warmup bridge is a Core-owned host capability. Keep the namespace
        // reserved so an app such as `com.evil.warmup` cannot self-approve it.
        "warmup",
        // Turn-hook phases, host-shell integration, the app KV store, the
        // follow-up-message verb, sandboxed widget promotion, media engines,
        // native-desktop capture/replay, and Core's own listing verbs.
        "hook",
        // Native effects are a host primitive rather than an app-owned
        // namespace. The exact actions are reviewed below; reserving the
        // namespace prevents an app named `native` from self-approving them.
        "native",
        "shell",
        "storage",
        "chat",
        "widget",
        "media",
        "ghost",
        "core",
        // The host UI/shell plane a sandboxed frame reaches through
        // `/api/plugins/:id/host`: `ui:render` (promote a frame), `ui:send_message`
        // (post a chat turn on the user's behalf — the same power the reserved
        // `chat.sendFollowUp` gates, so the two sigils must be fenced alike) and
        // `views:actions` (relay a declarative-view intent to the owning app).
        // All three are host verbs in `ryu-kernel-contracts::host_api`, none is on
        // a default allowlist, and no manifest declares them — they are injected
        // for MCP widget bridges. Reserved so a manifest cannot declare its way in.
        "ui",
        "views",
        // `assistant:context` lets an app steer the ONE global Ask Ryu surface:
        // publish what its page is showing (text that lands inside the user's
        // prompt), lend the assistant its own instructions while that page is
        // open, and — with `assistant.open({ prompt })` — post a turn on the
        // user's behalf. That last power is precisely what `chat.sendFollowUp`
        // and `ui:send_message` gate, so the sigil is fenced alike: reserved, so
        // Rule 2's owner-scoped self-grant cannot hand it to `com.evil.assistant`
        // on a name match.
        "assistant",
        // The browser namespace covers the identity-vault connect flow
        // (`browser.connect`) as well as the Browser app's sidecar control.
        "browser",
        // Core-owned data domains that a NON-owner app legitimately reads or
        // drives (`@ryu/skill-editor` holds `skills:crud`, `@ryu/approvals`
        // holds `quests:crud`), so they are host vocabulary rather than an app's
        // own namespace.
        "skills",
        "quests",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Built-in default grant allowlist: the **host-primitive vocabulary** a plugin
/// may hold. Every scope here is either in a [`reserved_namespaces`] family (so
/// the grammar refuses to self-approve it) or a cross-app capability a
/// first-party app legitimately holds. Anything outside this set is denied
/// unless it is an owner-scoped self-grant, so an over-privileged manifest
/// cannot publish.
///
/// **What is deliberately NOT here.** The per-app companion capabilities
/// (`monitors:crud`, `simulator:control`, `webhooks:crud`,
/// `activity:read`, `timeline:read`, `calendar:crud`, `learning:crud`,
/// `approvals:crud`, `meetings:crud`, `finetune:runs`) used to be
/// listed one-by-one, which meant every new App — including a third-party one —
/// needed a Gateway Rust edit before it could ever be enabled. They are now
/// approved by the owner-scoped rule in
/// [`ryu_gw_governance::validate_grants_for`] because each is declared by the
/// app whose id ends in the same namespace segment (`@ryu/monitors` ⇒
/// `monitors:*`). Do not re-add per-app strings here: if a first-party app's
/// capability is denied, either its namespace does not match its id (rename one
/// of them) or the capability is genuinely a host primitive and belongs in
/// [`reserved_namespaces`] plus this list.
fn default_grant_allowlist() -> Vec<String> {
    [
        // tool / MCP capability scopes
        "mcp.tools",
        "tools.read",
        "tools.invoke",
        // The UI host primitives are reserved as a namespace, but these two
        // reviewed frame capabilities are intentionally shared by shipped apps.
        "ui:toast",
        "ui:declarative-http",
        // Shared Core egress used by protocol apps such as MPP. This is distinct
        // from vendor-scoped `tool:http-egress:<host>` grants: the host guard is
        // generic, while the calling app supplies its own higher-level allowlist.
        "egress:http",
        // Per-server MCP tool grants that the seeded system MCP-tool plugins
        // declare in their `permission_grants` (`spider`, `agentbrowser`,
        // `ghost`, `shadow`). `mcp` is a RESERVED namespace (the MCP tool plane
        // is a host primitive, and `mcp:<name>` names someone else's server), so
        // the owner-scoped rule never covers these even for a plugin whose id IS
        // the server name — each needs its own exact entry here. Without them a
        // runtime disable→re-enable (which re-runs
        // `/v1/grants/validate` with the app's full declared grant set) is denied
        // with GrantsDenied. Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST`
        // env override. (Test-only `sample.manifest.json` is not seeded, so its
        // `mcp:web_search`/`mcp:file_read` are intentionally NOT here.)
        "mcp:spider",
        "mcp:agentbrowser",
        // `@ryu/news` and `@ryu/tuition` are apps rather than plugins, but they hit
        // the same rule for the same reason: each declares its OWN server in
        // `mcp_servers` (`news`, `tuition`) and grants itself `mcp:<that server>`.
        // Owning the server does not help — `mcp` is reserved, so the owner-scoped
        // rule skips it and the exact string has to be here or a disable→re-enable
        // is denied with GrantsDenied.
        "mcp:news",
        "mcp:tuition",
        // `@ryu/rlm` (the Automated Reasoning app) is the same case again: it declares
        // its own `rlm` server in `mcp_servers` and grants itself `mcp:rlm`. Reserved
        // namespace, so owning the server buys nothing — the exact entry is what keeps
        // its disable→re-enable from failing with GrantsDenied.
        "mcp:rlm",
        // `exa` is a declarative `http` plugin (fixtures/exa.manifest.json), so it
        // declares an egress grant, not an `mcp:<name>` server grant — its enable
        // path validates this exact scope instead.
        "tool:http-egress:api.exa.ai",
        // Exa's PUBLIC MCP endpoint, which needs no API key. `exa` is the one search
        // provider shipped default-ON, so it must work with zero setup; its binding
        // falls back here when RYU_EXA_API_KEY is unset. A separate host from
        // api.exa.ai, so it needs its own exact entry.
        "tool:http-egress:mcp.exa.ai",
        // The other BYOK providers of the swappable web layers, same shape as `exa`:
        // declarative `http` plugins whose only grant is egress to one vendor host.
        // Each needs its OWN exact entry — `tool:http-egress:<host>` names a remote
        // host, not the plugin's own namespace, so the owner-scoped rule never
        // covers it. Omitting one does not fail at install; it fails later, on the
        // disable→re-enable path that re-validates the full declared grant set, with
        // a GrantsDenied that reads like an unrelated permissions problem.
        "tool:http-egress:api.tavily.com",
        "tool:http-egress:api.search.brave.com",
        "tool:http-egress:api.firecrawl.dev",
        "tool:http-egress:google.serper.dev",
        "tool:http-egress:scrape.serper.dev",
        // `parallel` serves `web.search` from two hosts, not one: the keyed Search
        // API (`api.parallel.ai`) and the keyless free endpoint its binding falls
        // back to when RYU_PARALLEL_API_KEY is unset (`search.parallel.ai`). Two
        // hosts, so two exact entries — one covers neither the other nor the
        // re-enable path that validates the whole declared set.
        "tool:http-egress:api.parallel.ai",
        "tool:http-egress:search.parallel.ai",
        // `spidercloud` is the hosted half of the same engine the `spider` CLI plugin
        // shells out to, and the second `web.crawl` provider. It is a declarative
        // `http` plugin, so it needs an egress entry here even though its CLI sibling
        // is covered by `tool:command:spider` below — the two grants name different
        // things and neither implies the other.
        "tool:http-egress:api.spider.cloud",
        // `mem0` is the same shape, for the swappable `memory` layer rather than a
        // web one: a declarative `http` plugin whose only grant is egress to Mem0's
        // single API host (`https://api.mem0.ai/` — the `servers` entry in Mem0's own
        // OpenAPI, covering both `/v3/memories/search/` and `/v1/memories/{id}/`).
        "tool:http-egress:api.mem0.ai",
        // `honcho` is the same shape again, and the first `memory` provider that
        // serves `memory.context`. One host covers both its tools: the `servers`
        // entry in Honcho's own OpenAPI is `https://api.honcho.dev` (Production SaaS
        // Platform), carrying `/v3/workspaces/{ws}/peers/{peer}/chat` and
        // `/v3/workspaces/{ws}/peers/{peer}/search`.
        "tool:http-egress:api.honcho.dev",
        // `spider` and `rtk` were decoupled from Core into declarative `command`
        // tool plugins, so each declares a `tool:command:<bin>` grant instead of
        // its old in-Core provider. Same re-enable rationale as the scopes above.
        "tool:command:spider",
        "tool:command:rtk",
        "tool:command:bws",
        // Ship-code-in-a-manifest, for BOTH an `inline_deno` tool and a capability
        // ADAPTER (the JS a layer provider ships when its shape — an async job API,
        // a token vocabulary — is beyond what the declarative binding fields can
        // express). Deliberately allowlisted rather than owner-scoped: an adapter is
        // grant-gated precisely so shipping code stays a visible, approvable act,
        // and a plugin self-approving it would defeat that.
        "tool:execute",
        // `advisor` and `shadow` were decoupled into declarative `http` tools that
        // call Core-local bridges (/api/advisor/consult and the shadow proxy), so
        // both declare loopback egress rather than an `mcp:<name>` grant. `bytebot`
        // (the second `computer.control` provider) shares this ONE entry: it reaches
        // Bytebot's `bytebotd` daemon at 127.0.0.1:9990 — a third-party process, not
        // a Core bridge — so do not delete this line as "advisor/shadow only". The
        // grant names a HOST, not a port, so loopback egress is granted wholesale
        // here and the URL in the manifest is what pins the port.
        "tool:http-egress:127.0.0.1",
        "mcp:ghost",
        "mcp:shadow",
        // The Blueprint app's own MCP server (`blueprint.plan_publish` /
        // `plan_status` / `plan_get` / `step_update`), declared in
        // `apps-store/blueprint/manifest.json`. This is NOT the per-app-string
        // anti-pattern the doc above warns about, and the distinction is the reserved
        // `mcp` namespace: an app's OWN capability (`blueprint:review`) is approved by
        // the owner-scoped rule on a name match, but `mcp:<name>` names a SERVER, and
        // the rule refuses reserved namespaces "even for a plugin whose id IS the
        // server name" — which is exactly the case here. So without this line
        // `enable_app` fails the whole app with GrantsDenied (it requires
        // `all_approved`, not a filtered subset), and the four MCP tools an agent
        // needs to publish a plan at all never exist. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override, like its neighbours.
        "mcp:blueprint",
        // Seeded MCP plugins own these server names, but `mcp` is a reserved
        // namespace and therefore still requires an exact reviewed entry.
        "mcp:agentation",
        "mcp:docs",
        "mcp:expect",
        // Same rule, same reason: `@ryu/reasoning` declares `mcp:reasoning` and shipped
        // without this row, so `every_builtin_fixture_grant_is_allowlisted` has been red
        // and a disable→re-enable of that app fails with GrantsDenied. Every sidecar app
        // with an `mcp_servers` block needs a line here — the owner-scoped rule will
        // never approve a reserved namespace, however well the names match.
        "mcp:reasoning",
        // Expenses and Research own MCP servers; the reserved `mcp` namespace
        // means their runtime re-enable path needs reviewed server grants here.
        "mcp:expenses",
        "mcp:research",
        // data scopes
        "memory.read",
        "memory.write",
        "spaces.read",
        "spaces.write",
        "files.read",
        // Core's `/api/skills` CRUD, driven from a sandboxed companion frame via
        // the `skills.crud` bridge family. A **cross-app** hold: the declaring
        // app is `@ryu/skill-editor`, whose namespace is `skill-editor`, not
        // `skills` — so the owner-scoped rule does not cover it and the reviewed
        // entry stays. Skills are a Core-owned domain, not this app's surface.
        "skills:crud",
        // model / network scopes
        "model.chat",
        "model.embed",
        "network.fetch",
        // identity-vault scopes (#523): a connection-capture flow and a sealed
        // credential read. Like every scope here they stay swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "browser.connect",
        "identity.read",
        // Cross-plugin host capabilities used by seeded UX and usage bridges.
        "app:http",
        // Companion apps use these generic host bridges to reach their own
        // transport surfaces. `app` is reserved, so the owner-scoped rule cannot
        // approve either grant even when the manifest id is `@ryu/<app>`.
        "app:realtime",
        // Outreach uses the Mail app's reviewed host bridge to list inboxes and
        // send an explicitly selected, human-reviewed message. This is a
        // cross-app grant, so owner-scoping cannot approve it; keep the exact
        // capability on the reviewed list rather than teaching the Gateway
        // about the Outreach app itself.
        "mail:crud",
        // Warmup is a Core-owned host bridge rather than an app-owned namespace.
        // Keep its explicit grant reviewed so the reserved `warmup` namespace
        // cannot be self-approved by a lookalike app.
        "warmup:crud",
        "preferences:write",
        "usage:read",
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
        // Feedback Board invokes the shared Workflows and Blueprint host planes;
        // these are cross-app capabilities, not owner-scoped `@ryu/workflows`
        // capabilities.
        "workflows:crud",
        "workflows:runstate",
        "workflows:catalogs",
        "blueprint:review",
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
        // Research queries the RLM host plane as a cross-app dependency.
        "rlm:query",
        // ReelFarm can hand captions to the Outpost social sidecar through the
        // cross-app host bridge. `social` is reserved, so this safe capability
        // needs an exact reviewed entry rather than an owner-scoped match.
        "social:crud",
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

/// Parse the `RYU_MARKETPLACE_GRANT_ALLOWLIST` value into an allowlist.
/// `None` for an unset/blank value (the caller then uses the built-in default).
/// Split out of [`grant_allowlist`] so the override semantics are testable
/// without going through the process-wide `OnceLock`.
fn parse_grant_allowlist_env(raw: &str) -> Option<Vec<String>> {
    if raw.trim().is_empty() {
        return None;
    }
    Some(
        raw.split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Resolve the active grant allowlist from env, falling back to the built-in
/// default. Cached for the process lifetime.
fn grant_allowlist() -> &'static Vec<String> {
    static ALLOWLIST: OnceLock<Vec<String>> = OnceLock::new();
    ALLOWLIST.get_or_init(|| {
        std::env::var(ENV_GRANT_ALLOWLIST)
            .ok()
            .and_then(|raw| parse_grant_allowlist_env(&raw))
            .unwrap_or_else(default_grant_allowlist)
    })
}

/// The reserved host-primitive namespace vocabulary, cached for the process
/// lifetime. Not env-configurable: loosening it is a code review, not an
/// operator toggle — an operator who needs a reserved scope approved adds the
/// exact scope to `RYU_MARKETPLACE_GRANT_ALLOWLIST`, which is explicit and
/// auditable, rather than un-reserving a whole family.
fn reserved_namespace_list() -> &'static Vec<String> {
    static RESERVED: OnceLock<Vec<String>> = OnceLock::new();
    RESERVED.get_or_init(reserved_namespaces)
}

/// First-party app ids whose capability namespaces are protected from
/// same-segment squatting. Keep both the current scoped ids and the legacy ids
/// accepted by the marketplace alias map so either spelling remains an exact
/// owner, while `com.evil.<name>` is not.
fn protected_owner_id_list() -> &'static Vec<String> {
    static PROTECTED: OnceLock<Vec<String>> = OnceLock::new();
    PROTECTED.get_or_init(|| {
        [
            "monitors",
            "mail",
            "finetune",
            "activity",
            "timeline",
            "calendar",
            "learning",
            "approvals",
            "meetings",
            "simulator",
            "webhooks",
            "drafts",
            "social",
            "crm",
            "workflows",
            "safe-actions",
        ]
        .into_iter()
        .flat_map(|name| [format!("@ryu/{name}"), format!("com.ryu.{name}")])
        .collect()
    })
}

/// Whether the owner-scoped self-grant rule is active (default `true`; see
/// [`ENV_OWNER_SCOPED_GRANTS`]). Cached for the process lifetime.
fn owner_scoped_grants_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(ENV_OWNER_SCOPED_GRANTS)
            .map(|raw| parse_owner_scoped_env(&raw))
            .unwrap_or(true)
    })
}

/// Parse the `RYU_MARKETPLACE_OWNER_SCOPED_GRANTS` value. Anything that is not
/// an explicit off-word leaves owner-scoping on, so a typo cannot silently
/// disable app enablement across the fleet. Split out for the same
/// `OnceLock`-free testability reason as [`parse_grant_allowlist_env`].
fn parse_owner_scoped_env(raw: &str) -> bool {
    !matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

/// Resolve the gateway's active grant policy: the allowlist (env override or
/// built-in default), the reserved host-primitive vocabulary, and whether
/// owner-scoping is on.
fn grant_policy() -> GrantPolicy<'static> {
    GrantPolicy {
        allowlist: grant_allowlist(),
        reserved_namespaces: reserved_namespace_list(),
        owner_scoped: owner_scoped_grants_enabled(),
        protected_owner_ids: protected_owner_id_list(),
    }
}

/// Validate the grants `app_id` requests, under the gateway's active policy.
/// Delegates the grammar to [`ryu_gw_governance::validate_grants_for`]: a scope
/// is approved when it is on the reviewed allowlist **or** it is an owner-scoped
/// self-grant (its namespace equals the last segment of the requesting app's id
/// and that namespace is not a reserved host primitive).
///
/// `app_id` is `None` when the caller did not identify itself, which disables
/// owner-scoping for the request — fail-closed to the pre-grammar behavior.
pub fn validate_grants_for(app_id: Option<&str>, grants: &[String]) -> GrantDecision {
    if app_id.is_some_and(|id| {
        id.trim().eq_ignore_ascii_case("@ryu/chat-title")
            || id.trim().eq_ignore_ascii_case("com.ryu.chat-title")
    }) {
        let mut allowlist = grant_allowlist().clone();
        allowlist.push("hook:run-self".to_string());
        let policy = GrantPolicy {
            allowlist: &allowlist,
            reserved_namespaces: reserved_namespace_list(),
            owner_scoped: owner_scoped_grants_enabled(),
            protected_owner_ids: protected_owner_id_list(),
        };
        return ryu_gw_governance::validate_grants_for(app_id, grants, &policy);
    }
    ryu_gw_governance::validate_grants_for(app_id, grants, &grant_policy())
}

// ── Signing ─────────────────────────────────────────────────────────────────

/// Resolve the process signing key, in priority order:
///   1. `RYU_MARKETPLACE_SIGNING_KEY` env (base64 32-byte seed) — the production
///      source of truth. Stable across restarts and across replicas.
///   2. A dev-persisted key file (`$XDG_DATA_HOME/ryu/marketplace-signing-key`,
///      or `RYU_MARKETPLACE_SIGNING_KEY_PATH`): read it if present, else
///      generate a fresh key AND write it there so it is stable across local
///      restarts. This is what closes the "signatures die on every bounce" gap
///      for a managed local gateway where no env key is configured.
///   3. Only if disk persistence is impossible (no data dir / write fails) do we
///      fall back to an ephemeral key, and we say so loudly.
///
/// The public half is always discoverable via [`public_key_b64`] (same process
/// key), which is how the verify side (`POST /v1/manifests/verify` with no
/// pinned `public_key`) checks a signature — so a persistent private key gives a
/// persistent public key and prior signatures keep verifying.
fn signing_key() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| {
        // 1. Configured production key (env).
        if let Ok(raw) = std::env::var(ENV_SIGNING_KEY) {
            if let Some(key) = signing_key_from_seed(raw.trim()) {
                tracing::info!(
                    "governance: marketplace signing key configured from {ENV_SIGNING_KEY} (production)"
                );
                return key;
            }
            tracing::warn!(
                "governance: {ENV_SIGNING_KEY} set but not a valid base64 32-byte seed; falling back to a dev-persisted key"
            );
        }

        // 2. Dev-persisted key on disk (read existing, else generate + persist).
        if let Some(path) = signing_key_path() {
            if let Some(key) = read_persisted_signing_key(&path) {
                tracing::info!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: loaded dev-persisted marketplace signing key (set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            let mut csprng = rand::rngs::OsRng;
            let key = SigningKey::generate(&mut csprng);
            if persist_signing_key(&path, &key) {
                tracing::warn!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: generated and PERSISTED a dev marketplace signing key (stable across restarts; set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            tracing::error!(
                path = %path.display(),
                "governance: could not persist a dev signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
            );
            return key;
        }

        // 3. No data dir at all — ephemeral, loudly.
        tracing::error!(
            "governance: no data dir for a persisted signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
        );
        let mut csprng = rand::rngs::OsRng;
        SigningKey::generate(&mut csprng)
    })
}

/// Resolve the on-disk path for the dev-persisted signing key: the
/// `RYU_MARKETPLACE_SIGNING_KEY_PATH` override, else
/// `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the audit db location).
/// `None` when no data dir can be resolved.
fn signing_key_path() -> Option<std::path::PathBuf> {
    if let Ok(raw) = std::env::var(ENV_SIGNING_KEY_PATH) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed));
        }
    }
    dirs::data_local_dir().map(|d| d.join("ryu").join("marketplace-signing-key"))
}

/// Read a base64 32-byte seed from the persisted key file, if it exists and
/// parses. Any read/parse error returns `None` (the caller then regenerates).
fn read_persisted_signing_key(path: &std::path::Path) -> Option<SigningKey> {
    let raw = std::fs::read_to_string(path).ok()?;
    signing_key_from_seed(raw.trim())
}

/// Persist a signing key's 32-byte seed (base64) to `path`, creating parent
/// directories. Returns `true` on success. Never panics.
///
/// On Unix the file is created **atomically at mode `0600`** via an owner-only
/// `open` (not written-then-chmod'd), so the private seed is never observable at
/// a permissive umask, and the parent directory is tightened to `0700`. Closing
/// the write-then-chmod TOCTOU window matters because this is an ed25519 signing
/// key — a brief world-readable moment is a real disclosure.
fn persist_signing_key(path: &std::path::Path, key: &SigningKey) -> bool {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the file itself is created 0600 below regardless, so a
            // failure to tighten the dir is not fatal — but do it so the key is
            // not readable via a permissive parent.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let seed_b64 = B64.encode(key.to_bytes());

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "governance: could not create persisted signing key file");
            return false;
        }
    };
    use std::io::Write;
    if let Err(e) = file.write_all(seed_b64.as_bytes()) {
        tracing::warn!(path = %path.display(), error = %e, "governance: could not write persisted signing key");
        return false;
    }
    true
}

/// The base64-encoded public verifying key, exposed so clients can pin it.
pub fn public_key_b64() -> String {
    ryu_gw_governance::public_key_b64(&signing_key().verifying_key())
}

/// Sign a manifest with the gateway's process signing key, returning the
/// base64-encoded ed25519 signature over the canonicalized manifest bytes.
pub fn sign_manifest(manifest: &Value) -> String {
    ryu_gw_governance::sign_manifest(signing_key(), manifest)
}

/// Verify a base64 signature against a manifest. When `public_key_b64` is
/// `None` the process key is used (the common case: same Gateway signed and
/// verifies). A malformed pinned public key, a tampered manifest, or a wrong
/// key returns `false`.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    public_key_b64: Option<&str>,
) -> bool {
    let verifying_key = match public_key_b64 {
        Some(pk) => match verifying_key_from_b64(pk) {
            Some(k) => k,
            None => return false,
        },
        None => signing_key().verifying_key(),
    };
    ryu_gw_governance::verify_manifest(manifest, signature_b64, &verifying_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use serde_json::json;

    /// Shorthand for the common `&[&str] -> Vec<String>` in these tests.
    fn scopes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn default_allowlist_approves_known_grant() {
        let d = validate_grants_for(None, &scopes(&["mcp.tools", "memory.read"]));
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn shared_egress_grant_is_reviewed() {
        let d = validate_grants_for(Some("@ryu/mpp"), &scopes(&["egress:http"]));
        assert!(d.all_approved());
        assert_eq!(d.approved, vec!["egress:http".to_owned()]);
    }

    #[test]
    fn native_host_grants_are_reviewed_and_approved() {
        let d = validate_grants_for(
            Some("@ryu/tokenmaxxing"),
            &scopes(&[
                "native:haptics",
                "native:notifications",
                "native:live_activities",
                "notifications:send",
                "storage:kv",
            ]),
        );
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 5);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn unknown_grant_is_denied_and_blocks() {
        // Neither allowlisted nor owner-scoped (`filesystem` ≠ `canvas`).
        let d = validate_grants_for(
            Some("@ryu/canvas"),
            &scopes(&["mcp.tools", "filesystem.write_all"]),
        );
        assert!(!d.all_approved());
        assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
        assert_eq!(d.approved, vec!["mcp.tools".to_string()]);
    }

    #[test]
    fn empty_grants_approve() {
        let d = validate_grants_for(Some("@ryu/monitors"), &[]);
        assert!(d.all_approved());
    }

    #[test]
    fn protected_first_party_namespace_rejects_owner_squat() {
        let owned = validate_grants_for(Some("@ryu/monitors"), &scopes(&["monitors:crud"]));
        assert!(owned.all_approved(), "denied: {:?}", owned.denied);

        let impostor = validate_grants_for(Some("com.evil.monitors"), &scopes(&["monitors:crud"]));
        assert_eq!(impostor.denied, vec!["monitors:crud".to_string()]);
    }

    #[test]
    fn safe_actions_namespace_rejects_owner_squat() {
        for id in ["@ryu/safe-actions", "com.ryu.safe-actions"] {
            let owned = validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]));
            assert!(owned.all_approved(), "{id} denied: {:?}", owned.denied);
        }

        for id in [
            "com.evil.safe-actions",
            "@evil/safe-actions",
            "safe-actions",
        ] {
            let impostor = validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]));
            assert_eq!(
                impostor.denied,
                vec!["safe-actions:manage".to_string()],
                "{id} must not squat on Safe Actions' namespace"
            );
        }
    }

    #[test]
    fn manual_hook_grant_is_restricted_to_seeded_chat_title() {
        let seeded = validate_grants_for(Some("@ryu/chat-title"), &scopes(&["hook:run-self"]));
        assert!(seeded.all_approved());

        let third_party =
            validate_grants_for(Some("com.acme/chat-title"), &scopes(&["hook:run-self"]));
        assert_eq!(third_party.denied, vec!["hook:run-self".to_string()]);
    }

    #[test]
    fn identity_vault_scopes_are_approved() {
        // #523: the identity-vault grant scopes must be on the built-in allowlist
        // so a credential-read/connect flow is governed, not denied. Both are in
        // RESERVED namespaces (`browser`, `identity`), so the reviewed entry is
        // the only thing approving them — no app can name its way into them.
        let d = validate_grants_for(
            Some("@ryu/browser"),
            &scopes(&["browser.connect", "identity.read"]),
        );
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn workflows_companion_grants_are_approved() {
        // Crux #2: the Workflows companion's four bridge grants must all survive a
        // runtime disable→re-enable (which re-runs `/v1/grants/validate`) instead
        // of being dropped with GrantsDenied — which would leave the canvas unable
        // to call anything. Post-grammar the three `workflows:*` scopes are
        // owner-scoped (`@ryu/workflows` ⇒ namespace `workflows`) and
        // `ghost:record` is a reviewed host primitive; the app must not notice.
        let d = validate_grants_for(
            Some("@ryu/workflows"),
            &scopes(&[
                "workflows:crud",
                "workflows:runstate",
                "workflows:catalogs",
                "ghost:record",
            ]),
        );
        assert!(d.all_approved(), "denied: {:?}", d.denied);
        assert_eq!(d.approved.len(), 4);
    }

    #[test]
    fn blueprint_app_grants_are_approved() {
        // The two halves of `@ryu/blueprint`'s declared set travel through DIFFERENT
        // rules, and asserting them together is the point: `blueprint:review` is a
        // reviewed cross-app host capability consumed by Blueprint and Feedback Board,
        // while `mcp:blueprint` is in the reserved `mcp` namespace and can only ever be
        // approved by its explicit entry. A change that cleans up either one breaks
        // enable, because `enable_app` demands `all_approved` and fails the whole app
        // on a single denial — the app installs, and then has no sidecar or MCP tools.
        let d = validate_grants_for(
            Some("@ryu/blueprint"),
            &scopes(&["blueprint:review", "mcp:blueprint"]),
        );
        assert!(d.all_approved(), "denied: {:?}", d.denied);
        assert_eq!(d.approved.len(), 2);

        // The capability is deliberately reusable by another first-party consumer.
        let consumer =
            validate_grants_for(Some("@ryu/feedback-board"), &scopes(&["blueprint:review"]));
        assert!(consumer.all_approved(), "denied: {:?}", consumer.denied);
    }

    // ── capability grammar, against the REAL gateway policy ──────────────────

    /// **Requirement-5 regression proof.** Every capability string that used to
    /// be hand-listed in `default_grant_allowlist()` — including the 14 per-app
    /// companion scopes the grammar retired — paired with the manifest id that
    /// actually declares it. Each must still validate, whether it now passes via
    /// the owner-scoped rule or the retained host-primitive vocabulary.
    ///
    /// This is a **frozen historical table**, deliberately restated rather than
    /// derived: removing entries from the built-in list is the goal, and a
    /// derived table would shrink alongside it and stop proving anything. The
    /// fixture-driven `every_builtin_fixture_grant_is_allowlisted` below is the
    /// forward-looking half (it catches a NEW fixture with an ungranted scope);
    /// this one is the backward-looking half.
    #[test]
    fn every_pre_grammar_allowlist_entry_still_validates() {
        // (owning manifest id, capability scope) — the id is the one that really
        // declares the scope in `apps/core/src/plugin_manifest/fixtures/`, or a
        // representative holder for the scopes no fixture declares.
        let table: &[(&str, &str)] = &[
            // tool / MCP capability scopes (host vocabulary, no declarer)
            ("@ryu/canvas", "mcp.tools"),
            ("@ryu/canvas", "tools.read"),
            ("@ryu/canvas", "tools.invoke"),
            // per-server MCP tool grants from the seeded system MCP-tool plugins
            ("spider", "mcp:spider"),
            ("agentbrowser", "mcp:agentbrowser"),
            ("ghost", "mcp:ghost"),
            ("shadow", "mcp:shadow"),
            // declarative `http` / `command` tool plugins
            ("exa", "tool:http-egress:api.exa.ai"),
            ("@ryu/advisor", "tool:http-egress:127.0.0.1"),
            ("spider", "tool:command:spider"),
            ("rtk", "tool:command:rtk"),
            // data scopes
            ("@ryu/canvas", "memory.read"),
            ("@ryu/canvas", "memory.write"),
            ("@ryu/canvas", "spaces.read"),
            ("@ryu/canvas", "spaces.write"),
            ("@ryu/canvas", "files.read"),
            // companion bridge capabilities (the 14 the grammar retired)
            ("@ryu/monitors", "monitors:crud"),
            ("@ryu/mail", "mail:crud"),
            ("@ryu/finetune", "finetune:runs"),
            ("@ryu/workflows", "workflows:crud"),
            ("@ryu/workflows", "workflows:runstate"),
            ("@ryu/workflows", "workflows:catalogs"),
            ("@ryu/simulator", "simulator:control"),
            ("@ryu/webhooks", "webhooks:crud"),
            ("@ryu/activity", "activity:read"),
            ("@ryu/timeline", "timeline:read"),
            ("@ryu/calendar", "calendar:crud"),
            ("@ryu/learning", "learning:crud"),
            ("@ryu/approvals", "approvals:crud"),
            ("@ryu/meetings", "meetings:crud"),
            // cross-app / reserved-namespace holds that stay on the list
            ("@ryu/skill-editor", "skills:crud"),
            ("@ryu/quests", "quests:crud"),
            ("@ryu/quests", "quests:capture"),
            ("@ryu/approvals", "quests:crud"),
            ("@ryu/browser", "browser:control"),
            // model / network scopes
            ("@ryu/canvas", "model.chat"),
            ("@ryu/canvas", "model.embed"),
            ("@ryu/canvas", "network.fetch"),
            // identity-vault scopes (#523)
            ("@ryu/browser", "browser.connect"),
            ("@ryu/browser", "identity.read"),
            // widget consent + companion host primitives
            ("sample-widget", "widget:render"),
            ("@ryu/canvas", "spaces:docs"),
            ("@ryu/canvas", "core:list_agents"),
            ("@ryu/canvas", "media:generate"),
            ("@ryu/canvas", "media:transcribe"),
            ("proof", "hook:run-agent"),
            ("double-check", "hook:side-model"),
            ("@ryu/workflows", "ghost:record"),
            ("@ryu/activity", "shell:integrate"),
            ("goal", "storage:kv"),
            ("checklist", "chat.sendFollowUp"),
        ];

        let mut failures: Vec<String> = Vec::new();
        for (app_id, scope) in table {
            let d = validate_grants_for(Some(app_id), &scopes(&[scope]));
            if !d.all_approved() {
                failures.push(format!("{app_id} → '{scope}'"));
            }
        }
        assert!(
            failures.is_empty(),
            "first-party capability regression: these validated before the capability \
             grammar and must still validate (add the scope to default_grant_allowlist() \
             if it is a host primitive, or check that the app id's last segment matches \
             the capability namespace): {}",
            failures.join(", ")
        );
    }

    #[test]
    fn third_party_app_self_grants_its_own_namespace() {
        // The whole point: an app nobody hardcoded, declaring capabilities in its
        // own namespace, validates — so it can actually be ENABLED (Core aborts
        // enable with GrantsDenied on any denial) with no Gateway edit.
        let d = validate_grants_for(
            Some("com.acme.invoices"),
            &scopes(&["invoices:crud", "invoices:export", "invoices.read"]),
        );
        assert!(d.all_approved(), "denied: {:?}", d.denied);
        assert_eq!(d.approved.len(), 3);
    }

    #[test]
    fn spoofed_app_id_cannot_claim_another_apps_namespace() {
        // The named spoofing case: `com.ryu.evil` must not self-approve the
        // Monitors app's capability. Its owner namespace is `evil`, `monitors` is
        // not on the reviewed list any more, so it is denied outright.
        let d = validate_grants_for(Some("com.ryu.evil"), &scopes(&["monitors:crud"]));
        assert_eq!(d.denied, vec!["monitors:crud".to_string()]);
        assert!(d.approved.is_empty());

        // Nor by dressing the id up as a prefix/suffix of the real owner.
        for id in [
            "monitors.evil",
            "@ryu/monitors.evil",
            "com.ryu.evil-monitors",
            "com.ryu.monitorz",
        ] {
            let d = validate_grants_for(Some(id), &scopes(&["monitors:crud"]));
            assert_eq!(
                d.denied,
                vec!["monitors:crud".to_string()],
                "'{id}' must not reach the monitors namespace"
            );
        }
    }

    #[test]
    fn sidecar_process_is_never_approved_by_any_caller() {
        // Handoff §8 + requirement 3: running an unsandboxed managed process from
        // a manifest is arbitrary code execution. It is on no default allowlist,
        // and `sidecar` is reserved so no manifest id can name its way into it.
        for id in [
            "@ryu/monitors",
            "com.evil.sidecar",
            "sidecar",
            "com.ryu.sidecar",
        ] {
            let d = validate_grants_for(Some(id), &scopes(&["sidecar:process"]));
            assert_eq!(
                d.denied,
                vec!["sidecar:process".to_string()],
                "'{id}' must not self-approve sidecar:process"
            );
        }
    }

    #[test]
    fn reserved_host_namespaces_are_not_self_grantable() {
        // A privileged scope that is NOT on the reviewed list stays denied even
        // for an app that named itself after the namespace — the fence that keeps
        // the grammar from loosening the host-primitive set.
        let cases: &[(&str, &str)] = &[
            ("com.evil.memory", "memory.purge"),
            ("com.evil.model", "model.finetune"),
            ("com.evil.files", "files.write"),
            ("com.evil.network", "network.listen"),
            ("com.evil.tool", "tool:command:rm"),
            ("com.evil.tool", "tool:http-egress:evil.example"),
            ("com.evil.mcp", "mcp:evil"),
            ("com.evil.identity", "identity.write"),
            ("com.evil.core", "core:shutdown"),
            ("com.evil.hook", "hook:pre-turn"),
            ("com.evil.widget", "widget:inject"),
            ("com.evil.shell", "shell:exec"),
            ("com.evil.storage", "storage:global"),
            ("com.evil.chat", "chat.readAll"),
            ("com.evil.media", "media:record"),
            ("com.evil.ghost", "ghost:replay"),
            ("com.evil.browser", "browser:hijack"),
            ("com.evil.spaces", "spaces:purge"),
            ("com.evil.skills", "skills:write"),
            ("com.evil.quests", "quests:purge"),
            ("com.evil.self_build", "self_build:write"),
            // The three namespaces an adversarial pass caught missing: each names
            // a host verb that Core gates on `approved_grants`, so a miss here is
            // not cosmetic — it is a capability the grammar hands out that the
            // pre-grammar allowlist denied to everyone.
            //
            // `runtime:external` is the sharp one: it is what
            // `external_runtime::may_provision` checks before a Community-tier
            // plugin runs `pip install` from its own manifest.
            ("com.evil.runtime", "runtime:external"),
            ("runtime", "runtime:external"),
            // `ui:send_message` posts a chat turn as the user; `ui:render`
            // promotes a frame; `views:actions` relays a shell view intent.
            ("com.evil.ui", "ui:send_message"),
            ("com.evil.ui", "ui:render"),
            ("com.evil.views", "views:actions"),
        ];
        let mut approved: Vec<String> = Vec::new();
        for (app_id, scope) in cases {
            if validate_grants_for(Some(app_id), &scopes(&[scope])).all_approved() {
                approved.push(format!("{app_id} → '{scope}'"));
            }
        }
        assert!(
            approved.is_empty(),
            "reserved host-primitive namespaces must never be owner-scoped: {}",
            approved.join(", ")
        );
    }

    #[test]
    fn env_override_parses_and_replaces_the_default_list() {
        // The operator override keeps working as an override/extension. Parsed
        // through the same helper the process cache uses; the cache itself is a
        // `OnceLock`, so we exercise the policy with the parsed value directly
        // rather than mutating process env from a parallel test.
        assert_eq!(
            parse_grant_allowlist_env(""),
            None,
            "blank ⇒ built-in default"
        );
        assert_eq!(parse_grant_allowlist_env("   \n"), None);
        let parsed = parse_grant_allowlist_env("sidecar:process, mcp.tools\nmemory.read")
            .expect("non-blank value parses");
        assert_eq!(
            parsed,
            scopes(&["sidecar:process", "mcp.tools", "memory.read"])
        );

        // An override CAN approve a reserved scope the built-in default refuses —
        // that is the point of an operator escape hatch, and it stays explicit
        // (an exact scope, not an un-reserved family).
        let reserved = reserved_namespaces();
        let policy = GrantPolicy {
            allowlist: &parsed,
            reserved_namespaces: &reserved,
            owner_scoped: true,
            protected_owner_ids: &[],
        };
        let d = ryu_gw_governance::validate_grants_for(
            Some("@ryu/browser"),
            &scopes(&["sidecar:process"]),
            &policy,
        );
        assert!(d.all_approved(), "an explicit override entry approves");

        // …and a narrowed override still denies what it left out.
        let d = ryu_gw_governance::validate_grants_for(
            Some("@ryu/browser"),
            &scopes(&["browser:control"]),
            &policy,
        );
        assert_eq!(d.denied, vec!["browser:control".to_string()]);
    }

    #[test]
    fn owner_scoped_env_toggle_parses_off_words_only() {
        for off in ["0", "false", "no", "off", " OFF ", "False"] {
            assert!(!parse_owner_scoped_env(off), "'{off}' must disable");
        }
        for on in ["1", "true", "yes", "", "banana"] {
            assert!(parse_owner_scoped_env(on), "'{on}' must leave it on");
        }

        // With the rule off, the gateway is back to a pure allowlist: an app's
        // own namespace is no longer enough.
        let allow = default_grant_allowlist();
        let reserved = reserved_namespaces();
        let strict = GrantPolicy {
            allowlist: &allow,
            reserved_namespaces: &reserved,
            owner_scoped: false,
            protected_owner_ids: &[],
        };
        let d = ryu_gw_governance::validate_grants_for(
            Some("@ryu/monitors"),
            &scopes(&["monitors:crud"]),
            &strict,
        );
        assert_eq!(d.denied, vec!["monitors:crud".to_string()]);
    }

    #[test]
    fn default_allowlist_holds_no_retired_per_app_scope() {
        // Tripwire against re-growing the list one app at a time. If a first-party
        // capability is denied, fix the id/namespace match or classify it as a host
        // primitive — do not paste the string back in.
        let allow = default_grant_allowlist();
        let retired = [
            "monitors:crud",
            "finetune:runs",
            "simulator:control",
            "webhooks:crud",
            "activity:read",
            "timeline:read",
            "calendar:crud",
            "learning:crud",
            "approvals:crud",
            "meetings:crud",
        ];
        let regrown: Vec<&str> = retired
            .iter()
            .copied()
            .filter(|scope| allow.iter().any(|a| a.eq_ignore_ascii_case(scope)))
            .collect();
        assert!(
            regrown.is_empty(),
            "these are owner-scoped and must NOT be hardcoded again: {regrown:?}"
        );
    }

    /// Drift tripwire: every grant a **seeded built-in** fixture declares must
    /// validate *for that fixture's own id*. Core's enable path
    /// (`plugins/lifecycle.rs`) sends an app's full `permission_grants` set —
    /// with its manifest id as `app_id` — through `/v1/grants/validate` on every
    /// enable, including a runtime disable→re-enable, so a declared grant that
    /// neither the allowlist nor the owner-scoped rule approves is denied with
    /// GrantsDenied and the app cannot re-enable.
    ///
    /// Feeding the fixture's real `id` (not `None`) is what makes this the
    /// forward-looking half of the requirement-5 proof: a new app whose
    /// capability namespace does not match its id fails HERE, at the same place
    /// an unlisted host primitive does.
    ///
    /// Rather than restate the grant set (which would silently pass when a NEW
    /// fixture adds an unlisted grant — the exact drift this guards), the test
    /// READS the fixtures Core compiles in (`apps/core/src/plugin_manifest/
    /// fixtures/*.manifest.json`) and asserts `validate_grants` approves each
    /// declared grant. This also enforces handoff §8 automatically: a fixture that
    /// declared `sidecar:process` (or any other unlisted scope) would fail here.
    ///
    /// `sample.manifest.json` is excluded: it is a test-only demo, not in
    /// `SEED_MANIFESTS`, so it is never enabled at runtime and its file-read/
    /// web-search scopes must NOT loosen the marketplace-publish allowlist.
    ///
    /// Read at runtime (not `include_str!`, which can't cross crates cleanly) and
    /// skipped when the fixtures dir is absent, so a separately-vendored gateway
    /// (no sibling `apps/core`) still tests green — mirrors the core companion-pair
    /// test's skip-if-absent posture.
    #[test]
    fn every_builtin_fixture_grant_is_allowlisted() {
        // Built-in manifests live in TWO homes and BOTH must be scanned. The packaged
        // ones moved to `apps-store/<x>/manifest.json` /
        // `plugins-store/{plugins,lsp,external_plugins}/<x>/manifest.json`
        // (Core `include_str!`s them directly; the duplicate fixture copies are gone),
        // leaving only the ~13 Core-only manifests in `fixtures/`.
        //
        // Scanning `fixtures/` alone would still PASS — on 13 files instead of 71 —
        // because every remaining orphan happens to carry an allowlisted grant block.
        // That is a silent 58-manifest hole in a grant check, which is precisely what
        // the `checked_files > 0` guard below cannot catch. Hence both roots.
        let gateway = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut manifest_paths: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(gateway.join("../core/src/plugin_manifest/fixtures"))
        {
            manifest_paths.extend(entries.flatten().map(|e| e.path()).filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".manifest.json"))
            }));
        }
        for root in ["apps-store", "plugins-store"] {
            if let Ok(entries) = std::fs::read_dir(gateway.join("../..").join("generated/ryu-runtime").join(root)) {
                manifest_paths.extend(
                    entries
                        .flatten()
                        .map(|e| e.path().join("manifest.json"))
                        .filter(|p| p.is_file()),
                );
            }
        }
        if manifest_paths.is_empty() {
            // Vendored gateway without sibling `apps/core` or package roots.
            return;
        }
        manifest_paths.sort();

        let mut checked_files = 0;
        let mut checked_grants = 0;
        let mut failures: Vec<String> = Vec::new();

        for path in manifest_paths {
            // Name the OWNING package (`plugins-store/plugins/exa/manifest.json` -> `exa`), not
            // the bare `manifest.json`, so a failure message still identifies the app.
            let name = if path.file_name().and_then(|n| n.to_str()) == Some("manifest.json") {
                path.parent()
                    .and_then(|p| p.file_name())
                    .map(|n| format!("{}.manifest.json", n.to_string_lossy()))
                    .unwrap_or_else(|| path.display().to_string())
            } else {
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string())
            };
            if name == "sample.manifest.json" {
                continue; // test-only demo, not seeded (see doc comment)
            }
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", path.display()));
            let manifest: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("fixture {name} is not valid JSON: {e}"));
            let Some(grants) = manifest.get("permission_grants").and_then(Value::as_array) else {
                continue; // no declared grants
            };
            // The id is load-bearing here: it is the subject of the owner-scoped
            // rule. A fixture without one cannot owner-scope anything.
            let app_id = manifest
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("fixture {name} declares grants but has no `id`"));
            checked_files += 1;
            let declared: Vec<String> = grants
                .iter()
                .filter_map(|g| g.as_str().map(str::to_string))
                .collect();
            let decision = validate_grants_for(Some(app_id), &declared);
            for denied in decision.denied {
                // Community managed-sidecar, MCP-server, Scrapling, and Pi-extension
                // packages intentionally declare operator-only grants. They must
                // stay absent from the default allowlist; the dedicated
                // reserved-namespace tests below pin that fail-closed policy.
                // This fixture audit covers the safe host vocabulary, not operator
                // opt-ins. Core-tier packages may still use the host gate directly.
                if matches!(
                    denied.as_str(),
                    "sidecar:process" | "mcp:server" | "mcp:scrapling" | "pi:extension"
                ) {
                    continue;
                }
                failures.push(format!("{name} ({app_id}): '{denied}'"));
            }
            checked_grants += declared.len();
        }

        assert!(
            failures.is_empty(),
            "seeded built-in fixtures declare grants that neither default_grant_allowlist() nor \
             the owner-scoped rule approves (a runtime disable→re-enable would fail with \
             GrantsDenied). Either the capability namespace does not match the last segment of \
             the app's id, or the scope is a host primitive that must be added to the allowlist \
             (and, for `sidecar:process`, removed from the fixture per handoff §8): {}",
            failures.join(", ")
        );
        // Guard against a vacuous pass: the dir existed, so we must have parsed at
        // least a few grant-bearing fixtures.
        assert!(
            checked_files > 0 && checked_grants > 0,
            "fixtures dir resolved but no grant-bearing fixtures were read \
             (checked_files={checked_files}, checked_grants={checked_grants})"
        );
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
        let sig = sign_manifest(&manifest);
        assert!(verify_manifest(&manifest, &sig, None));
    }

    #[test]
    fn explicit_public_key_verifies() {
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&manifest);
        let pk = public_key_b64();
        assert!(verify_manifest(&manifest, &sig, Some(&pk)));
    }

    #[test]
    fn malformed_pinned_public_key_fails_verify() {
        // The gateway wrapper resolves a caller-pinned public key; a malformed one
        // must return false (unverifiable), not fall through to the process key.
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&manifest);
        assert!(!verify_manifest(&manifest, &sig, Some("not-base64!!!")));
    }

    #[test]
    fn persist_then_read_signing_key_roundtrips() {
        // A generated key persisted to disk must read back as the SAME key, so a
        // signature made before a restart still verifies after (the dev-persist
        // path that closes the "ephemeral key dies on bounce" gap). We exercise
        // the helpers directly since `signing_key()` is a process-wide OnceLock.
        let mut csprng = rand::rngs::OsRng;
        let key = SigningKey::generate(&mut csprng);
        let dir = std::env::temp_dir().join(format!("ryu-govtest-{}", std::process::id()));
        let path = dir.join("marketplace-signing-key");

        assert!(persist_signing_key(&path, &key), "persist should succeed");
        let loaded = read_persisted_signing_key(&path).expect("read back the key");

        // Same public key ⇒ same verifying identity across a simulated restart.
        assert_eq!(
            loaded.verifying_key().to_bytes(),
            key.verifying_key().to_bytes()
        );
        // A signature made with the original verifies against the reloaded key.
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = B64.encode(
            key.sign(&ryu_gw_governance::canonical_bytes(&manifest))
                .to_bytes(),
        );
        assert!(verify_manifest(
            &manifest,
            &sig,
            Some(&B64.encode(loaded.verifying_key().to_bytes()))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
