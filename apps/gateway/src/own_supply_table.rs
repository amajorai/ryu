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

/// Parse a published table body. Each row is validated on its own (own-supply
/// slot, non-empty ids, a price); a bad row is skipped and logged. `None` when
/// the body itself is not a table.
pub fn parse_table(body: &Value) -> Option<(OwnSupplyTable, Option<String>)> {
    let version = body.get("version")?.as_u64()?;
    let rows = body.get("rows")?.as_array()?;
    let own_slots: Vec<&str> = crate::credit_pools::own_supply_slots()
        .map(|(slot, _)| slot)
        .collect();
    let mut parsed = Vec::with_capacity(rows.len());
    for raw in rows {
        match serde_json::from_value::<OwnSupplyRow>(raw.clone()) {
            Ok(row)
                if own_slots.contains(&row.slot.as_str())
                    && !row.id.trim().is_empty()
                    && !row.upstream.trim().is_empty()
                    && row.user_price.is_some() =>
            {
                parsed.push(row);
            }
            Ok(row) => tracing::warn!(
                id = %row.id,
                "own-supply: skipped a published row (unknown slot, empty id or no price)"
            ),
            Err(error) => tracing::warn!("own-supply: skipped an unparseable row: {error}"),
        }
    }
    let pool_defaults: HashMap<String, String> = body
        .get("poolDefaults")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(pool, id)| Some((pool.clone(), id.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let requested = body
        .get("discoveryRequestedAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some((
        OwnSupplyTable::from_rows(version, parsed, pool_defaults),
        requested,
    ))
}

fn table_json(table: &OwnSupplyTable, discovery_requested_at: Option<&str>) -> Value {
    serde_json::json!({
        "version": table.version(),
        "rows": table.rows(),
        "poolDefaults": table.pool_defaults(),
        "discoveryRequestedAt": discovery_requested_at,
    })
}

fn read_lkg(path: &Path) -> Option<(OwnSupplyTable, Option<String>)> {
    let bytes = std::fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    parse_table(&value)
}

/// Write atomically (temp file + rename) so a crash never leaves half a table.
fn write_lkg(
    path: &Path,
    table: &OwnSupplyTable,
    discovery_requested_at: Option<&str>,
) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(&table_json(table, discovery_requested_at))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

/// The outcome of one poll, for logs and tests.
#[derive(Debug, PartialEq, Eq)]
pub enum PollOutcome {
    NotModified,
    Installed(u64),
    Kept,
    Failed,
}

/// One poll of the published table.
pub async fn poll_once(
    http: &reqwest::Client,
    endpoint: &reqwest::Url,
    secret: &str,
    runtime: &OwnSupplyRuntime,
) -> PollOutcome {
    let current = runtime.table();
    let mut request = http
        .get(endpoint.clone())
        .header("x-ryu-internal-secret", secret)
        .timeout(Duration::from_secs(10));
    if current.version() > 0 {
        request = request.header("if-none-match", format!("\"{}\"", current.version()));
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            runtime.note_failed_fetch(&format!("request failed: {error}"));
            return PollOutcome::Failed;
        }
    };
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        *lock(&runtime.last_fetch_ok) = Some(Instant::now());
        return PollOutcome::NotModified;
    }
    if !response.status().is_success() {
        runtime.note_failed_fetch(&format!("HTTP {}", response.status()));
        return PollOutcome::Failed;
    }
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(error) => {
            runtime.note_failed_fetch(&format!("invalid JSON: {error}"));
            return PollOutcome::Failed;
        }
    };
    let Some((table, requested)) = parse_table(&body) else {
        runtime.note_failed_fetch("not a table");
        return PollOutcome::Failed;
    };
    let version = table.version();
    if runtime.offer(table, requested) {
        PollOutcome::Installed(version)
    } else {
        PollOutcome::Kept
    }
}

/// Poll the fleet table every minute (fleet mode only).
pub fn spawn_poller(runtime: Arc<OwnSupplyRuntime>) {
    if !runtime.is_fleet() {
        return;
    }
    let (Ok(base), Ok(secret)) = (
        std::env::var("CONTROL_PLANE_URL"),
        std::env::var("RYU_VAULT_INTERNAL_SECRET"),
    ) else {
        return;
    };
    let endpoint = match crate::provider_vault::control_plane_endpoint(
        base.trim(),
        "own-supply/fleet/table",
    ) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            tracing::warn!("own-supply: table polling disabled: {error}");
            return;
        }
    };
    let http = match reqwest::Client::builder()
        // The request carries the fleet secret: never follow a redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(http) => http,
        Err(error) => {
            tracing::warn!("own-supply: table polling disabled: {error}");
            return;
        }
    };
    let secret = secret.trim().to_owned();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(POLL_EVERY);
        loop {
            interval.tick().await;
            poll_once(&http, &endpoint, &secret, &runtime).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn row(id: &str, slot: &str, upstream: &str) -> Value {
        json!({
            "id": id, "slot": slot, "upstream": upstream, "priority": 0,
            "canaryRequired": false,
            "userPrice": {"inPer1kMicroUsd": 3000, "outPer1kMicroUsd": 15000}
        })
    }

    fn body(version: u64, rows: Vec<Value>) -> Value {
        json!({"version": version, "rows": rows, "poolDefaults": {}, "discoveryRequestedAt": null})
    }

    #[test]
    fn a_bad_row_is_skipped_on_its_own() {
        let (table, _) = parse_table(&body(
            3,
            vec![
                row(
                    "anthropic/claude-sonnet-4.5",
                    "anthropic-credits",
                    "claude-sonnet-4-5",
                ),
                // Not an own-supply slot.
                row("openai/gpt-5", "openai", "gpt-5"),
                // No price.
                json!({"id": "openai/o3", "slot": "openai-credits", "upstream": "o3"}),
                // Not a row.
                json!("garbage"),
            ],
        ))
        .unwrap();
        assert_eq!(table.version(), 3);
        assert_eq!(table.rows().len(), 1);
        assert!(parse_table(&json!({"rows": []})).is_none());
    }

    #[test]
    fn the_table_never_downgrades() {
        let runtime = OwnSupplyRuntime::fleet_for_test(OwnSupplyTable::empty(), None);
        let parsed = |version, rows| parse_table(&body(version, rows)).unwrap().0;
        assert!(runtime.offer(
            parsed(5, vec![row("openai/o3", "openai-credits", "o3")]),
            None
        ));
        // Same version, older version, empty with the same version: ignored.
        assert!(!runtime.offer(parsed(5, vec![]), None));
        assert!(!runtime.offer(
            parsed(4, vec![row("openai/gpt-5", "openai-credits", "gpt-5")]),
            None
        ));
        assert_eq!(runtime.table().rows().len(), 1);
        // An empty table needs a higher version.
        assert!(runtime.offer(parsed(6, vec![]), None));
        assert!(runtime.table().is_empty());
    }

    #[test]
    fn fleet_rows_route_only_after_a_canary_and_never_while_quarantined() {
        let table = parse_table(&body(1, vec![row("openai/o3", "openai-credits", "o3")]))
            .unwrap()
            .0;
        let runtime = OwnSupplyRuntime::fleet_for_test(table, None);
        let row = runtime.table().rows()[0].clone();
        assert!(!runtime.is_routable(&row), "no canary yet");
        assert!(runtime.canary_due("openai-credits", "o3", "abcd"));
        runtime.record_canary(
            "openai-credits",
            "O3",
            CanaryResult {
                ok: true,
                at: Instant::now(),
                key_fingerprint: "abcd".into(),
            },
        );
        assert!(runtime.is_routable(&row));
        assert!(!runtime.canary_due("openai-credits", "o3", "abcd"));
        // A rotated key means a fresh check.
        assert!(runtime.canary_due("openai-credits", "o3", "beef"));
        runtime.quarantine("openai-credits", "o3");
        assert!(!runtime.is_routable(&row));
        assert_eq!(
            runtime.take_quarantine_counts("openai-credits"),
            vec![("o3".to_owned(), 1)]
        );
        assert!(runtime.take_quarantine_counts("openai-credits").is_empty());
        // A failed canary never routes.
        let failed = OwnSupplyRuntime::fleet_for_test(runtime.table().as_ref().clone(), None);
        failed.record_canary(
            "openai-credits",
            "o3",
            CanaryResult {
                ok: false,
                at: Instant::now(),
                key_fingerprint: "abcd".into(),
            },
        );
        assert!(!failed.is_routable(&row));
    }

    #[test]
    fn non_fleet_routes_the_seed_except_canary_required_rows() {
        let runtime = OwnSupplyRuntime::default();
        let table = runtime.table();
        let sonnet = table
            .equivalents("anthropic/claude-sonnet-4.5")
            .next()
            .unwrap();
        assert!(runtime.is_routable(sonnet));
        let nova = table.equivalents("amazon/nova-pro-v1").next().unwrap();
        assert!(!runtime.is_routable(nova));
    }

    #[test]
    fn fleet_boot_reads_the_last_known_good_file_else_starts_empty() {
        let dir = std::env::temp_dir().join(format!("ryu-own-supply-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = OwnSupplyRuntime::for_process_unmirrored(true, Some(&dir));
        assert!(empty.table().is_empty());
        let table = parse_table(&body(9, vec![row("openai/o3", "openai-credits", "o3")]))
            .unwrap()
            .0;
        assert!(empty.offer(table, Some("2026-10-12T00:00:00Z".into())));
        let rebooted = OwnSupplyRuntime::for_process_unmirrored(true, Some(&dir));
        assert_eq!(rebooted.table().version(), 9);
        assert_eq!(rebooted.table().rows().len(), 1);
        assert_eq!(
            rebooted.discovery_requested_at().as_deref(),
            Some("2026-10-12T00:00:00Z")
        );
        // Non-fleet ignores the file and uses the seed.
        let seed = OwnSupplyRuntime::for_process_unmirrored(false, Some(&dir));
        assert_eq!(seed.table().version(), 0);
        assert!(!seed.table().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[derive(Clone)]
    struct Mock {
        status: Arc<std::sync::Mutex<(StatusCode, Value)>>,
        hits: Arc<AtomicUsize>,
        saw_secret: Arc<AtomicUsize>,
    }

    async fn handler(
        State(mock): State<Mock>,
        headers: axum::http::HeaderMap,
    ) -> impl IntoResponse {
        mock.hits.fetch_add(1, Ordering::SeqCst);
        if headers
            .get("x-ryu-internal-secret")
            .and_then(|v| v.to_str().ok())
            == Some("s3cret")
        {
            mock.saw_secret.fetch_add(1, Ordering::SeqCst);
        }
        let (status, body) = mock.status.lock().unwrap().clone();
        (status, axum::Json(body))
    }

    #[tokio::test]
    async fn the_poller_installs_keeps_and_survives_failures() {
        let mock = Mock {
            status: Arc::new(std::sync::Mutex::new((
                StatusCode::OK,
                body(2, vec![row("openai/o3", "openai-credits", "o3")]),
            ))),
            hits: Arc::default(),
            saw_secret: Arc::default(),
        };
        let app = Router::new()
            .route("/api/own-supply/fleet/table", get(handler))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoint = crate::provider_vault::control_plane_endpoint(
            &format!("http://127.0.0.1:{}", addr.port()),
            "own-supply/fleet/table",
        )
        .unwrap();
        let http = reqwest::Client::new();
        let runtime = OwnSupplyRuntime::fleet_for_test(OwnSupplyTable::empty(), None);

        assert_eq!(
            poll_once(&http, &endpoint, "s3cret", &runtime).await,
            PollOutcome::Installed(2)
        );
        assert_eq!(mock.saw_secret.load(Ordering::SeqCst), 1);
        // 500: keep the table.
        *mock.status.lock().unwrap() = (StatusCode::INTERNAL_SERVER_ERROR, json!({}));
        assert_eq!(
            poll_once(&http, &endpoint, "s3cret", &runtime).await,
            PollOutcome::Failed
        );
        assert_eq!(runtime.table().version(), 2);
        // Same version, empty rows: ignored.
        *mock.status.lock().unwrap() = (StatusCode::OK, body(2, vec![]));
        assert_eq!(
            poll_once(&http, &endpoint, "s3cret", &runtime).await,
            PollOutcome::Kept
        );
        assert_eq!(runtime.table().rows().len(), 1);
        // 304: not modified.
        *mock.status.lock().unwrap() = (StatusCode::NOT_MODIFIED, json!(null));
        assert_eq!(
            poll_once(&http, &endpoint, "s3cret", &runtime).await,
            PollOutcome::NotModified
        );
    }
}
