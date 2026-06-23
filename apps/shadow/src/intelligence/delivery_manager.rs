use std::sync::{Arc, Mutex};

use super::proactive::ProactiveSuggestion;
use super::trust_tuner::{FeedbackKind, TrustTuner};

/// How to deliver a suggestion to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryDecision {
    /// Surface immediately (push notification / overlay).
    Push,
    /// Store silently for user to browse later.
    Inbox,
    /// Discard — not worth showing.
    Drop,
}

/// Coordinates suggestion delivery and feedback recording.
pub struct DeliveryManager {
    trust: Arc<Mutex<TrustTuner>>,
    push_enabled: bool,
}

impl DeliveryManager {
    pub fn new(trust: Arc<Mutex<TrustTuner>>, push_enabled: bool) -> Self {
        Self {
            trust,
            push_enabled,
        }
    }

    /// Decide how to deliver a suggestion based on current trust parameters.
    pub fn deliver(&self, suggestion: &ProactiveSuggestion) -> DeliveryDecision {
        let type_str = suggestion.suggestion_type.as_str();

        let (push_threshold, inbox_threshold) = {
            if let Ok(tuner) = self.trust.lock() {
                let push = tuner.push_threshold_for(&type_str);
                let inbox = tuner.params().inbox_threshold;
                (push, inbox)
            } else {
                (0.82, 0.55)
            }
        };

        if !self.push_enabled {
            if suggestion.confidence >= inbox_threshold {
                return DeliveryDecision::Inbox;
            }
            return DeliveryDecision::Drop;
        }

        if suggestion.confidence >= push_threshold {
            DeliveryDecision::Push
        } else if suggestion.confidence >= inbox_threshold {
            DeliveryDecision::Inbox
        } else {
            DeliveryDecision::Drop
        }
    }

    /// Record user feedback, updating trust tuner parameters.
    pub fn record_feedback(&self, kind: FeedbackKind, suggestion_type: &str) {
        if let Ok(mut tuner) = self.trust.lock() {
            tuner.apply_feedback(kind, suggestion_type);
        }
    }

    pub fn push_enabled(&self) -> bool {
        self.push_enabled
    }

    pub fn set_push_enabled(&mut self, enabled: bool) {
        self.push_enabled = enabled;
    }
}
