# ryu-storage

The plugin-owned key/value storage primitive: an isolated, namespaced SQLite KV
store that backs the plugin-host `storage:kv` capability.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency — the plugin turn-hook runtime reaches
it unconditionally. ZERO dependency on `apps/core`.

This is where a plugin keeps durable state instead of Core growing bespoke columns
for it — e.g. the goal plugin stores its per-conversation completion condition +
turn count here (key = conversation id), not on the `conversations` table.

## Key API

`PluginStorage` (cheap to clone; wraps an `Arc<Mutex<Connection>>`):

- `open(path)` / `in_memory()` — open + migrate the store.
- `get / set / delete` and `keys` — all keyed by `(plugin_id, namespace, key)`.
  `set` is an upsert; `keys` lists a plugin's keys within a namespace, newest
  first.

Rows are namespaced by `(plugin_id, namespace, key)` so one plugin can never read
another's state — the isolation guarantee the `storage:kv` grant relies on.

## How it is consumed

`PluginStorage::open` takes an explicit db path, so the crate is pure. The single
kernel coupling — choosing the default `~/.ryu/plugin-storage.db` path — and the
process-global handle stay Core-side as wiring (`apps/core/src/plugin_storage`).

## Placement

It stores *what a plugin is tracking* (decides what runs, not what is allowed) →
Core-tier.
