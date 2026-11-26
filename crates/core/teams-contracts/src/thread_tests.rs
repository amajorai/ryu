use super::*;

fn team(coordination: Coordination, lead: Option<&str>) -> TeamRecord {
    TeamRecord {
        id: "team_1".to_owned(),
        name: "Research".to_owned(),
        description: None,
        members: vec!["ada".to_owned(), "bob".to_owned(), "cy".to_owned()],
        coordination,
        lead_agent_id: lead.map(str::to_owned),
        created_at: None,
        updated_at: None,
    }
}

fn roster() -> Vec<(String, String)> {
    [("ada", "Ada"), ("bob", "Bob Stone"), ("cy", "Cy")]
        .into_iter()
        .map(|(id, name)| (id.to_owned(), name.to_owned()))
        .collect()
}

fn thread(owner: Option<&str>, run_state: ThreadRunState) -> TeamThread {
    TeamThread {
        team_id: "team_1".to_owned(),
        conversation_id: "conv_1".to_owned(),
        owner_agent_id: owner.map(str::to_owned),
        run_state,
        created_at: None,
        updated_at: None,
    }
}

fn owned(turn: ThreadTurn) -> OwnedTurn {
    match turn {
        ThreadTurn::Owned(turn) => turn,
        other => panic!("expected an owned turn, got {other:?}"),
    }
}

/// A thread with no record, or a record with no owner, keeps the old behaviour.
#[test]
fn no_record_or_no_owner_leaves_the_strategy_alone() {
    let team = team(Coordination::RoundRobin, None);
    assert!(matches!(
        plan_thread_turn(&team, None, "hello", &roster()),
        ThreadTurn::Strategy
    ));
    let unowned = thread(None, ThreadRunState::Active);
    assert!(matches!(
        plan_thread_turn(&team, Some(&unowned), "hello @bob", &roster()),
        ThreadTurn::Strategy
    ));
}

/// Exactly one agent answers an owned thread when nobody else is addressed, and
/// no synthesis or routing pass runs for a single responder.
#[test]
fn the_owner_answers_alone_by_default() {
    for coordination in [
        Coordination::Broadcast,
        Coordination::RoundRobin,
        Coordination::DebateSynthesis,
        Coordination::Router,
    ] {
        let team = team(coordination, Some("ada"));
        let record = thread(Some("bob"), ThreadRunState::Active);
        let turn = owned(plan_thread_turn(&team, Some(&record), "status?", &roster()));
        assert_eq!(turn.owner, "bob");
        assert_eq!(turn.team.members, ["bob"]);
        assert_eq!(turn.team.coordination, Coordination::Broadcast);
        assert_eq!(turn.team.lead_agent_id, None);
    }
}

/// Addressed members join the owner, and the team's strategy runs over them.
#[test]
fn addressed_members_join_under_the_existing_strategy() {
    let team = team(Coordination::RoundRobin, None);
    let record = thread(Some("cy"), ThreadRunState::Active);
    let turn = owned(plan_thread_turn(
        &team,
        Some(&record),
        "@Ada what do you think?",
        &roster(),
    ));
    assert_eq!(turn.team.members, ["cy", "ada"], "owner first");
    assert_eq!(turn.team.coordination, Coordination::RoundRobin);
}

/// The lead keeps its strategy role when it takes part. When it does not, the
/// owner stands in.
#[test]
fn the_owner_stands_in_for_a_lead_that_is_not_taking_part() {
    let team = team(Coordination::DebateSynthesis, Some("ada"));
    let record = thread(Some("bob"), ThreadRunState::Active);
    let without_lead = owned(plan_thread_turn(
        &team,
        Some(&record),
        "@cy please",
        &roster(),
    ));
    assert_eq!(without_lead.team.members, ["bob", "cy"]);
    assert_eq!(without_lead.team.lead_agent_id.as_deref(), Some("bob"));
    let with_lead = owned(plan_thread_turn(
        &team,
        Some(&record),
        "@ada please",
        &roster(),
    ));
    assert_eq!(with_lead.team.lead_agent_id.as_deref(), Some("ada"));
}

/// Reassigning changes who answers on the next turn.
#[test]
fn reassigning_the_owner_changes_who_answers() {
    let team = team(Coordination::Broadcast, None);
    let mut record = thread(Some("ada"), ThreadRunState::Active);
    let first = owned(plan_thread_turn(&team, Some(&record), "go", &roster()));
    assert_eq!(first.team.members, ["ada"]);
    record.owner_agent_id = Some("cy".to_owned());
    let second = owned(plan_thread_turn(&team, Some(&record), "go", &roster()));
    assert_eq!(second.team.members, ["cy"]);
}

/// Stop refuses the turn whether or not the thread has an owner. Resume (the
/// state back to active) lets it run again.
#[test]
fn a_stopped_thread_runs_nothing_until_it_is_resumed() {
    let team = team(Coordination::Broadcast, None);
    for owner in [None, Some("ada")] {
        let mut record = thread(owner, ThreadRunState::Stopped);
        assert!(matches!(
            plan_thread_turn(&team, Some(&record), "go", &roster()),
            ThreadTurn::Stopped
        ));
        record.run_state = ThreadRunState::Active;
        assert!(!matches!(
            plan_thread_turn(&team, Some(&record), "go", &roster()),
            ThreadTurn::Stopped
        ));
    }
}

/// An owner that was removed from the group does not strand the thread.
#[test]
fn an_owner_that_left_the_group_falls_back_to_the_strategy() {
    let team = team(Coordination::Router, None);
    let record = thread(Some("gone"), ThreadRunState::Active);
    assert!(matches!(
        plan_thread_turn(&team, Some(&record), "go", &roster()),
        ThreadTurn::Strategy
    ));
}

#[test]
fn mentions_match_ids_and_names_with_a_boundary() {
    let roster = roster();
    assert_eq!(mentioned_members("ping @BOB stone now", &roster), ["bob"]);
    assert_eq!(
        mentioned_members("ping @cy, and @ada.", &roster),
        ["ada", "cy"]
    );
    // `@adam` is not `@ada`, and a bare name without `@` addresses nobody.
    assert!(mentioned_members("ask @adam, or Ada", &roster).is_empty());
    assert!(mentioned_members("mail me at x@example.com", &roster).is_empty());
}

#[test]
fn the_longest_mention_wins_at_one_position() {
    let roster: Vec<(String, String)> = [("a1", "Ada"), ("a2", "Ada Lovelace")]
        .into_iter()
        .map(|(id, name)| (id.to_owned(), name.to_owned()))
        .collect();
    assert_eq!(mentioned_members("@Ada Lovelace, please", &roster), ["a2"]);
    assert_eq!(mentioned_members("@Ada, please", &roster), ["a1"]);
}

/// Only the members the owner names, and that have not already answered, are
/// asked. The owner cannot ask itself.
#[test]
fn the_owner_asks_only_members_that_have_not_answered() {
    let responders = vec!["ada".to_owned(), "bob".to_owned()];
    let asked = asked_by_owner(
        "I will take this. @cy check the numbers, @bob too, and @ada.",
        "ada",
        &responders,
        &roster(),
    );
    assert_eq!(asked, ["cy"]);
    assert!(asked_by_owner("All done.", "ada", &responders, &roster()).is_empty());
}

#[test]
fn the_owner_brief_lists_teammates_but_not_the_owner() {
    let brief = owner_brief("Research", "ada", &roster());
    assert!(brief.contains("- Bob Stone (id: bob)"), "{brief}");
    assert!(!brief.contains("(id: ada)"), "{brief}");
    let alone = owner_brief("Solo", "ada", &roster()[..1]);
    assert!(!alone.contains("Teammates"), "{alone}");
}

/// The record crosses from a separately versioned provider, so an unknown run
/// state must not stop a thread and a missing field must not fail the parse.
#[test]
fn the_record_reads_leniently() {
    let record: TeamThread = serde_json::from_str(
        r#"{"team_id":"t","conversation_id":"c","run_state":"paused-for-review"}"#,
    )
    .unwrap();
    assert_eq!(record.run_state, ThreadRunState::Active);
    assert_eq!(record.owner_agent_id, None);
    for state in [ThreadRunState::Active, ThreadRunState::Stopped] {
        assert_eq!(ThreadRunState::from_str_lenient(state.as_str()), state);
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            serde_json::Value::String(state.as_str().to_owned())
        );
    }
}
