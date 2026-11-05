//! Test-only capture of `tracing` output: a DEBUG-level subscriber that writes
//! into a shared buffer, installed for the current thread with
//! `set_default`. Use it from a current-thread `#[tokio::test]` so the
//! subscriber also covers polling a response body.

use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuffer {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl LogBuffer {
    /// Install a DEBUG-level subscriber writing into this buffer for the
    /// current thread until the returned guard drops.
    pub(super) fn capture(&self) -> tracing::subscriber::DefaultGuard {
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(self.clone())
            .finish();
        tracing::subscriber::set_default(subscriber)
    }

    /// Everything captured so far.
    pub(super) fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }

    /// The captured lines containing `needle`.
    pub(super) fn lines_with(&self, needle: &str) -> Vec<String> {
        self.text()
            .lines()
            .filter(|line| line.contains(needle))
            .map(str::to_owned)
            .collect()
    }

    /// The captured lines logged at `WARN`.
    pub(super) fn warn_lines(&self) -> Vec<String> {
        self.text()
            .lines()
            .filter(|line| line.trim_start().starts_with("WARN "))
            .map(str::to_owned)
            .collect()
    }
}
