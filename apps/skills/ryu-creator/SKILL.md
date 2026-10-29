---
name: ryu-creator
description: Create, extend, test, and package Ryu plugins and apps using Ryu's architecture, shared primitives, design system, and manifest contracts. Use for new extensions, Companion surfaces, chat widgets, tools, hooks, and app sidecars.
---

# Ryu Creator

Build the requested extension on Ryu's existing capabilities. Deliver a working package, its relevant documentation, and evidence of the actual user flow. A skill supplies guidance, not permissions to publish or deploy.

## Establish the contract

Identify the intended user flow, supported hosts, data owner, required capabilities, and package shape before scaffolding. In a source checkout read `AGENTS.md`, `docs/ryu-platform-consistency-standard.md`, `DESIGN.md`, and the nearest working extension. Outside the checkout use the installed SDK's types, CLI help, and the matching public docs at https://docs.ryuhq.com/docs; do not assume private paths exist or invent APIs. Verify documentation against the installed version.

Read these public routes for the relevant mode:
- `/start-here/architecture/platform-consistency`: ownership and cross-surface contracts.
- `/extend/develop/extensions/plugins-vs-apps` and `/extend/develop/extensions/schemas-and-layouts`: package shape and canonical formats.
- `/extend/develop/quickstart` and `/extend/develop/sdk/primitives`: scaffolding and available runtime clients.
- `/extend/develop/extensions/companion-ui`: full app surfaces; `/extend/develop/extensions/ryu-apps`: in-chat widgets.
All routes above are relative to `https://docs.ryuhq.com/docs`.

A plugin contributes runtime behavior such as tools, hooks, agents, workflows, or adapters. An app owns a product process or surface and composes platform primitives. An in-chat widget is a distinct UI mode; do not substitute it for a requested full Companion app. Start from `bunx create-ryu-app <name>` when its template fits; inspect its generated scripts and installed CLI help before running development and packaging commands.

## Architecture and primitives

- Core owns execution, sessions, files, and sidecar lifecycle. Gateway owns policy, routing, budgets, audit, and governed model access. The app owns domain behavior and durable domain state; host UIs are projections, never authorization authorities.
- Reuse the SDK's agents, tools, workflows, skills, Gateway, memory, spaces/retrieval, durable execution, and optional media/realtime clients when their installed contracts fit. Inspect `RunnableContext` and feature-detect optional clients. Keep model calls on `ctx.gateway` or a documented governed host capability, never a browser provider key.
- Define a public contract once, generate adapters, and retain existing wire spellings. New public JSON fields use camelCase, stable opaque IDs, explicit timestamp units, bounded pagination, and versioned migrations. Do not hand-maintain competing Rust/TypeScript schemas.
- App sidecars are standalone and must not depend on `apps/core`. In Ryu's source tree use the browser satellite as the reference. Do not add app-specific Core/Gateway routes, clients, IDs, ports, or capabilities. Use manifest `http.public_mount`, the generic `/api/ext/<app-id>/*` seam, injected sidecar ports, and the capability broker. Declare abstract requirements instead of hardcoding a provider app where a capability exists.
- Use caller-aware host bridges for platform data. Never accept client-supplied tenancy as authority. Keep secrets in the host vault or deployment boundary; frames receive neither provider credentials nor unrestricted network/filesystem access.

## Manifest and executable packaging

`manifest.json` is canonical; `plugin.json` and `mcp.json` are generated interop projections, and `ryu.package.json` is a portable package envelope. Inspect the current schema for exact fields, grant names, surface support, runtime requirements, versions, and minimum Ryu version. A declared grant is a request, not approval.

In the source collection, sandbox hooks and adapters are flat `.js` fragments referenced by `code_file`, under the extension's `hooks/` or `adapters/`. Preserve their header; top-level `return` is valid inside the host IIFE, `export` is not. Hooks receive `ctx`/`host`; adapters receive `input`/`defaults`/`callTool`/`callNamed`. When adding a body to the built-in collection, update its literal entry in `apps/core/src/plugin_manifest/builtin_code.rs` and existing hook/adapter vendoring in `tools/mirror-public.sh`. Packing must inline the body as `code` inside the signed surface; unresolved `code_file` must not reach clients.

Use the package's build and `ryu pack` path, inspect the emitted bundle, and test installation and enablement on an isolated node. Exercise permission denial as well as successful execution. Keep Marketplace metadata and generated projections derived from the same manifest. Consult checkout release instructions before changing mirrors or publishing; local build success does not establish publication.

## Hooks: choose the actual control point

Read `/extend/develop/extensions/hooks-lifecycle` and the installed hook schema before authoring. Declare explicit `on`, stable hook `id`, and a narrow `match.tools` gate when applicable under `contributes.turn_hooks`. `defineTurnHook` defaults to `post_assistant_turn`; specify the phase rather than relying on that default. The SDK builder is a serialization helper, not permission to ship inline strings in Ryu's source collection.

| Need | Phase and supported result |
| --- | --- |
| Add initial context | `session_start`: `inject` or `note` |
| Change/answer a pending user turn | `pre_user_turn`: `replace`, `inject`, or `handled` (no model call; first handler wins) |
| Block a tool before execution | `pre_tool_use`: `deny` with a safe reason |
| Redact/narrow a returned tool value | `tool_result`: awaited `transform` with `output` |
| Observe completed tools | `post_tool_use`: detached observation only |
| Reshape outbound context | `context`: `rewrite` with `messages` on the message-array plane; `replace` with `text` on ACP |
| Change an assistant message before persistence | `message_end`: `replace` |
| Add a note/follow-up after persistence | `post_assistant_turn`: `note` or bounded `continue` |
| Change a compaction summary | `session_compact`: `replace`; `session_before_compact` only observes |
| Observe delegation, session, model, tree, notification, workflow events | Use the documented event phase and `ctx.event`; do not return control directives to an observation-only phase |

Keep hook bodies self-contained and cross-platform: no captured imports/closures, shell wrappers, Node/Bun/Deno/process APIs, direct fetch/filesystem calls, or hardcoded home/temp/drive paths. Use package-relative forward-slash `code_file` paths and the declared host bridge. A missing sandbox is not a reason to run a shell fallback. If the installed SDK exposes additional middleware/function hooks or phases, inspect their current continuation, matching, and directive contracts before using them; do not infer them from the ordinary turn-hook table.

Inspect the fields actually present on `ctx`; ACP context has `input`, not the outbound message array. Preserve multimodal content when rewriting `messages`. A `context` hook may change only the newest user message (and anything after it); the system prompt and earlier turns are the prompt-cache prefix, and Core ignores a `rewrite` that edits them. On ACP, a `replace` must keep `ctx.input` as its exact prefix and only append. A `note` is not history replacement, and `post_tool_use` cannot prevent an already-executed side effect.

Transforms chain in priority order: each hook receives the latest output, and downstream observers see the final transformation. Never restore raw output captured before another transform. Runtime errors/ungranted host calls can degrade to `none`; a hook is not a substitute for mandatory Gateway policy. Explicitly test timeouts and failures for any purported security boundary.

Use `host.sideModel` (`hook:side-model`), namespaced `host.storage` (`storage:kv`), `host.notify` (`notifications:send`), and `host.log` according to their real contracts. Check `ctx.flags` for user-controlled composer modes. Deduplicate using a stable event/turn key and conversation/plugin scope; do not use a process-global counter for unrelated users. Keep continuations bounded, cancellation-aware, and within user scope; repeated notifications, agent creation, or model spending must not happen merely because a hook retries. Extra-budget modes are explicit opt-ins.

Verify matching and nonmatching tools, phase/plane mismatch, chained transforms, denied host grants, repeated events, failure/timeout, disable/re-enable, and persisted versus displayed output. A phase documented as wired is not proof that a particular engine path has been live-tested.

## Other extension modes

Read only the relevant public reference before implementing a mode:

- `/core/swappable-layers` and `/extend/develop/extensions/capability-broker`: `requires`/`provides`, versions, selectors, overrides, and adapter input/output contracts. Bind through the broker; a missing, incompatible, or ambiguous provider needs a visible recovery state. Adapters use declared tools through `callTool`/`callNamed`; they cannot invent privileged bridge access.
- `/extend/develop/extensions/author-actions` and `/extend/develop/extensions/testing-plugin-tools`: typed tool schemas, executable backends, effect metadata, and test seams. Unknown tool effects do not become read-only by naming convention.
- `/extend/develop/extensions/author-workflows` and `/core/workflows`: decide between an SDK `defineWorkflow` Runnable and a stored workflow definition. Use the engine's schema for node types, gates, triggers, retries, cancellation, and resume; an SDK `steps` list is not a stored graph or automatic durable scheduler.
- `/extend/develop/extensions/plugin-json-manifest`: contribution slots, settings, composer controls, slash commands, tool filters, engine pins, managed sidecars, and supported hosts. A setting/control must be wired to runtime behavior; declaring it alone does not implement the action. Keep tool visibility separate from authorization.
- `/extend/develop/extensions/agent-skills`: bundle complete skill trees, retain resources in the signed package, and check enable/disable/uninstall ownership. A body-less skill reference is not a loadable skill.
- `/extend/integrate/byo-agent` and `/extend/mcp/configuration`: use existing ACP/MCP integrations rather than a new agent transport. Feature-detect host support and preserve credential-purpose boundaries.

For building a saved agent or SDK agent, use `ryu-agent-creator` when available. Keep app packaging and UI ownership here; agent lifecycle, prompt design, tool/memory scope, and behavioral evals belong to that specialist.

## Ryu design system

Companion surfaces import `@ryu/ui/app-ui.css`, mark the root with `markCompanionAppRoot`, subscribe through `subscribeCompanionTheme()` when available, and compose `RyuAppShell` from `@ryu/blocks/companion/app-ui`. Use its toolbar, main, section, list, detail, form, field, empty, and action roles with `@ryu/ui` controls. Load `ryu-app-ui` if available for detailed examples; these foundations still apply when it is absent.

The host owns primary navigation: declare sidebar sections/buttons in the manifest, not a second primary sidebar inside the app. Use semantic tokens and host typography, spacing, focus, and motion. Interface copy uses the sans role, headings the heading role, numeric/ID data the mono role, and code the separate code-font role. Do not copy token blocks, invent raw colors or type scales, or ship a second control library. Static satellite adapters must preserve the same App UI v1 contract. Widgets use their documented sandbox bridge and self-contained bundle; do not assume Companion APIs exist there.

Provide loading, empty, success, error, unavailable/offline, disabled, and permission-denied states where applicable. Feature-detect host capabilities rather than assuming Desktop APIs on Web or Mobile.

## Completion evidence

Run focused schema, packing, behavior, and security-boundary tests plus the affected build/type checks. Test cancellation, retry/idempotency, invalid input, and persistence when the feature uses them. Verify the actual rendered target in light/dark themes, narrow width, keyboard navigation, and reduced motion where relevant. Inspect and save a screenshot or recording of the completed product flow, including logs for runtime failures. Update the relevant public Fumadocs page with user-facing behavior; keep internal runbooks, private links, credentials, and unverified deployment claims out. Report exactly what was built, installed, exercised, and published, with any remaining external gate stated separately.

## App identity

When creating or refreshing an app, load `ryu-app-icon` when available. Author filled, layered artwork and render it with Icon Composer. The host displays completed icons directly. Keep any separately declared Companion glyph consistent and inspect light/dark catalog and detail views.
