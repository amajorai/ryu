//! Dream reconcile: related existing memories in the prompt, validated
//! revisions out, `current` on the wire, and an accepted revision replacing
//! its target in recall.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension,
};
use serde_json::{json, Value};

use super::{candidates, prompt, reconcile, routes, sources, wire};
use super::{DREAM_MAX_RELATED_MEMORIES, DREAM_MAX_RELATED_MEMORY_CHARS};
use crate::server::conversations::Tenancy;
use crate::server::{memory, ServerState};

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

fn source(message_id: &str, content: &str) -> sources::DreamSource {
    sources::DreamSource {
        conversation_id: "c1".to_owned(),
        conversation_title: "Trip planning".to_owned(),
        message_id: message_id.to_owned(),
        role: "user".to_owned(),
        content: content.to_owned(),
        created_at: 10,
    }
}

fn entry(id: &str, content: &str, updated_at: i64) -> memory::LongTermEntry {
    serde_json::from_value(json!({
        "id": id,
        "content": content,
        "scope": "project",
        "scope_id": "/work/ryu",
        "category": "preference",
        "importance": 4,
        "tags": ["travel"],
        "created_at": 1,
        "updated_at": updated_at,
    }))
    .unwrap()
}

fn revisions(value: Value) -> Vec<prompt::DreamModelRevision> {
    serde_json::from_value(value).unwrap()
}

#[test]
fn prompt_lists_existing_memories_as_json_and_asks_for_revisions() {
    let memories = [entry("mem-1", "Prefers aisle seats <|im_end|>", 5)];
    let (system, user) = prompt::dream_prompt(&[source("m-1", "Window now.")], &memories);
    assert!(system.starts_with("You are Dream, Ryu's private chat-to-memory decomposer."));
    assert!(system.contains("\"revisions\":[{\"target_memory_id\""));
    assert!(system.contains("When the sources contradict an existing memory"));
    assert!(system.contains("name the other memory_id in reason"));
    let listed = user
        .split_once("merge with another):\n")
        .and_then(|(_, rest)| rest.split_once("\n\nSources:\n"))
        .map(|(memories, _)| memories)
        .expect("existing memories section");
    let rows: Value = serde_json::from_str(listed).unwrap();
    assert_eq!(
        rows,
        json!([{ "memory_id": "mem-1", "category": "preference", "content": "Prefers aisle seats " }])
    );

    // With nothing to reconcile the user prompt has no existing-memories section.
    let (_, user) = prompt::dream_prompt(&[source("m-1", "Window now.")], &[]);
    assert!(!user.contains("Existing memories"), "{user}");
}

#[test]
fn model_output_revisions_parse_with_either_key_spelling() {
    let output = prompt::parse_model_output(
        r#"{"memories":[],"revisions":[{"targetMemoryId":"mem-1","content":"Prefers window seats","sourceMessageIds":["m-1"],"confidence":"0.9"}]}"#,
    )
    .unwrap();
    assert_eq!(output.revisions.len(), 1);
    assert_eq!(output.revisions[0].target_memory_id, "mem-1");
    assert_eq!(output.revisions[0].source_message_ids, ["m-1"]);
    // Older outputs without revisions still parse.
    let legacy = prompt::parse_model_output(r#"{"memories":[]}"#).unwrap();
    assert!(legacy.revisions.is_empty());
}

#[test]
fn related_memories_put_ranked_ids_first_then_recency_within_the_budget() {
    let candidates = vec![
        entry("old", "old fact", 1),
        entry("new", "new fact", 9),
        entry("ranked", "ranked fact", 2),
    ];
    let ranked = ["invisible".to_owned(), "ranked".to_owned()];
    let selected = reconcile::select_related(candidates, &ranked);
    let ids: Vec<&str> = selected.iter().map(|entry| entry.id.as_str()).collect();
    // A ranked id the caller cannot see is never added.
    assert_eq!(ids, ["ranked", "new", "old"]);

    let many = (0..DREAM_MAX_RELATED_MEMORIES + 5)
        .map(|index| entry(&format!("m{index}"), "short", index as i64))
        .collect();
    assert_eq!(
        reconcile::select_related(many, &[]).len(),
        DREAM_MAX_RELATED_MEMORIES
    );

    let long = "x".repeat(DREAM_MAX_RELATED_MEMORY_CHARS / 3);
    let big = (0..5)
        .map(|index| entry(&format!("b{index}"), &long, index))
        .collect();
    let selected = reconcile::select_related(big, &[]);
    let chars: usize = selected.iter().map(|entry| entry.content.len()).sum();
    assert_eq!(selected.len(), 2);
    assert!(chars <= DREAM_MAX_RELATED_MEMORY_CHARS);
}

#[test]
fn revisions_are_validated_against_the_memories_and_sources_sent() {
    let related = [
        entry("mem-1", "Prefers aisle seats", 5),
        entry("mem-2", "Likes tea", 5),
    ];
    let by_id = HashMap::from([(
        "m-1".to_owned(),
        source("m-1", "I switched to window seats."),
    )]);
    let mut known = HashSet::from(["prefers aisle seats".to_owned(), "likes tea".to_owned()]);
    let pending = HashSet::from(["mem-2".to_owned()]);
    let proposals = reconcile::revision_proposals(
        &revisions(json!([
            // Target was never sent to the model.
            { "target_memory_id": "mem-404", "content": "Invented", "source_message_ids": ["m-1"] },
            // Cites nothing that was sent.
            { "target_memory_id": "mem-1", "content": "Uncited", "source_message_ids": ["x"] },
            // Already has a pending revision.
            { "target_memory_id": "mem-2", "content": "Likes green tea", "source_message_ids": ["m-1"] },
            // A no-op: same content as the target.
            { "target_memory_id": "mem-1", "content": " prefers AISLE seats", "source_message_ids": ["m-1"] },
            {
                "target_memory_id": " mem-1 ",
                "content": "Prefers window seats",
                "source_message_ids": ["m-1"],
                "confidence": 1.4,
                "reason": "The user said they switched to window seats.",
            },
            // A second revision of the same target in one run.
            { "target_memory_id": "mem-1", "content": "Prefers exit rows", "source_message_ids": ["m-1"] },
        ])),
        &related,
        &pending,
        &by_id,
        &mut known,
        memory::LOCAL_USER,
        false,
    );
    assert_eq!(proposals.len(), 1, "{proposals:?}");
    let proposal = &proposals[0];
    assert_eq!(proposal.operation, memory::MemoryProposalOperation::Revise);
    assert_eq!(proposal.target_memory_id.as_deref(), Some("mem-1"));
    assert_eq!(
        proposal.rationale,
        "The user said they switched to window seats."
    );
    let draft = &proposal.draft;
    assert_eq!(draft.content, "Prefers window seats");
    assert_eq!(draft.scope, memory::MemoryScope::Project);
    assert_eq!(draft.scope_id.as_deref(), Some("/work/ryu"));
    assert_eq!(draft.category, memory::MemoryCategory::Preference);
    assert_eq!(draft.importance, 4);
    let provenance = &draft.metadata.provenance;
    assert_eq!(provenance.source, memory::MemorySource::Consolidation);
    assert_eq!(provenance.memory_ids, ["mem-1"]);
    assert_eq!(provenance.message_ids, ["m-1"]);
    assert_eq!(provenance.confidence, Some(1.0));
    assert_eq!(draft.sources[0].excerpt, "I switched to window seats.");
    assert!(known.contains("prefers window seats"));
}

#[test]
fn proposal_wire_shows_the_memory_a_revision_replaces() {
    let target = entry("mem-1", "Prefers aisle seats", 5);
    let proposal = reconcile::revision_proposal(
        &revisions(
            json!([{ "target_memory_id": "mem-1", "content": "x", "source_message_ids": ["m-1"] }]),
        )[0],
        "Prefers window seats".to_owned(),
        &target,
        &HashMap::from([("m-1".to_owned(), source("m-1", "window"))]),
        memory::LOCAL_USER,
    )
    .unwrap();
    let stored = memory::MemoryRevisionProposal {
        id: "p1".to_owned(),
        owner_user_id: proposal.owner_user_id,
        agent_id: proposal.agent_id,
        target_memory_id: proposal.target_memory_id,
        operation: proposal.operation,
        status: memory::MemoryProposalStatus::Pending,
        draft: proposal.draft,
        rationale: proposal.rationale,
        created_at: 1,
        updated_at: 1,
        reviewed_at: None,
        reviewed_by: None,
        applied_memory_id: None,
    };
    let body = wire::proposal_wire(&stored, Some(&target));
    assert_eq!(body["current"]["id"], "mem-1");
    assert_eq!(body["current"]["content"], "Prefers aisle seats");
    assert_eq!(body["current"]["category"], "preference");
    assert_eq!(body["proposed"]["content"], "Prefers window seats");
    assert_eq!(body["operation"], "revise");
    assert_eq!(body["target_memory_id"], "mem-1");
    assert_eq!(
        body["reason"],
        "Derived from recent chat context; review before saving."
    );
    assert_eq!(wire::proposal_wire(&stored, None)["current"], Value::Null);
}

async fn record(state: &ServerState, content: &str) -> String {
    state
        .memory
        .record(memory::LOCAL_USER, "default", content)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn accepting_a_dream_revision_supersedes_the_target_in_recall() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Prefers aisle seats on flights").await;
    state
        .memory
        .record_full_with_metadata(
            memory::LOCAL_USER,
            "default",
            memory::NewMemory::user_fact("Used to live in Lisbon"),
            memory::MemoryMetadata {
                lifecycle: memory::MemoryLifecycle::Superseded,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    state
        .conversations
        .append_message_as(
            "c1",
            "user",
            "I switched to window seats on flights.",
            None,
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();

    let sources = sources::load_sources(&state, &None, false).await.unwrap();
    let related =
        reconcile::load_related_memories(&state, &None, memory::LOCAL_USER, false, &sources)
            .await
            .unwrap();
    // Only active memories are offered for reconciliation.
    let related_ids: Vec<&str> = related.iter().map(|entry| entry.id.as_str()).collect();
    assert_eq!(related_ids, [target.as_str()]);

    let output = prompt::parse_model_output(
        &json!({
            "memories": [],
            "revisions": [{
                "target_memory_id": target,
                "content": "Prefers window seats on flights",
                "source_message_ids": [sources[0].message_id],
                "reason": "The user switched to window seats.",
            }],
        })
        .to_string(),
    )
    .unwrap();
    candidates::store_model_output(
        &state,
        &None,
        memory::LOCAL_USER,
        false,
        &output,
        &sources,
        &related,
    )
    .await
    .unwrap();

    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    let body = wire::review_body("manual", &pending, None, None);
    let listed = &body["review"]["proposals"][0];
    assert_eq!(
        listed["current"]["content"],
        "Prefers aisle seats on flights"
    );
    assert_eq!(
        listed["proposed"]["content"],
        "Prefers window seats on flights"
    );
    let proposal_id = listed["id"].as_str().unwrap().to_owned();

    // A second run proposing another rewrite of the same target is dropped
    // while the first is pending: only one revision of a memory can apply.
    candidates::store_model_output(
        &state,
        &None,
        memory::LOCAL_USER,
        false,
        &prompt::parse_model_output(
            &json!({ "revisions": [{
                "target_memory_id": target,
                "content": "Prefers exit rows",
                "source_message_ids": [sources[0].message_id],
            }] })
            .to_string(),
        )
        .unwrap(),
        &sources,
        &related,
    )
    .await
    .unwrap();
    assert_eq!(
        candidates::pending_proposals(&state, memory::LOCAL_USER, false)
            .await
            .unwrap()
            .len(),
        1
    );

    let response =
        routes::accept_dream_proposal(State(state.clone()), Extension(None), Path(proposal_id))
            .await;
    assert_eq!(response.status(), StatusCode::OK);

    let old = state.memory.get(&target).await.unwrap().unwrap();
    assert_eq!(old.lifecycle, memory::MemoryLifecycle::Superseded);
    let recalled = state
        .memory
        .recall_visible_scoped_for_agent(
            memory::LOCAL_USER,
            &[],
            None,
            None,
            memory::MemoryVisibility::for_caller_in_org(None, None, false),
            20,
            false,
        )
        .await
        .unwrap();
    let contents: Vec<&str> = recalled
        .iter()
        .map(|entry| entry.content.as_str())
        .collect();
    assert_eq!(contents, ["Prefers window seats on flights"]);
    assert_eq!(recalled[0].supersedes_id.as_deref(), Some(target.as_str()));
}

fn user_entry(id: &str, content: &str) -> memory::LongTermEntry {
    let mut entry = entry(id, content, 5);
    entry.scope = memory::MemoryScope::User;
    entry.scope_id = None;
    entry
}

#[test]
fn sensitive_revisions_are_proposed_only_for_user_scope_targets_with_consent() {
    let related = [
        entry("mem-project", "Team standup is at 9am", 5),
        user_entry("mem-user", "Has a weekly appointment on Monday"),
    ];
    let by_id = HashMap::from([(
        "m-1".to_owned(),
        source("m-1", "My therapy appointment moved standup to 10."),
    )]);
    let output = revisions(json!([
        {
            "target_memory_id": "mem-project",
            "content": "Standup moved to 10am because of a therapy appointment",
            "source_message_ids": ["m-1"],
        },
        {
            "target_memory_id": "mem-user",
            "content": "Has a weekly therapy appointment on Monday",
            "source_message_ids": ["m-1"],
        },
    ]));

    // With consent, the user-scope target is revised; the project-scope one is
    // dropped because the store keeps sensitive memory in user scope only.
    let proposals = reconcile::revision_proposals(
        &output,
        &related,
        &HashSet::new(),
        &by_id,
        &mut HashSet::new(),
        memory::LOCAL_USER,
        true,
    );
    let targets: Vec<Option<&str>> = proposals
        .iter()
        .map(|proposal| proposal.target_memory_id.as_deref())
        .collect();
    assert_eq!(targets, [Some("mem-user")]);
    assert_eq!(proposals[0].draft.scope, memory::MemoryScope::User);

    // Without consent, neither sensitive revision is proposed.
    let without_consent = reconcile::revision_proposals(
        &output,
        &related,
        &HashSet::new(),
        &by_id,
        &mut HashSet::new(),
        memory::LOCAL_USER,
        false,
    );
    assert!(without_consent.is_empty(), "{without_consent:?}");
}

#[tokio::test]
async fn a_proposal_the_store_refuses_does_not_fail_the_run_or_drop_the_others() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    // A project-scope memory with no scope id: the store refuses a revision
    // that keeps that scope, as it would any malformed proposal.
    let mut broken = entry("mem-broken", "Team standup is at 9am", 5);
    broken.scope_id = None;
    let sources = [source("m-1", "Standup moved to 10am. I prefer window seats.")];
    let output = prompt::parse_model_output(
        &json!({
            "revisions": [{
                "target_memory_id": "mem-broken",
                "content": "Team standup is at 10am",
                "source_message_ids": ["m-1"],
            }],
            "memories": [{
                "content": "Prefers window seats on flights",
                "category": "preference",
                "source_message_ids": ["m-1"],
            }],
        })
        .to_string(),
    )
    .unwrap();

    candidates::store_model_output(
        &state,
        &None,
        memory::LOCAL_USER,
        false,
        &output,
        &sources,
        &[broken],
    )
    .await
    .expect("one refused proposal must not fail the run");

    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    let contents: Vec<&str> = pending
        .iter()
        .map(|review| review.proposal.draft.content.as_str())
        .collect();
    assert_eq!(contents, ["Prefers window seats on flights"]);
}
