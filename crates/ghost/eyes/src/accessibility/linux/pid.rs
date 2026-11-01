//! Process ids of AT-SPI applications and `/proc` liveness checks.
//!
//! AT-SPI's `Accessible` has no pid. The bus daemon knows it: the pid of the
//! connection that owns an application's unique bus name comes from
//! `org.freedesktop.DBus.GetConnectionUnixProcessID`.

use std::time::Duration;

use ::atspi::zbus;
use ::atspi::zbus::fdo::DBusProxy;
use ::atspi::zbus::names::BusName;
use ::atspi::ObjectRefOwned;
use serde_json::json;

use crate::contract::GhostError;

const PID_TIMEOUT: Duration = Duration::from_millis(500);

/// A bus-daemon proxy; build it once per call and reuse it for every lookup.
pub(crate) async fn bus_proxy(conn: &zbus::Connection) -> Option<DBusProxy<'static>> {
    DBusProxy::new(conn).await.ok()
}

/// The pid owning `bus_name`, if the bus daemon answers.
pub(crate) async fn bus_pid(dbus: &DBusProxy<'_>, bus_name: &str) -> Option<i32> {
    let name = BusName::try_from(bus_name).ok()?;
    let call = dbus.get_connection_unix_process_id(name);
    let pid = tokio::time::timeout(PID_TIMEOUT, call).await.ok()?.ok()?;
    i32::try_from(pid).ok().filter(|p| *p > 0)
}

/// The pid of the application that owns `obj`.
pub(crate) async fn obj_pid(dbus: Option<&DBusProxy<'_>>, obj: &ObjectRefOwned) -> Option<i32> {
    bus_pid(dbus?, obj.name_as_str()?).await
}

/// Whether `/proc/<pid>` exists.
pub(crate) fn process_alive(pid: i32) -> bool {
    pid > 0 && std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// The kernel's short process name (`/proc/<pid>/comm`).
pub(crate) fn process_name(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let name = comm.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub(crate) fn process_exited(pid: i32) -> GhostError {
    GhostError::stale_ref("the process the snapshot was taken from has exited")
        .with_details(json!({ "reason": "process_exited", "snapshot_pid": pid }))
        .with_suggestion("take a new snapshot")
}

pub(crate) fn pid_mismatch(snapshot_pid: i32, current_pid: i32) -> GhostError {
    GhostError::stale_ref("the window now belongs to a different process")
        .with_details(json!({ "snapshot_pid": snapshot_pid, "current_pid": current_pid }))
        .with_suggestion("take a new snapshot")
}
