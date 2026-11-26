//! Task ownership in a group thread, against a fixture provider of the
//! `teams.thread` capability: owner change, Stop and Resume, and the fallback
//! to the old behaviour when nothing provides the capability.

use super::*;

use axum::routing::post;
use axum::{Json, Router};
use ryu_teams_contracts::Coordination;
use serde_json::{json, Value};

use crate::sidecar::capability_consumer::test_support::{
    consumer_without_providers, registered, serve,
};

type SharedThread = Arc<std::sync::Mutex<Value>>;

fn team() -> TeamRecord {
    TeamRecord {
        id: "team_1".to_owned(),
        name: "Research".to_owned(),
        description: None,
        members: vec!["ada".to_owned(), "bob".to_owned(), "cy".to_owned()],
        coordination: Coordination::RoundRobin,
        lead_agent_id: None,
        created_at: None,
        updated_at: None,
    }
}

fn agents() -> AgentStore {
    AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap()
}

fn user(text: &str) -> UiMessage {
    UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Text(text.to_owned()),
        parts: vec![],
    }
}

fn record(owner: Option<&str>, run_state: &str) -> SharedThread {
    Arc::new(std::sync::Mutex::new(json!({
        "team_id": "team_1",
        "conversation_id": "conv_1",
        "owner_agent_id": owner,
        "run_state": run_state,
    })))
}

fn set(thread: &SharedThread, key: &str, value: Value) {
    thread.lock().unwrap()[key] = value;
}

/// A provider of `teams.thread` that serves whatever `thread` currently holds.
async fn provider(thread: &SharedThread) -> CapabilityConsumer {
    let (consumer, _sidecar, port) = registered(&[(CAP_TEAMS_THREAD, Some("/threads/open"))]).await;
    let served = Arc::clone(thread);
    let app = Router::new().route(
        "/api/fixture/threads/open",
        post(move || {
            let served = Arc::clone(&served);
            async move { Json(json!({ "thread": served.lock().unwrap().clone() })) }
        }),
    );
    serve(port, app).await;
    consumer
}

async fn open(
    capabilities: &CapabilityConsumer,
    user_text: &str,
) -> Result<(TeamRecord, Option<Arc<TeamThreadTurn>>), String> {
    open_thread_turn(capabilities, team(), Some("conv_1"), user_text, &agents()).await
}

/// Groups served by a provider without the capability, and temporary chats,
/// keep the behaviour they had before threads could have an owner.
#[tokio::test]
async fn without_a_thread_record_the_team_runs_unchanged() {
    let none = consumer_without_providers();
    let (unchanged, turn) = open(&none, "hello").await.unwrap();
    assert_eq!(unchanged.members, team().members);
    assert_eq!(unchanged.coordination, Coordination::RoundRobin);
    assert!(turn.is_none());

    let thread = record(Some("bob"), "active");
    let capabilities = provider(&thread).await;
    let (unchanged, turn) = open_thread_turn(&capabilities, team(), None, "hello", &agents())
        .await
        .unwrap();
    assert_eq!(
        unchanged.members,
        team().members,
        "a temporary chat has no thread"
    );
    assert!(turn.is_none());
}

#[tokio::test]
async fn the_owner_answers_and_reassigning_changes_who_does() {
    let thread = record(Some("bob"), "active");
    let capabilities = provider(&thread).await;

    let (narrowed, turn) = open(&capabilities, "status?").await.unwrap();
    assert_eq!(narrowed.members, ["bob"], "exactly one agent owns the task");
    assert!(turn.is_some());

    // Reassign: the next turn goes to the new owner.
    set(&thread, "owner_agent_id", json!("cy"));
    let (narrowed, _) = open(&capabilities, "status?").await.unwrap();
    assert_eq!(narrowed.members, ["cy"]);

    // A member the user addresses joins the owner under the team's strategy.
    let (narrowed, _) = open(&capabilities, "@ada what do you think?")
        .await
        .unwrap();
    assert_eq!(narrowed.members, ["cy", "ada"]);
    assert_eq!(narrowed.coordination, Coordination::RoundRobin);

    // No owner: the record only carries the state, the whole team answers.
    set(&thread, "owner_agent_id", Value::Null);
    let (unowned, turn) = open(&capabilities, "status?").await.unwrap();
    assert_eq!(unowned.members, team().members);
    assert!(
        turn.is_some(),
        "Stop still applies to a thread with no owner"
    );
}

#[tokio::test]
async fn a_stopped_thread_refuses_new_runs_until_it_is_resumed() {
    let thread = record(Some("bob"), "stopped");
    let capabilities = provider(&thread).await;
    let refusal = open(&capabilities, "go").await.err().expect("refused");
    assert!(refusal.contains("stopped"), "{refusal}");

    set(&thread, "run_state", json!("active"));
    let (narrowed, _) = open(&capabilities, "go").await.unwrap();
    assert_eq!(narrowed.members, ["bob"], "Resume keeps the owner");
}

/// Stop reaches a run that is already in flight: the member's run is dropped
/// and the turn knows it was stopped, so it starts no further member.
#[tokio::test]
async fn stop_ends_a_member_run_that_is_in_flight() {
    let thread = record(Some("bob"), "active");
    let capabilities = provider(&thread).await;
    let (_, turn) = open(&capabilities, "go").await.unwrap();
    let turn = turn.unwrap();

    let stopper = Arc::clone(&thread);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        set(&stopper, "run_state", json!("stopped"));
    });
    let never_finishes = async {
        tokio::time::sleep(Duration::from_secs(120)).await;
        Ok("too late".to_owned())
    };
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        turn.run("bob", true, never_finishes),
    )
    .await
    .expect("Stop must end the run well before it would finish");
    assert!(outcome.is_err());
    assert!(turn.is_stopped());

    // The members the owner started are not started after a Stop either.
    let next = turn
        .run("cy", true, async { Ok("unused".to_owned()) })
        .await;
    assert!(next.is_err(), "a stopped turn starts no further member");
}

#[tokio::test]
async fn the_owner_is_briefed_and_the_members_it_asks_answer_once() {
    let thread = record(Some("bob"), "active");
    let capabilities = provider(&thread).await;
    let (_, turn) = open(&capabilities, "go").await.unwrap();
    let turn = turn.unwrap();

    let briefed = turn.brief("bob", vec![user("go")]);
    assert!(briefed[0]
        .content
        .as_text()
        .starts_with("You own this task"));
    assert!(briefed[0].content.as_text().ends_with("go"));
    let plain = turn.brief("cy", vec![user("go")]);
    assert_eq!(plain[0].content.as_text(), "go");

    assert!(turn.asked(&[user("go")]).is_empty(), "nothing asked yet");
    let reply = turn
        .run("bob", true, async {
            Ok("I have it. @cy please check the numbers.".to_owned())
        })
        .await
        .unwrap();
    assert!(reply.contains("@cy"));

    let asked = turn.asked(&[user("go")]);
    assert_eq!(asked.len(), 1, "only the member the owner named");
    let (id, name, messages) = &asked[0];
    assert_eq!((id.as_str(), name.as_str()), ("cy", "cy"));
    let prompt = messages[0].content.as_text();
    assert!(prompt.contains("asked you for help"), "{prompt}");
    assert!(prompt.contains("check the numbers"), "{prompt}");

    // A reply from someone who is not the owner asks nobody.
    turn.run("cy", true, async { Ok("@ada over to you".to_owned()) })
        .await
        .unwrap();
    assert_eq!(turn.asked(&[user("go")]).len(), 1);
}
