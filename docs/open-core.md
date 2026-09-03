# Open-Core Boundary

Ryu follows an open-core model (the Vercel / Supabase shape): the orchestration and control
infrastructure is open-sourced and self-hostable so contributors and enterprise operators can
audit, extend, and deploy it themselves; the UX and identity layer is closed.

The supported OSS deployment unit is the **Self-hosted Ryu Node**: Ryu Core +
Ryu Gateway, used through the CLI, SDK, or another compatible client. It does
not require a Ryu-operated account or control-plane backend. A **Private/Full
Ryu Deployment** is a separate customer-operated offering that adds the
proprietary identity, organization, billing, entitlement, and Marketplace plane
around one or more self-hosted nodes.

## Tier mapping

Public projections may split a unit across the runtime hub and a satellite. The tier map below
identifies the source owner and license; root or subtree `LICENSE` files govern each checked-out
path.

| Path | Tier | License | Why |
|---|---|---|---|
| `apps/core` | OSS — self-hostable | Apache-2.0 | Orchestration engine: sessions, memory, tools, workflows, sub-agents, sidecars. Open-sourcing builds trust; zero-egress self-hosting. Max adoption → permissive. |
| `apps/gateway` | OSS — self-hostable | **AGPL-3.0** | LLM gateway: routing, firewall, PII/DLP, budgets, evals, audit. The shared layer a team adopts and an enterprise buys — and the layer Ryu sells as a managed service. AGPL keeps it OSI-open while obligating SaaS forks to share their modifications (copyleft on the control layer). |
| `apps/cli` | OSS — self-hostable | Apache-2.0 | Thin Core client; drives adoption. |
| `crates/ghost/{core,eyes,hands}` + `amajorai/ghost` satellite | OSS — self-hostable | Apache-2.0 | Desktop-automation MCP server + its crates. The source and release archive are maintained in the Ghost satellite. |
| `crates/ghost/shadow` + `amajorai/shadow` satellite | OSS — self-hostable | Apache-2.0 | Screen/audio capture + semantic search. The source and release archive are maintained in the Shadow satellite. |
| `apps/fumadocs` → [`amajorai/ryu-docs`](https://github.com/amajorai/ryu-docs) | OSS | Apache-2.0 | Documentation site. Published as its own repo, not part of this tree. |
| `packages/{sdk,create-ryu-app,client}` | OSS | Apache-2.0 | SDK authoring packages, published from the standalone `amajorai/ryu-sdk` hub. |
| `packages/{core-client,protocol,config}` | OSS | Apache-2.0 | Runtime clients and shared wire/config helpers required by the public CLI and source-available shell; also published from the SDK hub. |
| `crates/sdk/{core,ffi,napi,uniffi}` + `bindings/` | OSS | Apache-2.0 | SDK kernel, native adapters, and language bindings, published from `amajorai/ryu-sdk`, not the main runtime hub. |
| `amajorai/ryu-raycast` satellite | OSS | MIT | Separate MIT source snapshot; not included in this runtime hub. |
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
| `packages/{auth,db,api,email,settings,env}` | Closed — proprietary | Proprietary | Identity / persistence / environment layer. |

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

### Self-hosted Ryu Node

To self-host the OSS node:

1. Build `apps/core` - `cargo build --release` in `apps/core/`
2. Build `apps/gateway` - `cargo build --release` in `apps/gateway/`
3. Configure a local model or your own provider keys.
4. Point the CLI, SDK, or any OpenAI-compatible client at the node.

The node owns its runtime state, model/provider configuration, policies, audit,
and local storage. No `apps/server`, Ryu account, Ryu billing account, or Ryu
Marketplace service is required.

### Private/Full Ryu Deployment

A full customer-operated product deployment adds the proprietary control plane
(`apps/server` and its supporting Web/API surfaces) for account sessions,
organizations, entitlements, billing, Marketplace commerce, and managed-node
operations. That deployment is customer-operated under the applicable
commercial terms; it is not part of the public OSS self-hosting unit.

## License placement

The public projection uses root or subtree license files for the following units; satellite-owned
units retain their own repository license:

| License | Units |
|---|---|
| **Apache-2.0** | `apps/{core,cli}`, `crates/core/*`, `crates/ghost/*`, `crates/sdk/{core,ffi,napi,uniffi}`, `packages/{sdk,create-ryu-app,client,core-client,protocol,config,headroom}`, and the OSS satellites named above |
| **AGPL-3.0** | `apps/gateway` |
| **MIT** | `amajorai/ryu-raycast` satellite |
| **Proprietary** | `apps/{desktop,web,server,native,island,command,storyboard,extension}`, `packages/{ui,auth,db,api,email,settings,env,command}` |

Copyright 2026 A Major Pte. Ltd.
