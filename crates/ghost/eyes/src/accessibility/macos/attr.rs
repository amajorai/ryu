//! Typed AXUIElement attribute, action and timeout helpers over owned elements.

use std::time::Instant;

use super::super::Bounds;
use super::cf::*;
use super::ffi::*;

/// The per-element messaging timeout never exceeds this many seconds.
const MAX_MESSAGING_TIMEOUT_SECS: f32 = 1.0;

/// Sets `el`'s messaging timeout to `min(remaining, 1s)`. A per-element timeout
/// does not propagate to children, so call it before each element's IPC.
/// Returns false (and sets nothing) when the deadline has passed.
pub(crate) fn set_timeout(el: &CfRef, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let secs = remaining.as_secs_f32().min(MAX_MESSAGING_TIMEOUT_SECS);
    unsafe { AXUIElementSetMessagingTimeout(el.as_ptr(), secs) };
    true
}

/// Copies an attribute; `Err(AXError)` on failure (`NoValue` for a NULL value).
pub(crate) fn copy_attr(el: &CfRef, name: &str) -> Result<CfRef, i32> {
    let attr = CfRef::string(name).ok_or(AX_ILLEGAL_ARGUMENT)?;
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el.as_ptr(), attr.as_ptr(), &mut out) };
    if err != AX_SUCCESS {
        if !out.is_null() {
            unsafe { CFRelease(out) };
        }
        return Err(err);
    }
    unsafe { CfRef::owned(out) }.ok_or(AX_NO_VALUE)
}

pub(crate) fn attr_string(el: &CfRef, name: &str) -> Option<String> {
    let v = copy_attr(el, name).ok()?;
    unsafe { cf_to_string(v.as_ptr()) }
}

/// String, number or boolean attribute as text.
pub(crate) fn attr_value_text(el: &CfRef, name: &str) -> Option<String> {
    let v = copy_attr(el, name).ok()?;
    unsafe { cf_value_to_string(v.as_ptr()) }
}

/// A boolean attribute; a CFNumber 0/1 is accepted too.
pub(crate) fn attr_bool(el: &CfRef, name: &str) -> Option<bool> {
    let v = copy_attr(el, name).ok()?;
    unsafe {
        cf_bool(v.as_ptr()).or_else(|| {
            cf_number_f64(v.as_ptr()).and_then(|n| {
                if n == 0.0 {
                    Some(false)
                } else if n == 1.0 {
                    Some(true)
                } else {
                    None
                }
            })
        })
    }
}

/// The element's AXRole.
pub(crate) fn role(el: &CfRef) -> Option<String> {
    attr_string(el, "AXRole")
}

pub(crate) fn bounds(el: &CfRef) -> Option<Bounds> {
    let pos = copy_attr(el, "AXPosition").ok()?;
    let size = copy_attr(el, "AXSize").ok()?;
    let mut pt = CGPoint { x: 0.0, y: 0.0 };
    let mut sz = CGSize {
        width: 0.0,
        height: 0.0,
    };
    let ok = unsafe {
        AXValueGetValue(
            pos.as_ptr(),
            KAX_VALUE_TYPE_CGPOINT,
            (&mut pt as *mut CGPoint).cast(),
        ) && AXValueGetValue(
            size.as_ptr(),
            KAX_VALUE_TYPE_CGSIZE,
            (&mut sz as *mut CGSize).cast(),
        )
    };
    ok.then(|| Bounds {
        x: pt.x as i32,
        y: pt.y as i32,
        width: sz.width.max(0.0) as u32,
        height: sz.height.max(0.0) as u32,
    })
}

/// The AXChildren array (owned); `Err(AXError)` when unreadable.
pub(crate) fn children_array(el: &CfRef) -> Result<CfRef, i32> {
    copy_attr(el, "AXChildren")
}

/// The AXChildren of `el`, retained, in native order.
pub(crate) fn children(el: &CfRef) -> Vec<Option<CfRef>> {
    match children_array(el) {
        Ok(arr) => unsafe { cf_array_items(arr.as_ptr()) },
        Err(_) => Vec::new(),
    }
}

/// The element-valued attribute `name` (e.g. AXParent, AXFocusedWindow).
pub(crate) fn attr_element(el: &CfRef, name: &str) -> Option<CfRef> {
    copy_attr(el, name).ok()
}

/// The element-array attribute `name` (e.g. AXWindows), retained.
pub(crate) fn attr_elements(el: &CfRef, name: &str) -> Result<Vec<CfRef>, i32> {
    let arr = copy_attr(el, name)?;
    Ok(unsafe { cf_array_items(arr.as_ptr()) }
        .into_iter()
        .flatten()
        .collect())
}

/// `AXUIElementIsAttributeSettable`; any error counts as not settable.
pub(crate) fn is_settable(el: &CfRef, name: &str) -> bool {
    let Some(attr) = CfRef::string(name) else {
        return false;
    };
    let mut out: u8 = 0;
    let err = unsafe { AXUIElementIsAttributeSettable(el.as_ptr(), attr.as_ptr(), &mut out) };
    err == AX_SUCCESS && out != 0
}

/// `AXUIElementSetAttributeValue`; returns the AXError.
pub(crate) fn set_attr(el: &CfRef, name: &str, value: CFTypeRef) -> i32 {
    let Some(attr) = CfRef::string(name) else {
        return AX_ILLEGAL_ARGUMENT;
    };
    unsafe { AXUIElementSetAttributeValue(el.as_ptr(), attr.as_ptr(), value) }
}

/// `AXUIElementPerformAction`; returns the AXError.
pub(crate) fn perform(el: &CfRef, action: &str) -> i32 {
    let Some(name) = CfRef::string(action) else {
        return AX_ILLEGAL_ARGUMENT;
    };
    unsafe { AXUIElementPerformAction(el.as_ptr(), name.as_ptr()) }
}

/// The advertised AXActionNames, or `None` when they cannot be read.
pub(crate) fn action_names(el: &CfRef) -> Option<Vec<String>> {
    let mut out: CFArrayRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyActionNames(el.as_ptr(), &mut out) };
    let arr = unsafe { CfRef::owned(out) }?;
    if err != AX_SUCCESS {
        return None;
    }
    let names = unsafe { cf_array_items(arr.as_ptr()) }
        .into_iter()
        .flatten()
        .filter_map(|s| unsafe { cf_to_string(s.as_ptr()) })
        .collect();
    Some(names)
}

/// Advertised-action guard: false only when the names are readable and omit `action`.
pub(crate) fn may_perform(el: &CfRef, action: &str) -> bool {
    action_names(el).is_none_or(|names| names.iter().any(|n| n == action))
}

/// True only when the names are readable and list `action`.
pub(crate) fn advertises(el: &CfRef, action: &str) -> bool {
    action_names(el).is_some_and(|names| names.iter().any(|n| n == action))
}

pub(crate) fn element_pid(el: &CfRef) -> Option<i32> {
    let mut pid: i32 = 0;
    let err = unsafe { AXUIElementGetPid(el.as_ptr(), &mut pid) };
    (err == AX_SUCCESS && pid > 0).then_some(pid)
}

/// The application element of `pid`.
pub(crate) fn app_element(pid: i32) -> Option<CfRef> {
    unsafe { CfRef::owned(AXUIElementCreateApplication(pid)) }
}

/// Whether a process with `pid` exists (EPERM still means it exists).
pub(crate) fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM (1): the process exists but belongs to another user.
    std::io::Error::last_os_error().raw_os_error() == Some(1)
}
