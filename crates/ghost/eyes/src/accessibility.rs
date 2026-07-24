// Accessibility tree primitives — copied from apps/shadow/src/capture/accessibility.rs
// with shadow_core dependency removed.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Accessibility tree node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AXTreeNode {
    pub role: String,
    pub title: Option<String>,
    pub value: Option<String>,
    pub identifier: Option<String>,
    pub bounds: Option<Bounds>,
    pub children: Vec<AXTreeNode>,
    pub enabled: bool,
    pub focused: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Accessibility tree trait.
#[async_trait]
pub trait AXTree: Send + Sync {
    async fn get_focused_tree(&self) -> Result<AXTreeNode>;
    async fn find_element(&self, description: &str) -> Option<AXTreeNode>;
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode>;
    async fn list_apps(&self) -> Vec<serde_json::Value>;
}

// ─── Windows: IUIAutomation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use windows::core::Interface;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    pub struct WindowsAXTree;

    impl WindowsAXTree {
        pub fn new() -> Result<Self> {
            Ok(Self)
        }
    }

    #[async_trait]
    impl AXTree for WindowsAXTree {
        async fn get_focused_tree(&self) -> Result<AXTreeNode> {
            tokio::task::spawn_blocking(get_focused_tree_sync).await?
        }
        async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
            let desc = description.to_string();
            tokio::task::spawn_blocking(move || find_element_sync(&desc))
                .await
                .ok()
                .flatten()
        }
        async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
            tokio::task::spawn_blocking(move || element_at_sync(x, y))
                .await
                .ok()
                .flatten()
        }
        async fn list_apps(&self) -> Vec<serde_json::Value> {
            tokio::task::spawn_blocking(list_apps_sync)
                .await
                .unwrap_or_default()
        }
    }

    fn get_focused_tree_sync() -> Result<AXTreeNode> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let hwnd = GetForegroundWindow();
            let root = automation.ElementFromHandle(hwnd)?;
            let node = walk_element(&root, 0, 6)?;
            CoUninitialize();
            Ok(node)
        }
    }

    fn find_element_sync(description: &str) -> Option<AXTreeNode> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let hwnd = GetForegroundWindow();
            let root = automation.ElementFromHandle(hwnd).ok()?;
            let tree = walk_element(&root, 0, 5).ok()?;
            CoUninitialize();
            find_in_tree(&tree, &description.to_lowercase())
        }
    }

    fn element_at_sync(x: i32, y: i32) -> Option<AXTreeNode> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let pt = windows::Win32::Foundation::POINT { x, y };
            let element = automation.ElementFromPoint(pt).ok()?;
            CoUninitialize();
            walk_element(&element, 0, 1).ok()
        }
    }

    fn list_apps_sync() -> Vec<serde_json::Value> {
        use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows::Win32::System::Diagnostics::ToolHelp::*;
        let mut apps = vec![];
        unsafe {
            let snapshot =
                CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap_or(INVALID_HANDLE_VALUE);
            if snapshot == INVALID_HANDLE_VALUE {
                return apps;
            }
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut pe).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(
                        pe.szExeFile
                            .iter()
                            .take_while(|&&c| c != 0)
                            .cloned()
                            .collect::<Vec<_>>()
                            .as_slice(),
                    );
                    apps.push(serde_json::json!({ "pid": pe.th32ProcessID, "name": name }));
                    if Process32NextW(snapshot, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        }
        apps
    }

    pub unsafe fn walk_element(
        element: &IUIAutomationElement,
        depth: u32,
        max_depth: u32,
    ) -> Result<AXTreeNode> {
        if depth > max_depth {
            return Ok(AXTreeNode {
                role: "...".to_string(),
                title: None,
                value: None,
                identifier: None,
                bounds: None,
                children: vec![],
                enabled: true,
                focused: false,
                hidden: false,
            });
        }
        let role = element
            .CurrentLocalizedControlType()
            .map(|s| s.to_string())
            .unwrap_or_else(|_| "element".to_string());
        let title = element
            .CurrentName()
            .map(|s| {
                let t = s.to_string();
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            })
            .unwrap_or(None);
        let value = if let Ok(vp) =
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            vp.CurrentValue()
                .map(|s| {
                    let v = s.to_string();
                    if v.is_empty() {
                        None
                    } else {
                        Some(v)
                    }
                })
                .unwrap_or(None)
        } else {
            None
        };
        let identifier = element
            .CurrentAutomationId()
            .map(|s| {
                let id = s.to_string();
                if id.is_empty() {
                    None
                } else {
                    Some(id)
                }
            })
            .unwrap_or(None);
        let bounds = element.CurrentBoundingRectangle().ok().map(|r| Bounds {
            x: r.left,
            y: r.top,
            width: (r.right - r.left).unsigned_abs(),
            height: (r.bottom - r.top).unsigned_abs(),
        });
        let mut children = vec![];
        if depth < max_depth {
            let automation_result: windows::core::Result<IUIAutomation> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
            if let Ok(automation) = automation_result {
                if let Ok(walker) = automation.ControlViewWalker() {
                    if let Ok(child) = walker.GetFirstChildElement(element) {
                        let mut current = child;
                        loop {
                            if let Ok(node) = walk_element(&current, depth + 1, max_depth) {
                                children.push(node);
                            }
                            match walker.GetNextSiblingElement(&current) {
                                Ok(next) => current = next,
                                Err(_) => break,
                            }
                            if children.len() >= 100 {
                                break;
                            }
                        }
                    }
                }
            }
        }
        let enabled = element
            .CurrentIsEnabled()
            .map(|b| b.as_bool())
            .unwrap_or(true);
        let focused = element
            .CurrentHasKeyboardFocus()
            .map(|b| b.as_bool())
            .unwrap_or(false);
        let hidden = element
            .CurrentIsOffscreen()
            .map(|b| b.as_bool())
            .unwrap_or(false);
        Ok(AXTreeNode {
            role,
            title,
            value,
            identifier,
            bounds,
            children,
            enabled,
            focused,
            hidden,
        })
    }

    fn find_in_tree(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
        let role_lower = node.role.to_lowercase();
        let title_lower = node.title.as_deref().unwrap_or("").to_lowercase();
        let value_lower = node.value.as_deref().unwrap_or("").to_lowercase();
        let id_lower = node.identifier.as_deref().unwrap_or("").to_lowercase();
        if role_lower.contains(query)
            || title_lower.contains(query)
            || value_lower.contains(query)
            || id_lower.contains(query)
        {
            return Some(node.clone());
        }
        for child in &node.children {
            if let Some(found) = find_in_tree(child, query) {
                return Some(found);
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsAXTree;

// ─── macOS ────────────────────────────────────────────────────────────────────

// Accessibility permission lives in the shared `ghost-permissions` crate (single
// source of truth across the desktop app, CLI, Core, and this sidecar).
// Re-exported so existing `ghost_eyes::accessibility_granted` call sites keep
// working.
pub use ghost_permissions::{accessibility_granted, request_accessibility};

#[cfg(target_os = "macos")]
mod macos_ax {
    use super::*;
    use std::ffi::{c_void, CStr};

    #[link(name = "ApplicationServices", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> *const c_void;
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: *mut *const c_void,
        ) -> i32;
        fn AXUIElementCopyElementAtPosition(
            application: *const c_void,
            x: f32,
            y: f32,
            element: *mut *const c_void,
        ) -> i32;
        fn CFRelease(cf: *const c_void);
        fn CFArrayGetCount(array: *const c_void) -> i64;
        fn CFArrayGetValueAtIndex(array: *const c_void, idx: i64) -> *const c_void;
        fn CFStringGetCStringPtr(s: *const c_void, encoding: u32) -> *const i8;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            cstr: *const i8,
            encoding: u32,
        ) -> *const c_void;
        fn AXValueGetValue(value: *const c_void, ax_type: i32, out: *mut c_void) -> bool;
        fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    }

    const UTF8: u32 = 0x08000100;
    const KAX_VALUE_TYPE_CGPOINT: i32 = 1;
    const KAX_VALUE_TYPE_CGSIZE: i32 = 2;

    unsafe fn cf_string(s: &str) -> *const c_void {
        let cstr = std::ffi::CString::new(s).unwrap_or_default();
        CFStringCreateWithCString(std::ptr::null(), cstr.as_ptr(), UTF8)
    }

    unsafe fn cf_to_string(cf: *const c_void) -> Option<String> {
        if cf.is_null() {
            return None;
        }
        let ptr = CFStringGetCStringPtr(cf, UTF8);
        if ptr.is_null() {
            return None;
        }
        CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_string())
    }

    unsafe fn ax_str(element: *const c_void, attr: &str) -> Option<String> {
        let attr_cf = cf_string(attr);
        let mut val: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, attr_cf, &mut val);
        CFRelease(attr_cf);
        if err != 0 || val.is_null() {
            return None;
        }
        let s = cf_to_string(val);
        CFRelease(val);
        s
    }

    unsafe fn ax_bool(element: *const c_void, attr: &str, default: bool) -> bool {
        let attr_cf = cf_string(attr);
        let mut val: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, attr_cf, &mut val);
        CFRelease(attr_cf);
        if err != 0 || val.is_null() {
            return default;
        }
        let result = CFBooleanGetValue(val);
        CFRelease(val);
        result
    }

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

    unsafe fn ax_bounds(element: *const c_void) -> Option<Bounds> {
        let pos_cf = cf_string("AXPosition");
        let mut pos_val: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, pos_cf, &mut pos_val);
        CFRelease(pos_cf);
        if err != 0 || pos_val.is_null() {
            return None;
        }
        let sz_cf = cf_string("AXSize");
        let mut sz_val: *const c_void = std::ptr::null();
        let err2 = AXUIElementCopyAttributeValue(element, sz_cf, &mut sz_val);
        CFRelease(sz_cf);
        if err2 != 0 || sz_val.is_null() {
            CFRelease(pos_val);
            return None;
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        let mut sz = CGSize {
            width: 0.0,
            height: 0.0,
        };
        AXValueGetValue(
            pos_val,
            KAX_VALUE_TYPE_CGPOINT,
            &mut pt as *mut _ as *mut c_void,
        );
        AXValueGetValue(
            sz_val,
            KAX_VALUE_TYPE_CGSIZE,
            &mut sz as *mut _ as *mut c_void,
        );
        CFRelease(pos_val);
        CFRelease(sz_val);
        Some(Bounds {
            x: pt.x as i32,
            y: pt.y as i32,
            width: sz.width as u32,
            height: sz.height as u32,
        })
    }

    pub unsafe fn walk_ax_element(
        element: *const c_void,
        depth: u32,
        max_depth: u32,
    ) -> AXTreeNode {
        let role = ax_str(element, "AXRole").unwrap_or_else(|| "AXUnknown".to_string());
        let title = ax_str(element, "AXTitle").or_else(|| ax_str(element, "AXDescription"));
        let value = ax_str(element, "AXValue");
        let identifier = ax_str(element, "AXIdentifier");
        let bounds = ax_bounds(element);
        let mut children = vec![];
        if depth < max_depth {
            let ch_cf = cf_string("AXChildren");
            let mut ch_val: *const c_void = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(element, ch_cf, &mut ch_val);
            CFRelease(ch_cf);
            if err == 0 && !ch_val.is_null() {
                let count = CFArrayGetCount(ch_val).min(100);
                for i in 0..count {
                    let child = CFArrayGetValueAtIndex(ch_val, i);
                    if !child.is_null() {
                        children.push(walk_ax_element(child, depth + 1, max_depth));
                    }
                }
                CFRelease(ch_val);
            }
        }
        let enabled = ax_bool(element, "AXEnabled", true);
        let focused = ax_bool(element, "AXFocused", false);
        AXTreeNode {
            role,
            title,
            value,
            identifier,
            bounds,
            children,
            enabled,
            focused,
            hidden: false,
        }
    }

    pub fn get_focused_tree_sync() -> Result<AXTreeNode> {
        use objc2::runtime::{AnyClass, AnyObject};
        unsafe {
            let ws_class = AnyClass::get("NSWorkspace")
                .ok_or_else(|| anyhow::anyhow!("NSWorkspace not found"))?;
            let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
            let app: *mut AnyObject = objc2::msg_send![workspace, frontmostApplication];
            let pid: i32 = objc2::msg_send![app, processIdentifier];
            if pid <= 0 {
                anyhow::bail!("No frontmost app");
            }
            let ax_app = AXUIElementCreateApplication(pid);
            if ax_app.is_null() {
                anyhow::bail!("AXUIElementCreateApplication failed");
            }
            let win_cf = cf_string("AXFocusedWindow");
            let mut win_val: *const c_void = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(ax_app, win_cf, &mut win_val);
            CFRelease(win_cf);
            CFRelease(ax_app);
            if err != 0 || win_val.is_null() {
                return Ok(AXTreeNode {
                    role: "AXApplication".to_string(),
                    title: None,
                    value: None,
                    identifier: None,
                    bounds: None,
                    children: vec![],
                    enabled: true,
                    focused: false,
                    hidden: false,
                });
            }
            let node = walk_ax_element(win_val, 0, 25);
            CFRelease(win_val);
            Ok(node)
        }
    }

    pub fn find_element_sync(description: &str) -> Option<AXTreeNode> {
        let tree = get_focused_tree_sync().ok()?;
        find_in_tree(&tree, &description.to_lowercase())
    }

    pub fn element_at_sync(x: i32, y: i32) -> Option<AXTreeNode> {
        unsafe {
            let sys = AXUIElementCreateSystemWide();
            if sys.is_null() {
                return None;
            }
            let mut el: *const c_void = std::ptr::null();
            let err = AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut el);
            CFRelease(sys);
            if err != 0 || el.is_null() {
                return None;
            }
            let node = walk_ax_element(el, 0, 1);
            CFRelease(el);
            Some(node)
        }
    }

    fn find_in_tree(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
        if node.role.to_lowercase().contains(query)
            || node
                .title
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(query)
            || node
                .value
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(query)
        {
            return Some(node.clone());
        }
        for child in &node.children {
            if let Some(found) = find_in_tree(child, query) {
                return Some(found);
            }
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::super::{AXTreeNode, Bounds};
        use super::find_in_tree;

        fn leaf(role: &str, title: Option<&str>, value: Option<&str>) -> AXTreeNode {
            AXTreeNode {
                role: role.to_string(),
                title: title.map(str::to_string),
                value: value.map(str::to_string),
                identifier: None,
                bounds: None,
                children: vec![],
                enabled: true,
                focused: false,
                hidden: false,
            }
        }

        #[test]
        fn matches_root_by_role() {
            let tree = leaf("AXButton", None, None);
            let found = find_in_tree(&tree, "axbutton").expect("role match");
            assert_eq!(found.role, "AXButton");
        }

        #[test]
        fn matches_nested_child_by_title() {
            let mut root = leaf("AXWindow", Some("Main"), None);
            root.children
                .push(leaf("AXStaticText", Some("Save Changes"), None));
            // query is lowercased by the caller before reaching find_in_tree.
            let found = find_in_tree(&root, "save changes").expect("nested title match");
            assert_eq!(found.role, "AXStaticText");
            assert_eq!(found.title.as_deref(), Some("Save Changes"));
        }

        #[test]
        fn matches_by_value() {
            let root = leaf("AXTextField", None, Some("hello@example.com"));
            let found = find_in_tree(&root, "example.com").expect("value match");
            assert_eq!(found.role, "AXTextField");
        }

        #[test]
        fn does_not_match_identifier_on_macos() {
            // macOS `find_in_tree` intentionally searches role/title/value only,
            // NOT identifier (unlike the Linux backend). Pin that difference.
            let mut node = leaf("AXGroup", None, None);
            node.identifier = Some("submit-btn".to_string());
            node.bounds = Some(Bounds {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            });
            assert!(find_in_tree(&node, "submit-btn").is_none());
        }

        #[test]
        fn returns_none_when_absent() {
            let mut root = leaf("AXWindow", Some("Editor"), None);
            root.children.push(leaf("AXButton", Some("OK"), None));
            root.children.push(leaf("AXButton", Some("Cancel"), None));
            assert!(find_in_tree(&root, "nonexistent-zzz").is_none());
        }

        #[test]
        fn returns_first_match_depth_first() {
            let mut root = leaf("AXWindow", Some("target-word"), None);
            root.children.push(leaf("AXButton", Some("target-word"), None));
            // Root matches first in a pre-order traversal.
            let found = find_in_tree(&root, "target-word").expect("match");
            assert_eq!(found.role, "AXWindow");
        }
    }
}

#[cfg(target_os = "macos")]
pub struct MacOSAXTree;

#[cfg(target_os = "macos")]
impl MacOSAXTree {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "macos")]
#[async_trait]
impl AXTree for MacOSAXTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        tokio::task::spawn_blocking(macos_ax::get_focused_tree_sync).await?
    }
    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        let desc = description.to_string();
        tokio::task::spawn_blocking(move || macos_ax::find_element_sync(&desc))
            .await
            .ok()
            .flatten()
    }
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
        tokio::task::spawn_blocking(move || macos_ax::element_at_sync(x, y))
            .await
            .ok()
            .flatten()
    }
    async fn list_apps(&self) -> Vec<serde_json::Value> {
        tokio::task::spawn_blocking(|| {
            use objc2::runtime::{AnyClass, AnyObject};
            unsafe {
                let ws_class = match AnyClass::get("NSWorkspace") {
                    Some(c) => c,
                    None => return vec![],
                };
                let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
                let apps: *mut AnyObject = objc2::msg_send![workspace, runningApplications];
                let count: usize = objc2::msg_send![apps, count];
                let mut result = vec![];
                for i in 0..count {
                    let app: *mut AnyObject = objc2::msg_send![apps, objectAtIndex: i];
                    let name_obj: *mut AnyObject = objc2::msg_send![app, localizedName];
                    if name_obj.is_null() {
                        continue;
                    }
                    let cptr: *const std::ffi::c_char = objc2::msg_send![name_obj, UTF8String];
                    if cptr.is_null() {
                        continue;
                    }
                    let name = std::ffi::CStr::from_ptr(cptr).to_string_lossy().to_string();
                    let pid: i32 = objc2::msg_send![app, processIdentifier];
                    result.push(serde_json::json!({ "name": name, "pid": pid }));
                }
                result
            }
        })
        .await
        .unwrap_or_default()
    }
}

// ─── Linux: AT-SPI2 (primary) with x11rb window geometry (fallback) ────────────
//
// AT-SPI2 is the Linux equivalent of macOS AXUIElement / Windows IUIAutomation: a
// D-Bus accessibility bus that toolkits (GTK, Qt, Electron, Firefox, Chromium) expose
// their element trees on. It is display-server-agnostic, so it works under both X11
// and Wayland. The catch is that the a11y bus is frequently disabled on a desktop —
// when `AccessibilityConnection::new()` fails we degrade to the x11rb path below,
// which still returns a single window-geometry node (the previous behaviour).
//
// Every AT-SPI property read is a D-Bus round trip, so the same depth (<=6) and
// sibling (<=100) caps the Windows/macOS backends use matter even more here.

#[cfg(target_os = "linux")]
pub struct LinuxAXTree;

#[cfg(target_os = "linux")]
impl LinuxAXTree {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl AXTree for LinuxAXTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        match linux_atspi::focused_tree().await {
            Ok(node) => Ok(node),
            Err(e) => {
                tracing::debug!("at-spi unavailable ({e}); falling back to x11 window geometry");
                tokio::task::spawn_blocking(linux_x11::get_tree).await?
            }
        }
    }
    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        let query = description.to_lowercase();
        let tree = self.get_focused_tree().await.ok()?;
        find_in_tree_linux(&tree, &query)
    }
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
        linux_atspi::element_at(x, y).await.ok().flatten()
    }
    async fn list_apps(&self) -> Vec<serde_json::Value> {
        linux_atspi::list_apps().await.unwrap_or_default()
    }
}

#[cfg(target_os = "linux")]
fn find_in_tree_linux(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
    if node.role.to_lowercase().contains(query)
        || node
            .title
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains(query)
        || node
            .value
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains(query)
        || node
            .identifier
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains(query)
    {
        return Some(node.clone());
    }
    for child in &node.children {
        if let Some(f) = find_in_tree_linux(child, query) {
            return Some(f);
        }
    }
    None
}

#[cfg(target_os = "linux")]
mod linux_atspi {
    use super::{AXTreeNode, Bounds};
    use anyhow::{anyhow, Result};
    use atspi::connection::AccessibilityConnection;
    use atspi::proxy::accessible::AccessibleProxy;
    use atspi::proxy::component::ComponentProxy;
    use atspi::zbus;
    use atspi::{CoordType, ObjectRefOwned, State};
    use std::future::Future;
    use std::pin::Pin;

    const ROOT_DEST: &str = "org.a11y.atspi.Registry";
    const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
    const MAX_DEPTH: u32 = 6;
    const MAX_CHILDREN: usize = 100;

    type NodeFuture<'a> = Pin<Box<dyn Future<Output = AXTreeNode> + Send + 'a>>;

    /// Build an `AccessibleProxy` for a given object reference (bus name + path).
    async fn accessible<'a>(
        conn: &'a zbus::Connection,
        obj: &ObjectRefOwned,
    ) -> Result<AccessibleProxy<'a>> {
        let name = obj
            .name()
            .ok_or_else(|| anyhow!("object ref missing bus name"))?
            .clone();
        let path = obj.path().clone();
        let proxy = AccessibleProxy::builder(conn)
            .destination(name)?
            .path(path)?
            .build()
            .await?;
        Ok(proxy)
    }

    /// The registry root whose children are the running accessible applications.
    async fn root(conn: &zbus::Connection) -> Result<AccessibleProxy<'_>> {
        let proxy = AccessibleProxy::builder(conn)
            .destination(ROOT_DEST)?
            .path(ROOT_PATH)?
            .build()
            .await?;
        Ok(proxy)
    }

    /// Find the active top-level window across all applications.
    async fn active_window(conn: &zbus::Connection) -> Result<ObjectRefOwned> {
        let root = root(conn).await?;
        for app in root.get_children().await? {
            let app_proxy = match accessible(conn, &app).await {
                Ok(p) => p,
                Err(_) => continue,
            };
            let windows = match app_proxy.get_children().await {
                Ok(w) => w,
                Err(_) => continue,
            };
            for win in windows {
                if let Ok(win_proxy) = accessible(conn, &win).await {
                    if let Ok(state) = win_proxy.get_state().await {
                        if state.contains(State::Active) {
                            return Ok(win);
                        }
                    }
                }
            }
        }
        Err(anyhow!("no active window found on the a11y bus"))
    }

    async fn bounds_of(conn: &zbus::Connection, obj: &ObjectRefOwned) -> Option<Bounds> {
        let name = obj.name()?.clone();
        let path = obj.path().clone();
        let component = ComponentProxy::builder(conn)
            .destination(name)
            .ok()?
            .path(path)
            .ok()?
            .build()
            .await
            .ok()?;
        let (x, y, w, h) = component.get_extents(CoordType::Screen).await.ok()?;
        Some(Bounds {
            x,
            y,
            width: w.unsigned_abs(),
            height: h.unsigned_abs(),
        })
    }

    fn walk<'a>(conn: &'a zbus::Connection, obj: ObjectRefOwned, depth: u32) -> NodeFuture<'a> {
        Box::pin(async move {
            let proxy = match accessible(conn, &obj).await {
                Ok(p) => p,
                Err(_) => return placeholder(),
            };
            let role = proxy
                .get_role()
                .await
                .map(|r| format!("{r:?}").to_lowercase())
                .unwrap_or_else(|_| "element".to_string());
            let title = proxy.name().await.ok().filter(|s| !s.is_empty());
            let identifier = proxy.accessible_id().await.ok().filter(|s| !s.is_empty());
            let state = proxy.get_state().await.unwrap_or_default();
            let enabled = state.contains(State::Enabled) || state.contains(State::Sensitive);
            let focused = state.contains(State::Focused);
            let hidden = !state.contains(State::Showing) || !state.contains(State::Visible);
            let bounds = bounds_of(conn, &obj).await;

            let mut children = vec![];
            if depth < MAX_DEPTH {
                if let Ok(kids) = proxy.get_children().await {
                    for kid in kids.into_iter().take(MAX_CHILDREN) {
                        children.push(walk(conn, kid, depth + 1).await);
                    }
                }
            }

            AXTreeNode {
                role,
                title,
                value: None,
                identifier,
                bounds,
                children,
                enabled,
                focused,
                hidden,
            }
        })
    }

    fn placeholder() -> AXTreeNode {
        AXTreeNode {
            role: "element".to_string(),
            title: None,
            value: None,
            identifier: None,
            bounds: None,
            children: vec![],
            enabled: true,
            focused: false,
            hidden: false,
        }
    }

    pub async fn focused_tree() -> Result<AXTreeNode> {
        let a11y = AccessibilityConnection::new().await?;
        let conn = a11y.connection();
        let window = active_window(conn).await?;
        Ok(walk(conn, window, 0).await)
    }

    pub async fn element_at(x: i32, y: i32) -> Result<Option<AXTreeNode>> {
        let a11y = AccessibilityConnection::new().await?;
        let conn = a11y.connection();
        let window = active_window(conn).await?;
        let name = window
            .name()
            .ok_or_else(|| anyhow!("active window missing bus name"))?
            .clone();
        let path = window.path().clone();
        let component = ComponentProxy::builder(conn)
            .destination(name)?
            .path(path)?
            .build()
            .await?;
        let hit = match component
            .get_accessible_at_point(x, y, CoordType::Screen)
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        Ok(Some(walk(conn, hit, MAX_DEPTH).await))
    }

    pub async fn list_apps() -> Result<Vec<serde_json::Value>> {
        let a11y = AccessibilityConnection::new().await?;
        let conn = a11y.connection();
        let root = root(conn).await?;
        let mut apps = vec![];
        for app in root.get_children().await? {
            let name = match accessible(conn, &app).await {
                Ok(p) => p.name().await.unwrap_or_default(),
                Err(_) => String::new(),
            };
            // AT-SPI's Accessible has no pid; resolving it needs the app bus name ->
            // GetConnectionUnixProcessID, which is not load-bearing for our callers.
            apps.push(serde_json::json!({ "name": name, "pid": 0 }));
        }
        Ok(apps)
    }
}

#[cfg(target_os = "linux")]
mod linux_x11 {
    use super::{AXTreeNode, Bounds};
    use anyhow::Result;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    use x11rb::rust_connection::RustConnection;

    pub fn get_tree() -> Result<AXTreeNode> {
        let (conn, sn) = RustConnection::connect(None).map_err(|e| anyhow::anyhow!("{}", e))?;
        let screen = &conn.setup().roots[sn];
        let root = screen.root;
        let active_atom = conn
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .reply()
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .atom;
        let prop = conn
            .get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1)
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .reply()
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        let win_id = prop.value32().and_then(|mut i| i.next()).unwrap_or(root);
        let name_atom = conn
            .intern_atom(false, b"_NET_WM_NAME")
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .reply()
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .atom;
        let utf8_atom = conn
            .intern_atom(false, b"UTF8_STRING")
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .reply()
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .atom;
        let title = conn
            .get_property(false, win_id, name_atom, utf8_atom, 0, 1024)
            .ok()
            .and_then(|r| r.reply().ok())
            .and_then(|p| String::from_utf8(p.value).ok())
            .filter(|s| !s.is_empty());
        let geom = conn.get_geometry(win_id).ok().and_then(|r| r.reply().ok());
        let bounds = geom.map(|g| Bounds {
            x: g.x as i32,
            y: g.y as i32,
            width: g.width as u32,
            height: g.height as u32,
        });
        Ok(AXTreeNode {
            role: "frame".to_string(),
            title,
            value: None,
            identifier: Some(format!("0x{:08x}", win_id)),
            bounds,
            children: vec![],
            enabled: true,
            focused: false,
            hidden: false,
        })
    }
}

// ─── Platform aliases ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub type PlatformAXTree = WindowsAXTree;
#[cfg(target_os = "macos")]
pub type PlatformAXTree = MacOSAXTree;
#[cfg(target_os = "linux")]
pub type PlatformAXTree = LinuxAXTree;

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_node() -> AXTreeNode {
        AXTreeNode {
            role: "AXWindow".to_string(),
            title: Some("Editor".to_string()),
            value: None,
            identifier: Some("win-1".to_string()),
            bounds: Some(Bounds {
                x: 10,
                y: -5,
                width: 800,
                height: 600,
            }),
            children: vec![AXTreeNode {
                role: "AXButton".to_string(),
                title: Some("Save".to_string()),
                value: Some("enabled".to_string()),
                identifier: None,
                bounds: None,
                children: vec![],
                enabled: true,
                focused: true,
                hidden: false,
            }],
            enabled: true,
            focused: false,
            hidden: false,
        }
    }

    #[test]
    fn bounds_equality_and_clone() {
        let a = Bounds {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        let b = a.clone();
        assert_eq!(a, b);
        let c = Bounds {
            x: 1,
            y: 2,
            width: 3,
            height: 5,
        };
        assert_ne!(a, c);
    }

    #[test]
    fn bounds_serde_roundtrip() {
        let b = Bounds {
            x: -100,
            y: 200,
            width: 1920,
            height: 1080,
        };
        let json = serde_json::to_string(&b).expect("serialize");
        let back: Bounds = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(b, back);
        // Field names are the wire contract consumers depend on.
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["x"], -100);
        assert_eq!(v["width"], 1920);
    }

    #[test]
    fn axtreenode_serde_roundtrip_preserves_tree() {
        let node = sample_node();
        let json = serde_json::to_string(&node).expect("serialize");
        let back: AXTreeNode = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.role, "AXWindow");
        assert_eq!(back.title.as_deref(), Some("Editor"));
        assert!(back.value.is_none());
        assert_eq!(back.identifier.as_deref(), Some("win-1"));
        assert_eq!(back.bounds.unwrap().width, 800);
        assert_eq!(back.children.len(), 1);
        let child = &back.children[0];
        assert_eq!(child.role, "AXButton");
        assert!(child.focused);
        assert!(child.bounds.is_none());
    }

    #[test]
    fn axtreenode_optional_fields_serialize_as_null() {
        let node = AXTreeNode {
            role: "AXUnknown".to_string(),
            title: None,
            value: None,
            identifier: None,
            bounds: None,
            children: vec![],
            enabled: false,
            focused: false,
            hidden: true,
        };
        let v = serde_json::to_value(&node).unwrap();
        assert!(v["title"].is_null());
        assert!(v["bounds"].is_null());
        assert_eq!(v["enabled"], false);
        assert_eq!(v["hidden"], true);
        assert!(v["children"].as_array().unwrap().is_empty());
    }

    #[cfg(target_os = "macos")]
    fn rt() -> tokio::runtime::Runtime {
        // The crate does not enable tokio's `macros` feature, so build a
        // current-thread runtime by hand. `spawn_blocking` (used by the impls)
        // is available on it without `rt-multi-thread`.
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_axtree_new_ok() {
        assert!(MacOSAXTree::new().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_list_apps_shape() {
        // Reads NSWorkspace.runningApplications — not TCC-gated, no prompt.
        let tree = MacOSAXTree::new().unwrap();
        let apps = rt().block_on(async { tree.list_apps().await });
        // May be empty in a headless session; when populated every entry must
        // carry the {name, pid} contract callers serialize over the wire.
        for app in &apps {
            assert!(app.get("name").is_some(), "app missing name: {app}");
            assert!(app.get("pid").is_some(), "app missing pid: {app}");
            assert!(app["name"].is_string());
            assert!(app["pid"].is_i64() || app["pid"].is_u64());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_element_at_does_not_panic() {
        // `element_at` runs `walk_element`/`walk_ax_element` at depth 0..1 only —
        // bounded, and a plain AX query returns an error (never a TCC prompt)
        // when Accessibility is not granted. Some or None are both valid.
        let tree = MacOSAXTree::new().unwrap();
        let node = rt().block_on(async { tree.element_at(0, 0).await });
        if let Some(n) = node {
            assert!(!n.role.is_empty(), "a returned node must carry a role");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn accessibility_granted_returns_without_prompt() {
        // Pure checker (no kAXTrustedCheckOptionPrompt) — safe to call.
        let _granted: bool = accessibility_granted();
    }
}
