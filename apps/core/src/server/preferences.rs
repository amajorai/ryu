//! Cross-surface key-value preferences store.
//!
//! A tiny SQLite-backed KV table (`~/.ryu/preferences.db`) plus a broadcast
//! channel for live change notifications. Its first consumer is the shared
//! theme blob (key `theme`): the desktop writes it on every appearance change,
//! and the island companion — a separate Electron process that cannot share the
//! desktop's `localStorage` — reads it and subscribes to the change stream so
//! both surfaces render the exact same preset.
//!
//! Placement note (Core vs Gateway): this stores *what the user picked*, not
//! policy about what is allowed — so it belongs in Core.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{global_cipher, FieldCipher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

/// Preference values that are credentials or bearer material rather than user
/// settings. Keep this explicit: encrypting by a loose substring match would
/// eventually catch non-secret values such as token-count settings, while
/// missing a key here would leave a credential in plaintext.
const SECRET_PREFERENCE_KEYS: &[&str] = &[
    "aa-api-key",
    "composio-api-key",
    "fal-api-key",
    "gif-api-key",
    "github-api-token",
    "hf-token",
    "managed-gateway-token",
    "openrouter-api-key",
    "replicate-api-key",
    "smithery-api-key",
    "smtp-password",
    "node-onboarding-state",
];

/// Whether a preference value must be sealed before it is written to SQLite.
pub fn is_secret_preference_key(key: &str) -> bool {
    SECRET_PREFERENCE_KEYS.contains(&key)
}

/// A single preference change, fan-out to SSE subscribers.
#[derive(Clone, Serialize)]
pub struct PreferenceEvent {
    pub key: String,
    pub value: String,
}

/// SQLite-backed KV preferences store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct PreferencesStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<PreferenceEvent>,
    cipher: FieldCipher,
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("preferences.db")
}

impl PreferencesStore {
    /// Open (or create) the store at the default path (`~/.ryu/preferences.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        // Tests and embedders can construct a store without running Core's main
        // boot sequence. Installing the host here is idempotent and ensures the
        // same fail-closed key resolution is used by every preferences path.
        crate::crypto_host::install();
        let cipher = global_cipher().context("loading preferences encryption key")?;
        Self::open_with_cipher(path, cipher)
    }

    fn open_with_cipher(path: PathBuf, cipher: FieldCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening preferences db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(64);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
            cipher,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS preferences (
                 key        TEXT PRIMARY KEY,
                 value      TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .context("initializing preferences schema")?;
        Ok(())
    }

    /// Read a preference value by key, or `None` if unset.
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let value = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading preference")?;
        value
            .map(|value| {
                if is_secret_preference_key(key) {
                    self.cipher
                        .open(&value)
                        .with_context(|| format!("decrypting preference {key}"))
                } else {
                    Ok(value)
                }
            })
            .transpose()
    }

    /// Upsert a preference value and notify SSE subscribers.
    pub async fn set(&self, key: &str, value: &str) -> Result<()> {
        let stored_value = if is_secret_preference_key(key) {
            self.cipher
                .seal(value)
                .with_context(|| format!("encrypting preference {key}"))?
        } else {
            value.to_owned()
        };
        let now = chrono::Utc::now().timestamp_millis();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
                params![key, stored_value, now],
            )
            .context("writing preference")?;
        }
        // A send error just means no live subscribers — not a failure.
        let _ = self.tx.send(PreferenceEvent {
            key: key.to_string(),
            // Secret preferences are useful to the owner but must never be
            // echoed into an SSE subscriber or companion process. Consumers
            // can reread through the authenticated preference route when they
            // actually need the value.
            value: if is_secret_preference_key(key) {
                String::new()
            } else {
                value.to_string()
            },
        });
        Ok(())
    }

    /// Delete a preference and notify live subscribers when a row existed.
    ///
    /// The empty event value is the existing SSE representation for a cleared
    /// key; callers that need to distinguish clear from setting an empty value
    /// should reread the key, which also keeps secret values out of the event.
    pub async fn delete(&self, key: &str) -> Result<()> {
        let removed = {
            let conn = self.conn.lock().await;
            conn.execute("DELETE FROM preferences WHERE key = ?1", params![key])?
        };
        if removed > 0 {
            let _ = self.tx.send(PreferenceEvent {
                key: key.to_owned(),
                value: String::new(),
            });
        }
        Ok(())
    }

    /// Subscribe to live preference changes (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<PreferenceEvent> {
        self.tx.subscribe()
    }

    // ── Per-model launch config (advanced inference) ───────────────────────────
    //
    // Engine-launch flags (context size, GPU layers, MoE offload, chat template,
    // speculative draft model, quantization, ...) are properties of the *loaded
    // model*, not the agent: one resident engine serves every agent, so these are
    // keyed per model id. Stored as `LaunchConfig` JSON under
    // `model.launch.{model_id}`, with a per-engine fallback `model.launch.engine.
    // {engine}` so the feature still applies when the served model id is unknown.
    // Changing any field requires the engine process to restart (apply on load).

    /// Read the launch config for a model id. Returns the empty/default config
    /// when unset or unparseable (fail-soft: a corrupt value never breaks spawn).
    pub async fn get_launch_config(&self, model_id: &str) -> crate::inference::LaunchConfig {
        match self.get(&launch_key(model_id)).await {
            Ok(Some(s)) => serde_json::from_str(&s).unwrap_or_default(),
            _ => crate::inference::LaunchConfig::default(),
        }
    }

    /// Persist the launch config for a model id (serialised to JSON).
    pub async fn set_launch_config(
        &self,
        model_id: &str,
        cfg: &crate::inference::LaunchConfig,
    ) -> Result<()> {
        let json = serde_json::to_string(cfg).context("serializing launch config")?;
        self.set(&launch_key(model_id), &json).await
    }

    /// Resolve the launch config to apply when spawning `engine` to serve
    /// `model_id`: the per-model config if set, else the per-engine fallback, else
    /// empty. Used by the engine managers at spawn time.
    pub async fn resolve_launch_config(
        &self,
        model_id: &str,
        engine: &str,
    ) -> crate::inference::LaunchConfig {
        let primary = self.get_launch_config(model_id).await;
        if !primary.is_empty() {
            return primary;
        }
        match self.get(&launch_engine_key(engine)).await {
            Ok(Some(s)) => serde_json::from_str(&s).unwrap_or_default(),
            _ => crate::inference::LaunchConfig::default(),
        }
    }
}

const LAUNCH_KEY_PREFIX: &str = "model.launch.";

/// Preferences key for a model's launch config.
pub fn launch_key(model_id: &str) -> String {
    format!("{LAUNCH_KEY_PREFIX}{model_id}")
}

/// Preferences key for an engine-wide launch-config fallback (applied when the
/// served model id is unknown or has no per-model config).
pub fn launch_engine_key(engine: &str) -> String {
    format!("{LAUNCH_KEY_PREFIX}engine.{engine}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory_store() -> PreferencesStore {
        let conn = Connection::open_in_memory().expect("open in-memory preferences db");
        PreferencesStore::init_schema(&conn).expect("init preferences schema");
        let (tx, _rx) = broadcast::channel(64);
        PreferencesStore {
            conn: Arc::new(Mutex::new(conn)),
            tx,
            cipher: FieldCipher::new(&[0x41; 32]),
        }
    }

    fn temp_store() -> PreferencesStore {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.push(format!("ryu-prefs-test-{nanos}.db"));
        PreferencesStore::open(path).expect("open temp preferences store")
    }

    #[tokio::test]
    async fn secret_preferences_are_sealed_on_disk_and_round_trip() {
        let store = in_memory_store();
        store
            .set("hf-token", "hf_super_secret")
            .await
            .expect("set secret preference");

        assert_eq!(
            store.get("hf-token").await.unwrap().as_deref(),
            Some("hf_super_secret")
        );
        let conn = store.conn.lock().await;
        let stored: String = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = 'hf-token'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored.starts_with("enc:v1:"));
        assert!(!stored.contains("hf_super_secret"));
    }

    #[tokio::test]
    async fn non_secret_preferences_remain_queryable_plaintext() {
        let store = in_memory_store();
        store.set("theme", "dark").await.unwrap();

        let conn = store.conn.lock().await;
        let stored: String = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = 'theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "dark");
    }

    #[tokio::test]
    async fn delete_removes_preference_and_notifies_subscribers() {
        let store = in_memory_store();
        store.set("theme", "dark").await.unwrap();
        let mut events = store.subscribe();

        store.delete("theme").await.unwrap();

        assert_eq!(store.get("theme").await.unwrap(), None);
        let event = events.recv().await.unwrap();
        assert_eq!(event.key, "theme");
        assert!(event.value.is_empty());
    }

    #[tokio::test]
    async fn secret_preferences_are_not_echoed_to_subscribers() {
        let store = in_memory_store();
        let mut events = store.subscribe();

        store
            .set("node-onboarding-state", "company context")
            .await
            .unwrap();

        let event = events.recv().await.unwrap();
        assert_eq!(event.key, "node-onboarding-state");
        assert!(event.value.is_empty());
        assert_eq!(
            store.get("node-onboarding-state").await.unwrap().as_deref(),
            Some("company context")
        );
    }

    #[test]
    fn secret_key_allowlist_is_explicit() {
        assert!(is_secret_preference_key("composio-api-key"));
        assert!(is_secret_preference_key("smtp-password"));
        assert!(is_secret_preference_key("node-onboarding-state"));
        assert!(!is_secret_preference_key("context.max-tokens"));
        assert!(!is_secret_preference_key("theme"));
    }

    #[tokio::test]
    async fn launch_config_roundtrips_per_model() {
        let store = temp_store();
        let cfg = crate::inference::LaunchConfig {
            ctx_size: Some(8192),
            gpu_layers: Some(35),
            cpu_moe: Some(true),
            ..Default::default()
        };
        store
            .set_launch_config("owner/model-gguf", &cfg)
            .await
            .expect("set launch config");
        let fetched = store.get_launch_config("owner/model-gguf").await;
        assert_eq!(fetched, cfg);
        // Unknown model id returns the empty default.
        assert!(store.get_launch_config("nope").await.is_empty());
    }

    #[tokio::test]
    async fn resolve_falls_back_to_engine_key() {
        let store = temp_store();
        let cfg = crate::inference::LaunchConfig {
            ctx_size: Some(4096),
            ..Default::default()
        };
        // Stored under the per-engine fallback key, not the model key.
        store
            .set(
                &launch_engine_key("llamacpp"),
                &serde_json::to_string(&cfg).unwrap(),
            )
            .await
            .expect("set engine fallback");
        // A model with no per-model config resolves to the engine fallback.
        let resolved = store.resolve_launch_config("some/model", "llamacpp").await;
        assert_eq!(resolved.ctx_size, Some(4096));
        // A model WITH its own config wins over the fallback.
        let per_model = crate::inference::LaunchConfig {
            ctx_size: Some(2048),
            ..Default::default()
        };
        store
            .set_launch_config("some/model", &per_model)
            .await
            .expect("set per-model");
        let resolved = store.resolve_launch_config("some/model", "llamacpp").await;
        assert_eq!(resolved.ctx_size, Some(2048));
    }
}
