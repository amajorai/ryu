# Open-Core Boundary

Ryu follows an open-core model (the Vercel / Supabase shape): the orchestration and control
infrastructure is open-sourced and self-hostable so contributors and enterprise operators can
audit, extend, and deploy it themselves; the UX and identity layer is closed.

## Tier mapping

Every unit in the monorepo carries its own `LICENSE` file and maps to one of these tiers.

| Path | Tier | License | Why |
|---|---|---|---|
| `apps/core` | OSS — self-hostable | Apache-2.0 | Orchestration engine: sessions, memory, tools, workflows, sub-agents, sidecars. Open-sourcing builds trust; zero-egress self-hosting. Max adoption → permissive. |
| `apps/gateway` | OSS — self-hostable | **AGPL-3.0** | LLM gateway: routing, firewall, PII/DLP, budgets, evals, audit. The shared layer a team adopts and an enterprise buys — and the layer Ryu sells as a managed service. AGPL keeps it OSI-open while obligating SaaS forks to share their modifications (copyleft on the control layer). |
| `apps/cli` | OSS — self-hostable | Apache-2.0 | Thin Core client; drives adoption. |
| `apps/ghost` + `crates/ghost-{core,eyes,hands}` | OSS — self-hostable | Apache-2.0 | Desktop-automation MCP server + its crates. Dual-use; open for auditability. Shadow depends on the ghost crates, so they open by consequence. |
| `apps/shadow` + `crates/shadow-core` | OSS — self-hostable | Apache-2.0 | Screen/audio capture + semantic search. Dual-use; open-sourcing a screen recorder is a trust asset. |
| `apps/fumadocs` | OSS | Apache-2.0 | Documentation site. |
| `packages/sdk` + `packages/create-ryu-app` | OSS | Apache-2.0 | Dev SDK + scaffolder; must be open to grow the plugin ecosystem. |
| `packages/client` | OSS | Apache-2.0 | TS client for the open Core API; no internal deps. |
| `crates/ryu-sdk{,-ffi,-napi}` | OSS | Apache-2.0 | SDK kernel + FFI/Node-API bindings. |
| `apps/raycast` | OSS | MIT | Already MIT; fenced out of the workspace with its own toolchain. |
| `apps/desktop` | Closed — proprietary | Proprietary | The primary UX surface: making agents as easy as installing an app on desktop. |
| `apps/web` | Closed — proprietary | Proprietary | Marketing, auth flows, dashboard/billing, Notion blog/help/changelog. |
| `apps/server` | Closed — proprietary | Proprietary | Identity and content plane: Better Auth, OAuth/2FA, billing (Polar), Notion-backed content. |
| `apps/native` | Closed — proprietary | Proprietary | Expo/React Native mobile app. |
| `apps/island` | Closed — proprietary | Proprietary | Dynamic-island companion overlay — differentiated UX surface. |
| `apps/command` | Closed — proprietary | Proprietary | "Golden Gate" command launcher — differentiated UX surface. |
| `apps/storyboard` | Closed — proprietary | Proprietary | Internal screen + design-system explorer. |
| `apps/extension` | Closed — proprietary | Proprietary | Browser extension. Kept closed for now (depends on the closed `@ryu/ui`); could open later for adoption after decoupling. |
| `packages/ui` | Closed — proprietary | Proprietary | Shared design system, shared by closed desktop/extension/island/command. |
| `packages/command` | Closed — proprietary | Proprietary | Shared command palette + ChatView. |
| `packages/{auth,db,api,email,settings,env,config}` | Closed — proprietary | Proprietary | Identity / persistence / config layer. |

> **The closed apps are thin GUIs over the open engine.** Everything that touches your
> data or makes a decision is open and auditable: orchestration (`apps/core`), model
> governance (`apps/gateway`), and on-device capture (the open `shadow` sidecar). The
> desktop and Island are windows onto `ryu-core` — they talk to it over local HTTP and
> render the result; the substance is open, the shell is just UI. Closed-ness here is a
> UX/brand layer, not a place where logic hides.
>
> **The audit's recommendation vs. the current call.** The 2026-06-17 strategic audit
> (an internal strategic audit) recommended opening
> the **extension** and **`@ryu/ui`** for adoption. The current policy keeps both **closed** — a
> deliberate choice (a closed extension can use closed `ui`, and opening the shared `ui`
> would hand a cloner the paid desktop's UI layer); revisit if the extension becomes an
> adoption priority.

> **Pre-publication blocker (not yet cleared).** These LICENSE files declare intent. Before the
> OSS units are published to crates.io / npm or split into public mirrors, run a third-party
> dependency-license scan (`cargo deny check licenses` for Rust, `license-checker` for TS) to
> confirm no GPL/AGPL/SSPL-incompatible transitive dependency forces a different license, then add
> the SPDX `license` field to each manifest. See the internal strategy notes for detail.

## The plugin-runtime rule

The closed desktop stays extensible **only** if the plugin/extension runtime lives in OSS Core
(the VS Code / Codex model). Third parties author plugins at every layer via one manifest
(`manifest.json`) and the dev SDK; the runtime that loads and registers those plugins is in
`apps/core`, not in `apps/desktop`. This keeps the plugin store extensible without requiring the
closed desktop to be open-sourced.

The plugin/extension runtime is implemented in unit U054 (issue #168,
`apps/core/src/plugin_manifest/`) — the closed desktop delegates all plugin loading to it.

## Self-hosting

To self-host the OSS tier:

1. Build `apps/core` - `cargo build --release` in `apps/core/`
2. Build `apps/gateway` - `cargo build --release` in `apps/gateway/`
3. Point any OpenAI-compatible client at the gateway's `/v1/chat/completions` endpoint.

No `apps/desktop`, `apps/web`, or `apps/server` code is required for a self-hosted deployment.

## License placement

Every app, package, and crate now carries its own `LICENSE` file. By license:

| License | Units |
|---|---|
| **Apache-2.0** | `apps/{core,cli,ghost,shadow,fumadocs}`, `crates/{ghost-core,ghost-eyes,ghost-hands,shadow-core,ryu-sdk,ryu-sdk-ffi,ryu-sdk-napi}`, `packages/{sdk,create-ryu-app,client,headroom}` |
| **AGPL-3.0** | `apps/gateway` |
| **MIT** | `apps/raycast` |
| **Proprietary** | `apps/{desktop,web,server,native,island,command,storyboard,extension}`, `packages/{ui,auth,db,api,email,settings,env,config,command}` |

Copyright 2026 A Major Pte. Ltd.
