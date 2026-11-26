//! Where operation records are kept: one checkpoint per operation in the
//! `operations` namespace of a [`ryu_durable::CheckpointStore`], so every write
//! is atomic. Core's own store seals each record like other workflow state.

use std::sync::Arc;

use ryu_durable::{CheckpointError, CheckpointStore};

use super::record::OperationRecord;

/// The folder under the node's state directory, and the record kind the
/// sealing codec binds each file to.
const NAMESPACE: &str = "operations";
const SEALED_KIND: &str = "operation";

/// Finished records are kept this long.
pub const RETENTION_DAYS: i64 = 30;
/// At most this many finished records are kept.
pub const RETENTION_ENTRIES: usize = 500;

/// A typed handle over the checkpoint store holding operation records.
#[derive(Debug, Clone)]
pub struct OperationStore {
    backend: Arc<dyn CheckpointStore>,
}

impl OperationStore {
    /// A store over any checkpoint backend (tests pass a plain file store or a
    /// memory store).
    pub fn new(backend: Arc<dyn CheckpointStore>) -> Self {
        Self { backend }
    }

    /// The node's own store: `<data dir>/state/operations/<id>.json`, each
    /// file sealed under the workflow-state key. Fails without that key, so a
    /// record is never written in plain text.
    pub fn open_default() -> std::io::Result<Self> {
        let store =
            crate::workflow::store::sealed_store(crate::paths::state_path(NAMESPACE), SEALED_KIND)?;
        Ok(Self::new(Arc::new(store)))
    }

    /// Create or replace a record.
    pub async fn save(&self, record: &OperationRecord) -> Result<(), CheckpointError> {
        ryu_durable::save(self.backend.as_ref(), &record.id, record).await
    }

    /// Load one record; `None` when it does not exist.
    pub async fn load(&self, id: &str) -> Result<Option<OperationRecord>, CheckpointError> {
        ryu_durable::load(self.backend.as_ref(), id).await
    }

    /// Remove one record, returning whether it existed.
    pub async fn delete(&self, id: &str) -> Result<bool, CheckpointError> {
        self.backend.delete(id).await
    }

    /// Every record that opens, oldest first. A record that does not open (a
    /// damaged file, another key) is skipped and counted in the log, so one bad
    /// file never hides the rest.
    pub async fn load_all(&self) -> Result<Vec<OperationRecord>, CheckpointError> {
        let mut records = Vec::new();
        let mut unreadable = 0_usize;
        for id in self.backend.list().await? {
            match self.load(&id).await {
                Ok(Some(record)) => records.push(record),
                Ok(None) => {}
                Err(_) => unreadable += 1,
            }
        }
        if unreadable > 0 {
            tracing::warn!(
                unreadable,
                "operation records that do not open were skipped"
            );
        }
        records.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(records)
    }
}

/// The ids of the finished records the retention rule drops: every one that
/// settled more than [`RETENTION_DAYS`] before `now`, and the oldest beyond the
/// newest [`RETENTION_ENTRIES`]. Active records are never dropped.
pub fn expired_ids<'a>(
    records: impl IntoIterator<Item = &'a OperationRecord>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<String> {
    let cutoff = now - chrono::Duration::days(RETENTION_DAYS);
    let mut finished: Vec<&OperationRecord> = records
        .into_iter()
        .filter(|record| !record.status.is_active())
        .collect();
    // Newest first, so the entries past the cap are the oldest.
    finished.sort_by(|a, b| {
        b.settled_at()
            .cmp(a.settled_at())
            .then_with(|| b.id.cmp(&a.id))
    });
    finished
        .into_iter()
        .enumerate()
        .filter(|(index, record)| *index >= RETENTION_ENTRIES || settled_before(record, cutoff))
        .map(|(_, record)| record.id.clone())
        .collect()
}

/// Whether `record` settled before `cutoff`. A time that does not parse keeps
/// the record: it is dropped by the entry cap instead.
fn settled_before(record: &OperationRecord, cutoff: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(record.settled_at())
        .map(|settled| settled.with_timezone(&chrono::Utc) < cutoff)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::super::record::OperationStatus;
    use super::super::test_support::sample;
    use super::*;

    fn finished(id: &str, completed_at: &str) -> OperationRecord {
        let mut record = sample(id, OperationStatus::Succeeded);
        record.completed_at = Some(completed_at.to_owned());
        record
    }

    fn at(text: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[tokio::test]
    async fn a_record_round_trips_through_the_file_store_and_a_fresh_handle() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            OperationStore::new(Arc::new(ryu_durable::FileCheckpointStore::new(dir.path())));
        let record = sample("op_round_trip", OperationStatus::Running);
        store.save(&record).await.unwrap();
        assert_eq!(
            store.load("op_round_trip").await.unwrap(),
            Some(record.clone())
        );

        // A second handle on the same folder sees the write: this is what a
        // restarted node reads.
        let reopened =
            OperationStore::new(Arc::new(ryu_durable::FileCheckpointStore::new(dir.path())));
        assert_eq!(reopened.load_all().await.unwrap(), vec![record]);
        assert!(reopened.delete("op_round_trip").await.unwrap());
        assert_eq!(reopened.load("op_round_trip").await.unwrap(), None);
        assert!(!reopened.delete("op_round_trip").await.unwrap());
    }

    #[tokio::test]
    async fn load_all_skips_a_file_that_does_not_open_and_sorts_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            OperationStore::new(Arc::new(ryu_durable::FileCheckpointStore::new(dir.path())));
        let mut newer = sample("op_newer", OperationStatus::Queued);
        newer.created_at = "2026-11-18T12:00:00.000Z".to_owned();
        let older = sample("op_older", OperationStatus::Queued);
        store.save(&newer).await.unwrap();
        store.save(&older).await.unwrap();
        std::fs::write(dir.path().join("op_damaged.json"), b"{ not json").unwrap();

        let ids: Vec<String> = store
            .load_all()
            .await
            .unwrap()
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(ids, ["op_older", "op_newer"]);
    }

    #[tokio::test]
    async fn an_id_that_could_leave_the_folder_is_refused() {
        let store = OperationStore::new(Arc::new(ryu_durable::MemoryCheckpointStore::new()));
        assert!(store.load("../secrets").await.is_err());
        let mut record = sample("op_ok", OperationStatus::Queued);
        record.id = "..\\escape".to_owned();
        assert!(store.save(&record).await.is_err());
    }

    #[test]
    fn retention_drops_records_older_than_thirty_days_and_keeps_active_ones() {
        let now = at("2026-11-18T12:00:00.000Z");
        let fresh = finished("op_fresh", "2026-11-17T12:00:00.000Z");
        let edge = finished("op_edge", "2026-10-19T12:00:01.000Z");
        let old = finished("op_old", "2026-10-19T11:59:59.000Z");
        let mut active = sample("op_active", OperationStatus::Running);
        active.updated_at = "2025-01-01T00:00:00.000Z".to_owned();

        assert_eq!(expired_ids([&fresh, &edge, &old, &active], now), ["op_old"]);
    }

    #[test]
    fn retention_keeps_only_the_newest_five_hundred_finished_records() {
        let now = at("2026-11-18T12:00:00.000Z");
        let records: Vec<OperationRecord> = (0..RETENTION_ENTRIES + 3)
            .map(|index| {
                // One second apart, all inside the thirty days.
                let settled =
                    at("2026-11-18T00:00:00.000Z") + chrono::Duration::seconds(index as i64);
                finished(
                    &format!("op_{index:04}"),
                    &settled.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
            })
            .collect();
        let mut expired = expired_ids(&records, now);
        expired.sort();
        assert_eq!(expired, ["op_0000", "op_0001", "op_0002"]);
    }

    #[test]
    fn a_time_that_does_not_parse_is_not_treated_as_old() {
        let now = at("2026-11-18T12:00:00.000Z");
        let odd = finished("op_odd", "yesterday");
        assert!(expired_ids([&odd], now).is_empty());
    }
}
