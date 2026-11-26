//! `host.storage.*` and `host.crypto_*`.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    pub(super) async fn storage(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_STORAGE) {
            return err(format!(
                "capability '{GRANT_STORAGE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        #[cfg(test)]
        let selected_store: Option<&crate::plugin_storage::PluginStorage> =
            match self.test_storage.as_ref() {
                Some(store) => Some(store),
                None => crate::plugin_storage::global(),
            };
        #[cfg(not(test))]
        let selected_store = crate::plugin_storage::global();
        let Some(store) = selected_store else {
            return err("plugin storage is unavailable".to_string());
        };
        let namespace = args
            .get("namespace")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("default");
        let namespace = self.storage_namespace(namespace);
        let key = args.get("key").and_then(Value::as_str).unwrap_or_default();

        match method {
            "storage_get" => match store.get(&self.plugin_id, &namespace, key).await {
                Ok(Some(v)) => ok(json!(v)),
                Ok(None) => ok(Value::Null),
                Err(e) => err(e.to_string()),
            },
            "storage_set" => {
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if key.is_empty() {
                    return err("host.storage.set requires a non-empty key".to_string());
                }
                match store.set(&self.plugin_id, &namespace, key, value).await {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "storage_delete" => match store.delete(&self.plugin_id, &namespace, key).await {
                Ok(()) => ok(json!(true)),
                Err(e) => err(e.to_string()),
            },
            "storage_keys" => match store.keys(&self.plugin_id, &namespace).await {
                Ok(keys) => ok(json!(keys)),
                Err(e) => err(e.to_string()),
            },
            "storage_compare_and_set" => {
                let expected = args.get("expected").and_then(Value::as_str);
                let value = args.get("value").and_then(Value::as_str);
                match store
                    .compare_and_set(&self.plugin_id, &namespace, key, expected, value)
                    .await
                {
                    Ok(changed) => ok(json!(changed)),
                    Err(e) => err(e.to_string()),
                }
            }
            _ => err(format!("unknown storage method '{method}'")),
        }
    }

    pub(super) fn storage_namespace(&self, namespace: &str) -> String {
        let tenant = self.storage_tenant.as_deref().or_else(|| {
            self.verified_caller
                .as_ref()
                .map(|caller| caller.user_id.as_str())
        });
        crate::plugin_host::storage_namespace_for_tenant(tenant, namespace)
    }

    /// `host.crypto_*` — the **sealing primitive**. A plugin encrypts and decrypts
    /// its own data without ever holding, seeing, or naming a key.
    ///
    /// The key is a per-plugin subkey derived from Core's at-rest master key
    /// (`ryu_crypto::plugin_cipher`, HKDF-SHA256 with the plugin id as `info`).
    /// Two properties follow, and both are structural rather than checked:
    ///
    /// * **The key never crosses the sandbox boundary.** Only ciphertext does.
    ///   There is deliberately no `host.crypto_getKey` — a plugin that could read
    ///   the subkey could exfiltrate it, and the whole point is that it cannot.
    /// * **One app cannot open another's ciphertext.** Different id, different
    ///   subkey, so a cross-app open is an AEAD tag failure. `plugin_id` here is
    ///   the bridge's path-bound owner id (the same property `spaces` relies on),
    ///   so a frame cannot spoof its way into another app's data.
    ///
    /// The id is canonicalized before derivation: ids were rescoped to
    /// `@scope/name` with legacy aliases still accepted at the outside edge, and
    /// deriving from a legacy id here would silently produce a *different* subkey,
    /// making everything the app had already sealed unopenable.
    ///
    /// **Guarantee, stated honestly:** this is at-rest sealing. Custody is
    /// env → OS keychain → file fallback, which defends against a stolen disk or a
    /// copied `~/.ryu`, NOT against a compromised running Core (which must hold the
    /// key to function). `crypto_status` exists so an app can surface which custody
    /// is actually live before it stores anything. Note also that there is no rekey
    /// path anywhere in the crate: rotating the master key orphans sealed data.
    pub(super) async fn crypto(&self, method: &str, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CRYPTO) {
            return err(format!(
                "capability '{GRANT_CRYPTO}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        // Canonicalize at the ONE derivation site. See the doc comment above: a
        // legacy id here yields a different subkey and orphans existing ciphertext.
        let canonical = crate::plugin_manifest::canonical_plugin_id(&self.plugin_id);
        let cipher = match ryu_crypto::plugin_cipher(canonical) {
            Ok(c) => c,
            Err(e) => return err(format!("crypto is unavailable: {e}")),
        };

        match method {
            "crypto_seal" => {
                let Some(plaintext) = args.get("value").and_then(Value::as_str) else {
                    return err("host.crypto.seal requires a string { value }".to_string());
                };
                match cipher.seal(plaintext) {
                    Ok(sealed) => ok(json!(sealed)),
                    Err(e) => err(e.to_string()),
                }
            }
            "crypto_open" => {
                let Some(stored) = args.get("value").and_then(Value::as_str) else {
                    return err("host.crypto.open requires a string { value }".to_string());
                };
                match cipher.open(stored) {
                    Ok(plain) => ok(json!(plain)),
                    // The message deliberately does NOT echo the input: a failed
                    // open is usually another app's ciphertext, and reflecting it
                    // back would leak across the boundary the subkey exists to hold.
                    Err(e) => err(format!("could not open sealed value: {e}")),
                }
            }
            // Non-secret custody description, so an app can tell the user which
            // guarantee is live. `KeyCustody` is built to carry no key material —
            // not the key, not a prefix, not a hash — so it is safe to hand to a
            // sandboxed frame verbatim. `key_custody` itself gates `key_file` to
            // the `File` source (it is `None` for env/keychain), so the path is
            // disclosed only in the case where the key sits next to the data it
            // protects and the user genuinely needs to know.
            "crypto_status" => match ryu_crypto::key_custody() {
                Ok(c) => ok(json!({
                    "source": c.source.as_str(),
                    "keychain_service": c.keychain_service,
                    "keychain_account": c.keychain_account,
                    "key_file": c.key_file.map(|p| p.display().to_string()),
                    // The weaker-than-keychain case, named plainly so a UI does not
                    // have to re-derive the judgement from `source`.
                    "key_beside_data": matches!(c.source, ryu_crypto::MasterKeySource::File),
                })),
                Err(e) => err(format!("crypto status unavailable: {e}")),
            },
            _ => err(format!("unknown crypto method '{method}'")),
        }
    }
}
