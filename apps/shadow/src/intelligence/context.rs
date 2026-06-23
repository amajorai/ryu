use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::utils::wall_micros;

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

/// A 5-minute activity window that represents a focused work episode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodeRecord {
    pub id: String,
    pub start_us: u64,
    pub end_us: u64,
    pub app_name: String,
    pub window_title: String,
    pub actions: Vec<String>,
    pub summary: String,
    pub bundle_id: Option<String>,
}

/// Daily summary aggregated from episodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailySummary {
    pub date: String,
    pub top_apps: Vec<AppUsage>,
    pub total_active_ms: u64,
    pub episode_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUsage {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub duration_ms: u64,
    pub percentage: f32,
}

/// SQLite-backed store for persisting synthesized episode records.
pub struct EpisodeStore {
    conn: rusqlite::Connection,
}

impl EpisodeStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))?;
        let conn = rusqlite::Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY,
                start_us INTEGER NOT NULL,
                end_us INTEGER NOT NULL,
                app_name TEXT NOT NULL,
                window_title TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_episodes_start ON episodes(start_us DESC);
            CREATE TABLE IF NOT EXISTS context_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        Ok(Self { conn })
    }

    pub fn save(&self, ep: &EpisodeRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO episodes \
             (id, start_us, end_us, app_name, window_title, summary, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                ep.id,
                ep.start_us as i64,
                ep.end_us as i64,
                ep.app_name,
                ep.window_title,
                ep.summary,
                wall_micros() as i64,
            ],
        )?;
        Ok(())
    }

    pub fn load_recent(&self, n: usize) -> Result<Vec<EpisodeRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, start_us, end_us, app_name, window_title, summary \
             FROM episodes ORDER BY start_us DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([n as i64], |row| {
                Ok(EpisodeRecord {
                    id: row.get(0)?,
                    start_us: row.get::<_, i64>(1)? as u64,
                    end_us: row.get::<_, i64>(2)? as u64,
                    app_name: row.get(3)?,
                    window_title: row.get(4)?,
                    actions: vec![],
                    summary: row.get(5)?,
                    bundle_id: None,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn last_synth_timestamp(&self) -> Result<u64> {
        let result = self
            .conn
            .query_row(
                "SELECT value FROM context_meta WHERE key = 'last_synth'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(result.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0))
    }

    pub fn set_last_synth_timestamp(&self, ts: u64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO context_meta (key, value) VALUES ('last_synth', ?1)",
            [ts.to_string()],
        )?;
        Ok(())
    }
}

/// Builds EpisodeRecords from raw timeline events using 5-minute activity windows.
pub struct ContextSynthesizer {
    episode_store: Option<Arc<Mutex<EpisodeStore>>>,
    orchestrator: Option<Arc<LlmOrchestrator>>,
}

impl ContextSynthesizer {
    pub fn new() -> Self {
        Self {
            episode_store: None,
            orchestrator: None,
        }
    }

    pub fn with_store(store: Arc<Mutex<EpisodeStore>>, orchestrator: Arc<LlmOrchestrator>) -> Self {
        Self {
            episode_store: Some(store),
            orchestrator: Some(orchestrator),
        }
    }

    /// Build episodes from timeline entries in a time range.
    /// Groups consecutive entries by app with 5-minute windows.
    pub fn build_episodes(&self, start_us: u64, end_us: u64) -> Result<Vec<EpisodeRecord>> {
        let entries = shadow_core::query_time_range(start_us, end_us)?;

        if entries.is_empty() {
            return Ok(vec![]);
        }

        const EPISODE_WINDOW_US: u64 = 5 * 60 * 1_000_000; // 5 minutes

        let mut episodes: Vec<EpisodeRecord> = vec![];
        let mut current_app = String::new();
        let mut episode_start = 0u64;
        let mut episode_end = 0u64;
        let mut episode_actions: Vec<String> = vec![];
        let mut episode_title = String::new();

        for entry in &entries {
            let ts = entry.ts;
            let app = entry.app_name.as_deref().unwrap_or("").to_string();
            let title = entry.window_title.as_deref().unwrap_or("").to_string();

            if current_app.is_empty() {
                current_app = app.clone();
                episode_start = ts;
                episode_end = ts;
                episode_title = title.clone();
            } else if app != current_app || ts - episode_end > EPISODE_WINDOW_US {
                // Close current episode
                if !current_app.is_empty() && episode_end > episode_start {
                    episodes.push(EpisodeRecord {
                        id: uuid::Uuid::new_v4().to_string(),
                        start_us: episode_start,
                        end_us: episode_end,
                        app_name: current_app.clone(),
                        window_title: episode_title.clone(),
                        actions: episode_actions.clone(),
                        summary: fallback_summary(&current_app, episode_start, episode_end),
                        bundle_id: None,
                    });
                }

                current_app = app.clone();
                episode_start = ts;
                episode_end = ts;
                episode_title = title.clone();
                episode_actions.clear();
            } else {
                episode_end = ts;
                episode_title = title.clone();
            }

            episode_actions.push(format!("{}: {}", app, title));
        }

        // Close last episode
        if !current_app.is_empty() && episode_end > episode_start {
            episodes.push(EpisodeRecord {
                id: uuid::Uuid::new_v4().to_string(),
                start_us: episode_start,
                end_us: episode_end,
                app_name: current_app.clone(),
                window_title: episode_title,
                actions: episode_actions,
                summary: fallback_summary(&current_app, episode_start, episode_end),
                bundle_id: None,
            });
        }

        Ok(episodes)
    }

    /// Build daily summary for a given date string (YYYY-MM-DD).
    pub fn build_daily_summary(&self, date: &str) -> Result<DailySummary> {
        let blocks = shadow_core::get_day_summary(date.to_string())?;

        let mut app_durations: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        let mut total_ms = 0u64;

        for block in &blocks {
            let duration_ms = (block.end_ts.saturating_sub(block.start_ts)) / 1_000;
            *app_durations.entry(block.app_name.clone()).or_insert(0) += duration_ms;
            total_ms += duration_ms;
        }

        let mut top_apps: Vec<AppUsage> = app_durations
            .into_iter()
            .map(|(app_name, duration_ms)| {
                let percentage = if total_ms > 0 {
                    duration_ms as f32 / total_ms as f32 * 100.0
                } else {
                    0.0
                };
                AppUsage {
                    app_name,
                    bundle_id: None,
                    duration_ms,
                    percentage,
                }
            })
            .collect();

        top_apps.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
        top_apps.truncate(10);

        Ok(DailySummary {
            date: date.to_string(),
            top_apps,
            total_active_ms: total_ms,
            episode_count: blocks.len() as u32,
        })
    }

    /// Synthesize a 1-sentence LLM narrative for an episode's actions.
    /// Falls back to the simple "Used X for Ys" string when LLM is unavailable.
    pub async fn synthesize_episode_llm(&self, app_name: &str, actions: &[String]) -> String {
        let Some(orchestrator) = &self.orchestrator else {
            return fallback_summary_from_actions(app_name, actions);
        };

        if actions.is_empty() {
            return fallback_summary_from_actions(app_name, actions);
        }

        let actions_text = actions[..actions.len().min(20)].join(", ");

        let prompt = format!("Summarize this activity in one sentence: {}", actions_text);

        match orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                max_tokens: 60,
                temperature: 0.3,
                ..Default::default()
            })
            .await
        {
            Ok(resp) => resp
                .content
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| fallback_summary_from_actions(app_name, actions)),
            Err(_) => fallback_summary_from_actions(app_name, actions),
        }
    }

    /// Build episodes for a time window, synthesize LLM summaries, and save to the store.
    /// Called from the proactive deep tick.
    pub async fn refresh_and_store_episodes(
        &self,
        start_us: u64,
        end_us: u64,
    ) -> Result<Vec<EpisodeRecord>> {
        let mut episodes = self.build_episodes(start_us, end_us)?;

        for ep in &mut episodes {
            ep.summary = self.synthesize_episode_llm(&ep.app_name, &ep.actions).await;
        }

        if let Some(store) = &self.episode_store {
            if let Ok(guard) = store.lock() {
                let now = wall_micros();
                for ep in &episodes {
                    if let Err(e) = guard.save(ep) {
                        tracing::warn!("Failed to save episode to store: {}", e);
                    }
                }
                let _ = guard.set_last_synth_timestamp(now);
            }
        }

        Ok(episodes)
    }

    /// Get the N most recent episodes.
    /// Tries the persistent store first; falls back to building from the raw timeline.
    pub fn get_recent_episodes(&self, n: usize) -> Result<Vec<EpisodeRecord>> {
        if let Some(store) = &self.episode_store {
            if let Ok(guard) = store.lock() {
                if let Ok(episodes) = guard.load_recent(n) {
                    if !episodes.is_empty() {
                        return Ok(episodes);
                    }
                }
            }
        }

        // Fallback: build from raw timeline
        let now = wall_micros();
        let lookback = now.saturating_sub(2 * 60 * 60 * 1_000_000); // 2 hours
        let episodes = self.build_episodes(lookback, now)?;
        Ok(episodes.into_iter().rev().take(n).collect())
    }
}

fn fallback_summary(app: &str, start_us: u64, end_us: u64) -> String {
    format!("Used {} for {}s", app, (end_us - start_us) / 1_000_000)
}

fn fallback_summary_from_actions(app_name: &str, actions: &[String]) -> String {
    format!("Used {} ({} actions)", app_name, actions.len())
}

impl Default for ContextSynthesizer {
    fn default() -> Self {
        Self::new()
    }
}
