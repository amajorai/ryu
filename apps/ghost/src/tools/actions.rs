use anyhow::Result;
use serde_json::{json, Value};

use ghost_eyes::{PlatformAXTree, AXTree};
use ghost_hands::{
    drag, focus_app, hover, long_press, mouse_click, press_key, scroll, send_hotkey, type_text,
    window_action, MouseButton, WindowAction,
};

use super::{bool_param, f64_param, int_param, str_param};

pub async fn ghost_click(params: Value) -> Result<Value> {
    let app = str_param(&params, "app");
    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // Ref from a prior ghost_snapshot — re-identify (STALE_REF if gone) then click.
    if let Some(r) = str_param(&params, "ref") {
        let (x, y) = crate::tools::snapshot::resolve_ref(r).await?;
        let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
        let count = int_param(&params, "count", 1) as u32;
        tokio::task::spawn_blocking(move || mouse_click(x, y, button, count)).await??;
        return Ok(json!({ "success": true, "x": x, "y": y, "ref": r, "method": "ref" }));
    }

    // If x/y given, use coordinates directly
    if let (Some(x), Some(y)) = (params["x"].as_f64(), params["y"].as_f64()) {
        let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
        let count = int_param(&params, "count", 1) as u32;
        tokio::task::spawn_blocking(move || mouse_click(x as i32, y as i32, button, count)).await??;
        return Ok(json!({ "success": true, "x": x, "y": y, "method": "coordinates" }));
    }

    // dom_id: direct CDP lookup by CSS #id selector
    let dom_id = str_param(&params, "dom_id");
    if let Some(id) = &dom_id {
        if ghost_core::cdp::is_available().await {
            let selector = format!("#{id}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
                    let count = int_param(&params, "count", 1) as u32;
                    let text = el.text.clone();
                    tokio::task::spawn_blocking(move || mouse_click(sx, sy, button, count)).await??;
                    return Ok(json!({ "success": true, "x": sx, "y": sy, "element": text, "method": "cdp_dom_id" }));
                }
            }
        }
    }

    // dom_class: CDP lookup by CSS .class selector
    let dom_class = str_param(&params, "dom_class");
    if let Some(cls) = &dom_class {
        if ghost_core::cdp::is_available().await {
            let selector = format!(".{cls}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
                    let count = int_param(&params, "count", 1) as u32;
                    let text = el.text.clone();
                    tokio::task::spawn_blocking(move || mouse_click(sx, sy, button, count)).await??;
                    return Ok(json!({ "success": true, "x": sx, "y": sy, "element": text, "method": "cdp_dom_class" }));
                }
            }
        }
    }

    // Find element by query
    let query = str_param(&params, "query").unwrap_or("");
    let ax = PlatformAXTree::new()?;
    if let Some(el) = ax.find_element(query).await {
        if let Some(bounds) = &el.bounds {
            let cx = bounds.x + bounds.width as i32 / 2;
            let cy = bounds.y + bounds.height as i32 / 2;
            let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
            let count = int_param(&params, "count", 1) as u32;
            tokio::task::spawn_blocking(move || mouse_click(cx, cy, button, count)).await??;
            return Ok(json!({ "success": true, "x": cx, "y": cy, "element": el.title, "method": "ax_query" }));
        }
    }

    // CDP fallback: Chrome elements not exposed in the AX tree (iframes, SPAs, Gmail, etc.)
    if ghost_core::cdp::is_available().await {
        if let Ok(results) = ghost_core::cdp::find_elements(query).await {
            if let Some(el) = results.first() {
                let (win_x, win_y) = chrome_window_origin();
                let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
                let count = int_param(&params, "count", 1) as u32;
                tokio::task::spawn_blocking(move || mouse_click(sx, sy, button, count)).await??;
                return Ok(json!({ "success": true, "x": sx, "y": sy, "element": el.text, "method": "cdp" }));
            }
        }
    }

    Err(anyhow::anyhow!("Could not find element '{}'. Try ghost_annotate to see numbered labels, or specify x/y coordinates.", query))
}

pub async fn ghost_type(params: Value) -> Result<Value> {
    let text = params["text"].as_str().ok_or_else(|| anyhow::anyhow!("'text' required"))?;
    let into  = str_param(&params, "into");
    let app   = str_param(&params, "app");
    let clear = bool_param(&params, "clear", false);

    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // Ref from a prior ghost_snapshot — click to focus the field, then type.
    if let Some(r) = str_param(&params, "ref") {
        let (x, y) = crate::tools::snapshot::resolve_ref(r).await?;
        tokio::task::spawn_blocking(move || mouse_click(x, y, MouseButton::Left, 1)).await??;
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        let text_owned = text.to_string();
        tokio::task::spawn_blocking(move || type_text(&text_owned, clear)).await??;
        return Ok(json!({ "success": true, "typed": text, "ref": r, "method": "ref" }));
    }

    // dom_id: click field by CSS #id via CDP, then fall through to type
    let dom_id = str_param(&params, "dom_id");
    if let Some(id) = &dom_id {
        if ghost_core::cdp::is_available().await {
            let selector = format!("#{id}");
            if let Ok(els) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = els.first() {
                    let (wx, wy) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, wx, wy);
                    tokio::task::spawn_blocking(move || mouse_click(sx, sy, MouseButton::Left, 1)).await??;
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    // dom_class: click field by CSS .class via CDP, then fall through to type
    let dom_class = str_param(&params, "dom_class");
    if let Some(cls) = &dom_class {
        if ghost_core::cdp::is_available().await {
            let selector = format!(".{cls}");
            if let Ok(els) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = els.first() {
                    let (wx, wy) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, wx, wy);
                    tokio::task::spawn_blocking(move || mouse_click(sx, sy, MouseButton::Left, 1)).await??;
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    // If 'into' is given, click the target field first (AX → CDP fallback)
    if let Some(target) = into {
        let ax = PlatformAXTree::new()?;
        let focused = if let Some(el) = ax.find_element(target).await {
            if let Some(bounds) = &el.bounds {
                let cx = bounds.x + bounds.width as i32 / 2;
                let cy = bounds.y + bounds.height as i32 / 2;
                tokio::task::spawn_blocking(move || mouse_click(cx, cy, MouseButton::Left, 1)).await??;
                true
            } else { false }
        } else { false };

        if !focused && ghost_core::cdp::is_available().await {
            if let Ok(els) = ghost_core::cdp::find_elements(target).await {
                if let Some(el) = els.first() {
                    let (wx, wy) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, wx, wy);
                    tokio::task::spawn_blocking(move || mouse_click(sx, sy, MouseButton::Left, 1)).await??;
                }
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    let text_owned = text.to_string();
    tokio::task::spawn_blocking(move || type_text(&text_owned, clear)).await??;
    Ok(json!({ "success": true, "typed": text }))
}

pub async fn ghost_press(params: Value) -> Result<Value> {
    let key = params["key"].as_str().ok_or_else(|| anyhow::anyhow!("'key' required"))?;
    let app = str_param(&params, "app");

    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    let modifiers: Vec<String> = params["modifiers"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let key_owned = key.to_string();
    tokio::task::spawn_blocking(move || {
        let mod_refs: Vec<&str> = modifiers.iter().map(|s| s.as_str()).collect();
        press_key(&key_owned, &mod_refs)
    }).await??;
    Ok(json!({ "success": true, "key": key }))
}

pub async fn ghost_hotkey(params: Value) -> Result<Value> {
    let keys: Vec<String> = params["keys"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("'keys' required (array)"))?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();

    let app = str_param(&params, "app");
    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        send_hotkey(&refs)
    }).await??;
    Ok(json!({ "success": true, "keys": params["keys"] }))
}

pub async fn ghost_scroll(params: Value) -> Result<Value> {
    let direction = params["direction"].as_str().ok_or_else(|| anyhow::anyhow!("'direction' required"))?;
    let amount = int_param(&params, "amount", 3) as i32;
    let x = params["x"].as_f64().unwrap_or(960.0) as i32;
    let y = params["y"].as_f64().unwrap_or(540.0) as i32;
    let app = str_param(&params, "app");

    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    let dir = direction.to_string();
    tokio::task::spawn_blocking(move || scroll(x, y, &dir, amount)).await??;
    Ok(json!({ "success": true }))
}

pub async fn ghost_hover(params: Value) -> Result<Value> {
    let app = str_param(&params, "app");
    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // dom_id: CDP lookup by CSS #id selector
    let dom_id = str_param(&params, "dom_id");
    if let Some(id) = &dom_id {
        if ghost_core::cdp::is_available().await {
            let selector = format!("#{id}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    tokio::task::spawn_blocking(move || hover(sx, sy)).await??;
                    return Ok(json!({ "success": true, "x": sx, "y": sy, "method": "cdp_dom_id" }));
                }
            }
        }
    }

    // dom_class: CDP lookup by CSS .class selector
    let dom_class = str_param(&params, "dom_class");
    if let Some(cls) = &dom_class {
        if ghost_core::cdp::is_available().await {
            let selector = format!(".{cls}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    tokio::task::spawn_blocking(move || hover(sx, sy)).await??;
                    return Ok(json!({ "success": true, "x": sx, "y": sy, "method": "cdp_dom_class" }));
                }
            }
        }
    }

    if let (Some(x), Some(y)) = (params["x"].as_f64(), params["y"].as_f64()) {
        tokio::task::spawn_blocking(move || hover(x as i32, y as i32)).await??;
        return Ok(json!({ "success": true, "x": x, "y": y }));
    }

    let query = str_param(&params, "query").unwrap_or("");
    let ax = PlatformAXTree::new()?;
    if let Some(el) = ax.find_element(query).await {
        if let Some(bounds) = &el.bounds {
            let cx = bounds.x + bounds.width as i32 / 2;
            let cy = bounds.y + bounds.height as i32 / 2;
            tokio::task::spawn_blocking(move || hover(cx, cy)).await??;
            return Ok(json!({ "success": true, "x": cx, "y": cy, "method": "ax_query" }));
        }
    }

    // CDP fallback for Chrome elements not in AX tree
    if ghost_core::cdp::is_available().await {
        if let Ok(els) = ghost_core::cdp::find_elements(query).await {
            if let Some(el) = els.first() {
                let (wx, wy) = chrome_window_origin();
                let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, wx, wy);
                tokio::task::spawn_blocking(move || hover(sx, sy)).await??;
                return Ok(json!({ "success": true, "x": sx, "y": sy, "method": "cdp" }));
            }
        }
    }

    Err(anyhow::anyhow!("Could not find element '{}'. Specify x/y coordinates instead.", query))
}

pub async fn ghost_long_press(params: Value) -> Result<Value> {
    let duration_secs = f64_param(&params, "duration", 1.0);
    let duration_ms = (duration_secs * 1000.0) as u64;
    let button = str_to_button(str_param(&params, "button").unwrap_or("left"));
    let app = str_param(&params, "app");

    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // dom_id: CDP lookup by CSS #id selector
    let dom_id = str_param(&params, "dom_id");
    if let Some(id) = &dom_id {
        if ghost_core::cdp::is_available().await {
            let selector = format!("#{id}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    tokio::task::spawn_blocking(move || long_press(sx, sy, duration_ms, button)).await??;
                    return Ok(json!({ "success": true, "method": "cdp_dom_id" }));
                }
            }
        }
    }

    // dom_class: CDP lookup by CSS .class selector
    let dom_class = str_param(&params, "dom_class");
    if let Some(cls) = &dom_class {
        if ghost_core::cdp::is_available().await {
            let selector = format!(".{cls}");
            if let Ok(results) = ghost_core::cdp::find_elements(&selector).await {
                if let Some(el) = results.first() {
                    let (win_x, win_y) = chrome_window_origin();
                    let (sx, sy) = ghost_core::cdp::viewport_to_screen(el.center_x, el.center_y, win_x, win_y);
                    tokio::task::spawn_blocking(move || long_press(sx, sy, duration_ms, button)).await??;
                    return Ok(json!({ "success": true, "method": "cdp_dom_class" }));
                }
            }
        }
    }

    if let (Some(x), Some(y)) = (params["x"].as_f64(), params["y"].as_f64()) {
        tokio::task::spawn_blocking(move || long_press(x as i32, y as i32, duration_ms, button)).await??;
        return Ok(json!({ "success": true }));
    }

    let query = str_param(&params, "query").unwrap_or("");
    let ax = PlatformAXTree::new()?;
    if let Some(el) = ax.find_element(query).await {
        if let Some(bounds) = &el.bounds {
            let cx = bounds.x + bounds.width as i32 / 2;
            let cy = bounds.y + bounds.height as i32 / 2;
            tokio::task::spawn_blocking(move || long_press(cx, cy, duration_ms, button)).await??;
            return Ok(json!({ "success": true }));
        }
    }
    Err(anyhow::anyhow!("Specify x/y or a query to identify the target."))
}

pub async fn ghost_drag(params: Value) -> Result<Value> {
    let to_x = params["to_x"].as_f64().ok_or_else(|| anyhow::anyhow!("'to_x' required"))? as i32;
    let to_y = params["to_y"].as_f64().ok_or_else(|| anyhow::anyhow!("'to_y' required"))? as i32;
    let duration_secs = f64_param(&params, "duration", 0.5);
    let hold_secs     = f64_param(&params, "hold_duration", 0.1);
    let duration_ms   = (duration_secs * 1000.0) as u64;
    let hold_ms       = (hold_secs * 1000.0) as u64;

    let app = str_param(&params, "app");
    if let Some(app_name) = app {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    let (from_x, from_y) = if let (Some(fx), Some(fy)) = (params["from_x"].as_f64(), params["from_y"].as_f64()) {
        (fx as i32, fy as i32)
    } else {
        let query = str_param(&params, "query").unwrap_or("");
        let ax = PlatformAXTree::new()?;
        if let Some(el) = ax.find_element(query).await {
            if let Some(bounds) = &el.bounds {
                (bounds.x + bounds.width as i32 / 2, bounds.y + bounds.height as i32 / 2)
            } else {
                return Err(anyhow::anyhow!("Element has no bounds. Specify from_x/from_y."));
            }
        } else {
            return Err(anyhow::anyhow!("Specify from_x/from_y or a query."));
        }
    };

    tokio::task::spawn_blocking(move || drag(from_x, from_y, to_x, to_y, duration_ms, hold_ms)).await??;
    Ok(json!({ "success": true, "from": [from_x, from_y], "to": [to_x, to_y] }))
}

pub async fn ghost_focus(params: Value) -> Result<Value> {
    let app = params["app"].as_str().ok_or_else(|| anyhow::anyhow!("'app' required"))?;
    let window = str_param(&params, "window");
    // If a specific window title is given, try to focus it by exact title first
    if let Some(title) = window {
        if focus_app(title) {
            return Ok(json!({ "success": true, "method": "window_title", "window": title }));
        }
    }
    let success = focus_app(app);
    Ok(json!({ "success": success, "app": app }))
}

pub async fn ghost_window(params: Value) -> Result<Value> {
    let action_str = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("'action' required"))?;
    let app = params["app"].as_str().ok_or_else(|| anyhow::anyhow!("'app' required"))?;
    let window_title = str_param(&params, "window");

    let action = match action_str {
        "minimize" => WindowAction::Minimize,
        "maximize" => WindowAction::Maximize,
        "close"    => WindowAction::Close,
        "restore"  => WindowAction::Restore,
        "move"     => WindowAction::Move {
            x: params["x"].as_f64().unwrap_or(0.0) as i32,
            y: params["y"].as_f64().unwrap_or(0.0) as i32,
        },
        "resize"   => WindowAction::Resize {
            width:  params["width"].as_f64().unwrap_or(800.0)  as u32,
            height: params["height"].as_f64().unwrap_or(600.0) as u32,
        },
        "list" => WindowAction::List,
        _ => return Err(anyhow::anyhow!("Unknown action '{}'. Use: minimize, maximize, close, restore, move, resize, list.", action_str)),
    };

    let app_owned = app.to_string();
    let title_owned = window_title.map(|s| s.to_string());
    tokio::task::spawn_blocking(move || {
        window_action(&action, &app_owned, title_owned.as_deref())
    }).await?
}

fn str_to_button(s: &str) -> MouseButton {
    match s {
        "right"  => MouseButton::Right,
        "middle" => MouseButton::Middle,
        _        => MouseButton::Left,
    }
}

/// Return the screen-space top-left origin of the Chrome window.
/// Used to convert CDP viewport-relative coordinates to screen-absolute.
fn chrome_window_origin() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};
        use windows::core::w;
        unsafe {
            if let Ok(hwnd) = FindWindowW(w!("Chrome_WidgetWin_1"), windows::core::PCWSTR::null()) {
                if !hwnd.0.is_null() {
                    let mut r = RECT::default();
                    let _ = GetWindowRect(hwnd, &mut r);
                    return (r.left, r.top);
                }
            }
        }
    }
    (0, 0)
}
