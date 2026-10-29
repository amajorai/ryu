//! Subscription backends against a fake provider CLI: routing, fallback, no Box
//! billing, and token handling.

use super::cli::{self, CliFailure, CliOutput, CliRunner, Invocation, SignIn};
use super::routing::{self, Availability, SessionPin};
use super::store::{self, EnvironmentLink, RoutingSettings};
use super::*;
use std::sync::Mutex;

/// The owner routes (routing settings, cooldowns, runs, accounts) at the handler level.
mod api_routes;

/// The runner and store are process-wide; these tests take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type Script = Box<dyn Fn(&Invocation) -> Result<CliOutput, CliFailure> + Send + Sync>;

/// What a fake streaming call prints, and how it ends.
struct FakeStream {
    lines: Vec<String>,
    exit: CliOutput,
    /// Keep running after the lines until stopped (then exit with no code).
    hang: bool,
}

type StreamScript = Box<dyn Fn(&Invocation) -> FakeStream + Send + Sync>;

struct FakeCli {
    installed: bool,
    script: Script,
    stream: Option<StreamScript>,
    calls: Mutex<Vec<Vec<String>>>,
    detached: Mutex<Vec<Vec<String>>>,
    /// Each call's first argument and the account folder it ran with.
    homes: Mutex<Vec<(String, Option<std::path::PathBuf>)>>,
}

impl FakeCli {
    fn install(script: Script) -> Arc<Self> {
        Self::install_streaming(script, None)
    }
    fn install_streaming(script: Script, stream: Option<StreamScript>) -> Arc<Self> {
        let fake = Arc::new(Self {
            installed: true,
            script,
            stream,
            calls: Mutex::new(Vec::new()),
            detached: Mutex::new(Vec::new()),
            homes: Mutex::new(Vec::new()),
        });
        set_runner_for_test(fake.clone());
        fake
    }
    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
    fn homes(&self) -> Vec<(String, Option<std::path::PathBuf>)> {
        self.homes.lock().unwrap().clone()
    }
    fn note(&self, invocation: &Invocation) {
        let first = invocation.args.first().cloned().unwrap_or_default();
        self.homes
            .lock()
            .unwrap()
            .push((first, invocation.account_dir.clone()));
    }
}

#[async_trait::async_trait]
impl CliRunner for FakeCli {
    fn installed(&self, _provider: Provider) -> bool {
        self.installed
    }
    async fn run(&self, invocation: Invocation) -> Result<CliOutput, CliFailure> {
        let mut call = vec![invocation.provider.program().to_owned()];
        call.extend(invocation.args.iter().cloned());
        self.calls.lock().unwrap().push(call);
        self.note(&invocation);
        (self.script)(&invocation)
    }
    fn spawn_detached(&self, invocation: Invocation) -> Result<(), CliFailure> {
        let mut call = vec![invocation.provider.program().to_owned()];
        call.extend(invocation.args.iter().cloned());
        self.detached.lock().unwrap().push(call);
        self.note(&invocation);
        Ok(())
    }
    fn spawn_stream(&self, invocation: Invocation) -> Result<cli::Streaming, CliFailure> {
        let mut call = vec![invocation.provider.program().to_owned()];
        call.extend(invocation.args.iter().cloned());
        self.calls.lock().unwrap().push(call);
        self.note(&invocation);
        let script = self.stream.as_ref().ok_or(CliFailure::NotInstalled)?;
        let FakeStream { lines, exit, hang } = script(&invocation);
        let (line_tx, line_rx) = tokio::sync::mpsc::channel(256);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let (kill, kill_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            for line in lines {
                let _ = line_tx.send(line).await;
            }
            if hang {
                let _ = kill_rx.await;
                drop(line_tx);
                let _ = exit_tx.send(CliOutput {
                    exit_code: None,
                    ..CliOutput::default()
                });
            } else {
                drop(line_tx);
                let _ = exit_tx.send(exit);
            }
        });
        Ok(cli::Streaming {
            lines: line_rx,
            exit: exit_rx,
            kill,
        })
    }
}

fn default_key(provider: Provider) -> String {
    accounts::account_key(provider, accounts::DEFAULT_ACCOUNT)
}

fn ok(stdout: &str) -> Result<CliOutput, CliFailure> {
    Ok(CliOutput {
        exit_code: Some(0),
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

fn fail(stderr: &str) -> Result<CliOutput, CliFailure> {
    Ok(CliOutput {
        exit_code: Some(1),
        stdout: String::new(),
        stderr: stderr.into(),
    })
}

fn is(invocation: &Invocation, args: &[&str]) -> bool {
    invocation.args.len() >= args.len()
        && invocation
            .args
            .iter()
            .zip(args)
            .all(|(have, want)| have == want)
}

const CLAUDE_SUBSCRIPTION: &str =
    r#"{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"/home/u/.claude"}"#;
const SESSION: &str = "session_01DiUkqY2kzbUbDmW1w96rfi";

/// A fake `claude` that is signed in with the plan and starts sessions; `start` decides
/// how the start goes.
fn claude_with(start: fn() -> Result<CliOutput, CliFailure>) -> Script {
    Box::new(move |invocation| {
        if is(invocation, &["auth", "status"]) {
            ok(CLAUDE_SUBSCRIPTION)
        } else if is(invocation, &["--cloud"]) {
            start()
        } else if is(invocation, &["-p"]) {
            ok(&format!(
                r#"{{"ok":true,"session_id":"{SESSION}","url":"https://claude.ai/code/{SESSION}"}}"#
            ))
        } else {
            fail("unexpected call")
        }
    })
}

fn started_claude() -> Result<CliOutput, CliFailure> {
    ok(&format!(
        "Creating cloud session…\nSession ID: {SESSION}\nView: https://claude.ai/code/{SESSION}?from=cli\n"
    ))
}

fn node_owner() -> ResolvedAuthorization {
    ResolvedAuthorization {
        context: crate::authorization::AuthorizationContext::owner(0),
        bindings: crate::authorization::RequestBindings::default(),
        caller: None,
        verified_user_jwt: None,
    }
}

fn other_user() -> ResolvedAuthorization {
    use crate::authorization::*;
    ResolvedAuthorization {
        context: AuthorizationContext {
            credential: CredentialKind::ManagedUserJwt,
            principal: Principal::User {
                subject_id: "someone-else".into(),
            },
            capabilities: CapabilitySet::new([Capability::GatewayRoute, Capability::ToolsExec]),
            constraints: GrantConstraints::default(),
            issued_at: 0,
            expires_at: None,
        },
        bindings: RequestBindings::default(),
        caller: None,
        verified_user_jwt: None,
    }
}

/// A git checkout on disk for `claude --cloud` to run in.
fn checkout() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir(dir.path().join(".git")).expect(".git");
    dir
}

fn enable(owner: &str, environment: &str, checkout: &std::path::Path) {
    let mut settings = RoutingSettings {
        enabled: true,
        ..RoutingSettings::default()
    };
    settings.environments.insert(
        environment.into(),
        EnvironmentLink {
            claude_checkout: Some(checkout.to_string_lossy().into_owned()),
            codex_environment_id: Some("env_codex123".into()),
        },
    );
    store::save_settings(owner, settings);
}

fn fresh_conversation() -> String {
    format!("sub-{}", uuid::Uuid::new_v4().simple())
}

fn request<'a>(conversation_id: &'a str, executor: &'a str, pin: SessionPin) -> RouteRequest<'a> {
    RouteRequest {
        owner: "node-owner",
        conversation_id,
        environment_id: "env-1",
        executor,
        agent_id: None,
        pin,
        account: None,
        text: "Fix the login bug",
    }
}

fn unpinned() -> SessionPin {
    SessionPin {
        backend: None,
        fallback: true,
    }
}

fn error_code(error: &api::ApiError) -> String {
    error.1 .0["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

// ── Routing (pure) ───────────────────────────────────────────────────────────

#[test]
fn routing_prefers_the_plan_then_falls_back_to_the_box() {
    let plan = routing::resolve(
        "claude-code",
        SessionPin::default(),
        None,
        &routing::DEFAULT_ORDER,
        |_| Availability::Ready,
    );
    assert_eq!(
        plan.candidates,
        vec![
            CloudTaskBackend::AnthropicSubscriptionCli,
            CloudTaskBackend::AnthropicSubscriptionSdk,
            CloudTaskBackend::RyuBox
        ]
    );
    assert!(plan.notices.is_empty());
}

#[test]
fn routing_never_sends_an_executor_to_another_providers_plan() {
    for (executor, expected) in [
        (
            "codex",
            vec![
                CloudTaskBackend::OpenaiSubscriptionCli,
                CloudTaskBackend::OpenaiSubscriptionSdk,
                CloudTaskBackend::RyuBox,
            ],
        ),
        ("ryu", vec![CloudTaskBackend::RyuBox]),
        ("opencode", vec![CloudTaskBackend::RyuBox]),
    ] {
        let plan = routing::resolve(
            executor,
            SessionPin::default(),
            None,
            &routing::DEFAULT_ORDER,
            |_| Availability::Ready,
        );
        assert_eq!(plan.candidates, expected, "{executor}");
    }
}

#[test]
fn routing_session_pin_beats_agent_order_beats_default() {
    let agent = [CloudTaskBackend::RyuBox];
    let by_agent = routing::resolve(
        "claude-code",
        SessionPin::default(),
        Some(&agent),
        &routing::DEFAULT_ORDER,
        |_| Availability::Ready,
    );
    assert_eq!(by_agent.candidates, vec![CloudTaskBackend::RyuBox]);
    let by_session = routing::resolve(
        "claude-code",
        SessionPin {
            backend: Some(CloudTaskBackend::AnthropicSubscriptionCli),
            fallback: true,
        },
        Some(&agent),
        &routing::DEFAULT_ORDER,
        |_| Availability::Ready,
    );
    assert_eq!(
        by_session.candidates,
        vec![
            CloudTaskBackend::AnthropicSubscriptionCli,
            CloudTaskBackend::RyuBox
        ]
    );
}

#[test]
fn routing_strict_pin_has_no_box_and_unavailable_plans_leave_notices() {
    let strict = routing::resolve(
        "claude-code",
        SessionPin {
            backend: Some(CloudTaskBackend::AnthropicSubscriptionCli),
            fallback: false,
        },
        None,
        &routing::DEFAULT_ORDER,
        |_| Availability::CoolingDown,
    );
    assert!(strict.candidates.is_empty());
    assert_eq!(strict.notices[0].code, "subscription_cooling_down");
    for (availability, code) in [
        (Availability::SignedOut, "subscription_signed_out"),
        (Availability::WrongSignIn, "subscription_signed_out"),
        (Availability::NotInstalled, "subscription_unavailable"),
        (Availability::NotConfigured, "subscription_not_configured"),
    ] {
        let plan = routing::resolve(
            "claude-code",
            SessionPin::default(),
            None,
            &routing::DEFAULT_ORDER,
            |_| availability,
        );
        assert_eq!(plan.candidates, vec![CloudTaskBackend::RyuBox]);
        assert_eq!(plan.notices[0].code, code);
    }
    let disabled = routing::resolve(
        "claude-code",
        SessionPin::default(),
        None,
        &routing::DEFAULT_ORDER,
        |_| Availability::Disabled,
    );
    assert!(disabled.notices.is_empty(), "turned off is not news");
}

#[test]
fn a_missing_setting_is_reported_for_each_backend_of_one_plan() {
    // Both Codex backends share one plan but name different settings, so a
    // plan-wide reason is said once while this one is never folded away.
    let order = [
        CloudTaskBackend::OpenaiSubscriptionCli,
        CloudTaskBackend::OpenaiSubscriptionSdk,
    ];
    let plan = routing::resolve(
        "codex",
        SessionPin::default(),
        Some(&order),
        &routing::DEFAULT_ORDER,
        |_| Availability::NotConfigured,
    );
    let settings: Vec<&str> = plan
        .notices
        .iter()
        .filter(|notice| notice.code == "subscription_not_configured")
        .map(|notice| notice.message.as_str())
        .collect();
    assert_eq!(settings.len(), 2, "{settings:?}");
    assert!(settings[0].contains("Codex environment ID"), "{settings:?}");
    assert!(settings[1].contains("local checkout"), "{settings:?}");
    let signed_out = routing::resolve(
        "codex",
        SessionPin::default(),
        Some(&order),
        &routing::DEFAULT_ORDER,
        |_| Availability::SignedOut,
    );
    assert_eq!(
        signed_out
            .notices
            .iter()
            .filter(|notice| notice.code == "subscription_signed_out")
            .count(),
        1,
        "a plan-wide reason is still said once"
    );
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

fn output(code: i32, stdout: &str) -> CliOutput {
    CliOutput {
        exit_code: Some(code),
        stdout: stdout.into(),
        stderr: String::new(),
    }
}

#[test]
fn sign_in_counts_only_the_subscription_login() {
    let anthropic = |code, stdout| cli::parse_sign_in(Provider::Anthropic, &output(code, stdout));
    assert_eq!(anthropic(0, CLAUDE_SUBSCRIPTION), SignIn::Subscription);
    assert_eq!(
        anthropic(0, r#"{"authMethod":"api_key"}"#),
        SignIn::OtherMethod
    );
    assert_eq!(
        anthropic(0, r#"{"authMethod":"oauth_token"}"#),
        SignIn::OtherMethod
    );
    assert_eq!(anthropic(1, r#"{"authMethod":"none"}"#), SignIn::SignedOut);
    let openai = |code, stdout| cli::parse_sign_in(Provider::Openai, &output(code, stdout));
    assert_eq!(openai(0, "Logged in using ChatGPT"), SignIn::Subscription);
    assert_eq!(
        openai(0, "Logged in using an API key - sk-***"),
        SignIn::OtherMethod
    );
    assert_eq!(openai(1, "Not logged in"), SignIn::SignedOut);
}

#[test]
fn start_output_parses_into_ids_and_links() {
    let started = cli::parse_claude_started(&started_claude().unwrap()).unwrap();
    assert_eq!(started.external_id.as_deref(), Some(SESSION));
    assert_eq!(
        started.url.as_deref(),
        Some("https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi")
    );
    assert!(cli::parse_claude_started(&output(0, "Cloning…")).is_none());
    let codex = cli::parse_codex_started(&output(
        0,
        "Submitted. https://chatgpt.com/codex/tasks/task_e_68a1b2c3d4",
    ));
    assert_eq!(codex.external_id.as_deref(), Some("task_e_68a1b2c3d4"));
    let list = cli::parse_codex_list(&output(
        0,
        r#"{"tasks":[{"id":"task_e_1","url":"https://chatgpt.com/codex/tasks/task_e_1","title":"t","status":"ready","updated_at":"x","environment_id":"e","environment_label":"l","summary":"Done","is_review":false,"attempt_total":1}],"cursor":null}"#,
    ))
    .unwrap();
    assert_eq!(list[0].status.as_deref(), Some("ready"));
    assert!(
        cli::parse_claude_follow_up(&output(0, r#"{"ok":true,"session_id":"s","url":"u"}"#))
            .is_ok()
    );
    assert!(cli::parse_claude_follow_up(&output(
        1,
        r#"{"ok":false,"session_id":"s","error":"archived"}"#
    ))
    .is_err());
}

#[test]
fn failures_are_classified_so_only_plan_problems_fall_back() {
    let class = |stderr: &str| {
        cli::classify(
            &CliOutput {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: stderr.into(),
            },
            "",
        )
    };
    assert_eq!(
        class("Claude usage limit reached. Resets at 5pm"),
        cli::FailureClass::Quota
    );
    assert_eq!(class("429 Too Many Requests"), cli::FailureClass::Quota);
    assert_eq!(
        class("Cloud sessions need a claude.ai sign-in. Run `claude auth login`"),
        cli::FailureClass::SignedOut
    );
    assert_eq!(
        class("Cloud sessions are disabled by your organization's policy."),
        cli::FailureClass::Unavailable
    );
    assert_eq!(
        class("Not uploading this working tree: older git"),
        cli::FailureClass::Rejected
    );
    // Numbers, names and paths that merely contain a code or a word are not plan errors.
    assert_eq!(
        class("fatal: repository 'acme/quota-service' not found"),
        cli::FailureClass::Rejected
    );
    assert_eq!(
        class("object a429f0c1 missing; see /login/help"),
        cli::FailureClass::Rejected
    );
    assert_eq!(
        class("connect to 127.0.0.1:4290 refused"),
        cli::FailureClass::Rejected
    );
    // The task the CLI echoes back is not evidence either.
    assert_eq!(
        cli::classify(
            &CliOutput {
                exit_code: Some(1),
                stdout: "Task: fix the rate limit bug".into(),
                stderr: "Not uploading this working tree".into(),
            },
            "fix the rate limit bug",
        ),
        cli::FailureClass::Rejected
    );
    // A zero exit may have started the run: never a fallback.
    assert_eq!(
        cli::classify(&output(0, "usage limit reached"), ""),
        cli::FailureClass::Rejected
    );
}

// ── Token handling (security) ────────────────────────────────────────────────

const SECRETS: [&str; 6] = [
    "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
    "Bearer abcdefghijklmnop1234",
    "refresh_token=rt_9f8e7d6c5b4a39281706",
    "0123456789abcdef0123456789abcdef0123456789abcdef",
];

#[test]
fn scrub_masks_every_token_shape_and_caps_length() {
    for secret in SECRETS {
        let scrubbed = redact::scrub(&format!("Error: request failed with {secret} attached"));
        let tail = secret.rsplit(['=', ' ']).next().unwrap();
        assert!(!scrubbed.contains(tail), "{secret} leaked: {scrubbed}");
        assert!(scrubbed.contains("[redacted]"));
    }
    assert!(redact::scrub(&"x ".repeat(2000)).chars().count() <= redact::MAX_KEPT_CHARS + 1);
}

#[test]
fn child_env_drops_keys_tokens_base_urls_and_ryu_variables() {
    let parent = [
        ("PATH", "/usr/bin"),
        ("HOME", "/home/u"),
        ("CLAUDE_CONFIG_DIR", "/home/u/.claude"),
        ("ANTHROPIC_API_KEY", "sk-ant-api03-x"),
        ("ANTHROPIC_AUTH_TOKEN", "t"),
        ("ANTHROPIC_BASE_URL", "http://127.0.0.1:4000"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-x"),
        ("OPENAI_API_KEY", "sk-x"),
        ("OPENAI_BASE_URL", "http://127.0.0.1:4000/v1"),
        ("CODEX_API_KEY", "sk-x"),
        ("RYU_TOKEN", "node"),
        ("RYU_MASTER_KEY", "k"),
        ("GITHUB_TOKEN", "ghp_x"),
    ]
    .map(|(name, value)| (name.to_owned(), value.to_owned()));
    let child = cli::child_env(parent);
    let names: Vec<&str> = child.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, vec!["PATH", "HOME", "CLAUDE_CONFIG_DIR"]);
    for denied in cli::ENV_DENYLIST {
        assert!(!names.contains(denied));
    }
}

#[tokio::test]
async fn secrets_in_cli_output_never_reach_notices_records_or_errors() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    FakeCli::install(Box::new(|invocation| {
        if is(invocation, &["auth", "status"]) {
            ok(CLAUDE_SUBSCRIPTION)
        } else {
            fail(&format!(
                "Error: Not uploading this working tree with token {} and {}",
                SECRETS[0], SECRETS[2]
            ))
        }
    }));
    let conversation = fresh_conversation();
    let error = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect_err("rejected");
    let body = error.1 .0.to_string();
    assert_eq!(error_code(&error), "subscription_run_rejected");
    assert!(
        !body.contains("AbCdEfGh") && !body.contains("eyJhbGci"),
        "{body}"
    );

    // A follow-up failure is stored on the record: scrubbed there too.
    store::save_run(store::RunRecord {
        conversation_id: conversation.clone(),
        owner: "node-owner".into(),
        backend: CloudTaskBackend::AnthropicSubscriptionCli,
        environment_id: "env-1".into(),
        executor: "claude-code".into(),
        account_id: None,
        external_id: Some(SESSION.into()),
        url: None,
        status: "submitted".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: None,
        branch: None,
        created_at: 0,
        updated_at: 0,
        result_posted: false,
    });
    FakeCli::install(Box::new(|_| {
        Ok(CliOutput {
            exit_code: Some(1),
            stdout: format!(
                r#"{{"ok":false,"session_id":"s","error":"bad {}"}}"#,
                SECRETS[0]
            ),
            stderr: String::new(),
        })
    }));
    let error = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect_err("follow-up failed");
    assert!(!error.1 .0.to_string().contains("AbCdEfGh"));
    let saved = serde_json::to_string(&store::run(&conversation).unwrap()).unwrap();
    assert!(!saved.contains("AbCdEfGh"), "{saved}");
    assert!(saved.contains("[redacted]"));
}

// ── Start, fall back, and never bill ─────────────────────────────────────────

#[tokio::test]
async fn a_plan_run_starts_without_any_box_and_fences_both_box_paths() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let fake = FakeCli::install(claude_with(started_claude));
    let conversation = fresh_conversation();
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect("routes");
    let RouteOutcome::Started { record, notices } = outcome else {
        panic!("expected a plan run, got {outcome:?}");
    };
    assert!(notices.is_empty());
    assert_eq!(record.backend, CloudTaskBackend::AnthropicSubscriptionCli);
    assert_eq!(record.external_id.as_deref(), Some(SESSION));
    assert_eq!(
        fake.calls(),
        vec![
            vec!["claude".to_owned(), "auth".into(), "status".into()],
            vec![
                "claude".to_owned(),
                "--cloud".into(),
                "Fix the login bug".into()
            ],
        ]
    );

    // No Box exists, is counted against the cap, or was announced.
    assert_eq!(crate::server::cloud_tasks::live_box_count("node-owner"), 0);
    assert!(!crate::server::session_box::notice::acknowledged(
        "node-owner"
    ));
    assert!(
        crate::server::cloud_tasks::bound_box("node-owner", &conversation)
            .await
            .is_none()
    );

    // Both Box paths refuse this conversation.
    let error =
        crate::server::cloud_tasks::ensure_task_workspace(&node_owner(), &conversation, "env-1")
            .await
            .expect_err("cloud task Box fenced");
    assert_eq!(error.1 .0["error"]["code"], "cloud_task_on_subscription");
    let key =
        crate::server::session_box::SessionBoxKey::parse("node-owner", &conversation).unwrap();
    let error = crate::server::session_box::desktop_target(
        &node_owner(),
        &key,
        Some(crate::server::session_box::AcquireReason::ComputerUse),
    )
    .await
    .expect_err("session Box fenced");
    assert_eq!(
        error.1 .0["error"]["code"],
        "session_box_unavailable_on_subscription"
    );
    assert!(
        crate::server::session_box::desktop_target(&node_owner(), &key, None)
            .await
            .expect("attach-only reads no Box")
            .is_none()
    );

    // A follow-up stays on the plan.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect("follow-up");
    assert!(matches!(outcome, RouteOutcome::Started { .. }));
    assert_eq!(fake.calls().last().unwrap()[1], "-p");
}

#[tokio::test]
async fn quota_falls_back_to_the_box_with_a_notice_and_a_cooldown() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let fake = FakeCli::install(claude_with(|| {
        fail("Error: Claude usage limit reached. Resets 5pm.")
    }));
    let conversation = fresh_conversation();
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect("falls back");
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box, got {outcome:?}");
    };
    assert_eq!(notices[0].code, "subscription_quota_fallback");
    assert!(notices[0].message.contains("Ryu credits"));
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), unix_now()).is_some());
    assert!(
        !fences_box(&conversation),
        "a fallback conversation may use the Box"
    );

    // While cooling down the plan is skipped without asking the CLI to start anything.
    let before = fake.calls().len();
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .expect("falls back");
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box");
    };
    assert_eq!(notices[0].code, "subscription_cooling_down");
    assert_eq!(fake.calls().len(), before);
}

#[tokio::test]
async fn a_strict_pin_never_falls_back_and_a_bad_request_never_becomes_a_box() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    FakeCli::install(claude_with(|| fail("rate limit exceeded")));
    let strict = SessionPin {
        backend: Some(CloudTaskBackend::AnthropicSubscriptionCli),
        fallback: false,
    };
    let error = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", strict),
    )
    .await
    .expect_err("strict");
    assert_eq!(error_code(&error), "subscription_backend_unavailable");

    store::reset_for_test();
    enable("node-owner", "env-1", dir.path());
    FakeCli::install(claude_with(|| {
        fail("Not uploading this working tree: unsupported layout")
    }));
    let error = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .expect_err("rejected");
    assert_eq!(error_code(&error), "subscription_run_rejected");

    store::reset_for_test();
    enable("node-owner", "env-1", dir.path());
    FakeCli::install(claude_with(|| Err(CliFailure::TimedOut)));
    let error = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .expect_err("a timeout may have started the run");
    assert_eq!(error_code(&error), "subscription_run_rejected");
}

#[tokio::test]
async fn only_the_node_owner_uses_the_plan_and_off_means_off() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    let fake = FakeCli::install(claude_with(started_claude));
    // Not enabled: straight to the Box, no CLI call.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .unwrap();
    assert!(matches!(outcome, RouteOutcome::UseBox { ref notices } if notices.is_empty()));
    assert!(fake.calls().is_empty());

    enable("someone-else", "env-1", dir.path());
    enable("node-owner", "env-1", dir.path());
    let other_conversation = fresh_conversation();
    let mut other = request(&other_conversation, "claude-code", unpinned());
    other.owner = "user:someone-else";
    let outcome = start_or_fall_back(&other_user(), other).await.unwrap();
    assert!(matches!(outcome, RouteOutcome::UseBox { .. }));
    assert!(
        fake.calls().is_empty(),
        "another user's task never touches the owner's CLI"
    );
    let pinned_conversation = fresh_conversation();
    let mut pinned = request(
        &pinned_conversation,
        "claude-code",
        SessionPin {
            backend: Some(CloudTaskBackend::AnthropicSubscriptionCli),
            fallback: true,
        },
    );
    pinned.owner = "user:someone-else";
    let error = start_or_fall_back(&other_user(), pinned)
        .await
        .expect_err("owner only");
    assert_eq!(error_code(&error), "subscription_backend_owner_only");
}

/// The desktop sends the signed-in user's JWT with every request to its own node.
#[tokio::test]
async fn the_signed_in_owner_on_their_own_node_is_still_the_node_owner() {
    use crate::identity_verify::{OrgRole, VerifiedCaller};
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };
    let caller = |user_id: &str| VerifiedCaller {
        user_id: user_id.into(),
        email: None,
        email_verified: false,
        org_id: None,
        role: OrgRole::Viewer,
        teams: Vec::new(),
    };
    let signed_in = |user_id: &str| {
        let mut auth = node_owner();
        auth.caller = Some(caller(user_id));
        auth.verified_user_jwt = Some("verified.jwt".into());
        auth
    };
    let registered = |scope: NodeScope, owner: Option<&str>| RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".into(),
            name: "Org".into(),
            slug: None,
        },
        node_id: "node-1".into(),
        scope,
        team_id: None,
        owner_user_id: owner.map(str::to_owned),
    };

    // A self-hosted node that is not registered: the node token proves ownership.
    with_test_node_binding(false, None, async {
        let auth = signed_in("owner-1");
        assert!(caller_is_node_owner(&auth));
        assert_eq!(plan_owner(&auth, "user:owner-1"), "node-owner");
        assert_eq!(plan_owner(&node_owner(), "node-owner"), "node-owner");
        // An identity asserted for a self call carries no verified JWT.
        let mut acting = signed_in("owner-1");
        acting.verified_user_jwt = None;
        assert!(!caller_is_node_owner(&acting));
        // Only the node-token credential is the owner.
        let mut other = other_user();
        other.caller = Some(caller("someone-else"));
        other.verified_user_jwt = Some("verified.jwt".into());
        assert!(!caller_is_node_owner(&other));
        assert_eq!(plan_owner(&other, "user:someone-else"), "user:someone-else");
    })
    .await;

    // A personal managed node belongs to its registered owner only.
    let personal = Some(registered(NodeScope::Personal, Some("owner-1")));
    with_test_node_binding(true, personal, async {
        assert!(caller_is_node_owner(&signed_in("owner-1")));
        assert!(!caller_is_node_owner(&signed_in("someone-else")));
    })
    .await;

    // A team or org node, or a managed node not yet registered, has no single owner.
    let team = Some(registered(NodeScope::Team, None));
    with_test_node_binding(true, team, async {
        assert!(!caller_is_node_owner(&signed_in("owner-1")));
    })
    .await;
    with_test_node_binding(true, None, async {
        assert!(!caller_is_node_owner(&signed_in("owner-1")));
    })
    .await;
}

/// A follow-up run is a new run: its result is posted into the conversation again.
#[tokio::test]
async fn a_follow_up_run_posts_its_own_result() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let conversation = fresh_conversation();
    store::save_run(store::RunRecord {
        conversation_id: conversation.clone(),
        owner: "node-owner".into(),
        backend: CloudTaskBackend::OpenaiSubscriptionCli,
        environment_id: "env-1".into(),
        executor: "codex".into(),
        account_id: None,
        external_id: Some("task_e_first001".into()),
        url: None,
        status: "completed".into(),
        summary: Some("Done".into()),
        last_error: None,
        output_tail: None,
        workspace: None,
        branch: None,
        created_at: 0,
        updated_at: 0,
        result_posted: true,
    });
    FakeCli::install(Box::new(|invocation| {
        if is(invocation, &["login", "status"]) {
            ok("Logged in using ChatGPT")
        } else if is(invocation, &["cloud", "exec"]) {
            ok("https://chatgpt.com/codex/tasks/task_e_second02")
        } else if is(invocation, &["cloud", "list"]) {
            ok(r#"{"tasks":[]}"#)
        } else {
            fail("unexpected")
        }
    }));
    start_or_fall_back(&node_owner(), request(&conversation, "codex", unpinned()))
        .await
        .expect("follow-up starts");
    let saved = store::run(&conversation).expect("run");
    assert!(
        !saved.result_posted,
        "the new run's result is still to post"
    );
    assert_eq!(saved.status, "submitted");
}

#[tokio::test]
async fn codex_runs_track_status_from_the_task_list() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    // The environment already holds one task the user started elsewhere; the list after
    // the submit adds exactly one new task, which is the one Ryu adopts.
    let submitted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen = submitted.clone();
    let fake = FakeCli::install(Box::new(move |invocation| {
        use std::sync::atomic::Ordering;
        if is(invocation, &["login", "status"]) {
            ok("Logged in using ChatGPT")
        } else if is(invocation, &["cloud", "exec"]) {
            seen.store(true, Ordering::SeqCst);
            ok("Task submitted.")
        } else if is(invocation, &["cloud", "list"]) {
            let other =
                r#"{"id":"task_e_usersown","url":"https://evil.example/x","status":"ready"}"#;
            if seen.load(Ordering::SeqCst) {
                ok(&format!(
                    r#"{{"tasks":[{{"id":"task_e_42abcdef","url":"https://chatgpt.com/codex/tasks/task_e_42abcdef","status":"pending","summary":"Working"}},{other}]}}"#
                ))
            } else {
                ok(&format!(r#"{{"tasks":[{other}]}}"#))
            }
        } else {
            fail("unexpected")
        }
    }));
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "codex", unpinned()),
    )
    .await
    .unwrap();
    let RouteOutcome::Started { record, .. } = outcome else {
        panic!("expected a plan run");
    };
    assert_eq!(record.backend, CloudTaskBackend::OpenaiSubscriptionCli);
    assert_eq!(record.external_id.as_deref(), Some("task_e_42abcdef"));
    assert_eq!(record.status, "pending");
    assert_eq!(
        record.url.as_deref(),
        Some("https://chatgpt.com/codex/tasks/task_e_42abcdef")
    );
    assert!(submitted.load(std::sync::atomic::Ordering::SeqCst));
    assert!(fake.calls().iter().any(|call| call.len() >= 5
        && call[1..4] == ["cloud", "exec", "--env"]
        && call[4] == "env_codex123"));
}

#[tokio::test]
async fn sign_in_hands_off_to_the_cli_with_nothing_captured() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let fake = FakeCli::install(Box::new(|_| fail("unused")));
    let response = api::sign_in_backend(
        axum::Extension(node_owner()),
        axum::extract::Path("anthropic-subscription-cli".into()),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
    assert_eq!(
        *fake.detached.lock().unwrap(),
        vec![vec!["claude".to_owned(), "auth".into(), "login".into()]]
    );
    let response = api::sign_in_backend(
        axum::Extension(other_user()),
        axum::extract::Path("anthropic-subscription-cli".into()),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
}

#[test]
fn task_text_can_never_become_a_cli_flag() {
    let start = cli::claude_start_invocation("/repo".into(), "--settings={\"hooks\":{}}");
    assert_eq!(start.args[0], "--cloud");
    assert!(!start.args[1].starts_with('-'));
    let follow = cli::claude_follow_up_invocation(SESSION, "--permission-mode=bypassPermissions");
    let split = follow.args.iter().position(|arg| arg == "--").expect("--");
    assert_eq!(split, follow.args.len() - 2);
    assert!(!follow.args[split + 1].starts_with('-'));
    let codex = cli::codex_start_invocation("env_1", "--help");
    assert_eq!(codex.args[4], "--");
    assert!(!codex.args[5].starts_with('-'));
    // Ordinary text is passed through untouched.
    assert_eq!(
        cli::codex_start_invocation("env_1", "Fix it").args[5],
        "Fix it"
    );
}

#[test]
fn codex_list_rows_keep_only_their_own_links() {
    let tasks = cli::parse_codex_list(&output(
        0,
        r#"{"tasks":[{"id":"task_e_1abcdef","url":"https://evil.example/task_e_1abcdef"},{"id":"bad id!","url":null},{"id":"task_e_2abcdef","url":"https://chatgpt.com/codex/tasks/task_e_2abcdef"}]}"#,
    ))
    .unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].url, None);
    assert_eq!(
        tasks[1].url.as_deref(),
        Some("https://chatgpt.com/codex/tasks/task_e_2abcdef")
    );
}

#[tokio::test]
async fn an_unreadable_store_fails_closed() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("subscription-cloud.json");
    store::load_for_test(&file, b"{not json");
    assert!(
        fences_box("any-conversation"),
        "every conversation stays fenced"
    );
    assert!(!store::settings("node-owner").enabled, "plans are off");
    store::save_settings("node-owner", RoutingSettings::default());
    assert_eq!(
        std::fs::read(&file).unwrap(),
        b"{not json",
        "never overwritten"
    );
    store::reset_for_test();
}

#[tokio::test]
async fn one_prompt_at_a_time_per_conversation() {
    let first = lock_conversation("same").await;
    let waiting = tokio::spawn(async { lock_conversation("same").await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !waiting.is_finished(),
        "the second prompt waits for the first"
    );
    let other = lock_conversation("another").await;
    drop(other);
    drop(first);
    let _second = waiting.await.unwrap();
}

// ── Claude Code on this node (`anthropic-subscription-sdk`) ─────────────────

const LOCAL_SESSION: &str = "0b7d7c4e-9a2f-4c1e-8f3a-2d5e6f7a8b9c";

fn init_line() -> String {
    format!(r#"{{"type":"system","subtype":"init","session_id":"{LOCAL_SESSION}","tools":[]}}"#)
}

fn assistant_line(text: &str) -> String {
    serde_json::json!({
        "type": "assistant",
        "message": {"content": [
            {"type": "text", "text": text},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "a.rs"}}
        ]},
        "session_id": LOCAL_SESSION
    })
    .to_string()
}

fn result_line(text: &str) -> String {
    serde_json::json!({
        "type": "result", "subtype": "success", "is_error": false,
        "result": text, "session_id": LOCAL_SESSION
    })
    .to_string()
}

/// A real git repository with one commit, for worktrees.
fn git_checkout() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir.path())
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git");
        assert!(status.status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
    git(&["add", "README.md"]);
    git(&["commit", "-q", "-m", "init"]);
    dir
}

fn local_pin() -> SessionPin {
    SessionPin {
        backend: Some(CloudTaskBackend::AnthropicSubscriptionSdk),
        fallback: false,
    }
}

async fn wait_for_status(conversation: &str, status: &str) -> store::RunRecord {
    for _ in 0..200 {
        if let Some(record) = store::run(conversation) {
            if record.status == status {
                return record;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("run never reached {status}: {:?}", store::run(conversation));
}

#[test]
fn local_runs_pass_text_after_dashes_and_accept_only_edits() {
    let invocation = local_run::invocation(
        Provider::Anthropic,
        std::path::Path::new("/w"),
        Some(LOCAL_SESSION),
        "--help",
    );
    let args = &invocation.args;
    assert_eq!(args[0], "-p");
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "acceptEdits"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--resume", LOCAL_SESSION]));
    assert_eq!(args[args.len() - 2], "--");
    assert!(!args[args.len() - 1].starts_with('-'));
    assert!(!args.iter().any(|arg| arg.contains("dangerously")));
}

#[test]
fn local_stream_events_parse_and_ignore_the_unknown() {
    assert_eq!(
        local_run::parse_event(Provider::Anthropic, &init_line()),
        local_run::Event::Init {
            session_id: LOCAL_SESSION.into()
        }
    );
    assert_eq!(
        local_run::parse_event(Provider::Anthropic, &assistant_line("Fixing it")),
        local_run::Event::Log("Fixing it\n→ Edit".into())
    );
    assert!(matches!(
        local_run::parse_event(Provider::Anthropic, &result_line("Done")),
        local_run::Event::Result {
            is_error: false,
            ..
        }
    ));
    assert_eq!(
        local_run::parse_event(
            Provider::Anthropic,
            r#"{"type":"system","subtype":"init","session_id":"../../etc"}"#
        ),
        local_run::Event::Other
    );
    assert_eq!(
        local_run::parse_event(Provider::Anthropic, "not json"),
        local_run::Event::Other
    );
    assert_eq!(
        local_run::parse_event(Provider::Anthropic, r#"{"type":"brand_new_event"}"#),
        local_run::Event::Other
    );
}

#[tokio::test]
async fn a_local_run_works_in_its_own_worktree_and_follows_up_in_the_same_session() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let fake = FakeCli::install_streaming(
        Box::new(|invocation| {
            if is(invocation, &["auth", "status"]) {
                ok(CLAUDE_SUBSCRIPTION)
            } else {
                fail("unexpected")
            }
        }),
        Some(Box::new(|invocation: &Invocation| {
            if let Some(cwd) = &invocation.cwd {
                let _ = std::fs::write(cwd.join("new.txt"), "made by the agent\n");
            }
            FakeStream {
                lines: vec![
                    init_line(),
                    assistant_line("Working. key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"),
                    result_line("Added new.txt"),
                ],
                exit: output(0, ""),
                hang: false,
            }
        })),
    );
    let conversation = fresh_conversation();
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", local_pin()),
    )
    .await
    .expect("starts");
    let RouteOutcome::Started { record, .. } = outcome else {
        panic!("expected a local run");
    };
    assert_eq!(record.backend, CloudTaskBackend::AnthropicSubscriptionSdk);
    assert_eq!(record.external_id.as_deref(), Some(LOCAL_SESSION));
    let workspace = std::path::PathBuf::from(record.workspace.clone().unwrap());
    assert!(
        workspace.starts_with(root.path()),
        "never the owner's checkout"
    );
    assert_ne!(workspace, repo.path());
    assert!(record.branch.as_deref().unwrap().starts_with("ryu/task-"));
    assert!(
        fences_box(&conversation),
        "a local plan run never gets a Box"
    );

    let done = wait_for_status(&conversation, "completed").await;
    assert_eq!(done.summary.as_deref(), Some("Added new.txt"));
    let tail = done.output_tail.clone().unwrap();
    assert!(tail.contains("Working.") && tail.contains("→ Edit"));
    assert!(
        !tail.contains("sk-ant-api03"),
        "secrets are scrubbed: {tail}"
    );
    assert!(
        !repo.path().join("new.txt").exists(),
        "the checkout is untouched"
    );

    let diff = local_run::diff(&done).await.expect("diff");
    assert!(diff.patch.contains("made by the agent"));
    assert!(diff.files.iter().any(|line| line.ends_with("new.txt")));

    // The next message resumes the same session in the same worktree.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect("follow-up");
    let RouteOutcome::Started { record, .. } = outcome else {
        panic!("expected a follow-up");
    };
    assert_eq!(record.workspace.as_deref(), done.workspace.as_deref());
    let last = fake.calls().last().unwrap().clone();
    assert!(last
        .windows(2)
        .any(|pair| pair == ["--resume", LOCAL_SESSION]));
    wait_for_status(&conversation, "completed").await;
    local_run::set_worktree_root_for_test(None);
}

#[tokio::test]
async fn a_local_run_can_be_stopped_and_refuses_a_second_message_while_busy() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    FakeCli::install_streaming(
        Box::new(|_| ok(CLAUDE_SUBSCRIPTION)),
        Some(Box::new(|_: &Invocation| FakeStream {
            lines: vec![init_line(), assistant_line("Thinking")],
            exit: output(0, ""),
            hang: true,
        })),
    );
    let conversation = fresh_conversation();
    start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", local_pin()),
    )
    .await
    .expect("starts");
    assert!(local_run::is_running(&conversation));
    let busy = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect_err("busy");
    assert_eq!(error_code(&busy), "cloud_task_busy");
    assert!(local_run::stop(&conversation));
    wait_for_status(&conversation, "stopped").await;
    assert!(!local_run::is_running(&conversation));
    local_run::set_worktree_root_for_test(None);
}

#[tokio::test]
async fn a_claude_quota_cools_down_the_whole_plan_and_says_so_once() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    FakeCli::install_streaming(
        claude_with(|| fail("Error: Claude usage limit reached. Resets 5pm.")),
        Some(Box::new(|_: &Invocation| FakeStream {
            lines: Vec::new(),
            exit: output(0, "should never run"),
            hang: false,
        })),
    );
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .expect("falls back");
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box");
    };
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].code, "subscription_quota_fallback");
    let now = unix_now();
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), now).is_some());
    assert!(store::cooldown_remaining(&default_key(Provider::Openai), now).is_none());

    // A local run that hits the limit before it starts falls back the same way.
    store::reset_for_test();
    enable("node-owner", "env-1", repo.path());
    FakeCli::install_streaming(
        Box::new(|_| ok(CLAUDE_SUBSCRIPTION)),
        Some(Box::new(|_: &Invocation| FakeStream {
            lines: Vec::new(),
            exit: CliOutput {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: "API Error: 429 rate_limit_error: usage limit reached".into(),
            },
            hang: false,
        })),
    );
    let pin = SessionPin {
        backend: Some(CloudTaskBackend::AnthropicSubscriptionSdk),
        fallback: true,
    };
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", pin),
    )
    .await
    .expect("falls back");
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box, got {outcome:?}");
    };
    assert_eq!(notices[0].code, "subscription_quota_fallback");
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), unix_now()).is_some());
    local_run::set_worktree_root_for_test(None);
}

#[tokio::test]
async fn a_chatgpt_plan_on_a_ryu_hosted_node_waits_for_openai_approval() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let fake = FakeCli::install(Box::new(|invocation| {
        if is(invocation, &["login", "status"]) {
            ok("Logged in using ChatGPT")
        } else {
            ok("https://chatgpt.com/codex/tasks/task_e_hosted01")
        }
    }));
    let outcome = crate::sidecar::control_plane::with_test_node_binding(
        true,
        None,
        start_or_fall_back(
            &node_owner(),
            request(&fresh_conversation(), "codex", unpinned()),
        ),
    )
    .await
    .expect("routes");
    assert!(matches!(outcome, RouteOutcome::UseBox { ref notices } if notices.is_empty()));
    assert!(
        !fake
            .calls()
            .iter()
            .any(|call| call.get(1).is_some_and(|arg| arg == "cloud")),
        "no Codex cloud call on a hosted node"
    );
    // The same owner on their own (self-hosted) node may use it.
    let outcome = crate::sidecar::control_plane::with_test_node_binding(
        false,
        None,
        start_or_fall_back(
            &node_owner(),
            request(&fresh_conversation(), "codex", unpinned()),
        ),
    )
    .await
    .expect("routes");
    assert!(matches!(outcome, RouteOutcome::Started { .. }));
}

// ── Several linked accounts ──────────────────────────────────────────────────

use super::accounts::ProviderId;

fn link(owner: &str, provider: ProviderId, label: &str) -> String {
    let id = accounts::new_id();
    store::add_account(
        owner,
        accounts::PlanAccount {
            id: id.clone(),
            provider,
            label: label.into(),
            created_at: 0,
        },
    )
    .expect("room for another account");
    id
}

fn with_settings(owner: &str, change: impl FnOnce(&mut RoutingSettings)) {
    let mut settings = store::settings(owner);
    change(&mut settings);
    store::save_settings(owner, settings);
}

#[test]
fn account_folders_stay_inside_the_layout() {
    accounts::set_root_for_test(None);
    assert!(accounts::config_dir(Provider::Anthropic, accounts::DEFAULT_ACCOUNT).is_none());
    for bad in [
        "../../etc",
        "ABCDEF123456",
        "abc",
        "0123456789abc",
        "",
        "0a1b/2c3d4e5",
    ] {
        assert!(
            accounts::config_dir(Provider::Anthropic, bad).is_none(),
            "{bad}"
        );
    }
    let dir = accounts::config_dir(Provider::Openai, "0a1b2c3d4e5f").unwrap();
    assert!(dir.starts_with(crate::paths::state_dir()), "{dir:?}");
    assert!(dir.ends_with("plan-accounts/openai-0a1b2c3d4e5f"));
    assert_eq!(
        accounts::parse_pin("anthropic:0a1b2c3d4e5f"),
        Some((ProviderId::Anthropic, "0a1b2c3d4e5f"))
    );
    assert_eq!(
        accounts::parse_pin("openai:default"),
        Some((ProviderId::Openai, "default"))
    );
    assert_eq!(accounts::parse_pin("openai:../x"), None);
    assert_eq!(accounts::parse_pin("gemini:default"), None);
    assert!(accounts::clean_label("work").is_some());
    assert!(accounts::clean_label("").is_none());
    assert!(accounts::clean_label("a\nb").is_none());
}

#[test]
fn each_account_gets_only_its_own_folder_and_the_allowlist() {
    let dir = tempfile::tempdir().unwrap();
    for (provider, name) in [
        (Provider::Anthropic, "CLAUDE_CONFIG_DIR"),
        (Provider::Openai, "CODEX_HOME"),
    ] {
        let mut invocation = cli::status_invocation(provider);
        invocation.account_dir = Some(dir.path().to_path_buf());
        let command = cli::RealCli::command_for("/bin/true".into(), &invocation);
        let envs: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(envs.contains(&(
            name.to_owned(),
            Some(dir.path().to_string_lossy().into_owned())
        )));
        for (key, _) in &envs {
            assert!(!cli::ENV_DENYLIST.contains(&key.as_str()), "{key}");
            assert!(!key.starts_with("RYU_"), "{key}");
        }
    }
}

#[tokio::test]
async fn a_session_runs_and_stays_on_the_account_that_started_it() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    accounts::set_root_for_test(Some(root.path().to_path_buf()));
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let personal = link("node-owner", ProviderId::Anthropic, "personal");
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Anthropic, work.clone());
    });
    let fake = FakeCli::install(claude_with(started_claude));
    let conversation = fresh_conversation();
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .unwrap();
    let RouteOutcome::Started { record, .. } = outcome else {
        panic!("expected a plan run");
    };
    assert_eq!(record.account(), work);
    let work_dir = accounts::config_dir(Provider::Anthropic, &work);
    assert!(work_dir.is_some());
    assert!(
        fake.homes().iter().all(|(_, home)| *home == work_dir),
        "every call used the work folder: {:?}",
        fake.homes()
    );
    assert_eq!(
        fake.calls()
            .iter()
            .filter(|call| call.get(1).is_some_and(|arg| arg == "auth"))
            .count(),
        1,
        "each account's sign-in is read once per task"
    );

    // A new default does not move the session; its follow-up uses its own account.
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Anthropic, personal.clone());
    });
    start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect("follow-up");
    assert_eq!(
        fake.homes().last().unwrap(),
        &("-p".to_owned(), work_dir.clone())
    );

    // Account B cannot act on account A's session.
    let mut moved = request(&conversation, "claude-code", unpinned());
    moved.account = Some((ProviderId::Anthropic, personal.as_str()));
    let error = start_or_fall_back(&node_owner(), moved)
        .await
        .expect_err("locked");
    assert_eq!(error_code(&error), "cloud_task_account_locked");

    // A new session pinned to the other account runs there.
    let other = fresh_conversation();
    let mut pinned = request(&other, "claude-code", unpinned());
    pinned.account = Some((ProviderId::Anthropic, personal.as_str()));
    let RouteOutcome::Started { record, .. } =
        start_or_fall_back(&node_owner(), pinned).await.unwrap()
    else {
        panic!("expected a plan run");
    };
    assert_eq!(record.account(), personal);

    // An unlinked account cannot be pinned, and a removed account's session stops.
    let unlinked = fresh_conversation();
    let mut stranger = request(&unlinked, "claude-code", unpinned());
    stranger.account = Some((ProviderId::Anthropic, "0123456789ab"));
    let error = start_or_fall_back(&node_owner(), stranger)
        .await
        .expect_err("unknown");
    assert_eq!(error_code(&error), "subscription_account_not_found");
    store::remove_account("node-owner", ProviderId::Anthropic, &work);
    let error = start_or_fall_back(
        &node_owner(),
        request(&conversation, "claude-code", unpinned()),
    )
    .await
    .expect_err("removed");
    assert_eq!(error_code(&error), "subscription_account_removed");
    accounts::set_root_for_test(None);
}

#[tokio::test]
async fn a_limit_cools_down_only_that_account_and_other_accounts_need_an_explicit_list() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    accounts::set_root_for_test(Some(root.path().to_path_buf()));
    let dir = checkout();
    enable("node-owner", "env-1", dir.path());
    let work = link("node-owner", ProviderId::Anthropic, "work");
    let personal = link("node-owner", ProviderId::Anthropic, "personal");
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Anthropic, work.clone());
    });
    let work_dir = accounts::config_dir(Provider::Anthropic, &work);
    let personal_dir = accounts::config_dir(Provider::Anthropic, &personal);
    let limited = work_dir.clone();
    let fake = FakeCli::install(Box::new(move |invocation| {
        if is(invocation, &["auth", "status"]) {
            ok(CLAUDE_SUBSCRIPTION)
        } else if is(invocation, &["--cloud"]) {
            if invocation.account_dir == limited {
                fail("Error: Claude usage limit reached. Resets 5pm.")
            } else {
                started_claude()
            }
        } else {
            fail("unexpected")
        }
    }));

    // No fallback list: the limited account's task goes to the Ryu Box.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .unwrap();
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box, got {outcome:?}");
    };
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].code, "subscription_quota_fallback");
    assert_eq!(notices[0].account_id.as_deref(), Some(work.as_str()));
    let now = unix_now();
    let key = |id: &str| accounts::account_key(Provider::Anthropic, id);
    assert!(store::cooldown_remaining(&key(&work), now).is_some());
    assert!(store::cooldown_remaining(&key(&personal), now).is_none());
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), now).is_none());
    assert!(
        !fake.homes().iter().any(|(_, home)| *home == personal_dir),
        "Ryu never picks another account by itself"
    );

    // With the owner's explicit list, the next task uses the listed account.
    with_settings("node-owner", |settings| {
        settings
            .account_fallbacks
            .insert(ProviderId::Anthropic, vec![personal.clone()]);
    });
    let RouteOutcome::Started { record, notices } = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", unpinned()),
    )
    .await
    .unwrap() else {
        panic!("expected the listed account");
    };
    assert_eq!(record.account(), personal);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].code, "subscription_cooling_down");
    accounts::set_root_for_test(None);
}

#[tokio::test]
async fn adding_and_removing_an_account_uses_its_own_folder_and_needs_confirmation() {
    use axum::extract::Path as RoutePath;
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    accounts::set_root_for_test(Some(root.path().to_path_buf()));
    let fake = FakeCli::install(Box::new(|_| ok(CLAUDE_SUBSCRIPTION)));
    let response = accounts_api::add_account(
        axum::Extension(node_owner()),
        axum::body::Bytes::from_static(br#"{"provider":"anthropic","label":"work"}"#),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
    let account = store::accounts("node-owner").pop().expect("linked");
    assert_eq!(account.label, "work");
    let dir = accounts::config_dir(Provider::Anthropic, &account.id).unwrap();
    assert!(dir.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        fake.homes().last().unwrap(),
        &("auth".to_owned(), Some(dir.clone())),
        "the CLI's own sign-in runs with the new folder"
    );
    std::fs::write(dir.join(".credentials.json"), "written by the CLI").unwrap();
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Anthropic, account.id.clone());
    });

    let unconfirmed = accounts_api::remove_account(
        axum::Extension(node_owner()),
        RoutePath(("anthropic".to_owned(), account.id.clone())),
        axum::body::Bytes::from_static(b"{}"),
    )
    .await;
    assert_eq!(unconfirmed.status(), axum::http::StatusCode::BAD_REQUEST);
    assert!(dir.is_dir());

    let removed = accounts_api::remove_account(
        axum::Extension(node_owner()),
        RoutePath(("anthropic".to_owned(), account.id.clone())),
        axum::body::Bytes::from_static(br#"{"confirm":true}"#),
    )
    .await;
    assert_eq!(removed.status(), axum::http::StatusCode::OK);
    assert!(!dir.exists());
    assert!(store::accounts("node-owner").is_empty());
    assert!(store::settings("node-owner").default_accounts.is_empty());

    let builtin = accounts_api::remove_account(
        axum::Extension(node_owner()),
        RoutePath(("anthropic".to_owned(), accounts::DEFAULT_ACCOUNT.to_owned())),
        axum::body::Bytes::from_static(br#"{"confirm":true}"#),
    )
    .await;
    assert_eq!(builtin.status(), axum::http::StatusCode::BAD_REQUEST);
    accounts::set_root_for_test(None);
}

// ── Codex on this node (`openai-subscription-sdk`) ──────────────────────────

const CODEX_THREAD: &str = "5f0c2a8e-1d3b-4e6f-9a7c-0b1d2e3f4a5b";
const CODEX_CHATGPT: &str = "Logged in using ChatGPT";

fn codex_thread_line() -> String {
    format!(r#"{{"type":"thread.started","thread_id":"{CODEX_THREAD}"}}"#)
}

fn codex_message_line(text: &str) -> String {
    serde_json::json!({
        "type": "item.completed",
        "item": {"id": "item_1", "type": "agent_message", "text": text}
    })
    .to_string()
}

fn codex_command_line(command: &str) -> String {
    serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "item_0", "type": "command_execution", "command": command,
            "aggregated_output": "OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "exit_code": 0, "status": "completed"
        }
    })
    .to_string()
}

fn codex_done_line() -> String {
    r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}"#
        .into()
}

fn codex_local_pin() -> SessionPin {
    SessionPin {
        backend: Some(CloudTaskBackend::OpenaiSubscriptionSdk),
        fallback: false,
    }
}

/// A fake `codex` signed in with ChatGPT whose local runs print `lines`.
fn codex_local(lines: fn() -> Vec<String>) -> (Script, StreamScript) {
    (
        Box::new(|invocation| {
            if is(invocation, &["login", "status"]) {
                ok(CODEX_CHATGPT)
            } else {
                fail("unexpected")
            }
        }),
        Box::new(move |invocation: &Invocation| {
            if let Some(cwd) = &invocation.cwd {
                let _ = std::fs::write(cwd.join("codex.txt"), "made by codex\n");
            }
            FakeStream {
                lines: lines(),
                exit: output(0, ""),
                hang: false,
            }
        }),
    )
}

#[test]
fn local_codex_runs_in_the_workspace_sandbox_and_never_asks() {
    let invocation = local_run::invocation(
        Provider::Openai,
        std::path::Path::new("/w"),
        Some(CODEX_THREAD),
        "--help",
    );
    let args = &invocation.args;
    assert_eq!(invocation.provider, Provider::Openai);
    assert_eq!(args[0], "exec");
    assert!(args.contains(&"--json".to_owned()));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--sandbox", "workspace-write"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-c", "approval_policy=\"never\""]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-c", "sandbox_workspace_write.network_access=false"]));
    // The account's config.toml (MCP servers, plugins, execpolicy rules) never loads,
    // and web search is off.
    assert!(args.contains(&"--ignore-user-config".to_owned()));
    assert!(args.contains(&"--ignore-rules".to_owned()));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-c", "web_search=\"disabled\""]));
    assert!(!args.iter().any(|arg| arg.contains("mcp_servers")));
    // `--sandbox` is not global: every option comes before `resume`.
    let resume = args.iter().position(|arg| arg == "resume").expect("resume");
    assert_eq!(args[resume + 1], CODEX_THREAD);
    assert!(args[resume + 2..]
        .iter()
        .all(|arg| !arg.starts_with("--") || arg == "--"));
    assert_eq!(args[args.len() - 2], "--");
    assert!(!args[args.len() - 1].starts_with('-'));
    for wide in [
        "dangerously",
        "yolo",
        "full-auto",
        "danger-full-access",
        "approve-for-me",
        "network_access=true",
    ] {
        assert!(!args.iter().any(|arg| arg.contains(wide)), "{wide}");
    }
    let fresh = local_run::invocation(Provider::Openai, std::path::Path::new("/w"), None, "Fix it");
    assert!(!fresh.args.contains(&"resume".to_owned()));
    assert_eq!(fresh.cwd.as_deref(), Some(std::path::Path::new("/w")));
}

#[test]
fn codex_stream_events_parse_and_ignore_the_unknown() {
    use local_run::{parse_event, Event};
    let codex = Provider::Openai;
    assert_eq!(
        parse_event(codex, &codex_thread_line()),
        Event::Init {
            session_id: CODEX_THREAD.into()
        }
    );
    assert_eq!(
        parse_event(codex, &codex_message_line("Fixed it")),
        Event::Reply("Fixed it".into())
    );
    // A command is logged by kind only, never its text or output.
    assert_eq!(
        parse_event(codex, &codex_command_line("export TOKEN=abc && make")),
        Event::Log("→ shell".into())
    );
    assert_eq!(
        parse_event(
            codex,
            r#"{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"s","tool":"$(rm -rf /)","status":"completed"}}"#
        ),
        Event::Log("→ tool".into())
    );
    assert_eq!(
        parse_event(codex, &codex_done_line()),
        Event::Result {
            is_error: false,
            text: None
        }
    );
    assert_eq!(
        parse_event(
            codex,
            r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#
        ),
        Event::Result {
            is_error: true,
            text: Some("You've hit your usage limit.".into())
        }
    );
    // A stream error may be retried; only `turn.failed` ends the turn.
    assert_eq!(
        parse_event(
            codex,
            r#"{"type":"error","message":"Reconnecting... 1/5 (429 Too Many Requests)"}"#
        ),
        Event::StreamError(Some("Reconnecting... 1/5 (429 Too Many Requests)".into()))
    );
    assert_eq!(
        parse_event(
            codex,
            r#"{"type":"thread.started","thread_id":"../../etc"}"#
        ),
        Event::Other
    );
    assert_eq!(
        parse_event(
            codex,
            r#"{"type":"item.started","item":{"id":"i","type":"agent_message","text":"x"}}"#
        ),
        Event::Other,
        "only completed items are logged, so nothing is logged twice"
    );
    assert_eq!(parse_event(codex, "not json"), Event::Other);
    assert_eq!(
        parse_event(codex, r#"{"type":"brand_new_event"}"#),
        Event::Other
    );
    // Each runtime reads only its own stream.
    assert_eq!(
        parse_event(Provider::Anthropic, &codex_thread_line()),
        Event::Other
    );
    assert_eq!(parse_event(codex, &init_line()), Event::Other);
}

#[tokio::test]
async fn a_local_codex_run_works_in_its_own_worktree_and_resumes_its_session() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    accounts::set_root_for_test(Some(root.path().join("accounts")));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let work = link("node-owner", ProviderId::Openai, "work");
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Openai, work.clone());
    });
    let (script, stream) = codex_local(|| {
        vec![
            codex_thread_line(),
            codex_command_line("cat .env"),
            codex_message_line("Working. key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            codex_message_line("Added codex.txt"),
            codex_done_line(),
        ]
    });
    let fake = FakeCli::install_streaming(script, Some(stream));
    let conversation = fresh_conversation();
    let RouteOutcome::Started { record, .. } = start_or_fall_back(
        &node_owner(),
        request(&conversation, "codex", codex_local_pin()),
    )
    .await
    .expect("starts") else {
        panic!("expected a local Codex run");
    };
    assert_eq!(record.backend, CloudTaskBackend::OpenaiSubscriptionSdk);
    assert_eq!(record.external_id.as_deref(), Some(CODEX_THREAD));
    assert_eq!(record.account(), work);
    let workspace = std::path::PathBuf::from(record.workspace.clone().unwrap());
    assert!(
        workspace.starts_with(root.path()),
        "never the owner's checkout"
    );
    assert!(record.branch.as_deref().unwrap().starts_with("ryu/task-"));
    assert!(
        fences_box(&conversation),
        "a local plan run never gets a Box"
    );
    let work_dir = accounts::config_dir(Provider::Openai, &work);
    assert!(work_dir.is_some());
    assert!(
        fake.homes().iter().all(|(_, home)| *home == work_dir),
        "every call used the account's own CODEX_HOME: {:?}",
        fake.homes()
    );

    let done = wait_for_status(&conversation, "completed").await;
    assert_eq!(done.summary.as_deref(), Some("Added codex.txt"));
    let tail = done.output_tail.clone().unwrap();
    assert!(tail.contains("→ shell") && tail.contains("Working."));
    assert!(
        !tail.contains("cat .env"),
        "commands are not logged: {tail}"
    );
    assert!(!tail.contains("sk-proj-"), "secrets are scrubbed: {tail}");
    assert!(
        !repo.path().join("codex.txt").exists(),
        "the checkout is untouched"
    );
    let diff = local_run::diff(&done).await.expect("diff");
    assert!(diff.patch.contains("made by codex"));

    // Status, Stop and the diff answer for a Codex run on this node.
    assert!(api::features(CloudTaskBackend::OpenaiSubscriptionSdk).stop_from_ryu);
    assert!(
        !local_run::stop(&conversation),
        "nothing to stop once it is done"
    );

    // The next message resumes the same Codex session in the same worktree.
    let RouteOutcome::Started { record, .. } =
        start_or_fall_back(&node_owner(), request(&conversation, "codex", unpinned()))
            .await
            .expect("follow-up")
    else {
        panic!("expected a follow-up");
    };
    assert_eq!(record.workspace.as_deref(), done.workspace.as_deref());
    let last = fake.calls().last().unwrap().clone();
    assert_eq!(last[0], "codex");
    assert!(last.windows(2).any(|pair| pair == ["resume", CODEX_THREAD]));
    assert_eq!(fake.homes().last().unwrap().1, work_dir);
    wait_for_status(&conversation, "completed").await;
    local_run::set_worktree_root_for_test(None);
    accounts::set_root_for_test(None);
}

#[tokio::test]
async fn a_codex_limit_cools_down_that_account_and_uses_only_listed_ones() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    accounts::set_root_for_test(Some(root.path().join("accounts")));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let work = link("node-owner", ProviderId::Openai, "work");
    let personal = link("node-owner", ProviderId::Openai, "personal");
    with_settings("node-owner", |settings| {
        settings
            .default_accounts
            .insert(ProviderId::Openai, work.clone());
    });
    let work_dir = accounts::config_dir(Provider::Openai, &work);
    let personal_dir = accounts::config_dir(Provider::Openai, &personal);
    let limited = work_dir.clone();
    let fake = FakeCli::install_streaming(
        Box::new(|invocation| {
            if is(invocation, &["login", "status"]) {
                ok(CODEX_CHATGPT)
            } else {
                fail("unexpected")
            }
        }),
        Some(Box::new(move |invocation: &Invocation| {
            if invocation.account_dir == limited {
                // As real `codex exec --json` does: the thread starts, then the first
                // turn fails at the model with the limit, in the stream.
                FakeStream {
                    lines: vec![
                        codex_thread_line(),
                        r#"{"type":"turn.started"}"#.into(),
                        r#"{"type":"error","message":"You've hit your usage limit. Try again in 2 hours."}"#.into(),
                        r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again in 2 hours."}}"#.into(),
                    ],
                    exit: output(1, ""),
                    hang: false,
                }
            } else {
                FakeStream {
                    lines: vec![
                        codex_thread_line(),
                        codex_message_line("Done"),
                        codex_done_line(),
                    ],
                    exit: output(0, ""),
                    hang: false,
                }
            }
        })),
    );
    let fallback_pin = SessionPin {
        backend: Some(CloudTaskBackend::OpenaiSubscriptionSdk),
        fallback: true,
    };

    // No fallback list: the limited account's task goes to the Ryu Box.
    let outcome = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "codex", fallback_pin),
    )
    .await
    .unwrap();
    let RouteOutcome::UseBox { notices } = outcome else {
        panic!("expected the Box, got {outcome:?}");
    };
    assert_eq!(notices[0].code, "subscription_quota_fallback");
    assert_eq!(notices[0].account_id.as_deref(), Some(work.as_str()));
    let now = unix_now();
    let key = |id: &str| accounts::account_key(Provider::Openai, id);
    assert!(store::cooldown_remaining(&key(&work), now).is_some());
    assert!(store::cooldown_remaining(&key(&personal), now).is_none());
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), now).is_none());
    assert!(
        !fake.homes().iter().any(|(_, home)| *home == personal_dir),
        "Ryu never picks another account by itself"
    );

    // With the owner's explicit list, the next task uses the listed account.
    with_settings("node-owner", |settings| {
        settings
            .account_fallbacks
            .insert(ProviderId::Openai, vec![personal.clone()]);
    });
    let conversation = fresh_conversation();
    let RouteOutcome::Started { record, notices } =
        start_or_fall_back(&node_owner(), request(&conversation, "codex", fallback_pin))
            .await
            .unwrap()
    else {
        panic!("expected the listed account");
    };
    assert_eq!(record.account(), personal);
    assert_eq!(record.backend, CloudTaskBackend::OpenaiSubscriptionSdk);
    assert!(notices
        .iter()
        .all(|notice| notice.code == "subscription_cooling_down"));
    wait_for_status(&conversation, "completed").await;
    local_run::set_worktree_root_for_test(None);
    accounts::set_root_for_test(None);
}

#[tokio::test]
async fn a_codex_limit_reported_mid_run_fails_the_run_and_cools_the_account_down() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let (script, stream) = codex_local(|| {
        vec![
            codex_thread_line(),
            codex_command_line("make"),
            r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro or try again later."}}"#.into(),
        ]
    });
    FakeCli::install_streaming(script, Some(stream));
    let conversation = fresh_conversation();
    start_or_fall_back(
        &node_owner(),
        request(&conversation, "codex", codex_local_pin()),
    )
    .await
    .expect("starts");
    let failed = wait_for_status(&conversation, "failed").await;
    assert!(failed.last_error.unwrap().contains("usage limit"));
    let now = unix_now();
    assert!(store::cooldown_remaining(&default_key(Provider::Openai), now).is_some());
    assert!(store::cooldown_remaining(&default_key(Provider::Anthropic), now).is_none());

    // A follow-up on the cooled-down session is refused by the plan, not sent to a Box.
    let (script, _) = codex_local(Vec::new);
    FakeCli::install_streaming(
        script,
        Some(Box::new(|_: &Invocation| FakeStream {
            lines: Vec::new(),
            exit: CliOutput {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: "stream error: 429 Too Many Requests".into(),
            },
            hang: false,
        })),
    );
    let error = start_or_fall_back(&node_owner(), request(&conversation, "codex", unpinned()))
        .await
        .expect_err("limited");
    assert_eq!(error_code(&error), "subscription_quota");
    local_run::set_worktree_root_for_test(None);
}

#[tokio::test]
async fn a_stopped_codex_run_is_stopped_even_after_a_retried_stream_error() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let (script, _) = codex_local(Vec::new);
    FakeCli::install_streaming(
        script,
        Some(Box::new(|_: &Invocation| FakeStream {
            lines: vec![
                codex_thread_line(),
                codex_command_line("make"),
                r#"{"type":"error","message":"stream error: 429 Too Many Requests; retrying 1/5"}"#
                    .into(),
            ],
            exit: output(0, ""),
            hang: true,
        })),
    );
    let conversation = fresh_conversation();
    start_or_fall_back(
        &node_owner(),
        request(&conversation, "codex", codex_local_pin()),
    )
    .await
    .expect("starts");
    // Let the follower read the stream error before Stop.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(local_run::stop(&conversation));
    let stopped = wait_for_status(&conversation, "stopped").await;
    assert!(stopped.last_error.is_none());
    assert!(
        store::cooldown_remaining(&default_key(Provider::Openai), unix_now()).is_none(),
        "a retried error is not a usage limit"
    );
    local_run::set_worktree_root_for_test(None);
}

#[tokio::test]
async fn only_the_node_owner_runs_codex_on_this_node_and_not_on_a_hosted_one() {
    let _serial = SERIAL.lock().await;
    store::reset_for_test();
    let root = tempfile::tempdir().unwrap();
    local_run::set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let repo = git_checkout();
    enable("node-owner", "env-1", repo.path());
    let (script, stream) = codex_local(|| vec![codex_thread_line(), codex_done_line()]);
    let fake = FakeCli::install_streaming(script, Some(stream));

    let stranger_conversation = fresh_conversation();
    let mut stranger = request(&stranger_conversation, "codex", codex_local_pin());
    stranger.owner = "someone-else";
    let error = start_or_fall_back(&other_user(), stranger)
        .await
        .expect_err("owner only");
    assert_eq!(error_code(&error), "subscription_backend_owner_only");

    // A Ryu-managed node is hosted use of a ChatGPT plan: off until OpenAI approves.
    let error = crate::sidecar::control_plane::with_test_node_binding(
        true,
        None,
        start_or_fall_back(
            &node_owner(),
            request(&fresh_conversation(), "codex", codex_local_pin()),
        ),
    )
    .await
    .expect_err("strict pin, plan off");
    assert_eq!(error_code(&error), "subscription_backend_unavailable");
    assert!(
        !fake
            .calls()
            .iter()
            .any(|call| call.get(1).is_some_and(|arg| arg == "exec")),
        "no codex exec for a stranger or on a hosted node"
    );

    // A Claude Code task never runs on the ChatGPT plan.
    let error = start_or_fall_back(
        &node_owner(),
        request(&fresh_conversation(), "claude-code", codex_local_pin()),
    )
    .await
    .expect_err("wrong agent");
    assert_eq!(error_code(&error), "subscription_backend_unavailable");
    local_run::set_worktree_root_for_test(None);
}

#[test]
fn a_local_codex_run_gets_its_account_home_and_no_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut invocation =
        local_run::invocation(Provider::Openai, std::path::Path::new("/w"), None, "x");
    invocation.account_dir = Some(dir.path().to_path_buf());
    let command = cli::RealCli::command_for("/bin/true".into(), &invocation);
    let envs: Vec<(String, Option<String>)> = command
        .as_std()
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert!(envs.contains(&(
        "CODEX_HOME".to_owned(),
        Some(dir.path().to_string_lossy().into_owned())
    )));
    for (key, _) in &envs {
        assert!(!cli::ENV_DENYLIST.contains(&key.as_str()), "{key}");
        assert!(!key.starts_with("RYU_"), "{key}");
    }
    let env = cli::child_env(
        [
            ("OPENAI_API_KEY", "sk-proj-x"),
            ("CODEX_API_KEY", "sk-x"),
            ("OPENAI_BASE_URL", "http://127.0.0.1:1/v1"),
            ("RYU_GATEWAY_TOKEN", "t"),
            ("PATH", "/usr/bin"),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned())),
    );
    assert_eq!(env, vec![("PATH".to_owned(), "/usr/bin".to_owned())]);
}
