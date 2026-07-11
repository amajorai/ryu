//! In-memory evaluator registry.
//!
//! The registry is a **pure read-time merge** of the built-in seed catalog
//! ([`super::builtin_catalog`]) with the user-authored custom evaluators persisted
//! in [`crate::config::GatewayConfig::custom_evaluators`]. There is no global
//! mutable state: every construction site rebuilds the merged view from the config
//! snapshot it already holds ([`EvaluatorRegistry::from_config`]), so a custom
//! evaluator that overrides a built-in by `id` is visible identically to the
//! catalog API, the offline dataset runner, and the inline guardrail bridge.

use super::{builtin_catalog, Evaluator};

/// Holds the loaded evaluator catalog (built-ins merged with any custom entries).
#[derive(Debug, Clone)]
pub struct EvaluatorRegistry {
    entries: Vec<Evaluator>,
}

impl EvaluatorRegistry {
    /// Build the registry seeded from the built-in catalog only (no custom
    /// evaluators). Equivalent to `from_custom(&[])`; kept for the many call sites
    /// and tests that do not carry a config.
    pub fn new() -> Self {
        Self {
            entries: builtin_catalog(),
        }
    }

    /// Build the merged registry from the gateway config: the built-in catalog
    /// with `config.custom_evaluators` layered on top. This is the ONE helper every
    /// config-aware construction site (catalog API, offline runner, inline bridge)
    /// routes through, so all three surfaces see exactly the same catalog.
    pub fn from_config(config: &crate::config::GatewayConfig) -> Self {
        Self::from_custom(&config.custom_evaluators)
    }

    /// Pure merge core: `builtin_catalog()` with `custom` layered on top. A custom
    /// entry whose `id` matches a built-in **overrides** it in place (preserving
    /// catalog order); an entry with a new `id` is appended. Every custom entry is
    /// forced `builtin = false` regardless of the incoming flag, so the catalog can
    /// never misreport a user evaluator as shipped. Takes a slice (not a config) so
    /// it is unit-testable without constructing a full `GatewayConfig`.
    pub fn from_custom(custom: &[Evaluator]) -> Self {
        let mut entries = builtin_catalog();
        for c in custom {
            let mut entry = c.clone();
            entry.builtin = false;
            match entries.iter().position(|e| e.id == entry.id) {
                Some(pos) => entries[pos] = entry,
                None => entries.push(entry),
            }
        }
        Self { entries }
    }

    /// Look up an evaluator by its stable id. Used by the offline dataset runner
    /// (P2) and the inline bridge (P3) to resolve requested/bound evaluator ids to
    /// catalog entries — custom entries included, when built via [`Self::from_config`].
    pub fn get(&self, id: &str) -> Option<&Evaluator> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// All registered evaluators, in catalog order (built-ins first, then any
    /// appended custom entries; overrides keep their built-in position).
    pub fn all(&self) -> &[Evaluator] {
        &self.entries
    }
}

impl Default for EvaluatorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Validate a full-replacement set of custom evaluators authored via
/// `PUT /v1/config` before it is persisted. Minimal but present:
///   * every `id` must be non-empty (after trimming);
///   * no two custom entries may share an `id`.
///
/// `category` / `target` / `impl` validity is already guaranteed by serde: they are
/// closed enums, so an unknown value fails deserialization before this runs. A
/// custom `id` that matches a built-in is **permitted** — that collision is the
/// documented override mechanism ([`EvaluatorRegistry::from_custom`] replaces the
/// built-in with the custom entry). Returns a human-readable reason on rejection.
pub fn validate_custom_evaluators(custom: &[Evaluator]) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::with_capacity(custom.len());
    for e in custom {
        let id = e.id.trim();
        if id.is_empty() {
            return Err("custom evaluator id must be non-empty".to_string());
        }
        if seen.contains(&id) {
            return Err(format!("duplicate custom evaluator id '{id}'"));
        }
        seen.push(id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evaluators::{
        Capabilities, EvaluatorCategory, EvaluatorImpl, EvaluatorTarget, OfflineConfig,
    };

    /// A minimal custom offline Regex evaluator for merge/validation tests.
    fn custom(id: &str) -> Evaluator {
        Evaluator {
            id: id.to_string(),
            name: format!("Custom {id}"),
            description: "test".to_string(),
            category: EvaluatorCategory::Custom,
            target: EvaluatorTarget::Output,
            capabilities: Capabilities {
                inline: false,
                offline: true,
            },
            impl_: EvaluatorImpl::Regex {
                patterns: vec!["forbidden".to_string()],
            },
            inline: None,
            offline: Some(OfflineConfig {
                threshold: 0.5,
                judge_model: None,
            }),
            // Deliberately claim builtin=true to prove the merge forces it false.
            builtin: true,
            enforced: false,
            higher_is_better: true,
        }
    }

    #[test]
    fn get_finds_seeded_entry() {
        let reg = EvaluatorRegistry::new();
        assert!(reg.get("toxicity").is_some());
        assert!(reg.get("pii_leakage").is_some());
        assert!(reg.get("does_not_exist").is_none());
    }

    #[test]
    fn all_returns_full_catalog() {
        let reg = EvaluatorRegistry::new();
        assert_eq!(reg.all().len(), builtin_catalog().len());
    }

    #[test]
    fn from_custom_empty_is_back_compat() {
        // No custom evaluators == the built-in catalog verbatim (no field == today).
        let reg = EvaluatorRegistry::from_custom(&[]);
        assert_eq!(reg.all().len(), builtin_catalog().len());
        assert!(reg.get("toxicity").is_some());
    }

    #[test]
    fn from_custom_appends_new_id_and_forces_builtin_false() {
        let base = builtin_catalog().len();
        let reg = EvaluatorRegistry::from_custom(&[custom("my_custom_eval")]);
        assert_eq!(reg.all().len(), base + 1, "a new id appends one entry");
        let e = reg.get("my_custom_eval").expect("custom entry present");
        assert!(!e.builtin, "custom entry is forced builtin=false at merge");
        assert!(e.capabilities.offline);
    }

    #[test]
    fn from_custom_overrides_builtin_by_id_in_place() {
        let base = builtin_catalog().len();
        // Override the shipped "toxicity" builtin with a custom entry of the same id.
        let mut ovr = custom("toxicity");
        ovr.description = "overridden".to_string();
        let reg = EvaluatorRegistry::from_custom(&[ovr]);
        assert_eq!(reg.all().len(), base, "override replaces in place, no growth");
        let e = reg.get("toxicity").expect("overridden entry present");
        assert_eq!(e.description, "overridden");
        assert!(!e.builtin, "override is a custom entry (builtin=false)");
    }

    #[test]
    fn validate_rejects_empty_and_duplicate_ids() {
        assert!(validate_custom_evaluators(&[custom("ok")]).is_ok());

        let mut blank = custom("x");
        blank.id = "   ".to_string();
        assert!(validate_custom_evaluators(&[blank]).is_err());

        let dupe = vec![custom("dup"), custom("dup")];
        assert!(validate_custom_evaluators(&dupe).is_err());

        // Collision with a builtin id is ALLOWED (the override mechanism).
        assert!(validate_custom_evaluators(&[custom("toxicity")]).is_ok());
    }
}
