// BYOK provider-key vault — spike: one secret round-trip via Windows Credential Manager.
//
// Plugin chosen:  keyring v3 crate (not a Tauri plugin) with `windows-native` feature.
// Windows backend: Windows Credential Manager (wincred / CredWrite/CredRead).
//   - Keys are scoped per SERVICE + user (keyring service = "ryu", user = provider slug).
//   - Survives process restart by construction (persisted in the OS user profile hive).
//   - Data is encrypted at rest by Windows DPAPI — never written to plaintext files/logs.
//
// Viability for full BYOK vault:
//   VIABLE.  Credential Manager holds up to ~2 500 bytes per entry, which is enough for any
//   API key or token.  The `keyring::Entry` API is synchronous; wrap in `spawn_blocking` for
//   async Tauri commands.  The main limitation on Windows is that entries are visible in the
//   "Windows Credential Manager" control-panel app to the logged-in user — acceptable for a
//   desktop tool (consistent with how browsers, git-credential-manager, etc. work).
//
// Blockers / caveats for the full vault:
//   - keyring v4 requires Rust 1.88; the project pins 1.77.2, so we must stay on v3 for now.
//   - No per-key metadata (description, created-at) without a separate store entry.
//   - No cross-device sync — keys stay on this machine.  Cloud sync is a future concern.

use keyring::Entry;

const SERVICE: &str = "ryu";

/// Write (or overwrite) a provider key.  The key value is supplied by the user and is never
/// logged.  Returns an error string on failure.
#[tauri::command]
pub async fn set_provider_key(provider: String, key: String) -> Result<(), String> {
	if key.is_empty() {
		return Err("key value must not be empty".to_string());
	}
	tokio::task::spawn_blocking(move || {
		let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
		entry.set_password(&key).map_err(|e| e.to_string())
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Read back a previously stored provider key.  Returns `None` when no key has been stored
/// for this provider (not an error — callers must guard against missing values).
#[tauri::command]
pub async fn get_provider_key(provider: String) -> Result<Option<String>, String> {
	tokio::task::spawn_blocking(move || {
		let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
		match entry.get_password() {
			Ok(v) => Ok(Some(v)),
			Err(keyring::Error::NoEntry) => Ok(None),
			Err(e) => Err(e.to_string()),
		}
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Delete a stored provider key.  Idempotent — deleting a non-existent entry is not an error.
#[tauri::command]
pub async fn delete_provider_key(provider: String) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
		match entry.delete_credential() {
			Ok(()) => Ok(()),
			Err(keyring::Error::NoEntry) => Ok(()),
			Err(e) => Err(e.to_string()),
		}
	})
	.await
	.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
	use super::*;

	// Validates the Windows Credential Manager round-trip that is the core of AC #1.
	// We cannot restart the process in a unit test, but writing via CredWrite and reading back
	// via CredRead proves OS-level persistence — the same mechanism that survives process
	// restarts.  The entry is cleaned up after the test to be idempotent.
	#[tokio::test]
	async fn test_roundtrip_write_read_delete() {
		let provider = "test-spike-provider".to_string();
		let secret = "sk-test-byok-spike-value".to_string();

		// Write
		set_provider_key(provider.clone(), secret.clone())
			.await
			.expect("set_provider_key should succeed");

		// Read back
		let result = get_provider_key(provider.clone())
			.await
			.expect("get_provider_key should not error");
		assert_eq!(result, Some(secret), "round-trip value must match");

		// Delete (cleanup)
		delete_provider_key(provider.clone())
			.await
			.expect("delete_provider_key should succeed");

		// Confirm deleted
		let after = get_provider_key(provider)
			.await
			.expect("get after delete should not error");
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
		let result = get_provider_key("no-such-provider-xyz".to_string())
			.await
			.expect("should not error");
		assert_eq!(result, None);
	}
}
