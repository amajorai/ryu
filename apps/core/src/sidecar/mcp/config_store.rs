//! The on-disk MCP config file and its sealed secret values.

use super::*;

/// On-disk config shape. Matches the de-facto `mcpServers` map used by Claude
/// Desktop, Cursor, and friends, so users can paste an existing config.
///
/// The entries stay **raw** [`Value`]s here on purpose; [`McpConfigFile::servers`]
/// lowers them one at a time. See that method for why the file-level parse must
/// not be the thing that validates individual servers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct McpConfigFile {
    #[serde(
        default,
        rename = "mcpServers",
        alias = "servers",
        alias = "mcp_servers"
    )]
    pub(super) raw_servers: BTreeMap<String, Value>,
}

impl McpConfigFile {
    /// Lower the raw entries into spawnable [`McpServerConfig`]s **one at a time**,
    /// skipping (and logging) only the entries that fail to parse.
    ///
    /// Per-entry rather than one `BTreeMap<String, McpServerConfig>` deserialize
    /// because the all-or-nothing shape silently deleted the user's ENTIRE server
    /// list. The config dialect we advertise compatibility with — Claude
    /// Desktop's — also carries *remote* entries shaped
    /// `{"type":"http","url":"https://…"}`, which have no `command` at all.
    /// Pasting a config with one of those used to make serde fail the whole map,
    /// and every caller's error arm is a `warn!` + fall through: the user's
    /// stdio servers all vanished, the built-ins came back, and the only trace
    /// was a log line nobody reads.
    ///
    /// Keep it per-entry even after the remote (`url`/`transport`/`headers`)
    /// fields land. The invariant is not "we understand every entry" — it is that
    /// an entry we *cannot* understand costs the user that one entry, never the
    /// file. Collapsing this back into a single deserialize re-arms the bug for
    /// whatever the next unrecognized dialect turns out to be.
    ///
    /// `source` is only used to name the offending file in the warning.
    pub(super) fn servers(&self, source: &Path) -> BTreeMap<String, McpServerConfig> {
        let mut servers = BTreeMap::new();
        for (name, raw) in &self.raw_servers {
            match serde_json::from_value::<McpServerConfig>(raw.clone()) {
                Ok(mut cfg) => {
                    open_mcp_secret_map(&mut cfg.headers, name, source);
                    open_mcp_secret_map(&mut cfg.env, name, source);
                    servers.insert(name.clone(), cfg);
                }
                Err(e) => {
                    tracing::warn!(
                        "skipping unparseable MCP server '{name}' in {}: {e} (every other \
                         server in the file still loaded)",
                        source.display()
                    );
                }
            }
        }
        servers
    }
}

/// The single writer for the user's MCP config.
///
/// All Core mutation paths go through this store so read-modify-write operations
/// cannot race and lose a server. The operation receives the raw JSON document,
/// rather than a typed projection, which preserves `$schema`, alternate dialect
/// keys, metadata, and unknown fields while Ryu changes only the server entry it
/// owns.
pub struct McpConfigStore;

static MCP_CONFIG_WRITE_LOCK: OnceLock<TokioMutex<()>> = OnceLock::new();
static MCP_CONFIG_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl McpConfigStore {
    fn lock() -> &'static TokioMutex<()> {
        MCP_CONFIG_WRITE_LOCK.get_or_init(|| TokioMutex::new(()))
    }

    /// Mutate one config document and atomically replace it when the operation
    /// reports a change. The process-wide lock covers the whole read/modify/write
    /// window; the unique temp path also prevents unrelated writers from sharing
    /// `mcp.json.tmp`.
    pub async fn mutate<T, F>(path: PathBuf, operation: F) -> std::result::Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Value) -> std::result::Result<(bool, T), String> + Send + 'static,
    {
        let _guard = Self::lock().lock().await;
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("cannot create config dir: {error}"))?;
            }

            let mut document = match std::fs::read_to_string(&path) {
                Ok(raw) => serde_json::from_str::<Value>(&raw)
                    .map_err(|error| format!("mcp.json is malformed: {error}"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    serde_json::json!({})
                }
                Err(error) => return Err(format!("cannot read mcp.json: {error}")),
            };
            if !document.is_object() {
                return Err("mcp.json must contain a JSON object".to_owned());
            }

            // Operations see (and may return) plaintext header/env values; every
            // literal is sealed again before the document reaches disk.
            let mut cipher = None;
            transform_mcp_secret_values(&mut document, |value| {
                open_mcp_document_value(value, &mut cipher)
            })?;
            let (changed, result) = operation(&mut document)?;
            if changed {
                transform_mcp_secret_values(&mut document, |value| {
                    seal_mcp_document_value(value, &mut cipher)
                })?;
                let output = serde_json::to_vec_pretty(&document)
                    .map_err(|error| format!("failed to serialize mcp.json: {error}"))?;
                let sequence = MCP_CONFIG_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let tmp = path.with_file_name(format!(
                    ".{}.mcp.tmp.{}.{}",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("config"),
                    std::process::id(),
                    sequence
                ));
                write_mcp_secret_file(&tmp, &output)?;
                if let Err(error) = std::fs::rename(&tmp, &path) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("failed to replace mcp.json: {error}"));
                }
            }
            Ok(result)
        })
        .await
        .map_err(|error| format!("mcp.json write task panicked: {error}"))?
    }

    /// Return the raw server map, accepting the common config dialect aliases.
    pub fn servers_mut(
        document: &mut Value,
    ) -> std::result::Result<&mut serde_json::Map<String, Value>, String> {
        let object = document
            .as_object_mut()
            .ok_or_else(|| "mcp.json must contain a JSON object".to_owned())?;
        let key = if object.contains_key("mcpServers") {
            "mcpServers"
        } else if object.contains_key("servers") {
            "servers"
        } else if object.contains_key("mcp_servers") {
            "mcp_servers"
        } else {
            object.insert("mcpServers".to_owned(), serde_json::json!({}));
            "mcpServers"
        };
        object
            .get_mut(key)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| format!("mcp.json `{key}` must be an object"))
    }

    /// JSON keys [`McpServerConfig`] owns. A typed field that serializes as
    /// absent (`None`, or empty `headers`) means "removed", so its old value must
    /// not be carried over by [`Self::replace_server`].
    const TYPED_SERVER_KEYS: &'static [&'static str] = &[
        "command",
        "type",
        "url",
        "headers",
        "auth",
        "args",
        "env",
        "description",
        "enabled",
        "version",
        "catalog_id",
    ];

    /// Replace one typed server while retaining unknown fields inside that entry.
    pub fn replace_server(
        servers: &mut serde_json::Map<String, Value>,
        name: String,
        config: &McpServerConfig,
    ) -> std::result::Result<(), String> {
        let mut replacement = serde_json::to_value(config)
            .map_err(|error| format!("failed to serialize MCP server: {error}"))?;
        if let (Some(old), Some(new)) = (
            servers.get(&name).and_then(Value::as_object),
            replacement.as_object_mut(),
        ) {
            for (key, value) in old {
                if Self::TYPED_SERVER_KEYS.contains(&key.as_str()) {
                    continue;
                }
                new.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        servers.insert(name, replacement);
        Ok(())
    }
}

fn write_mcp_secret_file(path: &Path, data: &[u8]) -> std::result::Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true).mode(0o600);
        let mut file = options
            .open(path)
            .map_err(|error| format!("failed to write mcp.json: {error}"))?;
        std::io::Write::write_all(&mut file, data)
            .map_err(|error| format!("failed to write mcp.json: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, data).map_err(|error| format!("failed to write mcp.json: {error}"))?;
    }
    Ok(())
}

// ── Sealed header/env values in mcp.json ─────────────────────────────────────
//
// Remote-server `headers` and stdio-server `env` are where MCP credentials live
// (`Authorization: Bearer …`, `GITHUB_TOKEN`, API keys). Every literal value in
// them is stored sealed with the master key (`enc:v1:`); a value that only
// references the vault (`secret:NAME`) holds no secret and stays readable. Core
// is the only reader of this file. Legacy plaintext is accepted on read and
// sealed by the next write, or once by [`McpConfigStore::seal_literals`] at boot.

/// Whether an mcp.json header/env value is kept in plaintext: empty, or a vault
/// reference resolved at call time.
fn mcp_value_stays_plaintext(value: &str) -> bool {
    value.is_empty() || has_vault_secret_reference(value)
}

fn mcp_cipher(
    cipher: &mut Option<ryu_crypto::FieldCipher>,
) -> std::result::Result<&ryu_crypto::FieldCipher, String> {
    if cipher.is_none() {
        crate::crypto_host::install();
        let resolved = ryu_crypto::global_cipher().map_err(|error| {
            format!("refusing to write MCP credentials unsealed: no encryption key ({error:#})")
        })?;
        *cipher = Some(resolved);
    }
    cipher
        .as_ref()
        .ok_or_else(|| "no encryption key for mcp.json".to_owned())
}

/// Apply `transform` to every string value of every server's `headers` and
/// `env` object, under whichever dialect key holds the server map.
fn transform_mcp_secret_values(
    document: &mut Value,
    mut transform: impl FnMut(&str) -> std::result::Result<Option<String>, String>,
) -> std::result::Result<bool, String> {
    let mut changed = false;
    let Some(object) = document.as_object_mut() else {
        return Ok(false);
    };
    for key in ["mcpServers", "servers", "mcp_servers"] {
        let Some(servers) = object.get_mut(key).and_then(Value::as_object_mut) else {
            continue;
        };
        for entry in servers.values_mut() {
            for field in ["headers", "env"] {
                let Some(map) = entry.get_mut(field).and_then(Value::as_object_mut) else {
                    continue;
                };
                for value in map.values_mut() {
                    let Some(current) = value.as_str() else {
                        continue;
                    };
                    if let Some(next) = transform(current)? {
                        *value = Value::String(next);
                        changed = true;
                    }
                }
            }
        }
    }
    Ok(changed)
}

/// The sealed form of a literal value, or `None` when it stays as it is.
fn seal_mcp_document_value(
    value: &str,
    cipher: &mut Option<ryu_crypto::FieldCipher>,
) -> std::result::Result<Option<String>, String> {
    if mcp_value_stays_plaintext(value) || ryu_crypto::looks_sealed(value) {
        return Ok(None);
    }
    mcp_cipher(cipher)?
        .seal(value)
        .map(Some)
        .map_err(|error| format!("sealing an MCP credential: {error:#}"))
}

/// The plaintext of a sealed value for a read-modify-write. A value that does
/// not open (missing or wrong key) is left sealed so the write keeps it.
fn open_mcp_document_value(
    value: &str,
    cipher: &mut Option<ryu_crypto::FieldCipher>,
) -> std::result::Result<Option<String>, String> {
    if !ryu_crypto::looks_sealed(value) {
        return Ok(None);
    }
    let opened = mcp_cipher(cipher).and_then(|cipher| {
        ryu_crypto::SecretSealer::open(cipher, value).map_err(|error| format!("{error:#}"))
    });
    match opened {
        Ok(plaintext) => Ok(Some(plaintext)),
        Err(error) => {
            tracing::warn!("mcp.json: keeping a sealed value it cannot open: {error}");
            Ok(None)
        }
    }
}

/// Open the sealed values of one server's header/env map in place. A value that
/// cannot be opened is dropped rather than sent upstream as ciphertext.
fn open_mcp_secret_map(values: &mut BTreeMap<String, String>, server: &str, source: &Path) {
    values.retain(|key, value| {
        if !ryu_crypto::looks_sealed(value) {
            return true;
        }
        crate::crypto_host::install();
        match ryu_crypto::open_str(value) {
            Ok(plaintext) => {
                *value = plaintext;
                true
            }
            Err(error) => {
                tracing::warn!(
                    "MCP server '{server}' in {}: cannot open sealed value for '{key}' ({error:#}); \
                     omitting it",
                    source.display()
                );
                false
            }
        }
    });
}

impl McpConfigStore {
    /// Seal, once, every literal header/env value an older build (or a hand
    /// edit) left in plaintext. A no-op when nothing needs sealing, so it is
    /// cheap to run at every boot.
    pub async fn seal_literals(path: PathBuf) -> std::result::Result<bool, String> {
        let needs_sealing = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str::<Value>(&raw).is_ok_and(|mut document| {
                transform_mcp_secret_values(&mut document, |value| {
                    Ok(
                        (!mcp_value_stays_plaintext(value) && !ryu_crypto::looks_sealed(value))
                            .then(String::new),
                    )
                })
                .unwrap_or(false)
            }),
            Err(_) => false,
        };
        if !needs_sealing {
            return Ok(false);
        }
        // An unchanged operation still reports a change so `mutate` reseals.
        Self::mutate(path, |_| Ok((true, true))).await
    }
}

#[cfg(test)]
#[path = "tests/config_store.rs"]
mod tests;
