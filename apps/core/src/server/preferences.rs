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
    // Per-agent ACP launch settings: their environment map routinely carries
    // agent API keys, so the whole map is sealed and never echoed to subscribers.
    "acp-agent-settings",
    "composio-api-key",
    "fal-api-key",
    "gif-api-key",
    "github-api-token",
    "hf-token",
    // Bearer for the learning engine's process-reward-model endpoint.
    "learning.prm-key",
    "managed-gateway-token",
    "openrouter-api-key",
    "replicate-api-key",
    "smithery-api-key",
    "smtp-password",
    "unsplash-access-key",
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
    crate::paths::db_path("preferences.db")
}

impl PreferencesStore {
    /// Open (or create) the store at the default path (`~/.ryu/preferences.db`).
    ///
    /// Returns a clone of one process-wide handle. The data dir and cipher are both
    /// fixed for the process, and callers such as the tool-search ranker read a
    /// pref on every call; reopening SQLite and re-running the WAL pragma and schema
    /// each time was pure overhead. Sharing the handle also means a write through
    /// any caller reaches the change-stream subscribers. A failed open is not
    /// cached, so a later call can still succeed.
    pub fn open_default() -> Result<Self> {
        static DEFAULT_STORE: std::sync::OnceLock<PreferencesStore> = std::sync::OnceLock::new();
        if let Some(store) = DEFAULT_STORE.get() {
            return Ok(store.clone());
        }
        let store = Self::open(default_db_path())?;
        Ok(DEFAULT_STORE.get_or_init(|| store).clone())
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
        Self::reseal_plaintext_secrets(&conn, &cipher)?;
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

    /// Seal, once, every credential preference still stored as legacy plaintext
    /// (written before its key joined [`SECRET_PREFERENCE_KEYS`], or by an older
    /// build). When anything was rewritten the WAL is checkpointed and the file
    /// vacuumed, so the replaced plaintext pages do not linger in free space.
    fn reseal_plaintext_secrets(conn: &Connection, cipher: &FieldCipher) -> Result<()> {
        use ryu_crypto::SecretSealer as _;
        let mut statement = conn
            .prepare("SELECT key, value FROM preferences")
            .context("listing preferences for reseal")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("listing preferences for reseal")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("listing preferences for reseal")?;
        drop(statement);
        let mut resealed = 0usize;
        for (key, value) in rows {
            if !is_secret_preference_key(&key) {
                continue;
            }
            let Some(sealed) = cipher
                .reseal_if_plaintext(&value)
                .with_context(|| format!("sealing preference {key}"))?
            else {
                continue;
            };
            conn.execute(
                "UPDATE preferences SET value = ?1 WHERE key = ?2",
                params![sealed, key],
            )
            .with_context(|| format!("resealing preference {key}"))?;
            resealed += 1;
        }
        if resealed > 0 {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
                .context("purging plaintext preference pages")?;
            tracing::info!(
                count = resealed,
                "preferences: sealed legacy plaintext credentials"
            );
        }
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
        let event = PreferenceEvent {
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
        };
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, stored_value, now],
        )
        .context("writing preference")?;
        // Publish before releasing the store lock: events then reach subscribers
        // in commit order, so the last one is always the durable value even when
        // writers race. A send error just means no live subscribers.
        let _ = self.tx.send(event);
        Ok(())
    }

    /// Upsert several preference values in one transaction (all or none are
    /// written), then notify SSE subscribers for each key.
    pub async fn set_many(&self, entries: &[(&str, String)]) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut stored = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            let stored_value = if is_secret_preference_key(key) {
                self.cipher
                    .seal(value)
                    .with_context(|| format!("encrypting preference {key}"))?
            } else {
                value.clone()
            };
            stored.push((*key, stored_value));
        }
        {
            let conn = self.conn.lock().await;
            let transaction = conn
                .unchecked_transaction()
                .context("starting preference transaction")?;
            for (key, stored_value) in &stored {
                transaction
                    .execute(
                        "INSERT INTO preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
                        params![key, stored_value, now],
                    )
                    .context("writing preference")?;
            }
            transaction
                .commit()
                .context("committing preference transaction")?;
        }
        for (key, value) in entries {
            let _ = self.tx.send(PreferenceEvent {
                key: (*key).to_owned(),
                value: if is_secret_preference_key(key) {
                    String::new()
                } else {
                    value.clone()
                },
            });
        }
        Ok(())
    }

    /// Delete a preference and notify live subscribers when a row existed.
    ///
    /// The empty event value is the existing SSE representation for a cleared
    /// key; callers that need to distinguish clear from setting an empty value
    /// should reread the key, which also keeps secret values out of the event.
    pub async fn delete(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM preferences WHERE key = ?1", params![key])?;
        // Published under the store lock, like `set`, to keep commit order.
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

    /// Live change-stream receivers, so route tests can prove that a closed SSE
    /// client releases its subscription instead of leaking it.
    #[cfg(test)]
    pub(crate) fn live_subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    // ── Engine launch and sampling defaults (advanced inference) ──────────────
    //
    // Engine-launch flags (context size, GPU layers, MoE offload, chat template,
    // speculative draft model, quantization, ...) are properties of the *loaded
    // model*, not the agent: one resident engine serves every agent, so these are
    // keyed per engine and optionally overridden per model. Stored as
    // `LaunchConfig` JSON under `model.launch.engine.{engine}` and
    // `model.launch.{model_id}`. Changing launch fields requires a process restart.

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

    /// Read engine-wide launch defaults, returning an empty config when unset or
    /// malformed so a stale preference never prevents a runtime from starting.
    pub async fn get_engine_launch_config(&self, engine: &str) -> crate::inference::LaunchConfig {
        match self.get(&launch_engine_key(engine)).await {
            Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
            _ => crate::inference::LaunchConfig::default(),
        }
    }

    /// Persist engine-wide launch defaults as JSON in the preferences store.
    pub async fn set_engine_launch_config(
        &self,
        engine: &str,
        cfg: &crate::inference::LaunchConfig,
    ) -> Result<()> {
        let json = serde_json::to_string(cfg).context("serializing engine launch config")?;
        self.set(&launch_engine_key(engine), &json).await
    }

    /// Read engine-wide per-request sampling defaults. These are the base for
    /// every chat routed to this engine; agent and request values may override
    /// individual fields.
    pub async fn get_engine_sampling_config(
        &self,
        engine: &str,
    ) -> crate::inference::SamplingConfig {
        match self.get(&engine_sampling_key(engine)).await {
            Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
            _ => crate::inference::SamplingConfig::default(),
        }
    }

    /// Persist engine-wide per-request sampling defaults.
    pub async fn set_engine_sampling_config(
        &self,
        engine: &str,
        cfg: &crate::inference::SamplingConfig,
    ) -> Result<()> {
        let json = serde_json::to_string(cfg).context("serializing engine sampling config")?;
        self.set(&engine_sampling_key(engine), &json).await
    }

    /// Resolve launch values for `engine` + `model_id`. Engine values provide the
    /// defaults and model values override matching fields. Extra args are
    /// appended engine-first, model-second so model args can override an earlier
    /// flag when the upstream runtime uses last-value-wins parsing.
    pub async fn resolve_launch_config(
        &self,
        model_id: &str,
        engine: &str,
    ) -> crate::inference::LaunchConfig {
        let engine_defaults = self.get_engine_launch_config(engine).await;
        let model_values = self.get_launch_config(model_id).await;
        merge_launch_config(engine_defaults, model_values)
    }

    // ── Per-model sampling and node presets ───────────────────────────────────
    //
    // Per-model sampling applies to local AND cloud models: it rides in the
    // request body, so unlike launch flags it needs no engine. Presets are named
    // sampling (+ optional launch) bundles saved once per node and copied into a
    // model's settings when applied.

    /// Read a model's per-request sampling overrides. Empty when unset or
    /// malformed, so a stale value never blocks a chat.
    pub async fn get_model_sampling_config(
        &self,
        model_id: &str,
    ) -> crate::inference::SamplingConfig {
        match self.get(&model_sampling_key(model_id)).await {
            Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
            _ => crate::inference::SamplingConfig::default(),
        }
    }

    /// Persist a model's sampling overrides. An empty config clears the key so
    /// the model falls back to engine and agent defaults.
    pub async fn set_model_sampling_config(
        &self,
        model_id: &str,
        cfg: &crate::inference::SamplingConfig,
    ) -> Result<()> {
        let key = model_sampling_key(model_id);
        if cfg.is_empty() {
            return self.delete(&key).await;
        }
        let json = serde_json::to_string(cfg).context("serializing model sampling config")?;
        self.set(&key, &json).await
    }

    /// Node presets: built-ins first, then saved presets in creation order.
    pub async fn list_inference_presets(&self) -> Vec<crate::inference::InferencePreset> {
        let mut presets = crate::inference::builtin_presets();
        presets.extend(self.saved_inference_presets().await);
        presets
    }

    async fn saved_inference_presets(&self) -> Vec<crate::inference::InferencePreset> {
        match self.get(INFERENCE_PRESETS_KEY).await {
            Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// Create or replace a saved preset by id. Built-in ids are rejected, the
    /// `builtin` flag is never trusted from input, and `created_at` survives an
    /// update.
    pub async fn upsert_inference_preset(
        &self,
        mut preset: crate::inference::InferencePreset,
        now: i64,
    ) -> Result<crate::inference::InferencePreset> {
        anyhow::ensure!(
            !preset
                .id
                .starts_with(crate::inference::BUILTIN_PRESET_PREFIX),
            "built-in presets are read-only"
        );
        preset.name = preset.name.trim().to_owned();
        anyhow::ensure!(!preset.name.is_empty(), "preset name is required");
        preset.builtin = false;
        preset.updated_at = now;

        let _guard = PRESET_WRITE_LOCK.lock().await;
        let mut saved = self.saved_inference_presets().await;
        match saved.iter_mut().find(|existing| existing.id == preset.id) {
            Some(existing) => {
                preset.created_at = existing.created_at;
                *existing = preset.clone();
            }
            None => {
                preset.created_at = now;
                saved.push(preset.clone());
            }
        }
        let json = serde_json::to_string(&saved).context("serializing inference presets")?;
        self.set(INFERENCE_PRESETS_KEY, &json).await?;
        Ok(preset)
    }

    /// Delete a saved preset. Returns whether one was removed.
    pub async fn delete_inference_preset(&self, id: &str) -> Result<bool> {
        anyhow::ensure!(
            !id.starts_with(crate::inference::BUILTIN_PRESET_PREFIX),
            "built-in presets are read-only"
        );
        let _guard = PRESET_WRITE_LOCK.lock().await;
        let mut saved = self.saved_inference_presets().await;
        let before = saved.len();
        saved.retain(|preset| preset.id != id);
        if saved.len() == before {
            return Ok(false);
        }
        let json = serde_json::to_string(&saved).context("serializing inference presets")?;
        self.set(INFERENCE_PRESETS_KEY, &json).await?;
        Ok(true)
    }
}

/// Serialises preset read-modify-write cycles across store clones.
static PRESET_WRITE_LOCK: Mutex<()> = Mutex::const_new(());

/// Preferences key holding the shortcut-override document (a JSON object).
pub const KEYBINDINGS_KEY: &str = "keybindings";

/// Serialises every edit of the keybindings document, so two windows changing
/// different plugins' shortcuts (or a plugin uninstall clearing its own) cannot
/// overwrite each other's change with a stale copy of the whole document.
static KEYBINDINGS_EDIT_LOCK: Mutex<()> = Mutex::const_new(());

/// Hold while changing the keybindings document any other way (the generic
/// preference route, a plugin uninstall), so that write cannot land between an
/// entry edit's read and its write.
pub async fn lock_keybinding_edits() -> tokio::sync::MutexGuard<'static, ()> {
    KEYBINDINGS_EDIT_LOCK.lock().await
}

/// One change to an entry of the keybindings document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeybindingEdit<'a> {
    /// Store a JSON `null`: the shortcut is disabled.
    Disable,
    /// Drop the entry, so the default applies.
    Remove,
    /// Store this shortcut.
    Set(&'a str),
}

impl PreferencesStore {
    /// Apply one [`KeybindingEdit`] to one entry of the keybindings document
    /// under [`KEYBINDINGS_EDIT_LOCK`] and return the stored document. A stored document that is not a JSON object is
    /// refused rather than replaced, so a malformed value is never silently lost.
    pub async fn edit_keybinding_entry(
        &self,
        entry: &str,
        edit: KeybindingEdit<'_>,
    ) -> Result<String> {
        let _guard = lock_keybinding_edits().await;
        let mut document = match self.get(KEYBINDINGS_KEY).await? {
            None => serde_json::Map::new(),
            Some(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(serde_json::Value::Object(map)) => map,
                _ => anyhow::bail!("the stored keybindings document is not a JSON object"),
            },
        };
        match edit {
            KeybindingEdit::Set(shortcut) => {
                document.insert(
                    entry.to_owned(),
                    serde_json::Value::String(shortcut.to_owned()),
                );
            }
            KeybindingEdit::Disable => {
                document.insert(entry.to_owned(), serde_json::Value::Null);
            }
            KeybindingEdit::Remove => {
                document.remove(entry);
            }
        }
        let next = serde_json::to_string(&document).context("serializing keybindings")?;
        self.set(KEYBINDINGS_KEY, &next).await?;
        Ok(next)
    }
}

/// Preferences key holding the node's saved presets as a JSON array.
pub const INFERENCE_PRESETS_KEY: &str = "inference.presets";

/// Preferences key for a model's per-request sampling overrides.
pub fn model_sampling_key(model_id: &str) -> String {
    format!("model.sampling.{model_id}")
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

/// Preferences key for an engine's per-request sampling defaults.
pub fn engine_sampling_key(engine: &str) -> String {
    format!("inference.engine.{engine}")
}

fn merge_launch_config(
    defaults: crate::inference::LaunchConfig,
    overrides: crate::inference::LaunchConfig,
) -> crate::inference::LaunchConfig {
    let mut merged = serde_json::to_value(defaults).unwrap_or_else(|_| serde_json::json!({}));
    let overrides = serde_json::to_value(overrides).unwrap_or_else(|_| serde_json::json!({}));
    let (Some(merged_object), Some(overrides_object)) =
        (merged.as_object_mut(), overrides.as_object())
    else {
        return crate::inference::LaunchConfig::default();
    };

    for (key, value) in overrides_object {
        if key == "extra_args" {
            let combined = merged_object
                .get(key)
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .chain(value.as_array().into_iter().flatten().cloned())
                .collect();
            merged_object.insert(key.clone(), serde_json::Value::Array(combined));
        } else if key == "native" {
            // Native options merge per option: a model value overrides only the
            // engine default for that same option.
            let mut combined = merged_object
                .get(key)
                .and_then(serde_json::Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (option, option_value) in value.as_object().into_iter().flatten() {
                if option_value.is_null() {
                    combined.remove(option);
                } else {
                    combined.insert(option.clone(), option_value.clone());
                }
            }
            merged_object.insert(key.clone(), serde_json::Value::Object(combined));
        } else {
            merged_object.insert(key.clone(), value.clone());
        }
    }

    serde_json::from_value(merged).unwrap_or_default()
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

    #[tokio::test]
    async fn keybinding_entry_edits_keep_unrelated_entries() {
        let store = in_memory_store();
        store
            .set(KEYBINDINGS_KEY, r#"{"toggle-sidebar":"mod+b"}"#)
            .await
            .expect("seed");
        store
            .edit_keybinding_entry("plugin:@ryu/a", KeybindingEdit::Set("mod+1"))
            .await
            .expect("set a");
        store
            .edit_keybinding_entry("plugin:@ryu/b", KeybindingEdit::Disable)
            .await
            .expect("disable b");
        let doc = store
            .edit_keybinding_entry("plugin:@ryu/a", KeybindingEdit::Remove)
            .await
            .expect("remove a");
        let parsed: serde_json::Value = serde_json::from_str(&doc).expect("json");
        assert_eq!(
            parsed,
            serde_json::json!({"toggle-sidebar": "mod+b", "plugin:@ryu/b": null})
        );
        assert_eq!(
            store.get(KEYBINDINGS_KEY).await.expect("get").as_deref(),
            Some(doc.as_str())
        );
    }

    #[tokio::test]
    async fn concurrent_keybinding_entry_edits_do_not_lose_updates() {
        let store = in_memory_store();
        let mut tasks = Vec::new();
        for index in 0..16 {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .edit_keybinding_entry(
                        &format!("plugin:p{index}"),
                        KeybindingEdit::Set("mod+k"),
                    )
                    .await
                    .expect("edit");
            }));
        }
        for task in tasks {
            task.await.expect("join");
        }
        let doc: serde_json::Value = serde_json::from_str(
            &store
                .get(KEYBINDINGS_KEY)
                .await
                .expect("get")
                .expect("stored"),
        )
        .expect("json");
        assert_eq!(doc.as_object().map(|map| map.len()), Some(16));
    }

    #[tokio::test]
    async fn keybinding_entry_edit_refuses_a_malformed_document() {
        let store = in_memory_store();
        store.set(KEYBINDINGS_KEY, "[1,2]").await.expect("seed");
        assert!(store
            .edit_keybinding_entry("plugin:@ryu/a", KeybindingEdit::Set("mod+1"))
            .await
            .is_err());
        assert_eq!(
            store.get(KEYBINDINGS_KEY).await.expect("get").as_deref(),
            Some("[1,2]")
        );
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

    async fn durable_record(store: &PreferencesStore, key: &str) -> (String, i64) {
        store
            .conn
            .lock()
            .await
            .query_row(
                "SELECT value, updated_at FROM preferences WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    /// A credential written before its key was listed (or by an older build) is
    /// sealed once on open, readable afterwards, and gone from the file bytes.
    #[tokio::test]
    async fn legacy_plaintext_credentials_are_resealed_on_open_and_purged_from_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let secret = "prm-legacy-bearer-3f9a1c";
        {
            let conn = Connection::open(&path).unwrap();
            PreferencesStore::init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO preferences (key, value, updated_at) VALUES ('learning.prm-key', ?1, 1), ('theme', 'dark', 1)",
                params![secret],
            )
            .unwrap();
        }
        let cipher = FieldCipher::new(&[0x52; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        let (stored, _) = durable_record(&store, "learning.prm-key").await;
        assert!(FieldCipher::is_sealed(&stored), "{stored}");
        assert_eq!(durable_record(&store, "theme").await.0, "dark");
        assert_eq!(
            store.get("learning.prm-key").await.unwrap().as_deref(),
            Some(secret)
        );
        drop(store);
        let mut bytes = std::fs::read(&path).unwrap();
        for suffix in ["-wal", "-shm"] {
            let side = directory.path().join(format!("preferences.db{suffix}"));
            bytes.extend(std::fs::read(side).unwrap_or_default());
        }
        assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        // Idempotent: a second open leaves the sealed row untouched.
        let reopened = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(
            durable_record(&reopened, "learning.prm-key").await.0,
            stored
        );
    }

    #[derive(Clone, Copy)]
    enum ConcurrentWrite {
        Set(&'static str, &'static str),
        Delete(&'static str),
    }

    impl ConcurrentWrite {
        /// Run the write on its own OS thread and runtime, as an independent
        /// caller of the shared store handle would.
        fn spawn(self, store: PreferencesStore) -> std::thread::JoinHandle<Result<()>> {
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async move {
                        match self {
                            Self::Set(key, value) => store.set(key, value).await,
                            Self::Delete(key) => store.delete(key).await,
                        }
                    })
            })
        }
    }

    /// Waker of a store-lock waiter queued directly behind a writer. Tokio wakes
    /// the next waiter on the thread that drops the guard, so blocking here holds
    /// that writer immediately after it released the store lock.
    struct HoldReleasingWriter {
        released: std::sync::mpsc::SyncSender<()>,
        resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        held: std::sync::atomic::AtomicBool,
    }

    impl std::task::Wake for HoldReleasingWriter {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            if self.held.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            self.released.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("the test must resume the writer that released the store lock");
        }
    }

    /// Let `first` commit and release the store lock, then run `second` to
    /// completion before `first` continues. Returns the delivered events.
    fn interleave_after_first_release(
        store: &PreferencesStore,
        path: &std::path::Path,
        first: ConcurrentWrite,
        second: ConcurrentWrite,
    ) -> Vec<(String, String)> {
        let mut events = store.subscribe();
        // An independent connection owns SQLite's write lock, so `first` holds
        // the store mutex while its statement waits for the database.
        let blocker = Connection::open(path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let first_writer = first.spawn(store.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while let Ok(guard) = store.conn.try_lock() {
            drop(guard);
            assert!(
                std::time::Instant::now() < deadline,
                "first writer never acquired the store lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        let (released_tx, released_rx) = std::sync::mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let waker = std::task::Waker::from(Arc::new(HoldReleasingWriter {
            released: released_tx,
            resume: std::sync::Mutex::new(resume_rx),
            held: std::sync::atomic::AtomicBool::new(false),
        }));
        let mut queued = Box::pin(store.conn.lock());
        assert!(std::future::Future::poll(
            queued.as_mut(),
            &mut std::task::Context::from_waker(&waker)
        )
        .is_pending());
        let second_writer = second.spawn(store.clone());
        blocker.execute_batch("ROLLBACK;").unwrap();
        released_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("first writer must commit and release the store lock");
        let std::task::Poll::Ready(guard) = std::future::Future::poll(
            queued.as_mut(),
            &mut std::task::Context::from_waker(std::task::Waker::noop()),
        ) else {
            panic!("the released store lock must pass to the queued waiter");
        };
        drop(guard);
        second_writer
            .join()
            .unwrap()
            .expect("second write must commit");
        resume_tx.send(()).unwrap();
        first_writer
            .join()
            .unwrap()
            .expect("first write must commit");
        std::iter::from_fn(|| events.try_recv().ok())
            .map(|event| (event.key, event.value))
            .collect()
    }

    fn pairs(events: &[(&str, &str)]) -> Vec<(String, String)> {
        events
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn concurrent_upserts_publish_in_commit_order_so_subscribers_end_on_durable_value() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let cipher = FieldCipher::new(&[0x41; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(store.set("timezone", "Asia/Singapore"))
            .unwrap();
        let conserved_timezone = runtime.block_on(durable_record(&store, "timezone"));

        let delivered = interleave_after_first_release(
            &store,
            &path,
            ConcurrentWrite::Set("theme", "dark"),
            ConcurrentWrite::Set("theme", "light"),
        );

        assert_eq!(
            runtime.block_on(store.get("theme")).unwrap().as_deref(),
            Some("light")
        );
        assert_eq!(
            delivered,
            pairs(&[("theme", "dark"), ("theme", "light")]),
            "the last delivered event must be the committed value"
        );
        drop(store);
        let reopened = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(
            runtime.block_on(reopened.get("theme")).unwrap().as_deref(),
            Some("light")
        );
        assert_eq!(
            runtime.block_on(durable_record(&reopened, "timezone")),
            conserved_timezone
        );
    }

    #[test]
    fn concurrent_clear_and_upsert_publish_in_commit_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let cipher = FieldCipher::new(&[0x41; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(store.set("theme", "dark")).unwrap();
        runtime
            .block_on(store.set("timezone", "Asia/Singapore"))
            .unwrap();
        let conserved_timezone = runtime.block_on(durable_record(&store, "timezone"));

        let delivered = interleave_after_first_release(
            &store,
            &path,
            ConcurrentWrite::Delete("theme"),
            ConcurrentWrite::Set("theme", "contrast"),
        );

        assert_eq!(
            runtime.block_on(store.get("theme")).unwrap().as_deref(),
            Some("contrast")
        );
        assert_eq!(
            delivered,
            pairs(&[("theme", ""), ("theme", "contrast")]),
            "a clear that committed first must not be delivered after the newer value"
        );
        drop(store);
        let reopened = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(
            runtime.block_on(reopened.get("theme")).unwrap().as_deref(),
            Some("contrast")
        );
        assert_eq!(
            runtime.block_on(durable_record(&reopened, "timezone")),
            conserved_timezone
        );
    }

    #[tokio::test]
    async fn cancelled_writes_waiting_for_the_store_neither_commit_nor_publish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let cipher = FieldCipher::new(&[0x41; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        store.set("theme", "dark").await.unwrap();
        store.set("timezone", "Asia/Singapore").await.unwrap();
        let conserved_theme = durable_record(&store, "theme").await;
        let conserved_timezone = durable_record(&store, "timezone").await;
        let mut events = store.subscribe();

        // Another request owns the store while these two handlers are dropped,
        // as axum does when their clients disconnect.
        let in_flight = store.conn.lock().await;
        let mut cancelled_set = Box::pin(store.set("theme", "light"));
        let mut cancelled_delete = Box::pin(store.delete("timezone"));
        assert!(futures_util::poll!(cancelled_set.as_mut()).is_pending());
        assert!(futures_util::poll!(cancelled_delete.as_mut()).is_pending());
        drop(cancelled_set);
        drop(cancelled_delete);
        drop(in_flight);

        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(durable_record(&store, "theme").await, conserved_theme);
        assert_eq!(durable_record(&store, "timezone").await, conserved_timezone);

        // Abandoned waiters must not strand the lock for the next writer.
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            store.set("theme", "contrast"),
        )
        .await
        .expect("a later write must not wait on cancelled callers")
        .unwrap();
        let event = events.try_recv().unwrap();
        assert_eq!(
            (event.key.as_str(), event.value.as_str()),
            ("theme", "contrast")
        );
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        drop(store);
        let reopened = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(
            reopened.get("theme").await.unwrap().as_deref(),
            Some("contrast")
        );
        assert_eq!(
            durable_record(&reopened, "timezone").await,
            conserved_timezone
        );
    }

    #[tokio::test]
    async fn failed_sqlite_write_does_not_publish_and_retry_survives_independent_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let cipher = FieldCipher::new(&[0x41; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        store.set("theme", "dark").await.unwrap();
        store.set("hf-token", "preserved-credential").await.unwrap();
        let conserved_credential = durable_record(&store, "hf-token").await;
        let mut events = store.subscribe();
        store
            .conn
            .lock()
            .await
            .execute_batch(
                "CREATE TRIGGER refuse_theme BEFORE INSERT ON preferences
             WHEN NEW.key = 'theme' BEGIN SELECT RAISE(ABORT, 'write refusal'); END;",
            )
            .unwrap();
        assert!(store
            .set("theme", "light")
            .await
            .unwrap_err()
            .to_string()
            .contains("writing preference"));
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let reopened = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        assert_eq!(
            reopened.get("theme").await.unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            reopened.get("hf-token").await.unwrap().as_deref(),
            Some("preserved-credential")
        );
        assert_eq!(
            durable_record(&reopened, "hf-token").await,
            conserved_credential
        );
        store
            .conn
            .lock()
            .await
            .execute_batch("DROP TRIGGER refuse_theme;")
            .unwrap();
        store.set("theme", "light").await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .expect("successful retry must publish a preference event")
            .unwrap();
        assert_eq!(
            (event.key.as_str(), event.value.as_str()),
            ("theme", "light")
        );
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        drop(reopened);
        drop(store);
        let independent = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(
            independent.get("theme").await.unwrap().as_deref(),
            Some("light")
        );
        assert_eq!(
            independent.get("hf-token").await.unwrap().as_deref(),
            Some("preserved-credential")
        );
        assert_eq!(
            durable_record(&independent, "hf-token").await,
            conserved_credential
        );
    }

    #[tokio::test]
    async fn failed_delete_preserves_records_and_retry_notifies_once_then_stays_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let cipher = FieldCipher::new(&[0x41; 32]);
        let store = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        store.set("timezone", "Asia/Singapore").await.unwrap();
        store.set("theme", "dark").await.unwrap();
        let conserved_theme = durable_record(&store, "theme").await;
        let mut events = store.subscribe();
        store
            .conn
            .lock()
            .await
            .execute_batch(
                "CREATE TRIGGER refuse_timezone_delete BEFORE DELETE ON preferences
             WHEN OLD.key = 'timezone' BEGIN SELECT RAISE(ABORT, 'delete refusal'); END;",
            )
            .unwrap();
        assert!(store.delete("timezone").await.is_err());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let reopened = PreferencesStore::open_with_cipher(path.clone(), cipher.clone()).unwrap();
        assert_eq!(
            reopened.get("timezone").await.unwrap().as_deref(),
            Some("Asia/Singapore")
        );
        assert_eq!(
            reopened.get("theme").await.unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(durable_record(&reopened, "theme").await, conserved_theme);
        store
            .conn
            .lock()
            .await
            .execute_batch("DROP TRIGGER refuse_timezone_delete;")
            .unwrap();
        store.delete("timezone").await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .expect("successful delete must publish a preference event")
            .unwrap();
        assert_eq!(event.key, "timezone");
        assert!(event.value.is_empty());
        store.delete("timezone").await.unwrap();
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        drop(reopened);
        drop(store);
        let independent = PreferencesStore::open_with_cipher(path, cipher).unwrap();
        assert_eq!(independent.get("timezone").await.unwrap(), None);
        assert_eq!(
            independent.get("theme").await.unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(durable_record(&independent, "theme").await, conserved_theme);
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
    async fn model_sampling_round_trips_and_empty_clears() {
        let store = in_memory_store();
        let cfg = crate::inference::SamplingConfig {
            temperature: Some(0.4),
            top_k: Some(30),
            ..Default::default()
        };
        store
            .set_model_sampling_config("anthropic/claude-x", &cfg)
            .await
            .unwrap();
        assert_eq!(
            store.get_model_sampling_config("anthropic/claude-x").await,
            cfg
        );

        store
            .set_model_sampling_config("anthropic/claude-x", &Default::default())
            .await
            .unwrap();
        assert!(store
            .get(&model_sampling_key("anthropic/claude-x"))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn presets_upsert_preserve_creation_and_protect_builtins() {
        let store = in_memory_store();
        let builtin_count = crate::inference::builtin_presets().len();
        assert_eq!(store.list_inference_presets().await.len(), builtin_count);

        let preset = crate::inference::InferencePreset {
            id: "mine".to_owned(),
            name: "  Coding  ".to_owned(),
            builtin: true,
            sampling: crate::inference::SamplingConfig {
                temperature: Some(0.1),
                ..Default::default()
            },
            ..Default::default()
        };
        let saved = store
            .upsert_inference_preset(preset.clone(), 100)
            .await
            .unwrap();
        assert_eq!(saved.name, "Coding");
        assert!(!saved.builtin);
        assert_eq!((saved.created_at, saved.updated_at), (100, 100));

        let renamed = crate::inference::InferencePreset {
            name: "Code".to_owned(),
            ..preset
        };
        let updated = store.upsert_inference_preset(renamed, 200).await.unwrap();
        assert_eq!((updated.created_at, updated.updated_at), (100, 200));

        let listed = store.list_inference_presets().await;
        assert_eq!(listed.len(), builtin_count + 1);
        assert_eq!(listed.last().unwrap().name, "Code");

        let builtin = crate::inference::builtin_presets().remove(0);
        assert!(store
            .upsert_inference_preset(builtin.clone(), 300)
            .await
            .is_err());
        assert!(store.delete_inference_preset(&builtin.id).await.is_err());
        let unnamed = crate::inference::InferencePreset {
            id: "blank".to_owned(),
            name: " ".to_owned(),
            ..Default::default()
        };
        assert!(store.upsert_inference_preset(unnamed, 300).await.is_err());

        assert!(store.delete_inference_preset("mine").await.unwrap());
        assert!(!store.delete_inference_preset("mine").await.unwrap());
        assert_eq!(store.list_inference_presets().await.len(), builtin_count);
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
        assert!(is_secret_preference_key("unsplash-access-key"));
        assert!(is_secret_preference_key("node-onboarding-state"));
        assert!(is_secret_preference_key(
            crate::acp_agent_settings::ACP_AGENT_SETTINGS_PREF_KEY
        ));
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
    async fn resolve_merges_engine_defaults_with_model_overrides() {
        let store = temp_store();
        let engine_defaults = crate::inference::LaunchConfig {
            ctx_size: Some(4096),
            gpu_layers: Some(40),
            extra_args: vec!["--mlock".to_owned()],
            ..Default::default()
        };
        store
            .set_engine_launch_config("llamacpp", &engine_defaults)
            .await
            .expect("set engine defaults");
        let resolved = store.resolve_launch_config("some/model", "llamacpp").await;
        assert_eq!(resolved.ctx_size, Some(4096));
        assert_eq!(resolved.gpu_layers, Some(40));
        assert_eq!(resolved.extra_args, vec!["--mlock"]);

        let per_model = crate::inference::LaunchConfig {
            ctx_size: Some(2048),
            threads: Some(8),
            extra_args: vec!["--threads".to_owned(), "8".to_owned()],
            ..Default::default()
        };
        store
            .set_launch_config("some/model", &per_model)
            .await
            .expect("set per-model");
        let resolved = store.resolve_launch_config("some/model", "llamacpp").await;
        assert_eq!(resolved.ctx_size, Some(2048));
        assert_eq!(resolved.gpu_layers, Some(40));
        assert_eq!(resolved.threads, Some(8));
        assert_eq!(resolved.extra_args, vec!["--mlock", "--threads", "8"]);
    }
    #[tokio::test]
    async fn native_launch_options_merge_per_option() {
        let store = in_memory_store();
        let options = |value: serde_json::Value| value.as_object().cloned().unwrap();
        store
            .set_engine_launch_config(
                "llamacpp",
                &crate::inference::LaunchConfig {
                    native: options(serde_json::json!({ "split_mode": "row", "no_warmup": true })),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .set_launch_config(
                "some/model",
                &crate::inference::LaunchConfig {
                    native: options(serde_json::json!({ "split_mode": "layer", "keep": 64 })),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let resolved = store.resolve_launch_config("some/model", "llamacpp").await;
        assert_eq!(
            resolved.native,
            options(serde_json::json!({ "split_mode": "layer", "no_warmup": true, "keep": 64 }))
        );
    }

    #[tokio::test]
    async fn engine_sampling_defaults_roundtrip_and_default_when_missing() {
        let store = in_memory_store();
        let config = crate::inference::SamplingConfig {
            temperature: Some(0.4),
            top_k: Some(40),
            extra: serde_json::from_value(serde_json::json!({ "min_keep": 2 })).unwrap(),
            ..Default::default()
        };

        store
            .set_engine_sampling_config("llamacpp", &config)
            .await
            .expect("set engine sampling defaults");

        assert_eq!(store.get_engine_sampling_config("llamacpp").await, config);
        assert!(store.get_engine_sampling_config("ollama").await.is_empty());
        assert_eq!(engine_sampling_key("llamacpp"), "inference.engine.llamacpp");
    }
}
