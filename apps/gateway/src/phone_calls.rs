//! In-process controls plus a private durable journal for PSTN voice sessions.
//!
//! The journal makes outbound call creation idempotent across HTTP retries and
//! Gateway restarts. Twilio owns the media socket; authenticated Gateway
//! endpoints send bounded guidance or abort frames into a live Core session.
//!
//! The journal holds each call's opening prompt (the user's goal, and the
//! owner's hand-off number when one is configured), so its whole body is one
//! `encb:v1:` envelope under the Gateway's content key for [`JOURNAL_STORE`].
//! It lives at `<data dir>/state/phone-call-state.json` ([`journal_path`]). A
//! journal that cannot be read is moved aside (`<name>.unreadable-<unix secs>`,
//! 0600, and sealed when it was plaintext and a key is available, so no
//! plaintext copy is kept) and the hub starts empty: at worst a retried request within 24 hours places
//! a second call, which is better than a Gateway that cannot boot.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, RwLock};

/// File name of the journal, and its registered content-store name (KDF input;
/// never rename it).
pub const JOURNAL_STORE: &str = "phone-call-state.json";
/// Logical id bound into the journal's associated data (never the path).
const JOURNAL_FILE_ID: &str = "phone-call-journal";

fn journal_context() -> ContentContext {
    ContentContext::for_id("file", JOURNAL_FILE_ID)
}

/// Where the journal lives: `<data dir>/state/phone-call-state.json`. A journal
/// an older Gateway left beside `config_path` (`gateway.toml`, wherever
/// `GATEWAY_CONFIG` points) is moved there once; when the data folder already
/// holds one (after a downgrade and upgrade), the old copy is set aside in the
/// data folder (sealed under `cipher` when it was plaintext) and removed from
/// beside the config. Without a data dir the journal stays beside the config
/// file. Temp files a crashed write or move left behind are removed.
pub fn journal_path(
    config_path: Option<&std::path::Path>,
    cipher: Option<&ContentCipher>,
) -> Option<PathBuf> {
    let legacy = config_path.map(|path| path.with_file_name(JOURNAL_STORE));
    let Some(target) = crate::profile::data_file(crate::profile::DataSlot::State, JOURNAL_STORE)
    else {
        return legacy;
    };
    if let Some(legacy) = legacy.filter(|legacy| *legacy != target) {
        move_legacy_journal(&legacy, &target, cipher);
    }
    sweep_stale_temps(&target);
    Some(target)
}

/// Remove `phone-call-state.<uuid>.tmp` files beside `target`. A temp file is
/// only ever the unpublished half of a write or move whose source is still in
/// place, so removing it never loses the journal.
fn sweep_stale_temps(target: &std::path::Path) {
    let Some(directory) = target.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let prefix = format!("{}.", JOURNAL_STORE.trim_end_matches(".json"));
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".tmp") && name != JOURNAL_STORE {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Move `legacy` to `target`. The copy fallback (another file system) writes
/// and syncs a 0600 temp beside `target` (sealed first when `cipher` is given
/// and the legacy body is plaintext) and only then removes `legacy`, so a
/// crash never loses the journal. When `target` already exists, `legacy` is
/// set aside next to it as `<name>.superseded-<unix secs>` (never plaintext
/// when a key is available) instead of staying beside the config forever.
fn move_legacy_journal(
    legacy: &std::path::Path,
    target: &std::path::Path,
    cipher: Option<&ContentCipher>,
) {
    let Ok(metadata) = fs::symlink_metadata(legacy) else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            tracing::warn!(%error, "cannot create the phone-call journal directory");
            return;
        }
    }
    if target.exists() {
        let aside = target.with_file_name(format!("{JOURNAL_STORE}.superseded-{}", unix_secs()));
        match set_aside(legacy, &aside, cipher) {
            Ok(()) => tracing::warn!(
                "a phone-call journal remained beside gateway.toml although the data folder \
                 already holds one; the old copy was set aside in the data folder"
            ),
            Err(error) => tracing::warn!(
                %error,
                "could not set aside the phone-call journal left beside gateway.toml"
            ),
        }
        return;
    }
    let moved = fs::rename(legacy, target).or_else(|_| {
        let raw = fs::read(legacy)?;
        let bytes = match (cipher, std::str::from_utf8(&raw)) {
            (Some(cipher), Ok(text)) if !ContentCipher::is_sealed_text(text.trim()) => cipher
                .seal_text(text, &journal_context())
                .map(String::into_bytes)
                .map_err(std::io::Error::other)?,
            _ => raw,
        };
        let temp = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        if let Err(error) =
            write_new_private(&temp, &bytes).and_then(|()| fs::rename(&temp, target))
        {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        fs::remove_file(legacy)
    });
    match moved {
        Ok(()) => tracing::info!("moved the phone-call journal into the data folder"),
        Err(error) => tracing::warn!(%error, "could not move the phone-call journal"),
    }
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Create `path` (it must not exist) with mode 0600, write `bytes` and sync.
fn write_new_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Logical id bound into the associated data of a journal set aside.
const SET_ASIDE_FILE_ID: &str = "phone-call-journal.unreadable";

/// Move `source` to `target` without ever keeping a plaintext copy when a key
/// is available. A sealed body is renamed as it is (it is ciphertext). A
/// plaintext body is sealed into `target` (0600, synced) before `source` is
/// removed; without a key the renamed copy is at least narrowed to 0600.
fn set_aside(
    source: &std::path::Path,
    target: &std::path::Path,
    cipher: Option<&ContentCipher>,
) -> std::io::Result<()> {
    let raw = fs::read(source)?;
    let sealed =
        std::str::from_utf8(&raw).is_ok_and(|text| ContentCipher::is_sealed_text(text.trim()));
    if let (false, Some(cipher)) = (sealed, cipher) {
        let context = ContentContext::for_id("file", SET_ASIDE_FILE_ID);
        let body = cipher
            .seal_bytes(&raw, &context)
            .map_err(std::io::Error::other)?;
        if let Err(error) = write_new_private(target, &body) {
            let _ = fs::remove_file(target);
            return Err(error);
        }
        return fs::remove_file(source);
    }
    fs::rename(source, target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Move an unreadable journal aside so the empty one written next never
/// replaces data a key recovery could still open (see [`set_aside`]).
fn quarantine(path: &std::path::Path, cipher: Option<&ContentCipher>) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let target = path.with_file_name(format!("{name}.unreadable-{}", unix_secs()));
    set_aside(path, &target, cipher).ok().map(|()| target)
}

const MAX_INTENTS: usize = 2_048;
const MAX_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
const INTENT_RETENTION_MS: i64 = 24 * 60 * 60 * 1_000;
const JOURNAL_VERSION: u8 = 1;
/// How long an answered inbound call holds its line slot while the provider
/// opens the media stream. Streams start within a few seconds; a call whose
/// stream never starts gives the slot back once this passes.
const INBOUND_RESERVATION_TTL: Duration = Duration::from_secs(30);
/// How long Twilio lets an outbound call ring before it reports `no-answer`.
/// Sent as the Calls API `Timeout` (it matches Twilio's own default).
pub const OUTBOUND_RING_TIMEOUT: Duration = Duration::from_secs(60);
/// How long an outbound call holds its line slot before its media stream
/// starts: the ring timeout plus a margin for the Calls request, provider
/// queueing and the answer-to-stream gap. A call whose terminal status callback
/// never arrives gives the slot back once this passes.
const OUTBOUND_RESERVATION_TTL: Duration =
    Duration::from_secs(OUTBOUND_RING_TIMEOUT.as_secs() + 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallReservation {
    Created {
        intent_id: String,
    },
    Pending,
    Existing {
        call_sid: String,
    },
    /// The line already holds its simultaneous-call limit. Nothing was
    /// recorded, and the call must not be placed.
    LineBusy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OutboundCallIntent {
    pub call_sid: Option<String>,
    pub created_at_ms: i64,
    pub fingerprint: String,
    pub goal: String,
    pub idempotency_key: String,
    pub line_id: String,
}

/// A line slot a call holds until its media stream starts: an inbound call
/// from its answer webhook, an outbound call from before it is placed.
struct SlotReservation {
    line_id: String,
    expires_at: Instant,
}

#[derive(Default)]
struct HubState {
    /// Live call SID → (phone line id, control channel).
    sessions: HashMap<String, (String, mpsc::Sender<String>)>,
    /// Call SID → the slot it holds before its stream starts. An outbound
    /// call's slot is keyed by its intent id until its Call SID is known.
    reservations: HashMap<String, SlotReservation>,
    intents: HashMap<String, OutboundCallIntent>,
    idempotency: HashMap<String, String>,
}

impl HubState {
    fn prune_reservations(&mut self, now: Instant) {
        self.reservations
            .retain(|_, reservation| reservation.expires_at > now);
    }

    /// Slots held on `line_id` by calls other than `call_sid`: live calls plus
    /// admitted calls whose streams have not started yet.
    fn slots_held_by_others(&self, line_id: &str, call_sid: &str) -> usize {
        let live = self
            .sessions
            .iter()
            .filter(|(sid, (line, _))| line == line_id && *sid != call_sid)
            .count();
        let reserved = self
            .reservations
            .iter()
            .filter(|(sid, reservation)| reservation.line_id == line_id && *sid != call_sid)
            .count();
        live + reserved
    }
}

#[derive(Deserialize, Serialize)]
struct JournalFile {
    intents: HashMap<String, OutboundCallIntent>,
    version: u8,
}

/// The journal file and the cipher that seals it. Only built with a cipher:
/// the hub never writes the journal in plaintext.
struct Journal {
    path: PathBuf,
    cipher: ContentCipher,
}

#[derive(Clone)]
pub struct PhoneCallHub {
    state: Arc<RwLock<HubState>>,
    journal: Option<Arc<Journal>>,
}

impl Default for PhoneCallHub {
    fn default() -> Self {
        Self {
            state: Arc::new(RwLock::new(HubState::default())),
            journal: None,
        }
    }
}

/// What a journal file on disk turned out to be.
enum LoadedJournal {
    Missing,
    Opened {
        journal: JournalFile,
        reseal: bool,
    },
    /// Sealed, and no key in this process: left untouched.
    Locked,
    Unreadable(String),
}

fn read_journal(path: &std::path::Path, cipher: Option<&ContentCipher>) -> LoadedJournal {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return LoadedJournal::Missing;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return LoadedJournal::Unreadable("not a regular file".to_owned());
    }
    // A sealed body is base64 of the JSON plus a short prefix: allow for it.
    if metadata.len() > (MAX_JOURNAL_BYTES as u64) * 4 / 3 + 64 {
        return LoadedJournal::Unreadable("larger than the 8 MiB limit".to_owned());
    }
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => return LoadedJournal::Unreadable(format!("read failed: {error}")),
    };
    let trimmed = content.trim();
    let (json, reseal) = if ContentCipher::is_sealed_text(trimmed) {
        let Some(cipher) = cipher else {
            return LoadedJournal::Locked;
        };
        match cipher.open_text(trimmed, &journal_context()) {
            Ok(opened) => (opened.value, opened.needs_reseal),
            Err(error) => return LoadedJournal::Unreadable(error.to_string()),
        }
    } else {
        // AEAD authenticates a sealed body; a plaintext one is trusted only
        // when no other user could have written it. A merely readable legacy
        // file is resealed (0600) by the caller.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o022 != 0 {
                return LoadedJournal::Unreadable("writable by other users".to_owned());
            }
        }
        (content, true)
    };
    match serde_json::from_str::<JournalFile>(&json) {
        Ok(journal) if journal.version == JOURNAL_VERSION => {
            LoadedJournal::Opened { journal, reseal }
        }
        Ok(_) => LoadedJournal::Unreadable("unsupported version".to_owned()),
        Err(error) => LoadedJournal::Unreadable(format!("invalid JSON: {error}")),
    }
}

impl PhoneCallHub {
    /// The hub over the journal at `path`, sealed with `cipher` (the Gateway's
    /// content key for [`JOURNAL_STORE`]). Never fails: a journal that cannot
    /// be read is moved aside and the hub starts empty, and legacy plaintext is
    /// resealed at once. Without a key (`Err(reason)`) the hub keeps intents in
    /// memory only, reading a legacy plaintext journal but never writing one.
    pub fn with_journal(path: Option<PathBuf>, cipher: Result<ContentCipher, String>) -> Self {
        let mut state = HubState::default();
        let mut reseal = false;
        if let Some(path) = path.as_deref() {
            match read_journal(path, cipher.as_ref().ok()) {
                LoadedJournal::Missing => {}
                LoadedJournal::Opened {
                    journal,
                    reseal: needs_reseal,
                } => {
                    state.intents = journal.intents;
                    reseal = needs_reseal;
                }
                LoadedJournal::Locked => tracing::warn!(
                    "the phone-call journal is sealed and no sealing key is available; \
                     starting empty and leaving it untouched"
                ),
                LoadedJournal::Unreadable(reason) => {
                    let moved = quarantine(path, cipher.as_ref().ok());
                    tracing::warn!(
                        %reason,
                        moved_to = ?moved.as_ref().map(|target| target.display().to_string()),
                        "the phone-call journal is unreadable; moved aside and starting empty"
                    );
                }
            }
        }
        state.idempotency = state
            .intents
            .iter()
            .map(|(intent_id, intent)| (intent.idempotency_key.clone(), intent_id.clone()))
            .collect();
        reseal |= prune_expired(&mut state);
        if state.intents.len() > MAX_INTENTS {
            tracing::warn!("the phone-call journal holds too many entries; keeping none");
            state.intents.clear();
            state.idempotency.clear();
            reseal = true;
        }
        restore_outbound_reservations(&mut state, now_millis(), Instant::now());
        let journal = match (path, cipher) {
            (Some(path), Ok(cipher)) => Some(Arc::new(Journal { path, cipher })),
            (Some(_), Err(reason)) => {
                tracing::warn!(
                    %reason,
                    "no sealing key for the phone-call journal; outbound call requests are \
                     idempotent only until the Gateway restarts"
                );
                None
            }
            (None, _) => None,
        };
        let hub = Self {
            state: Arc::new(RwLock::new(state)),
            journal,
        };
        if reseal && hub.journal.is_some() {
            if let Ok(state) = hub.state.try_read() {
                if let Err(error) = hub.persist_locked(&state) {
                    tracing::warn!(%error, "could not seal the phone-call journal yet");
                }
            }
        }
        hub
    }

    /// Record a new outbound call request and hold one of the line's `limit`
    /// slots for it before the provider is asked to place the call. The cap
    /// check, the hold and the journal entry happen under one lock, so
    /// concurrent requests cannot both take the last slot, and a full line
    /// answers [`CallReservation::LineBusy`] without recording anything. A
    /// repeated request returns the recorded call and takes no second slot.
    pub async fn reserve_outbound(
        &self,
        idempotency_key: String,
        fingerprint: String,
        line_id: String,
        goal: String,
        limit: usize,
    ) -> Result<CallReservation, String> {
        let mut state = self.state.write().await;
        if prune_expired(&mut state) {
            self.persist_locked(&state)?;
        }
        if let Some(intent_id) = state.idempotency.get(&idempotency_key) {
            let Some(intent) = state.intents.get(intent_id) else {
                return Err("phone-call idempotency record is inconsistent".to_owned());
            };
            if intent.fingerprint != fingerprint {
                return Err("idempotency key was already used for a different call".to_owned());
            }
            return Ok(match intent.call_sid.as_deref() {
                Some(call_sid) => CallReservation::Existing {
                    call_sid: call_sid.to_owned(),
                },
                None => CallReservation::Pending,
            });
        }
        if state.intents.len() >= MAX_INTENTS {
            return Err("too many retained phone-call requests".to_owned());
        }
        let now = Instant::now();
        state.prune_reservations(now);
        if state.slots_held_by_others(&line_id, "") >= limit {
            return Ok(CallReservation::LineBusy);
        }

        let intent_id = uuid::Uuid::new_v4().simple().to_string();
        state.intents.insert(
            intent_id.clone(),
            OutboundCallIntent {
                call_sid: None,
                created_at_ms: now_millis(),
                fingerprint,
                goal,
                idempotency_key: idempotency_key.clone(),
                line_id: line_id.clone(),
            },
        );
        state
            .idempotency
            .insert(idempotency_key.clone(), intent_id.clone());
        if let Err(error) = self.persist_locked(&state) {
            state.intents.remove(&intent_id);
            state.idempotency.remove(&idempotency_key);
            return Err(error);
        }
        state.reservations.insert(
            intent_id.clone(),
            SlotReservation {
                line_id,
                expires_at: now + OUTBOUND_RESERVATION_TTL,
            },
        );
        Ok(CallReservation::Created { intent_id })
    }

    pub async fn get_intent(&self, intent_id: &str) -> Option<OutboundCallIntent> {
        let mut state = self.state.write().await;
        if prune_expired(&mut state) {
            let _ = self.persist_locked(&state);
        }
        state.intents.get(intent_id).cloned()
    }

    pub async fn get_intent_for_call(&self, call_sid: &str) -> Option<OutboundCallIntent> {
        let mut state = self.state.write().await;
        if prune_expired(&mut state) {
            let _ = self.persist_locked(&state);
        }
        state
            .intents
            .values()
            .find(|intent| intent.call_sid.as_deref() == Some(call_sid))
            .cloned()
    }

    pub async fn record_call_sid(&self, intent_id: &str, call_sid: &str) -> Result<bool, String> {
        let mut state = self.state.write().await;
        {
            let Some(intent) = state.intents.get_mut(intent_id) else {
                return Ok(false);
            };
            if let Some(existing) = intent.call_sid.as_deref() {
                return Ok(existing == call_sid);
            }
            intent.call_sid = Some(call_sid.to_owned());
        }
        if let Err(error) = self.persist_locked(&state) {
            if let Some(intent) = state.intents.get_mut(intent_id) {
                intent.call_sid = None;
            }
            return Err(error);
        }
        // The slot held while the call was placed now belongs to its Call SID,
        // which the call's media stream registers under.
        if let Some(reservation) = state.reservations.remove(intent_id) {
            state.reservations.insert(call_sid.to_owned(), reservation);
        }
        Ok(true)
    }

    /// Forget an outbound request whose call was never placed, and give its
    /// line slot back.
    pub async fn remove_intent(&self, intent_id: &str) -> Result<(), String> {
        let mut state = self.state.write().await;
        state.reservations.remove(intent_id);
        if let Some(intent) = state.intents.remove(intent_id) {
            state.idempotency.remove(&intent.idempotency_key);
            if let Err(error) = self.persist_locked(&state) {
                state
                    .idempotency
                    .insert(intent.idempotency_key.clone(), intent_id.to_owned());
                state.intents.insert(intent_id.to_owned(), intent);
                return Err(error);
            }
        }
        Ok(())
    }

    /// Admit an inbound call on `line_id` before its webhook answers, holding
    /// one of the line's `limit` slots for `call_sid` until its media stream
    /// registers or [`INBOUND_RESERVATION_TTL`] passes. The check and the hold
    /// happen under one lock, so concurrent webhooks cannot both take the last
    /// slot. A retried webhook for the same call keeps its single slot.
    pub async fn try_reserve(&self, call_sid: &str, line_id: &str, limit: usize) -> bool {
        self.try_reserve_at(call_sid, line_id, limit, Instant::now())
            .await
    }

    async fn try_reserve_at(
        &self,
        call_sid: &str,
        line_id: &str,
        limit: usize,
        now: Instant,
    ) -> bool {
        let mut state = self.state.write().await;
        state.prune_reservations(now);
        if state
            .sessions
            .get(call_sid)
            .is_some_and(|(line, _)| line == line_id)
        {
            return true;
        }
        if state.slots_held_by_others(line_id, call_sid) >= limit {
            return false;
        }
        state.reservations.insert(
            call_sid.to_owned(),
            SlotReservation {
                line_id: line_id.to_owned(),
                expires_at: now + INBOUND_RESERVATION_TTL,
            },
        );
        true
    }

    /// Register a live call on `line_id`. A call holding a reserved slot (an
    /// inbound call its answer webhook admitted, or an outbound call placed by
    /// [`Self::reserve_outbound`]) takes that slot over without a second cap
    /// check; any other stream (one whose reservation lapsed or was released)
    /// is refused when the line already holds `limit` calls. The check and the
    /// insert happen under one lock, so concurrent stream starts cannot both
    /// take the last slot.
    pub async fn try_register(
        &self,
        call_sid: String,
        line_id: String,
        control_tx: mpsc::Sender<String>,
        limit: usize,
    ) -> bool {
        let mut state = self.state.write().await;
        state.prune_reservations(Instant::now());
        let reserved = state
            .reservations
            .remove(&call_sid)
            .is_some_and(|reservation| reservation.line_id == line_id);
        if !reserved && state.slots_held_by_others(&line_id, &call_sid) >= limit {
            return false;
        }
        state.sessions.insert(call_sid, (line_id, control_tx));
        true
    }

    /// Give back the slot a call holds before its media stream starts, once
    /// the provider reports that the call ended without one. A live call keeps
    /// its slot until its stream ends.
    pub async fn release_reservation(&self, call_sid: &str) {
        self.state.write().await.reservations.remove(call_sid);
    }

    /// Slots held on `line_id`: live calls plus admitted calls whose streams
    /// have not started.
    #[cfg(test)]
    pub(crate) async fn slots_held_on_line(&self, line_id: &str, now: Instant) -> usize {
        let mut state = self.state.write().await;
        state.prune_reservations(now);
        state.slots_held_by_others(line_id, "")
    }

    pub async fn remove(&self, call_sid: &str) {
        self.state.write().await.sessions.remove(call_sid);
    }

    pub async fn send(&self, call_sid: &str, frame: String) -> bool {
        let control_tx = self
            .state
            .read()
            .await
            .sessions
            .get(call_sid)
            .map(|(_, control_tx)| control_tx.clone());
        match control_tx {
            Some(control_tx) => control_tx.send(frame).await.is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    pub async fn contains(&self, call_sid: &str) -> bool {
        self.state.read().await.sessions.contains_key(call_sid)
    }

    fn persist_locked(&self, state: &HubState) -> Result<(), String> {
        let Some(journal) = self.journal.as_deref() else {
            return Ok(());
        };
        let path = &journal.path;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("phone-call journal directory failed: {error}"))?;
        }
        let json = serde_json::to_string(&JournalFile {
            intents: state.intents.clone(),
            version: JOURNAL_VERSION,
        })
        .map_err(|error| format!("phone-call journal serialize failed: {error}"))?;
        if json.len() > MAX_JOURNAL_BYTES {
            return Err("phone-call journal exceeds the 8 MiB limit".to_owned());
        }
        let contents = journal
            .cipher
            .seal_text(&json, &journal_context())
            .map_err(|_| "phone-call journal could not be sealed".to_owned())?
            .into_bytes();
        let temp_path = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("phone-call journal temp file failed: {error}"))?;
        if let Err(error) = file.write_all(&contents).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(format!("phone-call journal write failed: {error}"));
        }
        drop(file);
        if let Err(error) = fs::rename(&temp_path, path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("phone-call journal replace failed: {error}"));
        }
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::File::open(parent).and_then(|directory| directory.sync_all()) {
                tracing::warn!(%error, "phone-call journal directory sync failed after atomic replace");
            }
        }
        Ok(())
    }
}

/// Line slots live only in memory, so a restart would free the slot of every
/// outbound call still ringing; a new call could then take it, and the
/// answered call's stream would be refused at its cap check. Give each
/// journaled intent recent enough to still be ringing its slot back for what
/// remains of its ring bound, keyed by its Call SID once it has one and by its
/// intent id before. A call that ended just before the restart holds its slot
/// only until that bound passes.
fn restore_outbound_reservations(state: &mut HubState, now_ms: i64, now: Instant) {
    let bound_ms = i64::try_from(OUTBOUND_RESERVATION_TTL.as_millis()).unwrap_or(i64::MAX);
    for (intent_id, intent) in &state.intents {
        // A clock that stepped back makes an intent look newer, never older.
        let age_ms = now_ms.saturating_sub(intent.created_at_ms).max(0);
        if age_ms >= bound_ms {
            continue;
        }
        let remaining = Duration::from_millis(u64::try_from(bound_ms - age_ms).unwrap_or(0));
        state.reservations.insert(
            intent.call_sid.clone().unwrap_or_else(|| intent_id.clone()),
            SlotReservation {
                line_id: intent.line_id.clone(),
                expires_at: now + remaining,
            },
        );
    }
}

fn prune_expired(state: &mut HubState) -> bool {
    let cutoff = now_millis().saturating_sub(INTENT_RETENTION_MS);
    let expired: Vec<String> = state
        .intents
        .iter()
        .filter_map(|(intent_id, intent)| {
            (intent.created_at_ms < cutoff).then(|| intent_id.clone())
        })
        .collect();
    for intent_id in &expired {
        if let Some(intent) = state.intents.remove(intent_id) {
            state.idempotency.remove(&intent.idempotency_key);
        }
    }
    !expired.is_empty()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use tokio::sync::mpsc;

    use ryu_crypto::{ContentCipher, ContentContext};

    use super::{
        restore_outbound_reservations, CallReservation, HubState, OutboundCallIntent, PhoneCallHub,
        INBOUND_RESERVATION_TTL, JOURNAL_STORE, OUTBOUND_RESERVATION_TTL, SET_ASIDE_FILE_ID,
    };

    #[tokio::test]
    async fn sends_control_only_to_a_registered_live_call() {
        let hub = PhoneCallHub::default();
        let (tx, mut rx) = mpsc::channel(1);
        assert!(
            hub.try_register("CA123".to_owned(), "line".to_owned(), tx, 2)
                .await
        );

        assert!(hub.send("CA123", "{\"type\":\"abort\"}".to_owned()).await);
        assert_eq!(rx.recv().await.as_deref(), Some("{\"type\":\"abort\"}"));
        assert!(!hub.send("CA404", "{}".to_owned()).await);

        hub.remove("CA123").await;
        assert!(!hub.contains("CA123").await);
    }

    #[tokio::test]
    async fn line_concurrency_cap_rejects_calls_beyond_the_limit() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(
            hub.try_register("CA1".into(), "line-a".into(), tx.clone(), 2)
                .await
        );
        assert!(
            hub.try_register("CA2".into(), "line-a".into(), tx.clone(), 2)
                .await
        );
        assert!(
            !hub.try_register("CA3".into(), "line-a".into(), tx.clone(), 2)
                .await,
            "a third simultaneous call must be refused"
        );
        assert!(
            hub.try_register("CB1".into(), "line-b".into(), tx.clone(), 2)
                .await,
            "the cap is per line"
        );
        assert_eq!(hub.slots_held_on_line("line-a", Instant::now()).await, 2);
        hub.remove("CA1").await;
        assert!(hub.try_register("CA3".into(), "line-a".into(), tx, 2).await);
    }

    /// Two webhooks racing for a line's last slot: exactly one is admitted,
    /// before either call's media stream exists.
    #[tokio::test]
    async fn concurrent_admissions_cannot_both_take_the_last_slot() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(hub.try_register("CA1".into(), "line".into(), tx, 2).await);
        let (first, second) = tokio::join!(
            hub.try_reserve("CA2", "line", 2),
            hub.try_reserve("CA3", "line", 2),
        );
        assert!(
            first ^ second,
            "exactly one racing call takes the last slot"
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 2);
        assert!(
            hub.try_reserve(if first { "CA2" } else { "CA3" }, "line", 2)
                .await,
            "a retried webhook for the admitted call keeps its slot"
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 2);
    }

    /// The admitted call's stream takes over its reserved slot without a
    /// second cap check, and its end frees that slot exactly once.
    #[tokio::test]
    async fn reserved_stream_takes_over_its_slot_and_frees_it_once() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(hub.try_reserve("CA1", "line", 2).await);
        assert!(hub.try_reserve("CA2", "line", 2).await);
        assert!(!hub.try_reserve("CA3", "line", 2).await);

        assert!(
            hub.try_register("CA1".into(), "line".into(), tx.clone(), 2)
                .await,
            "the reserved call is not refused by its own reservation"
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 2);
        assert!(!hub.try_reserve("CA3", "line", 2).await);

        hub.remove("CA1").await;
        hub.remove("CA1").await;
        assert_eq!(
            hub.slots_held_on_line("line", Instant::now()).await,
            1,
            "a repeated end must not free another call's slot"
        );
        assert!(hub.try_reserve("CA3", "line", 2).await);
        assert!(!hub.try_reserve("CA4", "line", 2).await);
    }

    /// A call whose stream never starts gives its slot back after the bound;
    /// its late stream then has to find a free slot like any other stream.
    #[tokio::test]
    async fn lapsed_reservation_frees_the_slot() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        let now = Instant::now();
        let lapsed = now + INBOUND_RESERVATION_TTL + Duration::from_secs(1);
        assert!(hub.try_reserve_at("CA1", "line", 1, now).await);
        assert!(!hub.try_reserve_at("CA2", "line", 1, now).await);
        assert_eq!(hub.slots_held_on_line("line", lapsed).await, 0);
        assert!(hub.try_reserve_at("CA2", "line", 1, lapsed).await);
        assert!(
            !hub.try_register("CA1".into(), "line".into(), tx, 1).await,
            "a stream whose reservation lapsed is checked against the cap"
        );
    }

    /// Once the stream registers, the reservation's bound no longer applies:
    /// the live call keeps the slot until it ends.
    #[tokio::test]
    async fn registered_call_outlives_its_reservation_bound() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        let now = Instant::now();
        let lapsed = now + INBOUND_RESERVATION_TTL + Duration::from_secs(1);
        assert!(hub.try_reserve_at("CA1", "line", 1, now).await);
        assert!(hub.try_register("CA1".into(), "line".into(), tx, 1).await);
        assert!(!hub.try_reserve_at("CA2", "line", 1, lapsed).await);
        hub.remove("CA1").await;
        assert!(hub.try_reserve_at("CA2", "line", 1, lapsed).await);
    }

    async fn request_call(hub: &PhoneCallHub, key: &str, limit: usize) -> CallReservation {
        hub.reserve_outbound(
            key.to_owned(),
            format!("fingerprint-{key}"),
            "line".to_owned(),
            "Confirm Friday".to_owned(),
            limit,
        )
        .await
        .unwrap()
    }

    async fn placed_intent(hub: &PhoneCallHub, key: &str, limit: usize) -> String {
        let CallReservation::Created { intent_id } = request_call(hub, key, limit).await else {
            panic!("a request on a line with a free slot records an intent");
        };
        intent_id
    }

    /// An outbound request on a full line is refused before anything is
    /// recorded, so the provider is never asked to place it.
    #[tokio::test]
    async fn outbound_request_on_a_full_line_is_refused_without_an_intent() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        assert!(hub.try_register("CA1".into(), "line".into(), tx, 1).await);
        assert_eq!(
            request_call(&hub, "request-busy", 1).await,
            CallReservation::LineBusy
        );
        hub.remove("CA1").await;
        assert!(
            matches!(
                request_call(&hub, "request-busy", 1).await,
                CallReservation::Created { .. }
            ),
            "a refused request leaves its idempotency key unused"
        );
    }

    /// Outbound requests and an inbound admission racing for a line's last
    /// slot: exactly one wins, before any call is placed or answered.
    #[tokio::test]
    async fn concurrent_outbound_requests_cannot_both_take_the_last_slot() {
        let hub = PhoneCallHub::default();
        let (first, second, inbound) = tokio::join!(
            request_call(&hub, "request-a", 1),
            request_call(&hub, "request-b", 1),
            hub.try_reserve("CA9", "line", 1),
        );
        let outbound = [&first, &second]
            .into_iter()
            .filter(|reservation| matches!(reservation, CallReservation::Created { .. }))
            .count();
        assert_eq!(
            outbound + usize::from(inbound),
            1,
            "exactly one racing call takes the last slot: {first:?} {second:?} {inbound}"
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 1);
    }

    /// A repeated request reports the recorded call and never takes a second
    /// slot, whether the call is still being placed or already has a Call SID.
    #[tokio::test]
    async fn repeated_outbound_request_keeps_one_slot() {
        let hub = PhoneCallHub::default();
        let intent_id = placed_intent(&hub, "request-1", 2).await;
        assert_eq!(
            request_call(&hub, "request-1", 2).await,
            CallReservation::Pending
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 1);
        assert!(hub.record_call_sid(&intent_id, "CA1").await.unwrap());
        assert_eq!(
            request_call(&hub, "request-1", 2).await,
            CallReservation::Existing {
                call_sid: "CA1".to_owned()
            }
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 1);
    }

    /// The slot follows the placed call to its Call SID, so its media stream
    /// takes the slot over instead of counting the call twice.
    #[tokio::test]
    async fn placed_call_stream_takes_over_its_slot() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        let intent_id = placed_intent(&hub, "request-1", 1).await;
        assert!(hub.record_call_sid(&intent_id, "CA1").await.unwrap());
        assert!(
            hub.record_call_sid(&intent_id, "CA1").await.unwrap(),
            "a repeated binding of the same call is accepted"
        );
        assert!(
            !hub.try_reserve("CA2", "line", 1).await,
            "the ringing call holds the line's only slot"
        );
        assert!(
            hub.try_register("CA1".into(), "line".into(), tx, 1).await,
            "the placed call's stream is not refused by its own slot"
        );
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 1);
        hub.remove("CA1").await;
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 0);
    }

    /// A call the provider refused, or one that ended without a stream, gives
    /// its slot back; a terminal status never takes a live call's slot.
    #[tokio::test]
    async fn refused_or_unanswered_outbound_call_frees_its_slot() {
        let hub = PhoneCallHub::default();
        let (tx, _rx) = mpsc::channel(1);
        let refused = placed_intent(&hub, "request-1", 1).await;
        hub.remove_intent(&refused).await.unwrap();
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 0);

        let unanswered = placed_intent(&hub, "request-2", 1).await;
        assert!(hub.record_call_sid(&unanswered, "CA2").await.unwrap());
        hub.release_reservation("CA2").await;
        assert_eq!(hub.slots_held_on_line("line", Instant::now()).await, 0);

        let answered = placed_intent(&hub, "request-3", 1).await;
        assert!(hub.record_call_sid(&answered, "CA3").await.unwrap());
        assert!(hub.try_register("CA3".into(), "line".into(), tx, 1).await);
        hub.release_reservation("CA3").await;
        assert_eq!(
            hub.slots_held_on_line("line", Instant::now()).await,
            1,
            "a live call keeps its slot until its stream ends"
        );
    }

    /// An outbound call rings far longer than an inbound stream takes to
    /// start, so its slot outlives the inbound bound, yet it still lapses when
    /// the call's terminal status never arrives.
    #[tokio::test]
    async fn lapsed_outbound_reservation_frees_the_slot() {
        let hub = PhoneCallHub::default();
        let intent_id = placed_intent(&hub, "request-1", 1).await;
        assert!(hub.record_call_sid(&intent_id, "CA1").await.unwrap());
        let ringing = Instant::now() + INBOUND_RESERVATION_TTL + Duration::from_secs(1);
        assert_eq!(hub.slots_held_on_line("line", ringing).await, 1);
        let lapsed = Instant::now() + OUTBOUND_RESERVATION_TTL + Duration::from_secs(1);
        assert_eq!(hub.slots_held_on_line("line", lapsed).await, 0);
        assert!(hub.try_reserve_at("CA2", "line", 1, lapsed).await);
    }

    #[tokio::test]
    async fn repeated_outbound_request_returns_pending_or_existing_call() {
        let hub = PhoneCallHub::default();
        let begin = hub
            .reserve_outbound(
                "request-1".to_owned(),
                "fingerprint".to_owned(),
                "main".to_owned(),
                "Confirm Friday".to_owned(),
                2,
            )
            .await
            .unwrap();
        let CallReservation::Created { intent_id } = begin else {
            panic!("first request should create an intent");
        };
        assert_eq!(
            hub.reserve_outbound(
                "request-1".to_owned(),
                "fingerprint".to_owned(),
                "main".to_owned(),
                "Confirm Friday".to_owned(),
                2,
            )
            .await
            .unwrap(),
            CallReservation::Pending
        );
        assert!(hub.record_call_sid(&intent_id, "CA123").await.unwrap());
        assert_eq!(
            hub.get_intent_for_call("CA123")
                .await
                .unwrap()
                .idempotency_key,
            "request-1"
        );
        assert_eq!(
            hub.reserve_outbound(
                "request-1".to_owned(),
                "fingerprint".to_owned(),
                "main".to_owned(),
                "Confirm Friday".to_owned(),
                2,
            )
            .await
            .unwrap(),
            CallReservation::Existing {
                call_sid: "CA123".to_owned()
            }
        );
        assert!(hub.get_intent(&intent_id).await.is_some());
    }

    #[tokio::test]
    async fn outbound_intents_are_consumed_once() {
        let hub = PhoneCallHub::default();
        let CallReservation::Created { intent_id } = hub
            .reserve_outbound(
                "request-2".to_owned(),
                "fingerprint".to_owned(),
                "main".to_owned(),
                "Confirm the appointment".to_owned(),
                2,
            )
            .await
            .unwrap()
        else {
            panic!("first request should create an intent");
        };
        let intent: OutboundCallIntent = hub.get_intent(&intent_id).await.unwrap();
        assert_eq!(intent.line_id, "main");
        assert_eq!(intent.goal, "Confirm the appointment");
        assert!(hub.get_intent("missing").await.is_none());
    }

    #[tokio::test]
    async fn outbound_idempotency_survives_gateway_restart() {
        let directory = std::env::temp_dir().join(format!(
            "ryu-phone-call-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("phone-call-state.json");
        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        let CallReservation::Created { intent_id } = hub
            .reserve_outbound(
                "request-restart-1".to_owned(),
                "fingerprint".to_owned(),
                "main".to_owned(),
                "Confirm Friday".to_owned(),
                2,
            )
            .await
            .unwrap()
        else {
            panic!("first request should create an intent");
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        drop(hub);

        let restarted = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        assert!(restarted.get_intent(&intent_id).await.is_some());
        assert_eq!(
            restarted
                .reserve_outbound(
                    "request-restart-1".to_owned(),
                    "fingerprint".to_owned(),
                    "main".to_owned(),
                    "Confirm Friday".to_owned(),
                    2,
                )
                .await
                .unwrap(),
            CallReservation::Pending
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A restart keeps the slots of outbound calls that may still be ringing,
    /// so a new call cannot take the slot an answered call's stream needs.
    #[tokio::test]
    async fn a_restart_keeps_the_slots_of_outbound_calls_still_ringing() {
        let directory = std::env::temp_dir().join(format!(
            "ryu-phone-call-restart-slots-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("phone-call-state.json");
        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        let placed = placed_intent(&hub, "request-placed", 2).await;
        assert!(hub.record_call_sid(&placed, "CA1").await.unwrap());
        placed_intent(&hub, "request-pending", 2).await;
        drop(hub);

        let restarted = PhoneCallHub::with_journal(Some(path), Ok(test_cipher()));
        assert_eq!(
            restarted.slots_held_on_line("line", Instant::now()).await,
            2
        );
        assert!(
            !restarted.try_reserve("CA9", "line", 2).await,
            "an inbound call cannot take a ringing call's slot"
        );
        assert_eq!(
            request_call(&restarted, "request-new", 2).await,
            CallReservation::LineBusy
        );
        let (tx, _rx) = mpsc::channel(1);
        assert!(
            restarted
                .try_register("CA1".into(), "line".into(), tx, 2)
                .await,
            "the answered call's stream takes over its own slot"
        );
        assert_eq!(
            restarted.slots_held_on_line("line", Instant::now()).await,
            2
        );
        let lapsed = Instant::now() + OUTBOUND_RESERVATION_TTL + Duration::from_secs(1);
        assert_eq!(
            restarted.slots_held_on_line("line", lapsed).await,
            1,
            "only the live call outlives the ring bound"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// Only intents young enough to still be ringing get a slot back, for
    /// what remains of the bound; a clock that stepped back never shortens it.
    #[test]
    fn restored_slots_cover_only_the_rest_of_the_ring_bound() {
        let bound_ms = OUTBOUND_RESERVATION_TTL.as_millis() as i64;
        let now_ms = 10 * bound_ms;
        let intent = |created_at_ms: i64, call_sid: Option<&str>| OutboundCallIntent {
            call_sid: call_sid.map(str::to_owned),
            created_at_ms,
            fingerprint: "fingerprint".to_owned(),
            goal: "Confirm Friday".to_owned(),
            idempotency_key: format!("key-{created_at_ms}"),
            line_id: "line".to_owned(),
        };
        let mut state = HubState::default();
        state
            .intents
            .insert("ringing".to_owned(), intent(now_ms - 10_000, Some("CA1")));
        state
            .intents
            .insert("placing".to_owned(), intent(now_ms - 10_000, None));
        state
            .intents
            .insert("ended".to_owned(), intent(now_ms - bound_ms, Some("CA2")));
        state
            .intents
            .insert("future".to_owned(), intent(now_ms + 5_000, None));
        let now = Instant::now();
        restore_outbound_reservations(&mut state, now_ms, now);

        let mut held: Vec<_> = state
            .reservations
            .iter()
            .map(|(key, slot)| (key.clone(), slot.expires_at - now))
            .collect();
        held.sort();
        assert_eq!(
            held,
            vec![
                (
                    "CA1".to_owned(),
                    OUTBOUND_RESERVATION_TTL - Duration::from_secs(10)
                ),
                ("future".to_owned(), OUTBOUND_RESERVATION_TTL),
                (
                    "placing".to_owned(),
                    OUTBOUND_RESERVATION_TTL - Duration::from_secs(10)
                ),
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_readable_legacy_journal_is_resealed_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temp_directory("permission");
        let path = directory.join("phone-call-state.json");
        let legacy = legacy_journal("request-broad", "Broad goal");
        std::fs::write(&path, &legacy).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        assert!(hub.get_intent("intent-legacy").await.is_some());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("encb:v1:"));
        assert!(!text.contains("Broad goal"));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(quarantined(&directory).is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_untrusted_plaintext_journal_is_set_aside_sealed_not_in_plaintext() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temp_directory("untrusted");
        let path = directory.join("phone-call-state.json");
        let legacy = legacy_journal("request-untrusted", "Untrusted goal +14155550199");
        std::fs::write(&path, &legacy).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        assert!(hub.state.read().await.intents.is_empty());
        let kept = quarantined(&directory);
        assert_eq!(kept.len(), 1);
        assert!(
            ContentCipher::is_sealed_bytes(&kept[0]),
            "set-aside copy is plaintext"
        );
        let text = String::from_utf8_lossy(&kept[0]);
        assert!(!text.contains("Untrusted goal") && !text.contains("+14155550199"));
        let opened = test_cipher()
            .open_bytes(&kept[0], &ContentContext::for_id("file", SET_ASIDE_FILE_ID))
            .unwrap();
        assert_eq!(opened.value, legacy.as_bytes());
        for entry in std::fs::read_dir(&directory).unwrap().flatten() {
            if entry.file_name().to_string_lossy().contains(".unreadable-") {
                let mode = entry.metadata().unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
        }

        // Without a key a corrupt plaintext journal is renamed but narrowed to 0600.
        let unkeyed = temp_directory("untrusted-no-key");
        let corrupt = unkeyed.join("phone-call-state.json");
        std::fs::write(
            &corrupt,
            b"{\"version\":1,\"intents\":{\"x\":{\"goal\":\"tru",
        )
        .unwrap();
        std::fs::set_permissions(&corrupt, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = PhoneCallHub::with_journal(Some(corrupt.clone()), Err("test".to_owned()));
        for entry in std::fs::read_dir(&unkeyed).unwrap().flatten() {
            let mode = entry.metadata().unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{:?}", entry.file_name());
        }
        std::fs::remove_dir_all(directory).unwrap();
        std::fs::remove_dir_all(unkeyed).unwrap();
    }

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[9u8; 32], JOURNAL_STORE)
    }

    fn temp_directory(tag: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "ryu-phone-call-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// A plaintext journal as an older Gateway wrote it, with one fresh intent.
    fn legacy_journal(idempotency_key: &str, goal: &str) -> String {
        serde_json::json!({
            "version": 1,
            "intents": {
                "intent-legacy": {
                    "call_sid": null,
                    "created_at_ms": super::now_millis(),
                    "fingerprint": format!("fingerprint-{idempotency_key}"),
                    "goal": goal,
                    "idempotency_key": idempotency_key,
                    "line_id": "main",
                }
            }
        })
        .to_string()
    }

    fn write_owner_only(path: &std::path::Path, contents: &[u8]) {
        std::fs::write(path, contents).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn quarantined(directory: &std::path::Path) -> Vec<Vec<u8>> {
        std::fs::read_dir(directory)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".unreadable-"))
            .map(|entry| std::fs::read(entry.path()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn the_journal_on_disk_is_sealed_and_holds_no_goal() {
        let directory = temp_directory("sealed");
        let path = directory.join("phone-call-state.json");
        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        placed_intent(&hub, "request-sealed-1", 2).await;
        hub.reserve_outbound(
            "request-sealed-2".to_owned(),
            "fingerprint-2".to_owned(),
            "main".to_owned(),
            "Ask Dr. Example about the biopsy results; transfer to +14155550111".to_owned(),
            2,
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("encb:v1:"), "the journal is not sealed");
        for needle in ["biopsy", "+14155550111", "request-sealed-2", "intents"] {
            assert!(!text.contains(needle), "{needle} is plaintext on disk");
        }
        // Another key cannot open it: it is moved aside, never overwritten.
        let other = ContentCipher::from_root(&[8u8; 32], JOURNAL_STORE);
        let stranger = PhoneCallHub::with_journal(Some(path.clone()), Ok(other));
        assert!(stranger.state.read().await.intents.is_empty());
        assert_eq!(quarantined(&directory), vec![text.into_bytes()]);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn a_legacy_plaintext_journal_is_read_and_resealed() {
        let directory = temp_directory("legacy");
        let path = directory.join("phone-call-state.json");
        write_owner_only(
            &path,
            legacy_journal("request-legacy", "Legacy goal").as_bytes(),
        );

        let hub = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        let intent = hub.get_intent("intent-legacy").await.unwrap();
        assert_eq!(intent.goal, "Legacy goal");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("encb:v1:"));
        assert!(!text.contains("Legacy goal"));
        // The idempotency record survived the reseal.
        let again = PhoneCallHub::with_journal(Some(path.clone()), Ok(test_cipher()));
        assert_eq!(
            request_call(&again, "request-legacy", 2).await,
            CallReservation::Pending
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn without_a_key_the_journal_is_read_but_never_written() {
        let directory = temp_directory("no-key");
        let path = directory.join("phone-call-state.json");
        let legacy = legacy_journal("request-no-key", "No key goal");
        write_owner_only(&path, legacy.as_bytes());

        let hub = PhoneCallHub::with_journal(Some(path.clone()), Err("test".to_owned()));
        assert!(hub.get_intent("intent-legacy").await.is_some());
        placed_intent(&hub, "request-new", 2).await;
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_journal_beside_gateway_toml_moves_once_into_the_target() {
        let directory = temp_directory("move");
        let legacy = directory.join("config").join("phone-call-state.json");
        let target = directory.join("state").join("phone-call-state.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        write_owner_only(&legacy, b"legacy");
        super::move_legacy_journal(&legacy, &target, None);
        assert!(!legacy.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"legacy");
        // A second copy never replaces the journal already in place, and is
        // not left in plaintext beside gateway.toml either.
        let stale = legacy_journal("request-stale", "Stale goal +14155550144");
        write_owner_only(&legacy, stale.as_bytes());
        super::move_legacy_journal(&legacy, &target, Some(&test_cipher()));
        assert_eq!(std::fs::read(&target).unwrap(), b"legacy");
        assert!(
            !legacy.exists(),
            "the stale plaintext copy stayed beside gateway.toml"
        );
        let state_dir = target.parent().unwrap();
        let aside: Vec<Vec<u8>> = std::fs::read_dir(state_dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".superseded-"))
            .map(|entry| std::fs::read(entry.path()).unwrap())
            .collect();
        assert_eq!(aside.len(), 1);
        assert!(ContentCipher::is_sealed_bytes(&aside[0]));
        assert!(!String::from_utf8_lossy(&aside[0]).contains("Stale goal"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_move_and_write_temps_are_swept() {
        let directory = temp_directory("sweep");
        let target = directory.join("phone-call-state.json");
        write_owner_only(&target, b"journal");
        let temp = directory.join("phone-call-state.0123abcd.tmp");
        write_owner_only(&temp, b"{\"goal\":\"plaintext\"}");
        let other = directory.join("other.tmp");
        write_owner_only(&other, b"keep");
        super::sweep_stale_temps(&target);
        assert!(!temp.exists());
        assert!(other.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"journal");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
