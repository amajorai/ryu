//! Route-level tests for the `cloud_tasks.box_backend` rollout gate.
//!
//! Every request goes through the real cloud environment and cloud task
//! routers behind Core's real admission middleware: the node credential as the
//! bearer and, for a cloud caller, an Ed25519-signed user JWT in the identity
//! header that the middleware verifies offline. Box is left unconfigured, so a
//! request the gate lets through stops at the node gate (or at the first Box
//! call) instead of starting a real box.
use super::{
    environments, now, records, tasks, CloudTaskContext, LiveTask, TaskState, TaskWorkspace,
};
use crate::server::ResolvedAuthorization;
use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    middleware, Router,
};
use ryu_sandbox::WorkspaceId;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;

const NODE_TOKEN: &str = "cloud-box-route-gate-node-token";

/// Serializes this module's read-modify-write saves of the shared environments
/// store: two tests saving the same revision at once would get a 409 revision
/// conflict, which is the store working as designed, not the behaviour tested.
static STORE_WRITES: Mutex<()> = Mutex::const_new(());
const FEATURE_UNAVAILABLE: &str = "cloud_environment_feature_unavailable";
const BACKEND_UNAVAILABLE: &str = "cloud_environment_backend_unavailable";
/// The code a cloud task route uses when the Box itself cannot be reached.
const TASK_UNAVAILABLE: &str = "cloud_task_unavailable";
const OTHER_FLAG: &str = "some.other_flag";

#[derive(Clone)]
enum Caller {
    /// Node credential only: no cloud identity, so no flag to read.
    LocalOwner,
    /// Node credential plus a verified user JWT.
    Cloud { user: String, jwt: String },
}

impl Caller {
    fn owner(&self) -> String {
        match self {
            Self::LocalOwner => "node-owner".into(),
            Self::Cloud { user, .. } => format!("user:{user}"),
        }
    }
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// A cloud caller whose signed `ryu_flags` claim holds `flags`, evaluated for
/// `org` (`ryu_flags_org`) when given.
async fn cloud(user: &str, flags: &[&str], org: Option<&str>) -> Caller {
    let mut claims = json!({
        "id": user,
        "sub": user,
        "email": format!("{user}@example.com"),
        "ryu_flags": flags,
    });
    if let Some(org) = org {
        claims["ryu_flags_org"] = json!(org);
    }
    let jwt = environments::tests::signed_user_jwt_with_claims(claims, 600).await;
    Caller::Cloud {
        user: user.to_owned(),
        jwt,
    }
}

/// One gate scenario: who sends the request, a flagged caller with the same
/// owner that seeds box state, and whether the gate must refuse.
struct Case {
    label: &'static str,
    caller: Caller,
    seeder: Caller,
    gated: bool,
}

async fn cases() -> Vec<Case> {
    let without = unique("box-route-without");
    let with = unique("box-route-with");
    vec![
        Case {
            label: "verified cloud caller without the flag",
            caller: cloud(&without, &[OTHER_FLAG], None).await,
            seeder: cloud(&without, &[environments::BOX_BACKEND_FLAG], None).await,
            gated: true,
        },
        Case {
            label: "verified cloud caller with the flag",
            caller: cloud(&with, &[environments::BOX_BACKEND_FLAG], None).await,
            seeder: cloud(&with, &[environments::BOX_BACKEND_FLAG], None).await,
            gated: false,
        },
        Case {
            label: "local owner without a cloud identity",
            caller: Caller::LocalOwner,
            seeder: Caller::LocalOwner,
            gated: false,
        },
    ]
}

struct Harness {
    _directory: tempfile::TempDir,
    // Keeps a Box-endpoint test from swapping `RYU_SANDBOX_BOX_*` mid-case.
    _box_env: std::sync::RwLockReadGuard<'static, ()>,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        let box_env = super::BOX_ENV
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let directory = tempfile::tempdir().expect("isolated state directory");
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let router = Router::new()
            .merge(environments::routes())
            .merge(super::routes())
            .merge(crate::server::session_box::routes())
            .layer(middleware::from_fn(|request, next| async move {
                crate::server::require_auth_with_token(request, next, Some(NODE_TOKEN.to_owned()))
                    .await
            }))
            .with_state(state);
        Self {
            _directory: directory,
            _box_env: box_env,
            router,
        }
    }

    async fn send(
        &self,
        caller: &Caller,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {NODE_TOKEN}"));
        if let Caller::Cloud { jwt, .. } = caller {
            request = request.header("x-ryu-user-jwt", jwt);
        }
        let body = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).expect("request builds"))
            .await
            .expect("router is infallible");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .expect("body reads");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The same request on a node bound to `org`.
    async fn send_on_org_node(
        &self,
        org: &str,
        caller: &Caller,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        environments::TEST_NODE_ORG
            .scope(Some(org.to_owned()), self.send(caller, method, uri, body))
            .await
    }

    async fn snapshot(&self, caller: &Caller) -> Value {
        let (status, body) = self
            .send(caller, Method::GET, "/api/cloud-environments", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Save `environment` (replacing one with the same id) into the caller's
    /// current snapshot, leaving every other stored environment as it is.
    async fn put_environment(&self, caller: &Caller, environment: Value) -> (StatusCode, Value) {
        self.put_environment_on(None, caller, environment).await
    }

    async fn put_environment_on(
        &self,
        org: Option<&str>,
        caller: &Caller,
        environment: Value,
    ) -> (StatusCode, Value) {
        let _write = STORE_WRITES.lock().await;
        let mut snapshot = self.snapshot(caller).await;
        let environments = snapshot["environments"]
            .as_array_mut()
            .expect("environments list");
        environments.retain(|existing| existing["id"] != environment["id"]);
        environments.push(environment);
        match org {
            Some(org) => {
                self.send_on_org_node(
                    org,
                    caller,
                    Method::PUT,
                    "/api/cloud-environments",
                    Some(snapshot),
                )
                .await
            }
            None => {
                self.send(
                    caller,
                    Method::PUT,
                    "/api/cloud-environments",
                    Some(snapshot),
                )
                .await
            }
        }
    }

    /// Store a published box environment for `seeder`'s owner.
    async fn seed_box_environment(&self, seeder: &Caller) -> String {
        let id = unique("env-box-route");
        let (status, body) = self.put_environment(seeder, environment(&id, "box")).await;
        assert_eq!(status, StatusCode::OK, "seeding a box environment: {body}");
        id
    }

    /// Remove test environments so the shared node-owner snapshot stays small.
    async fn remove_environments(&self, caller: &Caller, ids: &[String]) {
        let _write = STORE_WRITES.lock().await;
        let mut snapshot = self.snapshot(caller).await;
        snapshot["environments"]
            .as_array_mut()
            .expect("environments list")
            .retain(|existing| !ids.iter().any(|id| existing["id"] == id.as_str()));
        let (status, body) = self
            .send(
                caller,
                Method::PUT,
                "/api/cloud-environments",
                Some(snapshot),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "cleanup: {body}");
    }
}

fn environment(id: &str, backend: &str) -> Value {
    let executor = if backend == "box" { "codex" } else { "ryu" };
    json!({
        "id": id,
        "name": "Route gate",
        "repositories": [],
        "installScript": "",
        "startInstructions": "",
        "internet": {"enabled": true, "domainPolicy": "all", "allowedDomains": []},
        "privacy": "private",
        "vaultKeys": [],
        "tailscaleVaultKey": null,
        "published": true,
        "runtime": {"backend": backend, "executor": executor, "lifetimeMinutes": 30},
    })
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

/// A gated case is 403 `cloud_environment_feature_unavailable`; any other case
/// must get past the gate to exactly `allowed`.
fn assert_gate(
    case: &Case,
    route: &str,
    (status, body): &(StatusCode, Value),
    allowed: (StatusCode, &str),
) {
    if case.gated {
        assert_eq!(
            (*status, code(body)),
            (StatusCode::FORBIDDEN, FEATURE_UNAVAILABLE),
            "{route}: {}: {body}",
            case.label
        );
    } else {
        assert_ne!(
            *status,
            StatusCode::FORBIDDEN,
            "{route}: {}: {body}",
            case.label
        );
        assert_eq!(
            (*status, code(body)),
            allowed,
            "{route}: {}: {body}",
            case.label
        );
    }
}

fn node_owner_authority() -> ResolvedAuthorization {
    ResolvedAuthorization {
        context: crate::authorization::AuthorizationContext::owner(0),
        bindings: crate::authorization::RequestBindings::default(),
        caller: None,
        verified_user_jwt: None,
    }
}

/// A ready box task with a repository, a starting branch and a GitHub
/// credential, so diff and a pushing finish reach the gate.
fn ready_box_task(owner: &str, environment_id: &str, conversation_id: &str) -> LiveTask {
    let repository_directory = "/workspace/amajorai/ryu".to_owned();
    let profile = environments::PreparedEnvironment {
        owner: owner.into(),
        environment_id: environment_id.into(),
        environment_name: "Route gate".into(),
        revision: 1,
        start_instructions: String::new(),
        working_directory: "/workspace".into(),
        repository_directories: vec![repository_directory.clone()],
        script: String::new(),
        task_preamble: String::new(),
        secrets: Vec::new(),
        task_redactions: Vec::new(),
        governed_spec: ryu_sandbox::governed::GovernedWorkspaceSpec {
            egress: ryu_sandbox::governed::EgressPolicy::Unrestricted,
            credentials: Vec::new(),
        },
        vpn_backend: None,
        vpn_key: None,
        governed: false,
        network: true,
        backend_label: "box",
        backend: environments::TaskBackend::Box,
        executor: "codex".into(),
        lifetime_seconds: 1800,
        box_env: Vec::new(),
        box_network: None,
        git_push_token: Some("route-gate-test-token".into()),
        primary_repository: Some("amajorai/ryu".into()),
        git_env_keys: Vec::new(),
    };
    let context = CloudTaskContext {
        environment_id: environment_id.into(),
        environment_name: "Route gate".into(),
        revision: 1,
        working_directory: "/workspace".into(),
        repository_directories: vec![repository_directory],
        start_instructions: String::new(),
        executor: "codex".into(),
        backend: "box".into(),
    };
    let mut task = LiveTask::new(
        context,
        profile,
        TaskWorkspace::Box(WorkspaceId(format!("bx_{}", uuid::Uuid::new_v4().simple()))),
        now().expect("clock") + 1800,
        uuid::Uuid::new_v4().to_string(),
        conversation_id.into(),
        node_owner_authority(),
    );
    task.base_sha = Some("a".repeat(40));
    task.base_branch = Some("main".into());
    task
}

/// Bind a new conversation to a ready box task for `owner`, as a finished
/// first prompt would leave it. Returns the conversation id.
async fn bind_ready_box_task(owner: &str, environment_id: &str) -> String {
    let conversation = unique("cloud-box-route");
    assert_eq!(
        records::create(owner, &conversation, environment_id, Default::default)
            .expect("binding persists"),
        records::Created::New
    );
    records::mark(owner, &conversation, "ready", Some(1)).expect("binding marks ready");
    let slot = Arc::new(Mutex::new(TaskState::Ready(Box::new(ready_box_task(
        owner,
        environment_id,
        &conversation,
    )))));
    tasks()
        .lock()
        .await
        .insert((owner.to_owned(), conversation.clone()), slot);
    conversation
}

async fn unbind(owner: &str, conversation: &str) {
    tasks()
        .lock()
        .await
        .remove(&(owner.to_owned(), conversation.to_owned()));
    let _ = records::mark(owner, conversation, "stopped", None);
}

#[tokio::test]
async fn box_route_gate_put_switching_an_environment_to_box() {
    let harness = Harness::new();
    for case in cases().await {
        let id = unique("env-switch-route");
        let (status, body) = harness
            .put_environment(&case.caller, environment(&id, "auto"))
            .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}: saving auto: {body}",
            case.label
        );

        let response = harness
            .put_environment(&case.caller, environment(&id, "box"))
            .await;
        if !case.gated {
            assert_eq!(response.0, StatusCode::OK, "{}: {}", case.label, response.1);
            let saved = response.1["environments"]
                .as_array()
                .and_then(|list| list.iter().find(|item| item["id"] == id.as_str()))
                .expect("saved environment");
            assert_eq!(saved["runtime"]["backend"], "box");
        }
        assert_gate(
            &case,
            "PUT /api/cloud-environments",
            &(response.0, response.1.clone()),
            (StatusCode::OK, ""),
        );
        // A refused switch leaves the stored environment on auto.
        if case.gated {
            let stored = harness.snapshot(&case.caller).await;
            let saved = stored["environments"]
                .as_array()
                .and_then(|list| list.iter().find(|item| item["id"] == id.as_str()))
                .expect("stored environment");
            assert_eq!(saved["runtime"]["backend"], "auto", "{}", case.label);
        }
        harness.remove_environments(&case.caller, &[id]).await;
    }
}

#[tokio::test]
async fn box_route_gate_launch_of_a_box_environment() {
    let harness = Harness::new();
    for case in cases().await {
        let id = harness.seed_box_environment(&case.seeder).await;
        let response = harness
            .send(
                &case.caller,
                Method::POST,
                &format!("/api/cloud-environments/{id}/launch"),
                None,
            )
            .await;
        assert_gate(
            &case,
            "POST launch",
            &response,
            (StatusCode::SERVICE_UNAVAILABLE, BACKEND_UNAVAILABLE),
        );
        harness.remove_environments(&case.seeder, &[id]).await;
    }
}

#[tokio::test]
async fn box_route_gate_prompt_on_a_new_conversation() {
    let harness = Harness::new();
    for case in cases().await {
        let id = harness.seed_box_environment(&case.seeder).await;
        let conversation = unique("cloud-box-route");
        let response = harness
            .send(
                &case.caller,
                Method::POST,
                &format!("/api/cloud-tasks/{conversation}/prompt"),
                Some(json!({"environmentId": id, "text": "List the files."})),
            )
            .await;
        assert_gate(
            &case,
            "POST prompt",
            &response,
            (StatusCode::SERVICE_UNAVAILABLE, BACKEND_UNAVAILABLE),
        );
        // Neither gate burns the conversation: nothing was bound.
        assert_eq!(
            records::lookup(&case.caller.owner(), &conversation).expect("bindings read"),
            None,
            "{}",
            case.label
        );
        harness.remove_environments(&case.seeder, &[id]).await;
    }
}

#[tokio::test]
async fn box_route_gate_prompt_reusing_a_bound_box_task() {
    let harness = Harness::new();
    for case in cases().await {
        let id = harness.seed_box_environment(&case.seeder).await;
        let owner = case.caller.owner();
        let conversation = bind_ready_box_task(&owner, &id).await;
        let response = harness
            .send(
                &case.caller,
                Method::POST,
                &format!("/api/cloud-tasks/{conversation}/prompt"),
                Some(json!({"environmentId": id, "text": "Run the tests."})),
            )
            .await;
        // The binding status route stays readable either way.
        let binding = harness
            .send(
                &case.caller,
                Method::GET,
                &format!("/api/cloud-environments/task-binding/{conversation}"),
                None,
            )
            .await;
        unbind(&owner, &conversation).await;
        assert_gate(
            &case,
            "POST prompt (bound task)",
            &response,
            (StatusCode::SERVICE_UNAVAILABLE, BACKEND_UNAVAILABLE),
        );
        assert_eq!(binding.0, StatusCode::OK, "{}: {}", case.label, binding.1);
        assert_eq!(binding.1["cloudEnvironmentId"], id.as_str());
        assert_eq!(binding.1["state"], "ready");
        assert_eq!(binding.1["backend"], "box");
        harness.remove_environments(&case.seeder, &[id]).await;
    }
}

#[tokio::test]
async fn box_route_gate_diff_of_a_box_task() {
    let harness = Harness::new();
    for case in cases().await {
        let owner = case.caller.owner();
        let id = unique("env-diff-route");
        let conversation = bind_ready_box_task(&owner, &id).await;
        let response = harness
            .send(
                &case.caller,
                Method::GET,
                &format!("/api/cloud-tasks/{conversation}/diff"),
                None,
            )
            .await;
        unbind(&owner, &conversation).await;
        // Let through, the route reaches the unconfigured Box and reports it.
        assert_gate(
            &case,
            "GET diff",
            &response,
            (StatusCode::SERVICE_UNAVAILABLE, TASK_UNAVAILABLE),
        );
    }
}

#[tokio::test]
async fn box_route_gate_finish_with_push_of_a_box_task() {
    let harness = Harness::new();
    for case in cases().await {
        let owner = case.caller.owner();
        let id = unique("env-finish-route");
        let conversation = bind_ready_box_task(&owner, &id).await;
        let uri = format!("/api/cloud-tasks/{conversation}/finish");
        let push = harness
            .send(
                &case.caller,
                Method::POST,
                &uri,
                Some(json!({"push": true, "teardown": "keep"})),
            )
            .await;
        let pull_request = harness
            .send(
                &case.caller,
                Method::POST,
                &uri,
                Some(json!({"push": true, "teardown": "keep", "openPullRequest": true})),
            )
            .await;
        // Finishing without push stays open so a revoked user can tear down;
        // it also shows a refused push left the task idle, not finishing.
        let keep = harness
            .send(
                &case.caller,
                Method::POST,
                &uri,
                Some(json!({"push": false, "teardown": "keep"})),
            )
            .await;
        unbind(&owner, &conversation).await;
        let box_unreachable = (StatusCode::SERVICE_UNAVAILABLE, TASK_UNAVAILABLE);
        assert_gate(&case, "POST finish (push)", &push, box_unreachable);
        assert_gate(
            &case,
            "POST finish (pull request)",
            &pull_request,
            box_unreachable,
        );
        assert_eq!(
            (keep.0, code(&keep.1)),
            box_unreachable,
            "POST finish (no push): {}: {}",
            case.label,
            keep.1
        );
    }
}

#[tokio::test]
async fn box_route_gate_refuses_a_claim_evaluated_for_another_org() {
    let harness = Harness::new();
    let user = unique("box-route-org");
    let flag = environments::BOX_BACKEND_FLAG;
    let personal = cloud(&user, &[flag], None).await;
    let for_node_org = cloud(&user, &[flag], Some("org-a")).await;
    let for_other_org = cloud(&user, &[flag], Some("org-b")).await;
    let id = harness.seed_box_environment(&personal).await;
    let local_id = harness.seed_box_environment(&Caller::LocalOwner).await;
    let prompt = |environment_id: &str| {
        (
            format!("/api/cloud-tasks/{}/prompt", unique("cloud-box-route")),
            json!({"environmentId": environment_id, "text": "List the files."}),
        )
    };
    let not_gated = (StatusCode::SERVICE_UNAVAILABLE, BACKEND_UNAVAILABLE);

    // On a node bound to org-a, a claim evaluated for org-b is refused.
    let (uri, body) = prompt(&id);
    let refused = harness
        .send_on_org_node("org-a", &for_other_org, Method::POST, &uri, Some(body))
        .await;
    assert_eq!(
        (refused.0, code(&refused.1)),
        (StatusCode::FORBIDDEN, FEATURE_UNAVAILABLE),
        "{}",
        refused.1
    );
    let switch_id = unique("env-switch-org-route");
    let (status, body) = harness
        .put_environment(&for_other_org, environment(&switch_id, "auto"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let refused_switch = harness
        .put_environment_on(
            Some("org-a"),
            &for_other_org,
            environment(&switch_id, "box"),
        )
        .await;
    assert_eq!(
        (refused_switch.0, code(&refused_switch.1)),
        (StatusCode::FORBIDDEN, FEATURE_UNAVAILABLE),
        "{}",
        refused_switch.1
    );
    let launch = harness
        .send_on_org_node(
            "org-a",
            &for_other_org,
            Method::POST,
            &format!("/api/cloud-environments/{id}/launch"),
            None,
        )
        .await;
    assert_eq!(
        (launch.0, code(&launch.1)),
        (StatusCode::FORBIDDEN, FEATURE_UNAVAILABLE),
        "{}",
        launch.1
    );

    // A claim for the node's own org, a claim with no org context, and the
    // local owner all get past the gate on the same node.
    for (label, caller, environment_id) in [
        ("claim for the node org", &for_node_org, &id),
        ("claim without org context", &personal, &id),
        ("local owner", &Caller::LocalOwner, &local_id),
    ] {
        let (uri, body) = prompt(environment_id);
        let response = harness
            .send_on_org_node("org-a", caller, Method::POST, &uri, Some(body))
            .await;
        assert_eq!(
            (response.0, code(&response.1)),
            not_gated,
            "{label}: {}",
            response.1
        );
    }
    // On a personal node the org-b claim is used as-is.
    let (uri, body) = prompt(&id);
    let personal_node = harness
        .send(&for_other_org, Method::POST, &uri, Some(body))
        .await;
    assert_eq!(
        (personal_node.0, code(&personal_node.1)),
        not_gated,
        "{}",
        personal_node.1
    );

    harness
        .remove_environments(&personal, &[id, switch_id])
        .await;
    harness
        .remove_environments(&Caller::LocalOwner, &[local_id])
        .await;
}

/// The session Box routes under the default-on rollout: the signed claim the
/// control plane now mints by default opens the gated routes (screen, resume,
/// extend), the kill switch (the key absent from the claim) closes them with
/// 403, and a local owner without a cloud identity is never gated. Status and
/// stop are never gated. With no Box in the conversation, a request past the
/// gate is 404 `session_box_not_found`.
#[tokio::test]
async fn session_box_routes_follow_the_default_on_claim_and_kill_switch() {
    let harness = Harness::new();
    let conversation = unique("session-box-gate");
    let routes: [(Method, String, bool); 5] = [
        (
            Method::GET,
            format!("/api/session-boxes/{conversation}"),
            false,
        ),
        (
            Method::POST,
            format!("/api/session-boxes/{conversation}/screen"),
            true,
        ),
        (
            Method::POST,
            format!("/api/session-boxes/{conversation}/resume"),
            true,
        ),
        (
            Method::POST,
            format!("/api/session-boxes/{conversation}/extend"),
            true,
        ),
        (
            Method::POST,
            format!("/api/session-boxes/{conversation}/stop"),
            false,
        ),
    ];
    for case in cases().await {
        for (method, uri, gated_route) in &routes {
            let body = (*method == Method::POST).then(|| json!({}));
            let (status, response) = harness.send(&case.caller, method.clone(), uri, body).await;
            let expected = if case.gated && *gated_route {
                (StatusCode::FORBIDDEN, FEATURE_UNAVAILABLE)
            } else {
                (StatusCode::NOT_FOUND, "session_box_not_found")
            };
            assert_eq!(
                (status, code(&response)),
                expected,
                "{} {method} {uri}: {response}",
                case.label
            );
        }
    }
    for (method, uri, _) in &routes {
        assert_eq!(
            crate::server::route_policy(method, uri),
            crate::authorization::RoutePolicy::requires([
                crate::authorization::Capability::GatewayRoute
            ]),
            "{method} {uri}"
        );
    }
}
