//! Content policy, payload sealing, and the span-end sink.

use std::sync::atomic::Ordering;

use super::*;

impl TraceStore {
    /// Replace the content policy with a fixed value.
    pub fn set_content_policy(&self, policy: ContentPolicy) {
        if let Ok(mut guard) = self.inner.content.write() {
            *guard = ContentSource::Fixed(policy);
        }
    }

    /// Read the content policy from `source` on every span, so a host's live
    /// privacy-setting changes apply without re-configuring the store.
    pub fn set_content_policy_source(&self, source: fn() -> ContentPolicy) {
        if let Ok(mut guard) = self.inner.content.write() {
            *guard = ContentSource::Live(source);
        }
    }

    /// Seal captured payloads with `sealer` from now on. Without one the store
    /// persists no payloads, whatever the policy.
    pub fn set_content_sealer(&self, sealer: Arc<dyn ContentSealer>) {
        if let Ok(mut guard) = self.inner.sealer.write() {
            *guard = Some(sealer);
        }
    }

    fn sealer(&self) -> Option<Arc<dyn ContentSealer>> {
        self.inner
            .sealer
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Serialize and seal one payload for `column`. `None` when there is none,
    /// when no sealer is installed, or when sealing fails (the span is still
    /// recorded; a payload is never written unsealed).
    pub(super) fn seal_payload(
        &self,
        purpose: &str,
        id: &str,
        value: Option<&Value>,
    ) -> Option<String> {
        let text = to_json_text(value)?;
        let Some(sealer) = self.sealer() else {
            tracing::warn!("span payload dropped: the trace store has no content sealer");
            return None;
        };
        match sealer.seal(&text, purpose, id) {
            Ok(sealed) => Some(sealed),
            Err(error) => {
                tracing::warn!(%error, "span payload dropped: sealing failed");
                None
            }
        }
    }

    fn open_payload(&self, stored: Option<String>, purpose: &str, id: &str) -> Option<Value> {
        let stored = stored?;
        let plain = match self.sealer() {
            Some(sealer) => match sealer.open(&stored, purpose, id) {
                Ok(plain) => plain,
                Err(error) => {
                    tracing::warn!(%error, "span payload skipped: it did not open");
                    return None;
                }
            },
            None => stored,
        };
        parse_json_text(Some(plain))
    }

    pub(super) fn decode_span(&self, (mut span, input, output): RawSpan) -> Span {
        span.input = self.open_payload(input, INPUT_PURPOSE, &span.id);
        span.output = self.open_payload(output, OUTPUT_PURPOSE, &span.id);
        span
    }

    /// Clear the payloads already stored the first time a write finds capture
    /// off, so switching it off does not leave captured prompts and completions
    /// behind until retention removes them.
    pub(super) fn clear_payloads_if_capture_off(&self, conn: &Connection, capture: bool) {
        let state = if capture { CAPTURE_ON } else { CAPTURE_OFF };
        let previous = self.inner.capture_state.swap(state, Ordering::Relaxed);
        if capture || previous == CAPTURE_OFF {
            return;
        }
        match conn.execute(
            "UPDATE spans SET input = NULL, output = NULL
              WHERE input IS NOT NULL OR output IS NOT NULL",
            [],
        ) {
            Ok(cleared) if cleared > 0 => {
                tracing::info!(cleared, "cleared stored span payloads: capture is off");
            }
            Ok(_) => {}
            Err(error) => {
                // Try again on the next write.
                self.inner
                    .capture_state
                    .store(CAPTURE_UNKNOWN, Ordering::Relaxed);
                tracing::warn!(%error, "could not clear stored span payloads");
            }
        }
    }

    /// Seal payloads stored as plaintext by builds that did not seal them, and
    /// scrub the freed pages. Core calls this once at boot after installing the
    /// sealer. Returns how many values were sealed.
    pub async fn seal_stored_payloads(&self) -> Result<u64> {
        let Some(sealer) = self.sealer() else {
            return Ok(0);
        };
        let conn = self.inner.conn.lock().await;
        let rows: Vec<(String, Option<String>, Option<String>)> = {
            let mut statement = conn.prepare(
                "SELECT id, input, output FROM spans
                  WHERE input IS NOT NULL OR output IS NOT NULL",
            )?;
            let rows =
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut sealed = 0u64;
        for (id, input, output) in rows {
            for (column, purpose, stored) in [
                ("input", INPUT_PURPOSE, input),
                ("output", OUTPUT_PURPOSE, output),
            ] {
                let Some(stored) = stored.filter(|stored| !sealer.is_sealed(stored)) else {
                    continue;
                };
                let Ok(value) = sealer.seal(&stored, purpose, &id) else {
                    continue;
                };
                sealed += conn.execute(
                    &format!("UPDATE spans SET {column} = ?1 WHERE id = ?2 AND {column} IS ?3"),
                    params![value, id, stored],
                )? as u64;
            }
        }
        if sealed > 0 {
            if let Err(error) = conn.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
            ) {
                tracing::warn!(%error, "sealed span payloads, but the trace db scrub failed");
            }
        }
        Ok(sealed)
    }

    /// The current content policy.
    pub fn content_policy(&self) -> ContentPolicy {
        match self.inner.content.read().map(|guard| *guard) {
            Ok(ContentSource::Fixed(policy)) => policy,
            Ok(ContentSource::Live(source)) => source(),
            Err(_) => ContentPolicy::default(),
        }
    }

    /// Whether callers should bother building input/output payloads.
    pub fn captures_content(&self) -> bool {
        self.content_policy().capture
    }

    /// Install (or clear) the span-end sink.
    pub fn set_sink(&self, sink: Option<Arc<dyn SpanSink>>) {
        if let Ok(mut guard) = self.inner.sink.write() {
            *guard = sink;
        }
    }

    pub(super) fn sink(&self) -> Option<Arc<dyn SpanSink>> {
        self.inner.sink.read().ok().and_then(|guard| guard.clone())
    }
}
