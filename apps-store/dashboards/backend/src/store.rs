//! SQLite-backed persistence for dashboards + widgets.
//!
//! Two tables live in `~/.ryu/dashboards.db`:
//!   - `dashboards` — the dashboard identities (id + name).
//!   - `widgets`    — the widgets, keyed by `dashboard_id`, each stored as JSON
//!     (kind, config, source, layout, and the cached last value/refresh/error).
//!
//! A broadcast channel fans freshly-changed widgets out to SSE subscribers (the
//! desktop Home grid), mirroring `ryu_quests`. The refresh loop calls
//! [`DashboardStore::update_widget_value`] to cache + broadcast a new value, and
//! gates expensive refreshes on [`DashboardStore::receiver_count`] (no live
//! viewer ⇒ skip).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{CanvasLayout, Dashboard, DashboardEvent, DeviceDashboard, GridLayout, Widget};

/// RAII guard counting one **live UI viewer** (an open SSE stream). The refresh
/// loop's money guard keys off [`DashboardStore::viewer_count`], NOT the broadcast
/// `receiver_count`, so that internal subscribers (the hardware nudge loop) don't
/// trip the guard into thinking a human is watching and burn quota 24/7. Held by
/// the SSE handler for the life of the stream; decrements on drop.
pub struct ViewerGuard {
    viewers: Arc<AtomicUsize>,
}

impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.viewers.fetch_sub(1, Ordering::SeqCst);
    }
}

/// SQLite-backed dashboard store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct DashboardStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<DashboardEvent>,
    /// Count of live UI viewers (open SSE streams). Distinct from the broadcast
    /// receiver count so an internal subscriber (the nudge loop) can listen without
    /// faking a viewer and defeating the refresh loop's cost guard.
    viewers: Arc<AtomicUsize>,
}

impl DashboardStore {
    /// Open (or create) the store at a specific path and run migrations. Core
    /// passes `~/.ryu/dashboards.db` (its `paths::ryu_dir()` is the host's, not
    /// this crate's, concern).
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening dashboards db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(256);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
            viewers: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS dashboards (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS widgets (
                 id           TEXT PRIMARY KEY,
                 dashboard_id TEXT NOT NULL,
                 json         TEXT NOT NULL,
                 created_at   TEXT NOT NULL,
                 updated_at   TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_widgets_dashboard
                 ON widgets(dashboard_id);
             CREATE TABLE IF NOT EXISTS hardware_dashboards (
                 device_id    TEXT PRIMARY KEY,
                 dashboard_id TEXT NOT NULL,
                 refresh_rate INTEGER NOT NULL DEFAULT 300,
                 created_at   TEXT NOT NULL,
                 updated_at   TEXT NOT NULL
             );",
        )
        .context("initializing dashboards schema")?;
        Ok(())
    }

    // ---- device dashboards (hardware-scoped) ------------------------------

    /// Fetch the per-device dashboard binding, if one exists.
    pub async fn get_device_dashboard(&self, device_id: &str) -> Result<Option<DeviceDashboard>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT device_id, dashboard_id, refresh_rate, created_at, updated_at
             FROM hardware_dashboards WHERE device_id = ?1",
            params![device_id],
            |row| {
                Ok(DeviceDashboard {
                    device_id: row.get(0)?,
                    dashboard_id: row.get(1)?,
                    refresh_rate: row.get::<_, i64>(2)? as u32,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .context("reading device dashboard")
    }

    /// Insert or replace a device's dashboard binding.
    pub async fn upsert_device_dashboard(&self, dd: &DeviceDashboard) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO hardware_dashboards (device_id, dashboard_id, refresh_rate, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(device_id) DO UPDATE SET
                 dashboard_id = ?2, refresh_rate = ?3, updated_at = ?5",
            params![
                dd.device_id,
                dd.dashboard_id,
                dd.refresh_rate as i64,
                dd.created_at,
                dd.updated_at,
            ],
        )
        .context("upserting device dashboard")?;
        Ok(())
    }

    /// List every device→dashboard binding (the nudge loop's work list).
    pub async fn list_device_dashboards(&self) -> Result<Vec<DeviceDashboard>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT device_id, dashboard_id, refresh_rate, created_at, updated_at
             FROM hardware_dashboards",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DeviceDashboard {
                device_id: row.get(0)?,
                dashboard_id: row.get(1)?,
                refresh_rate: row.get::<_, i64>(2)? as u32,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Remove a device's dashboard binding (on device revoke). Returns true when
    /// a row was removed.
    pub async fn delete_device_dashboard(&self, device_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM hardware_dashboards WHERE device_id = ?1",
            params![device_id],
        )?;
        Ok(n > 0)
    }

    // ---- dashboards -------------------------------------------------------

    /// Insert or replace a dashboard, then broadcast a `DashboardUpdated` event.
    pub async fn upsert_dashboard(&self, dashboard: &Dashboard) -> Result<()> {
        let json = serde_json::to_string(dashboard).context("serializing dashboard")?;
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO dashboards (id, json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET json = ?2, updated_at = ?4",
                params![
                    dashboard.id,
                    json,
                    dashboard.created_at,
                    dashboard.updated_at
                ],
            )
            .context("upserting dashboard")?;
        }
        self.broadcast(DashboardEvent::DashboardUpdated {
            dashboard_id: dashboard.id.clone(),
        });
        Ok(())
    }

    /// Fetch a dashboard by id.
    pub async fn get_dashboard(&self, id: &str) -> Result<Option<Dashboard>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM dashboards WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading dashboard")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing dashboard")?,
            )),
            None => Ok(None),
        }
    }

    /// List all dashboards, oldest first (creation order is the tab order).
    pub async fn list_dashboards(&self) -> Result<Vec<Dashboard>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM dashboards ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(d) = serde_json::from_str::<Dashboard>(&row?) {
                out.push(d);
            }
        }
        Ok(out)
    }

    /// Delete a dashboard and all its widgets. Returns true when removed.
    pub async fn delete_dashboard(&self, id: &str) -> Result<bool> {
        let removed = {
            let conn = self.conn.lock().await;
            let n = conn.execute("DELETE FROM dashboards WHERE id = ?1", params![id])?;
            conn.execute("DELETE FROM widgets WHERE dashboard_id = ?1", params![id])?;
            n > 0
        };
        if removed {
            self.broadcast(DashboardEvent::DashboardUpdated {
                dashboard_id: id.to_string(),
            });
        }
        Ok(removed)
    }

    // ---- widgets ----------------------------------------------------------

    /// Insert or replace a widget, then broadcast a `WidgetUpdated` event.
    pub async fn upsert_widget(&self, widget: &Widget) -> Result<()> {
        let json = serde_json::to_string(widget).context("serializing widget")?;
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let existing_dashboard_id: Option<String> = conn
                .query_row(
                    "SELECT dashboard_id FROM widgets WHERE id = ?1",
                    params![widget.id],
                    |row| row.get(0),
                )
                .optional()
                .context("checking widget dashboard")?;
            if let Some(existing_dashboard_id) = existing_dashboard_id {
                if existing_dashboard_id != widget.dashboard_id {
                    anyhow::bail!(
                        "widget '{}' already belongs to dashboard '{}'",
                        widget.id,
                        existing_dashboard_id
                    );
                }
            }
            conn.execute(
                "INSERT INTO widgets (id, dashboard_id, json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET dashboard_id = ?2, json = ?3, updated_at = ?4",
                params![widget.id, widget.dashboard_id, json, now],
            )
            .context("upserting widget")?;
        }
        self.broadcast(DashboardEvent::WidgetUpdated {
            dashboard_id: widget.dashboard_id.clone(),
            widget: widget.clone(),
        });
        Ok(())
    }

    /// Fetch a widget by id.
    pub async fn get_widget(&self, id: &str) -> Result<Option<Widget>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM widgets WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading widget")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing widget")?,
            )),
            None => Ok(None),
        }
    }

    /// Fetch a widget only when it belongs to the supplied dashboard.
    pub async fn get_widget_for_dashboard(
        &self,
        dashboard_id: &str,
        id: &str,
    ) -> Result<Option<Widget>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM widgets WHERE dashboard_id = ?1 AND id = ?2",
                params![dashboard_id, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading dashboard widget")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing widget")?,
            )),
            None => Ok(None),
        }
    }

    /// List the widgets on a dashboard.
    pub async fn list_widgets(&self, dashboard_id: &str) -> Result<Vec<Widget>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT json FROM widgets WHERE dashboard_id = ?1 ORDER BY created_at ASC")?;
        let rows = stmt.query_map(params![dashboard_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(w) = serde_json::from_str::<Widget>(&row?) {
                out.push(w);
            }
        }
        Ok(out)
    }

    /// Every widget across every dashboard (the refresh loop's work list).
    pub async fn list_all_widgets(&self) -> Result<Vec<Widget>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM widgets")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(w) = serde_json::from_str::<Widget>(&row?) {
                out.push(w);
            }
        }
        Ok(out)
    }

    /// Delete a widget. Returns true when removed.
    pub async fn delete_widget(&self, id: &str) -> Result<bool> {
        let (removed, dashboard_id) = {
            let conn = self.conn.lock().await;
            let dashboard_id: Option<String> = conn
                .query_row(
                    "SELECT dashboard_id FROM widgets WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            let n = conn.execute("DELETE FROM widgets WHERE id = ?1", params![id])?;
            (n > 0, dashboard_id)
        };
        if let (true, Some(did)) = (removed, dashboard_id) {
            self.broadcast(DashboardEvent::WidgetDeleted {
                dashboard_id: did,
                widget_id: id.to_string(),
            });
        }
        Ok(removed)
    }

    /// Delete a widget only when it belongs to the supplied dashboard.
    pub async fn delete_widget_for_dashboard(&self, dashboard_id: &str, id: &str) -> Result<bool> {
        let removed = {
            let conn = self.conn.lock().await;
            let n = conn.execute(
                "DELETE FROM widgets WHERE dashboard_id = ?1 AND id = ?2",
                params![dashboard_id, id],
            )?;
            n > 0
        };
        if removed {
            self.broadcast(DashboardEvent::WidgetDeleted {
                dashboard_id: dashboard_id.to_string(),
                widget_id: id.to_string(),
            });
        }
        Ok(removed)
    }

    /// Persist only a widget's grid layout (the debounced drag/resize path).
    /// Returns the updated widget, or None if it does not exist.
    pub async fn update_widget_layout(
        &self,
        id: &str,
        layout: GridLayout,
    ) -> Result<Option<Widget>> {
        let mut widget = match self.get_widget(id).await? {
            Some(w) => w,
            None => return Ok(None),
        };
        widget.layout = layout;
        self.upsert_widget(&widget).await?;
        Ok(Some(widget))
    }

    /// Persist only a widget's grid layout when it belongs to the supplied dashboard.
    pub async fn update_widget_layout_for_dashboard(
        &self,
        dashboard_id: &str,
        id: &str,
        layout: GridLayout,
    ) -> Result<Option<Widget>> {
        self.update_widget_layout_fields_for_dashboard(dashboard_id, id, Some(layout), None)
            .await
    }

    /// Persist a widget's positional fields — grid layout and/or canvas layout —
    /// applying only the ones supplied. The two views are independent: a canvas
    /// drag passes `grid = None` so it never disturbs the v1 grid arrangement, and a
    /// grid drag passes `canvas = None`. A no-op call (both `None`) still returns the
    /// widget unchanged. Scoped to the dashboard so a widget can't be moved via the
    /// wrong dashboard id.
    pub async fn update_widget_layout_fields_for_dashboard(
        &self,
        dashboard_id: &str,
        id: &str,
        grid: Option<GridLayout>,
        canvas: Option<CanvasLayout>,
    ) -> Result<Option<Widget>> {
        let mut widget = match self.get_widget_for_dashboard(dashboard_id, id).await? {
            Some(w) => w,
            None => return Ok(None),
        };
        if let Some(layout) = grid {
            widget.layout = layout;
        }
        if let Some(c) = canvas {
            widget.canvas = Some(c);
        }
        self.upsert_widget(&widget).await?;
        Ok(Some(widget))
    }

    /// Cache a freshly-resolved value (or error) on a widget and broadcast it.
    /// Writes through to SQLite so a reload shows the last value immediately.
    pub async fn update_widget_value(
        &self,
        id: &str,
        value: Result<serde_json::Value, String>,
    ) -> Result<()> {
        let mut widget = match self.get_widget(id).await? {
            Some(w) => w,
            None => return Ok(()),
        };
        let now = chrono::Utc::now().to_rfc3339();
        widget.last_refresh_at = Some(now.clone());
        let event = match &value {
            Ok(v) => {
                widget.last_value = Some(v.clone());
                widget.last_error = None;
                DashboardEvent::WidgetData {
                    dashboard_id: widget.dashboard_id.clone(),
                    widget_id: widget.id.clone(),
                    value: v.clone(),
                    at: now,
                }
            }
            Err(e) => {
                widget.last_error = Some(e.clone());
                DashboardEvent::WidgetError {
                    dashboard_id: widget.dashboard_id.clone(),
                    widget_id: widget.id.clone(),
                    error: e.clone(),
                    at: now,
                }
            }
        };
        // Persist the cached value WITHOUT emitting a (noisy) WidgetUpdated; emit
        // the precise data/error event instead.
        let json = serde_json::to_string(&widget).context("serializing widget")?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE widgets SET json = ?2, updated_at = ?3 WHERE id = ?1",
                params![widget.id, json, updated_at],
            )
            .context("caching widget value")?;
        }
        self.broadcast(event);
        Ok(())
    }

    /// Broadcast a dashboard event to SSE subscribers (no live subscriber ⇒ noop).
    pub fn broadcast(&self, event: DashboardEvent) {
        let _ = self.tx.send(event);
    }

    /// Subscribe to live dashboard events (the SSE endpoint + internal listeners
    /// such as the hardware nudge loop). Subscribing does NOT register a UI viewer —
    /// SSE handlers separately hold a [`ViewerGuard`] so internal subscribers don't
    /// trip the refresh loop's cost guard.
    pub fn subscribe(&self) -> broadcast::Receiver<DashboardEvent> {
        self.tx.subscribe()
    }

    /// Register one live UI viewer for the duration of the returned guard. The SSE
    /// handler holds this while a client stream is open; the refresh loop reads
    /// [`Self::viewer_count`] to decide whether to run expensive sources.
    pub fn viewer_guard(&self) -> ViewerGuard {
        self.viewers.fetch_add(1, Ordering::SeqCst);
        ViewerGuard {
            viewers: Arc::clone(&self.viewers),
        }
    }

    /// Number of live UI viewers (open SSE streams). The refresh loop skips
    /// expensive sources when this is zero (no human is watching ⇒ do not burn
    /// tokens/quota). This is deliberately NOT the broadcast `receiver_count`, so an
    /// internal subscriber (the nudge loop) cannot fake a viewer.
    pub fn viewer_count(&self) -> usize {
        self.viewers.load(Ordering::SeqCst)
    }

    /// Number of live broadcast subscribers (UI streams + internal listeners).
    /// Retained for diagnostics; the cost guard uses [`Self::viewer_count`].
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{WidgetKind, WidgetSource};

    fn temp_store() -> DashboardStore {
        let dir = std::env::temp_dir().join(format!("ryu-dash-test-{}", uuid::Uuid::new_v4()));
        DashboardStore::open(dir.join("dashboards.db")).expect("open")
    }

    fn test_widget(id: &str, dashboard_id: &str) -> Widget {
        Widget {
            id: id.to_string(),
            dashboard_id: dashboard_id.to_string(),
            kind: WidgetKind::Stat,
            title: "Test".to_string(),
            config: serde_json::Value::Null,
            source: WidgetSource::Static {
                data: serde_json::Value::Null,
            },
            refresh_interval: None,
            layout: GridLayout::default(),
            canvas: None,
            last_value: None,
            last_refresh_at: None,
            last_error: None,
        }
    }

    #[tokio::test]
    async fn viewer_count_is_decoupled_from_subscribe() {
        let store = temp_store();
        // An internal subscriber (the nudge loop) must NOT register as a UI viewer,
        // or it would defeat the refresh loop's cost guard (expensive sources would
        // run 24/7). subscribe() bumps receiver_count but NOT viewer_count.
        let _internal_rx = store.subscribe();
        assert_eq!(
            store.viewer_count(),
            0,
            "subscribe alone is not a UI viewer"
        );
        assert!(store.receiver_count() >= 1);

        // A UI stream holds a viewer guard for its lifetime.
        let guard = store.viewer_guard();
        assert_eq!(store.viewer_count(), 1);
        drop(guard);
        assert_eq!(
            store.viewer_count(),
            0,
            "dropping the stream clears the viewer"
        );
    }

    #[tokio::test]
    async fn device_dashboard_round_trips() {
        let store = temp_store();
        let now = chrono::Utc::now().to_rfc3339();
        let dd = DeviceDashboard {
            device_id: "rhw_1".into(),
            dashboard_id: "dash_1".into(),
            refresh_rate: 300,
            created_at: now.clone(),
            updated_at: now,
        };
        store.upsert_device_dashboard(&dd).await.unwrap();
        let got = store.get_device_dashboard("rhw_1").await.unwrap().unwrap();
        assert_eq!(got.dashboard_id, "dash_1");
        assert_eq!(got.refresh_rate, 300);
        assert_eq!(store.list_device_dashboards().await.unwrap().len(), 1);
        assert!(store.delete_device_dashboard("rhw_1").await.unwrap());
        assert!(store.get_device_dashboard("rhw_1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn widget_id_cannot_move_between_dashboards() {
        let store = temp_store();
        store
            .upsert_widget(&test_widget("w1", "dash_a"))
            .await
            .unwrap();

        let err = store
            .upsert_widget(&test_widget("w1", "dash_b"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already belongs to dashboard"));

        let widget = store.get_widget("w1").await.unwrap().unwrap();
        assert_eq!(widget.dashboard_id, "dash_a");
    }

    #[tokio::test]
    async fn scoped_widget_delete_requires_matching_dashboard() {
        let store = temp_store();
        store
            .upsert_widget(&test_widget("w1", "dash_a"))
            .await
            .unwrap();

        assert!(!store
            .delete_widget_for_dashboard("dash_b", "w1")
            .await
            .unwrap());
        assert!(store.get_widget("w1").await.unwrap().is_some());

        assert!(store
            .delete_widget_for_dashboard("dash_a", "w1")
            .await
            .unwrap());
        assert!(store.get_widget("w1").await.unwrap().is_none());
    }
}
