//! Shared fixtures for the engine's flow tests. Each test is hermetic: an
//! in-memory [`MockHost`] and a unique tempfile-backed store, no network, no
//! real skills dir, no env mutation (defaults are asserted only where the
//! ambient env is guaranteed unset under a clean `cargo test`).

use std::sync::Arc;

use super::LearningCtx;
use crate::store::{Experience, ExperienceStore};
use crate::test_support::MockHost;

/// A fresh experience store unique to this process, thread and `tag`.
pub(super) fn store(tag: &str) -> ExperienceStore {
    let dir = std::env::temp_dir().join(format!(
        "ryu-learn-flow-{}-{tag}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    ExperienceStore::open(dir.join("experience.db")).expect("open store")
}

pub(super) fn ctx(host: MockHost, store: ExperienceStore) -> LearningCtx {
    LearningCtx::new(store, Arc::new(host), reqwest::Client::new())
}

/// Like [`ctx`] but also hands back the typed mock so a test can read its
/// side-effect counters (e.g. `reload_skills` calls) after the fact.
pub(super) fn ctx_arc(host: MockHost, store: ExperienceStore) -> (LearningCtx, Arc<MockHost>) {
    let h = Arc::new(host);
    let c = LearningCtx::new(store, h.clone(), reqwest::Client::new());
    (c, h)
}

/// An unscored, non-excluded, completed experience row.
pub(super) fn experience(id: &str, conversation_id: &str, user: &str, reply: &str) -> Experience {
    Experience {
        id: id.into(),
        conversation_id: conversation_id.into(),
        agent_id: None,
        user_text: user.into(),
        assistant_text: reply.into(),
        outcome: "completed".into(),
        reward: None,
        base_model: None,
        skill_generation: 0,
        excluded: false,
        created_at: "t".into(),
    }
}

/// Seed the canonical unscored row (`row-a` in conversation `c1`).
pub(super) async fn seed_unscored(c: &LearningCtx) {
    c.store
        .record_if_absent(&experience("row-a", "c1", "q", "a"))
        .await
        .unwrap();
}

#[test]
fn experience_fixture_is_unscored_and_trainable_shape() {
    let row = experience("id", "conv", "u", "r");
    assert_eq!(row.reward, None);
    assert!(!row.excluded);
    assert_eq!(row.outcome, "completed");
}
