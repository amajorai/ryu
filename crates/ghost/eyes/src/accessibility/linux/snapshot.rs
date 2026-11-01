//! Window acquisition for a [`WindowTarget`] and the snapshot walk, with the X11
//! window-geometry fallback for the focused window when AT-SPI is unavailable.

use std::time::{Duration, Instant};

use ::atspi::proxy::accessible::AccessibleProxy;
use ::atspi::zbus;
use ::atspi::{ObjectRefOwned, State, StateSet};
use serde_json::json;

use super::super::limits::WalkBudget;
use super::super::{pick_window_title, window_pick_error, TitlePick};
use super::super::{AXSnapshot, RendererA11y, SnapshotOptions, WalkStats, WindowTarget};
use super::at_spi::walk;
use super::conn::{accessible, bus_unavailable, connect, within};
use super::pid::{bus_proxy, obj_pid, process_alive, process_exited, process_name};
use super::x11;
use crate::contract::{Delivery, ErrorCode, GhostError};

/// How long one application may take to answer during window acquisition: a
/// frozen application costs at most this much and is skipped, so it never blocks
/// a call that targets a different, healthy one.
const APP_REPLY: Duration = Duration::from_millis(750);

const ROOT_DEST: &str = "org.a11y.atspi.Registry";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";

/// The window element a snapshot or a live resolution starts from.
pub(crate) struct Root {
    pub window: ObjectRefOwned,
    /// 0 when the bus daemon cannot tell.
    pub pid: i32,
    pub app_name: Option<String>,
    pub title: Option<String>,
}

struct Window {
    obj: ObjectRefOwned,
    title: String,
    states: StateSet,
}

/// The earlier of `deadline` and one application's reply allowance.
fn app_deadline(deadline: Instant) -> Instant {
    deadline.min(Instant::now() + APP_REPLY)
}

fn acquisition_timed_out() -> GhostError {
    GhostError::timeout(
        "the deadline passed while the window was being acquired",
        Delivery::NotDelivered,
    )
}

/// `Err(TIMEOUT)` once `deadline` has passed.
fn check_deadline(deadline: Instant) -> Result<(), GhostError> {
    if Instant::now() >= deadline {
        return Err(acquisition_timed_out());
    }
    Ok(())
}

/// Running accessible applications (children of the registry root).
pub(crate) async fn app_refs(
    conn: &zbus::Connection,
    deadline: Instant,
) -> Result<Vec<ObjectRefOwned>, GhostError> {
    let build = AccessibleProxy::builder(conn)
        .destination(ROOT_DEST)
        .and_then(|b| b.path(ROOT_PATH))
        .map_err(|_| bus_unavailable())?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build();
    let root = within(deadline, build)
        .await
        .ok_or_else(acquisition_timed_out)?
        .map_err(|_| bus_unavailable())?;
    within(deadline, root.get_children())
        .await
        .ok_or_else(acquisition_timed_out)?
        .map_err(|_| bus_unavailable())
}

/// The application's name; `None` when it is empty or does not answer in time.
pub(crate) async fn app_name(
    conn: &zbus::Connection,
    app: &ObjectRefOwned,
    deadline: Instant,
) -> Option<String> {
    let until = app_deadline(deadline);
    let proxy = within(until, accessible(conn, app)).await?.ok()?;
    let name = within(until, proxy.name()).await?.ok()?;
    (!name.is_empty()).then_some(name)
}

/// Top-level windows of `app`, in AT-SPI child order. An application that does not
/// answer within [`APP_REPLY`] contributes the windows read so far.
async fn windows_of(
    conn: &zbus::Connection,
    app: &ObjectRefOwned,
    deadline: Instant,
) -> Vec<Window> {
    let until = app_deadline(deadline);
    let Some(Ok(proxy)) = within(until, accessible(conn, app)).await else {
        return vec![];
    };
    let Some(Ok(kids)) = within(until, proxy.get_children()).await else {
        return vec![];
    };
    let mut out = vec![];
    for obj in kids {
        if Instant::now() >= until {
            break;
        }
        let Some(Ok(win)) = within(until, accessible(conn, &obj)).await else {
            continue;
        };
        let title = within(until, win.name()).await.and_then(Result::ok);
        let states = within(until, win.get_state()).await.and_then(Result::ok);
        out.push(Window {
            obj,
            title: title.unwrap_or_default(),
            states: states.unwrap_or_default(),
        });
    }
    out
}

fn no_active_window() -> GhostError {
    GhostError::new(
        ErrorCode::AppNotFound,
        "no active window found on the accessibility bus",
    )
}

fn no_window(pid: i32) -> GhostError {
    GhostError::new(
        ErrorCode::AppNotFound,
        "the process exposes no accessible top-level window",
    )
    .with_details(json!({ "pid": pid }))
}

/// Title match (exact only when `strict`, see [`pick_window_title`]); on a miss a
/// single window is used, several are STALE_REF.
fn by_title(
    windows: Vec<Window>,
    title: &str,
    pid: i32,
    strict: bool,
) -> Result<Window, GhostError> {
    let titles: Vec<Option<&str>> = windows.iter().map(|w| Some(w.title.as_str())).collect();
    match pick_window_title(&titles, title, strict).or_single_window() {
        TitlePick::Found(i) => windows.into_iter().nth(i).ok_or_else(|| no_window(pid)),
        TitlePick::Miss(0) => Err(no_window(pid)),
        other => Err(window_pick_error(other, pid)),
    }
}

/// The active window and the application that owns it.
pub(crate) async fn active_window(
    conn: &zbus::Connection,
    deadline: Instant,
) -> Result<Root, GhostError> {
    let (app, window) = active_pair(conn, deadline).await?;
    let dbus = bus_proxy(conn).await;
    Ok(Root {
        pid: obj_pid(dbus.as_ref(), &window.obj).await.unwrap_or(0),
        app_name: app_name(conn, &app, deadline).await,
        title: Some(window.title).filter(|t| !t.is_empty()),
        window: window.obj,
    })
}

async fn active_pair(
    conn: &zbus::Connection,
    deadline: Instant,
) -> Result<(ObjectRefOwned, Window), GhostError> {
    for app in app_refs(conn, deadline).await? {
        check_deadline(deadline)?;
        let windows = windows_of(conn, &app, deadline).await;
        if let Some(w) = windows
            .into_iter()
            .find(|w| w.states.contains(State::Active))
        {
            return Ok((app, w));
        }
    }
    Err(no_active_window())
}

/// Windows of every application whose bus connection belongs to `pid`.
async fn process_windows(
    conn: &zbus::Connection,
    pid: i32,
    deadline: Instant,
) -> Result<(Vec<Window>, Option<String>), GhostError> {
    let dbus = bus_proxy(conn).await;
    let mut windows = vec![];
    let mut name = None;
    for app in app_refs(conn, deadline).await? {
        check_deadline(deadline)?;
        if obj_pid(dbus.as_ref(), &app).await != Some(pid) {
            continue;
        }
        if name.is_none() {
            name = app_name(conn, &app, deadline).await;
        }
        windows.extend(windows_of(conn, &app, deadline).await);
    }
    Ok((windows, name))
}

fn root_of(window: Window, pid: i32, app_name: Option<String>) -> Root {
    Root {
        pid,
        app_name: app_name.or_else(|| process_name(pid)),
        title: Some(window.title).filter(|t| !t.is_empty()),
        window: window.obj,
    }
}

/// The window element for `target`, following the §2.4 rules. Every round trip
/// is bounded by `deadline`, and one application by [`APP_REPLY`].
pub(crate) async fn acquire_root(
    conn: &zbus::Connection,
    target: &WindowTarget,
    deadline: Instant,
) -> Result<Root, GhostError> {
    match target {
        WindowTarget::Focused => active_window(conn, deadline).await,
        WindowTarget::FocusedTitle { title } => {
            let (app, active) = active_pair(conn, deadline).await?;
            let dbus = bus_proxy(conn).await;
            let pid = obj_pid(dbus.as_ref(), &active.obj).await.unwrap_or(0);
            let window = by_title(windows_of(conn, &app, deadline).await, title, pid, false)?;
            Ok(root_of(window, pid, app_name(conn, &app, deadline).await))
        }
        WindowTarget::Pid { pid } | WindowTarget::PidTitle { pid, .. } => {
            if !process_alive(*pid) {
                return Err(process_exited(*pid));
            }
            let (windows, name) = process_windows(conn, *pid, deadline).await?;
            let window = match target {
                WindowTarget::PidTitle { title, .. } => by_title(windows, title, *pid, true)?,
                _ => pick_for_pid(windows).ok_or_else(|| no_window(*pid))?,
            };
            Ok(root_of(window, *pid, name))
        }
    }
}

/// The active window, else the first showing one, else the first.
fn pick_for_pid(windows: Vec<Window>) -> Option<Window> {
    let idx = windows
        .iter()
        .position(|w| w.states.contains(State::Active))
        .or_else(|| {
            windows
                .iter()
                .position(|w| w.states.contains(State::Showing))
        })
        .unwrap_or(0);
    windows.into_iter().nth(idx)
}

/// Takes a snapshot of the window `opts.target` names.
pub(crate) async fn take(opts: &SnapshotOptions) -> Result<AXSnapshot, GhostError> {
    let a11y = match connect().await {
        Ok(a11y) => a11y,
        Err(e) => return x11_fallback(opts, e).await,
    };
    let conn = a11y.connection();
    let root = match acquire_root(conn, &opts.target, opts.limits.deadline_from_now()).await {
        Ok(root) => root,
        Err(e) if e.code == ErrorCode::PermDenied || e.code == ErrorCode::AppNotFound => {
            return x11_fallback(opts, e).await
        }
        Err(e) => return Err(e),
    };
    let mut budget = WalkBudget::start(opts.limits);
    let tree = walk(conn, root.window, 0, &mut budget).await;
    let stats = budget.stats;
    Ok(AXSnapshot {
        pid: root.pid,
        app_name: root.app_name,
        window_title: tree.title.clone().or(root.title),
        complete: stats.complete(),
        stats,
        renderer: RendererA11y::NotApplicable,
        root: tree,
    })
}

/// The focused window's X11 geometry tree; only for `Focused`, and the AT-SPI
/// error wins when X11 is unavailable too.
async fn x11_fallback(opts: &SnapshotOptions, err: GhostError) -> Result<AXSnapshot, GhostError> {
    if opts.target != WindowTarget::Focused {
        return Err(err);
    }
    let fallback = tokio::task::spawn_blocking(x11::focused_window).await;
    let Ok(Ok(window)) = fallback else {
        tracing::debug!("x11 fallback unavailable; reporting the AT-SPI error");
        return Err(err);
    };
    let stats: WalkStats = window.stats;
    Ok(AXSnapshot {
        pid: window.pid,
        app_name: process_name(window.pid),
        window_title: window.root.title.clone(),
        complete: stats.complete(),
        stats,
        renderer: RendererA11y::NotApplicable,
        root: window.root,
    })
}
