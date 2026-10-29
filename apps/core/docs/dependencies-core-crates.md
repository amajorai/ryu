# ryu-core in-tree crate notes

Rationale for the path dependencies in [`apps/core/Cargo.toml`](../Cargo.toml), mostly the extracted
Core capability crates under `crates/core/*`. Index: [DEPENDENCIES.md](../DEPENDENCIES.md).

## Conventions

Unless an entry says otherwise, each extracted capability crate:

- is NON-optional (no cargo feature), because a kernel path reaches it in every build, including the
  lean one;
- runs in-process on a function-call hot path (no IPC);
- has ZERO dependency on `apps/core`. Kernel couplings it cannot own are inverted through a host
  trait that Core implements in a `*_host.rs` shim, or passed in as explicit parameters (data dir,
  db path);
- is re-exported or wrapped by a thin Core module so existing call sites stay unchanged.

Crates under `crates/core/*` are always in-process Core capability crates. `apps-store/*/backend` is
for app backends that ship as their own out-of-process sidecar (see
[dependencies-out-of-process-apps.md](./dependencies-out-of-process-apps.md)).

## Contracts

- `ryu-kernel-contracts` - the single, pure-data definition of the `manifest.json` contract
  (`PluginManifest`, Runnable/schema types, validation). Core re-exports these from
  `plugin_manifest`/`runnable` so every call site is unchanged; the Ryu SDK depends on the same
  crate, ending the historical manifest drift.
- `ryu-teams-contracts`, `ryu-healing-contracts`, `ryu-notify` - wire types shared with
  out-of-process sidecars; see
  [dependencies-out-of-process-apps.md](./dependencies-out-of-process-apps.md#shared-contract-crates).

## Ghost

- `ghost-core` - the Ghost recipe engine and types (record, parameterize, replay desktop
  automations). Reused so Core and the ghost desktop-automation server agree on the recipe schema
  and the `~/.ghost/recipes/` store path. ghost-core is cross-platform; native input-tap deps live in
  ghost-eyes/ghost-hands.
- `ghost-permissions` - shared automation-permission gates. Core detects and reports but never
  prompts (it is a background service); the desktop app and `ghost setup` do the prompting.

## Agents, protocols and messaging

- `ryu-email-send` - BYOK SMTP sink for self-host alerts and agent-inbox send; owns the lettre
  transport. Core injects the SMTP password resolver at startup; secret custody stays kernel-side in
  `smtp_auth`.
- `ryu-acp-server` - ACP server mode (`ryu-core acp`): editors such as Zed drive Ryu agents over
  stdio. A thin client of the running Core's HTTP API; it opens no Core state.
- `ryu-deletion-guard` - the shared permanent-deletion classifier used by Core's local preflight,
  the ACP/MCP seams, and the Gateway scanner. It is pure with no filesystem side effects, so every
  execution transport applies the same default-deny policy.
- `ryu-composio` - Composio orchestration (Core side): key resolver, catalog/connect client,
  trigger-subscription store with HMAC webhook verify, and the MCP execute path. Webhook, settings
  and tool routes reach it in every build. The workflow/agent-engine fan-out stays in Core
  (`composio_host`) via the `ComposioHost` seam.
- `ryu-webhook-ingress` - the webhook ingress primitive: the swappable public-reachability seam
  (RyuRelay push, Tailscale Funnel, cloudflared, BYO own-relay), the path-routed inbound dispatcher
  with fail-closed HMAC re-verification, delivery dedup, and the replay window. The public webhook
  routes in `server/mod.rs` (kernel ingress, program section 5) and the ingress start task in
  `main.rs` reach it unconditionally. Core injects `WebhookIngressHost` (`webhook_ingress_host.rs`)
  for composio verify/run, workflow-secret lookup, mesh Funnel, auth token, and the `~/.ryu` dir.
- `ryu-mesh` - private-network read/shape primitive (#478 P5 to P7): the `RYU_MESH_ENABLED` gate,
  `GET /api/mesh/status` (Contract 6) shaping from Tailscale/Headscale status or a Tailcat address,
  the fail-closed shared-mesh-token bearer resolution for `GET /api/mesh/peers`, and the Funnel
  helpers P6 consumes. The fail-closed startup gate in `server::create_router` reads `is_enabled()`
  and `enforce_remote_auth` consults `is_insecure_auth_token_placeholder` (the node-admittance
  security model this crate anchors). Core injects `MeshHost` (`mesh_host.rs`): the
  Tailscale/Headscale and Tailcat process adapters, the "what runs" half of the network.
- `ryu-sidecar-runtime` - enabled with `peer-probe`, the loopback peer proof Core runs before it
  sends Shadow its bearer (`sidecar/tools/shadow`). This dep carries a `version` string that the
  release bump rewrites.

## Skills, styles, learning and prediction

- `ryu-skills` - Agent Skills: SKILL.md registry, dual-root scan, progressive-disclosure injection
  block, authoring/version store, and the `/api/skills` CRUD surface. The registry is injected into
  EVERY chat turn (`ServerState.skills`, adapters, ACP/voice/hardware sessions), so it must always
  compile; only the HTTP surface is AppGate'd. Core publishes the ryu data dir and implements
  `Runnable for SkillRecord` host-side (`skills_host.rs`).
- `ryu-output-styles` - output styles (`docs/output-styles.md` in the private checkout): the
  `<name>.md` registry, the four-source merge, node-default selection, the system-prompt style
  block, user-root authoring, and `/api/output-styles`. Non-optional for the same reason as
  `ryu-skills`, since the style is resolved per turn at turn assembly (which is what makes the composer
  picker live); only the HTTP surface is gated. Core publishes the data dir and mounts the router.
- `ryu-learning` - continual-learning loop and experience buffer: the MetaClaw-style sweep,
  PRM-score, synthesize-skill, reward-filtered retrain engine, the durable `ExperienceStore`
  (`experience.db`), and `/api/learn/*`. Every Core-owned callback (conversation-store read, Gateway
  PRM/synth side-model, skill-synthesis approvals inbox, skills-registry reload, fine-tune dispatch,
  preference store) inverts through `LearningHost` (`CoreLearningHost` in
  `apps/core/src/learning/mod.rs`). Kept COMPILED IN rather than a `public_mount` sidecar: the loop
  is welded to those kernel subsystems. The `ryu-learning` sidecar bin is dormant scaffolding until
  broker-back endpoints exist. Core keeps only the thumbs-feedback fan-out (RAG memory/retrieval
  sink) and the conversation-read ACL on `/api/learn/synthesize`. It lives under `crates/core/*`
  (with `ryu-activity` and `ryu-predict`) because Outcome B says it never ships out of process. The
  app face (`apps-store/learning/{manifest.json,ui/}`, the `learning:crud` grant, the
  `include_str!`ed manifest) is unchanged.
- `ryu-predict` - predictive-typing brain: completion engine (config, per-app allowlist,
  secure-field denylist, prompt assembly, reply cleanup) and `/api/predict/*`. Plugin-owned enabled
  flag, preferences, the agent's bound model, the default model id, and the Gateway side-model call
  invert through `PredictHost` (`apps/core/src/predict_host.rs`). The process-global on/off flag and
  boot seeding stay in the kernel (`apps/core/src/predict.rs`). Routes are always mounted.
- `ryu-optimizer` - network-free agent optimizer: replay-case selection, Gateway eval result
  reading, model/tool recommendation rules, and the recommendation store. Wired to sessions, the
  Gateway and the agent store in `server/optimizer_api.rs`.

## Hardware, speech and media

- `ryu-hardware` - Ryu Hardware Protocol (RHP v1) node backend: paired-device registry (SQLite store
  plus revocable per-device tokens), pairing, the Opus/WAV codec edge (also used by `voice`), the
  per-connection realtime session state machine, the live device-sender registry, the display-nudge
  loop, and the device-registry plus TRMNL display HTTP surface. The store backs `ServerState` and
  the codec is used by `voice` in every build. The public ws/pair ingress
  (`server::hardware_ws`/`hardware_public`) and chat-turn orchestration (`hardware::turn`, welded to
  `run_text_turn`/voice/TTS) stay Core-side as consumers (the teams `@team` precedent).
- `ryu-stt` - speech-to-text primitive. Voice, meetings and hardware data paths reach
  `transcribe_wav*` unconditionally. The parakeet ONNX engine is behind the crate's `voice-parakeet`
  feature, forwarded by Core's feature of the same name. See `apps/core/src/stt_host.rs`.
- `ryu-vad` - voice-activity detection. In-process FOREVER (per-frame hot path, never IPC). The
  endpointing/barge-in gate and energy backend are always compiled; Silero VAD ONNX inference is
  behind the crate's `voice-vad` feature, forwarded by Core's. See `apps/core/src/voice/vad.rs`.
- `ryu-image` - image-generation primitive. `POST /api/images/generate` and `/api/video/generate`
  reach its `generate`/`cloud_provider`/`forward_to_gateway`/`proxy` routing unconditionally. Owns
  local (sd.cpp) versus cloud (Gateway) routing; sd-server base URL, Gateway URL/token, and
  lazy-starting the sdcpp sidecar come through `ImageHost` (`apps/core/src/image_host.rs`).

## Inference, retrieval and models

- `ryu-engines` - engine-agnostic inference configuration: `Engine`/`SamplingConfig`/`LaunchConfig`,
  the per-request and per-launch tuning surface translated per engine (llama.cpp, Ollama, vLLM,
  SGLang, MLX). Owns the continuous-batching launch flags, NOT the runtime admission queue (blocked
  on ryu-queue), the provider launch lifecycle (`sidecar/providers`, kernel-coupled), or embed
  (`Embedder`, deferred to ryu-rag). `crate::inference` is a re-export shim.
- `ryu-rag` - the `RagProvider` swap-seam trait plus the in-process `Embedder`/`Reranker`/
  `RetrievalStore` default impl. Chat retrieval injection, agent auto-routing, and tool/space/search
  embedding reach it unconditionally. Model/provider selection stays Core-side in the single
  resolver `src/rag_host.rs`; `crate::server::retrieval` is a re-export shim.
- `ryu-vector-stores` - pluggable vector stores (sqlite-vec default, Qdrant, Chroma, Pinecone,
  Weaviate, Milvus, pgvector) behind one `VectorStore` trait. Provider, path and credential
  resolution stay Core-side in `src/rag_host/vector_store.rs`.
- `ryu-search` - conversation search: the sqlite-vec (`vec0`) semantic KNN index and contentless
  FTS5 lexical index over past chat messages (schema, KNN/FTS query, dims reconciliation). Stores
  vectors, inverted index and metadata only, never message text. `ConversationStore` holds these
  unconditionally. The embedder is injected via `SearchEmbedder`, the default `~/.ryu` db paths stay
  in the `search_host` shim, and the backfill/decrypt-snippet orchestration in
  `ConversationStore::{search,fts_search}_messages` stays in Core (coupled to the cipher and the
  `messages` table).
- `ryu-model-format` - leaf crate: `ModelFormat` plus pure format-to-engine capability tables,
  re-exported as `crate::model_format`.
- `ryu-model-catalog` - Hugging Face catalog and device fit: HF search/detail, GGUF tree inspection,
  per-node device detection and fit estimation, installed-model tracking, capability overrides. Its
  five kernel couplings invert through `ModelCatalogHost` (`model_catalog_host.rs`). Re-exported as
  `crate::model_catalog`; the catalog HTTP routes are mounted in every build.

## Data, storage and documents

- `ryu-crypto` - encryption at rest: the `FieldCipher` AEAD, the `enc:v1:` envelope, and the
  master-key custody ladder (env, then keychain, then file). The session/chat loop
  (`conversations.rs`) and long-term memory (`memory.rs`) call `ryu_crypto::global_cipher` to seal
  every row. Core injects `CryptoHost` (`crypto_host.rs`) for the profile-scoped keychain suffix and
  the data dir. It also owns the keyring and chacha20poly1305 deps that used to live in Core. The
  `sqlite` feature is the phase-2 content_sqlite migration helper (state table, cursor migration,
  freelist scrub) the Core stores use.
- `ryu-durable` - durable execution: the `DurableEngine` swap-seam trait and
  `FileCheckpointStore`, an atomically durable (temp, fsync, rename) run-state store. The workflow
  store (`workflow::store::{save_run,load_run}`) checkpoints every node through it. The trait is
  generic over the run/workflow types, so the petgraph executor and the concrete `WorkflowRun`
  model stay Core-side (`workflow/{store,durable}.rs`).
- `ryu-workspace` - the git-native worktree engine: per-run worktrees (create, isolated
  `ryu/run-<id>` branch, Drop cleanup), the aggregate run diff, whole-tree apply (merge or
  `gh pr create`), and read-only git status/branches/checkout/create-branch/commit-push helpers;
  everything that shells `git`/`gh`. The ACP chat loop opens a worktree per isolated run. No host
  shim (the Windows `NoWindow` console-suppression util is vendored). The axum handlers, the live
  `WorktreeDiffStore`, the node-fs `/api/workspace/*` handlers, and ChatStreamRequest-to-cwd
  threading stay in Core.
- `ryu-knowledge` - Open Knowledge Format (OKF): in-memory model, permissive parser, and serializer
  (Concept, Bundle, IndexDoc, LogDoc, `Bundle::from_dir`/`from_git`/`write`). Referenced by
  `server::retrieval::ingest_okf_bundle`, `catalog_source::sources::OkfBundleSource`, and
  `server::okf_export`. No host shim (`NoWindow` vendored for `git clone`). The consumers that build
  and index these types from Ryu state (`build_okf_export_bundle`, `load_okf_bundle`,
  `reconstruct_okf_concepts`, the `okf_chunks` table) stay in Core.
- `ryu-spaces` - Spaces (U16/U17/U046): `SpaceStore` (sqlite-vec `vec0` vector store plus
  content-addressed blob store), documents/chunks schema and wikilink graph, the per-space embedder,
  and GraphRAG retrieval. `ServerState.spaces` holds it; chat, artifacts, meetings, clips and canvas
  reach it. Embedders/rerankers are injected as `ryu_rag` instances, so registry-driven model choice,
  `~/.ryu` paths, `Tenancy` to `DocOwner` lowering, `DocAccessMeta` to `ResourceTenancy` mapping,
  and preferences stay Core-side (`crate::server::spaces` shim).
- `ryu-realtime` - room-keyed fan-out: the transport-agnostic `RoomRegistry` of per-room tokio
  actors (isolated presence and idle clock, bounded broadcast, RAII membership, hibernation). Chat
  fan-out (`conversations.rs` `append_message`) and `/api/realtime/ws` (`server/realtime_ws.rs`)
  drive it in-process (per-frame hot path). ZERO kernel callbacks (only `tracing`), so no shim.
- `ryu-collab` - the authoritative CRDT engine: `DocRegistry` (per-doc `yrs` replica behind a
  single-writer Mutex), `CollabStore` persistence (`~/.ryu/collab.db`), the `DocSyncMessage` wire
  protocol, the pure `classify_doc_sync` write-ACL gate, and the `Y.Doc` to source projection.
  `ServerState` holds a `DocRegistry` and `server/realtime_ws.rs` drives it. Core injects
  `CollabHost` (`collab_host.rs`) for the data dir. No crate-to-crate dep on realtime or storage:
  the `Frame::DocSync` bridge is kernel-side and collab drives `rusqlite` directly.
- `ryu-storage` - plugin-owned KV storage backing the plugin-host `storage:kv` capability: the
  `(plugin_id, namespace, key)` SQLite table and get/set/delete/keys API. The plugin turn-hook
  runtime reaches it. `PluginStorage::open` takes an explicit db path; the default path and the
  process-global handle stay Core-side (`src/plugin_storage`).
- `ryu-vault` - Identity Vault: the SQLite `IdentityStore` (seal/open via ryu-crypto), the
  `CredentialSource` capture/rotation seam, and the staleness health sweep. The identity governance
  kernel in `src/identity/` (the `identity.read` grant and audit chokepoint, tool-call consult,
  elicitation) consumes it. The data dir is the `IdentityStore::open(dir)` parameter (Core passes
  `paths::ryu_dir()`).
- `ryu-downloads` - DownloadCenter: the process-wide registry and stream-to-`.part` transfer engine
  (Range/If-Range resume, bounded retry, checksum verify and atomic rename, pause/resume/cancel, SSE
  progress, durable history). A primitive by REUSE, not swap: the sidecar loader, model catalog,
  engines, and marketplace install all fetch through it. Core injects `DownloadsHost`
  (`downloads/mod.rs`) for the data dir, version-store checksum skip, and Hugging Face auth.

## Observability and activity

- `ryu-tracing` - per-run trace primitive: the ordered-span `TraceStore` (open/close spans,
  args-hash privacy fingerprint, per-run reads) behind the desktop per-run trace viewer (M4). Opens
  at boot (`main.rs`) and backs a `ServerState` field read by the always-mounted
  `GET /api/runs/:id/trace` and support-access routes. `TraceStore::open` takes an explicit path, so
  the default path (`~/.ryu/traces.db`) stays Core-side wiring.
- `ryu-usage` - per-agent subscription usage metering: vendor OAuth-token readers (Claude Code,
  Codex), never-refresh token safety, and normalized `UsageSnapshot` windows behind
  `GET /api/agents/:id/usage` (mounted unconditionally via `usage_api.rs`). Core injects `UsageHost`
  (`usage_host.rs`) for the Ryu-isolated `CODEX_HOME`.
- `ryu-activity` - unified activity feed: the `ActivityItem`/`ActivityLevel` contract and the
  SQLite-backed `ActivityStore`. Opens at boot and backs a `ServerState` field; `/api/activity*`
  routes are always mounted. Per-engine event mappers stay Core-side in `src/activity/ingest.rs`.

## Tools and execution

- `ryu-mcp-catalog` - MCP server catalog (official registry, Smithery and Ryu-hosted sources): the
  tolerant server.json parser, card/detail shaping, and hardened install-plan builder. Re-exported
  as `crate::mcp_catalog`; its SSRF-guarded registry fetch inverts through `mcp_catalog_host`.
- `ryu-openapi-import` - OpenAPI to `http` tool descriptors (install-time importer), re-exported as
  `crate::openapi_import`. Its parse rules are shared with the generated tool catalog tier
  (`tools/tool-catalog-generate`, Treg parity C1) through one golden case file. The import routes
  and app-sidecar tool derivation reach it.
- `ryu-tool-registry` - unified tool catalog (#474): Contract-1 descriptor types, the swappable
  `ToolRanker` (BM25 plus a Semantic seam), argument-schema parsing, and pure search/describe bodies.
  `/api/tools/{search,describe}` and the mcp_bridge tool-search meta-tool reach it. The
  `RegistryTool` to `ToolDescriptor` ingest adapter and built-in server inventory classification
  stay in `sidecar/mcp/catalog.rs`; the Semantic ranker's embedder inverts through `ToolEmbedder`
  (`tool_registry_host.rs`).
- `ryu-tool-exec` - the PTC code-execution sandbox (QuickJS on Wasmtime, in-process). Core's shim
  (`src/tool_exec/mod.rs`) links `run_sandboxed`/`resume_parked`/`is_available` in every build.
  Declared with `default-features = false`; backend features forward from Core's `js-sandbox`.
- `ryu-eval-code` - Core-side code evaluators (unified-evaluator P4): runs user scoring functions
  (JS/Python) to merge real scores into the gateway eval-run proxy response. The
  `POST /api/gateway/evals/run` handler links it. The JS path forwards to the js-sandbox backend.
- `ryu-code-runner` - workflow `code` step runners (Lean 4, Bend, BAML). The workflow executor
  dispatches `NodeKind::Code` in every build; a missing toolchain is a step error, not a build
  feature.
- `ryu-sandbox` - the sidecar sandbox execution primitive (in-process default). Core's sidecar,
  session and eval-code data paths reach it. Its wasmtime backend moved into the crate; Core's
  `sandbox-wasmtime` feature forwards to `ryu-sandbox/sandbox-wasmtime`.
