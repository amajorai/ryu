use super::*;
use crate::error::GatewayError;
use crate::providers::Provider;
use async_trait::async_trait;
// Core's real enum (dev-dependency, tests only) — the authority on which
// `tool_search.kind` values do anything. Aliased because
// `catalog_client::ToolKind`, the gateway's hand-written wire mirror, is already
// in scope via `super::*` and the whole point is to check one against the other's
// source of truth.
use ryu_tool_registry::ToolKind as CoreToolKind;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ── Mock provider ──────────────────────────────────────────────────────────

/// A provider that returns a scripted sequence of completion responses, one
/// per `complete` call. When the script is exhausted it repeats the last
/// entry (so a tool-emitting last entry drives the loop to `max_rounds`).
struct ScriptedProvider {
    responses: Vec<Value>,
    calls: AtomicUsize,
    /// Bodies seen on each complete call (to assert injection).
    seen_bodies: Mutex<Vec<Value>>,
}

impl ScriptedProvider {
    fn new(responses: Vec<Value>) -> Self {
        Self {
            responses,
            calls: AtomicUsize::new(0),
            seen_bodies: Mutex::new(Vec::new()),
        }
    }
    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Provider for ScriptedProvider {
    fn name(&self) -> &'static str {
        "scripted"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        let idx = self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen_bodies.lock().unwrap().push(body.clone());
        let resp = self
            .responses
            .get(idx)
            .or_else(|| self.responses.last())
            .cloned()
            .unwrap_or_else(|| json!({}));
        Box::pin(async move { Ok(resp) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(ryu_gw_providers::ProviderError::Provider(
                "no stream".into(),
            ))
        })
    }
}

// ── Mock catalog ───────────────────────────────────────────────────────────

#[derive(Default)]
struct MockCatalog {
    search_results: Vec<catalog_client::ToolDescriptor>,
    described: std::collections::HashMap<String, catalog_client::DescribedTool>,
    executed: Mutex<Vec<String>>,
    executed_users: Mutex<Vec<Option<String>>>,
    /// The `(host_conversation_id, host_conversation_proof)` each
    /// execution was forwarded with.
    executed_hosts: Mutex<Vec<(Option<String>, Option<String>)>>,
    /// The `untrusted_caller` flag each execution was forwarded with.
    executed_untrusted: Mutex<Vec<bool>>,
    described_scopes: Mutex<Vec<Option<String>>>,
    /// Replaces the default `{ "ran": id }` execution result when set.
    output: Option<Value>,
    /// Per-tool execution latency in milliseconds (none ⇒ returns at once).
    delays_ms: std::collections::HashMap<String, u64>,
    /// Executions currently inside `call_tool`, and the most seen at once.
    in_flight: AtomicUsize,
    peak_in_flight: AtomicUsize,
    /// `start:<id>` / `end:<id>` events in the order they happened.
    timeline: Mutex<Vec<String>>,
    /// Executions that ran to completion (past their delay).
    completed: AtomicUsize,
}

#[async_trait]
impl CoreCatalog for MockCatalog {
    async fn search(
        &self,
        _query: &str,
        _kind: Option<&str>,
        _limit: usize,
        _agent: Option<&str>,
    ) -> Result<Vec<catalog_client::ToolDescriptor>, String> {
        Ok(self.search_results.clone())
    }
    async fn describe(&self, id: &str) -> Result<catalog_client::DescribedTool, String> {
        self.described
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown {id}"))
    }
    async fn describe_for_agent(
        &self,
        id: &str,
        agent: Option<&str>,
    ) -> Result<catalog_client::DescribedTool, String> {
        self.described_scopes
            .lock()
            .unwrap()
            .push(agent.map(str::to_owned));
        self.describe(id).await
    }
    async fn call_tool(
        &self,
        tool_id: &str,
        _arguments: Value,
        _agent_id: Option<&str>,
        user_id: Option<&str>,
        host_conversation_id: Option<&str>,
        host_conversation_proof: Option<&str>,
        untrusted_caller: bool,
    ) -> Result<Value, String> {
        self.executed.lock().unwrap().push(tool_id.to_string());
        if let Some(ms) = self.delays_ms.get(tool_id).copied() {
            self.timeline
                .lock()
                .unwrap()
                .push(format!("start:{tool_id}"));
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_in_flight.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            self.timeline.lock().unwrap().push(format!("end:{tool_id}"));
            self.completed.fetch_add(1, Ordering::SeqCst);
        }
        self.executed_hosts.lock().unwrap().push((
            host_conversation_id.map(str::to_owned),
            host_conversation_proof.map(str::to_owned),
        ));
        self.executed_untrusted
            .lock()
            .unwrap()
            .push(untrusted_caller);
        self.executed_users
            .lock()
            .unwrap()
            .push(user_id.map(str::to_owned));
        Ok(self
            .output
            .clone()
            .unwrap_or_else(|| json!({ "ran": tool_id })))
    }
    async fn forward_exec(&self, _path: &str, _body: Value) -> Result<Value, String> {
        Err("not implemented in mock".into())
    }
}

fn descriptor(id: &str, name: &str) -> catalog_client::ToolDescriptor {
    catalog_client::ToolDescriptor {
        id: id.to_string(),
        name: name.to_string(),
        description: format!("desc {name}"),
        kind: catalog_client::ToolKind::Builtin,
        arg_names: vec![],
        arg_descriptions: vec![],
        score: Some(1.0),
    }
}

/// A `kind: skill` row — what Core returns for an Agent Skill in the merged
/// catalog. Ids are namespaced `skills.<slug>`.
fn skill_descriptor(id: &str, name: &str) -> catalog_client::ToolDescriptor {
    catalog_client::ToolDescriptor {
        kind: catalog_client::ToolKind::Skill,
        ..descriptor(id, name)
    }
}

fn described(id: &str, name: &str) -> catalog_client::DescribedTool {
    catalog_client::DescribedTool {
        id: id.to_string(),
        name: name.to_string(),
        description: format!("desc {name}"),
        args: vec![catalog_client::DescribedArg {
            name: "query".into(),
            r#type: "string".into(),
            description: "the query".into(),
            required: true,
        }],
        shallow: false,
        parameters: None,
        read_only: false,
    }
}

fn tool_call(id: &str, name: &str, args: &str) -> Value {
    json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": args }
                }]
            }
        }]
    })
}

fn model_tool(id: &str) -> String {
    catalog_client::model_tool_name(id)
}

fn final_text(text: &str) -> Value {
    json!({
        "id": "chatcmpl-x",
        "model": "m",
        "choices": [{
            "message": { "role": "assistant", "content": text },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
    })
}

/// Agent Skills come back from Core's one catalog, but they are not functions.
/// They must reach the model **listed with their kind** and must never be
/// injected as a callable tool definition.
#[tokio::test]
async fn skill_rows_are_listed_with_their_kind_but_never_injected() {
    let catalog = MockCatalog {
        search_results: vec![
            skill_descriptor("skills.merge-conflicts", "Resolve merge conflicts"),
            descriptor("exa.search", "search"),
        ],
        // Both are describable, so an injected skill WOULD be visible in `tools`
        // — the assertion below is about the skip, not about a describe failure.
        described: std::collections::HashMap::from([
            (
                "skills.merge-conflicts".to_string(),
                described("skills.merge-conflicts", "Resolve merge conflicts"),
            ),
            ("exa.search".to_string(), described("exa.search", "search")),
        ]),
        ..Default::default()
    };
    let ctx = ToolLoopContext::default();
    let mut body = json!({ "messages": [] });
    inject_search_tool(&mut body, &[]);

    let result = handle_search(
        &mut body,
        &catalog,
        &ctx,
        json!({ "query": "merge conflict" }),
        5,
        &mut HashSet::new(),
    )
    .await
    .expect("search");

    // The model sees both rows, each labelled with its plane.
    let rows = result["data"].as_array().expect("data array");
    let skill_row = rows
        .iter()
        .find(|r| r["id"] == json!("skills.merge-conflicts"))
        .unwrap_or_else(|| panic!("skill row missing: {result}"));
    assert_eq!(skill_row["kind"], json!("skill"), "{skill_row}");
    let tool_row = rows
        .iter()
        .find(|r| r["id"] == json!("exa.search"))
        .unwrap_or_else(|| panic!("tool row missing: {result}"));
    assert_eq!(tool_row["kind"], json!("builtin"), "{tool_row}");

    // Only the callable one became a function the model can emit.
    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(
        names.contains(&model_tool("exa.search").as_str()),
        "{names:?}"
    );
    assert!(
        !names.contains(&"skills.merge-conflicts"),
        "a skill must never be offered as a callable function: {names:?}"
    );
}

/// Telling the model to use `skills.load` is only actionable if it HAS
/// `skills.load`. On this plane it does not: the injected set is `tool_search`
/// plus whatever previous searches added. So a search that surfaces any skill
/// must inject the loader in the same round — including when every hit is a
/// skill and nothing else was injected at all.
#[tokio::test]
async fn surfacing_a_skill_injects_the_loader_the_model_needs() {
    let catalog = MockCatalog {
        search_results: vec![skill_descriptor("skills.merge-conflicts", "Conflicts")],
        described: std::collections::HashMap::from([(
            SKILLS_LOAD_TOOL_ID.to_string(),
            described(SKILLS_LOAD_TOOL_ID, "load"),
        )]),
        ..Default::default()
    };
    let ctx = ToolLoopContext::default();
    let mut body = json!({ "messages": [] });
    inject_search_tool(&mut body, &[]);

    let result = handle_search(
        &mut body,
        &catalog,
        &ctx,
        json!({ "query": "x" }),
        5,
        &mut HashSet::new(),
    )
    .await
    .expect("search");
    assert_eq!(
        result["data"].as_array().expect("data").len(),
        1,
        "the skill is still listed: {result}"
    );

    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(
        names.contains(&model_tool(SKILLS_LOAD_TOOL_ID).as_str()),
        "an all-skills result must still leave the model able to load: {names:?}"
    );
    // The skill itself is still not a function.
    assert!(!names.contains(&"skills.merge-conflicts"), "{names:?}");

    // Idempotent: a second search does not inject a duplicate definition.
    handle_search(
        &mut body,
        &catalog,
        &ctx,
        json!({ "query": "x" }),
        5,
        &mut HashSet::new(),
    )
    .await
    .expect("search");
    let loaders = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter(|t| t["function"]["name"] == json!(model_tool(SKILLS_LOAD_TOOL_ID)))
        .count();
    assert_eq!(loaders, 1, "the loader must be injected once");
}

/// A tools-only result must not drag the loader in — it is injected because a
/// skill needs it, not on every search.
#[tokio::test]
async fn a_result_without_skills_does_not_inject_the_loader() {
    let catalog = MockCatalog {
        search_results: vec![descriptor("exa.search", "search")],
        described: std::collections::HashMap::from([
            ("exa.search".to_string(), described("exa.search", "search")),
            (
                SKILLS_LOAD_TOOL_ID.to_string(),
                described(SKILLS_LOAD_TOOL_ID, "load"),
            ),
        ]),
        ..Default::default()
    };
    let ctx = ToolLoopContext::default();
    let mut body = json!({ "messages": [] });

    handle_search(
        &mut body,
        &catalog,
        &ctx,
        json!({ "query": "x" }),
        5,
        &mut HashSet::new(),
    )
    .await
    .expect("search");

    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert_eq!(names, vec![model_tool("exa.search").as_str()], "{names:?}");
}

/// The skip happens **before** `describe_top_n` is applied. With a budget of 1
/// and a skill ranked first, the real tool must still get injected — filtering
/// inside the loop would have spent the budget on the skill and injected nothing.
#[tokio::test]
async fn skills_do_not_consume_the_describe_budget() {
    let catalog = MockCatalog {
        search_results: vec![
            skill_descriptor("skills.a", "A skill"),
            skill_descriptor("skills.b", "Another skill"),
            descriptor("exa.search", "search"),
        ],
        described: std::collections::HashMap::from([(
            "exa.search".to_string(),
            described("exa.search", "search"),
        )]),
        ..Default::default()
    };
    let ctx = ToolLoopContext::default();
    let mut body = json!({ "messages": [] });

    handle_search(
        &mut body,
        &catalog,
        &ctx,
        json!({ "query": "x" }),
        1,
        &mut HashSet::new(),
    )
    .await
    .expect("search");

    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec![model_tool("exa.search").as_str()],
        "the one injection slot must go to the one callable hit"
    );
}

/// An untrusted-caller turn is offered exactly its allowlist, never
/// `tool_search`. A denied tool and a `tool_search` the model names anyway
/// are refused without reaching Core, and the allowed tool is forwarded
/// with the untrusted flag so Core applies its own profile too.
#[tokio::test]
async fn untrusted_caller_loop_offers_only_its_allowlist_and_refuses_the_rest() {
    let catalog = {
        let mut c = MockCatalog::default();
        c.search_results = vec![descriptor("spaces.list_documents", "list_documents")];
        c.described.insert(
            "notify.desktop".into(),
            described("notify.desktop", "desktop"),
        );
        c
    };
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", TOOL_SEARCH_NAME, r#"{"query":"documents"}"#),
        tool_call(
            "c2",
            model_tool("spaces.list_documents").as_str(),
            r#"{"space_id":"owner"}"#,
        ),
        tool_call(
            "c3",
            model_tool("notify.desktop").as_str(),
            r#"{"title":"Message from a caller"}"#,
        ),
        final_text("I'll pass that on."),
    ]);
    let allowed = vec!["notify.desktop".to_owned()];
    let ctx = ToolLoopContext {
        agent_id: Some("phone-agent".into()),
        allowed: allowed.clone(),
        untrusted_caller: true,
        ..Default::default()
    };
    assert!(!ctx.is_allowed(TOOL_SEARCH_NAME));
    let hints = allowlist_hint_envelope(&allowed);
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });

    let (out, _) = run_tool_loop_with_hints_for_session(
        &mut body,
        &provider,
        "m",
        &catalog,
        &ctx,
        6,
        5,
        hints.as_deref(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        out["choices"][0]["message"]["content"],
        "I'll pass that on."
    );

    let first = provider.seen_bodies.lock().unwrap()[0].clone();
    let offered: Vec<&str> = first["tools"]
        .as_array()
        .expect("the allowlisted tool is offered")
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert_eq!(offered, vec![model_tool("notify.desktop").as_str()]);
    assert_eq!(
        *catalog.executed.lock().unwrap(),
        vec!["notify.desktop".to_owned()],
        "neither the search nor the denied tool reached Core"
    );
    assert_eq!(*catalog.executed_untrusted.lock().unwrap(), vec![true]);
    let messages = body["messages"].as_array().unwrap();
    let refusals = messages
        .iter()
        .filter(|message| {
            message["role"] == "tool"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("is not allowed for this request"))
        })
        .count();
    assert_eq!(refusals, 2, "search and the denied tool are both refused");
}

#[test]
fn allowlist_hint_envelope_names_only_explicit_tools() {
    assert_eq!(allowlist_hint_envelope(&[]), None);
    assert_eq!(allowlist_hint_envelope(&["*".to_owned()]), None);
    let envelope =
        allowlist_hint_envelope(&["notify.desktop".to_owned(), "*".to_owned()]).expect("envelope");
    assert_eq!(
        serde_json::from_str::<Value>(&envelope).unwrap(),
        json!({ "tools": ["notify.desktop"] })
    );
}

#[tokio::test]
async fn search_injects_described_defs_then_executes() {
    let catalog = {
        let mut c = MockCatalog::default();
        c.search_results = vec![descriptor("exa.search", "search")];
        c.described
            .insert("exa.search".into(), described("exa.search", "search"));
        c
    };
    // Round 1: model calls tool_search. Round 2: model calls exa.search.
    // Round 3: model returns final text.
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", TOOL_SEARCH_NAME, r#"{"query":"web search"}"#),
        tool_call(
            "c2",
            model_tool("exa.search").as_str(),
            r#"{"query":"rust"}"#,
        ),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: Some("agent1".into()),
        user_id: None,
        allowed: vec!["exa.search".into()],
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    inject_search_tool(&mut body, &[]);

    let (out, billable) = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    assert_eq!(out["choices"][0]["message"]["content"], "done");
    // exa.search is not a Composio tool ⇒ not billable.
    assert_eq!(billable, 0);

    assert_eq!(
        *catalog.described_scopes.lock().unwrap(),
        vec![Some("agent1".to_owned())]
    );

    // The body's tools must now include the described exa.search def.
    let names: Vec<&str> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(names.contains(&TOOL_SEARCH_NAME));
    assert!(names.contains(&model_tool("exa.search").as_str()));
    // The allowed tool was executed.
    assert_eq!(catalog.executed.lock().unwrap().as_slice(), &["exa.search"]);
}

#[tokio::test]
async fn composio_search_uses_legal_alias_and_dispatches_canonical_id() {
    let canonical = "composio.SLACK_SEND_MESSAGE";
    let mut catalog = MockCatalog::default();
    let mut row = descriptor(canonical, "Send a Slack message");
    row.kind = catalog_client::ToolKind::Composio;
    catalog.search_results = vec![row];
    catalog.described.insert(
        canonical.to_owned(),
        described(canonical, "Send a Slack message"),
    );

    let provider = ScriptedProvider::new(vec![
        tool_call("c1", TOOL_SEARCH_NAME, r#"{"query":"slack"}"#),
        tool_call("c2", "composio__SLACK_SEND_MESSAGE", "{}"),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec![canonical.to_owned()],
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    inject_search_tool(&mut body, &[]);

    let (out, billable) = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();

    assert_eq!(out["choices"][0]["message"]["content"], "done");
    // Core charges the action after it executes; the Gateway-side counter
    // stays zero so this path cannot double-debit it.
    assert_eq!(billable, 0);
    assert_eq!(catalog.executed.lock().unwrap().as_slice(), &[canonical]);
    let names: Vec<&str> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert!(names.contains(&"composio__SLACK_SEND_MESSAGE"));
    assert!(!names.contains(&canonical));
}

#[tokio::test]
async fn unified_loop_does_not_duplicate_core_billing() {
    // #496: all three calls execute, but Core owns the charge event for
    // unified catalog dispatch. The Gateway must report no second debit.
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", "composio__SLACK_SEND_MESSAGE", "{}"),
        tool_call("c2", "composio__GITHUB_CREATE_ISSUE", "{}"),
        tool_call("c3", model_tool("exa.search").as_str(), r#"{"query":"x"}"#),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: None,
        user_id: Some("raw-user".into()),
        composio_user_id: Some("tenant-scope".into()),
        require_composio_user_id: true,
        allowed: vec![
            "composio.SLACK_SEND_MESSAGE".into(),
            "composio.GITHUB_CREATE_ISSUE".into(),
            "exa.search".into(),
        ],
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let (out, billable) = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    assert_eq!(out["choices"][0]["message"]["content"], "done");
    // All three executed; Core is the sole billing authority for Composio.
    assert_eq!(catalog.executed.lock().unwrap().len(), 3);
    assert_eq!(
        catalog.executed_users.lock().unwrap().as_slice(),
        [
            Some("tenant-scope".to_owned()),
            Some("tenant-scope".to_owned()),
            Some("raw-user".to_owned()),
        ]
    );
    assert_eq!(billable, 0);
}

/// Every execution carries the turn's proved host conversation to Core, so
/// Core applies the turn owner's own tool rules; a turn without one keeps
/// the fail-closed `None` pair.
#[tokio::test]
async fn unified_loop_relays_the_host_conversation_to_core() {
    for host in [
        Some(HostConversation {
            id: "conv-1".into(),
            proof: "proof-1".into(),
        }),
        None,
    ] {
        let catalog = MockCatalog::default();
        let provider = ScriptedProvider::new(vec![
            tool_call("c1", model_tool("github.create_issue").as_str(), "{}"),
            final_text("done"),
        ]);
        let ctx = ToolLoopContext {
            agent_id: Some("agent-1".into()),
            allowed: vec!["github.create_issue".into()],
            host_conversation: host.clone(),
            ..Default::default()
        };
        let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
            .await
            .unwrap();
        let expected = host.map(|host| (Some(host.id), Some(host.proof)));
        assert_eq!(
            catalog.executed_hosts.lock().unwrap().as_slice(),
            [expected.unwrap_or((None, None))]
        );
    }
}

#[tokio::test]
async fn shared_gateway_refuses_unscoped_composio_before_core_dispatch() {
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", "composio__SLACK_SEND_MESSAGE", "{}"),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: Some("agent1".into()),
        user_id: Some("spoofed-user".into()),
        require_composio_user_id: true,
        allowed: vec!["composio.SLACK_SEND_MESSAGE".into()],
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 3, 5)
        .await
        .unwrap();
    assert!(catalog.executed.lock().unwrap().is_empty());
    assert!(body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["role"] == "tool"
            && message["content"]
                .as_str()
                .is_some_and(|content| content.contains("authenticated organization"))));
}

#[tokio::test]
async fn denied_composio_call_is_not_billed() {
    // A `composio.*` call that fails the allowlist gate never reaches Core,
    // so it is not counted (no execution = no Composio charge).
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", "composio__SLACK_SEND_MESSAGE", "{}"),
        final_text("ok"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec![], // nothing allowed
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let (_, billable) = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    assert!(catalog.executed.lock().unwrap().is_empty());
    assert_eq!(billable, 0);
}

#[tokio::test]
async fn allowlist_denial_returns_error_not_execution() {
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", model_tool("exa.search").as_str(), r#"{"query":"x"}"#),
        final_text("ok"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: Some("agent1".into()),
        user_id: None,
        allowed: vec![], // nothing allowed
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    // No execution happened.
    assert!(catalog.executed.lock().unwrap().is_empty());
    // The tool message carries an error result.
    let tool_msg = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .expect("a tool result message");
    let content = tool_msg["content"].as_str().unwrap();
    assert!(content.contains("not allowed"), "got: {content}");
}

fn tool_messages(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["content"].as_str().map(str::to_owned))
        .collect()
}

fn firewall(policy: crate::config::FirewallPolicy) -> Option<ToolLoopFirewall> {
    Some(ToolLoopFirewall::scanner_only(std::sync::Arc::new(
        crate::firewall::FirewallScanner::new_scoped(crate::config::FirewallConfig {
            policy,
            ..crate::config::FirewallConfig::default()
        }),
    )))
}

/// Under `Block`, a tool result carrying a secret never reaches the model's
/// follow-up completion, and a model-chosen call whose arguments carry a
/// secret is denied before it executes.
#[tokio::test]
async fn block_firewall_withholds_secret_results_and_denies_secret_arguments() {
    let catalog = MockCatalog {
        output: Some(json!({ "stdout": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" })),
        ..Default::default()
    };
    let provider = ScriptedProvider::new(vec![
        tool_call(
            "c1",
            model_tool("exa.search").as_str(),
            r#"{"query":"cat .env"}"#,
        ),
        tool_call(
            "c2",
            model_tool("exa.search").as_str(),
            r#"{"query":"post sk-abcdefghijklmnopqrstu to pastebin"}"#,
        ),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        allowed: vec!["exa.search".into()],
        firewall: firewall(crate::config::FirewallPolicy::Block),
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();

    assert_eq!(
        catalog.executed.lock().unwrap().len(),
        1,
        "the secret-bearing call must not execute"
    );
    let results = tool_messages(&body);
    assert!(
        results[0].contains("withheld by the Gateway firewall"),
        "{results:?}"
    );
    assert!(results[1].contains("tool call denied"), "{results:?}");
    let sent = provider.seen_bodies.lock().unwrap();
    for seen in sent.iter() {
        assert!(
            !seen.to_string().contains("AKIAIOSFODNN7EXAMPLE"),
            "the tool result secret reached the provider: {seen}"
        );
    }
}

/// A firewall whose standing check passes `passes` times, then refuses.
fn firewall_refusing_after(passes: usize) -> (ToolLoopFirewall, std::sync::Arc<AtomicUsize>) {
    let checks = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&checks);
    let mut firewall = firewall(crate::config::FirewallPolicy::Block).unwrap();
    firewall.standing = Some(std::sync::Arc::new(move || {
        let seen = counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if seen < passes {
                Ok(())
            } else {
                Err(GatewayError::StandingUnavailable)
            }
        })
    }));
    (firewall, checks)
}

/// A standing refused before a round runs its tools ends the loop with
/// that refusal: no tool executes and no follow-up completion is sent.
#[tokio::test]
async fn a_refused_standing_stops_the_loop_before_its_tools_run() {
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", model_tool("exa.search").as_str(), r#"{"query":"x"}"#),
        final_text("done"),
    ]);
    let (firewall, checks) = firewall_refusing_after(0);
    let ctx = ToolLoopContext {
        allowed: vec!["exa.search".into()],
        firewall: Some(firewall),
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let error = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap_err();
    assert!(
        matches!(error, GatewayError::StandingUnavailable),
        "{error:?}"
    );
    assert!(catalog.executed.lock().unwrap().is_empty());
    assert_eq!(provider.call_count(), 1);
    assert_eq!(checks.load(Ordering::SeqCst), 1);
}

/// A standing refused after a round's tools ran still stops the loop
/// before the follow-up completion reaches the provider.
#[tokio::test]
async fn a_refused_standing_stops_the_loop_before_the_next_completion() {
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", model_tool("exa.search").as_str(), r#"{"query":"x"}"#),
        final_text("done"),
    ]);
    let (firewall, checks) = firewall_refusing_after(1);
    let ctx = ToolLoopContext {
        allowed: vec!["exa.search".into()],
        firewall: Some(firewall),
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let error = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap_err();
    assert!(
        matches!(error, GatewayError::StandingUnavailable),
        "{error:?}"
    );
    assert_eq!(catalog.executed.lock().unwrap().len(), 1);
    assert_eq!(provider.call_count(), 1, "no follow-up completion");
    assert_eq!(checks.load(Ordering::SeqCst), 2);
}

/// Under `Sanitize`, the tool result is redacted rather than withheld.
#[tokio::test]
async fn sanitize_firewall_redacts_tool_results_before_the_follow_up_completion() {
    let catalog = MockCatalog {
        output: Some(json!({ "stdout": "owner is admin@example.com" })),
        ..Default::default()
    };
    let provider = ScriptedProvider::new(vec![
        tool_call(
            "c1",
            model_tool("exa.search").as_str(),
            r#"{"query":"who"}"#,
        ),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        allowed: vec!["exa.search".into()],
        firewall: firewall(crate::config::FirewallPolicy::Sanitize),
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    let results = tool_messages(&body);
    assert!(!results[0].contains("admin@example.com"), "{results:?}");
    assert!(results[0].contains("[REDACTED:EMAIL]"), "{results:?}");
}

#[tokio::test]
async fn external_result_wrapped_tool_search_not() {
    // Injection defense: the external `exa.search` RESULT re-entering the
    // model is wrapped in untrusted-content boundary markers, while the
    // `tool_search` discovery envelope is returned verbatim (excluded).
    let _guard = crate::untrusted::FLAG_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::untrusted::set_enabled(true);
    let catalog = {
        let mut c = MockCatalog::default();
        c.search_results = vec![descriptor("exa.search", "search")];
        c.described
            .insert("exa.search".into(), described("exa.search", "search"));
        c
    };
    let provider = ScriptedProvider::new(vec![
        tool_call("c1", TOOL_SEARCH_NAME, r#"{"query":"web search"}"#),
        tool_call(
            "c2",
            model_tool("exa.search").as_str(),
            r#"{"query":"rust"}"#,
        ),
        final_text("done"),
    ]);
    let ctx = ToolLoopContext {
        agent_id: Some("agent1".into()),
        user_id: None,
        allowed: vec!["exa.search".into()],
        ..Default::default()
    };
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    inject_search_tool(&mut body, &[]);
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();

    let tool_msgs: Vec<&str> = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["content"].as_str())
        .collect();
    // Two tool results: the tool_search descriptor list and the exa.search
    // execution result.
    let search_content = tool_msgs
        .iter()
        .find(|c| c.contains("exa.search") && !c.contains("ran"))
        .expect("tool_search descriptor result");
    let exec_content = tool_msgs
        .iter()
        .find(|c| c.contains("ran"))
        .expect("exa.search execution result");
    // The external execution result is boundary-wrapped.
    assert!(
        exec_content.starts_with(crate::untrusted::UNTRUSTED_OPEN),
        "external result must be wrapped: {exec_content}"
    );
    assert!(exec_content.ends_with(crate::untrusted::UNTRUSTED_CLOSE));
    // The tool_search discovery envelope is NOT wrapped.
    assert!(
        !search_content.starts_with(crate::untrusted::UNTRUSTED_OPEN),
        "tool_search result must not be wrapped: {search_content}"
    );

    // Opt-out: with the flag off, the external result is not wrapped.
    crate::untrusted::set_enabled(false);
    let catalog2 = MockCatalog::default();
    let provider2 = ScriptedProvider::new(vec![
        tool_call("d1", model_tool("exa.search").as_str(), r#"{"query":"x"}"#),
        final_text("done"),
    ]);
    let ctx2 = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["exa.search".into()],
        ..Default::default()
    };
    let mut body2 = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let _ = run_tool_loop(&mut body2, &provider2, "m", &catalog2, &ctx2, 6, 5)
        .await
        .unwrap();
    let off_content = body2["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .unwrap();
    assert!(
        !off_content.contains(crate::untrusted::UNTRUSTED_OPEN),
        "opt-out must not wrap: {off_content}"
    );
    // Restore the default-ON state for other tests.
    crate::untrusted::set_enabled(true);
}

#[tokio::test]
async fn loop_terminates_at_max_rounds() {
    let catalog = MockCatalog::default();
    // Provider always emits a tool_search call → infinite without the cap.
    let provider =
        ScriptedProvider::new(vec![tool_call("c", TOOL_SEARCH_NAME, r#"{"query":"x"}"#)]);
    let ctx = ToolLoopContext::default();
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 3, 5)
        .await
        .unwrap();
    // 1 initial complete + 3 rounds each ending in a follow-up complete = 4.
    assert_eq!(provider.call_count(), 4);
}

#[tokio::test]
async fn run_tool_loop_strips_stream_options_for_provider() {
    // stream_options would be injected on the streaming path before the
    // tools branch; the buffered loop forces stream:false and must remove it
    // so OpenAI-family providers don't 400 on a non-streaming request.
    let catalog = MockCatalog::default();
    let provider = ScriptedProvider::new(vec![final_text("done")]);
    let ctx = ToolLoopContext::default();
    let mut body = json!({
        "messages": [{ "role": "user", "content": "hi" }],
        "stream": true,
        "stream_options": { "include_usage": true }
    });
    let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();
    // The provider must have seen stream:false and no stream_options.
    let seen = provider.seen_bodies.lock().unwrap();
    let first = &seen[0];
    assert_eq!(first["stream"], false);
    assert!(
        first.get("stream_options").is_none(),
        "stream_options must be stripped: {first}"
    );
}

#[test]
fn inject_search_tool_dedupes_and_merges() {
    let mut body = json!({
        "tools": [{ "type": "function", "function": { "name": "existing", "parameters": {} } }]
    });
    let always = json!({ "type": "function", "function": { "name": "always1", "parameters": {} } });
    inject_search_tool(&mut body, std::slice::from_ref(&always));
    // re-inject: tool_search must not duplicate.
    inject_search_tool(&mut body, &[]);
    let names: Vec<&str> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert_eq!(names.iter().filter(|n| **n == TOOL_SEARCH_NAME).count(), 1);
    assert!(names.contains(&"existing"));
    assert!(names.contains(&"always1"));
}

// ── Concurrent read-only tool calls ─────────────────────────────────────────

/// A described tool Core marked read-only (`readOnlyHint: true`).
fn described_read_only(id: &str) -> catalog_client::DescribedTool {
    catalog_client::DescribedTool {
        read_only: true,
        ..described(id, id)
    }
}

/// One assistant turn that emits every `(call_id, tool_id, args)` call at once.
fn tool_calls_turn(calls: &[(&str, &str, &str)]) -> Value {
    let calls: Vec<Value> = calls
        .iter()
        .map(|(id, tool, args)| {
            json!({
                "id": id,
                "type": "function",
                "function": { "name": model_tool(tool), "arguments": args }
            })
        })
        .collect();
    json!({
        "choices": [{
            "message": { "role": "assistant", "content": null, "tool_calls": calls }
        }]
    })
}

/// A catalog where every `(id, read_only, delay_ms)` tool is describable and
/// sleeps for its delay when executed.
fn timed_catalog(tools: &[(&str, bool, u64)]) -> MockCatalog {
    let mut catalog = MockCatalog::default();
    for (id, read_only, delay) in tools {
        let described = if *read_only {
            described_read_only(id)
        } else {
            described(id, id)
        };
        catalog.described.insert((*id).to_owned(), described);
        catalog.delays_ms.insert((*id).to_owned(), *delay);
    }
    catalog
}

/// Run one round of `calls` with every tool offered (and therefore described)
/// through the capability hints, then a final text turn.
async fn run_round(
    catalog: &MockCatalog,
    calls: &[(&str, &str, &str)],
    allowed: &[&str],
    parallel_reads: usize,
) -> Value {
    let allowed: Vec<String> = allowed.iter().map(|id| (*id).to_owned()).collect();
    let hints = allowlist_hint_envelope(&allowed);
    let ctx = ToolLoopContext {
        allowed,
        parallel_reads,
        ..Default::default()
    };
    let provider = ScriptedProvider::new(vec![tool_calls_turn(calls), final_text("done")]);
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    run_tool_loop_with_hints_for_session(
        &mut body,
        &provider,
        "m",
        catalog,
        &ctx,
        6,
        5,
        hints.as_deref(),
        None,
    )
    .await
    .unwrap();
    body
}

fn tool_message_ids(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["tool_call_id"].as_str().unwrap().to_owned())
        .collect()
}

fn position(timeline: &[String], event: &str) -> usize {
    timeline
        .iter()
        .position(|e| e == event)
        .unwrap_or_else(|| panic!("{event} missing from {timeline:?}"))
}

const SIX_READS: [&str; 6] = ["r.one", "r.two", "r.three", "r.four", "r.five", "r.six"];

/// Six independent reads run at most four at a time, yet their results land in
/// `tool_calls` order (the slowest is first) and the transcript is byte-equal to
/// the fully sequential run.
#[tokio::test]
async fn read_only_calls_run_concurrently_and_keep_call_order() {
    // Decreasing latency: a completion-ordered append would reverse them.
    let tools: Vec<(&str, bool, u64)> = SIX_READS
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, true, 60 - 10 * i as u64))
        .collect();
    let calls: Vec<(String, &str)> = SIX_READS
        .iter()
        .enumerate()
        .map(|(i, id)| (format!("c{i}"), *id))
        .collect();
    let calls: Vec<(&str, &str, &str)> = calls
        .iter()
        .map(|(call, id)| (call.as_str(), *id, r#"{"query":"q"}"#))
        .collect();

    let parallel = timed_catalog(&tools);
    let parallel_body = run_round(&parallel, &calls, &SIX_READS, 4).await;
    let peak = parallel.peak_in_flight.load(Ordering::SeqCst);
    assert!(peak > 1, "reads must overlap, peak was {peak}");
    assert!(
        peak <= 4,
        "parallel_reads=4 must bound the batch, peak was {peak}"
    );
    assert_eq!(
        tool_message_ids(&parallel_body),
        vec!["c0", "c1", "c2", "c3", "c4", "c5"]
    );

    let sequential = timed_catalog(&tools);
    let sequential_body = run_round(&sequential, &calls, &SIX_READS, 1).await;
    assert_eq!(sequential.peak_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_string(&parallel_body["messages"]).unwrap(),
        serde_json::to_string(&sequential_body["messages"]).unwrap(),
        "the transcript must not depend on concurrency"
    );
}

/// A write between reads is a barrier: it starts only after every read before
/// it has finished, and nothing after it starts until it has finished.
#[tokio::test]
async fn a_write_between_reads_runs_alone() {
    let catalog = timed_catalog(&[
        ("r.a", true, 30),
        ("r.b", true, 30),
        ("w.change", false, 30),
        ("r.c", true, 30),
        ("r.d", true, 30),
    ]);
    let ids = ["r.a", "r.b", "w.change", "r.c", "r.d"];
    let calls = [
        ("c1", "r.a", "{}"),
        ("c2", "r.b", "{}"),
        ("c3", "w.change", "{}"),
        ("c4", "r.c", "{}"),
        ("c5", "r.d", "{}"),
    ];
    let body = run_round(&catalog, &calls, &ids, 4).await;

    assert_eq!(tool_message_ids(&body), vec!["c1", "c2", "c3", "c4", "c5"]);
    assert_eq!(catalog.peak_in_flight.load(Ordering::SeqCst), 2);
    let timeline = catalog.timeline.lock().unwrap().clone();
    let write_start = position(&timeline, "start:w.change");
    let write_end = position(&timeline, "end:w.change");
    assert_eq!(
        write_end,
        write_start + 1,
        "nothing overlaps the write: {timeline:?}"
    );
    for read in ["r.a", "r.b"] {
        assert!(position(&timeline, &format!("end:{read}")) < write_start);
    }
    for read in ["r.c", "r.d"] {
        assert!(position(&timeline, &format!("start:{read}")) > write_end);
    }
}

/// An older Core that does not send `read_only` (or any tool Core did not mark
/// read-only) keeps the loop fully sequential.
#[tokio::test]
async fn tools_without_read_only_stay_sequential() {
    let tools: Vec<(&str, bool, u64)> = SIX_READS.iter().map(|id| (*id, false, 10)).collect();
    let catalog = timed_catalog(&tools);
    let calls: Vec<(&str, &str, &str)> = SIX_READS
        .iter()
        .zip(["c0", "c1", "c2", "c3", "c4", "c5"])
        .map(|(id, call)| (call, *id, "{}"))
        .collect();
    run_round(&catalog, &calls, &SIX_READS, 4).await;
    assert_eq!(catalog.peak_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(catalog.completed.load(Ordering::SeqCst), 6);
}

/// A call refused by the allowlist is a barrier that keeps its position and its
/// usual error envelope; the reads on either side of it do not overlap.
#[tokio::test]
async fn a_denied_call_inside_a_read_run_is_a_barrier() {
    let catalog = timed_catalog(&[("r.a", true, 30), ("r.b", true, 30)]);
    let calls = [
        ("c1", "r.a", "{}"),
        ("c2", "secret.read", "{}"),
        ("c3", "r.b", "{}"),
    ];
    let body = run_round(&catalog, &calls, &["r.a", "r.b"], 4).await;

    assert_eq!(tool_message_ids(&body), vec!["c1", "c2", "c3"]);
    let denied = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["tool_call_id"] == "c2")
        .unwrap();
    assert_eq!(
        denied["content"],
        json!({ "error": "tool 'secret.read' is not allowed for this request" }).to_string()
    );
    assert_eq!(catalog.peak_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(
        *catalog.timeline.lock().unwrap(),
        vec!["start:r.a", "end:r.a", "start:r.b", "end:r.b"]
    );
}

/// `tool_search` runs alone and still injects, but a read-only tool it
/// describes only becomes concurrent from the NEXT round: the round's plan is
/// fixed before the search runs.
#[tokio::test]
async fn tool_search_is_a_barrier_and_its_read_only_hits_apply_next_round() {
    let mut catalog = timed_catalog(&[("r.a", true, 30), ("r.b", true, 30)]);
    catalog.search_results = vec![descriptor("r.a", "a"), descriptor("r.b", "b")];
    let ctx = ToolLoopContext {
        allowed: vec!["r.a".into(), "r.b".into()],
        parallel_reads: 4,
        ..Default::default()
    };
    let provider = ScriptedProvider::new(vec![
        json!({
            "choices": [{ "message": { "role": "assistant", "content": null, "tool_calls": [
                { "id": "s1", "type": "function",
                  "function": { "name": TOOL_SEARCH_NAME, "arguments": r#"{"query":"x"}"# } },
                { "id": "c1", "type": "function",
                  "function": { "name": model_tool("r.a"), "arguments": "{}" } },
                { "id": "c2", "type": "function",
                  "function": { "name": model_tool("r.b"), "arguments": "{}" } }
            ] } }]
        }),
        tool_calls_turn(&[("c3", "r.a", "{}"), ("c4", "r.b", "{}")]),
        final_text("done"),
    ]);
    let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
    inject_search_tool(&mut body, &[]);

    run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
        .await
        .unwrap();

    assert_eq!(tool_message_ids(&body), vec!["s1", "c1", "c2", "c3", "c4"]);
    let names: Vec<&str> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(names.contains(&model_tool("r.a").as_str()), "{names:?}");
    let timeline = catalog.timeline.lock().unwrap().clone();
    assert_eq!(
        &timeline[..4],
        &["start:r.a", "end:r.a", "start:r.b", "end:r.b"],
        "round 1 ran sequentially: {timeline:?}"
    );
    assert!(
        timeline[4].starts_with("start:") && timeline[5].starts_with("start:"),
        "round 2 overlapped: {timeline:?}"
    );
}

/// Dropping the loop future mid-batch cancels the in-flight calls: no call
/// completes after the drop.
#[tokio::test]
async fn dropping_the_loop_cancels_in_flight_reads() {
    let tools: Vec<(&str, bool, u64)> = SIX_READS.iter().map(|id| (*id, true, 200)).collect();
    let catalog = timed_catalog(&tools);
    let calls: Vec<(&str, &str, &str)> = SIX_READS
        .iter()
        .zip(["c0", "c1", "c2", "c3", "c4", "c5"])
        .map(|(id, call)| (call, *id, "{}"))
        .collect();

    let outcome = tokio::time::timeout(
        std::time::Duration::from_millis(60),
        run_round(&catalog, &calls, &SIX_READS, 4),
    )
    .await;
    assert!(
        outcome.is_err(),
        "the loop must still be running at the timeout"
    );
    assert_eq!(catalog.peak_in_flight.load(Ordering::SeqCst), 4);

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        catalog.completed.load(Ordering::SeqCst),
        0,
        "a dropped batch must not keep executing"
    );
    assert_eq!(catalog.executed.lock().unwrap().len(), 4);
}

#[test]
fn shallow_described_tool_synthesizes_permissive_schema() {
    let dt = catalog_client::DescribedTool {
        id: "composio.SLACK".into(),
        name: "SLACK".into(),
        description: "".into(),
        args: vec![],
        shallow: true,
        parameters: None,
        read_only: false,
    };
    let params = dt.to_function_parameters();
    assert_eq!(params["type"], "object");
    assert!(params["properties"]["arguments"].is_object());
}

#[tokio::test]
async fn value_to_sse_carries_usage_and_content() {
    let resp = final_text("hello");
    let body = value_to_sse_stream(&resp);
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    // Final assistant content is streamed as a delta.
    assert!(
        text.contains("\"content\":\"hello\""),
        "missing content: {text}"
    );
    // A terminal usage frame carries the buffered turn's token counts so the
    // stream observer records real tokens.
    assert!(
        text.contains("\"prompt_tokens\":10"),
        "missing usage: {text}"
    );
    assert!(
        text.contains("\"completion_tokens\":5"),
        "missing usage: {text}"
    );
    assert!(
        text.trim_end().ends_with("data: [DONE]"),
        "missing DONE: {text}"
    );
}

#[test]
fn allowlist_matches_fully_qualified_id_only() {
    // Bare-server / bare-name entries must NOT authorize a FQ id
    // (spec §3 security fix #1, lines 218/961/966 — no cross-plane bypass).
    let bare = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["spider".into(), "crawl".into()],
        ..Default::default()
    };
    assert!(
        !bare.is_allowed("spider.crawl"),
        "bare server/name must not grant a fully-qualified tool"
    );
    // The exact FQ id authorizes.
    let exact = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["spider.crawl".into()],
        ..Default::default()
    };
    assert!(exact.is_allowed("spider.crawl"));
    assert!(ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["composio.SLACK_SEND_MESSAGE".into()],
        ..Default::default()
    }
    .is_allowed("composio__SLACK_SEND_MESSAGE"));
    // tool_search is always allowed; an unrelated id is not.
    assert!(exact.is_allowed(TOOL_SEARCH_NAME));
    assert!(!exact.is_allowed("exa.search"));
}

#[test]
fn wildcard_allows_any_tool_for_unrestricted_profile() {
    // The "full"/unrestricted tool-policy profile resolves to a single "*"
    // allowlist entry, which must permit any catalog tool.
    let full = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["*".into()],
        ..Default::default()
    };
    assert!(full.is_allowed("spider.crawl"));
    assert!(full.is_allowed("exa.search"));
    assert!(full.is_allowed(TOOL_SEARCH_NAME));
    // Without "*", a non-listed id is still denied (deny-by-default intact).
    let scoped = ToolLoopContext {
        agent_id: None,
        user_id: None,
        allowed: vec!["spider.crawl".into()],
        ..Default::default()
    };
    assert!(!scoped.is_allowed("exa.search"));
}

/// The `kind` filter advertised to the model must be exactly the set Core's
/// [`CoreToolKind::parse_filter`] honors (`crates/core/tool-registry`), plus the
/// `any` sentinel the gateway strips before the request.
///
/// Both directions are bugs, so both are asserted against the real
/// `parse_filter` (a dev-only dependency; the gateway's runtime still never
/// links Core). Advertising **more** would be a lie — `parse_filter` maps
/// anything unrecognized to "no filter", so the model would get every plane back
/// and believe it filtered. Advertising **less** is what hid `core-api`/`command`
/// from it. Mirrors Core's ACP twin,
/// `sidecar::adapters::mcp_bridge::tests::advertised_kind_filter_matches_cores_parse_filter_set`,
/// so the two planes cannot drift apart from each other either.
#[test]
fn advertised_kind_filter_matches_cores_parse_filter_set() {
    let def = tool_search_def();
    let kinds = def["function"]["parameters"]["properties"]["kind"]["enum"]
        .as_array()
        .expect("kind must advertise an enum")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    // Direction 1: everything advertised is honored by Core.
    for kind in &kinds {
        if *kind == "any" {
            assert_eq!(
                CoreToolKind::parse_filter(kind),
                None,
                "'any' is the documented no-filter sentinel"
            );
            continue;
        }
        assert!(
            CoreToolKind::parse_filter(kind).is_some(),
            "advertised kind '{kind}' is not honored by Core's parse_filter — the \
             model would filter and silently get every plane back"
        );
    }

    // Direction 2: every plane Core can filter on is advertised, or that plane is
    // unreachable for every model driven through the gateway's tool loop.
    // Enumerated from `CoreToolKind::ALL` — the enum's own list — so a plane Core
    // grows cannot be missed by a list copied into this file, which is precisely
    // how `core-api` and `command` stayed invisible.
    for kind in CoreToolKind::ALL.iter().copied() {
        let wire = kind.wire_name();
        assert_eq!(
            CoreToolKind::parse_filter(wire),
            Some(kind),
            "'{wire}' must be the wire spelling of {kind:?}"
        );
        assert!(
            kinds.contains(&wire),
            "'{wire}' is filterable in Core but not advertised to the model"
        );
    }
    assert_eq!(
        kinds.len(),
        CoreToolKind::ALL.len() + 1,
        "exactly every ToolKind plus the 'any' sentinel: {kinds:?}"
    );
    assert_eq!(
        def["function"]["parameters"]["properties"]["kind"]["default"],
        "any"
    );
}

// ── Tool-result bounding (ported from Core's mcp_bridge) ───────────────────

#[test]
fn bound_tool_result_passes_short_results_through() {
    let text = "exit 0\nall good".to_owned();
    assert_eq!(bound_tool_result(text.clone(), 100), text);
    assert_eq!(bound_tool_result(String::new(), 0), "");
}

#[test]
fn bound_tool_result_keeps_head_and_tail() {
    let text = format!("HEAD{}TAIL", "x".repeat(1_000));
    let bounded = bound_tool_result(text, 20);
    assert!(bounded.starts_with("HEADxxxxxx\n"), "{bounded}");
    assert!(bounded.ends_with("\nxxxxxxTAIL"), "{bounded}");
    assert!(bounded.contains("[988 characters omitted"), "{bounded}");
}

#[test]
fn bound_tool_result_cuts_on_char_boundaries() {
    let bounded = bound_tool_result("é".repeat(50), 10);
    assert!(bounded.starts_with("ééééé\n"), "{bounded}");
    assert!(bounded.ends_with("...\nééééé"), "{bounded}");
    assert!(bounded.contains("[40 characters omitted"), "{bounded}");
}

/// Byte-for-byte parity with Core's `mcp_bridge` on Core's own test
/// fixtures, so a model sees the same cut and the same elision note
/// whichever plane ran the tool loop.
#[test]
fn bounding_matches_core_output_on_core_fixtures() {
    let marker = |omitted: usize| {
        format!(
            "\n...[{omitted} characters omitted from the middle of this tool result; \
             narrow the request to see them]...\n"
        )
    };
    assert_eq!(
        bound_tool_result(format!("HEAD{}TAIL", "x".repeat(1_000)), 20),
        format!("HEADxxxxxx{}xxxxxxTAIL", marker(988))
    );
    assert_eq!(
        bound_tool_result("é".repeat(50), 10),
        format!("ééééé{}ééééé", marker(40))
    );

    let screenshot = json!({
        "url": "https://example.com",
        "screenshot": { "image": "A".repeat(40_000), "encoding": "base64", "mime": "image/png" },
        "title": "Example",
    })
    .to_string();
    let value: Value = serde_json::from_str(&elide_inline_images(screenshot)).unwrap();
    assert_eq!(value["title"], "Example");
    assert_eq!(
        value["screenshot"]["image"],
        "[image/png image, ~29 KB, omitted: base64 is not readable as text. \
         Use an accessibility snapshot or page text to inspect content]"
    );

    let mcp_block = json!({
        "content": [
            { "type": "text", "text": "captured" },
            { "type": "image", "data": "B".repeat(8_000), "mimeType": "image/jpeg" },
        ]
    })
    .to_string();
    let value: Value = serde_json::from_str(&elide_inline_images(mcp_block)).unwrap();
    assert_eq!(value["content"][0]["text"], "captured");
    assert!(value["content"][1]["data"]
        .as_str()
        .unwrap()
        .starts_with("[image/jpeg image, ~5 KB, omitted"));

    // Below the elision threshold, and non-image base64, pass through.
    let long_text = "x".repeat(5_000);
    assert_eq!(elide_inline_images(long_text.clone()), long_text);
    let pdf = json!({ "data": "y".repeat(5_000), "encoding": "base64", "mime": "application/pdf" })
        .to_string();
    assert_eq!(elide_inline_images(pdf.clone()), pdf);
}

#[test]
fn external_result_is_bounded_inside_intact_boundary_markers() {
    let _guard = crate::untrusted::FLAG_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::untrusted::set_enabled(true);
    let huge = json!({ "body": "y".repeat(MAX_TOOL_RESULT_CHARS * 3) });

    let content = external_tool_result_content(None, "http.fetch", &huge);

    assert!(
        content.starts_with(crate::untrusted::UNTRUSTED_OPEN),
        "{}",
        &content[..80]
    );
    assert!(content.ends_with(crate::untrusted::UNTRUSTED_CLOSE));
    assert!(content.contains("characters omitted from the middle"));
    assert!(content.chars().count() < MAX_TOOL_RESULT_CHARS + 1_000);
}

#[test]
fn internal_results_are_bounded_except_meta_tool_envelopes() {
    let huge = json!({ "error": "z".repeat(MAX_TOOL_RESULT_CHARS * 2) });
    let full = huge.to_string();
    assert!(
        internal_tool_result_content("exa.search", &huge)
            .chars()
            .count()
            < full.len()
    );
    assert_eq!(internal_tool_result_content(TOOL_SEARCH_NAME, &huge), full);
    assert_eq!(internal_tool_result_content("describe", &huge), full);
}
