//! Ryu's first-party capability taxonomy (Treg parity B1).
//!
//! A **capability** is a job an agent wants done (`web.search`, `issue.create`);
//! a **platform** is the real-world system the job acts on (`web`, `github`). An
//! endpoint joins one capability on one platform, and `(platform, capability)`
//! is the comparison row that lines up every vendor serving the same job, so a
//! caller can choose between them.
//!
//! The data lives in `fixtures/capability-taxonomy-v1.json`, which is the single
//! source of truth: this module and the TypeScript twin
//! `@ryuhq/protocol/capability-taxonomy` both read it, and both assert the same
//! golden cases in `fixtures/capability-taxonomy-cases-v1.json`. A rule change
//! lands as a fixture case first, then in both implementations.
//!
//! Rules the validator enforces:
//!
//! * **Propose, then promote.** New jobs land as `proposed`. Only `promoted`
//!   capabilities key a comparison row; a `retired` one names a non-retired
//!   `successor`.
//! * **No duplicate meaning.** Ids, aliases, facade verbs and descriptions are
//!   unique, and two capabilities whose names reduce to the same set of words
//!   ("Search the web" / "Web searches") are refused.
//! * **Per-model generative media.** A capability with comparison `per_model`
//!   compares only endpoints that run the same model, so its key carries the
//!   model id; a capability-level row must not carry one.
//! * Facade verbs (`capability_tools.rs` in Core) belong only to promoted
//!   capabilities; `tests/capability_taxonomy_fixture.rs` checks every shipped
//!   verb is covered.
//!
//! Every function is pure. Errors carry fixed codes and the offending id only.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Version of this contract and of `capability-taxonomy-v1.json`.
pub const TAXONOMY_VERSION: u32 = 1;

/// The built-in taxonomy, embedded at compile time.
pub const TAXONOMY_JSON: &str = include_str!("../fixtures/capability-taxonomy-v1.json");

/// Maximum length of a capability or platform id.
pub const MAX_ID_LEN: usize = 64;

/// Maximum length of a model id in a per-model comparison key.
pub const MAX_MODEL_LEN: usize = 128;

/// Words ignored when deciding whether two capability names mean the same job.
const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to",
    "with",
];

/// Review state of a capability or platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaxonomyStatus {
    /// Landed but not reviewed: endpoints may reference it, comparison rows may not.
    Proposed,
    /// Reviewed and stable.
    Promoted,
    /// Kept for old references; resolves to its successor.
    Retired,
}

/// How endpoints of one capability are compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonRule {
    /// Every endpoint for the capability on a platform is one row.
    Capability,
    /// Only endpoints running the same model share a row (generative media).
    PerModel,
}

/// A real-world system an endpoint acts on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Platform {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: TaxonomyStatus,
    pub added_on: String,
}

/// A job an agent wants done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: TaxonomyStatus,
    pub comparison: ComparisonRule,
    /// Platforms this job is defined on.
    pub platforms: Vec<String>,
    /// The binding capability in Core that serves the verb (`web.search`,
    /// `browser.control`), when this capability is a facade verb.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    /// Core facade verb ids (`capability_tools.rs`) that perform this job.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verbs: Vec<String>,
    /// Older or alternative ids that resolve to this capability.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub successor: Option<String>,
    pub added_on: String,
}

/// The whole taxonomy document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Taxonomy {
    pub version: u32,
    pub description: String,
    pub platforms: Vec<Platform>,
    pub capabilities: Vec<Capability>,
}

/// One validation finding: a fixed code and the id it concerns.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaxonomyIssue {
    pub code: String,
    pub subject: String,
}

impl TaxonomyIssue {
    fn new(code: &str, subject: &str) -> Self {
        Self {
            code: code.to_owned(),
            subject: subject.to_owned(),
        }
    }
}

/// Why a `(platform, capability, model)` triple has no comparison key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonError {
    UnknownCapability,
    PlatformNotAllowed,
    ModelRequired,
    ModelNotAllowed,
    InvalidModel,
    CapabilityRetired,
    CapabilityNotPromoted,
}

impl ComparisonError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnknownCapability => "unknown_capability",
            Self::PlatformNotAllowed => "platform_not_allowed",
            Self::ModelRequired => "model_required",
            Self::ModelNotAllowed => "model_not_allowed",
            Self::InvalidModel => "invalid_model",
            Self::CapabilityRetired => "capability_retired",
            Self::CapabilityNotPromoted => "capability_not_promoted",
        }
    }
}

/// `<segment>(.<segment>)+`, each segment `[a-z][a-z0-9_]*`.
pub fn is_valid_capability_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return false;
    }
    let mut segments = 0;
    for segment in id.split('.') {
        segments += 1;
        let mut chars = segment.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !first.is_ascii_lowercase()
            || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            return false;
        }
    }
    segments >= 2
}

/// `[a-z][a-z0-9-]*`.
pub fn is_valid_platform_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= MAX_ID_LEN
        && first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 1..=128 characters of `[A-Za-z0-9._:/-]`.
pub fn is_valid_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= MAX_MODEL_LEN
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
}

/// A calendar date written `YYYY-MM-DD`.
pub fn is_valid_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let mut out = 0_u32;
        for &byte in &bytes[range] {
            if !byte.is_ascii_digit() {
                return None;
            }
            out = out * 10 + u32::from(byte - b'0');
        }
        Some(out)
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    year >= 1970 && (1..=days_in_month).contains(&day)
}

/// A naive English singular: `ies` to `y`, `es` after a sibilant, else a
/// trailing `s` (not `ss`). Both sides of a comparison go through it, so it
/// only has to be consistent.
fn singular(word: &str) -> String {
    if word.len() > 4 && word.ends_with("ies") {
        return format!("{}y", &word[..word.len() - 3]);
    }
    for suffix in ["sses", "ches", "shes", "xes", "zes"] {
        if word.ends_with(suffix) {
            return word[..word.len() - 2].to_owned();
        }
    }
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        return word[..word.len() - 1].to_owned();
    }
    word.to_owned()
}

/// The words a capability name reduces to for the duplicate-meaning check:
/// lowercase ASCII words of two or more letters, stop words dropped, plurals
/// made singular, deduplicated and sorted. Empty when nothing is left.
pub fn meaning_key(name: &str) -> String {
    let words: BTreeSet<String> = name
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| word.len() >= 2 && !STOP_WORDS.contains(word))
        .map(singular)
        .collect();
    words.into_iter().collect::<Vec<_>>().join(" ")
}

/// Every issue in `taxonomy`, in discovery order. Empty means valid.
pub fn validate_taxonomy(taxonomy: &Taxonomy) -> Vec<TaxonomyIssue> {
    let mut issues = Vec::new();
    if taxonomy.version != TAXONOMY_VERSION {
        issues.push(TaxonomyIssue::new(
            "unsupported_version",
            &taxonomy.version.to_string(),
        ));
        return issues;
    }

    let mut platform_ids = HashSet::new();
    for platform in &taxonomy.platforms {
        if !is_valid_platform_id(&platform.id) {
            issues.push(TaxonomyIssue::new("invalid_platform_id", &platform.id));
        }
        if !platform_ids.insert(platform.id.as_str()) {
            issues.push(TaxonomyIssue::new("duplicate_platform", &platform.id));
        }
        if platform.name.trim().is_empty() || platform.description.trim().is_empty() {
            issues.push(TaxonomyIssue::new("empty_text", &platform.id));
        }
        if !is_valid_iso_date(&platform.added_on) {
            issues.push(TaxonomyIssue::new("invalid_date", &platform.id));
        }
    }

    let mut ids = HashSet::new();
    let mut verbs = HashSet::new();
    let mut meanings = HashSet::new();
    let mut descriptions = HashSet::new();
    for capability in &taxonomy.capabilities {
        let id = capability.id.as_str();
        if !is_valid_capability_id(id) {
            issues.push(TaxonomyIssue::new("invalid_id", id));
        }
        if !ids.insert(id) {
            issues.push(TaxonomyIssue::new("duplicate_id", id));
        }
        if capability.name.trim().is_empty() || capability.description.trim().is_empty() {
            issues.push(TaxonomyIssue::new("empty_text", id));
        }
        if !is_valid_iso_date(&capability.added_on) {
            issues.push(TaxonomyIssue::new("invalid_date", id));
        }
        if capability.platforms.is_empty() {
            issues.push(TaxonomyIssue::new("no_platforms", id));
        }
        if capability
            .platforms
            .iter()
            .any(|platform| !platform_ids.contains(platform.as_str()))
        {
            issues.push(TaxonomyIssue::new("unknown_platform", id));
        }
        if !capability.verbs.is_empty() && capability.status != TaxonomyStatus::Promoted {
            issues.push(TaxonomyIssue::new("verb_not_promoted", id));
        }
        for verb in &capability.verbs {
            if !verbs.insert(verb.as_str()) {
                issues.push(TaxonomyIssue::new("duplicate_verb", verb));
            }
        }
        match (capability.status, &capability.successor) {
            (TaxonomyStatus::Retired, None) => {
                issues.push(TaxonomyIssue::new("missing_successor", id));
            }
            (TaxonomyStatus::Proposed | TaxonomyStatus::Promoted, Some(_)) => {
                issues.push(TaxonomyIssue::new("successor_not_allowed", id));
            }
            _ => {}
        }
        let meaning = meaning_key(&capability.name);
        if !meaning.is_empty() && !meanings.insert(meaning) {
            issues.push(TaxonomyIssue::new("duplicate_meaning", id));
        }
        let description = capability.description.trim().to_ascii_lowercase();
        if !description.is_empty() && !descriptions.insert(description) {
            issues.push(TaxonomyIssue::new("duplicate_description", id));
        }
    }

    let mut by_id: HashMap<&str, &Capability> = HashMap::new();
    for capability in &taxonomy.capabilities {
        by_id.entry(capability.id.as_str()).or_insert(capability);
    }
    let mut aliases = HashSet::new();
    for capability in &taxonomy.capabilities {
        for alias in &capability.aliases {
            if !is_valid_capability_id(alias) {
                issues.push(TaxonomyIssue::new("invalid_id", alias));
            }
            if by_id.contains_key(alias.as_str()) || !aliases.insert(alias.as_str()) {
                issues.push(TaxonomyIssue::new("duplicate_alias", alias));
            }
        }
        if capability.status == TaxonomyStatus::Retired {
            if let Some(successor) = &capability.successor {
                let valid = successor != &capability.id
                    && by_id
                        .get(successor.as_str())
                        .is_some_and(|next| next.status != TaxonomyStatus::Retired);
                if !valid {
                    issues.push(TaxonomyIssue::new("invalid_successor", &capability.id));
                }
            }
        }
    }
    issues
}

impl Taxonomy {
    /// Parse and validate a taxonomy document.
    pub fn parse(json: &str) -> Result<Self, String> {
        let taxonomy: Self =
            serde_json::from_str(json).map_err(|error| format!("taxonomy JSON: {error}"))?;
        let issues = validate_taxonomy(&taxonomy);
        if let Some(first) = issues.first() {
            return Err(format!(
                "taxonomy invalid: {} ({}), {} issue(s)",
                first.code,
                first.subject,
                issues.len()
            ));
        }
        Ok(taxonomy)
    }

    /// The capability `id` names, directly or through an alias.
    pub fn resolve(&self, id: &str) -> Option<&Capability> {
        self.capabilities
            .iter()
            .find(|capability| capability.id == id)
            .or_else(|| {
                self.capabilities
                    .iter()
                    .find(|capability| capability.aliases.iter().any(|alias| alias == id))
            })
    }

    pub fn platform(&self, id: &str) -> Option<&Platform> {
        self.platforms.iter().find(|platform| platform.id == id)
    }

    /// The capability that owns facade verb `verb`.
    pub fn capability_for_verb(&self, verb: &str) -> Option<&Capability> {
        self.capabilities
            .iter()
            .find(|capability| capability.verbs.iter().any(|candidate| candidate == verb))
    }

    /// The comparison-row key for an endpoint: `<platform>/<capability>`, or
    /// `<platform>/<capability>@<model>` for a per-model capability. Aliases
    /// key their canonical row. Only promoted capabilities are compared.
    pub fn comparison_key(
        &self,
        platform: &str,
        capability: &str,
        model: Option<&str>,
    ) -> Result<String, ComparisonError> {
        let found = self
            .resolve(capability)
            .ok_or(ComparisonError::UnknownCapability)?;
        if !found.platforms.iter().any(|allowed| allowed == platform) {
            return Err(ComparisonError::PlatformNotAllowed);
        }
        let model = match (found.comparison, model) {
            (ComparisonRule::PerModel, None) => return Err(ComparisonError::ModelRequired),
            (ComparisonRule::PerModel, Some("")) => return Err(ComparisonError::ModelRequired),
            (ComparisonRule::PerModel, Some(model)) if !is_valid_model_id(model) => {
                return Err(ComparisonError::InvalidModel)
            }
            (ComparisonRule::PerModel, Some(model)) => Some(model),
            (ComparisonRule::Capability, Some(_)) => return Err(ComparisonError::ModelNotAllowed),
            (ComparisonRule::Capability, None) => None,
        };
        match found.status {
            TaxonomyStatus::Retired => return Err(ComparisonError::CapabilityRetired),
            TaxonomyStatus::Proposed => return Err(ComparisonError::CapabilityNotPromoted),
            TaxonomyStatus::Promoted => {}
        }
        Ok(match model {
            Some(model) => format!("{platform}/{}@{model}", found.id),
            None => format!("{platform}/{}", found.id),
        })
    }
}

/// The built-in taxonomy, parsed and validated once.
pub fn builtin_taxonomy() -> Result<&'static Taxonomy, &'static str> {
    static TAXONOMY: OnceLock<Result<Taxonomy, String>> = OnceLock::new();
    TAXONOMY
        .get_or_init(|| Taxonomy::parse(TAXONOMY_JSON))
        .as_ref()
        .map_err(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_taxonomy_parses_and_validates() {
        let taxonomy = builtin_taxonomy().unwrap();
        assert_eq!(taxonomy.version, TAXONOMY_VERSION);
        assert!(validate_taxonomy(taxonomy).is_empty());
    }

    #[test]
    fn meaning_key_ignores_order_stop_words_and_plurals() {
        assert_eq!(meaning_key("Search the web"), "search web");
        assert_eq!(meaning_key("Web searches"), "search web");
        assert_eq!(meaning_key("List a project's issues"), "issue list project");
        assert_eq!(meaning_key("Access"), "access");
        assert_eq!(meaning_key("List repositories"), "list repository");
        assert_eq!(meaning_key("Addresses"), "address");
        assert_eq!(meaning_key(""), "");
    }

    #[test]
    fn dates_are_calendar_dates() {
        assert!(is_valid_iso_date("2024-02-29"));
        assert!(!is_valid_iso_date("2026-02-29"));
        assert!(!is_valid_iso_date("2026-13-01"));
        assert!(!is_valid_iso_date("2026-1-01"));
    }

    #[test]
    fn id_grammars() {
        assert!(is_valid_capability_id("browser.click_at"));
        assert!(!is_valid_capability_id("search"));
        assert!(!is_valid_capability_id("Web.search"));
        assert!(!is_valid_capability_id("web..search"));
        assert!(is_valid_platform_id("agent-memory"));
        assert!(!is_valid_platform_id("Agent"));
        assert!(is_valid_model_id("black-forest-labs/flux-1.1-pro"));
        assert!(!is_valid_model_id("flux pro"));
    }
}
