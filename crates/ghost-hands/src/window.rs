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

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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

    #[cfg(not(target_os = "windows"))]
    {
        tracing::debug!("window_action {:?} on {app_name}", action);
        Ok(serde_json::json!({ "success": true }))
    }
}

// ─── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_focus(app_name: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        ShowWindow, SetForegroundWindow, BringWindowToTop, GetForegroundWindow,
        GetWindowThreadProcessId, SW_RESTORE,
    };
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};

    let Some(hwnd) = resolve_hwnd(app_name, None) else { return false; };

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
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use windows::Win32::Foundation::HWND;
    use windows::core::PCWSTR;
    use std::os::windows::ffi::OsStrExt;

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
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, IsWindowVisible, GetWindowRect, GetWindowThreadProcessId,
    };
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, INVALID_HANDLE_VALUE, CloseHandle};
    use std::collections::HashSet;

    // Collect PIDs whose process name matches.
    let name_lower = app_name.to_lowercase();
    let mut target_pids: HashSet<u32> = HashSet::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .unwrap_or(INVALID_HANDLE_VALUE);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut pe).is_ok() {
                loop {
                    let exe = String::from_utf16_lossy(
                        pe.szExeFile.iter().take_while(|&&c| c != 0).cloned().collect::<Vec<_>>().as_slice()
                    );
                    if exe.to_lowercase().contains(&name_lower) {
                        target_pids.insert(pe.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut pe).is_err() { break; }
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
        if !data.pids.contains(&pid) { return BOOL(1); }
        if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 { return BOOL(1); }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        if let Some(ref f) = data.title_filter {
            if !title.to_lowercase().contains(f) { return BOOL(1); }
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
            .map(|(_, title, rect)| serde_json::json!({
                "title":  title,
                "x":      rect.left,
                "y":      rect.top,
                "width":  (rect.right - rect.left).unsigned_abs(),
                "height": (rect.bottom - rect.top).unsigned_abs(),
            }))
            .collect();
        return Ok(serde_json::json!({ "windows": windows }));
    }

    let hwnd = resolve_hwnd(app_name, window_title).ok_or_else(|| {
        anyhow::anyhow!("Window for '{}' not found", window_title.unwrap_or(app_name))
    })?;

    unsafe {
        match action {
            WindowAction::Minimize => { ShowWindow(hwnd, SW_MINIMIZE); }
            WindowAction::Maximize => { ShowWindow(hwnd, SW_MAXIMIZE); }
            WindowAction::Restore  => { ShowWindow(hwnd, SW_RESTORE); }
            WindowAction::Close    => {
                use windows::Win32::Foundation::{WPARAM, LPARAM};
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
                MoveWindow(hwnd, rect.left, rect.top, *width as i32, *height as i32, true)?;
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
        let ws_class = match AnyClass::get(c"NSWorkspace") {
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
            if name_obj.is_null() { continue; }
            let cptr: *const std::ffi::c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() { continue; }
            let name = std::ffi::CStr::from_ptr(cptr).to_string_lossy();
            if name.to_lowercase().contains(&lower) {
                let _: bool = objc2::msg_send![app, activateWithOptions: 2u64]; // NSApplicationActivateIgnoringOtherApps
                return true;
            }
        }
        false
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
        let result =
            window_action(&WindowAction::List, "no_such_app_xyzzy_12345", None).unwrap();
        let windows = result.get("windows").and_then(|w| w.as_array()).unwrap();
        assert!(windows.is_empty());
    }
}
