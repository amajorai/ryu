# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-redis-wire

> Minimal RESP2 client for Ryu's pluggable state stores. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../../apps/core/LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-redis-wire` speaks just enough of the Redis/Valkey protocol for Ryu's Redis-backed stores: the
durable checkpoint store (`ryu-durable`, feature `redis`) and the Gateway response, semantic, and
embedding caches (`ryu-gw-cache`). It exists so those crates share one small, audited client
instead of each pulling a full Redis client crate.

## What it provides

- **`codec`** — binary-safe command encoding (`Cmd`) and an incremental, bounded RESP2 parser
  (`parse_frame`: 64 MiB bulk, 1M-item array, depth 16 limits).
- **`RedisUrl`** — `redis://`, `rediss://` (TLS), `valkey://`, `valkeys://`; userinfo becomes
  `AUTH`, the path becomes `SELECT`. `redacted()` and `Debug` never show credentials.
- **`RedisClient`** — a small pool of lazily-opened connections with connect and I/O deadlines.
  `query` (one command), `pipeline` (many commands, one round trip), and `transaction`
  (`MULTI`/`EXEC`). A failed or timed-out round trip drops its connection; nothing is retried
  automatically, so a write is never applied twice. Errors name the command, never its arguments.
- **`testing::FakeRedis`** (feature `testing`) — an in-process RESP server implementing the
  strings/sets/sorted-sets/hashes/`MULTI` subset the stores use, with a programmable handler for
  other commands (for example RediSearch `FT.*`) and a command log for assertions.

## Placement

Wire plumbing only; it holds no policy and no data. **ZERO dependency on `apps/core`.**

## Build

```bash
cargo test -p ryu-redis-wire --features testing
```

## License

Apache-2.0; see [LICENSE](../../../apps/core/LICENSE). © 2026 A Major Pte. Ltd.
