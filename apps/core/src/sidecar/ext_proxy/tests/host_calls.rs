use super::*;

/// End to end through the real `events.emit` handler: an app's own declared
/// event carrying an `activity` hint lands on the activity feed attributed to
/// the AUTHENTICATED caller; a `core#` kernel event is refused outright.
#[tokio::test]
async fn events_emit_records_owner_attributed_activity_and_refuses_kernel_events() {
    const APP: &str = "@example/feedapp";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state.app_store.set_enabled(APP, &[]).await.unwrap();
    let manifest: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
        "id": APP, "name": "Feed", "version": "1.0.0", "runnables": [],
        "contributes": { "hook_events": [
            { "id": "@example/feedapp#thing.done", "title": "Thing done" }
        ] }
    }))
    .unwrap();
    state.app_manifests.write().await.push(manifest);
    let mut headers = HeaderMap::new();
    headers.insert(HDR_PLUGIN_ID, APP.parse().unwrap());
    headers.insert(
        "authorization",
        format!("Bearer {}", ext_token(None, APP)).parse().unwrap(),
    );

    let emit = |event: &str| EventEmitBody {
        event: event.to_owned(),
        payload: json!({ "id": "t1" }),
        conversation_id: None,
        notify: None,
        activity: Some(crate::plugin_host::AppEventActivity {
            kind: "thing".to_owned(),
            title: "Thing done: t1".to_owned(),
            body: None,
            level: Some("success".to_owned()),
            metadata: Some(json!({ "thing_id": "t1" })),
        }),
    };
    let ok = host_events_emit(
        state.clone(),
        headers.clone(),
        Json(emit("@example/feedapp#thing.done")),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let rows = state.activity.list(10, None).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source, "feedapp");
    assert_eq!(rows[0].title, "Thing done: t1");
    assert_eq!(rows[0].metadata["thing_id"], "t1");

    let refused = host_events_emit(state.clone(), headers, Json(emit("core#run.failed"))).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(state.activity.list(10, None).await.unwrap().len(), 1);
}

/// A sidecar reaches `warmup.*` only with `warmup:crud` both declared in its
/// `host_api.grants` and approved; the owner is its authenticated id.
///
/// The kernel-capability dispatch builds debug-build futures that exceed the
/// 2 MiB test thread. Run it on one owned worker with the 16 MiB stack Core's
/// runtime workers use, rather than changing global stack settings.
#[test]
fn warmup_kernel_capability_requires_the_declared_and_approved_grant() {
    let worker = std::thread::Builder::new()
        .name("warmup-kernel-capability-fixture".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("create owned warmup fixture runtime")
                .block_on(Box::pin(run_warmup_kernel_capability_fixture()));
        })
        .expect("start warmup fixture worker");
    if let Err(panic) = worker.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_warmup_kernel_capability_fixture() {
    const APP: &str = "@example/pinger";
    let directory = tempfile::tempdir().unwrap();
    let jobs = directory.path().join("jobs");
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(APP, &["warmup:crud".to_owned()])
        .await
        .unwrap();
    let manifest = |host_grants: Vec<&str>| -> crate::plugin_manifest::PluginManifest {
        serde_json::from_value(json!({
            "id": APP, "name": "Pinger", "version": "1.0.0", "runnables": [],
            "permission_grants": ["warmup:crud"],
            "sidecars": [{ "name": "svc", "port": 18999,
                           "process": { "kind": "local", "command": "true" },
                           "host_api": { "grants": host_grants } }],
        }))
        .unwrap()
    };
    let call = |state: ServerState| async move {
        let request = Request::builder()
            .method("POST")
            .header(HDR_PLUGIN_ID, APP)
            .header("authorization", format!("Bearer {}", ext_token(None, APP)))
            .body(axum::body::Body::from("{}"))
            .unwrap();
        let response = host_capability(State(state), Path("warmup.list".to_owned()), request).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        )
    };
    crate::scheduler::store::with_test_jobs_directory(jobs, async {
        let mut foreign = crate::scheduler::store::ScheduledJob {
            id: "foreign".to_owned(),
            name: "foreign".to_owned(),
            schedule: crate::scheduler::store::Schedule::Every {
                interval: "1h".to_owned(),
            },
            target: crate::scheduler::store::JobTarget::Agent {
                agent_id: "a".to_owned(),
                prompt: "p".to_owned(),
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: false,
            owner_app: Some("@example/other".to_owned()),
            owner_user_id: None,
            org_id: None,
            created_at: "now".to_owned(),
            updated_at: "now".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        };
        crate::scheduler::store::save_job(&foreign).unwrap();
        foreign.id = "own".to_owned();
        foreign.owner_app = Some(APP.to_owned());
        crate::scheduler::store::save_job(&foreign).unwrap();

        // Approved but not declared as a host-API grant: refused.
        state.app_manifests.write().await.push(manifest(vec![]));
        let (status, body) = call(state.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

        // Declared and approved: answers with the caller's own jobs only.
        state.app_manifests.write().await.clear();
        state
            .app_manifests
            .write()
            .await
            .push(manifest(vec!["warmup:crud"]));
        let (status, body) = call(state.clone()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let ids: Vec<&str> = body["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|j| j["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["own"]);
    })
    .await;
}

/// Records what the run-recovery capabilities asked Core to do.
#[derive(Default)]
struct RecordingRunHost {
    approvals: std::sync::Mutex<Vec<crate::approvals::ApprovalRequest>>,
    agent_reruns: std::sync::Mutex<Vec<(Option<String>, String, String)>>,
    workflow_reruns: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl crate::server::app_runs::RunRecoveryHost for RecordingRunHost {
    async fn request_approval(
        &self,
        request: crate::approvals::ApprovalRequest,
    ) -> Result<Option<String>, crate::server::app_runs::RunOpError> {
        let id = request.id.clone();
        self.approvals.lock().unwrap().push(request);
        Ok(Some(id))
    }
    fn start_agent_rerun(
        &self,
        agent_id: Option<String>,
        run_id: String,
        prompt: String,
    ) -> Result<(), crate::server::app_runs::RunOpError> {
        self.agent_reruns
            .lock()
            .unwrap()
            .push((agent_id, run_id, prompt));
        Ok(())
    }
    fn start_workflow_rerun(
        &self,
        source_id: String,
    ) -> Result<(), crate::server::app_runs::RunOpError> {
        self.workflow_reruns.lock().unwrap().push(source_id);
        Ok(())
    }
}

/// Each run-recovery capability is refused unless its OWN grant is declared in
/// `host_api.grants` and approved, and with it does exactly what
/// `CoreHealingHost` did: the heal approval kinds, a `healrun_` agent re-run id
/// Core mints, and a workflow re-run of the named run.
#[tokio::test]
async fn run_recovery_capabilities_are_each_gated_by_their_own_grant() {
    use crate::server::app_runs::{
        GRANT_APPROVALS_REQUEST, GRANT_RERUN_AGENT, GRANT_WORKFLOW_RUNSTATE, TEST_HOST,
    };
    const APP: &str = "@example/healer";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    let all = [
        GRANT_APPROVALS_REQUEST,
        GRANT_RERUN_AGENT,
        GRANT_WORKFLOW_RUNSTATE,
    ];
    let manifest = |host_grants: &[&str]| -> crate::plugin_manifest::PluginManifest {
        serde_json::from_value(json!({
            "id": APP, "name": "Healer", "version": "1.0.0", "runnables": [],
            "permission_grants": all,
            "sidecars": [{ "name": "svc", "port": 18998,
                           "process": { "kind": "local", "command": "true" },
                           "host_api": { "grants": host_grants } }],
        }))
        .unwrap()
    };
    let call = |state: ServerState, cap: &'static str, body: serde_json::Value| async move {
        let request = Request::builder()
            .method("POST")
            .header(HDR_PLUGIN_ID, APP)
            .header("authorization", format!("Bearer {}", ext_token(None, APP)))
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let response = host_capability(State(state), Path(cap.to_owned()), request).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default(),
        )
    };
    let cases: [(&'static str, &str, serde_json::Value); 3] = [
        (
            "approvals.request",
            GRANT_APPROVALS_REQUEST,
            json!({ "kind": "heal_fix", "source_id": "conv-1", "agent_id": "a1",
                    "diagnosis": "bad query", "corrected": "search for X" }),
        ),
        (
            "runs.rerunAgent",
            GRANT_RERUN_AGENT,
            json!({ "agent_id": "a1", "prompt": "search for X" }),
        ),
        (
            "workflows.rerun",
            GRANT_WORKFLOW_RUNSTATE,
            json!({ "source_id": "run-9" }),
        ),
    ];
    let host = std::sync::Arc::new(RecordingRunHost::default());
    TEST_HOST
        .scope(host.clone(), async {
            for (cap, grant, body) in &cases {
                // Approved, but the sidecar declares every grant EXCEPT this one.
                let others: Vec<&str> = all.iter().copied().filter(|g| g != grant).collect();
                state
                    .app_store
                    .set_enabled(APP, &all.map(str::to_owned))
                    .await
                    .unwrap();
                *state.app_manifests.write().await = vec![manifest(&others)];
                let (status, _) = call(state.clone(), cap, body.clone()).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{cap} without its grant");
                // Declared, but the Gateway approved every grant EXCEPT this one.
                *state.app_manifests.write().await = vec![manifest(&all)];
                let approved: Vec<String> = others.iter().map(|g| (*g).to_owned()).collect();
                state.app_store.set_enabled(APP, &approved).await.unwrap();
                let (status, _) = call(state.clone(), cap, body.clone()).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{cap} unapproved");
            }
            assert!(host.approvals.lock().unwrap().is_empty());
            assert!(host.agent_reruns.lock().unwrap().is_empty());
            assert!(host.workflow_reruns.lock().unwrap().is_empty());

            // Declared and approved: each one acts.
            state
                .app_store
                .set_enabled(APP, &all.map(str::to_owned))
                .await
                .unwrap();
            for (cap, _, body) in &cases {
                let (status, reply) = call(state.clone(), cap, body.clone()).await;
                assert!(status.is_success(), "{cap}: {status} {reply}");
            }
        })
        .await;

    let approvals = host.approvals.lock().unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].kind, crate::approvals::ApprovalKind::HealFix);
    assert_eq!(approvals[0].source_ref.as_deref(), Some("conv-1"));
    let reruns = host.agent_reruns.lock().unwrap();
    assert_eq!(reruns.len(), 1);
    assert_eq!(reruns[0].0.as_deref(), Some("a1"));
    assert!(reruns[0].1.starts_with(ryu_healing_contracts::HEAL_PREFIX));
    assert_eq!(reruns[0].2, "search for X");
    assert_eq!(*host.workflow_reruns.lock().unwrap(), vec!["run-9"]);
}

/// A fan-out capability is never brokered: a sidecar that declares the edge
/// and holds the provider's grant is still refused before any binding, so it
/// cannot run or purge another app's jobs or data even when that app is the
/// sole provider.
#[tokio::test]
async fn fanout_capabilities_are_refused_by_the_broker() {
    const CALLER: &str = "@example/curious";
    const PROVIDER: &str = "@example/owner";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    for (id, grants) in [
        (
            CALLER,
            vec!["owner:jobs".to_owned(), "owner:data".to_owned()],
        ),
        (PROVIDER, Vec::new()),
    ] {
        state.app_store.insert(id, "1.0.0").await.unwrap();
        state.app_store.set_enabled(id, &grants).await.unwrap();
    }
    let caller: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
        "id": CALLER, "name": "Curious", "version": "1.0.0", "runnables": [],
        "permission_grants": ["owner:jobs", "owner:data"],
        "requires": { "capabilities": [
            { "capability": "jobs.run" }, { "capability": "data.purge" }
        ] },
        "sidecars": [{ "name": "svc", "port": 18997,
                       "process": { "kind": "local", "command": "true" } }],
    }))
    .unwrap();
    let provider: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
        "id": PROVIDER, "name": "Owner", "version": "1.0.0", "runnables": [],
        "sidecars": [{ "name": "svc", "port": 18996,
                       "process": { "kind": "local", "command": "true" },
                       "http": { "mount": "/api/owner", "routes": [
                           { "path": "/run", "method": "POST" },
                           { "path": "/purge", "method": "POST" }
                       ] } }],
        "provides": [
            { "capability": "jobs.run", "version": "1.0.0", "sidecar": "svc",
              "route": "/run", "grant": "owner:jobs" },
            { "capability": "data.purge", "version": "1.0.0", "sidecar": "svc",
              "route": "/purge", "grant": "owner:data" }
        ],
    }))
    .unwrap();
    *state.app_manifests.write().await = vec![caller, provider];
    for cap in ["jobs.run", "data.purge"] {
        let request = Request::builder()
            .method("POST")
            .header(HDR_PLUGIN_ID, CALLER)
            .header(
                "authorization",
                format!("Bearer {}", ext_token(None, CALLER)),
            )
            .body(axum::body::Body::from(r#"{"id":"j1","category":"x"}"#))
            .unwrap();
        let response = host_capability(State(state.clone()), Path(cap.to_owned()), request).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND, "{cap}: {body}");
        assert_eq!(body["error"], "capability not callable through the broker");
        assert_eq!(body["capability"], cap);
    }
}

#[test]
fn a_still_starting_wake_is_a_retryable_503_and_a_failed_start_is_not() {
    let starting = anyhow::Error::new(crate::sidecar::manager::SidecarStillStarting {
        name: "com.acme.tool/engine".to_owned(),
        waited: std::time::Duration::from_secs(20),
    });
    let response = wake_failed_response("test", "com.acme.tool/engine", &starting, false);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.headers().get(axum::http::header::RETRY_AFTER),
        Some(&axum::http::HeaderValue::from_static(WAKE_RETRY_AFTER_SECS))
    );

    let failed = anyhow::anyhow!("pip install failed");
    let response = wake_failed_response("test", "com.acme.tool/engine", &failed, true);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .is_none());
}
