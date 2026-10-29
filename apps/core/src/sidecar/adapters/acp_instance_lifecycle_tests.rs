use super::*;

/// A turn that is admitted, scoped to `conversation` when one is given.
fn queued_turn(events: mpsc::UnboundedSender<AcpEvent>, conversation: Option<&str>) -> AcpTurn {
    AcpTurn {
        admission: crate::execution_control::admit(),
        prompt: "hello".to_owned(),
        delta_prompt: "hello".to_owned(),
        images: Vec::new(),
        turn: AcpTurnConfig::default(),
        mcp: None,
        allowlist: None,
        composio_actions: Vec::new(),
        agent_id: "acp:test".to_owned(),
        provider_account_identity: None,
        identity_profile_ids: Vec::new(),
        composio_connection_scope: None,
        conversation_scope: None,
        permission_scope_id: conversation.map(str::to_owned),
        conversation_generation: None,
        events,
    }
}

/// Trust `dir` so the instance starts the fake agent unconfined. Held for
/// the test: the trusted-folder list is process-global.
fn trust(dir: &Path) -> std::sync::MutexGuard<'static, ()> {
    let guard = crate::workspace_trust::TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::workspace_trust::set_from_pref(
        &serde_json::to_string(&[dir.to_string_lossy()]).unwrap(),
    );
    guard
}

fn fake_agent(dir: &Path, body: &str, argument: &str) -> String {
    let node = resolve_in_path("node").expect("Node is required for ACP wire tests");
    let script = dir.join("agent.js");
    std::fs::write(&script, body).unwrap();
    acp_stdio_spawn_json(
        "fake",
        node,
        vec![script.to_string_lossy().into_owned(), argument.to_owned()],
        vec![],
    )
    .unwrap()
}

/// Every event a turn receives until the instance closes its stream.
async fn drain(events: &mut mpsc::UnboundedReceiver<AcpEvent>) -> Vec<AcpEvent> {
    let mut seen = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(20), events.recv())
        .await
        .expect("the turn's stream must end")
    {
        seen.push(event);
    }
    seen
}

fn texts(events: &[AcpEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            AcpEvent::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

const SESSION_REJECTING_AGENT: &str = r#"
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===undefined) return;
 const response=m.method==='initialize'
  ? {result:{protocolVersion:1,agentCapabilities:{}}}
  : {error:{code:Number(process.argv[2]),message:'Authentication required'}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...response})+'\n');
});
"#;

#[tokio::test]
async fn a_session_new_failure_answers_every_queued_turn() {
    let dir = tempfile::tempdir().unwrap();
    let _trusted = trust(dir.path());
    for (code, expected) in [
        (ACP_AUTH_REQUIRED_CODE, "auth_required"),
        (-32603, "agent_start_failed"),
    ] {
        let spawn = fake_agent(dir.path(), SESSION_REJECTING_AGENT, &code.to_string());
        let (turns_tx, turns_rx) = mpsc::unbounded_channel();
        let (first_tx, mut first_rx) = mpsc::unbounded_channel();
        let (second_tx, mut second_rx) = mpsc::unbounded_channel();
        turns_tx.send(queued_turn(first_tx, None)).unwrap();
        turns_tx.send(queued_turn(second_tx, None)).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            run_acp_instance(
                spawn,
                dir.path().to_path_buf(),
                Vec::new(),
                Vec::new(),
                None,
                None,
                turns_rx,
                None,
                crate::agent_access::AccountConfinement::None,
            ),
        )
        .await
        .expect("the instance ends");
        assert!(result.is_err(), "a failed session/new ends the instance");
        for (index, events) in [&mut first_rx, &mut second_rx].into_iter().enumerate() {
            let events = drain(events).await;
            let auth_needed = events.iter().any(|event| {
                matches!(event, AcpEvent::AuthNeeded { agent_id, .. } if agent_id == "acp:test")
            });
            assert_eq!(
                auth_needed,
                code == ACP_AUTH_REQUIRED_CODE,
                "turn {index}, code {code}: {events:?} ({result:?})"
            );
            match events.last() {
                Some(AcpEvent::Error(failure)) => assert_eq!(failure.code, expected),
                other => panic!("the turn must end with an error, got {other:?}"),
            }
        }
    }
    crate::workspace_trust::set_from_pref("");
}

#[tokio::test]
async fn a_start_up_failure_before_spawn_answers_the_turn_with_its_code() {
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    turns_tx.send(queued_turn(first_tx, None)).unwrap();
    let result = run_acp_instance(
        acp_stdio_spawn_json("fake", PathBuf::from("/nonexistent/agent"), vec![], vec![]).unwrap(),
        std::env::temp_dir(),
        Vec::new(),
        vec![("RYU_PI_ACCOUNT_CAPTURE".to_owned(), "not json".to_owned())],
        None,
        None,
        turns_rx,
        None,
        crate::agent_access::AccountConfinement::None,
    )
    .await;
    assert!(result.is_err());
    match drain(&mut first_rx).await.as_slice() {
        [AcpEvent::Error(failure)] => assert_eq!(failure.code, "pi_account_required"),
        other => panic!("expected the Pi account failure, got {other:?}"),
    }
}

#[test]
fn start_up_errors_keep_a_stable_code() {
    let (gateway, _) = instance_start_failure(&anyhow::Error::from(GatewayStartupPending));
    assert_eq!(gateway.code, "gateway_starting");
    let (other, auth) = instance_start_failure(&anyhow::anyhow!("spawn failed"));
    assert_eq!(other.code, "agent_start_failed");
    assert!(other.message.contains("spawn failed") && auth.is_none());
    let signed_out = anyhow::Error::new(agent_client_protocol::Error::new(
        ACP_AUTH_REQUIRED_CODE,
        "Authentication required",
    ))
    .context("ACP connection");
    let (failure, auth) = instance_start_failure(&signed_out);
    assert_eq!(failure.code, "auth_required");
    assert!(auth.is_some_and(|message| message.contains("Authentication required")));
    let classified = anyhow::anyhow!("refresh revoked").context(AcpFailure {
        code: "pi_account_required".to_owned(),
        title: "Pi account unavailable".to_owned(),
        message: "refresh revoked".to_owned(),
    });
    assert_eq!(
        instance_start_failure(&classified).0.code,
        "pi_account_required"
    );
}

#[tokio::test]
async fn stop_answers_the_conversations_pending_prompts_only() {
    let conversation = format!("conv-stop-prompts-{}", Uuid::new_v4());
    let other = format!("conv-stop-prompts-{}", Uuid::new_v4());
    let mine = register_permission(format!("{conversation}-perm"), Some(conversation.clone()));
    let mut theirs = register_permission(format!("{other}-perm"), Some(other.clone()));
    let question = register_question(conversation.clone(), "tool-1".to_owned());
    request_cancel(&conversation);
    assert_eq!(mine.await, Ok(None), "the permission resolves as cancelled");
    assert!(question.await.is_err(), "the question waiter is dropped");
    assert!(
        theirs.try_recv().is_err() && peek_permission_scope(&format!("{other}-perm")).is_some(),
        "another conversation's prompt stays pending"
    );
    assert!(resolve_permission(&format!("{other}-perm"), None));
}

#[test]
fn a_turn_registration_is_removed_on_any_exit_but_never_a_newer_one() {
    let conversation = format!("conv-registration-{}", Uuid::new_v4());
    let older = Arc::new(TurnCancel::default());
    let registration = CancelRegistration::register(&conversation, &older);
    assert!(has_live_turn(&conversation));
    drop(registration);
    assert!(
        !has_live_turn(&conversation),
        "an early exit must not leave the turn live"
    );

    let stale = CancelRegistration::register(&conversation, &older);
    let newer = Arc::new(TurnCancel::default());
    let current = CancelRegistration::register(&conversation, &newer);
    drop(stale);
    assert!(
        has_live_turn(&conversation),
        "the newer turn keeps its entry"
    );
    drop(current);
    assert!(!has_live_turn(&conversation));
    assert!(CancelRegistration::register("", &newer).is_none());
}

/// Streams `first` on the first prompt and waits. On `session/cancel` it
/// flushes a trailing chunk, as ACP allows, before answering `cancelled`.
const CANCEL_TAIL_AGENT: &str = r#"
const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const chunk=text=>send({method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
let prompts=0; let pending=null;
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(m.method==='session/new') return send({id:m.id,result:{sessionId:'s1'}});
 if(m.method==='session/prompt'){
  prompts++;
  if(prompts===1){ pending=m.id; chunk('first'); return; }
  chunk('second');
  return send({id:m.id,result:{stopReason:'end_turn'}});
 }
 if(m.method==='session/cancel'){
  chunk('stale tail');
  if(pending!==null){ send({id:pending,result:{stopReason:'cancelled'}}); pending=null; }
  return;
 }
 if(m.id!==undefined) send({id:m.id,result:{}});
});
"#;

#[tokio::test]
async fn a_cancelled_turn_keeps_its_trailing_updates_out_of_the_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let _trusted = trust(dir.path());
    let spawn = fake_agent(dir.path(), CANCEL_TAIL_AGENT, "");
    let conversation = format!("conv-cancel-tail-{}", Uuid::new_v4());
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    turns_tx
        .send(queued_turn(first_tx, Some(&conversation)))
        .unwrap();
    let instance = tokio::spawn(run_acp_instance(
        spawn,
        dir.path().to_path_buf(),
        Vec::new(),
        Vec::new(),
        None,
        None,
        turns_rx,
        None,
        crate::agent_access::AccountConfinement::None,
    ));

    let mut first = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(20), first_rx.recv())
            .await
            .expect("the first chunk arrives")
            .expect("the turn is still streaming");
        let started = matches!(&event, AcpEvent::Text(text) if text == "first");
        first.push(event);
        if started {
            break;
        }
    }
    assert!(has_live_turn(&conversation));
    assert!(request_cancel(&conversation));
    first.extend(drain(&mut first_rx).await);
    assert_eq!(texts(&first), ["first", "stale tail"]);
    assert!(
        !first
            .iter()
            .any(|event| matches!(event, AcpEvent::Error(_))),
        "a stopped turn is not a failure: {first:?}"
    );
    assert!(!has_live_turn(&conversation));

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    turns_tx
        .send(queued_turn(second_tx, Some(&conversation)))
        .unwrap();
    let second = drain(&mut second_rx).await;
    assert_eq!(texts(&second), ["second"], "{second:?}");

    drop(turns_tx);
    tokio::time::timeout(Duration::from_secs(20), instance)
        .await
        .expect("the instance ends with its queue")
        .unwrap()
        .unwrap();
    crate::workspace_trust::set_from_pref("");
}

/// Never answers a cancelled prompt. It asks permission at once on
/// `session/cancel`, keeps streaming past Core's settle deadline, then asks
/// permission and reads a file while Core is discarding its tail. The next
/// prompt reports how each request was answered (`none` if it never was).
const CANCEL_REQUEST_AGENT: &str = r#"
const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const chunk=text=>send({method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
const permission=id=>send({id,method:'session/request_permission',params:{sessionId:'s1',toolCall:{toolCallId:'t-'+id,title:'run'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});
const answers={};
let prompts=0;
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method===undefined&&m.id!==undefined){
  answers[m.id]=m.error?'error:'+m.error.code:(m.result&&m.result.outcome&&m.result.outcome.outcome)||'unknown';
  return;
 }
 if(m.method==='initialize') return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(m.method==='session/new') return send({id:m.id,result:{sessionId:'s1'}});
 if(m.method==='session/prompt'){
  prompts++;
  if(prompts===1){ chunk('first'); return; }
  chunk(['p1','p2','p3'].map(id=>id+'='+(answers[id]||'none')).join(' '));
  return send({id:m.id,result:{stopReason:'end_turn'}});
 }
 if(m.method==='session/cancel'){
  permission('p1');
  const tail=setInterval(()=>chunk('tail'),200);
  setTimeout(()=>{
   clearInterval(tail);
   permission('p2');
   send({id:'p3',method:'fs/read_text_file',params:{sessionId:'s1',path:'/nonexistent'}});
  },Number(process.argv[2]));
  return;
 }
 if(m.id!==undefined) send({id:m.id,result:{}});
});
"#;

#[tokio::test]
async fn requests_after_a_cancel_are_answered_not_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let _trusted = trust(dir.path());
    // Ask the late requests a second into Core's post-deadline discard.
    let late = ACP_CANCEL_SETTLE_TIMEOUT + Duration::from_secs(1);
    let spawn = fake_agent(
        dir.path(),
        CANCEL_REQUEST_AGENT,
        &late.as_millis().to_string(),
    );
    let conversation = format!("conv-cancel-requests-{}", Uuid::new_v4());
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    turns_tx
        .send(queued_turn(first_tx, Some(&conversation)))
        .unwrap();
    let instance = tokio::spawn(run_acp_instance(
        spawn,
        dir.path().to_path_buf(),
        Vec::new(),
        Vec::new(),
        None,
        None,
        turns_rx,
        None,
        crate::agent_access::AccountConfinement::None,
    ));

    loop {
        let event = tokio::time::timeout(Duration::from_secs(20), first_rx.recv())
            .await
            .expect("the first chunk arrives")
            .expect("the turn is still streaming");
        if matches!(&event, AcpEvent::Text(text) if text == "first") {
            break;
        }
    }
    assert!(request_cancel(&conversation));
    let first = drain(&mut first_rx).await;
    assert!(
        !first
            .iter()
            .any(|event| matches!(event, AcpEvent::PermissionRequest { .. })),
        "a cancelled turn never asks the user: {first:?}"
    );

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    turns_tx
        .send(queued_turn(second_tx, Some(&conversation)))
        .unwrap();
    let second = drain(&mut second_rx).await;
    assert_eq!(
        texts(&second),
        ["p1=cancelled p2=cancelled p3=error:-32800"],
        "{second:?}"
    );

    drop(turns_tx);
    tokio::time::timeout(Duration::from_secs(20), instance)
        .await
        .expect("the instance ends with its queue")
        .unwrap()
        .unwrap();
    crate::workspace_trust::set_from_pref("");
}

/// Sends a request Ryu does not serve mid-turn and only finishes the turn
/// once it is answered, reporting the answer.
const UNKNOWN_REQUEST_AGENT: &str = r#"
const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
let prompt=null;
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method===undefined&&m.id==='x1'){
  const answer=m.error?'error:'+m.error.code:'ok';
  send({method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});
  return send({id:prompt,result:{stopReason:'end_turn'}});
 }
 if(m.method==='initialize') return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(m.method==='session/new') return send({id:m.id,result:{sessionId:'s1'}});
 if(m.method==='session/prompt'){
  prompt=m.id;
  return send({id:'x1',method:'_vendor/custom',params:{sessionId:'s1'}});
 }
 if(m.id!==undefined) send({id:m.id,result:{}});
});
"#;

#[tokio::test]
async fn an_unserved_agent_request_is_answered_not_left_pending() {
    let dir = tempfile::tempdir().unwrap();
    let _trusted = trust(dir.path());
    let spawn = fake_agent(dir.path(), UNKNOWN_REQUEST_AGENT, "");
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let (tx, mut rx) = mpsc::unbounded_channel();
    turns_tx.send(queued_turn(tx, None)).unwrap();
    let instance = tokio::spawn(run_acp_instance(
        spawn,
        dir.path().to_path_buf(),
        Vec::new(),
        Vec::new(),
        None,
        None,
        turns_rx,
        None,
        crate::agent_access::AccountConfinement::None,
    ));
    let events = drain(&mut rx).await;
    assert_eq!(texts(&events), ["error:-32601"], "{events:?}");

    drop(turns_tx);
    tokio::time::timeout(Duration::from_secs(20), instance)
        .await
        .expect("the instance ends with its queue")
        .unwrap()
        .unwrap();
    crate::workspace_trust::set_from_pref("");
}
