//! Windows low-level keyboard hook for the Alt×2 gesture.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

use crate::quick_capture::gesture::{Detector, Input, Modifier, Side, Trigger};

const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const LLKHF_INJECTED: u32 = 0x0000_0010;

struct HookState {
    listening: Arc<AtomicBool>,
    sender: Mutex<Sender<Trigger>>,
}

static HOOK_STATE: OnceLock<HookState> = OnceLock::new();

thread_local! {
    static DETECTOR: RefCell<Detector> = RefCell::new(Detector::for_modifier(Modifier::Alt));
}

pub fn spawn_listener(tx: Sender<Trigger>, listening: Arc<AtomicBool>) -> Result<(), String> {
    HOOK_STATE
        .set(HookState {
            listening,
            sender: Mutex::new(tx),
        })
        .map_err(|_| "Clips quick attach Windows hook was already initialized".to_string())?;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("ryu-clips-quick-attach-windows".into())
        .spawn(move || {
            let module = match unsafe { GetModuleHandleW(None) } {
                Ok(module) => HINSTANCE(module.0),
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("couldn't find Ryu module: {error}")));
                    return;
                }
            };
            let hook = match unsafe {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), Some(module), 0)
            } {
                Ok(hook) => hook,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!(
                        "couldn't install the Windows keyboard hook: {error}"
                    )));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));

            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
        })
        .map_err(|error| format!("couldn't start Windows keyboard hook: {error}"))?;

    ready_rx
        .recv()
        .map_err(|_| "Windows keyboard hook stopped before it started".to_string())?
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if event.flags.0 & LLKHF_INJECTED == 0 {
            let message = wparam.0 as u32;
            let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
            if let Some(input) = input_for(event.vkCode, is_down, is_up) {
                let now_ms = now_millis();
                DETECTOR.with(|detector| {
                    if let Some(trigger) = detector.borrow_mut().feed(now_ms, input) {
                        if let Some(state) = HOOK_STATE.get() {
                            if state.listening.load(Ordering::SeqCst) {
                                if let Ok(sender) = state.sender.lock() {
                                    let _ = sender.send(trigger);
                                }
                            }
                        }
                    }
                });
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn input_for(keycode: u32, is_down: bool, is_up: bool) -> Option<Input> {
    if keycode == VK_LMENU || keycode == VK_RMENU {
        let side = if keycode == VK_LMENU {
            Side::Left
        } else {
            Side::Right
        };
        if is_down {
            return Some(Input::ModifierDown {
                modifier: Modifier::Alt,
                side,
                other_modifiers: other_modifiers_held(),
            });
        }
        if is_up {
            return Some(Input::ModifierUp {
                modifier: Modifier::Alt,
                side,
            });
        }
        return None;
    }
    if is_down && is_modifier_key(keycode) {
        return Some(Input::OtherModifier);
    }
    if is_down {
        return Some(Input::KeyDown);
    }
    None
}

fn is_modifier_key(keycode: u32) -> bool {
    matches!(
        keycode,
        VK_LSHIFT | VK_RSHIFT | VK_LCONTROL | VK_RCONTROL | VK_LWIN | VK_RWIN
    )
}

fn other_modifiers_held() -> bool {
    [
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LWIN,
        VK_RWIN,
    ]
    .into_iter()
    .any(is_key_down)
}

fn is_key_down(keycode: u32) -> bool {
    unsafe { GetAsyncKeyState(keycode as i32) < 0 }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
