# ryu-downloads

The DownloadCenter artifact-fetch primitive: one process-wide registry that owns
the lifecycle of *every* artifact Ryu pulls over the network — chat/embedding
GGUFs, engine binaries (llama.cpp, whisper, sd-server), agent binaries, the
parakeet bundle, tools, and skills.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency (the sidecar loader, model catalog,
engines, and marketplace install all fetch through it — a primitive by reuse, not
swap). ZERO dependency on `apps/core`.

Why it exists: before it, every downloader streamed whole files into a `Vec<u8>`
(multi-GB into RAM) with no progress, cancel, or resume. The center replaces that
with stream-to-disk `.part` files (HTTP Range + `If-Range` resume), bounded retry,
checksum-verify + atomic rename, and live progress over a broadcast channel (SSE).
It is the single source of truth `/api/setup/status` is derived from.

## Key API

- `DownloadCenter` — the registry; queue / pause / resume / cancel + a durable
  history log (`downloads.json` + `downloads-history.json`).
- `DownloadTask` (state machine `DownloadState`: queued → active → paused →
  completed/failed/cancelled; `percent()`), `DownloadSpec`, `DownloadKind`,
  `VersionRecord`, and `DownloadEvent` (the SSE progress stream).
- `default_http_client()` — the shared reqwest client.

## Kernel seam (`DownloadsHost`)

Three process-global couplings invert through the narrow `DownloadsHost` trait:
the active `~/.ryu` **data dir** (dynamic — data-folder relocation moves it), the
**version-store checksum-skip** (a completed re-download is skipped when the
on-disk file already matches the recorded checksum), and **Hugging Face bearer
auth** (attach the HF token only to Hub hosts). Core installs `CoreDownloadsHost`
at boot via `set_global_host`; the production `host()` accessor panics loudly if
it was never installed rather than defaulting to a wrong data dir or dropping HF
auth. Tests install a temp-dir host first.

## Placement

Downloading artifacts is *what runs* → Core.
