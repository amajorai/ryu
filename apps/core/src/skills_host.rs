//! Core-side host shim for the extracted [`ryu_skills`] crate.
//!
//! The SKILL.md registry, dual-root scan, progressive-disclosure injection block,
//! authoring/version store, and the `/api/skills` CRUD surface now live in
//! `crates/ryu-skills`. That crate has ZERO dependency on `apps/core`; the two
//! things it needs from the host are inverted here:
//!
//! - **the Ryu data folder** (for the activation set, version snapshots, and the
//!   one-time legacy migration) → published via [`ryu_skills::set_data_dir`] at
//!   startup with [`crate::paths::ryu_dir`] (see `main.rs`, *before*
//!   [`ryu_skills::SkillRegistry::load`] so seeding/migration hit the real, possibly
//!   relocated, `~/.ryu`).
//! - **the [`Runnable`] identity view** → the trait is Core-local, so the
//!   `impl Runnable for SkillRecord` stays here (orphan rule: a Core-owned trait for
//!   a foreign type is allowed). Every other consumer treats a `SkillRecord` as a
//!   `Runnable` through this impl.

use crate::runnable::Runnable;
use ryu_kernel_contracts::runnable::RunnableKind;
use ryu_skills::SkillRecord;

impl Runnable for SkillRecord {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> RunnableKind {
        RunnableKind::Skill
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_skills::parse_skill_md;

    const SAMPLE_SKILL_MD: &str = r#"---
name: "Polite Greeter"
description: "Prefixes every reply with a greeting."
allowed-tools:
  - "agentbrowser"
---
Always begin every response with "Hello!".
"#;

    // Moved from the crate: `SkillRecord`'s `Runnable` impl is Core-local, so its
    // conformance test lives beside the impl.
    #[test]
    fn skill_record_implements_runnable() {
        let record = parse_skill_md("polite-greeter", SAMPLE_SKILL_MD).unwrap();
        assert_eq!(record.kind(), RunnableKind::Skill);
        assert_eq!(record.id(), "polite-greeter");
        assert_eq!(record.name(), "Polite Greeter");
    }
}
