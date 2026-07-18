//! Linux input + window synthesis via the X11 XTEST extension and EWMH.
//!
//! XTEST injects at the X server, so it drives X11 and XWayland clients. On a
//! native Wayland session there is no root window to inject into; callers get a
//! clear error (and should fall back to a portal/libei path, not yet wired).
//! evdev-level injection (uinput) is the Wayland-safe alternative for a future
//! revision; this module is the X11 path that mirrors the Windows/macOS behaviour.

use anyhow::{anyhow, Result};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

// X11 core event opcodes, used as the XTEST `type_` argument.
const MOTION_NOTIFY: u8 = 6;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;

// X11 button details: 1=left, 2=middle, 3=right, 4/5=wheel up/down, 6/7=wheel left/right.
const BTN_LEFT: u8 = 1;
const BTN_MIDDLE: u8 = 2;
const BTN_RIGHT: u8 = 3;

fn connect() -> Result<(RustConnection, usize)> {
    x11rb::connect(None).map_err(|e| anyhow!("X11 connect failed (need X11/XWayland): {e}"))
}

fn root_of(conn: &RustConnection, screen: usize) -> Window {
    conn.setup().roots[screen].root
}

/// Map our cross-platform MouseButton to an X11 button detail.
pub fn button_detail(button: crate::click::MouseButton) -> u8 {
    match button {
        crate::click::MouseButton::Left => BTN_LEFT,
        crate::click::MouseButton::Middle => BTN_MIDDLE,
        crate::click::MouseButton::Right => BTN_RIGHT,
    }
}

// ─── Pointer ──────────────────────────────────────────────────────────────────

pub fn move_pointer(x: i32, y: i32) -> Result<()> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x as i16, y as i16, 0)?;
    conn.flush()?;
    Ok(())
}

pub fn click(x: i32, y: i32, button: u8, count: u32) -> Result<()> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x as i16, y as i16, 0)?;
    for _ in 0..count.max(1) {
        conn.xtest_fake_input(BUTTON_PRESS, button, 0, root, x as i16, y as i16, 0)?;
        conn.xtest_fake_input(BUTTON_RELEASE, button, 0, root, x as i16, y as i16, 0)?;
        conn.flush()?;
        std::thread::sleep(std::time::Duration::from_millis(20));
        if count > 1 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    Ok(())
}

pub fn long_press(x: i32, y: i32, duration_ms: u64, button: u8) -> Result<()> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x as i16, y as i16, 0)?;
    conn.xtest_fake_input(BUTTON_PRESS, button, 0, root, x as i16, y as i16, 0)?;
    conn.flush()?;
    std::thread::sleep(std::time::Duration::from_millis(duration_ms));
    conn.xtest_fake_input(BUTTON_RELEASE, button, 0, root, x as i16, y as i16, 0)?;
    conn.flush()?;
    Ok(())
}

pub fn drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u64,
    hold_duration_ms: u64,
) -> Result<()> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, from_x as i16, from_y as i16, 0)?;
    conn.flush()?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    conn.xtest_fake_input(BUTTON_PRESS, BTN_LEFT, 0, root, from_x as i16, from_y as i16, 0)?;
    conn.flush()?;
    std::thread::sleep(std::time::Duration::from_millis(hold_duration_ms));

    let steps = (duration_ms / 10).max(10) as i32;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let cx = from_x + ((to_x - from_x) as f64 * t) as i32;
        let cy = from_y + ((to_y - from_y) as f64 * t) as i32;
        conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, cx as i16, cy as i16, 0)?;
        conn.flush()?;
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    conn.xtest_fake_input(BUTTON_RELEASE, BTN_LEFT, 0, root, to_x as i16, to_y as i16, 0)?;
    conn.flush()?;
    Ok(())
}

pub fn scroll(x: i32, y: i32, direction: &str, amount: i32) -> Result<()> {
    // Wheel buttons: 4=up, 5=down, 6=left, 7=right. Each notch is a press+release.
    let detail: u8 = match direction {
        "up" => 4,
        "down" => 5,
        "left" => 6,
        "right" => 7,
        _ => {
            return Err(anyhow!(
                "Unknown scroll direction '{direction}'; use up, down, left, or right"
            ))
        }
    };
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x as i16, y as i16, 0)?;
    for _ in 0..amount.max(1) {
        conn.xtest_fake_input(BUTTON_PRESS, detail, 0, root, x as i16, y as i16, 0)?;
        conn.xtest_fake_input(BUTTON_RELEASE, detail, 0, root, x as i16, y as i16, 0)?;
    }
    conn.flush()?;
    Ok(())
}

// ─── Keyboard ───────────────────────────────────────────────────────────────

/// Resolve an X11 keysym to (keycode, needs_shift) using the live keyboard map.
/// X11 keysyms for Latin-1 equal the Unicode/ASCII codepoint, so a char maps to
/// its keysym directly. Column 0 of each keycode is unshifted, column 1 shifted.
fn find_keycode(
    setup_min: u8,
    per: usize,
    keysyms: &[u32],
    keysym: u32,
) -> Option<(u8, bool)> {
    for (i, chunk) in keysyms.chunks(per).enumerate() {
        if chunk.first().copied() == Some(keysym) {
            return Some((setup_min + i as u8, false));
        }
        if per > 1 && chunk.get(1).copied() == Some(keysym) {
            return Some((setup_min + i as u8, true));
        }
    }
    None
}

const SHIFT_KEYSYM: u32 = 0xFFE1;

/// X11 keysym for a named key, mirroring the macOS keycode table.
fn name_to_keysym(name: &str) -> Option<u32> {
    Some(match name.to_lowercase().as_str() {
        "ctrl" | "control" => 0xFFE3,
        "alt" | "option" => 0xFFE9,
        "shift" => SHIFT_KEYSYM,
        "cmd" | "command" | "super" | "win" | "meta" => 0xFFEB, // Super_L
        "return" | "enter" => 0xFF0D,
        "tab" => 0xFF09,
        "space" => 0x0020,
        "backspace" => 0xFF08,
        "delete" | "del" => 0xFFFF,
        "escape" | "esc" => 0xFF1B,
        "home" => 0xFF50,
        "end" => 0xFF57,
        "pageup" => 0xFF55,
        "pagedown" => 0xFF56,
        "left" => 0xFF51,
        "up" => 0xFF52,
        "right" => 0xFF53,
        "down" => 0xFF54,
        "f1" => 0xFFBE,
        "f2" => 0xFFBF,
        "f3" => 0xFFC0,
        "f4" => 0xFFC1,
        "f5" => 0xFFC2,
        "f6" => 0xFFC3,
        "f7" => 0xFFC4,
        "f8" => 0xFFC5,
        "f9" => 0xFFC6,
        "f10" => 0xFFC7,
        "f11" => 0xFFC8,
        "f12" => 0xFFC9,
        s if s.chars().count() == 1 => s.chars().next()? as u32,
        _ => return None,
    })
}

struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
}

fn keymap(conn: &RustConnection) -> Result<Keymap> {
    let setup = conn.setup();
    let min = setup.min_keycode;
    let count = setup.max_keycode - min + 1;
    let reply = conn.get_keyboard_mapping(min, count)?.reply()?;
    Ok(Keymap {
        min,
        per: reply.keysyms_per_keycode as usize,
        syms: reply.keysyms,
    })
}

fn tap_keysym(conn: &RustConnection, km: &Keymap, keysym: u32) -> Result<()> {
    let Some((kc, needs_shift)) = find_keycode(km.min, km.per, &km.syms, keysym) else {
        // Not in the active layout (e.g. a non-Latin char); skip rather than error.
        return Ok(());
    };
    let shift_kc = find_keycode(km.min, km.per, &km.syms, SHIFT_KEYSYM).map(|(c, _)| c);
    if needs_shift {
        if let Some(s) = shift_kc {
            conn.xtest_fake_input(KEY_PRESS, s, 0, x11rb::NONE, 0, 0, 0)?;
        }
    }
    conn.xtest_fake_input(KEY_PRESS, kc, 0, x11rb::NONE, 0, 0, 0)?;
    conn.xtest_fake_input(KEY_RELEASE, kc, 0, x11rb::NONE, 0, 0, 0)?;
    if needs_shift {
        if let Some(s) = shift_kc {
            conn.xtest_fake_input(KEY_RELEASE, s, 0, x11rb::NONE, 0, 0, 0)?;
        }
    }
    Ok(())
}

pub fn type_text(text: &str, clear: bool) -> Result<()> {
    let (conn, _screen) = connect()?;
    let km = keymap(&conn)?;
    if clear {
        hotkey_on(&conn, &km, &["ctrl", "a"])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        press_key_on(&conn, &km, "delete", &[])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    for ch in text.chars() {
        tap_keysym(&conn, &km, ch as u32)?;
        conn.flush()?;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}

fn press_key_on(conn: &RustConnection, km: &Keymap, key: &str, modifiers: &[&str]) -> Result<()> {
    let key_sym = name_to_keysym(key).ok_or_else(|| anyhow!("Unknown key: {key}"))?;
    let mod_kcs: Vec<u8> = modifiers
        .iter()
        .filter_map(|m| name_to_keysym(m))
        .filter_map(|ks| find_keycode(km.min, km.per, &km.syms, ks).map(|(c, _)| c))
        .collect();
    for &kc in &mod_kcs {
        conn.xtest_fake_input(KEY_PRESS, kc, 0, x11rb::NONE, 0, 0, 0)?;
    }
    tap_keysym(conn, km, key_sym)?;
    for &kc in mod_kcs.iter().rev() {
        conn.xtest_fake_input(KEY_RELEASE, kc, 0, x11rb::NONE, 0, 0, 0)?;
    }
    conn.flush()?;
    Ok(())
}

pub fn press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    let (conn, _screen) = connect()?;
    let km = keymap(&conn)?;
    press_key_on(&conn, &km, key, modifiers)
}

fn hotkey_on(conn: &RustConnection, km: &Keymap, keys: &[&str]) -> Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let (modifiers, key) = keys.split_at(keys.len() - 1);
    press_key_on(conn, km, key[0], modifiers)
}

pub fn hotkey(keys: &[&str]) -> Result<()> {
    let (conn, _screen) = connect()?;
    let km = keymap(&conn)?;
    hotkey_on(&conn, &km, keys)
}

// ─── Window management (EWMH) ─────────────────────────────────────────────────

fn atom(conn: &RustConnection, name: &[u8]) -> Result<u32> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}

/// Every top-level managed window, from `_NET_CLIENT_LIST`.
fn client_list(conn: &RustConnection, root: Window) -> Result<Vec<Window>> {
    let prop = atom(conn, b"_NET_CLIENT_LIST")?;
    let reply = conn
        .get_property(false, root, prop, AtomEnum::WINDOW, 0, 4096)?
        .reply()?;
    Ok(reply.value32().map(|it| it.collect()).unwrap_or_default())
}

fn window_title(conn: &RustConnection, win: Window) -> String {
    if let (Ok(name_atom), Ok(utf8)) = (atom(conn, b"_NET_WM_NAME"), atom(conn, b"UTF8_STRING")) {
        if let Some(reply) = conn
            .get_property(false, win, name_atom, utf8, 0, 1024)
            .ok()
            .and_then(|c| c.reply().ok())
        {
            if !reply.value.is_empty() {
                return String::from_utf8_lossy(&reply.value).into_owned();
            }
        }
    }
    if let Some(reply) = conn
        .get_property(false, win, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
    {
        return String::from_utf8_lossy(&reply.value).into_owned();
    }
    String::new()
}

fn window_class(conn: &RustConnection, win: Window) -> String {
    if let Some(reply) = conn
        .get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
    {
        return String::from_utf8_lossy(&reply.value).replace('\0', " ");
    }
    String::new()
}

/// Resolve the first window whose class or title contains `app_name`.
fn resolve_window(
    conn: &RustConnection,
    root: Window,
    app_name: &str,
    title_filter: Option<&str>,
) -> Option<Window> {
    let needle = app_name.to_lowercase();
    let title_needle = title_filter.map(|s| s.to_lowercase());
    for win in client_list(conn, root).ok()? {
        let class = window_class(conn, win).to_lowercase();
        let title = window_title(conn, win).to_lowercase();
        if !(class.contains(&needle) || title.contains(&needle)) {
            continue;
        }
        if let Some(ref t) = title_needle {
            if !title.contains(t) {
                continue;
            }
        }
        return Some(win);
    }
    None
}

fn send_client_message(
    conn: &RustConnection,
    root: Window,
    win: Window,
    type_name: &[u8],
    data: [u32; 5],
) -> Result<()> {
    let type_atom = atom(conn, type_name)?;
    let event = ClientMessageEvent::new(32, win, type_atom, data);
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
        event,
    )?;
    conn.flush()?;
    Ok(())
}

pub fn focus_app(app_name: &str) -> bool {
    let Ok((conn, screen)) = connect() else {
        return false;
    };
    let root = root_of(&conn, screen);
    let Some(win) = resolve_window(&conn, root, app_name, None) else {
        return false;
    };
    // _NET_ACTIVE_WINDOW: source indication 2 (pager), timestamp 0, requestor 0.
    send_client_message(&conn, root, win, b"_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0]).is_ok()
}

pub fn window_action(
    action: &crate::window::WindowAction,
    app_name: &str,
    window_title_filter: Option<&str>,
) -> Result<serde_json::Value> {
    use crate::window::WindowAction;
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen);

    if let WindowAction::List = action {
        let needle = app_name.to_lowercase();
        let mut windows = vec![];
        for win in client_list(&conn, root)? {
            let class = window_class(&conn, win).to_lowercase();
            let title = window_title(&conn, win);
            if !(class.contains(&needle) || title.to_lowercase().contains(&needle)) {
                continue;
            }
            if let Ok(g) = conn.get_geometry(win)?.reply() {
                windows.push(serde_json::json!({
                    "title": title,
                    "x": g.x,
                    "y": g.y,
                    "width": g.width,
                    "height": g.height,
                }));
            }
        }
        return Ok(serde_json::json!({ "windows": windows }));
    }

    let win = resolve_window(&conn, root, app_name, window_title_filter).ok_or_else(|| {
        anyhow!(
            "Window for '{}' not found",
            window_title_filter.unwrap_or(app_name)
        )
    })?;

    match action {
        WindowAction::Minimize => {
            // WM_CHANGE_STATE -> IconicState(3).
            send_client_message(&conn, root, win, b"WM_CHANGE_STATE", [3, 0, 0, 0, 0])?;
        }
        WindowAction::Maximize => {
            let vert = atom(&conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
            let horz = atom(&conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
            // _NET_WM_STATE action 1 = ADD.
            send_client_message(&conn, root, win, b"_NET_WM_STATE", [1, vert, horz, 1, 0])?;
        }
        WindowAction::Restore => {
            let vert = atom(&conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
            let horz = atom(&conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
            // action 0 = REMOVE, then re-activate so an iconified window un-minimizes.
            send_client_message(&conn, root, win, b"_NET_WM_STATE", [0, vert, horz, 1, 0])?;
            send_client_message(&conn, root, win, b"_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0])?;
        }
        WindowAction::Close => {
            send_client_message(&conn, root, win, b"_NET_CLOSE_WINDOW", [0, 2, 0, 0, 0])?;
        }
        WindowAction::Move { x, y } => {
            conn.configure_window(win, &ConfigureWindowAux::new().x(*x).y(*y))?;
            conn.flush()?;
        }
        WindowAction::Resize { width, height } => {
            conn.configure_window(
                win,
                &ConfigureWindowAux::new().width(*width).height(*height),
            )?;
            conn.flush()?;
        }
        WindowAction::List => unreachable!("handled above"),
    }
    Ok(serde_json::json!({ "success": true }))
}
