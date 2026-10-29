# Open-Core Boundary

Ryu follows an open-core model (the Vercel / Supabase shape): the orchestration and control
infrastructure is open-sourced and self-hostable so contributors and enterprise operators can
audit, extend, and deploy it themselves. The Desktop and Island UX layer is published
**source-available** (readable and buildable locally, but not open source), and the identity,
billing, and Web layer stays closed.

The supported OSS deployment unit is the **Self-hosted Ryu Node**: Ryu Core +
Ryu Gateway, used through the CLI, SDK, or another compatible client. It does
not require a Ryu-operated account or control-plane backend. A **Private/Full
Ryu Deployment** is a separate customer-operated offering that adds the
proprietary identity, organization, billing, entitlement, and Marketplace plane
around one or more self-hosted nodes.

## Tier mapping

Public projections may split a unit across the runtime hub and a satellite. The tier map below
identifies the source owner and license. [`LICENSING.md`](../LICENSING.md) explains which
declaration each entry follows: the unit's own `LICENSE` file, otherwise the SPDX `license` field
in its package manifest, otherwise the root `LICENSE`.

| Path | Tier | License | Why |
|---|---|---|---|
| `apps/core` | OSS — self-hostable | Apache-2.0 | Orchestration engine: sessions, memory, tools, workflows, sub-agents, sidecars. Open-sourcing builds trust; zero-egress self-hosting. Max adoption → permissive. |
| `apps/gateway` | OSS — self-hostable | **AGPL-3.0** | LLM gateway: routing, firewall, PII/DLP, budgets, evals, audit. The shared layer a team adopts and an enterprise buys — and the layer Ryu sells as a managed service. AGPL keeps it OSI-open while obligating SaaS forks to share their modifications (copyleft on the control layer). |
| `crates/gateway/*` (except `credentials`) | OSS — self-hostable | **AGPL-3.0** | The Gateway's capability crates. Each declares `AGPL-3.0-only` in its `Cargo.toml`; none carries its own `LICENSE` file. |
| `crates/gateway/credentials` | OSS — self-hostable | Apache-2.0 | Local Gateway credential handling shared by the standalone Gateway and Core hosts. It has no `LICENSE` file or manifest `license` field, so the root `LICENSE` applies. |
| `apps/cli` | OSS — self-hostable | Apache-2.0 | Thin Core client; drives adoption. |
| `apps/plugins`, `crates/core/*` | OSS — self-hostable | Apache-2.0 | Claude Code and Codex plugins that connect those agents to a Core node, and Core's capability crates. |
| `crates/ghost/{core,eyes,hands,permissions}` + `amajorai/ghost` satellite | OSS — self-hostable | Apache-2.0 | Desktop-automation MCP server + its crates. The source and release archive are maintained in the Ghost satellite. |
| `crates/ghost/shadow` + `amajorai/shadow` satellite | OSS — self-hostable | Apache-2.0 | Screen/audio capture + semantic search. The source and release archive are maintained in the Shadow satellite. |
| `apps/fumadocs` → [`amajorai/ryu-docs`](https://github.com/amajorai/ryu-docs) | OSS | Apache-2.0 | Documentation site. Published as its own repo, not part of this tree. |
| `packages/{sdk,create-ryu-app,client}` | OSS | Apache-2.0 | SDK authoring packages, published from the standalone `amajorai/ryu-sdk` hub; not included in this tree. |
| `packages/{core-client,protocol,config}` | OSS | Apache-2.0 | Runtime clients and shared wire/config helpers required by the public CLI and source-available shell; also published from the SDK hub. |
| `packages/{client,services,services-cli}` | OSS | Apache-2.0 | The standalone-services client, `@ryuhq/services` facade and `ryu-services` CLI/MCP that the public CLI's `ryu services` delegates to. |
| `crates/sdk/{core,ffi,napi,uniffi}` + `bindings/` | OSS | Apache-2.0 | SDK kernel, native adapters, and language bindings, published from `amajorai/ryu-sdk`; not included in this tree. |
| `amajorai/ryu-raycast` satellite | OSS | MIT | Separate MIT source snapshot; not included in this runtime hub. |
| `apps/desktop` | Source-available | `LICENSE-COMMERCIAL.md` | The primary UX surface: making agents as easy as installing an app on desktop. |
| `apps/web` | Closed — proprietary | Proprietary | Marketing, auth flows, dashboard/billing, Notion blog/help/changelog. |
| `apps/server` | Closed — proprietary | Proprietary | Identity and content plane: Better Auth, OAuth/2FA, billing (Polar), Notion-backed content. |
| `apps/native` | Closed — proprietary | Proprietary | Expo/React Native mobile app. |
| `apps/island` | Source-available | `LICENSE-COMMERCIAL.md` | Dynamic-island companion overlay — differentiated UX surface. |
| `apps/storyboard` | Closed — proprietary | Proprietary | Internal screen + design-system explorer. |
| `apps/extension` | Closed — proprietary | Proprietary | Browser extension. Kept closed for now; could open later for adoption after decoupling. |
| `packages/ui` | Source-available | `LICENSE-COMMERCIAL.md` | Shared design system used by Desktop and Island. |
| `packages/command` | Source-available | `LICENSE-COMMERCIAL.md` | Shared command palette + ChatView. |
| `packages/{blocks,settings,hotkeys,app-host,marketplace,workbench}` | Source-available | `LICENSE-COMMERCIAL.md` | The rest of the shared UI layer Desktop is built from, including its tab and split-view workbench model. |
| `packages/{auth,step-up,env}` | Source-available | `LICENSE-COMMERCIAL.md` | Shared auth client/config, the step-up client, and environment configuration used by the source-available surfaces. |
| `packages/{assistant-widget,browser-local-ai,i18n,portable-packages}` | Source-available | `LICENSE-COMMERCIAL.md` | The assistant surface and its browser-local inference, the language-pack bridge (also published in `amajorai/ryu-sdk`; see `LICENSING.md`), and the package validate/import/export implementation. |
| `packages/{db,api,email}` | Closed — proprietary | Proprietary | Persistence, API, and email layer of the identity plane; not included in this tree. |

> **The non-open-source apps are thin GUIs over the open engine.** Everything that touches your
> data or makes a decision is open and auditable: orchestration (`apps/core`), model
> governance (`apps/gateway`), and on-device capture (the open `shadow` sidecar). The
> desktop and Island are windows onto `ryu-core` — they talk to it over local HTTP and
> render the result; the substance is open, the shell is just UI. Their source is published
> under `LICENSE-COMMERCIAL.md` so it can be read and audited too; the commercial licence is a
> UX/brand boundary, not a place where logic hides.
>
> **The audit's recommendation vs. the current call.** The 2026-06-17 strategic audit
> (an internal strategic audit) recommended opening
> the **extension** and **`@ryu/ui`** for adoption. The current policy keeps the extension
> **closed** and `@ryu/ui` out of the open-source tier — a deliberate choice: `@ryu/ui` is
> published source-available under `LICENSE-COMMERCIAL.md`, which permits reading and local
> builds but not redistribution, because an open-source `ui` would hand a cloner the paid
> desktop's UI layer. Revisit if the extension becomes an adoption priority.

> **Pre-publication blocker (not yet cleared).** These LICENSE files declare intent. Before the
> OSS units are published to crates.io / npm or split into public mirrors, run a third-party
> dependency-license scan (`cargo deny check licenses` for Rust, `license-checker` for TS) to
> confirm no GPL/AGPL/SSPL-incompatible transitive dependency forces a different license, then add
> the SPDX `license` field to each manifest. See the internal strategy notes for detail.

## The plugin-runtime rule

The source-available desktop stays extensible **only** if the plugin/extension runtime lives in OSS Core
(the VS Code / Codex model). Third parties author plugins at every layer via one manifest
(`manifest.json`) and the dev SDK; the runtime that loads and registers those plugins is in
`apps/core`, not in `apps/desktop`. This keeps the plugin store extensible without requiring the
desktop to be open-sourced.

The plugin/extension runtime is implemented in unit U054 (issue #168,
`apps/core/src/plugin_manifest/`) — the desktop delegates all plugin loading to it.

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

This table matches [`LICENSING.md`](../LICENSING.md), the summary of the licence declarations in
this tree. Satellite-owned units retain their own repository license:

| License | Units |
|---|---|
| **Apache-2.0** | `apps/{core,cli,plugins}`, `crates/{core,ghost}/*`, `crates/gateway/credentials`, `packages/{client,services,services-cli,core-client,protocol,config}`, and the OSS Ghost, Shadow, and SDK satellites |
| **AGPL-3.0** | `apps/gateway` and every other `crates/gateway/*` crate |
| **MIT** | `amajorai/ryu-raycast` satellite (not included in this tree) |
| **Source-available** (`LICENSE-COMMERCIAL.md`) | `apps/{desktop,island}`, `packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace,auth,step-up,env,assistant-widget,browser-local-ai,i18n,portable-packages,workbench}` |
| **Proprietary** (not included in this tree) | `apps/{web,server,native,storyboard,extension}`, `packages/{db,api,email}` |

As [`LICENSING.md`](../LICENSING.md) notes, the other open-source paths in this tree (for example
`apps/{skills,mcp}`, `.agents/plugins`, `packages/github-action`, `registry`, and
`tools/toolsmith`) fall under the root Apache-2.0 `LICENSE` unless a subdirectory `LICENSE` says
otherwise, and `vendor/genai` keeps its upstream MIT OR Apache-2.0 licence.

Copyright 2026 A Major Pte. Ltd.
