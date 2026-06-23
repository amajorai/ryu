// Input monitoring — platform hooks for keyboard/mouse events.
// Returns events via an UnboundedReceiver; no dependency on shadow_core.

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc::UnboundedReceiver;

/// Raw input event.
#[derive(Debug, Clone)]
pub enum InputEvent {
    KeyDown   { vk_code: u32 },
    KeyUp     { vk_code: u32 },
    MouseDown { x: i32, y: i32, button: u8 },
    MouseUp   { x: i32, y: i32, button: u8 },
    MouseMove { x: i32, y: i32 },
    Scroll    { x: i32, y: i32, delta_x: i32, delta_y: i32 },
}

/// Input monitor trait — start/stop global hooks.
#[async_trait]
pub trait InputMonitor: Send + Sync {
    /// Install global hooks. Returns a receiver for incoming events.
    async fn start(&mut self) -> Result<UnboundedReceiver<InputEvent>>;
    async fn stop(&mut self) -> Result<()>;
}

// ─── Windows: SetWindowsHookEx ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use windows::Win32::Foundation::{LRESULT, WPARAM, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static INPUT_TX: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<InputEvent>>> = OnceLock::new();

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let event = if wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN {
                InputEvent::KeyDown { vk_code: kb.vkCode }
            } else {
                InputEvent::KeyUp { vk_code: kb.vkCode }
            };
            if let Some(tx) = INPUT_TX.get() { if let Ok(tx) = tx.lock() { let _ = tx.send(event); } }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let x = ms.pt.x; let y = ms.pt.y;
            let event = match wparam.0 as u32 {
                WM_LBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 0 }),
                WM_RBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 1 }),
                WM_MBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 2 }),
                WM_LBUTTONUP   => Some(InputEvent::MouseUp   { x, y, button: 0 }),
                WM_RBUTTONUP   => Some(InputEvent::MouseUp   { x, y, button: 1 }),
                WM_MBUTTONUP   => Some(InputEvent::MouseUp   { x, y, button: 2 }),
                WM_MOUSEMOVE => {
                    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                    let packed = ((x as u32 as u64) << 32) | (y as u32 as u64);
                    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
                    let lx = (last >> 32) as i32; let ly = (last & 0xFFFF_FFFF) as i32;
                    if ((x - lx).pow(2) + (y - ly).pow(2)) < 2500 { None } else {
                        LAST.store(packed, std::sync::atomic::Ordering::Relaxed);
                        Some(InputEvent::MouseMove { x, y })
                    }
                }
                WM_MOUSEWHEEL => {
                    let delta = ((ms.mouseData >> 16) as i16) as i32;
                    Some(InputEvent::Scroll { x, y, delta_x: 0, delta_y: delta })
                }
                WM_MOUSEHWHEEL => {
                    let delta = ((ms.mouseData >> 16) as i16) as i32;
                    Some(InputEvent::Scroll { x, y, delta_x: delta, delta_y: 0 })
                }
                _ => None,
            };
            if let Some(ev) = event { if let Some(tx) = INPUT_TX.get() { if let Ok(tx) = tx.lock() { let _ = tx.send(ev); } } }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub struct WindowsInputMonitor { stop_tx: Option<tokio::sync::oneshot::Sender<()>> }
    impl WindowsInputMonitor { pub fn new() -> Result<Self> { Ok(Self { stop_tx: None }) } }

    #[async_trait]
    impl InputMonitor for WindowsInputMonitor {
        async fn start(&mut self) -> Result<UnboundedReceiver<InputEvent>> {
            let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
            let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
            INPUT_TX.get_or_init(|| Mutex::new(event_tx));
            std::thread::spawn(|| unsafe {
                let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0).expect("keyboard hook");
                let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0).expect("mouse hook");
                let mut msg = MSG::default();
                loop {
                    let ret = GetMessageW(&mut msg, None, 0, 0);
                    if ret.0 == 0 || ret.0 == -1 { break; }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWindowsHookEx(kb_hook);
                let _ = UnhookWindowsHookEx(mouse_hook);
            });
            self.stop_tx = Some(stop_tx);
            Ok(event_rx)
        }

        async fn stop(&mut self) -> Result<()> {
            if let Some(tx) = self.stop_tx.take() { let _ = tx.send(()); }
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsInputMonitor;

// ─── macOS: CGEventTap ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    static INPUT_TX: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<InputEvent>>> = OnceLock::new();

    const KCG_EVENT_LEFT_MOUSE_DOWN:  u32 = 1;  const KCG_EVENT_LEFT_MOUSE_UP:    u32 = 2;
    const KCG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;  const KCG_EVENT_RIGHT_MOUSE_UP:   u32 = 4;
    const KCG_EVENT_MOUSE_MOVED:      u32 = 5;  const KCG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
    const KCG_EVENT_OTHER_MOUSE_UP:   u32 = 26; const KCG_EVENT_KEY_DOWN:         u32 = 10;
    const KCG_EVENT_KEY_UP:           u32 = 11; const KCG_EVENT_SCROLL_WHEEL:     u32 = 22;
    const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;  const KCG_MOUSE_EVENT_BUTTON:     u32 = 71;
    const KCG_SCROLL_DELTA_AXIS_1:    u32 = 96; const KCG_SCROLL_DELTA_AXIS_2:    u32 = 97;
    const KCG_SESSION_EVENT_TAP:      u32 = 1;  const KCG_HEAD_INSERT:            u32 = 0;
    const KCG_LISTEN_ONLY:            u32 = 1;

    #[repr(C)] struct CGPoint { x: f64, y: f64 }
    extern "C" {
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CGEventGetIntegerValueField(event: *const c_void, field: u32) -> i64;
        fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: extern "C" fn(*const c_void, u32, *const c_void, *const c_void) -> *const c_void, info: *const c_void) -> *const c_void;
        fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *const c_void, order: isize) -> *const c_void;
        fn CFRunLoopGetCurrent() -> *const c_void;
        fn CFRunLoopAddSource(rl: *const c_void, source: *const c_void, mode: *const c_void);
        fn CFRunLoopRun();
        fn CGEventTapEnable(tap: *const c_void, enable: bool);
        static kCFRunLoopCommonModes: *const c_void;
    }

    extern "C" fn tap_cb(_proxy: *const c_void, etype: u32, event: *const c_void, _info: *const c_void) -> *const c_void {
        unsafe {
            let pt = CGEventGetLocation(event);
            let x = pt.x as i32; let y = pt.y as i32;
            let ev = match etype {
                t if t == KCG_EVENT_KEY_DOWN => { let kc = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) as u32; Some(InputEvent::KeyDown { vk_code: kc }) }
                t if t == KCG_EVENT_KEY_UP   => { let kc = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) as u32; Some(InputEvent::KeyUp { vk_code: kc }) }
                t if t == KCG_EVENT_LEFT_MOUSE_DOWN  => Some(InputEvent::MouseDown { x, y, button: 0 }),
                t if t == KCG_EVENT_LEFT_MOUSE_UP    => Some(InputEvent::MouseUp   { x, y, button: 0 }),
                t if t == KCG_EVENT_RIGHT_MOUSE_DOWN => Some(InputEvent::MouseDown { x, y, button: 1 }),
                t if t == KCG_EVENT_RIGHT_MOUSE_UP   => Some(InputEvent::MouseUp   { x, y, button: 1 }),
                t if t == KCG_EVENT_OTHER_MOUSE_DOWN => { let btn = CGEventGetIntegerValueField(event, KCG_MOUSE_EVENT_BUTTON) as u8; Some(InputEvent::MouseDown { x, y, button: btn }) }
                t if t == KCG_EVENT_OTHER_MOUSE_UP   => { let btn = CGEventGetIntegerValueField(event, KCG_MOUSE_EVENT_BUTTON) as u8; Some(InputEvent::MouseUp { x, y, button: btn }) }
                t if t == KCG_EVENT_MOUSE_MOVED => {
                    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                    let packed = ((x as u32 as u64) << 32) | (y as u32 as u64);
                    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
                    if ((x - (last >> 32) as i32).pow(2) + (y - (last & 0xFFFF_FFFF) as i32).pow(2)) < 2500 { None } else { LAST.store(packed, std::sync::atomic::Ordering::Relaxed); Some(InputEvent::MouseMove { x, y }) }
                }
                t if t == KCG_EVENT_SCROLL_WHEEL => {
                    let dy = CGEventGetIntegerValueField(event, KCG_SCROLL_DELTA_AXIS_1) as i32;
                    let dx = CGEventGetIntegerValueField(event, KCG_SCROLL_DELTA_AXIS_2) as i32;
                    Some(InputEvent::Scroll { x, y, delta_x: dx, delta_y: dy })
                }
                _ => None,
            };
            if let Some(e) = ev { if let Some(tx) = INPUT_TX.get() { if let Ok(g) = tx.lock() { let _ = g.send(e); } } }
        }
        event
    }

    pub struct MacOSInputMonitor { stop_tx: Option<tokio::sync::oneshot::Sender<()>> }
    impl MacOSInputMonitor { pub fn new() -> Result<Self> { Ok(Self { stop_tx: None }) } }

    #[async_trait]
    impl InputMonitor for MacOSInputMonitor {
        async fn start(&mut self) -> Result<UnboundedReceiver<InputEvent>> {
            let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
            let (stop_tx, _stop_rx) = tokio::sync::oneshot::channel::<()>();
            INPUT_TX.get_or_init(|| Mutex::new(event_tx));
            std::thread::spawn(|| unsafe {
                let mask: u64 = (1u64 << KCG_EVENT_KEY_DOWN) | (1 << KCG_EVENT_KEY_UP) | (1 << KCG_EVENT_LEFT_MOUSE_DOWN) | (1 << KCG_EVENT_LEFT_MOUSE_UP) | (1 << KCG_EVENT_RIGHT_MOUSE_DOWN) | (1 << KCG_EVENT_RIGHT_MOUSE_UP) | (1 << KCG_EVENT_OTHER_MOUSE_DOWN) | (1 << KCG_EVENT_OTHER_MOUSE_UP) | (1 << KCG_EVENT_MOUSE_MOVED) | (1 << KCG_EVENT_SCROLL_WHEEL);
                let tap = CGEventTapCreate(KCG_SESSION_EVENT_TAP, KCG_HEAD_INSERT, KCG_LISTEN_ONLY, mask, tap_cb, std::ptr::null());
                if tap.is_null() { tracing::warn!("CGEventTapCreate failed — grant Accessibility permission"); return; }
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                CFRunLoopRun();
            });
            self.stop_tx = Some(stop_tx);
            Ok(event_rx)
        }
        async fn stop(&mut self) -> Result<()> {
            if let Some(tx) = self.stop_tx.take() { let _ = tx.send(()); }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos_impl::MacOSInputMonitor;

// ─── Linux: evdev ─────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub struct LinuxInputMonitor { stop_tx: Option<tokio::sync::oneshot::Sender<()>> }
#[cfg(target_os = "linux")]
impl LinuxInputMonitor { pub fn new() -> Result<Self> { Ok(Self { stop_tx: None }) } }

#[cfg(target_os = "linux")]
#[async_trait]
impl InputMonitor for LinuxInputMonitor {
    async fn start(&mut self) -> Result<UnboundedReceiver<InputEvent>> {
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (stop_tx, _stop_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::task::spawn_blocking(move || {
            use evdev::{Device, EventType, Key};
            for path in std::fs::read_dir("/dev/input").into_iter().flatten().flatten() {
                if let Ok(mut device) = Device::open(&path.path()) {
                    if device.supported_keys().map(|k| k.contains(Key::KEY_A)).unwrap_or(false) {
                        loop { match device.fetch_events() { Ok(_) => {}, Err(_) => break } }
                    }
                }
            }
        });
        self.stop_tx = Some(stop_tx);
        Ok(event_rx)
    }
    async fn stop(&mut self) -> Result<()> { if let Some(tx) = self.stop_tx.take() { let _ = tx.send(()); } Ok(()) }
}

// ─── Platform aliases ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub type PlatformInputMonitor = WindowsInputMonitor;
#[cfg(target_os = "macos")]
pub type PlatformInputMonitor = MacOSInputMonitor;
#[cfg(target_os = "linux")]
pub type PlatformInputMonitor = LinuxInputMonitor;
