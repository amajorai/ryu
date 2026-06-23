use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Adaptive thresholds adjusted by user feedback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustParams {
    /// Minimum confidence to push a suggestion immediately.
    pub confidence_threshold: f32,
    /// Minimum score for inbox delivery (vs drop).
    pub inbox_threshold: f32,
    /// Score penalty per recent repetition of the same suggestion type.
    pub repetition_penalty: f32,
    /// Per-type cooldown in seconds (increased on dismissals).
    pub cooldown_by_type: HashMap<String, u64>,
    /// Per-type weight multiplier (increased on thumbs-up).
    pub preferred_types: HashMap<String, f32>,
}

impl Default for TrustParams {
    fn default() -> Self {
        Self {
            confidence_threshold: 0.82,
            inbox_threshold: 0.55,
            repetition_penalty: 0.05,
            cooldown_by_type: HashMap::new(),
            preferred_types: HashMap::new(),
        }
    }
}

/// How the user responded to a proactive suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackKind {
    ThumbsUp,
    ThumbsDown,
    Dismiss,
    Snooze,
}

/// Adjusts delivery parameters based on accumulated user feedback.
pub struct TrustTuner {
    params: TrustParams,
    persist_path: Option<std::path::PathBuf>,
}

impl TrustTuner {
    const CONFIDENCE_MIN: f32 = 0.40;
    const CONFIDENCE_MAX: f32 = 0.95;
    const INBOX_MIN: f32 = 0.20;
    const INBOX_MAX: f32 = 0.80;
    const REPETITION_MAX: f32 = 0.30;
    const COOLDOWN_INCREMENT_SECS: u64 = 15 * 60; // 15 min
    const COOLDOWN_CAP_SECS: u64 = 60 * 60; // 1 hr

    pub fn new() -> Self {
        Self {
            params: TrustParams::default(),
            persist_path: None,
        }
    }

    /// Load from JSON file, falling back to defaults on error.
    pub fn load(path: &std::path::Path) -> Self {
        let params = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            params,
            persist_path: Some(path.to_path_buf()),
        }
    }

    /// Current parameters (read-only snapshot).
    pub fn params(&self) -> &TrustParams {
        &self.params
    }

    /// Apply a feedback signal and optionally persist.
    pub fn apply_feedback(&mut self, kind: FeedbackKind, suggestion_type: &str) {
        match kind {
            FeedbackKind::ThumbsUp => {
                self.params.confidence_threshold =
                    (self.params.confidence_threshold - 0.02).max(Self::CONFIDENCE_MIN);
                // Boost preference weight for this type
                let weight = self
                    .params
                    .preferred_types
                    .entry(suggestion_type.to_string())
                    .or_insert(1.0);
                *weight = (*weight + 0.1).min(2.0);
            }
            FeedbackKind::ThumbsDown => {
                self.params.confidence_threshold =
                    (self.params.confidence_threshold + 0.03).min(Self::CONFIDENCE_MAX);
                self.params.repetition_penalty =
                    (self.params.repetition_penalty + 0.02).min(Self::REPETITION_MAX);
            }
            FeedbackKind::Dismiss | FeedbackKind::Snooze => {
                let cooldown = self
                    .params
                    .cooldown_by_type
                    .entry(suggestion_type.to_string())
                    .or_insert(0);
                *cooldown =
                    (*cooldown + Self::COOLDOWN_INCREMENT_SECS).min(Self::COOLDOWN_CAP_SECS);
            }
        }

        self.params.inbox_threshold = self
            .params
            .inbox_threshold
            .clamp(Self::INBOX_MIN, Self::INBOX_MAX);

        self.save_if_path();
    }

    /// Effective push threshold for a suggestion type (accounts for preference boost).
    pub fn push_threshold_for(&self, suggestion_type: &str) -> f32 {
        let base = self.params.confidence_threshold;
        let boost = self
            .params
            .preferred_types
            .get(suggestion_type)
            .copied()
            .unwrap_or(1.0);
        // Boost lowers the threshold (user prefers this type)
        (base / boost).max(Self::CONFIDENCE_MIN)
    }

    /// Returns the configured cooldown for this suggestion type (0 = none).
    pub fn cooldown_for(&self, suggestion_type: &str) -> u64 {
        self.params
            .cooldown_by_type
            .get(suggestion_type)
            .copied()
            .unwrap_or(0)
    }

    fn save_if_path(&self) {
        let _ = self.persist();
    }

    pub fn persist(&self) -> Result<()> {
        if let Some(path) = &self.persist_path {
            let json = serde_json::to_string_pretty(&self.params)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, json)?;
        }
        Ok(())
    }
}

impl Default for TrustTuner {
    fn default() -> Self {
        Self::new()
    }
}
