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
/// the key lives in the gateway's `secrets/` slot (see `signing_key_path`).
/// Only consulted when `ENV_SIGNING_KEY` is
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
        // Usage is a host primitive; administrative audit access is operator-only.
        "usage",
        "memory",
        "spaces",
        "files",
        "identity",
        "authorization",
        "network",
        // Core-owned DNS-pinned HTTP for app protocols. The app may still own
        // origin/payment semantics, but it cannot self-approve the network seam.
        "egress",
        // Tool-plane primitives: `tool:command:<bin>` is local process exec and
        // `tool:http-egress:<host>` is network egress, so neither may ever be
        // owner-scoped; `tools.*` / `mcp:*` / `mcp.*` are the MCP tool plane.
        "tool",
        "tools",
        // Installing a bundle is a host effect, never an owner-scoped self-grant.
        "plugins",
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
        // Subscription accounts are a Core-owned host capability (saved logins
        // whose labels may be email addresses). Reserved so an app such as
        // `com.evil.subscriptions` cannot self-approve `subscriptions:*`; only
        // the reviewed `subscriptions:read` is allowlisted below, and the future
        // `subscriptions:pin` name stays unapprovable until it is designed.
        "subscriptions",
        // The vault is a Core-owned host primitive. `vault:fill` lets a sidecar
        // receive one agent-account field to type into a page; reserved so an
        // app such as `com.evil.vault` cannot self-approve it.
        "vault",
        // Turn-hook phases, host-shell integration, the app KV store, the
        // follow-up-message verb, sandboxed widget promotion, media engines,
        // native-desktop capture/replay, and Core's own listing verbs.
        "hook",
        "execution",
        // Native effects are a host primitive rather than an app-owned
        // namespace. The exact actions are reviewed below; reserving the
        // namespace prevents an app named `native` from self-approving them.
        "native",
        "shell",
        "storage",
        "backups",
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
        // Core's run plane: failed agent / scheduled-job / workflow runs
        // (`runs:failures`, the `core#run.failed` kernel event) and the agent
        // re-run kernel capability (`runs:rerun-agent`). No app owns runs, so the
        // namespace is reserved: otherwise an app named `com.evil.runs` would
        // owner-scope its way into every failed run's instruction and error.
        "runs",
        // The generic Companion → sidecar HTTP and realtime host bridges
        // (`app:http`, `app:realtime`, and per-target `app:http:<app id>`). Reserved
        // so an app whose id ends in `app` (`com.evil.app`) cannot owner-scope
        // its way into another app's sidecar.
        "app",
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
        "plugins:install",
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
        "mcp:checks",
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
        // DeepSeek serves search and fetch from one host, so one exact entry.
        "tool:http-egress:api.deepseek.com",
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
        // `spider`, `rtk`, `ripgrep` and `just-bash` were decoupled from Core into
        // declarative `command` tool plugins, so each declares a `tool:command:<bin>`
        // grant instead of an in-Core provider. Same re-enable rationale as the
        // scopes above.
        "tool:command:spider",
        "tool:command:rtk",
        "tool:command:rg",
        "tool:command:just-bash",
        "tool:command:bws",
        // Ship-code-in-a-manifest, for BOTH an `inline_js` tool and a capability
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
        "mcp:zvec_grep",
        // The opt-in local computer.control engine `@ryu/codex-computer-use` owns
        // this stdio server.
        "mcp:codex_cu",
        // Same rule, same reason: `@ryu/reasoning` declares `mcp:reasoning` and shipped
        // without this row, so `every_builtin_fixture_grant_is_allowlisted` has been red
        // and a disable→re-enable of that app fails with GrantsDenied. Every sidecar app
        // with an `mcp_servers` block needs a line here — the owner-scoped rule will
        // never approve a reserved namespace, however well the names match.
        "mcp:reasoning",
        // Expenses, Family, Places, and Research own MCP servers; the reserved
        // `mcp` namespace means their runtime re-enable path needs reviewed
        // server grants here.
        "mcp:expenses",
        "mcp:family",
        "mcp:places",
        "mcp:research",
        // Sites' own `sites.*` agent tools (`apps-store/sites/manifest.json`);
        // same reserved-namespace rule as the rows above.
        "mcp:sites",
        // data scopes
        "memory.read",
        "memory.write",
        "spaces.read",
        "spaces.write",
        "files.read",
        // A sandboxed companion may trigger a user-requested download from its
        // own rendered export; the host adds only the browser download permission
        // and still blocks filesystem reads/writes. A manifest must declare the
        // grant and the user must install/enable that app before it is approved.
        "files:download",
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
        // Cross-app Companion requests (`app.request({ app })`, Host API 1.18):
        // `app:http:<target app id>` lets a Companion call ONE other app's sidecar
        // through the host's ext-proxy forwarder, confined to that app's mount and
        // declared routes. Each target is reviewed on its own row; the form is
        // checked in `validate_grants_for` (concrete scoped id, no wildcard) and a
        // well-formed target grant is approved ONLY by exact membership here, never
        // by the owner-scoped rule. The Workflows Companion lists recorded recipes
        // from the Recipes app's list route (it used to reach that route through the
        // per-app `ghost.recipes` host verb).
        "app:http:@ryu/recipes",
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
        // Run recovery, the Self-Healing extraction (`@ryu/healing`). Three
        // cross-app holds, each reviewed on its own because the reach differs:
        //
        // `runs:failures` receives the `core#run.failed` kernel event: the
        // instruction and error text of every failed chat, scheduled-agent and
        // workflow run. That is user data from runs the app did not start, so it
        // is a reserved-namespace entry here rather than an owner-scoped match.
        "runs:failures",
        // `approvals:request` queues a proposed fix into the Approvals inbox
        // through the `approvals.request` kernel capability. Distinct from the
        // owner-scoped `approvals:crud` (list/approve/reject the inbox): a holder
        // can only ASK, a human still decides, and Core builds the request (kind,
        // deferred action) from a closed set, never from free-form input. The
        // `approvals` namespace is protected, so only this exact entry allows it
        // for any app other than `@ryu/approvals`.
        "approvals:request",
        // `runs:rerun-agent` re-runs a failed agent run (`runs.rerunAgent`
        // kernel capability; an approved fix is executed by Core's own
        // approval engine instead). Core mints the
        // never-heal-a-heal run id itself, so a holder cannot choose or collide
        // with a conversation. Workflow re-runs need no new word: they reuse the
        // reviewed `workflows:runstate` above (the same power as `workflows.run`).
        "runs:rerun-agent",
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
            // First-party capability providers (`provides[].grant` in
            // `apps-store/<name>/manifest.json`). Core's capability broker gates a
            // provided capability only on the caller holding the grant, so an
            // unprotected namespace would let `@evil/teams` self-grant
            // `teams:manage`. `every_first_party_provided_grant_namespace_is_protected`
            // fails when a new provider is not listed here.
            "teams",
            "dashboards",
            "news",
            "reasoning",
            "rlm",
            "tuition",
            "blueprint",
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
    let decision = validate_general_grants_for(app_id, grants);
    // Per-target cross-app grants (`app:http:<target>`) are decided here, not by
    // the general grammar: a malformed target (wildcard, unscoped id, anything
    // but one concrete `@scope/name`) is denied even if an operator allowlist
    // names it, and a well-formed one is approved only by exact membership in the
    // reviewed allowlist.
    let mut approved = Vec::new();
    let mut denied = Vec::new();
    for grant in grants {
        let scope = grant.trim();
        if scope.is_empty() {
            continue;
        }
        let allowed = if is_app_http_target_grant(scope) {
            app_http_target_grant_well_formed(scope)
                && grant_allowlist().iter().any(|entry| entry.trim() == scope)
        } else {
            decision.approved.iter().any(|a| a == scope)
        };
        if allowed {
            approved.push(scope.to_owned());
        } else {
            denied.push(scope.to_owned());
        }
    }
    GrantDecision { approved, denied }
}

/// Prefix of a per-target cross-app request grant.
const APP_HTTP_TARGET_PREFIX: &str = "app:http:";

/// Whether `scope` is shaped as a per-target cross-app grant at all (any case),
/// so it is routed to [`app_http_target_grant_well_formed`] and never to the
/// general grammar.
fn is_app_http_target_grant(scope: &str) -> bool {
    scope
        .get(..APP_HTTP_TARGET_PREFIX.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(APP_HTTP_TARGET_PREFIX))
}

/// The accepted form of a per-target grant: `app:http:@scope/name`, lowercase,
/// one concrete scoped app id (`[a-z0-9][a-z0-9-]*` scope, `[a-z0-9][a-z0-9._-]*`
/// name). No wildcard, no flat or dotted legacy id, no extra segment.
fn app_http_target_grant_well_formed(scope: &str) -> bool {
    let Some(target) = scope.strip_prefix(APP_HTTP_TARGET_PREFIX) else {
        return false;
    };
    let Some((owner, name)) = target
        .strip_prefix('@')
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let segment = |s: &str, extra: &[char]| {
        s.len() <= 214
            && s.chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || extra.contains(&c)
            })
    };
    segment(owner, &[]) && segment(name, &['.', '_'])
}

/// The general capability grammar (allowlist + owner-scoped + owner-exclusive).
fn validate_general_grants_for(app_id: Option<&str>, grants: &[String]) -> GrantDecision {
    let extra = app_id.map(owner_exclusive_grants).unwrap_or_default();
    if extra.is_empty() {
        return ryu_gw_governance::validate_grants_for(app_id, grants, &grant_policy());
    }
    let mut allowlist = grant_allowlist().clone();
    allowlist.extend(extra.iter().map(|grant| (*grant).to_owned()));
    let policy = GrantPolicy {
        allowlist: &allowlist,
        reserved_namespaces: reserved_namespace_list(),
        owner_scoped: owner_scoped_grants_enabled(),
        protected_owner_ids: protected_owner_id_list(),
    };
    ryu_gw_governance::validate_grants_for(app_id, grants, &policy)
}

/// One reviewed owner-exclusive grant row: the exact first-party owner ids
/// (current scoped id plus its legacy flat alias) and the sensitive grants only
/// that owner may request.
struct OwnerExclusiveGrant {
    owner_ids: &'static [&'static str],
    grants: &'static [&'static str],
}

/// Reviewed grants that are deliberately kept OFF the global allowlist (so no
/// marketplace app can self-request them) but are approved for one exact
/// first-party owner. This is data, not per-app code: adding a row is a security
/// review decision, and the policy itself stays app-agnostic. It cannot be driven
/// by the requesting manifest, because the manifest is the untrusted party here.
///
/// - `execution:control` — the kill switch's stop-all-executions primitive.
/// - `hook:run-self` — `host.runHook`, restricted to the seeded chat-title plugin.
/// - `timeline:speech` — Shadow speech history, only Life Recorder requests it.
/// - `media:record` — host-owned microphone windows, requested by Life Recorder,
///   Teleprompter, Voice, and Video Studio (short windows only; no Shadow speech
///   history).
/// - `hook:run-agent:write` — mutating sub-agent presets (autopilot, sites).
/// - `vault:fill` — an agent's own website login or TOTP code, released in
///   plaintext to the Browser sidecar that types it into the page.
/// - `chat:project-guidance` — a project's standing goal and instructions, which
///   Core puts in the system prompt of every turn in that project.
const OWNER_EXCLUSIVE_GRANTS: &[OwnerExclusiveGrant] = &[
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/kill-switch", "com.ryu.kill-switch"],
        grants: &["execution:control"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/chat-title", "com.ryu.chat-title"],
        grants: &["hook:run-self"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/life-recorder", "com.ryu.life-recorder"],
        grants: &["timeline:speech", "media:record"],
    },
    // Short host-owned microphone windows only; no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/teleprompter", "com.ryu.teleprompter"],
        grants: &["media:record"],
    },
    // Voice Studio records consented voice samples through the same short
    // host-owned microphone window; no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/voice", "com.ryu.voice"],
        grants: &["media:record"],
    },
    // Video Studio's voiceover and screen/camera recorder (an optional grant the
    // viewer still approves); no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/video-studio", "com.ryu.video-studio"],
        grants: &["media:record"],
    },
    // Write-capable sub-agents stay off the global allowlist so an app holding
    // plain `hook:run-agent` cannot escalate to `preset: "code_write"`; only the
    // reviewed first-party owners whose shipped flows launch a write delegate.
    OwnerExclusiveGrant {
        owner_ids: RUN_AGENT_WRITE_OWNERS,
        grants: &[RUN_AGENT_WRITE_GRANT],
    },
    // Agent accounts: `vault.credentialFill` returns the stored password or the
    // current TOTP code to the calling sidecar, and Core cannot see the page it
    // claims to fill. Only the reviewed Browser app may hold it; on the global
    // allowlist any installed app's sidecar could read every agent's logins.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/browser", "com.ryu.browser"],
        grants: &["vault:fill"],
    },
    // Project guidance: `scopeGuidance.set` writes text that every turn in the
    // project carries in its system prompt, user-started turns included. Only
    // the reviewed Projects app, which owns project settings, may hold it;
    // `chat.sendFollowUp` alone would hand it to every app that posts turns.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/projects", "com.ryu.projects"],
        grants: &["chat:project-guidance"],
    },
];

/// The owner-exclusive grants reviewed for `app_id` (exact, case-insensitive id
/// match after trimming; empty for every other caller). Rows are unioned, so one
/// grant shared by several owners can be its own row and an owner may appear in
/// more than one row.
fn owner_exclusive_grants(app_id: &str) -> Vec<&'static str> {
    let app_id = app_id.trim();
    OWNER_EXCLUSIVE_GRANTS
        .iter()
        .filter(|row| {
            row.owner_ids
                .iter()
                .any(|id| id.eq_ignore_ascii_case(app_id))
        })
        .flat_map(|row| row.grants.iter().copied())
        .collect()
}

/// The explicit grant that lets `host.runAgent` / `host.runFanout` launch a
/// mutating (`code_write`) preset. Not on [`default_grant_allowlist`].
const RUN_AGENT_WRITE_GRANT: &str = "hook:run-agent:write";

/// Reviewed first-party apps whose shipped flows run a write-capable sub-agent
/// (Autopilot's strategy cycle and Sites' provider reset action).
const RUN_AGENT_WRITE_OWNERS: &[&str] = &[
    "@ryu/autopilot",
    "com.ryu.autopilot",
    "@ryu/sites",
    "com.ryu.sites",
];

// ── Signing ─────────────────────────────────────────────────────────────────

/// Resolve the process signing key, in priority order:
///   1. `RYU_MARKETPLACE_SIGNING_KEY` env (base64 32-byte seed) — the production
///      source of truth. Stable across restarts and across replicas.
///   2. A dev-persisted key file (`<data dir>/secrets/marketplace-signing-key`,
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
        //    The seed is sealed (`encc:v1:`) with the Gateway's sealing key; a
        //    legacy plaintext seed is read and resealed in place.
        if let Some(path) = signing_key_path() {
            let sealer = signing_key_sealer();
            match read_persisted_signing_key(&path, sealer.as_deref()) {
                Ok(Some(key)) => {
                    tracing::info!(
                        path = %path.display(),
                        public_key = %B64.encode(key.verifying_key().to_bytes()),
                        "governance: loaded dev-persisted marketplace signing key (set {ENV_SIGNING_KEY} for production)"
                    );
                    return key;
                }
                Ok(None) => {}
                Err(error) => {
                    // Never mint a replacement over a key we cannot open: that
                    // would silently rotate the marketplace trust root.
                    tracing::error!(
                        path = %path.display(),
                        "governance: the persisted marketplace signing key could not be opened ({error}); using an EPHEMERAL key and leaving the file untouched (start the Gateway with its sealing key, or set {ENV_SIGNING_KEY})"
                    );
                    let mut csprng = rand::rngs::OsRng;
                    return SigningKey::generate(&mut csprng);
                }
            }
            // Before keys were profile-scoped every profile shared one file. Adopt
            // that key on first start of a non-release profile so signatures it
            // already issued keep verifying; fresh installs stay isolated. The
            // shared file is the release profile's own key, sealed (if at all)
            // under the release key, so it is only read here, never rewritten.
            if let Some(key) = legacy_signing_key_path(&path)
                .and_then(|legacy| adopt_legacy_signing_key(&legacy, &path, sealer.as_deref()))
            {
                tracing::info!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: adopted the pre-profile marketplace signing key for this profile"
                );
                return key;
            }
            let mut csprng = rand::rngs::OsRng;
            let key = SigningKey::generate(&mut csprng);
            if persist_signing_key(&path, &key, sealer.as_deref()) {
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
/// `<RYU_DIR>/secrets/marketplace-signing-key` under Core, else the standalone
/// profile's `$XDG_DATA_HOME/ryu{suffix}/marketplace-signing-key` (mirrors the
/// audit db location, profile-scoped so a dev Gateway never signs with the
/// release key).
/// `None` when no data dir can be resolved.
fn signing_key_path() -> Option<std::path::PathBuf> {
    let ryu_dir = std::env::var_os("RYU_DIR")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    signing_key_path_for(
        std::env::var(ENV_SIGNING_KEY_PATH).ok().as_deref(),
        ryu_dir.as_deref(),
        dirs::data_local_dir().as_deref(),
        &crate::profile::suffix(),
    )
}

/// Pure half of [`signing_key_path`], testable without process-global env.
fn signing_key_path_for(
    override_path: Option<&str>,
    ryu_dir: Option<&std::path::Path>,
    data_local_dir: Option<&std::path::Path>,
    profile_suffix: &str,
) -> Option<std::path::PathBuf> {
    if let Some(trimmed) = override_path.map(str::trim).filter(|raw| !raw.is_empty()) {
        return Some(std::path::PathBuf::from(trimmed));
    }
    if let Some(root) = ryu_dir {
        return Some(ryu_sidecar_runtime::layout::secret_path(
            root,
            "marketplace-signing-key",
        ));
    }
    data_local_dir.map(|dir| {
        dir.join(format!("ryu{profile_suffix}"))
            .join("marketplace-signing-key")
    })
}

/// The shared pre-profile key file (`$XDG_DATA_HOME/ryu/marketplace-signing-key`)
/// for a profile-scoped default path (`ryu-<profile>/marketplace-signing-key`).
/// `None` for the release profile, an explicit override, or any other shape.
fn legacy_signing_key_path(profile_path: &std::path::Path) -> Option<std::path::PathBuf> {
    if std::env::var(ENV_SIGNING_KEY_PATH).is_ok_and(|raw| !raw.trim().is_empty()) {
        return None;
    }
    legacy_signing_key_path_for(profile_path)
}

/// Pure half of [`legacy_signing_key_path`].
fn legacy_signing_key_path_for(profile_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let profile_dir = profile_path.parent()?;
    let dir_name = profile_dir.file_name()?.to_str()?;
    if !dir_name.starts_with("ryu-") || profile_path.file_name()? != "marketplace-signing-key" {
        return None;
    }
    Some(
        profile_dir
            .parent()?
            .join("ryu")
            .join("marketplace-signing-key"),
    )
}

/// Adopt the shared pre-profile seed at `legacy` into this profile's own `path`.
///
/// The legacy file is the release profile's live key, so it is read strictly
/// read-only: with no sealer, so [`read_persisted_signing_key`] never reseals it
/// under this profile's key (which would leave the release Gateway unable to
/// open it and rotate its trust root on the next restart). A plaintext seed is
/// adopted; a sealed one cannot be opened without the release key, so it is
/// skipped and the profile mints its own. The seed is then persisted only to
/// `path`, sealed under this profile's sealer.
fn adopt_legacy_signing_key(
    legacy: &std::path::Path,
    path: &std::path::Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> Option<SigningKey> {
    read_persisted_signing_key(legacy, None)
        .ok()
        .flatten()
        .filter(|key| persist_signing_key(path, key, sealer))
}

/// The Gateway's sealing key for the persisted seed: the subkey Core delivered,
/// or the one a standalone Gateway derived from `RYU_MASTER_KEY`. `None` when
/// this process has no key.
fn signing_key_sealer() -> Option<std::sync::Arc<dyn ryu_crypto::SecretSealer>> {
    <ryu_crypto::GatewayScope as ryu_crypto::SealScope>::sealer().ok()
}

/// Read the persisted base64 32-byte seed from `path`.
///
/// * `Ok(None)`: no file.
/// * `Ok(Some(key))`: a sealed or legacy plaintext seed; a plaintext seed is
///   resealed in place when `sealer` is available (best effort).
/// * `Err`: the file exists but cannot be opened (sealed without a usable key)
///   or does not hold a valid seed. The caller must not overwrite it.
fn read_persisted_signing_key(
    path: &std::path::Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> anyhow::Result<Option<SigningKey>> {
    let Some(opened) = ryu_crypto::read_secret_file(path, sealer)? else {
        return Ok(None);
    };
    let key = signing_key_from_seed(opened.value.trim())
        .ok_or_else(|| anyhow::anyhow!("not a base64 32-byte ed25519 seed"))?;
    if opened.needs_reseal {
        if let Some(sealer) = sealer {
            match ryu_crypto::write_secret_file(path, &opened.value, sealer) {
                Ok(()) => tracing::info!(
                    path = %path.display(),
                    "governance: sealed the plaintext marketplace signing key in place"
                ),
                Err(error) => tracing::warn!(
                    path = %path.display(),
                    "governance: could not seal the plaintext marketplace signing key: {error}"
                ),
            }
        }
    }
    Ok(Some(key))
}

/// Persist a signing key's 32-byte seed (base64) to `path`, sealed with the
/// Gateway's sealing key. Returns `true` on success. Never panics.
///
/// Fails closed: without a sealer nothing is written (the caller then runs on
/// an ephemeral key and says so). The write is atomic (owner-only temporary
/// file, fsync, rename), so a crash never truncates the seed and silently
/// rotates the trust root, and the parent directory is tightened to `0700`.
fn persist_signing_key(
    path: &std::path::Path,
    key: &SigningKey,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> bool {
    let Some(sealer) = sealer else {
        tracing::warn!(
            path = %path.display(),
            "governance: no Gateway sealing key, so the marketplace signing key is not persisted (start the Gateway with RYU_MASTER_KEY, or set {ENV_SIGNING_KEY})"
        );
        return false;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the file itself is written 0600 regardless.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let seed_b64 = B64.encode(key.to_bytes());
    match ryu_crypto::write_secret_file(path, &seed_b64, sealer) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(path = %path.display(), "governance: could not persist the sealed signing key: {error}");
            false
        }
    }
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
mod tests;
