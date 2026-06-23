// Learning mode — records user actions for recipe synthesis.
// Uses a global LearningSession + ghost-eyes input monitor.

use anyhow::Result;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

use ghost_core::learning::{LearnedEvent, LearningSession, SessionStatus};
use ghost_eyes::{AXTree, InputEvent, InputMonitor, PlatformAXTree, PlatformInputMonitor, PlatformWindowTracker, WindowTracker};

use super::str_param;

// Global learning session shared across tool calls within an MCP session.
static LEARNING: OnceLock<Arc<LearningSession>> = OnceLock::new();
static MONITOR: OnceLock<Arc<Mutex<PlatformInputMonitor>>> = OnceLock::new();

fn session() -> &'static Arc<LearningSession> {
    LEARNING.get_or_init(|| Arc::new(LearningSession::new()))
}

pub async fn ghost_learn_start(params: Value) -> Result<Value> {
    let task_desc = str_param(&params, "task_description").map(|s| s.to_string());

    session().start(task_desc.clone())
        .map_err(|e| anyhow::anyhow!(e))?;

    // Start the input monitor
    let monitor_cell = MONITOR.get_or_init(|| {
        Arc::new(Mutex::new(PlatformInputMonitor::new().expect("InputMonitor")))
    });

    let session_ref = Arc::clone(session());
    {
        let mut mon = monitor_cell.lock().await;
        match mon.start().await {
            Ok(mut rx) => {
                tokio::spawn(async move {
                    let mut pending_text = String::new();
                    let mut last_key_time = tokio::time::Instant::now();
                    let flush_interval = tokio::time::Duration::from_millis(500);

                    let mut pending_scroll: Option<(i32, i32, i32, i32)> = None; // (x, y, dx, dy)
                    let mut last_scroll_time = tokio::time::Instant::now();
                    let scroll_flush = tokio::time::Duration::from_millis(300);

                    loop {
                        tokio::select! {
                            biased;

                            // Flush pending text after 500ms of no keystrokes
                            _ = tokio::time::sleep_until(last_key_time + flush_interval), if !pending_text.is_empty() => {
                                let text = std::mem::take(&mut pending_text);
                                session_ref.push_event(LearnedEvent {
                                    ts_ms: session_ref.elapsed_secs() * 1000,
                                    event_type: "typeText".to_string(),
                                    x: None, y: None,
                                    key: Some(text),
                                    element_role: None, element_name: None,
                                    element_id: None, app_name: None,
                                });
                            }

                            // Flush accumulated scroll after 300ms of no scroll events
                            _ = tokio::time::sleep_until(last_scroll_time + scroll_flush), if pending_scroll.is_some() => {
                                if let Some((sx, sy, dx, dy)) = pending_scroll.take() {
                                    let dir = if dy > 0 { "down" } else if dy < 0 { "up" }
                                              else if dx > 0 { "right" } else { "left" };
                                    session_ref.push_event(LearnedEvent {
                                        ts_ms: session_ref.elapsed_secs() * 1000,
                                        event_type: "scroll".to_string(),
                                        x: Some(sx), y: Some(sy),
                                        key: Some(dir.to_string()),
                                        element_role: None, element_name: None,
                                        element_id: None, app_name: None,
                                    });
                                }
                            }

                            maybe_event = rx.recv() => {
                                let Some(event) = maybe_event else { break };
                                if session_ref.status() != SessionStatus::Recording { break; }

                                match &event {
                                    InputEvent::KeyDown { vk_code } => {
                                        if let Some(ch) = vk_to_char(*vk_code) {
                                            pending_text.push(ch);
                                            last_key_time = tokio::time::Instant::now();
                                        } else if let Some(name) = vk_to_key_name(*vk_code) {
                                            // Flush any pending text before emitting the special key
                                            if !pending_text.is_empty() {
                                                let text = std::mem::take(&mut pending_text);
                                                session_ref.push_event(LearnedEvent {
                                                    ts_ms: session_ref.elapsed_secs() * 1000,
                                                    event_type: "typeText".to_string(),
                                                    x: None, y: None,
                                                    key: Some(text),
                                                    element_role: None, element_name: None,
                                                    element_id: None, app_name: None,
                                                });
                                            }
                                            session_ref.push_event(LearnedEvent {
                                                ts_ms: session_ref.elapsed_secs() * 1000,
                                                event_type: "press".to_string(),
                                                x: None, y: None,
                                                key: Some(name.to_string()),
                                                element_role: None, element_name: None,
                                                element_id: None, app_name: None,
                                            });
                                        }
                                        // ignore unmapped VK codes (modifier keys, etc.)
                                    }

                                    InputEvent::Scroll { x, y, delta_x, delta_y } => {
                                        // Flush pending text first
                                        if !pending_text.is_empty() {
                                            let text = std::mem::take(&mut pending_text);
                                            session_ref.push_event(LearnedEvent {
                                                ts_ms: session_ref.elapsed_secs() * 1000,
                                                event_type: "typeText".to_string(),
                                                x: None, y: None,
                                                key: Some(text),
                                                element_role: None, element_name: None,
                                                element_id: None, app_name: None,
                                            });
                                        }
                                        // Accumulate scroll deltas
                                        match pending_scroll.as_mut() {
                                            Some(s) => { s.2 += delta_x; s.3 += delta_y; }
                                            None => { pending_scroll = Some((*x, *y, *delta_x, *delta_y)); }
                                        }
                                        last_scroll_time = tokio::time::Instant::now();
                                    }

                                    _ => {
                                        // Non-key, non-scroll event: flush pending text and scroll first
                                        if !pending_text.is_empty() {
                                            let text = std::mem::take(&mut pending_text);
                                            session_ref.push_event(LearnedEvent {
                                                ts_ms: session_ref.elapsed_secs() * 1000,
                                                event_type: "typeText".to_string(),
                                                x: None, y: None,
                                                key: Some(text),
                                                element_role: None, element_name: None,
                                                element_id: None, app_name: None,
                                            });
                                        }
                                        if let Some((sx, sy, dx, dy)) = pending_scroll.take() {
                                            let dir = if dy > 0 { "down" } else if dy < 0 { "up" }
                                                      else if dx > 0 { "right" } else { "left" };
                                            session_ref.push_event(LearnedEvent {
                                                ts_ms: session_ref.elapsed_secs() * 1000,
                                                event_type: "scroll".to_string(),
                                                x: Some(sx), y: Some(sy),
                                                key: Some(dir.to_string()),
                                                element_role: None, element_name: None,
                                                element_id: None, app_name: None,
                                            });
                                        }
                                        if let Some(e) = raw_to_learned(&event, session_ref.elapsed_secs()).await {
                                            session_ref.push_event(e);
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }
            Err(e) => tracing::warn!("Input monitor start failed: {e}"),
        }
    }

    Ok(json!({
        "recording": true,
        "task_description": task_desc,
        "message": "Learning mode started. Perform your task, then call ghost_learn_stop."
    }))
}

pub async fn ghost_learn_stop(_params: Value) -> Result<Value> {
    let events = session().stop().map_err(|e| anyhow::anyhow!(e))?;

    // Stop the input monitor
    if let Some(mon) = MONITOR.get() {
        let _ = mon.lock().await.stop().await;
    }

    let event_values: Vec<Value> = events.iter().map(|e| serde_json::to_value(e).unwrap_or_default()).collect();
    Ok(json!({
        "recording": false,
        "event_count": event_values.len(),
        "events": event_values,
        "suggestion": "Use ghost_recipe_save to save these actions as a reusable recipe."
    }))
}

pub async fn ghost_learn_status(_params: Value) -> Result<Value> {
    let s = session();
    Ok(json!({
        "status":      format!("{:?}", s.status()),
        "recording":   s.status() == SessionStatus::Recording,
        "event_count": s.event_count(),
        "elapsed_secs": s.elapsed_secs(),
        "task_description": s.task_description(),
    }))
}

async fn raw_to_learned(event: &InputEvent, elapsed_secs: u64) -> Option<LearnedEvent> {
    let ts_ms = elapsed_secs * 1000;
    match event {
        InputEvent::MouseDown { x, y, button } => {
            // Enrich with AX element at click coordinates
            let (element_role, element_name, element_id) =
                if let Ok(ax) = PlatformAXTree::new() {
                    if let Some(node) = ax.element_at(*x, *y).await {
                        (Some(node.role), node.title, node.identifier)
                    } else {
                        (None, None, None)
                    }
                } else {
                    (None, None, None)
                };

            // Enrich with app name from window tracker
            let app_name = if let Ok(tracker) = PlatformWindowTracker::new() {
                tracker.get_active_window().await.map(|w| w.app_name)
            } else {
                None
            };

            Some(LearnedEvent {
                ts_ms,
                event_type: format!("click.button{button}"),
                x: Some(*x), y: Some(*y),
                key: None,
                element_role, element_name, element_id, app_name,
            })
        }
        _ => None, // KeyDown handled by coalescer; Scroll handled by accumulator; others skipped
    }
}

// ─── VK code translation ──────────────────────────────────────────────────────

/// Convert a Windows VK code (or macOS CGKeyCode) to a printable character.
fn vk_to_char(vk: u32) -> Option<char> {
    match vk {
        65..=90 => Some((b'a' + (vk - 65) as u8) as char), // A-Z → a-z
        48..=57 => Some((b'0' + (vk - 48) as u8) as char), // 0-9
        32  => Some(' '),
        // OEM punctuation keys (US layout, unshifted)
        186 => Some(';'),
        187 => Some('='),
        188 => Some(','),
        189 => Some('-'),
        190 => Some('.'),
        191 => Some('/'),
        192 => Some('`'),
        219 => Some('['),
        220 => Some('\\'),
        221 => Some(']'),
        222 => Some('\''),
        _ => None,
    }
}

/// Convert a VK code to a named key string for press events.
fn vk_to_key_name(vk: u32) -> Option<&'static str> {
    match vk {
        8  => Some("backspace"),
        9  => Some("tab"),
        13 => Some("return"),
        27 => Some("escape"),
        33 => Some("pageup"),
        34 => Some("pagedown"),
        35 => Some("end"),
        36 => Some("home"),
        37 => Some("left"),
        38 => Some("up"),
        39 => Some("right"),
        40 => Some("down"),
        45 => Some("insert"),
        46 => Some("delete"),
        112 => Some("f1"),
        113 => Some("f2"),
        114 => Some("f3"),
        115 => Some("f4"),
        116 => Some("f5"),
        117 => Some("f6"),
        118 => Some("f7"),
        119 => Some("f8"),
        120 => Some("f9"),
        121 => Some("f10"),
        122 => Some("f11"),
        123 => Some("f12"),
        _  => None,
    }
}
