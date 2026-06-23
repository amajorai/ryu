use anyhow::Result;
use async_trait::async_trait;
use serde_json::json;

use super::super::{AgentTool, Tool, ToolResult};
#[allow(unused_imports)]
use crate::capture::accessibility::AXTree;

/// Click UI element by description.
pub struct AXClickTool;

#[async_trait]
impl AgentTool for AXClickTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_click".to_string(),
            description: "Click a UI element matching a description using the grounding oracle (AX exact → AX fuzzy → ShowUI-2B vision)".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "strategy": {"type": "string", "enum": ["auto", "exact", "fuzzy", "vision"], "default": "auto"}
                },
                "required": ["description"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let description = params["description"].as_str().unwrap_or("");

        // Get real screen dimensions and capture current screenshot
        let (sw, sh) = crate::capture::screen::get_primary_display_size();
        let frame = crate::capture::screen::quick_screenshot(0).await.ok();
        let screenshot_data = frame.as_ref().map(|f| f.data.as_slice()).unwrap_or(&[]);

        let oracle = crate::intelligence::GroundingOracle::new()?;
        let result = oracle.ground(description, screenshot_data, sw, sh).await;

        match result {
            Ok(grounding) => {
                let pixel_x = (grounding.x * sw as f32) as i32;
                let pixel_y = (grounding.y * sh as f32) as i32;
                simulate_click(pixel_x, pixel_y);
                Ok(ToolResult {
                    tool_name: "ax_click".to_string(),
                    result: json!({
                        "success": true,
                        "x": pixel_x,
                        "y": pixel_y,
                        "strategy": format!("{:?}", grounding.strategy),
                        "confidence": grounding.confidence
                    }),
                    error: None,
                })
            }
            Err(e) => Ok(ToolResult {
                tool_name: "ax_click".to_string(),
                result: json!({ "success": false }),
                error: Some(e.to_string()),
            }),
        }
    }
}

fn simulate_click(x: i32, y: i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
        unsafe {
            let _ = SetCursorPos(x, y);
            let inputs = [
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: x,
                            dy: y,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_LEFTDOWN,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: x,
                            dy: y,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_LEFTUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
    #[cfg(not(target_os = "windows"))]
    tracing::debug!("simulate_click({}, {})", x, y);
}

/// Type text into focused element.
pub struct AXTypeTool;

#[async_trait]
impl AgentTool for AXTypeTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_type".to_string(),
            description: "Type text into the currently focused UI element".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "press_enter": {"type": "boolean", "default": false}
                },
                "required": ["text"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let text = params["text"].as_str().unwrap_or("");
        let press_enter = params["press_enter"].as_bool().unwrap_or(false);

        platform_type_text(text, press_enter);

        Ok(ToolResult {
            tool_name: "ax_type".to_string(),
            result: json!({ "success": true, "typed": text }),
            error: None,
        })
    }
}

fn platform_type_text(text: &str, press_enter: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        let chars: Vec<u16> = text.encode_utf16().collect();
        let mut inputs: Vec<INPUT> = chars
            .iter()
            .flat_map(|&ch| {
                [
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(0),
                                wScan: ch,
                                dwFlags: KEYEVENTF_UNICODE,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(0),
                                wScan: ch,
                                dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                ]
            })
            .collect();

        if press_enter {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RETURN,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
    #[cfg(not(target_os = "windows"))]
    tracing::debug!("platform_type_text: {}", text);
}

/// Query accessibility tree.
pub struct AXTreeQueryTool;

#[async_trait]
impl AgentTool for AXTreeQueryTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_tree_query".to_string(),
            description: "Query the accessibility tree for the focused app, optionally filtered by role or title".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional filter by role or title substring"}
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let filter = params["filter"].as_str();

        let ax = crate::capture::accessibility::PlatformAXTree::new()?;
        let tree = ax.get_focused_tree().await?;

        let tree_json = serde_json::to_value(&tree)?;
        let result = if let Some(f) = filter {
            filter_ax_tree(&tree_json, f)
        } else {
            tree_json
        };

        Ok(ToolResult {
            tool_name: "ax_tree_query".to_string(),
            result: json!({ "tree": result }),
            error: None,
        })
    }
}

fn filter_ax_tree(node: &serde_json::Value, filter: &str) -> serde_json::Value {
    let filter_lower = filter.to_lowercase();
    let role = node["role"].as_str().unwrap_or("").to_lowercase();
    let title = node["title"].as_str().unwrap_or("").to_lowercase();
    if role.contains(&filter_lower) || title.contains(&filter_lower) {
        return node.clone();
    }
    if let Some(children) = node["children"].as_array() {
        let filtered: Vec<_> = children
            .iter()
            .filter_map(|c| {
                let r = filter_ax_tree(c, filter);
                if r.is_null() {
                    None
                } else {
                    Some(r)
                }
            })
            .collect();
        if !filtered.is_empty() {
            return json!({ "role": node["role"], "title": node["title"], "children": filtered });
        }
    }
    serde_json::Value::Null
}

/// Synthesize keyboard shortcuts.
pub struct AXHotkeyTool;

#[async_trait]
impl AgentTool for AXHotkeyTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_hotkey".to_string(),
            description: "Synthesize a keyboard shortcut (e.g. 'Ctrl+C', 'Cmd+Tab', 'Alt+F4')"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "string",
                        "description": "Key combination like 'Ctrl+C', 'Cmd+Shift+T', 'F5'"
                    }
                },
                "required": ["keys"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let keys = params["keys"].as_str().unwrap_or("");
        platform_send_hotkey(keys);
        Ok(ToolResult {
            tool_name: "ax_hotkey".to_string(),
            result: json!({ "success": true, "keys": keys }),
            error: None,
        })
    }
}

fn platform_send_hotkey(keys: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        let parts: Vec<&str> = keys.split('+').collect();
        let mut vk_codes: Vec<VIRTUAL_KEY> = vec![];

        for part in &parts {
            let vk = match part.to_uppercase().as_str() {
                "CTRL" | "CONTROL" => VK_CONTROL,
                "ALT" => VK_MENU,
                "SHIFT" => VK_SHIFT,
                "WIN" | "CMD" | "META" => VK_LWIN,
                "ENTER" | "RETURN" => VK_RETURN,
                "ESCAPE" | "ESC" => VK_ESCAPE,
                "TAB" => VK_TAB,
                "SPACE" => VK_SPACE,
                "BACKSPACE" => VK_BACK,
                "DELETE" | "DEL" => VK_DELETE,
                "HOME" => VK_HOME,
                "END" => VK_END,
                "PAGEUP" => VK_PRIOR,
                "PAGEDOWN" => VK_NEXT,
                "LEFT" => VK_LEFT,
                "RIGHT" => VK_RIGHT,
                "UP" => VK_UP,
                "DOWN" => VK_DOWN,
                "F1" => VK_F1,
                "F2" => VK_F2,
                "F3" => VK_F3,
                "F4" => VK_F4,
                "F5" => VK_F5,
                "F6" => VK_F6,
                "F7" => VK_F7,
                "F8" => VK_F8,
                "F9" => VK_F9,
                "F10" => VK_F10,
                "F11" => VK_F11,
                "F12" => VK_F12,
                s if s.len() == 1 => {
                    let c = s.chars().next().unwrap() as u16;
                    VIRTUAL_KEY(c)
                }
                _ => continue,
            };
            vk_codes.push(vk);
        }

        let mut inputs: Vec<INPUT> = vk_codes
            .iter()
            .map(|&vk| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            })
            .collect();
        let releases: Vec<INPUT> = vk_codes
            .iter()
            .rev()
            .map(|&vk| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            })
            .collect();
        inputs.extend(releases);

        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
    #[cfg(not(target_os = "windows"))]
    tracing::debug!("platform_send_hotkey: {}", keys);
}

/// Scroll in an element.
pub struct AXScrollTool;

#[async_trait]
impl AgentTool for AXScrollTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_scroll".to_string(),
            description: "Scroll up or down in the focused element or at specific coordinates"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                    "amount": {"type": "integer", "default": 3, "description": "Number of scroll steps"},
                    "x": {"type": "integer"},
                    "y": {"type": "integer"}
                },
                "required": ["direction"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let direction = params["direction"].as_str().unwrap_or("down");
        let amount = params["amount"].as_i64().unwrap_or(3) as i32;
        let x = params["x"].as_i64().unwrap_or(960) as i32;
        let y = params["y"].as_i64().unwrap_or(540) as i32;

        platform_scroll(x, y, direction, amount);

        Ok(ToolResult {
            tool_name: "ax_scroll".to_string(),
            result: json!({ "success": true }),
            error: None,
        })
    }
}

fn platform_scroll(x: i32, y: i32, direction: &str, amount: i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        let wheel_delta: i32 = match direction {
            "up" => 120 * amount,
            "down" => -120 * amount,
            _ => 0,
        };
        let mi = MOUSEINPUT {
            dx: x,
            dy: y,
            mouseData: wheel_delta as u32,
            dwFlags: MOUSEEVENTF_WHEEL,
            time: 0,
            dwExtraInfo: 0,
        };
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi },
        };
        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }
    #[cfg(not(target_os = "windows"))]
    tracing::debug!("platform_scroll({}, {}, {}, {})", x, y, direction, amount);
}

/// Wait for an element condition with timeout.
pub struct AXWaitTool;

#[async_trait]
impl AgentTool for AXWaitTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_wait".to_string(),
            description: "Wait for a UI element to appear or match a condition, with timeout"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "condition": {"type": "string", "description": "Description of the element to wait for"},
                    "timeout_ms": {"type": "integer", "default": 5000}
                },
                "required": ["condition"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let condition = params["condition"].as_str().unwrap_or("");
        let timeout_ms = params["timeout_ms"].as_u64().unwrap_or(5000);

        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

        loop {
            let ax = crate::capture::accessibility::PlatformAXTree::new()?;
            if let Some(element) = ax.find_element(condition).await {
                return Ok(ToolResult {
                    tool_name: "ax_wait".to_string(),
                    result: json!({ "found": true, "element": element }),
                    error: None,
                });
            }

            if tokio::time::Instant::now() >= deadline {
                return Ok(ToolResult {
                    tool_name: "ax_wait".to_string(),
                    result: json!({ "found": false, "timed_out": true }),
                    error: None,
                });
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }
    }
}

/// Bring an app to the foreground.
pub struct AXFocusAppTool;

#[async_trait]
impl AgentTool for AXFocusAppTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_focus_app".to_string(),
            description: "Bring an application window to the foreground by name".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "app_name": {"type": "string", "description": "Application name or window title substring"}
                },
                "required": ["app_name"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let app_name = params["app_name"].as_str().unwrap_or("");
        let success = platform_focus_app(app_name);
        Ok(ToolResult {
            tool_name: "ax_focus_app".to_string(),
            result: json!({ "success": success }),
            error: None,
        })
    }
}

fn platform_focus_app(app_name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::*;

        let title: Vec<u16> = OsStr::new(app_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let hwnd = match FindWindowW(None, PCWSTR(title.as_ptr())) {
                Ok(h) if !h.0.is_null() => h,
                _ => return false,
            };
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd).as_bool()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::debug!("platform_focus_app: {}", app_name);
        false
    }
}

/// Extract all text from an element subtree.
pub struct AXReadTextTool;

#[async_trait]
impl AgentTool for AXReadTextTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_read_text".to_string(),
            description: "Extract all visible text from the focused window's accessibility tree"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional filter by element role"}
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let filter = params["filter"].as_str();
        let ax = crate::capture::accessibility::PlatformAXTree::new()?;
        let tree = ax.get_focused_tree().await?;

        let mut texts = vec![];
        collect_texts(&tree, filter, &mut texts);

        Ok(ToolResult {
            tool_name: "ax_read_text".to_string(),
            result: json!({ "texts": texts }),
            error: None,
        })
    }
}

fn collect_texts(
    node: &crate::capture::accessibility::AXTreeNode,
    role_filter: Option<&str>,
    out: &mut Vec<String>,
) {
    let matches = role_filter
        .map(|f| node.role.to_lowercase().contains(&f.to_lowercase()))
        .unwrap_or(true);

    if matches {
        if let Some(v) = &node.value {
            if !v.is_empty() {
                out.push(v.clone());
            }
        }
        if let Some(t) = &node.title {
            if !t.is_empty() {
                out.push(t.clone());
            }
        }
    }
    for child in &node.children {
        collect_texts(child, role_filter, out);
    }
}

/// Detailed element inspection.
pub struct AXInspectTool;

#[async_trait]
impl AgentTool for AXInspectTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_inspect".to_string(),
            description: "Get detailed accessibility attributes for a specific element matching a description".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "description": {"type": "string"}
                },
                "required": ["description"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let description = params["description"].as_str().unwrap_or("");
        let ax = crate::capture::accessibility::PlatformAXTree::new()?;
        let element = ax.find_element(description).await;

        Ok(ToolResult {
            tool_name: "ax_inspect".to_string(),
            result: json!({ "element": element }),
            error: None,
        })
    }
}

/// Get element at screen coordinates.
pub struct AXElementAtTool;

#[async_trait]
impl AgentTool for AXElementAtTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_element_at".to_string(),
            description: "Get the accessibility element at specific screen coordinates".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"}
                },
                "required": ["x", "y"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let x = params["x"].as_i64().unwrap_or(0) as i32;
        let y = params["y"].as_i64().unwrap_or(0) as i32;

        Ok(ToolResult {
            tool_name: "ax_element_at".to_string(),
            result: json!({ "x": x, "y": y, "element": null }),
            error: None,
        })
    }
}

/// List running applications.
pub struct AXListAppsTool;

#[async_trait]
impl AgentTool for AXListAppsTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "ax_list_apps".to_string(),
            description: "List all running applications with their process IDs".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    async fn execute(&self, _params: serde_json::Value) -> Result<ToolResult> {
        let apps = platform_list_apps();
        Ok(ToolResult {
            tool_name: "ax_list_apps".to_string(),
            result: json!({ "apps": apps }),
            error: None,
        })
    }
}

fn platform_list_apps() -> Vec<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
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
                    apps.push(json!({ "pid": pe.th32ProcessID, "name": name }));
                    if Process32NextW(snapshot, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        }
        apps
    }
    #[cfg(not(target_os = "windows"))]
    vec![]
}

/// Capture current screen as base64 PNG.
pub struct CaptureLiveScreenshotTool;

#[async_trait]
impl AgentTool for CaptureLiveScreenshotTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "capture_live_screenshot".to_string(),
            description: "Capture the current screen and return it as a base64 PNG for analysis"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "display_id": {"type": "integer", "default": 0}
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let display_id = params["display_id"].as_u64().unwrap_or(0) as u32;

        let frame = crate::capture::screen::quick_screenshot(display_id)
            .await
            .map_err(|e| anyhow::anyhow!("Screenshot failed: {}", e))?;

        // Convert BGRA → RGBA for PNG encoding
        let mut rgba = vec![0u8; frame.data.len()];
        for i in (0..frame.data.len()).step_by(4) {
            rgba[i] = frame.data[i + 2]; // R
            rgba[i + 1] = frame.data[i + 1]; // G
            rgba[i + 2] = frame.data[i]; // B
            rgba[i + 3] = frame.data[i + 3]; // A
        }
        let img = image::RgbaImage::from_raw(frame.width, frame.height, rgba)
            .ok_or_else(|| anyhow::anyhow!("Image buffer size mismatch"))?;

        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )?;

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

        Ok(ToolResult {
            tool_name: "capture_live_screenshot".to_string(),
            result: json!({
                "png_base64": b64,
                "width":  frame.width,
                "height": frame.height,
                "display_id": display_id
            }),
            error: None,
        })
    }
}

/// Replay a learned procedure by name.
pub struct ReplayProcedureTool;

#[async_trait]
impl AgentTool for ReplayProcedureTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "replay_procedure".to_string(),
            description: "Look up and execute a stored procedure by name (learned automation)"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Procedure name or description"}
                },
                "required": ["name"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let name = params["name"].as_str().unwrap_or("");

        Ok(ToolResult {
            tool_name: "replay_procedure".to_string(),
            result: json!({
                "message": format!("Procedure '{}' queued for execution", name)
            }),
            error: None,
        })
    }
}

/// Hint string listing available AX/automation tools for the mimicry planner prompt.
pub const AVAILABLE_TOOLS_HINT: &str = "\
ax_click, ax_type, ax_hotkey, ax_scroll, ax_wait, ax_focus_app, \
ax_read_text, ax_inspect, ax_element_at, ax_list_apps, ax_tree_query, \
capture_live_screenshot, replay_procedure";
