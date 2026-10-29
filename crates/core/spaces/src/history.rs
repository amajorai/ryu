use std::collections::HashSet;
use std::io::Cursor;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const AUTO_BUCKET_MS: i64 = 10 * 60 * 1_000;
pub(crate) const MAX_HISTORY_BYTES_PER_SPACE: i64 = 64 * 1024 * 1024;
pub(crate) const SNAPSHOT_CODEC: &str = "zstd-json-v1";

const HOUR_MS: i64 = 60 * 60 * 1_000;
const DAY_MS: i64 = 24 * HOUR_MS;
const WEEK_MS: i64 = 7 * DAY_MS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SnapshotPayload {
    pub kind: String,
    pub source: String,
    pub title: String,
}

pub(crate) struct EncodedSnapshot {
    /// The canonical serialized snapshot. Its content address is a KEYED hash
    /// (`ryu_history_hash`, a blind index of `spaces.db`), never a plain digest:
    /// an unkeyed digest of a short page could be confirmed offline.
    pub raw: Vec<u8>,
    pub payload: Vec<u8>,
    pub raw_bytes: i64,
    pub stored_bytes: i64,
}

pub(crate) fn encode_snapshot(snapshot: &SnapshotPayload) -> Result<EncodedSnapshot> {
    let raw = serde_json::to_vec(snapshot).context("serializing document history snapshot")?;
    let payload = zstd::stream::encode_all(Cursor::new(&raw), 3)
        .context("compressing document history snapshot")?;
    Ok(EncodedSnapshot {
        raw_bytes: raw.len() as i64,
        stored_bytes: payload.len() as i64,
        raw,
        payload,
    })
}

/// The canonical serialized snapshot inside a stored payload (what the content
/// address is computed over).
pub(crate) fn snapshot_raw(codec: &str, payload: &[u8]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        codec == SNAPSHOT_CODEC,
        "unsupported history codec '{codec}'"
    );
    zstd::stream::decode_all(Cursor::new(payload))
        .context("decompressing document history snapshot")
}

pub(crate) fn decode_snapshot(codec: &str, payload: &[u8]) -> Result<SnapshotPayload> {
    anyhow::ensure!(
        codec == SNAPSHOT_CODEC,
        "unsupported history codec '{codec}'"
    );
    let raw = zstd::stream::decode_all(Cursor::new(payload))
        .context("decompressing document history snapshot")?;
    serde_json::from_slice(&raw).context("parsing document history snapshot")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RetentionCandidate {
    pub id: String,
    pub updated_at: i64,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RetentionPlan {
    pub delete_ids: Vec<String>,
    pub granularity_updates: Vec<(String, &'static str)>,
}

/// Thin automatic checkpoints as they age. `candidates` must be newest first.
/// Named, legacy, baseline, and restore-guard versions never enter this planner.
pub(crate) fn plan_automatic_retention(
    now: i64,
    candidates: &[RetentionCandidate],
) -> RetentionPlan {
    let mut plan = RetentionPlan::default();
    let mut kept_buckets: HashSet<(&'static str, i64)> = HashSet::new();

    for candidate in candidates {
        let age = now.saturating_sub(candidate.updated_at);
        let bucket = if age <= DAY_MS {
            plan.granularity_updates
                .push((candidate.id.clone(), "ten_minute"));
            continue;
        } else if age <= 7 * DAY_MS {
            ("hour", candidate.updated_at.div_euclid(HOUR_MS))
        } else if age <= 30 * DAY_MS {
            ("day", candidate.updated_at.div_euclid(DAY_MS))
        } else if age <= 90 * DAY_MS {
            ("week", candidate.updated_at.div_euclid(WEEK_MS))
        } else {
            plan.delete_ids.push(candidate.id.clone());
            continue;
        };

        if kept_buckets.insert(bucket) {
            plan.granularity_updates
                .push((candidate.id.clone(), bucket.0));
        } else {
            plan.delete_ids.push(candidate.id.clone());
        }
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, updated_at: i64) -> RetentionCandidate {
        RetentionCandidate {
            id: id.to_owned(),
            updated_at,
        }
    }

    #[test]
    fn snapshot_codec_round_trips_and_hashes_canonical_state() {
        let snapshot = SnapshotPayload {
            kind: "page".to_owned(),
            source: "One\nTwo".to_owned(),
            title: "Notes".to_owned(),
        };
        let first = encode_snapshot(&snapshot).unwrap();
        let second = encode_snapshot(&snapshot).unwrap();

        assert_eq!(first.raw, second.raw);
        assert_eq!(
            snapshot_raw(SNAPSHOT_CODEC, &first.payload).unwrap(),
            first.raw
        );
        assert_eq!(
            decode_snapshot(SNAPSHOT_CODEC, &first.payload).unwrap(),
            snapshot
        );
        assert!(first.stored_bytes > 0);
        assert!(first.raw_bytes > 0);
    }

    #[test]
    fn retention_keeps_recent_versions_and_rolls_up_older_buckets() {
        let now = 100 * DAY_MS;
        let candidates = vec![
            candidate("recent-a", now - HOUR_MS),
            candidate("recent-b", now - 2 * HOUR_MS),
            candidate("hour-new", now - 2 * DAY_MS - 10 * 60 * 1_000),
            candidate("hour-old", now - 2 * DAY_MS - 20 * 60 * 1_000),
            candidate("day-new", now - 10 * DAY_MS - HOUR_MS),
            candidate("day-old", now - 10 * DAY_MS - 2 * HOUR_MS),
            candidate("week-new", now - 41 * DAY_MS),
            candidate("week-old", now - 42 * DAY_MS),
            candidate("expired", now - 91 * DAY_MS),
        ];

        let plan = plan_automatic_retention(now, &candidates);

        assert!(plan.delete_ids.contains(&"hour-old".to_owned()));
        assert!(plan.delete_ids.contains(&"day-old".to_owned()));
        assert!(plan.delete_ids.contains(&"week-old".to_owned()));
        assert!(plan.delete_ids.contains(&"expired".to_owned()));
        assert!(!plan.delete_ids.contains(&"recent-a".to_owned()));
        assert!(plan
            .granularity_updates
            .contains(&("hour-new".to_owned(), "hour")));
    }
}
