# toolsmith

Scaffold, verify and seal Ryu plugin tools so a tool an agent (or a person) writes
is **deterministic** and **proven by cases** before anything can call it.

```
node tools/toolsmith/index.mjs scaffold --id @scope/name --tool slug [--kind inline_tool|adapter] [--out DIR]
node tools/toolsmith/index.mjs verify   <plugin dir>
node tools/toolsmith/index.mjs sync     <plugin dir> [--check]
```

Re-running `scaffold` on an existing package regenerates `tool.test.mjs` only. The
body and `cases.json` are authored and are never overwritten — to start one over,
delete the file.

## Why this exists

A tool body in Ryu is a **fragment**, not a module: Core splices it into an async
IIFE with a fixed set of bindings and the body `return`s its result
(`build_inline_tool_program` / `build_capability_adapter_program` in
`crates/core/tool-exec/src/lib.rs`). Because it is not a module, `node --test`
cannot import it — so the co-located `plugins-store/{plugins,lsp,external_plugins}/*/plugin.test.mjs` files
mostly assert on manifest *shape*, and the 26 that execute a hook currently
hand-roll their own `new AsyncFunction("ctx", "host", code)` with ad-hoc stubs.

Nothing checked that a tool body was replayable, and nothing ran any of it in CI.

toolsmith is the shared piece: one splice, one stub protocol, one gate.

## The three fragment forms

| `cases.json` `kind` | Injected bindings | Core builder |
| --- | --- | --- |
| `inline_tool` (default) | `input`, `caller`, `host` | `build_inline_tool_program` |
| `adapter` | `input`, `defaults`, `callTool`, `callNamed` | `build_capability_adapter_program` |
| `turn_hook` | `ctx`, `host` | `plugin_host::build_hook_program` |

`scaffold` emits `inline_tool` and `adapter` packages. `turn_hook` is supported by
the harness (set `"kind": "turn_hook"` in `cases.json`) but has no scaffold
template yet: it exists so the 26 `plugins-store/{plugins,lsp,external_plugins}/*/plugin.test.mjs` files that
hand-roll their own `new AsyncFunction("ctx", "host", code)` splice can converge
onto one implementation.

## What "deterministic" means here, precisely

A tool that calls a search API is not deterministic and never will be. The
testable property — and the one the sandbox actually supports — is narrower:

> The body is a **pure function of its injected input and the answers its declared
> effects returned.** All nondeterminism is confined to `host.*` / `callTool` /
> `callNamed`, which are exactly the calls a case can stub.

Three mechanisms enforce it, and all three must pass:

1. **Static purity scan** (`purity.mjs`) — rejects `Date.now()`, argless
   `new Date()`, `Math.random()`, `crypto` randomness, `performance.now()`,
   `fetch`, `process.env`, timers, `globalThis`, `eval`, `new Function`,
   `require`, `import`/`export`, and `Deno.*`. Runs on the source, so an offender
   in an untested branch is still caught. Comments and string literals are blanked
   first, so prose *about* a rule does not trip it.
2. **Shadowed globals** (`harness.mjs`) — each of those names is bound as a
   *parameter* that throws `ImpureAccessError`, so the body physically cannot
   reach the real global. `Math.max` and `new Date(ms)` still work: only the
   impure members are poisoned.
3. **Double execution** — every case runs twice against fresh, identically-seeded
   stubs and the two results must deep-equal.

## What "outcomes" means

`expect` pins the return value. `expectCalls` pins the **effect sequence** — every
`host.*` / `callTool` / `callNamed` invocation, in order, with exact arguments.
That is the half that catches a tool returning the right shape while calling the
wrong endpoint.

`callNamed` is additionally checked against the manifest's `adapter.tools`
allowlist, mirroring Core's host-side check, so a case cannot pass against a call
the real runtime would refuse.

## `cases.json`

```jsonc
{
  "tool": "web.extract",
  "kind": "adapter",              // inline_tool | adapter | turn_hook
  "code_file": "adapters/web.extract.js",
  "adapter_tools": [],            // adapter only: the callNamed allowlist
  "cases": [
    {
      "name": "maps a provider hit onto the canonical shape",
      "input":    { "url": "https://example.com" },
      "caller":   { "agent_id": "ryu", "conversation_id": "c1" }, // inline_tool only;
                                             //   host-derived, defaults to nulls
      "defaults": { },                       // adapter only
      "provider": {                          // adapter only
        "call":  [ { "structuredContent": { "content": ["a", "b"] } } ],
        "named": { "job.status": [ { "done": true } ] }
      },
      "host": {                              // inline_tool / turn_hook only
        "sideModel": [ { "text": "…" } ],    // a QUEUE, one entry per expected call
        "storage":   { "seen": "1" }         // seed for a real read-after-write Map
      },
      "expect":      { "results": [ … ] },   // exactly one of expect /
      "expectError": "…",                    //   expectError (regex) /
      "expectImpure": "Date.now",            //   expectImpure (regex)
      "expectCalls": [ { "path": "callTool", "args": { … } } ]
      // recorded args are JSON-snapshotted: an optional argument the body never
      // passed is ABSENT, not `undefined`, so a case can express it
    }
  ]
}
```

At least **three** cases are required — happy path, edge case, failure. One happy
path proves nothing about a tool.

## The gate

Both `verify` (the CLI) and `defineToolTests` (the generated suite) run the same
four steps, in the same order. That duplication is the point: if only the CLI
enforced them, `bun run test:plugins` would go green on a body that had been
edited and never resealed — certifying code that is not what ships.

The order is load-bearing:

1. **Purity scan.** First, because it is the only step that runs *before* the body
   does. Its denylist covers every escape from the harness (`import`, `require`,
   `eval`, `new Function`, `process`, `fetch`, `Deno`), so clearing it is what
   makes step 4 safe to run on someone else's code at all. **Never call `runCase`
   on an unscanned body.**
2. **Manifest contract.** The seat exists; the tool is routable (real description,
   `input_schema`) and callable (`tool:execute` granted — without it Core registers
   an `inline_deno` tool and then refuses every call).
3. **Drift check.** The manifest carries exactly the body the cases tested.
4. **Cases.** `node --test`, every case twice. Inside the suite a purity
   violation ABORTS registration of the case tests, so nothing impure is ever
   executed.

### The harness is a guardrail, not a sandbox

The purity scan is a conservative regex denylist over source with comments and
strings blanked; it does not model regex literals, and the body runs with full
Node privileges in this process. Use it on tool bodies you or your team wrote and
have read. It is **not** a vetting step for an untrusted third-party plugin — the
thing that actually confines that code is Core's Deno sandbox.

## Why `sync` exists

`ToolConfig` (`crates/core/kernel-contracts/src/schema.rs`) has **no `code_file`
field** — an `inline_deno` tool's only loadable form is a JSON string in the
manifest. Authoring in that string is what AGENTS.md bans for hooks and adapters,
for a reason that applies here identically: nobody audits a `\n`-escaped blob, and
that is where malicious code hides.

So toolsmith splits the two: `tools/<slug>.js` is the **source** form (diffable,
lintable, reviewable) and the manifest `code` string is the **wire** form, sealed
from the file by `sync`. `sync --check` is what stops them drifting, and `verify`
runs it.

An **adapter** needs no sealing: `adapters/<verb>.js` is a real `code_file` that
Core hydrates from disk (`hydrate_manifest_code_files`), so there the check is only
that the manifest points at the file the cases test — and that it has not been
"simplified" back to an inline `code`.

## Where a made tool can live

| Situation | Home |
| --- | --- |
| Built at dev time, shipped with Ryu | `plugins-store/{plugins,lsp,external_plugins}/<name>/` (add the `include_str!` registration row) |
| Made by an agent at runtime, on a user's machine | `~/.ryu/plugins/<id>/` — `hydrate_manifest_code_files` reads `code_file` off disk for any manifest with a `code_base`, so this works today with no Core change |
| Needs a process: a Python lib, a binary, a long-lived server | Not a plugin tool. `apps-store/<app>/sidecar/` with an `http.public_mount`, per AGENTS.md |

## Where things live

| Path | What |
| --- | --- |
| `tools/toolsmith/*.mjs` | the harness, the scan, the manifest checks, the CLI |
| `tools/toolsmith/*.test.mjs` | one test file per module, beside the module |
| `plugins-store/plugins/toolsmith-example/` | the worked example — a real verified tool, in its own plugin folder like every other package, so `bun run test:plugins` picks it up with no special-casing. Deliberately in Core's `UNREGISTERED_BY_DESIGN` list: registering a demo would put it in every user's catalog. |

In the private monorepo, both suites run in CI (`.github/workflows/ci.yml`, the `js` job):

```bash
bun run test:tools     # the harness's own tests + the repo's generators
bun run test:plugins   # every packaged plugin's co-located tests
```

The public runtime hub carries the harness itself and exposes its standalone checks as
`bun run test:toolsmith`. It does not carry the full packaged-plugin source tree; that source lives
in the Marketplace projection. The public-facing version of this document is
[`Testing Plugin Tools`](https://docs.ryuhq.com/docs/extend/develop/extensions/testing-plugin-tools);
this file is the contributor-facing contract and may name monorepo internals the docs page must not.

## Known gaps (deliberate, not oversights)

- **`ToolConfig` has no `code_file`.** Adding one (plus `"tools"` to
  `CODE_FILE_DIRS`, hydration, the `builtin_code` table and the
  `mirror-public.sh` step-1c glob) would delete `sync` entirely. Until then the
  seal + drift check is the substitute.
- **`packaged_plugin_manifests_declare_no_inline_sandbox_code`** (Core) checks
  `contributes.turn_hooks[].code` and `provides[].tools.*.adapter.code`, but not
  `runnables[].config.code`. An `inline_deno` tool can therefore still ship a
  hand-written blob and no Core test objects; `toolsmith verify` is what closes
  that for packages that opt in.

  If you tighten that guard to cover `runnables[].config.code`, note that
  `plugins-store/plugins/toolsmith-example` will trip it — **not a regression**. Its inline
  `code` is machine-sealed from `tools/text_chunk.js` by `sync`, and the drift check
  proves the two agree on every run. It is exempt by construction until `ToolConfig`
  gains a `code_file` field, at which point the example converts and the exemption
  goes away with `sync` itself.
- **The runtime gate is now the twin of this CLI.** `ryu_self_build` gained
  `write_tool` / `verify_tool` / `install_tool`
  (`apps/core/src/runnable/self_build.rs` + `tool_build.rs`): an agent in chat
  can author a body + case table, run the SAME four checks here — purity,
  contract, drift, cases — with the cases executed **inside Core's deny-all Deno
  sandbox** (`ryu_tool_exec::run_eval_js`) instead of this Node process, and
  only a passing tool is ever hot-installed. No Node on the user's machine, no
  `tools/` directory shipped. `verify` (CLI) and `verify_tool` (runtime) are the
  two gates that must stay in lockstep; this README is the contract for both.
- **`ToolConfig` has no `code_file`.** Adding one (plus `"tools"` to
  `CODE_FILE_DIRS`, hydration, the `builtin_code` table and the
  `mirror-public.sh` step-1c glob) would delete `sync` entirely. Until then the
  seal + drift check is the substitute.
