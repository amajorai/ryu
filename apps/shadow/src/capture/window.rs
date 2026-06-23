use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Window information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub title: String,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub url: Option<String>,
}

/// App information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub is_focused: bool,
}

/// Window tracking trait.
#[async_trait]
pub trait WindowTracker: Send + Sync {
    async fn get_active_window(&self) -> Option<WindowInfo>;
    async fn get_active_app(&self) -> Option<AppInfo>;
}

// ─── Windows: GetForegroundWindow + WinAPI ────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    use windows::Win32::System::Com::*;
    use windows::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    pub struct WindowsWindowTracker;

    impl WindowsWindowTracker {
        pub fn new() -> Result<Self> {
            Ok(Self)
        }
    }

    #[async_trait]
    impl WindowTracker for WindowsWindowTracker {
        async fn get_active_window(&self) -> Option<WindowInfo> {
            tokio::task::spawn_blocking(get_foreground_window_info)
                .await
                .ok()
                .flatten()
        }

        async fn get_active_app(&self) -> Option<AppInfo> {
            let win = tokio::task::spawn_blocking(get_foreground_window_info)
                .await
                .ok()
                .flatten()?;
            Some(AppInfo {
                name: win.app_name,
                bundle_id: win.bundle_id,
                pid: win.pid,
                is_focused: true,
            })
        }
    }

    fn get_foreground_window_info() -> Option<WindowInfo> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == HWND(std::ptr::null_mut()) {
                return None;
            }

            // Get window title
            let title_len = GetWindowTextLengthW(hwnd) as usize;
            let mut title_buf = vec![0u16; title_len + 2];
            GetWindowTextW(hwnd, &mut title_buf);
            let title = OsString::from_wide(
                title_buf
                    .iter()
                    .take_while(|&&c| c != 0)
                    .cloned()
                    .collect::<Vec<_>>()
                    .as_slice(),
            )
            .to_string_lossy()
            .to_string();

            // Get process ID
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));

            // Resolve the executable path once, then derive both the process stem
            // ("msedge") and the friendly display name ("Microsoft Edge").
            let image_path = get_process_image_path(pid);
            let proc_stem = image_path
                .as_deref()
                .and_then(stem_from_path)
                .unwrap_or_else(|| "Unknown".to_string());

            // Browser-URL detection keys off process-stem tokens (e.g. "msedge"),
            // which are NOT substrings of the friendly name, so match on the stem.
            let url = extract_browser_url(hwnd, &proc_stem);

            // Display/app name: prefer the executable's version-info
            // FileDescription ("Task Manager" for Taskmgr.exe), falling back to the
            // process stem when the exe carries no version resource.
            let app_name = image_path
                .as_deref()
                .and_then(friendly_name_from_path)
                .unwrap_or(proc_stem);

            Some(WindowInfo {
                title,
                app_name,
                bundle_id: None,
                pid: pid as i32,
                url,
            })
        }
    }

    /// Full path of a process's main executable, e.g. `C:\Windows\System32\Taskmgr.exe`.
    unsafe fn get_process_image_path(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = vec![0u16; 1024];
        let len = K32GetModuleFileNameExW(Some(handle), None, &mut buf) as usize;
        let _ = CloseHandle(handle);

        if len == 0 {
            return None;
        }

        Some(
            OsString::from_wide(&buf[..len])
                .to_string_lossy()
                .to_string(),
        )
    }

    /// The executable's file stem (no extension), e.g. `Taskmgr`. Used as a stable
    /// process identifier for token matching (browser detection, allowlist).
    fn stem_from_path(path: &str) -> Option<String> {
        std::path::Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    }

    /// Cache of exe path -> friendly name. The executable path is stable per
    /// process and version-info is a disk read, so cache it off the capture hot
    /// path. `None` is cached too (exes with no version resource).
    fn friendly_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// The friendly application name from the exe's version-info `FileDescription`
    /// (e.g. "Task Manager" for `Taskmgr.exe`), or `None` when unavailable.
    fn friendly_name_from_path(path: &str) -> Option<String> {
        if let Ok(cache) = friendly_cache().lock() {
            if let Some(hit) = cache.get(path) {
                return hit.clone();
            }
        }
        let computed = unsafe { read_file_description(path) };
        if let Ok(mut cache) = friendly_cache().lock() {
            cache.insert(path.to_string(), computed.clone());
        }
        computed
    }

    /// A NUL-terminated UTF-16 buffer for passing &str to wide Win32 APIs.
    fn wide_nul(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Read `FileDescription` from a file's version-info block. Resolves the real
    /// language/codepage from the `\VarFileInfo\Translation` table (falling back to
    /// common codepages) rather than hardcoding US-English.
    unsafe fn read_file_description(path: &str) -> Option<String> {
        let wide = wide_nul(path);
        let name = PCWSTR(wide.as_ptr());
        let size = GetFileVersionInfoSizeW(name, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(name, Some(0), size, data.as_mut_ptr().cast()).ok()?;

        // Candidate "lang+codepage" tokens for the StringFileInfo sub-block. The
        // real one (from the Translation table) is tried first.
        let mut candidates: Vec<String> = Vec::new();
        if let Some((lang, cp)) = query_translation(&data) {
            candidates.push(format!("{lang:04x}{cp:04x}"));
        }
        // Common fallbacks: US-English/Unicode, US-English/Latin-1, lang-neutral.
        for token in ["040904b0", "040904e4", "000004b0"] {
            if !candidates.iter().any(|c| c == token) {
                candidates.push(token.to_string());
            }
        }

        for token in candidates {
            let sub = format!("\\StringFileInfo\\{token}\\FileDescription");
            if let Some(desc) = query_string(&data, &sub) {
                let trimmed = desc.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
        None
    }

    /// The first `{language, codepage}` pair from a version block's Translation table.
    unsafe fn query_translation(data: &[u8]) -> Option<(u16, u16)> {
        let sub = wide_nul("\\VarFileInfo\\Translation");
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        let ok = VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(sub.as_ptr()),
            &mut ptr,
            &mut len,
        );
        if !ok.as_bool() || ptr.is_null() || len < 4 {
            return None;
        }
        let lang = *(ptr as *const u16);
        let codepage = *((ptr as *const u16).add(1));
        Some((lang, codepage))
    }

    /// Read a string value (e.g. FileDescription) from a version block by sub-block.
    unsafe fn query_string(data: &[u8], sub_block: &str) -> Option<String> {
        let sub = wide_nul(sub_block);
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        let ok = VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(sub.as_ptr()),
            &mut ptr,
            &mut len,
        );
        if !ok.as_bool() || ptr.is_null() || len == 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        let s = OsString::from_wide(slice).to_string_lossy().to_string();
        let s = s.trim_end_matches('\0').to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    unsafe fn extract_browser_url(hwnd: HWND, app_name: &str) -> Option<String> {
        let browser_processes = [
            "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "safari", "iexplore",
        ];

        let app_lower = app_name.to_lowercase();
        if !browser_processes.iter().any(|&b| app_lower.contains(b)) {
            return None;
        }

        // Initialize COM for this thread (STA)
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(a) => a,
                Err(_) => return None,
            };

        let root = automation.ElementFromHandle(hwnd).ok()?;

        // Walk the tree to find URL bar by name/value pattern
        let url_bar_names = [
            "Address and search bar",
            "Search or enter address",
            "Address bar",
            "Omnibox",
            "tab url",
        ];

        let url = find_url_in_element(&automation, &root, &url_bar_names, 0);
        CoUninitialize();
        url
    }

    unsafe fn find_url_in_element(
        automation: &IUIAutomation,
        element: &IUIAutomationElement,
        url_bar_names: &[&str],
        depth: u32,
    ) -> Option<String> {
        if depth > 6 {
            return None;
        }

        // Check if this element is an address bar
        let name = element
            .CurrentName()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if url_bar_names.iter().any(|&n| name.eq_ignore_ascii_case(n)) {
            if let Ok(vp) =
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                if let Ok(val) = vp.CurrentValue() {
                    let url = val.to_string();
                    if url.starts_with("http") {
                        return Some(url);
                    }
                }
            }
        }

        // Walk children
        let walker_result: windows::core::Result<IUIAutomation> =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
        if let Ok(auto2) = walker_result {
            if let Ok(walker) = auto2.ControlViewWalker() {
                if let Ok(child) = walker.GetFirstChildElement(element) {
                    let mut current = child;
                    let mut visited = 0u32;
                    loop {
                        if let Some(url) =
                            find_url_in_element(automation, &current, url_bar_names, depth + 1)
                        {
                            return Some(url);
                        }
                        match walker.GetNextSiblingElement(&current) {
                            Ok(next) => current = next,
                            Err(_) => break,
                        }
                        visited += 1;
                        if visited >= 30 {
                            break;
                        }
                    }
                }
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsWindowTracker;

// ─── macOS: NSWorkspace + AXUIElement ────────────────────────────────────────

#[cfg(target_os = "macos")]
pub struct MacOSWindowTracker;

#[cfg(target_os = "macos")]
impl MacOSWindowTracker {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "macos")]
#[async_trait]
impl WindowTracker for MacOSWindowTracker {
    async fn get_active_window(&self) -> Option<WindowInfo> {
        tokio::task::spawn_blocking(macos_frontmost_window)
            .await
            .ok()
            .flatten()
    }
    async fn get_active_app(&self) -> Option<AppInfo> {
        let w = tokio::task::spawn_blocking(macos_frontmost_window)
            .await
            .ok()
            .flatten()?;
        Some(AppInfo {
            name: w.app_name,
            bundle_id: w.bundle_id,
            pid: w.pid,
            is_focused: true,
        })
    }
}

#[cfg(target_os = "macos")]
fn macos_frontmost_window() -> Option<WindowInfo> {
    use objc2::runtime::AnyClass;
    use std::ffi::{c_char, c_void, CStr};

    // AXUIElement FFI for window title + browser URL
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            attribute: *const c_void, // CFStringRef
            value: *mut *const c_void,
        ) -> i32; // AXError
        fn CFRelease(cf: *const c_void);
        fn CFStringGetCStringPtr(string: *const c_void, encoding: u32) -> *const c_char;
        fn AXValueGetType(value: *const c_void) -> u32;
    }

    // CoreFoundation string literals
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
    }

    const KCF_STRING_ENCODING_UTF8: u32 = 0x08000100;

    unsafe fn cf_string(s: &[u8]) -> *const c_void {
        CFStringCreateWithCString(
            std::ptr::null(),
            s.as_ptr() as *const c_char,
            KCF_STRING_ENCODING_UTF8,
        )
    }

    unsafe fn ax_string_attr(element: *const c_void, attr: &[u8]) -> Option<String> {
        let attr_cf = cf_string(attr);
        let mut value: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, attr_cf, &mut value);
        CFRelease(attr_cf);
        if err != 0 || value.is_null() {
            return None;
        }
        // value is a CFStringRef
        let ptr = CFStringGetCStringPtr(value, KCF_STRING_ENCODING_UTF8);
        let result = if ptr.is_null() {
            None
        } else {
            Some(CStr::from_ptr(ptr).to_string_lossy().to_string())
        };
        CFRelease(value);
        result
    }

    unsafe {
        // NSWorkspace.sharedWorkspace.frontmostApplication
        let ws_class = AnyClass::get(c"NSWorkspace")?;
        let workspace: *mut objc2::runtime::AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }

        let pid: i32 = objc2::msg_send![app, processIdentifier];

        // `localizedName` is already the user-facing app name ("Activity Monitor",
        // "Visual Studio Code"), not the process/bundle id, so no friendly-name
        // resolution is needed on macOS (unlike Windows exe stems / Linux WM_CLASS).
        let name_obj: *mut objc2::runtime::AnyObject = objc2::msg_send![app, localizedName];
        let app_name = if name_obj.is_null() {
            String::new()
        } else {
            let cptr: *const c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() {
                String::new()
            } else {
                CStr::from_ptr(cptr).to_string_lossy().to_string()
            }
        };

        let bid_obj: *mut objc2::runtime::AnyObject = objc2::msg_send![app, bundleIdentifier];
        let bundle_id = if bid_obj.is_null() {
            None
        } else {
            let cptr: *const c_char = objc2::msg_send![bid_obj, UTF8String];
            if cptr.is_null() {
                None
            } else {
                Some(CStr::from_ptr(cptr).to_string_lossy().to_string())
            }
        };

        // Get window title via AXUIElement (requires accessibility permissions)
        let ax_app = AXUIElementCreateApplication(pid);
        let title = if !ax_app.is_null() {
            let kax_focused = b"AXFocusedWindow\0";
            let mut win: *const c_void = std::ptr::null();
            let attr_cf = cf_string(kax_focused);
            let err = AXUIElementCopyAttributeValue(ax_app, attr_cf, &mut win);
            CFRelease(attr_cf);
            let title = if err == 0 && !win.is_null() {
                let t = ax_string_attr(win, b"AXTitle\0");
                CFRelease(win);
                t
            } else {
                None
            };
            CFRelease(ax_app);
            title.unwrap_or_default()
        } else {
            String::new()
        };

        // Try to extract browser URL via AX (address bar value)
        let url = try_macos_browser_url(pid, &app_name);

        Some(WindowInfo {
            title,
            app_name,
            bundle_id,
            pid,
            url,
        })
    }
}

#[cfg(target_os = "macos")]
fn try_macos_browser_url(pid: i32, app_name: &str) -> Option<String> {
    let browsers = [
        "chrome", "safari", "firefox", "edge", "brave", "arc", "opera", "vivaldi", "iexplore",
    ];
    let lower = app_name.to_lowercase();
    if !browsers.iter().any(|&b| lower.contains(b)) {
        return None;
    }

    use std::ffi::{c_char, c_void, CStr};
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(
            e: *const c_void,
            attr: *const c_void,
            val: *mut *const c_void,
        ) -> i32;
        fn AXUIElementCopyAttributeNames(e: *const c_void, names: *mut *const c_void) -> i32;
        fn CFArrayGetCount(arr: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(arr: *const c_void, idx: isize) -> *const c_void;
        fn CFStringGetCStringPtr(s: *const c_void, enc: u32) -> *const c_char;
        fn CFRelease(cf: *const c_void);
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            enc: u32,
        ) -> *const c_void;
    }
    const UTF8: u32 = 0x08000100;
    unsafe fn mkcf(s: &[u8]) -> *const c_void {
        unsafe { CFStringCreateWithCString(std::ptr::null(), s.as_ptr() as *const c_char, UTF8) }
    }
    unsafe fn ax_str(el: *const c_void, attr: &[u8]) -> Option<String> {
        let cf = unsafe { mkcf(attr) };
        let mut val: *const c_void = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(el, cf, &mut val) };
        unsafe {
            CFRelease(cf);
        }
        if err != 0 || val.is_null() {
            return None;
        }
        let ptr = unsafe { CFStringGetCStringPtr(val, UTF8) };
        let r = if ptr.is_null() {
            None
        } else {
            unsafe { Some(CStr::from_ptr(ptr).to_string_lossy().to_string()) }
        };
        unsafe {
            CFRelease(val);
        }
        r
    }

    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return None;
        }
        // AXFocusedWindow -> children looking for AXTextField with URL-like value
        let win_cf = mkcf(b"AXFocusedWindow\0");
        let mut win: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(app_el, win_cf, &mut win);
        CFRelease(win_cf);
        CFRelease(app_el);
        if err != 0 || win.is_null() {
            return None;
        }

        // Walk children for address bar
        let children_cf = mkcf(b"AXChildren\0");
        let mut children: *const c_void = std::ptr::null();
        let _ = AXUIElementCopyAttributeValue(win, children_cf, &mut children);
        CFRelease(children_cf);
        CFRelease(win);
        if children.is_null() {
            return None;
        }

        let count = CFArrayGetCount(children);
        let mut result = None;
        'outer: for i in 0..count {
            let child = CFArrayGetValueAtIndex(children, i);
            if let Some(role) = ax_str(child, b"AXRole\0") {
                if role == "AXTextField" || role == "AXComboBox" {
                    if let Some(val) = ax_str(child, b"AXValue\0") {
                        if val.starts_with("http") {
                            result = Some(val);
                            break 'outer;
                        }
                    }
                }
            }
        }
        CFRelease(children);
        result
    }
}

// ─── Linux: X11 _NET_ACTIVE_WINDOW ───────────────────────────────────────────

#[cfg(target_os = "linux")]
pub struct LinuxWindowTracker;

#[cfg(target_os = "linux")]
impl LinuxWindowTracker {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WindowTracker for LinuxWindowTracker {
    async fn get_active_window(&self) -> Option<WindowInfo> {
        tokio::task::spawn_blocking(linux_active_window)
            .await
            .ok()
            .flatten()
    }
    async fn get_active_app(&self) -> Option<AppInfo> {
        let w = tokio::task::spawn_blocking(linux_active_window)
            .await
            .ok()
            .flatten()?;
        Some(AppInfo {
            name: w.app_name,
            bundle_id: None,
            pid: w.pid,
            is_focused: true,
        })
    }
}

/// Cache of WM_CLASS token -> friendly name. Resolving a `.desktop` file is a
/// filesystem scan, so cache it (incl. misses) off the capture hot path.
#[cfg(target_os = "linux")]
fn linux_friendly_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, Option<String>>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Standard XDG directories that hold `.desktop` application entries.
#[cfg(target_os = "linux")]
fn linux_desktop_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = Vec::new();
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    if let Some(d) = data_home {
        dirs.push(d.join("applications"));
        dirs.push(d.join("flatpak/exports/share/applications"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for d in data_dirs.split(':').filter(|s| !s.is_empty()) {
        dirs.push(PathBuf::from(d).join("applications"));
    }
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    dirs
}

/// Parse a `.desktop` file's `[Desktop Entry]` section, returning its `Name` and
/// `StartupWMClass` (the unlocalized values). Lines outside the section and
/// locale-qualified keys like `Name[de]=` are ignored.
#[cfg(target_os = "linux")]
fn parse_desktop_entry(contents: &str) -> (Option<String>, Option<String>) {
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut startup_wm_class: Option<String> = None;
    for raw in contents.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            if name.is_none() {
                name = Some(v.trim().to_string());
            }
        } else if let Some(v) = line.strip_prefix("StartupWMClass=") {
            startup_wm_class = Some(v.trim().to_string());
        }
    }
    (name, startup_wm_class)
}

/// The friendly app name for a WM_CLASS token, from the matching `.desktop`
/// entry's `Name=`, or `None` when no entry matches. Cached per token.
#[cfg(target_os = "linux")]
fn linux_friendly_name(wm_class: &str) -> Option<String> {
    if wm_class.is_empty() {
        return None;
    }
    if let Ok(cache) = linux_friendly_cache().lock() {
        if let Some(hit) = cache.get(wm_class) {
            return hit.clone();
        }
    }
    let computed = resolve_linux_friendly_name(wm_class);
    if let Ok(mut cache) = linux_friendly_cache().lock() {
        cache.insert(wm_class.to_string(), computed.clone());
    }
    computed
}

/// Filesystem lookup behind {@link linux_friendly_name}: first a `.desktop` file
/// whose basename matches the WM_CLASS (the common case), then a bounded scan for
/// one whose `StartupWMClass` matches.
#[cfg(target_os = "linux")]
fn resolve_linux_friendly_name(wm_class: &str) -> Option<String> {
    let dirs = linux_desktop_dirs();
    let lower = wm_class.to_lowercase();
    let candidates = [format!("{wm_class}.desktop"), format!("{lower}.desktop")];

    for dir in &dirs {
        for cand in &candidates {
            if let Ok(contents) = std::fs::read_to_string(dir.join(cand)) {
                if let (Some(name), _) = parse_desktop_entry(&contents) {
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
    }

    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            let (name, startup) = parse_desktop_entry(&contents);
            let matches = startup
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(wm_class));
            if matches {
                if let Some(name) = name {
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_active_window() -> Option<WindowInfo> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::*;
    use x11rb::rust_connection::RustConnection;

    let (conn, sn) = RustConnection::connect(None).ok()?;
    let screen = &conn.setup().roots[sn];
    let root = screen.root;

    // Intern all needed atoms
    let active_atom = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let name_atom = conn
        .intern_atom(false, b"_NET_WM_NAME")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let utf8_atom = conn
        .intern_atom(false, b"UTF8_STRING")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let pid_atom = conn
        .intern_atom(false, b"_NET_WM_PID")
        .ok()?
        .reply()
        .ok()?
        .atom;

    // _NET_ACTIVE_WINDOW on root
    let prop = conn
        .get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let win_id = prop.value32()?.next()?;
    if win_id == 0 {
        return None;
    }

    // _NET_WM_NAME (UTF-8 title)
    let title = {
        let p = conn
            .get_property(false, win_id, name_atom, utf8_atom, 0, 1024)
            .ok()?
            .reply()
            .ok()?;
        let s = String::from_utf8_lossy(&p.value).to_string();
        if s.is_empty() {
            // Fall back to WM_NAME
            conn.get_property(false, win_id, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)
                .ok()?
                .reply()
                .ok()
                .map(|p| String::from_utf8_lossy(&p.value).to_string())
                .unwrap_or_default()
        } else {
            s
        }
    };

    // _NET_WM_PID
    let pid = conn
        .get_property(false, win_id, pid_atom, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()
        .and_then(|p| p.value32()?.next())
        .unwrap_or(0) as i32;

    // WM_CLASS: two null-terminated strings (instance, class).
    let (wm_instance, wm_class) = {
        let p = conn
            .get_property(false, win_id, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
            .ok()?
            .reply()
            .ok()?;
        let s = String::from_utf8_lossy(&p.value);
        let mut parts = s.split('\0').filter(|s| !s.is_empty());
        let instance = parts.next().unwrap_or("").to_string();
        let class = parts.next().unwrap_or(&instance).to_string();
        (instance, class)
    };

    // Prefer the friendly `Name=` from the matching `.desktop` entry ("Firefox",
    // "System Monitor") over the raw WM_CLASS ("firefox", "Gnome-system-monitor"),
    // falling back to the class name when no desktop entry matches. Try the class
    // first, then the instance.
    let app_name = linux_friendly_name(&wm_class)
        .or_else(|| linux_friendly_name(&wm_instance))
        .unwrap_or(wm_class);

    Some(WindowInfo {
        title,
        app_name,
        bundle_id: None,
        pid,
        url: None,
    })
}

#[cfg(target_os = "windows")]
pub type PlatformWindowTracker = WindowsWindowTracker;
#[cfg(target_os = "macos")]
pub type PlatformWindowTracker = MacOSWindowTracker;
#[cfg(target_os = "linux")]
pub type PlatformWindowTracker = LinuxWindowTracker;
