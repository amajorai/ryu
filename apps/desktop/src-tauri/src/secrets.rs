// BYOK provider-key vault — one secret round-trip via the native OS credential store.
//
// Plugin chosen: keyring v3 crate (not a Tauri plugin) with platform-specific backends.
// Backends: Windows Credential Manager, macOS Keychain, and Linux Secret Service.
//   - Keys are scoped per SERVICE + user (keyring service = "ryu", user = provider slug).
//   - Survives process restart by construction (persisted by the native credential service).
//   - Data is encrypted by the operating-system credential service and is never logged.
//
// Viability for full BYOK vault:
//   VIABLE. The native stores accommodate API keys and tokens. The `keyring::Entry` API is
//   synchronous, so Tauri commands wrap it in `spawn_blocking`. The logged-in user can inspect
//   entries through the operating system's credential UI, consistent with other desktop tools.
//
// Blockers / caveats for the full vault:
//   - keyring v4 requires a newer compiler than the repository pin, so v3 remains required.
//   - No per-key metadata (description, created-at) without a separate store entry.
//   - No cross-device sync — keys stay on this machine.  Cloud sync is a future concern.

use keyring::Entry;
use tauri::Emitter as _;

use crate::desktop_seal::{self, DesktopSecret};

const SERVICE: &str = "ryu";

fn provider_entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|error| error.to_string())
}

fn write_provider_key(entry: &Entry, key: &str) -> Result<(), String> {
    entry.set_password(key).map_err(|error| error.to_string())
}

fn read_provider_key(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_provider_key(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Write (or overwrite) a provider key.  The key value is supplied by the user and is never
/// logged.  Returns an error string on failure.
#[tauri::command]
pub async fn set_provider_key(provider: String, key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("key value must not be empty".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let entry = provider_entry(&provider)?;
        write_provider_key(&entry, &key)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Read back a previously stored provider key.  Returns `None` when no key has been stored
/// for this provider (not an error — callers must guard against missing values).
#[tauri::command]
pub async fn get_provider_key(provider: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let entry = provider_entry(&provider)?;
        read_provider_key(&entry)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Delete a stored provider key.  Idempotent — deleting a non-existent entry is not an error.
#[tauri::command]
pub async fn delete_provider_key(provider: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let entry = provider_entry(&provider)?;
        remove_provider_key(&entry)
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── Desktop-owned sealed secrets ─────────────────────────────────────────────
//
// The webview's auth vault (every signed-in account's bearer token) and the
// license key. They used to sit in plaintext in the webview's localStorage and in
// tauri-plugin-store JSON files (`auth.bin`, `entitlement.bin`). They now live
// sealed (`enc:v1:`, the desktop's own keychain-held key) in one file per slot
// under the data dir's `secrets/`; see `desktop_seal.rs`. The webview keeps the
// opened values in memory only.

/// Event every window receives after a slot changes, so each one reloads its
/// in-memory copy (this replaces the cross-window `storage` event localStorage
/// used to provide). The payload is the slot name only, never the value.
pub const DESKTOP_SECRET_CHANGED_EVENT: &str = "desktop-secret-changed";

/// Serializes slot reads and writes across windows.
static DESKTOP_SECRET_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn with_secret_slot<T>(
    name: &str,
    operation: impl FnOnce(&std::path::Path) -> Result<T, String>,
) -> Result<T, String> {
    let slot = DesktopSecret::parse(name)?;
    let _guard = DESKTOP_SECRET_LOCK
        .lock()
        .map_err(|_| "Desktop secret lock is unavailable".to_owned())?;
    operation(&slot.path(&crate::profile::ryu_home_dir()))
}

/// Read one sealed desktop slot. `None` when nothing is stored.
#[tauri::command]
pub async fn desktop_secret_get(name: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || with_secret_slot(&name, desktop_seal::read_secret_file))
        .await
        .map_err(|error| error.to_string())?
}

/// Seal and store one desktop slot. Fails closed without a key: nothing is
/// written in plaintext.
#[tauri::command]
pub async fn desktop_secret_set(
    app: tauri::AppHandle,
    name: String,
    value: String,
) -> Result<(), String> {
    let slot = DesktopSecret::parse(&name)?;
    tokio::task::spawn_blocking(move || {
        with_secret_slot(&name, |path| desktop_seal::write_secret_file(path, &value))
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = app.emit(DESKTOP_SECRET_CHANGED_EVENT, slot.name());
    Ok(())
}

/// Delete one desktop slot. Idempotent.
#[tauri::command]
pub async fn desktop_secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let slot = DesktopSecret::parse(&name)?;
    tokio::task::spawn_blocking(move || with_secret_slot(&name, desktop_seal::delete_secret_file))
        .await
        .map_err(|error| error.to_string())??;
    let _ = app.emit(DESKTOP_SECRET_CHANGED_EVENT, slot.name());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercise the credential operations on one explicit in-memory entry. Platform persistence
    // comes from keyring's target-specific backend; tests must never open a real OS keychain.
    #[tokio::test]
    async fn test_roundtrip_write_read_delete() {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        let secret = "sk-test-byok-spike-value";

        // Write
        write_provider_key(&entry, secret).expect("write_provider_key should succeed");

        // Read back
        let result = read_provider_key(&entry).expect("read_provider_key should not error");
        assert_eq!(
            result.as_deref(),
            Some(secret),
            "round-trip value must match"
        );

        // Delete (cleanup)
        remove_provider_key(&entry).expect("remove_provider_key should succeed");

        // Confirm deleted
        let after = read_provider_key(&entry).expect("read after delete should not error");
        assert_eq!(after, None, "key should be absent after deletion");
    }

    #[tokio::test]
    async fn test_empty_key_rejected() {
        let err = set_provider_key("openai".to_string(), String::new())
            .await
            .unwrap_err();
        assert!(!err.is_empty());
    }

    #[tokio::test]
    async fn test_missing_key_returns_none() {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        let result = read_provider_key(&entry).expect("should not error");
        assert_eq!(result, None);
    }
}
