use super::*;
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Clone)]
pub struct UsageHistoryStore {
    connection: Arc<Mutex<Connection>>,
}
impl UsageHistoryStore {
    pub fn open_default() -> Result<Self> {
        Self::open(&crate::paths::db_path("usage-history.db"))
    }
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = c.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if !(0..=2).contains(&version) {
            bail!("Usage history database version is unsupported");
        }
        let migration = if version < 2 {
            "UPDATE usage_history_records SET data=json_set(data,'$.scope','unattributed') WHERE json_extract(data,'$.scope')='session' AND json_extract(data,'$.provenance')='live-acp-unbound-session';"
        } else {
            ""
        };
        c.execute_batch(&format!("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS usage_history_records(source TEXT NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,event)); CREATE TABLE IF NOT EXISTS usage_history_files(source TEXT NOT NULL,path TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(source,path)); CREATE TABLE IF NOT EXISTS usage_history_settings(name TEXT PRIMARY KEY,value INTEGER NOT NULL); {migration} PRAGMA user_version=2; COMMIT;"))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(c)),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("History store unavailable"))
    }
    pub fn tracking_enabled(&self) -> Result<bool> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT value FROM usage_history_settings WHERE name='tracking'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            == 1)
    }
    pub fn is_enabled(&self) -> Result<bool> {
        self.tracking_enabled()
    }
    pub fn get_session_import_cursor(&self) -> Result<i64> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT value FROM usage_history_settings WHERE name='ryu_session_cursor'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn set_session_import_cursor(&self, cursor: i64) -> Result<()> {
        if cursor < 0 {
            bail!("Invalid session cursor");
        }
        self.lock()?.execute("INSERT INTO usage_history_settings(name,value) VALUES('ryu_session_cursor',?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value",[cursor])?;
        Ok(())
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        self.set_tracking_enabled(enabled)
    }
    pub fn set_tracking_enabled(&self, enabled: bool) -> Result<()> {
        self.lock()?.execute("INSERT INTO usage_history_settings(name,value) VALUES('tracking',?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value",[i64::from(enabled)])?;
        Ok(())
    }
    pub fn upsert_record(&self, record: &UsageRecord) -> Result<bool> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let result = save(&tx, record, false)?;
        tx.commit()?;
        Ok(result == 1)
    }
    pub fn import_local(&self, request: &ImportRequest) -> Result<ImportReport> {
        self.import_local_with_progress(request, &mut |_| {})
    }
    pub fn import_local_with_progress(
        &self,
        request: &ImportRequest,
        progress: &mut dyn FnMut(&ImportReport),
    ) -> Result<ImportReport> {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("Home directory unavailable"))?;
        self.import_from_home_with_progress(request, &home, progress)
    }
    pub fn import_from_home(&self, request: &ImportRequest, home: &Path) -> Result<ImportReport> {
        self.import_from_home_with_progress(request, home, &mut |_| {})
    }
    pub fn import_from_home_with_progress(
        &self,
        request: &ImportRequest,
        home: &Path,
        progress: &mut dyn FnMut(&ImportReport),
    ) -> Result<ImportReport> {
        if request.roots.len() > 32 || request.source_ids.len() > 32 {
            bail!("Too many scan roots or sources");
        }
        let valid =
            |id: &str| scan::roots(home, id).is_some() || scan::EXPORT_SOURCES.contains(&id);
        if request.source_ids.iter().any(|id| !valid(id))
            || request.roots.iter().any(|r| !valid(&r.source_id))
        {
            bail!("Unknown usage history source");
        }
        let ids: Vec<String> = if request.source_ids.is_empty() && request.roots.is_empty() {
            scan::LOCAL_SOURCES
                .iter()
                .map(|(id, _, _)| (*id).to_owned())
                .collect()
        } else {
            request.source_ids.clone()
        };
        let mut jobs = Vec::new();
        let mut report = ImportReport::default();
        for id in ids {
            for root in scan::roots(home, &id).unwrap_or_default() {
                let mut paths = Vec::new();
                if scan::files(&root, &mut paths, 0).is_err() {
                    report_error(&mut report, &id, "directory could not be scanned");
                }
                jobs.extend(paths.into_iter().map(|p| (id.clone(), p, None)));
            }
        }
        for root in &request.roots {
            let path = std::path::PathBuf::from(&root.path);
            if !path.is_absolute() {
                bail!("Scan roots must be absolute");
            }
            if !path.exists() {
                report_error(
                    &mut report,
                    &root.source_id,
                    "explicit history path was not found",
                );
                continue;
            }
            if path
                .ancestors()
                .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| scan::is_link(&m)))
            {
                bail!("Scan roots cannot contain symlinks");
            }
            let mut paths = Vec::new();
            if scan::files(&path, &mut paths, 0).is_err() {
                report_error(
                    &mut report,
                    &root.source_id,
                    "directory could not be scanned",
                );
            }
            jobs.extend(
                paths
                    .into_iter()
                    .map(|p| (root.source_id.clone(), p, root.account_id.clone())),
            );
        }
        jobs.sort();
        jobs.dedup();
        let max = request.max_files.unwrap_or(2000).clamp(1, 10000);
        for (source, path, account_id) in jobs {
            let path_identity = format!(
                "{}:{}",
                path.to_string_lossy(),
                account_id.as_deref().unwrap_or("")
            );
            let key = adapters::digest(&if source == "opencode" {
                format!("{path_identity}:reasoning-output-v2")
            } else {
                path_identity
            });
            let fingerprint = match scan::fingerprint(&path) {
                Ok(f) => f,
                // Deleted since the walk (a pruned transcript): nothing to import.
                Err(_) if std::fs::symlink_metadata(&path).is_err() => {
                    report.skipped_files += 1;
                    progress(&report);
                    continue;
                }
                Err(_) => {
                    report_error(&mut report, &source, "file metadata unavailable");
                    progress(&report);
                    continue;
                }
            };
            let unchanged = self
                .lock()?
                .query_row(
                    "SELECT fingerprint FROM usage_history_files WHERE source=?1 AND path=?2",
                    params![source, key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .is_some_and(|f| {
                    f == fingerprint
                        || (!request.retry_failed && f == format!("failed:{fingerprint}"))
                });
            if unchanged {
                report.skipped_files += 1;
                progress(&report);
                continue;
            }
            if report.scanned_files >= max as u64 {
                report.has_more = true;
                break;
            }
            report.scanned_files += 1;
            let parsed = match scan::parse_file(&source, &path, account_id.as_deref()) {
                Ok(rows) => rows,
                Err(_) if std::fs::symlink_metadata(&path).is_err() => {
                    report.skipped_files += 1;
                    progress(&report);
                    continue;
                }
                Err(_) => {
                    report_error(
                        &mut report,
                        &source,
                        "history file unreadable or unsupported schema",
                    );
                    self.lock()?.execute("INSERT INTO usage_history_files(source,path,fingerprint) VALUES(?1,?2,?3) ON CONFLICT(source,path) DO UPDATE SET fingerprint=excluded.fingerprint",params![source,key,format!("failed:{fingerprint}")])?;
                    progress(&report);
                    continue;
                }
            };
            for (message, count) in parsed.warnings {
                report_error(&mut report, &source, &format!("{count} {message}"));
                report.error_count += count.saturating_sub(1);
            }
            let mut c = self.lock()?;
            let tx = c.transaction()?;
            for record in parsed.records {
                match save(&tx, &record, source == "codex") {
                    Ok(1) => report.imported_records += 1,
                    Ok(2) => report.updated_records += 1,
                    Ok(_) => report.duplicate_records += 1,
                    Err(_) => report_error(&mut report, &source, "invalid usage metadata skipped"),
                }
            }
            // Mark only a stable snapshot. Appended/truncated files retry next run.
            if scan::fingerprint(&path).ok().as_deref() == Some(&fingerprint) {
                tx.execute("INSERT INTO usage_history_files(source,path,fingerprint) VALUES(?1,?2,?3) ON CONFLICT(source,path) DO UPDATE SET fingerprint=excluded.fingerprint",params![source,key,fingerprint])?;
            }
            tx.commit()?;
            drop(c);
            progress(&report);
        }
        progress(&report);
        Ok(report)
    }
    pub fn records(&self, query: &HistoryQuery) -> Result<Vec<UsageRecord>> {
        for date in [&query.start_date, &query.end_date].into_iter().flatten() {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        }
        let scope = query.scope.as_deref().unwrap_or("session");
        if !matches!(
            scope,
            "session" | "account" | "organization" | "unattributed" | "unreconciled"
        ) {
            bail!("Unknown history scope");
        }
        let c = self.lock()?;
        let mut stmt = c.prepare("SELECT data FROM usage_history_records")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut retained = Vec::new();
        let mut native_sessions: BTreeMap<(String, String), BTreeSet<Option<String>>> =
            BTreeMap::new();
        for row in rows {
            let record: UsageRecord = serde_json::from_str(&row?)?;
            if record.scope == "session"
                && matches!(
                    record.provenance.as_str(),
                    "localHistory" | "localSessionAggregate"
                )
            {
                native_sessions
                    .entry((record.source_id.clone(), record.session_id.clone()))
                    .or_default()
                    .insert(record.account_id.clone());
            }
            retained.push(record);
        }
        let mut result = Vec::new();
        for mut record in retained {
            // Binding identifies a session, not the native turns covered by a file.
            // Preserve unmatched live evidence separately until event overlap is proven.
            if record.scope == "session"
                && record.provenance == "live-acp-native-session"
                && native_sessions
                    .get(&(record.source_id.clone(), record.session_id.clone()))
                    .is_some_and(|identities| {
                        // Billing route names can differ across the same bound native
                        // session, for example openai versus openai-codex. They do not
                        // prove disjoint turns. Preserve them without inferring overlap.
                        identities.iter().any(|account| {
                            account
                                .as_ref()
                                .zip(record.account_id.as_ref())
                                .is_none_or(|(native, live)| native == live)
                        })
                    })
            {
                record.scope = "unreconciled".into();
                record.provenance = "unresolvedNativeOverlap".into();
            }
            let day = record
                .timestamp
                .get(..10)
                .ok_or_else(|| anyhow!("Invalid stored usage timestamp"))?;
            if record.scope != scope
                || query
                    .start_date
                    .as_ref()
                    .is_some_and(|start| day < start.as_str())
                || query
                    .end_date
                    .as_ref()
                    .is_some_and(|end| day > end.as_str())
                || (!query.source_ids.is_empty() && !query.source_ids.contains(&record.source_id))
            {
                continue;
            }
            result.push(record);
        }
        Ok(result)
    }
    pub fn summary(
        &self,
        query: &HistoryQuery,
        rates: &BTreeMap<(String, String), ModelRates>,
    ) -> Result<HistorySummary> {
        let records = self.records(query)?;
        let mut summary = HistorySummary::default();
        let mut sessions = BTreeSet::new();
        let mut daily: BTreeMap<(String, String), Accumulator> = BTreeMap::new();
        let mut models: BTreeMap<(String, Option<String>), Accumulator> = BTreeMap::new();
        let mut sources: BTreeMap<String, Accumulator> = BTreeMap::new();
        let mut accounts: BTreeMap<(String, Option<String>), Accumulator> = BTreeMap::new();
        let mut total = Accumulator::default();
        for r in &records {
            let rate = r
                .provider_id
                .as_ref()
                .zip(r.model_id.as_ref())
                .and_then(|(p, m)| rates.get(&(p.clone(), m.clone())))
                .or_else(|| {
                    r.model_id
                        .as_ref()
                        .and_then(|m| rates.get(&(String::new(), m.clone())))
                });
            total.add(r, rate);
            if counts_as_session(r) {
                sessions.insert((
                    &r.source_id,
                    r.account_id.as_ref().filter(|_| r.scope != "unattributed"),
                    &r.session_id,
                ));
            }
            let day = r.timestamp[..10].to_owned();
            daily
                .entry((day.clone(), r.source_id.clone()))
                .or_default()
                .add(r, rate);
            models
                .entry((r.source_id.clone(), r.model_id.clone()))
                .or_default()
                .add(r, rate);
            sources.entry(r.source_id.clone()).or_default().add(r, rate);
            accounts
                .entry((r.source_id.clone(), r.account_id.clone()))
                .or_default()
                .add(r, rate);
        }
        summary.totals = total.bucket.totals.clone();
        summary.sessions = sessions.len() as u64;
        summary.records = records.len() as u64;
        summary.estimated_cost_usd = total.bucket.estimated_cost_usd;
        summary.reported_cost_usd = total.bucket.reported_cost_usd;
        summary.billed_cost_usd = total.bucket.billed_cost_usd;
        summary.source_estimated_cost_usd = total.bucket.source_estimated_cost_usd;
        summary.cache_savings_usd = total.bucket.cache_savings_usd;
        summary.unpriced_records = total.bucket.unpriced_records;
        summary.daily = daily
            .into_iter()
            .map(|((date, source), a)| a.finish(date, source, None))
            .collect();
        summary.models = models
            .into_iter()
            .map(|((source, model), a)| a.finish(String::new(), source, model))
            .collect();
        summary.sources = sources
            .into_iter()
            .map(|(source, a)| a.finish(String::new(), source, None))
            .collect();
        if accounts.keys().any(|(_, account)| account.is_some()) {
            summary.accounts = accounts
                .into_iter()
                .map(|((source, account), a)| {
                    let mut bucket = a.finish(String::new(), source, None);
                    bucket.account_id = account;
                    bucket
                })
                .collect();
        }
        Ok(summary)
    }
}
fn report_error(report: &mut ImportReport, source: &str, message: &str) {
    report.error_count += 1;
    if report.errors.len() < 20 {
        report.errors.push(format!("{source}: {message}"));
    }
}
fn counts_as_session(record: &UsageRecord) -> bool {
    matches!(record.scope.as_str(), "session" | "unreconciled")
        || (record.scope == "unattributed"
            && record
                .session_id
                .strip_prefix("ryu-conversation:")
                .is_some_and(|id| !id.is_empty()))
}
fn save(c: &Connection, r: &UsageRecord, allow_retained_baseline_correction: bool) -> Result<u8> {
    if r.account_id.as_ref().is_some_and(|id| {
        id.is_empty() || id.len() > 512 || id.trim() != id || id.chars().any(char::is_control)
    }) {
        bail!("Invalid usage account identity");
    }
    // Provider export aggregates already namespace their event IDs. Preserve their
    // existing keys so reimporting older exports does not create duplicate rows.
    let event_key = if matches!(r.scope.as_str(), "session" | "unattributed") {
        if let Some(id) = &r.account_id {
            format!(
                "\0account:{}",
                adapters::digest(&serde_json::to_string(&(id, &r.event_id))?)
            )
        } else {
            r.event_id.clone()
        }
    } else {
        r.event_id.clone()
    };
    if !matches!(
        r.scope.as_str(),
        "session" | "account" | "organization" | "unattributed"
    ) {
        bail!("Invalid usage scope");
    }
    if !matches!(
        r.cost_kind.as_str(),
        "unknown"
            | "billed"
            | "estimated"
            | "sourceEstimate"
            | "apiEquivalent"
            | "source-reported"
            | "subscription"
    ) {
        bail!("Invalid usage cost kind");
    }
    for s in [&r.provenance, &r.cost_kind]
        .into_iter()
        .chain(r.provider_id.iter())
        .chain(r.model_id.iter())
    {
        if s.is_empty() || s.len() > 512 || s.chars().any(char::is_control) {
            bail!("Invalid usage attribution");
        }
    }
    for s in [&r.source_id, &r.session_id, &r.event_id, &r.timestamp] {
        if s.is_empty() || s.len() > 512 || s.chars().any(char::is_control) {
            bail!("Invalid usage identity");
        }
    }
    let utc_timestamp = chrono::DateTime::parse_from_rfc3339(&r.timestamp)?
        .with_timezone(&chrono::Utc)
        .to_rfc3339();
    for n in [
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.cached_output_tokens,
        r.reasoning_tokens,
    ]
    .into_iter()
    .flatten()
    {
        if n > 1_000_000_000_000 {
            bail!("Token count exceeds limit");
        }
    }
    if r.reported_cost_usd
        .is_some_and(|n| !n.is_finite() || n < 0.0)
    {
        bail!("Invalid usage cost");
    }
    if r.output_tokens
        .zip(r.cached_output_tokens)
        .is_some_and(|(output, cached)| cached > output)
        || r.output_tokens
            .zip(r.reasoning_tokens)
            .is_some_and(|(output, reasoning)| reasoning > output)
    {
        bail!("Output subset exceeds inclusive output");
    }
    let old = c
        .query_row(
            "SELECT data FROM usage_history_records WHERE source=?1 AND event=?2",
            params![r.source_id, event_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let mut merged = r.clone();
    merged.timestamp = utc_timestamp;
    if let Some(old) = old.as_deref() {
        let existing: UsageRecord = serde_json::from_str(old)?;
        // Exact source/event identity proves overlap. A live replay must not turn
        // a reconciled native event back into an unresolved live projection.
        if r.provenance == "live-acp-native-session"
            && matches!(
                existing.provenance.as_str(),
                "localHistory" | "localSessionAggregate"
            )
        {
            merged.provenance = existing.provenance.clone();
        }
        let baseline_correction = allow_retained_baseline_correction
            && r.source_id == "codex"
            && existing.source_id == "codex"
            && existing.scope == "session"
            && existing.provenance == "localHistory"
            && r.scope == "unattributed"
            && r.provenance == "retainedBaseline"
            && r.model_id.is_none()
            && r.provider_id.is_none()
            && r.session_id == existing.session_id
            && merged.timestamp == existing.timestamp
            && [
                r.input_tokens,
                r.output_tokens,
                r.cache_read_tokens,
                r.cache_write_tokens,
                r.cached_output_tokens,
                r.reasoning_tokens,
            ]
            .into_iter()
            .zip([
                existing.input_tokens,
                existing.output_tokens,
                existing.cache_read_tokens,
                existing.cache_write_tokens,
                existing.cached_output_tokens,
                existing.reasoning_tokens,
            ])
            .all(|(new, old)| new.is_none_or(|new| old.is_some_and(|old| new <= old)));
        if existing.scope != r.scope && !baseline_correction {
            bail!("Usage event scope cannot change");
        }
        if matches!(r.scope.as_str(), "session" | "unattributed")
            && !matches!(
                r.provenance.as_str(),
                "localSessionAggregate" | "retainedBaseline"
            )
        {
            // Streaming snapshots and mirrored fork entries share a native request ID.
            // Preserve the greatest observed counter; late partial events cannot erase usage.
            merged.input_tokens = merged.input_tokens.max(existing.input_tokens);
            merged.output_tokens = merged.output_tokens.max(existing.output_tokens);
            merged.cache_read_tokens = merged.cache_read_tokens.max(existing.cache_read_tokens);
            merged.cache_write_tokens = merged.cache_write_tokens.max(existing.cache_write_tokens);
            merged.cached_output_tokens = merged
                .cached_output_tokens
                .max(existing.cached_output_tokens);
            merged.reasoning_tokens = merged.reasoning_tokens.max(existing.reasoning_tokens);
            merged.timestamp = existing.timestamp;
            merged.session_id = existing.session_id;
            merged.model_id = merged.model_id.or(existing.model_id);
            merged.provider_id = merged.provider_id.or(existing.provider_id);
        }
    }
    let data = serde_json::to_string(&merged)?;
    if old.as_deref() == Some(&data) {
        return Ok(0);
    }
    c.execute("INSERT INTO usage_history_records(source,event,data) VALUES(?1,?2,?3) ON CONFLICT(source,event) DO UPDATE SET data=excluded.data",params![r.source_id,event_key,data])?;
    Ok(if old.is_some() { 2 } else { 1 })
}
#[derive(Default)]
struct Accumulator {
    bucket: HistoryBucket,
    sessions: BTreeSet<(Option<String>, String)>,
}
impl Accumulator {
    fn add(&mut self, r: &UsageRecord, rate: Option<&ModelRates>) {
        if counts_as_session(r) {
            self.sessions.insert((
                r.account_id.clone().filter(|_| r.scope != "unattributed"),
                r.session_id.clone(),
            ));
        }
        self.bucket.records += 1;
        let t = &mut self.bucket.totals;
        t.input_tokens += r.input_tokens.unwrap_or(0);
        t.output_tokens += r.output_tokens.unwrap_or(0);
        t.cache_read_tokens += r.cache_read_tokens.unwrap_or(0);
        t.cache_write_tokens += r.cache_write_tokens.unwrap_or(0);
        t.cached_output_tokens += r.cached_output_tokens.unwrap_or(0);
        t.reasoning_tokens += r.reasoning_tokens.unwrap_or(0);
        t.missing_input_records += u64::from(r.input_tokens.is_none());
        t.missing_output_records += u64::from(r.output_tokens.is_none());
        t.missing_cache_read_records += u64::from(r.cache_read_tokens.is_none());
        t.missing_cache_write_records += u64::from(r.cache_write_tokens.is_none());
        t.missing_cached_output_records += u64::from(r.cached_output_tokens.is_none());
        t.missing_reasoning_records += u64::from(r.reasoning_tokens.is_none());
        if let Some(cost) = r.reported_cost_usd {
            self.bucket.reported_cost_usd =
                Some(self.bucket.reported_cost_usd.unwrap_or(0.0) + cost);
            if r.cost_kind == "billed" {
                self.bucket.billed_cost_usd =
                    Some(self.bucket.billed_cost_usd.unwrap_or(0.0) + cost);
            } else if matches!(
                r.cost_kind.as_str(),
                "sourceEstimate" | "apiEquivalent" | "estimated"
            ) {
                self.bucket.source_estimated_cost_usd =
                    Some(self.bucket.source_estimated_cost_usd.unwrap_or(0.0) + cost);
            }
        }
        let mut cost = 0.0;
        let mut priced = false;
        let mut incomplete = r.input_tokens.is_none() || r.output_tokens.is_none();
        for (tokens, price) in [
            (r.input_tokens, rate.and_then(|p| p.input)),
            (r.output_tokens, rate.and_then(|p| p.output)),
            (r.cache_read_tokens, rate.and_then(|p| p.cache_read)),
            (r.cache_write_tokens, rate.and_then(|p| p.cache_write)),
        ] {
            if let Some(tokens) = tokens {
                if tokens == 0 {
                    continue;
                }
                if let Some(price) = price.filter(|n| n.is_finite() && *n >= 0.0) {
                    cost += tokens as f64 * price / 1_000_000.0;
                    priced = true;
                } else {
                    incomplete = true;
                }
            }
        }
        if priced {
            self.bucket.estimated_cost_usd =
                Some(self.bucket.estimated_cost_usd.unwrap_or(0.0) + cost);
        }
        if incomplete || !priced {
            self.bucket.unpriced_records += 1;
        }
        if let Some((input, read)) = rate.and_then(|p| p.input.zip(p.cache_read)) {
            if input.is_finite() && read.is_finite() && input >= 0.0 && read >= 0.0 {
                let savings =
                    r.cache_read_tokens.unwrap_or(0) as f64 * (input - read).max(0.0) / 1_000_000.0;
                self.bucket.cache_savings_usd =
                    Some(self.bucket.cache_savings_usd.unwrap_or(0.0) + savings);
            }
        }
    }
    fn finish(
        mut self,
        date: String,
        source_id: String,
        model_id: Option<String>,
    ) -> HistoryBucket {
        self.bucket.date = date;
        self.bucket.source_id = source_id;
        self.bucket.model_id = model_id;
        self.bucket.sessions = self.sessions.len() as u64;
        self.bucket
    }
}
