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
