//! Core's rotating log file (`RYU_CORE_LOG_PATH`).
//!
//! Logs are redacted, not sealed: every formatted record passes through
//! [`redact_log_text`] before it reaches the file, which masks Ryu and provider
//! token shapes, bearer credentials and JWTs. The log directory is created
//! owner-only (`0700`) and every log file, including rotated backups, is `0600`.
//! Content (prompts, replies, file contents) does not belong in logs at all:
//! callers log methods, ids and sizes, and truncate third-party stderr with
//! [`truncate_for_log`].

use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::Layer;
use tracing_subscriber::registry::LookupSpan;

const CORE_LOG_PATH_ENV: &str = "RYU_CORE_LOG_PATH";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKUPS: usize = 4;
static CORE_LOG_WRITER: OnceLock<Option<RotatingLogWriter>> = OnceLock::new();

pub fn from_env<S>() -> Option<Box<dyn Layer<S> + Send + Sync>>
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a> + Send + Sync,
{
    let writer = writer_from_env()?;
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer)
            .boxed(),
    )
}

pub fn initialize_from_env() {
    let _ = writer_from_env();
}

pub fn write_diagnostic(message: impl std::fmt::Display) {
    if let Some(writer) = writer_from_env() {
        let mut output = writer.make_writer();
        let _ = writeln!(output, "{message}");
    } else {
        eprintln!("{message}");
    }
}

/// Characters third-party output is cut to before it is logged.
pub const MAX_LOGGED_OUTPUT_CHARS: usize = 512;

/// Token prefixes whose value is a credential. Matched only when at least
/// [`MIN_SECRET_TAIL`] credential characters follow, so identifiers such as
/// `ryu_core::server` stay readable.
const SECRET_PREFIXES: &[&str] = &["gwrelay_", "gwadm_", "ryux_", "ryu_", "sk-", "tskey-"];
const MIN_SECRET_TAIL: usize = 16;
const REDACTED_MARK: &str = "[redacted]";

fn is_token_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn regexes() -> &'static (regex::Regex, regex::Regex) {
    static PATTERNS: OnceLock<(regex::Regex, regex::Regex)> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        (
            regex::Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}").expect("bearer pattern"),
            regex::Regex::new(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}")
                .expect("jwt pattern"),
        )
    })
}

/// Mask credential shapes in one log record: Ryu tokens (`ryu_`, `ryux_`,
/// `gwrelay_`, `gwadm_`), provider keys (`sk-`), Tailscale keys (`tskey-`),
/// `Bearer` credentials and JWTs. Borrowed when nothing matched.
pub fn redact_log_text(text: &str) -> Cow<'_, str> {
    let (bearer, jwt) = regexes();
    let mut out: Cow<'_, str> = Cow::Borrowed(text);
    if bearer.is_match(&out) {
        out = Cow::Owned(bearer.replace_all(&out, "Bearer [redacted]").into_owned());
    }
    if jwt.is_match(&out) {
        out = Cow::Owned(jwt.replace_all(&out, REDACTED_MARK).into_owned());
    }
    if !SECRET_PREFIXES.iter().any(|prefix| out.contains(prefix)) {
        return out;
    }
    let source = out.into_owned();
    let mut result = String::with_capacity(source.len());
    let mut rest = source.as_str();
    'scan: while !rest.is_empty() {
        for prefix in SECRET_PREFIXES {
            if let Some(tail) = rest.strip_prefix(prefix) {
                let preceded_by_token = result.chars().next_back().is_some_and(is_token_char);
                let tail_len = tail
                    .char_indices()
                    .find(|(_, character)| !is_token_char(*character))
                    .map_or(tail.len(), |(index, _)| index);
                if !preceded_by_token && tail_len >= MIN_SECRET_TAIL {
                    result.push_str(prefix);
                    result.push_str(REDACTED_MARK);
                    rest = &tail[tail_len..];
                    continue 'scan;
                }
            }
        }
        let mut chars = rest.chars();
        if let Some(character) = chars.next() {
            result.push(character);
        }
        rest = chars.as_str();
    }
    Cow::Owned(result)
}

/// Cut third-party output to [`MAX_LOGGED_OUTPUT_CHARS`] and redact it.
pub fn truncate_for_log(text: &str) -> String {
    let trimmed = text.trim_end();
    let mut cut: String = trimmed.chars().take(MAX_LOGGED_OUTPUT_CHARS).collect();
    if cut.len() < trimmed.len() {
        cut.push('…');
    }
    redact_log_text(&cut).into_owned()
}

/// Create `dir` owner-only when it does not exist yet; tighten an existing
/// directory only when it is a dedicated `logs` folder (never, say, `/tmp`).
fn prepare_log_dir(dir: &Path) -> io::Result<()> {
    let existed = dir.is_dir();
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    if !existed || dir.file_name().is_some_and(|name| name == "logs") {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = existed;
    Ok(())
}

/// Open a log file for appending, owner-only (`0600`, also tightened when it
/// already existed).
pub fn open_private_log(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

fn writer_from_env() -> Option<RotatingLogWriter> {
    CORE_LOG_WRITER
        .get_or_init(|| {
            let path = PathBuf::from(std::env::var_os(CORE_LOG_PATH_ENV)?);
            if path.as_os_str().is_empty() {
                return None;
            }

            match RotatingLogWriter::open(path) {
                Ok(writer) => Some(writer),
                Err(error) => {
                    eprintln!("core: rotating log file unavailable: {error}");
                    None
                }
            }
        })
        .clone()
}

#[derive(Clone)]
struct RotatingLogWriter {
    state: Arc<Mutex<RotatingLogState>>,
}

impl RotatingLogWriter {
    fn open(path: PathBuf) -> io::Result<Self> {
        Self::open_with_limits(path, MAX_LOG_BYTES, MAX_BACKUPS)
    }

    fn open_with_limits(path: PathBuf, max_bytes: u64, max_backups: usize) -> io::Result<Self> {
        if path.file_name().is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "log path must name a file",
            ));
        }
        if max_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "log file size limit must be positive",
            ));
        }

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        prepare_log_dir(parent)?;

        let mut state = RotatingLogState {
            path,
            file: None,
            active_size: 0,
            rotation_failed_reported: false,
            max_bytes,
            max_backups,
        };
        state.open_active_file()?;

        Ok(Self {
            state: Arc::new(Mutex::new(state)),
        })
    }
}

struct RotatingLogState {
    path: PathBuf,
    file: Option<File>,
    active_size: u64,
    rotation_failed_reported: bool,
    max_bytes: u64,
    max_backups: usize,
}

impl RotatingLogState {
    fn open_active_file(&mut self) -> io::Result<()> {
        let file = open_private_log(&self.path)?;
        self.active_size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn rotate_if_full(&mut self) -> io::Result<()> {
        // The writer holds the mutex for one formatted event, so rotation never
        // splits a record. A single large event may put the active file over the cap.
        if self.active_size < self.max_bytes {
            return Ok(());
        }

        drop(self.file.take());
        let rotation_result = self.shift_backups();
        let open_result = self.open_active_file();
        rotation_result.and(open_result)
    }

    fn shift_backups(&self) -> io::Result<()> {
        if self.max_backups == 0 {
            return remove_if_present(&self.path);
        }

        for backup_index in (1..=self.max_backups).rev() {
            let source = if backup_index == 1 {
                self.path.clone()
            } else {
                backup_path(&self.path, backup_index - 1)
            };
            let destination = backup_path(&self.path, backup_index);

            remove_if_present(&destination)?;
            match fs::rename(&source, destination) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }

        Ok(())
    }
}

impl<'a> MakeWriter<'a> for RotatingLogWriter {
    type Writer = RotatingLogGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.rotate_if_full() {
            Ok(()) => state.rotation_failed_reported = false,
            Err(error) => {
                if !state.rotation_failed_reported {
                    eprintln!("core: log rotation failed; pausing file output: {error}");
                    state.rotation_failed_reported = true;
                }
                drop(state.file.take());
            }
        }
        RotatingLogGuard { state }
    }
}

struct RotatingLogGuard<'a> {
    state: MutexGuard<'a, RotatingLogState>,
}

impl Write for RotatingLogGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let file =
            self.state.file.as_mut().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "log file is unavailable")
            })?;
        // The fmt layer hands over one whole record per write, so a token is
        // never split across calls.
        let redacted = redact_log_text(&String::from_utf8_lossy(buffer)).into_owned();
        file.write_all(redacted.as_bytes())?;
        self.state.active_size = self.state.active_size.saturating_add(redacted.len() as u64);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.state
            .file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "log file is unavailable"))?
            .flush()
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut file_name = path.file_name().unwrap_or_default().to_os_string();
    file_name.push(format!(".{index}"));
    path.with_file_name(file_name)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::{backup_path, redact_log_text, truncate_for_log, RotatingLogWriter};
    use tracing_subscriber::fmt::MakeWriter as _;
    use tracing_subscriber::layer::SubscriberExt;

    fn write_formatted_event(writer: &RotatingLogWriter, iteration: usize) {
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .without_time()
                .with_ansi(false)
                .with_target(false)
                .with_writer(writer.clone()),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(iteration, "rotation test event");
        });
    }

    #[test]
    fn rotates_formatted_events_and_keeps_only_the_configured_backups() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let path = directory.path().join("core.log");
        let writer =
            RotatingLogWriter::open_with_limits(path.clone(), 1, 2).expect("open rotating log");

        for iteration in 0..5 {
            write_formatted_event(&writer, iteration);
        }

        drop(writer);
        let reopened =
            RotatingLogWriter::open_with_limits(path.clone(), 1, 2).expect("reopen rotating log");
        write_formatted_event(&reopened, 5);

        let current = fs::read_to_string(&path).expect("current log");
        let first_backup = fs::read_to_string(backup_path(&path, 1)).expect("first backup");
        let second_backup = fs::read_to_string(backup_path(&path, 2)).expect("second backup");

        assert!(current.contains("iteration=5"));
        assert!(first_backup.contains("iteration=4"));
        assert!(second_backup.contains("iteration=3"));
        assert!(!backup_path(&path, 3).exists());
    }

    #[test]
    fn stops_appending_when_a_full_log_cannot_rotate() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let path = directory.path().join("core.log");
        let writer =
            RotatingLogWriter::open_with_limits(path.clone(), 1, 1).expect("open rotating log");
        write_formatted_event(&writer, 0);

        let active_size = fs::metadata(&path).expect("active log").len();
        fs::create_dir(backup_path(&path, 1)).expect("block backup replacement");
        let mut output = writer.make_writer();

        assert!(output.write_all(b"must not grow the full log\n").is_err());
        assert_eq!(
            fs::metadata(&path)
                .expect("active log after failed rotation")
                .len(),
            active_size
        );
    }

    #[test]
    fn redacts_credential_shapes_and_keeps_identifiers() {
        let line = "target=ryu_core::server token=ryu_0123456789abcdef0123456789abcdef \
                    relay=gwrelay_ABCDEFGHIJKLMNOPQRST key=sk-proj-abcdefghijklmnopqrstuv \
                    ts=tskey-auth-kAbCdEfGhIjKlMnOp auth=\"Bearer abc.def-ghi_jklmnop\" \
                    jwt=eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl";
        let redacted = redact_log_text(line);
        assert!(redacted.contains("target=ryu_core::server"));
        for secret in [
            "0123456789abcdef0123456789abcdef",
            "ABCDEFGHIJKLMNOPQRST",
            "abcdefghijklmnopqrstuv",
            "kAbCdEfGhIjKlMnOp",
            "abc.def-ghi_jklmnop",
            "eyJzdWIiOiIx",
        ] {
            assert!(!redacted.contains(secret), "{secret} leaked: {redacted}");
        }
        assert!(matches!(
            redact_log_text("plain line"),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    #[test]
    fn truncates_and_redacts_third_party_output() {
        let long = format!("Bearer abcdefghijklmnop {}", "x".repeat(2000));
        let cut = truncate_for_log(&long);
        assert!(cut.chars().count() <= super::MAX_LOGGED_OUTPUT_CHARS + 1);
        assert!(!cut.contains("abcdefghijklmnop"));
    }

    #[test]
    fn log_file_is_redacted_and_owner_only() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let logs = directory.path().join("logs");
        let path = logs.join("core.log");
        let writer = RotatingLogWriter::open_with_limits(path.clone(), 1024 * 1024, 2)
            .expect("open rotating log");
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer.clone()),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("upstream said Authorization: Bearer sk-live-0123456789abcdefghij");
        });
        let text = fs::read_to_string(&path).expect("log");
        assert!(text.contains("Bearer [redacted]"));
        assert!(!text.contains("0123456789abcdefghij"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(&logs).unwrap().permissions().mode() & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }
    }
}
