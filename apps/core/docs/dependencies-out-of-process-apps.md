# ryu-core out-of-process apps and retired features

Apps listed here used to be linked into Core or gated by a Core cargo feature. They now run out of
process, so [`apps/core/Cargo.toml`](../Cargo.toml) deliberately has NO dependency and NO cargo
feature for them. Do not add one back: per `AGENTS.md`, apps are self-contained satellites reached
through the manifest `public_mount`, the generic ext-proxy, capabilities, or loopback clients.
Index: [DEPENDENCIES.md](../DEPENDENCIES.md).

## Shared contract crates

These ARE dependencies. They carry only the wire types Core and a sidecar must agree on, so neither
side links the other's code.

- `ryu-teams-contracts` - the serde-only `TeamRecord` / `CreateTeam` / `Coordination` shapes that
  Core and the `ryu-teams` sidecar must agree on. Both link it, and the kebab-case strategy table is
  declared once. Path-only in Core; the sidecar's copy carries a `version` too, because the
  satellite tree has no sibling `crates/`.
- `ryu-healing-contracts` - the healing wire contract (`HealVerdict` plus the `healrun_` prefix and
  truncation policy that neither side can infer from the wire), in `crates/core/healing-contracts`.
  Linked by Core and the `ryu-healing` sidecar; path-only in Core for the same reason as
  `ryu-teams-contracts`.
- `ryu-notify` - dep-light notification wire types. The kernel notification-delivery store and
  fan-out stay in Core (`crate::notify`) and share these types with the `ryu-monitors` sidecar.

## Dashboards (no `ryu-dashboards` dependency)

The `ryu-dashboards` sidecar (`apps-store/dashboards/backend`) owns `dashboards.db`, the refresh
loop, the device-image renderer, and `/api/dashboards/*` (served through the ext-proxy
`public_mount`). Core links NO dashboard code. The hardware device-dashboard renderer and nudge loop
reach it through the `ryu_hardware::DashboardFeed` seam, and the `dashboard_builder` MCP runnable
through its authoring seam. Both go through the `dashboards.*` capabilities the app provides
(`dashboard_capabilities` over the generic capability consumer).

## Quests (no `ryu-quests` dependency)

The `ryu-quests` sidecar (`apps-store/quests/backend`) owns `quests.db`, the engine, and
`/api/quests/*` (served via the manifest `public_mount`). Core links NO quest code. Its three
reverse couplings (scheduler judge, `JobTarget::Quest` job lifecycle, activity feed) reach the
sidecar over loopback via `quests_client`.

## Clips (no `ryu-clips` dependency, no `clips` feature)

The former in-process `clips` feature was retired in the CoreDecouple wave. The `ryu-clips` sidecar
(`apps-store/clips/backend`, the `@ryu/clips` app, spawned by the generic sidecar loader) owns the
`/api/clips/*` Core-to-Shadow capture proxy and serves it via `public_mount`. Core no longer links
the crate, merges an in-process `clips_routes`, or runs a `clips_host` shim. The two `ClipsHost`
couplings (yt-dlp URL ingest and `Clips`-Space filing) degrade cleanly in the standalone sidecar;
the Shadow record/browse half is fully live there (it reads `RYU_SHADOW_URL` itself).

## Recipes (no `ryu-recipes` dependency, no `recipes` feature)

The `ryu-recipes` sidecar owns `/api/recipes/*` (over Ghost's shared `~/.ghost/recipes/`
RecipeStore) and serves it via `public_mount`, so there is no in-process `recipes_routes` merge. The
workflow executor's `Recipe`/`GhostAction` nodes drive Core's OWN built-in ghost MCP tool
(`sidecar::mcp::GHOST_RUN_TOOL` plus `client::extract_mcp_json`) through the shared registry. The
recorder subprocess stays Core-side in `recipes_host.rs`, reached by the sidecar via
`/api/host/capability/ghost.*` (`recipes_client`). That is a JSON boundary with no shared Rust
types.

## Teams (no `ryu-teams` dependency, no `teams` feature)

Teams are agent rosters plus a coordination strategy, addressed as one unit via `@team`. The weld
was severed; Core links none of the app's code. The `ryu-teams` sidecar is the single owner of
`teams.db` and serves `/api/teams/*` via `public_mount`, so there is no in-process `teams_routes`
merge. Core's two remaining reverse couplings, the `@team` chat orchestration
(`sidecar::adapters::{route_team_chat_stream, run_team_reply_text}`) and the
`agent_builder__create_agent_team` roster minter, reach it through the `teams.resolve` and
`teams.create` capabilities the app provides (`crate::agent_teams` over
`sidecar::capability_consumer`) rather than opening the DB.

What survived the cut was pure data: the three serde shapes both sides must agree on, now in
`ryu-teams-contracts` (see [Shared contract crates](#shared-contract-crates)).

## Research (no `ryu-research` dependency, no `research` feature)

Deep research is FULLY out of process. Both of the app's Rust surfaces are served by its own binary:

- `/api/research/*` goes to the app's sidecar via `public_mount` (generic ext-proxy), as before.
- The `research.*` MCP tools go to the app's own stdio MCP server (`ryu-research mcp`, the crate's
  `mcp_stdio` module), declared under `mcp_servers` in `apps-store/research/manifest.json` and
  registered by the generic `register_manifest_mcp_servers`. The Core-side
  `sidecar/mcp/research.rs` provider this replaced was an app-specific MCP module in the kernel,
  the shape `AGENTS.md` forbids.

Core neither merges `research_routes` nor links the crate. What stays Core-side is the PYTHON
autoresearch engine's lifecycle (`ResearchManager: Sidecar` and `sidecar::tools::research`, kernel
plumbing analogous to RyuTtsManager). It needs no app code, only the loopback address, which that
module owns outright. The Rust sidecar's `ResearchHost::start_sidecar` is a deliberate no-op.

## Self-healing (no `ryu-healing` dependency, no `healing` feature)

The former in-process `healing` feature was retired in the CoreDecouple wave, and the `ryu-healing`
lib dep that outlived it is gone too. The `ryu-healing` sidecar (`apps-store/healing/backend`,
`@ryu/healing`, its `[[bin]]` spawned by the generic sidecar loader) owns the diagnose-then-propose
engine, the loop-prevention decision logic, the per-source attempt cap, the `healing.*` prefs, the
Gateway diagnosis, and `/api/healing/*` (served via `public_mount`).

Core raises the `core#run.failed` kernel event (`run_failures`); the sidecar subscribes to it and
applies its verdict through Core's grant-gated kernel capabilities (`server::app_runs`, the
approvals write plus agent/workflow re-run). The run-status bus loop stays kernel. The only Rust the
two share is the wire contract in `ryu-healing-contracts`.

## Meetings (no `ryu-meetings` dependency)

The `ryu-meetings` sidecar (`apps-store/meetings/backend`) owns `meetings.db`, the engine and
audio/diarize pipeline, and `/api/meetings/*` (served to the desktop via `public_mount`). Core links
NO meeting code. Its reverse couplings (the kernel hardware ambient-audio path
`ryu_hardware::MeetingIngest`, the activity-feed fold, the data-admin clear, and the `save-notes`
Space-filing host callback) reach the sidecar over loopback via `crate::meetings_client`.

## Fine-tuning (no `ryu-finetune` dependency)

The `ryu-finetune` control-plane sidecar (`apps-store/finetune/backend`) owns `finetune.db`, the
trained-adapter catalog, the Python `unsloth` worker (over `RYU_UNSLOTH_URL`), and
`/api/finetune/*` (served via `public_mount`). Core links NO finetune code and holds no fine-tune
client. The Companion reaches the sidecar through the generic ext-proxy, and the learning loop
through the `finetune.start` and `finetune.merge` capabilities.

## Website monitors (no `ryu-monitors` dependency)

The `ryu-monitors` sidecar owns `monitors.db`, the engine, and `/api/monitors/*` (served via
`public_mount`). Core reaches it over loopback via `monitors_client` (scheduler run and backing-job
reconcile), and the sidecar reaches BACK via two ext-bearer host callbacks (Spider fetch and alert
fan-out). The kernel notification-delivery store and fan-out stay in Core (`crate::notify`),
sharing the dep-light `ryu-notify` wire types with the sidecar.

## Mail (retired `mail` feature)

The former in-process `mail` feature was retired in Track C. Mail is the out-of-process `@ryu/mail`
app, spawned by the generic sidecar loader with `/api/mail/*` served via `public_mount`.
`mail-parser` moved to that app's crate.
