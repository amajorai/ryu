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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    }

    fn get_focused_tree_sync() -> Result<AXTreeNode> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;

            let hwnd = GetForegroundWindow();
            let root = automation.ElementFromHandle(hwnd)?;
            let node = walk_element(&root, 0)?;

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

            // Walk the tree and search by text content
            let tree = walk_element(&root, 3).ok()?;
            CoUninitialize();
            find_in_tree(&tree, &description.to_lowercase())
        }
    }

    unsafe fn walk_element(element: &IUIAutomationElement, depth: u32) -> Result<AXTreeNode> {
        if depth > 5 {
            return Ok(AXTreeNode {
                role: "...".to_string(),
                title: None,
                value: None,
                identifier: None,
                bounds: None,
                children: vec![],
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

        // Walk children
        let mut children = vec![];
        if depth < 4 {
            // Use TreeWalker for children
            let automation_result: windows::core::Result<IUIAutomation> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER);
            if let Ok(automation) = automation_result {
                if let Ok(walker) = automation.ControlViewWalker() {
                    if let Ok(child) = walker.GetFirstChildElement(element) {
                        let mut current = child;
                        loop {
                            if let Ok(node) = walk_element(&current, depth + 1) {
                                children.push(node);
                            }
                            match walker.GetNextSiblingElement(&current) {
                                Ok(next) => current = next,
                                Err(_) => break,
                            }
                            if children.len() >= 50 {
                                break; // Cap to avoid huge trees
                            }
                        }
                    }
                }
            }
        }

        Ok(AXTreeNode {
            role,
            title,
            value,
            identifier,
            bounds,
            children,
        })
    }

    fn find_in_tree(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
        let role_lower = node.role.to_lowercase();
        let title_lower = node.title.as_deref().unwrap_or("").to_lowercase();
        let value_lower = node.value.as_deref().unwrap_or("").to_lowercase();

        if role_lower.contains(query) || title_lower.contains(query) || value_lower.contains(query)
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

// ─── macOS: AXUIElement ──────────────────────────────────────────────────────

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
        ) -> i32; // AXError
        fn AXUIElementCopyAttributeNames(element: *const c_void, names: *mut *const c_void) -> i32;
        fn AXUIElementCopyAttributeValues(
            element: *const c_void,
            attribute: *const c_void,
            index: i64,
            max_values: i64,
            values: *mut *const c_void,
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
    }

    const KCF_STRING_ENCODING_UTF8: u32 = 0x08000100;
    // AXValueType for CGRect is 3
    const KAX_VALUE_TYPE_CGPOINT: i32 = 1;
    const KAX_VALUE_TYPE_CGSIZE: i32 = 2;

    unsafe fn cf_string(s: &str) -> *const c_void {
        let cstr = std::ffi::CString::new(s).unwrap_or_default();
        CFStringCreateWithCString(std::ptr::null(), cstr.as_ptr(), KCF_STRING_ENCODING_UTF8)
    }

    unsafe fn cf_to_string(cf: *const c_void) -> Option<String> {
        if cf.is_null() {
            return None;
        }
        let ptr = CFStringGetCStringPtr(cf, KCF_STRING_ENCODING_UTF8);
        if ptr.is_null() {
            return None;
        }
        CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_string())
    }

    unsafe fn ax_string_attr(element: *const c_void, attr: &str) -> Option<String> {
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

    unsafe fn walk_ax_element(element: *const c_void, depth: u32) -> AXTreeNode {
        let role = ax_string_attr(element, "AXRole").unwrap_or_else(|| "AXUnknown".to_string());
        let title =
            ax_string_attr(element, "AXTitle").or_else(|| ax_string_attr(element, "AXDescription"));
        let value = ax_string_attr(element, "AXValue");
        let identifier = ax_string_attr(element, "AXIdentifier");
        let bounds = ax_bounds(element);

        let mut children = vec![];
        if depth < 4 {
            let ch_cf = cf_string("AXChildren");
            let mut ch_val: *const c_void = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(element, ch_cf, &mut ch_val);
            CFRelease(ch_cf);
            if err == 0 && !ch_val.is_null() {
                let count = CFArrayGetCount(ch_val).min(40);
                for i in 0..count {
                    let child = CFArrayGetValueAtIndex(ch_val, i);
                    if !child.is_null() {
                        children.push(walk_ax_element(child, depth + 1));
                    }
                }
                CFRelease(ch_val);
            }
        }

        AXTreeNode {
            role,
            title,
            value,
            identifier,
            bounds,
            children,
        }
    }

    pub fn get_focused_tree_sync() -> Result<AXTreeNode> {
        use objc2::runtime::AnyClass;
        use objc2::runtime::AnyObject;

        unsafe {
            let ws_class = AnyClass::get(c"NSWorkspace")
                .ok_or_else(|| anyhow::anyhow!("NSWorkspace not found"))?;
            let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
            let app: *mut AnyObject = objc2::msg_send![workspace, frontmostApplication];
            let pid: i32 = objc2::msg_send![app, processIdentifier];
            if pid <= 0 {
                anyhow::bail!("No frontmost application");
            }

            let ax_app = AXUIElementCreateApplication(pid);
            if ax_app.is_null() {
                anyhow::bail!("AXUIElementCreateApplication failed for pid {}", pid);
            }

            let win_cf = cf_string("AXFocusedWindow");
            let mut win_val: *const c_void = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(ax_app, win_cf, &mut win_val);
            CFRelease(win_cf);
            CFRelease(ax_app);

            if err != 0 || win_val.is_null() {
                // Return app-level tree if no focused window
                return Ok(AXTreeNode {
                    role: "AXApplication".to_string(),
                    title: None,
                    value: None,
                    identifier: None,
                    bounds: None,
                    children: vec![],
                });
            }

            let node = walk_ax_element(win_val, 0);
            CFRelease(win_val);
            Ok(node)
        }
    }

    pub fn find_element_sync(description: &str) -> Option<AXTreeNode> {
        let tree = get_focused_tree_sync().ok()?;
        find_in_tree(&tree, &description.to_lowercase())
    }

    fn find_in_tree(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
        let role_lc = node.role.to_lowercase();
        let title_lc = node.title.as_deref().unwrap_or("").to_lowercase();
        let value_lc = node.value.as_deref().unwrap_or("").to_lowercase();
        if role_lc.contains(query) || title_lc.contains(query) || value_lc.contains(query) {
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
}

// ─── Linux: x11rb _NET_WM_NAME + _NET_CLIENT_LIST ────────────────────────────

#[cfg(target_os = "linux")]
mod linux_ax {
    use super::*;

    pub fn get_focused_tree_sync() -> Result<AXTreeNode> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
        use x11rb::rust_connection::RustConnection;

        let (conn, screen_num) = RustConnection::connect(None)?;
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;

        // Get active window via _NET_ACTIVE_WINDOW
        let active_atom = conn
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")?
            .reply()?
            .atom;
        let prop = conn
            .get_property(false, root, active_atom, AtomEnum::WINDOW, 0, 1)?
            .reply()?;
        let win_id = prop.value32().and_then(|mut i| i.next()).unwrap_or(root);

        // Window title
        let name_atom = conn.intern_atom(false, b"_NET_WM_NAME")?.reply()?.atom;
        let utf8_atom = conn.intern_atom(false, b"UTF8_STRING")?.reply()?.atom;
        let title = conn
            .get_property(false, win_id, name_atom, utf8_atom, 0, 1024)?
            .reply()
            .ok()
            .and_then(|p| String::from_utf8(p.value).ok())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                conn.get_property(
                    false,
                    win_id,
                    AtomEnum::WM_NAME.into(),
                    AtomEnum::STRING.into(),
                    0,
                    1024,
                )
                .ok()
                .and_then(|r| r.reply().ok())
                .and_then(|p| String::from_utf8(p.value).ok())
                .filter(|s| !s.is_empty())
            });

        // Window geometry
        let geom = conn.get_geometry(win_id).ok().and_then(|r| r.reply().ok());
        let bounds = geom.map(|g| Bounds {
            x: g.x as i32,
            y: g.y as i32,
            width: g.width as u32,
            height: g.height as u32,
        });

        // Enumerate child windows up to 2 levels for basic tree
        let children = get_children(&conn, win_id, 1);

        Ok(AXTreeNode {
            role: "frame".to_string(),
            title,
            value: None,
            identifier: Some(format!("0x{:08x}", win_id)),
            bounds,
            children,
        })
    }

    fn get_children(
        conn: &x11rb::rust_connection::RustConnection,
        parent: u32,
        depth: u32,
    ) -> Vec<AXTreeNode> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

        if depth > 2 {
            return vec![];
        }
        let Ok(tree) = conn
            .query_tree(parent)
            .and_then(|r| r.reply().map_err(Into::into))
        else {
            return vec![];
        };

        let name_atom = conn
            .intern_atom(false, b"_NET_WM_NAME")
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.atom)
            .unwrap_or(0);
        let utf8_atom = conn
            .intern_atom(false, b"UTF8_STRING")
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.atom)
            .unwrap_or(0);

        tree.children
            .iter()
            .take(20)
            .filter_map(|&win| {
                // Skip windows without a name
                let title = if name_atom > 0 && utf8_atom > 0 {
                    conn.get_property(false, win, name_atom, utf8_atom, 0, 256)
                        .ok()
                        .and_then(|c| c.reply().ok())
                        .and_then(|p| String::from_utf8(p.value).ok())
                        .filter(|s| !s.is_empty())
                } else {
                    None
                };

                let geom = conn.get_geometry(win).ok().and_then(|r| r.reply().ok());
                let bounds = geom.map(|g| Bounds {
                    x: g.x as i32,
                    y: g.y as i32,
                    width: g.width as u32,
                    height: g.height as u32,
                });

                Some(AXTreeNode {
                    role: "window".to_string(),
                    title,
                    value: None,
                    identifier: Some(format!("0x{:08x}", win)),
                    bounds,
                    children: get_children(conn, win, depth + 1),
                })
            })
            .collect()
    }

    pub fn find_element_sync(description: &str) -> Option<AXTreeNode> {
        let tree = get_focused_tree_sync().ok()?;
        find_in_tree(&tree, &description.to_lowercase())
    }

    fn find_in_tree(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
        let title_lc = node.title.as_deref().unwrap_or("").to_lowercase();
        let value_lc = node.value.as_deref().unwrap_or("").to_lowercase();
        if title_lc.contains(query) || value_lc.contains(query) || node.role.contains(query) {
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

// ─── Linux: AT-SPI2 (primary, full element tree) ──────────────────────────────
//
// AT-SPI2 is the Linux equivalent of macOS AXUIElement / Windows IUIAutomation: a
// D-Bus accessibility bus that GTK/Qt/Electron/Firefox/Chromium publish their element
// trees on, under both X11 and Wayland. When the a11y bus is disabled (common) we
// fall back to the x11 window-enumeration tree in `linux_ax` above. Every property
// read is a D-Bus round trip, so depth (<=6) and sibling (<=100) caps are enforced.

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

    async fn accessible<'a>(
        conn: &'a zbus::Connection,
        obj: &ObjectRefOwned,
    ) -> Result<AccessibleProxy<'a>> {
        let name = obj.name().ok_or_else(|| anyhow!("object ref missing bus name"))?.clone();
        let path = obj.path().clone();
        Ok(AccessibleProxy::builder(conn)
            .destination(name)?
            .path(path)?
            .build()
            .await?)
    }

    async fn root(conn: &zbus::Connection) -> Result<AccessibleProxy<'_>> {
        Ok(AccessibleProxy::builder(conn)
            .destination(ROOT_DEST)?
            .path(ROOT_PATH)?
            .build()
            .await?)
    }

    async fn active_window(conn: &zbus::Connection) -> Result<ObjectRefOwned> {
        let root = root(conn).await?;
        for app in root.get_children().await? {
            let Ok(app_proxy) = accessible(conn, &app).await else { continue };
            let Ok(windows) = app_proxy.get_children().await else { continue };
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
        Some(Bounds { x, y, width: w.unsigned_abs(), height: h.unsigned_abs() })
    }

    fn walk<'a>(conn: &'a zbus::Connection, obj: ObjectRefOwned, depth: u32) -> NodeFuture<'a> {
        Box::pin(async move {
            let Ok(proxy) = accessible(conn, &obj).await else { return placeholder() };
            let role = proxy
                .get_role()
                .await
                .map(|r| format!("{r:?}").to_lowercase())
                .unwrap_or_else(|_| "element".to_string());
            let title = proxy.name().await.ok().filter(|s| !s.is_empty());
            let identifier = proxy.accessible_id().await.ok().filter(|s| !s.is_empty());
            let bounds = bounds_of(conn, &obj).await;

            let mut children = vec![];
            if depth < MAX_DEPTH {
                if let Ok(kids) = proxy.get_children().await {
                    for kid in kids.into_iter().take(MAX_CHILDREN) {
                        children.push(walk(conn, kid, depth + 1).await);
                    }
                }
            }

            AXTreeNode { role, title, value: None, identifier, bounds, children }
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
        }
    }

    pub async fn focused_tree() -> Result<AXTreeNode> {
        let a11y = AccessibilityConnection::new().await?;
        let conn = a11y.connection();
        let window = active_window(conn).await?;
        Ok(walk(conn, window, 0).await)
    }
}

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
                tracing::debug!("at-spi unavailable ({e}); falling back to x11 window tree");
                tokio::task::spawn_blocking(linux_ax::get_focused_tree_sync).await?
            }
        }
    }

    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        let query = description.to_lowercase();
        let tree = self.get_focused_tree().await.ok()?;
        find_in_tree_linux(&tree, &query)
    }
}

#[cfg(target_os = "linux")]
fn find_in_tree_linux(node: &AXTreeNode, query: &str) -> Option<AXTreeNode> {
    if node.role.to_lowercase().contains(query)
        || node.title.as_deref().unwrap_or("").to_lowercase().contains(query)
        || node.value.as_deref().unwrap_or("").to_lowercase().contains(query)
        || node.identifier.as_deref().unwrap_or("").to_lowercase().contains(query)
    {
        return Some(node.clone());
    }
    for child in &node.children {
        if let Some(found) = find_in_tree_linux(child, query) {
            return Some(found);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub type PlatformAXTree = WindowsAXTree;
#[cfg(target_os = "macos")]
pub type PlatformAXTree = MacOSAXTree;
#[cfg(target_os = "linux")]
pub type PlatformAXTree = LinuxAXTree;
