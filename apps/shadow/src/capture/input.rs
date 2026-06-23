use anyhow::Result;
use async_trait::async_trait;

/// Input event types.
#[derive(Debug, Clone)]
pub enum InputEvent {
    KeyDown { vk_code: u32 },
    KeyUp { vk_code: u32 },
    MouseDown { x: i32, y: i32, button: u8 },
    MouseUp { x: i32, y: i32, button: u8 },
    MouseMove { x: i32, y: i32 },
}

/// Input monitor trait — platform-specific implementations.
#[async_trait]
pub trait InputMonitor: Send + Sync {
    async fn start(&mut self) -> Result<()>;
    async fn stop(&mut self) -> Result<()>;
}

// ─── Windows: SetWindowsHookEx (WH_KEYBOARD_LL + WH_MOUSE_LL) ────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static INPUT_TX: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<InputEvent>>> =
        OnceLock::new();

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let event = if wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN {
                InputEvent::KeyDown { vk_code: kb.vkCode }
            } else {
                InputEvent::KeyUp { vk_code: kb.vkCode }
            };
            if let Some(tx) = INPUT_TX.get() {
                if let Ok(tx) = tx.lock() {
                    let _ = tx.send(event);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let x = ms.pt.x;
            let y = ms.pt.y;

            let event = match wparam.0 as u32 {
                WM_LBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 0 }),
                WM_RBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 1 }),
                WM_MBUTTONDOWN => Some(InputEvent::MouseDown { x, y, button: 2 }),
                WM_LBUTTONUP => Some(InputEvent::MouseUp { x, y, button: 0 }),
                WM_RBUTTONUP => Some(InputEvent::MouseUp { x, y, button: 1 }),
                WM_MBUTTONUP => Some(InputEvent::MouseUp { x, y, button: 2 }),
                WM_MOUSEMOVE => {
                    // Throttle mouse moves: only emit every ~50 pixels
                    static LAST_POS: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let packed = ((x as u32 as u64) << 32) | (y as u32 as u64);
                    let last = LAST_POS.load(std::sync::atomic::Ordering::Relaxed);
                    let lx = (last >> 32) as i32;
                    let ly = (last & 0xFFFF_FFFF) as i32;
                    let dist = ((x - lx).pow(2) + (y - ly).pow(2)) as f64;
                    if dist < 2500.0 {
                        // < 50px
                        None
                    } else {
                        LAST_POS.store(packed, std::sync::atomic::Ordering::Relaxed);
                        Some(InputEvent::MouseMove { x, y })
                    }
                }
                _ => None,
            };

            if let Some(ev) = event {
                if let Some(tx) = INPUT_TX.get() {
                    if let Ok(tx) = tx.lock() {
                        let _ = tx.send(ev);
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub struct WindowsInputMonitor {
        stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl WindowsInputMonitor {
        pub fn new() -> Result<Self> {
            Ok(Self { stop_tx: None })
        }
    }

    #[async_trait]
    impl super::InputMonitor for WindowsInputMonitor {
        async fn start(&mut self) -> Result<()> {
            let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<InputEvent>();
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();

            // Store the sender globally for the hook callbacks
            INPUT_TX.get_or_init(|| Mutex::new(event_tx));

            // Spawn hook thread (must have a message loop)
            std::thread::spawn(|| {
                unsafe {
                    let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0)
                        .expect("Failed to install keyboard hook");

                    let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0)
                        .expect("Failed to install mouse hook");

                    // Message loop — required for low-level hooks
                    let mut msg = MSG::default();
                    loop {
                        let ret = GetMessageW(&mut msg, None, 0, 0);
                        if ret.0 == 0 || ret.0 == -1 {
                            break;
                        }
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }

                    let _ = UnhookWindowsHookEx(kb_hook);
                    let _ = UnhookWindowsHookEx(mouse_hook);
                }
            });

            // Spawn event processing task
            tokio::spawn(async move {
                let mut stop = stop_rx;
                loop {
                    tokio::select! {
                        event = event_rx.recv() => {
                            match event {
                                Some(ev) => {
                                    // Ingest event into shadow-core
                                    ingest_input_event(ev);
                                }
                                None => break,
                            }
                        }
                        _ = &mut stop => break,
                    }
                }
            });

            self.stop_tx = Some(stop_tx);
            tracing::info!("Windows input monitor started (WH_KEYBOARD_LL + WH_MOUSE_LL)");
            Ok(())
        }

        async fn stop(&mut self) -> Result<()> {
            if let Some(tx) = self.stop_tx.take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    fn ingest_input_event(event: InputEvent) {
        use std::collections::HashMap;

        let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;

        map.insert("ts", rmpv::Value::from(now_us));
        map.insert("v", rmpv::Value::from(2u8));

        match event {
            InputEvent::KeyDown { vk_code } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("key_down"));
                map.insert("key_code", rmpv::Value::from(vk_code));
            }
            InputEvent::KeyUp { vk_code } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("key_up"));
                map.insert("key_code", rmpv::Value::from(vk_code));
            }
            InputEvent::MouseDown { x, y, button } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_down"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
                map.insert("button", rmpv::Value::from(button));
            }
            InputEvent::MouseUp { x, y, button } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_up"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
                map.insert("button", rmpv::Value::from(button));
            }
            InputEvent::MouseMove { x, y } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_move"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
            }
        }

        if let Ok(data) = rmp_serde::to_vec(&map) {
            let _ = shadow_core::write_event(data);
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

    static INPUT_TX: OnceLock<Mutex<tokio::sync::mpsc::UnboundedSender<super::InputEvent>>> =
        OnceLock::new();

    // CGEventType constants
    const KCG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
    const KCG_EVENT_LEFT_MOUSE_UP: u32 = 2;
    const KCG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
    const KCG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
    const KCG_EVENT_MOUSE_MOVED: u32 = 5;
    const KCG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
    const KCG_EVENT_OTHER_MOUSE_UP: u32 = 26;
    const KCG_EVENT_KEY_DOWN: u32 = 10;
    const KCG_EVENT_KEY_UP: u32 = 11;

    // CGEventField constants
    const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
    const KCG_MOUSE_EVENT_BUTTON_NUMBER: u32 = 71;

    // CGEventTap parameters
    const KCG_SESSION_EVENT_TAP: u32 = 1;
    const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    extern "C" {
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CGEventGetIntegerValueField(event: *const c_void, field: u32) -> i64;
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: extern "C" fn(
                *const c_void,
                u32,
                *const c_void,
                *const c_void,
            ) -> *const c_void,
            user_info: *const c_void,
        ) -> *const c_void;
        fn CFMachPortCreateRunLoopSource(
            alloc: *const c_void,
            port: *const c_void,
            order: isize,
        ) -> *const c_void;
        fn CFRunLoopGetCurrent() -> *const c_void;
        fn CFRunLoopAddSource(rl: *const c_void, source: *const c_void, mode: *const c_void);
        fn CFRunLoopRun();
        fn CGEventTapEnable(tap: *const c_void, enable: bool);
        static kCFRunLoopCommonModes: *const c_void;
    }

    extern "C" fn tap_callback(
        _proxy: *const c_void,
        event_type: u32,
        event: *const c_void,
        _user_info: *const c_void,
    ) -> *const c_void {
        unsafe {
            let pt = CGEventGetLocation(event);
            let x = pt.x as i32;
            let y = pt.y as i32;

            let ev = match event_type {
                t if t == KCG_EVENT_KEY_DOWN => {
                    let kc = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) as u32;
                    Some(super::InputEvent::KeyDown { vk_code: kc })
                }
                t if t == KCG_EVENT_KEY_UP => {
                    let kc = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) as u32;
                    Some(super::InputEvent::KeyUp { vk_code: kc })
                }
                t if t == KCG_EVENT_LEFT_MOUSE_DOWN => {
                    Some(super::InputEvent::MouseDown { x, y, button: 0 })
                }
                t if t == KCG_EVENT_LEFT_MOUSE_UP => {
                    Some(super::InputEvent::MouseUp { x, y, button: 0 })
                }
                t if t == KCG_EVENT_RIGHT_MOUSE_DOWN => {
                    Some(super::InputEvent::MouseDown { x, y, button: 1 })
                }
                t if t == KCG_EVENT_RIGHT_MOUSE_UP => {
                    Some(super::InputEvent::MouseUp { x, y, button: 1 })
                }
                t if t == KCG_EVENT_OTHER_MOUSE_DOWN => {
                    let btn =
                        CGEventGetIntegerValueField(event, KCG_MOUSE_EVENT_BUTTON_NUMBER) as u8;
                    Some(super::InputEvent::MouseDown { x, y, button: btn })
                }
                t if t == KCG_EVENT_OTHER_MOUSE_UP => {
                    let btn =
                        CGEventGetIntegerValueField(event, KCG_MOUSE_EVENT_BUTTON_NUMBER) as u8;
                    Some(super::InputEvent::MouseUp { x, y, button: btn })
                }
                t if t == KCG_EVENT_MOUSE_MOVED => {
                    static LAST: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let packed = ((x as u32 as u64) << 32) | (y as u32 as u64);
                    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
                    let lx = (last >> 32) as i32;
                    let ly = (last & 0xFFFF_FFFF) as i32;
                    if (x - lx).pow(2) + (y - ly).pow(2) < 2500 {
                        None
                    } else {
                        LAST.store(packed, std::sync::atomic::Ordering::Relaxed);
                        Some(super::InputEvent::MouseMove { x, y })
                    }
                }
                _ => None,
            };

            if let Some(e) = ev {
                if let Some(tx) = INPUT_TX.get() {
                    if let Ok(g) = tx.lock() {
                        let _ = g.send(e);
                    }
                }
            }
        }
        event
    }

    pub struct MacOSInputMonitor {
        stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl MacOSInputMonitor {
        pub fn new() -> Result<Self> {
            Ok(Self { stop_tx: None })
        }
    }

    #[async_trait]
    impl super::InputMonitor for MacOSInputMonitor {
        async fn start(&mut self) -> Result<()> {
            let (event_tx, mut event_rx) =
                tokio::sync::mpsc::unbounded_channel::<super::InputEvent>();
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();

            INPUT_TX.get_or_init(|| Mutex::new(event_tx));

            // Spawn run-loop thread that hosts the event tap
            std::thread::spawn(|| unsafe {
                let mask: u64 = (1u64 << KCG_EVENT_KEY_DOWN)
                    | (1u64 << KCG_EVENT_KEY_UP)
                    | (1u64 << KCG_EVENT_LEFT_MOUSE_DOWN)
                    | (1u64 << KCG_EVENT_LEFT_MOUSE_UP)
                    | (1u64 << KCG_EVENT_RIGHT_MOUSE_DOWN)
                    | (1u64 << KCG_EVENT_RIGHT_MOUSE_UP)
                    | (1u64 << KCG_EVENT_OTHER_MOUSE_DOWN)
                    | (1u64 << KCG_EVENT_OTHER_MOUSE_UP)
                    | (1u64 << KCG_EVENT_MOUSE_MOVED);

                let tap = CGEventTapCreate(
                    KCG_SESSION_EVENT_TAP,
                    KCG_HEAD_INSERT_EVENT_TAP,
                    KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    mask,
                    tap_callback,
                    std::ptr::null(),
                );
                if tap.is_null() {
                    tracing::warn!("CGEventTapCreate failed — grant Accessibility permission in System Preferences");
                    return;
                }
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                let rl = CFRunLoopGetCurrent();
                CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                tracing::info!("macOS CGEventTap installed");
                CFRunLoopRun();
            });

            // Process events
            tokio::spawn(async move {
                let mut stop = stop_rx;
                loop {
                    tokio::select! {
                        ev = event_rx.recv() => match ev {
                            Some(e) => ingest_input_event(e),
                            None => break,
                        },
                        _ = &mut stop => break,
                    }
                }
            });

            self.stop_tx = Some(stop_tx);
            tracing::info!("macOS input monitor started");
            Ok(())
        }

        async fn stop(&mut self) -> Result<()> {
            if let Some(tx) = self.stop_tx.take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    fn ingest_input_event(event: super::InputEvent) {
        use std::collections::HashMap;
        let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;
        map.insert("ts", rmpv::Value::from(now_us));
        map.insert("v", rmpv::Value::from(2u8));
        match event {
            super::InputEvent::KeyDown { vk_code } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("key_down"));
                map.insert("key_code", rmpv::Value::from(vk_code));
            }
            super::InputEvent::KeyUp { vk_code } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("key_up"));
                map.insert("key_code", rmpv::Value::from(vk_code));
            }
            super::InputEvent::MouseDown { x, y, button } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_down"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
                map.insert("button", rmpv::Value::from(button));
            }
            super::InputEvent::MouseUp { x, y, button } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_up"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
                map.insert("button", rmpv::Value::from(button));
            }
            super::InputEvent::MouseMove { x, y } => {
                map.insert("track", rmpv::Value::from(2u8));
                map.insert("type", rmpv::Value::from("mouse_move"));
                map.insert("x", rmpv::Value::from(x));
                map.insert("y", rmpv::Value::from(y));
            }
        }
        if let Ok(data) = rmp_serde::to_vec(&map) {
            let _ = shadow_core::write_event(data);
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos_impl::MacOSInputMonitor;

// ─── Linux: evdev ─────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub struct LinuxInputMonitor {
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

#[cfg(target_os = "linux")]
impl LinuxInputMonitor {
    pub fn new() -> Result<Self> {
        Ok(Self { stop_tx: None })
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl InputMonitor for LinuxInputMonitor {
    async fn start(&mut self) -> Result<()> {
        use evdev::{Device, EventType, Key};

        let (stop_tx, _stop_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::task::spawn_blocking(move || {
            // Try to open the first available keyboard device
            for path in std::fs::read_dir("/dev/input")
                .into_iter()
                .flatten()
                .flatten()
            {
                let path = path.path();
                if let Ok(mut device) = Device::open(&path) {
                    if device
                        .supported_keys()
                        .map(|k| k.contains(Key::KEY_A))
                        .unwrap_or(false)
                    {
                        tracing::info!("Linux input: monitoring {:?}", path);
                        loop {
                            match device.fetch_events() {
                                Ok(events) => {
                                    for ev in events {
                                        if ev.event_type() == EventType::KEY {
                                            tracing::trace!("Key event: {:?}", ev.code());
                                        }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    }
                }
            }
        });

        self.stop_tx = Some(stop_tx);
        tracing::info!("Linux input monitor started (evdev)");
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub type PlatformInputMonitor = WindowsInputMonitor;
#[cfg(target_os = "macos")]
pub type PlatformInputMonitor = MacOSInputMonitor;
#[cfg(target_os = "linux")]
pub type PlatformInputMonitor = LinuxInputMonitor;
