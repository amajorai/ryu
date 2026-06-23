use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};
use crate::utils::wall_micros;

/// A candidate meeting window detected from audio/activity overlap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingWindow {
    pub start_us: u64,
    pub end_us: u64,
    pub app_name: String,
    pub confidence: f32,
}

/// Full structured meeting summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSummary {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub open_questions: Vec<String>,
    pub highlights: Vec<String>,
    pub participants: Vec<String>,
    pub start_us: u64,
    pub end_us: u64,
    pub app_name: String,
    pub created_at: u64,
    pub transcript_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub description: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
}

/// Detects meeting windows from timeline activity.
pub struct MeetingResolver;

impl MeetingResolver {
    pub fn find_meetings(&self, start_us: u64, end_us: u64) -> Result<Vec<MeetingWindow>> {
        let entries = shadow_core::query_time_range(start_us, end_us)?;

        let meeting_apps = [
            "zoom", "meet", "teams", "webex", "skype", "slack", "discord", "facetime", "telegram",
            "signal",
        ];

        let mut meetings = vec![];
        let mut current_meeting: Option<(u64, String)> = None;

        for entry in &entries {
            let app = entry.app_name.as_deref().unwrap_or("");
            let app_lower = app.to_lowercase();
            let is_meeting = meeting_apps.iter().any(|&m| app_lower.contains(m));

            if is_meeting {
                match &current_meeting {
                    None => {
                        current_meeting = Some((entry.ts, app.to_string()));
                    }
                    Some((start, cur_app)) => {
                        if app != cur_app {
                            // Different meeting app — close current
                            meetings.push(MeetingWindow {
                                start_us: *start,
                                end_us: entry.ts,
                                app_name: cur_app.clone(),
                                confidence: 0.85,
                            });
                            current_meeting = Some((entry.ts, app.to_string()));
                        }
                        // else: continue the same meeting
                    }
                }
            } else if let Some((start, cur_app)) = current_meeting.take() {
                // Meeting ended
                meetings.push(MeetingWindow {
                    start_us: start,
                    end_us: entry.ts,
                    app_name: cur_app,
                    confidence: 0.85,
                });
            }
        }

        // Close any open meeting
        if let Some((start, app)) = current_meeting {
            meetings.push(MeetingWindow {
                start_us: start,
                end_us: end_us,
                app_name: app,
                confidence: 0.85,
            });
        }

        Ok(meetings)
    }
}

/// Summarizes meetings using LLM + transcript.
pub struct MeetingSummarizer {
    orchestrator: Arc<LlmOrchestrator>,
}

impl MeetingSummarizer {
    pub fn new(orchestrator: Arc<LlmOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub async fn summarize(&self, window: &MeetingWindow) -> Result<MeetingSummary> {
        // Gather timeline context for the meeting window
        let entries = shadow_core::query_time_range(window.start_us, window.end_us)?;
        let context: Vec<String> = entries
            .iter()
            .map(|e| {
                format!(
                    "[{}] {}: {}",
                    e.ts / 1_000_000,
                    e.app_name.as_deref().unwrap_or(""),
                    e.window_title.as_deref().unwrap_or(""),
                )
            })
            .collect();

        let context_str = context.join("\n");
        let duration_min = (window.end_us - window.start_us) / 60_000_000;

        let prompt = format!(
            "You are summarizing a meeting that took place in {}.\n\
             Duration: ~{} minutes.\n\
             Activity log:\n{}\n\n\
             Generate a structured meeting summary. Respond with JSON matching this schema:\n\
             {{\n\
               \"title\": \"Brief meeting title\",\n\
               \"summary\": \"2-3 sentence overview\",\n\
               \"key_points\": [\"point1\", ...],\n\
               \"decisions\": [\"decision1\", ...],\n\
               \"action_items\": [{{\"description\": \"...\", \"owner\": null, \"due_date\": null}}, ...],\n\
               \"open_questions\": [\"question1\", ...],\n\
               \"highlights\": [\"highlight1\", ...],\n\
               \"participants\": []\n\
             }}",
            window.app_name,
            duration_min,
            context_str.chars().take(3000).collect::<String>()
        );

        let response = self
            .orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                temperature: 0.3,
                max_tokens: 1024,
                ..Default::default()
            })
            .await?;

        let content = response.content.unwrap_or_default();
        let json_str = extract_json_object(&content).unwrap_or_else(|| "{}".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap_or_default();

        // Compute a transcript hash for dedup
        let hash = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(context_str.as_bytes());
            format!("{:x}", hasher.finalize())
        };

        let now = wall_micros();
        Ok(MeetingSummary {
            id: uuid::Uuid::new_v4().to_string(),
            title: parsed["title"].as_str().unwrap_or("Meeting").to_string(),
            summary: parsed["summary"].as_str().unwrap_or("").to_string(),
            key_points: json_array_of_strings(&parsed["key_points"]),
            decisions: json_array_of_strings(&parsed["decisions"]),
            action_items: parse_action_items(&parsed["action_items"]),
            open_questions: json_array_of_strings(&parsed["open_questions"]),
            highlights: json_array_of_strings(&parsed["highlights"]),
            participants: json_array_of_strings(&parsed["participants"]),
            start_us: window.start_us,
            end_us: window.end_us,
            app_name: window.app_name.clone(),
            created_at: now,
            transcript_hash: hash,
        })
    }
}

fn json_array_of_strings(val: &serde_json::Value) -> Vec<String> {
    val.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_action_items(val: &serde_json::Value) -> Vec<ActionItem> {
    val.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    Some(ActionItem {
                        description: v["description"].as_str()?.to_string(),
                        owner: v["owner"].as_str().map(|s| s.to_string()),
                        due_date: v["due_date"].as_str().map(|s| s.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    // Find the matching closing brace
    let bytes = s[start..].as_bytes();
    let mut depth = 0i32;
    let mut end = start;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    if end > start {
        Some(s[start..=end].to_string())
    } else {
        None
    }
}

/// SQLite-backed store for meeting summaries.
pub struct SummaryStore {
    conn: rusqlite::Connection,
}

impl SummaryStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        let conn = rusqlite::Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meeting_summaries (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                key_points TEXT NOT NULL DEFAULT '[]',
                decisions TEXT NOT NULL DEFAULT '[]',
                action_items TEXT NOT NULL DEFAULT '[]',
                open_questions TEXT NOT NULL DEFAULT '[]',
                highlights TEXT NOT NULL DEFAULT '[]',
                participants TEXT NOT NULL DEFAULT '[]',
                start_us INTEGER NOT NULL,
                end_us INTEGER NOT NULL,
                app_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                transcript_hash TEXT NOT NULL UNIQUE
            );",
        )?;
        Ok(Self { conn })
    }

    pub fn store(&self, summary: &MeetingSummary) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO meeting_summaries \
             (id, title, summary, key_points, decisions, action_items, open_questions, \
              highlights, participants, start_us, end_us, app_name, created_at, transcript_hash) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            rusqlite::params![
                summary.id,
                summary.title,
                summary.summary,
                serde_json::to_string(&summary.key_points).unwrap_or_default(),
                serde_json::to_string(&summary.decisions).unwrap_or_default(),
                serde_json::to_string(&summary.action_items).unwrap_or_default(),
                serde_json::to_string(&summary.open_questions).unwrap_or_default(),
                serde_json::to_string(&summary.highlights).unwrap_or_default(),
                serde_json::to_string(&summary.participants).unwrap_or_default(),
                summary.start_us as i64,
                summary.end_us as i64,
                summary.app_name,
                summary.created_at as i64,
                summary.transcript_hash,
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, limit: usize) -> Result<Vec<MeetingSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, key_points, decisions, action_items, open_questions, \
             highlights, participants, start_us, end_us, app_name, created_at, transcript_hash \
             FROM meeting_summaries ORDER BY created_at DESC LIMIT ?1",
        )?;

        let rows = stmt.query_map([limit as i64], |row| {
            Ok(MeetingSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                key_points: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                decisions: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                action_items: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                open_questions: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
                highlights: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                participants: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_default(),
                start_us: row.get::<_, i64>(9)? as u64,
                end_us: row.get::<_, i64>(10)? as u64,
                app_name: row.get(11)?,
                created_at: row.get::<_, i64>(12)? as u64,
                transcript_hash: row.get(13)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get(&self, id: &str) -> Result<Option<MeetingSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, key_points, decisions, action_items, open_questions, \
             highlights, participants, start_us, end_us, app_name, created_at, transcript_hash \
             FROM meeting_summaries WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map([id], |row| {
            Ok(MeetingSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                key_points: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                decisions: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                action_items: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                open_questions: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
                highlights: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                participants: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_default(),
                start_us: row.get::<_, i64>(9)? as u64,
                end_us: row.get::<_, i64>(10)? as u64,
                app_name: row.get(11)?,
                created_at: row.get::<_, i64>(12)? as u64,
                transcript_hash: row.get(13)?,
            })
        })?;

        Ok(rows.next().and_then(|r| r.ok()))
    }
}
