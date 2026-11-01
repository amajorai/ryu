//! CoreFoundation ownership and conversion helpers.

use std::ffi::{c_char, c_void, CStr, CString};

use super::ffi::*;

/// An owned (+1) CoreFoundation reference, released on drop.
pub(crate) struct CfRef(CFTypeRef);

impl CfRef {
    /// Takes ownership of a +1 reference (from a `Create`/`Copy` call); `None` for NULL.
    pub(crate) unsafe fn owned(ptr: CFTypeRef) -> Option<Self> {
        (!ptr.is_null()).then_some(Self(ptr))
    }

    /// Retains a borrowed (+0) reference, e.g. an element of a CFArray.
    pub(crate) unsafe fn retained(ptr: CFTypeRef) -> Option<Self> {
        if ptr.is_null() {
            return None;
        }
        Some(Self(CFRetain(ptr)))
    }

    /// A new CFString; `None` if `s` contains NUL or allocation fails.
    pub(crate) fn string(s: &str) -> Option<Self> {
        let cstr = CString::new(s).ok()?;
        unsafe {
            Self::owned(CFStringCreateWithCString(
                std::ptr::null(),
                cstr.as_ptr(),
                UTF8,
            ))
        }
    }

    pub(crate) fn as_ptr(&self) -> CFTypeRef {
        self.0
    }

    /// CFEqual against another reference.
    pub(crate) fn equals(&self, other: CFTypeRef) -> bool {
        !other.is_null() && unsafe { CFEqual(self.0, other) }
    }
}

impl Drop for CfRef {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

/// The CFTypeID class of a reference, for type-checked reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CfKind {
    String,
    Number,
    Boolean,
    Other,
}

pub(crate) unsafe fn cf_kind(cf: CFTypeRef) -> CfKind {
    if cf.is_null() {
        return CfKind::Other;
    }
    let id = CFGetTypeID(cf);
    if id == CFStringGetTypeID() {
        CfKind::String
    } else if id == CFNumberGetTypeID() {
        CfKind::Number
    } else if id == CFBooleanGetTypeID() {
        CfKind::Boolean
    } else {
        CfKind::Other
    }
}

/// A CFString's text; `None` for NULL or a non-string.
pub(crate) unsafe fn cf_to_string(cf: CFTypeRef) -> Option<String> {
    if cf_kind(cf) != CfKind::String {
        return None;
    }
    let ptr = CFStringGetCStringPtr(cf, UTF8);
    if !ptr.is_null() {
        return CStr::from_ptr(ptr).to_str().ok().map(str::to_string);
    }
    // No direct pointer: copy out. UTF-8 needs at most 4 bytes per UTF-16 unit.
    let len = CFStringGetLength(cf).max(0);
    let size = len.saturating_mul(4).saturating_add(1);
    let mut buf = vec![0u8; usize::try_from(size).ok()?];
    if !CFStringGetCString(cf, buf.as_mut_ptr().cast::<c_char>(), size, UTF8) {
        return None;
    }
    CStr::from_bytes_until_nul(&buf)
        .ok()
        .and_then(|s| s.to_str().ok())
        .map(str::to_string)
}

/// A CFNumber as f64; `None` for NULL or a non-number.
pub(crate) unsafe fn cf_number_f64(cf: CFTypeRef) -> Option<f64> {
    if cf_kind(cf) != CfKind::Number {
        return None;
    }
    let mut out: f64 = 0.0;
    CFNumberGetValue(
        cf,
        CF_NUMBER_FLOAT64,
        (&mut out as *mut f64).cast::<c_void>(),
    )
    .then_some(out)
}

/// A CFBoolean's value; `None` for NULL or a non-boolean.
pub(crate) unsafe fn cf_bool(cf: CFTypeRef) -> Option<bool> {
    (cf_kind(cf) == CfKind::Boolean).then(|| CFBooleanGetValue(cf))
}

/// Decimal text for a number: integral values print without a fraction.
pub(crate) fn number_text(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// String, number (decimal text) or boolean ("0"/"1") as text.
pub(crate) unsafe fn cf_value_to_string(cf: CFTypeRef) -> Option<String> {
    match cf_kind(cf) {
        CfKind::String => cf_to_string(cf),
        CfKind::Number => cf_number_f64(cf).map(number_text),
        CfKind::Boolean => Some(if CFBooleanGetValue(cf) { "1" } else { "0" }.to_string()),
        CfKind::Other => None,
    }
}

/// A new CFNumber: SInt64 for integral values, Float64 otherwise.
pub(crate) fn cf_number(n: f64) -> Option<CfRef> {
    unsafe {
        if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
            let v = n as i64;
            CfRef::owned(CFNumberCreate(
                std::ptr::null(),
                CF_NUMBER_SINT64,
                (&v as *const i64).cast::<c_void>(),
            ))
        } else {
            CfRef::owned(CFNumberCreate(
                std::ptr::null(),
                CF_NUMBER_FLOAT64,
                (&n as *const f64).cast::<c_void>(),
            ))
        }
    }
}

/// The shared `kCFBooleanTrue`/`kCFBooleanFalse` singleton (not owned).
pub(crate) fn cf_boolean(v: bool) -> CFTypeRef {
    unsafe {
        if v {
            kCFBooleanTrue
        } else {
            kCFBooleanFalse
        }
    }
}

/// A one-element CFArray holding `el` (retained by the array).
pub(crate) fn cf_array_of(el: CFTypeRef) -> Option<CfRef> {
    let values = [el];
    unsafe {
        CfRef::owned(CFArrayCreate(
            std::ptr::null(),
            values.as_ptr(),
            1,
            (&kCFTypeArrayCallBacks as *const [usize; 6]).cast::<c_void>(),
        ))
    }
}

/// Borrowed elements of a CFArray, retained one by one.
pub(crate) unsafe fn cf_array_items(array: CFArrayRef) -> Vec<Option<CfRef>> {
    let count = CFArrayGetCount(array).max(0);
    (0..count)
        .map(|i| CfRef::retained(CFArrayGetValueAtIndex(array, i)))
        .collect()
}
