// Window and app tracking — copied from apps/shadow/src/capture/window.rs

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub title: String,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub is_focused: bool,
}

#[async_trait]
pub trait WindowTracker: Send + Sync {
    async fn get_active_window(&self) -> Option<WindowInfo>;
    async fn get_active_app(&self) -> Option<AppInfo>;
}

// ─── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::Win32::Foundation::{HWND, HANDLE, CloseHandle};
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::System::Com::*;
    use windows::core::Interface;

    pub struct WindowsWindowTracker;
    impl WindowsWindowTracker { pub fn new() -> Result<Self> { Ok(Self) } }

    #[async_trait]
    impl WindowTracker for WindowsWindowTracker {
        async fn get_active_window(&self) -> Option<WindowInfo> {
            tokio::task::spawn_blocking(get_foreground_window_info).await.ok().flatten()
        }
        async fn get_active_app(&self) -> Option<AppInfo> {
            let win = tokio::task::spawn_blocking(get_foreground_window_info).await.ok().flatten()?;
            Some(AppInfo { name: win.app_name, bundle_id: win.bundle_id, pid: win.pid, is_focused: true })
        }
    }

    fn get_foreground_window_info() -> Option<WindowInfo> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == HWND(std::ptr::null_mut()) { return None; }
            let title_len = GetWindowTextLengthW(hwnd) as usize;
            let mut title_buf = vec![0u16; title_len + 2];
            GetWindowTextW(hwnd, &mut title_buf);
            let title = OsString::from_wide(title_buf.iter().take_while(|&&c| c != 0).cloned().collect::<Vec<_>>().as_slice()).to_string_lossy().to_string();
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let app_name = get_process_name(pid).unwrap_or_else(|| "Unknown".to_string());
            let url = extract_browser_url(hwnd, &app_name);
            Some(WindowInfo { title, app_name, bundle_id: None, pid: pid as i32, url })
        }
    }

    unsafe fn get_process_name(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let len = K32GetModuleFileNameExW(Some(handle), None, &mut buf) as usize;
        let _ = CloseHandle(handle);
        if len == 0 { return None; }
        let path = OsString::from_wide(&buf[..len]).to_string_lossy().to_string();
        std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string())
    }

    unsafe fn extract_browser_url(hwnd: HWND, app_name: &str) -> Option<String> {
        let browsers = ["chrome","msedge","firefox","brave","opera","vivaldi","arc","safari","iexplore"];
        if !browsers.iter().any(|&b| app_name.to_lowercase().contains(b)) { return None; }
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation.ElementFromHandle(hwnd).ok()?;
        let url_bar_names = ["Address and search bar","Search or enter address","Address bar","Omnibox","tab url"];
        let url = find_url_in_element(&automation, &root, &url_bar_names, 0);
        CoUninitialize();
        url
    }

    unsafe fn find_url_in_element(automation: &IUIAutomation, element: &IUIAutomationElement, names: &[&str], depth: u32) -> Option<String> {
        if depth > 6 { return None; }
        let name = element.CurrentName().map(|s| s.to_string()).unwrap_or_default();
        if names.iter().any(|&n| name.eq_ignore_ascii_case(n)) {
            if let Ok(vp) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                if let Ok(val) = vp.CurrentValue() {
                    let url = val.to_string();
                    if url.starts_with("http") { return Some(url); }
                }
            }
        }
        let walker_result: windows::core::Result<IUIAutomation> = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
        if let Ok(auto2) = walker_result {
            if let Ok(walker) = auto2.ControlViewWalker() {
                if let Ok(child) = walker.GetFirstChildElement(element) {
                    let mut current = child;
                    let mut visited = 0u32;
                    loop {
                        if let Some(url) = find_url_in_element(automation, &current, names, depth + 1) { return Some(url); }
                        match walker.GetNextSiblingElement(&current) { Ok(next) => current = next, Err(_) => break }
                        visited += 1; if visited >= 30 { break; }
                    }
                }
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsWindowTracker;

// ─── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub struct MacOSWindowTracker;
#[cfg(target_os = "macos")]
impl MacOSWindowTracker { pub fn new() -> Result<Self> { Ok(Self) } }

#[cfg(target_os = "macos")]
#[async_trait]
impl WindowTracker for MacOSWindowTracker {
    async fn get_active_window(&self) -> Option<WindowInfo> {
        tokio::task::spawn_blocking(macos_frontmost_window).await.ok().flatten()
    }
    async fn get_active_app(&self) -> Option<AppInfo> {
        let w = tokio::task::spawn_blocking(macos_frontmost_window).await.ok().flatten()?;
        Some(AppInfo { name: w.app_name, bundle_id: w.bundle_id, pid: w.pid, is_focused: true })
    }
}

#[cfg(target_os = "macos")]
fn macos_frontmost_window() -> Option<WindowInfo> {
    use std::ffi::{c_char, c_void, CStr};
    use objc2::runtime::AnyClass;
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(element: *const c_void, attribute: *const c_void, value: *mut *const c_void) -> i32;
        fn CFRelease(cf: *const c_void);
        fn CFStringGetCStringPtr(string: *const c_void, encoding: u32) -> *const c_char;
        fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> *const c_void;
    }
    const UTF8: u32 = 0x08000100;
    unsafe fn mkcf(s: &[u8]) -> *const c_void { CFStringCreateWithCString(std::ptr::null(), s.as_ptr() as *const c_char, UTF8) }
    unsafe fn ax_str(el: *const c_void, attr: &[u8]) -> Option<String> {
        let cf = mkcf(attr); let mut val: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, cf, &mut val); CFRelease(cf);
        if err != 0 || val.is_null() { return None; }
        let ptr = CFStringGetCStringPtr(val, UTF8);
        let r = if ptr.is_null() { None } else { Some(CStr::from_ptr(ptr).to_string_lossy().to_string()) };
        CFRelease(val); r
    }
    unsafe {
        let ws_class = AnyClass::get("NSWorkspace")?;
        let workspace: *mut objc2::runtime::AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        if workspace.is_null() { return None; }
        let app: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace, frontmostApplication];
        if app.is_null() { return None; }
        let pid: i32 = objc2::msg_send![app, processIdentifier];
        let name_obj: *mut objc2::runtime::AnyObject = objc2::msg_send![app, localizedName];
        let app_name = if name_obj.is_null() { String::new() } else {
            let cptr: *const c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() { String::new() } else { CStr::from_ptr(cptr).to_string_lossy().to_string() }
        };
        let bid_obj: *mut objc2::runtime::AnyObject = objc2::msg_send![app, bundleIdentifier];
        let bundle_id = if bid_obj.is_null() { None } else {
            let cptr: *const c_char = objc2::msg_send![bid_obj, UTF8String];
            if cptr.is_null() { None } else { Some(CStr::from_ptr(cptr).to_string_lossy().to_string()) }
        };
        let ax_app = AXUIElementCreateApplication(pid);
        let title = if !ax_app.is_null() {
            let win_cf = mkcf(b"AXFocusedWindow\0"); let mut win: *const c_void = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(ax_app, win_cf, &mut win); CFRelease(win_cf);
            let t = if err == 0 && !win.is_null() { let s = ax_str(win, b"AXTitle\0"); CFRelease(win); s } else { None };
            CFRelease(ax_app); t.unwrap_or_default()
        } else { String::new() };
        Some(WindowInfo { title, app_name, bundle_id, pid, url: None })
    }
}

// ─── Linux ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub struct LinuxWindowTracker;
#[cfg(target_os = "linux")]
impl LinuxWindowTracker { pub fn new() -> Result<Self> { Ok(Self) } }

#[cfg(target_os = "linux")]
#[async_trait]
impl WindowTracker for LinuxWindowTracker {
    async fn get_active_window(&self) -> Option<WindowInfo> {
        tokio::task::spawn_blocking(linux_active_window).await.ok().flatten()
    }
    async fn get_active_app(&self) -> Option<AppInfo> {
        let w = tokio::task::spawn_blocking(linux_active_window).await.ok().flatten()?;
        Some(AppInfo { name: w.app_name, bundle_id: None, pid: w.pid, is_focused: true })
    }
}

#[cfg(target_os = "linux")]
fn linux_active_window() -> Option<WindowInfo> {
    use x11rb::{connection::Connection, protocol::xproto::*, rust_connection::RustConnection};
    let (conn, sn) = RustConnection::connect(None).ok()?;
    let screen = &conn.setup().roots[sn]; let root = screen.root;
    let active_atom = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW").ok()?.reply().ok()?.atom;
    let name_atom = conn.intern_atom(false, b"_NET_WM_NAME").ok()?.reply().ok()?.atom;
    let utf8_atom = conn.intern_atom(false, b"UTF8_STRING").ok()?.reply().ok()?.atom;
    let pid_atom = conn.intern_atom(false, b"_NET_WM_PID").ok()?.reply().ok()?.atom;
    let prop = conn.get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1).ok()?.reply().ok()?;
    let win_id = prop.value32()?.next()?;
    if win_id == 0 { return None; }
    let title = { let p = conn.get_property(false, win_id, name_atom, utf8_atom, 0, 1024).ok()?.reply().ok()?; String::from_utf8_lossy(&p.value).to_string() };
    let pid = conn.get_property(false, win_id, pid_atom, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok().and_then(|p| p.value32()?.next()).unwrap_or(0) as i32;
    let app_name = { let p = conn.get_property(false, win_id, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024).ok()?.reply().ok()?; let s = String::from_utf8_lossy(&p.value); let mut parts = s.split('\0').filter(|s| !s.is_empty()); let inst = parts.next().unwrap_or("").to_string(); parts.next().unwrap_or(&inst).to_string() };
    Some(WindowInfo { title, app_name, bundle_id: None, pid, url: None })
}

// ─── Platform aliases ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub type PlatformWindowTracker = WindowsWindowTracker;
#[cfg(target_os = "macos")]
pub type PlatformWindowTracker = MacOSWindowTracker;
#[cfg(target_os = "linux")]
pub type PlatformWindowTracker = LinuxWindowTracker;
