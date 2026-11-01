// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! One AT-SPI connection per public call, uncached proxy builders, deadline-bounded
//! calls and the D-Bus fault table.

use std::future::Future;
use std::time::{Duration, Instant};

use ::atspi::connection::AccessibilityConnection;
use ::atspi::proxy::accessible::AccessibleProxy;
use ::atspi::zbus;
use ::atspi::zbus::proxy::{Builder, CacheProperties, Defaults};
use ::atspi::zbus::DBusError;
use ::atspi::ObjectRefOwned;
use serde_json::json;

use crate::contract::{Delivery, ErrorCode, GhostError};

/// How long opening the accessibility bus may take before it counts as unavailable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Floor for a single read so a nearly spent budget still gets one answer.
pub(crate) const MIN_CALL: Duration = Duration::from_millis(50);

/// GTK maps `G_IO_ERROR`s it cannot name onto quark error names; this one is the
/// "no such action" reply of `Action.DoAction`.
const GTK_NO_SUCH_ACTION: &str =
    "org.gtk.GDBus.UnmappedGError.Quark._g_2dio_2derror_2dquark.Code13";

pub(crate) fn bus_unavailable() -> GhostError {
    GhostError::perm_denied("AT-SPI accessibility bus unavailable").with_suggestion(
        "enable assistive technologies (for GNOME: `gsettings set \
         org.gnome.desktop.interface toolkit-accessibility true`), make sure \
         at-spi2-core is running, then restart the target app",
    )
}

/// Opens the accessibility bus; any failure (or a hang) is PERM_DENIED.
pub(crate) async fn connect() -> Result<AccessibilityConnection, GhostError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, AccessibilityConnection::new()).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) => {
            tracing::debug!("at-spi connection failed: {e}");
            Err(bus_unavailable())
        }
        Err(_) => Err(bus_unavailable()),
    }
}

/// An uncached proxy of interface `T` on `obj`. Uncached means no `GetAll` and
/// no `PropertiesChanged` subscription per object: each read is one round trip.
pub(crate) async fn proxy<'a, T>(conn: &zbus::Connection, obj: &ObjectRefOwned) -> zbus::Result<T>
where
    T: Defaults + From<zbus::Proxy<'a>>,
{
    let name = obj
        .name()
        .ok_or_else(|| zbus::Error::Failure("object ref has no bus name".into()))?
        .clone();
    Builder::<T>::new(conn)
        .destination(name)?
        .path(obj.path().clone())?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

pub(crate) async fn accessible<'a>(
    conn: &zbus::Connection,
    obj: &ObjectRefOwned,
) -> zbus::Result<AccessibleProxy<'a>> {
    proxy::<AccessibleProxy<'a>>(conn, obj).await
}

/// `"<bus>:<path>"`, the Linux `native_id`.
pub(crate) fn native_id(obj: &ObjectRefOwned) -> Option<String> {
    let bus = obj.name_as_str()?;
    Some(format!("{bus}:{}", obj.path_as_str()))
}

/// Time left until `deadline`, never below [`MIN_CALL`].
pub(crate) fn remaining(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .max(MIN_CALL)
}

/// Runs `fut` until `deadline` (at least [`MIN_CALL`]); `None` on timeout.
pub(crate) async fn within<T>(deadline: Instant, fut: impl Future<Output = T>) -> Option<T> {
    tokio::time::timeout(remaining(deadline), fut).await.ok()
}

/// What a failed D-Bus call means for an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    /// The object lacks the interface, method, property or action: fall through.
    Unsupported,
    InvalidArgs,
    AccessDenied,
    TimedOut,
    /// Needs a liveness check before it means anything.
    UnknownObject,
    /// The application left the bus.
    AppGone,
    Other,
}

/// Classifies a D-Bus error name.
pub(crate) fn fault_of_name(name: &str) -> Fault {
    if name == GTK_NO_SUCH_ACTION {
        return Fault::Unsupported;
    }
    let short = name.rsplit('.').next().unwrap_or(name);
    match short {
        "NoSuchAction" | "NotSupported" | "UnknownProperty" | "UnknownMethod"
        | "UnknownInterface" | "PropertyReadOnly" => Fault::Unsupported,
        "InvalidArgs" => Fault::InvalidArgs,
        "AccessDenied" => Fault::AccessDenied,
        "NoReply" | "Timeout" | "TimedOut" => Fault::TimedOut,
        "UnknownObject" => Fault::UnknownObject,
        "ServiceUnknown" | "NameHasNoOwner" => Fault::AppGone,
        _ => Fault::Other,
    }
}

/// Classifies a zbus error (method errors by name, I/O timeouts as timeouts).
pub(crate) fn fault_of(err: &zbus::Error) -> Fault {
    match err {
        zbus::Error::MethodError(name, _, _) => fault_of_name(name.as_str()),
        zbus::Error::FDO(e) => fault_of_name(e.name().as_str()),
        zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            Fault::TimedOut
        }
        zbus::Error::InterfaceNotFound | zbus::Error::Unsupported => Fault::Unsupported,
        _ => Fault::Other,
    }
}

/// The action-level meaning of a fault.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Verdict {
    /// Not delivered; try the next rung.
    FallThrough,
    /// `UnknownObject`: confirm with one `GetRole` whether the element still exists.
    Confirm,
    Fail(GhostError),
}

pub(crate) fn element_gone() -> GhostError {
    GhostError::stale_ref("the element is no longer on the accessibility bus")
        .with_details(json!({ "reason": "element_gone" }))
        .with_suggestion("take a new snapshot")
}

pub(crate) fn call_timed_out(method: &str) -> GhostError {
    GhostError::timeout(
        format!("{method} did not reply in time"),
        Delivery::DeliveryUncertain,
    )
}

/// Maps a fault from a mutating call. The application's own error text is never
/// copied into the message: it may echo the value that was written.
pub(crate) fn verdict(fault: Fault, method: &str) -> Verdict {
    match fault {
        Fault::Unsupported => Verdict::FallThrough,
        Fault::UnknownObject => Verdict::Confirm,
        Fault::InvalidArgs => Verdict::Fail(GhostError::invalid_args(format!(
            "{method} rejected its arguments"
        ))),
        Fault::AccessDenied => Verdict::Fail(GhostError::perm_denied(format!(
            "{method} was denied by the application"
        ))),
        Fault::TimedOut => Verdict::Fail(call_timed_out(method)),
        Fault::AppGone => Verdict::Fail(
            GhostError::stale_ref("the application left the accessibility bus")
                .with_details(json!({ "reason": "process_exited" }))
                .with_suggestion("take a new snapshot"),
        ),
        Fault::Other => Verdict::Fail(
            GhostError::new(ErrorCode::ActionFailed, format!("{method} failed"))
                .with_delivery(Delivery::DeliveryUncertain),
        ),
    }
}
