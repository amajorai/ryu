use super::{
    adapters::{digest, parse, ParseState},
    HistorySource, UsageRecord,
};

pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
use anyhow::{bail, Result};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

pub(super) const LOCAL_SOURCES: &[(&str, &str, &[&str])] = &[
    (
        "codex",
        "Codex",
        &[".codex/sessions", ".codex/archived_sessions"],
    ),
    (
        "claude-code",
        "Claude Code",
        &[".claude/projects", ".claude/transcripts"],
    ),
    ("opencode", "OpenCode", &[".local/share/opencode"]),
    ("gemini", "Gemini CLI", &[".gemini/tmp"]),
    ("pi", "Pi", &[".pi/agent/sessions"]),
    ("omp", "Oh My Pi", &[".omp/agent/sessions"]),
    ("senpi", "Senpi", &[".senpi/agent/sessions"]),
    ("grok", "Grok Build", &[".grok/sessions"]),
    (
        "antigravity",
        "Antigravity synced metadata",
        &[
            ".config/tokscale/antigravity-cache/sessions",
            "AppData/Roaming/tokscale/antigravity-cache/sessions",
        ],
    ),
    ("droid", "Droid", &[".factory/sessions"]),
    (
        "zed",
        "Zed hosted agent",
        &[
            ".local/share/zed/threads",
            "Library/Application Support/Zed/threads",
            "AppData/Local/Zed/threads",
        ],
    ),
    ("qwen", "Qwen CLI", &[".qwen/projects"]),
    (
        "kimi",
        "Kimi CLI",
        &[".kimi/sessions", ".kimi-code/sessions"],
    ),
    ("amp", "Amp", &[".local/share/amp/threads"]),
    ("copilot", "GitHub Copilot OTEL", &[".copilot/otel"]),
    (
        "cline",
        "Cline",
        &[
            ".cline/data/sessions",
            "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/tasks",
            ".config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks",
            ".vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks",
        ],
    ),
    (
        "roo",
        "Roo Code",
        &[
            "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
            ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
            ".vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
        ],
    ),
    (
        "kilo",
        "Kilo",
        &[
            ".local/share/kilo",
            "AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks",
            ".config/Code/User/globalStorage/kilocode.kilo-code/tasks",
            ".vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks",
        ],
    ),
    (
        "goose",
        "Goose",
        &[
            ".local/share/goose/sessions",
            "Library/Application Support/goose/sessions",
        ],
    ),
    (
        "openclaw",
        "OpenClaw",
        &[".openclaw/agents", ".clawdbot/agents", ".moltbot/agents"],
    ),
];
pub(super) const EXPORT_SOURCES: &[&str] = &[
    "openai-org-usage",
    "openai-org-costs",
    "anthropic-org-usage",
    "anthropic-org-costs",
    "claude-code-analytics",
    "cursor-account",
    "usage-metadata",
];
pub fn sources(home: &Path) -> Vec<HistorySource> {
    let mut result: Vec<_> = LOCAL_SOURCES.iter().map(|(id, label, _)| HistorySource {
        id: (*id).to_owned(), label: (*label).to_owned(), transport: "localFiles".to_owned(),
        available: roots(home, id).is_some_and(|paths| paths.iter().any(|path| path.exists())),
        limitations: match *id {
            "goose" => "Session totals are attributed to session creation date; per-turn daily history and cache counters are unavailable.",
            "droid" => "Measured settings tokenUsage totals require a dated assistant transcript. The whole session is attributed to its last retained assistant date; daily splits and missing counters remain unknown.",
            "zed" => "Only hosted zed.dev JSON/zstd threads with measured usage. Session totals use thread update date; imported threads and external ACP agents are skipped; reasoning is unknown.",
            "grok" => "Only retained completed updates with measured input/output breakdowns and agent timestamps. Legacy totalTokens-only counters and partial updates are skipped.",
            "antigravity" => "Reads existing Tokscale synced usage metadata only; Ryu does not run local RPC sync. Cache-write counts are unavailable in that export; missing or undated usage is skipped.",
            "copilot" => "Only retained OTEL inference spans with native span IDs and explicit token attributes. Account quotas and missing exports are not token histories.",
            _ => "Only retained usage counters are imported. Missing fields stay unknown; source costs are not bills.",
        }.to_owned(),
    }).collect();
    result.extend(EXPORT_SOURCES.iter().map(|id|HistorySource{id:(*id).to_owned(),label:id.replace('-'," "),transport:"metadataExport".to_owned(),available:true,limitations:"Requires an explicit metadata export and account identity. Organization/account aggregates are separate from session totals.".to_owned()}));
    result.push(HistorySource{id:"ryu-acp".to_owned(),label:"Ryu ACP".to_owned(),transport:"liveEvents".to_owned(),available:true,limitations:"Opt-in token counters observed by Ryu. Sessions without native identity cannot be reconciled with external history.".to_owned()});
    for (id, label, reason) in [(
        "cursor-local",
        "Cursor local history",
        "Local conversations do not provide authoritative account billing; import a Cursor account export.",
    )] {
        result.push(HistorySource {
            id: id.to_owned(),
            label: label.to_owned(),
            transport: "unavailable".to_owned(),
            available: false,
            limitations: reason.to_owned(),
        });
    }
    result
}
pub(super) fn roots(home: &Path, id: &str) -> Option<Vec<PathBuf>> {
    let defaults = LOCAL_SOURCES
        .iter()
        .find(|(source, _, _)| *source == id)
        .map(|(_, _, roots)| roots.iter().map(|r| home.join(r)).collect::<Vec<_>>())?;
    if dirs::home_dir().as_deref() != Some(home) {
        return Some(defaults);
    }
    let env_path = |name: &str| {
        std::env::var_os(name).and_then(|value| {
            let p = PathBuf::from(value);
            if p.is_absolute() {
                Some(p)
            } else {
                p.to_str()
                    .and_then(|s| s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")))
                    .map(|s| home.join(s))
            }
        })
    };
    let (variable, suffixes): (&str, &[&str]) = match id {
        "codex" => ("CODEX_HOME", &["sessions", "archived_sessions"]),
        "claude-code" => ("CLAUDE_CONFIG_DIR", &["projects", "transcripts"]),
        "opencode" => ("OPENCODE_DATA_DIR", &[""]),
        "gemini" => ("GEMINI_CLI_HOME", &["tmp"]),
        "pi" => ("PI_CODING_AGENT_DIR", &["sessions"]),
        "senpi" => ("SENPI_CODING_AGENT_DIR", &["sessions"]),
        "kimi" => ("KIMI_CODE_HOME", &["sessions"]),
        "goose" => ("GOOSE_PATH_ROOT", &["data/sessions"]),
        "openclaw" => ("OPENCLAW_STATE_DIR", &["agents"]),
        "antigravity" => ("TOKSCALE_CONFIG_DIR", &["antigravity-cache/sessions"]),
        _ => ("", &[]),
    };
    let mut result = if let Some(base) = env_path(variable) {
        suffixes.iter().map(|s| base.join(s)).collect()
    } else {
        defaults
    };
    if let Some(base) = env_path("XDG_DATA_HOME") {
        match id {
            "opencode" | "amp" | "kilo" => result.push(base.join(id)),
            "goose" => result.push(base.join("goose/sessions")),
            "zed" => result.push(base.join("zed/threads")),
            _ => {}
        }
    }
    if id == "copilot" {
        if let Some(path) = env_path("COPILOT_OTEL_FILE_EXPORTER_PATH") {
            result.push(path);
        }
    }
    if id == "opencode" {
        if let Some(path) = env_path("OPENCODE_DB_PATH") {
            result.push(path);
        }
    }
    if id == "zed" {
        if let Some(base) = env_path("LOCALAPPDATA") {
            result.push(base.join("Zed/threads"));
        }
    }
    if id == "antigravity" && env_path("TOKSCALE_CONFIG_DIR").is_none() {
        if let Some(base) = env_path("XDG_CONFIG_HOME") {
            result.push(base.join("tokscale/antigravity-cache/sessions"));
        }
        if let Some(base) = env_path("APPDATA") {
            result.push(base.join("tokscale/antigravity-cache/sessions"));
        }
    }
    if id == "pi" {
        result.push(crate::pi_config::config_dir().join("sessions"));
    }
    Some(result)
}
pub(super) fn files(root: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    if depth == 0
        && root
            .ancestors()
            .any(|path| fs::symlink_metadata(path).is_ok_and(|m| is_link(&m)))
    {
        bail!("Scan roots cannot traverse links");
    }
    if depth > 16 || out.len() >= 100_000 {
        bail!("Scan limit reached");
    }
    let meta = match fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if is_link(&meta) {
        return Ok(());
    }
    if meta.is_dir() {
        // Agents prune their own transcripts (and Ryu applies age caps to Pi's),
        // so a folder or file can vanish mid-walk: that is not an error.
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            match entry {
                Ok(entry) => files(&entry.path(), out, depth + 1)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    } else if meta.is_file()
        && matches!(
            root.extension().and_then(|s| s.to_str()),
            Some("json" | "jsonl" | "db" | "sqlite" | "csv")
        )
    {
        out.push(root.to_owned());
    }
    Ok(())
}
pub(super) fn fingerprint(path: &Path) -> Result<String> {
    let m = fs::symlink_metadata(path)?;
    if is_link(&m) {
        bail!("Symlink skipped");
    }
    let modified = m
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let wal = fs::metadata(PathBuf::from(format!("{}-wal", path.display())))
        .ok()
        .map(|m| format!("{}:{:?}", m.len(), m.modified().ok()))
        .unwrap_or_default();
    let sibling = path
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_suffix(".settings.json"))
        .map(|s| path.with_file_name(format!("{s}.jsonl")))
        .and_then(|p| fs::symlink_metadata(p).ok())
        .filter(|m| !is_link(m))
        .map(|m| format!("{}:{:?}", m.len(), m.modified().ok()))
        .unwrap_or_default();
    Ok(format!("{}:{modified}:{wal}:{sibling}:v4", m.len()))
}
pub(super) struct ParsedFile {
    pub records: Vec<UsageRecord>,
    pub warnings: Vec<(&'static str, u64)>,
}
pub(super) fn parse_file(
    source: &str,
    path: &Path,
    account_id: Option<&str>,
) -> Result<ParsedFile> {
    let mut warnings = Vec::new();
    let records = parse_file_records(source, path, account_id, &mut warnings)?;
    Ok(ParsedFile { records, warnings })
}
fn parse_file_records(
    source: &str,
    path: &Path,
    account_id: Option<&str>,
    warnings: &mut Vec<(&'static str, u64)>,
) -> Result<Vec<UsageRecord>> {
    let meta = fs::symlink_metadata(path)?;
    if matches!(
        path.file_name().and_then(|s| s.to_str()),
        Some("auth.json" | "credentials.json" | ".credentials.json" | "oauth.json")
    ) {
        return Ok(Vec::new());
    }
    let sqlite = matches!(
        path.extension().and_then(|s| s.to_str()),
        Some("db" | "sqlite")
    );
    if is_link(&meta) || (!sqlite && meta.len() > 512 * 1024 * 1024) {
        bail!("Unsafe or oversized history file");
    }
    let identity = digest(&path.to_string_lossy());
    if path.extension().and_then(|s| s.to_str()) == Some("csv") {
        if meta.len() > 32 * 1024 * 1024 {
            bail!("CSV history exceeds size limit");
        }
        let text = std::fs::read_to_string(path)?;
        let account_id = account_id
            .ok_or_else(|| anyhow::anyhow!("Account identity required for CSV export"))?;
        return super::provider_exports::parse_csv_scoped(
            source,
            &text,
            "metadataExport",
            account_id,
        );
    }
    if matches!(
        path.extension().and_then(|s| s.to_str()),
        Some("db" | "sqlite")
    ) {
        if source == "goose" {
            return parse_goose(path);
        }
        if source == "zed" {
            return parse_zed(path);
        }
        if !matches!(source, "opencode" | "kilo") {
            return Ok(Vec::new());
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        let sql = if conn
            .prepare("SELECT id,session_id,data FROM message LIMIT 0")
            .is_ok()
        {
            "SELECT id,session_id,data FROM message WHERE length(data)<=2097152 LIMIT 1000001"
        } else {
            "SELECT id,session_id,data FROM session_message WHERE length(data)<=2097152 LIMIT 1000001"
        };
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut result = Vec::new();
        for (index, row) in rows.enumerate() {
            if index >= 1_000_000 {
                bail!("SQLite history exceeds row limit");
            }
            let (id, session, data) = row?;
            let mut v: serde_json::Value = serde_json::from_str(&data)?;
            v["id"] = id.into();
            v["sessionID"] = session.into();
            if let Some(r) = parse(source, &v, &identity, &mut ParseState::default()) {
                result.push(r);
            }
        }
        return Ok(result);
    }
    let file = fs::File::open(path)?;
    if path.extension().and_then(|s| s.to_str()) == Some("json") {
        if meta.len() > 32 * 1024 * 1024 {
            bail!("JSON history exceeds size limit");
        }
        let v: serde_json::Value = serde_json::from_reader(file.take(32 * 1024 * 1024 + 1))?;
        if source == "droid" {
            return parse_droid(path, &v);
        }
        if EXPORT_SOURCES.contains(&source) {
            if source == "usage-metadata" && account_id.is_none() {
                return super::provider_exports::parse(source, &v, "metadataExport");
            }
            let account_id = account_id
                .or_else(|| v.get("accountId").and_then(serde_json::Value::as_str))
                .ok_or_else(|| anyhow::anyhow!("Account identity required for provider export"))?;
            return super::provider_exports::parse_scoped(source, &v, "metadataExport", account_id);
        }
        let mut state = ParseState::default();
        let mut result = Vec::new();
        if source == "copilot" && v.get("resourceSpans").is_some() {
            for resource in v
                .get("resourceSpans")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                for scope in resource
                    .get("scopeSpans")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    for span in scope
                        .get("spans")
                        .and_then(|v| v.as_array())
                        .into_iter()
                        .flatten()
                    {
                        if let Some(r) = parse(source, span, &identity, &mut state) {
                            result.push(r);
                        }
                    }
                }
            }
            return Ok(result);
        }
        if matches!(source, "cline" | "roo" | "kilo") && v.is_array() {
            let session = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|v| v.to_str())
                .unwrap_or(&identity);
            for event in v.as_array().unwrap() {
                let mut event = event.clone();
                event["sessionId"] = session.into();
                if let Some(r) = parse(source, &event, &identity, &mut state) {
                    result.push(r);
                }
            }
            return Ok(result);
        }
        if source == "amp" {
            if let Some(events) = v.pointer("/usageLedger/events").and_then(|v| v.as_array()) {
                for (index, event) in events.iter().enumerate() {
                    let mut event = event.clone();
                    if let Some(id) = v.get("id") {
                        event["sessionId"] = id.clone();
                    }
                    event["id"] = serde_json::Value::String(format!(
                        "{}:{index}",
                        v.get("id").and_then(|v| v.as_str()).unwrap_or(&identity)
                    ));
                    if let Some(r) = parse(source, &event, &identity, &mut state) {
                        result.push(r);
                    }
                }
            }
            return Ok(result);
        }
        if let Some(messages) = v.get("messages").and_then(|v| v.as_array()) {
            for message in messages {
                let mut m = message.clone();
                if let Some(id) = v.get("sessionId") {
                    m["sessionId"] = id.clone();
                }
                if let Some(r) = parse(source, &m, &identity, &mut state) {
                    result.push(r);
                }
            }
        } else if let Some(r) = parse(source, &v, &identity, &mut state) {
            result.push(r);
        }
        result.append(&mut state.pending_records);
        return Ok(result);
    }
    // Bound the whole snapshot as well as individual frames. A concurrently
    // appended transcript cannot make this read run without a limit.
    let mut reader = BufReader::new(file.take(512 * 1024 * 1024));
    if source == "droid" {
        return Ok(Vec::new());
    }
    let mut state = ParseState::default();
    let mut result = Vec::new();
    let mut invalid = 0u64;
    let mut oversized = 0u64;
    let mut incomplete = 0u64;
    let mut record_limit = false;
    loop {
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if line.len() > 2 * 1024 * 1024 {
            oversized += 1;
            // Drain this one frame in bounded chunks, preserving the next
            // frame boundary. Prompts and compaction text may be much larger
            // than measured usage events and must not erase valid counters.
            while !line.ends_with(b"\n") && !line.is_empty() {
                line.clear();
                reader
                    .by_ref()
                    .take(64 * 1024)
                    .read_until(b'\n', &mut line)?;
            }
            continue;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice(&line) {
            Ok(v) => {
                if let Some(r) = parse(source, &v, &identity, &mut state) {
                    result.push(r);
                    if result.len() >= 100_000 {
                        record_limit = true;
                        break;
                    }
                }
            }
            Err(_) => {
                if line.ends_with(b"\n") {
                    invalid += 1;
                } else {
                    incomplete += 1;
                }
            }
        }
    }
    result.append(&mut state.pending_records);
    for (message, count) in [
        (
            "oversized JSONL frames skipped; valid usage retained",
            oversized,
        ),
        (
            "invalid JSONL frames skipped; valid usage retained",
            invalid,
        ),
        (
            "incomplete JSONL tail skipped; retry after append",
            incomplete,
        ),
        (
            "JSONL snapshot byte limit reached; usage may be incomplete",
            u64::from(reader.get_ref().limit() == 0),
        ),
        (
            "JSONL snapshot record limit reached; usage may be incomplete",
            u64::from(record_limit),
        ),
    ] {
        if count > 0 {
            warnings.push((message, count));
        }
    }
    if invalid + oversized + incomplete > 0 {
        tracing::warn!(
            source,
            invalid_lines = invalid,
            oversized_lines = oversized,
            incomplete_tails = incomplete,
            "Historical usage parser retained valid counters while skipping unsafe frames"
        );
    }
    Ok(result)
}

fn parse_goose(path: &Path) -> Result<Vec<UsageRecord>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let mut stmt=conn.prepare("SELECT id,model_config_json,provider_name,created_at,COALESCE(accumulated_input_tokens,input_tokens),COALESCE(accumulated_output_tokens,output_tokens) FROM sessions LIMIT 1000000")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (id, model, provider, time, input, output) = row?;
        let timestamp = chrono::DateTime::parse_from_rfc3339(&time)
            .map(|t| t.with_timezone(&chrono::Utc).to_rfc3339())
            .or_else(|_| {
                chrono::NaiveDateTime::parse_from_str(&time, "%Y-%m-%d %H:%M:%S")
                    .map(|t| t.and_utc().to_rfc3339())
            });
        let Ok(timestamp) = timestamp else {
            continue;
        };
        let model_id = model
            .and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok())
            .and_then(|m| {
                m.get("model_name")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            });
        records.push(UsageRecord {
            account_id: None,
            source_id: "goose".to_owned(),
            provider_id: provider,
            model_id,
            session_id: id.clone(),
            event_id: id,
            timestamp,
            input_tokens: input.and_then(|n| u64::try_from(n).ok()),
            output_tokens: output.and_then(|n| u64::try_from(n).ok()),
            cache_read_tokens: None,
            cache_write_tokens: None,
            cached_output_tokens: None,
            reasoning_tokens: None,
            reported_cost_usd: None,
            cost_kind: "unknown".to_owned(),
            provenance: "localSessionAggregate".to_owned(),
            scope: "session".to_owned(),
            bucket_seconds: None,
            request_count: None,
        });
    }
    Ok(records)
}

// Factory's settings file holds measured cumulative counters. Only an authentic
// assistant timestamp from its sibling transcript anchors this session aggregate.
// Neither file mtimes nor transcript character counts stand in for usage dates.
fn parse_droid(path: &Path, settings: &serde_json::Value) -> Result<Vec<UsageRecord>> {
    let Some(stem) = path
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_suffix(".settings.json"))
    else {
        return Ok(Vec::new());
    };
    let Some(usage) = settings.get("tokenUsage") else {
        return Ok(Vec::new());
    };
    let transcript = path.with_file_name(format!("{stem}.jsonl"));
    let metadata = match fs::symlink_metadata(&transcript) {
        Ok(m) => m,
        Err(_) => return Ok(Vec::new()),
    };
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        bail!("Unsafe Droid date metadata");
    }
    let mut reader = BufReader::new(fs::File::open(transcript)?);
    let mut latest = None;
    loop {
        let mut line = Vec::new();
        if reader
            .by_ref()
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            break;
        }
        if line.len() > 2 * 1024 * 1024 {
            bail!("Droid date metadata exceeds line limit");
        }
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(|v| v.as_str()) == Some("message")
            && event.pointer("/message/role").and_then(|v| v.as_str()) == Some("assistant")
        {
            if let Some(time) = event.get("timestamp").and_then(super::adapters::timestamp) {
                if latest.as_ref().is_none_or(|old| &time > old) {
                    latest = Some(time);
                }
            }
        }
    }
    let Some(timestamp) = latest else {
        return Ok(Vec::new());
    };
    let input = super::adapters::count(usage, &["inputTokens"]);
    let output = super::adapters::count(usage, &["outputTokens"]);
    let thinking = super::adapters::count(usage, &["thinkingTokens"]);
    if input.is_none() && output.is_none() {
        return Ok(Vec::new());
    }
    Ok(vec![UsageRecord {
        account_id: None,
        source_id: "droid".to_owned(),
        provider_id: settings
            .get("providerLock")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        model_id: settings
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        session_id: stem.to_owned(),
        event_id: stem.to_owned(),
        timestamp,
        input_tokens: input,
        // Factory reports thinking separately; the Ryu output bucket includes
        // its reasoning subset so model-rate estimation counts it exactly once.
        output_tokens: output.map(|n| n.saturating_add(thinking.unwrap_or(0))),
        cache_read_tokens: super::adapters::count(usage, &["cacheReadTokens"]),
        cache_write_tokens: super::adapters::count(usage, &["cacheCreationTokens"]),
        reasoning_tokens: thinking,
        cached_output_tokens: None,
        reported_cost_usd: None,
        cost_kind: "unknown".to_owned(),
        provenance: "localSessionAggregate".to_owned(),
        scope: "session".to_owned(),
        bucket_seconds: None,
        request_count: None,
    }])
}

// Zed persists language_model::TokenUsage in JSON/zstd threads. Count only
// zed.dev hosted models; external ACP rows belong to their native agents.
fn parse_zed(path: &Path) -> Result<Vec<UsageRecord>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let mut statement = conn.prepare("SELECT id,updated_at,data_type,data FROM threads WHERE length(data)<=33554432 LIMIT 1000001")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;
    let mut records = Vec::new();
    for (index, row) in rows.enumerate() {
        if index >= 1_000_000 {
            bail!("Zed history exceeds row limit");
        }
        let (id, updated, kind, data) = row?;
        let decoded = match kind.as_str() {
            "json" => data,
            "zstd" => {
                let mut decoded = Vec::new();
                zstd::Decoder::new(data.as_slice())?
                    .take(32 * 1024 * 1024 + 1)
                    .read_to_end(&mut decoded)?;
                if decoded.len() > 32 * 1024 * 1024 {
                    bail!("Zed decompressed history exceeds size limit");
                }
                decoded
            }
            _ => continue,
        };
        let v: serde_json::Value = serde_json::from_slice(&decoded)?;
        if v.get("imported").and_then(|v| v.as_bool()) == Some(true)
            || v.pointer("/model/provider").and_then(|v| v.as_str()) != Some("zed.dev")
        {
            continue;
        }
        let Some(timestamp) = super::adapters::timestamp(&serde_json::Value::String(updated))
        else {
            continue;
        };
        let request = v.get("request_token_usage");
        let usages: Vec<&serde_json::Value> = match request {
            Some(serde_json::Value::Object(map)) => map.values().collect(),
            Some(serde_json::Value::Array(array)) => array.iter().collect(),
            _ => Vec::new(),
        };
        let usages = if usages.iter().any(|u| {
            [
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ]
            .iter()
            .any(|key| super::adapters::count(u, &[*key]).is_some_and(|n| n > 0))
        }) {
            usages
        } else {
            v.get("cumulative_token_usage").into_iter().collect()
        };
        let sum = |key: &str| {
            if usages.is_empty() {
                return None;
            }
            usages.iter().try_fold(0u64, |total, usage| {
                // language_model_core::TokenUsage omits zero fields on write
                // and defaults them to zero on read. Invalid values stay unknown.
                let value = if usage.get(key).is_none() {
                    Some(0)
                } else {
                    super::adapters::count(usage, &[key])
                };
                total.checked_add(value?)
            })
        };
        let input = sum("input_tokens");
        let output = sum("output_tokens");
        if input.is_none() && output.is_none() {
            continue;
        }
        records.push(UsageRecord {
            account_id: None,
            source_id: "zed".to_owned(),
            provider_id: Some("zed.dev".to_owned()),
            model_id: v
                .pointer("/model/model")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            session_id: id.clone(),
            event_id: id,
            timestamp,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: sum("cache_read_input_tokens"),
            cache_write_tokens: sum("cache_creation_input_tokens"),
            cached_output_tokens: None,
            reasoning_tokens: None,
            reported_cost_usd: None,
            cost_kind: "unknown".to_owned(),
            provenance: "localSessionAggregate".to_owned(),
            scope: "session".to_owned(),
            bucket_seconds: None,
            request_count: None,
        });
    }
    Ok(records)
}
