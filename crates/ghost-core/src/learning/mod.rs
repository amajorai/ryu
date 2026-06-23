// Learning session: tracks recording state and collected action events.
// Platform hook management is handled by the caller (apps/ghost or apps/shadow).

use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

/// Maximum learning session duration.
pub const MAX_SESSION_DURATION: Duration = Duration::from_secs(10 * 60); // 10 minutes

/// A single learned action event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedEvent {
    /// Milliseconds since session start.
    pub ts_ms: u64,
    /// Event type: click, type, hotkey, scroll, app_switch.
    pub event_type: String,
    /// For clicks: screen coordinates.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// For key events: the key or text typed.
    pub key: Option<String>,
    /// AX element info enriched at capture time.
    pub element_role: Option<String>,
    pub element_name: Option<String>,
    pub element_id: Option<String>,
    pub app_name: Option<String>,
}

/// Learning session status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Idle,
    Recording,
    Stopped,
}

struct SessionInner {
    status: SessionStatus,
    task_description: Option<String>,
    started_at: Option<Instant>,
    events: Vec<LearnedEvent>,
}

/// Thread-safe learning session.
pub struct LearningSession {
    inner: Mutex<SessionInner>,
}

impl Default for LearningSession {
    fn default() -> Self {
        Self::new()
    }
}

impl LearningSession {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SessionInner {
                status: SessionStatus::Idle,
                task_description: None,
                started_at: None,
                events: vec![],
            }),
        }
    }

    pub fn start(&self, task_description: Option<String>) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        if g.status == SessionStatus::Recording {
            return Err("Already recording".to_string());
        }
        g.status = SessionStatus::Recording;
        g.task_description = task_description;
        g.started_at = Some(Instant::now());
        g.events.clear();
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<LearnedEvent>, String> {
        let mut g = self.inner.lock().unwrap();
        if g.status != SessionStatus::Recording {
            return Err("Not recording".to_string());
        }
        g.status = SessionStatus::Stopped;
        Ok(g.events.clone())
    }

    pub fn push_event(&self, event: LearnedEvent) {
        let mut g = self.inner.lock().unwrap();
        if g.status != SessionStatus::Recording {
            return;
        }
        // Hard limit: stop if session has been running too long
        if let Some(started) = g.started_at {
            if started.elapsed() > MAX_SESSION_DURATION {
                g.status = SessionStatus::Stopped;
                return;
            }
        }
        g.events.push(event);
    }

    pub fn status(&self) -> SessionStatus {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn event_count(&self) -> usize {
        self.inner.lock().unwrap().events.len()
    }

    pub fn elapsed_secs(&self) -> u64 {
        let g = self.inner.lock().unwrap();
        g.started_at
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0)
    }

    pub fn task_description(&self) -> Option<String> {
        self.inner.lock().unwrap().task_description.clone()
    }
}
