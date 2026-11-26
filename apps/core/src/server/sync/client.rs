//! The HTTP client: push, pull and the SSE change feed.

use super::*;

impl SyncClient {
    /// Build a sync client from the environment.
    ///
    /// `server_url` - `RYU_SERVER_URL`, else the backend of the last device
    ///   sign-in (`crate::auth::load_backend_url`), which must use https.
    ///   There is no default address.
    /// `token` - loaded via [`crate::auth::load_token`].
    ///
    /// Returns [`SyncError::Unauthenticated`] when no token is stored and
    /// [`SyncError::Backend`] when no backend can be used.
    pub fn from_env() -> Result<Self, SyncError> {
        Self::from_sources(
            std::env::var(backend::SERVER_URL_ENV).ok(),
            crate::auth::load_backend_url(),
            crate::auth::load_token(),
        )
    }

    /// [`Self::from_env`] with its inputs passed in: the `RYU_SERVER_URL`
    /// value, the stored sign-in backend and the stored token. No client is
    /// built when either check fails.
    pub fn from_sources(
        env_url: Option<String>,
        stored_url: Option<String>,
        token: Option<String>,
    ) -> Result<Self, SyncError> {
        let token = token.ok_or(SyncError::Unauthenticated)?;
        let server_url =
            backend::resolve_backend_base(env_url, stored_url).map_err(SyncError::Backend)?;
        Ok(Self::new(server_url, token))
    }

    /// Build a sync client with explicit values (used in tests / integration).
    pub fn new(server_url: impl Into<String>, token: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("building reqwest client");
        Self {
            server_url: server_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http,
        }
    }

    pub(super) fn pull_url(&self, path: &str, since_ms: i64, cursor: Option<&str>) -> String {
        let mut url = format!("{}/api/{path}?since={since_ms}", self.server_url);
        if let Some(cursor) = cursor {
            url.push_str("&cursor=");
            url.push_str(&urlencoding::encode(cursor));
        }
        url
    }

    /// Push one conversation (all messages) to the server store.
    pub async fn push(
        &self,
        store: &ConversationStore,
        conversation_id: &str,
    ) -> Result<(), SyncError> {
        let payload = build_sync_payload(store, conversation_id)
            .await
            .map_err(SyncError::Store)?;

        let url = format!("{}/api/conversations-sync/push", self.server_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::ServerError(status, body));
        }
        Ok(())
    }

    /// Push one non-binary Spaces document snapshot to the user's cloud mirror.
    pub async fn push_document(&self, payload: &DocumentSyncPayload) -> Result<(), SyncError> {
        let url = format!("{}/api/documents-sync/push", self.server_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(payload)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::ServerError(status, body));
        }
        Ok(())
    }

    /// Pull document snapshots changed since `since_ms` and apply each row
    /// independently so one malformed or inaccessible document cannot abort the
    /// rest of the batch.
    pub async fn pull_documents_since(
        &self,
        store: &crate::server::spaces::SpaceStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<usize, SyncError> {
        Ok(self
            .pull_documents_since_with_snapshot(store, since_ms, tenancy)
            .await?
            .applied)
    }

    pub(super) async fn pull_documents_since_with_snapshot(
        &self,
        store: &crate::server::spaces::SpaceStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<SyncPullOutcome, SyncError> {
        let mut cursor: Option<String> = None;
        let mut outcome = SyncPullOutcome::default();
        for _page in 0..MAX_SYNC_PAGES {
            let url = self.pull_url("documents-sync/pull", since_ms, cursor.as_deref());
            let resp = self.http.get(&url).bearer_auth(&self.token).send().await?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(SyncError::ServerError(status, body));
            }
            let data: DocumentPullPage = resp.json().await?;
            record_pull_snapshot(
                &mut outcome,
                data.snapshot_at,
                cursor.is_some() || data.next_cursor.is_some(),
            )?;
            let mut apply_error = None;
            for payload in data.documents {
                match apply_document_sync_payload(store, &payload, tenancy.clone()).await {
                    Ok(true) => outcome.applied += 1,
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(
                            "cloud sync: applying pulled document {} failed: {error:#}",
                            payload.document_id
                        );
                        if apply_error.is_none() {
                            apply_error = Some(error);
                        }
                    }
                }
            }
            if let Some(error) = apply_error {
                return Err(SyncError::Store(error));
            }
            let Some(next_cursor) = data.next_cursor else {
                return Ok(outcome);
            };
            if next_cursor.is_empty() || cursor.as_deref() == Some(next_cursor.as_str()) {
                return Err(SyncError::ServerError(
                    502,
                    "sync server returned a non-advancing cursor".to_owned(),
                ));
            }
            cursor = Some(next_cursor);
        }
        Err(SyncError::ServerError(
            502,
            "sync server returned too many pages".to_owned(),
        ))
    }

    /// Pull all conversations updated at or after `since_ms` and apply them
    /// to the local store.  Pass `0` for a full sync.
    ///
    /// Returns the number of conversations applied.
    ///
    /// `tenancy` is the receiving node's CONTEXT (its org + the signed-in device
    /// account), not the owner written to a row — each replayed row is owned by its
    /// OWN payload author (see [`effective_replay_tenancy`]). [`apply_sync_payload`]
    /// REFUSES an author-less replay on an org-bound node rather than minting rows
    /// nobody can read.
    pub async fn pull_since(
        &self,
        store: &ConversationStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<usize, SyncError> {
        Ok(self
            .pull_since_with_snapshot(store, since_ms, tenancy)
            .await?
            .applied)
    }

    pub(super) async fn pull_since_with_snapshot(
        &self,
        store: &ConversationStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<SyncPullOutcome, SyncError> {
        let mut cursor: Option<String> = None;
        let mut outcome = SyncPullOutcome::default();
        for _page in 0..MAX_SYNC_PAGES {
            let url = self.pull_url("conversations-sync/pull", since_ms, cursor.as_deref());
            let resp = self.http.get(&url).bearer_auth(&self.token).send().await?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(SyncError::ServerError(status, body));
            }
            let data: ConversationPullPage = resp.json().await?;
            record_pull_snapshot(
                &mut outcome,
                data.snapshot_at,
                cursor.is_some() || data.next_cursor.is_some(),
            )?;
            let mut apply_error = None;
            for payload in data.conversations {
                // Per-row best-effort: a single fail-closed refusal (e.g. an
                // author-less row on a bound node) must not abort the batch.
                match apply_sync_payload(store, &payload, tenancy.clone()).await {
                    Ok(()) => outcome.applied += 1,
                    Err(error) => {
                        tracing::warn!(
                            "cloud sync: applying pulled conversation {} failed: {error}",
                            payload.conversation_id
                        );
                        if apply_error.is_none() {
                            apply_error = Some(error);
                        }
                    }
                }
            }
            if let Some(error) = apply_error {
                return Err(SyncError::Store(error));
            }
            let Some(next_cursor) = data.next_cursor else {
                return Ok(outcome);
            };
            if next_cursor.is_empty() || cursor.as_deref() == Some(next_cursor.as_str()) {
                return Err(SyncError::ServerError(
                    502,
                    "sync server returned a non-advancing cursor".to_owned(),
                ));
            }
            cursor = Some(next_cursor);
        }
        Err(SyncError::ServerError(
            502,
            "sync server returned too many pages".to_owned(),
        ))
    }

    /// Consume the SSE change feed, applying each delta to the local store as it
    /// arrives. Connects to `GET /api/conversations-sync/stream?since=<ms>`,
    /// which first emits a snapshot of everything changed since `since_ms` and
    /// then streams new deltas live (same LWW + union-merge semantics as
    /// [`Self::pull_since`], via [`apply_sync_payload`]).
    ///
    /// Returns `Ok(())` when the server closes the stream; returns an error if
    /// the stream cannot be established, so the caller can fall back to `/pull`.
    ///
    /// Per the repo convention, SSE is read with a fetch-style byte stream (not
    /// an `EventSource`) so the bearer token rides the `Authorization` header.
    /// The tiny frame parser mirrors [`parse_change_frame`] — `:` keepalive
    /// comments and non-`data:` lines are ignored.
    pub async fn stream_changes(
        &self,
        store: &ConversationStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<(), SyncError> {
        self.stream_changes_with_snapshot(store, since_ms, tenancy)
            .await
            .map(|_| ())
    }

    pub(super) async fn stream_changes_with_snapshot(
        &self,
        store: &ConversationStore,
        since_ms: i64,
        tenancy: Tenancy,
    ) -> Result<SyncStreamOutcome, SyncError> {
        use futures_util::StreamExt;

        let url = format!(
            "{}/api/conversations-sync/stream?since={}",
            self.server_url, since_ms
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .header("accept", "text/event-stream")
            // The client-wide 30 s total timeout also bounds body reads, which
            // would cut this long-lived stream off halfway through every sync
            // window. Outlive the caller's `SYNC_INTERVAL` window instead.
            .timeout(SYNC_INTERVAL + Duration::from_secs(5))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::ServerError(status, body));
        }

        let snapshot_at = resp
            .headers()
            .get("x-ryu-sync-snapshot-at")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value >= 0);
        let mut buf = Vec::new();
        let mut stream = resp.bytes_stream();
        let mut apply_error = None;
        let mut frame_error = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buf.extend_from_slice(&chunk);
            // SSE events are separated by a blank line — drain complete frames.
            while let Some(frame) = take_sse_frame(&mut buf) {
                if frame_has_data(&frame) {
                    let Some(payload) = parse_change_frame_bytes(&frame) else {
                        frame_error = true;
                        continue;
                    };
                    if let Err(error) = apply_sync_payload(store, &payload, tenancy.clone()).await {
                        tracing::warn!("cloud sync: applying streamed delta failed: {error}");
                        if apply_error.is_none() {
                            apply_error = Some(error);
                        }
                    }
                }
            }
        }
        if !buf.is_empty() {
            frame_error = true;
        }
        if let Some(error) = apply_error {
            return Err(SyncError::Store(error));
        }
        if frame_error {
            return Err(SyncError::ServerError(
                502,
                "sync server returned an incomplete or invalid SSE frame".to_owned(),
            ));
        }
        Ok(SyncStreamOutcome { snapshot_at })
    }
}

/// Drain one complete SSE frame without decoding incomplete UTF-8 bytes.
/// Supports the LF framing emitted by Ryu and CRLF framing from a proxy.
pub(super) fn take_sse_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let mut end = None;
    for index in 0..buffer.len().saturating_sub(1) {
        if buffer[index..].starts_with(b"\n\n") {
            end = Some(index + 2);
            break;
        }
        if buffer[index..].starts_with(b"\r\n\r\n") {
            end = Some(index + 4);
            break;
        }
    }
    end.map(|end| buffer.drain(..end).collect())
}

pub(super) fn parse_change_frame_bytes(raw: &[u8]) -> Option<SyncPayload> {
    std::str::from_utf8(raw).ok().and_then(parse_change_frame)
}

pub(super) fn frame_has_data(raw: &[u8]) -> bool {
    std::str::from_utf8(raw)
        .ok()
        .map(|frame| {
            frame
                .lines()
                .any(|line| line.trim_end_matches('\r').starts_with("data:"))
        })
        .unwrap_or(true)
}

/// Parse one SSE frame from the change feed into a [`SyncPayload`].
/// Concatenates `data:` lines (SSE spec) and JSON-decodes them; ignores `:`
/// keepalive comments plus the `event:`/`id:` lines. Returns `None` for
/// keepalives and any frame that does not decode to a payload.
pub(super) fn parse_change_frame(raw: &str) -> Option<SyncPayload> {
    let mut data = String::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data).ok()
}
