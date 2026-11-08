//! The Ryu Router own-supply table on this gateway: which Ryu Router ids may be
//! served from an own-supply slot on free credit, plus this gateway's local
//! evidence that each row is actually callable here (canary) and not failing
//! right now (quarantine).
//!
//! WHERE THE TABLE COMES FROM.
//! - Fleet mode (`CONTROL_PLANE_URL` + `RYU_VAULT_INTERNAL_SECRET` both set):
//!   the control plane's published table (`GET /api/own-supply/fleet/table`),
//!   polled every 60 s with `If-None-Match`. At boot: the last-known-good file
//!   next to `gateway.toml`, else an EMPTY table — never the compiled seed, so a
//!   model an admin disabled cannot come back during a control-plane outage.
//! - Otherwise (self-hosted / BYOK): the compiled seed
//!   ([`ryu_gw_router::own_supply::OwnSupplyTable::seed`]); nothing is fetched
//!   or reported.
//!
//! THE TABLE NEVER DOWNGRADES. A 5xx, timeout or unparseable body keeps the
//! current table; a body is accepted only with a higher version (so an empty
//! `rows: []` needs one too); a malformed row is skipped on its own.
//!
//! WHAT ROUTES. A row routes on this gateway only when [`OwnSupplyRuntime::
//! is_routable`]: not quarantined, and — in fleet mode — its local canary passed
//! (a 1-token call through the slot's own provider, run by
//! `own_supply_discovery`). Outside fleet mode no canary runs, so only seed rows
//! that do not require one route.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use ryu_gw_router::own_supply::{OwnSupplyPrice, OwnSupplyRow, OwnSupplyTable};
use serde_json::Value;

mod fleet;
pub use fleet::{parse_table, poll_once, spawn_poller, PollOutcome};
use fleet::{read_lkg, write_lkg};

/// How long a runtime 404 / 403 / "model not found" keeps a row off this gateway.
pub const QUARANTINE_FOR: Duration = Duration::from_secs(60 * 60);
/// A canary result older than this is re-checked.
pub const CANARY_FRESH_FOR: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the fleet table is polled.
const POLL_EVERY: Duration = Duration::from_secs(60);
/// Staleness past which every failed poll logs a warning.
const STALE_WARN_AFTER: Duration = Duration::from_secs(60 * 60);
/// The last-known-good file, next to `gateway.toml`.
const LKG_FILE: &str = "own-supply-table.json";

/// One local canary outcome for `(slot, upstream)`.
#[derive(Debug, Clone)]
pub struct CanaryResult {
    pub ok: bool,
    pub at: Instant,
    /// Which credential the canary ran on (first 16 hex of its SHA-256).
    pub key_fingerprint: String,
}

#[derive(Debug, Clone)]
struct Quarantine {
    until: Instant,
    unreported: u32,
    /// The upstream id as published (the map key is lowercased).
    upstream: String,
}

type SlotUpstream = (String, String);

fn key(slot: &str, upstream: &str) -> SlotUpstream {
    (slot.to_owned(), upstream.to_ascii_lowercase())
}

/// The table plus this gateway's canary and quarantine state.
#[derive(Debug)]
pub struct OwnSupplyRuntime {
    fleet: bool,
    /// Whether installs update the process-wide [`published`] mirror (only the
    /// process's own runtime does; test runtimes never touch it).
    mirror: bool,
    table: RwLock<Arc<OwnSupplyTable>>,
    discovery_requested_at: Mutex<Option<String>>,
    last_fetch_ok: Mutex<Option<Instant>>,
    canaries: RwLock<HashMap<SlotUpstream, CanaryResult>>,
    quarantine: RwLock<HashMap<SlotUpstream, Quarantine>>,
    lkg_path: Option<PathBuf>,
}

impl Default for OwnSupplyRuntime {
    /// Non-fleet: the compiled seed, nothing fetched, nothing mirrored.
    fn default() -> Self {
        Self::new(false, false, OwnSupplyTable::seed(), None)
    }
}

/// The process-wide copy of the installed table, for code with no `AppState`
/// at hand (display names on usage rows, row pricing in the reporter).
static PUBLISHED: LazyLock<RwLock<Arc<OwnSupplyTable>>> =
    LazyLock::new(|| RwLock::new(Arc::new(OwnSupplyTable::seed())));

/// The table this process last installed (the compiled seed until then).
pub fn published() -> Arc<OwnSupplyTable> {
    PUBLISHED
        .read()
        .map(|table| Arc::clone(&table))
        .unwrap_or_else(|_| Arc::new(OwnSupplyTable::seed()))
}

/// The Ryu Router id a user may see for `upstream` served by `slot`: the live
/// table first, then the compiled seed (so work served before a row was
/// removed never surfaces the supplier's id).
pub fn display_id(slot: &str, upstream: &str) -> Option<String> {
    published()
        .equivalent_id(slot, upstream)
        .map(str::to_owned)
        .or_else(|| ryu_gw_router::pool_model_equivalent_id(slot, upstream).map(str::to_owned))
}

/// The published user price for work `slot` served, whether `model` is the
/// upstream id or the Ryu Router id it was recorded under.
pub fn price_for(slot: &str, model: &str) -> Option<OwnSupplyPrice> {
    table_price(&published(), slot, model)
}

fn table_price(table: &OwnSupplyTable, slot: &str, model: &str) -> Option<OwnSupplyPrice> {
    table.price(slot, model).or_else(|| {
        table
            .equivalents(model)
            .find(|row| row.slot == slot)
            .and_then(|row| row.user_price)
    })
}

/// Whether this process runs as a hosted fleet gateway (both fleet variables set).
pub fn fleet_from_env() -> bool {
    let set = |name: &str| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    };
    set("CONTROL_PLANE_URL") && set("RYU_VAULT_INTERNAL_SECRET")
}

impl OwnSupplyRuntime {
    fn new(fleet: bool, mirror: bool, table: OwnSupplyTable, lkg_path: Option<PathBuf>) -> Self {
        let runtime = Self {
            fleet,
            mirror,
            table: RwLock::new(Arc::new(table)),
            discovery_requested_at: Mutex::new(None),
            last_fetch_ok: Mutex::new(None),
            canaries: RwLock::new(HashMap::new()),
            quarantine: RwLock::new(HashMap::new()),
            lkg_path,
        };
        runtime.publish_mirror();
        runtime
    }

    /// The runtime for this process: fleet gateways boot from the
    /// last-known-good file (else empty); others from the compiled seed.
    pub fn for_process(fleet: bool, config_dir: Option<&Path>) -> Self {
        Self::boot(fleet, config_dir, true)
    }

    #[cfg(test)]
    fn for_process_unmirrored(fleet: bool, config_dir: Option<&Path>) -> Self {
        Self::boot(fleet, config_dir, false)
    }

    fn boot(fleet: bool, config_dir: Option<&Path>, mirror: bool) -> Self {
        if !fleet {
            return Self::new(false, mirror, OwnSupplyTable::seed(), None);
        }
        let lkg_path = config_dir.map(|dir| dir.join(LKG_FILE));
        let loaded = lkg_path.as_deref().and_then(read_lkg);
        let (table, requested) = loaded.unwrap_or_else(|| (OwnSupplyTable::empty(), None));
        tracing::info!(
            version = table.version(),
            rows = table.rows().len(),
            "own-supply: fleet table loaded from the last-known-good file (empty if none)"
        );
        let runtime = Self::new(true, mirror, table, lkg_path);
        *lock(&runtime.discovery_requested_at) = requested;
        runtime
    }

    /// A fleet runtime with no file and no mirror (tests).
    #[cfg(test)]
    pub fn fleet_for_test(table: OwnSupplyTable, lkg_path: Option<PathBuf>) -> Self {
        Self::new(true, false, table, lkg_path)
    }

    pub fn is_fleet(&self) -> bool {
        self.fleet
    }

    pub fn table(&self) -> Arc<OwnSupplyTable> {
        self.table
            .read()
            .map(|table| Arc::clone(&table))
            .unwrap_or_else(|_| Arc::new(OwnSupplyTable::empty()))
    }

    /// The control plane's latest "rediscover now" request, if any.
    pub fn discovery_requested_at(&self) -> Option<String> {
        lock(&self.discovery_requested_at).clone()
    }

    fn publish_mirror(&self) {
        if !self.mirror {
            return;
        }
        let table = self.table();
        if let Ok(mut mirror) = PUBLISHED.write() {
            *mirror = table;
        }
    }

    /// Replace the table when `candidate` is newer (see the module docs).
    /// Returns whether it was installed.
    pub fn offer(&self, candidate: OwnSupplyTable, discovery_requested_at: Option<String>) -> bool {
        *lock(&self.last_fetch_ok) = Some(Instant::now());
        *lock(&self.discovery_requested_at) = discovery_requested_at.clone();
        let current = self.table();
        let newer = candidate.version() > current.version()
            || (candidate.version() == current.version()
                && current.is_empty()
                && !candidate.is_empty());
        if !newer {
            return false;
        }
        tracing::info!(
            from = current.version(),
            to = candidate.version(),
            rows = candidate.rows().len(),
            "own-supply: installed a new published table"
        );
        if let Some(path) = &self.lkg_path {
            if let Err(error) = write_lkg(path, &candidate, discovery_requested_at.as_deref()) {
                tracing::warn!("own-supply: could not write the last-known-good file: {error}");
            }
        }
        if let Ok(mut table) = self.table.write() {
            *table = Arc::new(candidate);
        }
        self.publish_mirror();
        true
    }

    /// Note a poll that produced no usable table; warns once stale.
    fn note_failed_fetch(&self, reason: &str) {
        let last = *lock(&self.last_fetch_ok);
        let stale = last.is_none_or(|at| at.elapsed() > STALE_WARN_AFTER);
        if stale {
            tracing::warn!(
                stale_seconds = last.map(|at| at.elapsed().as_secs()),
                "own-supply: table fetch failed ({reason}); keeping the current table"
            );
        } else {
            tracing::debug!("own-supply: table fetch failed ({reason}); keeping the current table");
        }
    }

    /// Whether `row` may serve a request on this gateway right now.
    pub fn is_routable(&self, row: &OwnSupplyRow) -> bool {
        let now = Instant::now();
        let key = key(&row.slot, &row.upstream);
        if self
            .quarantine
            .read()
            .ok()
            .and_then(|map| map.get(&key).map(|q| q.until))
            .is_some_and(|until| until > now)
        {
            return false;
        }
        if !self.fleet {
            return !row.canary_required;
        }
        self.canaries
            .read()
            .ok()
            .and_then(|map| map.get(&key).map(|result| result.ok))
            .unwrap_or(false)
    }

    /// Take `(slot, upstream)` off this gateway for [`QUARANTINE_FOR`].
    pub fn quarantine(&self, slot: &str, upstream: &str) {
        if let Ok(mut map) = self.quarantine.write() {
            let entry = map.entry(key(slot, upstream)).or_insert(Quarantine {
                until: Instant::now(),
                unreported: 0,
                upstream: upstream.to_owned(),
            });
            entry.until = Instant::now() + QUARANTINE_FOR;
            entry.unreported = entry.unreported.saturating_add(1);
        }
        tracing::warn!(
            slot,
            "own-supply: quarantined a row after a not-found / refused-credential reply"
        );
    }

    /// Quarantine counts for `slot` not yet reported (and reset them).
    pub fn take_quarantine_counts(&self, slot: &str) -> Vec<(String, u32)> {
        let Ok(mut map) = self.quarantine.write() else {
            return Vec::new();
        };
        map.iter_mut()
            .filter(|((s, _), q)| s == slot && q.unreported > 0)
            .map(|(_, q)| {
                let count = std::mem::take(&mut q.unreported);
                (q.upstream.clone(), count)
            })
            .collect()
    }

    /// The published user price for work `slot` served as `model` (upstream id
    /// or the Ryu Router id it is recorded under).
    pub fn price_for(&self, slot: &str, model: &str) -> Option<OwnSupplyPrice> {
        table_price(&self.table(), slot, model)
    }

    pub fn record_canary(&self, slot: &str, upstream: &str, result: CanaryResult) {
        if let Ok(mut map) = self.canaries.write() {
            map.insert(key(slot, upstream), result);
        }
    }

    pub fn canary(&self, slot: &str, upstream: &str) -> Option<CanaryResult> {
        self.canaries
            .read()
            .ok()?
            .get(&key(slot, upstream))
            .cloned()
    }

    /// Whether `(slot, upstream)` needs a (re-)check on `key_fingerprint`.
    pub fn canary_due(&self, slot: &str, upstream: &str, key_fingerprint: &str) -> bool {
        self.canary(slot, upstream).is_none_or(|result| {
            result.key_fingerprint != key_fingerprint || result.at.elapsed() > CANARY_FRESH_FOR
        })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
