//! Span reads, trace listings, deletion, and retention passes.

use rusqlite::OptionalExtension;

use super::*;
use crate::{build_tree, RunTraceTree, TraceQuery, TraceSummary};

impl TraceStore {
    /// One span by row id.
    pub async fn get_span(&self, span_row_id: &str) -> Result<Option<Span>> {
        let raw = {
            let conn = self.inner.conn.lock().await;
            conn.query_row(
                &format!("SELECT {} FROM spans s WHERE s.id = ?1", span_columns("s")),
                params![span_row_id],
                span_from_row,
            )
            .optional()
            .context("reading span")?
        };
        Ok(raw.map(|raw| self.decode_span(raw)))
    }

    /// Return all spans for a run in ascending `seq` order.
    pub async fn get_spans(&self, conversation_id: &str) -> Result<Vec<Span>> {
        let raw = {
            let conn = self.inner.conn.lock().await;
            let mut stmt = conn.prepare(&format!(
                "SELECT {} FROM spans s WHERE s.conversation_id = ?1 ORDER BY s.seq ASC",
                span_columns("s")
            ))?;
            let rows = stmt.query_map(params![conversation_id], span_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .context("reading spans")?
        };
        Ok(raw.into_iter().map(|raw| self.decode_span(raw)).collect())
    }

    /// Every span of one trace in ascending `seq` order.
    pub async fn get_trace_spans(&self, trace_id: &str) -> Result<Vec<Span>> {
        let raw = {
            let conn = self.inner.conn.lock().await;
            let mut stmt = conn.prepare(&format!(
                "SELECT {} FROM spans s WHERE s.trace_id = ?1 ORDER BY s.seq ASC",
                span_columns("s")
            ))?;
            let rows = stmt.query_map(params![trace_id], span_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .context("reading trace spans")?
        };
        Ok(raw.into_iter().map(|raw| self.decode_span(raw)).collect())
    }

    /// A run's spans assembled into a tree.
    pub async fn get_tree(&self, conversation_id: &str) -> Result<RunTraceTree> {
        Ok(build_tree(
            conversation_id,
            self.get_spans(conversation_id).await?,
        ))
    }

    /// List traces (root spans with their span/error counts), newest first.
    pub async fn list_traces(&self, query: &TraceQuery) -> Result<Vec<TraceSummary>> {
        let run_ids = query
            .run_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let search = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let like = search.map(|value| {
            let escaped = value
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            format!("%{escaped}%")
        });
        let limit = match query.limit {
            0 => 50,
            value => value.min(500),
        } as i64;
        let status = status_sql("r");
        let child_error = "(c.status = 'error' OR (c.status IS NULL AND c.error IS NOT NULL))";
        let sql = format!(
            "SELECT r.trace_id, r.conversation_id, r.id, r.span_id, r.kind, r.name, r.agent_id,
                    {status}, r.started_at, r.ended_at,
                    (SELECT COUNT(*) FROM spans c WHERE c.trace_id = r.trace_id),
                    (SELECT COUNT(*) FROM spans c WHERE c.trace_id = r.trace_id AND {child_error})
               FROM spans r
              WHERE r.trace_id IS NOT NULL AND r.parent_span_id IS NULL
                AND (?1 IS NULL OR r.conversation_id IN (SELECT value FROM json_each(?1)))
                AND (?2 IS NULL OR r.agent_id = ?2)
                AND (?3 IS NULL OR {status} = ?3)
                AND (?4 IS NULL OR r.kind = ?4)
                AND (?5 IS NULL OR r.started_at >= ?5)
                AND (?6 IS NULL OR r.started_at <= ?6)
                AND (?7 IS NULL OR r.name LIKE ?7 ESCAPE '\\'
                     OR r.conversation_id = ?8 OR r.trace_id = ?8)
              ORDER BY r.started_at DESC, r.seq DESC
              LIMIT ?9 OFFSET ?10"
        );
        let conn = self.inner.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                run_ids,
                query.agent_id,
                query.status.map(SpanStatus::as_str),
                query.kind.map(SpanKind::as_str),
                query.since,
                query.until,
                like,
                search,
                limit,
                query.offset as i64,
            ],
            |row| {
                let status: String = row.get(7)?;
                let started_at: i64 = row.get(8)?;
                let ended_at: Option<i64> = row.get(9)?;
                Ok(TraceSummary {
                    trace_id: row.get(0)?,
                    run_id: row.get(1)?,
                    root_id: row.get(2)?,
                    span_id: row.get(3)?,
                    kind: row.get(4)?,
                    name: row.get(5)?,
                    agent_id: row.get(6)?,
                    status: SpanStatus::parse(&status).unwrap_or_default(),
                    started_at,
                    ended_at,
                    duration_ms: ended_at.map(|end| end.saturating_sub(started_at)),
                    span_count: row.get(10)?,
                    error_count: row.get(11)?,
                })
            },
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("listing traces")
    }

    /// Delete every span for a temporary or deleted run. Trace rows have no
    /// independent ownership; retaining them after their conversation disappears
    /// would leave no durable ACL principal to authorize a later read.
    pub async fn delete_spans(&self, conversation_id: &str) -> Result<u64> {
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(conversation_id);
        }
        let conn = self.inner.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM spans WHERE conversation_id = ?1",
            params![conversation_id],
        )? as u64)
    }

    /// Apply the configured trace retention policy immediately. In-memory stores
    /// are intentionally no-ops; persistent stores use the same bounded policy
    /// that runs at startup.
    pub async fn prune(&self) -> Result<TracePruneSummary> {
        let Some(_path) = &self.inner.path else {
            return Ok(TracePruneSummary::default());
        };
        let (retention_days, max_rows) = trace_retention_policy();
        let conn = self.inner.conn.lock().await;
        prune_connection(&conn, retention_days, max_rows)
    }
}
