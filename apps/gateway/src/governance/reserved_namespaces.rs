//! The reserved host-primitive namespaces of the grant grammar.
//!
//! Moved as is out of `mod.rs`, which went over the file size limits. `mod.rs`
//! caches the list in `reserved_namespace_list()` and hands it to the grant
//! policy.

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
pub(super) fn reserved_namespaces() -> Vec<String> {
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
        // Security-key relay is a Core-owned host primitive: `security-key:relay`
        // asks the user's desktop key to sign for a page; reserved so an app
        // such as `com.evil.security-key` cannot self-approve it.
        "security-key",
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
