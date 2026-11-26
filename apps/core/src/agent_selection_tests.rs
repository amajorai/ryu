use super::*;
use std::sync::{Mutex, OnceLock};

fn snapshot_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .expect("snapshot lock")
}

#[test]
fn parses_legacy_bare_model_id() {
    let s = AgentSelection::parse("gpt-5-mini");
    assert_eq!(s.model, "gpt-5-mini");
    assert!(s.agent_id.is_empty());
    assert!(!s.is_empty());
}

#[test]
fn parses_full_json_selection() {
    let s = AgentSelection::parse(
        r#"{"agent_id":"ryu","provider":"openai","model":"gpt-5","thinking_level":"high","effort":"medium","access_mode":"acceptEdits"}"#,
    );
    assert_eq!(s.agent_id, "ryu");
    assert_eq!(s.provider, "openai");
    assert_eq!(s.model, "gpt-5");
    assert_eq!(s.thinking_level, "high");
    assert_eq!(s.effort, "medium");
    assert_eq!(s.access_mode, "acceptEdits");
}

#[test]
fn partial_json_leaves_other_fields_empty() {
    let s = AgentSelection::parse(r#"{"model":"claude-sonnet-5"}"#);
    assert_eq!(s.model, "claude-sonnet-5");
    assert!(s.effort.is_empty());
    assert!(s.agent_id.is_empty());
}

#[test]
fn blank_and_corrupt_values_read_as_unset() {
    assert!(AgentSelection::parse("").is_empty());
    assert!(AgentSelection::parse("   ").is_empty());
    // JSON-looking but unreadable: a corrupt setting, not a model id.
    assert!(AgentSelection::parse("{not json").is_empty());
}

#[test]
fn json_fields_are_trimmed() {
    let s = AgentSelection::parse(r#"{"model":"  gpt-5  ","effort":"  "}"#);
    assert_eq!(s.model, "gpt-5");
    assert!(s.effort.is_empty());
}

#[test]
fn round_trips_through_pref_value() {
    let s = AgentSelection {
        agent_id: "ryu".into(),
        provider: "openai".into(),
        model: "gpt-5".into(),
        thinking_level: "high".into(),
        effort: "low".into(),
        access_mode: "plan".into(),
    };
    assert_eq!(AgentSelection::parse(&s.to_pref_value()), s);
}

#[test]
fn model_typed_selection_yields_model_and_effort() {
    let s = AgentSelection {
        model: "gpt-5".into(),
        effort: "high".into(),
        ..Default::default()
    };
    let r = side_model_from(&s).expect("model-typed selection resolves");
    assert_eq!(r.model, "gpt-5");
    assert_eq!(r.effort, "high");
}

#[test]
fn external_agent_selection_falls_through_instead_of_sending_agent_id() {
    // The bug this guards: passing "claude" off as a model id.
    let s = AgentSelection {
        agent_id: "claude".into(),
        ..Default::default()
    };
    assert!(side_model_from(&s).is_none());
}

#[test]
fn empty_selection_yields_nothing() {
    assert!(side_model_from(&AgentSelection::default()).is_none());
}

#[test]
fn thinking_level_drives_effort_when_no_explicit_effort() {
    // A thinking level picked from a provider submenu must reach the call —
    // it is the same vocabulary the effort picker offers.
    let s = AgentSelection {
        model: "gpt-5".into(),
        thinking_level: "high".into(),
        ..Default::default()
    };
    assert_eq!(side_model_from(&s).expect("resolves").effort, "high");
}

#[test]
fn explicit_effort_beats_thinking_level() {
    let s = AgentSelection {
        model: "gpt-5".into(),
        thinking_level: "high".into(),
        effort: "low".into(),
        ..Default::default()
    };
    assert_eq!(side_model_from(&s).expect("resolves").effort, "low");
}

#[test]
fn lane_keys_keep_cloud_unset_and_legacy_local_only() {
    assert_eq!(AgentLane::Local.preference_key(), LOCAL_SELECTION_PREF);
    assert_eq!(AgentLane::Cloud.preference_key(), CLOUD_SELECTION_PREF);
    assert_ne!(LOCAL_SELECTION_PREF, CLOUD_SELECTION_PREF);
    assert_eq!(GLOBAL_SELECTION_PREF, "default-agent-selection");
}

#[test]
fn chat_lane_prefers_cloud_and_falls_back_to_local() {
    let _guard = snapshot_lock();
    set_local_selection_from_json(r#"{"agent_id":"ryu","provider":"local","model":"gemma-local"}"#);
    set_cloud_selection_from_json(
        r#"{"agent_id":"ryu","provider":"managed-openrouter","model":"openrouter/auto","effort":"high"}"#,
    );
    assert_eq!(chat_default_selection().provider, "managed-openrouter");
    assert_eq!(chat_default_selection().model, "openrouter/auto");
    assert_eq!(chat_default_selection().effort, "high");

    set_cloud_selection_from_json("");
    assert_eq!(chat_default_selection().provider, "local");
    assert_eq!(chat_default_selection().model, "gemma-local");
    set_cloud_selection_from_json(
        r#"{"agent_id":"ryu","provider":"managed-openrouter","model":"openrouter/auto"}"#,
    );
    assert_eq!(local_default_selection().provider, "local");
    assert_eq!(local_default_selection().model, "gemma-local");
    set_cloud_selection_from_json("");
    set_local_selection_from_json("");
}

#[test]
fn ryu_and_external_acp_selections_keep_their_controls() {
    let ryu = AgentSelection::parse(
        r#"{"agent_id":"ryu","provider":"managed-openrouter","model":"openrouter/auto","effort":"medium"}"#,
    );
    assert_eq!(ryu.agent_id, "ryu");
    assert_eq!(ryu.provider, "managed-openrouter");
    assert_eq!(ryu.model, "openrouter/auto");
    assert_eq!(ryu.effort, "medium");

    let acp = AgentSelection::parse(
        r#"{"agent_id":"acp:claude","model":"sonnet","effort":"high","access_mode":"plan"}"#,
    );
    assert_eq!(acp.agent_id, "acp:claude");
    assert_eq!(acp.model, "sonnet");
    assert_eq!(acp.effort, "high");
    assert_eq!(acp.access_mode, "plan");
}

#[test]
fn default_agent_snapshot_tracks_the_written_value() {
    let _guard = snapshot_lock();
    set_default_selection_from_json(r#"{"agent_id":"claude"}"#);
    assert_eq!(default_agent_id().as_deref(), Some("claude"));
    // A model-only selection names no agent — callers keep their own default.
    set_default_selection_from_json(r#"{"model":"gpt-5"}"#);
    assert_eq!(default_agent_id(), None);
    set_default_selection_from_json("");
    assert_eq!(default_agent_id(), None);
}
