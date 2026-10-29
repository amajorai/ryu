# ryu-core third-party dependency notes

Rationale for external crates in [`apps/core/Cargo.toml`](../Cargo.toml). Index:
[DEPENDENCIES.md](../DEPENDENCIES.md). Crates without an entry here (tokio, axum, serde, reqwest,
and similar) have no special constraint beyond their declared features.

## Networking and transport

### tokio-tungstenite

WebSocket client for the ext-proxy WebSocket tunnel. Core upgrades a client socket and bridges it to
a manifest sidecar's declared WS endpoint (the interactive desktop stream rides
`/api/ext/ws/<plugin>/<route>`). It only dials loopback, so the `connect` feature and no TLS extras
are needed; the hop never leaves 127.0.0.1.

### hyper, hyper-util, http-body-util, bytes, rustls, tokio-rustls

The Vault credential broker (`apps/core/src/vault/broker`) is a loopback HTTP/HTTPS forward proxy
that terminates CONNECT with leaf certificates minted by a vault-held CA. All of these were already
in `Cargo.lock` through reqwest/axum. The `ring` provider is selected explicitly on `rustls` and
`tokio-rustls` because both rustls crypto providers are compiled into the workspace.

### rustls-native-certs

Reads the OS trust store, which is written next to the broker CA into the combined bundle that the
replaced variables (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, ...) point at.

### tokio-postgres, postgres-native-tls, native-tls, tokio-native-tls

The Postgres dynamic-secret provider creates short-lived database roles. Redis/Valkey dynamic and
static roles speak RESP over TLS (`rediss://`), which is what `tokio-native-tls` is for.

## Hashing, identity and crypto

### sha1

RFC 6238 TOTP defaults to HMAC-SHA1 (the vault TOTP engine). It was already locked via other crates.

### shell-words

Argv-safe splitting of agent-supplied command strings (`rtk__run`). Quotes are honored but shell
metacharacters (`;`, `$()`, backticks, pipes) are never interpreted, because the command is exec'd
argv-style, not through `sh -c`.

### unicode-normalization

NFKD for `agent_inbox` alias folding, mirroring `@ryu/mail` `normalizeAliasLocalPart`.

### jsonwebtoken

Phase 0 multi-user identity (#multiplayer). Core verifies Better Auth JWTs OFFLINE against the JWKS
endpoint. EdDSA/Ed25519 is Better Auth's default signing algorithm and jsonwebtoken 10 supports it
out of the box (its `jwk` module decodes OKP keys via `DecodingKey::from_jwk`). The node-admittance
gate stays `RYU_TOKEN`; this layer is the USER identity (see `src/identity_verify/`).

### rcgen, time

Secret Vault engines (`docs/vault-parity-spec.md` in the private checkout): the PKI engine issues
X.509 certificates and CRLs from a vault-held CA. `time` is rcgen's validity type.

### chacha20poly1305, p256, p384, rsa, hkdf, aes

Transit key types (ChaCha20-Poly1305, ECDSA P-256/P-384, RSA), derived (HKDF) keys, BYOK key
unwrapping (RSA-OAEP plus AES-KWP over `aes`), and ES256 identity-token signing keys. All were
already locked via other crates.

### x509-parser

PKI intermediate `set-signed` and issuer import validate external CA certificates, and the Vault
`cert` machine login verifies client certificates against a CA. The tests also parse issued
certificates and CRLs.

## Collaboration

### yrs

Phase 3 multi-user collaboration (#multiplayer): the authoritative CRDT document engine. `yrs` is
the Rust port of Yjs with an IDENTICAL binary v1 update and state-vector format, so a custom JS Yjs
provider's updates apply natively. Ryu defines a tiny self-framed DocSync protocol over the existing
realtime DocSync channel rather than pulling y-sync or yrs-axum (version traps). See `src/collab/`
and the `ryu-collab` crate.

## Audio

### opus

Ryu Hardware Protocol (RHP v1) audio bridging. The device link speaks Opus while the rest of Core
speaks WAV/PCM (whisper STT, OuteTTS). The `opus` crate wraps libopus through
`audiopus-sys`/`opus-sys`, whose build script BUILDS libopus FROM VENDORED SOURCE via CMake when
pkg-config cannot find a system copy (the default on Windows and on any box without libopus-dev), so
`cargo check` is self-contained. Its API is plain slices (`encode(&[i16], &mut [u8])` and
`decode(&[u8], &mut [i16], fec)`), unlike audiopus's wrapper types.

Advisory: `opus` depends on `audiopus_sys`, and there is no safe upstream upgrade for
RUSTSEC-2026-0150. The advisory is ignored in the repository `deny.toml`, which points at the
note beside `opus` in `apps/core/Cargo.toml`, and that note points here. Keep the ignore visible
until the voice transport moves.

### hound

Reads and writes the RIFF/WAV the transcribe and synth seams use.

## Rendering

### resvg, png

Server-side dashboard rasterization for the hardware display surface (TRMNL-style: the node renders
a device's dashboard to an image, the device just polls and blits it; see
`apps/hardware/DASHBOARD.md`). Core builds an SVG layout from the live widget data and rasterizes it
WITHOUT a headless browser. `resvg` renders the SVG onto a `tiny-skia` pixmap (pure Rust, no system
deps, no Chromium), and the `png` crate encodes the LCD color path. The e-ink path dithers the
pixmap to 1-bit and packs it in Core (`src/dashboard/render.rs`). `resvg` re-exports
`usvg`/`tiny-skia`, so Core depends on it alone to keep ONE version of each.

## Agent protocols

### agent-client-protocol (exact pin `=3.5.0`)

ACP 3.x stabilized most of what Core used to opt into through `unstable_*` features: the live usage
meter (`SessionUpdate::UsageUpdate`), session/close, session/resume, logout, boolean config options,
and additional directories.

- Boolean config options stay load-bearing. `SessionConfigOption` deserializes through
  `DefaultOnError<VecSkipError<..>>`, so a schema without `SessionConfigKind::Boolean` would
  silently drop an agent's toggles. 3.x also needs the client to advertise
  `session.configOptions.boolean`; see `ryu_client_capabilities`.
- Session models were REMOVED from the schema, not stabilized. Core keeps `session/set_model` and
  the `models` response field as Ryu-local wire types in `sidecar/adapters/acp.rs` for agents that
  still speak them.
- `unstable_mcp_over_acp` is deliberately OFF. Its `type: "acp"` binding replaced the `_mcp/*` wire
  that Ryu's tool bridge speaks, which Core now owns in `sidecar/adapters/acp_mcp_over_acp.rs`.
- The former `agent-client-protocol-tokio` wrapper (`AcpAgent` subprocess spawning,
  `LineDirection`) now lives in the main crate behind the `process` feature.
- `unstable_end_turn_token_usage` provides `PromptResponse.usage` (per-turn token totals, surfaced to
  the desktop as a `data-acp-usage` stats frame). It was renamed from `unstable_session_usage`.

### async-trait

Async methods in traits that must stay object-safe (`dyn`-dispatched host seams, channel adapters,
provider abstractions; about 30 impls across `src/`). Non-optional because those traits are in the
unconditional build.

## Scheduling

### chrono-tz

The IANA zone database, so a cron schedule can be evaluated in the user's own wall-clock time
instead of UTC. A fixed offset would drift an hour twice a year across DST, which is exactly the
failure a "fire at 05:00 local" schedule cannot tolerate. See
`scheduler::cron::CronSchedule::matches_in`.

## API surface and system info

### utoipa

OpenAPI spec generated from the Axum handlers. `--dump-openapi` writes the spec the docs site
(`apps/fumadocs`) renders; see `src/openapi.rs`.

### sysinfo

Live system snapshot (CPU/RAM/disk) for the per-node hardware view, plus per-process sampling for
the per-engine resource usage shown in the node selector. GPU/VRAM still comes from `device.rs`.

## Observability

### opentelemetry, opentelemetry_sdk, opentelemetry-otlp, tracing-opentelemetry

The OpenTelemetry seam (#539, P1) is the vendor-neutral instrumentation export path.

- `tracing-opentelemetry` 0.33 bridges the existing `tracing` spans into OTel. It pins
  `opentelemetry` ^0.32, so the whole family is pinned to 0.32 to keep ONE `opentelemetry` in the
  tree. A version skew pulls two and breaks the layer's trait bounds.
- OTLP/HTTP-protobuf only (`http-proto` plus `reqwest-blocking-client`), to avoid tonic/grpc; Axiom
  and most collectors speak OTLP/HTTP.
- The blocking client is required: the SDK's batch processor exports from its own thread with no
  Tokio reactor, where the async reqwest client panics.
- The exporter is installed ONLY on consent (see `main.rs`). With the pref off nothing egresses and
  the local `trace.rs` SQLite sink is untouched.
- The backend is a swappable config value (`diagnostics-otlp-endpoint` /
  `OTEL_EXPORTER_OTLP_ENDPOINT`), never a lock-in.

The Gateway mirrors this seam in `apps/gateway/Cargo.toml`.

### sentry

Crash reporting tier (#544, P3): Sentry for Rust PANICS ONLY. It is gated on the
`crash-reports-enabled` pref (separate consent from product analytics) and a DSN env
(`SENTRY_DSN` / `RYU_SENTRY_DSN`); an absent DSN means disabled and never crashes boot.

- Deliberately NO `sentry-tracing` or `sentry-log` feature. Those sweep `tracing`/log events (which
  can hold prompt or agent content and `~/.ryu` paths) into Sentry.
- Only the `panic` integration plus `backtrace`/`contexts` are enabled, and a `before_send` hook
  scrubs home-dir paths from the panic message and frames.
- The `reqwest` plus `native-tls` transport matches the tree's existing reqwest, so no second TLS
  stack is pulled.
