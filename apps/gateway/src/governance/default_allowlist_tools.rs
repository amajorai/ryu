//! First half of the built-in default grant allowlist: the tool, MCP, egress,
//! data, model and identity scopes.
//!
//! Moved as is out of `default_grant_allowlist()` in `mod.rs`, which went over
//! the file size limits. `mod.rs` joins this half and `default_allowlist_host`,
//! in this order, and its doc comment is the review rule for both.

/// The scopes of this half, in their reviewed order.
pub(super) fn tool_and_data_scopes() -> Vec<String> {
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
        // is covered by the owner-exclusive `tool:command:spider` — the two grants name different
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
        // `tool:command:<bin>` grants are NOT here: a `command` tool chooses literal
        // argv for a trusted binary (`rtk proxy sh -c …`), which is unsandboxed
        // exec. Each is owner-exclusive to its first-party plugin instead (see
        // `OWNER_EXCLUSIVE_GRANTS`).
        // Ship-code-in-a-manifest, for BOTH an `inline_js` tool and a capability
        // ADAPTER (the JS a layer provider ships when its shape — an async job API,
        // a token vocabulary — is beyond what the declarative binding fields can
        // express). Deliberately allowlisted rather than owner-scoped: an adapter is
        // grant-gated precisely so shipping code stays a visible, approvable act,
        // and a plugin self-approving it would defeat that.
        "tool:execute",
        // `tool:http-egress:127.0.0.1` is NOT here: it names a host, not a port, so
        // it reaches every loopback listener. It is owner-exclusive to its reviewed
        // first-party declarers (see `loopback_egress::LOOPBACK_EGRESS_OWNERS`).
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
        // `skills:crud` is owner-exclusive (see `crossapp_grants`): it writes
        // always-on, tool-preapproved SKILL.md files into the shared skills root.
        // model / network scopes
        "model.chat",
        "model.embed",
        "network.fetch",
        // identity-vault scopes (#523): a connection-capture flow and a sealed
        // credential read. Like every scope here they stay swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "browser.connect",
        "identity.read",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}
