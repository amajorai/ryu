//! Special-category (sensitive) topic detection used by the memory admission
//! and recall consent gates.

use serde::{Deserialize, Serialize};

/// A special-category topic that is kept out of memory unless the owning user
/// has explicitly enabled sensitive-topic memory for the current node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveTopic {
    HealthCondition,
    ReligiousBelief,
    PoliticalBelief,
    SexualOrientation,
    Financial,
    Legal,
    Biometric,
}

impl SensitiveTopic {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HealthCondition => "health_condition",
            Self::ReligiousBelief => "religious_belief",
            Self::PoliticalBelief => "political_belief",
            Self::SexualOrientation => "sexual_orientation",
            Self::Financial => "financial",
            Self::Legal => "legal",
            Self::Biometric => "biometric",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "health_condition" => Some(Self::HealthCondition),
            "religious_belief" => Some(Self::ReligiousBelief),
            "political_belief" => Some(Self::PoliticalBelief),
            "sexual_orientation" => Some(Self::SexualOrientation),
            "financial" => Some(Self::Financial),
            "legal" => Some(Self::Legal),
            "biometric" => Some(Self::Biometric),
            _ => None,
        }
    }
}

/// Deterministically identify the special-category topics covered by the
/// sensitive-memory consent. This is an admission guard, not a claim that the
/// text is medically, religiously, or legally classified with certainty.
pub fn detect_sensitive_topics(content: &str) -> Vec<SensitiveTopic> {
    let normalized = content.to_lowercase();
    let tokens: std::collections::HashSet<String> = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect();
    let contains_any = |phrases: &[&str]| {
        phrases.iter().any(|phrase| {
            if phrase.contains(' ') {
                normalized.contains(phrase)
            } else {
                tokens.contains(*phrase)
            }
        })
    };
    let mut topics = Vec::new();
    let checks = [
        (
            SensitiveTopic::HealthCondition,
            &[
                "health",
                "medical condition",
                "health condition",
                "diagnosis",
                "disease",
                "disability",
                "medication",
                "therapy",
                "hospital",
                "illness",
                "surgery",
                "allergy",
                "doctor",
            ][..],
        ),
        (
            SensitiveTopic::ReligiousBelief,
            &[
                "religion",
                "religious",
                "faith",
                "prayer",
                "church",
                "mosque",
                "synagogue",
                "temple",
                "christian",
                "muslim",
                "islam",
                "jewish",
                "judaism",
                "hindu",
                "buddhist",
                "atheist",
            ][..],
        ),
        (
            SensitiveTopic::PoliticalBelief,
            &[
                "politics",
                "political",
                "vote",
                "election",
                "political party",
                "democrat",
                "republican",
            ][..],
        ),
        (
            SensitiveTopic::SexualOrientation,
            &[
                "sexual orientation",
                "gay",
                "lesbian",
                "bisexual",
                "transgender",
            ][..],
        ),
        (
            SensitiveTopic::Financial,
            &[
                "bank account",
                "income",
                "salary",
                "debt",
                "credit card",
                "financial",
            ][..],
        ),
        (
            SensitiveTopic::Legal,
            &[
                "criminal record",
                "legal case",
                "lawsuit",
                "conviction",
                "immigration status",
            ][..],
        ),
        (
            SensitiveTopic::Biometric,
            &["fingerprint", "face scan", "retina scan", "biometric"][..],
        ),
    ];
    for (topic, phrases) in checks {
        if contains_any(phrases) {
            topics.push(topic);
        }
    }
    topics
}
