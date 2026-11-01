//! ApplicationServices / CoreFoundation FFI used by the macOS AX backend.
//!
//! Raw declarations only; the RAII and conversion helpers live in `cf.rs`.

use std::ffi::{c_char, c_void};

pub(crate) type CFTypeRef = *const c_void;
pub(crate) type CFStringRef = *const c_void;
pub(crate) type CFArrayRef = *const c_void;
pub(crate) type CFNumberRef = *const c_void;
pub(crate) type AXUIElementRef = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub(crate) fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub(crate) fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub(crate) fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    pub(crate) fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> i32;
    pub(crate) fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> i32;
    pub(crate) fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    pub(crate) fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> i32;
    pub(crate) fn AXUIElementCopyActionNames(
        element: AXUIElementRef,
        names: *mut CFArrayRef,
    ) -> i32;
    pub(crate) fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    pub(crate) fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, secs: f32) -> i32;
    pub(crate) fn AXValueGetValue(value: CFTypeRef, ax_type: i32, out: *mut c_void) -> bool;

    pub(crate) fn CFRelease(cf: CFTypeRef);
    pub(crate) fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub(crate) fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> bool;
    pub(crate) fn CFGetTypeID(cf: CFTypeRef) -> usize;
    pub(crate) fn CFStringGetTypeID() -> usize;
    pub(crate) fn CFNumberGetTypeID() -> usize;
    pub(crate) fn CFBooleanGetTypeID() -> usize;
    pub(crate) fn CFArrayGetCount(array: CFArrayRef) -> i64;
    pub(crate) fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: i64) -> CFTypeRef;
    pub(crate) fn CFArrayCreate(
        alloc: *const c_void,
        values: *const *const c_void,
        n: i64,
        callbacks: *const c_void,
    ) -> CFArrayRef;
    pub(crate) fn CFStringGetCStringPtr(s: CFStringRef, encoding: u32) -> *const c_char;
    pub(crate) fn CFStringGetLength(s: CFStringRef) -> i64;
    pub(crate) fn CFStringGetCString(
        s: CFStringRef,
        buf: *mut c_char,
        size: i64,
        encoding: u32,
    ) -> bool;
    pub(crate) fn CFStringCreateWithCString(
        alloc: *const c_void,
        cstr: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    pub(crate) fn CFNumberGetValue(num: CFNumberRef, the_type: isize, out: *mut c_void) -> bool;
    pub(crate) fn CFNumberCreate(
        alloc: *const c_void,
        the_type: isize,
        value: *const c_void,
    ) -> CFNumberRef;
    pub(crate) fn CFBooleanGetValue(boolean: CFTypeRef) -> bool;

    pub(crate) static kCFBooleanTrue: CFTypeRef;
    pub(crate) static kCFBooleanFalse: CFTypeRef;
    pub(crate) static kCFTypeArrayCallBacks: [usize; 6];
}

// libSystem (always linked): process liveness probe.
extern "C" {
    pub(crate) fn kill(pid: i32, sig: i32) -> i32;
}

pub(crate) const UTF8: u32 = 0x0800_0100;
pub(crate) const KAX_VALUE_TYPE_CGPOINT: i32 = 1;
pub(crate) const KAX_VALUE_TYPE_CGSIZE: i32 = 2;
/// `kCFNumberSInt64Type`.
pub(crate) const CF_NUMBER_SINT64: isize = 4;
/// `kCFNumberFloat64Type`.
pub(crate) const CF_NUMBER_FLOAT64: isize = 6;

// AXError codes.
pub(crate) const AX_SUCCESS: i32 = 0;
pub(crate) const AX_FAILURE: i32 = -25200;
pub(crate) const AX_ILLEGAL_ARGUMENT: i32 = -25201;
pub(crate) const AX_INVALID_UI_ELEMENT: i32 = -25202;
pub(crate) const AX_CANNOT_COMPLETE: i32 = -25204;
pub(crate) const AX_ATTRIBUTE_UNSUPPORTED: i32 = -25205;
pub(crate) const AX_ACTION_UNSUPPORTED: i32 = -25206;
pub(crate) const AX_NOT_IMPLEMENTED: i32 = -25208;
pub(crate) const AX_API_DISABLED: i32 = -25211;
pub(crate) const AX_NO_VALUE: i32 = -25212;

#[repr(C)]
pub(crate) struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
pub(crate) struct CGSize {
    pub width: f64,
    pub height: f64,
}
