//! DM pairing and per-conversation access policy.
//!
//! The original gate ([`crate::channel_chat_allowed`]) was a flat, env-configured
//! chat allowlist: a chat id was either listed or the channel was closed. That is
//! safe but unusable for a bot the operator wants strangers to be able to start a
//! DM with — the operator had to read the chat id out of a log and edit an env
//! var before the bot would say a single word.
//!
//! Pairing replaces that dance. An unknown DM sender is answered with a one-time
//! **pairing code**; the operator approves the code from Ryu, and from then on
//! that sender is paired and talks to the bot normally. Nothing is admitted until
//! a human approves, so the default stays closed — the security property the flat
//! allowlist had — while the enrolment step moves out of the config file.
//!
//! Groups are gated separately ([`GroupPolicy`]): a group is a shared room, so
//! "someone in it typed at the bot" is not consent for the whole room. There is
//! no pairing flow for groups — a group is allowlisted or it is not.
//!
//! The store is a small JSON file so a paired sender survives a gateway restart.
//! It is deliberately NOT the control-plane database: pairing state is per-node
//! runtime data (the same bot token on another node has its own pairings), and
//! the gateway must be able to gate inbound traffic while the control plane is
//! unreachable.
//!
//! At rest the whole JSON body is one `encb:v1:` envelope under the Gateway's
//! content key for the store [`PAIRING_STORE`] ([`PairingSeal`]): its keys are
//! phone numbers, handles and chat ids. The associated data binds a logical id,
//! never the path, so the file can move (`RYU_CHANNEL_PAIRING_PATH`). A legacy
//! plaintext file is read and resealed on load; a file that does not open is
//! moved aside (`<name>.unreadable-<unix secs>`) and the store starts empty.
//! Without a key nothing is written: the store keeps its state in memory only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

/// How long an unapproved pairing code stays valid. After this the sender must
/// message again to get a fresh code — a code left lying around in a chat log
/// should not be approvable a month later.
pub const CODE_TTL: Duration = Duration::from_secs(60 * 60 * 24);
const REPLY_LINK_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 90);
const MAX_REPLY_LINKS: usize = 4096;

/// Characters a pairing code is drawn from. Digits `0`/`1` and letters `O`/`I`
/// are omitted so a code read aloud or off a phone screen is unambiguous.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Length of a generated pairing code.
const CODE_LEN: usize = 6;

/// How long a completed or failed provider delivery remains in the node-local
/// ledger. Provider webhooks are at-least-once, and a redelivery after a
/// restart must still converge on the original turn rather than create a second
/// model call.
const DELIVERY_RETENTION: Duration = Duration::from_secs(60 * 60 * 24 * 30);

/// How long an in-flight delivery claim is kept before a later webhook may
/// reclaim it. This covers normal model/media work while still allowing a
/// process that died mid-turn to recover when the provider redelivers.
const DELIVERY_LEASE: Duration = Duration::from_secs(60 * 30);

/// Hard bound for the node-local provider delivery ledger. A full ledger fails
/// closed at the webhook boundary so the provider retries instead of letting an
/// unbounded attacker-controlled id set consume disk.
const MAX_DELIVERY_RECORDS: usize = 8192;

/// Hard bound on live, unapproved pairing codes. A full queue fails closed
/// (unknown senders are dropped silently) so a flood of new DM senders cannot
/// grow the node-local store, or the cost of rewriting it, without bound.
const MAX_PENDING_PAIRINGS: usize = 1024;

/// One durable provider delivery claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum DeliveryState {
    /// The normalized message is being handled by the Gateway.
    Processing,
    /// The message was handled or intentionally refused and must not be run
    /// again when the provider retries the callback.
    Completed,
    /// The Gateway exhausted its local retry budget. A later provider
    /// redelivery may claim it again.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DeliveryRecord {
    state: DeliveryState,
    updated_at: u64,
    attempts: u32,
}

/// Result of claiming one provider delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryClaim {
    /// This caller owns the delivery and may process it.
    Claimed,
    /// Another task is already processing the same delivery inside its lease.
    InFlight,
    /// The delivery completed previously, so the retry is safely acknowledged
    /// without another model call or outbound message.
    Completed,
}

/// How a channel treats a **direct message** from a sender it has not seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    /// Unknown senders get a one-time pairing code and are held until an operator
    /// approves it. The default: closed to strangers, but self-service to enrol.
    #[default]
    Pairing,
    /// Only senders on the configured allowlist are admitted; everyone else is
    /// dropped silently. No enrolment path.
    Allowlist,
    /// Every DM is admitted. Only sane for a bot whose completions the operator
    /// is happy to pay for on behalf of anyone who finds it.
    Open,
    /// DMs are refused entirely; the bot only works in allowlisted groups.
    Disabled,
}

/// How a channel treats a message in a **group / multi-user** conversation.
///
/// Deliberately narrower than [`DmPolicy`]: there is no pairing flow, because the
/// consent that matters for a room is the operator's, not one member's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupPolicy {
    /// Only allowlisted group/chat ids are served.
    #[default]
    Allowlist,
    /// Any group the bot has been added to is served.
    Open,
    /// The bot never answers in groups.
    Disabled,
}

/// What the gate decided about one inbound message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Route the message to the agent.
    Allow,
    /// Drop the message without replying. Used where replying would leak that the
    /// bot exists to someone the operator never admitted.
    Deny,
    /// Do not route the message; instead reply with this pairing code so the
    /// sender can read it out to the operator.
    Challenge(String),
    /// Do not route; the sender already has a live code awaiting approval. Carries
    /// the existing code so the reply can repeat it rather than mint a second one.
    Pending(String),
}

/// The persisted state of one sender on one platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum PairState {
    /// A code has been issued and is waiting for operator approval.
    Pending {
        code: String,
        /// Unix seconds when the code was issued, for [`CODE_TTL`] expiry.
        issued_at: u64,
    },
    /// The operator approved this sender; messages flow.
    Paired {
        /// Unix seconds when approval happened. Informational (shown in the UI).
        paired_at: u64,
    },
    /// The operator explicitly blocked this sender. Distinct from "unknown" so a
    /// blocked sender never gets another code by messaging again.
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ReplyLink {
    core_message_ids: Vec<String>,
    updated_at: u64,
}

/// The on-disk shape. A map of `"<platform>:<sender_id>"` → state, provider
/// message links, and bounded delivery claims, plus a version tag so a future
/// format change can migrate rather than silently mis-parse.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PairingFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, PairState>,
    #[serde(default)]
    reply_links: HashMap<String, ReplyLink>,
    #[serde(default)]
    deliveries: HashMap<String, DeliveryRecord>,
}

/// The registered content-store name of the pairing file (KDF input; never
/// rename it).
pub const PAIRING_STORE: &str = "channel-pairing.json";

/// The logical id bound into the pairing file's associated data.
const PAIRING_FILE_ID: &str = "channel-pairing";

/// How the pairing file is protected at rest.
#[derive(Clone)]
pub enum PairingSeal {
    /// Seal the whole body with this cipher (the Gateway's content key for
    /// [`PAIRING_STORE`]).
    Sealed(ContentCipher),
    /// No key in this process: a legacy plaintext file is still read, but the
    /// store keeps every change in memory and never writes the file.
    Unavailable(String),
}

fn pairing_context() -> ContentContext {
    ContentContext::for_id("file", PAIRING_FILE_ID)
}

/// What [`PairingStore::load`] found on disk.
enum Loaded {
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

fn decode_pairing_file(bytes: &[u8], seal: &PairingSeal) -> Loaded {
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
const QUARANTINE_FILE_ID: &str = "channel-pairing.unreadable";

/// Move an unreadable pairing file aside so a fresh store never overwrites
/// data a key recovery could still open. A sealed body is renamed as it is
/// (it is ciphertext). A plaintext body (a truncated legacy file) is never
/// kept in plaintext: with a key it is sealed into the quarantine copy
/// (0600, synced) before the original is removed; without one the renamed
/// copy is at least narrowed to 0600.
async fn quarantine(path: &Path, cipher: Option<&ContentCipher>) -> Option<PathBuf> {
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

/// Pairing state for every channel on this node, backed by a sealed JSON file.
///
/// Cloneable and cheap to share: the map lives behind one `Arc<RwLock<_>>`, so all
/// channel loops on a node observe the same approvals the moment they land.
#[derive(Clone)]
pub struct PairingStore {
    inner: Arc<RwLock<PairingFile>>,
    persist_lock: Arc<Mutex<()>>,
    /// Set only together with `cipher`: the store never writes plaintext.
    path: Option<PathBuf>,
    cipher: Option<ContentCipher>,
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
    async fn persist(&self) {
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
    async fn persist_snapshot(&self, path: &Path, snapshot: &PairingFile) -> anyhow::Result<()> {
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

    /// Claim a provider delivery before spawning any model or outbound work.
    ///
    /// Provider callbacks are at-least-once. A completed claim is retained for
    /// [`DELIVERY_RETENTION`], an in-flight claim suppresses concurrent retries
    /// for [`DELIVERY_LEASE`], and a stale/failed claim can be reclaimed. The
    /// claim is durably written before the webhook should return `200`.
    pub async fn claim_delivery(
        &self,
        platform: &str,
        delivery_id: &str,
    ) -> anyhow::Result<DeliveryClaim> {
        let key = delivery_key(platform, delivery_id)?;
        let now = unix_now();
        let cutoff = now.saturating_sub(DELIVERY_RETENTION.as_secs());
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;

        file.deliveries.retain(|_, record| {
            let live_processing = matches!(record.state, DeliveryState::Processing)
                && now.saturating_sub(record.updated_at) < DELIVERY_LEASE.as_secs();
            record.updated_at >= cutoff
                && (live_processing || !matches!(record.state, DeliveryState::Processing))
        });

        if let Some(record) = file.deliveries.get(&key) {
            match record.state {
                DeliveryState::Completed => return Ok(DeliveryClaim::Completed),
                DeliveryState::Processing
                    if now.saturating_sub(record.updated_at) < DELIVERY_LEASE.as_secs() =>
                {
                    return Ok(DeliveryClaim::InFlight);
                }
                DeliveryState::Processing | DeliveryState::Failed => {}
            }
        }

        let previous = file.deliveries.get(&key).cloned();
        let mut evicted = None;
        if previous.is_none() && file.deliveries.len() >= MAX_DELIVERY_RECORDS {
            let oldest = file
                .deliveries
                .iter()
                .filter(|(_, record)| {
                    !matches!(record.state, DeliveryState::Processing)
                        || now.saturating_sub(record.updated_at) >= DELIVERY_LEASE.as_secs()
                })
                .min_by_key(|(_, record)| record.updated_at)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                anyhow::bail!("channel delivery ledger is full of in-flight messages");
            };
            evicted = file
                .deliveries
                .remove(&oldest)
                .map(|record| (oldest, record));
        }

        file.version = 1;
        let attempts = previous
            .as_ref()
            .map_or(1, |record| record.attempts.saturating_add(1));
        file.deliveries.insert(
            key.clone(),
            DeliveryRecord {
                state: DeliveryState::Processing,
                updated_at: now,
                attempts,
            },
        );

        if let Some(path) = &self.path {
            if let Err(error) = self.persist_snapshot(path, &file).await {
                if let Some(previous) = previous {
                    file.deliveries.insert(key, previous);
                } else {
                    file.deliveries.remove(&key);
                }
                if let Some((evicted_key, evicted_record)) = evicted {
                    file.deliveries.insert(evicted_key, evicted_record);
                }
                return Err(error);
            }
        }
        Ok(DeliveryClaim::Claimed)
    }

    /// Extend an in-flight claim while the local retry budget is being used.
    pub async fn touch_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            if !matches!(record.state, DeliveryState::Processing) {
                return Ok(());
            }
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Mark a claimed delivery complete after the shared turn has either sent
    /// its reply or intentionally refused/dropped the message.
    pub async fn complete_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            record.state = DeliveryState::Completed;
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Record a terminal local failure. The key remains reclaimable on a later
    /// provider redelivery, while the failure itself is kept out of the durable
    /// store so provider URLs, user text, and other transport diagnostics cannot
    /// accidentally become long-lived pairing-state content.
    pub async fn fail_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            record.state = DeliveryState::Failed;
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Persist provider-message → Core-message links next to pairing state so a
    /// delayed reaction still targets the exact assistant row after restart.
    /// The table is TTL-pruned and hard-bounded on every write.
    pub async fn bind_reply_messages(
        &self,
        platform: &str,
        conversation_id: &str,
        provider_message_ids: &[String],
        core_message_ids: &[String],
    ) {
        let now = unix_now();
        let cutoff = now.saturating_sub(REPLY_LINK_TTL.as_secs());
        {
            let mut file = self.inner.write().await;
            file.reply_links.retain(|_, link| link.updated_at >= cutoff);
            for provider_message_id in provider_message_ids {
                if provider_message_id.trim().is_empty() {
                    continue;
                }
                file.reply_links.insert(
                    reply_link_key(platform, conversation_id, provider_message_id),
                    ReplyLink {
                        core_message_ids: core_message_ids.to_vec(),
                        updated_at: now,
                    },
                );
            }
            while file.reply_links.len() > MAX_REPLY_LINKS {
                let Some(oldest) = file
                    .reply_links
                    .iter()
                    .min_by_key(|(_, link)| link.updated_at)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                file.reply_links.remove(&oldest);
            }
        }
        self.persist().await;
    }

    pub async fn reply_message(
        &self,
        platform: &str,
        conversation_id: &str,
        provider_message_id: &str,
    ) -> Option<Vec<String>> {
        let cutoff = unix_now().saturating_sub(REPLY_LINK_TTL.as_secs());
        self.inner
            .read()
            .await
            .reply_links
            .get(&reply_link_key(
                platform,
                conversation_id,
                provider_message_id,
            ))
            .filter(|link| link.updated_at >= cutoff)
            .map(|link| link.core_message_ids.clone())
    }

    /// Look up one sender's state.
    pub async fn get(&self, platform: &str, sender_id: &str) -> Option<PairState> {
        let key = entry_key(platform, sender_id);
        self.inner.read().await.entries.get(&key).cloned()
    }

    /// Every entry, for the operator-facing "pending approvals" list.
    pub async fn list(&self) -> Vec<(String, PairState)> {
        self.inner
            .read()
            .await
            .entries
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Issue (or re-issue) a pairing code for a sender and return it.
    ///
    /// An unexpired pending code is returned as-is: a sender who messages three
    /// times gets one code, not three, so the operator is not asked to choose
    /// between codes that mean the same thing.
    pub async fn challenge(&self, platform: &str, sender_id: &str) -> Decision {
        let key = entry_key(platform, sender_id);
        let now = unix_now();
        {
            let map = self.inner.read().await;
            match map.entries.get(&key) {
                Some(PairState::Paired { .. }) => return Decision::Allow,
                Some(PairState::Blocked) => return Decision::Deny,
                Some(PairState::Pending { code, issued_at })
                    if now.saturating_sub(*issued_at) < CODE_TTL.as_secs() =>
                {
                    return Decision::Pending(code.clone());
                }
                _ => {}
            }
        }
        let code = generate_code(platform, sender_id, now);
        {
            let mut map = self.inner.write().await;
            // Expired codes can never be approved; dropping them here keeps the
            // store bounded by live codes rather than by every sender ever seen.
            map.entries.retain(|_, state| match state {
                PairState::Pending { issued_at, .. } => {
                    now.saturating_sub(*issued_at) < CODE_TTL.as_secs()
                }
                PairState::Paired { .. } | PairState::Blocked => true,
            });
            // Another message may have decided this sender while the lock was
            // released; answer from that decision instead of minting a new code.
            match map.entries.get(&key) {
                Some(PairState::Paired { .. }) => return Decision::Allow,
                Some(PairState::Blocked) => return Decision::Deny,
                Some(PairState::Pending { code, .. }) => return Decision::Pending(code.clone()),
                None => {}
            }
            let pending = map
                .entries
                .values()
                .filter(|state| matches!(state, PairState::Pending { .. }))
                .count();
            if pending >= MAX_PENDING_PAIRINGS {
                warn!(
                    platform,
                    "channel pairing queue is full; dropping unknown DM sender"
                );
                return Decision::Deny;
            }
            map.version = 1;
            map.entries.insert(
                key,
                PairState::Pending {
                    code: code.clone(),
                    issued_at: now,
                },
            );
        }
        self.persist().await;
        // The code admits the sender once approved: never log it.
        info!(platform, "issued channel pairing code");
        Decision::Challenge(code)
    }

    /// Approve whichever sender holds `code`. Returns the paired entry key, or
    /// `None` when no live entry carries that code (wrong, stale, or already used).
    pub async fn approve_code(&self, code: &str) -> Option<String> {
        let wanted = code.trim().to_ascii_uppercase();
        let now = unix_now();
        let mut approved = None;
        {
            let mut map = self.inner.write().await;
            for (key, state) in map.entries.iter_mut() {
                if let PairState::Pending { code, issued_at } = state {
                    if *code == wanted && now.saturating_sub(*issued_at) < CODE_TTL.as_secs() {
                        approved = Some(key.clone());
                        break;
                    }
                }
            }
            if let Some(key) = &approved {
                map.entries
                    .insert(key.clone(), PairState::Paired { paired_at: now });
            }
        }
        if approved.is_some() {
            self.persist().await;
        }
        approved
    }

    /// Approve a sender directly (operator clicked "allow" on a pending row rather
    /// than typing the code).
    pub async fn approve(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries.insert(
                entry_key(platform, sender_id),
                PairState::Paired {
                    paired_at: unix_now(),
                },
            );
        }
        self.persist().await;
    }

    /// Block a sender. Idempotent, and permanent until explicitly removed — a
    /// blocked sender never receives another pairing code.
    pub async fn block(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries
                .insert(entry_key(platform, sender_id), PairState::Blocked);
        }
        self.persist().await;
    }

    /// Forget a sender entirely, returning them to "unknown" (so they can pair
    /// again). Used to undo an accidental block.
    pub async fn forget(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries.remove(&entry_key(platform, sender_id));
        }
        self.persist().await;
    }
}

/// The access policy for one channel: DM and group rules plus the static
/// allowlists they consult.
#[derive(Debug, Clone, Default)]
pub struct AccessPolicy {
    pub dm: DmPolicy,
    pub group: GroupPolicy,
    /// Sender ids admitted without pairing (`DmPolicy::Allowlist`, and a fast path
    /// under `Pairing`). Empty means "nobody is pre-admitted".
    pub dm_allowlist: Vec<String>,
    /// Group/chat ids admitted under `GroupPolicy::Allowlist`.
    pub group_allowlist: Vec<String>,
    /// Sender ids admitted in an allowlisted group. This is the platform-neutral
    /// equivalent of Hermes' `allow_from` user rule: a known person can address
    /// the bot in a room without opening every room with the same name.
    pub group_sender_allowlist: Vec<String>,
}

impl AccessPolicy {
    /// Decide a **group** message with no store lookup — group rules are static.
    pub fn decide_group(&self, chat_id: &str) -> Decision {
        match self.group {
            GroupPolicy::Disabled => Decision::Deny,
            GroupPolicy::Open => Decision::Allow,
            GroupPolicy::Allowlist => {
                if self.group_allowlist.iter().any(|id| id == chat_id) {
                    Decision::Allow
                } else {
                    Decision::Deny
                }
            }
        }
    }

    /// Decide a group message with both the room and the sender available.
    ///
    /// Sender admission is intentionally an additive fast path: an explicitly
    /// allowed sender may talk in a room even when the room itself is not listed,
    /// but an empty sender allowlist preserves the existing room-only behavior.
    pub fn decide_group_for_sender(&self, chat_id: &str, sender_id: Option<&str>) -> Decision {
        if sender_id.is_some_and(|id| {
            self.group_sender_allowlist
                .iter()
                .any(|allowed| allowed == id)
        }) {
            return Decision::Allow;
        }
        self.decide_group(chat_id)
    }

    /// Decide a **direct message**. `sender_id` is the platform's stable per-user
    /// id where available, falling back to the chat id for platforms where a DM
    /// chat id *is* the user (WhatsApp phone numbers, iMessage handles).
    pub async fn decide_dm(
        &self,
        store: &PairingStore,
        platform: &str,
        sender_id: &str,
    ) -> Decision {
        if self.dm_allowlist.iter().any(|id| id == sender_id) {
            return Decision::Allow;
        }
        match self.dm {
            DmPolicy::Disabled => Decision::Deny,
            DmPolicy::Open => Decision::Allow,
            DmPolicy::Allowlist => Decision::Deny,
            DmPolicy::Pairing => match store.get(platform, sender_id).await {
                Some(PairState::Paired { .. }) => Decision::Allow,
                Some(PairState::Blocked) => Decision::Deny,
                _ => store.challenge(platform, sender_id).await,
            },
        }
    }
}

/// The message sent back to a sender who needs to pair. Kept here (rather than in
/// each adapter) so every channel says the same thing.
pub fn pairing_prompt(code: &str) -> String {
    format!(
        "🔒 This assistant is private.\n\nYour pairing code is *{code}*.\n\nAsk the owner to approve this code on the Ryu Gateway. \
         Once approved, just send your message again."
    )
}

/// `"<platform>:<sender_id>"` — the store's key shape.
fn entry_key(platform: &str, sender_id: &str) -> String {
    format!("{platform}:{sender_id}")
}

fn reply_link_key(platform: &str, conversation_id: &str, provider_message_id: &str) -> String {
    format!("{platform}\0{conversation_id}\0{provider_message_id}")
}

/// Scope one provider id to its channel type. The delimiter is not exposed to
/// providers; it only prevents a Telegram update id from colliding with a
/// WhatsApp message id in the shared node store.
fn delivery_key(platform: &str, delivery_id: &str) -> anyhow::Result<String> {
    let platform = platform.trim();
    let delivery_id = delivery_id.trim();
    if platform.is_empty() || delivery_id.is_empty() {
        anyhow::bail!("channel delivery identity is empty");
    }
    if platform.len() > 80 || delivery_id.len() > 512 {
        anyhow::bail!("channel delivery identity is too long");
    }
    Ok(format!("{platform}\0{delivery_id}"))
}

/// Seconds since the Unix epoch, saturating to 0 if the clock is before it.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Nanoseconds used only for unique temporary filenames during atomic writes.
fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Derive a pairing code from the sender identity plus the issue time.
///
/// A hash rather than a random draw so the crate needs no RNG dependency. The
/// input includes the nanosecond clock, so re-challenging the same sender yields a
/// different code; the code is not a secret to be guessed but a short token the
/// operator retypes, and it is only ever valid alongside the sender it was issued
/// to (approval looks up the entry, so guessing a code cannot admit a *different*
/// sender than the one who holds it).
fn generate_code(platform: &str, sender_id: &str, now: u64) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(platform.as_bytes());
    hasher.update(b"\0");
    hasher.update(sender_id.as_bytes());
    hasher.update(now.to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(CODE_LEN)
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_seal() -> PairingSeal {
        PairingSeal::Sealed(ContentCipher::from_root(&[5u8; 32], PAIRING_STORE))
    }

    fn temp_pairing_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "ryu-pairing-{tag}-{}-{}",
                std::process::id(),
                unix_nanos()
            ))
            .join("channel-pairing.json")
    }

    #[tokio::test]
    async fn the_file_on_disk_is_sealed_and_holds_no_sender_id() {
        let path = temp_pairing_path("sealed");
        let store = PairingStore::load(&path, test_seal()).await;
        store.approve("whatsapp", "+14155550177").await;
        let challenge = store.challenge("telegram", "tg-user-4242").await;
        let bytes = tokio::fs::read(&path).await.unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("encb:v1:"), "pairing file is not sealed");
        for needle in ["+14155550177", "tg-user-4242", "whatsapp", "entries"] {
            assert!(!text.contains(needle), "{needle} is plaintext on disk");
        }
        if let Decision::Challenge(code) = challenge {
            assert!(
                !text.contains(&code),
                "the pairing code is plaintext on disk"
            );
        }
        // The body is bound to a logical id, not the path: a moved file opens.
        let moved = path.with_file_name("moved.json");
        tokio::fs::rename(&path, &moved).await.unwrap();
        let reopened = PairingStore::load(&moved, test_seal()).await;
        assert!(matches!(
            reopened.get("whatsapp", "+14155550177").await,
            Some(PairState::Paired { .. })
        ));
        let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
    }

    #[tokio::test]
    async fn legacy_plaintext_is_read_and_resealed_on_load() {
        let path = temp_pairing_path("legacy");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let legacy =
            r#"{"version":1,"entries":{"telegram:legacy-777":{"state":"paired","paired_at":1}}}"#;
        tokio::fs::write(&path, legacy).await.unwrap();
        let store = PairingStore::load(&path, test_seal()).await;
        assert!(matches!(
            store.get("telegram", "legacy-777").await,
            Some(PairState::Paired { .. })
        ));
        let text = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(text.starts_with("encb:v1:"));
        assert!(!text.contains("legacy-777"));
        // Loading the sealed file again is a no-op that still finds the sender.
        let again = PairingStore::load(&path, test_seal()).await;
        assert!(again.get("telegram", "legacy-777").await.is_some());
        let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
    }

    #[tokio::test]
    async fn a_file_sealed_under_another_key_is_moved_aside_not_overwritten() {
        let path = temp_pairing_path("wrong-key");
        let store = PairingStore::load(&path, test_seal()).await;
        store.approve("slack", "U123").await;
        let original = tokio::fs::read(&path).await.unwrap();
        let other = PairingSeal::Sealed(ContentCipher::from_root(&[6u8; 32], PAIRING_STORE));
        let fresh = PairingStore::load(&path, other).await;
        assert!(fresh.get("slack", "U123").await.is_none());
        let mut kept = None;
        let mut listing = tokio::fs::read_dir(path.parent().unwrap()).await.unwrap();
        while let Some(entry) = listing.next_entry().await.unwrap() {
            if entry.file_name().to_string_lossy().contains(".unreadable-") {
                kept = Some(tokio::fs::read(entry.path()).await.unwrap());
            }
        }
        assert_eq!(
            kept.as_deref(),
            Some(original.as_slice()),
            "sealed data was lost"
        );
        let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
    }

    #[tokio::test]
    async fn a_truncated_plaintext_file_is_quarantined_sealed_not_in_plaintext() {
        let path = temp_pairing_path("truncated");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let truncated = r#"{"version":1,"entries":{"whatsapp:+14155550123":{"state":"pai"#;
        tokio::fs::write(&path, truncated).await.unwrap();
        let store = PairingStore::load(&path, test_seal()).await;
        assert!(store.get("whatsapp", "+14155550123").await.is_none());
        let mut kept = Vec::new();
        let mut listing = tokio::fs::read_dir(path.parent().unwrap()).await.unwrap();
        while let Some(entry) = listing.next_entry().await.unwrap() {
            if entry.file_name().to_string_lossy().contains(".unreadable-") {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = entry.metadata().await.unwrap().permissions().mode();
                    assert_eq!(mode & 0o777, 0o600);
                }
                kept.push(tokio::fs::read(entry.path()).await.unwrap());
            }
        }
        assert_eq!(kept.len(), 1, "the unreadable file was not kept");
        let copy = &kept[0];
        assert!(
            ContentCipher::is_sealed_bytes(copy),
            "quarantine copy is plaintext"
        );
        assert!(!String::from_utf8_lossy(copy).contains("+14155550123"));
        // A key recovery can still read what was set aside.
        let PairingSeal::Sealed(cipher) = test_seal() else {
            unreachable!()
        };
        let opened = cipher
            .open_bytes(copy, &ContentContext::for_id("file", QUARANTINE_FILE_ID))
            .unwrap();
        assert_eq!(opened.value, truncated.as_bytes());
        // Without a key the renamed copy is still narrowed to 0600.
        let unkeyed = temp_pairing_path("truncated-no-key");
        tokio::fs::create_dir_all(unkeyed.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&unkeyed, truncated).await.unwrap();
        PairingStore::load(&unkeyed, PairingSeal::Unavailable("test".into())).await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut listing = tokio::fs::read_dir(unkeyed.parent().unwrap())
                .await
                .unwrap();
            while let Some(entry) = listing.next_entry().await.unwrap() {
                let mode = entry.metadata().await.unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{:?}", entry.file_name());
            }
        }
        let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
        let _ = tokio::fs::remove_dir_all(unkeyed.parent().unwrap()).await;
    }

    #[tokio::test]
    async fn without_a_key_the_store_is_memory_only_and_writes_nothing() {
        let path = temp_pairing_path("no-key");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let legacy =
            r#"{"version":1,"entries":{"telegram:legacy-888":{"state":"paired","paired_at":1}}}"#;
        tokio::fs::write(&path, legacy).await.unwrap();
        let store = PairingStore::load(&path, PairingSeal::Unavailable("test".into())).await;
        assert!(store.get("telegram", "legacy-888").await.is_some());
        store.approve("telegram", "new-999").await;
        store.claim_delivery("telegram", "update-9").await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), legacy);
        // A sealed file without a key is left untouched as well.
        let sealed_path = temp_pairing_path("no-key-sealed");
        PairingStore::load(&sealed_path, test_seal())
            .await
            .approve("slack", "U9")
            .await;
        let sealed = tokio::fs::read(&sealed_path).await.unwrap();
        let locked =
            PairingStore::load(&sealed_path, PairingSeal::Unavailable("test".into())).await;
        locked.approve("slack", "U10").await;
        assert_eq!(tokio::fs::read(&sealed_path).await.unwrap(), sealed);
        let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
        let _ = tokio::fs::remove_dir_all(sealed_path.parent().unwrap()).await;
    }

    #[test]
    fn generated_code_uses_unambiguous_alphabet() {
        let code = generate_code("telegram", "42", 1);
        assert_eq!(code.len(), CODE_LEN);
        for ch in code.chars() {
            assert!(
                CODE_ALPHABET.contains(&(ch as u8)),
                "{ch} is not in the code alphabet"
            );
            assert!(!"01OI".contains(ch), "{ch} is visually ambiguous");
        }
    }

    #[tokio::test]
    async fn unknown_sender_is_challenged_then_paired() {
        let store = PairingStore::ephemeral();
        let policy = AccessPolicy {
            dm: DmPolicy::Pairing,
            ..Default::default()
        };

        let first = policy.decide_dm(&store, "telegram", "u1").await;
        let Decision::Challenge(code) = first else {
            panic!("first contact must be challenged, got {first:?}");
        };

        // Messaging again re-serves the SAME code rather than minting a second.
        let second = policy.decide_dm(&store, "telegram", "u1").await;
        assert_eq!(second, Decision::Pending(code.clone()));

        assert_eq!(
            store.approve_code(&code).await.as_deref(),
            Some("telegram:u1")
        );
        assert_eq!(
            policy.decide_dm(&store, "telegram", "u1").await,
            Decision::Allow
        );
    }

    #[tokio::test]
    async fn exact_reply_links_survive_restart() {
        let path = std::env::temp_dir().join(format!(
            "ryu-channel-reply-links-{}-{}.json",
            std::process::id(),
            unix_now()
        ));
        let store = PairingStore::load(&path, test_seal()).await;
        store
            .bind_reply_messages(
                "telegram",
                "channel:bot:chat",
                &["provider-42".to_owned()],
                &["assistant-98".to_owned(), "assistant-99".to_owned()],
            )
            .await;
        drop(store);

        let restored = PairingStore::load(&path, test_seal()).await;
        assert_eq!(
            restored
                .reply_message("telegram", "channel:bot:chat", "provider-42")
                .await,
            Some(vec!["assistant-98".to_owned(), "assistant-99".to_owned()])
        );
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn reply_links_stay_within_the_hard_limit() {
        let store = PairingStore::ephemeral();
        for index in 0..=MAX_REPLY_LINKS {
            store
                .bind_reply_messages(
                    "telegram",
                    "channel:bot:chat",
                    &[format!("provider-{index}")],
                    &[format!("assistant-{index}")],
                )
                .await;
        }

        assert_eq!(store.inner.read().await.reply_links.len(), MAX_REPLY_LINKS);
    }

    #[tokio::test]
    async fn delivery_claims_suppress_duplicates_until_completion() {
        let store = PairingStore::ephemeral();
        assert_eq!(
            store
                .claim_delivery("telegram", "bot-a:update-42")
                .await
                .unwrap(),
            DeliveryClaim::Claimed
        );
        assert_eq!(
            store
                .claim_delivery("telegram", "bot-a:update-42")
                .await
                .unwrap(),
            DeliveryClaim::InFlight
        );

        store
            .complete_delivery("telegram", "bot-a:update-42")
            .await
            .unwrap();
        assert_eq!(
            store
                .claim_delivery("telegram", "bot-a:update-42")
                .await
                .unwrap(),
            DeliveryClaim::Completed
        );

        // Provider ids are scoped by platform, so equal-looking ids on two
        // transports remain independent deliveries.
        assert_eq!(
            store
                .claim_delivery("whatsapp", "bot-a:update-42")
                .await
                .unwrap(),
            DeliveryClaim::Claimed
        );
    }

    #[tokio::test]
    async fn failed_delivery_can_be_reclaimed_and_survives_restart() {
        let path = std::env::temp_dir().join(format!(
            "ryu-channel-deliveries-{}-{}.json",
            std::process::id(),
            unix_nanos()
        ));
        let store = PairingStore::load(&path, test_seal()).await;
        store
            .claim_delivery("whatsapp", "bot-a:wamid-1")
            .await
            .unwrap();
        store
            .fail_delivery("whatsapp", "bot-a:wamid-1")
            .await
            .unwrap();
        assert_eq!(
            store
                .claim_delivery("whatsapp", "bot-a:wamid-1")
                .await
                .unwrap(),
            DeliveryClaim::Claimed
        );
        store
            .complete_delivery("whatsapp", "bot-a:wamid-1")
            .await
            .unwrap();
        drop(store);

        let restored = PairingStore::load(&path, test_seal()).await;
        assert_eq!(
            restored
                .claim_delivery("whatsapp", "bot-a:wamid-1")
                .await
                .unwrap(),
            DeliveryClaim::Completed
        );
        let _ = tokio::fs::remove_file(path).await;
    }

    #[test]
    fn delivery_identity_rejects_empty_and_unbounded_provider_ids() {
        assert!(delivery_key("telegram", "").is_err());
        assert!(delivery_key("", "update-1").is_err());
        assert!(delivery_key("telegram", &"x".repeat(513)).is_err());
        assert_eq!(
            delivery_key("telegram", "update-1").unwrap(),
            "telegram\0update-1"
        );
    }

    #[tokio::test]
    async fn blocked_sender_never_gets_a_new_code() {
        let store = PairingStore::ephemeral();
        let policy = AccessPolicy::default();
        store.block("telegram", "spammer").await;
        assert_eq!(
            policy.decide_dm(&store, "telegram", "spammer").await,
            Decision::Deny
        );
        // …and forgetting them restores the enrolment path.
        store.forget("telegram", "spammer").await;
        assert!(matches!(
            policy.decide_dm(&store, "telegram", "spammer").await,
            Decision::Challenge(_)
        ));
    }

    #[tokio::test]
    async fn approve_code_rejects_unknown_and_expired_codes() {
        let store = PairingStore::ephemeral();
        assert!(store.approve_code("ZZZZZZ").await.is_none());

        // An expired pending entry is not approvable. Age the entry by rewriting
        // its `issued_at`, then RELEASE the lock before calling `approve_code` —
        // it takes the same write lock, so holding one across the call deadlocks.
        store.challenge("telegram", "u2").await;
        let key = entry_key("telegram", "u2");
        let stale = {
            let mut map = store.inner.write().await;
            let code = match map.entries.get(&key) {
                Some(PairState::Pending { code, .. }) => code.clone(),
                other => panic!("expected pending, got {other:?}"),
            };
            map.entries.insert(
                key.clone(),
                PairState::Pending {
                    code: code.clone(),
                    issued_at: unix_now() - CODE_TTL.as_secs() - 1,
                },
            );
            code
        };
        assert!(
            store.approve_code(&stale).await.is_none(),
            "an expired code must not be approvable"
        );
        // The entry is left pending rather than silently consumed.
        assert!(matches!(
            store.get("telegram", "u2").await,
            Some(PairState::Pending { .. })
        ));
    }

    #[tokio::test]
    async fn dm_policies_gate_as_documented() {
        let store = PairingStore::ephemeral();

        let open = AccessPolicy {
            dm: DmPolicy::Open,
            ..Default::default()
        };
        assert_eq!(open.decide_dm(&store, "t", "x").await, Decision::Allow);

        let disabled = AccessPolicy {
            dm: DmPolicy::Disabled,
            ..Default::default()
        };
        assert_eq!(disabled.decide_dm(&store, "t", "x").await, Decision::Deny);

        // Allowlist admits only listed senders and offers no enrolment path.
        let listed = AccessPolicy {
            dm: DmPolicy::Allowlist,
            dm_allowlist: vec!["known".into()],
            ..Default::default()
        };
        assert_eq!(
            listed.decide_dm(&store, "t", "known").await,
            Decision::Allow
        );
        assert_eq!(listed.decide_dm(&store, "t", "other").await, Decision::Deny);
    }

    #[test]
    fn group_policies_gate_as_documented() {
        let allow = AccessPolicy {
            group: GroupPolicy::Allowlist,
            group_allowlist: vec!["-100".into()],
            ..Default::default()
        };
        assert_eq!(allow.decide_group("-100"), Decision::Allow);
        assert_eq!(allow.decide_group("-200"), Decision::Deny);

        let open = AccessPolicy {
            group: GroupPolicy::Open,
            ..Default::default()
        };
        assert_eq!(open.decide_group("anything"), Decision::Allow);

        let off = AccessPolicy {
            group: GroupPolicy::Disabled,
            ..Default::default()
        };
        assert_eq!(off.decide_group("-100"), Decision::Deny);
    }

    #[test]
    fn group_sender_allowlist_is_an_additive_fast_path() {
        let policy = AccessPolicy {
            group: GroupPolicy::Allowlist,
            group_allowlist: vec!["room-1".into()],
            group_sender_allowlist: vec!["trusted-user".into()],
            ..Default::default()
        };
        assert_eq!(
            policy.decide_group_for_sender("unlisted-room", Some("trusted-user")),
            Decision::Allow
        );
        assert_eq!(
            policy.decide_group_for_sender("unlisted-room", Some("other-user")),
            Decision::Deny
        );
        assert_eq!(
            policy.decide_group_for_sender("room-1", Some("other-user")),
            Decision::Allow
        );
    }

    #[tokio::test]
    async fn store_round_trips_through_a_file() {
        // Unique per process and per call so concurrent test binaries never
        // share (and then delete) one another's directory.
        let dir = std::env::temp_dir().join(format!(
            "ryu-pairing-test-{}-{}",
            std::process::id(),
            unix_nanos()
        ));
        let path = dir.join("pairing.json");
        let store = PairingStore::load(&path, test_seal()).await;
        store.approve("telegram", "u9").await;
        store
            .claim_delivery("telegram", "update-1")
            .await
            .expect("claim persists");

        let reloaded = PairingStore::load(&path, test_seal()).await;
        assert!(matches!(
            reloaded.get("telegram", "u9").await,
            Some(PairState::Paired { .. })
        ));
        // Every write is renamed into place; no temporary file is left behind.
        let mut leftovers = Vec::new();
        let mut listing = tokio::fs::read_dir(&dir).await.expect("list dir");
        while let Some(entry) = listing.next_entry().await.expect("dir entry") {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(".tmp-") {
                leftovers.push(name);
            }
        }
        assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = tokio::fs::metadata(&path)
                .await
                .expect("pairing file metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "pairing file must be owner-only");
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Rewrite a pending entry's `issued_at` so it is past [`CODE_TTL`]. The
    /// write lock is released before returning.
    async fn age_pending(store: &PairingStore, platform: &str, sender_id: &str) {
        let key = entry_key(platform, sender_id);
        let mut map = store.inner.write().await;
        let code = match map.entries.get(&key) {
            Some(PairState::Pending { code, .. }) => code.clone(),
            other => panic!("expected pending, got {other:?}"),
        };
        map.entries.insert(
            key,
            PairState::Pending {
                code,
                issued_at: unix_now() - CODE_TTL.as_secs() - 1,
            },
        );
    }

    #[tokio::test]
    async fn expired_pending_codes_are_pruned_and_pending_codes_are_bounded() {
        let store = PairingStore::ephemeral();
        let policy = AccessPolicy::default();
        store.challenge("telegram", "u-old").await;
        age_pending(&store, "telegram", "u-old").await;
        store.block("telegram", "u-blocked").await;
        store.approve("telegram", "u-paired").await;

        assert!(matches!(
            store.challenge("telegram", "u-new").await,
            Decision::Challenge(_)
        ));
        assert_eq!(store.get("telegram", "u-old").await, None);
        assert_eq!(
            store.get("telegram", "u-blocked").await,
            Some(PairState::Blocked)
        );
        assert!(matches!(
            store.get("telegram", "u-paired").await,
            Some(PairState::Paired { .. })
        ));

        // Fill the queue with live codes ("u-new" already holds one).
        for index in 1..MAX_PENDING_PAIRINGS {
            assert!(matches!(
                store.challenge("telegram", &format!("u-{index}")).await,
                Decision::Challenge(_)
            ));
        }
        let entries_when_full = store.inner.read().await.entries.len();
        assert_eq!(
            store.challenge("telegram", "u-fresh").await,
            Decision::Deny,
            "a full queue fails closed for unknown senders"
        );
        assert_eq!(store.inner.read().await.entries.len(), entries_when_full);

        // Senders who already have a code, or are paired, are unaffected.
        let Some(PairState::Pending { code, .. }) = store.get("telegram", "u-new").await else {
            panic!("u-new should still be pending");
        };
        assert_eq!(
            store.challenge("telegram", "u-new").await,
            Decision::Pending(code)
        );
        assert_eq!(
            policy.decide_dm(&store, "telegram", "u-paired").await,
            Decision::Allow
        );

        // Once a code expires, a new sender can enrol again.
        age_pending(&store, "telegram", "u-1").await;
        assert!(matches!(
            store.challenge("telegram", "u-fresh").await,
            Decision::Challenge(_)
        ));
        assert_eq!(store.get("telegram", "u-1").await, None);
    }
}
