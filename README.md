<p align="center">
  <a href="https://ryuhq.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.png" />
      <img src=".github/banner.png" alt="Ryu — The open control layer for AI agents" width="100%" />
    </picture>
  </a>
</p>

<p align="center"><img src=".github/logo.png" width="96" alt=""  /></p>
<h1 align="center">Ryu</h1>

<p align="center">
  The open platform for agent orchestration and human collaboration. With tools, security, memory, cost saving, and routing all built in.
</p>

<p align="center">
  <img src="https://shieldcn.dev/badge/900k-Skills-e8e8e8.svg" alt="900k skills" />&nbsp;
  <img src="https://shieldcn.dev/badge/400+-Models-c8c8c8.svg" alt="400+ models" />&nbsp;
  <img src="https://shieldcn.dev/badge/30+-Agents-a3a3a3.svg" alt="30+ agents" />&nbsp;
  <img src="https://shieldcn.dev/badge/2.8M+-Local%20Models-787878.svg" alt="2.8M+ local models" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ryuhq/client"><img src="https://shieldcn.dev/npm/@ryuhq/client.svg?color=575757" alt="npm @ryuhq/client" /></a>&nbsp;
  <a href="https://www.npmjs.com/package/@ryuhq/client"><img src="https://shieldcn.dev/npm/@ryuhq/client/downloads.svg?color=404040" alt="npm weekly downloads" /></a>&nbsp;
  <a href="https://github.com/amajorai/ryu/releases"><img src="https://shieldcn.dev/github/release/amajorai/ryu.svg?color=2d2d2d" alt="GitHub release" /></a>&nbsp;
  <a href="https://github.com/amajorai/ryu/releases"><img src="https://shieldcn.dev/github/downloads/amajorai/ryu.svg?color=1a1a1a" alt="GitHub downloads" /></a>&nbsp;
  <a href="https://github.com/amajorai/ryu/stargazers"><img src="https://shieldcn.dev/github/stars/amajorai/ryu.svg?color=0a0a0a" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://ryuhq.com"><img src="https://shieldcn.dev/badge/Status-Alpha-F59E0B.svg" alt="Alpha" /></a>&nbsp;
  <a href="https://ryuhq.com/help"><img src="https://shieldcn.dev/badge/Docs-ryuhq.com-73DC8C.svg?logo=readthedocs&logoColor=white" alt="Docs" /></a>&nbsp;
  <a href="https://ryuhq.com/download"><img src="https://shieldcn.dev/badge/Download-macOS%20%7C%20Windows%20%7C%20Linux-4B78E6.svg?logo=tauri&logoColor=white" alt="Download" /></a>&nbsp;
  <a href="https://ryuhq.com/discord"><img src="https://shieldcn.dev/discord/1439211418724597800.svg?logo=discord&logoColor=white&color=4B78E6" alt="Discord" /></a>
  <a href="./docs/open-core.md"><img src="https://shieldcn.dev/badge/License-Apache--2.0%20%2B%20AGPL--3.0-73DC8C.svg?logo=opensourceinitiative&logoColor=white" alt="Open source"></a>
</p>

## Backed by

Ryu is built with the support of leading startup programs.

<p align="center">
  <a href="https://aws.amazon.com/startups/" target="_blank" rel="noopener"><img alt="AWS Activate" height="34" src=".github/backers/aws.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://block71.co" target="_blank" rel="noopener"><img alt="BLOCK71" height="34" src=".github/backers/block71.png" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.anthropic.com/startups" target="_blank" rel="noopener"><img alt="Claude for Startups" height="34" src=".github/backers/claude.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openai.com/startups" target="_blank" rel="noopener"><img alt="OpenAI for Startups" height="34" src=".github/backers/openai.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.cloudflare.com/forstartups/" target="_blank" rel="noopener"><img alt="Cloudflare for Startups" height="34" src=".github/backers/cloudflare.svg" /></a>
</p>

<p align="center">
  <sub>AWS Activate&nbsp; · &nbsp;BLOCK71&nbsp; · &nbsp;Claude for Startups&nbsp; · &nbsp;OpenAI for Startups&nbsp; · &nbsp;Cloudflare for Startups</sub>
</p>

## About Ryu

Your agents don't know what each other did. They burn through subscriptions you
already pay for. They're one misconfiguration away from a leak. And setting them
up takes weeks of wiring, keys, and glue code.

Ryu fixes that. It's the control layer around any agent — OpenAI, Claude Code,
Codex, Pi, OpenClaw, Hermes, any OpenAI-compatible runtime. Every model call
goes through one Gateway that handles routing, firewall, PII/DLP, budgets,
evals, and audit. Agents share context, subscriptions stack, and security is on
by default. Local-first, encrypted, no telemetry. **Works with everything.
Locked to nothing.**

> [!WARNING]
> Ryu is pre-1.0 and under active development. Interfaces, APIs, and on-disk formats may change between releases. Not recommended for production use yet.

## Why Ryu

- **Agents that know what each other did.** Shared memory and context across every surface — desktop, mobile, CLI, bots, web.
- **Your subscriptions, fully used.** Point Claude Code, Codex, and Gemini at one Gateway. Smart routing keeps cheap tasks on local models; cloud handles only what needs it.
- **Secure out of the box.** Firewall, prompt-injection protection, PII/DLP redaction, per-agent budgets, and a full audit trail — not bolted on, built in.
- **One-click setup.** Pick an agent from the catalog, install, and go. No MCP wiring, no API-key hunt, no week-long integration.
- **Works with everything, locked to nothing.** Every layer — model, embedder, reranker, engine, RAG strategy, sandbox — swaps via one registry. BYO agent, key, subscription.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/architecture-dark.svg">
  <img alt="Ryu architecture: any surface routes through the Gateway, into Core, out to any engine, and back" src=".github/architecture-light.svg" width="100%">
</picture>

**The one design rule:** if code decides *what runs* (which agent, session, workflow, tool), it is
**Core**. If it decides *what is allowed, shared, measured, or paid for*, it is **Gateway**. Core
never enforces policy inline — it routes every model call through the Gateway.

### Decomposition

Core and the Gateway were decomposed from a monolith into a virtual Cargo workspace of **~75
crates**: 52 primitive + app-backend capability crates (43 `crates/ryu-*` capabilities — crypto,
vault, downloads, engines, RAG, memory, search, durable, voice, image, sandbox… + 9 app backends),
11 gateway-stage crates (`crates/ryu-gw-*`), plus the ghost/shadow automation crates. Alongside
them live 21 self-contained apps under `apps-store/*` (16 with UI companions). `apps/core` shrank
from ~195k to ~143k LoC (−27%); ~88k LoC now lives in swappable crates.

Every layer is a swappable default, never a lock — chat model, embedder, reranker, TTS/STT,
image-gen, engine, RAG strategy, durable engine, sandbox. This repository carries the **open-core
subset** (`apps/core`, `apps/gateway`, the CLI/TUI clients, and the public capability + SDK crates
listed below) **plus a source-available tier** — `apps/desktop`, `apps/island`, and the shared UI
packages — under [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md). The web, server, mobile,
extension, and identity/billing surfaces remain proprietary and are not part of this mirror.

## Quick start (self-host)

### Install (prebuilt binaries)

One line pulls the headless stack — `ryu-core`, `ryu-gateway`, `ryu-cli` — into
`~/.ryu/bin` and puts it on your PATH. Great for servers, containers, and CI.

**macOS & Linux** (x86_64 Linux, Apple Silicon macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh
```

**Windows** (x86_64, PowerShell):

```powershell
irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex
```

Then just run the CLI — it self-bootstraps, starting a local Core (which brings up
the Gateway + a fully-local model stack) if none is running:

```bash
ryu-cli      # fetches + starts Core on first run, then attaches — no API key
```

Or start the node yourself and point clients at it:

```bash
ryu-core     # starts the Gateway + local model stack on :7980
```

<sub>Prebuilt targets: Linux x86_64, macOS Apple Silicon, Windows x86_64. On Intel
Macs or ARM Linux, build from source below. Override the install dir with
`RYU_INSTALL_DIR` or pin a release with `RYU_VERSION=v0.0.4`.</sub>

### Build from source

```bash
cd apps/core    && cargo build --release   # ryu-core    :7980
cd apps/gateway && cargo build --release   # ryu-gateway :7981
```

Point any OpenAI-compatible client at the Gateway's `/v1/chat/completions`.

On first run, Ryu downloads a fully-local stack (llama.cpp with Gemma 4 for chat, nomic embeddings, whisper for speech), so it works with **no API key**.

Swap any piece later: model, embedder, engine, and RAG strategy are all config.

The TypeScript units (SDK, docs) use [Bun](https://bun.sh):

```bash
bun install && bun run build
```

### One-click deploy

Stand up a hosted node (Core + Gateway) on a container host. Each builds the
[`Dockerfile`](./Dockerfile): Core runs the stack and manages the Gateway on
loopback, so only Core's port is published.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/amajorai/ryu)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)
&nbsp;
[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/amajorai/ryu/tree/main)

Or run it yourself:

- **Docker Compose** — `docker compose up --build` ([`docker-compose.yml`](./docker-compose.yml)): Core on `:7980`, Gateway on `:7981`, model state in a named volume.
- **Fly.io** — `fly launch --copy-config` then `fly deploy` ([`fly.toml`](./fly.toml)).

> **Sizing.** Core downloads a fully-local model stack on first boot, so pick a
> plan with **≥ 2 GB RAM** (4 GB is comfortable), or set a provider key such as
> `OPENAI_API_KEY` to skip the local download and run small.
>
> **License.** The Gateway is **AGPL-3.0**: host a *modified* Gateway and §13
> obliges you to offer those changes to its users. Core is Apache-2.0.

The documentation site (`apps/fumadocs`) is a Next.js app and deploys to Vercel
in one click — [![Deploy docs to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amajorai/ryu&root-directory=apps/fumadocs&project-name=ryu-docs). Vercel is serverless and cannot host the long-running Core/Gateway; use a container host above for the backend.

## Batteries-included defaults (all swappable)

- **Engine/model:** llama.cpp + Gemma 4 — runs on most machines, no key.
- **Default agent:** **"Ryu"** = Pi with the Gateway on top (the flagship "car around the engine"). Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and ~18 more ACP agents are opt-in via the catalog.
- **RAG:** local nomic embeddings + BGE reranker; vector + GraphRAG.
- **Modalities:** chat, image-gen, TTS, STT — all first-class, all swappable.
- **Standards:** Agent Skills + MCP + ACP, all first-class.

## Repository layout

This mirror ships **two tiers**, and the difference matters. Each unit carries its own
`LICENSE`; the full map is in [`LICENSING.md`](./LICENSING.md).

1. **Open source** — the orchestration engine, the Gateway, the terminal clients, and the
   public capability + SDK crates. Apache-2.0 (Gateway: AGPL-3.0, Raycast: MIT).
2. **Source-available** — `apps/desktop`, `apps/island`, and the shared UI packages they
   cannot compile without, under [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).
   **This is not open source.** You may read, audit, build locally, and contribute; you
   may not use it in production without an official binary, redistribute it, offer it as
   a service, or build a competing product from it.

The web, server, mobile, extension, and identity/billing surfaces (© 2026 A Major Pte.
Ltd.) remain closed and are **not** part of this repository.

The **Ryu name and logo are not licensed by any file here** — a permitted fork must
rebrand. See [`TRADEMARK.md`](./TRADEMARK.md). Build instructions:
[`docs/BUILDING.md`](./docs/BUILDING.md).

### Apps — Apache-2.0 (Gateway: AGPL-3.0)

| Unit | What it is |
|---|---|
| [`apps/core`](./apps/core) | Orchestration engine, the real local backend (Rust/Axum, :7980) |
| [`apps/gateway`](./apps/gateway) | The LLM control layer: routing, firewall, cache, evals, audit (Rust, :7981) |
| [`apps/cli`](./apps/cli) | Terminal client for Core (Rust/ratatui) |
| [`apps/tui`](./apps/tui) | Bun/OpenTUI terminal client — pure HTTP/SSE to a running Core node |
| [`apps/fumadocs`](./apps/fumadocs) | Documentation site + interactive OpenAPI (Next/Fumadocs) |
| [`apps/mcp`](./apps/mcp) | MCP server exposing a running Core node to any MCP host (TS) |
| [`apps/skills`](./apps/skills) | SKILL.md agent skills that teach coding agents to set up and drive Ryu |
| [`apps/plugins`](./apps/plugins) | Claude Code / Codex plugin definitions for Ryu |
| [`apps-store/voice/sidecar`](./apps-store/voice/sidecar) | Python TTS sidecar (`ryu_tts`), Core-managed |
| [`apps-store/finetune/sidecar`](./apps-store/finetune/sidecar) | Python LoRA/QLoRA fine-tuning sidecar (`ryu_unsloth`) |

### Capability & SDK crates — Apache-2.0

| Unit | What it is |
|---|---|
| [`crates/ryu-kernel-contracts`](./crates/ryu-kernel-contracts) | Pure-data `manifest.json` manifest model shared by Core + SDK |
| [`crates/ryu-crypto`](./crates/ryu-crypto) | Encryption-at-rest `FieldCipher` + swappable master-key custody |
| [`crates/ryu-vault`](./crates/ryu-vault) | Identity Vault — crypto-sealed per-domain credential store |
| [`crates/ryu-downloads`](./crates/ryu-downloads) | `DownloadCenter` — resumable, checksum-verified artifact fetch |
| [`crates/ryu-webhook-ingress`](./crates/ryu-webhook-ingress) | Public-reachability seam for inbound third-party webhooks |
| [`crates/ryu-usage`](./crates/ryu-usage) | Per-agent subscription usage/rate-limit metering |
| [`crates/ryu-sdk{,-ffi,-napi,-uniffi}`](./crates) | SDK kernel + C-ABI/Node-API/UniFFI language bindings |
| [`crates/ghost-{core,permissions}`](./crates) | Desktop-automation primitives + OS-permission checks |

### TypeScript packages — Apache-2.0

| Unit | What it is |
|---|---|
| [`packages/sdk`](./packages/sdk) · [`create-ryu-app`](./packages/create-ryu-app) | Ryu's dev SDK (typed Runnable builders) + project scaffolder |
| [`packages/client`](./packages/client) | `@ryuhq/client` — typed client for embedding a Core agent in any app |
| [`packages/core-client`](./packages/core-client) | `@ryuhq/core-client` — platform-agnostic Core node client (tui/native) |
| [`packages/protocol`](./packages/protocol) | `@ryuhq/protocol` — surface-agnostic wire-format contracts |
| [`packages/config`](./packages/config) · [`env`](./packages/env) | Shared TypeScript config + env schemas |

## Footprint

<!-- BENCH:ROOT:START (generated by scripts/benchmark.mjs, do not edit by hand) -->

The native tier ships as a handful of small self-contained Rust binaries: no interpreter,
no runtime, no Electron, no Docker. Every number below is emitted by
[`scripts/benchmark.mjs`](./scripts/benchmark.mjs); reproduce it with `node scripts/benchmark.mjs --build --runtime`.

| Component | Release binary | Crates | Source (LOC) | Idle RSS | Idle CPU |
| --- | --- | --- | --- | --- | --- |
| [`apps/core`](./apps/core) | 44.2 MB | 687 | 105,168 | n/a | n/a |
| [`apps/gateway`](./apps/gateway) | 18.7 MB | 405 | 20,658 | 17.0 MB | 0.0% |
| [`apps/shadow`](./apps/shadow) | 21.5 MB | 604 | 16,410 | n/a | n/a |
| [`apps/ghost`](./apps/ghost) | 12.8 MB | 428 | 3,427 | n/a | n/a |
| [`apps/cli`](./apps/cli) | 5.9 MB | 235 | 10,497 | n/a | n/a |

_Idle RSS and CPU are sampled only for the Gateway (a stateless proxy with a clean idle), and idle CPU is effectively nil. Core boots a full local stack on first run, and the capture/automation tools (Shadow, Ghost) and the CLI have no steady idle, so they report size/deps/LOC. Measured on `win32`._

<!-- BENCH:ROOT:END -->

## Primitives — every crate & package

<!-- INVENTORY:START -->
**78 primitives · 290,170 LoC · 9 MB of source.** Sizes and line counts are measured from source files only (no `node_modules`, `target`, or build output) and regenerated by `scripts/inventory.mjs`.

#### Core capability crates — 36 packages · 52,355 LoC

The swappable primitives Core is assembled from.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`ryu-model-catalog`](./crates/core/model-catalog) | Rust | 4,660 | 178 KB | Hugging Face model catalog + device-fit verdict primitive for Ryu: HF search/detail, GGUF tree inspection, per-node… |
| [`ryu-spaces`](./crates/core/spaces) | Rust | 4,336 | 184 KB | Spaces primitive for Ryu: named document collections with a sqlite-vec (`vec0`) vector store, a content-addressed b… |
| [`ryu-sandbox`](./crates/core/sandbox) | Rust | 4,313 | 168 KB | Sandbox execution primitive for Ryu: `run(command\|wasm, spec) -> output` behind a swappable backend seam |
| [`ryu-kernel-contracts`](./crates/core/kernel-contracts) | Rust | 4,138 | 192 KB | Ryu kernel contracts |
| [`ryu-tool-exec`](./crates/core/tool-exec) | Rust | 3,341 | 134 KB | The programmatic-tool-calling (PTC) code-execution sandbox primitive for Ryu: Deno-subprocess backend with deny-by-… |
| [`ryu-skills`](./crates/core/skills) | Rust | 2,424 | 97 KB | Agent Skills: the SKILL.md registry, dual-root (~/.claude + ~/.agents) scan, progressive-disclosure injection block… |
| [`ryu-rag`](./crates/core/rag) | Rust | 2,408 | 97 KB | Retrieval-augmented-generation primitive for Ryu: the embedder (local hashing + remote OpenAI-compatible `/v1/embed… |
| [`ryu-hardware`](./crates/core/hardware) | Rust | 2,288 | 88 KB | Ryu Hardware Protocol (RHP v1) node backend |
| [`ryu-webhook-ingress`](./crates/core/webhook-ingress) | Rust | 2,100 | 87 KB | Webhook ingress: the swappable public-reachability seam that lets a loopback-bound Ryu Core receive third-party web… |
| [`ryu-vault`](./crates/core/vault) | Rust | 1,960 | 83 KB | Identity Vault primitive for Ryu: the crypto-sealed per-domain credential store (SQLite `IdentityStore` with the `e… |
| [`ryu-composio`](./crates/core/composio) | Rust | 1,815 | 71 KB | Composio integration orchestration (Core side): the user's Composio account seam |
| [`ryu-collab`](./crates/core/collab) | Rust | 1,802 | 80 KB | Authoritative CRDT document engine for Ryu: Core's durable server-side replica of every live collaborative Yjs docu… |
| [`ryu-downloads`](./crates/core/downloads) | Rust | 1,396 | 51 KB | The DownloadCenter artifact-fetch primitive for Ryu: one process-wide registry that owns the lifecycle of every art… |
| [`ryu-workspace`](./crates/core/workspace) | Rust | 1,356 | 48 KB | Git-native workspace primitive for Ryu: the git/worktree engine that shells `git`/`gh` for a caller-supplied cwd |
| [`ryu-memory`](./crates/core/memory) | Rust | 1,273 | 51 KB | Long-term memory primitive for Ryu: the SQLite-backed, encryption-at-rest MemoryStore plus the multi-level scope mo… |
| [`ryu-engines`](./crates/core/engines) | Rust | 1,228 | 55 KB | Engine-agnostic inference-configuration primitive for Ryu: the per-request `SamplingConfig` (temperature/top_p/top_… |
| [`ryu-realtime`](./crates/core/realtime) | Rust | 1,162 | 48 KB | Room-keyed realtime fan-out primitive for Ryu: a transport-agnostic RoomRegistry mapping room_id -> a per-room toki… |
| [`ryu-search`](./crates/core/search) | Rust | 987 | 41 KB | Conversation search primitive for Ryu: a sqlite-vec (`vec0`) semantic KNN index plus a contentless FTS5 lexical ind… |
| [`ryu-eval-code`](./crates/core/eval-code) | Rust | 977 | 37 KB | Core-side code evaluators for Ryu: runs a user (input, output, expected, vars) -> {score} function in an isolated r… |
| [`ryu-mcp-catalog`](./crates/core/mcp-catalog) | Rust | 974 | 38 KB | MCP server catalog primitive for Ryu: browse and install MCP servers from the official Model Context Protocol regis… |
| [`ryu-knowledge`](./crates/core/knowledge) | Rust | 806 | 31 KB | Open Knowledge Format (OKF) primitive for Ryu: the in-memory model, permissive parser, and serializer for git-shipp… |
| [`ryu-usage`](./crates/core/usage) | Rust | 786 | 30 KB | Per-agent subscription usage-metering primitive for Ryu: reads the OAuth token a subscription CLI (Claude Code / Co… |
| [`ryu-mesh`](./crates/core/mesh) | Rust | 755 | 30 KB | Mesh read/shape primitive for Ryu (#478 P5–P7): the read side of the optional Tailscale/Headscale plane |
| [`ryu-tool-registry`](./crates/core/tool-registry) | Rust | 642 | 25 KB | Unified tool-catalog primitive for Ryu (#474): the Contract-1 descriptor types (`ToolKind`/`ToolDescriptor`/`Descri… |
| [`ryu-crypto`](./crates/core/crypto) | Rust | 599 | 23 KB | Encryption-at-rest primitive for Ryu: the FieldCipher (ChaCha20-Poly1305 AEAD with a self-describing `enc:v1:` fiel… |
| [`ryu-predict`](./crates/core/predict) | Rust | 585 | 22 KB | Predict: the system-wide predictive-typing brain for Ryu |
| [`ryu-vad`](./crates/core/vad) | Rust | 500 | 19 KB | Voice activity detection (VAD) modality primitive for Ryu: `detect(frame) -> speech_prob` feeding an endpointing/ba… |
| [`ryu-stt`](./crates/core/stt) | Rust | 480 | 19 KB | Speech-to-text (STT) modality primitive for Ryu: `transcribe(audio) -> text` with a swappable engine seam (in-proce… |
| [`ryu-email-send`](./crates/core/email-send) | Rust | 449 | 17 KB | BYOK SMTP email sink for Ryu self-host: a swappable outbound-email transport (the SES agent-inbox path in `packages… |
| [`ryu-activity`](./crates/core/activity) | Rust | 332 | 12 KB | Unified activity-feed primitive for Ryu: the cross-module timeline of everything a node did (monitor alerts, quest… |
| [`ryu-model-format`](./crates/core/model-format) | Rust | 299 | 11 KB | Model weight-format primitive for Ryu: the `ModelFormat` enum (GGUF/Safetensors/MLX), its wire/serde mapping, and t… |
| [`ryu-tracing`](./crates/core/tracing) | Rust | 286 | 10 KB | Per-run observability trace primitive for Ryu: the ordered-span store (`Span` v1 contract + SQLite-backed `TraceSto… |
| [`ryu-image`](./crates/core/image) | Rust | 252 | 10 KB | Image-generation modality primitive for Ryu: `generate(prompt) -> image` with a swappable engine seam (local stable… |
| [`ryu-durable`](./crates/core/durable) | Rust | 250 | 11 KB | Durable-execution primitive for Ryu: the swap-seam `DurableEngine` trait (checkpoint / resume / replay of a run to… |
| [`ryu-storage`](./crates/core/storage) | Rust | 203 | 7 KB | Plugin-owned key/value storage primitive for Ryu: an isolated, `(plugin_id, namespace, key)`-namespaced SQLite KV s… |
| [`ryu-notify`](./crates/core/notify) | Rust | 193 | 7 KB | Shared notification-delivery wire types + send primitives for Ryu: the swappable channel targets (webhook / Telegra… |

#### Gateway stage crates — 11 packages · 13,726 LoC

The detection/decision engines behind the control layer.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`ryu-gw-channels`](./crates/gateway/channels) | Rust | 3,368 | 130 KB | Ryu Gateway channel-layer engine: the external messaging-surface adapters (Telegram long-poll, Slack Socket Mode, D… |
| [`ryu-gw-providers`](./crates/gateway/providers) | Rust | 3,182 | 117 KB | Ryu Gateway concrete backend providers: the OpenAI/Anthropic/local/core/OpenRouter/Modal/GenAI/Replicate/Fal HTTP i… |
| [`ryu-gw-firewall`](./crates/gateway/firewall) | Rust | 1,421 | 58 KB | Ryu Gateway firewall scanning core: the pure regex detection engine (curated PII/secret/injection/code-injection/to… |
| [`ryu-gw-evals`](./crates/gateway/evals) | Rust | 1,238 | 47 KB | Ryu Gateway evals stage: per-request sampling + provider-score EMA (the live EvalsRunner) as a swappable EvalsBacke… |
| [`ryu-gw-budget`](./crates/gateway/budget) | Rust | 1,225 | 47 KB | Ryu Gateway token-budget stage: per-user / per-agent / per-session token budgets + the per-window exec budget, as a… |
| [`ryu-gw-audit`](./crates/gateway/audit) | Rust | 1,211 | 48 KB | Ryu Gateway audit stage: the SQLite-backed append-only request log + lifetime token totals + query/summary, exposed… |
| [`ryu-gw-cache`](./crates/gateway/cache) | Rust | 722 | 26 KB | Ryu Gateway response-cache stage: the exact-match TTL cache (CacheBackend) and the embedding-similarity semantic ca… |
| [`ryu-gw-router`](./crates/gateway/router) | Rust | 683 | 26 KB | Ryu Gateway model-routing core (Plane A): the pure model->provider resolution logic |
| [`ryu-gw-passthrough`](./crates/gateway/passthrough) | Rust | 384 | 15 KB | Ryu Gateway passthrough wire-format redaction engine: the native-format (Anthropic Messages / OpenAI Responses) req… |
| [`ryu-gw-governance`](./crates/gateway/governance) | Rust | 259 | 11 KB | Ryu Gateway marketplace-governance core: the pure grant-allowlist matching + ed25519 manifest sign/verify crypto ov… |
| [`ryu-gw-contracts`](./crates/gateway/contracts) | Rust | 33 | 1 KB | Shared value-types exchanged between Ryu Gateway stages (e.g |

#### Automation & capture crates — 5 packages · 16,158 LoC

Desktop perception, input control, and screen/audio capture.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`ryu-shadow-core`](./crates/ghost/shadow) | Rust | 11,535 | 402 KB | Screen/audio/input capture, OCR, and semantic search engine for Shadow |
| [`ghost-hands`](./crates/ghost/hands) | Rust | 2,122 | 79 KB | Synthetic keyboard/mouse/window input for Ghost |
| [`ghost-eyes`](./crates/ghost/eyes) | Rust | 1,670 | 80 KB | Screen perception (AX tree, screen capture, input monitoring) for Ghost |
| [`ghost-core`](./crates/ghost/core) | Rust | 589 | 20 KB | Core automation primitives (recipes, store) for the Ghost desktop-automation MCP server |
| [`ghost-permissions`](./crates/ghost/permissions) | Rust | 242 | 10 KB | Cross-platform check/request for the OS capabilities Ghost needs (UI automation + screen capture) |

#### SDK crates — 4 packages · 3,092 LoC

The SDK kernel and its C-ABI / Node-API / UniFFI bindings.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`ryu-sdk`](./crates/sdk/core) | Rust | 1,394 | 49 KB | Ryu developer SDK core |
| [`ryu-sdk-napi`](./crates/sdk/napi) | Rust | 768 | 25 KB | Node-API (napi-rs) binding exposing the ryu-sdk Rust core to TypeScript/JavaScript as a native addon |
| [`ryu-sdk-ffi`](./crates/sdk/ffi) | Rust | 521 | 18 KB | C-ABI surface over the ryu-sdk Rust core, consumed by the Go (cgo) binding and any other C-FFI client |
| [`ryu-sdk-uniffi`](./crates/sdk/uniffi) | Rust | 409 | 17 KB | UniFFI binding surface over the ryu-sdk Rust core |

#### Testing crates — 2 packages · 1,492 LoC

Shared test harnesses.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`ryu-integration-tests`](./crates/testing/integration) | Rust | 1,292 | 52 KB | The dedicated decomposition SEAM suite: boots ryu-core as a subprocess (RYU_PROFILE=auditsmoke + temp RYU_DIR) and… |
| [`ryu-test-sidecar`](./crates/testing/sidecar) | Rust | 200 | 8 KB | A minimal, controllable out-of-process sidecar used ONLY by crates/ryu-integration-tests to exercise the decomposit… |

#### TypeScript packages — 20 packages · 203,347 LoC

Shared TS surface: SDK, clients, design system, protocol.

| Package | Lang | LoC | Size | What it is |
|---|---|--:|--:|---|
| [`@ryu/ui`](./packages/ui) | TypeScript | 53,385 | 1406 KB | — |
| [`@ryu/blocks`](./packages/blocks) | TypeScript | 52,445 | 1459 KB | — |
| [`@ryu/api`](./packages/api) | TypeScript | 30,168 | 985 KB | — |
| [`@ryuhq/sdk`](./packages/sdk) | TypeScript | 9,665 | 326 KB | Ryu developer SDK: typed builders and CLI for authoring manifest.json Plugin bundles |
| [`@ryuhq/core-client`](./packages/core-client) | TypeScript | 9,428 | 278 KB | — |
| [`@ryu/app-host`](./packages/app-host) | TypeScript | 8,961 | 331 KB | — |
| [`@ryu/marketplace`](./packages/marketplace) | TypeScript | 8,552 | 246 KB | — |
| [`@ryu/db`](./packages/db) | TypeScript | 5,746 | 215 KB | — |
| [`@ryu/auth`](./packages/auth) | TypeScript | 5,199 | 174 KB | — |
| [`@ryu/settings`](./packages/settings) | TypeScript | 2,262 | 59 KB | — |
| [`@ryu/mail`](./packages/mail) | TypeScript | 1,594 | 48 KB | — |
| [`@ryuhq/protocol`](./packages/protocol) | TypeScript | 1,330 | 40 KB | — |
| [`create-ryu-app`](./packages/create-ryu-app) | TypeScript | 1,089 | 36 KB | Scaffold a starter Ryu SDK project with a Runnable, gateway-pointed model config, and manifest.json manifest |
| [`@ryu/email`](./packages/email) | TypeScript | 927 | 25 KB | — |
| [`@ryu/hotkeys`](./packages/hotkeys) | TypeScript | 760 | 21 KB | — |
| [`@ryuhq/client`](./packages/client) | TypeScript | 631 | 17 KB | TypeScript client SDK for embedding a Ryu Core agent in any app |
| [`@ryu/command`](./packages/command) | TypeScript | 583 | 18 KB | — |
| [`@ryu/env`](./packages/env) | TypeScript | 346 | 19 KB | — |
| [`@ryu/config`](./packages/config) | TypeScript | 0 | 0 KB | Shared TypeScript configuration for Ryu packages |

<!-- INVENTORY:END -->

## Contributing

Contributions to the OSS units are welcome — see each unit's README for build instructions.
Report security issues privately to security@ryuhq.com.

Open-source units are Apache-2.0, except the Gateway (AGPL-3.0) and Raycast (MIT).
`apps/{desktop,island}` and the shared UI packages are **source-available, not open
source** — see [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md); contributions to them
are welcome under those terms. The web/server/mobile/extension and identity/billing
surfaces are © 2026 A Major Pte. Ltd. and live in the private monorepo. Each
subdirectory carries its own `LICENSE` file; [`LICENSING.md`](./LICENSING.md) is the map.

---

Built on the shoulders of [kernel.sh](https://github.com/onkernel/kernel) (identity vault),
[Jan](https://github.com/menloresearch/jan) (local-first desktop),
[Ghost OS](https://github.com/ghostwright/ghost-os) (desktop automation), and
[Shadow](https://github.com/ghostwright/shadow) (capture + semantic memory).
