use super::config::{in_hour_window, DEFAULT_MIN_REWARD};
use super::*;
use crate::test_support::MockHost;

#[test]
fn hour_window_same_day_and_wrapping() {
    // Same-day window [1, 5)
    assert!(in_hour_window(2, 1, 5));
    assert!(in_hour_window(1, 1, 5));
    assert!(!in_hour_window(5, 1, 5));
    assert!(!in_hour_window(0, 1, 5));
    // Wrapping window [22, 6) spans midnight
    assert!(in_hour_window(23, 22, 6));
    assert!(in_hour_window(0, 22, 6));
    assert!(in_hour_window(5, 22, 6));
    assert!(!in_hour_window(12, 22, 6));
    // Single-bound window [22, 24) (missing end defaults to 24)
    assert!(in_hour_window(22, 22, 24));
    assert!(in_hour_window(23, 22, 24));
    assert!(!in_hour_window(12, 22, 24));
    // Empty window
    assert!(!in_hour_window(3, 3, 3));
}

// ---- two-flag consent gating ------------------------------------------

#[tokio::test]
async fn training_and_skills_opt_in_default_off() {
    // Both learning paths process conversation content, so both are OFF
    // until explicitly enabled. Both prefs unset exercises the default
    // branch (env is unset under a clean test run).
    let host = MockHost::new();
    assert!(!resolve_enabled(&host).await);
    assert!(!resolve_skills_enabled(&host).await);
}

#[tokio::test]
async fn training_opt_in_honors_pref_truthy_and_falsy() {
    for v in ["1", "true", "YES", "on"] {
        let host = MockHost::new().with_pref(LEARNING_ENABLED_PREF, v);
        assert!(resolve_enabled(&host).await, "{v} should be truthy");
    }
    for v in ["0", "false", "no", "off", "  "] {
        let host = MockHost::new().with_pref(LEARNING_ENABLED_PREF, v);
        assert!(!resolve_enabled(&host).await, "{v:?} should be falsy");
    }
}

#[tokio::test]
async fn skills_opt_in_can_be_turned_off() {
    let host = MockHost::new().with_pref(LEARNING_SKILLS_ENABLED_PREF, "false");
    assert!(!resolve_skills_enabled(&host).await);
}

#[tokio::test]
async fn approval_and_feedback_flags_default_on() {
    let host = MockHost::new();
    assert!(resolve_require_approval(&host).await);
    assert!(resolve_feedback_memory_enabled(&host).await);
    assert!(resolve_feedback_down_negative(&host).await);
}

#[tokio::test]
async fn approval_and_feedback_flags_respect_falsy_pref() {
    let host = MockHost::new()
        .with_pref(LEARNING_REQUIRE_APPROVAL_PREF, "0")
        .with_pref(FEEDBACK_MEMORY_ENABLED_PREF, "no")
        .with_pref(FEEDBACK_DOWN_NEGATIVE_PREF, "off");
    assert!(!resolve_require_approval(&host).await);
    assert!(!resolve_feedback_memory_enabled(&host).await);
    assert!(!resolve_feedback_down_negative(&host).await);
}

#[tokio::test]
async fn per_conversation_exclude_resolves_from_prefixed_pref() {
    let key = format!("{LEARNING_EXCLUDE_PREFIX}conv-9");
    let host = MockHost::new().with_pref(&key, "true");
    assert!(resolve_excluded(&host, "conv-9").await);
    assert!(!resolve_excluded(&host, "conv-other").await);
}

#[tokio::test]
async fn min_reward_clamps_to_unit_range_else_default() {
    assert_eq!(
        resolve_min_reward(&MockHost::new()).await,
        DEFAULT_MIN_REWARD
    );
    let ok = MockHost::new().with_pref(LEARNING_MIN_REWARD_PREF, "0.4");
    assert_eq!(resolve_min_reward(&ok).await, 0.4);
    // Out of [0,1] and non-numeric both fall back to the default.
    let hi = MockHost::new().with_pref(LEARNING_MIN_REWARD_PREF, "1.5");
    assert_eq!(resolve_min_reward(&hi).await, DEFAULT_MIN_REWARD);
    let junk = MockHost::new().with_pref(LEARNING_MIN_REWARD_PREF, "abc");
    assert_eq!(resolve_min_reward(&junk).await, DEFAULT_MIN_REWARD);
}

#[tokio::test]
async fn skill_generation_and_base_model_resolve() {
    assert_eq!(resolve_skill_generation(&MockHost::new()).await, 0);
    let host = MockHost::new()
        .with_pref(LEARNING_SKILL_GENERATION_PREF, "5")
        .with_pref(LEARNING_BASE_MODEL_PREF, "gemma-base");
    assert_eq!(resolve_skill_generation(&host).await, 5);
    assert_eq!(
        resolve_base_model(&host).await,
        Some("gemma-base".to_string())
    );
    assert_eq!(resolve_base_model(&MockHost::new()).await, None);
}

// ---- sleep window + schedule gating -----------------------------------

#[tokio::test]
async fn sleep_window_unset_is_unrestricted_full_window_true_empty_false() {
    // Neither bound -> no restriction.
    assert!(resolve_in_sleep_window(&MockHost::new()).await);
    // [0,24) contains every hour.
    let full = MockHost::new()
        .with_pref(LEARNING_SLEEP_START_PREF, "0")
        .with_pref(LEARNING_SLEEP_END_PREF, "24");
    assert!(resolve_in_sleep_window(&full).await);
    // start == end is an empty window -> never (independent of wall clock).
    let empty = MockHost::new()
        .with_pref(LEARNING_SLEEP_START_PREF, "5")
        .with_pref(LEARNING_SLEEP_END_PREF, "5");
    assert!(!resolve_in_sleep_window(&empty).await);
}

#[tokio::test]
async fn scheduled_cycle_due_and_mark_ran() {
    // No prior run recorded -> always due.
    assert!(scheduled_cycle_due(&MockHost::new()).await);
    // A run long ago (epoch 0) with the default 20h gap -> due.
    let old = MockHost::new().with_pref(LEARNING_LAST_CYCLE_PREF, "0");
    assert!(scheduled_cycle_due(&old).await);
    // Stamp "now" then re-check: inside the gap -> not due.
    let host = MockHost::new();
    mark_cycle_ran(&host).await;
    assert!(!scheduled_cycle_due(&host).await);
}

// ---- config projection + PRM/synth sources ----------------------------

#[tokio::test]
async fn resolve_config_projects_prefs_without_secrets() {
    let host = MockHost::new()
        .enabled()
        .with_pref(LEARNING_SKILLS_ENABLED_PREF, "false")
        .with_pref(LEARNING_PRM_MODEL_PREF, "judge-x")
        .with_pref(LEARNING_PRM_URL_PREF, "https://byo.example")
        .with_pref(LEARNING_PRM_KEY_PREF, "sk-secret")
        .with_pref(LEARNING_SYNTH_MODEL_PREF, "synth-y")
        .with_pref(LEARNING_MIN_REWARD_PREF, "0.6")
        .with_pref(LEARNING_BASE_MODEL_PREF, "base-z")
        .with_pref(LEARNING_SKILL_GENERATION_PREF, "3");
    let cfg = resolve_config(&host).await;
    assert!(cfg.enabled);
    assert!(!cfg.skills_enabled);
    assert_eq!(cfg.prm_model, "judge-x");
    assert!(cfg.prm_via_byo); // url present
    assert_eq!(cfg.synth_model, "synth-y");
    assert_eq!(cfg.min_reward, 0.6);
    assert_eq!(cfg.base_model, Some("base-z".to_string()));
    assert_eq!(cfg.skill_generation, 3);
    // The serialized config must never carry the BYO key.
    let json = serde_json::to_string(&cfg).unwrap();
    assert!(!json.contains("sk-secret"));
}

#[tokio::test]
async fn prm_defaults_to_host_model_synth_defaults_local() {
    // Pref set so the env fallback branch is skipped (determinism).
    let host = MockHost::new()
        .with_pref(LEARNING_PRM_MODEL_PREF, "pref-prm")
        .with_pref(LEARNING_SYNTH_MODEL_PREF, "pref-synth");
    let prm = resolve_prm(&host).await;
    assert_eq!(prm.model, "pref-prm");
    assert!(prm.url.is_none());
    let synth = resolve_synth(&host).await;
    assert_eq!(synth.model, "pref-synth");
    assert!(synth.url.is_none()); // synth never routes BYO
}
