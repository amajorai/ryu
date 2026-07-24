use anyhow::Result;

#[derive(Debug, Clone)]
pub enum WindowAction {
    Minimize,
    Maximize,
    Close,
    Restore,
    Move { x: i32, y: i32 },
    Resize { width: u32, height: u32 },
    List,
}

/// Focus an application by name or window title.
pub fn focus_app(app_name: &str) -> bool {
    #[cfg(target_os = "windows")]
    return windows_focus(app_name);

    #[cfg(target_os = "macos")]
    return macos_focus(app_name);

    #[cfg(target_os = "linux")]
    return crate::linux::focus_app(app_name);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("focus_app: {app_name}");
        false
    }
}

/// Perform a window action on the named app/window.
pub fn window_action(
    action: &WindowAction,
    app_name: &str,
    window_title: Option<&str>,
) -> Result<serde_json::Value> {
    #[cfg(target_os = "windows")]
    return windows_window_action(action, app_name, window_title);

    #[cfg(target_os = "macos")]
    return macos_window_action(action, app_name, window_title);

    #[cfg(target_os = "linux")]
    return crate::linux::window_action(action, app_name, window_title);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("window_action {:?} on {app_name}", action);
        Ok(serde_json::json!({ "success": true }))
    }
}

// ─── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_focus(app_name: &str) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
    };

    let Some(hwnd) = resolve_hwnd(app_name, None) else {
        return false;
    };

    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);

        // SetForegroundWindow is rejected for a background process under
        // Windows' foreground lock. Attaching our input queue to the current
        // foreground thread's makes the OS treat the request as coming from
        // the active app, which lets the change actually land.
        let fg = GetForegroundWindow();
        let mut fg_pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        let this_thread = GetCurrentThreadId();
        let attached = fg_thread != 0
            && fg_thread != this_thread
            && AttachThreadInput(this_thread, fg_thread, true).as_bool();

        let _ = SetForegroundWindow(hwnd);
        let _ = BringWindowToTop(hwnd);

        if attached {
            let _ = AttachThreadInput(this_thread, fg_thread, false);
        }

        // SetForegroundWindow's bool is unreliable from a background process;
        // the only honest signal is who actually owns the foreground now.
        GetForegroundWindow() == hwnd
    }
}

/// Resolve the best HWND for an app: an exact window-title match first, then the
/// topmost visible, titled window of any process whose executable name contains
/// `app_name`. `window_title`, when given, seeds the exact match and filters the
/// enumeration by title substring.
#[cfg(target_os = "windows")]
fn resolve_hwnd(
    app_name: &str,
    window_title: Option<&str>,
) -> Option<windows::Win32::Foundation::HWND> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    // 1. Exact window-title match (a given window_title wins over app_name).
    let exact = window_title.unwrap_or(app_name);
    let wide: Vec<u16> = std::ffi::OsStr::new(exact)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        if let Ok(h) = FindWindowW(None, PCWSTR(wide.as_ptr())) {
            if !h.0.is_null() {
                return Some(h);
            }
        }
    }

    // 2. Topmost visible, titled window of a process matching app_name.
    //    EnumWindows yields top-of-z-order first, so first() is the frontmost.
    matching_app_windows(app_name, window_title)
        .first()
        .map(|&(h, _, _)| HWND(h as *mut core::ffi::c_void))
}

/// Enumerate visible, titled windows of processes whose executable name contains
/// `app_name`, returned as (hwnd-as-isize, title, rect) in z-order (frontmost
/// first). When `title_filter` is set, only windows whose title contains it
/// (case-insensitive) are kept.
#[cfg(target_os = "windows")]
fn matching_app_windows(
    app_name: &str,
    title_filter: Option<&str>,
) -> Vec<(isize, String, windows::Win32::Foundation::RECT)> {
    use std::collections::HashSet;
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT};
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    // Collect PIDs whose process name matches.
    let name_lower = app_name.to_lowercase();
    let mut target_pids: HashSet<u32> = HashSet::new();
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap_or(INVALID_HANDLE_VALUE);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut pe).is_ok() {
                loop {
                    let exe = String::from_utf16_lossy(
                        pe.szExeFile
                            .iter()
                            .take_while(|&&c| c != 0)
                            .cloned()
                            .collect::<Vec<_>>()
                            .as_slice(),
                    );
                    if exe.to_lowercase().contains(&name_lower) {
                        target_pids.insert(pe.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
    }

    struct EnumData {
        pids: HashSet<u32>,
        title_filter: Option<String>,
        out: Vec<(isize, String, RECT)>,
    }
    let mut data = EnumData {
        pids: target_pids,
        title_filter: title_filter.map(|s| s.to_lowercase()),
        out: vec![],
    };
    let data_ptr = &mut data as *mut EnumData as isize;

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut EnumData);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if !data.pids.contains(&pid) {
            return BOOL(1);
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        if let Some(ref f) = data.title_filter {
            if !title.to_lowercase().contains(f) {
                return BOOL(1);
            }
        }
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        data.out.push((hwnd.0 as isize, title, rect));
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(data_ptr));
    }
    data.out
}

#[cfg(target_os = "windows")]
fn windows_window_action(
    action: &WindowAction,
    app_name: &str,
    window_title: Option<&str>,
) -> Result<serde_json::Value> {
    use windows::Win32::UI::WindowsAndMessaging::*;

    // List enumerates every window of the app — there is no single target hwnd,
    // so it must run before (and independently of) hwnd resolution.
    if let WindowAction::List = action {
        let windows: Vec<serde_json::Value> = matching_app_windows(app_name, None)
            .into_iter()
            .map(|(_, title, rect)| {
                serde_json::json!({
                    "title":  title,
                    "x":      rect.left,
                    "y":      rect.top,
                    "width":  (rect.right - rect.left).unsigned_abs(),
                    "height": (rect.bottom - rect.top).unsigned_abs(),
                })
            })
            .collect();
        return Ok(serde_json::json!({ "windows": windows }));
    }

    let hwnd = resolve_hwnd(app_name, window_title).ok_or_else(|| {
        anyhow::anyhow!(
            "Window for '{}' not found",
            window_title.unwrap_or(app_name)
        )
    })?;

    unsafe {
        match action {
            WindowAction::Minimize => {
                ShowWindow(hwnd, SW_MINIMIZE);
            }
            WindowAction::Maximize => {
                ShowWindow(hwnd, SW_MAXIMIZE);
            }
            WindowAction::Restore => {
                ShowWindow(hwnd, SW_RESTORE);
            }
            WindowAction::Close => {
                use windows::Win32::Foundation::{LPARAM, WPARAM};
                PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0))?;
            }
            WindowAction::Move { x, y } => {
                let mut rect = windows::Win32::Foundation::RECT::default();
                GetWindowRect(hwnd, &mut rect)?;
                let w = (rect.right - rect.left).unsigned_abs();
                let h = (rect.bottom - rect.top).unsigned_abs();
                MoveWindow(hwnd, *x, *y, w as i32, h as i32, true)?;
            }
            WindowAction::Resize { width, height } => {
                let mut rect = windows::Win32::Foundation::RECT::default();
                GetWindowRect(hwnd, &mut rect)?;
                MoveWindow(
                    hwnd,
                    rect.left,
                    rect.top,
                    *width as i32,
                    *height as i32,
                    true,
                )?;
            }
            WindowAction::List => unreachable!("handled above"),
        }
    }
    Ok(serde_json::json!({ "success": true }))
}

// ─── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_focus(app_name: &str) -> bool {
    use objc2::runtime::AnyClass;
    unsafe {
        let ws_class = match AnyClass::get("NSWorkspace") {
            Some(c) => c,
            None => return false,
        };
        let workspace: *mut objc2::runtime::AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        let apps: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace, runningApplications];
        let count: usize = objc2::msg_send![apps, count];
        let lower = app_name.to_lowercase();
        for i in 0..count {
            let app: *mut objc2::runtime::AnyObject = objc2::msg_send![apps, objectAtIndex: i];
            let name_obj: *mut objc2::runtime::AnyObject = objc2::msg_send![app, localizedName];
            if name_obj.is_null() {
                continue;
            }
            let cptr: *const std::ffi::c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(cptr).to_string_lossy();
            if name.to_lowercase().contains(&lower) {
                let _: bool = objc2::msg_send![app, activateWithOptions: 2u64]; // NSApplicationActivateIgnoringOtherApps
                return true;
            }
        }
        false
    }
}

// macОS window management via the Accessibility (AX) API. Move/Resize/Minimize/
// Restore/Close/List are real; Maximize maps to the AX "zoom" button (macOS has no
// true maximize). Requires the Accessibility permission, same as input synthesis.
#[cfg(target_os = "macos")]
mod macos_ax_window {
    use super::WindowAction;
    use anyhow::{anyhow, Result};
    use std::ffi::{c_char, c_void, CStr, CString};

    const UTF8: u32 = 0x0800_0100;
    const KAX_VALUE_TYPE_CGPOINT: i32 = 1;
    const KAX_VALUE_TYPE_CGSIZE: i32 = 2;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: *mut *const c_void,
        ) -> i32;
        fn AXUIElementSetAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: *const c_void,
        ) -> i32;
        fn AXUIElementPerformAction(element: *const c_void, action: *const c_void) -> i32;
        fn AXValueCreate(the_type: i32, value_ptr: *const c_void) -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> i64;
        fn CFArrayGetValueAtIndex(array: *const c_void, idx: i64) -> *const c_void;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFStringGetCStringPtr(s: *const c_void, encoding: u32) -> *const c_char;
        fn AXValueGetValue(value: *const c_void, the_type: i32, out: *mut c_void) -> bool;
        fn CFRetain(cf: *const c_void) -> *const c_void;
        fn CFRelease(cf: *const c_void);
        static kCFBooleanTrue: *const c_void;
        static kCFBooleanFalse: *const c_void;
    }

    unsafe fn cfstr(s: &str) -> *const c_void {
        let c = CString::new(s).unwrap_or_default();
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8)
    }

    unsafe fn ax_get(element: *const c_void, attr: &str) -> Option<*const c_void> {
        let a = cfstr(attr);
        let mut out: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, a, &mut out);
        CFRelease(a);
        if err == 0 && !out.is_null() {
            Some(out)
        } else {
            None
        }
    }

    unsafe fn ax_set(element: *const c_void, attr: &str, value: *const c_void) -> bool {
        let a = cfstr(attr);
        let err = AXUIElementSetAttributeValue(element, a, value);
        CFRelease(a);
        err == 0
    }

    unsafe fn ax_string(element: *const c_void, attr: &str) -> Option<String> {
        let v = ax_get(element, attr)?;
        let ptr = CFStringGetCStringPtr(v, UTF8);
        let s = if ptr.is_null() {
            None
        } else {
            Some(CStr::from_ptr(ptr).to_string_lossy().to_string())
        };
        CFRelease(v);
        s
    }

    unsafe fn ax_press(element: *const c_void, button_attr: &str) -> bool {
        let Some(btn) = ax_get(element, button_attr) else {
            return false;
        };
        let action = cfstr("AXPress");
        let err = AXUIElementPerformAction(btn, action);
        CFRelease(action);
        CFRelease(btn);
        err == 0
    }

    /// Resolve the frontmost matching app's pid via NSWorkspace.
    unsafe fn pid_for_app(app_name: &str) -> Option<i32> {
        use objc2::runtime::{AnyClass, AnyObject};
        let ws_class = AnyClass::get("NSWorkspace")?;
        let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        let apps: *mut AnyObject = objc2::msg_send![workspace, runningApplications];
        let count: usize = objc2::msg_send![apps, count];
        let lower = app_name.to_lowercase();
        for i in 0..count {
            let app: *mut AnyObject = objc2::msg_send![apps, objectAtIndex: i];
            let name_obj: *mut AnyObject = objc2::msg_send![app, localizedName];
            if name_obj.is_null() {
                continue;
            }
            let cptr: *const c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() {
                continue;
            }
            let name = CStr::from_ptr(cptr).to_string_lossy();
            if name.to_lowercase().contains(&lower) {
                let pid: i32 = objc2::msg_send![app, processIdentifier];
                return Some(pid);
            }
        }
        None
    }

    pub fn window_action(
        action: &WindowAction,
        app_name: &str,
        window_title: Option<&str>,
    ) -> Result<serde_json::Value> {
        unsafe {
            let pid = pid_for_app(app_name)
                .ok_or_else(|| anyhow!("Running app '{app_name}' not found"))?;
            let ax_app = AXUIElementCreateApplication(pid);
            if ax_app.is_null() {
                return Err(anyhow!(
                    "AXUIElementCreateApplication failed for {app_name}"
                ));
            }

            // List enumerates AXWindows; it needs no single target.
            if let WindowAction::List = action {
                let mut windows = vec![];
                if let Some(arr) = ax_get(ax_app, "AXWindows") {
                    let count = CFArrayGetCount(arr).min(50);
                    for i in 0..count {
                        let win = CFArrayGetValueAtIndex(arr, i);
                        if win.is_null() {
                            continue;
                        }
                        let title = ax_string(win, "AXTitle").unwrap_or_default();
                        let (mut x, mut y, mut w, mut h) = (0i32, 0i32, 0u32, 0u32);
                        if let Some(pv) = ax_get(win, "AXPosition") {
                            let mut p = CGPoint { x: 0.0, y: 0.0 };
                            AXValueGetValue(
                                pv,
                                KAX_VALUE_TYPE_CGPOINT,
                                &mut p as *mut _ as *mut c_void,
                            );
                            x = p.x as i32;
                            y = p.y as i32;
                            CFRelease(pv);
                        }
                        if let Some(sv) = ax_get(win, "AXSize") {
                            let mut s = CGSize {
                                width: 0.0,
                                height: 0.0,
                            };
                            AXValueGetValue(
                                sv,
                                KAX_VALUE_TYPE_CGSIZE,
                                &mut s as *mut _ as *mut c_void,
                            );
                            w = s.width as u32;
                            h = s.height as u32;
                            CFRelease(sv);
                        }
                        windows.push(serde_json::json!({
                            "title": title, "x": x, "y": y, "width": w, "height": h,
                        }));
                    }
                    CFRelease(arr);
                }
                CFRelease(ax_app);
                return Ok(serde_json::json!({ "windows": windows }));
            }

            // Resolve the target window: a title match, else the focused window.
            let win = resolve_window(ax_app, window_title);
            let Some(win) = win else {
                CFRelease(ax_app);
                return Err(anyhow!(
                    "Window for '{}' not found",
                    window_title.unwrap_or(app_name)
                ));
            };

            let result = match action {
                WindowAction::Minimize => ax_set(win, "AXMinimized", kCFBooleanTrue),
                WindowAction::Restore => ax_set(win, "AXMinimized", kCFBooleanFalse),
                WindowAction::Maximize => ax_press(win, "AXZoomButton"),
                WindowAction::Close => ax_press(win, "AXCloseButton"),
                WindowAction::Move { x, y } => {
                    let p = CGPoint {
                        x: *x as f64,
                        y: *y as f64,
                    };
                    let v = AXValueCreate(KAX_VALUE_TYPE_CGPOINT, &p as *const _ as *const c_void);
                    let ok = !v.is_null() && ax_set(win, "AXPosition", v);
                    if !v.is_null() {
                        CFRelease(v);
                    }
                    ok
                }
                WindowAction::Resize { width, height } => {
                    let s = CGSize {
                        width: *width as f64,
                        height: *height as f64,
                    };
                    let v = AXValueCreate(KAX_VALUE_TYPE_CGSIZE, &s as *const _ as *const c_void);
                    let ok = !v.is_null() && ax_set(win, "AXSize", v);
                    if !v.is_null() {
                        CFRelease(v);
                    }
                    ok
                }
                WindowAction::List => unreachable!("handled above"),
            };

            CFRelease(win);
            CFRelease(ax_app);
            Ok(serde_json::json!({ "success": result }))
        }
    }

    /// The window whose AXTitle contains `title` (when given), else AXFocusedWindow,
    /// else the first AXWindows entry. Returns a +1 retained AXUIElementRef.
    unsafe fn resolve_window(ax_app: *const c_void, title: Option<&str>) -> Option<*const c_void> {
        if let Some(t) = title {
            let needle = t.to_lowercase();
            if let Some(arr) = ax_get(ax_app, "AXWindows") {
                let count = CFArrayGetCount(arr);
                let mut found: Option<*const c_void> = None;
                for i in 0..count {
                    let win = CFArrayGetValueAtIndex(arr, i);
                    if win.is_null() {
                        continue;
                    }
                    if ax_string(win, "AXTitle")
                        .map(|s| s.to_lowercase().contains(&needle))
                        .unwrap_or(false)
                    {
                        // `win` is a +0 borrow into the array; retain it (+1) so it
                        // outlives the CFRelease(arr) below. Caller CFReleases it.
                        found = Some(CFRetain(win));
                        break;
                    }
                }
                CFRelease(arr);
                if found.is_some() {
                    return found;
                }
            }
        }
        ax_get(ax_app, "AXFocusedWindow")
    }
}

#[cfg(target_os = "macos")]
use macos_ax_window::window_action as macos_window_action;

// macOS: only the TCC-free failure paths are hermetic. `focus_app` and the
// `pid_for_app` lookup read NSWorkspace's running-app list (no input, no AX), and
// a bogus app name never matches — so no window is ever activated or manipulated.
// The real-app action paths (Minimize/Move/Resize/… on a resolved window) touch
// Accessibility and mutate live windows, so they are deliberately not exercised.
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;

    const NO_SUCH_APP: &str = "__ryu_ghost_hands_no_such_app_zzz__";

    #[test]
    fn focus_unknown_app_returns_false() {
        // Walks every running app, matches none, returns false without activating.
        assert!(!focus_app(NO_SUCH_APP));
    }

    #[test]
    fn window_action_unknown_app_errors() {
        // pid_for_app finds nothing ⇒ Err before any AX element is created.
        for action in [
            WindowAction::List,
            WindowAction::Minimize,
            WindowAction::Maximize,
            WindowAction::Close,
            WindowAction::Restore,
            WindowAction::Move { x: 0, y: 0 },
            WindowAction::Resize {
                width: 10,
                height: 10,
            },
        ] {
            let err = window_action(&action, NO_SUCH_APP, None)
                .unwrap_err()
                .to_string();
            assert!(err.contains("not found"), "action {action:?} ⇒ {err}");
        }
    }

    #[test]
    fn window_action_titled_unknown_app_errors() {
        let err = window_action(&WindowAction::Minimize, NO_SUCH_APP, Some("some title"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found"), "got: {err}");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn list_action_returns_windows_for_running_process() {
        // explorer.exe is always running with at least one visible top-level
        // window on a Windows desktop session. Before the fix this errored
        // ("Window 'explorer' not found") because List required an exact
        // window-title match up front.
        let result = window_action(&WindowAction::List, "explorer", None)
            .expect("List must not error for a running app");
        let windows = result
            .get("windows")
            .and_then(|w| w.as_array())
            .expect("List returns a `windows` array");
        assert!(
            !windows.is_empty(),
            "explorer should have at least one visible window"
        );
    }

    #[test]
    fn list_action_is_empty_not_error_for_unknown_app() {
        // A process that does not exist yields an empty list, never an error.
        let result = window_action(&WindowAction::List, "no_such_app_xyzzy_12345", None).unwrap();
        let windows = result.get("windows").and_then(|w| w.as_array()).unwrap();
        assert!(windows.is_empty());
    }
}
