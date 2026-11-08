//! Fleet mode: parse the control plane's published table, keep the
//! last-known-good file, and poll for new versions.

use super::*;

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

pub(super) fn table_json(table: &OwnSupplyTable, discovery_requested_at: Option<&str>) -> Value {
    serde_json::json!({
        "version": table.version(),
        "rows": table.rows(),
        "poolDefaults": table.pool_defaults(),
        "discoveryRequestedAt": discovery_requested_at,
    })
}

pub(super) fn read_lkg(path: &Path) -> Option<(OwnSupplyTable, Option<String>)> {
    let bytes = std::fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    parse_table(&value)
}

/// Write atomically (temp file + rename) so a crash never leaves half a table.
pub(super) fn write_lkg(
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
