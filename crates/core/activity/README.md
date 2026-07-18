# ryu-activity

The **activity feed** primitive: one unified, cross-module timeline of everything a
node did — monitor alerts, quest completions, approvals, meeting notes, runs, and
manual notes.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default and consumed as a **non-optional** path dependency (the store opens at boot,
backs a `ServerState` field, and the `/api/activity*` routes are always mounted).

Placement (Core vs Gateway): this records *what the node did* — a history of what
ran, not a policy decision about what is allowed — so it is **Core**.

Zero dependency on `apps/core`. `ActivityStore::open` takes an explicit db path, so
the default-path choice (`~/.ryu/activity.db`) stays Core-side wiring — **that
explicit path is the seam.** The per-engine event *mappers*
(`from_monitor_alert`/`from_quest_event`/…) and their subscribe-loops stay in
`apps/core` (`activity::ingest`) because they consume Core types
(monitors/approvals/meetings/quests) and would otherwise force a dependency back onto
Core.

## Key surface

- `ActivityItem` — the v1 record contract: `id`, `kind`, `source`, `title`, optional
  `body`/`agent_id`/`session_id`, `level`, JSON `metadata`, `created_at` (epoch
  seconds). Unset optionals serialize as `null` (never skipped); builder methods
  (`with_body`/`with_agent`/`with_session`/`with_level`/`with_metadata`/
  `with_created_at`).
- `ActivityLevel` — `Info` (default) / `Success` / `Warning`; drives the feed icon.
- `ActivityStore` — SQLite persistence + newest-first cursor paging + a `tokio`
  broadcast fan-out that backs the `/api/activity/stream` SSE feed.

## Consumed as

Compiled-into-Core crate; served over Core's `/api/activity*` routes.

Deps: rusqlite (bundled), serde/serde_json, chrono, uuid, tokio (sync). Dev:
tempfile.
