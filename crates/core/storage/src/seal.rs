//! Per-value content sealing for `plugin-storage.db` (encryption at rest, phase 2).
//!
//! Every `plugin_kv.value` is sealed as `encb:v1:` under the content key of
//! `plugin-storage.db` rooted at **that plugin's** subkey (the same subkey the
//! sandbox bridge's `host.crypto.*` and an app satellite use), bound to
//! `(plugin_id, namespace, key)`. A value copied to another row, namespace or
//! plugin does not open. The store-level key check value recorded in
//! `ryu_content_seal` is the master-rooted one: every plugin subkey derives
//! from it, so one record covers every plugin's rows.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use ryu_crypto::{ContentCipher, ContentContext};

/// The registered store name (KDF input; never rename).
pub const STORE: &str = "plugin-storage.db";

/// The AAD purpose of a sealed KV value.
pub(crate) const VALUE_PURPOSE: &str = "plugin_kv.value";

/// Resolves the content cipher of one plugin's rows from its plugin id.
pub type PluginCipherResolver = Arc<dyn Fn(&str) -> Result<ContentCipher> + Send + Sync>;

/// The keys a [`crate::PluginStorage`] seals with.
#[derive(Clone)]
pub struct StorageKeys {
    /// Master-rooted cipher of the store: only its key check value is used, to
    /// detect a store sealed under a key this process does not hold.
    store: ContentCipher,
    plugin: PluginCipherResolver,
    cache: Arc<Mutex<HashMap<String, ContentCipher>>>,
}

impl StorageKeys {
    /// The keys of a process that holds the master key (Core). Fails closed
    /// without a crypto host or `RYU_MASTER_KEY`.
    pub fn from_process() -> Result<Self> {
        let store =
            ryu_crypto::content_cipher(STORE).context("resolving the plugin storage key")?;
        Ok(Self::new(
            store,
            Arc::new(|plugin_id: &str| ryu_crypto::plugin_content_cipher(plugin_id, STORE)),
        ))
    }

    /// Explicit keys (tests, tools): `store` carries the store-level key check
    /// value, `plugin` derives each plugin's cipher.
    pub fn new(store: ContentCipher, plugin: PluginCipherResolver) -> Self {
        Self {
            store,
            plugin,
            cache: Arc::default(),
        }
    }

    pub(crate) fn store_cipher(&self) -> &ContentCipher {
        &self.store
    }

    /// The (cached) cipher of one plugin's rows.
    pub(crate) fn plugin(&self, plugin_id: &str) -> Result<ContentCipher> {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cipher) = cache.get(plugin_id) {
            return Ok(cipher.clone());
        }
        let cipher = (self.plugin)(plugin_id)
            .with_context(|| format!("resolving the storage key of plugin {plugin_id}"))?;
        cache.insert(plugin_id.to_owned(), cipher.clone());
        Ok(cipher)
    }
}

/// Where one value lives (AAD).
pub(crate) fn value_context(plugin_id: &str, namespace: &str, key: &str) -> ContentContext {
    ContentContext::new(VALUE_PURPOSE)
        .with("plugin_id", plugin_id)
        .with("namespace", namespace)
        .with("key", key)
}
