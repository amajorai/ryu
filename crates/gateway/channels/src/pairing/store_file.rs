//! The pairing store's file: loading (sealed or legacy plaintext), quarantining
//! an unreadable file, and persisting snapshots.

use super::*;

pub(super) fn pairing_context() -> ContentContext {
    ContentContext::for_id("file", PAIRING_FILE_ID)
}

/// What [`PairingStore::load`] found on disk.
pub(super) enum Loaded {
    /// No file yet.
    Missing,
    /// A body that opened; `reseal` when it was legacy plaintext or sealed
    /// under a retired key.
    Opened { file: PairingFile, reseal: bool },
    /// A sealed body and no key to open it: left untouched.
    Locked,
    /// Neither sealed under this key nor valid JSON.
    Unreadable(String),
}

pub(super) fn decode_pairing_file(bytes: &[u8], seal: &PairingSeal) -> Loaded {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Loaded::Unreadable("not UTF-8".to_owned());
    };
    let trimmed = text.trim();
    let (json, reseal) = if ContentCipher::is_sealed_text(trimmed) {
        let PairingSeal::Sealed(cipher) = seal else {
            return Loaded::Locked;
        };
        match cipher.open_text(trimmed, &pairing_context()) {
            Ok(opened) => (opened.value, opened.needs_reseal),
            Err(error) => return Loaded::Unreadable(error.to_string()),
        }
    } else {
        (text.to_owned(), true)
    };
    match serde_json::from_str::<PairingFile>(&json) {
        Ok(file) => Loaded::Opened { file, reseal },
        Err(error) => Loaded::Unreadable(format!("invalid pairing JSON: {error}")),
    }
}

/// Logical id bound into a quarantined copy's associated data.
pub(super) const QUARANTINE_FILE_ID: &str = "channel-pairing.unreadable";

/// Move an unreadable pairing file aside so a fresh store never overwrites
/// data a key recovery could still open. A sealed body is renamed as it is
/// (it is ciphertext). A plaintext body (a truncated legacy file) is never
/// kept in plaintext: with a key it is sealed into the quarantine copy
/// (0600, synced) before the original is removed; without one the renamed
/// copy is at least narrowed to 0600.
pub(super) async fn quarantine(path: &Path, cipher: Option<&ContentCipher>) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let target = path.with_file_name(format!("{name}.unreadable-{}", unix_now()));
    let bytes = tokio::fs::read(path).await.ok()?;
    let sealed =
        std::str::from_utf8(&bytes).is_ok_and(|text| ContentCipher::is_sealed_text(text.trim()));
    if !sealed {
        if let Some(cipher) = cipher {
            let context = ContentContext::for_id("file", QUARANTINE_FILE_ID);
            let body = cipher.seal_bytes(&bytes, &context).ok()?;
            let written = async {
                let mut options = tokio::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = options.open(&target).await?;
                file.write_all(&body).await?;
                file.sync_all().await
            }
            .await;
            if written.is_err() {
                let _ = tokio::fs::remove_file(&target).await;
                return None;
            }
            tokio::fs::remove_file(path).await.ok()?;
            return Some(target);
        }
    }
    tokio::fs::rename(path, &target).await.ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).await;
    }
    Some(target)
}

impl PairingStore {
    /// Load the store from `path`, or start empty when the file does not exist.
    ///
    /// A file that cannot be read (corrupt, or sealed under a key this process
    /// does not hold) is moved aside and logged, and the store starts empty
    /// rather than failing: a bad pairing file must not stop the gateway from
    /// booting, and "empty" is the safe direction (everyone re-pairs; nobody is
    /// wrongly admitted). Legacy plaintext is resealed at once. Without a key
    /// ([`PairingSeal::Unavailable`]) the store is memory-only and the file is
    /// left exactly as it is.
    pub async fn load(path: impl AsRef<Path>, seal: PairingSeal) -> Self {
        let path = path.as_ref().to_path_buf();
        let loaded = match tokio::fs::read(&path).await {
            Ok(bytes) => decode_pairing_file(&bytes, &seal),
            Err(_) => Loaded::Missing,
        };
        let (file, reseal) = match loaded {
            Loaded::Missing => (PairingFile::default(), false),
            Loaded::Opened { file, reseal } => {
                info!(entries = file.entries.len(), "loaded channel pairing store");
                (file, reseal)
            }
            Loaded::Locked => {
                warn!(
                    path = %path.display(),
                    "channel pairing store is sealed and no sealing key is available; \
                     starting empty in memory and leaving the file untouched"
                );
                (PairingFile::default(), false)
            }
            Loaded::Unreadable(reason) => {
                let cipher = match &seal {
                    PairingSeal::Sealed(cipher) => Some(cipher),
                    PairingSeal::Unavailable(_) => None,
                };
                let moved = quarantine(&path, cipher).await;
                warn!(
                    path = %path.display(),
                    moved_to = ?moved.as_ref().map(|target| target.display().to_string()),
                    %reason,
                    "channel pairing store is unreadable; moved aside and starting empty \
                     (senders must re-pair)"
                );
                (PairingFile::default(), false)
            }
        };
        let (path, cipher) = match seal {
            PairingSeal::Sealed(cipher) => (Some(path), Some(cipher)),
            PairingSeal::Unavailable(reason) => {
                warn!(
                    %reason,
                    "no sealing key for the channel pairing store; approvals and delivery \
                     claims are kept in memory only and will not survive a restart"
                );
                (None, None)
            }
        };
        let store = Self {
            inner: Arc::new(RwLock::new(file)),
            persist_lock: Arc::new(Mutex::new(())),
            path,
            cipher,
        };
        if reseal {
            if let Some(path) = &store.path {
                let _guard = store.persist_lock.lock().await;
                let snapshot = store.inner.read().await.clone();
                match store.persist_snapshot(path, &snapshot).await {
                    Ok(()) => info!("sealed the channel pairing store"),
                    Err(error) => warn!(
                        %error,
                        "could not seal the channel pairing store yet; the next write retries"
                    ),
                }
            }
        }
        store
    }

    /// An in-memory store with no file behind it. Used by tests and by a gateway
    /// with no writable data dir; pairings then last only as long as the process.
    pub fn ephemeral() -> Self {
        Self {
            inner: Arc::new(RwLock::new(PairingFile::default())),
            persist_lock: Arc::new(Mutex::new(())),
            path: None,
            cipher: None,
        }
    }

    /// Persist the current map. Best-effort for pairing/reaction-link callers:
    /// a write failure is logged, never propagated, because losing durability
    /// must not drop a live message. Delivery claims use the same atomic writer
    /// strictly, because acknowledging a webhook before its claim reaches disk
    /// would turn a restart into a lost message.
    pub(super) async fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let _persist_guard = self.persist_lock.lock().await;
        let snapshot = { self.inner.read().await.clone() };
        if let Err(err) = self.persist_snapshot(path, &snapshot).await {
            warn!(path = %path.display(), %err, "failed to persist channel pairing store");
        }
    }

    /// Atomically persist one snapshot. The temporary file is unique per
    /// process/time slice so concurrent best-effort pairing writes cannot
    /// truncate a delivery claim that is being committed at the same time.
    pub(super) async fn persist_snapshot(
        &self,
        path: &Path,
        snapshot: &PairingFile,
    ) -> anyhow::Result<()> {
        let Some(cipher) = &self.cipher else {
            anyhow::bail!(
                "the channel pairing store has no sealing key; refusing a plaintext write"
            );
        };
        let json = serde_json::to_string(snapshot)?;
        let bytes = cipher.seal_text(&json, &pairing_context())?.into_bytes();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("channel-pairing.json");
        let temporary = path.with_file_name(format!(
            ".{file_name}.tmp-{}-{}",
            std::process::id(),
            unix_nanos()
        ));
        // Sync the contents before the rename publishes them: without it a power
        // loss can leave a truncated file, which `load` treats as corrupt and
        // replaces with an empty store (losing blocks and delivery claims).
        let written = async {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary).await?;
            file.write_all(&bytes).await?;
            file.sync_all().await?;
            tokio::fs::rename(&temporary, path).await
        }
        .await;
        if let Err(error) = written {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        Ok(())
    }
}
