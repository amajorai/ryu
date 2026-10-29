//! Credential-free lifecycle markers prevent installation retries after a
//! stopped task or a Core restart. Provider handles live in separate leases.
//!
//! Retention: a marker is never dropped while its conversation exists, because
//! it is also the immutable environment binding and the fail-closed "this
//! conversation is cloud-bound" signal. Markers older than
//! [`RETENTION_SECONDS`] that hold no live slot or lease are flagged retired.
//! Retired markers still bind their conversation (every read below sees them),
//! but they no longer count toward [`LIVE_LIMIT`]. A marker is removed only
//! when its conversation is deleted.
//!
//! Compatibility: `cloud-task-bindings.json` keeps the exact shape earlier
//! Core releases parse strictly (`deny_unknown_fields`), and retired markers
//! stay in it, so an older Core still loads the file and still sees every
//! binding. Retention metadata (`updatedAt` and the retired flag) lives only in
//! `cloud-task-binding-retention.json`, which older Core ignores. Reads
//! (`contains_conversation`, `lookup`) never depend on that file.
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

/// Terminal markers stop counting toward the live cap after this long. Every
/// workspace has an absolute 30-minute lifetime, so a marker this old can no
/// longer back a running task.
pub(super) const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Node-wide cap on live (not yet retired) markers.
const LIVE_LIMIT: usize = 10000;
/// Status of a marker whose conversation was deleted. It is sticky: setup or
/// stop finishing later cannot overwrite it, and the recovery sweep removes the
/// marker once no slot or lease remains. Older Core reads it as a terminal
/// (stopped) status.
pub(super) const DELETED: &str = "deleted";
const BINDINGS_FILE: &str = "cloud-task-bindings.json";
const RETENTION_FILE: &str = "cloud-task-binding-retention.json";
const FILE_LIMIT: u64 = 8_388_608;

static LOCK: Mutex<()> = Mutex::new(());
type Key = (String, String);

/// The binding marker. Its shape is frozen: earlier Core parses it with
/// `deny_unknown_fields`, so new per-marker data belongs in [`Meta`].
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    environment_id: String,
    revision: Option<u64>,
    status: String,
}
/// `cloud-task-bindings.json`. Frozen like [`Record`].
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    schema_version: u8,
    owners: BTreeMap<String, BTreeMap<String, Record>>,
}
/// Retention metadata for one marker.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    /// Unix seconds of the last lifecycle change.
    updated_at: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    retired: bool,
}
/// `cloud-task-binding-retention.json`. Tolerates unknown fields so later
/// releases can extend it without breaking this one.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Retention {
    schema_version: u8,
    #[serde(default)]
    markers: BTreeMap<String, BTreeMap<String, Meta>>,
    /// Why a stopped task stopped (`balance`, `budget`, `accounting`, `user`,
    /// …), by owner and conversation. Kept here, not in the frozen
    /// [`Record`], so older Core still parses the bindings file.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    stop_reasons: BTreeMap<String, BTreeMap<String, String>>,
}
/// Both files, operated on together under [`LOCK`].
#[derive(Default)]
struct Bindings {
    store: Store,
    retention: Retention,
}

/// Outcome of [`create`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Created {
    New,
    /// The caller already holds a marker for this conversation.
    Exists,
    /// [`LIVE_LIMIT`] live markers exist even after retiring aged ones.
    LimitReached,
}

impl Bindings {
    fn meta(&self, owner: &str, conversation: &str) -> Option<&Meta> {
        self.retention
            .markers
            .get(owner)
            .and_then(|markers| markers.get(conversation))
    }
    fn set_meta(&mut self, owner: &str, conversation: &str, meta: Meta) {
        self.retention
            .markers
            .entry(owner.into())
            .or_default()
            .insert(conversation.into(), meta);
    }
    fn set_stop_reason(&mut self, owner: &str, conversation: &str, reason: Option<&str>) {
        match reason {
            Some(reason) => {
                self.retention
                    .stop_reasons
                    .entry(owner.into())
                    .or_default()
                    .insert(conversation.into(), reason.into());
            }
            None => {
                if let Some(reasons) = self.retention.stop_reasons.get_mut(owner) {
                    reasons.remove(conversation);
                    if reasons.is_empty() {
                        self.retention.stop_reasons.remove(owner);
                    }
                }
            }
        }
    }
    fn stop_reason(&self, owner: &str, conversation: &str) -> Option<String> {
        self.retention
            .stop_reasons
            .get(owner)
            .and_then(|reasons| reasons.get(conversation))
            .cloned()
    }
    fn remove_meta(&mut self, owner: &str, conversation: &str) -> bool {
        self.set_stop_reason(owner, conversation, None);
        let Some(markers) = self.retention.markers.get_mut(owner) else {
            return false;
        };
        let removed = markers.remove(conversation).is_some();
        if markers.is_empty() {
            self.retention.markers.remove(owner);
        }
        removed
    }
    fn is_retired(&self, owner: &str, conversation: &str) -> bool {
        self.meta(owner, conversation)
            .is_some_and(|meta| meta.retired)
    }
    fn live_count(&self) -> usize {
        self.store
            .owners
            .iter()
            .flat_map(|(owner, records)| {
                records
                    .keys()
                    .map(move |conversation| (owner, conversation))
            })
            .filter(|(owner, conversation)| !self.is_retired(owner, conversation))
            .count()
    }
    fn holds(&self, owner: &str, conversation: &str) -> bool {
        self.store
            .owners
            .get(owner)
            .is_some_and(|records| records.contains_key(conversation))
    }
    fn create(
        &mut self,
        owner: &str,
        conversation: &str,
        environment: &str,
        now: u64,
        limit: usize,
        protected: impl FnOnce() -> HashSet<Key>,
    ) -> Created {
        if self.holds(owner, conversation) {
            return Created::Exists;
        }
        if self.live_count() >= limit {
            self.retire_aged(now, &protected());
            if self.live_count() >= limit {
                return Created::LimitReached;
            }
        }
        self.store.owners.entry(owner.into()).or_default().insert(
            conversation.into(),
            Record {
                environment_id: environment.into(),
                revision: None,
                status: "preparing".into(),
            },
        );
        // Replaces any stale metadata left for a reused id.
        self.set_stop_reason(owner, conversation, None);
        self.set_meta(
            owner,
            conversation,
            Meta {
                updated_at: now,
                retired: false,
            },
        );
        Created::New
    }
    fn mark(
        &mut self,
        owner: &str,
        conversation: &str,
        status: &str,
        revision: Option<u64>,
        now: u64,
    ) -> bool {
        let Some(record) = self
            .store
            .owners
            .get_mut(owner)
            .and_then(|records| records.get_mut(conversation))
        else {
            return false;
        };
        if record.status != DELETED {
            record.status = status.into();
        }
        if revision.is_some() {
            record.revision = revision;
        }
        // A retired marker keeps its age; it stays out of the live count.
        if !self.is_retired(owner, conversation) {
            self.set_meta(
                owner,
                conversation,
                Meta {
                    updated_at: now,
                    retired: false,
                },
            );
        }
        true
    }
    /// Flag live markers older than the retention window, and not in
    /// `protected` (live slots and leases), retired. Returns whether the
    /// retention metadata changed, including stamping markers that have none
    /// (written before retention existed, or by an older Core) and dropping
    /// metadata whose marker is gone.
    fn retire_aged(&mut self, now: u64, protected: &HashSet<Key>) -> bool {
        let mut changed = false;
        let mut updates = Vec::new();
        for (owner, records) in &self.store.owners {
            for (conversation, record) in records {
                let meta = match self.meta(owner, conversation) {
                    None => Meta {
                        updated_at: now,
                        retired: false,
                    },
                    Some(meta) if meta.retired => continue,
                    Some(meta) => {
                        let key = (owner.clone(), conversation.clone());
                        if record.status == DELETED
                            || meta.updated_at.saturating_add(RETENTION_SECONDS) > now
                            || protected.contains(&key)
                        {
                            continue;
                        }
                        Meta {
                            retired: true,
                            ..*meta
                        }
                    }
                };
                updates.push((owner.clone(), conversation.clone(), meta));
            }
        }
        for (owner, conversation, meta) in updates {
            self.set_meta(&owner, &conversation, meta);
            changed = true;
        }
        let orphaned: Vec<Key> = self
            .retention
            .markers
            .iter()
            .flat_map(|(owner, markers)| {
                markers
                    .keys()
                    .map(move |conversation| (owner.clone(), conversation.clone()))
            })
            .filter(|(owner, conversation)| !self.holds(owner, conversation))
            .collect();
        for (owner, conversation) in orphaned {
            changed |= self.remove_meta(&owner, &conversation);
        }
        changed
    }
    #[cfg(test)]
    fn lookup(&self, owner: &str, conversation: &str) -> Option<(String, String)> {
        lookup_in(&self.store, owner, conversation)
    }
    #[cfg(test)]
    fn contains_conversation(&self, conversation: &str) -> bool {
        contains_in(&self.store, conversation)
    }
    /// Mark every owner's marker for `conversation` deleted. Returns the owners.
    fn mark_deleted(&mut self, conversation: &str, now: u64) -> Vec<String> {
        let mut owners = Vec::new();
        for (owner, records) in &mut self.store.owners {
            if let Some(record) = records.get_mut(conversation) {
                record.status = DELETED.into();
                owners.push(owner.clone());
            }
        }
        for owner in &owners {
            if !self.is_retired(owner, conversation) {
                self.set_meta(
                    owner,
                    conversation,
                    Meta {
                        updated_at: now,
                        retired: false,
                    },
                );
            }
        }
        owners
    }
    fn deleted(&self) -> Vec<Key> {
        self.store
            .owners
            .iter()
            .flat_map(|(owner, records)| {
                records
                    .iter()
                    .filter(|(_, record)| record.status == DELETED)
                    .map(move |(conversation, _)| (owner.clone(), conversation.clone()))
            })
            .collect()
    }
    /// Remove one owner's deleted marker. A marker that is not deleted stays.
    fn remove_deleted(&mut self, owner: &str, conversation: &str) -> bool {
        let Some(records) = self.store.owners.get_mut(owner) else {
            return false;
        };
        if !records
            .get(conversation)
            .is_some_and(|record| record.status == DELETED)
        {
            return false;
        }
        records.remove(conversation);
        if records.is_empty() {
            self.store.owners.remove(owner);
        }
        self.remove_meta(owner, conversation);
        true
    }
}

fn lookup_in(store: &Store, owner: &str, conversation: &str) -> Option<(String, String)> {
    store
        .owners
        .get(owner)
        .and_then(|records| records.get(conversation))
        .map(|record| (record.environment_id.clone(), record.status.clone()))
}
fn contains_in(store: &Store, conversation: &str) -> bool {
    store
        .owners
        .values()
        .any(|records| records.contains_key(conversation))
}

fn now() -> u64 {
    super::now().unwrap_or(0)
}
/// Read a bounded state file; `None` when it does not exist.
fn read_state(name: &str) -> Result<Option<Vec<u8>>> {
    let path = crate::paths::state_path(name);
    match std::fs::metadata(&path) {
        Ok(meta) => ensure!(
            meta.is_file() && meta.len() <= FILE_LIMIT,
            "Cloud task bindings exceeded limits"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    Ok(Some(std::fs::read(path)?))
}
fn write_state(name: &str, bytes: &[u8]) -> Result<()> {
    let directory: PathBuf = crate::paths::state_dir();
    std::fs::create_dir_all(&directory)?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(name))
        .map_err(|_| anyhow!("Cloud task binding persistence failed"))?;
    Ok(())
}
fn load() -> Result<Store> {
    let Some(bytes) = read_state(BINDINGS_FILE)? else {
        return Ok(Store {
            schema_version: 1,
            ..Default::default()
        });
    };
    let store: Store = serde_json::from_slice(&bytes)?;
    ensure!(
        store.schema_version == 1,
        "Unsupported cloud task bindings schema"
    );
    Ok(store)
}
fn save(store: &Store) -> Result<()> {
    write_state(BINDINGS_FILE, &serde_json::to_vec(store)?)
}
/// Retention metadata only decides what counts toward the cap, never what is
/// bound, so an unreadable file starts over: every marker is stamped on the
/// next pass and ages from then.
fn load_retention() -> Retention {
    let fresh = || Retention {
        schema_version: 1,
        ..Default::default()
    };
    let parsed = read_state(RETENTION_FILE).and_then(|bytes| {
        bytes
            .map(|bytes| serde_json::from_slice::<Retention>(&bytes).map_err(Into::into))
            .transpose()
    });
    match parsed {
        Ok(Some(retention)) if retention.schema_version == 1 => retention,
        Ok(None) => fresh(),
        Ok(Some(_)) | Err(_) => {
            tracing::warn!("Cloud task binding retention metadata is unreadable; starting over");
            fresh()
        }
    }
}
fn save_retention(retention: &Retention) -> Result<()> {
    write_state(RETENTION_FILE, &serde_json::to_vec(retention)?)
}
/// Bindings are saved first; a retention write that fails after them only
/// leaves a marker unstamped or younger-looking, which the next pass repairs.
fn persist_retention(retention: &Retention) {
    if let Err(error) = save_retention(retention) {
        tracing::warn!(error = %error, "Cloud task binding retention metadata could not be saved");
    }
}
fn load_bindings() -> Result<Bindings> {
    Ok(Bindings {
        store: load()?,
        retention: load_retention(),
    })
}
fn locked<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let _lock = LOCK
        .lock()
        .map_err(|_| anyhow!("Cloud task bindings unavailable"))?;
    operation()
}
/// Record a new binding. At the live cap, aged markers outside `protected`
/// (live slots and leases, computed only then) are retired first.
pub(super) fn create(
    owner: &str,
    conversation: &str,
    environment: &str,
    protected: impl FnOnce() -> HashSet<Key>,
) -> Result<Created> {
    locked(|| {
        let mut bindings = load_bindings()?;
        let created = bindings.create(
            owner,
            conversation,
            environment,
            now(),
            LIVE_LIMIT,
            protected,
        );
        if created == Created::New {
            save(&bindings.store)?;
        }
        if created != Created::Exists {
            persist_retention(&bindings.retention);
        }
        Ok(created)
    })
}
pub(super) fn mark(
    owner: &str,
    conversation: &str,
    status: &str,
    revision: Option<u64>,
) -> Result<()> {
    locked(|| {
        let mut bindings = load_bindings()?;
        if bindings.mark(owner, conversation, status, revision, now()) {
            save(&bindings.store)?;
            persist_retention(&bindings.retention);
        }
        Ok(())
    })
}
/// Mark a task stopped and record why (a kill verdict or the user's Stop).
pub(super) fn mark_stopped(owner: &str, conversation: &str, reason: &str) -> Result<()> {
    locked(|| {
        let mut bindings = load_bindings()?;
        if bindings.mark(owner, conversation, "stopped", None, now()) {
            bindings.set_stop_reason(owner, conversation, Some(reason));
            save(&bindings.store)?;
            persist_retention(&bindings.retention);
        }
        Ok(())
    })
}
/// Why a stopped task stopped, when recorded.
pub(super) fn stop_reason(owner: &str, conversation: &str) -> Result<Option<String>> {
    locked(|| {
        Ok(Bindings {
            retention: load_retention(),
            ..Default::default()
        }
        .stop_reason(owner, conversation))
    })
}
/// Drop a binding that is still `preparing` (setup never got a workspace, for
/// example no Box capacity), so the conversation can retry. Any other status
/// stays.
pub(super) fn unbind_preparing(owner: &str, conversation: &str) -> Result<()> {
    locked(|| {
        let mut bindings = load_bindings()?;
        let Some(records) = bindings.store.owners.get_mut(owner) else {
            return Ok(());
        };
        if !records
            .get(conversation)
            .is_some_and(|record| record.status == "preparing")
        {
            return Ok(());
        }
        records.remove(conversation);
        if records.is_empty() {
            bindings.store.owners.remove(owner);
        }
        bindings.remove_meta(owner, conversation);
        save(&bindings.store)?;
        persist_retention(&bindings.retention);
        Ok(())
    })
}
pub(super) fn contains_conversation(conversation: &str) -> Result<bool> {
    locked(|| Ok(contains_in(&load()?, conversation)))
}
pub(super) fn lookup(owner: &str, conversation: &str) -> Result<Option<(String, String)>> {
    locked(|| Ok(lookup_in(&load()?, owner, conversation)))
}
/// The retention pass the recovery sweep runs. It writes only the retention
/// file; the bindings file is untouched.
pub(super) fn retire_aged(protected: &HashSet<Key>) -> Result<()> {
    locked(|| {
        let mut bindings = load_bindings()?;
        if bindings.retire_aged(now(), protected) {
            save_retention(&bindings.retention)?;
        }
        Ok(())
    })
}
/// The conversation was deleted: mark its markers so nothing can use or set
/// it up again, and return the owners whose slots and leases need releasing.
pub(super) fn mark_deleted(conversation: &str) -> Result<Vec<String>> {
    locked(|| {
        let mut bindings = load_bindings()?;
        let owners = bindings.mark_deleted(conversation, now());
        if !owners.is_empty() {
            save(&bindings.store)?;
            persist_retention(&bindings.retention);
        }
        Ok(owners)
    })
}
/// Every marker still waiting for its deleted conversation to be released.
pub(super) fn deleted() -> Result<Vec<Key>> {
    locked(|| {
        Ok(Bindings {
            store: load()?,
            ..Default::default()
        }
        .deleted())
    })
}
/// Drop a deleted conversation's marker once its slot and leases are gone.
pub(super) fn remove_deleted(owner: &str, conversation: &str) -> Result<()> {
    locked(|| {
        let mut bindings = load_bindings()?;
        if bindings.remove_deleted(owner, conversation) {
            save(&bindings.store)?;
            persist_retention(&bindings.retention);
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Bindings {
        Bindings {
            store: Store {
                schema_version: 1,
                ..Default::default()
            },
            retention: Retention {
                schema_version: 1,
                ..Default::default()
            },
        }
    }
    fn none() -> HashSet<Key> {
        HashSet::new()
    }
    /// What this build writes must still load in the previous Core, which
    /// parses the bindings file with these exact strict structs.
    fn reload(bindings: &Bindings) -> Bindings {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct PreviousRecord {
            environment_id: String,
            revision: Option<u64>,
            status: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct PreviousStore {
            schema_version: u8,
            owners: BTreeMap<String, BTreeMap<String, PreviousRecord>>,
        }
        let store = serde_json::to_vec(&bindings.store).unwrap();
        serde_json::from_slice::<PreviousStore>(&store)
            .expect("the bindings file stays readable by the previous Core");
        Bindings {
            store: serde_json::from_slice(&store).unwrap(),
            retention: serde_json::from_slice(&serde_json::to_vec(&bindings.retention).unwrap())
                .unwrap(),
        }
    }
    const DAY: u64 = 24 * 60 * 60;

    #[test]
    fn aged_terminal_markers_retire_but_keep_the_binding() {
        let mut store = store();
        assert_eq!(
            store.create("o", "c1", "env", 1_000, 10, none),
            Created::New
        );
        assert!(store.mark("o", "c1", "stopped", Some(3), 1_000));
        assert!(!store.retire_aged(1_000 + RETENTION_SECONDS - 1, &none()));
        assert_eq!(store.live_count(), 1);
        assert!(store.retire_aged(1_000 + RETENTION_SECONDS, &none()));
        assert_eq!(store.live_count(), 0);
        // Still bound: same environment, same final state, cannot be recreated.
        assert!(store.contains_conversation("c1"));
        assert_eq!(
            store.lookup("o", "c1"),
            Some(("env".into(), "stopped".into()))
        );
        assert_eq!(
            store.create("o", "c1", "other", 1_000 + RETENTION_SECONDS, 10, none),
            Created::Exists
        );
        let reloaded = reload(&store);
        assert!(reloaded.contains_conversation("c1"));
        assert_eq!(reloaded.live_count(), 0, "retirement survives a reload");
        // An older Core reading only the bindings file still sees the binding.
        assert!(contains_in(&reloaded.store, "c1"));
    }

    #[test]
    fn live_slots_and_leases_are_never_retired() {
        let mut store = store();
        store.create("o", "live", "env", 0, 10, none);
        store.create("o", "leased", "env", 0, 10, none);
        let protected: HashSet<Key> = [
            ("o".to_owned(), "live".to_owned()),
            ("o".to_owned(), "leased".to_owned()),
        ]
        .into();
        assert!(!store.retire_aged(365 * DAY, &protected));
        assert_eq!(store.live_count(), 2);
    }

    #[test]
    fn the_cap_counts_only_live_markers_and_retires_before_refusing() {
        let mut store = store();
        for index in 0..3 {
            let conversation = format!("c{index}");
            assert_eq!(
                store.create("o", &conversation, "env", 0, 3, none),
                Created::New
            );
            store.mark("o", &conversation, "stopped", None, 0);
        }
        // Full and nothing aged yet: refused, and nothing was dropped.
        assert_eq!(
            store.create("o", "fresh", "env", DAY, 3, none),
            Created::LimitReached
        );
        assert_eq!(store.live_count(), 3);
        // Once the terminal markers age out, the next create retires them.
        let later = RETENTION_SECONDS + 1;
        assert_eq!(
            store.create("o", "fresh", "env", later, 3, none),
            Created::New
        );
        assert_eq!(store.live_count(), 1);
        assert!((0..3).all(|index| store.contains_conversation(&format!("c{index}"))));
        // A protected marker stays live, and still counts.
        let mut full = super::tests::store();
        for index in 0..3 {
            full.create("o", &format!("c{index}"), "env", 0, 3, none);
        }
        let protected = || HashSet::from([("o".to_owned(), "c0".to_owned())]);
        assert_eq!(
            full.create("o", "x", "env", later, 3, protected),
            Created::New
        );
        assert_eq!(full.live_count(), 2);
    }

    #[test]
    fn cloud_stop_reason_lives_in_retention_and_never_in_the_frozen_record() {
        let mut bindings = store();
        assert_eq!(
            bindings.create("o", "c", "env", 1, LIVE_LIMIT, none),
            Created::New
        );
        assert!(bindings.mark("o", "c", "stopped", None, 2));
        bindings.set_stop_reason("o", "c", Some("balance"));
        assert_eq!(bindings.stop_reason("o", "c").as_deref(), Some("balance"));
        // The bindings file keeps the previous Core's strict shape.
        let reloaded = reload(&bindings);
        let retention = serde_json::to_vec(&bindings.retention).unwrap();
        let parsed: Retention = serde_json::from_slice(&retention).unwrap();
        assert_eq!(
            parsed.stop_reasons["o"]["c"], "balance",
            "the reason survives a reload"
        );
        assert_eq!(reloaded.lookup("o", "c").unwrap().1, "stopped");
        // A retention file from before stop reasons still loads.
        let older: Retention = serde_json::from_str(r#"{"schemaVersion":1,"markers":{}}"#).unwrap();
        assert!(older.stop_reasons.is_empty());
        // Deleting the marker drops its reason with it.
        bindings.mark_deleted("c", 3);
        assert!(bindings.remove_deleted("o", "c"));
        assert_eq!(bindings.stop_reason("o", "c"), None);
        // A new binding with the same id starts without a stale reason.
        bindings.set_stop_reason("o", "c", Some("user"));
        assert_eq!(
            bindings.create("o", "c", "env", 4, LIVE_LIMIT, none),
            Created::New
        );
        assert_eq!(bindings.stop_reason("o", "c"), None);
    }

    #[test]
    fn legacy_markers_are_stamped_then_age_from_the_upgrade() {
        let legacy = r#"{"schemaVersion":1,"owners":{"o":{"c":{"environmentId":"env","revision":1,"status":"stopped"}}}}"#;
        let mut store = Bindings {
            store: serde_json::from_str(legacy).unwrap(),
            retention: Retention {
                schema_version: 1,
                ..Default::default()
            },
        };
        assert!(store.retire_aged(50 * DAY, &none()));
        assert_eq!(store.live_count(), 1, "stamped, not retired, on first pass");
        assert!(store.retire_aged(50 * DAY + RETENTION_SECONDS, &none()));
        assert_eq!(store.live_count(), 0);
        // Stamping and retiring never change the bindings file.
        assert_eq!(serde_json::to_string(&store.store).unwrap(), legacy);
    }

    #[test]
    fn retention_metadata_never_reaches_the_bindings_file() {
        let mut store = store();
        store.create("o", "a", "env", 0, 10, none);
        store.create("o", "b", "env", 0, 10, none);
        store.mark("o", "a", "ready", Some(1), 5);
        store.mark_deleted("b", 6);
        store.retire_aged(RETENTION_SECONDS + 10, &none());
        let json = serde_json::to_string(&store.store).unwrap();
        assert!(!json.contains("updatedAt") && !json.contains("retired"));
        // reload() parses it with the previous Core's strict structs.
        let reloaded = reload(&store);
        assert_eq!(reloaded.lookup("o", "b").unwrap().1, DELETED);
        assert!(reloaded.is_retired("o", "a"));
        // Metadata for a marker that no longer exists is dropped, and an older
        // Core recreating the id later starts it live again.
        let mut orphaned = reload(&store);
        orphaned.store.owners.get_mut("o").unwrap().remove("a");
        assert!(orphaned.retire_aged(RETENTION_SECONDS + 20, &none()));
        assert!(orphaned.meta("o", "a").is_none());
    }

    #[test]
    fn deleting_a_conversation_is_sticky_until_its_marker_is_removed() {
        let mut store = store();
        store.create("o", "gone", "env", 0, 10, none);
        store.create("o", "old", "env", 0, 10, none);
        store.create("o", "kept", "env", 0, 10, none);
        store.retire_aged(
            RETENTION_SECONDS,
            &HashSet::from([("o".into(), "gone".into()), ("o".into(), "kept".into())]),
        );
        assert!(store.is_retired("o", "old"));
        assert_eq!(store.mark_deleted("gone", 5), vec!["o".to_owned()]);
        assert_eq!(store.mark_deleted("old", 5), vec!["o".to_owned()]);
        // Setup finishing after the delete cannot revive the marker.
        store.mark("o", "gone", "ready", Some(2), 6);
        assert_eq!(store.lookup("o", "gone").unwrap().1, DELETED);
        // Deleted markers are never retired; they still bind until removed.
        assert!(!store.retire_aged(
            10 * RETENTION_SECONDS,
            &HashSet::from([("o".into(), "kept".into())])
        ));
        assert_eq!(store.lookup("o", "gone").unwrap().1, DELETED);
        let mut deleted = store.deleted();
        deleted.sort();
        assert_eq!(
            deleted,
            vec![("o".into(), "gone".into()), ("o".into(), "old".into())]
        );
        assert!(!store.remove_deleted("o", "kept"));
        assert!(store.remove_deleted("o", "gone"));
        assert!(store.remove_deleted("o", "old"));
        assert!(!store.contains_conversation("gone"));
        assert!(!store.contains_conversation("old"));
        assert!(store.contains_conversation("kept"));
        assert!(store.meta("o", "old").is_none());
        // The same id can now start over as a new, live conversation.
        assert_eq!(store.create("o", "old", "env", 7, 10, none), Created::New);
        assert!(!store.is_retired("o", "old"));
    }
}
