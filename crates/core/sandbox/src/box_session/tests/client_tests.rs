//! Disposable Box, command, and managed prompt tests.

use super::*;

#[tokio::test]
async fn box_session_create_sends_policy_and_polls_until_ready() {
    let created =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning"}}"#;
    let provisioning =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning"}}"#;
    let ready =
        r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready"}}"#;
    let (base, captured) = fake_box(vec![(202, created), (200, provisioning), (200, ready)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let spec = DisposableBoxSpec {
        name: "ryu-task-abc".into(),
        image: None,
        network: BoxNetwork::Allowlist(vec!["github.com".into(), "archive.ubuntu.com".into()]),
        ttl_seconds: 2100,
        setup: vec![ENSURE_GIT_SCRIPT.to_owned()],
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let id = client.create_disposable(&spec, "idem-123").await.unwrap();
    assert_eq!(id.0, BOX_ID);
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert!(requests[0]
        .request_line()
        .starts_with("POST /v1/boxes HTTP/1.1"));
    assert_eq!(
        requests[0].header("Idempotency-Key").as_deref(),
        Some("idem-123")
    );
    assert_eq!(
        requests[0].header("Authorization").as_deref(),
        Some("Bearer box_token")
    );
    let body = requests[0].json();
    assert_eq!(body["ttlSeconds"], 2100);
    assert_eq!(body["noEnv"], true);
    assert_eq!(body["network"], "allowlist");
    assert_eq!(
        body["allowedHosts"],
        json!(["github.com", "archive.ubuntu.com"])
    );
    assert_eq!(body["setup"], json!([ENSURE_GIT_SCRIPT]));
    assert_eq!(body["name"], "ryu-task-abc");
    assert!(body.get("image").is_none());
    assert!(requests[1]
        .request_line()
        .starts_with(&format!("GET /v1/boxes/{BOX_ID} ")));
    assert!(requests[2]
        .request_line()
        .starts_with(&format!("GET /v1/boxes/{BOX_ID} ")));
}

#[tokio::test]
async fn box_session_create_omits_allowed_hosts_for_egress_and_sends_image() {
    let ready = r#"{"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready"}}"#;
    let (base, captured) = fake_box(vec![(201, ready), (200, ready)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let spec = DisposableBoxSpec {
        name: "ryu-task-egress".into(),
        image: Some("ubuntu:24.04".into()),
        network: BoxNetwork::Egress,
        ttl_seconds: 600,
        setup: Vec::new(),
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    };
    client.create_disposable(&spec, "idem").await.unwrap();
    let body = captured.lock().unwrap()[0].json();
    assert_eq!(body["network"], "egress");
    assert!(body.get("allowedHosts").is_none());
    assert_eq!(body["image"], "ubuntu:24.04");
}

#[tokio::test]
async fn box_session_create_surfaces_truncated_last_error() {
    let created = r#"{"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning"}}"#;
    let long_error: &'static str = Box::leak(
        format!(
            r#"{{"box":{{"id":"{BOX_ID}","status":"error","lastError":"{}"}}}}"#,
            "e".repeat(900)
        )
        .into_boxed_str(),
    );
    let (base, _captured) = fake_box(vec![(202, created), (200, long_error)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let spec = DisposableBoxSpec {
        name: "ryu-task-err".into(),
        image: None,
        network: BoxNetwork::None,
        ttl_seconds: 600,
        setup: Vec::new(),
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let error = client
        .create_disposable(&spec, "idem")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("(error)"), "{error}");
    assert!(error.contains(&"e".repeat(500)));
    assert!(!error.contains(&"e".repeat(501)));
}

#[tokio::test]
async fn box_session_exec_script_sends_script_in_stdin_and_env_separately() {
    let result =
        r#"{"ok":true,"result":{"exitCode":0,"stdout":"done\n","stderr":"","durationMs":5}}"#;
    let top_level = r#"{"exitCode":3,"stdout":"","stderr":"boom"}"#;
    let (base, captured) = fake_box(vec![(200, result), (200, top_level)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let env = vec![("GITHUB_TOKEN".to_owned(), "ghp_secret_value".to_owned())];
    let output = client
        .exec_script(&workspace(), "git status\n", &env, BoxUser::Root, 120)
        .await
        .unwrap();
    assert_eq!(output.exit_code, 0);
    assert_eq!(output.stdout, b"done\n");
    let output = client
        .exec_script(&workspace(), "true", &[], BoxUser::Box, 60)
        .await
        .unwrap();
    assert_eq!(output.exit_code, 3);
    assert_eq!(output.stderr, b"boom");
    let requests = captured.lock().unwrap().clone();
    assert!(requests[0]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/commands ")));
    let body = requests[0].json();
    assert_eq!(body["command"], "sh");
    assert_eq!(body["args"], json!(["-s"]));
    assert_eq!(body["stdin"], "git status\n");
    assert_eq!(body["cwd"], ".");
    assert_eq!(body["env"], json!({"GITHUB_TOKEN": "ghp_secret_value"}));
    assert_eq!(body["user"], "root");
    assert_eq!(body["timeoutSeconds"], 120);
    let without_env = body
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.as_str() != "env")
        .map(|(_, value)| value.to_string())
        .collect::<String>();
    assert!(!without_env.contains("ghp_secret_value"));
    assert_eq!(requests[1].json()["user"], "box");
}

#[tokio::test]
async fn box_session_exec_script_rejects_oversized_inputs_locally() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    assert!(client
        .exec_script(&workspace(), "true", &[], BoxUser::Box, 3601)
        .await
        .is_err());
    let script = "x".repeat(MAX_SCRIPT_BYTES + 1);
    assert!(client
        .exec_script(&workspace(), &script, &[], BoxUser::Box, 60)
        .await
        .is_err());
    assert!(client
        .exec_script(&WorkspaceId("../etc".into()), "true", &[], BoxUser::Box, 60)
        .await
        .is_err());
}

#[tokio::test]
async fn box_session_start_prompt_sends_managed_run_and_parses_older_box() {
    let queued = r#"{"ok":true,"type":"prompt.queued","run":{"id":"run_1","status":"queued"}}"#;
    let completed = r#"{"ok":true,"type":"prompt","run":{"id":"run_1","provider":"codex","execution":"managed","status":"completed","processId":"proc_9","exitCode":0,"summary":"done","reason":null,"completedAt":"2026-10-14T00:00:00Z"}}"#;
    let canceled = r#"{"ok":true,"type":"prompt.canceled","run":{"id":"run_1","status":"failed","reason":"canceled"}}"#;
    let (base, captured) = fake_box(vec![(202, queued), (200, completed), (200, canceled)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let run = client
        .start_prompt(&workspace(), &prompt_spec("sk-test"))
        .await
        .unwrap();
    assert_eq!(run.id, "run_1");
    assert_eq!(run.status, "queued");
    assert_eq!(run.process_id, None);
    assert_eq!(run.exit_code, None);
    assert!(!run.is_terminal());
    let run = client.prompt_run(&workspace(), "run_1").await.unwrap();
    assert!(run.is_terminal());
    assert_eq!(run.process_id.as_deref(), Some("proc_9"));
    assert_eq!(run.summary.as_deref(), Some("done"));
    let run = client.cancel_prompt(&workspace(), "run_1").await.unwrap();
    assert_eq!(run.reason.as_deref(), Some("canceled"));
    assert!(run.is_terminal());
    let requests = captured.lock().unwrap().clone();
    assert!(requests[0]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/prompt ")));
    let body = requests[0].json();
    assert_eq!(body["provider"], "codex");
    assert_eq!(body["execution"], "managed");
    assert_eq!(body["text"], "fix the failing test");
    assert_eq!(body["cwd"], "repo");
    assert_eq!(body["env"], json!({"OPENAI_API_KEY": "sk-test"}));
    assert_eq!(body["timeoutSeconds"], 600);
    assert!(requests[1]
        .request_line()
        .starts_with(&format!("GET /v1/boxes/{BOX_ID}/prompts/run_1 ")));
    assert!(requests[2]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/prompts/run_1/cancel ")));
}

#[tokio::test]
async fn box_session_start_prompt_validates_locally() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    let mut spec = prompt_spec("x");
    spec.cwd = "../escape".into();
    assert!(client.start_prompt(&workspace(), &spec).await.is_err());
    let mut spec = prompt_spec("x");
    spec.cwd = "/abs".into();
    assert!(client.start_prompt(&workspace(), &spec).await.is_err());
    let mut spec = prompt_spec("x");
    spec.timeout_secs = 30;
    assert!(client.start_prompt(&workspace(), &spec).await.is_err());
    assert!(client.prompt_run(&workspace(), "bad/id").await.is_err());
}

#[tokio::test]
async fn box_session_process_output_parses_chunks_and_exit() {
    let running = r#"{"ok":true,"type":"process.logs","chunks":[{"seq":4,"stream":"stdout","data":"hello"},{"seq":5,"stream":"stderr","data":"warn"}],"process":{"status":"running","exitCode":null}}"#;
    let exited = r#"{"ok":true,"type":"process.logs","chunks":[],"process":{"status":"exited","exitCode":0}}"#;
    let (base, captured) = fake_box(vec![(200, running), (200, exited)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let page = client
        .process_output_after(&workspace(), "proc_9", 3)
        .await
        .unwrap();
    assert!(!page.exited);
    assert_eq!(
        page.chunks,
        vec![
            OutputChunk {
                seq: 4,
                stream: "stdout".into(),
                data: "hello".into()
            },
            OutputChunk {
                seq: 5,
                stream: "stderr".into(),
                data: "warn".into()
            },
        ]
    );
    let page = client
        .process_output_after(&workspace(), "proc_9", 5)
        .await
        .unwrap();
    assert!(page.exited);
    assert!(page.chunks.is_empty());
    let requests = captured.lock().unwrap().clone();
    assert!(requests[0].request_line().starts_with(&format!(
        "GET /v1/boxes/{BOX_ID}/processes/proc_9/logs?after=3 "
    )));
}

#[tokio::test]
async fn box_session_destroy_treats_404_as_ok_and_confirms() {
    let (base, captured) =
        fake_box(vec![(404, r#"{"ok":false}"#), (500, r#"{"error":"x"}"#)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    client.destroy(&workspace()).await.unwrap();
    assert!(client.destroy(&workspace()).await.is_err());
    let requests = captured.lock().unwrap().clone();
    assert!(requests[0]
        .request_line()
        .starts_with(&format!("DELETE /v1/boxes/{BOX_ID} ")));
    assert_eq!(
        requests[0].header("X-Ascii-Confirm-Delete").as_deref(),
        Some(BOX_ID)
    );
}

#[tokio::test]
async fn box_session_interrupt_posts() {
    let (base, captured) = fake_box(vec![(200, r#"{"ok":true}"#)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    client.interrupt(&workspace()).await.unwrap();
    assert!(captured.lock().unwrap()[0]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/interrupt ")));
}

#[tokio::test]
async fn box_session_find_by_name_matches_exactly_and_skips_deleted() {
    let list = r#"{"ok":true,"type":"box.list","boxes":[
            {"id":"bx_11111111111111111111111111111111","name":"ryu-task","status":"deleted"},
            {"id":"bx_22222222222222222222222222222222","name":"ryu-task-other","status":"ready"},
            {"id":"bx_33333333333333333333333333333333","name":"ryu-task","status":"ready"}]}"#;
    let (base, _captured) = fake_box(vec![(200, list), (200, list)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    assert_eq!(
        client.find_by_name("ryu-task").await.unwrap(),
        Some(WorkspaceId("bx_33333333333333333333333333333333".into()))
    );
    assert_eq!(client.find_by_name("ryu-missing").await.unwrap(), None);
}

#[tokio::test]
async fn box_session_http_errors_do_not_echo_request_env() {
    let (base, _captured) = fake_box(vec![(400, r#"{"error":{"code":"invalid_request"}}"#)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let env = vec![("TOKEN".to_owned(), "s3cret-env".to_owned())];
    let error = client
        .exec_script(&workspace(), "echo hi", &env, BoxUser::Box, 60)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("400"), "{error}");
    assert!(!error.contains("s3cret-env"));
    assert!(!error.contains("box_token"));
}

#[test]
fn box_session_prompt_spec_debug_hides_env_values() {
    let rendered = format!("{:?}", prompt_spec("s3cret"));
    assert!(!rendered.contains("s3cret"), "{rendered}");
    assert!(rendered.contains("OPENAI_API_KEY"));
}

#[test]
fn box_session_managed_provider_wire_names_round_trip() {
    assert_eq!(ManagedProvider::from_executor("ryu"), None);
    assert_eq!(ManagedProvider::from_executor("unknown"), None);
    assert_eq!(ManagedProvider::from_executor("claude"), None);
    for provider in ManagedProvider::ALL {
        assert_eq!(
            ManagedProvider::from_executor(provider.wire_name()),
            Some(provider)
        );
        assert!(!provider.required_hosts().is_empty());
    }
    assert_eq!(ManagedProvider::ClaudeCode.wire_name(), "claude-code");
    assert_eq!(
        ManagedProvider::Cursor.required_hosts(),
        &["cursor.com", "downloads.cursor.com", "api2.cursor.sh"]
    );
}

#[test]
fn box_session_ids_are_validated() {
    assert!(validate_box_id(BOX_ID).is_ok());
    assert!(validate_box_id("bx_0123456789ABCDEF0123456789abcdef").is_err());
    assert!(validate_box_id("bx_123").is_err());
    assert!(validate_run_id("run_abc-1").is_ok());
    assert!(validate_run_id("").is_err());
    assert!(validate_run_id(&"a".repeat(129)).is_err());
    let run = PromptRunView {
        id: "r".into(),
        status: "running".into(),
        process_id: None,
        exit_code: None,
        summary: None,
        reason: None,
        completed_at: None,
    };
    assert!(!run.is_terminal());
}
