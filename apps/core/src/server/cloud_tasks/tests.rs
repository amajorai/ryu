use super::*;

fn unreachable_proxy_env() -> Option<Vec<(&'static str, String)>> {
    panic!("proxy env must not be resolved")
}

#[test]
fn route_preamble_is_skipped_without_network_or_routing() {
    for (network, routing) in [(false, false), (false, true), (true, false)] {
        for docker in [false, true] {
            assert!(
                route_preamble(network, routing, docker, unreachable_proxy_env)
                    .unwrap()
                    .is_none()
            );
        }
    }
}

#[test]
fn route_preamble_fails_closed_outside_docker() {
    let error = live_task::route_preamble(true, true, false, unreachable_proxy_env).unwrap_err();
    assert!(error
        .to_string()
        .contains("cannot route through your desktop"));
}

#[test]
fn route_preamble_fails_when_containers_cannot_reach_route() {
    let error = route_preamble(true, true, true, || None).unwrap_err();
    assert!(error
        .to_string()
        .contains("task containers cannot reach the route"));
}

#[test]
fn route_preamble_exports_quoted_proxy_vars_before_script() {
    let preamble = route_preamble(true, true, true, || {
        Some(vec![
            ("HTTP_PROXY", "http://ryu:p'a ss@10.0.0.1:1".to_owned()),
            ("NO_PROXY", "localhost".to_owned()),
        ])
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        preamble,
        "export HTTP_PROXY='http://ryu:p'\\''a ss@10.0.0.1:1'\nexport NO_PROXY='localhost'\n"
    );
    let script = "curl https://example.com\n";
    let routed = format!("{preamble}{script}");
    assert!(routed.starts_with("export HTTP_PROXY="));
    assert!(routed.ends_with(script));
}

#[tokio::test]
async fn held_task_slot_reports_persisted_state_without_waiting() {
    let slot: TaskSlot = Arc::new(Mutex::new(TaskState::Preparing));
    let held = slot.lock().await;
    assert_eq!(observed_state(&slot, "preparing"), "preparing");
    assert_eq!(observed_state(&slot, "ready"), "ready");
    drop(held);
    assert_eq!(observed_state(&slot, "ready"), "preparing");
    *slot.lock().await = TaskState::Failed;
    assert_eq!(observed_state(&slot, "ready"), "failed");
}

#[tokio::test(start_paused = true)]
async fn task_waiters_honor_the_setup_deadline() {
    let slot: TaskSlot = Arc::new(Mutex::new(TaskState::Preparing));
    let _held = slot.clone().lock_owned().await;
    let deadline = tokio::time::Instant::now() + SETUP_WAIT;
    let Err((status, _)) = lock_slot_until(&slot, deadline).await else {
        panic!("a held slot must not be acquired before the deadline");
    };
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(tokio::time::Instant::now() >= deadline);
}

#[test]
fn cloud_paths_cannot_select_host_paths_or_parent_directories() {
    for path in [
        "/etc/passwd",
        "../secret",
        "a/../../secret",
        "C:\\host",
        "bad\npath",
    ] {
        assert!(tool_script("/tmp/ryu-workspace", "read_file", &json!({"path":path})).is_err());
    }
    let script = live_task::tool_script(
        "/tmp/ryu-workspace",
        "write_file",
        &json!({"path":"src/main.rs","content":"literal '$HOME'"}),
    )
    .unwrap();
    assert!(script.contains("realpath -m"));
    assert!(script.contains("exit 65"));
    assert!(script.contains("printf '%s'"));
}

/// A one-connection-per-request fake Box API that lists one named Box and
/// records every request line.
async fn fake_box(box_id: String, name: String) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = vec![0u8; 16384];
            let mut read = 0;
            while !buffer[..read]
                .windows(4)
                .any(|window| window == b"\r\n\r\n")
            {
                match stream.read(&mut buffer[read..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => read += count,
                }
            }
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let line = request.lines().next().unwrap_or_default().to_owned();
            recorded.lock().unwrap().push(line.clone());
            let body = if line.starts_with("GET /v1/boxes ") {
                json!({"boxes":[{"id":box_id,"name":name,"status":"ready"}]}).to_string()
            } else {
                json!({"ok":true}).to_string()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    (base, seen)
}

struct InstalledCredential;

impl ryu_sandbox::box_credential::BoxCredentialSource for InstalledCredential {
    fn current(&self) -> ryu_sandbox::box_credential::CredentialFuture<'_> {
        Box::pin(async {
            Ok(ryu_sandbox::box_credential::BoxCredential {
                base: reqwest::Url::parse("https://box.example/v1").unwrap(),
                token: ryu_sandbox::box_types::SecretString::new("rbx1.control-plane"),
                public_base: None,
                billing_owner: ryu_sandbox::box_credential::BillingOwner::CoreTick,
                expires_at: None,
            })
        })
    }
}

/// A managed node has no `RYU_SANDBOX_BOX_TOKEN`: its Box credential comes
/// from the control-plane source it installs. The Box task and environment
/// gates must accept it, as the Box arm that runs the task does.
#[tokio::test]
async fn cloud_box_gate_accepts_a_managed_nodes_control_plane_credential() {
    let _box_env = BOX_ENV
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_token = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
    std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
    ryu_sandbox::box_credential::clear_source();
    let unconfigured = super::super::session_box::box_configured().await;
    ryu_sandbox::box_credential::install_source(std::sync::Arc::new(InstalledCredential));
    let managed = super::super::session_box::box_configured().await;
    ryu_sandbox::box_credential::clear_source();
    if let Some(value) = previous_token {
        std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, value);
    }
    assert!(!unconfigured, "no env token and no installed source");
    assert!(managed, "the installed control-plane source configures Box");
}

#[tokio::test]
async fn cloud_box_lease_without_box_id_is_destroyed_by_name_and_removed() {
    let lease_id = uuid::Uuid::new_v4().to_string();
    let box_id = format!("bx_{}", uuid::Uuid::new_v4().simple());
    let name = format!("ryu-ct-{lease_id}");
    let (base, seen) = fake_box(box_id.clone(), name).await;
    // No session Box test may point Box calls at its own fake meanwhile.
    let _overrides = super::super::session_box::tests::without_overrides().await;
    let _box_env = BOX_ENV
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_url = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_URL);
    let previous_token = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
    std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_URL, &base);
    std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, "box-test-token");
    let owner = format!("user:cloud-box-recovery-{}", uuid::Uuid::new_v4().simple());
    let conversation = format!("cloud-box-{}", uuid::Uuid::new_v4().simple());
    persist_record(&TaskLease {
        schema_version: 1,
        id: lease_id.clone(),
        owner: owner.clone(),
        conversation_id: conversation.clone(),
        expires_at: now().unwrap() + 60,
        backend: "box".into(),
        handle: box_arm::lease_handle(&lease_id, None),
    })
    .unwrap();
    let path = leases::lease_directory().join(format!("{lease_id}.json"));
    assert!(path.exists());
    let result = recover_leases_matching(Some((&owner, &conversation))).await;
    match previous_url {
        Some(value) => std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_URL, value),
        None => std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_URL),
    }
    match previous_token {
        Some(value) => std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, value),
        None => std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN),
    }
    result.unwrap();
    assert!(!path.exists(), "the recovered lease file is removed");
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.iter().any(|line| line.starts_with("GET /v1/boxes ")),
        "{seen:?}"
    );
    assert!(
        seen.iter()
            .any(|line| line.starts_with(&format!("DELETE /v1/boxes/{box_id} "))),
        "{seen:?}"
    );
}

/// The rebind, diff and push gate follows the task's actual workspace, not
/// the environment's current runtime: a prepared box task whose environment
/// was edited to `auto` is still refused without the signed flag.
#[tokio::test]
async fn box_gate_follows_the_task_workspace_not_the_environment() {
    use environments::tests::{cloud_auth, denial_code, signed_user_jwt};
    let boxed = TaskWorkspace::Box(WorkspaceId(format!("bx_{}", "b".repeat(32))));
    let docker = TaskWorkspace::Docker(WorkspaceId("ws-docker".into()));
    let without_flag = cloud_auth(signed_user_jwt(Some(json!([])), 600).await).await;
    let with_flag =
        cloud_auth(signed_user_jwt(Some(json!([environments::BOX_BACKEND_FLAG])), 600).await).await;

    let error = require_workspace_feature(&without_flag, &boxed)
        .await
        .expect_err("a box task without the flag is refused");
    assert_eq!(
        denial_code(&error),
        (
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable".to_owned()
        )
    );
    assert!(require_workspace_feature(&with_flag, &boxed).await.is_ok());
    assert!(require_workspace_feature(&without_flag, &docker)
        .await
        .is_ok());
}

fn ready_box_task(environment_id: &str, authority: ResolvedAuthorization) -> LiveTask {
    let profile = environments::PreparedEnvironment {
        owner: "user:user-box".into(),
        environment_id: environment_id.into(),
        environment_name: "Edited".into(),
        revision: 1,
        start_instructions: String::new(),
        working_directory: "/workspace".into(),
        repository_directories: Vec::new(),
        script: String::new(),
        task_preamble: String::new(),
        secrets: Vec::new(),
        task_redactions: Vec::new(),
        governed_spec: ryu_sandbox::governed::GovernedWorkspaceSpec {
            egress: ryu_sandbox::governed::EgressPolicy::Denied,
            credentials: Vec::new(),
        },
        vpn_backend: None,
        vpn_key: None,
        governed: false,
        network: false,
        backend_label: "box",
        backend: environments::TaskBackend::Box,
        executor: "ryu".into(),
        lifetime_seconds: 600,
        box_env: Vec::new(),
        box_network: None,
        git_push_token: None,
        primary_repository: None,
        git_env_keys: Vec::new(),
    };
    let context = CloudTaskContext {
        environment_id: environment_id.into(),
        environment_name: "Edited".into(),
        revision: 1,
        working_directory: "/workspace".into(),
        repository_directories: Vec::new(),
        start_instructions: String::new(),
        executor: "ryu".into(),
        backend: "box".into(),
    };
    LiveTask::new(
        context,
        profile,
        TaskWorkspace::Box(WorkspaceId(format!("bx_{}", "c".repeat(32)))),
        now().unwrap() + 600,
        uuid::Uuid::new_v4().to_string(),
        "unused".into(),
        authority,
    )
}

/// A prepared box task whose environment no longer selects box (edited to
/// `auto` or removed) cannot be rebound without the signed flag.
#[tokio::test]
async fn box_gate_rebind_of_a_ready_box_task_after_leaving_box_needs_the_flag() {
    use environments::tests::{cloud_auth, denial_code, signed_user_jwt};
    let without_flag = cloud_auth(signed_user_jwt(Some(json!([])), 600).await).await;
    let with_flag =
        cloud_auth(signed_user_jwt(Some(json!([environments::BOX_BACKEND_FLAG])), 600).await).await;
    let owner = environments::owner(&without_flag).unwrap();
    let environment_id = format!("env-left-box-{}", uuid::Uuid::new_v4().simple());
    // The environment is not stored as box, so the early check is skipped.
    assert!(environments::runtime_for(&owner, &environment_id)
        .is_none_or(|runtime| runtime.backend != "box"));
    let conversation = format!("cloud-box-{}", uuid::Uuid::new_v4().simple());
    let key = (owner.clone(), conversation.clone());
    let slot = Arc::new(Mutex::new(TaskState::Ready(Box::new(ready_box_task(
        &environment_id,
        with_flag.clone(),
    )))));
    tasks().lock().await.insert(key.clone(), slot);

    let refused =
        workspace::ensure_task_workspace(&without_flag, &conversation, &environment_id).await;
    let allowed = ensure_task_workspace(&with_flag, &conversation, &environment_id).await;
    tasks().lock().await.remove(&key);

    let error = refused.expect_err("rebind without the flag is refused");
    assert_eq!(
        denial_code(&error),
        (
            StatusCode::FORBIDDEN,
            "cloud_environment_feature_unavailable".to_owned()
        )
    );
    assert_eq!(
        allowed.expect("rebind with the flag").environment_id,
        environment_id
    );
}

#[path = "release_tests.rs"]
mod release_tests;

#[test]
fn cloud_task_openapi_documents_the_stop_route() {
    let spec = serde_json::to_value(routes::openapi()).unwrap();
    assert!(spec["paths"]
        .get("/api/cloud-tasks/{conversation_id}/stop")
        .is_some_and(|path| path.get("post").is_some()));
}
