//! The two places a learned skill reaches the skills folder, run against an
//! isolated temp folder: synthesis with no approval engine (never overwrites,
//! saves under a fresh slug) and the write of an approved revision (saves the
//! previous version first, then replaces it).

use super::harness_test::{ctx_arc, store, TempSkills};
use super::*;
use crate::host::QueuedApproval;
use crate::test_support::MockHost;

const ORIGINAL: &str = "---\nname: Reverse a string\ndescription: old\n---\nold steps\n";

fn reverse_convo() -> MockHost {
    MockHost::new().with_messages(
        "c1",
        &[
            ("user", "how do I reverse a unicode string in rust?"),
            ("assistant", "use graphemes, then rev()"),
        ],
    )
}

fn revision_json() -> String {
    r#"{"name":"Reverse a string","description":"reverse unicode text","instructions":"use graphemes then rev()","updates":"learned-reverse-a-string"}"#
        .to_string()
}

#[tokio::test]
async fn no_engine_revision_saves_under_a_fresh_slug_and_leaves_the_original() {
    let skills = TempSkills::new("synth-no-engine");
    skills.seed("learned-reverse-a-string", ORIGINAL);
    let mut host = reverse_convo().with_skills_dir(skills.dir.clone());
    host.queue = QueuedApproval::NoEngine;
    host.synth_reply = Some(revision_json());
    let queued = host.queued.clone();
    let (c, h) = ctx_arc(host, store("synth-no-engine"));

    let out = synthesize_skill(&c, "c1", true, None).await.unwrap();

    assert!(out.created);
    assert_eq!(out.slug.as_deref(), Some("learned-reverse-a-string-2"));
    assert!(out
        .reason
        .contains("`learned-reverse-a-string` was left unchanged"));
    // The revision was offered to the inbox first; only then written directly.
    assert_eq!(queued.lock().unwrap().len(), 1);
    assert_eq!(
        skills.read("learned-reverse-a-string").as_deref(),
        Some(ORIGINAL)
    );
    let fresh = skills
        .read("learned-reverse-a-string-2")
        .expect("fresh skill");
    assert!(fresh.contains("revises: learned-reverse-a-string\n"));
    assert!(fresh.contains("use graphemes then rev()"));
    assert!(skills.dir.is_active("learned-reverse-a-string-2"));
    assert!(!skills.dir.is_active("learned-reverse-a-string"));
    assert!(skills.versions("learned-reverse-a-string").is_empty());
    assert_eq!(h.reload_count(), 1);
}

#[tokio::test]
async fn no_engine_revision_skips_a_suffixed_slug_already_on_disk() {
    let skills = TempSkills::new("synth-no-engine-taken");
    skills.seed("learned-reverse-a-string", ORIGINAL);
    // A bare directory is not a skill, but a direct write must not reuse it.
    std::fs::create_dir_all(skills.root.join("learned-reverse-a-string-2")).unwrap();
    let mut host = reverse_convo().with_skills_dir(skills.dir.clone());
    host.queue = QueuedApproval::NoEngine;
    host.synth_reply = Some(revision_json());
    let (c, _h) = ctx_arc(host, store("synth-no-engine-taken"));

    let out = synthesize_skill(&c, "c1", true, None).await.unwrap();

    assert_eq!(out.slug.as_deref(), Some("learned-reverse-a-string-3"));
    assert!(skills.read("learned-reverse-a-string-2").is_none());
    assert!(skills.read("learned-reverse-a-string-3").is_some());
    assert_eq!(
        skills.read("learned-reverse-a-string").as_deref(),
        Some(ORIGINAL)
    );
}

#[tokio::test]
async fn approval_off_writes_a_new_skill_under_its_own_slug() {
    let skills = TempSkills::new("synth-approval-off");
    let mut host = reverse_convo()
        .with_pref(LEARNING_REQUIRE_APPROVAL_PREF, "false")
        .with_skills_dir(skills.dir.clone());
    host.synth_reply = Some(
        r#"{"name":"Reverse a string","description":"d","instructions":"use chars().rev()"}"#
            .to_string(),
    );
    let queued = host.queued.clone();
    let (c, h) = ctx_arc(host, store("synth-approval-off"));

    let out = synthesize_skill(&c, "c1", true, None).await.unwrap();

    assert!(out.created);
    assert_eq!(out.slug.as_deref(), Some("learned-reverse-a-string"));
    assert_eq!(out.reason, "skill synthesized");
    assert!(queued.lock().unwrap().is_empty());
    let written = skills.read("learned-reverse-a-string").expect("written");
    assert!(written.contains("use chars().rev()"));
    assert!(!written.contains("revises:"));
    assert!(skills.dir.is_active("learned-reverse-a-string"));
    assert_eq!(h.reload_count(), 1);
}

#[tokio::test]
async fn approved_revision_saves_the_previous_version_then_overwrites() {
    let skills = TempSkills::new("approved-revision");
    skills.seed("learned-reverse-a-string", ORIGINAL);
    let revised = "---\nname: Reverse a string\ndescription: new\n---\nnew steps\n";

    write_synthesized_skill_in(&skills.dir, "learned-reverse-a-string", revised)
        .await
        .unwrap();

    assert_eq!(
        skills.read("learned-reverse-a-string").as_deref(),
        Some(revised)
    );
    assert_eq!(
        skills.versions("learned-reverse-a-string"),
        vec![(
            Some("Before learned update".to_string()),
            ORIGINAL.to_string()
        )]
    );
}

#[tokio::test]
async fn approved_new_skill_is_written_with_no_previous_version() {
    let skills = TempSkills::new("approved-new");

    write_synthesized_skill_in(&skills.dir, "learned-new", ORIGINAL)
        .await
        .unwrap();

    assert_eq!(skills.read("learned-new").as_deref(), Some(ORIGINAL));
    assert!(skills.versions("learned-new").is_empty());
}
