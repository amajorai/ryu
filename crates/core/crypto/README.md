# ryu-crypto

The encryption-at-rest primitive for Ryu — one crypto path every local store
hangs off (`docs/encryption-at-rest.md`).

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency: the session/chat loop and long-term
memory encrypt every row unconditionally, so there is no `off` build. ZERO
dependency on `apps/core`.

## Key API

- `FieldCipher` — ChaCha20-Poly1305 AEAD with a self-describing field envelope
  `enc:v1:<base64(nonce||ciphertext)>`. `seal`/`open` for string columns,
  `encrypt`/`decrypt` for blobs. `open` transparently passes through **legacy
  plaintext** (anything without the `enc:v1:` prefix), so already-stored rows keep
  working and upgrade to ciphertext on the next write. `is_sealed` tests a value.
- `global_cipher()` — the process-wide cipher backed by the swappable master key,
  resolved in priority order: `RYU_MASTER_KEY` (env) → OS keychain (default) →
  `~/.ryu` file fallback, with legacy in-memory-key migration. The key lives
  *outside* the data it protects, so a copy of `~/.ryu` alone cannot decrypt.
  Headless-safe: no interactive prompts.

## Content sealing (phase 2)

User content and PII are sealed per value under per-store keys derived from the
root key a process already holds (master key in Core, plugin subkey in a
satellite, component subkey in the Gateway, Shadow or Ghost). The formats are
pinned by `tests/vectors/content-v1.json` (shared with the TypeScript and Python
helpers):

- `content` — `ContentCipher` (`encb:v1:` TEXT, `RYU-CB01` BLOB, AAD from a
  `ContentContext` of store, purpose and stable ids; retired-key fallback with
  `needs_reseal`); constructors `content_cipher`, `plugin_content_cipher`,
  `plugin_content_cipher_for_process`, `component_content_cipher_for_process`,
  `app_content_cipher`, `PluginCipher::content_cipher`,
  `ComponentCipher::content_cipher`; `key_check_value`.
- `blind_index` — `BlindIndex` equality tokens (`bi1:`), full-text term tokens,
  and the shared term tokenizer `tokenize_terms`.
- `sealed_file` — write-once `RYU-SF01` files with verified length and Range
  reads; `seal_file_in_place`; `ensure_free_space`.
- `sealed_log` — append-only `RYU-SL01` logs with torn-tail recovery and
  `compact_to_sealed_file`.
- `vector_index` — in-memory f16 vector index under one process-wide budget
  (`RYU_VECTOR_CACHE_MB`), LRU partitions and coverage reporting.
- `content_sqlite` (feature `sqlite`) — the `ryu_content_seal` state table,
  cursor-paginated migration, per-store key check, freelist scrub and gated
  `VACUUM`.
- `custody` — key check value, no generation over sealed data, candidate
  recovery, retired keys, data-format marker, `keys` CLI helpers and the
  export key bundle.

Feature `test-ephemeral-host` (dev-dependencies only) lets kernel-crate unit
tests build sealing stores without a host: debug builds then use a
process-ephemeral root.

## Kernel seam (`CryptoHost`)

The two things the crate needs from the kernel — the profile-scoped keychain
account suffix and the `~/.ryu` data dir — invert through the narrow `CryptoHost`
trait. Core implements it once (`crate::crypto_host::CoreCryptoHost`) and installs
it at boot via `set_global_host` before the first store opens.

## Swap seam

Key-custody policy (env/keychain/file, legacy migration) stays in-crate; the
internal `Keychain` port is the swap seam for a future local-key → KMS backend.
The per-platform keychain backend (Windows Credential Manager / macOS Keychain /
Linux Secret Service) is selected by `cfg(target_os)`.

## Placement

At-rest encryption of local orchestration data is *what runs* → Core. The
Gateway's firewall/DLP governs *what is allowed/shared* on egress — a separate
layer.
