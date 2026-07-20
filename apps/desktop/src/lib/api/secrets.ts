// BYOK provider-key vault — Tauri secure-storage API.
//
// Spike note (U029):
//   Plugin chosen:   keyring v3 crate (direct crate dependency, not a Tauri plugin).
//   Windows backend: Windows Credential Manager via CredWrite/CredRead (DPAPI-encrypted at
//                    rest, scoped to the logged-in Windows user profile).
//   Viability:       VIABLE for full BYOK vault.  Entries persist across process restarts by
//                    OS construction; values are never written to plaintext files, logs, or
//                    localStorage.  Max ~2 500 bytes per entry (sufficient for any API key).
//   Blockers:        keyring v4 requires Rust >= 1.88; project pins 1.77.2 — must upgrade
//                    or relax rust-version before adopting v4.  No cross-device sync.
import { invoke } from "@tauri-apps/api/core";

/**
 * Write (or overwrite) a provider API key in the OS credential store.
 * The value is user-supplied and never stored in plaintext or logs.
 * Rejects if `key` is empty.
 */
export const setProviderKey = (provider: string, key: string): Promise<void> =>
	invoke("set_provider_key", { provider, key });

/**
 * Read back a stored provider key.
 * Returns `null` when no key has been stored — callers must guard against this.
 */
export const getProviderKey = (provider: string): Promise<string | null> =>
	invoke("get_provider_key", { provider });

/**
 * Delete a stored provider key.  Idempotent — deleting a non-existent key is not an error.
 */
export const deleteProviderKey = (provider: string): Promise<void> =>
	invoke("delete_provider_key", { provider });
