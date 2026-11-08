//! Per-key in-flight request caps.

use super::*;

// ─── In-flight caps ────────────────────────────────────────────────────────

/// Per-subject in-flight counters, one per process.
#[derive(Debug, Default)]
pub struct InFlight {
    pub(super) counts: DashMap<String, u32>,
}

impl InFlight {
    /// Take one slot of `cap` under `key`, or `None` when all are taken.
    pub(super) fn acquire(self: &Arc<Self>, key: &str, cap: u32) -> Option<Slot> {
        let mut count = self.counts.entry(key.to_owned()).or_insert(0);
        if *count >= cap {
            return None;
        }
        *count += 1;
        drop(count);
        Some(Slot {
            counts: Arc::clone(self),
            key: key.to_owned(),
        })
    }

    /// Requests in flight under `key`.
    #[cfg(test)]
    pub fn count(&self, key: &str) -> u32 {
        self.counts.get(key).map_or(0, |count| *count)
    }
}

/// One held in-flight slot, given back on drop.
#[derive(Debug)]
pub(super) struct Slot {
    pub(super) counts: Arc<InFlight>,
    pub(super) key: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let emptied = match self.counts.counts.get_mut(&self.key) {
            Some(mut count) => {
                *count = count.saturating_sub(1);
                *count == 0
            }
            None => false,
        };
        if emptied {
            self.counts
                .counts
                .remove_if(&self.key, |_, count| *count == 0);
        }
    }
}
