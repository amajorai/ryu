//! Opt-in end-to-end test of [`BoxSessionClient`] against a real Ryu Box
//! service (`apps/box`).
//!
//! It runs only when `RYU_BOX_E2E_URL` (the service `/v1` base) and
//! `RYU_BOX_E2E_TOKEN` are set; otherwise it prints a skip notice and passes.
//! `tools/box-e2e.sh` starts the service with the development filesystem
//! driver on a free port and runs this test against it, without Docker.
//!
//! The managed prompt checks need no model credentials or network access: the
//! npm registry is pointed at a closed local port (install fails fast) or at
//! a local listener that never answers (install hangs until interrupted).

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::time::{Duration, Instant};

use ryu_sandbox::box_session::{
    BoxNetwork, BoxSessionClient, BoxUser, DisposableBoxSpec, ManagedPromptSpec, ManagedProvider,
    PromptRunView,
};
use ryu_sandbox::box_types::BoxSize;
use ryu_sandbox::WorkspaceId;

const ENV_URL: &str = "RYU_BOX_E2E_URL";
const ENV_TOKEN: &str = "RYU_BOX_E2E_TOKEN";
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const RUN_DEADLINE: Duration = Duration::from_secs(120);

struct E2eConfig {
    base: String,
    token: String,
}

fn config() -> Option<E2eConfig> {
    let base = std::env::var(ENV_URL).ok()?.trim().to_owned();
    let token = std::env::var(ENV_TOKEN).ok()?.trim().to_owned();
    if base.is_empty() || token.is_empty() {
        return None;
    }
    Some(E2eConfig { base, token })
}

fn stdout_text(output: &ryu_sandbox::ExecOutput) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn unique_name(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Reads the Box event log with a plain HTTP client so the assertion does not
/// depend on the client under test.
async fn box_events_text(config: &E2eConfig, id: &WorkspaceId) -> String {
    let response = reqwest::Client::new()
        .get(format!("{}/boxes/{}/events?limit=500", config.base, id.0))
        .bearer_auth(&config.token)
        .send()
        .await
        .expect("events request");
    assert!(
        response.status().is_success(),
        "events returned {}",
        response.status()
    );
    let text = response.text().await.expect("events body");
    let value: serde_json::Value = serde_json::from_str(&text).expect("events JSON");
    assert!(
        value["events"]
            .as_array()
            .is_some_and(|events| !events.is_empty()),
        "expected a non-empty events array: {text}"
    );
    text
}

async fn wait_for_run(
    client: &BoxSessionClient,
    id: &WorkspaceId,
    run_id: &str,
    done: impl Fn(&PromptRunView) -> bool,
) -> PromptRunView {
    let deadline = Instant::now() + RUN_DEADLINE;
    loop {
        let run = client.prompt_run(id, run_id).await.expect("prompt_run");
        if done(&run) {
            return run;
        }
        assert!(
            Instant::now() < deadline,
            "prompt run {run_id} did not reach the expected state: {run:?}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Env that keeps the managed CLI install offline and fast to fail.
fn offline_npm_env(registry: &str) -> Vec<(String, String)> {
    vec![
        ("NPM_CONFIG_REGISTRY".to_owned(), registry.to_owned()),
        ("NPM_CONFIG_FETCH_RETRIES".to_owned(), "0".to_owned()),
        ("NPM_CONFIG_UPDATE_NOTIFIER".to_owned(), "false".to_owned()),
    ]
}

async fn exercise_disposable_box(client: &BoxSessionClient, config: &E2eConfig) {
    let name = unique_name("ryu-e2e-exec");
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: BoxNetwork::None,
        ttl_seconds: 600,
        setup: vec!["echo setup-ran > setup-marker.txt".to_owned()],
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let idempotency_key = uuid::Uuid::new_v4().to_string();
    let id = client
        .create_disposable(&spec, &idempotency_key)
        .await
        .expect("create_disposable");

    // Retrying with the same idempotency key returns the same Box.
    let again = client
        .create_disposable(&spec, &idempotency_key)
        .await
        .expect("idempotent create_disposable");
    assert_eq!(again, id);

    assert_eq!(
        client.find_by_name(&name).await.expect("find_by_name"),
        Some(id.clone())
    );
    assert_eq!(
        client
            .find_by_name(&unique_name("ryu-e2e-missing"))
            .await
            .expect("find_by_name missing"),
        None
    );

    let marker = client
        .exec_script(&id, "cat setup-marker.txt", &[], BoxUser::Box, 30)
        .await
        .expect("read setup marker");
    assert_eq!(marker.exit_code, 0, "{marker:?}");
    assert_eq!(stdout_text(&marker).trim(), "setup-ran");

    // Per-command env reaches the process for both users.
    let secret = format!("e2e-secret-{}", uuid::Uuid::new_v4().simple());
    let env = vec![("RYU_E2E_SECRET".to_owned(), secret.clone())];
    for user in [BoxUser::Box, BoxUser::Root] {
        let output = client
            .exec_script(&id, "printf '%s' \"$RYU_E2E_SECRET\"", &env, user, 30)
            .await
            .expect("exec_script with env");
        assert_eq!(output.exit_code, 0, "{user:?}: {output:?}");
        assert_eq!(stdout_text(&output), secret, "{user:?}");
    }

    // Exit codes and stderr round-trip.
    let failing = client
        .exec_script(&id, "echo oops >&2; exit 7", &[], BoxUser::Box, 30)
        .await
        .expect("failing exec_script");
    assert_eq!(failing.exit_code, 7);
    assert_eq!(String::from_utf8_lossy(&failing.stderr).trim(), "oops");

    // Emulate a repository and read its diff the way the cloud-task arm does.
    let init = client
        .exec_script(
            &id,
            "set -e\n\
             git init -q repo\n\
             cd repo\n\
             git config user.email e2e@example.invalid\n\
             git config user.name 'Ryu E2E'\n\
             printf 'one\\n' > notes.txt\n\
             git add notes.txt\n\
             git commit -q -m init\n\
             printf 'two\\n' >> notes.txt\n",
            &[],
            BoxUser::Box,
            60,
        )
        .await
        .expect("git init and commit");
    assert_eq!(init.exit_code, 0, "{init:?}");
    let diff = client
        .exec_script(
            &id,
            "cd repo && git --no-pager diff --no-color",
            &[],
            BoxUser::Box,
            30,
        )
        .await
        .expect("git diff");
    assert_eq!(diff.exit_code, 0, "{diff:?}");
    let diff_text = stdout_text(&diff);
    assert!(diff_text.contains("+two"), "{diff_text}");
    assert!(diff_text.contains("notes.txt"), "{diff_text}");

    // A managed prompt needs a network policy that is not `none`.
    let refused = client
        .start_prompt(
            &id,
            &ManagedPromptSpec {
                provider: ManagedProvider::Opencode,
                text: "say hi".into(),
                cwd: ".".into(),
                env: Vec::new(),
                timeout_secs: 60,
            },
        )
        .await
        .expect_err("managed prompt on a network-none Box");
    assert!(refused.to_string().contains("400"), "{refused}");

    let events = box_events_text(config, &id).await;
    assert!(
        !events.contains(&secret),
        "Box events echoed a per-command env value"
    );

    client.destroy(&id).await.expect("destroy");
    client.destroy(&id).await.expect("destroy again is Ok");
    assert_eq!(
        client
            .find_by_name(&name)
            .await
            .expect("find after destroy"),
        None
    );
}

async fn exercise_managed_prompts(client: &BoxSessionClient, config: &E2eConfig) {
    let name = unique_name("ryu-e2e-prompt");
    let spec = DisposableBoxSpec {
        name,
        image: None,
        network: BoxNetwork::Allowlist(vec!["registry.npmjs.org".into()]),
        ttl_seconds: 600,
        setup: Vec::new(),
        size: BoxSize::Small,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let id = client
        .create_disposable(&spec, &uuid::Uuid::new_v4().to_string())
        .await
        .expect("create_disposable allowlist");

    // 1. The CLI install fails (closed registry port) -> terminal failure.
    let prompt_secret = format!("e2e-prompt-{}", uuid::Uuid::new_v4().simple());
    let mut env = offline_npm_env("http://127.0.0.1:9/");
    env.push(("OPENCODE_E2E_TOKEN".to_owned(), prompt_secret.clone()));
    let run = client
        .start_prompt(
            &id,
            &ManagedPromptSpec {
                provider: ManagedProvider::Opencode,
                text: "summarize the repository".into(),
                cwd: ".".into(),
                env,
                timeout_secs: 60,
            },
        )
        .await
        .expect("start_prompt");
    assert!(!run.id.is_empty());
    assert!(
        matches!(run.status.as_str(), "queued" | "running"),
        "{run:?}"
    );
    let failed = wait_for_run(client, &id, &run.id, PromptRunView::is_terminal).await;
    assert_eq!(failed.status, "failed", "{failed:?}");
    assert_ne!(failed.exit_code, Some(0), "{failed:?}");
    assert!(failed.completed_at.is_some(), "{failed:?}");

    // Cancel on a terminal run is idempotent and keeps the terminal state.
    for _ in 0..2 {
        let canceled = client
            .cancel_prompt(&id, &run.id)
            .await
            .expect("cancel_prompt on a terminal run");
        assert_eq!(canceled.id, run.id);
        assert_eq!(canceled.status, "failed");
        assert_eq!(canceled.exit_code, failed.exit_code);
    }

    // Page the failed run's process output.
    let process_id = failed
        .process_id
        .clone()
        .expect("failed run recorded its process id");
    let first = client
        .process_output_after(&id, &process_id, 0)
        .await
        .expect("process_output_after 0");
    assert!(first.exited, "process should have exited");
    assert!(!first.chunks.is_empty(), "expected install output");
    assert!(first
        .chunks
        .windows(2)
        .all(|pair| pair[0].seq < pair[1].seq));
    let combined: String = first
        .chunks
        .iter()
        .map(|chunk| chunk.data.as_str())
        .collect();
    assert!(combined.contains("Installing opencode-ai"), "{combined}");
    let pivot = first.chunks[0].seq;
    let rest = client
        .process_output_after(&id, &process_id, pivot)
        .await
        .expect("process_output_after pivot");
    assert_eq!(rest.chunks.len(), first.chunks.len() - 1);
    assert!(rest.chunks.iter().all(|chunk| chunk.seq > pivot));
    let last = first.chunks.last().map_or(0, |chunk| chunk.seq);
    let tail = client
        .process_output_after(&id, &process_id, last)
        .await
        .expect("process_output_after last");
    assert!(tail.chunks.is_empty());
    assert!(tail.exited);

    // 2. The install hangs on a registry that never answers; interrupt ends it.
    let blackhole = TcpListener::bind("127.0.0.1:0").expect("bind blackhole");
    let blackhole_addr = blackhole.local_addr().expect("blackhole addr");
    let holder = std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in blackhole.incoming().take(16).flatten() {
            held.push(stream);
        }
    });
    let mut env = offline_npm_env(&format!("http://{blackhole_addr}/"));
    env.push(("NPM_CONFIG_FETCH_TIMEOUT".to_owned(), "600000".to_owned()));
    let hanging = client
        .start_prompt(
            &id,
            &ManagedPromptSpec {
                provider: ManagedProvider::Opencode,
                text: "this run is interrupted".into(),
                cwd: ".".into(),
                env,
                timeout_secs: 300,
            },
        )
        .await
        .expect("start hanging prompt");
    let started = wait_for_run(client, &id, &hanging.id, |run| {
        run.process_id.is_some() || run.is_terminal()
    })
    .await;
    assert_eq!(started.status, "running", "{started:?}");
    client.interrupt(&id).await.expect("interrupt");
    let interrupted = wait_for_run(client, &id, &hanging.id, PromptRunView::is_terminal).await;
    assert_eq!(interrupted.status, "failed", "{interrupted:?}");
    assert_eq!(interrupted.reason.as_deref(), Some("canceled"));
    let page = client
        .process_output_after(&id, started.process_id.as_deref().unwrap_or_default(), 0)
        .await
        .expect("interrupted process output");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut exited = page.exited;
    while !exited {
        assert!(
            Instant::now() < deadline,
            "interrupted process kept running"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
        exited = client
            .process_output_after(&id, started.process_id.as_deref().unwrap_or_default(), 0)
            .await
            .expect("interrupted process output")
            .exited;
    }
    let canceled_again = client
        .cancel_prompt(&id, &hanging.id)
        .await
        .expect("cancel after interrupt");
    assert_eq!(canceled_again.status, "failed");
    assert_eq!(canceled_again.reason.as_deref(), Some("canceled"));
    // Interrupting an idle Box is still Ok.
    client.interrupt(&id).await.expect("idle interrupt");

    let events = box_events_text(config, &id).await;
    assert!(
        !events.contains(&prompt_secret),
        "Box events echoed a per-prompt env value"
    );

    client.destroy(&id).await.expect("destroy prompt Box");
    client
        .destroy(&id)
        .await
        .expect("destroy prompt Box again is Ok");
    drop(holder);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn box_service_e2e_session_client_round_trip() {
    let Some(config) = config() else {
        eprintln!(
            "skipping box_service_e2e: set {ENV_URL} (Box /v1 base) and {ENV_TOKEN}, \
             or run tools/box-e2e.sh"
        );
        return;
    };
    let client = BoxSessionClient::with_endpoint(config.base.clone(), config.token.clone());
    exercise_disposable_box(&client, &config).await;
    exercise_managed_prompts(&client, &config).await;
}
